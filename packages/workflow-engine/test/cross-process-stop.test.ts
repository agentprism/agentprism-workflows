import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowManager } from "../src/workflow-manager.js";

const SCRIPT = [
  'export const meta = { name: "lease-stop", description: "lease stop" };',
  'return await agent("block");',
].join("\n");

function controlledRunner() {
  let resolve!: (value: string) => void;
  let markStarted!: () => void;
  const ready = new Promise<void>((resolveReady) => {
    markStarted = resolveReady;
  });
  const result = new Promise<string>((resolveResult) => {
    resolve = resolveResult;
  });
  return {
    ready,
    resolve,
    runner: {
      async run() {
        markStarted();
        return result;
      },
    },
  };
}

test("lease owner identity is observable and a second manager cannot cold-stop a live owner", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-live-owner-stop-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "agentprism-live-owner-store-"));
  const controlled = controlledRunner();
  const owner = new WorkflowManager({ cwd, persistenceRoot, leaseOwnerId: "owner-generation-a", agent: controlled.runner });
  const observer = new WorkflowManager({ cwd, persistenceRoot, leaseOwnerId: "owner-generation-b" });
  try {
    const started = owner.startInBackground(SCRIPT, undefined, { runId: "live-owner" });
    await controlled.ready;

    const leaseOwner = observer.getPersistence().inspectRunLease?.(started.runId);
    assert.deepEqual(leaseOwner && { pid: leaseOwner.pid, ownerId: leaseOwner.ownerId }, {
      pid: process.pid,
      ownerId: "owner-generation-a",
    });

    const refused = observer.stopPersistedRun(started.runId);
    assert.equal(refused.outcome, "owned-elsewhere");
    assert.equal(observer.getPersistence().load(started.runId)?.status, "running");

    assert.equal(owner.stop(started.runId), true);
    controlled.resolve("cleanup");
    await started.promise.catch(() => undefined);
  } finally {
    controlled.resolve("cleanup");
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

test("a manager cold-stops a lease-free paused run and appends one durable stopped event", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-cold-stop-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "agentprism-cold-stop-store-"));
  const controlled = controlledRunner();
  const owner = new WorkflowManager({ cwd, persistenceRoot, leaseOwnerId: "owner-generation-a", agent: controlled.runner });
  try {
    const started = owner.startInBackground(SCRIPT, undefined, { runId: "cold-stop" });
    await controlled.ready;
    assert.equal(owner.pause(started.runId), true);

    const fresh = new WorkflowManager({ cwd, persistenceRoot, leaseOwnerId: "owner-generation-b" });
    const stopped = fresh.stopPersistedRun(started.runId);
    assert.equal(stopped.outcome, "stopped");
    const state = fresh.getPersistence().load(started.runId);
    assert.equal(state?.status, "aborted");
    const events = fresh.getPersistence().readEvents(started.runId, { streamId: state?.eventStreamId });
    assert.equal(events.events.filter((record) => record.event.type === "stopped").length, 1);

    const retry = fresh.stopPersistedRun(started.runId);
    assert.equal(retry.outcome, "already-terminal");
    const afterRetry = fresh.getPersistence().readEvents(started.runId, { streamId: state?.eventStreamId });
    assert.equal(afterRetry.events.filter((record) => record.event.type === "stopped").length, 1);
    controlled.resolve("cleanup");
    await started.promise.catch(() => undefined);
  } finally {
    controlled.resolve("cleanup");
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
