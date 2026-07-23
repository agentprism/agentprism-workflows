import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunner, JournalEntry, RunOptions } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  MAX_STRUCTURED_STATUS_BYTES,
  createWorkflowLogTail,
  matchesLabelGlob,
  normalizeInspectionOptions,
  projectWorkflowRunStatus,
} from "../src/run-observability.js";
import type { PersistedRunState, RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

function memoryPersistence() {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const clone = (state: PersistedRunState) => structuredClone(state);
  const persistence: RunPersistence = {
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
  };
  return { persistence, states, saves, acquired, released };
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}

function persisted(runId: string, status: PersistedRunState["status"]): PersistedRunState {
  return {
    runId,
    workflowName: `workflow-${status}`,
    script: "private script",
    args: { private: true },
    cwd: "/private/cwd",
    status,
    phases: ["Declared", "Dynamic"],
    currentPhase: "Dynamic",
    agents: [],
    logs: ["one", "two"],
    journal: [{ index: 0, hash: "private-hash", result: { ok: true } }],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("inspection is live-first, cold-readable, ordered, missing-safe, and read-only", async () => {
  const store = memoryPersistence();
  const held = deferred<unknown>();
  const runner = runnerFrom(async (prompt, options) => {
    options.onModelResolved?.("resolved/model");
    options.onSessionOpen?.({
      sessionId: `private-${prompt}`,
      backendId: "actual-backend",
      cwd: "/private/cwd",
      reopen: { load: true, resume: false, list: true },
    });
    if (prompt === "hold") return held.promise;
    return { prompt, answer: true };
  });
  const manager = new WorkflowManager({ persistence: store.persistence, agent: runner });
  const checkpointOnly = await manager.runSync(
    'export const meta = { name: "checkpoint-metadata", description: "checkpoint", phases: [{ title: "Review" }] };\nphase("Review");\nreturn await checkpoint("continue?", { default: true });',
  );
  assert.deepEqual(store.persistence.load(checkpointOnly.runId)?.journal?.[0]?.call, {
    kind: "checkpoint",
    label: "checkpoint",
    phase: "Review",
  });
  const script = [
    'export const meta = { name: "live", description: "live", phases: [{ title: "Plan" }, { title: "Review" }] };',
    'phase("Plan");',
    'log("planning");',
    'await agent("first", { label: "plan-agent" });',
    'phase("Dynamic");',
    'await agent("hold", { label: "review-agent" });',
    'return "done";',
  ].join("\n");
  const started = manager.startInBackground(script);
  await waitUntil(() => (manager.getRun(started.runId)?.journal.length ?? 0) === 1);

  const beforeSaves = store.saves.length;
  const beforeAcquires = store.acquired.length;
  const live = manager.inspectRun(started.runId);
  assert.equal(live?.status, "running");
  assert.deepEqual(live?.phases, ["Plan", "Review", "Dynamic"]);
  assert.equal(live?.currentPhase, "Dynamic");
  assert.equal(live?.calls[0]?.label, "plan-agent");
  assert.equal(live?.calls[0]?.model, "resolved/model");
  assert.equal(live?.calls[0]?.backendId, "actual-backend");
  assert.equal(live?.calls[0]?.status, undefined, "settled calls carry no in-flight status");
  // The held agent has no journal row yet — it must still be visible as an in-flight call.
  assert.equal(live?.calls.length, 2);
  assert.equal(live?.calls[1]?.label, "review-agent");
  assert.equal(live?.calls[1]?.status, "running");
  assert.equal(store.saves.length, beforeSaves, "inspection does not save");
  assert.equal(store.acquired.length, beforeAcquires, "inspection does not acquire a lease");
  assert.equal(manager.inspectRun("missing-run"), undefined);

  held.resolve({ answer: "done" });
  const completed = await started.promise;
  assert.equal(completed.status, "completed");
  const settled = manager.inspectRun(started.runId);
  assert.equal(settled?.calls.length, 2);
  assert.ok(settled?.calls.every((call) => call.status === undefined), "no in-flight rows after completion");
  assert.equal(completed.logTail, undefined);
  assert.equal("logTail" in completed, false);
  const cold = new WorkflowManager({ persistence: store.persistence, agent: runner }).inspectRun(started.runId);
  assert.equal(cold?.status, "completed");
  assert.deepEqual(cold?.phases, ["Plan", "Review", "Dynamic"]);

  for (const status of ["completed", "paused", "failed"] as const) {
    const fixture = persisted(`cold-${status}`, status);
    fixture.reason = status === "completed" ? undefined : `${status} reason`;
    fixture.errorCode = status === "failed" ? WorkflowErrorCode.SCRIPT_ERROR : undefined;
    store.persistence.save(fixture);
  }
  const fresh = new WorkflowManager({ persistence: store.persistence, agent: runner });
  assert.equal(fresh.inspectRun("cold-completed")?.status, "completed");
  assert.equal(fresh.inspectRun("cold-paused")?.reason, "paused reason");
  assert.equal(fresh.inspectRun("cold-failed")?.errorCode, WorkflowErrorCode.SCRIPT_ERROR);
});

test("in-flight agent calls are projected only while the run is live", () => {
  const base = {
    runId: "run-inflight",
    workflowName: "wf",
    phases: ["Plan"],
    logs: [],
    journal: [],
  };
  const agents = [
    { label: "active", phase: "Plan", status: "running" as const, callIndex: 0 },
    { label: "waiting", status: "queued" as const, callIndex: 1 },
  ];
  const live = projectWorkflowRunStatus({ ...base, status: "running", agents });
  assert.deepEqual(
    live.calls.map((call) => ({ index: call.index, label: call.label, status: call.status })),
    [
      { index: 0, label: "active", status: "running" },
      { index: 1, label: "waiting", status: "queued" },
    ],
  );
  assert.equal(live.truncation.calls.total, 2);

  // A dead run's persisted agent rows can still say "running"; those are stale, not in flight.
  for (const status of ["paused", "completed", "failed", "aborted"] as const) {
    const stale = projectWorkflowRunStatus({ ...base, status, agents });
    assert.deepEqual(stale.calls, [], `${status} run projects no phantom in-flight calls`);
  }
});

test("journal attribution covers agents, checkpoints, synthetic replies, and replay without changing identity", async () => {
  const store = memoryPersistence();
  let calls = 0;
  const runner = runnerFrom((prompt, options) => {
    calls++;
    options.onModelResolved?.("resolved/model");
    options.onSessionOpen?.({
      sessionId: `session-${calls}`,
      backendId: "actual-backend",
      cwd: "/cwd",
      reopen: { load: true, resume: true, list: true },
    });
    return `answer:${prompt}`;
  });
  const manager = new WorkflowManager({ persistence: store.persistence, agent: runner });
  const script = [
    'export const meta = { name: "metadata", description: "metadata", phases: [{ title: "Review" }] };',
    'phase("Review");',
    'const approved = await checkpoint("continue?", { headless: "pause" });',
    'const answer = await agent("work", { label: "reviewer" });',
    'return { approved, answer };',
  ].join("\n");
  const paused = await manager.runSync(script);
  assert.equal(paused.status, "paused");
  const resumed = await manager.resumeInBackground(paused.runId, { checkpointReplies: { 0: "yes" } });
  assert.equal(resumed.accepted, true);
  assert.ok(resumed.promise);
  const result = await resumed.promise;
  assert.equal(result.status, "completed");
  const entries = store.persistence.load(paused.runId)?.journal ?? [];
  assert.deepEqual(entries[0]?.call, { kind: "checkpoint", label: "checkpoint", phase: "Review" });
  assert.deepEqual(entries[1]?.call, {
    kind: "agent",
    label: "reviewer",
    phase: "Review",
    model: "resolved/model",
    backendId: "actual-backend",
  });

  const replayMap = new Map(entries.map((entry) => [entry.index, entry] as const));
  const replayRunner = runnerFrom(() => {
    assert.fail("a matching enriched journal entry must replay without invoking the runner");
  });
  const replayed = await new WorkflowManager({ persistence: memoryPersistence().persistence, agent: replayRunner }).runSync(
    script,
    undefined,
    { resumeJournal: replayMap },
  );
  assert.equal(replayed.status, "completed");
  assert.equal(calls, 1);
});

test("label glob is Unicode-aware, case-sensitive, whole-label, escaped, and applied before lastN", () => {
  for (const [label, glob, expected] of [
    ["review-alpha", "review-*", true],
    ["Review-alpha", "review-*", false],
    ["review-a", "review-?", true],
    ["review-ab", "review-?", false],
    ["review-*", "review-\\*", true],
    ["review-x", "review-\\*", false],
    ["emoji-😀", "emoji-?", true],
    ["path\\", "path\\", true],
    ["x-review-alpha", "review-*", false],
  ] as const) {
    assert.equal(matchesLabelGlob(label, glob), expected, `${glob} against ${label}`);
  }
  assert.deepEqual(normalizeInspectionOptions(), { lastN: 20, logLines: 20, labelGlob: undefined });
  for (const options of [
    { lastN: 0 },
    { lastN: 1.5 },
    { logLines: -1 },
    { logLines: 51 },
    { labelGlob: "" },
    { labelGlob: "😀".repeat(129) },
  ]) {
    assert.throws(() => normalizeInspectionOptions(options), RangeError);
  }

  const session = {
    sessionId: "private-session",
    backendId: "legacy-backend",
    cwd: "/private",
    reopen: { load: true, resume: false, list: false },
    callIndex: 3,
    label: "review-legacy",
    phase: "Legacy",
    keptOpen: false,
  };
  const journal: JournalEntry[] = [
    { index: 9, hash: "9", result: 9, call: { kind: "agent", label: "review-nine" } },
    { index: 2, hash: "2", result: 2, call: { kind: "agent", label: "other" } },
    { index: 7, hash: "7", result: 7, call: { kind: "agent", label: "review-seven" } },
    { index: 4, hash: "4", result: true, call: { kind: "checkpoint", label: "checkpoint" } },
    { index: 5, hash: "5", result: "unknown" },
    { index: 3, hash: "3", result: "legacy", session },
  ];
  const status = projectWorkflowRunStatus(
    { runId: "a-b", status: "running", workflowName: "glob", phases: [], logs: [], journal },
    { labelGlob: "review-*", lastN: 2 },
  );
  assert.deepEqual(
    status.calls.map((call) => call.index),
    [7, 9],
    "filtering precedes latest-N selection and output is chronological",
  );
  assert.equal(status.truncation.calls.total, 6);
  assert.equal(status.truncation.calls.matched, 3, "legacy session attribution is honestly matched");
  const legacy = projectWorkflowRunStatus(
    { runId: "a-b", status: "running", workflowName: "legacy", phases: [], logs: [], journal },
    { lastN: 50 },
  ).calls.find((call) => call.index === 3);
  assert.deepEqual(
    { kind: legacy?.kind, label: legacy?.label, phase: legacy?.phase, backendId: legacy?.backendId },
    { kind: "agent", label: "review-legacy", phase: "Legacy", backendId: "legacy-backend" },
  );
});

test("projection structurally compacts and redacts every credential form and never exposes raw persisted fields", () => {
  const opaque = "abcd1234".repeat(4);
  const result = {
    password: "plain-password",
    nested: {
      api_key: "plain-api-key",
      assignment: "authorization=plain-assignment",
      bearer: "Bearer abcdefghijklmnop",
      basic: "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
      url: "https://user:pass@example.com/path",
      jwt: "abc.def.ghi",
      pem: "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
      prefix: "github_pat_abcdefgh12345678",
      opaque,
    },
    array: Array.from({ length: 12 }, (_, index) => ({ index })),
    deep: { one: { two: { three: { four: "hidden" } } } },
    ...Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`key${index}`, index])),
  };
  const source = {
    runId: "safe-run",
    status: "failed" as const,
    workflowName: "secret=workflow-password",
    phases: ["Bearer phasecredential123"],
    currentPhase: "https://user:pass@example.com",
    reason: `token=${opaque}`,
    errorCode: WorkflowErrorCode.SCRIPT_ERROR,
    logs: [`xoxb-abcdefgh12345678 ${opaque}`],
    journal: [
      {
        index: 0,
        hash: "private-hash-never-returned",
        result,
        session: {
          sessionId: "private-session-never-returned",
          backendId: "backend",
          cwd: "/private/cwd-never-returned",
          reopen: { load: true, resume: true, list: true },
          callIndex: 0,
          label: "label",
          keptOpen: false,
        },
      },
    ],
    script: "private-script-never-returned",
    args: "private-args-never-returned",
    history: "private-history-never-returned",
    prompt: "private-prompt-never-returned",
  };
  const status = projectWorkflowRunStatus(source);
  const serialized = JSON.stringify(status);
  for (const secret of [
    "plain-password",
    "plain-api-key",
    "plain-assignment",
    "abcdefghijklmnop",
    "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
    "user:pass",
    "abc.def.ghi",
    "private-material",
    "github_pat_abcdefgh12345678",
    opaque,
    "private-hash-never-returned",
    "private-session-never-returned",
    "/private/cwd-never-returned",
    "private-script-never-returned",
    "private-args-never-returned",
    "private-history-never-returned",
    "private-prompt-never-returned",
  ]) {
    assert.equal(serialized.includes(secret), false, `must not expose ${secret}`);
  }
  assert.equal(status.calls[0]?.resultRedacted, true);
  assert.equal(status.calls[0]?.resultTruncated, true);
  assert.equal(status.logTail.redactedLines, 1);
  assert.equal(status.truncation.calls.redactedResults, 1);
  assert.equal(status.truncation.calls.shortenedResults, 1);
});

test("multibyte previews and the whole structured status obey deterministic hard byte budgets", () => {
  const journal: JournalEntry[] = Array.from({ length: 50 }, (_, index) => ({
    index,
    hash: `hash-${index}`,
    result: { index, text: "😀".repeat(1_000), values: Array.from({ length: 20 }, (_, item) => item) },
    call: { kind: "agent", label: `call-${index}-${"l".repeat(600)}` },
  }));
  const logs = Array.from({ length: 50 }, (_, index) => `log-${index}-${"😀".repeat(1_000)}`);
  const phases = Array.from({ length: 70 }, (_, index) => `phase-${index}-${"😀".repeat(1_000)}`);
  const status = projectWorkflowRunStatus(
    { runId: "large-run", status: "running", workflowName: "large", phases, logs, journal },
    { lastN: 50, logLines: 50 },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(status), "utf8") <= MAX_STRUCTURED_STATUS_BYTES);
  assert.equal(status.truncation.byteCapApplied, true);
  assert.equal(status.truncation.phases.total, 70);
  assert.equal(status.truncation.logs.total, 50);
  assert.equal(status.truncation.calls.total, 50);
  assert.equal(status.truncation.phases.returned, status.phases.length);
  assert.equal(status.truncation.logs.returned, status.logTail.lines.length);
  assert.equal(status.truncation.calls.returned, status.calls.length);
  assert.equal(status.logTail.omittedLines, 50 - status.logTail.lines.length);
  assert.equal(status.truncation.logs.redacted, 0);
  assert.equal(status.truncation.calls.redactedResults, 0);
  assert.ok(status.phases.at(-1)?.startsWith("phase-69-"), "the newest phase survives oldest-first removal");
  if (status.logTail.lines.length > 0) assert.ok(status.logTail.lines.at(-1)?.startsWith("log-49-"));
  if (status.calls.length > 0) assert.equal(status.calls.at(-1)?.index, 49);
  for (const scalar of [
    ...status.phases,
    ...status.logTail.lines,
    ...status.calls.map((call) => call.resultPreview),
  ]) {
    assert.ok(Buffer.byteLength(scalar, "utf8") <= 512);
    assert.equal(Buffer.from(scalar, "utf8").toString("utf8"), scalar, "truncation preserves valid UTF-8");
  }
  const preview = projectWorkflowRunStatus({
    runId: "preview-run",
    status: "completed",
    workflowName: "preview",
    phases: [],
    logs: [],
    journal: [journal[49]!],
  }).calls[0]?.resultPreview;
  assert.ok(preview?.endsWith("…[truncated]"));
});

test("terminal results get exact redacted final-20 tails while completed results retain only full logs", async () => {
  const token = "ghp_abcdefgh12345678";
  const admissionLog =
    "agent timeout admission: host ceiling none total wall-clock per attempt; each retry re-arms the clock";
  const loggingPrefix =
    'for (let i = 1; i <= 25; i++) log(i === 10 ? `line-${i} ghp_abcdefgh12345678` : i === 11 ? `line-${i} ${"😀".repeat(1000)}` : `line-${i}`);';
  const manager = new WorkflowManager({ persistence: memoryPersistence().persistence, agent: runnerFrom(() => "ok") });
  const paused = await manager.runSync(
    `export const meta = { name: "paused", description: "paused" };\n${loggingPrefix}\nawait checkpoint("q", { headless: "pause" });`,
  );
  assert.equal(paused.status, "paused");
  assert.equal(paused.logs.length, 26, "the compatibility logs remain complete and raw");
  assert.equal(paused.logs[0], admissionLog);
  assert.equal(paused.logs[10]?.includes(token), true);
  assert.equal(paused.logTail?.lines.length, 20);
  assert.equal(paused.logTail?.lines[0], "line-6");
  assert.equal(paused.logTail?.lines.at(-1), "line-25");
  assert.equal(paused.logTail?.omittedLines, 6);
  assert.equal(paused.logTail?.redactedLines, 1);
  assert.equal(paused.logTail?.truncatedLines, 1);
  assert.equal(paused.logTail?.lines.some((line) => line.includes(token)), false);

  const failed = await manager.runSync(
    `export const meta = { name: "failed", description: "failed" };\n${loggingPrefix}\nthrow new Error("boom");`,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.logTail?.lines.length, 20);
  assert.equal(failed.logTail?.lines[0], "line-6");

  const empty = await manager.runSync(
    'export const meta = { name: "empty", description: "empty" };\nthrow new Error("empty failure");',
  );
  assert.deepEqual(empty.logTail, createWorkflowLogTail([admissionLog], 20));

  const controller = new AbortController();
  const entered = deferred<void>();
  const blocked = deferred<unknown>();
  const abortManager = new WorkflowManager({
    persistence: memoryPersistence().persistence,
    agent: runnerFrom(async () => {
      entered.resolve(undefined);
      return blocked.promise;
    }),
  });
  const abortPromise = abortManager.runSync(
    `export const meta = { name: "aborted", description: "aborted" };\n${loggingPrefix}\nawait agent("hold");`,
    undefined,
    { signal: controller.signal },
  );
  await entered.promise;
  controller.abort();
  blocked.resolve("ignored");
  const aborted = await abortPromise;
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.logTail?.lines[0], "line-6");

  const completed = await manager.runSync(
    `export const meta = { name: "completed", description: "completed" };\n${loggingPrefix}\nreturn true;`,
  );
  assert.deepEqual(
    completed.logs.slice(1, 26),
    Array.from({ length: 25 }, (_, index) =>
      index === 9
        ? `line-${index + 1} ghp_abcdefgh12345678`
        : index === 10
          ? `line-${index + 1} ${"😀".repeat(1000)}`
          : `line-${index + 1}`,
    ),
  );
  assert.equal(completed.logs[0], admissionLog);
  assert.equal(completed.logTail, undefined);
  assert.equal("logTail" in completed, false);
});

test("terminal cause persistence supports new and legacy records", () => {
  const store = memoryPersistence();
  const current = persisted("cause-current", "failed");
  current.reason = "actual failure";
  current.errorCode = WorkflowErrorCode.SCRIPT_ERROR;
  current.journal = [
    { index: 0, hash: "hash", result: true, call: { kind: "checkpoint", label: "checkpoint", phase: "Review" } },
  ];
  store.persistence.save(current);
  const roundTrip = store.persistence.load(current.runId);
  assert.equal(roundTrip?.reason, "actual failure");
  assert.equal(roundTrip?.errorCode, WorkflowErrorCode.SCRIPT_ERROR);
  assert.equal(roundTrip?.journal?.[0]?.call?.kind, "checkpoint");

  const legacy = persisted("cause-legacy", "paused");
  legacy.pauseReason = "usage_limit";
  delete legacy.reason;
  delete legacy.errorCode;
  store.persistence.save(legacy);
  const inspected = new WorkflowManager({ persistence: store.persistence, agent: runnerFrom(() => "ok") }).inspectRun(
    legacy.runId,
  );
  assert.equal(inspected?.reason, "usage_limit");
  assert.equal(inspected?.errorCode, undefined);
});

test("failure reasons persist the actual WorkflowError message and code", async () => {
  const store = memoryPersistence();
  const manager = new WorkflowManager({
    persistence: store.persistence,
    agent: runnerFrom(() => {
      throw new WorkflowError("FAIL-CLOSED at review", WorkflowErrorCode.SCRIPT_ERROR, { recoverable: false });
    }),
  });
  const result = await manager.runSync(
    'export const meta = { name: "failure", description: "failure" };\nawait agent("fail");',
  );
  assert.equal(result.status, "failed");
  assert.equal(store.persistence.load(result.runId)?.reason, "FAIL-CLOSED at review");
  assert.equal(store.persistence.load(result.runId)?.errorCode, WorkflowErrorCode.SCRIPT_ERROR);
});
