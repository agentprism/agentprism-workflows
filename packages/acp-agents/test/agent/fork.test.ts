// `agent.fork()` against the fake: the trait-driven choreography (id-only → release keepOpen →
// resume|load; live → the fork handle IS the session), option inheritance, the history seed, the
// pre-response replay buffer, the pre-spawn guards, custom-backend traits, FIFO ordering, and
// parent/child isolation. Every fork is its own dedicated process.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { Type } from "typebox";
import {
  AcpAgent,
  ClaudeBackend,
  PooledConnection,
  resolveBackendRegistry,
  type AcpSessionOptions,
} from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { FAKE_AGENT_FIXTURE, createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

interface LogEntry {
  method: string;
  pid?: number;
  params?: {
    sessionId?: string;
    cwd?: string;
    configId?: string;
    modeId?: string;
    value?: string | boolean;
    prompt?: ContentBlock[];
    _meta?: Record<string, unknown>;
  };
}

const MODES: SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};
const MODEL: SessionConfigOption = {
  id: "model",
  type: "select",
  name: "Model",
  category: "model",
  currentValue: "default-model",
  options: [
    { value: "opus", name: "Opus" },
    { value: "default-model", name: "Default" },
  ],
};
const EFFORT: SessionConfigOption = {
  id: "effort",
  type: "select",
  name: "Effort",
  currentValue: "low",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
};

const harness = createFakeAgentHarness({ prefix: "acp-agent-fork-it-", backends: ["claude", "pi", "opencode"] });
const configure = (scenario: unknown, options?: Parameters<typeof harness.configure>[1]) =>
  harness.configure<LogEntry>(scenario, options);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);
const methods = (log: LogEntry[]): string[] => log.map((entry) => entry.method);
const count = (log: LogEntry[], method: string): number => methods(log).filter((m) => m === method).length;
const entriesFor = (log: LogEntry[], sessionId: string | undefined): LogEntry[] =>
  log.filter((entry) => entry.params?.sessionId === sessionId);

function isSessionNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const details = (error as { data?: { details?: unknown } } | null)?.data?.details;
  return /Session not found/.test(message) || details === "Session not found";
}

function validation(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
    assert.match(error.message, pattern);
    return true;
  };
}

const OTHER_DIR = mkdtempSync(join(tmpdir(), "acp-agent-fork-other-"));

afterEach(async () => {
  await harness.cleanup();
});

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
  rmSync(OTHER_DIR, { recursive: true, force: true });
});

test("id-only fork: forkSession < resumeSession < prompt, the fork handle is released keepOpen, the child sees one session_open and no session_close", async () => {
  const scenario = {
    lifecycleSupport: true,
    forkSession: { idOnly: true, turns: [{ text: "child" }] },
    turns: [{ text: "parent" }],
  };
  const { cwd, readLog } = configure(scenario);
  const parent = track(await AcpAgent.open({ cwd, model: "claude" }));
  assert.equal((await parent.prompt("p")).text, "parent");

  const child = track(await parent.fork());
  const childOpens: string[] = [];
  const childCloses: string[] = [];
  child.on("session_open", (event) => childOpens.push(event.sessionId));
  child.on("session_close", (event) => childCloses.push(event.sessionId));
  assert.notEqual(child.sessionId, parent.sessionId);
  assert.equal(child.state, "ready");
  assert.ok(child.configOptions.length > 0, "the catalog came from the resume response — the fork response had none");
  assert.equal((await child.prompt("go")).text, "child", "the child's turns come from forkSession.turns");

  const log = readLog();
  const wire = methods(log);
  assert.equal(wire.includes("loadSession"), false);
  assert.equal(count(log, "__start"), 2, "one process per agent");
  const fork = wire.indexOf("forkSession");
  const resume = wire.indexOf("resumeSession");
  const childPrompt = wire.lastIndexOf("prompt");
  assert.ok(fork > 0 && fork < resume && resume < childPrompt, wire.join(","));
  assert.equal(log.find((entry) => entry.method === "forkSession")?.params?.sessionId, parent.sessionId);
  assert.equal(log.find((entry) => entry.method === "resumeSession")?.params?.sessionId, child.sessionId);
  assert.equal(log[childPrompt]?.params?.sessionId, child.sessionId);
  assert.equal(count(log, "closeSession"), 0, "the fork handle's release was keepOpen: nothing closed on the wire");

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(childOpens, [child.sessionId], "exactly one session_open (the sticky one) for the child");
  assert.deepEqual(childCloses, [], "the hand-off release was not reported as the child's close");
  assert.equal(child.sessionRef?.sessionId, child.sessionId);
  assert.equal(child.sessionRef?.poolKey, "claude");
  assert.equal(child.label, "fork-1");

  await child.close();
  assert.deepEqual(childCloses, [child.sessionId], "the agent's real close is delivered");
  assert.deepEqual(readLog().filter((entry) => entry.method === "closeSession").map((entry) => entry.params?.sessionId), [child.sessionId]);
  assert.equal(parent.state, "ready");

  // Negative proof of the trap and of the bare fork shape (guards the fixture the test relies on):
  // a direct fork handle has no catalog and its id is dead until reattached.
  const sessionOptions: AcpSessionOptions = { cwd, schema: undefined, policy: {} };
  const connection = harness.track(PooledConnection.create(new ClaudeBackend(), { onDead: () => undefined }));
  const bare = await connection.forkSession(parent.sessionId!, sessionOptions);
  assert.deepEqual(bare.advertisedConfigOptions, []);
  assert.equal(bare.modes, undefined);
  await assert.rejects(() => bare.prompt("hi"), isSessionNotFound);
  await bare.release({ keepOpen: true });
});

test("id-only fork falls back to session/load when resume is not advertised; replay lands in history and no parent seed is added", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    resumeSessionSupport: false,
    forkSession: { idOnly: true },
    loadSession: { replay: [{ role: "user", text: "q" }, "replayed"] },
    turns: [{ text: "parent" }],
  });
  const parent = track(await AcpAgent.open({ cwd, model: "claude" }));
  await parent.prompt("p");
  const child = track(await parent.fork());
  const wire = methods(readLog());
  assert.ok(wire.includes("loadSession"));
  assert.equal(wire.includes("resumeSession"), false);
  assert.ok(wire.indexOf("forkSession") < wire.indexOf("loadSession"));
  assert.equal(child.history.length, 1, "the replay, not the parent's snapshot");
  const [entry] = child.history;
  assert.equal(entry!.role, "assistant");
  assert.equal(entry!.kind, "text");
  assert.equal(entry!.text, "replayed");
  assert.equal(typeof entry!.timestamp, "number");
  assert.equal(child.text, "replayed");
  assert.equal(child.replay.length, 2, "both replayed chunks are observable verbatim");
  assert.deepEqual(child.replay.map((record) => record.update.sessionUpdate), ["user_message_chunk", "agent_message_chunk"]);
});

test("live fork (pi): the fork handle is the session and the parent's history seeds the child", async () => {
  const { cwd, readLog } = configure(
    { lifecycleSupport: true, forkSession: { turns: [{ text: "child" }] }, turns: [{ text: "parent" }] },
    { backends: ["pi"] },
  );
  const parent = track(await AcpAgent.open({ cwd, model: "pi" }));
  await parent.prompt("p");
  const child = track(await parent.fork());
  const wire = methods(readLog());
  assert.ok(wire.includes("forkSession"));
  assert.equal(wire.includes("resumeSession"), false);
  assert.equal(wire.includes("loadSession"), false);
  assert.equal(child.history.length, 1);
  assert.equal(child.history[0]!.text, "parent");
  assert.notEqual(child.history[0], parent.history[0], "a copy of the parent's entry");
  assert.ok(child.text.startsWith("parent"));
  assert.equal(child.text, "parent");
  assert.deepEqual(child.messages, parent.messages, "the parent's message snapshot seeds the child exactly like history/text");
  assert.notEqual(child.messages[0], parent.messages[0], "copies, not the parent's objects");

  const turn = await child.prompt("go");
  assert.equal(turn.text, "child");
  assert.equal(turn.history.length, 1, "the turn's own slice never includes the seed");
  assert.equal(turn.messages.length, 1, "the turn's own messages never include the seed");
  assert.equal(child.history.length, 2);
  assert.equal(child.history[1]!.text, "child");
  assert.equal(child.text, "parent\n\nchild", "the seed and the child's own messages fold like turn.text");
  assert.deepEqual(
    child.messages.map((message) => message.content),
    [[{ type: "text", text: "parent" }], [{ type: "text", text: "child" }]],
    "messages: the seed, then the child's own turn",
  );
  assert.equal(parent.history.length, 1, "the parent is untouched by the child's turn");
  assert.equal(parent.messages.length, 1);
});

test("pre-response fork replay is buffered and adopted for the new id", async () => {
  const { cwd } = configure(
    {
      lifecycleSupport: true,
      forkSession: {
        replay: [{ role: "user", text: "q" }, "a"],
        updates: [{ sessionUpdate: "usage_update", used: 1, size: 10 }],
        turns: [{ text: "child" }],
      },
      turns: [{ text: "parent" }],
    },
    { backends: ["opencode"] },
  );
  const parent = track(await AcpAgent.open({ cwd, model: "opencode" }));
  const child = track(await parent.fork());
  assert.deepEqual(
    child.replay.map((record) => record.update.sessionUpdate),
    ["user_message_chunk", "agent_message_chunk", "usage_update"],
  );
  for (const record of child.replay) {
    assert.equal(typeof record.receivedAt, "number");
    assert.equal((record.update as { sessionId?: unknown }).sessionId, undefined, "the update itself, not the event envelope");
  }
  // Received before the fork response registered the id: not folded into the handle's history;
  // the parent's snapshot (empty here — no parent turn ran) is the seed instead. `messages`
  // follows the same retained log, so it excludes the pre-response replay too.
  assert.equal(child.history.length, 0);
  assert.equal(child.messages.length, 0);
  assert.equal((await child.prompt("go")).text, "child");
  assert.deepEqual(child.messages.map((message) => message.content), [[{ type: "text", text: "child" }]]);
});

test("fork inherits options, suffixes the label, drops the signal, re-applies model/config/mode, and honors overrides", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    modes: MODES,
    configOptions: [MODEL, EFFORT],
    forkSession: { idOnly: true, turns: [{ text: "child" }] },
    turns: [{ text: "parent" }],
  });
  const controller = new AbortController();
  const parent = track(
    await AcpAgent.open({ cwd, model: "claude/opus", label: "primary", mode: "plan", configOptions: { effort: "high" }, signal: controller.signal }),
  );
  const child = track(await parent.fork());
  assert.equal(child.label, "primary/fork-1");
  assert.equal(child.cwd, cwd);
  assert.equal(child.backendId, "claude");
  assert.equal(child.model, "claude/opus", "the parent's routed model is inherited");
  assert.equal(child.modes?.currentModeId, "plan");
  assert.equal(child.configOptions.find((option) => option.id === "effort")?.currentValue, "high");
  assert.equal(child.configOptions.find((option) => option.id === "model")?.currentValue, "opus");

  const log = readLog();
  const resumeIndex = log.findIndex((entry) => entry.method === "resumeSession" && entry.params?.sessionId === child.sessionId);
  assert.ok(resumeIndex > 0);
  const applied = entriesFor(log.slice(resumeIndex + 1), child.sessionId).map((entry) =>
    entry.method === "setSessionConfigOption" ? `${entry.method}:${entry.params?.configId}=${String(entry.params?.value)}` : `${entry.method}:${entry.params?.modeId ?? ""}`,
  );
  assert.deepEqual(applied, ["setSessionConfigOption:model=opus", "setSessionConfigOption:effort=high", "setSessionMode:plan"]);

  const second = track(await parent.fork({ mode: "default" }));
  assert.equal(second.label, "primary/fork-2");
  assert.equal(second.modes?.currentModeId, "default", "the override replaced the inherited mode");
  assert.equal(second.configOptions.find((option) => option.id === "effort")?.currentValue, "high", "everything else is inherited");

  const named = track(await parent.fork({ label: "custom" }));
  assert.equal(named.label, "custom");

  // The parent's signal is NOT inherited: aborting it closes the parent only.
  controller.abort(new Error("stop parent"));
  await waitFor(() => parent.state === "closed");
  assert.equal(child.state, "ready");
  assert.equal(second.state, "ready");
  assert.equal((await child.prompt("go")).text, "child");
});

test("fork overrides set to undefined are not overrides: the child keeps the parent's schema, mode, config options, and model", async () => {
  const schema = Type.Object({ answer: Type.Number() });
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    modes: MODES,
    configOptions: [MODEL, EFFORT],
    forkSession: { idOnly: true, turns: [{ text: "child" }] },
    turns: [{ text: "parent" }],
  });
  const parent = track(
    await AcpAgent.open({ cwd, model: "claude/opus", label: "primary", mode: "plan", configOptions: { effort: "high" }, schema }),
  );
  // Every key an author might pass through from an optional variable, all `undefined`.
  const child = track(
    await parent.fork({ schema: undefined, mode: undefined, configOptions: undefined, model: undefined, retainHistory: undefined, meta: undefined }),
  );
  assert.equal(child.schema, schema, "the parent's schema survives an undefined override");
  assert.equal(child.modes?.currentModeId, "plan");
  assert.equal(child.configOptions.find((option) => option.id === "effort")?.currentValue, "high");
  assert.equal(child.configOptions.find((option) => option.id === "model")?.currentValue, "opus");

  const log = readLog();
  const forkEntry = log.find((entry) => entry.method === "forkSession");
  const forkMeta = forkEntry?.params?._meta as { claudeCode?: { options?: { outputFormat?: unknown } } } | undefined;
  assert.ok(forkMeta?.claudeCode?.options?.outputFormat, "the session schema rode the child's session/fork _meta");
  const resumeIndex = log.findIndex((entry) => entry.method === "resumeSession" && entry.params?.sessionId === child.sessionId);
  const applied = entriesFor(log.slice(resumeIndex + 1), child.sessionId).map((entry) =>
    entry.method === "setSessionConfigOption" ? `${entry.method}:${entry.params?.configId}=${String(entry.params?.value)}` : `${entry.method}:${entry.params?.modeId ?? ""}`,
  );
  assert.deepEqual(applied, ["setSessionConfigOption:model=opus", "setSessionConfigOption:effort=high", "setSessionMode:plan"]);
  assert.equal((await child.prompt("go")).text, "child");
});

test("fork guards: model routing to another backend and a cwd override on a source-only backend fail before spawning", async () => {
  {
    const { cwd, readLog } = configure({ lifecycleSupport: true, forkSession: { idOnly: true }, turns: [{ text: "parent" }] });
    const parent = track(await AcpAgent.open({ cwd, model: "claude" }));
    await assert.rejects(() => parent.fork({ model: "codex/x" }), validation(/must stay on backend "claude"/));
    await assert.rejects(() => parent.fork({ cwd: OTHER_DIR }), validation(/must keep the source cwd/));
    await assert.rejects(() => parent.fork({ cwd: "relative" }), validation(/absolute/));
    await assert.rejects(() => parent.fork({ configOptions: { model: "x" } }), validation(/reserved option id "model"/));
    assert.equal(count(readLog(), "__start"), 1, "no child process was spawned");
    assert.equal(count(readLog(), "forkSession"), 0);
    assert.equal(parent.state, "ready");
    // The same backend through a model spec is fine (and the spec is applied on the child).
    const child = track(await parent.fork({ model: "claude/claude-opus-4-1" }));
    assert.equal(child.backendId, "claude");
    assert.equal(child.model, "claude/claude-opus-4-1", "the override is the child's routed model");
    assert.equal(count(readLog(), "__start"), 2);
  }
  await harness.cleanup();
  {
    const { cwd, readLog } = configure(
      { lifecycleSupport: true, forkSession: { turns: [{ text: "child" }] }, turns: [{ text: "parent" }] },
      { backends: ["pi"] },
    );
    const parent = track(await AcpAgent.open({ cwd, model: "pi" }));
    const child = track(await parent.fork({ cwd: OTHER_DIR }));
    assert.equal(child.cwd, OTHER_DIR);
    assert.equal(readLog().find((entry) => entry.method === "forkSession")?.params?.cwd, OTHER_DIR);
    assert.equal(child.sessionRef?.cwd, OTHER_DIR);
  }
});

test("a custom backend follows its declared fork trait, never the built-in row of a shadowing name", async () => {
  const command = { command: process.execPath, args: [FAKE_AGENT_FIXTURE] };
  {
    const { cwd, readLog } = configure({
      lifecycleSupport: true,
      forkSession: { idOnly: true, turns: [{ text: "child" }] },
      turns: [{ text: "parent" }],
    });
    const parent = track(
      await AcpAgent.open({
        cwd,
        model: "wrapped",
        backends: { wrapped: { ...command, fork: { disposition: "id-only", cwd: "source-only" } } },
      }),
    );
    assert.equal(parent.backendId, "wrapped");
    const child = track(await parent.fork());
    assert.equal((await child.prompt("go")).text, "child");
    const wire = methods(readLog());
    assert.ok(wire.indexOf("forkSession") < wire.indexOf("resumeSession") && wire.indexOf("resumeSession") < wire.lastIndexOf("prompt"), wire.join(","));
    await assert.rejects(() => parent.fork({ cwd: OTHER_DIR }), validation(/must keep the source cwd/));
  }
  await harness.cleanup();
  {
    const { cwd, readLog } = configure({ lifecycleSupport: true, forkSession: { turns: [{ text: "child" }] }, turns: [{ text: "parent" }] });
    const parent = track(await AcpAgent.open({ cwd, model: "wrapped", backends: { wrapped: command } }));
    const child = track(await parent.fork({ cwd: OTHER_DIR }));
    assert.equal(methods(readLog()).includes("resumeSession"), false, "undeclared: the live default");
    assert.equal((await child.prompt("go")).text, "child");
  }
  await harness.cleanup();
  {
    const { cwd, readLog } = configure({ lifecycleSupport: true, forkSession: { turns: [{ text: "child" }] }, turns: [{ text: "parent" }] });
    const parent = track(await AcpAgent.open({ cwd, model: "claude", backends: { claude: command } }));
    track(await parent.fork());
    assert.equal(methods(readLog()).includes("resumeSession"), false, "a custom entry named claude never inherits the built-in id-only row");
  }
  assert.throws(
    () => resolveBackendRegistry({ b: { command: "x", fork: { disposition: "sideways" } as never } }),
    /"fork" must be/,
  );
});

test("fork waits for the in-flight turn", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: { turns: [{ text: "child" }] },
    turns: [{ waitForCancel: true }, { text: "after" }],
  });
  const parent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const parked = parent.prompt("park");
  const forked = parent.fork();
  await waitFor(() => methods(readLog()).includes("prompt"));
  assert.equal(methods(readLog()).includes("forkSession"), false, "no fork while the turn is in flight");
  await parent.cancel();
  await parked;
  const child = track(await forked);
  const wire = methods(readLog());
  assert.ok(wire.indexOf("cancel") < wire.indexOf("forkSession"), wire.join(","));
  assert.equal((await child.prompt("go")).text, "child");
});

test("two forks run on their own processes while the parent keeps going; the parent's close never affects them", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: { turns: [{ text: "child" }] },
    turns: [{ text: "parent" }, { text: "parent again" }],
  });
  const parent = track(await AcpAgent.open({ cwd, model: "claude" }));
  await parent.prompt("p");
  const [f1, f2] = await Promise.all([parent.fork(), parent.fork()]);
  track(f1);
  track(f2);
  assert.equal(count(readLog(), "__start"), 3);
  assert.equal(new Set([parent.sessionId, f1.sessionId, f2.sessionId]).size, 3);
  assert.equal((await parent.prompt("again")).text, "parent again", "the parent keeps going");

  await parent.close();
  assert.equal(f1.state, "ready");
  assert.equal(f2.state, "ready");
  assert.equal((await f1.prompt("a")).text, "child");
  assert.equal((await f2.prompt("b")).text, "child");
  assert.equal(f1.state, "ready");
  assert.equal(f2.state, "ready");
});

test("closing a fork with keep never closes the parent's session", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: { turns: [{ text: "child" }] },
    turns: [{ text: "parent" }, { text: "still here" }],
  });
  const parent = track(await AcpAgent.open({ cwd, model: "claude" }));
  await parent.prompt("p");
  const kept = track(await parent.fork());
  const closed = track(await parent.fork());

  await kept.close({ keep: true });
  assert.equal(count(readLog(), "closeSession"), 0, "keep: no session/close at all");
  assert.equal(kept.sessionRef?.sessionId, kept.sessionId);

  await closed.close();
  const closes = readLog().filter((entry) => entry.method === "closeSession").map((entry) => entry.params?.sessionId);
  assert.deepEqual(closes, [closed.sessionId], "only the child's own id was closed");

  assert.equal(parent.state, "ready");
  assert.equal((await parent.prompt("q")).text, "still here");
  await parent.close();
  assert.deepEqual(
    readLog().filter((entry) => entry.method === "closeSession").map((entry) => entry.params?.sessionId),
    [closed.sessionId, parent.sessionId],
  );
});

test("fork inherits systemPrompt (sent on the fork and its reattach), honors an override, and validates it before spawning", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: { idOnly: true, turns: [{ text: "child" }] },
    turns: [{ text: "parent" }],
  });
  const parent = track(await AcpAgent.open({ cwd, model: "claude", raw: false, systemPrompt: { append: "Be terse." } }));
  const child = track(await parent.fork());
  let log = readLog();
  const forkEntry = log.find((entry) => entry.method === "forkSession");
  assert.deepEqual(forkEntry?.params?._meta, { systemPrompt: { append: "Be terse." } }, "inherited on session/fork");
  const resumeEntry = log.find((entry) => entry.method === "resumeSession" && entry.params?.sessionId === child.sessionId);
  assert.deepEqual(resumeEntry?.params?._meta, { systemPrompt: { append: "Be terse." } }, "and on the id-only reattach");

  const overridden = track(await parent.fork({ systemPrompt: { replace: "Reviewer." } }));
  log = readLog();
  const overriddenResume = log.find((entry) => entry.method === "resumeSession" && entry.params?.sessionId === overridden.sessionId);
  assert.deepEqual(overriddenResume?.params?._meta, { systemPrompt: "Reviewer." }, "the override replaced the inherited value");

  const spawns = log.filter((entry) => entry.method === "__start").length;
  await assert.rejects(
    () => parent.fork({ systemPrompt: { append: "  " } }),
    (error: unknown) =>
      isWorkflowError(error) && error.code === WorkflowErrorCode.INVALID_ARGUMENT && /append must be a non-empty string/.test(error.message),
  );
  assert.equal(readLog().filter((entry) => entry.method === "__start").length, spawns, "the refused fork spawned nothing");
});
