// Same-ID continuation through consecutive checkpoints. A foreground run or resume that reaches a
// LATER checkpoint must elicit again (never silently take the authored default), and a retried
// resume input that already carries earlier answers must be accepted as an idempotent batch.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ElicitRequest } from "@modelcontextprotocol/client";

import { createWorkflowServer } from "../src/index.js";
import { connect, okRunner, structured, textOf } from "./_harness.js";

const TWO_CHECKPOINTS = `export const meta = { name: "two-checkpoints", description: "two consecutive gates" };
const first = await checkpoint("First?", { kind: "confirm", default: true, headless: "pause" });
const second = await checkpoint("Second?", { kind: "confirm", default: true, headless: "pause" });
return { first, second };`;

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

async function connectEliciting(approve: boolean) {
  const server = createWorkflowServer(okRunner());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "checkpoint-chain", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  const requests: ElicitRequest[] = [];
  client.setRequestHandler("elicitation/create", async (request) => {
    requests.push(request);
    return { action: "accept", content: { approve } };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

async function waitForPause(client: Client, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    if (structured(status)?.status === "paused") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`run ${runId} never paused`);
}

test("a foreground run elicits every consecutive checkpoint under one run id", async () => {
  const conn = await connectEliciting(false);
  try {
    const result = await conn.client.callTool({ name: "workflow", arguments: { action: "run", script: TWO_CHECKPOINTS } });
    assert.equal(result.isError, false, textOf(result));
    assert.equal(structured(result)?.status, "completed");
    assert.deepEqual(structuredClone(structured(result)?.result), { first: false, second: false });
    assert.equal(conn.requests.length, 2);
    assert.match(String(conn.requests[0]?.params.message), /First\?/);
    assert.match(String(conn.requests[1]?.params.message), /Second\?/);
    const taken = structured(result)?.checkpointsTaken as Array<Record<string, unknown>>;
    assert.deepEqual(taken.map((entry) => [entry.callIndex, entry.decision, entry.source]), [
      [0, false, "journal-replay"],
      [1, false, "injected"],
    ]);
  } finally {
    await conn.dispose();
  }
});

test("an explicit resume that answers one checkpoint elicits the next and its retry keeps the earlier answer", async () => {
  const conn = await connectEliciting(false);
  try {
    const admitted = await conn.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: TWO_CHECKPOINTS, background: true },
    });
    const runId = String(structured(admitted)?.runId);
    await waitForPause(conn.client, runId);

    const resumed = await conn.client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": false } },
    });
    assert.equal(resumed.isError, false, textOf(resumed));
    assert.equal(structured(resumed)?.runId, runId);
    assert.equal(structured(resumed)?.status, "completed");
    assert.deepEqual(structuredClone(structured(resumed)?.result), { first: false, second: false });
    assert.equal(conn.requests.length, 1);
    assert.match(String(conn.requests[0]?.params.message), /Second\?/);
  } finally {
    await conn.dispose();
  }
});

test("a form-capable resume with no reply elicits the pending checkpoint instead of refusing", async () => {
  const conn = await connectEliciting(true);
  try {
    const admitted = await conn.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: TWO_CHECKPOINTS, background: true },
    });
    const runId = String(structured(admitted)?.runId);
    await waitForPause(conn.client, runId);

    const resumed = await conn.client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(resumed.isError, false, textOf(resumed));
    assert.equal(structured(resumed)?.runId, runId);
    assert.equal(structured(resumed)?.status, "completed");
    assert.deepEqual(structuredClone(structured(resumed)?.result), { first: true, second: true });
    assert.equal(conn.requests.length, 2);
  } finally {
    await conn.dispose();
  }
});

test("a resume with no reply and no elicitation reports the pending checkpoint as an observation", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const admitted = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: TWO_CHECKPOINTS, background: true },
    });
    const runId = String(structured(admitted)?.runId);
    await waitForPause(client, runId);

    const resumed = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(resumed.isError, false, textOf(resumed));
    assert.equal(structured(resumed)?.status, "paused");
    assert.equal(field(field(structured(resumed)?.outcome, "checkpointContext"), "callIndex"), 0);
    assert.match(textOf(resumed), /not continued: checkpoint-required/);
    assert.match(textOf(resumed), /checkpointReplies=\{ "0": <decision> \}/);
  } finally {
    await dispose();
  }
});

test("a decision made before a restart replays on the cold instance and only the next checkpoint is asked", async () => {
  const first = await connect(okRunner(), { listTools: true });
  let runId = "";
  try {
    const admitted = await first.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: TWO_CHECKPOINTS, background: true },
    });
    runId = String(structured(admitted)?.runId);
    await waitForPause(first.client, runId);
    const answered = await first.client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": false } },
    });
    assert.equal(answered.isError, false, textOf(answered));
    assert.equal(structured(answered)?.status, "paused");
    assert.equal(field(structured(answered)?.checkpointContext, "callIndex"), 1);
  } finally {
    await first.dispose();
  }

  const second = await connect(okRunner(), { listTools: true });
  try {
    const finished = await second.client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "1": true } },
    });
    assert.equal(finished.isError, false, textOf(finished));
    assert.equal(structured(finished)?.runId, runId);
    assert.equal(structured(finished)?.status, "completed");
    assert.deepEqual(structuredClone(structured(finished)?.result), { first: false, second: true });
    const taken = structured(finished)?.checkpointsTaken as Array<Record<string, unknown>>;
    assert.deepEqual(taken.map((entry) => [entry.callIndex, entry.decision, entry.source]), [
      [0, false, "journal-replay"],
      [1, true, "injected"],
    ]);
  } finally {
    await second.dispose();
  }
});
