import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

// The browser harness is OPT-IN, like the live backend e2e: a real Chrome's cold start on a
// shared CI runner is not deterministic, so the default suite never runs it. Set
// AGENTPRISM_UI_E2E=1 to run it (the pre-push hook does), and AGENTPRISM_UI_CHROME for a
// nonstandard install. Uses the platform browser and native CDP/WebSocket; no browser
// automation dependency enters the repository.
const uiE2e = process.env.AGENTPRISM_UI_E2E === "1";
const chrome = [
  process.env.AGENTPRISM_UI_CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((path) => path && existsSync(path));
const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

test(
  "complete production monitor against controllable MCP App host",
  {
    skip: uiE2e
      ? false
      : "browser harness is opt-in: set AGENTPRISM_UI_E2E=1 (runs in the pre-push hook)",
    timeout: 120_000,
  },
  async (t) => {
    // Opted in without a browser is a loud failure, not a silent skip: the hook's coverage
    // must not quietly disappear on a machine without Chrome.
    assert.ok(chrome, "AGENTPRISM_UI_E2E=1 but no Chrome was found; install it or set AGENTPRISM_UI_CHROME");
    const server = await createServer({
      root: uiRoot,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/preview.html`;
    const profile = await mkdtemp(resolve(tmpdir(), "agentprism-ui-host-"));
    const browser = spawn(
      chrome!,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let closeBrowser: (() => Promise<unknown>) | undefined;
    t.after(async () => {
      try {
        await closeBrowser?.();
      } catch {
        /* The browser may already be closed. */
      }
      browser.kill("SIGTERM");
      await server.close();
      await new Promise<void>((done) => {
        if (browser.exitCode !== null) done();
        else browser.once("exit", () => done());
      });
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    });
    // A cold Chrome on a loaded CI runner can take well over 15 s before it prints its
    // DevTools line (it failed on main with empty stderr); allow 60 s of the test's 120 s
    // budget, and fail fast if the browser exits before exposing CDP.
    const port = await new Promise<number>((accept, reject) => {
      let output = "";
      const timeout = setTimeout(
        () =>
          reject(
            new Error(`Chrome did not expose CDP: ${output.slice(-1000)}`),
          ),
        60_000,
      );
      browser.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited (${code ?? signal}) before exposing CDP: ${output.slice(-1000)}`));
      });
      browser.stderr!.on("data", (chunk) => {
        output += String(chunk);
        const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(
          output,
        );
        if (match) {
          clearTimeout(timeout);
          accept(Number(match[1]));
        }
      });
      browser.once("error", reject);
    });
    const target = (await (
      await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
        { method: "PUT" },
      )
    ).json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((accept, reject) => {
      socket.addEventListener("open", () => accept(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    t.after(() => socket.close());
    let nextId = 0;
    const pending = new Map<
      number,
      { accept: (result: any) => void; reject: (error: Error) => void }
    >();
    const pageErrors: unknown[] = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown")
        pageErrors.push(message.params);
      if (!message.id) return;
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(JSON.stringify(message.error)));
      else call?.accept(message.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((accept, reject) => {
        const id = ++nextId;
        pending.set(id, { accept, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    closeBrowser = () => send("Browser.close");
    await send("Runtime.enable");
    const evaluate = async <T = unknown>(expression: string): Promise<T> => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      return result.result.value as T;
    };
    const waitFor = async (predicate: string, timeout = 8000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${predicate})`)) return;
        await new Promise((done) => setTimeout(done, 30));
      }
      assert.fail(
        `Browser condition timed out: ${predicate}\n${await evaluate(
          "document.body.innerText",
        )}`,
      );
    };
    const click = (text: string, panel = 0) =>
      evaluate(
        `(() => { const button = [...document.querySelectorAll('[data-panel="${panel}"] button')].find(node => node.textContent.trim() === ${JSON.stringify(
          text,
        )}); if (!button) throw new Error('Button missing: ' + ${JSON.stringify(
          text,
        )}); button.click(); })()`,
      );
    const reset = async () => {
      await send("Page.navigate", { url });
      await waitFor(
        "window.monitorHarness?.hosts[0].contexts.length > 0 && document.querySelector('[data-panel=\"0\"] .node.status-running')",
      );
    };
    await reset();

    await t.test(
      "retained panels isolate selection, cursors, communication and project navigation",
      async () => {
        await click("Research transport");
        await waitFor("document.querySelector('[data-panel=\"0\"] .detail')");
        await evaluate(
          "document.querySelector('[data-panel=\"0\"] .log-rows').scrollTop = 40; document.querySelector('[data-panel=\"0\"] .log-rows').dispatchEvent(new Event('scroll')); window.monitorHarness.open('run-b', false)",
        );
        await waitFor(
          "document.querySelectorAll('main.monitor').length === 2 && window.monitorHarness.hosts[1].contexts.length > 0",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('[data-panel=\"0\"] main').dataset.runId",
          ),
          "run-a",
        );
        assert.equal(
          await evaluate(
            "!!document.querySelector('[data-panel=\"0\"] .detail')",
          ),
          true,
        );
        assert.equal(
          await evaluate(
            "document.querySelector('[data-panel=\"0\"] .log-rows').scrollTop",
          ),
          40,
        );
        assert.equal(
          await evaluate(
            "document.querySelector('[data-panel=\"0\"] .run-switch').textContent.includes('other-project')",
          ),
          false,
        );
        assert.equal(
          await evaluate(
            "window.monitorHarness.hosts.reduce((n, host) => n + host.messages.length, 0)",
          ),
          0,
        );
        await click("Ask about this agent");
        await waitFor("window.monitorHarness.hosts[0].messages.length === 1");
        assert.match(
          await evaluate<string>(
            "JSON.stringify(window.monitorHarness.hosts[0].messages)",
          ),
          /run-a.*callIndex/,
        );
        assert.equal(
          await evaluate("window.monitorHarness.hosts[1].messages.length"),
          0,
        );
        await evaluate(
          "window.monitorHarness.store.emit('run-a', {type:'log',message:'Still live'});window.monitorHarness.store.emit('run-b', {type:'log',message:'Also live'})",
        );
        await waitFor(
          "window.monitorHarness.hosts.every(host => host.calls.filter(call => call.name === 'workflow-events').length > 1)",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('[data-panel=\"0\"] .log-rows').scrollTop",
          ),
          40,
        );
      },
    );

    await t.test(
      "fullscreen and host-initiated exit preserve agent selection and transcript position",
      async () => {
        await click("Expand");
        await waitFor(
          "document.querySelector('[data-panel=\"0\"] main').classList.contains('mode-fullscreen')",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('[data-panel=\"0\"] .log-rows').scrollTop",
          ),
          40,
        );
        await evaluate(
          "window.monitorHarness.hosts[0].hostContext({displayMode:'inline',safeAreaInsets:{top:5,right:8,bottom:12,left:8},containerDimensions:{width:360,height:620}})",
        );
        await waitFor(
          "document.querySelector('[data-panel=\"0\"] main').classList.contains('mode-inline')",
        );
        assert.equal(
          await evaluate(
            "!!document.querySelector('[data-panel=\"0\"] .detail')",
          ),
          true,
        );
        assert.equal(
          await evaluate(
            "document.querySelector('[data-panel=\"0\"] main').getBoundingClientRect().width",
          ),
          360,
        );
        assert.equal(
          await evaluate(
            "getComputedStyle(document.querySelector('[data-panel=\"0\"] main')).paddingBottom",
          ),
          "12px",
        );
        await evaluate(
          "window.monitorHarness.hosts[0].rejectFullscreen = true",
        );
        await click("Expand");
        await waitFor(
          "document.querySelector('[data-panel=\"0\"]').textContent.includes('Fullscreen is unavailable')",
        );
        assert.equal(
          await evaluate(
            "!!document.querySelector('[data-panel=\"0\"] .detail')",
          ),
          true,
        );
      },
    );

    await t.test(
      "same-run panels deduplicate required input and terminal notifications, reopening history stays quiet",
      async () => {
        await reset();
        await evaluate("window.monitorHarness.open('run-a', false)");
        await waitFor("window.monitorHarness.hosts[1]?.contexts.length > 0");
        await evaluate(
          "window.monitorHarness.store.scenario('run-a','permission')",
        );
        await waitFor(
          "window.monitorHarness.hosts.reduce((n,host)=>n+host.messages.length,0)===1",
        );
        await waitFor(
          "document.querySelectorAll('.action-section h2').length === 2",
        );
        await click("Allow onceallow once");
        await waitFor(
          "window.monitorHarness.store.runs.get('run-a').snapshot.pendingPermissions.length === 0",
        );
        const request = await evaluate<any>(
          "window.monitorHarness.hosts[0].calls.find(call => call.arguments?.action === 'permissions-response')",
        );
        assert.deepEqual(request.arguments, {
          action: "permissions-response",
          runId: "run-a",
          permissionId: "permission-run-a",
          response: { outcome: "selected", optionId: "allow-once" },
        });
        await evaluate(
          "window.monitorHarness.store.scenario('run-a','completed')",
        );
        await waitFor(
          "window.monitorHarness.hosts.reduce((n,host)=>n+host.messages.length,0)===2",
        );
        await evaluate("window.monitorHarness.open('run-a',false)");
        await waitFor("window.monitorHarness.hosts[2]?.contexts.length > 0");
        assert.equal(
          await evaluate("window.monitorHarness.hosts[2].messages.length"),
          0,
        );
      },
    );

    await t.test(
      "setup and checkpoint controls use current identities and preserve retry identity after rejection",
      async () => {
        await reset();
        await evaluate("window.monitorHarness.store.scenario('run-a','setup')");
        await waitFor("document.querySelector('.setup-field select')");
        await evaluate(
          "(() => { const select = document.querySelector('.setup-field select'); select.value='true'; select.dispatchEvent(new Event('change',{bubbles:true})); })()",
        );
        await click("Submit setup");
        await waitFor(
          "window.monitorHarness.hosts[0].calls.some(call => call.arguments?.action === 'setup-response')",
        );
        const setup = await evaluate<any>(
          "window.monitorHarness.hosts[0].calls.find(call => call.arguments?.action === 'setup-response').arguments",
        );
        assert.deepEqual(setup, {
          action: "setup-response",
          runId: "run-a",
          setupId: "setup-run-a",
          response: { action: "accept", content: { approve: true } },
        });
        await evaluate(
          "window.monitorHarness.store.scenario('run-a','checkpoint'); window.monitorHarness.hosts[0].rejectAction = true; window.monitorHarness.hosts[0].statusDelayMs = 100",
        );
        await waitFor(
          "[...document.querySelectorAll('[data-panel=\"0\"] button')].some(node => node.textContent === 'Yes, continue')",
        );
        await click("Yes, continue");
        await waitFor(
          "document.querySelector('.action-error')?.textContent.includes('stale')",
        );
        await evaluate("new Promise(done => setTimeout(done, 200))");
        await click("Yes, continue");
        await waitFor(
          "window.monitorHarness.hosts[0].calls.filter(call => call.arguments?.action === 'resume').length === 2",
        );
        const retries = await evaluate<any[]>(
          "window.monitorHarness.hosts[0].calls.filter(call => call.arguments?.action === 'resume').map(call => call.arguments)",
        );
        assert.deepEqual(retries[1], retries[0], "a retried decision resends the identical resume input");
        assert.deepEqual(retries[0].checkpointReplies, { "1": true });
        assert.equal(retries[0].runId, "run-a");
        assert.equal("background" in retries[0], false);
        await evaluate("window.monitorHarness.hosts[0].statusFailures = 1");
        await click("Yes, continue");
        await waitFor(
          "document.querySelector('.banner-error')?.textContent.includes('Temporary status failure')",
        );
        await click("Refresh status");
        await waitFor(
          "[...document.querySelectorAll('button')].some(node => node.textContent === 'Yes, continue')",
        );
        await click("Yes, continue");
        await waitFor(
          "window.monitorHarness.hosts[0].calls.filter(call => call.arguments?.action === 'resume').length === 4",
        );
        const afterOutage = await evaluate<any[]>(
          "window.monitorHarness.hosts[0].calls.filter(call => call.arguments?.action === 'resume').map(call => call.arguments)",
        );
        assert.deepEqual(afterOutage, Array(4).fill(retries[0]));
        await evaluate("window.monitorHarness.hosts[0].rejectAction = false");
        await click("No");
        await waitFor(
          "window.monitorHarness.store.runs.get('run-a').snapshot.status === 'running'",
        );
        await waitFor(
          "document.querySelector('[data-panel=\"0\"] .bar.top .chip')?.textContent.includes('Running')",
        );
      },
    );

    await t.test(
      "agent stop targets the selected call; exact result paging never uses event previews",
      async () => {
        await reset();
        await click("Research transport");
        await click("Stop this agent");
        const stop = await evaluate<any>(
          "window.monitorHarness.hosts[0].calls.find(call => call.arguments?.action === 'stop').arguments",
        );
        assert.deepEqual(stop, {
          action: "stop",
          runId: "run-a",
          callIndex: 0,
        });
        await evaluate(
          "window.monitorHarness.store.runs.get('run-a').result = JSON.stringify({exact:'Z'.repeat(17000)}); window.monitorHarness.store.scenario('run-a','completed')",
        );
        await waitFor(
          "[...document.querySelectorAll('button')].some(node=>node.textContent==='Inspect exact result')",
        );
        await click("Inspect exact result");
        await waitFor(
          "document.querySelector('pre[aria-label=\"Exact result\"]')?.textContent.length === 16384",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('pre[aria-label=\"Exact result\"]').textContent.includes('REDACTED PREVIEW')",
          ),
          false,
        );
        await click("Next page");
        await waitFor(
          "document.querySelector('.exact-result p').textContent.includes('16384')",
        );
        const pages = await evaluate<any[]>(
          "window.monitorHarness.hosts[0].calls.filter(call=>call.arguments?.action==='result').map(call=>call.arguments)",
        );
        assert.deepEqual(
          pages.map((page) => [page.offset, page.maxBytes]),
          [
            [0, 16384],
            [16384, 16384],
          ],
        );
        await evaluate(
          "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text)=>{window.monitorHarness.copied=text}}})",
        );
        await click("Copy this page");
        await waitFor("typeof window.monitorHarness.copied==='string'");
        assert.equal(
          await evaluate("window.monitorHarness.copied"),
          await evaluate(
            "document.querySelector('pre[aria-label=\"Exact result\"]').textContent",
          ),
        );
      },
    );

    await t.test(
      "reused input stops old polling and ignores late old results, teardown stops calls",
      async () => {
        await reset();
        await evaluate(
          "window.monitorHarness.hosts[0].deferEvents=true; window.monitorHarness.hosts[0].input('run-a')",
        );
        await waitFor("window.monitorHarness.hosts[0].deferred.length>0");
        await evaluate(
          "window.monitorHarness.hosts[0].input('run-b'); window.monitorHarness.hosts[0].releaseEvents(); window.monitorHarness.hosts[0].result('run-a',true)",
        );
        await waitFor(
          "document.querySelector('main').dataset.runId === 'run-b' && document.querySelector('.wf-name')?.textContent === 'Workflow run-b'",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('main').textContent.includes('No workflow run found for run-a')",
          ),
          false,
        );
        await evaluate("window.monitorHarness.hosts[0].teardown()");
        await waitFor(
          "document.querySelector('main').textContent.includes('Monitor closed')",
        );
        const count = await evaluate(
          "window.monitorHarness.hosts[0].calls.length",
        );
        await evaluate("new Promise(done=>setTimeout(done,2200))");
        assert.equal(
          await evaluate("window.monitorHarness.hosts[0].calls.length"),
          count,
        );
        await evaluate("window.monitorHarness.reopen(0)");
        await waitFor(
          "document.querySelector('.wf-name')?.textContent === 'Workflow run-b'",
        );
      },
    );

    await t.test(
      "poll faults back off, give up visibly, and explicit reconnect recovers",
      async () => {
        await reset();
        await evaluate(`(() => {
      const original = window.setTimeout.bind(window);
      window.monitorHarness.delays = [];
      window.setTimeout = (callback, ms, ...args) => {
        if (ms >= 1500 && ms <= 15000) { window.monitorHarness.delays.push(ms); return original(callback, 25, ...args); }
        return original(callback, ms, ...args);
      };
      window.monitorHarness.hosts[0].eventFailures = 5;
      window.monitorHarness.hosts[0].input('run-a');
    })()`);
        await waitFor(
          "document.querySelector('[data-panel=\"0\"]').textContent.includes('disconnected — updates stopped')",
        );
        const delays = await evaluate<number[]>("window.monitorHarness.delays");
        assert.ok(delays.includes(4000));
        assert.ok(delays.includes(8000));
        assert.ok(delays.includes(15000));
        const before = await evaluate<number>(
          "window.monitorHarness.hosts[0].calls.filter(call=>call.name==='workflow-events').length",
        );
        await evaluate("new Promise(done => setTimeout(done,100))");
        assert.equal(
          await evaluate(
            "window.monitorHarness.hosts[0].calls.filter(call=>call.name==='workflow-events').length",
          ),
          before,
        );
        await click("Reconnect");
        await waitFor(
          "!document.querySelector('[data-panel=\"0\"]').textContent.includes('disconnected — updates stopped') && document.querySelector('[data-panel=\"0\"] .node.status-running')",
        );
      },
    );

    await t.test(
      "rejected context and conversation delivery leave inspection and controls working",
      async () => {
        await reset();
        await evaluate(
          "window.monitorHarness.hosts[0].rejectContext=true; window.monitorHarness.hosts[0].rejectMessage=true",
        );
        await click("Research transport");
        await click("Ask about this agent");
        await waitFor(
          "document.querySelector('.action-error')?.textContent.includes('declined')",
        );
        assert.equal(
          await evaluate("!!document.querySelector('.detail')"),
          true,
        );
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('[data-panel=\"0\"] button')].some(node=>node.textContent==='Stop this agent')",
          ),
          true,
        );
        await evaluate(
          "window.monitorHarness.store.scenario('run-a','completed')",
        );
        await waitFor(
          "[...document.querySelectorAll('button')].some(node=>node.textContent==='Inspect exact result')",
        );
        await click("Inspect exact result");
        await waitFor(
          "document.querySelector('pre[aria-label=\"Exact result\"]')",
        );
        await evaluate(
          "Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined})",
        );
        await click("Copy result");
        await waitFor(
          "document.querySelector('.exact-result').textContent.includes('Select the result text to copy it')",
        );
      },
    );

    await t.test(
      "unsupported context/message capabilities do not hide controls; invalid input and cancellation fail clearly",
      async () => {
        await reset();
        await evaluate(
          "window.monitorHarness.hosts[0].capabilities={serverTools:{}}; window.monitorHarness.hosts[0].hostContext({availableDisplayModes:['inline']}); window.monitorHarness.hosts[0].input('run-b')",
        );
        await waitFor(
          "document.querySelector('.wf-name')?.textContent === 'Workflow run-b'",
        );
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('[data-panel=\"0\"] button')].some(node=>node.textContent.startsWith('Ask about') || node.textContent==='Expand')",
          ),
          false,
        );
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('[data-panel=\"0\"] button')].some(node=>node.textContent==='Stop run')",
          ),
          true,
        );
        await evaluate("window.monitorHarness.hosts[0].invalidInput()");
        await waitFor(
          "document.querySelector('main').textContent.includes('requires an explicit existing runId')",
        );
        await evaluate("window.monitorHarness.hosts[0].input('missing-run')");
        await waitFor(
          "document.querySelector('main').textContent.includes('no longer present')",
        );
        await evaluate(
          "window.monitorHarness.hosts[0].input('run-a'); window.monitorHarness.hosts[0].cancel()",
        );
        await waitFor(
          "document.querySelector('main').textContent.includes('Monitor opening was cancelled')",
        );
      },
    );
    assert.deepEqual(
      pageErrors,
      [],
      "the complete app emitted no browser exceptions",
    );
  },
);
