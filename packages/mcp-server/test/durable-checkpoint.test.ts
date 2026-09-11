import assert from "node:assert/strict";
import test from "node:test";

import { connect, okRunner, structured, textOf, waitForRun } from "./_harness.js";

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const SCRIPT = `export const meta = { name: "durable-checkpoint", description: "first answer wins" };
const decision = await checkpoint("Choose deployment", {
  kind: "select",
  choices: ["ship", "hold"],
});
return { decision };`;

test("the first strict checkpoint answer is durable and continues the same runId", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: SCRIPT },
    });
    assert.equal(structured(first)?.accepted, true);
    const paused = structured(await waitForRun(client, String(structured(first)?.runId)));
    assert.equal(first.isError, false);
    assert.equal(paused?.status, "paused");
    const runId = String(paused?.runId);
    assert.equal(field(field(paused?.outcome, "checkpointContext"), "callIndex"), 0);

    const resumed = await client.callTool({
      name: "workflow",
      arguments: {
        action: "resume", runId,
        checkpointReplies: { "0": "ship" },
      },
    });
    assert.equal(structured(resumed)?.accepted, true);
    const completed = structured(await waitForRun(client, runId, status => status.status === "completed"));
    assert.equal(resumed.isError, false);
    assert.equal(completed?.runId, runId);
    assert.equal(completed?.status, "completed");
    assert.equal(field(field(completed?.outcome, "result"), "decision"), "ship");
    const checkpoints = field(completed?.outcome, "checkpointsTaken") as unknown[];
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
    await waitForRun(client, runId);
    await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": "ship" } },
    });

    await waitForRun(client, runId, status => status.status === "completed");
    const same = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": "ship" } },
    });
    assert.equal(same.isError, false);
    assert.match(textOf(same), /"outcome":"same","decision":"ship"/);

    const conflict = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId, checkpointReplies: { "0": "hold" } },
    });
    assert.equal(conflict.isError, false);
    assert.match(textOf(conflict), /"outcome":"different","decision":"ship","ignored":"hold"/);

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
    await waitForRun(first.client, runId);
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
    const finished = structured(await waitForRun(second.client, runId, status => status.status === "completed"));
    assert.equal(field(field(finished?.outcome, "result"), "decision"), "hold");
  } finally {
    await second.dispose();
  }
});
