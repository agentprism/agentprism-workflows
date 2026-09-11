import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "@automatalabs/shared-types";
import { createRunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { WorkflowErrorCode } from "../src/errors.js";
import {
  MAX_WORKFLOW_PREPARATION_BYTES,
  MAX_WORKFLOW_SETUP_RESPONSES,
  mergeWorkflowSetupResponses,
  type WorkflowPreparation,
} from "../src/workflow-preparation.js";

const script = (body: string) => `export const meta = { name: 'Prepared workflow', description: 'Durable setup', model: 'fixture' }\n${body}`;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const preparing = (data: Record<string, unknown> = {}): WorkflowPreparation => ({ format: 1, state: "preparing", data });
const runner: AgentRunner = { async run() { return "unused"; } };

async function inStore(fn: (paths: { cwd: string; persistenceRoot: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workflow-preparation-"));
  try {
    await fn({ cwd: root, persistenceRoot: join(root, "storage") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a parked run persists frozen source, args, and setup with empty events before any live execution", async () => {
  await inStore(async (paths) => {
    let liveCalls = 0;
    const manager = new WorkflowManager({ ...paths, agent: { async run(prompt) { liveCalls++; return prompt; } } });
    const args = { message: "accepted" };
    const metadata = { stage: "validation" };
    const source = script(`return await agent(args.message, { model: 'fixture' })`);
    const parked = manager.prepareRun(source, args, { preparation: preparing(metadata) });
    args.message = "changed after acceptance";
    metadata.stage = "changed after acceptance";
    assert.match(parked.runId, /^[a-z0-9]+-[a-z0-9]+$/, "parked runs use engine-generated identities");
    assert.equal(liveCalls, 0);
    assert.equal(manager.activeExecutionCount(), 1);
    const stored = manager.getPersistence().load(parked.runId)!;
    assert.equal(stored.status, "pending");
    assert.equal(stored.script, source);
    assert.deepEqual(stored.args, { message: "accepted" });
    assert.equal(stored.preparation?.data.stage, "validation");
    assert.equal(stored.preparationRevision, 0);
    assert.equal(stored.admission, undefined);
    assert.deepEqual(manager.getPersistence().readEvents(parked.runId).events, []);
    assert.equal(manager.inspectRun(parked.runId)?.status, "pending");
    assert.equal(manager.inspectRun(parked.runId)?.runId, parked.runId, "public redaction must preserve the opaque run ID");

    const started = manager.admitPreparedRun(parked.runId, {
      requireAgentConfiguration: true,
    });
    const result = await started.promise;
    assert.equal(started.runId, parked.runId);
    assert.equal(result.result, "accepted");
    assert.equal(liveCalls, 1);
    const completed = manager.getPersistence().load(parked.runId)!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.admission?.format, 3);
    assert.equal(completed.preparation, undefined);
    assert.equal(manager.activeExecutionCount(), 0);
  });
});

test("every parked run owns a distinct identity; a second manager cannot claim a live owner's run", async () => {
  await inStore(async (paths) => {
    const first = new WorkflowManager({ ...paths, agent: runner });
    const second = new WorkflowManager({ ...paths, agent: runner });
    const source = script("return 1");
    const one = first.prepareRun(source, undefined, { preparation: preparing() });
    const two = first.prepareRun(source, undefined, { preparation: preparing() });
    assert.notEqual(one.runId, two.runId, "identical inputs never collapse into one run");
    assert.equal(second.claimPreparedRun(one.runId), undefined, "a live lease is never stolen");
    assert.equal(first.getPersistence().list().length, 2);
    assert.equal(first.stop(one.runId), true);
    assert.equal(first.stop(two.runId), true);
  });
});

test("pending setup survives cold restore and old owner cannot overwrite the claimed revision", async () => {
  await inStore(async (paths) => {
    const first = new WorkflowManager({ ...paths, agent: runner });
    const parked = first.prepareRun(script("return 7"), undefined, {
      preparation: { format: 1, state: "input-required", data: { requestId: "setup-one", question: "Choose" } },
    });
    const oldLease = first.getRun(parked.runId)!.lease!;
    first.getPersistence().releaseRunLease(oldLease);
    const cold = new WorkflowManager({ ...paths, agent: runner });
    assert.equal(cold.inspectRun(parked.runId)?.status, "pending");
    const restored = cold.claimPreparedRun(parked.runId)!;
    assert.equal(restored.preparation?.state, "input-required");
    assert.equal(restored.preparation?.data.question, "Choose");
    assert.equal(cold.activeExecutionCount(), 1);
    assert.throws(() => first.updatePreparation(parked.runId, preparing({ corrupted: true })), /not owned pending/);
    cold.updatePreparation(parked.runId, preparing({ approved: true }), 0);
    assert.throws(() => cold.updatePreparation(parked.runId, preparing(), 0), /preparation changed/);
    const result = await cold.admitPreparedRun(parked.runId, {
      requireAgentConfiguration: true,
    }).promise;
    assert.equal(result.result, 7);
  });
});

test("response receipts survive admission, settlement and cold reads; conflicts never replace answers", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    for (const terminal of ["completed", "aborted"] as const) {
      const parked = manager.prepareRun(script("return 8"), undefined, { preparation: preparing() });
      const receipt = fingerprint("approved");
      manager.updatePreparation(parked.runId, { ...preparing(), responses: { "setup-one": receipt } }, 0);
      assert.throws(() => manager.updatePreparation(parked.runId, {
        ...preparing(), responses: { "setup-one": fingerprint("declined") },
      }, 1), /response conflict/);
      manager.updatePreparation(parked.runId, preparing({ next: true }), 1);
      if (terminal === "completed") {
        await manager.admitPreparedRun(parked.runId, { requireAgentConfiguration: true }).promise;
      } else {
        manager.settlePreparedRun(parked.runId, "aborted", "User declined setup");
      }
      const cold = new WorkflowManager({ ...paths, agent: runner });
      assert.equal(cold.getPersistence().load(parked.runId)?.setupResponses?.["setup-one"], receipt);
      assert.equal(cold.inspectRun(parked.runId)?.status, terminal);
    }
  });
});

test("initial save and canonical-admission save failures cannot acknowledge or execute unpersisted work", async () => {
  await inStore(async (paths) => {
    const disk = createRunPersistence(paths.cwd, undefined, { persistenceRoot: paths.persistenceRoot });
    let reject: "initial" | "admission" | undefined = "initial";
    let calls = 0;
    const manager = new WorkflowManager({
      ...paths,
      agent: { async run() { calls++; return "done"; } },
      persistence: {
        ...disk,
        save(state) {
          if (reject === "initial" || (reject === "admission" && state.status === "running")) throw new Error("disk unavailable");
          disk.save(state);
        },
      },
    });
    const source = script("return await agent('work', { model: 'fixture' })");
    assert.throws(() => manager.prepareRun(source, undefined, { preparation: preparing() }), /failed to persist/);
    assert.equal(manager.activeExecutionCount(), 0);
    assert.equal(disk.list().length, 0, "a failed initial save leaves no run behind");
    reject = undefined;
    const parked = manager.prepareRun(source, undefined, { preparation: preparing() });
    reject = "admission";
    assert.throws(() => manager.admitPreparedRun(parked.runId, {
      requireAgentConfiguration: true,
    }), /failed to persist/);
    assert.equal(manager.getRun(parked.runId)?.status, "pending");
    assert.equal(disk.load(parked.runId)?.status, "pending");
    assert.equal(disk.load(parked.runId)?.admission, undefined);
    assert.equal(calls, 0);
    reject = undefined;
    assert.equal(manager.settlePreparedRun(parked.runId, "failed", "Canonical admission could not be persisted"), true);
    assert.equal(disk.load(parked.runId)?.status, "failed");
    assert.equal(disk.readEvents(parked.runId).events.at(-1)?.event.type, "error");
  });
});

test("terminal setup responses and abort state commit atomically and failed saves remain retryable", async () => {
  await inStore(async (paths) => {
    const disk = createRunPersistence(paths.cwd, undefined, { persistenceRoot: paths.persistenceRoot });
    let rejectTerminal = true;
    const committed: Array<{ status: string; receipt?: string }> = [];
    const manager = new WorkflowManager({ ...paths, agent: runner, persistence: {
      ...disk,
      save(state) {
        if (rejectTerminal && state.status === "aborted") throw new Error("terminal disk unavailable");
        disk.save(state);
        committed.push({ status: state.status, receipt: state.setupResponses?.["setup-one"] });
      },
    } });
    const parked = manager.prepareRun(script("return 1"), undefined, {
      preparation: { format: 1, state: "input-required", data: { question: "Approve?" } },
    });
    const receipt = fingerprint("declined");
    const response = { responses: { "setup-one": receipt }, expectedRevision: 0 };
    assert.throws(() => manager.settlePreparedRun(parked.runId, "aborted", "Declined", response), /failed to persist/);
    const pending = disk.load(parked.runId)!;
    assert.equal(pending.status, "pending");
    assert.equal(pending.preparation?.state, "input-required");
    assert.equal(pending.setupResponses?.["setup-one"], undefined);
    assert.equal(manager.getRun(parked.runId)?.setupResponses?.["setup-one"], undefined);
    assert.equal(manager.getRun(parked.runId)?.controller.signal.aborted, false);
    assert.equal(disk.readEvents(parked.runId).events.length, 0);

    assert.throws(() => manager.settlePreparedRun(parked.runId, "aborted", "Stale", {
      ...response, expectedRevision: 1,
    }), /preparation changed/);
    rejectTerminal = false;
    assert.equal(manager.settlePreparedRun(parked.runId, "aborted", "Declined", response), true);
    const cold = new WorkflowManager({ ...paths, agent: runner });
    const terminal = cold.getPersistence().load(parked.runId)!;
    assert.equal(terminal.status, "aborted");
    assert.equal(terminal.setupResponses?.["setup-one"], receipt);
    assert.ok(committed.every(state => state.receipt === undefined || state.status === "aborted"));
    assert.equal(disk.readEvents(parked.runId).events.filter(row => row.event.type === "stopped").length, 1);
    assert.equal(cold.claimPreparedRun(parked.runId), undefined);
  });
});

test("invalid parked source becomes inspectable failed setup; a stopped parked run cannot be revived", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const invalid = manager.prepareRun("this is not workflow JavaScript", undefined, { preparation: preparing() });
    assert.equal(manager.getPersistence().load(invalid.runId)?.status, "pending");
    assert.throws(() => manager.admitPreparedRun(invalid.runId, { requireAgentConfiguration: true }));
    assert.equal(manager.settlePreparedRun(invalid.runId, "failed", "Workflow static validation failed"), true);
    assert.match(manager.inspectRun(invalid.runId)?.reason ?? "", /static validation failed/);
    assert.equal(manager.deleteRun(invalid.runId), true);
    assert.equal(manager.getPersistence().load(invalid.runId), null);

    const pending = manager.prepareRun(script("return 9"), undefined, { preparation: preparing() });
    assert.equal(manager.stop(pending.runId), true);
    assert.equal(manager.getPersistence().load(pending.runId)?.status, "aborted");
    assert.equal(manager.getPersistence().readEvents(pending.runId).events.at(-1)?.event.type, "stopped");
    assert.throws(() => manager.updatePreparation(pending.runId, preparing()), /not owned pending/);
    assert.throws(() => manager.admitPreparedRun(pending.runId, { requireAgentConfiguration: true }), /not owned pending/);
  });
});

test("an explicit checkpoint reply commits with its continuation; repeats are reported, never re-applied", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const parked = manager.prepareRun(script("const a = await checkpoint('First'); const b = await checkpoint('Second'); return [a,b]"), undefined, {
      preparation: preparing(),
    });
    await assert.rejects(manager.admitPreparedRun(parked.runId, { requireAgentConfiguration: true }).promise,
      (error: unknown) => (error as { code?: string }).code === WorkflowErrorCode.CHECKPOINT_REQUIRED);
    const first = await manager.continueRun(parked.runId, { checkpointReplies: { 0: true } });
    assert.equal(first.accepted, true);
    if (!first.accepted) assert.fail("first reply should be accepted");
    assert.equal(first.continuation.generation, 1);
    await assert.rejects(first.promise, /Second/);
    const paused = manager.getPersistence().load(parked.runId)!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.checkpointContext?.callIndex, 1);
    assert.equal(paused.journal?.find((entry) => entry.index === 0)?.checkpointDecision, "explicit-v1");
    assert.equal(paused.calls?.find((entry) => entry.index === 0)?.checkpointDecision, "explicit-v1");

    const cold = new WorkflowManager({ ...paths, agent: runner });
    const repeated = await cold.continueRun(parked.runId, { checkpointReplies: { 0: true } });
    assert.equal(repeated.accepted, false, "an already-durable answer cannot advance the later checkpoint");
    if (repeated.accepted) assert.fail("unreachable");
    assert.equal(repeated.reason, "checkpoint-required");
    assert.deepEqual(repeated.resolvedCheckpoints, [{ callIndex: 0, outcome: "same", decision: true }]);
    assert.equal(cold.getRun(parked.runId), undefined);
    assert.equal(cold.getPersistence().load(parked.runId)?.continuation?.generation, 1);
    const conflicting = await cold.continueRun(parked.runId, { checkpointReplies: { 0: false } });
    assert.equal(conflicting.accepted, false, "a different late answer is reported against the durable first answer");
    if (conflicting.accepted) assert.fail("unreachable");
    assert.deepEqual(conflicting.resolvedCheckpoints, [{ callIndex: 0, outcome: "different", decision: true, ignored: false }]);

    const second = await cold.continueRun(parked.runId, { checkpointReplies: { 1: false } });
    if (!second.accepted) assert.fail("new explicit answer should continue");
    assert.deepEqual(Array.from((await second.promise).result as boolean[]), [true, false]);
    assert.equal(cold.getPersistence().load(parked.runId)?.continuation?.generation, 2);
    const late = await manager.continueRun(parked.runId, { checkpointReplies: { 0: true } });
    assert.equal(late.accepted, false);
    if (late.accepted) assert.fail("unreachable");
    assert.equal(late.reason, "terminal");
  });
});

test("failed continuation save preserves the unanswered checkpoint and the same answer can be retried", async () => {
  await inStore(async (paths) => {
    const disk = createRunPersistence(paths.cwd, undefined, { persistenceRoot: paths.persistenceRoot });
    let denyContinuation = false;
    const manager = new WorkflowManager({ ...paths, agent: runner, persistence: {
      ...disk,
      save(state) {
        if (denyContinuation && state.continuation) throw new Error("continuation save failed");
        disk.save(state);
      },
    } });
    const parked = manager.prepareRun(script("return await checkpoint('Confirm')"), undefined, { preparation: preparing() });
    await assert.rejects(manager.admitPreparedRun(parked.runId, { requireAgentConfiguration: true }).promise);
    denyContinuation = true;
    await assert.rejects(manager.continueRun(parked.runId, { checkpointReplies: { 0: true } }), /failed to persist/);
    assert.equal(disk.load(parked.runId)?.status, "paused");
    assert.equal(disk.load(parked.runId)?.continuation, undefined);
    assert.equal(disk.load(parked.runId)?.journal?.length, 0);
    denyContinuation = false;
    const retried = await manager.continueRun(parked.runId, { checkpointReplies: { 0: true } });
    if (!retried.accepted) assert.fail("a failed save must not consume the answer");
    assert.equal((await retried.promise).result, true);
  });
});

test("setup data and setup receipts have finite non-evicting limits", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    assert.throws(() => manager.prepareRun(script("return 1"), undefined, {
      preparation: preparing({ oversized: "x".repeat(MAX_WORKFLOW_PREPARATION_BYTES) }),
    }), /preparation exceeds/);
    const receipts = Object.fromEntries(Array.from({ length: MAX_WORKFLOW_SETUP_RESPONSES }, (_, index) => [`setup-${index}`, fingerprint(String(index))]));
    assert.equal(Object.keys(mergeWorkflowSetupResponses(undefined, receipts) ?? {}).length, MAX_WORKFLOW_SETUP_RESPONSES);
    assert.throws(() => mergeWorkflowSetupResponses(receipts, { overflow: fingerprint("overflow") }), /setup response limit/);
    assert.throws(() => mergeWorkflowSetupResponses(undefined, { "setup-1": "not-a-sha256" }), /lowercase SHA-256/);
  });
});
