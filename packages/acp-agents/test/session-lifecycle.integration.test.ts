import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import {
  AGENT_METHODS,
  AcpAgentRunner,
  ClaudeBackend,
  PI_CHILD_CLEANUP_DEADLINE_MS,
  PI_CLOSE_SESSION_TIMEOUT_MS,
  PooledConnection,
  SESSION_STEERING_METHOD,
  type AcpEventSink,
  type AcpSessionOptions,
} from "../src/index.js";
import { createFakeAgentHarness, waitFor } from "./helpers/fake-agent.js";

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const ELICITATION_ACCEPT: CreateElicitationResponse = {
  action: "accept",
  content: { answer: "fork accepted" },
};

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
  request?: CreateElicitationRequest;
  response?: CreateElicitationResponse;
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

/** The fake's id-only fork rejection as the SDK maps a plain `Error("Session not found")`:
 *  `internalError({ details })` on the wire; the handle's prompt path folds `data.details` into
 *  the classifiable message while raw wire methods surface the RequestError itself. */
function isSessionNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const details = (error as { data?: { details?: unknown } } | null)?.data?.details;
  return /Session not found/.test(message) || details === "Session not found";
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

test("Pi close delivery bound admits 4,999 ms success and observes 5,000 ms child cleanup failure", async () => {
  assert.equal(PI_CHILD_CLEANUP_DEADLINE_MS, 5_000);
  assert.equal(PI_CLOSE_SESSION_TIMEOUT_MS, 6_000);
  assert.ok(PI_CLOSE_SESSION_TIMEOUT_MS > PI_CHILD_CLEANUP_DEADLINE_MS);

  const success = harness.configure<LogEntry>({
    turns: [{ text: "closed cleanly", close: { delayMs: 4_999 } }],
  }, { backends: ["pi"] });
  const successRunner = makeRunner();
  assert.equal(await successRunner.run("hi", { model: "pi", cwd: success.cwd }), "closed cleanly");
  await successRunner.dispose();

  const failure = harness.configure<LogEntry>({
    turns: [{
      text: "primary success",
      close: {
        delayMs: 5_000,
        throw: "child process cleanup failed",
        throwData: { errorKind: "child_cleanup_error", details: { remainingChildren: 1 } },
      },
    }],
  }, { backends: ["pi"] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "pi", cwd: failure.cwd, label: "pi-cleanup" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, false);
      assert.equal(error.message, "child process cleanup failed");
      assert.equal(error.agentLabel, "pi-cleanup");
      return true;
    },
  );
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

test("forkSession routes turn permission resolution under the forked response id", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: {},
    turns: [{ toolCall: { title: "Read from fork", kind: "read" }, text: "fork permission resolved" }],
  });
  const runner = makeRunner();
  const resolved: Array<{ requestSessionId: string; contextSessionId: string }> = [];
  const session = await runner.forkSession({
    cwd,
    sessionId: "permission-source",
    onPermissionRequest: (request, context) => {
      resolved.push({ requestSessionId: request.sessionId, contextSessionId: context.sessionId });
      return ALLOW;
    },
  });

  const turn = await session.prompt("continue with permission");

  assert.equal(turn.text, "fork permission resolved");
  assert.deepEqual(resolved, [
    { requestSessionId: session.sessionId, contextSessionId: session.sessionId },
  ]);
  assert.deepEqual(permissionOutcomes(readLog()), [ALLOW.outcome]);
  assert.equal(
    readLog().find((entry) => entry.method === "prompt")?.params?.sessionId,
    session.sessionId,
  );
  await session.release();
});

test("forkSession uses its session-scoped elicitation resolver under the forked response id", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: {},
    turns: [
      {
        elicitation: {
          mode: "form",
          message: "Name this fork",
          schema: {
            type: "object",
            properties: { answer: { type: "string", title: "Answer" } },
            required: ["answer"],
          },
        },
        text: "fork elicitation resolved",
      },
    ],
  });
  const runner = makeRunner();
  const resolved: Array<{ requestSessionId: string; contextSessionId: string }> = [];
  const session = await runner.forkSession({
    cwd,
    sessionId: "elicitation-source",
    onElicitation: (request, context) => {
      resolved.push({ requestSessionId: request.sessionId, contextSessionId: context.sessionId });
      return ELICITATION_ACCEPT;
    },
  });

  const turn = await session.prompt("continue with elicitation");

  assert.equal(turn.text, "fork elicitation resolved");
  assert.deepEqual(resolved, [
    { requestSessionId: session.sessionId, contextSessionId: session.sessionId },
  ]);
  const outcome = readLog().find((entry) => entry.method === "elicitationOutcome");
  assert.equal(outcome?.request?.sessionId, session.sessionId);
  assert.deepEqual(outcome?.response, ELICITATION_ACCEPT);
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

test("forkSession keepSession remains loadable after release without closing the forked id", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: {},
    loadSession: {},
    turns: [{ text: "loaded fork reply" }],
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

  const loaded = await runner.loadSession({ cwd, sessionId: forkedSessionId });
  assert.equal(loaded.sessionId, forkedSessionId);
  assert.equal((await loaded.prompt("continue kept fork")).text, "loaded fork reply");
  const loadCall = readLog().find((entry) => entry.method === "loadSession");
  assert.equal(loadCall?.params?.sessionId, forkedSessionId);
  await loaded.release();
});

// ---- fixture self-tests: the fork knobs the AcpAgent suite relies on ------------------------

test("forkSession.idOnly returns a bare { sessionId } whose id is dead until session/resume reattaches it", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    modes: MODES,
    forkSession: { idOnly: true, turns: [{ text: "child after resume" }] },
    extensionRequest: { method: SESSION_STEERING_METHOD, response: { outcome: "accepted" } },
    turns: [{ text: "never served to the fork" }],
  });
  const sessionOptions: AcpSessionOptions = { cwd, schema: undefined, policy: {} };
  const connection = harness.track(
    PooledConnection.create(new ClaudeBackend(), { onDead: () => undefined }),
  );

  const fork = await connection.forkSession("id-only-source", sessionOptions);
  assert.match(fork.sessionId, /^fake-fork-/);
  assert.deepEqual(fork.advertisedConfigOptions, [], "the fork response carries no catalog");
  assert.equal(fork.modes, undefined, "the fork response carries no modes");

  // Every session method aimed at the un-reattached id fails the Claude way.
  await assert.rejects(() => fork.prompt("hi"), isSessionNotFound);
  await assert.rejects(() => fork.steer("nudge"), isSessionNotFound);
  await assert.rejects(
    () => connection.setSessionMode({ sessionId: fork.sessionId, modeId: "plan" }),
    isSessionNotFound,
  );
  await assert.rejects(
    () =>
      connection.setSessionConfigOption({
        sessionId: fork.sessionId,
        configId: "model",
        value: "claude-opus-4-1",
      }),
    isSessionNotFound,
  );
  assert.equal(fork.currentTurnText(), "");

  // Reattaching the id makes it live and hands back the catalog; the forked id keeps its own
  // turn script across the reattach (forkSession.turns, not scenario.turns).
  await fork.release({ keepOpen: true });
  const resumed = await connection.resumeSession(fork.sessionId, sessionOptions);
  assert.equal(resumed.sessionId, fork.sessionId);
  assert.ok(resumed.advertisedConfigOptions.length > 0, "the catalog arrives with the reattach");
  assert.deepEqual(resumed.modes?.availableModes.map((mode) => mode.id), ["default", "plan"]);
  await resumed.setMode("plan");
  assert.equal((await resumed.prompt("go")).stopReason, "end_turn");
  assert.equal(resumed.currentTurnText(), "child after resume");
  assert.deepEqual(await resumed.steer("nudge again"), { outcome: "accepted" });
  await resumed.release();

  const log = readLog();
  const wire = methods(log);
  assert.equal(wire.includes("loadSession"), false);
  assert.equal(wire.filter((method) => method === "closeSession").length, 1, "only the live handle closes");
  const failingPrompt = wire.indexOf("prompt");
  const resume = wire.indexOf("resumeSession");
  assert.ok(wire.indexOf("forkSession") < failingPrompt, "the dead prompt reached the wire after the fork");
  assert.ok(failingPrompt < resume, "the rejections happened before the reattach");
  assert.ok(resume < wire.lastIndexOf("prompt"), "the live prompt followed the reattach");
  assert.ok(resume < wire.indexOf("setSessionMode", resume));
  assert.equal(log.find((entry) => entry.method === "resumeSession")?.params?.sessionId, fork.sessionId);
  for (const entry of log) {
    if (["prompt", "resumeSession", "setSessionMode", "extensionRequest"].includes(entry.method)) {
      assert.equal(entry.params?.sessionId, fork.sessionId, `${entry.method} targets the forked id`);
    }
  }
});

test("forkSession.idOnly is reattachable through session/load as well", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    resumeSessionSupport: false,
    forkSession: { idOnly: true },
    loadSession: { replay: [{ role: "user", text: "q" }, "replayed"] },
    turns: [{ text: "after load" }],
  });
  const sessionOptions: AcpSessionOptions = { cwd, schema: undefined, policy: {} };
  const connection = harness.track(
    PooledConnection.create(new ClaudeBackend(), { onDead: () => undefined }),
  );
  const fork = await connection.forkSession("id-only-load-source", sessionOptions);
  await assert.rejects(() => fork.prompt("hi"), isSessionNotFound);
  await fork.release({ keepOpen: true });

  const loaded = await connection.loadSession(fork.sessionId, sessionOptions);
  assert.equal(loaded.text, "replayed");
  assert.equal((await loaded.prompt("go")).stopReason, "end_turn");
  assert.equal(loaded.currentTurnText(), "after load");
  await loaded.release();
  const wire = methods(readLog());
  assert.equal(wire.includes("resumeSession"), false);
  assert.ok(wire.indexOf("forkSession") < wire.indexOf("loadSession"));
  assert.ok(wire.indexOf("loadSession") < wire.lastIndexOf("prompt"));
});

test("forkSession.turns serves ids minted by session/fork their own script; other ids keep scenario.turns", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    forkSession: { turns: [{ text: "child one" }, { text: "child two" }] },
    turns: [{ text: "parent" }],
  });
  const runner = makeRunner();

  const parent = await runner.openSession({ cwd });
  assert.equal((await parent.prompt("p1")).text, "parent");
  const child = await runner.forkSession({ cwd, sessionId: parent.sessionId });
  assert.equal((await child.prompt("c1")).text, "child one", "the fork's first prompt is its own turns[0]");
  assert.equal((await child.prompt("c2")).text, "child two");
  assert.equal((await child.prompt("c3")).text, "child two", "the last fork turn repeats");
  assert.equal((await parent.prompt("p2")).text, "parent", "the parent's cursor is untouched by the fork");

  const prompts = readLog().filter((entry) => entry.method === "prompt");
  assert.deepEqual(
    prompts.map((entry) => entry.params?.sessionId === child.sessionId),
    [false, true, true, true, false],
  );
  await child.release();
  await parent.release();
});

test("forkSession.replay and forkSession.updates stream under the NEW id before the fork response", async () => {
  const { cwd } = configure({
    lifecycleSupport: true,
    forkSession: {
      replay: [{ role: "user", text: "q" }, "a"],
      updates: [{ sessionUpdate: "usage_update", used: 1, size: 10 }],
    },
    turns: [{ text: "unused" }],
  });
  const seen: Array<{ sessionId: string; kind: string; beforeResponse: boolean }> = [];
  let forkResponded = false;
  const onEvent: AcpEventSink = (name, event) => {
    if (name !== "session_update") return;
    const { sessionId, update } = event as { sessionId: string; update: { sessionUpdate: string } };
    seen.push({ sessionId, kind: update.sessionUpdate, beforeResponse: !forkResponded });
  };
  const connection = harness.track(
    PooledConnection.create(new ClaudeBackend(), { onDead: () => undefined, onEvent }),
  );

  const fork = await connection.forkSession("replay-source", { cwd, schema: undefined, policy: {} });
  forkResponded = true;

  assert.deepEqual(seen, [
    { sessionId: fork.sessionId, kind: "user_message_chunk", beforeResponse: true },
    { sessionId: fork.sessionId, kind: "agent_message_chunk", beforeResponse: true },
    { sessionId: fork.sessionId, kind: "usage_update", beforeResponse: true },
  ]);
  // The id is registered only after the response, so pre-response updates never fold into the
  // handle's accumulator — the seam an AcpAgent has to buffer around.
  assert.equal(fork.text, "");
  assert.deepEqual(fork.history, []);
  await fork.release();
});

test("the turn permission request forwards toolCall.name and toolCallId verbatim and defaults the id to tc-1", async () => {
  const { cwd, readLog } = configure({
    turns: [
      { toolCall: { title: "Write", kind: "edit", name: "write_file", toolCallId: "tc-9" }, text: "named" },
      { toolCall: { title: "Read", kind: "read" }, text: "default" },
    ],
  });
  const requests: Array<{ toolCallId: string; name?: string | null }> = [];
  const runner = makeRunner();
  const session = await runner.openSession({
    cwd,
    onPermissionRequest: (request) => {
      requests.push({ toolCallId: request.toolCall.toolCallId, name: request.toolCall.name });
      return ALLOW;
    },
  });
  assert.equal((await session.prompt("one")).text, "named");
  assert.equal((await session.prompt("two")).text, "default");
  assert.deepEqual(requests, [
    { toolCallId: "tc-9", name: "write_file" },
    { toolCallId: "tc-1", name: undefined },
  ]);
  assert.deepEqual(permissionOutcomes(readLog()), [ALLOW.outcome, ALLOW.outcome]);
  await session.release();
});

test("a turn with ignoreCancel alone parks and stays parked after session/cancel", async () => {
  const { cwd, readLog } = configure({ turns: [{ ignoreCancel: true }] });
  const connection = harness.track(
    PooledConnection.create(new ClaudeBackend(), { onDead: () => undefined }),
  );
  const session = await connection.openSession({ cwd, schema: undefined, policy: {} });
  let settled = false;
  const prompt = session.prompt("park").finally(() => {
    settled = true;
  });
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  await connection.cancelSession(session.sessionId);
  await waitFor(() => readLog().some((entry) => entry.method === "cancel"));
  assert.equal(settled, false, "session/cancel did not release the parked turn");

  // Only killing the process ends the turn.
  const rejected = assert.rejects(() => prompt);
  await connection.dispose();
  await rejected;
  await waitFor(() => readLog().some((entry) => entry.method === "__exit"));
  const wire = methods(readLog());
  assert.deepEqual(wire.filter((method) => method === "cancel"), ["cancel"]);
  assert.ok(wire.indexOf("prompt") < wire.indexOf("cancel"));
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
