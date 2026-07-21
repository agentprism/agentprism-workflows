import assert from "node:assert/strict";
import test from "node:test";

import { connect, countingRunner, makeRunner, okRunner, structured, textOf } from "./_harness.js";

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
    assert.equal(field(completed?.resumeReport, "strategy"), "identity-v1");
    assert.equal(field(completed?.resumeReport, "replayed"), 1);
    assert.match(
      textOf(second),
      /^resume: identity-v1; predicted replayable prefix 1; replayed prefix 1; 1 replayed, 0 live, 0 failed$/m,
    );

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
    assert.equal(field(replayed?.resumeReport, "replayed"), 1);
  } finally {
    await dispose();
  }
});

test("checkpoint replies stay keyed to the source index when an inserted call shifts the checkpoint", async () => {
  const sourceScript = `export const meta = { name: 'shifted-checkpoint', description: 'source-index reply' }
await agent('stable', { label: 'stable', resume: { filesystem: 'read-only' } })
const decision = await checkpoint('Ship release?', { headless: 'pause', default: false })
return { decision }`;
  const shiftedScript = `export const meta = { name: 'shifted-checkpoint', description: 'source-index reply' }
await agent('inserted', { label: 'inserted', resume: { filesystem: 'read-only' } })
await agent('stable', { label: 'stable', resume: { filesystem: 'read-only' } })
const decision = await checkpoint('Ship release?', { headless: 'pause', default: false })
return { decision }`;
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const first = await client.callTool({ name: "workflow", arguments: { script: sourceScript } });
    const paused = structured(first);
    assert.equal(paused?.status, "paused");
    assert.equal(field(paused?.checkpointContext, "callIndex"), 1);
    assert.equal(calls(), 1);

    const second = await client.callTool({
      name: "workflow",
      arguments: {
        script: shiftedScript,
        resumeFromRunId: String(paused?.runId),
        checkpointReplies: { "1": true },
      },
    });
    const completed = structured(second);
    assert.equal(second.isError, false);
    assert.equal(completed?.status, "completed");
    assert.equal(field(completed?.result, "decision"), true);
    assert.equal(calls(), 2, "only the inserted agent runs live; the moved stable call replays");
    const reportCalls = field(completed?.resumeReport, "calls") as Array<Record<string, unknown>>;
    assert.deepEqual(reportCalls.map((call) => [call.index, call.action]), [
      [0, "live"],
      [1, "replayed"],
      [2, "replayed"],
    ]);
    assert.deepEqual(reportCalls[2], {
      index: 2,
      kind: "checkpoint",
      action: "replayed",
      sourceRunId: String(paused?.runId),
      recordedIndex: 1,
      match: "unique-hash",
      checkpointInjected: true,
    });
    assert.deepEqual(completed?.checkpointsTaken, [
      { callIndex: 2, kind: "confirm", decision: true, source: "injected" },
    ]);
  } finally {
    await dispose();
  }
});

test("terminal summary reports a supplied checkpoint reply that did not exactly target the live checkpoint", async () => {
  let sourceRoute = true;
  const runner = makeRunner(() => sourceRoute ? "source-route" : "diverged-route");
  const script = `export const meta = { name: 'unapplied-checkpoint-reply', description: 'reply diagnostics' }
const route = await agent('choose-route', { label: 'choose-route' })
if (route === 'source-route') {
  return await checkpoint('approve same text', { headless: 'pause', default: false })
}
return await checkpoint('approve same text', { headless: 'pause', default: false })`;
  const changedScript = script.replace("agent('choose-route'", "agent('choose-route-changed'");
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const first = await client.callTool({ name: "workflow", arguments: { script } });
    const paused = structured(first);
    assert.equal(paused?.status, "paused");
    const callIndex = Number(field(paused?.checkpointContext, "callIndex"));

    sourceRoute = false;
    const second = await client.callTool({
      name: "workflow",
      arguments: {
        script: changedScript,
        resumeFromRunId: String(paused?.runId),
        checkpointReplies: { [callIndex]: true },
      },
    });
    const resumed = structured(second);
    assert.equal(resumed?.status, "paused");
    const checkpointReply = field(resumed?.resumeReport, "checkpointReply");
    assert.equal(field(checkpointReply, "status"), "not-applied");
    assert.match(
      textOf(second),
      new RegExp(`checkpointReplies for call ${callIndex} was not applied: ` +
        "the checkpoint was not reached at its recorded call site after a live prefix"),
    );
  } finally {
    await dispose();
  }
});

test("a fresh MCP server resumes a checkpoint paused by a previous server instance", async () => {
  const pausingServer = await connect(okRunner(), { listTools: true });
  let pausedRunId = "";
  try {
    const first = await pausingServer.client.callTool({
      name: "workflow",
      arguments: { script: SCRIPT },
    });
    const paused = structured(first);
    assert.equal(first.isError, false);
    assert.equal(paused?.status, "paused");
    assert.equal(field(paused?.checkpointContext, "callIndex"), 0);
    pausedRunId = String(paused?.runId);
    assert.notEqual(pausedRunId, "");
  } finally {
    await pausingServer.dispose();
  }

  const resumingServer = await connect(okRunner(), { listTools: true });
  try {
    const second = await resumingServer.client.callTool({
      name: "workflow",
      arguments: {
        script: SCRIPT,
        resumeFromRunId: pausedRunId,
        checkpointReplies: { "0": "ship" },
      },
    });
    const completed = structured(second);
    assert.equal(second.isError, false);
    assert.equal(completed?.status, "completed");
    assert.equal(field(completed?.result, "decision"), "ship");
  } finally {
    await resumingServer.dispose();
  }
});
