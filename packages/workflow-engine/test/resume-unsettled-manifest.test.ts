import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunOptions } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { WorkflowManager } from "../src/workflow-manager.js";

const ENVIRONMENT_KEY = "resume-unsettled-manifest";

function tempDirs(): { cwd: string; root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "resume-unsettled-"));
  const cwd = join(base, "cwd");
  const root = join(base, "persistence");
  mkdirSync(cwd);
  mkdirSync(root);
  return { cwd, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function abortablePending(options: RunOptions): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(options.signal?.reason ?? new Error("aborted"));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

function parallelScript(prompts: readonly string[], name: string): string {
  return `export const meta = { name: ${JSON.stringify(name)}, description: "resume interrupted calls" }
return await parallel(${JSON.stringify(prompts)}.map((prompt) => () =>
  agent(prompt, { label: prompt, resume: { filesystem: "read-only" } })
))`;
}

function usageLimitRunner(completed: ReadonlySet<string>, release: Promise<void>) {
  return {
    async run(prompt: string, options: RunOptions): Promise<unknown> {
      if (completed.has(prompt)) return `source:${prompt}`;
      if (prompt === "usage") {
        await release;
        throw new WorkflowError("provider usage exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
          recoverable: false,
        });
      }
      return abortablePending(options);
    },
  };
}

describe("resume manifests for unsettled calls", () => {
  it("replays a completed prefix after a usage-limit pause and runs interrupted calls live", async () => {
    const dirs = tempDirs();
    const release = deferred();
    const prompts = ["complete-0", "complete-1", "pending", "usage"];
    const script = parallelScript(prompts, "usage-prefix");
    try {
      const source = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: ENVIRONMENT_KEY,
        agent: usageLimitRunner(new Set(["complete-0", "complete-1"]), release.promise),
      });
      const started = source.startInBackground(script, undefined, { concurrency: 8 });
      await waitUntil(
        () => source.getPersistence().load(started.runId)?.journal?.length === 2,
        "both completed prefix calls should be durable",
      );
      release.resolve();
      await assert.rejects(started.promise, (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT);

      const persisted = source.getPersistence().load(started.runId);
      assert.equal(persisted?.callsAllocated, 4);
      assert.deepEqual(persisted?.calls?.map((call) => call.index).sort((a, b) => a - b), [0, 1, 2, 3]);
      assert.equal(persisted?.calls?.find((call) => call.index === 2)?.error?.code, WorkflowErrorCode.WORKFLOW_ABORTED);

      const live: string[] = [];
      const resumed = await new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { live.push(prompt); return `live:${prompt}`; } },
      }).runSync(script, undefined, { resumeFromRunId: started.runId, concurrency: 8 });

      assert.equal(resumed.status, "completed");
      assert.equal(resumed.resumeReport?.strategy, "identity-v1");
      assert.deepEqual(resumed.result, [
        "source:complete-0",
        "source:complete-1",
        "live:pending",
        "live:usage",
      ]);
      assert.deepEqual(live, ["pending", "usage"]);
      assert.equal(resumed.resumeReport?.replayed, 2);
      assert.equal(resumed.resumeReport?.live, 2);
      assert.ok((resumed.replayEligibility?.replayedPrefix ?? 0) > 0);
    } finally {
      dirs.cleanup();
    }
  });

  it("preserves identity alignment around a non-zero interrupted index and replays later completions", async () => {
    const dirs = tempDirs();
    const release = deferred();
    const prompts = ["complete-0", "pending-1", "complete-2", "usage"];
    const script = parallelScript(prompts, "usage-alignment");
    try {
      const source = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: ENVIRONMENT_KEY,
        agent: usageLimitRunner(new Set(["complete-0", "complete-2"]), release.promise),
      });
      const started = source.startInBackground(script, undefined, { concurrency: 8 });
      await waitUntil(
        () => source.getPersistence().load(started.runId)?.journal?.length === 2,
        "the results on both sides of the gap should be durable",
      );
      release.resolve();
      await assert.rejects(started.promise, (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT);

      const live: string[] = [];
      const resumed = await new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { live.push(prompt); return `live:${prompt}`; } },
      }).runSync(script, undefined, { resumeFromRunId: started.runId, concurrency: 8 });

      assert.deepEqual(resumed.result, [
        "source:complete-0",
        "live:pending-1",
        "source:complete-2",
        "live:usage",
      ]);
      assert.deepEqual(live, ["pending-1", "usage"]);
      assert.deepEqual(
        resumed.resumeReport?.calls.map((decision) => decision.action),
        ["replayed", "live", "replayed", "live"],
      );
    } finally {
      dirs.cleanup();
    }
  });

  it("persists dense interrupted rows for auth, checkpoint, host pause, stop, and external abort halts", async () => {
    const dirs = tempDirs();
    try {
      const scenarios: Array<{
        name: string;
        script: string;
        halt: (manager: WorkflowManager, runId: string) => void;
      }> = [
        {
          name: "host-pause",
          script: parallelScript(["pending-0", "pending-1"], "host-pause"),
          halt: (manager, runId) => { assert.equal(manager.pause(runId), true); },
        },
        {
          name: "host-stop",
          script: parallelScript(["pending-0", "pending-1"], "host-stop"),
          halt: (manager, runId) => { assert.equal(manager.stop(runId), true); },
        },
      ];

      for (const scenario of scenarios) {
        const manager = new WorkflowManager({
          cwd: dirs.cwd,
          persistenceRoot: join(dirs.root, scenario.name),
          environmentKey: ENVIRONMENT_KEY,
          agent: { run: (_prompt, options) => abortablePending(options) },
        });
        const started = manager.startInBackground(scenario.script, undefined, { concurrency: 8 });
        await waitUntil(
          () => manager.getRun(started.runId)?.callsAllocated === 2,
          `${scenario.name} should allocate both calls`,
        );
        scenario.halt(manager, started.runId);
        const persisted = manager.getPersistence().load(started.runId);
        assert.equal(persisted?.calls?.length, 2, `${scenario.name} should persist every allocation`);
        assert.ok(persisted?.calls?.every((call) => call.error?.code === WorkflowErrorCode.WORKFLOW_ABORTED));
        await started.promise.catch(() => {});
      }

      for (const code of [WorkflowErrorCode.AUTH_REQUIRED, WorkflowErrorCode.CHECKPOINT_REQUIRED]) {
        const root = join(dirs.root, code.toLowerCase());
        const script = code === WorkflowErrorCode.CHECKPOINT_REQUIRED
          ? `export const meta = { name: "checkpoint-halt", description: "checkpoint halt" }
return await parallel([
  () => agent("pending", { label: "pending", resume: { filesystem: "read-only" } }),
  () => checkpoint("approval", { headless: "pause" }),
])`
          : parallelScript(["pending", "halt"], "auth-halt");
        const manager = new WorkflowManager({
          cwd: dirs.cwd,
          persistenceRoot: root,
          environmentKey: ENVIRONMENT_KEY,
          agent: {
            async run(prompt, options) {
              if (prompt === "halt") {
                throw new WorkflowError("authentication required", code, { recoverable: false });
              }
              return abortablePending(options);
            },
          },
        });
        const result = await manager.runSync(script, undefined, { concurrency: 8 });
        assert.equal(result.status, "paused");
        assert.equal(result.callsAllocated, 2);
        assert.equal(result.calls?.length, 2);
      }

      const external = new AbortController();
      const externalManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: join(dirs.root, "external"),
        environmentKey: ENVIRONMENT_KEY,
        agent: { run: (_prompt, options) => abortablePending(options) },
      });
      const externallyAborted = externalManager.startInBackground(
        parallelScript(["pending-0", "pending-1"], "external-abort"),
        undefined,
        { concurrency: 8, externalSignal: external.signal },
      );
      await waitUntil(
        () => externalManager.getRun(externallyAborted.runId)?.callsAllocated === 2,
        "external abort should see both allocations",
      );
      external.abort();
      await externallyAborted.promise.catch(() => {});
      assert.equal(externalManager.getPersistence().load(externallyAborted.runId)?.calls?.length, 2);
    } finally {
      dirs.cleanup();
    }
  });
});
