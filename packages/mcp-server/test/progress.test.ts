import assert from "node:assert/strict";
import test from "node:test";
import type { RunEventLogRecord } from "@automatalabs/shared-types";
import type { PersistedRunState } from "@automatalabs/workflows";
import {
  createAwaitProgressReporter,
  type WorkflowToolExtra,
} from "../src/progress.js";

type ProgressParams = {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
};

function extra(notifications: ProgressParams[], withToken = true): WorkflowToolExtra {
  return {
    signal: new AbortController().signal,
    _meta: withToken ? { progressToken: "await-token" } : undefined,
    sendNotification: async (notification: { params: ProgressParams }) => {
      notifications.push(notification.params);
    },
  } as unknown as WorkflowToolExtra;
}

function snapshot(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId: "root-run",
    workflowName: "progress",
    script: "return 1",
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function record(event: RunEventLogRecord["event"]): RunEventLogRecord {
  return {
    version: 1,
    streamId: "a".repeat(32),
    runId: "root-run",
    seq: 1,
    timestamp: new Date(0).toISOString(),
    event,
    projection: { redacted: false, truncated: false },
  };
}

test("await progress seeds distinct scoped calls and emits only new suffix transitions", async () => {
  const notifications: ProgressParams[] = [];
  const reporter = createAwaitProgressReporter(extra(notifications));
  reporter.seed(snapshot({
    currentPhase: "Explore",
    agents: [
      { id: 0, label: "same", prompt: "root", status: "done", callIndex: 0 },
      { id: 1, label: "same", prompt: "nested", status: "running", scope: "root-run-nested1", callIndex: 0 },
      { id: 2, label: "ignored", prompt: "legacy", status: "done", callIndex: -1 },
    ],
  }));

  reporter.record(record({ type: "phase", runId: "root-run", scope: "root-run", title: "Review" }));
  reporter.record(record({
    type: "agentStart",
    runId: "root-run",
    scope: "root-run-nested1",
    label: "same",
    prompt: "nested",
    callIndex: 0,
  }));
  reporter.record(record({
    type: "agentEnd",
    runId: "root-run",
    scope: "root-run",
    label: "same",
    result: { preview: "done", redacted: false, truncated: false },
    callIndex: 0,
  }));
  reporter.record(record({ type: "paused", runId: "root-run", scope: "root-run" }));
  reporter.record(record({ type: "resumed", runId: "root-run", scope: "root-run" }));
  reporter.record(record({
    type: "agentEnd",
    runId: "root-run",
    scope: "root-run-nested1",
    label: "same",
    result: { preview: "done", redacted: false, truncated: false },
    callIndex: 0,
  }));
  reporter.record(record({
    type: "agentEnd",
    runId: "root-run",
    scope: "root-run-nested2",
    label: "same",
    result: { preview: "done", redacted: false, truncated: false },
    callIndex: 0,
  }));
  reporter.record(record({
    type: "agentEnd",
    runId: "root-run",
    scope: "root-run-nested2",
    label: "same",
    result: { preview: "duplicate", redacted: false, truncated: false },
    callIndex: 0,
  }));
  reporter.record(record({
    type: "agentStart",
    runId: "root-run",
    scope: "root-run",
    label: "next",
    prompt: "next",
    callIndex: 1,
  }));
  reporter.record(record({ type: "phase", runId: "root-run", scope: "root-run", title: "Ship" }));
  await Promise.resolve();

  assert.deepEqual(notifications, [
    { progressToken: "await-token", progress: 1, total: 2, message: "Review" },
    { progressToken: "await-token", progress: 2, total: 2, message: "Review" },
    { progressToken: "await-token", progress: 3, total: 3, message: "Review" },
    { progressToken: "await-token", progress: 3, total: 4, message: "Review" },
    { progressToken: "await-token", progress: 3, total: 4, message: "Ship" },
  ]);
});

test("await progress omits unknown totals and messages and stays silent without a token", async () => {
  const notifications: ProgressParams[] = [];
  const reporter = createAwaitProgressReporter(extra(notifications));
  reporter.seed(snapshot());
  reporter.record(record({ type: "phase", runId: "root-run", scope: "root-run", title: "Plan" }));
  reporter.record(record({
    type: "agentStart",
    runId: "root-run",
    scope: "root-run",
    label: "first",
    prompt: "first",
    callIndex: 0,
  }));

  const untitled: ProgressParams[] = [];
  const beforePhase = createAwaitProgressReporter(extra(untitled));
  beforePhase.seed(snapshot());
  beforePhase.record(record({
    type: "agentStart",
    runId: "root-run",
    scope: "root-run",
    label: "untitled",
    prompt: "untitled",
    callIndex: 0,
  }));

  const silent: ProgressParams[] = [];
  const noToken = createAwaitProgressReporter(extra(silent, false));
  noToken.seed(snapshot({ currentPhase: "Ignored" }));
  noToken.record(record({ type: "phase", runId: "root-run", scope: "root-run", title: "Ignored" }));
  await Promise.resolve();

  assert.deepEqual(notifications, [
    { progressToken: "await-token", progress: 0, message: "Plan" },
    { progressToken: "await-token", progress: 0, total: 1, message: "Plan" },
  ]);
  assert.equal(Object.hasOwn(notifications[0] ?? {}, "total"), false);
  assert.deepEqual(untitled, [{ progressToken: "await-token", progress: 0, total: 1 }]);
  assert.equal(Object.hasOwn(untitled[0] ?? {}, "message"), false);
  assert.deepEqual(silent, []);
});

test("await progress forwards content-bearing agent progress without changing call counters", async () => {
  const notifications: ProgressParams[] = [];
  const reporter = createAwaitProgressReporter(extra(notifications));
  reporter.seed(snapshot({
    currentPhase: "Execute",
    agents: [
      { id: 0, label: "worker", prompt: "work", status: "running", callIndex: 0 },
    ],
  }));

  reporter.record(record({
    type: "agentTranscript",
    runId: "root-run",
    scope: "root-run",
    label: "worker",
    callIndex: 0,
    executionStartSeq: 1,
    entryIndex: 0,
    revision: 0,
    operation: "upsert",
    entry: { role: "assistant", kind: "text", text: "private transcript", timestamp: 0 },
  }));
  reporter.record(record({
    type: "agentProgress",
    runId: "root-run",
    scope: "root-run",
    label: "worker",
    callIndex: 0,
    executionStartSeq: 1,
    turnCount: 1,
    observedEvents: 2,
    coalescedEvents: 1,
    cause: "activity",
    latestText: "checking the implementation",
  }));
  reporter.record(record({
    type: "agentProgress",
    runId: "root-run",
    scope: "root-run",
    label: "worker",
    callIndex: 0,
    executionStartSeq: 1,
    turnCount: 1,
    observedEvents: 3,
    coalescedEvents: 2,
    cause: "activity",
    lastToolName: "typecheck",
  }));
  await Promise.resolve();

  assert.deepEqual(notifications, [
    {
      progressToken: "await-token",
      progress: 0,
      total: 1,
      message: "worker: checking the implementation",
    },
    {
      progressToken: "await-token",
      progress: 0,
      total: 1,
      message: "worker: tool typecheck",
    },
  ]);
});
