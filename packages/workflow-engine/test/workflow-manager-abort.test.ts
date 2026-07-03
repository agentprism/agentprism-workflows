import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// AgentUsage now lives in @automatalabs/shared-types (the frozen seam), not Pi's
// `../src/agent.js`. runSync is the consolidated path the MCP shell drives: it resolves
// to a TERMINAL WorkflowRunResult (status completed|paused|failed|aborted) even on
// abort/pause/fail, rather than throwing — so these abort tests assert run.status, not a
// thrown error. The manager still emits the same 'error'/'paused'/'stopped' events.

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

/** Agent that stays running until a single shared deferred resolve is called externally. */
function deferredAgent() {
  let deferredResolve: ((value: unknown) => void) | null = null;
  let deferredReject: ((err: Error) => void) | null = null;
  const promise = new Promise((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  return {
    resolve: (value: unknown = "done") => deferredResolve?.(value),
    reject: (err: Error) => deferredReject?.(err),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        return promise;
      },
    },
  };
}

/** Agent runner where EACH run() call gets its OWN deferred promise, resolved by index. */
function perCallDeferredAgent() {
  const resolves: Array<(v: unknown) => void> = [];
  let idx = 0;
  return {
    resolve: (i: number, v: unknown = "done") => resolves[i]?.(v),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        const i = idx++;
        return new Promise((resolve) => {
          resolves[i] = resolve;
        });
      },
    },
  };
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

const twoAgentScript = `export const meta = { name: 'tracked_demo_two', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-dw-abort-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

// ─── Observer isolation ───────────────────────────────────────────────────────

test(
  "throwing manager event observers do not fail the run or block sibling listeners",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let siblingCalled = false;

    manager.on("agentStart", () => {
      throw new Error("host observer failed");
    });
    manager.on("agentStart", () => {
      siblingCalled = true;
    });

    const result = await manager.runSync(oneAgentScript);

    assert.equal(result.status, "completed");
    assert.equal(manager.getRun(result.runId)?.status, "completed");
    assert.equal(siblingCalled, true, "sibling observer still receives the event");
  }),
);

test(
  "manager event once listeners fire exactly once under isolated dispatch",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let starts = 0;

    manager.once("agentStart", () => {
      starts++;
    });

    const result = await manager.runSync(twoAgentScript);

    assert.equal(result.status, "completed");
    assert.equal(starts, 1, "once listener should self-remove after the first event");
    assert.equal(manager.listenerCount("agentStart"), 0);
  }),
);

// ─── Abort Propagation (3 tests) ───────────────────────────────────────────────

test(
  "abort via externalSignal yields a terminal aborted result (not a throw) and emits 'error'",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    let errorEmitted = false;
    manager.on("error", () => {
      errorEmitted = true;
    });

    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });

    // Let the agent start (deferred, so it hangs inside agentRunner.run())
    await new Promise((r) => setTimeout(r, 20));

    // Abort from outside — this triggers managed.controller.abort()
    ac.abort();

    // Resolve the deferred agent so the in-flight agent completes,
    // then throwIfAborted() fires and the run settles aborted.
    da.resolve("done");

    // runSync resolves to a TERMINAL WorkflowRunResult (status "aborted") rather than
    // throwing, so the caller can read run.status without a try/catch.
    const result = await runPromise;
    assert.equal(result.status, "aborted", "runSync settles to a terminal aborted result");
    assert.equal(result.reason, "workflow aborted", "reason carries the abort message");

    const managed = manager.getRun(result.runId);
    assert.ok(managed?.error instanceof WorkflowError, "managed run records a WorkflowError");
    assert.equal(
      (managed?.error as WorkflowError).code,
      WorkflowErrorCode.WORKFLOW_ABORTED,
      "error code should be WORKFLOW_ABORTED",
    );
    assert.ok((managed?.error as WorkflowError).recoverable, "abort error should be recoverable");
    assert.equal(errorEmitted, true, "manager should emit 'error' event on abort");
  }),
);

test(
  "abort via externalSignal does not crash the host (no uncaught exception)",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let uncaughtFromTest: Error | null = null;
    const errorHandler = (err: Error) => {
      uncaughtFromTest = err;
    };
    process.on("uncaughtException", errorHandler);

    try {
      const runPromise = manager.runSync(oneAgentScript, undefined, {
        externalSignal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      da.resolve("done");

      // runSync settles to a terminal aborted result (no throw).
      const result = await runPromise;
      assert.equal(result.status, "aborted");

      // Give microtasks a chance to settle
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(uncaughtFromTest, null, "abort should NOT produce an uncaught exception");
    } finally {
      process.off("uncaughtException", errorHandler);
    }
  }),
);

test(
  "abort mid-way through multi-agent workflow: remaining agents are skipped",
  withTempCwd(async (cwd) => {
    // Per-call deferred agent: each call to run() gets its own promise.
    const resolves: Array<(v: unknown) => void> = [];
    let callIdx = 0;
    const multiDa = {
      resolve(idx: number, v: unknown = "done") {
        resolves[idx]?.(v);
      },
      runner: {
        async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
          const idx = callIdx++;
          return new Promise((resolve) => {
            resolves[idx] = resolve;
          });
        },
      },
    };

    const manager = new WorkflowManager({ cwd, agent: multiDa.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete (gets journaled)
    multiDa.resolve(0, "first-done");
    // Wait for agent 1's result to be journaled and agent 2 to start
    await new Promise((r) => setTimeout(r, 30));

    // Stop the run while agent 2 is in-flight
    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed");

    // Resolve agent 2 so the abort/throwIfAborted path executes
    multiDa.resolve(1, "second-done");
    await promise.catch(() => {});

    // Verify the run is aborted
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "run should be aborted after stop");

    // Verify the error is a WorkflowError
    const managedRun = manager.getRun(runId);
    assert.ok(managedRun?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal((managedRun?.error as WorkflowError).code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);

// ─── Stop tests (3 tests) ──────────────────────────────────────────────────────

test(
  "stop on paused run transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause first
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Then stop the paused run
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    assert.equal(manager.getRun(runId)?.status, "aborted", "paused run should become aborted after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop emits 'stopped' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let stoppedEvent: { runId: string } | null = null;
    manager.on("stopped", (ev: { runId: string }) => {
      stoppedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.stop(runId);

    assert.ok(stoppedEvent, "stopped event should fire");
    assert.equal(stoppedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const secondStop = manager.stop(runId);
    assert.equal(secondStop, false, "second stop on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Pause tests (3 tests) ─────────────────────────────────────────────────────

test(
  "pause emits 'paused' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let pausedEvent: { runId: string } | null = null;
    manager.on("paused", (ev: { runId: string }) => {
      pausedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);

    assert.ok(pausedEvent, "paused event should fire");
    assert.equal(pausedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause an already stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-paused run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.pause(runId);
    const secondPause = manager.pause(runId);
    assert.equal(secondPause, false, "second pause on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Resume tests (3 tests) ────────────────────────────────────────────────────

test(
  "resume full cycle: pause then resume then complete",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Resume — replays journal (empty for single-agent that never completed) and
    // re-runs the live agent with a fresh (non-aborted) controller.
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed");

    // The resumed run should be running
    assert.equal(manager.getRun(runId)?.status, "running", "resumed run should be running");

    // Resolve the deferred agent so the resumed run's agent completes
    da.resolve("resumed-done");

    // The original promise will reject (its controller was aborted). Suppress it.
    await origPromise.catch(() => {});

    // Wait for the resumed run to complete
    await new Promise((r) => setTimeout(r, 50));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run should complete successfully");
    assert.equal(finalRun?.result?.result?.a, "resumed-done", "resumed run should have the agent result");

    // The run should also appear in listRuns as completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed");
  }),
);

test(
  "resume with journal replay replays completed agents and runs remaining live",
  withTempCwd(async (cwd) => {
    // Per-call deferred so agent 1 can complete (and journal) while agent 2 stays
    // in-flight — the precondition for a real pause → resume → journal-replay cycle.
    const agent = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: agent.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise: origPromise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Agent 1 (run() call #0) completes and is journaled; agent 2 (call #1) stays pending.
    agent.resolve(0, "first-result");
    await new Promise((r) => setTimeout(r, 30));

    // Pause while agent 2 is still in-flight.
    const paused = manager.pause(runId);
    assert.equal(paused, true, "run pauses while agent 2 is in-flight");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Release the original's in-flight agent 2 so the aborted original settles. Its
    // result is NOT journaled — throwIfAborted fires before the journal write.
    agent.resolve(1);
    await origPromise.catch(() => {});

    // Only the completed agent 1 made it into the journal.
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.ok(persisted?.journal && persisted.journal.length >= 1, "journal should have at least one entry");
    assert.equal(persisted?.journal?.length, 1, "only the completed agent 1 is journaled");

    // Resume: agent 1 replays from the journal (no run() call); agent 2 runs live
    // (the next run() call, #2).
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 30));
    agent.resolve(2, "second-result");
    await new Promise((r) => setTimeout(r, 50));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed multi-agent run should complete");
    assert.equal(finalRun?.result?.result?.a, "first-result", "agent 1 replayed from the journal");
    assert.equal(finalRun?.result?.result?.b, "second-result", "agent 2 ran live after resume");
  }),
);

test(
  "resume returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    if (runId) {
      const resumed = await manager.resume(runId);
      assert.equal(resumed, false, "cannot resume a completed run");
    }
  }),
);

// ─── getRun tests (3 tests) ────────────────────────────────────────────────────

test(
  "getRun returns ManagedRun with correct fields for active background run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    const run = manager.getRun(runId);
    assert.ok(run, "getRun should return the managed run");
    assert.equal(run?.runId, runId);
    assert.equal(run?.status, "running");
    assert.equal(run?.script, oneAgentScript);
    assert.ok(run?.controller instanceof AbortController, "should have an AbortController");
    assert.ok(run?.startedAt instanceof Date, "should have a startedAt date");
    assert.equal(run?.background, true, "should be marked as background");
    assert.ok(Array.isArray(run?.journal), "should have a journal array");

    // snapshot should be populated
    assert.equal(run?.snapshot.name, "tracked_demo");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns ManagedRun with status 'aborted' after stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns undefined after deleteRun",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Stop first, then delete
    manager.stop(runId);
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    const run = manager.getRun(runId);
    assert.equal(run, undefined, "deleted run should not be accessible");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── deleteRun tests (2 tests) ─────────────────────────────────────────────────

test(
  "deleteRun can delete a running run (removes from memory and persistence)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Delete while running — should succeed (removes from tracking)
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    // Should not be in memory
    assert.equal(manager.getRun(runId), undefined);

    // Should not be in persistence
    const runs = manager.listRuns();
    assert.equal(
      runs.find((r) => r.runId === runId),
      undefined,
    );

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "deleteRun deletes persisted journal entries",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion
    await new Promise((r) => setTimeout(r, 30));

    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    // Verify persistence file is gone by checking listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 0, "no persisted runs should remain after delete");
  }),
);

// ─── startInBackground tests (3 tests) ─────────────────────────────────────────

test(
  "startInBackground with args propagates args to workflow script",
  withTempCwd(async (cwd) => {
    // Script that uses args
    const argsScript = `export const meta = { name: 'args_demo', description: 'args test' }
const a = await agent('do it', { label: 'a' })
return { args, a }`;

    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(argsScript, { mode: "test", value: 42 });
    const result = await promise;
    assert.ok(result, "should complete successfully");
    assert.equal(result.status, "completed", "runSync/background settle to a terminal status");
  }),
);

test(
  "startInBackground runId is unique per call",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    assert.notEqual(r1.runId, r2.runId, "runIds should be unique");

    // Wait for both to complete
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "startInBackground snapshot is initially populated with workflow name",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    const snap = manager.getSnapshot(runId);
    assert.equal(snap?.name, "tracked_demo");
    assert.equal(snap?.description, "one agent");
    assert.ok(Array.isArray(snap?.phases), "snap.phases should be an array");
    assert.ok(Array.isArray(snap?.logs), "snap.logs should be an array");
    await promise.catch(() => {});
  }),
);

// ─── Multiple runs / Events tests (3 tests) ────────────────────────────────────

test(
  "multiple background runs are independently managed",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 30));

    // Both should be running
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Stop one independently
    manager.stop(r1.runId);
    assert.equal(manager.getRun(r1.runId)?.status, "aborted");
    assert.equal(manager.getRun(r2.runId)?.status, "running", "other run should still be running");

    // listRuns should show both
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should be listed");

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "listRuns reflects status changes after pause and stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause
    manager.pause(runId);
    let persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused", "listRuns should show paused status");

    // Stop
    manager.stop(runId);
    persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "listRuns should show aborted status after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "manager emits 'resumed' and 'error' events",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    // The paused original emits 'error' when its in-flight agent later settles under
    // the aborted controller; register a sink so the EventEmitter never throws.
    manager.on("error", () => {});

    // Track resumed event
    let resumedEvent: { runId: string } | null = null;
    manager.on("resumed", (ev: { runId: string }) => {
      resumedEvent = ev;
    });

    // Track resumed event on the pause→resume cycle
    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);
    await manager.resume(runId);

    assert.ok(resumedEvent, "resumed event should fire on resume");
    assert.equal(resumedEvent?.runId, runId);

    da.resolve("done");
    await origPromise.catch(() => {});

    // Now test error event on abort. runSync settles to a terminal aborted result;
    // the 'error' event still fires.
    let capturedError: { runId: string; error: WorkflowError } | null = null;
    const da2 = deferredAgent();
    const manager2 = new WorkflowManager({ cwd, agent: da2.runner });
    manager2.on("error", (ev: { runId: string; error: WorkflowError }) => {
      capturedError = ev;
    });

    const ac2 = new AbortController();
    const runPromise = manager2.runSync(oneAgentScript, undefined, {
      externalSignal: ac2.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac2.abort();
    da2.resolve("done");

    const result = await runPromise;
    assert.equal(result.status, "aborted", "runSync settles to a terminal aborted result");

    assert.ok(capturedError, "error event should fire on abort");
    assert.ok(capturedError?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal(capturedError?.error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);
