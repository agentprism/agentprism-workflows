import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner, EngineRunEventPayloadMap } from "@automatalabs/shared-types";
import { RunEventLogError } from "../src/run-event-persistence.js";
import {
  createRunPersistence,
  type PersistedRunState,
  type RunPersistence,
} from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const script = (body: string, name = "manager-events") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: 'manager event persistence' }\n${body}`;

async function withPersistenceDirs(
  run: (dirs: { cwd: string; root: string }) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-manager-events-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "workflow-manager-events-root-"));
  try {
    await run({ cwd, root });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function legacyState(runId: string, source: string): PersistedRunState {
  const now = new Date().toISOString();
  return {
    runId,
    workflowName: "legacy-events",
    script: source,
    status: "paused",
    phases: [],
    agents: [],
    logs: [],
    startedAt: now,
    updatedAt: now,
  };
}

test("manager appends dense events before delivery and public emit stays live-only", async () => {
  await withPersistenceDirs(async ({ cwd, root }) => {
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: { async run() { return "done"; } },
    });
    let appendObservedBeforeDelivery = false;
    let hostOnlyLogs = 0;
    let initialWatermarkObserved = false;
    manager.once("phase", ({ runId }) => {
      const initial = manager.getPersistence().load(runId);
      initialWatermarkObserved = initial?.eventSeq === 0 && /^[0-9a-f]{32}$/.test(initial.eventStreamId ?? "");
    });
    manager.on("log", (payload) => {
      if (payload.message === "host-only") {
        hostOnlyLogs++;
        return;
      }
      if (payload.message !== "persisted") return;
      appendObservedBeforeDelivery = manager.getPersistence().readEvents(payload.runId).events.some(
        (record) => record.event.type === "log" && record.event.message === payload.message,
      );
    });
    manager.once("agentStart", (payload) => {
      manager.emit("log", { runId: payload.runId, scope: payload.scope, message: "host-only" });
    });

    const result = await manager.runSync(script(`phase('Build')\nlog('persisted')\nreturn await agent('work', { label: 'work' })`));
    const persisted = manager.getPersistence().load(result.runId);
    const events = manager.getPersistence().readEvents(result.runId, { limit: 1_000 });

    assert.equal(result.status, "completed");
    assert.match(persisted?.eventStreamId ?? "", /^[0-9a-f]{32}$/);
    assert.equal(persisted?.eventSeq, events.endCursor);
    assert.deepEqual(events.events.map((record) => record.seq), events.events.map((_, index) => index + 1));
    assert.ok(events.events.every((record) => record.streamId === persisted?.eventStreamId));
    assert.ok(events.events.every((record) => record.runId === result.runId));
    assert.ok(events.events.every((record) => record.event.runId === result.runId));
    assert.ok(events.events.every((record) => record.event.scope === result.runId));
    assert.equal(events.events.at(-1)?.event.type, "complete");
    assert.equal(
      events.events.some((record) => record.event.type === "log" && record.event.message === "host-only"),
      false,
    );
    assert.equal(appendObservedBeforeDelivery, true);
    assert.equal(initialWatermarkObserved, true);
    assert.equal(hostOnlyLogs, 1);
  });
});

test("nested workflow observations use the parent stream and child callback scope", async () => {
  await withPersistenceDirs(async ({ cwd, root }) => {
    const child = script(`phase('Child')\nlog('child-log')\nreturn await agent('child', { label: 'child' })`, "child");
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      loadSavedWorkflow: (name) => name === "child" ? child : undefined,
      agent: { async run() { return "child-result"; } },
    });
    const liveScopes: string[] = [];
    manager.on("phase", ({ scope }) => liveScopes.push(scope));
    manager.on("log", ({ scope }) => liveScopes.push(scope));
    manager.on("tokenUsage", ({ scope }) => liveScopes.push(scope));

    const result = await manager.runSync(script(`return await workflow('child')`, "parent"));
    const childRunId = `${result.runId}-nested1`;
    const persisted = manager.getPersistence().load(result.runId);
    const childEvents = manager.getPersistence().readEvents(result.runId, { limit: 1_000 }).events
      .filter((record) => record.event.scope === childRunId);
    const childTypes = new Set<string>(childEvents.map((record) => record.event.type));

    assert.ok(liveScopes.includes(childRunId));
    for (const type of ["phase", "log", "tokenUsage", "agentStart", "callRecord", "journal", "agentEnd"]) {
      assert.equal(childTypes.has(type), true, `missing child ${type}`);
    }
    assert.ok(childEvents.every((record) => record.runId === result.runId));
    assert.deepEqual(persisted?.journal, []);
    assert.deepEqual(persisted?.calls, []);
    assert.equal(existsSync(join(manager.getPersistence().getRunsDir(), `${childRunId}.events.jsonl`)), false);
  });
});

test("append failure marks the snapshot incomplete once without changing the outcome", async () => {
  await withPersistenceDirs(async ({ cwd, root }) => {
    let writes = 0;
    const persistence = createRunPersistence(
      cwd,
      {
        writeSync: ((..._args: Parameters<typeof writeSync>) => {
          writes++;
          const error = new Error("event disk full") as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        }) as typeof writeSync,
      },
      { persistenceRoot: root },
    );
    const manager = new WorkflowManager({ cwd, persistence, agent: { async run() { return "unused"; } } });
    const originalWarn = console.warn;
    let warnings = 0;
    let result;
    try {
      console.warn = () => { warnings++; };
      result = await manager.runSync(script(`log('survives')\nreturn 42`));
    } finally {
      console.warn = originalWarn;
    }

    const persisted = persistence.load(result.runId);
    assert.equal(result.status, "completed");
    assert.equal(result.result, 42);
    assert.equal(writes, 1);
    assert.equal(warnings, 1);
    assert.equal(persisted?.eventSeq, 0);
    assert.equal(persisted?.eventLogIncomplete, true);
    assert.throws(() => persistence.readEvents(result.runId), (error: unknown) =>
      error instanceof RunEventLogError && error.code === "EVENT_LOG_INCOMPLETE");
  });
});

test("manual pause settles live-only, and warm stop reacquires and revalidates the lease", async () => {
  await withPersistenceDirs(async ({ cwd, root }) => {
    const entered = deferred<void>();
    const runner: AgentRunner = {
      async run(_prompt, options) {
        entered.resolve();
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    };
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
    let liveErrors = 0;
    manager.on("error", () => liveErrors++);
    const background = manager.startInBackground(script(`return await agent('hold', { label: 'hold' })`));
    await entered.promise;

    assert.equal(manager.pause(background.runId), true);
    const paused = manager.getPersistence().load(background.runId);
    await assert.rejects(background.promise);
    assert.deepEqual(manager.getPersistence().load(background.runId), paused);
    assert.equal(liveErrors, 1);
    assert.equal(
      manager.getPersistence().readEvents(background.runId, { limit: 1_000 }).events.some(
        (record) => record.event.type === "error",
      ),
      false,
    );

    const competitor = createRunPersistence(cwd, undefined, { persistenceRoot: root });
    const competingLease = competitor.acquireRunLease(background.runId);
    assert.ok(competingLease);
    assert.equal(manager.stop(background.runId), false);
    assert.equal(manager.getPersistence().load(background.runId)?.status, "paused");
    competitor.releaseRunLease(competingLease);

    assert.equal(manager.stop(background.runId), true);
    const stopped = manager.getPersistence().load(background.runId);
    const records = manager.getPersistence().readEvents(background.runId, { limit: 1_000 });
    assert.equal(stopped?.status, "aborted");
    assert.equal(stopped?.eventStreamId, paused?.eventStreamId);
    assert.equal(stopped?.eventSeq, records.endCursor);
    assert.equal(records.events.at(-1)?.event.type, "stopped");
  });
});

test("automatic error persists without a listener and checkpoint gates republish paused", async () => {
  await withPersistenceDirs(async ({ cwd, root }) => {
    const failedManager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: { async run() { return "unused"; } },
    });
    const failed = await failedManager.runSync(script(`throw new Error('boom')`, "failed-events"));
    const failureRecords = failedManager.getPersistence().readEvents(failed.runId, { limit: 1_000 });
    const failure = failureRecords.events.at(-1)?.event;
    assert.equal(failed.status, "failed");
    assert.equal(failure?.type, "error");
    if (failure?.type !== "error") assert.fail("terminal error event was not persisted");
    assert.equal(failure.scope, failed.runId);
    assert.equal(failure.errorRecord.form, "workflow-error");

    const checkpointManager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: { async run() { return "unused"; } },
    });
    const checkpoint = await checkpointManager.runSync(
      script(`await checkpoint('approve', { headless: 'pause', kind: 'confirm' })`, "checkpoint-events"),
    );
    const before = checkpointManager.getPersistence().load(checkpoint.runId);
    assert.equal(checkpoint.status, "paused");
    assert.ok(before?.eventSeq);

    const cold = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: { async run() { return "unused"; } },
    });
    let eventVisibleBeforeGateSave = false;
    cold.on("paused", ({ runId }) => {
      const records = cold.getPersistence().readEvents(runId, { limit: 1_000 });
      eventVisibleBeforeGateSave = records.events.at(-1)?.event.type === "paused";
    });
    const gate = await cold.resumeInBackground(checkpoint.runId);
    assert.equal(gate.accepted, true);
    if (!gate.accepted) assert.fail("checkpoint gate should be accepted");
    await assert.rejects(gate.promise);

    const after = cold.getPersistence().load(checkpoint.runId);
    const records = cold.getPersistence().readEvents(checkpoint.runId, { limit: 1_000 });
    assert.equal(eventVisibleBeforeGateSave, true);
    assert.equal(after?.eventStreamId, before?.eventStreamId);
    assert.equal(after?.eventSeq, (before?.eventSeq ?? 0) + 1);
    assert.equal(after?.eventSeq, records.endCursor);
    assert.equal(records.events.at(-1)?.event.type, "paused");
    assert.equal(records.events.some((record) => record.event.type === "resumed"), false);
  });
});

test("resume replay republishes execution observations without cached journal events", async () => {
  await withPersistenceDirs(async ({ cwd, root }) => {
    let calls = 0;
    const runner: AgentRunner = {
      async run() {
        calls++;
        return "cached";
      },
    };
    const source = script(
      `const value = await agent('cached', { label: 'cached' })
const decision = await checkpoint('continue', { headless: 'pause' })
return { value, decision }`,
      "replay-events",
    );
    const first = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
    const paused = await first.runSync(source);
    assert.equal(paused.status, "paused");
    assert.ok(paused.checkpointContext);
    const before = first.getPersistence().load(paused.runId);
    assert.ok(before?.eventSeq);

    const second = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
    const resumed = await second.resumeInBackground(paused.runId, {
      checkpointReplies: { [paused.checkpointContext.callIndex]: "approved" },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("replay resume should be accepted");
    assert.equal((await resumed.promise).status, "completed");

    const suffix = second.getPersistence().readEvents(paused.runId, {
      after: before.eventSeq,
      limit: 1_000,
      streamId: before.eventStreamId,
    }).events.map((record) => record.event);
    const cached = suffix.filter((event) =>
      ((event.type === "agentStart" || event.type === "agentEnd") && event.callIndex === 0) ||
      (event.type === "callRecord" && event.record.index === 0));
    const checkpoint = suffix.filter((event) =>
      event.type === "callRecord" && event.record.kind === "checkpoint" && event.record.index === 1);

    assert.equal(suffix[0]?.type, "resumed");
    assert.deepEqual(cached.map((event) => event.type), ["agentStart", "callRecord", "agentEnd"]);
    assert.equal(cached[1]?.type === "callRecord" ? cached[1].record.origin : undefined, "journal-replay");
    assert.equal(checkpoint.length, 1);
    assert.equal(suffix.some((event) => event.type === "journal"), false);
    assert.equal(calls, 1);
  });
});

test("legacy resume upgrades under lease and begins a new event stream at resumed", async () => {
  await withPersistenceDirs(async ({ cwd, root }) => {
    const runId = "legacy-manager-events";
    const source = script(`return 'resumed'`, "legacy-events");
    const persistence = createRunPersistence(cwd, undefined, { persistenceRoot: root });
    const lease = persistence.acquireRunLease(runId);
    assert.ok(lease);
    persistence.save(legacyState(runId, source));
    persistence.releaseRunLease(lease);
    assert.throws(() => persistence.readEvents(runId), (error: unknown) =>
      error instanceof RunEventLogError && error.code === "EVENT_LOG_UNAVAILABLE");

    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: { async run() { return "unused"; } } });
    const resumed = await manager.resumeInBackground(runId);
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("legacy resume should be accepted");
    const result = await resumed.promise;
    const persisted = manager.getPersistence().load(runId);
    const records = manager.getPersistence().readEvents(runId, { limit: 1_000 });

    assert.equal(result.status, "completed");
    assert.match(persisted?.eventStreamId ?? "", /^[0-9a-f]{32}$/);
    assert.equal(records.events[0]?.seq, 1);
    assert.equal(records.events[0]?.event.type, "resumed");
    assert.equal(persisted?.eventSeq, records.endCursor);
  });
});

test("stale recovery reloads under lease and never saves the pre-lease listing copy", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "workflow-manager-recovery-"));
  try {
    const source = legacyState("stale-recovery", script(`return 1`));
    source.status = "running";
    let current = structuredClone(source);
    const saved: PersistedRunState[] = [];
    let releases = 0;
    const persistence: RunPersistence = {
      save(state) {
        saved.push(structuredClone(state));
        current = structuredClone(state);
      },
      load() {
        return structuredClone(current);
      },
      list() {
        return [structuredClone(source)];
      },
      delete() {
        return false;
      },
      acquireRunLease(runId) {
        current = { ...current, status: "completed", result: "won elsewhere" };
        return { runId, token: "recovery" };
      },
      releaseRunLease() {
        releases++;
      },
      getRunsDir() {
        return runsDir;
      },
    };

    new WorkflowManager({ persistence, agent: { async run() { return "unused"; } } });
    assert.deepEqual(saved, []);
    assert.equal(current.status, "completed");
    assert.equal(current.result, "won elsewhere");
    assert.equal(releases, 1);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("deleting a running managed run prevents every later callback from recreating files", async () => {
  await withPersistenceDirs(async ({ cwd, root }) => {
    const entered = deferred<void>();
    const outcome = deferred<unknown>();
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: {
        async run() {
          entered.resolve();
          return await outcome.promise as never;
        },
      },
    });
    const background = manager.startInBackground(script(`return await agent('hold', { label: 'hold' })`));
    await entered.promise;
    const eventPath = join(manager.getPersistence().getRunsDir(), `${background.runId}.events.jsonl`);
    assert.equal(existsSync(eventPath), true);

    assert.equal(manager.deleteRun(background.runId), true);
    outcome.resolve("late-result");
    assert.equal((await background.promise).status, "completed");
    assert.equal(manager.getPersistence().load(background.runId), null);
    assert.equal(existsSync(eventPath), false);
  });
});

test("typed EventEmitter methods retain arbitrary-event fallbacks", () => {
  const manager = new WorkflowManager({ journaling: false, agent: { async run() { return "unused"; } } });
  const logListener = (payload: EngineRunEventPayloadMap["log"]) => {
    assert.equal(payload.message, "typed");
  };
  manager.addListener("log", logListener);
  manager.once("log", logListener);
  manager.off("log", logListener);
  manager.on("custom-event", (...args: unknown[]) => assert.deepEqual(args, [1, "two"]));
  assert.equal(manager.emit("custom-event", 1, "two"), true);
  manager.removeListener("log", logListener);
});
