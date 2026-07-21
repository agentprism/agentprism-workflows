import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunLease, RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const script = `export const meta = { name: "managed-continuation", description: "manager continuation" }
return await agent("finish the task", { label: "worker" })`;

function fixture(): {
  cwd: string;
  root: string;
  persistence: RunPersistence;
  states: Map<string, PersistedRunState>;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "continuation-manager-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "continuation-manager-root-"));
  mkdirSync(root, { recursive: true });
  const states = new Map<string, PersistedRunState>();
  const leases = new Set<string>();
  const persistence: RunPersistence = {
    save(value) {
      states.set(value.runId, structuredClone(value));
    },
    load(runId) {
      const value = states.get(runId);
      return value ? structuredClone(value) : null;
    },
    list() {
      return [...states.values()].map((value) => structuredClone(value));
    },
    delete(runId) {
      return states.delete(runId);
    },
    acquireRunLease(runId) {
      if (leases.has(runId)) return null;
      leases.add(runId);
      return { runId, token: runId };
    },
    releaseRunLease(lease: RunLease) {
      leases.delete(lease.runId);
    },
    getRunsDir() {
      return root;
    },
  };
  return {
    cwd,
    root,
    persistence,
    states,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

class ContinuationRunner implements AgentRunner {
  mode: "usage-pause" | "auth-pause" | "continue" = "usage-pause";
  authReady = false;
  readonly directives: Array<RunOptions["continueFromSession"]> = [];
  readonly calls: string[] = [];
  readonly auth = {
    canResume: (_backendId: string) => this.authReady,
  };

  async run(prompt: string, options: RunOptions): Promise<string> {
    this.calls.push(prompt);
    if (this.mode === "usage-pause" || this.mode === "auth-pause") {
      options.onSessionOpen?.({
        sessionId: `${this.mode}-session`,
        backendId: "test-backend",
        poolKey: "test-backend",
        cwd: options.cwd ?? "",
        reopen: { load: true, resume: true, list: true },
      });
      if (this.mode === "auth-pause") {
        throw new WorkflowError("credentials expired", WorkflowErrorCode.AUTH_REQUIRED, {
          recoverable: false,
          authContext: { backendId: "test-backend", methods: [] },
        });
      }
      throw new WorkflowError("quota exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
      });
    }

    this.directives.push(options.continueFromSession);
    if (options.continueFromSession) {
      options.onResultProvenance?.({
        source: "live",
        continuation: { reattached: true, method: "resume" },
      });
      options.onSessionOpen?.({
        ...options.continueFromSession,
        sessionId: `${options.continueFromSession.sessionId}-continued`,
      });
    }
    return options.continueFromSession ? "continued result" : "fresh result";
  }
}

describe("WorkflowManager continuation wiring", () => {
  it("reattaches by default on same-ID resume without a PreparedResume", async () => {
    const test = fixture();
    try {
      const runner = new ContinuationRunner();
      const manager = new WorkflowManager({
        cwd: test.cwd,
        persistence: test.persistence,
        agent: runner,
        environmentKey: "continuation-v1",
      });
      const paused = await manager.runSync(script, undefined, { runId: "same-id" });
      assert.equal(paused.status, "paused");
      assert.equal(paused.reason, "usage_limit");
      runner.mode = "continue";

      const resumed = await manager.resumeInBackground("same-id");
      assert.equal(resumed.accepted, true);
      const completed = await resumed.promise;
      assert.equal(completed.status, "completed");
      assert.equal(completed.result, "continued result");
      assert.equal(runner.directives.length, 1);
      assert.equal(runner.directives[0]?.sessionId, "usage-pause-session");
      assert.equal(completed.fallbacks?.[0]?.kind, "continuation");
      assert.equal(completed.resumeReport, undefined, "same-ID recovery builds no PreparedResume");
    } finally {
      test.cleanup();
    }
  });

  it("reattaches on identity new-run resume and permits sequential multi-consumer fan-out", async () => {
    const test = fixture();
    try {
      const runner = new ContinuationRunner();
      const manager = new WorkflowManager({
        cwd: test.cwd,
        persistence: test.persistence,
        agent: runner,
        environmentKey: "continuation-v1",
      });
      const paused = await manager.runSync(script, undefined, { runId: "fanout-source" });
      assert.equal(paused.status, "paused");
      runner.mode = "continue";

      for (const runId of ["fanout-a", "fanout-b"]) {
        const started = manager.startInBackground(script, undefined, {
          runId,
          resumeFromRunId: "fanout-source",
        });
        const completed = await started.promise;
        assert.equal(completed.status, "completed");
        assert.equal(completed.result, "continued result");
        assert.equal(completed.resumeReport?.strategy, "identity-v1");
        assert.equal(test.states.get(runId)?.resumeSourceRunId, "fanout-source");
      }
      assert.deepEqual(runner.directives.map((directive) => directive?.sessionId), [
        "usage-pause-session",
        "usage-pause-session",
      ]);
      assert.equal(test.states.get("fanout-source")?.status, "paused", "targets never claim or mutate the source");
    } finally {
      test.cleanup();
    }
  });

  it("replays an ordinary completed prefix before reattaching the interrupted call", async () => {
    const test = fixture();
    try {
      const calls: string[] = [];
      const directives: Array<RunOptions["continueFromSession"]> = [];
      let continuing = false;
      const runner: AgentRunner = {
        async run(prompt, options) {
          calls.push(prompt);
          if (prompt === "completed prefix") {
            assert.equal(continuing, false, "the completed prefix must replay on resume");
            return "recorded prefix";
          }
          if (!continuing) {
            options.onSessionOpen?.({
              sessionId: "interrupted-session",
              backendId: "test-backend",
              poolKey: "test-backend",
              cwd: options.cwd ?? "",
              reopen: { load: true, resume: true, list: true },
            });
            throw new WorkflowError("quota exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
              recoverable: false,
            });
          }
          directives.push(options.continueFromSession);
          return options.continueFromSession ? "continued tail" : "fresh tail";
        },
      };
      const manager = new WorkflowManager({
        cwd: test.cwd,
        persistence: test.persistence,
        agent: runner,
        environmentKey: "continuation-v1",
      });
      const prefixScript = `export const meta = { name: "prefix-continuation", description: "prefix continuation" }
const prefix = await agent("completed prefix", { label: "prefix" })
const tail = await agent("interrupted tail", { label: "tail" })
return { prefix, tail }`;
      const paused = await manager.runSync(prefixScript, undefined, { runId: "prefix-source" });
      assert.equal(paused.status, "paused");
      assert.deepEqual(calls, ["completed prefix", "interrupted tail"]);
      const persistedSource = test.states.get("prefix-source");
      assert.ok(persistedSource);
      test.states.set("prefix-source", JSON.parse(JSON.stringify(persistedSource)) as PersistedRunState);

      continuing = true;
      const completed = await manager.runSync(prefixScript, undefined, {
        runId: "prefix-target",
        resumeFromRunId: "prefix-source",
      });
      assert.equal(completed.status, "completed");
      assert.deepEqual(JSON.parse(JSON.stringify(completed.result)), {
        prefix: "recorded prefix",
        tail: "continued tail",
      });
      assert.deepEqual(calls, ["completed prefix", "interrupted tail", "interrupted tail"]);
      assert.equal(directives[0]?.sessionId, "interrupted-session");
      assert.equal(completed.resumeReport?.strategy, "identity-v1");
      assert.deepEqual(completed.resumeReport?.calls.map((decision) => decision.action), [
        "replayed",
        "live",
      ]);
    } finally {
      test.cleanup();
    }
  });

  it("does not consume a candidate when execution admission is denied and preserves ancestry", async () => {
    const test = fixture();
    try {
      const runner = new ContinuationRunner();
      const manager = new WorkflowManager({ cwd: test.cwd, persistence: test.persistence, agent: runner });
      await manager.runSync(script, undefined, { runId: "admission-source" });
      runner.mode = "continue";
      const callsBefore = runner.calls.length;
      const started = manager.startInBackground(script, undefined, {
        runId: "admission-target",
        resumeFromRunId: "admission-source",
        executionAdmission: Promise.resolve("denied"),
      });
      await assert.rejects(started.promise, (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR);
      assert.equal(runner.calls.length, callsBefore);
      assert.deepEqual(runner.directives, []);
      assert.equal(test.states.get("admission-target")?.fallbacks?.length ?? 0, 0);
      assert.equal(test.states.get("admission-target")?.resumeSourceRunId, "admission-source");
    } finally {
      test.cleanup();
    }
  });

  it("runs the auth cold re-arm gate before same-ID candidate consumption", async () => {
    const test = fixture();
    try {
      const runner = new ContinuationRunner();
      runner.mode = "auth-pause";
      const manager = new WorkflowManager({ cwd: test.cwd, persistence: test.persistence, agent: runner });
      const paused = await manager.runSync(script, undefined, { runId: "auth-source" });
      assert.equal(paused.status, "paused");
      assert.equal(paused.reason, "auth_required");
      runner.mode = "continue";

      const gated = await manager.resumeInBackground("auth-source");
      assert.equal(gated.accepted, true);
      await assert.rejects(gated.promise, (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.AUTH_REQUIRED);
      assert.deepEqual(runner.directives, [], "cold gate re-pauses before executeRun");

      runner.authReady = true;
      const resumed = await manager.resumeInBackground("auth-source");
      assert.equal(resumed.accepted, true);
      const completed = await resumed.promise;
      assert.equal(completed.status, "completed");
      assert.equal(runner.directives[0]?.sessionId, "auth-pause-session");
      assert.equal(test.states.get("auth-source")?.resumeSourceRunId, undefined);
    } finally {
      test.cleanup();
    }
  });
});
