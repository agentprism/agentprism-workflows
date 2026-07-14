import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunner, AgentUsage, JournalEntry, RunOptions } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";

function memoryPersistence() {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const clone = (state: PersistedRunState) => structuredClone(state);
  const persistence: RunPersistence = {
    save(state) {
      const copy = clone(state);
      states.set(state.runId, copy);
      saves.push(copy);
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
      return { runId, token: `${runId}-lease` };
    },
    releaseRunLease() {},
    getRunsDir() {
      return "/memory/runs";
    },
  };
  return { persistence, states, saves };
}

function runnerFrom(impl: (prompt: string, options: RunOptions) => unknown | Promise<unknown>): AgentRunner {
  return { run: (prompt: string, options?: RunOptions) => Promise.resolve(impl(prompt, options ?? {})) } as AgentRunner;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

const TWO_AGENT_SCRIPT = [
  'export const meta = { name: "usage-live", description: "usage" };',
  'const first = await agent("first", { label: "first" });',
  'const second = await agent("second", { label: "second" });',
  "return { first, second };",
].join("\n");

test("live attempts emit fresh cumulative usage snapshots and persist them before settlement", async () => {
  const second = deferred<string>();
  let calls = 0;
  const usageByCall: AgentUsage[] = [
    { input: 10, output: 5, total: 15, cost: 0.1, cacheRead: 3, cacheWrite: 1 },
    { input: 20, output: 7, total: 27, cost: 0.2, cacheRead: 4, cacheWrite: 2 },
  ];
  const runner = runnerFrom(async (_prompt, options) => {
    const index = calls++;
    options.onUsage?.(usageByCall[index]);
    return index === 0 ? "first-result" : await second.promise;
  });
  const directSnapshots: number[] = [];
  const directSecond = deferred<string>();
  let directCalls = 0;
  const directRun = runWorkflow(TWO_AGENT_SCRIPT, {
    agent: runnerFrom(async (_prompt, options) => {
      const index = directCalls++;
      options.onUsage?.(usageByCall[index]);
      return index === 0 ? "first-result" : await directSecond.promise;
    }),
    persistLogs: false,
    onTokenUsage: (usage) => directSnapshots.push(usage.total),
  });
  await waitUntil(() => directCalls === 2, "direct workflow did not reach the second agent");
  assert.deepEqual(directSnapshots, [15]);
  directSecond.resolve("second-result");
  const directResult = await directRun;
  assert.deepEqual(directSnapshots, [15, 42, 42], "live attempts plus the unchanged final snapshot are emitted");
  assert.equal(directResult.tokenUsage.total, 42);

  const store = memoryPersistence();
  const manager = new WorkflowManager({ persistence: store.persistence, agent: runner });
  const managerSnapshots: number[] = [];
  manager.on("tokenUsage", (event: { usage: { total: number } }) => managerSnapshots.push(event.usage.total));
  const started = manager.startInBackground(TWO_AGENT_SCRIPT);
  await waitUntil(() => calls === 2, "managed workflow did not reach the second agent");
  assert.equal(manager.getSnapshot(started.runId)?.tokenUsage?.total, 15);
  assert.equal(store.persistence.load(started.runId)?.tokenUsage?.total, 15);
  second.resolve("second-result");
  const result = await started.promise;
  assert.deepEqual(managerSnapshots, [15, 42, 42]);
  assert.equal(manager.getSnapshot(started.runId)?.tokenUsage?.total, 42);
  assert.deepEqual(result.tokenUsage, {
    input: 30,
    output: 12,
    total: 42,
    cost: 0.30000000000000004,
    cacheRead: 7,
    cacheWrite: 3,
  });
  assert.equal(new WorkflowManager({ persistence: store.persistence, agent: runner }).getPersistence().load(started.runId)?.tokenUsage?.total, 42);
});

test("usage includes estimates, failed retries, provider/auth pauses, and terminal failures", async () => {
  const estimateSnapshots: number[] = [];
  const estimated = await runWorkflow(
    'export const meta = { name: "estimate", description: "estimate" }; return await agent("estimate me");',
    {
      agent: runnerFrom(() => "estimated result"),
      persistLogs: false,
      onTokenUsage: (usage) => estimateSnapshots.push(usage.total),
    },
  );
  assert.ok(estimateSnapshots[0] > 0);
  assert.equal(estimateSnapshots.at(-1), estimated.tokenUsage.total);

  let retryCalls = 0;
  const retrySnapshots: number[] = [];
  const retried = await runWorkflow(
    'export const meta = { name: "retry-usage", description: "retry" }; return await agent("retry", { retries: 1 });',
    {
      agent: runnerFrom((_prompt, options) => {
        retryCalls++;
        options.onUsage?.({ input: 2, output: 1, total: 3, cost: 0.01, cacheRead: 0, cacheWrite: 0 });
        if (retryCalls === 1) {
          throw new WorkflowError("retry", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
        }
        return "ok";
      }),
      persistLogs: false,
      onTokenUsage: (usage) => retrySnapshots.push(usage.total),
    },
  );
  assert.deepEqual(retrySnapshots, [3, 6, 6]);
  assert.equal(retried.tokenUsage.total, 6);

  for (const fixture of [
    { code: WorkflowErrorCode.PROVIDER_USAGE_LIMIT, status: "paused" },
    { code: WorkflowErrorCode.AUTH_REQUIRED, status: "paused" },
    { code: WorkflowErrorCode.SCRIPT_ERROR, status: "failed" },
  ] as const) {
    const store = memoryPersistence();
    const manager = new WorkflowManager({
      persistence: store.persistence,
      agent: runnerFrom((_prompt, options) => {
        options.onUsage?.({ input: 8, output: 2, total: 10, cost: 0.5, cacheRead: 1, cacheWrite: 0 });
        throw new WorkflowError("terminal", fixture.code, { recoverable: false });
      }),
    });
    const result = await manager.runSync(
      'export const meta = { name: "terminal-usage", description: "terminal" }; return await agent("stop");',
    );
    assert.equal(result.status, fixture.status);
    assert.equal(result.tokenUsage?.total, 10);
    assert.equal(store.persistence.load(result.runId)?.tokenUsage?.total, 10);
    assert.equal(new WorkflowManager({ persistence: store.persistence }).getPersistence().load(result.runId)?.tokenUsage?.cost, 0.5);
  }
});

test("replay contributes no usage and background journal seeding survives a multi-hop checkpoint resume", async () => {
  const store = memoryPersistence();
  let sourceCalls = 0;
  const sourceManager = new WorkflowManager({
    persistence: store.persistence,
    agent: runnerFrom((prompt) => {
      sourceCalls++;
      return `source:${prompt}`;
    }),
  });
  const script = [
    'export const meta = { name: "multi-hop", description: "multi hop", phases: [{ title: "Work" }] };',
    'phase("Work");',
    'const values = [];',
    'for (let i = 0; i < args.count; i++) values.push(await agent(`call-${i}`, { label: `call-${i}` }));',
    'if (args.pause) values.push(await checkpoint("ship?", { headless: "pause", kind: "confirm" }));',
    "return values;",
  ].join("\n");
  const source = await sourceManager.runSync(script, { count: 10, pause: false });
  assert.equal(source.status, "completed");
  assert.equal(sourceCalls, 10);
  const sourceJournal = store.persistence.load(source.runId)?.journal ?? [];
  assert.deepEqual(sourceJournal.map((entry) => entry.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const liveMiss = deferred<string>();
  let childCalls = 0;
  let childJournalEvents = 0;
  const childManager = new WorkflowManager({
    persistence: store.persistence,
    agent: runnerFrom(async (prompt) => {
      childCalls++;
      return await liveMiss.promise.then(() => `child:${prompt}`);
    }),
  });
  childManager.on("journal", () => childJournalEvents++);
  const child = childManager.startInBackground(script, { count: 11, pause: true }, {
    resumeJournal: new Map(sourceJournal.map((entry) => [entry.index, entry] as const)),
  });
  assert.deepEqual(
    store.persistence.load(child.runId)?.journal?.map((entry) => entry.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    "the fail-fast initial save contains the entire inherited prefix",
  );
  await waitUntil(() => childCalls === 1, "the child did not reach its only live miss");
  assert.equal(childManager.getSnapshot(child.runId)?.tokenUsage, undefined, "cached calls add no usage");
  liveMiss.resolve("ready");
  await assert.rejects(child.promise, (error: unknown) => {
    return error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED;
  });
  assert.equal(childJournalEvents, 1, "replay never re-fires onAgentJournal");
  const childPersisted = store.persistence.load(child.runId);
  assert.deepEqual(childPersisted?.journal?.map((entry) => entry.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(childManager.getSnapshot(child.runId)?.tokenUsage?.total, childPersisted?.tokenUsage?.total);

  const checkpoint = childPersisted?.checkpointContext;
  assert.ok(checkpoint);
  const synthetic: JournalEntry = {
    index: checkpoint.callIndex,
    hash: checkpoint.hash,
    result: true,
    call: { kind: "checkpoint", label: "checkpoint", phase: childPersisted?.currentPhase },
  };
  const thirdJournal = new Map(
    [...(childPersisted?.journal ?? [])].reverse().map((entry) => [entry.index, entry] as const),
  );
  thirdJournal.set(synthetic.index, synthetic);
  let thirdCalls = 0;
  const thirdManager = new WorkflowManager({
    persistence: store.persistence,
    agent: runnerFrom(() => {
      thirdCalls++;
      return "unexpected";
    }),
  });
  let thirdJournalEvents = 0;
  thirdManager.on("journal", () => thirdJournalEvents++);
  const third = thirdManager.startInBackground(script, { count: 11, pause: true }, { resumeJournal: thirdJournal });
  assert.deepEqual(
    store.persistence.load(third.runId)?.journal?.map((entry) => entry.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "sorted inherited agents and the synthetic checkpoint are durable before execution",
  );
  const completed = await third.promise;
  assert.equal(completed.status, "completed");
  assert.equal(thirdCalls, 0);
  assert.equal(thirdJournalEvents, 0);
  assert.equal(completed.tokenUsage?.total, 0);
});
