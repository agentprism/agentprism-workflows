import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner, AgentHistoryEntry, RunOptions } from "@automatalabs/shared-types";
import { WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";

const workflow = (options = "") => [
  'export const meta = { name: "agent-timeout", description: "timeout coverage" };',
  `return await agent("stream forever", { label: "streaming"${options ? `, ${options}` : ""} });`,
].join("\n");

function streamingAbortIgnoringRunner(): {
  runner: AgentRunner;
  starts: number[];
  aborts: number[];
  emissions: () => number;
  cleanup: () => void;
} {
  const starts: number[] = [];
  const aborts: number[] = [];
  const intervals = new Set<NodeJS.Timeout>();
  let emitted = 0;
  const runner = {
    run(_prompt: string, options?: RunOptions) {
      starts.push(Date.now());
      const history: AgentHistoryEntry[] = [{ role: "assistant", kind: "text", text: "still working" }];
      const interval = setInterval(() => {
        emitted++;
        options?.onHistory?.(history);
      }, 2);
      interval.unref?.();
      intervals.add(interval);
      options?.signal?.addEventListener("abort", () => {
        aborts.push(Date.now());
        // Deliberately do not resolve or reject the runner promise. The engine's wall-clock
        // race must settle independently even while this attempt ignores cancellation.
        const cleanup = setTimeout(() => {
          clearInterval(interval);
          intervals.delete(interval);
        }, 20);
        cleanup.unref?.();
      }, { once: true });
      return new Promise<string>(() => {});
    },
  } as AgentRunner;
  return {
    runner,
    starts,
    aborts,
    emissions: () => emitted,
    cleanup: () => {
      for (const interval of intervals) clearInterval(interval);
      intervals.clear();
    },
  };
}

function memoryPersistence(): {
  persistence: RunPersistence;
  load: (runId: string) => PersistedRunState | null;
  cleanup: () => void;
} {
  const states = new Map<string, PersistedRunState>();
  const runsDir = mkdtempSync(join(tmpdir(), "agent-timeout-runs-"));
  const clone = (state: PersistedRunState): PersistedRunState => structuredClone(state);
  const persistence: RunPersistence = {
    save(state) {
      states.set(state.runId, clone(state));
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
      return runsDir;
    },
  };
  return {
    persistence,
    load: (runId) => persistence.load(runId),
    cleanup: () => rmSync(runsDir, { recursive: true, force: true }),
  };
}

test("a streaming abort-ignoring runner settles at the engine wall-clock cap", async () => {
  const streaming = streamingAbortIgnoringRunner();
  const starts: Array<number | null | undefined> = [];
  const ends: Array<{ errorCode?: WorkflowErrorCode; recoverable?: boolean }> = [];
  const startedAt = Date.now();
  try {
    const result = await runWorkflow(workflow(), {
      agent: streaming.runner,
      agentTimeoutMs: 30,
      persistLogs: false,
      onAgentStart: (event) => starts.push(event.timeoutMs),
      onAgentEnd: (event) => ends.push(event),
    });

    assert.equal(result.result, null);
    assert.ok(Date.now() - startedAt >= 20, "the wall-clock timer, not activity, settles the attempt");
    assert.ok(Date.now() - startedAt < 1_000, "an ignored abort cannot strand engine settlement");
    assert.deepEqual(starts, [30]);
    assert.equal(streaming.starts.length, 1);
    assert.equal(streaming.aborts.length, 1);
    assert.ok(streaming.emissions() > 0, "the runner remained actively streaming before the cap");
    assert.equal(result.calls?.[0]?.outcome, "null");
    assert.equal(result.calls?.[0]?.error?.code, WorkflowErrorCode.AGENT_TIMEOUT);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.errorCode, WorkflowErrorCode.AGENT_TIMEOUT);
    assert.equal(ends[0]?.recoverable, true);
    assert.equal(
      result.logs.filter((line) =>
        line.includes("total-wall ceiling 30ms; idle ceiling disabled; each retry re-arms both clocks")
      ).length,
      1,
    );
  } finally {
    streaming.cleanup();
  }
});

test("agentRetries re-arms a fresh bounded clock for every attempt", async () => {
  const streaming = streamingAbortIgnoringRunner();
  const startedAt = Date.now();
  try {
    const result = await runWorkflow(workflow(), {
      agent: streaming.runner,
      agentRetries: 1,
      agentTimeoutMs: 25,
      persistLogs: false,
    });

    const elapsed = Date.now() - startedAt;
    assert.equal(result.result, null);
    assert.equal(streaming.starts.length, 2);
    assert.equal(streaming.aborts.length, 2);
    assert.ok(streaming.starts[1]! - streaming.starts[0]! >= 15, "attempt two received a fresh clock");
    assert.ok(elapsed >= 35, "both attempt clocks fired");
    assert.ok(elapsed < 1_000, "the retry ladder remained bounded");
    assert.equal(result.calls?.[0]?.attempts, 2);
    assert.equal(result.calls?.[0]?.error?.code, WorkflowErrorCode.AGENT_TIMEOUT);
  } finally {
    streaming.cleanup();
  }
});

test("the host timeout is a ceiling and per-call timeoutMs can only tighten it", async () => {
  const cases = [
    { name: "finite host and omitted call", host: 40, call: "", expected: 40 },
    { name: "finite host and null call", host: 40, call: "timeoutMs: null", expected: 40 },
    { name: "finite host and shorter call", host: 40, call: "timeoutMs: 7", expected: 7 },
    { name: "finite host and longer call", host: 40, call: "timeoutMs: 90", expected: 40 },
    { name: "null host and omitted call", host: null, call: "", expected: null },
    { name: "null host and null call", host: null, call: "timeoutMs: null", expected: null },
    { name: "null host and finite call", host: null, call: "timeoutMs: 7", expected: 7 },
  ] as const;

  for (const fixture of cases) {
    const observed: Array<number | null | undefined> = [];
    const result = await runWorkflow(workflow(fixture.call), {
      agentTimeoutMs: fixture.host,
      agent: { async run() { return "ok"; } },
      persistLogs: false,
      onAgentStart: (event) => observed.push(event.timeoutMs),
    });
    assert.equal(result.result, "ok", fixture.name);
    assert.deepEqual(observed, [fixture.expected], fixture.name);
  }
});

test("WorkflowManager.startInBackground persists and inspects timeout limits and AGENT_TIMEOUT", async () => {
  const streaming = streamingAbortIgnoringRunner();
  const store = memoryPersistence();
  const manager = new WorkflowManager({ persistence: store.persistence, agent: streaming.runner });
  try {
    const started = manager.startInBackground(workflow(), undefined, {
      agentTimeoutMs: 30,
      agentRetries: 0,
      concurrency: 2,
    });
    const result = await started.promise;

    assert.equal(result.status, "completed");
    assert.equal(result.result, null);
    assert.deepEqual(result.effectiveLimits, {
      maxAgents: 1000,
      concurrency: 2,
      agentRetries: 0,
      agentTimeoutMs: 30,
      agentIdleTimeoutMs: null,
    });
    const status = manager.inspectRun(started.runId, { lastN: 10, logLines: 10 });
    assert.deepEqual(status?.limits, result.effectiveLimits);
    assert.equal(status?.calls.length, 1);
    assert.equal(status?.calls[0]?.label, "streaming");
    assert.equal(status?.calls[0]?.timeoutMs, 30);
    assert.equal(status?.calls[0]?.errorCode, WorkflowErrorCode.AGENT_TIMEOUT);

    const persisted = store.load(started.runId);
    assert.equal(persisted?.agents[0]?.timeoutMs, 30);
    assert.equal(persisted?.agents[0]?.errorCode, WorkflowErrorCode.AGENT_TIMEOUT);
    assert.deepEqual(persisted?.limits, result.effectiveLimits);
  } finally {
    streaming.cleanup();
    store.cleanup();
  }
});
