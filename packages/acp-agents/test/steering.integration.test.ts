// End-to-end first-class steering coverage against the mock ACP agent. These tests pin the
// initialize advertisement gate, named raw transport, held-open session contract, event privacy,
// and lifecycle races without assigning steering a second prompt turn or usage accumulator.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  type ContentBlock,
} from "@agentclientprotocol/sdk";
import {
  CODEX_CUSTOM_CAPABILITY_NAMESPACE,
  META_KEYS,
  WorkflowErrorCode,
  isWorkflowError,
} from "@automatalabs/shared-types";
import {
  CodexBackend,
  PooledConnection,
  SESSION_STEERING_METHOD,
  type AcpEventSink,
  type AcpSessionOptions,
  type AcpSteeringEvent,
  type SteeringResponse,
} from "../src/index.js";
import {
  createFakeAgentHarness,
  waitFor,
} from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  extensionMethod?: string;
  params?: {
    sessionId?: string;
    prompt?: ContentBlock[];
    _meta?: Record<string, unknown>;
  };
}

const harness = createFakeAgentHarness({
  prefix: "acp-steering-it-",
  backends: ["codex", "opencode"],
});
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

function steeringInitialize(options: {
  image?: boolean;
  customMeta?: Record<string, boolean>;
} = {}): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { close: {} },
      ...(options.image === undefined
        ? {}
        : { promptCapabilities: { image: options.image } }),
      ...(options.customMeta
        ? {
            _meta: {
              [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: options.customMeta,
            },
          }
        : {}),
    },
    _meta: { steering: { supported: true } },
  };
}

const sessionOptions = (cwd: string): AcpSessionOptions => ({
  cwd,
  schema: undefined,
  policy: {},
  label: "steering-core",
  runId: "steering-run",
  callIndex: 23,
});

afterEach(async () => {
  await harness.cleanup();
});

test("SessionHandle steering preserves prompt ownership, adapts content/meta, and emits a private event", async () => {
  const secretPrompt = "do not copy this steering prompt into the event";
  const privateMeta = "request-metadata-only";
  const { cwd, readLog } = configure({
    initialize: steeringInitialize({
      image: false,
      customMeta: { [META_KEYS.outputSchema]: false },
    }),
    extensionRequest: {
      method: SESSION_STEERING_METHOD,
      response: { outcome: "failed" },
    },
    turns: [{
      delayMs: 150,
      text: "owned by original prompt",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    }],
  });
  const steeringEvents: AcpSteeringEvent[] = [];
  const onEvent: AcpEventSink = (name, event) => {
    if (name === "steering") steeringEvents.push(event as AcpSteeringEvent);
  };
  const connection = harness.track(
    PooledConnection.create(new CodexBackend(), {
      onDead: () => undefined,
      onEvent,
    }),
  );
  const session = await connection.openSession(sessionOptions(cwd));
  const prompt = session.prompt("original prompt");
  let promptSettled = false;
  void prompt.finally(() => {
    promptSettled = true;
  });
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  const outcome = await session.steer(
    [
      { type: "text", text: secretPrompt },
      {
        type: "image",
        data: "ZmFrZS1pbWFnZQ==",
        mimeType: "image/png",
        uri: "file:///tmp/steer.png",
      },
    ],
    {
      [META_KEYS.outputSchema]: { private: true },
      trace: privateMeta,
    },
  );

  assert.equal(outcome, "failed", "a resolved failed outcome is surfaced rather than thrown");
  assert.equal(promptSettled, false, "steering did not settle or replace the original prompt");
  assert.equal(session.currentTurnText(), "", "steering owns no output accumulator");
  assert.deepEqual(session.usage.toAgentUsage(), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
  }, "steering owns no usage");

  const wire = readLog().find(
    (entry) =>
      entry.method === "extensionRequest" &&
      entry.extensionMethod === SESSION_STEERING_METHOD,
  );
  assert.deepEqual(wire?.params?.prompt?.[0], { type: "text", text: secretPrompt });
  assert.equal(wire?.params?.prompt?.[1]?.type, "text");
  assert.match(
    (wire?.params?.prompt?.[1] as Extract<ContentBlock, { type: "text" }>).text,
    /image omitted: image\/png; uri=file:\/\/\/tmp\/steer\.png.+codex agent does not advertise promptCapabilities\.image/,
    "steering content uses the same prompt-capability adaptation as session/prompt",
  );
  assert.deepEqual(
    wire?.params?._meta,
    { trace: privateMeta },
    "outgoing request metadata uses the separate custom-meta capability gate",
  );

  assert.equal(steeringEvents.length, 1);
  assert.equal(steeringEvents[0]?.sessionId, session.sessionId);
  assert.equal(steeringEvents[0]?.backendId, "codex");
  assert.equal(steeringEvents[0]?.label, "steering-core");
  assert.equal(steeringEvents[0]?.runId, "steering-run");
  assert.equal(steeringEvents[0]?.callIndex, 23);
  assert.equal(steeringEvents[0]?.outcome, "failed");
  assert.deepEqual(steeringEvents[0]?.initializeMeta, { steering: { supported: true } });
  const eventJson = JSON.stringify(steeringEvents[0]);
  assert.equal(eventJson.includes(secretPrompt), false);
  assert.equal(eventJson.includes(privateMeta), false);
  assert.deepEqual(
    Object.keys(steeringEvents[0] ?? {}).sort(),
    ["backendId", "callIndex", "initializeMeta", "label", "outcome", "runId", "sessionId"].sort(),
  );

  const response = await prompt;
  assert.equal(response.stopReason, "end_turn");
  assert.equal(session.currentTurnText(), "owned by original prompt");
  assert.deepEqual(session.usage.toAgentUsage(), {
    input: 11,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    total: 18,
    cost: 0,
  }, "only the original session/prompt response recorded usage");
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 1);
  await session.release();
});

test("PooledConnection.steerSession preserves the raw response object", async () => {
  const { cwd } = configure({
    initialize: steeringInitialize(),
    extensionRequest: {
      method: SESSION_STEERING_METHOD,
      response: { outcome: "injected" },
    },
    turns: [{ waitForCancel: true }],
  });
  const connection = harness.track(
    PooledConnection.create(new CodexBackend(), { onDead: () => undefined }),
  );
  const session = await connection.openSession(sessionOptions(cwd));
  const prompt = session.prompt("wait");

  const response = await connection.steerSession({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "redirect" }],
  });
  assert.deepEqual(response, { outcome: "injected" } satisfies SteeringResponse);

  await session.cancel();
  await prompt;
  await session.release();
});

test("unadvertised OpenCode rejects idle and in-flight steering before any wire request", async () => {
  const { cwd, readLog } = configure({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        sessionCapabilities: { close: {} },
        _meta: { steering: { supported: true } },
      },
      // Deliberately place a lookalike in agentCapabilities._meta: it is NOT the top-level
      // initialize-response capability advertisement and must never enable steering.
    },
    extensionRequest: {
      method: SESSION_STEERING_METHOD,
      response: { outcome: "injected" },
    },
    turns: [{ waitForCancel: true }],
  });
  const runner = harness.makeRunner();
  const session = await runner.openSession({
    model: "opencode",
    cwd,
    label: "unsupported-steering",
  });

  await assert.rejects(
    () => session.steer("idle"),
    /use prompt\(\) when the session is idle/,
  );
  const prompt = session.prompt("wait");
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  await assert.rejects(
    () => session.steer("in flight"),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.equal(error.agentLabel, "unsupported-steering");
      assert.match(error.message, /opencode/);
      assert.match(error.message, /_session\/steering/);
      assert.match(error.message, /_meta\.steering\.supported was not exactly true/);
      return true;
    },
  );
  await assert.rejects(
    () =>
      session.request(SESSION_STEERING_METHOD, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "raw" }],
      }),
    /use steerSession\(\).+initialize-response steering capability/s,
  );
  assert.equal(
    readLog().some((entry) => entry.method === "extensionRequest"),
    false,
    "neither named nor raw unsupported steering crossed the wire",
  );

  await session.cancel();
  await prompt;
  await session.release();
});

test("cancelling the original prompt does not retry a late startedNewTurn steering outcome", async () => {
  const { cwd, readLog } = configure({
    initialize: steeringInitialize(),
    extensionRequest: {
      method: SESSION_STEERING_METHOD,
      delayMs: 100,
      response: { outcome: "startedNewTurn" },
    },
    turns: [{ waitForCancel: true }],
  });
  const runner = harness.makeRunner();
  const events: AcpSteeringEvent[] = [];
  runner.on("steering", (event) => events.push(event));
  const session = await runner.openSession({ model: "codex", cwd });
  const prompt = session.prompt("wait");
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  const steering = session.steer("late follow-up");
  await waitFor(() => readLog().some((entry) => entry.method === "extensionRequest"));
  await session.cancel();
  assert.deepEqual(await prompt, { stopReason: "cancelled", text: "" });
  assert.equal(await steering, "startedNewTurn");
  assert.equal(readLog().filter((entry) => entry.method === "extensionRequest").length, 1);
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 1);
  assert.deepEqual(events.map((event) => event.outcome), ["startedNewTurn"]);
  await session.release();
});

test("release during steering rejects the request and emits no steering event", async () => {
  const { cwd, readLog } = configure({
    initialize: steeringInitialize(),
    extensionRequest: {
      method: SESSION_STEERING_METHOD,
      delayMs: 1_000,
      response: { outcome: "injected" },
    },
    turns: [{ waitForCancel: true }],
  });
  const runner = harness.makeRunner();
  const events: AcpSteeringEvent[] = [];
  runner.on("steering", (event) => events.push(event));
  const session = await runner.openSession({ model: "codex", cwd });
  const prompt = session.prompt("wait");
  const steering = session.steer("follow-up");
  void prompt.catch(() => {});
  void steering.catch(() => {});
  await waitFor(() => readLog().some((entry) => entry.method === "extensionRequest"));

  await session.release();
  await assert.rejects(steering, /process|exited|closed|connection/i);
  await assert.rejects(prompt, /process|exited|closed|connection/i);
  assert.deepEqual(events, []);
});

test("process death races steering and emits no resolved-response event", async () => {
  const { cwd, readLog } = configure({
    initialize: steeringInitialize(),
    extensionRequest: {
      method: SESSION_STEERING_METHOD,
      exitBeforeResponse: true,
    },
    turns: [{ waitForCancel: true }],
  });
  const runner = harness.makeRunner();
  const events: AcpSteeringEvent[] = [];
  runner.on("steering", (event) => events.push(event));
  const session = await runner.openSession({ model: "codex", cwd });
  const prompt = session.prompt("wait");
  void prompt.catch(() => {});
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  await assert.rejects(
    () => session.steer("crash"),
    /process|exited|closed|connection/i,
  );
  await assert.rejects(prompt, /process|exited|closed|connection/i);
  assert.deepEqual(events, []);
});
