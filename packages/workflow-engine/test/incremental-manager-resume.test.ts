import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunLease, RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const ENVIRONMENT_KEY = "incremental-manager-v1";
const workflow = (body: string, name = "incremental-manager") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "manager resume" }\n${body}`;

function tempDirs(prefix = "incremental-manager-"): { cwd: string; root: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}cwd-`));
  const root = mkdtempSync(join(tmpdir(), `${prefix}root-`));
  return {
    cwd,
    root,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface MemoryStore {
  persistence: RunPersistence;
  states: Map<string, PersistedRunState>;
  history: PersistedRunState[];
  leases: Set<string>;
  failSaveWhen: (predicate: ((state: PersistedRunState) => boolean) | undefined) => void;
}

function memoryStore(root: string): MemoryStore {
  mkdirSync(root, { recursive: true });
  const states = new Map<string, PersistedRunState>();
  const history: PersistedRunState[] = [];
  const leases = new Set<string>();
  let failure: ((state: PersistedRunState) => boolean) | undefined;
  const persistence: RunPersistence = {
    save(state) {
      if (failure?.(state)) throw new Error("injected save failure");
      const snapshot = JSON.parse(JSON.stringify(state)) as PersistedRunState;
      states.set(state.runId, snapshot);
      history.push(snapshot);
    },
    load(runId) {
      const state = states.get(runId);
      return state ? structuredClone(state) : null;
    },
    list() {
      return [...states.values()].map((state) => structuredClone(state));
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
    persistence,
    states,
    history,
    leases,
    failSaveWhen(predicate) {
      failure = predicate;
    },
  };
}

function safeCalls(items: readonly string[], name = "safe-calls"): string {
  return workflow(`
const items = ${JSON.stringify(items)}
return await parallel(items.map((item) => () => agent(item, {
  label: item,
  resume: { filesystem: "read-only" },
})))`, name);
}

async function recordSafeSource(
  manager: WorkflowManager,
  items: readonly string[],
): Promise<string> {
  const result = await manager.runSync(safeCalls(items), undefined, { environmentKey: ENVIRONMENT_KEY });
  assert.equal(result.status, "completed");
  return result.runId;
}

describe("WorkflowManager resumeFromRunId admission", () => {
  it("validates exact option combinations before creating a target run", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `recorded:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one"]);
      const originalIds = [...store.states.keys()];
      const invalid = [
        { resumeFromRunId: "" },
        { resumeFromRunId: 1 as unknown as string },
        { resumePolicy: "auto" as const },
        { resumePolicy: "future" as "auto" },
        { resumeFromRunId: sourceRunId, resumeJournal: new Map() },
        { resumePolicy: "positional" as const, resumeJournal: new Map() },
        { resumeFromRunId: sourceRunId, journaling: false },
        { resumeFromRunId: sourceRunId, runId: sourceRunId },
        { checkpointReplies: { 0: true } },
      ];
      for (const exec of invalid) {
        assert.throws(
          () => manager.startInBackground(workflow(`return "unused"`), undefined, exec),
          (error: unknown) =>
            error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        );
      }
      assert.deepEqual([...store.states.keys()], originalIds);

      assert.throws(
        () => manager.startInBackground(workflow(`return "unused"`), undefined, {
          resumeFromRunId: "missing-source",
        }),
        (error: unknown) =>
          error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.deepEqual([...store.states.keys()], originalIds);
    } finally {
      dirs.cleanup();
    }
  });

  it("holds the source lease through the critical target save and releases it before acknowledgement", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `recorded:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one", "two"]);
      const held = store.persistence.acquireRunLease(sourceRunId);
      assert.ok(held);
      assert.throws(
        () => manager.startInBackground(safeCalls(["one", "two"]), undefined, { resumeFromRunId: sourceRunId }),
        (error: unknown) =>
          error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(store.states.size, 1, "contention creates no target run");
      store.persistence.releaseRunLease(held);

      let observedCriticalSave = false;
      store.failSaveWhen((state) => {
        if (state.runId === "durable-target" && !observedCriticalSave) {
          observedCriticalSave = true;
          assert.equal(store.leases.has(sourceRunId), true, "source lease covers target seed save");
        }
        return false;
      });
      const started = manager.startInBackground(safeCalls(["one", "two"]), undefined, {
        runId: "durable-target",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(store.leases.has(sourceRunId), false, "source lease is released before return");
      assert.equal(store.leases.has("durable-target"), true, "target writer keeps its own lease");
      assert.equal(observedCriticalSave, true);
      const firstTargetSave = store.history.find((state) => state.runId === "durable-target");
      assert.equal(firstTargetSave?.resumeReport?.strategy, "identity-v1", JSON.stringify(firstTargetSave?.resumeReport));
      assert.equal(firstTargetSave?.resumeSeed?.candidates.length, 2);
      assert.deepEqual(firstTargetSave?.resumeReport, {
        strategy: "identity-v1",
        sourceRunId,
        requestedPolicy: "auto",
        replayed: 0,
        live: 0,
        failed: 0,
        calls: [],
      });
      const result = await started.promise;
      assert.equal(result.resumeReport?.replayed, 2);
      assert.deepEqual(store.persistence.load("durable-target")?.resumeSeed, {
        format: "identity-v1",
        sourceRunId,
        candidates: [],
      });
    } finally {
      dirs.cleanup();
    }
  });

  it("activates legacy, forced-positional, and unknown-format rollout paths", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const sourceManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const identitySource = await recordSafeSource(sourceManager, ["one"]);

      const positional = await new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run() { assert.fail("forced positional should replay"); } },
      }).runSync(safeCalls(["one"]), undefined, {
        runId: "forced-positional",
        resumeFromRunId: identitySource,
        resumePolicy: "positional",
      });
      assert.equal(positional.resumeReport?.strategy, "positional-v1");
      if (positional.resumeReport?.strategy === "positional-v1") {
        assert.equal(positional.resumeReport.fallbackReason, "forced-positional");
        assert.equal(positional.resumeReport.eligibility, "safe-prefix");
      }
      assert.equal(positional.resumeReport?.replayed, 1);
      assert.equal(store.persistence.load("forced-positional")?.legacyResume, undefined);
      assert.equal(store.persistence.load("forced-positional")?.resumeSeed?.sourceRunId, identitySource);

      const legacyState = store.persistence.load(identitySource);
      assert.ok(legacyState);
      delete legacyState.resume;
      store.states.set("legacy-source", { ...legacyState, runId: "legacy-source" });
      const rewrittenLegacy = store.states.get("legacy-source");
      assert.ok(rewrittenLegacy);
      rewrittenLegacy.journal = rewrittenLegacy.journal?.map((entry) => ({ ...entry, scope: "legacy-source" }));
      rewrittenLegacy.calls = rewrittenLegacy.calls?.map((call) => ({ ...call, scope: "legacy-source" }));
      const legacy = await new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run() { assert.fail("legacy positional should replay"); } },
      }).runSync(safeCalls(["one"]), undefined, {
        runId: "legacy-target",
        resumeFromRunId: "legacy-source",
      });
      assert.equal(legacy.resumeReport?.strategy, "positional-v1");
      if (legacy.resumeReport?.strategy === "positional-v1") {
        assert.equal(legacy.resumeReport.fallbackReason, "legacy-recording");
        assert.equal(legacy.resumeReport.eligibility, "legacy");
      }
      assert.equal(legacy.resumeReport?.replayed, 1);
      assert.equal(store.persistence.load("legacy-target")?.legacyResume, true);
      assert.equal(store.persistence.load("legacy-target")?.resumeSeed?.sourceRunId, "legacy-source");

      const unsupported = { ...legacyState, runId: "unsupported-source", resume: { format: "future" } };
      unsupported.journal = unsupported.journal?.map((entry) => ({ ...entry, scope: "unsupported-source" }));
      unsupported.calls = unsupported.calls?.map((call) => ({ ...call, scope: "unsupported-source" }));
      store.states.set("unsupported-source", unsupported as PersistedRunState);
      let live = 0;
      const unsupportedResult = await new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run() { live++; return "live"; } },
      }).runSync(safeCalls(["one"]), undefined, {
        runId: "unsupported-target",
        resumeFromRunId: "unsupported-source",
      });
      assert.equal(live, 1);
      assert.equal(unsupportedResult.resumeReport?.strategy, "live");
      if (unsupportedResult.resumeReport?.strategy === "live") {
        assert.equal(unsupportedResult.resumeReport.disabledReason, "unsupported-format");
      }
      assert.deepEqual(store.persistence.load("unsupported-target")?.resumeSeed, {
        format: "identity-v1",
        sourceRunId: "unsupported-source",
        candidates: [],
      });
    } finally {
      dirs.cleanup();
    }
  });
});

describe("WorkflowManager durable identity execution", () => {
  it("replays 38 of 40 moved public calls, persists decisions, and compacts completion", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const sourceItems = Array.from({ length: 40 }, (_, index) => `item-${index}`);
      const sourceManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(sourceManager, sourceItems);
      const livePrompts: string[] = [];
      const targetItems = [...sourceItems.slice(7), ...sourceItems.slice(0, 7)];
      targetItems[5] = "changed-a";
      targetItems[31] = "changed-b";
      const targetManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { livePrompts.push(prompt); return `live:${prompt}`; } },
      });
      const result = await targetManager.runSync(safeCalls(targetItems), undefined, {
        runId: "fanout-target",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(livePrompts.sort(), ["changed-a", "changed-b"]);
      assert.equal(result.resumeReport?.strategy, "identity-v1");
      assert.equal(result.resumeReport?.replayed, 38);
      assert.equal(result.resumeReport?.live, 2);
      assert.equal(result.resumeReport?.failed, 0);
      assert.deepEqual(result.resumeReport?.calls.map((decision) => decision.index), sourceItems.map((_, index) => index));
      assert.equal(result.resumeReport?.calls.filter((decision) =>
        decision.action === "replayed" && decision.recordedIndex !== decision.index).length, 38);

      const persisted = store.persistence.load("fanout-target");
      assert.equal(persisted?.resumeSeed?.sourceRunId, sourceRunId);
      assert.equal(persisted?.resumeSeed?.candidates.length, 0);
      assert.deepEqual(persisted?.resumeReport, result.resumeReport);
      assert.equal(persisted?.journal?.length, 40);
      assert.equal(persisted?.calls?.length, 40);
      assert.ok(persisted?.journal?.every((entry) => entry.scope === "fanout-target"));
      assert.ok(persisted?.calls?.every((call) => call.scope === "fanout-target"));
      const outward = JSON.stringify(result.resumeReport);
      for (const secret of [dirs.cwd, "source:item-0", "changed-a", "sessionId", "inputsHash"]) {
        assert.equal(outward.includes(secret), false);
      }
    } finally {
      dirs.cleanup();
    }
  });

  it("retains only the remaining seed on pause and flattens grandparent provenance with a reply", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one", "two"]);
      const paused = await manager.runSync(workflow(`
await agent("one", { label: "one", resume: { filesystem: "read-only" } })
await checkpoint("approve", { headless: "pause" })
return await agent("two", { label: "two", resume: { filesystem: "read-only" } })`, "paused-hop"), undefined, {
        runId: "paused-hop",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);
      assert.deepEqual(paused.resumeReport?.calls.map((decision) => decision.action), ["replayed", "live"]);
      const pausedState = store.persistence.load("paused-hop");
      assert.equal(pausedState?.resumeSeed?.candidates.length, 1);
      assert.equal(pausedState?.resumeSeed?.candidates[0]?.sourceRunId, sourceRunId);
      assert.equal(pausedState?.journal?.length, 1);
      assert.equal(pausedState?.calls?.length, 2);
      assert.ok(pausedState?.resume?.terminalEnvironment);

      const final = await manager.runSync(workflow(`
const one = await agent("one", { label: "one", resume: { filesystem: "read-only" } })
const approval = await checkpoint("approve", { headless: "pause" })
const two = await agent("two", { label: "two", resume: { filesystem: "read-only" } })
return { one, approval, two }`, "replied-hop"), undefined, {
        runId: "replied-hop",
        resumeFromRunId: "paused-hop",
        checkpointReplies: { [paused.checkpointContext.callIndex]: true },
      });
      assert.equal(final.status, "completed", JSON.stringify(final.resumeReport));
      assert.deepEqual(JSON.parse(JSON.stringify(final.result)), {
        one: "source:one",
        approval: true,
        two: "source:two",
      });
      assert.equal(final.resumeReport?.strategy, "identity-v1");
      assert.equal(final.resumeReport?.replayed, 3);
      const twoDecision = final.resumeReport?.calls[2];
      assert.equal(twoDecision?.action, "replayed");
      if (twoDecision?.action === "replayed") assert.equal(twoDecision.sourceRunId, sourceRunId);
      assert.equal(store.persistence.load("replied-hop")?.resumeSeed?.sourceRunId, "paused-hop");
      assert.equal(store.persistence.load("replied-hop")?.resumeSeed?.candidates.length, 0);
    } finally {
      dirs.cleanup();
    }
  });

  it("retains and flattens the reduced seed after a failed execution", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one", "two"]);
      const failed = await manager.runSync(workflow(`
await agent("one", { label: "one", resume: { filesystem: "read-only" } })
throw new Error("stop after one")`, "failed-hop"), undefined, {
        runId: "failed-hop",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.resumeReport?.replayed, 1);
      const failedState = store.persistence.load("failed-hop");
      assert.equal(failedState?.resumeSeed?.sourceRunId, sourceRunId);
      assert.equal(failedState?.resumeSeed?.candidates.length, 1);
      assert.equal(failedState?.resumeSeed?.candidates[0]?.sourceRunId, sourceRunId);

      const resumed = await manager.runSync(safeCalls(["one", "two"], "after-failure"), undefined, {
        runId: "after-failure",
        resumeFromRunId: "failed-hop",
      });
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.resumeReport?.replayed, 2);
      const second = resumed.resumeReport?.calls[1];
      assert.equal(second?.action, "replayed");
      if (second?.action === "replayed") assert.equal(second.sourceRunId, sourceRunId);
    } finally {
      dirs.cleanup();
    }
  });

  it("persists an empty seed at the unsafe barrier and never resurrects its suffix", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `live:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one", "two"]);
      const failed = await manager.runSync(workflow(`
await agent("changed", { label: "changed" })
throw new Error("stop after unsafe work")`, "unsafe-barrier"), undefined, {
        runId: "unsafe-barrier",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(failed.status, "failed");
      assert.equal(store.persistence.load("unsafe-barrier")?.resumeSeed?.candidates.length, 0);

      const live: string[] = [];
      const resumed = await new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { live.push(prompt); return `next:${prompt}`; } },
      }).runSync(workflow(`
await agent("changed", { label: "changed" })
return await agent("two", { label: "two", resume: { filesystem: "read-only" } })`, "after-unsafe"), undefined, {
        runId: "after-unsafe",
        resumeFromRunId: "unsafe-barrier",
      });
      assert.deepEqual(live, ["changed", "two"]);
      assert.equal(resumed.resumeReport?.replayed, 0);
      assert.equal(resumed.resumeReport?.live, 2);
    } finally {
      dirs.cleanup();
    }
  });

  it("drops an inherited positional suffix before a replied checkpoint double hop", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceScript = workflow(`
await agent("one", { label: "one", resume: { filesystem: "read-only" } })
await checkpoint("original checkpoint")
return await agent("tail", { label: "tail", resume: { filesystem: "read-only" } })`, "positional-checkpoint-source");
      const source = await manager.runSync(sourceScript);
      assert.equal(source.status, "completed");

      const changedScript = workflow(`
await agent("one", { label: "one", resume: { filesystem: "read-only" } })
const approval = await checkpoint("changed checkpoint", { headless: "pause" })
const tail = await agent("tail", { label: "tail", resume: { filesystem: "read-only" } })
return { approval, tail }`, "positional-checkpoint-target");
      const paused = await manager.runSync(changedScript, undefined, {
        runId: "positional-pause",
        resumeFromRunId: source.runId,
        resumePolicy: "positional",
      });
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);
      assert.equal(paused.resumeReport?.strategy, "positional-v1");
      assert.deepEqual(store.persistence.load("positional-pause")?.journal?.map((entry) => entry.index), [0]);

      const live: string[] = [];
      const resumed = await new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { live.push(prompt); return `live:${prompt}`; } },
      }).runSync(changedScript, undefined, {
        runId: "positional-replied",
        resumeFromRunId: "positional-pause",
        checkpointReplies: { [paused.checkpointContext.callIndex]: true },
      });
      assert.equal(resumed.status, "completed");
      assert.deepEqual(live, ["tail"]);
      assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), { approval: true, tail: "live:tail" });
      assert.deepEqual(resumed.resumeReport?.calls.map((decision) => decision.action), [
        "replayed",
        "replayed",
        "live",
      ]);
    } finally {
      dirs.cleanup();
    }
  });

  it("turns initial and commit save failures into fail-closed persistence errors", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const sourceManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(sourceManager, ["one", "two"]);

      store.failSaveWhen((state) => state.runId === "initial-failure");
      const initialManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run() { assert.fail("initial failure must not execute"); } },
      });
      assert.throws(
        () => initialManager.startInBackground(safeCalls(["one", "two"]), undefined, {
          runId: "initial-failure",
          resumeFromRunId: sourceRunId,
        }),
        (error: unknown) =>
          error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(store.leases.has(sourceRunId), false);
      assert.equal(store.leases.has("initial-failure"), false);
      assert.equal(store.states.has("initial-failure"), false);

      let failedCommit = false;
      store.failSaveWhen((state) => {
        if (
          !failedCommit &&
          state.runId === "commit-failure" &&
          state.resumeSeed?.candidates.length === 1
        ) {
          failedCommit = true;
          return true;
        }
        return false;
      });
      let liveCalls = 0;
      const commitManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        environmentKey: ENVIRONMENT_KEY,
        agent: { async run() { liveCalls++; return "live"; } },
      });
      const caught = await commitManager.runSync(workflow(`
const codes = []
try { await agent("one", { label: "one", resume: { filesystem: "read-only" } }) } catch (error) { codes.push(error.code) }
try { await agent("two", { label: "two", resume: { filesystem: "read-only" } }) } catch (error) { codes.push(error.code) }
return codes`, "commit-failure"), undefined, {
        runId: "commit-failure",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(failedCommit, true);
      assert.equal(liveCalls, 0);
      assert.deepEqual(JSON.parse(JSON.stringify(caught.result)), [
        WorkflowErrorCode.PERSISTENCE_ERROR,
        WorkflowErrorCode.PERSISTENCE_ERROR,
      ]);
      assert.deepEqual(caught.resumeReport?.calls.map((decision) =>
        decision.action === "failed" ? decision.reason : decision.action), [
        "seed-persistence-error",
        "resume-fatal-latch",
      ]);
    } finally {
      dirs.cleanup();
    }
  });
});

describe("WorkflowManager positional safety counterexamples", () => {
  function gitDirs(): { cwd: string; root: string; cleanup: () => void } {
    const dirs = tempDirs("incremental-manager-git-");
    execFileSync("git", ["-C", dirs.cwd, "init", "-q"]);
    execFileSync("git", ["-C", dirs.cwd, "config", "user.email", "tests@example.com"]);
    execFileSync("git", ["-C", dirs.cwd, "config", "user.name", "Tests"]);
    writeFileSync(join(dirs.cwd, "tracked.txt"), "clean\n");
    execFileSync("git", ["-C", dirs.cwd, "add", "tracked.txt"]);
    execFileSync("git", ["-C", dirs.cwd, "commit", "-qm", "initial"]);
    return dirs;
  }

  function artifactRunner(cwd: string, calls: string[]): AgentRunner {
    return {
      async run(prompt: string, options: RunOptions) {
        calls.push(prompt);
        if (prompt.startsWith("write:")) {
          const value = prompt.slice("write:".length);
          writeFileSync(join(options.cwd ?? cwd, "generated.json"), value);
          return value;
        }
        return readFileSync(join(options.cwd ?? cwd, "generated.json"), "utf8");
      },
    };
  }

  const writerScript = (writer: string, reader: string) => workflow(`
await agent(${JSON.stringify(writer)}, { label: "writer" })
return await agent(${JSON.stringify(reader)}, {
  label: "reader",
  resume: { filesystem: "read-only" },
})`, "writer-counterexample");

  it("runs an edited unsafe writer and its unchanged reader live", async () => {
    const dirs = gitDirs();
    try {
      const sourceCalls: string[] = [];
      const source = await new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: artifactRunner(dirs.cwd, sourceCalls),
      }).runSync(writerScript("write:v1", "read"));
      const targetCalls: string[] = [];
      const target = await new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: artifactRunner(dirs.cwd, targetCalls),
      }).runSync(writerScript("write:v2", "read"), undefined, { resumeFromRunId: source.runId });
      assert.deepEqual(targetCalls, ["write:v2", "read"]);
      assert.equal(target.result, "v2");
      assert.equal(target.resumeReport?.strategy, "positional-v1");
      if (target.resumeReport?.strategy === "positional-v1") {
        assert.equal(target.resumeReport.fallbackReason, "unsafe-recording");
        assert.equal(target.resumeReport.eligibility, "all-live");
      }
      assert.deepEqual(target.resumeReport?.calls.map((decision) =>
        decision.action === "live" ? decision.reason : decision.action), [
        "positional-suffix",
        "positional-suffix",
      ]);
    } finally {
      dirs.cleanup();
    }
  });

  it("reruns an unchanged unsafe writer before a changed downstream reader", async () => {
    const dirs = gitDirs();
    try {
      const source = await new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: artifactRunner(dirs.cwd, []),
      }).runSync(writerScript("write:v1", "read:first"));
      const targetCalls: string[] = [];
      const target = await new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: artifactRunner(dirs.cwd, targetCalls),
      }).runSync(writerScript("write:v1", "read:changed"), undefined, { resumeFromRunId: source.runId });
      assert.deepEqual(targetCalls, ["write:v1", "read:changed"]);
      assert.equal(target.result, "v1");
      assert.equal(target.resumeReport?.replayed, 0);
      assert.equal(target.resumeReport?.live, 2);
    } finally {
      dirs.cleanup();
    }
  });
});
