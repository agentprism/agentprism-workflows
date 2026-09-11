import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RunOptions } from "@automatalabs/shared-types";
import { WorkflowManager } from "@automatalabs/workflows";

import { createWorkflowServer, WORKFLOW_PAUSE_SETTLE_WAIT_MS } from "../src/index.js";

import { makeRunner, persistedRunFile, structured, textOf, type ToolCallResult } from "./_harness.js";

const TWO_AGENT_SCRIPT = [
  'export const meta = { model: "claude", name: "pause-loop", description: "pause and resume" };',
  'const first = await agent("first", { label: "first" });',
  'const second = await agent("second", { label: "second" });',
  "return { first, second };",
].join("\n");

class ControlledRunner {
  readonly calls: Array<{ prompt: string; options: RunOptions; resolve: (value: unknown) => void }> = [];
  readonly runner = makeRunner(
    (prompt, options) =>
      new Promise((resolve, reject) => {
        this.calls.push({ prompt, options, resolve });
        options.signal?.addEventListener("abort", () => reject(new Error("agent cancelled")), { once: true });
      }),
  );
}

async function connectWithManager(
  runner: ReturnType<typeof makeRunner>,
  manager: WorkflowManager,
): Promise<{ client: Client; dispose: () => Promise<void> }> {
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pause-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    dispose: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function runIdOf(result: ToolCallResult): string {
  const runId = structured(result)?.runId;
  assert.equal(typeof runId, "string");
  return runId;
}

test("pause lets the executing agent finish and journal, refuses the next one, and resume replays the prefix", async () => {
  const controlled = new ControlledRunner();
  const manager = new WorkflowManager({ agent: controlled.runner });
  const { client, dispose } = await connectWithManager(controlled.runner, manager);
  try {
    const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", script: TWO_AGENT_SCRIPT } });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 1, "the first agent should start");

    // The request is delivered while the first agent executes; the tool waits for it to finish.
    const pausing = client.callTool({ name: "workflow", arguments: { action: "pause", runId, lastN: 5, logLines: 0 } });
    await waitUntil(() => manager.pausePending(runId), "the pause request should reach the live run");
    assert.equal(controlled.calls.length, 1, "nothing new starts once a pause is pending");
    controlled.calls[0].resolve("first result");
    const paused = await pausing;
    assert.equal(paused.isError, false, textOf(paused));
    assert.equal(structured(paused)?.status, "paused");
    assert.equal(structured(paused)?.pauseRequested, true);
    assert.equal(structured(paused)?.paused, true);
    assert.equal(structured(paused)?.reason, "requested");
    assert.match(textOf(paused), /Pause is durably complete/);
    assert.equal(controlled.calls.length, 1, "the second agent never started");

    const persistedFile = persistedRunFile(runId);
    assert.ok(persistedFile);
    const persisted = JSON.parse(readFileSync(persistedFile, "utf8")) as {
      status: string; pauseReason?: string; journal?: Array<{ index: number }>; calls?: Array<{ index: number; outcome: string }>;
    };
    assert.equal(persisted.status, "paused");
    assert.equal(persisted.pauseReason, "requested");
    assert.deepEqual(persisted.journal?.map((entry) => entry.index), [0], "the executing agent journaled before the pause settled");
    assert.deepEqual(persisted.calls?.map((call) => [call.index, call.outcome]), [[0, "result"]]);
    const events = readFileSync(persistedFile.replace(/\.json$/, ".events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { event: { type: string; reason?: string } });
    assert.ok(events.some((record) => record.event.type === "paused" && record.event.reason === "requested"));

    // A repeated pause is a no-op observation, not an error.
    const again = await client.callTool({ name: "workflow", arguments: { action: "pause", runId } });
    assert.equal(again.isError, false, textOf(again));
    assert.equal(structured(again)?.pauseRequested, false);
    assert.equal(structured(again)?.paused, true);
    assert.match(textOf(again), /already paused/);

    const resumed = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(resumed.isError, false, textOf(resumed));
    assert.equal(structured(resumed)?.accepted, true);
    await waitUntil(() => controlled.calls.length === 2, "the second agent runs live after resume");
    assert.equal(controlled.calls[1].prompt, "second");
    controlled.calls[1].resolve("second result");
    await waitUntil(() => manager.getRun(runId)?.status === "completed", "the resumed run completes");
    const status = await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(status)?.status, "completed");
    assert.equal(JSON.stringify(structured(status)?.outcome?.result), JSON.stringify({ first: "first result", second: "second result" }));

    const terminal = await client.callTool({ name: "workflow", arguments: { action: "pause", runId } });
    assert.equal(terminal.isError, true);
    assert.match(textOf(terminal), /already terminal \(completed\)/);
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("a pause whose executing agent outlasts the settle wait answers running with the request pending", async () => {
  const controlled = new ControlledRunner();
  const manager = new WorkflowManager({ agent: controlled.runner });
  const { client, dispose } = await connectWithManager(controlled.runner, manager);
  try {
    const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", script: TWO_AGENT_SCRIPT } });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 1, "the first agent should start");

    const startedAt = Date.now();
    const pending = await client.callTool({ name: "workflow", arguments: { action: "pause", runId } });
    assert.ok(Date.now() - startedAt >= WORKFLOW_PAUSE_SETTLE_WAIT_MS - 50, "the tool waited for the settle window");
    assert.equal(pending.isError, false, textOf(pending));
    assert.equal(structured(pending)?.status, "running");
    assert.equal(structured(pending)?.pauseRequested, true);
    assert.equal(structured(pending)?.paused, false);
    assert.match(textOf(pending), /Pause requested/);
    assert.equal(manager.pausePending(runId), true);

    controlled.calls[0].resolve("first result");
    await waitUntil(() => manager.getRun(runId)?.status === "paused", "the pause settles once the agent finishes");
    const status = await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(status)?.status, "paused");
    assert.equal(structured(status)?.reason, "requested");
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("a stopped run resumes from its journal and re-runs the interrupted agent", async () => {
  const controlled = new ControlledRunner();
  const manager = new WorkflowManager({ agent: controlled.runner });
  const { client, dispose } = await connectWithManager(controlled.runner, manager);
  try {
    const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", script: TWO_AGENT_SCRIPT } });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 1, "the first agent should start");
    controlled.calls[0].resolve("first result");
    await waitUntil(() => controlled.calls.length === 2, "the second agent should start");

    const stopped = await client.callTool({ name: "workflow", arguments: { action: "stop", runId } });
    assert.equal(stopped.isError, false, textOf(stopped));
    assert.equal(structured(stopped)?.status, "aborted");
    assert.match(textOf(stopped), /a new resume action is safe immediately/);

    const pauseAborted = await client.callTool({ name: "workflow", arguments: { action: "pause", runId } });
    assert.equal(pauseAborted.isError, true);
    assert.match(textOf(pauseAborted), /already terminal \(aborted\).*Resume it/);

    const resumed = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(resumed.isError, false, textOf(resumed));
    assert.equal(structured(resumed)?.accepted, true);
    assert.equal(structured(resumed)?.status, "running");
    await waitUntil(() => controlled.calls.length === 3, "the interrupted agent runs again live");
    assert.equal(controlled.calls[2].prompt, "second");
    controlled.calls[2].resolve("second result");
    await waitUntil(() => manager.getRun(runId)?.status === "completed", "the resumed run completes");
    const status = await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(status)?.status, "completed");
    assert.equal(JSON.stringify(structured(status)?.outcome?.result), JSON.stringify({ first: "first result", second: "second result" }));
    const persisted = JSON.parse(readFileSync(persistedRunFile(runId)!, "utf8")) as { abortSignaled?: boolean };
    assert.equal(persisted.abortSignaled, undefined, "the stop marker does not outlive the continuation");
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("pause rejects unknown runs and runs still waiting for setup", async () => {
  const controlled = new ControlledRunner();
  const manager = new WorkflowManager({ agent: controlled.runner });
  const { client, dispose } = await connectWithManager(controlled.runner, manager);
  try {
    const unknown = await client.callTool({ name: "workflow", arguments: { action: "pause", runId: "missing-run" } });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /No workflow run found/);

    const extra = await client.callTool({ name: "workflow", arguments: { action: "pause", runId: "missing-run", callIndex: 0 } });
    assert.equal(extra.isError, true, "pause takes no callIndex");
  } finally {
    await dispose();
  }
});
