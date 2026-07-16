import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RunOptions } from "@automatalabs/shared-types";
import {
  WorkflowManager,
  type PersistedRunState,
  type RunPersistence,
} from "@automatalabs/workflows";

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

function faultablePersistence(root: string): {
  persistence: RunPersistence;
  load(runId: string): PersistedRunState | null;
  setSaveFailure(fail: boolean): void;
} {
  const records = new Map<string, PersistedRunState>();
  const leases = new Map<string, string>();
  let leaseSequence = 0;
  let failSave = false;
  const persistence: RunPersistence = {
    save(state) {
      if (failSave) throw new Error("injected terminal snapshot save failure");
      records.set(state.runId, structuredClone(state));
    },
    load(runId) {
      const state = records.get(runId);
      return state ? structuredClone(state) : null;
    },
    list: () => [...records.values()].map((state) => structuredClone(state)),
    delete: (runId) => records.delete(runId),
    acquireRunLease(runId) {
      if (leases.has(runId)) return null;
      const token = `${runId}-${leaseSequence++}`;
      leases.set(runId, token);
      return { runId, token };
    },
    releaseRunLease(lease) {
      if (leases.get(lease.runId) === lease.token) leases.delete(lease.runId);
    },
    getRunsDir: () => root,
  };
  return {
    persistence,
    load: (runId) => persistence.load(runId),
    setSaveFailure(fail) {
      failSave = fail;
    },
  };
}

async function connectWithManager(
  runner: ReturnType<typeof makeRunner>,
  manager: WorkflowManager,
): Promise<{ client: Client; server: ReturnType<typeof createWorkflowServer> }> {
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stop-fault-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
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
    'const first = await agent("first", { label: "first", resume: { filesystem: "read-only" } });',
    'const second = await agent("second", { label: "second", resume: { filesystem: "read-only" } });',
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
      arguments: { scriptPath, resumeFromRunId: runId, resumePolicy: "positional" },
    });
    await waitUntil(() => controlled.calls.length === 3, "the stopped source should fail live safely");
    assert.equal(controlled.calls[2].prompt, "first");
    controlled.calls[2].resolve("first rerun");
    await waitUntil(() => controlled.calls.length === 4, "the patched call should run after the live prefix");
    assert.equal(controlled.calls[3].prompt, "second patched");
    controlled.calls[3].resolve("patched result");
    const resumed = await resumedPromise;
    const resumedRunId = runIdOf(resumed);
    assert.equal(structured(resumed)?.status, "completed", JSON.stringify(structured(resumed)));
    assert.equal(
      JSON.stringify(structured(resumed)?.result),
      JSON.stringify({ first: "first rerun", second: "patched result" }),
    );
    const resumeReport = structured(resumed)?.resumeReport as Record<string, unknown>;
    assert.equal(resumeReport.replayed, 0);
    assert.equal(resumeReport.live, 2);
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

test("four stopped background runs immediately free every registry slot", async () => {
  const pending: Array<(value: string) => void> = [];
  let calls = 0;
  const runner = makeRunner(
    () =>
      new Promise<string>((resolve) => {
        calls++;
        pending.push(resolve);
      }),
  );
  const { client, dispose } = await connect(runner);
  const script = [
    'export const meta = { name: "registry-stop", description: "slot eviction" };',
    'return await agent("block until cleanup");',
  ].join("\n");
  try {
    const runIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const accepted = await client.callTool({
        name: "workflow",
        arguments: { script, background: true },
      });
      assert.equal(accepted.isError, false);
      runIds.push(runIdOf(accepted));
    }
    await waitUntil(() => calls === 4, "all four background calls should occupy the registry");

    for (const runId of runIds) {
      const stopped = await client.callTool({ name: "workflow", arguments: { action: "stop", runId } });
      assert.equal(structured(stopped)?.status, "aborted");
      assert.equal(structured(stopped)?.stopped, true);
    }

    const fifth = await client.callTool({
      name: "workflow",
      arguments: { script, background: true },
    });
    assert.equal(fifth.isError, false);
    assert.equal(structured(fifth)?.status, "running");
    await waitUntil(() => calls === 5, "the fifth run should start before stopped backends wind down");
  } finally {
    for (const resolve of pending) resolve("cleanup");
    await dispose();
  }
});

test("stop refuses a final acknowledgement when the terminal snapshot save fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-stop-save-fault-"));
  const store = faultablePersistence(root);
  const controlled = new AbortAwareRunner();
  const manager = new WorkflowManager({ cwd: root, agent: controlled.runner, persistence: store.persistence });
  const first = await connectWithManager(controlled.runner, manager);
  let fresh: Awaited<ReturnType<typeof connectWithManager>> | undefined;
  try {
    const accepted = await first.client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "stop-save-fault", description: "fault" };',
          'return await agent("block");',
        ].join("\n"),
        background: true,
      },
    });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 1, "the background runner should start");
    store.setSaveFailure(true);

    const stopped = await first.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId },
    });
    assert.equal(stopped.isError, true);
    assert.equal(stopped.structuredContent, undefined);
    assert.match(textOf(stopped), /could not be durably acknowledged/i);
    assert.match(textOf(stopped), /persisted status is running/i);
    assert.equal(store.load(runId)?.status, "running");

    store.setSaveFailure(false);
    await first.client.close();
    await first.server.close();
    const freshRunner = okRunner();
    const freshManager = new WorkflowManager({ cwd: root, agent: freshRunner, persistence: store.persistence });
    fresh = await connectWithManager(freshRunner, freshManager);
    const inspected = await fresh.client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId },
    });
    assert.equal(structured(inspected)?.status, "paused");
    const coldStop = await fresh.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId },
    });
    assert.equal(coldStop.isError, true);
    assert.match(textOf(coldStop), /nothing live to stop in this server process/i);
  } finally {
    store.setSaveFailure(false);
    for (const call of controlled.calls) call.resolve("cleanup");
    await first.client.close().catch(() => {});
    await first.server.close().catch(() => {});
    await fresh?.client.close().catch(() => {});
    await fresh?.server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop refuses a final acknowledgement when the stopped event append fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-stop-event-fault-"));
  const store = faultablePersistence(root);
  const controlled = new AbortAwareRunner();
  const manager = new WorkflowManager({ cwd: root, agent: controlled.runner, persistence: store.persistence });
  const eventPersistence = manager.getPersistence();
  const appendEvent = eventPersistence.appendEvent.bind(eventPersistence);
  eventPersistence.appendEvent = (runId, input) => {
    if (input.event.type === "stopped") throw new Error("injected stopped event append failure");
    return appendEvent(runId, input);
  };
  const first = await connectWithManager(controlled.runner, manager);
  let fresh: Awaited<ReturnType<typeof connectWithManager>> | undefined;
  try {
    const accepted = await first.client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "stop-event-fault", description: "fault" };',
          'return await agent("block");',
        ].join("\n"),
        background: true,
      },
    });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 1, "the background runner should start");

    const stopped = await first.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId },
    });
    assert.equal(stopped.isError, true);
    assert.equal(stopped.structuredContent, undefined);
    assert.match(textOf(stopped), /could not be durably acknowledged/i);
    assert.match(textOf(stopped), /stopped event is not durably readable/i);
    assert.equal(store.load(runId)?.status, "aborted");
    assert.equal(store.load(runId)?.eventLogIncomplete, true);

    await first.client.close();
    await first.server.close();
    const freshRunner = okRunner();
    const freshManager = new WorkflowManager({ cwd: root, agent: freshRunner, persistence: store.persistence });
    fresh = await connectWithManager(freshRunner, freshManager);
    const coldStop = await fresh.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId },
    });
    assert.equal(coldStop.isError, false);
    assert.equal(structured(coldStop)?.status, "aborted");
    assert.equal(structured(coldStop)?.stopped, false);
    assert.equal(structured(coldStop)?.alreadyTerminal, true);
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await first.client.close().catch(() => {});
    await first.server.close().catch(() => {});
    await fresh?.client.close().catch(() => {});
    await fresh?.server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
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
