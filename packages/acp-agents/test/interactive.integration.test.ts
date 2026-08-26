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
  assert.deepEqual(third, {
    stopReason: "end_turn",
    text: "three!",
    response: { stopReason: "end_turn" },
  });
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

test("interactive turns expose the complete PromptResponse including arbitrary nested metadata", async () => {
  const responseMeta = {
    vendor: {
      nested: [1, null, { complete: true, future: { value: "untouched" } }],
    },
  };
  const { cwd } = configure({
    turns: [{
      text: "done",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      responseMeta,
    }],
  });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });

  const turn = await session.prompt("work");
  assert.deepEqual(turn, {
    stopReason: "end_turn",
    text: "done",
    response: {
      stopReason: "end_turn",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      _meta: responseMeta,
    },
  });
  await session.release();
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
  assert.deepEqual(await first, {
    stopReason: "cancelled",
    text: "",
    response: { stopReason: "cancelled" },
  });
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

test("awaitCurrentTurn on a loaded session: the _session/loaded_turn extension makes the founding turn's terminal state authoritative — completed-while-down settles from the replay, a still-running turn settles ONLY from the ended notification (never a quiet gap, never a re-issue), interrupted re-issues, and a backend WITHOUT the extension is classified authoritatively by the observation path (the post-load continuation watch + the replay probe under the connection-death contract — never a quiet-gap guess, never a possibly-running re-issue)", async () => {
  // The round-3 semantics: completion evidence is the _session/loaded_turn extension's
  // terminal state (the steering-extension precedent), NOT quiet-gap heuristics. The
  // backend answers whether the founding turn is still running at query time and pushes
  // the authoritative `_session/loaded_turn/ended` notification when a running turn ends.
  const prevMax = process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
  process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = "400";
  const prevObserve = process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS;
  try {
    // 1) Completed while down: the backend's query answers `completed` (the replay's
    //    trailing assistant message is the turn's FINAL message — an authoritative
    //    answer, not a quiet-gap guess), and the seam resolves immediately with the
    //    real outcome text (stop reason synthesized `end_turn`).
    const { cwd, readLog } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        loadedTurn: { status: "completed" },
        replay: [
          { role: "user", text: "task" },
          { role: "assistant", text: "result B (loaded)" },
        ],
      },
    });
    const runner = harness.makeRunner();
    const loaded = await runner.loadSession({ sessionId: "fake-session-any", cwd, model: "claude" });
    const turn = await loaded.awaitCurrentTurn();
    assert.deepEqual(turn, { stopReason: "end_turn", text: "result B (loaded)" });
    // The transcript accessors agree with the seam (the broker's schema ladder reads the
    // same surface).
    assert.equal(loaded.finalMessageText(), "result B (loaded)");
    assert.equal(loaded.currentTurnText(), "result B (loaded)");
    // The query was actually asked on the wire (the fixture records it).
    assert.ok(
      readLog().some((e) => e.method === "extensionRequest" && e.extensionMethod === "_session/loaded_turn/query"),
      "the seam asked the backend for the authoritative terminal state",
    );
    await loaded.release();

    // 2) THE ROUND-3 REGRESSION: a restored transcript ending in an assistant PARTIAL
    //    with the turn still running at the backend — the next live chunk arrives LATER
    //    than any quiet grace. The old seam declared the replay-complete transcript
    //    settled after the quiet grace, durably recording the partial as the call's
    //    outcome. The extension's `running` answer makes the trailing assistant message
    //    PARTIAL (the turn is still executing), so the seam must NOT settle at any quiet
    //    gap: it waits for the authoritative `_session/loaded_turn/ended` notification
    //    and settles with the turn's REAL accumulated text only then.
    const { cwd: cwd2 } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        loadedTurn: { status: "running" },
        replay: [
          { role: "user", text: "task" },
          { role: "assistant", text: "partial " },
        ],
        // The next live chunk arrives at 150 ms — far later than the old 100 ms settle
        // grace — and the turn's authoritative end arrives at 250 ms.
        continue: [
          { afterMs: 150, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "result C" } } },
        ],
        turnEnded: { afterMs: 250, stopReason: "end_turn" },
      },
    });
    const runner2 = harness.makeRunner();
    const loaded2 = await runner2.loadSession({ sessionId: "fake-session-any", cwd: cwd2, model: "claude" });
    let settled: { stopReason: string; text: string } | undefined;
    let rejected: unknown;
    const wait = loaded2.awaitCurrentTurn().then(
      (turn) => {
        settled = turn;
      },
      (error) => {
        rejected = error;
      },
    );
    // At 190 ms (past the old grace, after the late chunk): the seam must STILL be
    // waiting — the running turn's terminal state is not yet observable, and a quiet
    // gap is never terminal evidence (the round-1/2 defect: partial output durably
    // settled as a completed-while-down turn).
    await new Promise((resolve) => setTimeout(resolve, 190));
    assert.equal(settled, undefined, "the seam must not settle a quiet gap for a running turn");
    assert.equal(rejected, undefined, "the seam must not reject while the turn is still running");
    await wait;
    assert.deepEqual(settled, { stopReason: "end_turn", text: "partial result C" }, "the seam settles from the authoritative ended notification — consecutive replay/live deltas of one message concatenate verbatim");
    await loaded2.release();

    // 3) Never terminal: the backend's query answers `interrupted` (no turn running —
    //    the founding turn ended without a terminal assistant message while the host was
    //    down). The seam rejects IMMEDIATELY with the safe-re-issue class (nothing is
    //    running at the backend to duplicate) — no max-wait needed.
    const { cwd: cwd3 } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        loadedTurn: { status: "interrupted" },
        replay: [{ role: "user", text: "task" }],
      },
    });
    const runner3 = harness.makeRunner();
    const loaded3 = await runner3.loadSession({ sessionId: "fake-session-any", cwd: cwd3, model: "claude" });
    await assert.rejects(
      () => loaded3.awaitCurrentTurn(),
      (error: unknown) =>
        (error as Error).message.includes("ended without a terminal assistant message") &&
        (error as Error).message.includes("re-issue is the honest fallback"),
    );
    await loaded3.release();

    // 4) A `running` turn whose terminal notification never arrives hits the max-wait
    //    backstop: the seam rejects with the RE-ARMABLE still-running class (the
    //    duplicate-risk marker — the broker keeps the loaded session attached and re-arms
    //    the seam on it; it never settles a quiet gap, and a later notification or a
    //    cancel still settles the call).
    const { cwd: cwd4 } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        loadedTurn: { status: "running" },
        replay: [{ role: "user", text: "task" }],
      },
    });
    const runner4 = harness.makeRunner();
    const loaded4 = await runner4.loadSession({ sessionId: "fake-session-any", cwd: cwd4, model: "claude" });
    await assert.rejects(
      () => loaded4.awaitCurrentTurn(),
      (error: unknown) => {
        assert.ok(
          (error as { loadedTurnStillRunning?: unknown }).loadedTurnStillRunning === true,
          `the still-running marker: ${String((error as Error).message)}`,
        );
        assert.equal((error as { rearmable?: unknown }).rearmable, true, "re-armable: the notification may still arrive");
        assert.ok((error as Error).message.includes("still running at the backend"), (error as Error).message);
        return true;
      },
    );
    await loaded4.release();

    // 5) THE OBSERVATION PATH — a backend WITHOUT the extension (no
    //    `_meta.loadedTurn.supported` advertisement; the built-in claude
    //    and opencode backends today). The seam classifies the founding
    //    turn's terminal state authoritatively instead of rejecting: the
    //    post-load continuation watch (any CONTENT update after the load
    //    boundary is live continuation — the still-running signal), then
    //    the replay probe (an assistant trailing message is a COMPLETED,
    //    persisted message — the turn observably completed while down;
    //    anything else means the turn died mid-way — nothing running,
    //    safe to re-issue). Phase-F review round 2: the old rejection-
    //    and-re-issue degradation could duplicate a still-running turn;
    //    the observation path never re-issues a possibly-running call.
    //
    // 5a) Replay ends with the turn's terminal assistant message and no
    //     live continuation follows the load → completed-while-down,
    //     resolved with the real accumulated text.
    process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS = "150";
    const { cwd: cwd5a, readLog: readLog5a } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        replay: [
          { role: "user", text: "task" },
          { role: "assistant", text: "result B (loaded)" },
        ],
      },
    });
    const runner5a = harness.makeRunner();
    const loaded5a = await runner5a.loadSession({ sessionId: "fake-session-any", cwd: cwd5a, model: "claude" });
    const turn5a = await loaded5a.awaitCurrentTurn();
    assert.deepEqual(turn5a, { stopReason: "end_turn", text: "result B (loaded)" });
    assert.ok(
      !readLog5a().some(
        (e) => e.method === "extensionRequest" && e.extensionMethod === "_session/loaded_turn/query",
      ),
      "no query on the wire — the observation path needs no extension",
    );
    await loaded5a.release();

    // 5b) Live continuation arrives WITHIN the observation window → the
    //     turn is still running: the seam keeps the loaded session
    //     attached, never settles the quiet gap, never re-issues, and
    //     rejects with the RE-ARMABLE still-running class at the max-wait
    //     bound (the broker re-arms the wait on the attached session).
    const { cwd: cwd5b } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        replay: [
          { role: "user", text: "task" },
          { role: "assistant", text: "looks complete but is partial" },
        ],
        continue: [
          { afterMs: 60, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " — live continuation" } } },
        ],
      },
    });
    const runner5b = harness.makeRunner();
    const loaded5b = await runner5b.loadSession({ sessionId: "fake-session-any", cwd: cwd5b, model: "claude" });
    await assert.rejects(
      () => loaded5b.awaitCurrentTurn(),
      (error: unknown) => {
        assert.ok(
          (error as { loadedTurnStillRunning?: unknown }).loadedTurnStillRunning === true,
          `the still-running marker: ${String((error as Error).message)}`,
        );
        assert.equal((error as { rearmable?: unknown }).rearmable, true, "re-armable: the broker keeps the attached session and re-arms");
        assert.ok((error as Error).message.includes("live content followed the load"), (error as Error).message);
        return true;
      },
    );
    await loaded5b.release();

    // 5c) The replay's trailing content is NOT an assistant message (the
    //     turn died mid-way — interrupted/failed/abandoned while down)
    //     and no live continuation followed the load → the safe-re-issue
    //     class: nothing is running at the backend (the connection-death
    //     contract), so re-issue cannot duplicate.
    const { cwd: cwd5c } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        replay: [{ role: "user", text: "task" }],
      },
    });
    const runner5c = harness.makeRunner();
    const loaded5c = await runner5c.loadSession({ sessionId: "fake-session-any", cwd: cwd5c, model: "claude" });
    await assert.rejects(
      () => loaded5c.awaitCurrentTurn(),
      (error: unknown) =>
        (error as Error).message.includes("without a terminal assistant message") &&
        (error as Error).message.includes("re-issue is the honest fallback") &&
        (error as Error).message.includes("no duplication possible"),
    );
    await loaded5c.release();

    // 5d) An EXTENSION backend whose query FAILS falls through to the
    //     observation path (phase-F review round 2: the query's failure
    //     used to reject with the non-re-armable still-running class,
    //     pushing the broker to release-and-re-issue a possibly-running
    //     call). The replay ends with the terminal assistant message and
    //     no live continuation → completed-while-down, resolved from the
    //     transcript.
    const { cwd: cwd5d } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        loadedTurnQueryError: "query exploded",
        replay: [
          { role: "user", text: "task" },
          { role: "assistant", text: "result D (loaded)" },
        ],
      },
    });
    const runner5d = harness.makeRunner();
    const loaded5d = await runner5d.loadSession({ sessionId: "fake-session-any", cwd: cwd5d, model: "claude" });
    const turn5d = await loaded5d.awaitCurrentTurn();
    assert.deepEqual(turn5d, { stopReason: "end_turn", text: "result D (loaded)" });
    await loaded5d.release();

    // 5e) A CUSTOM backend (a registered registry entry) WITHOUT the
    //     extension: the connection-death contract is NOT live-verified
    //     for it, so its quiet observation window is NOT terminal
    //     evidence (phase-F review round 3: the replay classification
    //     used to apply to every extension-less backend — a durable
    //     custom backend can keep a turn running while quiet, and
    //     settling stale/partial replay or re-issuing would violate the
    //     no-duplicate invariant). The seam keeps the loaded session
    //     attached and waits for the authoritative terminal state — the
    //     max-wait bound rejects with the RE-ARMABLE still-running class
    //     (the broker re-arms the wait on the attached session); the
    //     replay's trailing assistant message is never settled as
    //     completed.
    const { config: config5e, cwd: cwd5e, readLog: readLog5e } = fakeCustomBackend({
      loadSessionSupport: true,
      loadSession: {
        replay: [
          { role: "user", text: "task" },
          { role: "assistant", text: "looks complete but the backend may still be running" },
        ],
      },
    });
    const runner5e = makeRunner({ backends: { fakecustom: config5e } });
    const loaded5e = await runner5e.loadSession({ sessionId: "fake-session-any", cwd: cwd5e, model: "fakecustom" });
    await assert.rejects(
      () => loaded5e.awaitCurrentTurn(),
      (error: unknown) => {
        assert.ok(
          (error as { loadedTurnStillRunning?: unknown }).loadedTurnStillRunning === true,
          `the still-running marker: ${String((error as Error).message)}`,
        );
        assert.equal(
          (error as { rearmable?: unknown }).rearmable,
          true,
          "re-armable: the broker keeps the attached session and re-arms the wait",
        );
        assert.ok(
          (error as Error).message.includes("not live-verified"),
          (error as Error).message,
        );
        assert.ok(
          (error as Error).message.includes("stayed quiet after the load"),
          (error as Error).message,
        );
        return true;
      },
    );
    assert.ok(
      !readLog5e().some((e) => e.method === "extensionRequest" && e.extensionMethod === "_session/loaded_turn/query"),
      "no query on the wire — the custom backend advertised no extension",
    );
    await loaded5e.release();

    // 5f) A CUSTOM backend whose EXTENSION query fails: the query's
    //     failure falls through to the observation path, and the same
    //     unverified rule applies — the quiet window is not terminal
    //     evidence, the loaded session stays attached, and the max-wait
    //     bound rejects with the RE-ARMABLE still-running class (never
    //     a replay settlement, never a re-issue of a possibly-running
    //     turn).
    const { config: config5f, cwd: cwd5f } = fakeCustomBackend({
      loadSessionSupport: true,
      loadSession: {
        loadedTurnQueryError: "query exploded",
        replay: [
          { role: "user", text: "task" },
          { role: "assistant", text: "looks complete but the backend may still be running" },
        ],
      },
    });
    const runner5f = makeRunner({ backends: { fakecustom: config5f } });
    const loaded5f = await runner5f.loadSession({ sessionId: "fake-session-any", cwd: cwd5f, model: "fakecustom" });
    await assert.rejects(
      () => loaded5f.awaitCurrentTurn(),
      (error: unknown) => {
        assert.ok(
          (error as { loadedTurnStillRunning?: unknown }).loadedTurnStillRunning === true,
          `the still-running marker: ${String((error as Error).message)}`,
        );
        assert.equal(
          (error as { rearmable?: unknown }).rearmable,
          true,
          "re-armable: the broker keeps the attached session and re-arms the wait",
        );
        assert.ok((error as Error).message.includes("query failed: query exploded"), (error as Error).message);
        return true;
      },
    );
    await loaded5f.release();

    // 6) The unconditional arm: a transcript with NO user message (the recorded session
    //    never received its prompt) rejects with the safe-re-issue class even when the
    //    extension is advertised — nothing reached the backend.
    const { cwd: cwd6 } = harness.configure<LogEntry>({
      loadSessionSupport: true,
      loadSession: {
        loadedTurn: { status: "completed" },
        replay: [{ role: "assistant", text: "orphaned assistant text" }],
      },
    });
    const runner6 = harness.makeRunner();
    const loaded6 = await runner6.loadSession({ sessionId: "fake-session-any", cwd: cwd6, model: "claude" });
    await assert.rejects(
      () => loaded6.awaitCurrentTurn(),
      (error: unknown) =>
        (error as Error).message.includes("shows no user message") &&
        (error as Error).message.includes("re-issue is the honest fallback"),
    );
    await loaded6.release();
  } finally {
    if (prevMax === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = prevMax;
    if (prevObserve === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS = prevObserve;
  }
});

test("§5 [C]12 message fold on the RESTORED path matches the live result fold", async () => {
  // The ended-notification wait's loser timer rides the max-wait knob
  // (default 15 min — it would keep the test process alive); bound it
  // like the awaitCurrentTurn suite does.
  const prevMax = process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
  process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = "400";
  try {
  // 1) Completed-while-down: deltas inside each message concatenate
  //    verbatim, while intervening tool activity contributes one message
  //    boundary separator.
  const { cwd } = harness.configure<LogEntry>({
    loadSessionSupport: true,
    loadSession: {
      loadedTurn: { status: "completed" },
      replay: [
        { role: "user", text: "task" },
        { role: "assistant", text: "I " },
        { role: "assistant", text: "won't modify " },
        { role: "assistant", text: "any files." },
      ],
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "tc-restored-fold-1", title: "search the codebase", kind: "search", status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: "tc-restored-fold-1", status: "completed" },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Type" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Script files under " } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "src/ stay untouched." } },
      ],
    },
  });
  const runner = harness.makeRunner();
  const loaded = await runner.loadSession({ sessionId: "fake-session-any", cwd, model: "claude" });
  const turn = await loaded.awaitCurrentTurn();
  assert.deepEqual(turn, {
    stopReason: "end_turn",
    text: "I won't modify any files.\n\nTypeScript files under src/ stay untouched.",
  }, "the completed-while-down result separates messages, not deltas");
  await loaded.release();

  // 2) The loaded-turn-ENDED path (a turn running at load that ends
  //    later): replayed and live continuation deltas remain one message
  //    when no non-text content update intervenes.
  const { cwd: cwd2 } = harness.configure<LogEntry>({
    loadSessionSupport: true,
    loadSession: {
      loadedTurn: { status: "running" },
      replay: [
        { role: "user", text: "task" },
        { role: "assistant", text: "LIVE" },
      ],
      continue: [
        { afterMs: 40, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "_SM" } } },
        { afterMs: 70, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OKE" } } },
        { afterMs: 100, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "_OK" } } },
      ],
      turnEnded: { afterMs: 140, stopReason: "end_turn" },
    },
  });
  const runner2 = harness.makeRunner();
  const loaded2 = await runner2.loadSession({ sessionId: "fake-session-any", cwd: cwd2, model: "claude" });
  const turn2 = await loaded2.awaitCurrentTurn();
  assert.deepEqual(turn2, {
    stopReason: "end_turn",
    text: "LIVE_SMOKE_OK",
  }, "the loaded-turn-ended result concatenates same-message deltas byte-identically");
  await loaded2.release();
  } finally {
    if (prevMax === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = prevMax;
  }
});
