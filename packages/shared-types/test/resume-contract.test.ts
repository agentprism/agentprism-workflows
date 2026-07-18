import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  JournalEntry,
  ResumePolicy,
  WorkflowCallRecord,
  WorkflowCallReplayProvenance,
  WorkflowReplayEligibility,
  WorkflowReplayOperationalChange,
  WorkflowResumeCallDecision,
  WorkflowResumeCallFailedReason,
  WorkflowResumeCallLiveReason,
  WorkflowResumeDisabledReason,
  WorkflowResumeFallbackReason,
  WorkflowResumeMatch,
  WorkflowResumeReport,
  WorkflowResumeSafety,
  WorkflowResumeStrategy,
  WorkflowRunResult,
} from "../src/index.js";

const POLICIES = ["auto", "positional"] as const satisfies readonly ResumePolicy[];
const STRATEGIES = ["identity-v1", "positional-v1", "live"] as const satisfies readonly WorkflowResumeStrategy[];
const MATCHES = ["path-hash", "unique-hash", "index-hash"] as const satisfies readonly WorkflowResumeMatch[];
const FALLBACK_REASONS = [
  "legacy-recording",
  "inputs-format-legacy",
  "forced-positional",
  "unsafe-recording",
  "nested-workflows",
  "legacy-resume",
] as const satisfies readonly WorkflowResumeFallbackReason[];
const DISABLED_REASONS = [
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
] as const satisfies readonly WorkflowResumeDisabledReason[];
const CALL_LIVE_REASONS = [
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
] as const satisfies readonly WorkflowResumeCallLiveReason[];
const CALL_FAILED_REASONS = [
  "seed-persistence-error",
  "resume-fatal-latch",
] as const satisfies readonly WorkflowResumeCallFailedReason[];
const SAFETY_CLASSES = [
  "declared-read-only",
  "isolated-worktree",
] as const satisfies readonly WorkflowResumeSafety[];

type AssertNever<T extends never> = T;
type _PoliciesComplete = AssertNever<Exclude<ResumePolicy, (typeof POLICIES)[number]>>;
type _StrategiesComplete = AssertNever<Exclude<WorkflowResumeStrategy, (typeof STRATEGIES)[number]>>;
type _MatchesComplete = AssertNever<Exclude<WorkflowResumeMatch, (typeof MATCHES)[number]>>;
type _FallbackReasonsComplete = AssertNever<
  Exclude<WorkflowResumeFallbackReason, (typeof FALLBACK_REASONS)[number]>
>;
type _DisabledReasonsComplete = AssertNever<
  Exclude<WorkflowResumeDisabledReason, (typeof DISABLED_REASONS)[number]>
>;
type _CallLiveReasonsComplete = AssertNever<
  Exclude<WorkflowResumeCallLiveReason, (typeof CALL_LIVE_REASONS)[number]>
>;
type _CallFailedReasonsComplete = AssertNever<
  Exclude<WorkflowResumeCallFailedReason, (typeof CALL_FAILED_REASONS)[number]>
>;
type _SafetyClassesComplete = AssertNever<Exclude<WorkflowResumeSafety, (typeof SAFETY_CLASSES)[number]>>;

const replayProvenance: WorkflowCallReplayProvenance = {
  sourceRunId: "source-run",
  recordedIndex: 4,
  match: "unique-hash",
  logicalBudgetDebit: 12,
  sourceResumeSafety: "declared-read-only",
};
const checkpointReplayProvenance: WorkflowCallReplayProvenance = {
  sourceRunId: "source-run",
  recordedIndex: 5,
  match: "path-hash",
  checkpointHostDecision: true,
  checkpointInjected: true,
};
const replayedDecision: WorkflowResumeCallDecision = {
  index: 0,
  kind: "agent",
  action: "replayed",
  sourceRunId: "source-run",
  recordedIndex: 4,
  match: "unique-hash",
  logicalBudgetDebit: 12,
};
const liveDecision: WorkflowResumeCallDecision = {
  index: 1,
  kind: "checkpoint",
  action: "live",
  reason: "inputs-changed",
};
const injectedDecision: WorkflowResumeCallDecision = {
  index: 2,
  kind: "checkpoint",
  action: "replayed",
  sourceRunId: "source-run",
  recordedIndex: 5,
  match: "path-hash",
  checkpointInjected: true,
};
const failedDecision: WorkflowResumeCallDecision = {
  index: 3,
  kind: "agent",
  action: "failed",
  reason: "seed-persistence-error",
};
const identityReport: WorkflowResumeReport = {
  strategy: "identity-v1",
  sourceRunId: "source-run",
  requestedPolicy: "auto",
  replayed: 2,
  live: 1,
  failed: 1,
  calls: [replayedDecision, liveDecision, injectedDecision, failedDecision],
};
const positionalReport: WorkflowResumeReport = {
  strategy: "positional-v1",
  sourceRunId: "source-run",
  requestedPolicy: "positional",
  fallbackReason: "forced-positional",
  eligibility: "safe-prefix",
  replayed: 0,
  live: 0,
  failed: 0,
  calls: [],
};
const liveReport: WorkflowResumeReport = {
  strategy: "live",
  sourceRunId: "source-run",
  requestedPolicy: "auto",
  disabledReason: "runtime-mismatch",
  replayed: 0,
  live: 0,
  failed: 0,
  calls: [],
};
const operationalChange: WorkflowReplayOperationalChange = {
  option: "agentTimeoutMs",
  source: 900_000,
  current: null,
  detail: "source recorded agentTimeoutMs=900000; this run: none",
};
const replayEligibility: WorkflowReplayEligibility = {
  strategy: "positional-v1",
  sourceRunId: "source-run",
  fallbackReason: "inputs-format-legacy",
  eligibility: "legacy",
  predictedReplayablePrefix: 2,
  replayedPrefix: 0,
  replayed: 0,
  live: 0,
  failed: 0,
  sourceEngineVersion: "0.26.0",
  currentEngineVersion: "0.27.0",
  engineVersionComparison: "different",
  sourceInputsFormat: 1,
  currentInputsFormat: 2,
  operationalChanges: [operationalChange],
};

const legacyJournal: JournalEntry = { index: 0, hash: "legacy", result: "cached" };
const legacyCall: WorkflowCallRecord = {
  index: 0,
  kind: "agent",
  hash: "legacy",
  outcome: "result",
  origin: "runner",
};
const legacyResult: WorkflowRunResult = {
  runId: "legacy-run",
  status: "completed",
  meta: { name: "legacy", description: "legacy" },
  result: null,
  phases: [],
  agentCount: 0,
  durationMs: 1,
  logs: [],
};
const resumeCall: WorkflowCallRecord = {
  ...legacyCall,
  inputsHash: "checkpoint-or-agent-inputs",
  origin: "journal-replay",
  budgetDebit: 0,
  resumeSafety: "declared-read-only",
  replay: replayProvenance,
};
const resumeResult: WorkflowRunResult = { ...legacyResult, resumeReport: identityReport };

test("incremental resume shared type fixtures cover every public branch", () => {
  assert.deepEqual(POLICIES, ["auto", "positional"]);
  assert.deepEqual(STRATEGIES, ["identity-v1", "positional-v1", "live"]);
  assert.deepEqual(MATCHES, ["path-hash", "unique-hash", "index-hash"]);
  assert.equal(FALLBACK_REASONS.length, 6);
  assert.equal(DISABLED_REASONS.length, 12);
  assert.equal(CALL_LIVE_REASONS.length, 14);
  assert.equal(CALL_FAILED_REASONS.length, 2);
  assert.deepEqual(SAFETY_CLASSES, ["declared-read-only", "isolated-worktree"]);
  assert.equal(resumeCall.replay?.recordedIndex, 4);
  assert.equal(checkpointReplayProvenance.checkpointInjected, true);
  assert.equal(resumeResult.resumeReport?.strategy, "identity-v1");
  assert.equal(positionalReport.eligibility, "safe-prefix");
  assert.equal(liveReport.disabledReason, "runtime-mismatch");
  assert.equal(replayEligibility.fallbackReason, "inputs-format-legacy");
  assert.equal(replayEligibility.predictedReplayablePrefix, 2);
  assert.equal(replayEligibility.operationalChanges[0]?.option, "agentTimeoutMs");
});

test("legacy object literals omit every additive resume field", () => {
  assert.equal(legacyJournal.kind, undefined);
  assert.equal(legacyCall.inputsHash, undefined);
  assert.equal(legacyCall.resumeSafety, undefined);
  assert.equal(legacyCall.replay, undefined);
  assert.equal(legacyResult.resumeReport, undefined);
  assert.equal(legacyResult.replayEligibility, undefined);
  assert.equal(Object.hasOwn(legacyCall, "resumeSafety"), false);
  assert.equal(Object.hasOwn(legacyCall, "replay"), false);
  assert.equal(Object.hasOwn(legacyResult, "resumeReport"), false);
});

interface FutureContract {
  futureResumeContract: { version: number };
}

interface CompatibilityFixture {
  old: {
    journalEntry: JournalEntry;
    workflowCallRecord: WorkflowCallRecord;
    workflowRunResult: WorkflowRunResult;
  };
  future: {
    journalEntry: JournalEntry & FutureContract;
    workflowCallRecord: WorkflowCallRecord & FutureContract;
    workflowRunResult: WorkflowRunResult & FutureContract;
  };
}

test("old JSON contracts parse and unknown future fields remain ignorable", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/incremental-resume-compat.json", import.meta.url), "utf8"),
  ) as CompatibilityFixture;
  const oldJournal: JournalEntry = fixture.old.journalEntry;
  const oldCall: WorkflowCallRecord = fixture.old.workflowCallRecord;
  const oldResult: WorkflowRunResult = fixture.old.workflowRunResult;
  const futureJournal: JournalEntry = fixture.future.journalEntry;
  const futureCall: WorkflowCallRecord = fixture.future.workflowCallRecord;
  const futureResult: WorkflowRunResult = fixture.future.workflowRunResult;

  assert.equal(oldJournal.result, "cached");
  assert.equal(oldCall.replay, undefined);
  assert.equal(oldResult.resumeReport, undefined);
  assert.deepEqual(futureJournal.result, { ok: true });
  assert.equal(futureCall.kind, "checkpoint");
  assert.equal(futureResult.result, true);
  assert.equal(fixture.future.journalEntry.futureResumeContract.version, 2);
  assert.equal(fixture.future.workflowCallRecord.futureResumeContract.version, 2);
  assert.equal(fixture.future.workflowRunResult.futureResumeContract.version, 2);
});
