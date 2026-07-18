import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRunner, WorkflowCallRecord, WorkflowResumeCallDecision } from "@automatalabs/shared-types";
import {
  CALL_INPUTS_FORMAT,
  CALL_PATH_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  RESUME_CALL_FAILED_REASONS,
  RESUME_CALL_LIVE_REASONS,
  RESUME_DISABLED_REASONS,
  RESUME_FALLBACK_REASONS,
} from "../src/index.js";
import type {
  PersistedCheckpointInjection,
  PersistedResumeCandidate,
  PersistedResumeFormat,
  PersistedResumeSeed,
  PersistedRunState,
  PreparedResume,
  WorkflowRunOptions,
} from "../src/index.js";

const HASH = "a".repeat(64);

const sourceCall: WorkflowCallRecord = {
  index: 3,
  kind: "agent",
  hash: HASH,
  path: "workflow.js:3:1",
  inputsHash: HASH,
  outcome: "result",
  origin: "runner",
  budgetDebit: 8,
  resumeSafety: "declared-read-only",
  scope: "source-run",
};
const candidate: PersistedResumeCandidate = {
  sourceRunId: "source-run",
  recordedIndex: 3,
  entry: {
    index: 3,
    hash: HASH,
    result: "cached",
    kind: "agent",
    scope: "source-run",
  },
  call: sourceCall,
  logicalBudgetDebit: 8,
};
const injection: PersistedCheckpointInjection = {
  sourceRunId: "source-run",
  recordedIndex: 4,
  hash: HASH,
  path: "workflow.js:4:1",
  inputsHash: HASH,
  decision: { accepted: true },
};
const seed: PersistedResumeSeed = {
  format: "identity-v1",
  sourceRunId: "source-run",
  candidates: [candidate],
  checkpointInjections: [injection],
};
const format: PersistedResumeFormat = {
  format: "identity-v1",
  terminalEnvironment: { git: { head: HASH, dirtyDigest: HASH } },
};
const committedSeeds: PersistedResumeSeed[] = [];
const identityPrepared: PreparedResume = {
  strategy: "identity-v1",
  sourceRunId: "source-run",
  requestedPolicy: "auto",
  seed,
  commitSeed: (remaining) => committedSeeds.push(remaining),
};
const positionalPrepared: PreparedResume = {
  strategy: "positional-v1",
  sourceRunId: "source-run",
  requestedPolicy: "positional",
  fallbackReason: "forced-positional",
  eligibility: "safe-prefix",
  sourceCalls: new Map([[sourceCall.index, sourceCall]]),
  checkpoint: { seed, commitSeed: (remaining) => committedSeeds.push(remaining) },
};
const livePrepared: PreparedResume = {
  strategy: "live",
  sourceRunId: "source-run",
  requestedPolicy: "auto",
  disabledReason: "runtime-mismatch",
};

const runner: AgentRunner = {
  async run() {
    return "unused" as never;
  },
};
const decisions: WorkflowResumeCallDecision[] = [];
const activities: number[] = [];
const allocations: number[] = [];
let filesystemTainted = false;
const runOptions: WorkflowRunOptions = {
  agent: runner,
  preparedResume: identityPrepared,
  onResumeFilesystemTainted: () => {
    filesystemTainted = true;
  },
  onResumeActivity: (active) => activities.push(active),
  onResumeCallAllocated: (allocated) => allocations.push(allocated),
  onResumeDecision: (decision) => decisions.push(decision),
};

const legacyState: PersistedRunState = {
  runId: "legacy-run",
  workflowName: "legacy",
  script: "return null",
  status: "completed",
  phases: [],
  agents: [],
  logs: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  runtime: {
    node: "v22.0.0",
    v8: "12.4",
    pathFormat: CALL_PATH_FORMAT,
    inputsFormat: 1,
  },
};
const identityState: PersistedRunState = {
  ...legacyState,
  runId: "identity-run",
  runtime: {
    ...legacyState.runtime!,
    checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
  },
  resume: format,
  resumeSeed: seed,
  resumeReport: {
    strategy: "identity-v1",
    sourceRunId: "source-run",
    requestedPolicy: "auto",
    replayed: 0,
    live: 0,
    failed: 0,
    calls: [],
  },
};

test("incremental resume format constants and frozen reason arrays match the contract", () => {
  assert.equal(CALL_PATH_FORMAT, 1);
  assert.equal(CALL_INPUTS_FORMAT, 2);
  assert.equal(CHECKPOINT_INPUTS_FORMAT, 1);
  assert.deepEqual(RESUME_FALLBACK_REASONS, [
    "legacy-recording",
    "inputs-format-legacy",
    "forced-positional",
    "unsafe-recording",
    "nested-workflows",
    "legacy-resume",
  ]);
  assert.deepEqual(RESUME_DISABLED_REASONS, [
    "unsupported-format",
    "source-not-terminal",
    "abort-residue",
    "isolation-recording",
    "resume-metadata-missing",
    "manifest-invalid",
    "cwd-mismatch",
    "runtime-mismatch",
    "environment-missing",
    "environment-mismatch",
    "source-environment-drift",
    "resume-seed-invalid",
  ]);
  assert.deepEqual(RESUME_CALL_LIVE_REASONS, [
    "strategy-live",
    "positional-miss",
    "positional-suffix",
    "not-recorded",
    "path-missing",
    "inputs-missing",
    "inputs-changed",
    "ambiguous-identity",
    "ambiguous-content",
    "candidate-consumed",
    "empty-output",
    "safety-changed",
    "unsafe-suffix",
    "worktree-degraded",
  ]);
  assert.deepEqual(RESUME_CALL_FAILED_REASONS, [
    "seed-persistence-error",
    "resume-fatal-latch",
  ]);
  for (const reasons of [
    RESUME_FALLBACK_REASONS,
    RESUME_DISABLED_REASONS,
    RESUME_CALL_LIVE_REASONS,
    RESUME_CALL_FAILED_REASONS,
  ]) {
    assert.equal(Object.isFrozen(reasons), true);
  }
});

test("persisted and prepared resume declaration fixtures cover every branch", () => {
  assert.equal(identityState.resume?.terminalEnvironment?.git?.head, HASH);
  assert.equal(identityState.resumeSeed?.checkpointInjections?.[0]?.recordedIndex, 4);
  assert.equal(identityState.runtime?.checkpointInputsFormat, 1);
  assert.equal(identityPrepared.strategy, "identity-v1");
  assert.equal(positionalPrepared.eligibility, "safe-prefix");
  assert.equal(livePrepared.disabledReason, "runtime-mismatch");
  assert.equal(runOptions.preparedResume?.sourceRunId, "source-run");
  identityPrepared.commitSeed(seed);
  runOptions.onResumeFilesystemTainted?.();
  runOptions.onResumeActivity?.(1);
  runOptions.onResumeCallAllocated?.(1);
  runOptions.onResumeDecision?.({
    index: 0,
    kind: "agent",
    action: "live",
    reason: "not-recorded",
  });
  assert.equal(committedSeeds[0], seed);
  assert.equal(filesystemTainted, true);
  assert.deepEqual(activities, [1]);
  assert.deepEqual(allocations, [1]);
  assert.equal(decisions[0]?.reason, "not-recorded");
});

test("legacy persisted state remains valid and omits additive resume fields", () => {
  const json = JSON.parse(JSON.stringify(legacyState)) as PersistedRunState;
  assert.deepEqual(json.runtime, {
    node: "v22.0.0",
    v8: "12.4",
    pathFormat: 1,
    inputsFormat: 1,
  });
  assert.equal(json.runtime?.checkpointInputsFormat, undefined);
  assert.equal(json.runtime?.engineVersion, undefined);
  assert.equal(json.resume, undefined);
  assert.equal(json.resumeSeed, undefined);
  assert.equal(json.resumeReport, undefined);
  assert.equal(json.replayEligibility, undefined);
  assert.equal(Object.hasOwn(json, "resume"), false);
  assert.equal(Object.hasOwn(json, "resumeSeed"), false);
  assert.equal(Object.hasOwn(json, "resumeReport"), false);
});
