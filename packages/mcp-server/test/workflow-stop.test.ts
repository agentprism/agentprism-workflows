import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RunOptions } from "@automatalabs/shared-types";

import { createWorkflowServer } from "../src/index.js";

import {
  connect,
  makeRunner,
  NO_AGENT_SCRIPT,
  okRunner,
  persistedRunFile,
  structured,
  textOf,
  type ToolCallResult,
} from "./_harness.js";

class AbortAwareRunner {
  readonly calls: Array<{
    prompt: string;
    options: RunOptions;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  readonly runner = makeRunner(
    (prompt, options) =>
      new Promise((resolve, reject) => {
        const call = { prompt, options, resolve, reject };
        this.calls.push(call);
        options.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("agent cancelled by workflow stop");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
  );
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
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

function links(result: ToolCallResult): Array<Record<string, unknown>> {
  return (result.content as Array<Record<string, unknown>>).filter((block) => block.type === "resource_link");
}

test("stop durably aborts a background run, publishes stopped, retains its resource, and supports kill-patch-resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentprism-mcp-stop-loop-"));
  const scriptPath = join(dir, "stop-loop.workflow.js");
  const original = [
    'export const meta = { name: "stop-loop", description: "stop and resume" };',
    'const first = await agent("first", { label: "first" });',
    'const second = await agent("second", { label: "second" });',
    "return { first, second };",
  ].join("\n");
  writeFileSync(scriptPath, original, "utf8");
  const controlled = new AbortAwareRunner();
  const { client, dispose } = await connect(controlled.runner);
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { scriptPath, background: true },
    });
    const runId = runIdOf(accepted);
    assert.deepEqual(links(accepted).map((link) => link.uri), [`workflow://runs/${runId}/script`]);
    await waitUntil(() => controlled.calls.length === 1, "the first agent should start");
    controlled.calls[0].resolve("first result");
    await waitUntil(() => controlled.calls.length === 2, "the second agent should start");

    const stopped = await client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId, lastN: 1, logLines: 0 },
    });
    assert.equal(stopped.isError, false);
    assert.equal(structured(stopped)?.status, "aborted");
    assert.equal(structured(stopped)?.stopped, true);
    assert.equal(structured(stopped)?.alreadyTerminal, false);
    assert.equal(controlled.calls[1].options.signal?.aborted, true);
    assert.match(textOf(stopped), /snapshot is final for run fate/i);
    assert.match(textOf(stopped), /Agent-session cancellation may still be winding down/i);
    assert.deepEqual(links(stopped).map((link) => link.uri), [`workflow://runs/${runId}/script`]);

    const persistedFile = persistedRunFile(runId);
    assert.ok(persistedFile);
    const persisted = JSON.parse(readFileSync(persistedFile, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.status, "aborted");
    assert.equal(persisted.script, original);
    const eventFile = persistedFile.replace(/\.json$/, ".events.jsonl");
    assert.ok(
      readFileSync(eventFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: { type?: string } })
        .some((record) => record.event?.type === "stopped"),
      "the durable event log should contain stopped",
    );
    const resource = await client.readResource({ uri: `workflow://runs/${runId}/script` });
    assert.equal(resource.contents[0] && "text" in resource.contents[0] ? resource.contents[0].text : undefined, original);

    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 25_000, lastN: 1, logLines: 0 },
    });
    assert.equal(structured(awaited)?.status, "aborted");
    assert.equal((structured(awaited)?.wait as Record<string, unknown>).returnedBecause, "terminal");
    assert.deepEqual(
      (structured(awaited)?.lineage as Array<Record<string, unknown>>).map((entry) => entry.runId),
      [runId],
    );

    const changed = original.replace('agent("second"', 'agent("second patched"');
    writeFileSync(scriptPath, changed, "utf8");
    const resumedPromise = client.callTool({
      name: "workflow",
      arguments: { scriptPath, resumeFromRunId: runId },
    });
    await waitUntil(() => controlled.calls.length === 3, "only the patched suffix should run live");
    assert.equal(controlled.calls[2].prompt, "second patched");
    controlled.calls[2].resolve("patched result");
    const resumed = await resumedPromise;
    const resumedRunId = runIdOf(resumed);
    assert.equal(structured(resumed)?.status, "completed");
    assert.equal(
      JSON.stringify(structured(resumed)?.result),
      JSON.stringify({ first: "first result", second: "patched result" }),
    );
    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: resumedRunId },
    });
    assert.deepEqual(
      (structured(inspected)?.lineage as Array<Record<string, unknown>>).map((entry) => entry.runId),
      [runId, resumedRunId],
    );
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop is retry-safe for terminal runs and disambiguates unknown and persisted-but-not-live runs", async () => {
  const firstConnection = await connect(okRunner());
  let completedRunId: string;
  try {
    const completed = await firstConnection.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT },
    });
    completedRunId = runIdOf(completed);
    const repeated = await firstConnection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId: completedRunId },
    });
    assert.equal(repeated.isError, false);
    assert.equal(structured(repeated)?.status, "completed");
    assert.equal(structured(repeated)?.stopped, false);
    assert.equal(structured(repeated)?.alreadyTerminal, true);

    const unknown = await firstConnection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId: "missing-run" },
    });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /No workflow run found/);
  } finally {
    await firstConnection.dispose();
  }

  const file = persistedRunFile(completedRunId!);
  assert.ok(file);
  const stale = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  stale.status = "running";
  delete stale.completedAt;
  writeFileSync(file, JSON.stringify(stale), "utf8");

  const secondConnection = await connect(okRunner());
  try {
    const notLive = await secondConnection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId: completedRunId! },
    });
    assert.equal(notLive.isError, true);
    assert.match(textOf(notLive), /persisted as paused/);
    assert.match(textOf(notLive), /nothing live to stop in this server process/);
    assert.match(textOf(notLive), /resumeFromRunId/);
  } finally {
    await secondConnection.dispose();
  }
});

test("stop clears durable checkpoint context on a paused live run", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const paused = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "paused-stop", description: "paused stop" };',
          'return await checkpoint("approve", { headless: "pause" });',
        ].join("\n"),
      },
    });
    const runId = runIdOf(paused);
    assert.equal(structured(paused)?.status, "paused");
    assert.ok(structured(paused)?.checkpointContext);

    const stopped = await client.callTool({ name: "workflow", arguments: { action: "stop", runId } });
    assert.equal(structured(stopped)?.status, "aborted");
    const file = persistedRunFile(runId);
    assert.ok(file);
    const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.pauseReason, undefined);
    assert.equal(persisted.authContext, undefined);
    assert.equal(persisted.checkpointContext, undefined);
  } finally {
    await dispose();
  }
});

test("stop cancels an in-flight foreground checkpoint elicitation", async () => {
  const server = createWorkflowServer(okRunner());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "stop-elicitation-client", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  let elicitationStarted = false;
  let elicitationCancelled = false;
  client.setRequestHandler(ElicitRequestSchema, (_request, extra) => {
    elicitationStarted = true;
    return new Promise((resolve) => {
      extra.signal.addEventListener(
        "abort",
        () => {
          elicitationCancelled = true;
          resolve({ action: "cancel" });
        },
        { once: true },
      );
    });
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const foreground = client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "elicitation-stop", description: "stop a prompt" };',
          'return await checkpoint("approve this", { headless: "pause" });',
        ].join("\n"),
      },
    });
    await waitUntil(() => elicitationStarted, "the client should receive the checkpoint elicitation");
    const listed = await client.listResources();
    const resource = listed.resources.find((candidate) => candidate.name.startsWith("elicitation-stop ("));
    assert.ok(resource);
    const runId = resource.uri.split("/").at(-2);
    assert.ok(runId);

    const stopped = await client.callTool({ name: "workflow", arguments: { action: "stop", runId } });
    assert.equal(structured(stopped)?.status, "aborted");
    await waitUntil(() => elicitationCancelled, "stop should cancel the pending MCP elicitation request");
    const foregroundResult = await foreground;
    assert.equal(structured(foregroundResult)?.status, "aborted");
  } finally {
    await client.close();
    await server.close();
  }
});
