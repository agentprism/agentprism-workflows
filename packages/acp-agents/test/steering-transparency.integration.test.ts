// End-to-end steering transport coverage against the mock ACP agent. These tests pin the active
// prompt precondition, absence of a client-side advertisement gate, complete raw responses,
// malformed-response transparency, event privacy, and lifecycle races.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type ContentBlock } from "@agentclientprotocol/sdk";
import { META_KEYS } from "@automatalabs/shared-types";
import {
  CodexBackend,
  PooledConnection,
  SESSION_STEERING_METHOD,
  type AcpEventSink,
  type AcpSessionOptions,
  type AcpSteeringEvent,
} from "../src/index.js";
import { createFakeAgentHarness, waitFor } from "./helpers/fake-agent.js";

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
  prefix: "acp-steering-transparency-",
  backends: ["codex", "opencode"],
});
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

function initialize(options: { image?: boolean; topLevelMeta?: Record<string, unknown> } = {}): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { close: {} },
      ...(options.image === undefined ? {} : { promptCapabilities: { image: options.image } }),
      // These false flags previously filtered outgoing metadata. They are now opaque agent data.
      _meta: {
        "@example/legacy-gate": {
          [META_KEYS.outputSchema]: false,
          trace: false,
        },
      },
    },
    ...(options.topLevelMeta ? { _meta: options.topLevelMeta } : {}),
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

test("SessionHandle transports complete steering metadata/response and emits a privacy-safe event", async () => {
  const secretPrompt = "do not copy this steering prompt into the event";
  const privateMeta = "request-metadata-only";
  const rawResponse = {
    outcome: "failed",
    _meta: {
      vendor: { nested: [1, null, { complete: true }] },
    },
    diagnostics: { retryable: false },
  };
  const initializeMeta = {
    steering: { supported: true, protocol: { strict: true } },
    vendor: { nested: ["initialize", { complete: true }] },
  };
  const { cwd, readLog } = configure({
    initialize: initialize({ image: false, topLevelMeta: initializeMeta }),
    extensionRequest: { method: SESSION_STEERING_METHOD, response: rawResponse },
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
    PooledConnection.create(new CodexBackend(), { onDead: () => undefined, onEvent }),
  );
  const session = await connection.openSession(sessionOptions(cwd));
  const prompt = session.prompt("original prompt");
  let promptSettled = false;
  void prompt.finally(() => {
    promptSettled = true;
  });
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  const response = await session.steer(
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
      arbitraryNested: { values: [false, { deep: "kept" }] },
    },
  );

  assert.deepEqual(response, rawResponse);
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
    (entry) => entry.method === "extensionRequest" && entry.extensionMethod === SESSION_STEERING_METHOD,
  );
  assert.deepEqual(wire?.params?.prompt?.[0], { type: "text", text: secretPrompt });
  assert.equal(wire?.params?.prompt?.[1]?.type, "text");
  assert.match(
    (wire?.params?.prompt?.[1] as Extract<ContentBlock, { type: "text" }>).text,
    /image omitted: image\/png; uri=file:\/\/\/tmp\/steer\.png.+codex agent does not advertise promptCapabilities\.image/,
  );
  assert.deepEqual(wire?.params?._meta, {
    [META_KEYS.outputSchema]: { private: true },
    trace: privateMeta,
    arbitraryNested: { values: [false, { deep: "kept" }] },
  });

  assert.equal(steeringEvents.length, 1);
  const event = steeringEvents[0]!;
  assert.equal(event.sessionId, session.sessionId);
  assert.equal(event.backendId, "codex");
  assert.equal(event.label, "steering-core");
  assert.equal(event.runId, "steering-run");
  assert.equal(event.callIndex, 23);
  assert.deepEqual(event.response, rawResponse);
  assert.deepEqual(event.initializeMeta, initializeMeta);
  const eventJson = JSON.stringify(event);
  assert.equal(eventJson.includes(secretPrompt), false);
  assert.equal(eventJson.includes(privateMeta), false);
  assert.deepEqual(
    Object.keys(event).sort(),
    ["backendId", "callIndex", "initializeMeta", "label", "response", "runId", "sessionId"].sort(),
  );

  const promptResponse = await prompt;
  assert.equal(promptResponse.stopReason, "end_turn");
  assert.equal(session.currentTurnText(), "owned by original prompt");
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 1);
  await session.release();
});

test("malformed steering response values cross the raw transport and event boundary unchanged", async () => {
  const { cwd } = configure({
    initialize: initialize(),
    extensionRequest: { method: SESSION_STEERING_METHOD, response: null },
  });
  const events: AcpSteeringEvent[] = [];
  const connection = harness.track(
    PooledConnection.create(new CodexBackend(), {
      onDead: () => undefined,
      onEvent: (name, event) => {
        if (name === "steering") events.push(event as AcpSteeringEvent);
      },
    }),
  );
  const session = await connection.openSession(sessionOptions(cwd));

  const response = await connection.steerSession({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "redirect" }],
  });
  assert.equal(response, null);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.response, null);
  await session.release();
});

test("InteractiveSession keeps the idle precondition but sends active steering without an advertisement gate", async () => {
  const { cwd, readLog } = configure({
    initialize: initialize(),
    extensionRequest: {
      method: SESSION_STEERING_METHOD,
      response: { outcome: "injected", _meta: { acceptedBy: "unadvertised-agent" } },
    },
    turns: [{ waitForCancel: true }],
  });
  const runner = harness.makeRunner();
  const session = await runner.openSession({ model: "opencode", cwd });

  await assert.rejects(() => session.steer("idle"), /use prompt\(\) when the session is idle/);
  assert.equal(readLog().some((entry) => entry.method === "extensionRequest"), false);

  const prompt = session.prompt("wait");
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));
  assert.deepEqual(await session.steer("in flight"), {
    outcome: "injected",
    _meta: { acceptedBy: "unadvertised-agent" },
  });
  assert.equal(readLog().filter((entry) => entry.method === "extensionRequest").length, 1);
  await assert.rejects(
    () => session.request(SESSION_STEERING_METHOD, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "raw" }],
    }),
    /use steerSession\(\).+complete extension response/s,
  );

  await session.cancel();
  await prompt;
  await session.release();
});

test("cancelling the original prompt does not retry or narrow a late steering response", async () => {
  const rawResponse = {
    outcome: "startedNewTurn",
    _meta: { protocolViolationOwner: "host" },
  };
  const { cwd, readLog } = configure({
    initialize: initialize({ topLevelMeta: { steering: { supported: true } } }),
    extensionRequest: { method: SESSION_STEERING_METHOD, delayMs: 100, response: rawResponse },
    turns: [{ waitForCancel: true }],
  });
  const runner = harness.makeRunner();
  const events: AcpSteeringEvent[] = [];
  runner.on("steering", (event) => events.push(event));
  const session = await runner.openSession({ model: "codex", cwd });
  const prompt = session.prompt("wait");
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  const steering = session.steer("late instruction");
  await waitFor(() => readLog().some((entry) => entry.method === "extensionRequest"));
  await session.cancel();
  assert.equal((await prompt).stopReason, "cancelled");
  assert.deepEqual(await steering, rawResponse);
  assert.equal(readLog().filter((entry) => entry.method === "extensionRequest").length, 1);
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 1);
  assert.deepEqual(events.map((event) => event.response), [rawResponse]);
  await session.release();
});

test("release during steering rejects the request and emits no steering event", async () => {
  const { cwd, readLog } = configure({
    initialize: initialize(),
    extensionRequest: { method: SESSION_STEERING_METHOD, delayMs: 1_000, response: { outcome: "injected" } },
    turns: [{ waitForCancel: true }],
  });
  const runner = harness.makeRunner();
  const events: AcpSteeringEvent[] = [];
  runner.on("steering", (event) => events.push(event));
  const session = await runner.openSession({ model: "codex", cwd });
  const prompt = session.prompt("wait");
  const steering = session.steer("instruction");
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
    initialize: initialize(),
    extensionRequest: { method: SESSION_STEERING_METHOD, exitBeforeResponse: true },
    turns: [{ waitForCancel: true }],
  });
  const runner = harness.makeRunner();
  const events: AcpSteeringEvent[] = [];
  runner.on("steering", (event) => events.push(event));
  const session = await runner.openSession({ model: "codex", cwd });
  const prompt = session.prompt("wait");
  void prompt.catch(() => {});
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  await assert.rejects(() => session.steer("crash"), /process|exited|closed|connection/i);
  await assert.rejects(prompt, /process|exited|closed|connection/i);
  assert.deepEqual(events, []);
});
