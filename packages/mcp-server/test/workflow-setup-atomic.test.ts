import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowManager } from "@automatalabs/workflows";
import { ActiveRunRegistry } from "../src/project-registry.js";
import { WorkflowLifecycle, workflowSetup } from "../src/workflow-lifecycle.js";
import { makeRunner } from "./_harness.js";

const cancellations = [
  { action: "decline" },
  { action: "cancel" },
  { action: "accept", content: { approve: false } },
] as const;

for (const response of cancellations) {
  test(`setup ${JSON.stringify(response)} stays retryable after a terminal write failure and cancels cold`, async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-setup-atomic-"));
    const paths = { cwd: root, persistenceRoot: join(root, "storage") };
    let liveCalls = 0;
    const runner = makeRunner(() => { liveCalls++; return "must not run"; });
    const disk = new WorkflowManager({ ...paths, agent: runner }).getPersistence();
    let rejectTerminal = true;
    const manager = new WorkflowManager({ ...paths, agent: runner, persistence: {
      ...disk,
      save(state) {
        if (rejectTerminal && state.status === "aborted") throw new Error("terminal disk unavailable");
        disk.save(state);
      },
    } });
    const activeRuns = new ActiveRunRegistry();
    const lifecycle = new WorkflowLifecycle({ projectDir: root, manager, activeRuns }, runner);
    try {
      const accepted = await lifecycle.prepare({
        action: "run", script: 'export const meta = { name: "setup-cancel", description: "atomic decision", backends: { custom: { command: "custom-acp" } } }; return await agent("must not run", { model: "custom" });',
      });
      let setup = workflowSetup(disk.load(accepted.runId));
      for (let count = 0; count < 100 && setup?.state !== "input-required"; count++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        setup = workflowSetup(disk.load(accepted.runId));
      }
      assert.equal(setup?.state, "input-required");
      if (setup?.state !== "input-required") assert.fail("expected backend approval");
      const request = { action: "setup-response" as const, runId: accepted.runId, setupId: setup.request.id, response };
      assert.throws(() => lifecycle.respond(request), /failed to persist/);
      const pending = disk.load(accepted.runId)!;
      assert.equal(pending.status, "pending");
      assert.equal(pending.setupResponses?.[request.setupId], undefined);
      assert.deepEqual(workflowSetup(pending), setup);
      assert.equal(activeRuns.activeCount(), 1);
      assert.equal(liveCalls, 0);

      // Releasing the failed owner's lease models a real cold process recovery.
      disk.releaseRunLease(manager.getRun(accepted.runId)!.lease!);
      rejectTerminal = false;
      const coldManager = new WorkflowManager({ ...paths, agent: runner });
      const coldRuns = new ActiveRunRegistry();
      const cold = new WorkflowLifecycle({ projectDir: root, manager: coldManager, activeRuns: coldRuns }, runner);
      cold.respond(request);
      cold.respond(request);
      cold.recover(accepted.runId);
      await new Promise(resolve => setImmediate(resolve));
      const aborted = disk.load(accepted.runId)!;
      assert.equal(aborted.status, "aborted");
      assert.equal(typeof aborted.setupResponses?.[request.setupId], "string");
      assert.equal(workflowSetup(aborted), undefined);
      assert.equal(coldRuns.activeCount(), 0);
      assert.equal(liveCalls, 0);
      assert.equal(disk.readEvents(accepted.runId).events.filter(row => row.event.type === "stopped").length, 1);
      assert.throws(() => cold.respond({ ...request, response: { action: "accept", content: { approve: true } } }), /Conflicting response/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("cold setup approval cannot bypass four reserved runs and can retry after a cancellation frees capacity", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-setup-capacity-"));
  const paths = { cwd: root, persistenceRoot: join(root, "storage") };
  const runner = makeRunner(() => { throw new Error("no agent dispatch expected"); });
  const firstManager = new WorkflowManager({ ...paths, agent: runner });
  const first = new WorkflowLifecycle({ projectDir: root, manager: firstManager, activeRuns: new ActiveRunRegistry() }, runner);
  const input = () => ({ action: "run" as const, script: 'export const meta = { name: "capacity", description: "pending approval", backends: { custom: { command: "custom-acp" } } }; return 42;' });
  const waitForSetup = async (manager: WorkflowManager, runId: string) => {
    for (let count = 0; count < 100; count++) {
      const setup = workflowSetup(manager.getPersistence().load(runId));
      if (setup?.state === "input-required") return setup.request;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("expected pending setup");
  };
  try {
    const original = await first.prepare(input());
    const originalSetup = await waitForSetup(firstManager, original.runId);
    firstManager.getPersistence().releaseRunLease(firstManager.getRun(original.runId)!.lease!);
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const activeRuns = new ActiveRunRegistry();
    const lifecycle = new WorkflowLifecycle({ projectDir: root, manager, activeRuns }, runner);
    const activeIds: string[] = [];
    for (let count = 0; count < 4; count++) activeIds.push((await lifecycle.prepare(input())).runId);
    const activeSetups = await Promise.all(activeIds.map(runId => waitForSetup(manager, runId)));
    const response = { action: "setup-response" as const, runId: original.runId, setupId: originalSetup.id,
      response: { action: "accept" as const, content: { approve: true } } };
    assert.equal(activeRuns.activeCount(), 4);
    assert.equal(manager.activeExecutionCount(), 4);
    assert.throws(() => lifecycle.respond(response), /available active-run slot/);
    assert.equal(manager.activeExecutionCount(), 4);
    assert.equal(activeRuns.activeCount(), 4);
    const pending = manager.getPersistence().load(original.runId)!;
    assert.equal(pending.setupResponses?.[originalSetup.id], undefined);
    assert.deepEqual(workflowSetup(pending), { state: "input-required", request: originalSetup });

    lifecycle.respond({ action: "setup-response", runId: activeIds[0], setupId: activeSetups[0].id, response: { action: "cancel" } });
    assert.equal(activeRuns.activeCount(), 3);
    lifecycle.respond(response);
    assert.equal(activeRuns.activeCount(), 4);
    for (let count = 0; count < 100 && manager.getPersistence().load(original.runId)?.status !== "completed"; count++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(manager.getPersistence().load(original.runId)?.status, "completed");
    assert.equal(activeRuns.activeCount(), 3);
    lifecycle.respond(response);
    assert.equal(activeRuns.activeCount(), 3, "acknowledgement retries never reserve capacity");
    for (const runId of activeIds.slice(1)) manager.stop(runId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
