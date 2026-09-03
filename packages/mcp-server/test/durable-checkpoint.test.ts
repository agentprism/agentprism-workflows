import assert from "node:assert/strict";
import test from "node:test";

import { connect, okRunner, structured, textOf } from "./_harness.js";

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const SCRIPT = `export const meta = { name: "durable-checkpoint", description: "first answer wins" };
const decision = await checkpoint("Choose deployment", {
  headless: "pause",
  kind: "select",
  choices: ["ship", "hold"],
  default: "hold"
});
return { decision };`;

test("the first strict checkpoint answer is durable and continues the same runId", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: SCRIPT },
    });
    const paused = structured(first);
    assert.equal(first.isError, false);
    assert.equal(paused?.status, "paused");
    const runId = String(paused?.runId);
    assert.equal(field(paused?.checkpointContext, "callIndex"), 0);

    const resumed = await client.callTool({
      name: "workflow",
      arguments: {
        action: "resume",
        runId,
        checkpointReplies: { "0": "ship" },
      },
    });
    const completed = structured(resumed);
    assert.equal(resumed.isError, false);
    assert.equal(completed?.runId, runId);
    assert.equal(completed?.status, "completed");
    assert.equal(field(completed?.result, "decision"), "ship");
    const checkpoints = completed?.checkpointsTaken as unknown[];
    assert.equal(field(checkpoints?.[0], "callIndex"), 0);
    assert.equal(field(checkpoints?.[0], "decision"), "ship");
    assert.equal(field(checkpoints?.[0], "source"), "injected");
  } finally {
    await dispose();
  }
});

test("same answers are idempotent and conflicting later answers are ignored forever", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: SCRIPT },
    });
    const runId = String(structured(first)?.runId);
    await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": "ship" } },
    });

    const same = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": "ship" } },
    });
    assert.equal(same.isError, false);
    assert.match(textOf(same), /checkpoint 0: same; durable decision="ship"/);

    const conflict = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": "hold" } },
    });
    assert.equal(conflict.isError, false);
    assert.match(textOf(conflict), /checkpoint 0: different; durable decision="ship"; ignored="hold"/);

    const status = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    });
    assert.equal(field(structured(status)?.outcome, "result") && field(field(structured(status)?.outcome, "result"), "decision"), "ship");
  } finally {
    await dispose();
  }
});

test("cold continuation reconstructs the durable checkpoint decision", async () => {
  const first = await connect(okRunner(), { listTools: true });
  let runId = "";
  try {
    const paused = await first.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: SCRIPT },
    });
    runId = String(structured(paused)?.runId);
  } finally {
    await first.dispose();
  }

  const second = await connect(okRunner(), { listTools: true });
  try {
    const resumed = await second.client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": "hold" } },
    });
    assert.equal(resumed.isError, false);
    assert.equal(structured(resumed)?.runId, runId);
    assert.equal(field(structured(resumed)?.result, "decision"), "hold");
  } finally {
    await second.dispose();
  }
});
