// End-to-end public interactive sessions against the MOCK ACP agent. These tests prove the
// dedicated-process contract separately from the pooled one-shot run() contract: a held-open
// session can take multiple prompt turns, but it never consumes the pool slot used by run().
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ContentBlock, type RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgentRunner, type AcpRunnerOptions, type CustomBackendConfig } from "../src/index.js";
import {
  createFakeAgentHarness,
  FAKE_AGENT_FIXTURE,
  readLog as readLogFile,
  waitFor,
} from "./helpers/fake-agent.js";

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const REJECT: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "reject-1" } };

interface LogEntry {
  method: string;
  pid?: number;
  reason?: string;
  outcome?: RequestPermissionResponse["outcome"];
  params?: {
    sessionId?: string;
    prompt?: ContentBlock[];
    configId?: string;
    value?: string;
    _meta?: Record<string, unknown> | null;
  };
}

const SCHEMA = {
  type: "object",
  properties: { city: { type: "string" }, hot: { type: "boolean" } },
  required: ["city", "hot"],
};

/** A registry config that spawns the fake ACP agent (custom-backend path). */
function fakeCustomBackend(scenario: unknown): {
  config: CustomBackendConfig;
  cwd: string;
  readLog: () => LogEntry[];
} {
  const dir = mkdtempSync(join(tmpdir(), "acp-interactive-custom-"));
  const log = join(dir, "log.jsonl");
  return {
    config: {
      command: process.execPath,
      args: [FAKE_AGENT_FIXTURE],
      env: {
        AGENTPRISM_FAKE_SCENARIO: JSON.stringify(scenario),
        AGENTPRISM_FAKE_LOG: log,
      },
    },
    cwd: dir,
    readLog: () => readLogFile<LogEntry>(log),
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-interactive-it-", backends: ["claude"] });
const configure = (scenario: unknown, options?: Parameters<ReturnType<typeof createFakeAgentHarness>["configure"]>[1]) =>
  harness.configure<LogEntry>(scenario, options);

function makeRunner(options: AcpRunnerOptions = {}): AcpAgentRunner {
  return harness.makeRunner(options);
}

const count = (entries: LogEntry[], method: string): number =>
  entries.filter((entry) => entry.method === method).length;

function pidOfFirst(entries: LogEntry[], method: string): number {
  const pid = entries.find((entry) => entry.method === method)?.pid;
  assert.equal(typeof pid, "number", `${method} carried a pid`);
  return pid;
}

function permissionOutcome(log: LogEntry[]): RequestPermissionResponse["outcome"] | undefined {
  return log.find((entry) => entry.method === "permissionOutcome")?.outcome;
}

afterEach(async () => {
  await harness.cleanup();
});

test("interactive session drives three prompt turns on one dedicated process", async () => {
  const image = { data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png", uri: "file:///tmp/screen.png" };
  const { cwd, readLog } = configure({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} }, promptCapabilities: { image: true } },
    },
    turns: [{ text: "one" }, { text: "two" }, { text: ["three", "!"] }],
  });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, label: "chat" });

  assert.equal((await session.prompt("first")).text, "one");
  assert.equal((await session.prompt([{ type: "text", text: "second" }])).text, "two");
  const third = await session.prompt("third", { images: [image] });
  assert.deepEqual(third, { stopReason: "end_turn", text: "three!" });
  await session.release();

  const log = readLog();
  const newSessions = log.filter((entry) => entry.method === "newSession");
  const prompts = log.filter((entry) => entry.method === "prompt");
  const pid = pidOfFirst(log, "__start");
  assert.equal(count(log, "__start"), 1, "one dedicated process spawned");
  assert.equal(newSessions.length, 1, "one ACP session opened");
  assert.equal(prompts.length, 3, "three prompt turns sent");
  assert.ok(newSessions.every((entry) => entry.pid === pid), "session/new used the dedicated process");
  assert.ok(prompts.every((entry) => entry.pid === pid), "all turns used the same process");
  assert.deepEqual(prompts[2]?.params?.prompt, [{ type: "text", text: "third" }, { type: "image", ...image }]);
});

test("interactive prompt maps a structured provider wall with reset metadata", async () => {
  const live =
    "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.";
  const { cwd } = configure({
    turns: [{
      throw: live,
      throwData: { errorKind: "billing_error" },
      usageUpdate: {
        used: 10,
        size: 100,
        _meta: {
          "_claude/rateLimit": {
            status: "rejected",
            resetsAt: Date.parse("2026-07-15T09:00:00.000Z") / 1_000,
          },
        },
      },
    }],
  });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, label: "chat-wall" });

  await assert.rejects(session.prompt("continue"), (error: unknown) => {
    assert.ok(isWorkflowError(error));
    assert.equal(error.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal(error.agentLabel, "chat-wall");
    assert.equal(error.providerUsageLimitContext?.resetAt, "2026-07-15T09:00:00.000Z");
    return true;
  });
  await session.release();
});

test("run() still completes while an interactive session is held open on the same backend", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "pooled ok" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });

  const out = await runner.run("one-shot", { cwd });
  assert.equal(out, "pooled ok");

  const log = readLog();
  assert.equal(count(log, "__start"), 2, "interactive and pooled paths spawned separate processes");
  assert.equal(count(log, "newSession"), 2, "held interactive session did not block run()");
  assert.equal(count(log, "prompt"), 1, "only the one-shot run prompted");
  await session.release();
});

test("per-session on() ignores events from a parallel run() session", async () => {
  const { cwd } = configure({ turns: [{ text: "event text" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, label: "interactive" });
  const seen: Array<{ text: string; label?: string; sessionId: string }> = [];
  session.on("agent_message_chunk", (event) => {
    if (event.content.type === "text") {
      seen.push({ text: event.content.text, label: event.label, sessionId: event.sessionId });
    }
  });

  const [turn, runOut] = await Promise.all([
    session.prompt("interactive prompt"),
    runner.run("one-shot prompt", { cwd, label: "one-shot" }),
  ]);

  assert.equal(turn.text, "event text");
  assert.equal(runOut, "event text");
  assert.deepEqual(seen, [{ text: "event text", label: "interactive", sessionId: session.sessionId }]);
  await session.release();
});

test("openSession sends an unprefixed model verbatim without a fallback callback", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();
  const fallbacks: string[] = [];
  const resolved: string[] = [];
  const session = await runner.openSession({
    cwd,
    model: "not-a-real-model",
    onModelFallback: (spec) => fallbacks.push(spec),
    onModelResolved: (model) => resolved.push(model),
  });

  assert.deepEqual(fallbacks, []);
  assert.deepEqual(resolved, ["not-a-real-model"]);
  const modelSet = readLog().find(
    (entry) => entry.method === "setSessionConfigOption" && entry.params?.configId === "model",
  );
  assert.equal(modelSet?.params?.value, "not-a-real-model");
  await session.release();
});

test("release() closes the interactive session and dedicated process, leaving the pooled process alive", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });
  const interactivePid = pidOfFirst(readLog(), "newSession");

  assert.equal(await runner.run("one-shot", { cwd }), "ok");
  const afterRun = readLog();
  const pooledPid = afterRun.find((entry) => entry.method === "newSession" && entry.pid !== interactivePid)?.pid;
  assert.equal(typeof pooledPid, "number", "pooled run used a different process");

  await session.release();
  const afterRelease = readLog();
  assert.ok(
    afterRelease.some((entry) => entry.method === "closeSession" && entry.pid === interactivePid),
    "interactive session was closed",
  );
  assert.ok(
    afterRelease.some((entry) => entry.method === "__exit" && entry.pid === interactivePid),
    "dedicated process exited on release",
  );
  assert.equal(
    afterRelease.some((entry) => entry.method === "__exit" && entry.pid === pooledPid),
    false,
    "pooled process remained alive until runner.dispose()",
  );
});

test("dedicated process death auto-releases the interactive session", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, label: "crash-watch" });
  const pid = pidOfFirst(readLog(), "newSession");
  const closes: string[] = [];
  session.on("session_close", (event) => closes.push(event.sessionId));

  process.kill(pid, "SIGKILL");
  await waitFor(() => closes.includes(session.sessionId));

  await assert.rejects(() => session.prompt("after death"), /InteractiveSession has been released/);
  await runner.dispose();
});

test("a second prompt while one is in flight throws and the active turn can be cancelled", async () => {
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });
  const first = session.prompt("wait");
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  await assert.rejects(
    () => session.prompt("second"),
    /InteractiveSession\.prompt\(\) already has a prompt in flight/,
  );
  await session.cancel();
  assert.deepEqual(await first, { stopReason: "cancelled", text: "" });
  await session.release();
});

test("session-level onPermissionRequest overrides the runner-level resolver", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "done" }],
  });
  let runnerResolverCalls = 0;
  let sessionResolverCalls = 0;
  const runner = makeRunner({
    onPermissionRequest: () => {
      runnerResolverCalls += 1;
      return REJECT;
    },
  });
  const session = await runner.openSession({
    cwd,
    disallowedToolNames: ["read"],
    onPermissionRequest: () => {
      sessionResolverCalls += 1;
      return ALLOW;
    },
  });

  assert.equal((await session.prompt("do it")).text, "done");
  assert.equal(runnerResolverCalls, 0);
  assert.equal(sessionResolverCalls, 1);
  assert.deepEqual(permissionOutcome(readLog()), ALLOW.outcome);
  await session.release();
});

test("signal abort releases the interactive session", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();
  const controller = new AbortController();
  const session = await runner.openSession({ cwd, signal: controller.signal });
  const pid = pidOfFirst(readLog(), "newSession");

  controller.abort();
  await waitFor(() => {
    const log = readLog();
    return (
      log.some((entry) => entry.method === "closeSession" && entry.pid === pid) &&
      log.some((entry) => entry.method === "__exit" && entry.pid === pid)
    );
  });
  await assert.rejects(() => session.prompt("after abort"), /InteractiveSession has been released/);
});

test("runner.dispose() releases a still-open interactive session before the pool", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });
  const pid = pidOfFirst(readLog(), "newSession");

  await runner.dispose();
  const log = readLog();
  assert.ok(log.some((entry) => entry.method === "closeSession" && entry.pid === pid), "session closed");
  assert.ok(log.some((entry) => entry.method === "__exit" && entry.pid === pid), "process reaped");
  await assert.rejects(() => session.prompt("after dispose"), /InteractiveSession has been released/);
});

test("openSession({ schema }) folds the contract into the backend's native schema channels", async () => {
  const schema = {
    type: "object",
    properties: { city: { type: "string" }, hot: { type: "boolean" } },
    required: ["city", "hot"],
  };

  // Claude: the schema rides session/new `_meta.claudeCode.options.outputFormat`; the turns
  // carry NOTHING (the channel is session-scoped, exactly like run()).
  const claude = configure({ turns: [{ text: "one" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd: claude.cwd, schema: schema as never, label: "schema-session" });
  assert.equal((await session.prompt("classify")).text, "one");
  await session.release();
  const claudeLog = claude.readLog();
  const claudeCode = claudeLog.find((e) => e.method === "newSession")?.params?._meta?.claudeCode as
    | { options: { outputFormat: { type: string; schema: Record<string, unknown> } }; emitRawSDKMessages: boolean }
    | undefined;
  assert.equal(claudeCode?.options.outputFormat.type, "json_schema");
  assert.deepEqual(claudeCode?.options.outputFormat.schema.properties, schema.properties);
  assert.equal(claudeCode?.emitRawSDKMessages, true);
  assert.equal(claudeLog.find((e) => e.method === "prompt")?.params?._meta ?? undefined, undefined);

  // Codex: the STRICT schema rides each turn's `_meta[outputSchema]`; session/new carries
  // nothing schema-shaped. (`model: "codex/..."` routes to the codex backend — the
  // schema channels are backend-specific, so the backend must actually be codex.)
  const codex = configure({ turns: [{ text: "one" }] }, { backends: ["codex"] });
  const runner2 = makeRunner();
  const session2 = await runner2.openSession({
    cwd: codex.cwd,
    model: "codex/gpt-5.6-luna",
    schema: schema as never,
    label: "codex-schema",
  });
  assert.equal((await session2.prompt("classify")).text, "one");
  await session2.release();
  const codexLog = codex.readLog();
  const forwarded = codexLog.find((e) => e.method === "prompt")?.params?._meta?.outputSchema as
    | Record<string, unknown>
    | undefined;
  // strict-normalized: every prop required + additionalProperties:false (the same shape
  // run()'s (2b) test pins for the one-shot path).
  assert.deepEqual(forwarded, {
    type: "object",
    required: ["city", "hot"],
    properties: { city: { type: "string" }, hot: { type: "boolean" } },
    additionalProperties: false,
  });
  assert.equal(codexLog.find((e) => e.method === "newSession")?.params?._meta ?? undefined, undefined);
});

test("openSession({ schema }) states the contract in-band for embedSchemaInPrompt backends", async () => {
  // A custom backend (embedSchemaInPrompt defaults true): the prompt text carries the
  // contract because its agent may ignore the `_meta.outputSchema` forward entirely.
  const { config, cwd, readLog } = fakeCustomBackend({ turns: [{ text: "done" }] });
  const runner = makeRunner({ backends: { fake: config } });
  const session = await runner.openSession({ cwd, model: "fake", schema: SCHEMA as never });
  assert.equal((await session.prompt("classify")).text, "done");
  await session.release();
  const promptEntry = readLog().find((e) => e.method === "prompt");
  const text = (promptEntry?.params?.prompt ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
  assert.ok(text.includes("classify"), text);
  assert.match(text, /Final output contract/);
  assert.ok(text.includes(JSON.stringify(SCHEMA)), "the schema is embedded in-band");
  // And the generic `_meta.outputSchema` forward is present on the turn too.
  assert.deepEqual(
    (promptEntry?.params?._meta?.outputSchema as { properties: unknown }).properties,
    SCHEMA.properties,
  );
});

test("awaitCurrentTurn on a loaded session: the founding turn's outcome is observable from the replay (and the still-running case rejects with the honest unobservable error)", async () => {
  // Phase D re-attach arm over the REAL adapter: `loadSession` replays the persisted
  // transcript, and the seam's observability probe keys on its trailing content event
  // (the only completion evidence the ACP protocol exposes for a session re-opened via
  // session/load).
  const { cwd } = harness.configure<LogEntry>({
    loadSessionSupport: true,
    loadSession: {
      replay: [
        { role: "user", text: "task" },
        { role: "assistant", text: "result B (loaded)" },
      ],
    },
  });
  const runner = harness.makeRunner();
  const loaded = await runner.loadSession({ sessionId: "fake-session-any", cwd, model: "claude" });
  const turn = await loaded.awaitCurrentTurn();
  // The founding turn's REAL outcome, resolved from the replay; the stop reason is
  // synthesized `end_turn` (the protocol's replay carries none).
  assert.deepEqual(turn, { stopReason: "end_turn", text: "result B (loaded)" });
  // The transcript accessors agree with the seam (the broker's schema ladder reads the
  // same surface).
  assert.equal(loaded.finalMessageText(), "result B (loaded)");
  assert.equal(loaded.currentTurnText(), "result B (loaded)");
  await loaded.release();

  // The still-running case: the replay ends at the founding turn's user message (no
  // terminal assistant message) — the completion is not observable over the protocol,
  // and the seam rejects with the honest host-side error (the broker degrades to
  // re-issue).
  const { cwd: cwd2 } = harness.configure<LogEntry>({
    loadSessionSupport: true,
    loadSession: { replay: [{ role: "user", text: "task" }] },
  });
  const runner2 = harness.makeRunner();
  const loaded2 = await runner2.loadSession({ sessionId: "fake-session-any", cwd: cwd2, model: "claude" });
  await assert.rejects(() => loaded2.awaitCurrentTurn(), (error: unknown) =>
    (error as Error).message.includes("still in flight at the backend"),
  );
  await loaded2.release();
});
