import assert from "node:assert/strict";
import test from "node:test";

import { connect, okRunner, structured, textOf } from "./_harness.js";

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const SCRIPT = `export const meta = { name: 'durable-mcp-checkpoint', description: 'durable MCP checkpoint' }
const decision = await checkpoint('Choose deployment', {
  headless: 'pause',
  kind: 'select',
  choices: ['ship', 'hold'],
  default: 'hold'
})
return { decision }`;

test("non-elicitation client receives checkpointContext and resumes with checkpointReplies", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const first = await client.callTool({ name: "workflow", arguments: { script: SCRIPT } });
    const paused = structured(first);
    assert.equal(first.isError, false);
    assert.equal(paused?.status, "paused");

    const context = paused?.checkpointContext;
    assert.equal(field(context, "callIndex"), 0);
    assert.match(String(field(context, "hash")), /^[a-f0-9]{64}$/);
    assert.equal(field(context, "prompt"), "Choose deployment");
    assert.equal(field(context, "kind"), "select");
    assert.deepEqual(Array.from((field(context, "choices") as string[] | undefined) ?? []), ["ship", "hold"]);
    assert.equal(field(context, "default"), "hold");
    assert.match(textOf(first), /checkpointReplies/);

    const runId = String(paused?.runId);
    const second = await client.callTool({
      name: "workflow",
      arguments: {
        script: SCRIPT,
        resumeFromRunId: runId,
        checkpointReplies: { "0": "ship" },
      },
    });
    const completed = structured(second);
    assert.equal(second.isError, false);
    assert.equal(completed?.status, "completed");
    assert.equal(field(completed?.result, "decision"), "ship");

    // The resumed call has its own run id. Its final persisted journal must retain the
    // synthetic checkpoint reply, so another cold replay needs neither replies nor elicitation.
    const third = await client.callTool({
      name: "workflow",
      arguments: { script: SCRIPT, resumeFromRunId: String(completed?.runId) },
    });
    const replayed = structured(third);
    assert.equal(third.isError, false);
    assert.equal(replayed?.status, "completed");
    assert.equal(field(replayed?.result, "decision"), "ship");
  } finally {
    await dispose();
  }
});
