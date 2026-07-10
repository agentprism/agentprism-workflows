import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type {
  ContentBlock,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import {
  AGENT_METHODS,
  AcpAgentRunner,
  ClaudeBackend,
  PooledConnection,
  type AcpSessionOptions,
} from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };

const MODES: SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};

interface LogEntry {
  method: string;
  phase?: string;
  outcome?: RequestPermissionResponse["outcome"];
  params?: {
    sessionId?: string;
    cwd?: string;
    cursor?: string;
    configId?: string;
    modeId?: string;
    value?: string | boolean;
    prompt?: ContentBlock[];
    mcpServers?: unknown[];
    _meta?: Record<string, unknown>;
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-session-lifecycle-it-", backends: ["claude"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

function makeRunner(): AcpAgentRunner {
  return harness.makeRunner();
}

function methods(log: LogEntry[]): string[] {
  return log.map((entry) => entry.method).filter((method) => !method.startsWith("__"));
}

function permissionOutcomes(log: LogEntry[]): Array<RequestPermissionResponse["outcome"] | undefined> {
  return log.filter((entry) => entry.method === "permissionOutcome").map((entry) => entry.outcome);
}

afterEach(async () => {
  await harness.cleanup();
});

test("loadSession routes replay updates and permissions before resolving", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSession: {
      replay: ["loaded ", "history"],
      toolCall: { title: "Read replay", kind: "read" },
    },
    turns: [{ text: "unused" }],
  });
  const runner = makeRunner();

  const session = await runner.loadSession({ cwd, sessionId: "persisted-load", toolNames: ["read"] });

  assert.equal(session.sessionId, "persisted-load");
  assert.equal(session.text, "loaded history");
  assert.deepEqual(
    session.history.map((entry) => entry.text),
    ["loaded ", "history"],
  );
  assert.deepEqual(permissionOutcomes(readLog()), [ALLOW.outcome]);
  await session.release();
});

test("a prompt after loadSession receives a real permission decision, not unknown-session cancellation", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSession: { replay: ["prior"] },
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "done" }],
  });
  const runner = makeRunner();
  const session = await runner.loadSession({ cwd, sessionId: "persisted-permission" });

  assert.equal((await session.prompt("continue")).text, "done");

  const outcomes = permissionOutcomes(readLog());
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0], ALLOW.outcome);
  await session.release();
});

test("resumeSession returns a live session without replaying history", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    resumeSession: { modes: MODES },
    turns: [{ text: "resumed" }],
  });
  const runner = makeRunner();
  const session = await runner.resumeSession({ cwd, sessionId: "persisted-resume" });

  assert.equal(session.text, "");
  assert.deepEqual(session.history, []);
  assert.equal((await session.prompt("continue")).text, "resumed");

  const wire = methods(readLog());
  assert.ok(wire.indexOf("resumeSession") < wire.indexOf("prompt"));
  assert.equal(wire.includes("loadSession"), false);
  await session.release();
});

test("forkSession returns and routes a usable InteractiveSession under the new response id", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: {},
    turns: [{ text: "forked reply" }],
  });
  const runner = makeRunner();
  const sourceSessionId = "persisted-source";
  const events: Array<{ kind: "open" | "chunk"; sessionId: string }> = [];
  runner.on("session_open", (event) => events.push({ kind: "open", sessionId: event.sessionId }));
  runner.on("agent_message_chunk", (event) =>
    events.push({ kind: "chunk", sessionId: event.sessionId }),
  );

  const session = await runner.forkSession({ cwd, sessionId: sourceSessionId });

  assert.notEqual(session.sessionId, sourceSessionId);
  assert.equal(session.sessionRef.sessionId, session.sessionId);
  assert.equal((await session.prompt("continue independently")).text, "forked reply");

  const forkCall = readLog().find((entry) => entry.method === "forkSession");
  const promptCall = readLog().find((entry) => entry.method === "prompt");
  assert.equal(forkCall?.params?.sessionId, sourceSessionId, "fork request carries the source id");
  assert.equal(promptCall?.params?.sessionId, session.sessionId, "prompt targets the response id");
  assert.deepEqual(events, [
    { kind: "open", sessionId: session.sessionId },
    { kind: "chunk", sessionId: session.sessionId },
  ]);
  assert.equal(events.some((event) => event.sessionId === sourceSessionId), false);
  await session.release();
});

test("forkSession adopts response modes and configOptions before applying selections", async () => {
  const forkConfigOptions: SessionConfigOption[] = [
    {
      id: "model",
      type: "select",
      name: "Model",
      category: "model",
      currentValue: "fork-default",
      options: [
        { value: "fork-default", name: "Fork default" },
        { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      ],
    },
  ];
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: { modes: MODES, configOptions: forkConfigOptions },
    turns: [{ text: "unused" }],
  });
  const runner = makeRunner();
  const resolved: string[] = [];

  const session = await runner.forkSession({
    cwd,
    sessionId: "source-with-catalog",
    model: "claude-sonnet-4-5",
    mode: "plan",
    onModelResolved: (model) => resolved.push(model),
  });

  assert.deepEqual(resolved, ["claude-sonnet-4-5"]);
  assert.equal(session.modes?.currentModeId, "plan");
  const wire = methods(readLog());
  assert.ok(wire.indexOf("forkSession") < wire.indexOf("setSessionConfigOption"));
  assert.ok(wire.indexOf("setSessionConfigOption") < wire.indexOf("setSessionMode"));
  const configCall = readLog().find((entry) => entry.method === "setSessionConfigOption");
  const modeCall = readLog().find((entry) => entry.method === "setSessionMode");
  assert.equal(configCall?.params?.sessionId, session.sessionId);
  assert.equal(configCall?.params?.configId, "model");
  assert.equal(configCall?.params?.value, "claude-sonnet-4-5");
  assert.equal(modeCall?.params?.sessionId, session.sessionId);
  await session.release();
});

test("forkSession capability gate rejects before any session/fork request", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();

  await assert.rejects(
    () => runner.forkSession({ cwd, sessionId: "source-without-fork", label: "fork-gate" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.equal(error.agentLabel, "fork-gate");
      assert.match(error.message, /claude/);
      assert.match(error.message, /session\/fork/);
      assert.match(error.message, /sessionCapabilities=close/);
      return true;
    },
  );
  assert.equal(readLog().some((entry) => entry.method === "forkSession"), false);
});

test("failed forkSession cleans routing, pending resolvers, and activeSessions on the same connection", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: {
      permissionBeforeError: { sessionId: "unannounced-fork-id", title: "Premature fork tool" },
      throw: "fork exploded",
    },
    turns: [{ text: "connection recovered" }],
  });
  let resolverCalls = 0;
  const sessionOptions: AcpSessionOptions = {
    cwd,
    schema: undefined,
    policy: {},
    permissionResolver: () => {
      resolverCalls += 1;
      return ALLOW;
    },
  };
  const connection = harness.track(
    PooledConnection.create(new ClaudeBackend(), { onDead: () => undefined }),
  );

  await assert.rejects(
    () => connection.forkSession("source-that-fails", sessionOptions),
    /fork exploded/,
  );
  assert.equal(connection.activeSessions, 0);
  assert.equal(resolverCalls, 0, "an unknown pre-response id never reaches the resolver");
  assert.deepEqual(permissionOutcomes(readLog()), [{ outcome: "cancelled" }]);

  type RoutedState = {
    pendingPermissions: Set<unknown>;
    pendingElicitations: Set<unknown>;
  };
  const routedStates = (
    connection as unknown as { client: { sessions: Map<string, RoutedState> } }
  ).client.sessions;
  assert.equal(routedStates.size, 0, "failed fork leaves no registered state");

  const opened = await connection.openSession(sessionOptions);
  assert.equal(connection.activeSessions, 1);
  assert.equal((await opened.prompt("still usable")).stopReason, "end_turn");
  assert.equal(opened.currentTurnText(), "connection recovered");
  assert.equal(routedStates.size, 1);
  for (const state of routedStates.values()) {
    assert.equal(state.pendingPermissions.size, 0);
    assert.equal(state.pendingElicitations.size, 0);
  }
  await opened.release();
  assert.equal(connection.activeSessions, 0);
  assert.equal(routedStates.size, 0);
});

test("forkSession keepSession releases without closing the new response id", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: {},
    turns: [{ text: "unused" }],
  });
  const runner = makeRunner();
  const session = await runner.forkSession({
    cwd,
    sessionId: "source-to-keep",
    keepSession: true,
  });
  const forkedSessionId = session.sessionId;

  await session.release();

  assert.notEqual(forkedSessionId, "source-to-keep");
  assert.equal(
    readLog().some(
      (entry) => entry.method === "closeSession" && entry.params?.sessionId === forkedSessionId,
    ),
    false,
  );
});

test("sessionRef.reopen.fork mirrors the initialize advertisement", async () => {
  const capable = configure({ lifecycleSupport: true, forkSession: {}, turns: [{ text: "unused" }] });
  const capableRunner = makeRunner();
  const forked = await capableRunner.forkSession({ cwd: capable.cwd, sessionId: "source-ref" });
  assert.equal(forked.sessionRef.reopen.fork, true);
  await forked.release();
  await capableRunner.dispose();

  const unsupported = configure({ turns: [{ text: "unused" }] });
  const unsupportedRunner = makeRunner();
  const opened = await unsupportedRunner.openSession({ cwd: unsupported.cwd });
  assert.equal(opened.sessionRef.reopen.fork, false);
  await opened.release();
});

test("listSessions and deleteSession round-trip through the selected backend", async () => {
  const savedCwd = "/tmp/saved-session";
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    listSessions: {
      sessions: [{ sessionId: "s1", cwd: savedCwd, title: "Saved", updatedAt: "2026-07-06T00:00:00.000Z" }],
      nextCursor: "next-page",
    },
  });
  const runner = makeRunner();

  const listed = await runner.listSessions({
    model: "claude",
    cwd,
    cursor: "cursor-1",
    meta: { source: "test" },
  });
  await runner.deleteSession({ model: "claude", sessionId: "s1", meta: { source: "test" } });

  assert.deepEqual(listed, {
    sessions: [{ sessionId: "s1", cwd: savedCwd, title: "Saved", updatedAt: "2026-07-06T00:00:00.000Z" }],
    nextCursor: "next-page",
  });
  const listCall = readLog().find((entry) => entry.method === "listSessions");
  assert.equal(listCall?.params?.cwd, cwd);
  assert.equal(listCall?.params?.cursor, "cursor-1");
  assert.deepEqual(listCall?.params?._meta, { source: "test" });
  const deleteCall = readLog().find((entry) => entry.method === "deleteSession");
  assert.equal(deleteCall?.params?.sessionId, "s1");
});

test("lifecycle capability gate names the backend, method, and advertisement", async () => {
  configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();

  await assert.rejects(
    () => runner.listSessions({ model: "claude" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.match(error.message, /claude/);
      assert.match(error.message, /session\/list/);
      assert.match(error.message, /loadSession=false/);
      assert.match(error.message, /sessionCapabilities=close/);
      return true;
    },
  );
});

test("raw passthrough guards stateful session methods but leaves safe methods open", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    modes: MODES,
    turns: [{ text: "unused" }],
  });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });

  await assert.rejects(
    () => session.request(AGENT_METHODS.session_new, { cwd, mcpServers: [] }),
    /use openSession\(\).+unregistered.+permission requests auto-cancel/s,
  );
  await assert.rejects(
    () => session.request(AGENT_METHODS.session_load, { sessionId: session.sessionId, cwd, mcpServers: [] }),
    /use loadSession\(\).+unregistered.+fs\/terminal dispatch fails/s,
  );
  await assert.rejects(
    () => session.request(AGENT_METHODS.session_resume, { sessionId: session.sessionId, cwd, mcpServers: [] }),
    /use resumeSession\(\).+unregistered/s,
  );
  await assert.rejects(
    () => session.request(AGENT_METHODS.session_fork, { sessionId: session.sessionId, cwd, mcpServers: [] }),
    /use forkSession\(\).+unregistered/s,
  );

  await session.request(AGENT_METHODS.session_set_mode, { sessionId: session.sessionId, modeId: "plan" });
  assert.equal(
    readLog().some((entry) => entry.method === "setSessionMode" && entry.params?.modeId === "plan"),
    true,
  );
  await session.release();
});

test("loadSession({ mode }) applies strictly from the response mode catalog", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSession: { modes: MODES },
    turns: [{ text: "unused" }],
  });
  const runner = makeRunner();

  const session = await runner.loadSession({ cwd, sessionId: "persisted-mode", mode: "plan" });

  assert.equal(session.modes?.currentModeId, "plan");
  await session.release();
  const wire = methods(readLog());
  assert.ok(wire.indexOf("setSessionMode") > wire.indexOf("loadSession"));
  assert.ok(wire.indexOf("setSessionMode") < wire.indexOf("closeSession"));
});
