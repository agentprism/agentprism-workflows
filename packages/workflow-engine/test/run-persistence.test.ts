import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionRecord, AgentSessionRef } from "@automatalabs/shared-types";
import { WORKFLOW_RUNS_DIR } from "../src/config.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createRunPersistence, generateRunId, type PersistedRunState, type RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { AGENTPRISM_PERSISTENCE_ROOT_ENV, workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// Run state now lives under the user's workflow home (~/.agentprism/workflows/projects/<key>/runs),
// with the project-relative `.agentprism/workflows/runs` (WORKFLOW_RUNS_DIR) read/cleaned as the
// legacy location. Each test isolates BOTH cwd and HOME so primary + legacy paths are sandboxed.
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-dw-rp-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-dw-home-"));
    const priorRoot = process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
    try {
      delete process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      if (priorRoot === undefined) delete process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
      else process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV] = priorRoot;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

const twoAgentScript = `export const meta = { name: 'persistence_demo', description: 'persistence demo' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

const loggingScript = `export const meta = { name: 'logging_demo', description: 'logging demo' }
log('root check')
const a = await agent('first', { label: 'first' })
return { a }`;

const persistedSessionScript = `export const meta = { name: 'persisted_session', description: 'persisted session', phases: [{ title: 'Recovery' }] }
phase('Recovery')
const answer = await agent('persist this session', { label: 'recovery-agent', keepSession: true })
return answer`;

const noSessionScript = `export const meta = { name: 'no_session', description: 'no agent session' }
return 'done'`;

function deferredAgent() {
  let resolveRun: ((value: unknown) => void) | undefined;
  return {
    resolve(value: unknown = "ok") {
      resolveRun?.(value);
    },
    runner: {
      async run() {
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    },
  };
}

function persistedRun(runId: string, status: PersistedRunState["status"]): PersistedRunState {
  return {
    runId,
    workflowName: "recovery",
    script: "export const meta = { name: 'recovery', description: 'recovery' }\nreturn 1",
    status,
    phases: ["Recover"],
    currentPhase: "Recover",
    agents: [],
    logs: ["preserved"],
    journal: [],
    calls: [],
    callsAllocated: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
}

function memoryPersistence(): {
  persistence: RunPersistence;
  saves: PersistedRunState[];
  acquired: string[];
  released: string[];
} {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const clone = (state: PersistedRunState): PersistedRunState => structuredClone(state);

  return {
    saves,
    acquired,
    released,
    persistence: {
      save(state) {
        const copy = clone(state);
        saves.push(copy);
        states.set(state.runId, copy);
      },
      load(runId) {
        const state = states.get(runId);
        return state ? clone(state) : null;
      },
      list() {
        return [...states.values()].map(clone);
      },
      delete(runId) {
        return states.delete(runId);
      },
      acquireRunLease(runId) {
        acquired.push(runId);
        return { runId, token: `${runId}-lease` };
      },
      releaseRunLease(lease) {
        released.push(lease.runId);
      },
      getRunsDir() {
        return "/memory/runs";
      },
    },
  };
}

test(
  "createRunPersistence creates runs directory on first save",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.equal(existsSync(runsDir), false, "dir should not exist yet");
    rp.save({
      runId: "test-1",
      workflowName: "demo",
      script: "export const meta = { name: 'd', description: 'd' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.ok(existsSync(runsDir), "dir should be created");
    assert.ok(existsSync(join(runsDir, "test-1.json")), "run file should exist");
    assert.equal(existsSync(join(cwd, WORKFLOW_RUNS_DIR)), false, "legacy project runs dir should not be created");
  }),
);

test(
  "createRunPersistence writes under an explicit persistence root and remains fsOverride-compatible",
  withTempCwd(async (cwd) => {
    const persistenceRoot = mkdtempSync(join(tmpdir(), "ap-dw-root-"));
    const writePaths: string[] = [];
    try {
      const rp = createRunPersistence(
        cwd,
        {
          writeFileSync: ((path: Parameters<typeof writeFileSync>[0], data: Parameters<typeof writeFileSync>[1]) => {
            writePaths.push(String(path));
            return writeFileSync(path, data);
          }) as typeof writeFileSync,
        },
        { persistenceRoot },
      );
      rp.save({
        runId: "custom-root",
        workflowName: "demo",
        script: "export const meta = { name: 'd', description: 'd' }",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const runsDir = workflowProjectPaths(cwd, { persistenceRoot }).runsDir;
      assert.ok(existsSync(join(runsDir, "custom-root.json")), "run file should land under explicit root");
      assert.ok(writePaths.length > 0, "fsOverride should still observe writes");
      assert.ok(writePaths.every((path) => path.startsWith(runsDir)), "fsOverride writes should target explicit root");
      assert.equal(existsSync(workflowProjectPaths(cwd).runsDir), false, "homedir default should not receive files");
    } finally {
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  }),
);

test(
  "createRunPersistence uses AGENTPRISM_PERSISTENCE_ROOT when no explicit root is supplied",
  withTempCwd(async (cwd) => {
    const persistenceRoot = mkdtempSync(join(tmpdir(), "ap-dw-root-env-"));
    const prior = process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
    try {
      process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV] = persistenceRoot;
      const rp = createRunPersistence(cwd);
      rp.save({
        runId: "env-root",
        workflowName: "demo",
        script: "export const meta = { name: 'd', description: 'd' }",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.ok(
        existsSync(join(workflowProjectPaths(cwd, { persistenceRoot }).runsDir, "env-root.json")),
        "run file should land under env root",
      );
    } finally {
      if (prior === undefined) delete process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
      else process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV] = prior;
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  }),
);

test(
  "WorkflowManager rejects a relative persistence root",
  withTempCwd(async (cwd) => {
    assert.throws(
      () => new WorkflowManager({ cwd, persistenceRoot: "relative-root" }),
      /persistenceRoot.*absolute/,
    );
  }),
);

test(
  "WorkflowManager resolves persistence root once for run state and logs",
  withTempCwd(async (cwd) => {
    const constructionRoot = mkdtempSync(join(tmpdir(), "ap-dw-root-once-a-"));
    const mutatedRoot = mkdtempSync(join(tmpdir(), "ap-dw-root-once-b-"));
    try {
      process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV] = constructionRoot;
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(prompt: string) {
            return `ok:${prompt}`;
          },
        },
      });
      process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV] = mutatedRoot;

      const result = await manager.runSync(loggingScript);

      const constructionRunsDir = workflowProjectPaths(cwd, { persistenceRoot: constructionRoot }).runsDir;
      const mutatedRunsDir = workflowProjectPaths(cwd, { persistenceRoot: mutatedRoot }).runsDir;
      assert.equal(result.status, "completed");
      assert.equal(existsSync(join(constructionRunsDir, `${result.runId}.json`)), true, "run state uses construction root");
      assert.equal(existsSync(join(constructionRunsDir, `${result.runId}.log`)), true, "logs use construction root");
      assert.equal(existsSync(join(mutatedRunsDir, `${result.runId}.json`)), false, "mutated env gets no run state");
      assert.equal(existsSync(join(mutatedRunsDir, `${result.runId}.log`)), false, "mutated env gets no logs");
    } finally {
      rmSync(constructionRoot, { recursive: true, force: true });
      rmSync(mutatedRoot, { recursive: true, force: true });
    }
  }),
);

test(
  "pre-contract run fixture loads, lists, and resumes with additive fields absent",
  withTempCwd(async (cwd) => {
    const persistenceRoot = mkdtempSync(join(tmpdir(), "ap-dw-old-fixture-"));
    try {
      const fixture = JSON.parse(
        readFileSync(join(import.meta.dirname, "fixtures", "pre-contract-run.json"), "utf8"),
      ) as PersistedRunState;
      const persistence = createRunPersistence(cwd, undefined, { persistenceRoot });
      persistence.save(fixture);
      const loaded = persistence.load(fixture.runId);
      assert.equal(loaded?.calls, undefined);
      assert.equal(loaded?.limits, undefined);
      assert.equal(loaded?.runtime, undefined);
      assert.equal(loaded?.resume, undefined);
      assert.equal(persistence.list().some((run) => run.runId === fixture.runId), true);

      const manager = new WorkflowManager({
        cwd,
        persistenceRoot,
        agent: { async run() { return "fresh"; } },
      });
      const resumed = await manager.resumeInBackground(fixture.runId);
      assert.equal(resumed.accepted, true);
      if (!resumed.accepted) assert.fail("old fixture remains resumable");
      const result = await resumed.promise;
      assert.equal(result.status, "completed");
      assert.equal(result.result, "fresh");
      assert.equal(persistence.load(fixture.runId)?.legacyResume, true);
      assert.equal(persistence.load(fixture.runId)?.resume, undefined);
    } finally {
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  }),
);

test(
  "run persistence round-trips every PR3 run and agent field",
  withTempCwd(async (cwd) => {
    const persistence = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "pr3-parity",
      workflowName: "parity",
      script: "export const meta = { name: 'parity', description: 'parity' }\nreturn 1",
      args: { input: true },
      argsUnreplayable: true,
      cwd: "/override",
      effectiveCwd: "/effective",
      runtime: { node: "v24.1.0", v8: "13.6.1", pathFormat: 1, inputsFormat: 1 },
      environment: { key: "environment" },
      status: "completed",
      phases: [],
      agents: [
        {
          id: 1,
          label: "agent",
          prompt: "prompt",
          status: "done",
          resultPreview: "result",
          tokens: 5,
          callIndex: 0,
          scope: "pr3-parity",
          usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0.1 },
          provenance: { source: "live", overrideModel: "candidate" },
        },
      ],
      logs: [],
      journal: [
        {
          index: 0,
          hash: "hash",
          result: "result",
          kind: "agent",
          usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0.1 },
          scope: "pr3-parity",
        },
      ],
      calls: [
        {
          index: 0,
          kind: "agent",
          hash: "hash",
          outcome: "result",
          origin: "runner",
          attempts: 1,
          budgetDebit: 5,
          settlementOrdinal: 1,
          scope: "pr3-parity",
        },
      ],
      callsAllocated: 1,
      limits: { maxAgents: 10, tokenBudget: null, concurrency: 2, agentRetries: 1, agentTimeoutMs: null },
      abortSignaled: true,
      mainModel: "provider/model",
      agentsDir: "/agents",
      nestedWorkflows: true,
      legacyResume: true,
      executionMode: { kind: "isolation", baselineRunId: "baseline" },
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    persistence.save(state);
    assert.deepEqual(persistence.load(state.runId), state);
  }),
);

test(
  "WorkflowManager can use an injected persistence implementation for run state",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const manager = new WorkflowManager({
      cwd,
      persistence: store.persistence,
      agent: {
        async run(prompt: string) {
          return `ok:${prompt}`;
        },
      },
    });

    const result = await manager.runSync(twoAgentScript);
    const persisted = store.persistence.load(result.runId);

    assert.equal(result.status, "completed");
    assert.deepEqual(store.acquired, [result.runId], "run lease is acquired through the injected store");
    assert.deepEqual(store.released, [result.runId], "run lease is released through the injected store");
    assert.ok(store.saves.length >= 3, "initial, journal, and final states are saved");
    assert.equal(persisted?.status, "completed");
    assert.deepEqual(
      persisted?.journal?.map((entry) => entry.index),
      [0, 1],
      "journal entries are persisted through the injected store",
    );
  }),
);

test(
  "WorkflowManager emits journal events in append order with runId",
  withTempCwd(async (cwd) => {
    const seen: Array<{ runId: string; index: number; result: unknown }> = [];
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          return `ok:${prompt}`;
        },
      },
    });
    manager.on("journal", (event: { runId: string; entry: { index: number; result: unknown } }) => {
      seen.push({ runId: event.runId, index: event.entry.index, result: event.entry.result });
    });

    const script = `export const meta = { name: 'journal_events', description: 'journal events' }
const approved = await checkpoint('continue?', { default: 'yes' })
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { approved, a, b }`;
    const result = await manager.runSync(script);

    assert.equal(result.status, "completed");
    assert.deepEqual(
      seen.map((event) => event.index),
      [0, 1, 2],
      "checkpoint and agent journal appends stream in deterministic order",
    );
    assert.ok(seen.every((event) => event.runId === result.runId), "every journal event is stamped with runId");
    assert.deepEqual(
      seen.map((event) => event.result),
      ["yes", "ok:first", "ok:second"],
    );
  }),
);

test(
  "WorkflowManager isolates throwing journal listeners from the run and sibling listeners",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          return `ok:${prompt}`;
        },
      },
    });
    let siblingCalled = false;
    manager.on("journal", () => {
      throw new Error("observer failed");
    });
    manager.on("journal", () => {
      siblingCalled = true;
    });

    const result = await manager.runSync(loggingScript);

    assert.equal(result.status, "completed");
    assert.equal(siblingCalled, true, "sibling listener still receives the journal event");
  }),
);

test(
  "createRunPersistence save and load round-trips correctly",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "roundtrip-1",
      workflowName: "test-wf",
      script: "export const meta = { name: 't', description: 't' }",
      args: { key: "value" },
      status: "running",
      phases: ["Scan", "Report"],
      currentPhase: "Scan",
      agents: [{ id: 1, label: "agent-1", prompt: "do it", status: "running" }],
      logs: ["started", "phase: Scan"],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
    };
    rp.save(state);

    const loaded = rp.load("roundtrip-1");
    assert.ok(loaded, "should load saved state");
    assert.equal(loaded?.runId, "roundtrip-1");
    assert.equal(loaded?.workflowName, "test-wf");
    assert.equal(loaded?.status, "running");
    assert.deepEqual(loaded?.phases, ["Scan", "Report"]);
    assert.equal(loaded?.currentPhase, "Scan");
    assert.equal(loaded?.agents.length, 1);
    assert.equal(loaded?.agents[0].label, "agent-1");
    assert.deepEqual(loaded?.logs, ["started", "phase: Scan"]);
    assert.deepEqual(loaded?.args, { key: "value" });
  }),
);

test(
  "createRunPersistence save updates updatedAt",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "update-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    rp.save(state);
    const before = rp.load("update-test");
    const beforeTime = before?.updatedAt;

    // Small delay so updatedAt changes
    await new Promise((r) => setTimeout(r, 10));

    rp.save({ ...state, status: "running" });
    const after = rp.load("update-test");
    assert.notEqual(after?.updatedAt, beforeTime, "updatedAt should change");
    assert.equal(after?.status, "running");
  }),
);

test(
  "createRunPersistence load returns null for missing run",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const loaded = rp.load("nonexistent");
    assert.equal(loaded, null);
  }),
);

test(
  "createRunPersistence reads legacy project run files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-run.json"),
      JSON.stringify({
        runId: "legacy-run",
        workflowName: "legacy",
        script: "export const meta = { name: 'legacy', description: 'legacy' }",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    const loaded = rp.load("legacy-run");
    assert.equal(loaded?.workflowName, "legacy");
    assert.equal(loaded?.fallbacks, undefined);
    assert.equal(loaded?.checkpointsTaken, undefined);
    assert.equal(
      rp.list().some((run) => run.runId === "legacy-run"),
      true,
    );
  }),
);

test(
  "createRunPersistence list returns runs sorted by updatedAt descending",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    // Save with explicit updatedAt values to guarantee order
    // (save() overwrites updatedAt, so we need to write files directly)
    const runsDir = workflowProjectPaths(cwd).runsDir;
    mkdirSync(runsDir, { recursive: true });
    const makeFile = (runId: string, date: string) => {
      writeFileSync(
        join(runsDir, `${runId}.json`),
        JSON.stringify({
          runId,
          workflowName: `wf-${runId}`,
          script: "export const meta = { name: 'w', description: 'w' }",
          status: "completed",
          phases: [],
          agents: [],
          logs: [],
          startedAt: date,
          updatedAt: date,
        }),
      );
    };
    makeFile("oldest", "2024-01-01T00:00:00.000Z");
    makeFile("middle", "2024-03-01T00:00:00.000Z");
    makeFile("newest", "2024-06-01T00:00:00.000Z");

    const runs = rp.list();
    assert.equal(runs.length, 3);
    assert.equal(runs[0].runId, "newest");
    assert.equal(runs[1].runId, "middle");
    assert.equal(runs[2].runId, "oldest");
  }),
);

test(
  "createRunPersistence list handles empty state",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runs = rp.list();
    assert.deepEqual(runs, []);
    assert.equal(existsSync(workflowProjectPaths(cwd).runsDir), false, "list should not create the runs dir");
  }),
);

test(
  "createRunPersistence list skips corrupted files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    // Save one valid run
    rp.save({
      runId: "valid",
      workflowName: "v",
      script: "export const meta = { name: 'v', description: 'v' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    // Write a corrupted file
    const runsDir = workflowProjectPaths(cwd).runsDir;
    writeFileSync(join(runsDir, "corrupted.json"), "not valid json{{{");
    writeFileSync(join(runsDir, "empty.json"), "");

    const runs = rp.list();
    assert.equal(runs.length, 1, "should only return valid run");
    assert.equal(runs[0].runId, "valid");
  }),
);

test(
  "createRunPersistence delete removes run and returns true",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "delete-me",
      workflowName: "d",
      script: "export const meta = { name: 'd', description: 'd' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    assert.ok(existsSync(join(workflowProjectPaths(cwd).runsDir, "delete-me.json")), "existsSync() should succeed");
    const deleted = rp.delete("delete-me");
    assert.equal(deleted, true);
    assert.equal(rp.load("delete-me"), null);
  }),
);

test(
  "createRunPersistence retains only content-free lineage after delete and clears it on run-id reuse",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state = {
      runId: "lineage-child",
      workflowName: "lineage",
      script: "secret script content",
      args: { secret: "argument content" },
      resumeSourceRunId: "lineage-root",
      resumeSeed: { format: "identity-v1" as const, sourceRunId: "matcher-parent", candidates: [] },
      status: "paused" as const,
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    rp.save(state);

    assert.equal(rp.delete(state.runId), true);
    const tombstone = rp.loadLineageTombstone?.(state.runId);
    assert.equal(tombstone?.runId, state.runId);
    assert.equal(tombstone?.sourceRunId, "lineage-root");
    assert.equal(typeof tombstone?.deletedAt, "string");
    assert.deepEqual(Object.keys(tombstone ?? {}).sort(), ["deletedAt", "runId", "sourceRunId"]);

    rp.save({ ...state, script: "replacement content" });
    assert.equal(rp.loadLineageTombstone?.(state.runId), null);
  }),
);

test(
  "createRunPersistence delete removes legacy project run files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "delete-legacy.json"),
      JSON.stringify({
        runId: "delete-legacy",
        workflowName: "legacy",
        script: "export const meta = { name: 'legacy', description: 'legacy' }",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    assert.equal(rp.delete("delete-legacy"), true);
    assert.equal(existsSync(join(legacyRunsDir, "delete-legacy.json")), false);
  }),
);

test(
  "createRunPersistence delete returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const deleted = rp.delete("no-such-run");
    assert.equal(deleted, false);
  }),
);

test(
  "createRunPersistence getRunsDir returns the runs directory path",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    assert.equal(rp.getRunsDir(), workflowProjectPaths(cwd).runsDir);
  }),
);

test(
  "createRunPersistence round-trips terminal cause and enriched journals while loading legacy shapes",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "journal-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "paused",
      reason: "checkpoint_required",
      errorCode: WorkflowErrorCode.CHECKPOINT_REQUIRED,
      phases: [],
      agents: [],
      logs: [],
      journal: [
        { index: 0, hash: "abc123", result: { ok: true } },
        {
          index: 1,
          hash: "def456",
          result: { value: 42 },
          call: { kind: "agent", label: "review", phase: "Review", model: "provider/model", backendId: "provider" },
        },
        { index: 2, hash: "ghi789", result: true, call: { kind: "checkpoint", label: "checkpoint", phase: "Review" } },
      ],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    rp.save(state);
    const loaded = rp.load("journal-test");
    assert.equal(loaded?.journal?.length, 3);
    assert.equal(loaded?.journal?.[0].index, 0);
    assert.equal(loaded?.journal?.[0].hash, "abc123");
    assert.deepEqual(loaded?.journal?.[0].result, { ok: true });
    assert.equal(loaded?.journal?.[0].call, undefined, "pre-change entries stay valid");
    assert.equal(loaded?.journal?.[1].call?.kind, "agent");
    assert.equal(loaded?.journal?.[2].call?.kind, "checkpoint");
    assert.equal(loaded?.reason, "checkpoint_required");
    assert.equal(loaded?.errorCode, WorkflowErrorCode.CHECKPOINT_REQUIRED);

    const legacy: PersistedRunState = {
      ...state,
      runId: "journal-legacy",
      journal: [{ index: 0, hash: "legacy", result: true }],
    };
    delete legacy.reason;
    delete legacy.errorCode;
    rp.save(legacy);
    assert.equal(rp.load(legacy.runId)?.reason, undefined);
    assert.equal(rp.load(legacy.runId)?.errorCode, undefined);
  }),
);

test(
  "WorkflowManager persists complete session records for cold restart and journal replay",
  withTempCwd(async (cwd) => {
    const ref: AgentSessionRef = {
      sessionId: "session-cold-restart",
      backendId: "custom-acp",
      cwd,
      reopen: { load: true, resume: false, list: true },
    };
    let liveCalls = 0;
    const writer = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string, options: Record<string, any> = {}): Promise<string> {
          liveCalls += 1;
          options.onSessionOpen?.(ref);
          return `live:${prompt}`;
        },
      },
    });

    const original = await writer.runSync(persistedSessionScript);
    assert.equal(original.status, "completed");
    assert.equal(liveCalls, 1);

    let replayCalls = 0;
    const fresh = new WorkflowManager({
      cwd,
      agent: {
        async run(): Promise<string> {
          replayCalls += 1;
          return "unexpected live replay";
        },
      },
    });
    const persisted = fresh.listRuns().find((run) => run.runId === original.runId);
    assert.ok(persisted, "a fresh manager loads the completed run from persisted storage");

    const expected: AgentSessionRecord = {
      ...ref,
      callIndex: 0,
      label: "recovery-agent",
      phase: "Recovery",
      keptOpen: true,
    };
    const persistedAgentSession: AgentSessionRecord | undefined = persisted.agents[0]?.session;
    const persistedJournalSession: AgentSessionRecord | undefined = persisted.journal?.[0]?.session;
    assert.deepEqual(persistedAgentSession, expected, "the agent snapshot preserves every session field");
    assert.deepEqual(persistedJournalSession, expected, "the journal preserves every session field");
    assert.deepEqual(fresh.getPersistedAgentSessions(original.runId), [expected]);
    assert.equal(fresh.getPersistedAgentSessions("unknown-run"), undefined);

    const noSession = await writer.runSync(noSessionScript);
    assert.equal(noSession.status, "completed");
    assert.deepEqual(
      fresh.getPersistedAgentSessions(noSession.runId),
      [],
      "legacy/no-session runs produce an empty hand-off",
    );

    assert.ok(persisted.journal);
    const replayed = await fresh.runSync(persistedSessionScript, undefined, {
      resumeJournal: new Map(persisted.journal.map((entry) => [entry.index, entry] as const)),
    });
    assert.equal(replayed.status, "completed");
    assert.equal(replayCalls, 0, "a matching persisted journal prevents a live agent call");
    assert.deepEqual(replayed.agentSessions, [expected], "journal replay restores the persisted session record as-is");
  }),
);

test("WorkflowManager derives persisted sessions from agents first, then missing journal records", () => {
  const store = memoryPersistence();
  const agentSession: AgentSessionRecord = {
    sessionId: "agent-session",
    backendId: "claude",
    cwd: "/work",
    reopen: { load: true, resume: true, list: true },
    callIndex: 2,
    label: "agent-copy",
    keptOpen: true,
  };
  const duplicateJournalSession: AgentSessionRecord = {
    ...agentSession,
    sessionId: "journal-duplicate",
    label: "journal-copy",
  };
  const journalOnlySession: AgentSessionRecord = {
    sessionId: "journal-only",
    backendId: "codex",
    cwd: "/work",
    reopen: { load: true, resume: false, list: true },
    callIndex: 0,
    label: "journal-only",
    keptOpen: false,
  };
  store.persistence.save({
    runId: "session-merge",
    workflowName: "session-merge",
    script: "export const meta = { name: 'session-merge', description: 'session merge' }\nreturn null",
    status: "completed",
    phases: [],
    agents: [
      {
        id: 1,
        label: "agent-copy",
        prompt: "agent",
        status: "done",
        session: agentSession,
      },
    ],
    logs: [],
    journal: [
      { index: 2, hash: "duplicate", result: "agent", session: duplicateJournalSession },
      { index: 0, hash: "journal-only", result: "journal", session: journalOnlySession },
    ],
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  });

  const manager = new WorkflowManager({ persistence: store.persistence });
  assert.deepEqual(manager.getPersistedAgentSessions("session-merge"), [journalOnlySession, agentSession]);
});

test(
  "createRunPersistence save and load preserves token usage",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "tokens",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      tokenUsage: { input: 100, output: 50, total: 150 },
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const loaded = rp.load("tokens");
    assert.deepEqual(loaded?.tokenUsage, { input: 100, output: 50, total: 150 });
  }),
);

test(
  "createRunPersistence save and load preserves completedAt and durationMs",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "timing",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:01:00.000Z",
      durationMs: 60000,
    });
    const loaded = rp.load("timing");
    assert.equal(loaded?.completedAt, "2024-01-01T00:01:00.000Z");
    assert.equal(loaded?.durationMs, 60000);
  }),
);

test("generateRunId returns a string with timestamp and random parts", () => {
  const id = generateRunId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 5, "run id should have reasonable length");
  assert.ok(id.includes("-"), "run id should have separator");
});

test("generateRunId produces unique ids", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
  assert.equal(ids.size, 100, "all 100 generated ids should be unique");
});

test(
  "createRunPersistence save throws ENOSPC when disk is full",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      writeFileSync: () => {
        const err = new Error("ENOSPC: no space left on device");
        (err as { code?: string }).code = "ENOSPC";
        throw err;
      },
    });

    const state: PersistedRunState = {
      runId: "enospc-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.throws(
      () => rp.save(state),
      (err: unknown) => (err as { code?: string }).code === "ENOSPC",
    );
  }),
);

test(
  "createRunPersistence save throws EACCES when permission denied",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      writeFileSync: () => {
        const err = new Error("EACCES: permission denied");
        (err as { code?: string }).code = "EACCES";
        throw err;
      },
    });

    const state: PersistedRunState = {
      runId: "eacces-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.throws(
      () => rp.save(state),
      (err: unknown) => (err as { code?: string }).code === "EACCES",
    );
  }),
);

test(
  "createRunPersistence list returns empty array when directory is unreadable",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      readdirSync: () => {
        throw new Error("EACCES: permission denied, scandir");
      },
    });

    const runs = rp.list();
    assert.deepEqual(runs, []);
  }),
);

test(
  "createRunPersistence concurrent save and load returns consistent data",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);

    const state: PersistedRunState = {
      runId: "concurrent-test",
      workflowName: "test-wf",
      script: "export const meta = { name: 't', description: 't' }",
      args: { items: [1, 2, 3] },
      status: "running",
      phases: ["Scan", "Analyze", "Report"],
      currentPhase: "Analyze",
      agents: [
        { id: 1, label: "agent-a", prompt: "scan", status: "done", result: { found: true } },
        { id: 2, label: "agent-b", prompt: "analyze", status: "running" },
      ],
      logs: ["started", "phase: Scan", "phase: Analyze"],
      tokenUsage: { input: 500, output: 200, total: 700 },
      journal: [{ index: 0, hash: "abc", result: { ok: true } }],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: undefined,
    };

    rp.save(state);
    const loaded = rp.load("concurrent-test");

    assert.ok(loaded, "should load immediately after save");
    assert.equal(loaded.runId, state.runId);
    assert.equal(loaded.workflowName, state.workflowName);
    assert.equal(loaded.status, "running");
    assert.equal(loaded.currentPhase, "Analyze");
    assert.deepEqual(loaded.args, { items: [1, 2, 3] });
    assert.deepEqual(loaded.phases, ["Scan", "Analyze", "Report"]);
    assert.equal(loaded.agents.length, 2);
    assert.deepEqual(loaded.agents[0].result, { found: true });
    assert.equal(loaded.agents[1].status, "running");
    assert.deepEqual(loaded.logs, ["started", "phase: Scan", "phase: Analyze"]);
    assert.deepEqual(loaded.tokenUsage, { input: 500, output: 200, total: 700 });
    assert.deepEqual(loaded.journal, [{ index: 0, hash: "abc", result: { ok: true } }]);
  }),
);

// ─── crash-safe durable resume ───────────────────────────────────────────────

test(
  "save writes the primary plus a .bak (atomic temp+rename leaves no .tmp)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "running",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.ok(existsSync(join(runsDir, "r1.json")), "primary written");
    assert.ok(existsSync(join(runsDir, "r1.json.bak")), ".bak written");
    assert.equal(existsSync(join(runsDir, "r1.json.tmp")), false, "no leftover .tmp");
  }),
);

test(
  "load recovers from .bak when the primary is corrupt",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "running",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    // Corrupt the primary; the .bak from the good save should still load.
    writeFileSync(join(workflowProjectPaths(cwd).runsDir, "r1.json"), "{ truncated", "utf-8");
    const loaded = rp.load("r1");
    assert.equal(loaded?.runId, "r1", "load falls back to the intact .bak");
  }),
);

test(
  "delete removes the .bak sidecar too",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    rp.delete("r1");
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.equal(existsSync(join(runsDir, "r1.json")), false);
    assert.equal(existsSync(join(runsDir, "r1.json.bak")), false, ".bak cleaned up");
  }),
);

test(
  "persistence round-trips cost and cache fields in tokenUsage",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "tu",
      workflowName: "w",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      tokenUsage: { input: 1, output: 2, total: 3, cost: 0.5, cacheRead: 9, cacheWrite: 4 },
    } as PersistedRunState);
    const loaded = rp.load("tu");
    assert.equal(loaded?.tokenUsage?.cost, 0.5, "cost survives reload");
    assert.equal(loaded?.tokenUsage?.cacheRead, 9, "cacheRead survives reload");
    assert.equal(loaded?.tokenUsage?.cacheWrite, 4, "cacheWrite survives reload");
  }),
);

test(
  "run lease creates an exclusive lock and releases only with the owner token",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const lease = rp.acquireRunLease("lease-1");
    assert.ok(lease, "first acquire should succeed");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")), true, "lock file is created");

    const second = rp.acquireRunLease("lease-1");
    assert.equal(second, null, "second acquire should be refused while owner pid is alive");

    rp.releaseRunLease({ ...lease, token: "wrong-token" });
    assert.equal(
      existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")),
      true,
      "wrong token does not release",
    );

    rp.releaseRunLease(lease);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")), false, "owner token releases");
  }),
);

test(
  "run lease refuses while a legacy project lock owner is alive",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-live.lock"),
      JSON.stringify({
        runId: "legacy-live",
        runPath: join(legacyRunsDir, "legacy-live.json"),
        pid: process.pid,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-owner",
      }),
      "utf-8",
    );

    assert.equal(rp.acquireRunLease("legacy-live"), null);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "legacy-live.lock")), false);
  }),
);

test(
  "run lease removes a stale legacy project lock before acquiring the new lock",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    const primaryRunsDir = workflowProjectPaths(cwd).runsDir;
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-stale.lock"),
      JSON.stringify({
        runId: "legacy-stale",
        runPath: join(legacyRunsDir, "legacy-stale.json"),
        pid: 2147483647,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-stale",
      }),
      "utf-8",
    );

    const lease = rp.acquireRunLease("legacy-stale");
    assert.ok(lease, "dead-pid legacy lock should not block the new owner");
    assert.equal(existsSync(join(legacyRunsDir, "legacy-stale.lock")), false);
    assert.equal(existsSync(join(primaryRunsDir, "legacy-stale.lock")), true);
    rp.releaseRunLease(lease);
  }),
);

test(
  "run lease steals a stale lock whose pid is dead",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    rp.save({
      runId: "stale-lock",
      workflowName: "w",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);

    writeFileSync(
      join(runsDir, "stale-lock.lock"),
      JSON.stringify({
        runId: "stale-lock",
        runPath: join(runsDir, "stale-lock.json"),
        pid: 2147483647,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "stale",
      }),
      "utf-8",
    );

    const lease = rp.acquireRunLease("stale-lock");
    assert.ok(lease, "dead-pid lock should be stolen");
    assert.equal(lease.recoveredOwnerPid, 2147483647);
    const lock = JSON.parse(readFileSync(join(runsDir, "stale-lock.lock"), "utf-8")) as { token: string };
    assert.equal(lock.token, lease.token, "stale lock is replaced by the new owner");
    rp.releaseRunLease(lease);
  }),
);

test(
  "run lease removes corrupt locks and preserves live and EPERM owners",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;

    rp.save(persistedRun("corrupt-lock", "running"));
    writeFileSync(join(runsDir, "corrupt-lock.lock"), "{not-json", "utf8");
    const corruptLease = rp.acquireRunLease("corrupt-lock");
    assert.ok(corruptLease);
    assert.equal(corruptLease.recoveredOwnerPid, undefined);
    rp.releaseRunLease(corruptLease);

    rp.save(persistedRun("live-lock", "running"));
    const liveLease = rp.acquireRunLease("live-lock");
    assert.ok(liveLease);
    assert.equal(rp.acquireRunLease("live-lock"), null, "the current live PID remains authoritative");
    rp.releaseRunLease(liveLease);

    const epermPid = 2147483001;
    rp.save(persistedRun("eperm-lock", "running"));
    writeFileSync(
      join(runsDir, "eperm-lock.lock"),
      JSON.stringify({
        runId: "eperm-lock",
        runPath: join(runsDir, "eperm-lock.json"),
        pid: epermPid,
        startedAt: "2026-01-01T00:00:00.000Z",
        token: "eperm-owner",
      }),
      "utf8",
    );
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === epermPid && signal === 0) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      assert.equal(rp.acquireRunLease("eperm-lock"), null, "EPERM means the owner may be alive");
      assert.equal(existsSync(join(runsDir, "eperm-lock.lock")), true);
    } finally {
      process.kill = originalKill;
      rp.releaseRunLease({ runId: "eperm-lock", token: "eperm-owner" });
    }
  }),
);

test(
  "delete removes the lock sidecar too",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "delete-lock",
      workflowName: "w",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    const lease = rp.acquireRunLease("delete-lock");
    assert.ok(lease, "lease exists before delete");
    rp.delete("delete-lock");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "delete-lock.lock")), false, "lock cleaned up");
  }),
);

test(
  "WorkflowManager reconciles a stale 'running' run to 'paused' on construction",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      ...persistedRun("stale", "running"),
      resumeSourceRunId: "ancestor",
    };
    state.args = { preserve: true };
    state.tokenUsage = { input: 1, output: 2, total: 3 };
    state.eventStreamId = "0123456789abcdef0123456789abcdef";
    state.eventSeq = 7;
    state.agents = [{
      id: 1,
      label: "preserved-agent",
      prompt: "preserve",
      status: "running",
      session: {
        sessionId: "preserved-session",
        backendId: "custom",
        reopen: { load: true, resume: true, list: true },
        callIndex: 0,
        label: "preserved-agent",
        keptOpen: true,
      },
    }];
    state.journal = [{ index: 0, hash: "preserved-hash", result: "cached", scope: "stale" }];
    state.calls = [{
      index: 0,
      kind: "agent",
      hash: "preserved-hash",
      outcome: "result",
      origin: "runner",
      scope: "stale",
    }];
    state.callsAllocated = 1;
    rp.save(state);
    const before = rp.load("stale");
    const runsDir = workflowProjectPaths(cwd).runsDir;
    writeFileSync(
      join(runsDir, "stale.lock"),
      JSON.stringify({
        runId: "stale",
        runPath: join(runsDir, "stale.json"),
        pid: 2147483647,
        startedAt: "2026-01-01T00:00:00.000Z",
        token: "dead-owner",
      }),
      "utf8",
    );
    // A fresh manager (the previous process died) should recover the orphan.
    new WorkflowManager({ cwd });
    const recovered = rp.load("stale");
    assert.equal(recovered?.status, "paused", "stale running -> paused (journal preserved for resume)");
    assert.equal(recovered?.pauseReason, "interrupted");
    assert.match(recovered?.reason ?? "", /owning process PID 2147483647 exited/);
    assert.equal(existsSync(join(runsDir, "stale.lock")), false);
    const recoveryFields = new Set(["status", "pauseReason", "reason", "updatedAt"]);
    assert.deepEqual(
      Object.fromEntries(Object.entries(recovered ?? {}).filter(([key]) => !recoveryFields.has(key))),
      Object.fromEntries(Object.entries(before ?? {}).filter(([key]) => !recoveryFields.has(key))),
      "recovery preserves every field outside its status vocabulary and write timestamp",
    );
  }),
);

test(
  "lazy inspect and list reconcile missing and corrupt locks once while live owners remain running",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;

    rp.save(persistedRun("late-missing", "running"));
    const inspected = manager.inspectRun("late-missing");
    assert.equal(inspected?.status, "paused");
    assert.equal(inspected?.reason?.includes("PID unavailable"), true);
    assert.equal(rp.load("late-missing")?.pauseReason, "interrupted");
    const firstUpdatedAt = rp.load("late-missing")?.updatedAt;
    manager.inspectRun("late-missing");
    manager.listRuns();
    assert.equal(rp.load("late-missing")?.updatedAt, firstUpdatedAt, "reconciliation is idempotent");

    rp.save(persistedRun("late-corrupt", "pending"));
    writeFileSync(join(runsDir, "late-corrupt.lock"), "not-json", "utf8");
    const corrupt = manager.listRuns().find((run) => run.runId === "late-corrupt");
    assert.equal(corrupt?.status, "paused");
    assert.equal(corrupt?.pauseReason, "interrupted");
    assert.equal(existsSync(join(runsDir, "late-corrupt.lock")), false);

    rp.save(persistedRun("late-live", "running"));
    const liveLease = rp.acquireRunLease("late-live");
    assert.ok(liveLease);
    assert.equal(manager.inspectRun("late-live")?.status, "running");
    assert.equal(rp.load("late-live")?.pauseReason, undefined);
    assert.equal(existsSync(join(runsDir, "late-live.lock")), true);
    rp.releaseRunLease(liveLease);

    for (const pauseReason of ["auth_required", "usage_limit", "checkpoint_required"]) {
      const runId = `preserved-${pauseReason}`;
      const paused = { ...persistedRun(runId, "paused"), pauseReason };
      rp.save(paused);
      const before = rp.load(runId);
      assert.equal(manager.listRuns().find((run) => run.runId === runId)?.pauseReason, pauseReason);
      assert.deepEqual(rp.load(runId), before, `${pauseReason} pauses are never swept`);
    }
  }),
);

test("WorkflowManager recovery reloads under the lease so concurrent completion wins", () => {
  let state = persistedRun("completion-wins", "running");
  let saveCalls = 0;
  let releaseCalls = 0;
  const persistence: RunPersistence = {
    save(next) {
      saveCalls++;
      state = structuredClone(next);
    },
    load(runId) {
      return runId === state.runId ? structuredClone(state) : null;
    },
    list() {
      return [structuredClone(state)];
    },
    delete() {
      return false;
    },
    acquireRunLease(runId) {
      state = { ...state, status: "completed", result: "concurrent-winner" };
      return { runId, token: "completion-winner" };
    },
    releaseRunLease() {
      releaseCalls++;
    },
    getRunsDir() {
      return "/memory/runs";
    },
  };

  const manager = new WorkflowManager({ persistence });
  assert.equal(manager.inspectRun(state.runId)?.status, "completed");
  assert.equal(state.result, "concurrent-winner");
  assert.equal(saveCalls, 0, "the stale listed row is never written over the completion");
  assert.equal(releaseCalls, 1);
});

test(
  "WorkflowManager journaling:false never touches persisted run state on construction",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "stale",
      workflowName: "w",
      status: "running",
      script: "export const meta = { name: 'w', description: 'd' }\nawait agent('x',{label:'x'})\nreturn 1",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    // A non-journaling manager (the host keeps its own transcript store) must not rewrite
    // run state that belongs to journaling processes — stale-run recovery is gated off.
    const manager = new WorkflowManager({ cwd, journaling: false });
    assert.equal(rp.load("stale")?.status, "running", "journaling:false leaves persisted runs untouched");
    rp.save(persistedRun("late-stale", "pending"));
    assert.equal(manager.inspectRun("late-stale")?.status, "pending");
    assert.equal(manager.listRuns().find((run) => run.runId === "late-stale")?.status, "pending");
    assert.equal(rp.load("late-stale")?.pauseReason, undefined, "lazy paths also skip reconciliation");
  }),
);

test(
  "WorkflowManager journaling:false writes no journal files and rejects resume clearly",
  withTempCwd(async (cwd) => {
    const journalEvents: number[] = [];
    const manager = new WorkflowManager({
      cwd,
      journaling: false,
      agent: {
        async run(prompt: string) {
          return `ok:${prompt}`;
        },
      },
    });
    manager.on("journal", (event: { entry: { index: number } }) => {
      journalEvents.push(event.entry.index);
    });

    const result = await manager.runSync(twoAgentScript);

    assert.equal(result.status, "completed");
    assert.deepEqual(journalEvents, [0, 1], "journal events still emit when file journaling is disabled");
    assert.equal((result.result as { a?: unknown }).a, "ok:first");
    assert.equal((result.result as { b?: unknown }).b, "ok:second");
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const files = existsSync(runsDir) ? readdirSync(runsDir) : [];
    assert.deepEqual(files, [], "journaling:false should not leave run-state, log, lock, or sidecar files");
    assert.deepEqual(manager.listRuns(), [], "there are no persisted run journals for this run");
    await assert.rejects(() => manager.resume(result.runId), /journaling disabled for this run/);
  }),
);

test(
  "WorkflowManager journaling:false still acquires and releases the run lease",
  withTempCwd(async (cwd) => {
    const agent = deferredAgent();
    const manager = new WorkflowManager({ cwd, journaling: false, agent: agent.runner });

    const { runId, promise } = manager.startInBackground(loggingScript);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const lockPath = join(runsDir, `${runId}.lock`);

    assert.equal(existsSync(lockPath), true, "active non-journaled run still owns a cross-process lock");
    agent.resolve("ok");
    const result = await promise;

    assert.equal(result.status, "completed");
    assert.equal(existsSync(lockPath), false, "lock is released when the non-journaled run settles");
    assert.deepEqual(readdirSync(runsDir), [], "no journal/log files are left behind");
  }),
);

test(
  "WorkflowManager lists per-run journaling:true output under a journaling:false manager",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      journaling: false,
      agent: {
        async run(prompt: string) {
          return `ok:${prompt}`;
        },
      },
    });

    const result = await manager.runSync(twoAgentScript, undefined, { journaling: true });

    assert.equal(result.status, "completed");
    assert.deepEqual(
      manager.listRuns().map((run) => run.runId),
      [result.runId],
      "manager default does not hide persisted per-run journaling:true output",
    );
  }),
);

test(
  "WorkflowManager journaling:false manager still lists other persisted runs",
  withTempCwd(async (cwd) => {
    const writer = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          return `ok:${prompt}`;
        },
      },
    });
    const written = await writer.runSync(loggingScript);

    const manager = new WorkflowManager({ cwd, journaling: false });

    assert.deepEqual(
      manager.listAllRuns().map((run) => run.runId),
      [written.runId],
      "journaling:false controls writes for new runs, not enumeration of existing state",
    );
  }),
);

test(
  "WorkflowManager does not recover a legacy running run while its legacy lock owner is alive",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-live.json"),
      JSON.stringify({
        runId: "legacy-live",
        workflowName: "w",
        status: "running",
        script: "export const meta = { name: 'w', description: 'd' }\nawait agent('x',{label:'x'})\nreturn 1",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );
    writeFileSync(
      join(legacyRunsDir, "legacy-live.lock"),
      JSON.stringify({
        runId: "legacy-live",
        runPath: join(legacyRunsDir, "legacy-live.json"),
        pid: process.pid,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-owner",
      }),
      "utf-8",
    );

    new WorkflowManager({ cwd });

    assert.equal(rp.load("legacy-live")?.status, "running");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "legacy-live.json")), false);
  }),
);

test(
  "WorkflowManager.listRuns is scoped to the bound session and switches with setSessionId",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const run = (runId: string, sessionId: string): PersistedRunState =>
      ({
        runId,
        workflowName: "w",
        status: "completed",
        sessionId,
        phases: [],
        agents: [],
        logs: [],
      }) as PersistedRunState;
    rp.save(run("a", "s1"));
    rp.save(run("b", "s2"));

    const m = new WorkflowManager({ cwd, sessionId: "s1" });
    assert.deepEqual(
      m.listRuns().map((r) => r.runId),
      ["a"],
      "only the bound session's runs are listed",
    );

    m.setSessionId("s2");
    assert.deepEqual(
      m.listRuns().map((r) => r.runId),
      ["b"],
      "switching sessions re-shows that session's runs",
    );

    m.setSessionId(undefined);
    assert.deepEqual(
      m
        .listRuns()
        .map((r) => r.runId)
        .sort(),
      ["a", "b"],
      "unbound lists all runs (legacy/global)",
    );

    // listAllRuns ignores the session binding.
    assert.equal(new WorkflowManager({ cwd, sessionId: "s1" }).listAllRuns().length, 2);
  }),
);

// ─── Per-run cwd (ExecOptions.cwd): worktree-per-run hosts ─────────────────────

const perRunCwdScript = `export const meta = { name: 'per_run_cwd', description: 'per-run cwd demo' }
const a = await agent('first', { label: 'first' })
return { a }`;

test(
  "ExecOptions.cwd threads to agent sessions and persists; run state stays keyed to the manager cwd",
  withTempCwd(async (cwd) => {
    const runCwd = mkdtempSync(join(tmpdir(), "ap-dw-run-cwd-"));
    try {
      const seen: Array<string | undefined> = [];
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(_prompt: string, opts: { cwd?: string } = {}) {
            seen.push(opts.cwd);
            return "ok";
          },
        },
      });
      const result = await manager.runSync(perRunCwdScript, undefined, { cwd: runCwd });
      assert.equal(result.status, "completed");
      assert.deepEqual(seen, [runCwd], "the agent session runs in the per-run cwd");
      // Run STATE is keyed to the MANAGER cwd (survives the per-run directory's deletion),
      // and it carries the per-run cwd for resume.
      const rp = createRunPersistence(cwd);
      assert.equal(rp.load(result.runId)?.cwd, runCwd, "the per-run cwd is persisted with the run");
    } finally {
      rmSync(runCwd, { recursive: true, force: true });
    }
  }),
);

test(
  "resume() re-runs in the run's ORIGINAL per-run cwd, not the manager cwd",
  withTempCwd(async (cwd) => {
    const runCwd = mkdtempSync(join(tmpdir(), "ap-dw-run-cwd-"));
    try {
      let failFirstPass = true;
      const seen: Array<string | undefined> = [];
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(_prompt: string, opts: { cwd?: string } = {}) {
            seen.push(opts.cwd);
            if (failFirstPass) {
              throw new WorkflowError("first pass fails", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
                recoverable: false,
              });
            }
            return "ok";
          },
        },
      });
      manager.on("error", () => {});

      const result = await manager.runSync(perRunCwdScript, undefined, { cwd: runCwd });
      assert.equal(result.status, "failed");

      failFirstPass = false;
      // NOTE: no exec.cwd here — resume must recover it from the persisted run.
      const resumed = await manager.resume(result.runId);
      assert.equal(resumed, true, "failed run should resume");
      const deadline = Date.now() + 5_000;
      while (manager.getRun(result.runId)?.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(manager.getRun(result.runId)?.status, "completed");
      assert.deepEqual(seen, [runCwd, runCwd], "the resumed agent ran in the original per-run cwd");
    } finally {
      rmSync(runCwd, { recursive: true, force: true });
    }
  }),
);

// ─── PR4 (§2.12/§2.13): auth-pause persistence + disk-backed cold-resume re-arm ───────────────

const oneAgentAuthScript = `export const meta = { name: 'auth_persist_demo', description: 'auth persist demo' }
const a = await agent('first', { label: 'first' })
return { a }`;

const authPersistContext = {
  backendId: "codex",
  methods: [
    { id: "api-key", type: "agent" as const, name: "API Key" },
    { id: "chat-gpt", type: "agent" as const, name: "ChatGPT" },
  ],
};

const checkpointPersistContext = {
  callIndex: 1,
  hash: "checkpoint-hash",
  prompt: "Ship this release?",
  kind: "select" as const,
  choices: ["ship", "hold"],
  default: "hold",
};

test(
  "PersistedRunState.checkpointContext round-trips through the real fs persistence layer",
  withTempCwd(async (cwd) => {
    const persistence = createRunPersistence(cwd);
    const runId = generateRunId();
    const now = new Date().toISOString();
    persistence.save({
      runId,
      workflowName: "checkpoint_persist_demo",
      script: oneAgentAuthScript,
      status: "paused",
      pauseReason: "checkpoint_required",
      checkpointContext: checkpointPersistContext,
      phases: [],
      agents: [],
      logs: [],
      journal: [],
      startedAt: now,
      updatedAt: now,
    });

    const loaded = persistence.load(runId);
    assert.equal(loaded?.status, "paused");
    assert.equal(loaded?.pauseReason, "checkpoint_required");
    assert.deepEqual(loaded?.checkpointContext, checkpointPersistContext);
  }),
);

test(
  "PersistedRunState.authContext round-trips through the real fs persistence layer (§2.12)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = generateRunId();
    const now = new Date().toISOString();
    rp.save({
      runId,
      workflowName: "auth_persist_demo",
      script: oneAgentAuthScript,
      status: "paused",
      pauseReason: "auth_required",
      authContext: authPersistContext,
      phases: [],
      agents: [],
      logs: [],
      journal: [],
      startedAt: now,
      updatedAt: now,
    });

    const loaded = rp.load(runId);
    assert.equal(loaded?.status, "paused");
    assert.equal(loaded?.pauseReason, "auth_required");
    assert.equal(loaded?.resetHint, undefined);
    assert.deepEqual(loaded?.authContext, authPersistContext, "the non-secret authContext survives save/load");
  }),
);

test(
  "auth pause persists 'auth_required' + authContext to real disk; a COLD manager re-pauses when canResume is false (§2.13)",
  withTempCwd(async (cwd) => {
    // Manager 1: an AUTH_REQUIRED fault checkpoints the run as paused and writes it to disk.
    const manager1 = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("Authentication required for codex", WorkflowErrorCode.AUTH_REQUIRED, {
            recoverable: false,
            authContext: authPersistContext,
          });
        },
      },
    });
    const paused = await manager1.runSync(oneAgentAuthScript);
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "auth_required");

    // The persisted file on disk carries pauseReason + authContext (no reset hint).
    const rp = createRunPersistence(cwd);
    const onDisk = rp.load(paused.runId);
    assert.equal(onDisk?.pauseReason, "auth_required");
    assert.deepEqual(onDisk?.authContext, authPersistContext);

    // Manager 2 = a fresh ("cold") process: its runner's in-process/spawn-env intent is gone, so
    // auth.canResume returns false → resume re-pauses instead of re-running into the same wall.
    let runCalls = 0;
    const consulted: string[] = [];
    const manager2 = new WorkflowManager({
      cwd,
      agent: {
        auth: {
          canResume(backendId: string): boolean {
            consulted.push(backendId);
            return false;
          },
        },
        async run(prompt: string) {
          runCalls++;
          return `ok:${prompt}`;
        },
      },
    });
    let rePause: { reason?: string; error?: WorkflowError; authContext?: unknown } | undefined;
    manager2.on("paused", (ev: typeof rePause) => {
      rePause = ev;
    });

    const ok = await manager2.resume(paused.runId);
    assert.equal(ok, true, "resume handled the run by re-pausing");
    assert.deepEqual(consulted, ["codex"], "the cold runner's auth.canResume was consulted with the persisted backendId");
    assert.equal(runCalls, 0, "the lost in-process intent means the agent is never re-executed");
    assert.equal(rePause?.reason, "auth_required");
    assert.match(rePause?.error?.message ?? "", /re-supply credentials for codex via runner auth before resuming/);
    assert.deepEqual(rePause?.authContext, authPersistContext);
  }),
);

test(
  "a disk-backed auth pause cold-resumes to completion when canResume is true (§2.13)",
  withTempCwd(async (cwd) => {
    const manager1 = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("Authentication required for codex", WorkflowErrorCode.AUTH_REQUIRED, {
            recoverable: false,
            authContext: authPersistContext,
          });
        },
      },
    });
    const paused = await manager1.runSync(oneAgentAuthScript);
    assert.equal(paused.status, "paused");

    // Manager 2: a disk-backed intent (native store / env re-read by the fresh spawn) survives, so
    // canResume is true and the run proceeds — the fresh runner re-executes and completes clean.
    let runCalls = 0;
    const manager2 = new WorkflowManager({
      cwd,
      agent: {
        auth: {
          canResume(): boolean {
            return true;
          },
        },
        async run(prompt: string) {
          runCalls++;
          return `ok:${prompt}`;
        },
      },
    });

    const ok = await manager2.resume(paused.runId);
    assert.equal(ok, true);
    const deadline = Date.now() + 5_000;
    while (manager2.getRun(paused.runId)?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(manager2.getRun(paused.runId)?.status, "completed", "the disk-backed run resumed to completion");
    assert.ok(runCalls >= 1, "the fresh runner re-executed the run live");
  }),
);
