// Script-declared ACP commands require explicit, durable approval before any backend is opened.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { RunOptions } from "@automatalabs/shared-types";
import { connect, makeRunner, runAndObserve, structured, textOf, waitForRun } from "./_harness.js";

const SCRIPT_WITH_BACKENDS = [
  'export const meta = { name: "sb", description: "d", backends: { browser: { command: "browser-acp", env: { HEADLESS: "1" } } } };',
  'return await agent("p", { model: "browser" });',
].join("\n");
const PLAIN_SCRIPT = 'export const meta = { name: "plain", description: "d" }; return await agent("p", { model: "claude" });';

function capturingRunner() {
  const seen: RunOptions[] = [];
  return { runner: makeRunner((_prompt, options) => { seen.push(options); return "ok"; }), seen };
}

afterEach(() => { delete process.env.AGENTPRISM_ALLOW_SCRIPT_BACKENDS; });

async function pendingSetup(client: Parameters<typeof waitForRun>[0], script = SCRIPT_WITH_BACKENDS) {
  const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", script } });
  assert.equal(accepted.isError, false, textOf(accepted));
  const runId = String(structured(accepted)?.runId);
  const waiting = await waitForRun(client, runId, (status) => (status.setup as { state?: string })?.state === "input-required");
  const request = (structured(waiting)?.setup as { request: { id: string; kind: string; message: string } }).request;
  assert.equal(request.kind, "backend-approval");
  return { runId, request };
}

test("a non-App client can inspect and answer backend approval without a held elicitation", async () => {
  const { runner, seen } = capturingRunner();
  const conn = await connect(runner, { listTools: true });
  try {
    const { runId, request } = await pendingSetup(conn.client);
    assert.match(request.message, /browser-acp/);
    assert.match(request.message, /HEADLESS.*1/);
    assert.equal(seen.length, 0);
    const response = await conn.client.callTool({ name: "workflow", arguments: {
      action: "setup-response", runId, setupId: request.id, response: { action: "accept", content: { approve: true } },
    } });
    assert.equal(response.isError, false, textOf(response));
    const completed = await waitForRun(conn.client, runId);
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    assert.deepEqual(seen[0]?.backends, { browser: { command: "browser-acp", env: { HEADLESS: "1" } } });
  } finally { await conn.dispose(); }
});

test("the explicit operator opt-in approves script backends and preserves their exact registry", async () => {
  process.env.AGENTPRISM_ALLOW_SCRIPT_BACKENDS = "1";
  const { runner, seen } = capturingRunner();
  const conn = await connect(runner);
  try {
    const completed = await runAndObserve(conn.client, { script: SCRIPT_WITH_BACKENDS });
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    assert.deepEqual(seen[0]?.backends, { browser: { command: "browser-acp", env: { HEADLESS: "1" } } });
  } finally { await conn.dispose(); }
});

test("each new run obtains its own approval; changed configuration cannot reuse a setup response", async () => {
  const { runner, seen } = capturingRunner();
  const conn = await connect(runner);
  try {
    const first = await pendingSetup(conn.client);
    const second = await pendingSetup(conn.client, SCRIPT_WITH_BACKENDS.replace("browser-acp", "different-acp"));
    assert.notEqual(first.runId, second.runId);
    assert.notEqual(first.request.id, second.request.id);
    const stale = await conn.client.callTool({ name: "workflow", arguments: { action: "setup-response", runId: second.runId,
      setupId: first.request.id, response: { action: "accept", content: { approve: true } } } });
    assert.equal(stale.isError, true);
    assert.equal(seen.length, 0);
    for (const pending of [first, second]) await conn.client.callTool({ name: "workflow", arguments: { action: "stop", runId: pending.runId } });
  } finally { await conn.dispose(); }
});

for (const response of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { approve: false } }] as const) {
  test(`setup ${JSON.stringify(response)} records a cancelled run and never dispatches`, async () => {
    const { runner, seen } = capturingRunner();
    const conn = await connect(runner);
    try {
      const { runId, request } = await pendingSetup(conn.client);
      const acknowledged = await conn.client.callTool({ name: "workflow", arguments: { action: "setup-response", runId, setupId: request.id, response } });
      assert.equal(acknowledged.isError, false, textOf(acknowledged));
      assert.equal(structured(acknowledged)?.status, "aborted");
      assert.equal(structured(await waitForRun(conn.client, runId))?.status, "aborted");
      assert.equal(seen.length, 0);
    } finally { await conn.dispose(); }
  });
}

test("scripts without custom backends need no approval and same-ID continuation inherits admitted backends", async () => {
  const { runner, seen } = capturingRunner();
  const conn = await connect(runner);
  try {
    const plain = await runAndObserve(conn.client, { script: PLAIN_SCRIPT });
    assert.equal(structured(plain)?.status, "completed");
    assert.equal(seen[0]?.backends, undefined);
    const { runId, request } = await pendingSetup(conn.client, SCRIPT_WITH_BACKENDS.replace('return await agent("p", { model: "browser" });',
      'await agent("p", { model: "browser" }); await checkpoint("continue?"); return await agent("q", { model: "browser" });'));
    await conn.client.callTool({ name: "workflow", arguments: { action: "setup-response", runId, setupId: request.id, response: { action: "accept", content: { approve: true } } } });
    const paused = await waitForRun(conn.client, runId);
    const checkpoint = (structured(paused)?.outcome as { checkpointContext: { callIndex: number } }).checkpointContext;
    const continued = await conn.client.callTool({ name: "workflow", arguments: { action: "resume", runId,
      checkpointReplies: { [checkpoint.callIndex]: true } } });
    assert.equal(continued.isError, false, textOf(continued));
    const completed = await waitForRun(conn.client, runId);
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    assert.equal(structured(completed)?.setup, undefined);
    assert.deepEqual(seen[2]?.backends, seen[1]?.backends);
    assert.ok(seen[2]?.backends?.browser);
  } finally { await conn.dispose(); }
});
