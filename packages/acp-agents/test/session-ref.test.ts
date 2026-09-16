import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionRef } from "@automatalabs/shared-types";
import {
  ClaudeBackend,
  CustomAcpBackend,
  PooledConnection,
  type AcpSessionOptions,
} from "../src/index.js";
import { sessionRefFor } from "../src/session-ref.js";
import { FAKE_AGENT_FIXTURE, createFakeAgentHarness } from "./helpers/fake-agent.js";

// src/session-ref.ts is a pure move of the runner's ref builder (the SDK-style AcpAgent reports
// the same shape). Behavioral companion to the source weld in backend-registry.test.ts: the ref
// the runner hands to `onSessionOpen` is an `InteractiveSession.sessionRef` plus `poolKey`, and
// the builder reads only the handle's negotiated capabilities and initialize metadata.

const harness = createFakeAgentHarness({ backends: ["claude"] });
afterEach(async () => {
  await harness.cleanup();
});

const sessionOptions = (cwd: string): AcpSessionOptions => ({ cwd, schema: undefined, policy: {} });

function withoutSessionId(ref: AgentSessionRef): Omit<AgentSessionRef, "sessionId"> {
  const { sessionId: _sessionId, ...rest } = ref;
  return rest;
}

test("sessionRefFor is InteractiveSession.sessionRef plus poolKey, and is what run() reports", async () => {
  const { cwd } = harness.configure({ lifecycleSupport: true, turns: [{ text: "one" }, { text: "two" }] });
  const runner = harness.makeRunner();

  let reported: AgentSessionRef | undefined;
  await runner.run("go", { model: "claude", cwd, onSessionOpen: (ref) => (reported = ref) });
  assert.ok(reported);

  const interactive = await runner.openSession({ model: "claude", cwd });
  const fromInteractive = interactive.sessionRef;
  await interactive.release();

  const backend = new ClaudeBackend();
  const connection = harness.track(PooledConnection.create(backend, { onDead: () => undefined }));
  const handle = await connection.openSession(sessionOptions(cwd));
  const built = sessionRefFor(handle, backend, cwd);
  await handle.release();

  assert.equal(built.sessionId, handle.sessionId);
  assert.deepEqual(withoutSessionId(built), { ...withoutSessionId(fromInteractive), poolKey: "claude" });
  assert.deepEqual(withoutSessionId(reported), withoutSessionId(built));
  assert.equal("poolKey" in fromInteractive, false, "the interactive ref carries no poolKey; the builder adds it");
  assert.deepEqual(built.reopen, { load: true, resume: true, list: true, fork: true });
  assert.equal(built.backendId, "claude");
  assert.equal(built.cwd, cwd);
  assert.equal("initializeMeta" in built, false, "the default fake advertises no initialize _meta");
  assert.deepEqual(JSON.parse(JSON.stringify(built)), built, "JSON-round-trippable");
});

test("sessionRefFor reads the reopen flags from the negotiated capabilities, nothing else", async () => {
  const { cwd } = harness.configure({ turns: [{ text: "ok" }] });
  const backend = new ClaudeBackend();
  const connection = harness.track(PooledConnection.create(backend, { onDead: () => undefined }));
  const handle = await connection.openSession(sessionOptions(cwd));
  try {
    const ref = sessionRefFor(handle, backend, cwd);
    assert.deepEqual(
      ref.reopen,
      { load: false, resume: false, list: false, fork: false },
      "without lifecycleSupport the fake advertises only session/close",
    );
    assert.equal(ref.reopen.load, handle.capabilities?.supportsLoadSession);
    assert.equal(ref.reopen.fork, handle.capabilities?.supportsForkSession);
  } finally {
    await handle.release();
  }
});

test("sessionRefFor carries frozen initialize metadata verbatim when the agent sends it", async () => {
  const metadata = { vendor: "example", nested: { ok: true } };
  const { cwd } = harness.configure({
    initialize: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, resume: {} } },
      _meta: metadata,
    },
    turns: [{ text: "ok" }],
  });
  const backend = new ClaudeBackend();
  const connection = harness.track(PooledConnection.create(backend, { onDead: () => undefined }));
  const handle = await connection.openSession(sessionOptions(cwd));
  try {
    const ref = sessionRefFor(handle, backend, cwd);
    assert.deepEqual(ref.initializeMeta, metadata);
    assert.strictEqual(ref.initializeMeta, handle.initializeMeta, "the handle's frozen snapshot, not a copy");
    assert.ok(Object.isFrozen(ref.initializeMeta));
    assert.deepEqual(ref.reopen, { load: true, resume: true, list: false, fork: false });
  } finally {
    await handle.release();
  }
});

test("sessionRefFor uses the custom backend's spawn-identity poolKey and registry name", async () => {
  const { cwd } = harness.configure({ turns: [{ text: "ok" }] });
  const backend = new CustomAcpBackend({
    name: "fake",
    command: process.execPath,
    args: [FAKE_AGENT_FIXTURE],
  });
  const connection = harness.track(PooledConnection.create(backend, { onDead: () => undefined }));
  const handle = await connection.openSession(sessionOptions(cwd));
  try {
    const ref = sessionRefFor(handle, backend, cwd);
    assert.equal(ref.backendId, "fake");
    assert.equal(ref.poolKey, backend.poolKey);
    assert.match(ref.poolKey!, /^fake#[0-9a-f]{12}$/);
  } finally {
    await handle.release();
  }
});
