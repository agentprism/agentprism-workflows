// The cold statics: `AcpAgent.open`, `resume(ref)`, `load(ref)`, `fork(ref)` — ref routing by
// name (never the default backend), the reattach wire, the load replay, and the pre-spawn
// failure modes. `sessionRef` is pinned against the runner's own builder and InteractiveSession.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentSessionRef } from "@automatalabs/shared-types";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgent, ClaudeBackend, PooledConnection, createAcpRunner, type AcpSessionOptions } from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { sessionRefFor } from "../../src/session-ref.js";
import { FAKE_AGENT_FIXTURE, createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

interface LogEntry {
  method: string;
  params?: { sessionId?: string; cwd?: string; prompt?: ContentBlock[]; configId?: string; value?: string | boolean };
}

const harness = createFakeAgentHarness({ prefix: "acp-agent-statics-it-", backends: ["claude"] });
const configure = (scenario: unknown, options?: Parameters<typeof harness.configure>[1]) =>
  harness.configure<LogEntry>(scenario, options);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);
const methods = (log: LogEntry[]): string[] => log.map((entry) => entry.method);
const count = (log: LogEntry[], method: string): number => methods(log).filter((m) => m === method).length;

function withoutSessionId(ref: AgentSessionRef): Omit<AgentSessionRef, "sessionId"> {
  const { sessionId: _sessionId, ...rest } = ref;
  return rest;
}

function validation(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
    assert.match(error.message, pattern);
    return true;
  };
}

afterEach(async () => {
  await harness.cleanup();
});

const OTHER_DIR = mkdtempSync(join(tmpdir(), "acp-agent-statics-other-"));

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
  rmSync(OTHER_DIR, { recursive: true, force: true });
});

test("AcpAgent.open is new + ready", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude", label: "opened" }));
  assert.equal(agent.state, "ready");
  assert.equal(count(readLog(), "__start"), 1);
  assert.equal(count(readLog(), "newSession"), 1);
  assert.equal(agent.label, "opened");
  assert.equal(typeof agent.sessionId, "string");
  assert.equal((await agent.prompt("hi")).text, "ok");
});

test("resume(ref) routes by ref.backendId, passes ref.cwd, sends session/resume then prompt, and lands on the ref's model", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, resumeSession: {}, turns: [{ text: "one" }, { text: "two" }] });
  const original = track(await AcpAgent.open({ cwd, model: "claude/opus" }));
  assert.equal(original.model, "claude/opus", "the routed spec the agent selected");
  await original.prompt("first");
  const ref = original.sessionRef!;
  await original.close({ keep: true });
  assert.equal(ref.backendId, "claude");
  assert.equal(ref.cwd, cwd);
  assert.equal(ref.model, "claude/opus", "the ref records the model the session was on");
  assert.deepEqual(ref.reopen, { load: true, resume: true, list: true, fork: true });

  const resumed = track(await AcpAgent.resume(ref, { label: "resumed" }));
  assert.equal(resumed.sessionId, ref.sessionId);
  assert.equal(resumed.cwd, ref.cwd);
  assert.equal(resumed.backendId, "claude");
  assert.equal(resumed.model, "claude/opus");
  assert.equal(resumed.configOptions.find((option) => option.id === "model")?.currentValue, "opus", "the ref's model was selected");
  assert.equal(resumed.history.length, 0, "resume replays nothing");
  // The resumed agent is a FRESH fake process with its own turn cursor: it serves turns[0].
  assert.equal((await resumed.prompt("again")).text, "one");
  const log = readLog();
  const resume = log.findIndex((entry) => entry.method === "resumeSession");
  assert.ok(resume > 0);
  assert.equal(log[resume]!.params?.cwd, ref.cwd);
  assert.equal(log[resume]!.params?.sessionId, ref.sessionId);
  const selectedAfterResume = log.slice(resume + 1).find((entry) => entry.method === "setSessionConfigOption" && entry.params?.configId === "model");
  assert.equal(selectedAfterResume?.params?.value, "opus", "session/set_config_option model=opus after session/resume");
  assert.ok(resume < methods(log).lastIndexOf("prompt"), "resume, then the prompt");
  assert.equal(count(log, "__start"), 2, "a fresh dedicated process for the resumed agent");
  assert.deepEqual(withoutSessionId(resumed.sessionRef!), withoutSessionId(ref), "the resumed agent reports the same ref");

  // An explicit `model` still wins over the ref's.
  const switched = track(await AcpAgent.resume(ref, { model: "claude/sonnet" }));
  assert.equal(switched.model, "claude/sonnet");
  assert.equal(switched.sessionRef!.model, "claude/sonnet");
  await switched.close({ keep: true });

  // A ref with no model (nothing was ever selected on the session) selects nothing: the session
  // runs on whatever the backend restores or defaults to.
  const { model: _model, ...modelless } = ref;
  const selections = count(readLog(), "setSessionConfigOption");
  const plain = track(await AcpAgent.resume(modelless));
  assert.equal(plain.model, undefined);
  assert.equal("model" in plain.sessionRef!, false);
  assert.equal(count(readLog(), "setSessionConfigOption"), selections, "no model on the ref: no selection on the wire");
  await plain.close({ keep: true });

  // Behavioral companion to the routing weld: the agent's ref IS the runner's builder output,
  // which is InteractiveSession.sessionRef plus poolKey (modulo sessionId) — the selected model
  // included, on all three.
  const runner = harness.track(createAcpRunner());
  const interactive = await runner.openSession({ model: "claude/opus", cwd });
  const fromInteractive = interactive.sessionRef;
  await interactive.release();
  assert.deepEqual(withoutSessionId(ref), { ...withoutSessionId(fromInteractive), poolKey: "claude" });
  const backend = new ClaudeBackend();
  const connection = harness.track(PooledConnection.create(backend, { onDead: () => undefined }));
  const sessionOptions: AcpSessionOptions = { cwd, schema: undefined, policy: {} };
  const handle = await connection.openSession(sessionOptions);
  assert.equal("model" in sessionRefFor(handle, backend, cwd), false, "nothing selected yet: the ref records no model");
  await handle.selectModel("opus");
  assert.deepEqual(withoutSessionId(ref), withoutSessionId(sessionRefFor(handle, backend, cwd)));
  await handle.release();
  assert.deepEqual(JSON.parse(JSON.stringify(ref)), ref, "JSON-round-trippable");
});

test("load(ref) replays into history/replay and marks the load boundary", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSession: { replay: [{ role: "user", text: "q" }, "a"] },
    turns: [{ text: "after" }],
  });
  const ref: AgentSessionRef = { sessionId: "recorded-session", backendId: "claude", cwd, reopen: { load: true, resume: true, list: false } };
  const loaded = track(await AcpAgent.load(ref));
  assert.equal(loaded.sessionId, "recorded-session");
  assert.equal(loaded.history.length, 1);
  assert.equal(loaded.history[0]!.text, "a");
  assert.equal(loaded.text, "a");
  assert.equal(loaded.replay.length, 2);
  assert.deepEqual(loaded.replay.map((record) => record.update.sessionUpdate), ["user_message_chunk", "agent_message_chunk"]);
  assert.deepEqual(
    loaded.messages.map((message) => [message.role, message.content]),
    [["user", [{ type: "text", text: "q" }]], ["assistant", [{ type: "text", text: "a" }]]],
    "the replay lands in messages too — the user prompt included, unlike history/text",
  );
  assert.equal(loaded.messages[0]!.receivedAt, loaded.replay[0]!.receivedAt, "dated by the replayed record");
  assert.equal(readLog().find((entry) => entry.method === "loadSession")?.params?.sessionId, "recorded-session");
  assert.equal(methods(readLog()).includes("resumeSession"), false);

  // The load boundary: the next turn's text is its own, not the replay's.
  const turn = await loaded.prompt("go");
  assert.equal(turn.text, "after");
  assert.equal(turn.history.length, 1);
  assert.equal(turn.messages.length, 1, "the turn's messages are its own, not the replay's");
  assert.equal(loaded.text, "a\n\nafter", "the replayed message and the new turn fold like turn.text");
  assert.equal(loaded.history.length, 2);
  assert.deepEqual(
    loaded.messages.map((message) => message.content),
    [[{ type: "text", text: "q" }], [{ type: "text", text: "a" }], [{ type: "text", text: "after" }]],
  );
  assert.equal(loaded.usage.total, 0, "replayed history is never counted as usage");
});

test("fork(ref) cold prefers session/load on an id-only backend so the child carries the recorded transcript", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: { idOnly: true, turns: [{ text: "child" }] },
    loadSession: { replay: [{ role: "user", text: "q" }, "recorded"] },
    turns: [{ text: "parent" }],
  });
  const ref: AgentSessionRef = { sessionId: "recorded-session", backendId: "claude", cwd, reopen: { load: true, resume: true, list: false, fork: true } };
  const forked = track(await AcpAgent.fork(ref, { label: "cold" }));
  assert.notEqual(forked.sessionId, "recorded-session");
  const log = readLog();
  const wire = methods(log);
  assert.ok(wire.indexOf("forkSession") < wire.indexOf("loadSession"), wire.join(","));
  assert.equal(wire.includes("resumeSession"), false, "load is preferred whenever the agent advertises it");
  assert.equal(log.find((entry) => entry.method === "forkSession")?.params?.sessionId, "recorded-session");
  assert.equal(log.find((entry) => entry.method === "loadSession")?.params?.sessionId, forked.sessionId, "the forked id is what gets loaded");
  assert.equal(count(log, "closeSession"), 0, "the bare fork handle was released keepOpen");
  // The replay IS the child's transcript — there is no parent to seed from.
  assert.equal(forked.history.length, 1);
  assert.equal(forked.history[0]!.text, "recorded");
  assert.equal(forked.text, "recorded");
  assert.deepEqual(
    forked.messages.map((message) => [message.role, message.content]),
    [["user", [{ type: "text", text: "q" }]], ["assistant", [{ type: "text", text: "recorded" }]]],
  );
  assert.equal(forked.replay.length, 2);
  assert.equal(forked.usage.total, 0, "replayed history is never counted as usage");

  // The load boundary is marked: the next turn's text is its own.
  const turn = await forked.prompt("go");
  assert.equal(turn.text, "child");
  assert.equal(turn.history.length, 1);
  assert.equal(turn.messages.length, 1);
  assert.equal(forked.text, "recorded\n\nchild");
  assert.equal(count(log, "__start"), 1);

  // A cwd override on the source-only built-in is rejected before spawning.
  const before = readLog().length;
  await assert.rejects(() => AcpAgent.fork(ref, { cwd: OTHER_DIR }), validation(/must keep the source cwd/));
  assert.equal(readLog().length, before);
});

test("fork(ref) cold falls back to session/resume when load is not advertised; the child's transcript then starts empty", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSessionSupport: false,
    forkSession: { idOnly: true, turns: [{ text: "child" }] },
    loadSession: { replay: ["never replayed"] },
    turns: [{ text: "parent" }],
  });
  const ref: AgentSessionRef = { sessionId: "recorded-session", backendId: "claude", cwd, reopen: { load: false, resume: true, list: false, fork: true } };
  const forked = track(await AcpAgent.fork(ref));
  const log = readLog();
  const wire = methods(log);
  assert.ok(wire.indexOf("forkSession") < wire.indexOf("resumeSession"), wire.join(","));
  assert.equal(wire.includes("loadSession"), false);
  assert.equal(log.find((entry) => entry.method === "resumeSession")?.params?.sessionId, forked.sessionId);
  assert.equal(forked.history.length, 0, "resume replays nothing and there is no parent to seed from");
  assert.equal(forked.text, "");
  assert.deepEqual(forked.messages, []);
  assert.equal(forked.replay.length, 0);
  assert.equal((await forked.prompt("go")).text, "child");
  assert.equal(count(log, "__start"), 1);
});

test("a ref with an unknown backend, a mismatched poolKey, or a model routing elsewhere fails before spawning and never falls back to the default backend", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, turns: [{ text: "ok" }] }, { defaultBackend: "claude" });
  const ref: AgentSessionRef = { sessionId: "s", backendId: "claude", cwd, reopen: { load: true, resume: true, list: false } };

  await assert.rejects(
    () => AcpAgent.resume({ ...ref, backendId: "nope" }),
    validation(/neither a built-in nor a registered custom/),
  );
  await assert.rejects(
    () => AcpAgent.load({ ...ref, backendId: "nope" }),
    validation(/neither a built-in nor a registered custom/),
  );
  await assert.rejects(
    () =>
      AcpAgent.resume(
        { ...ref, backendId: "fake", poolKey: "fake#000000000000" },
        { backends: { fake: { command: process.execPath, args: [FAKE_AGENT_FIXTURE] } } },
      ),
    validation(/pool key/),
  );
  await assert.rejects(() => AcpAgent.resume({ ...ref, poolKey: "codex" }), validation(/pool key/));
  await assert.rejects(() => AcpAgent.resume(ref, { model: "codex/x" }), validation(/routes to "codex"/));
  await assert.rejects(
    () => AcpAgent.resume(ref, { model: "fake/x", backends: { fake: { command: process.execPath, args: [FAKE_AGENT_FIXTURE] } } }),
    validation(/routes to "fake"/),
  );
  await assert.rejects(() => AcpAgent.fork({ ...ref, backendId: "" }), validation(/non-empty backendId/));
  assert.equal(count(readLog(), "__start"), 0, "nothing spawned");

  // Positive control: the same ref on its own backend with a same-backend model spec does spawn.
  const ok = track(await AcpAgent.resume(ref, { model: "claude/claude-opus-4-1" }));
  assert.equal(ok.backendId, "claude");
  assert.equal(ok.model, "claude/claude-opus-4-1");
  assert.equal(ok.configOptions.find((option) => option.id === "model")?.currentValue, "claude-opus-4-1");
  assert.equal(count(readLog(), "__start"), 1);
});

test("resume on a backend that does not advertise session/resume fails with the lifecycle error and disposes the process", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: false, turns: [{ text: "ok" }] });
  const ref: AgentSessionRef = { sessionId: "s", backendId: "claude", cwd, reopen: { load: false, resume: false, list: false } };
  await assert.rejects(() => AcpAgent.resume(ref, { label: "no-resume" }), validation(/session\/resume/));
  await waitFor(() => methods(readLog()).includes("__exit"));
  assert.equal(count(readLog(), "__start"), 1, "the process was spawned (the capability is only known after initialize)");
  assert.equal(count(readLog(), "resumeSession"), 0, "and the request never went out");
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
});

test("resume(ref, { systemPrompt }) carries the instructions on session/resume; an unsupported ref backend refuses before spawning", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, resumeSession: {}, turns: [{ text: "one" }] });
  const original = track(await AcpAgent.open({ cwd, model: "claude", raw: false }));
  const ref = original.sessionRef!;
  await original.close({ keep: true });

  const resumed = track(await AcpAgent.resume(ref, { raw: false, systemPrompt: { append: "Continue tersely." } }));
  const resume = readLog().find((entry) => entry.method === "resumeSession");
  assert.deepEqual((resume?.params as { _meta?: unknown } | undefined)?._meta, { systemPrompt: { append: "Continue tersely." } });
  await resumed.close({ keep: true });

  const spawns = count(readLog(), "__start");
  await assert.rejects(
    () => AcpAgent.resume({ ...ref, backendId: "opencode", poolKey: "opencode" }, { systemPrompt: { replace: "R" } }),
    validation(/systemPrompt\.replace is not supported by backend "opencode"/),
  );
  assert.equal(count(readLog(), "__start"), spawns, "refused before any process spawned");
});

// ---- inherited cost gauge: a reopened session's cumulative `usage_update.cost` carries the ----
// ---- earlier total (claude-agent-sdk 0.3.277 on resume; OpenCode and pi always)            ----

const costUpdate = (amount: number) => ({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount, currency: "USD" } });
const near = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);

test("resume(ref) baselines the gauge the ref recorded: the first turn reports its own cost, not the session's total", async () => {
  const first = configure({ lifecycleSupport: true, turns: [{ text: "one", updates: [costUpdate(0.03)] }] });
  const original = track(await AcpAgent.open({ cwd: first.cwd, model: "claude" }));
  assert.equal(original.sessionRef!.costGauge, undefined, "no cost reported yet: the ref carries no gauge");
  const t1 = await original.prompt("first");
  near(t1.usage.turn.cost, 0.03, "a fresh session's first turn");
  const ref = original.sessionRef!;
  assert.equal(ref.costGauge, 0.03, "the ref tracks the live cumulative gauge");
  await original.close({ keep: true });
  assert.equal(original.sessionRef!.costGauge, 0.03, "and keeps it after close");

  // The reopened agent's gauge CONTINUES from 0.03: its first reading is 0.035.
  configure({ lifecycleSupport: true, resumeSession: {}, turns: [{ text: "two", updates: [costUpdate(0.035)] }, { text: "three", updates: [costUpdate(0.045)] }] });
  const resumed = track(await AcpAgent.resume(ref));
  assert.equal(resumed.sessionRef!.costGauge, 0.03, "before any turn the recorded gauge is handed on unchanged");
  const t2 = await resumed.prompt("second");
  near(t2.usage.turn.cost, 0.005, "the resumed turn's own cost");
  near(t2.usage.session.cost, 0.005, "the resumed agent's running sum covers its own turns only");
  const t3 = await resumed.prompt("third");
  near(t3.usage.turn.cost, 0.01, "later turns are plain gauge deltas");
  near(t3.usage.session.cost, 0.015, "running sum");
  assert.equal(resumed.sessionRef!.costGauge, 0.045, "the ref records the agent's cumulative gauge, inherited spend included");
  const ref2 = resumed.sessionRef!;
  await resumed.close({ keep: true });

  // An agent that RESTARTED its gauge (a crash before the totals were saved): the first reading
  // is below the recorded gauge, so nothing was inherited and the reading is the turn's cost.
  configure({ lifecycleSupport: true, resumeSession: {}, turns: [{ text: "four", updates: [costUpdate(0.004)] }] });
  const restarted = track(await AcpAgent.resume(ref2));
  const t4 = await restarted.prompt("fourth");
  near(t4.usage.turn.cost, 0.004, "a restarted gauge is not baselined");
  assert.equal(restarted.sessionRef!.costGauge, 0.004);
});

test("a malformed ref.model or ref.costGauge fails the reopen before any process spawns", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, resumeSession: {}, turns: [{ text: "ok" }] });
  const ref = { sessionId: "s-1", backendId: "claude", cwd, reopen: { load: true, resume: true, list: true, fork: true } };
  for (const model of ["", "   ", 7]) {
    await assert.rejects(
      AcpAgent.resume({ ...ref, model } as unknown as AgentSessionRef),
      validation(/model, when present, is a non-empty string/),
    );
  }
  for (const costGauge of [-0.01, Number.NaN, "0.03"]) {
    await assert.rejects(
      AcpAgent.resume({ ...ref, costGauge } as unknown as AgentSessionRef),
      validation(/costGauge, when present, is a non-negative number/),
    );
  }
  assert.equal(count(readLog(), "__start"), 0);
});
