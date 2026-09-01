import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
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
  options: Pick<NonNullable<Parameters<typeof createWorkflowServer>[1]>, "runControl"> = {},
): Promise<{ client: Client; server: ReturnType<typeof createWorkflowServer> }> {
  const server = createWorkflowServer(runner, { manager, ...options });
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

test("whole-run stop exposes a durable pending operation when an external owner does not settle", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-stop-pending-"));
  const store = faultablePersistence(root);
  const controlled = new AbortAwareRunner();
  const owner = new WorkflowManager({ cwd: root, agent: controlled.runner, persistence: store.persistence });
  const started = owner.startInBackground(
    [
      'export const meta = { name: "pending-stop", description: "pending stop" };',
      'return await agent("block");',
    ].join("\n"),
    undefined,
    { runId: "pending-stop" },
  );
  await waitUntil(() => controlled.calls.length === 1, "the external owner run should start");
  const observer = new WorkflowManager({ cwd: root, agent: okRunner(), persistence: store.persistence });
  const connection = await connectWithManager(okRunner(), observer, {
    runControl: {
      async control() {
        return {
          kind: "whole",
          state: "pending",
          operationId: "00000000-0000-4000-8000-000000000000",
          requestedAt: "2026-08-28T00:00:00.000Z",
          owner: { pid: 4242, instanceId: "predecessor", version: "0.34.0", lameDuck: true },
        };
      },
    },
  });
  try {
    const result = await connection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId: started.runId },
    });
    assert.equal(result.isError, false);
    assert.equal(structured(result)?.status, "running");
    assert.equal(structured(result)?.stopped, false);
    assert.equal(structured(result)?.control?.state, "pending");
    assert.equal(structured(result)?.control?.operationId, "00000000-0000-4000-8000-000000000000");
    assert.match(textOf(result), /durably pending/);
    assert.equal(store.load(started.runId)?.status, "running", "pending acknowledgement never fabricates terminal fate");
  } finally {
    owner.stop(started.runId);
    for (const call of controlled.calls) call.resolve("cleanup");
    await started.promise.catch(() => undefined);
    await connection.client.close().catch(() => {});
    await connection.server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(links(accepted).map((link) => link.uri), [
      `workflow://runs/${runId}/script`,
      `workflow://runs/${runId}/events`,
    ]);
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
    assert.deepEqual(links(stopped).map((link) => link.uri), [
      `workflow://runs/${runId}/script`,
      `workflow://runs/${runId}/events`,
    ]);

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
      arguments: { action: "status", runId, waitMs: 25_000, lastN: 1, logLines: 0 },
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
      arguments: { action: "status", runId: resumedRunId },
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

test("stop with callIndex cancels one agent, keeps the run live, and treats labelGlob only as an output filter", async () => {
  const controlled = new AbortAwareRunner();
  const { client, dispose } = await connect(controlled.runner);
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "narrow-stop", description: "cancel one branch" };',
          "const values = await parallel([",
          '  () => agent("peer", { label: "peer", retries: 3 }),',
          '  () => agent("cancel", { label: "cancel", retries: 3 }),',
          "]);",
          "return { values };",
        ].join("\n"),
        background: true,
      },
    });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 2, "both parallel agents should start");

    const missed = await client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId, callIndex: 99 },
    });
    assert.equal(missed.isError, true);
    assert.equal(missed.structuredContent, undefined);
    assert.match(textOf(missed), /not currently in flight/i);
    assert.match(textOf(missed), /0 \("peer"/);
    assert.match(textOf(missed), /1 \("cancel"/);
    assert.equal(controlled.calls[0].options.signal?.aborted, false);
    assert.equal(controlled.calls[1].options.signal?.aborted, false);

    const cancelled = await client.callTool({
      name: "workflow",
      arguments: {
        action: "stop",
        runId,
        callIndex: 1,
        labelGlob: "peer",
        lastN: 5,
        logLines: 5,
      },
    });
    assert.equal(cancelled.isError, false, textOf(cancelled));
    assert.equal(structured(cancelled)?.status, "running");
    assert.equal(structured(cancelled)?.stopped, undefined);
    assert.equal(structured(cancelled)?.alreadyTerminal, undefined);
    assert.equal((structured(cancelled)?.filter as Record<string, unknown>).labelGlob, "peer");
    assert.deepEqual(
      (structured(cancelled)?.calls as Array<Record<string, unknown>>).map((call) => ({
        index: call.index,
        label: call.label,
        status: call.status,
      })),
      [{ index: 0, label: "peer", status: "running" }],
      "the output glob filters, but does not select, cancellation: the matching peer is live and visible, the cancelled call is filtered out",
    );
    assert.match(textOf(cancelled), /Agent call 1 \("cancel"\) settled with AGENT_CANCELLED/i);
    assert.match(textOf(cancelled), /run remains live/i);
    assert.equal(controlled.calls[0].options.signal?.aborted, false, "the peer remains untouched");
    assert.equal(controlled.calls[1].options.signal?.aborted, true, "only call index 1 is aborted");
    assert.equal(controlled.calls.length, 2, "host cancellation bypasses retries");

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, lastN: 5, logLines: 5 },
    });
    const cancelledCall = (structured(inspected)?.calls as Array<Record<string, unknown>>)
      .find((call) => call.index === 1);
    assert.equal(cancelledCall?.errorCode, "AGENT_CANCELLED");
    const persistedFile = persistedRunFile(runId);
    assert.ok(persistedFile);
    const persisted = JSON.parse(readFileSync(persistedFile, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.status, "running");
    assert.equal(persisted.abortSignaled, undefined);

    controlled.calls[0].resolve("peer-ok");
    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 25_000 },
    });
    assert.equal(structured(awaited)?.status, "completed");
    const outcome = structured(awaited)?.outcome as Record<string, unknown>;
    assert.equal(
      JSON.stringify(outcome.result),
      JSON.stringify({ values: ["peer-ok", null] }),
    );
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("stop with callIndex reports scoped ambiguity and leaves whole-run stop behavior available", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-cancel-ambiguity-"));
  const controlled = new AbortAwareRunner();
  const manager = new WorkflowManager({
    cwd: root,
    persistenceRoot: root,
    agent: controlled.runner,
    loadSavedWorkflow: (name) => name === "child"
      ? [
          'export const meta = { name: "cancel-child", description: "nested call" };',
          'return await agent("nested", { label: "nested" });',
        ].join("\n")
      : undefined,
  });
  const connection = await connectWithManager(controlled.runner, manager);
  try {
    const accepted = await connection.client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "cancel-ambiguity", description: "duplicate indexes" };',
          "return await parallel([",
          '  () => agent("root", { label: "root" }),',
          '  () => workflow("child"),',
          "]);",
        ].join("\n"),
        background: true,
      },
    });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 2, "root and nested index zero should start");

    const ambiguous = await connection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId, callIndex: 0 },
    });
    assert.equal(ambiguous.isError, true);
    assert.match(textOf(ambiguous), /ambiguous/i);
    assert.match(textOf(ambiguous), /"root"/);
    assert.match(textOf(ambiguous), /"nested"/);
    assert.equal(controlled.calls.every((call) => call.options.signal?.aborted === false), true);

    const wholeRun = await connection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId },
    });
    assert.equal(wholeRun.isError, false, textOf(wholeRun));
    assert.equal(structured(wholeRun)?.status, "aborted");
    assert.equal(structured(wholeRun)?.stopped, true);
    for (const call of controlled.calls) call.resolve("cleanup");
    await waitUntil(
      () => manager.getRun(runId)?.executionSettled === true,
      "the stopped nested execution should drain before its persistence root is removed",
    );
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await connection.client.close().catch(() => {});
    await connection.server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
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
      arguments: { action: "status", runId },
    });
    assert.equal(structured(inspected)?.status, "paused");
    const coldStop = await fresh.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId },
    });
    assert.equal(coldStop.isError, false);
    assert.equal(structured(coldStop)?.status, "aborted");
    assert.equal(structured(coldStop)?.stopped, true);
    assert.equal(structured(coldStop)?.alreadyTerminal, false);
    const coldState = freshManager.getPersistence().load(runId);
    const coldEvents = freshManager.getPersistence().readEvents(runId, { streamId: coldState?.eventStreamId });
    assert.equal(
      coldEvents.events.filter((record) => record.event.type === "stopped").length,
      1,
      "cold snapshot repair reuses the durable stopped event from the failed first acknowledgement",
    );
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

test("stop is retry-safe for terminal runs and cold-stops an orphaned persisted run under its lease", async () => {
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

    const terminalSelector = await firstConnection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId: completedRunId, callIndex: 0 },
    });
    assert.equal(terminalSelector.isError, true);
    assert.equal(terminalSelector.structuredContent, undefined);
    assert.match(textOf(terminalSelector), /already terminal \(completed\)/i);
    assert.match(textOf(terminalSelector), /without callIndex is a successful no-op/i);

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

  const secondConnection = await connect(okRunner());
  try {
    writeFileSync(file, JSON.stringify(stale), "utf8");
    const notLive = await secondConnection.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId: completedRunId! },
    });
    assert.equal(notLive.isError, false);
    assert.equal(structured(notLive)?.status, "aborted");
    assert.equal(structured(notLive)?.stopped, true);
    assert.equal(structured(notLive)?.alreadyTerminal, false);
    const reconciled = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(reconciled.status, "aborted");
    assert.equal(reconciled.pauseReason, undefined);
    assert.equal(reconciled.reason, undefined);
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
  client.setRequestHandler('elicitation/create', (_request, ctx) => {
    elicitationStarted = true;
    return new Promise((resolve) => {
      ctx.mcpReq.signal.addEventListener(
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
    const resource = listed.resources.find((candidate) => candidate.name.startsWith("elicitation-stop script ("));
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
