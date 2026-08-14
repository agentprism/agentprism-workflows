import type {
  AgentResult,
  AgentRunner,
  AgentUsage,
  RunOptions,
  WorkflowBackendConfig,
  WorkflowCallRecord,
  WorkflowRecordedError,
  WorkflowRunResult,
} from "@automatalabs/shared-types";
import { errorMessage, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { captureRunEnvironment } from "./run-environment.js";
import { buildResumeExactIndex, environmentsEqual, resumeExactKey } from "./resume-identity.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedRunState,
} from "./run-persistence.js";
import { deepFreeze } from "./strict-json.js";
import { WorkflowManager } from "./workflow-manager.js";
import {
  CALL_INPUTS_FORMAT,
  CALL_PATH_FORMAT,
  parseWorkflowScript,
  type CheckpointCallContext,
  type CheckpointOptions,
} from "./workflow.js";
import type { WorkflowSnapshot } from "./display.js";

export const RECORDING_UNUSABLE_REASONS = Object.freeze([
  "not-found",
  "corrupt-structure",
  "not-completed",
  "script-invalid",
  "incomplete-manifest",
  "nested-workflow-recording",
  "isolation-artifact",
  "legacy-resume",
  "abort-residue",
  "engine-origin-row",
  "replayed-row",
  "unreplayable-error",
  "args-unreplayable",
  "ambiguous-identity",
  "path-missing",
  "runtime-mismatch",
  "no-limits",
  "agent-limit-boundary",
  "no-budget-trajectory",
  "no-execution-cwd",
  "no-environment-identity",
  "environment-mismatch",
  "journal-manifest-mismatch",
] as const);

export const REPLAY_DIVERGENCE_KINDS = Object.freeze([
  "path-unavailable",
  "nested-workflow-call",
  "identity-reexecuted",
  "target-site-reexecuted",
  "dependent-or-drifted-target",
  "ambiguous-path",
  "unrecorded-call",
  "target-inputs-drift",
  "target-unsettled",
  "candidate-fallback",
  "checkpoint-context-unavailable",
] as const);

type RecordingUnusableReason = (typeof RECORDING_UNUSABLE_REASONS)[number];
type ReplayDivergenceKind = (typeof REPLAY_DIVERGENCE_KINDS)[number];

/** Exactly one selector. */
export type IsolationTarget =
  ({ callIndex: number; label?: never } | { label: string; callIndex?: never }) & {
    model?: string;
  };

export interface ResolvedIsolationTarget {
  recordedIndex: number;
  hash: string;
  path: string;
  inputsHash: string;
  model?: string;
}

export interface ReplayDivergenceEvent {
  kind: ReplayDivergenceKind;
  liveCallIndex?: number;
  path?: string;
  candidateIndexes?: number[];
  detail: string;
}

export interface ReplayCallReport {
  liveIndex: number;
  recordedIndex?: number;
  kind: "agent" | "checkpoint";
  mode: "served" | "live-target";
  hashMatched: boolean;
  label?: string;
  recordedFailure?: boolean;
  recordedError?: WorkflowRecordedError;
  recordedUsage?: AgentUsage;
  liveResult?: unknown;
  liveUsage?: AgentUsage;
  attempts?: number;
  modelRequested?: string;
  overrideModel?: string;
  resolvedModel?: string;
  modelFallbacks?: string[];
  backendId?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  candidateEvidence?: "verified" | "unverified";
}

export interface ReplayReport {
  baselineRunId: string;
  isolationRunId: string;
  targets: ResolvedIsolationTarget[];
  calls: ReplayCallReport[];
  divergence?: ReplayDivergenceEvent;
  unvisitedRecordedIndexes?: number[];
  unreachedTargets?: number[];
  unverifiedTargets?: number[];
  targetUnsettled?: number[];
  finalized: boolean;
  notes: string[];
}

export type ReplayObservation =
  | { target: false }
  | {
      target: true;
      recordedIndex: number;
      outcome: "settled" | "failed" | "diverged";
      remainingTargets: number;
    };

export interface ReplayRunnerOptions {
  recording: PersistedRunState;
  inner: AgentRunner;
  live: IsolationTarget[];
  rootRunId: string;
  executionCwd?: string;
  environmentKey?: string;
}

export interface ReplayRunner extends AgentRunner {
  confirm: (
    promptText: string,
    options: CheckpointOptions,
    context?: CheckpointCallContext,
  ) => Promise<unknown>;
  finalize(outcome?: { scriptCompleted?: boolean }): ReplayReport;
  report(): ReplayReport;
  observeAgentEnd(event: {
    callIndex: number;
    scope: string;
    result: unknown;
    error?: string;
    errorCode?: WorkflowErrorCode;
    errorRecord?: WorkflowRecordedError;
    usage?: AgentUsage;
    modelResolved?: string;
    modelFallbacks?: string[];
    backendId?: string;
  }): ReplayObservation;
}

export interface RunIsolationOptions {
  baselineRunId: string;
  runner: AgentRunner;
  live: IsolationTarget[];
  journaling?: boolean;
  cwd?: string;
  executionCwd?: string;
  persistenceRoot?: string;
  scriptBackends?: Record<string, WorkflowBackendConfig>;
  concurrency?: number;
  agentTimeoutMs?: number | null;
  agentRetries?: number;
  signal?: AbortSignal;
  agentsDir?: string;
  mainModel?: string;
  environmentKey?: string;
  onProgress?: (snapshot: WorkflowSnapshot) => void;
}

export interface IsolationRunResult<T = unknown> {
  status: "completed" | "target-failed" | "diverged" | "failed";
  run?: WorkflowRunResult<T>;
  error?: WorkflowError;
  report: ReplayReport;
}

type PreflightOptions = { executionCwd?: string; environmentKey?: string };
type PreflightResult = { notes: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsage(value: unknown): value is AgentUsage {
  if (!isRecord(value)) return false;
  return ["input", "output", "cacheRead", "cacheWrite", "total", "cost"].every((key) =>
    isFiniteNonNegative(value[key]),
  );
}

function isWorkflowErrorCode(value: unknown): value is WorkflowErrorCode {
  return typeof value === "string" && Object.values(WorkflowErrorCode).includes(value as WorkflowErrorCode);
}

function isRecordedError(value: unknown): value is WorkflowRecordedError {
  if (!isRecord(value) || !["workflow-error", "error", "value"].includes(String(value.form))) {
    return false;
  }
  if (value.lossy !== undefined && typeof value.lossy !== "boolean") return false;
  if (value.form === "workflow-error") {
    if (!isWorkflowErrorCode(value.code) || typeof value.message !== "string") return false;
    if (value.recoverable !== undefined && typeof value.recoverable !== "boolean") return false;
    if (value.agentLabel !== undefined && typeof value.agentLabel !== "string") return false;
    if (value.resetHint !== undefined && typeof value.resetHint !== "string") return false;
    if (value.providerUsageLimitContext !== undefined && !isRecord(value.providerUsageLimitContext)) return false;
    if (value.authContext !== undefined && !isRecord(value.authContext)) return false;
    if (value.checkpointContext !== undefined && !isRecord(value.checkpointContext)) return false;
    return true;
  }
  if (value.form === "error") {
    if (typeof value.name !== "string" || typeof value.message !== "string") return false;
    if (value.props !== undefined && !isRecord(value.props)) return false;
    return true;
  }
  return hasOwn(value, "value") || value.lossy === true;
}

function isProvenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.source === "live") {
    return value.overrideModel === undefined || typeof value.overrideModel === "string";
  }
  if (value.source !== "replay") return false;
  return (
    (value.recordedRunId === undefined || typeof value.recordedRunId === "string") &&
    (value.recordedIndex === undefined || isNonNegativeInteger(value.recordedIndex)) &&
    (value.hashMatched === undefined || typeof value.hashMatched === "boolean")
  );
}

function recordingError(
  recording: Partial<PersistedRunState> | undefined,
  reason: RecordingUnusableReason,
  detail: string,
  extra: Record<string, unknown> = {},
): WorkflowError {
  return new WorkflowError(detail, WorkflowErrorCode.RECORDING_UNUSABLE, {
    recoverable: false,
    details: {
      reason,
      ...(isNonEmptyString(recording?.runId) ? { runId: recording.runId } : {}),
      ...extra,
    },
  });
}

function failRecording(
  recording: Partial<PersistedRunState> | undefined,
  reason: RecordingUnusableReason,
  detail: string,
  extra?: Record<string, unknown>,
): never {
  throw recordingError(recording, reason, detail, extra);
}

function corrupt(
  recording: Partial<PersistedRunState> | undefined,
  field: string,
  index?: number,
): never {
  failRecording(recording, "corrupt-structure", `recording has an invalid ${field}`, {
    field,
    ...(index === undefined ? {} : { index }),
  });
}

function validateRecordedError(
  recording: PersistedRunState,
  value: unknown,
  index: number,
): asserts value is WorkflowRecordedError {
  if (!isRecordedError(value)) corrupt(recording, "calls[].error", index);
}

function validateCallStructure(recording: PersistedRunState, row: unknown, position: number): void {
  if (!isRecord(row)) corrupt(recording, "calls[]", position);
  if (!isNonNegativeInteger(row.index)) corrupt(recording, "calls[].index", position);
  const index = row.index;
  if (row.kind !== "agent" && row.kind !== "checkpoint") corrupt(recording, "calls[].kind", index);
  if (!isNonEmptyString(row.hash)) corrupt(recording, "calls[].hash", index);
  if (row.path !== undefined && !isNonEmptyString(row.path)) corrupt(recording, "calls[].path", index);
  if (row.inputsHash !== undefined && !isNonEmptyString(row.inputsHash)) {
    corrupt(recording, "calls[].inputsHash", index);
  }
  if (row.label !== undefined && typeof row.label !== "string") corrupt(recording, "calls[].label", index);
  if (!["result", "null", "error"].includes(String(row.outcome))) {
    corrupt(recording, "calls[].outcome", index);
  }
  if (!["runner", "journal-replay", "confirm", "headless", "engine"].includes(String(row.origin))) {
    corrupt(recording, "calls[].origin", index);
  }
  if (row.aborted !== undefined && row.aborted !== true) corrupt(recording, "calls[].aborted", index);
  if (row.attempts !== undefined && !isPositiveInteger(row.attempts)) corrupt(recording, "calls[].attempts", index);
  if (row.usage !== undefined && !isUsage(row.usage)) corrupt(recording, "calls[].usage", index);
  for (const field of ["modelRequested", "modelResolved", "backendId", "resolvedCwd"] as const) {
    if (row[field] !== undefined && typeof row[field] !== "string") corrupt(recording, `calls[].${field}`, index);
  }
  if (row.modelFallback !== undefined && row.modelFallback !== true) {
    corrupt(recording, "calls[].modelFallback", index);
  }
  if (row.worktree !== undefined && row.worktree !== true) corrupt(recording, "calls[].worktree", index);
  if (row.isolation !== undefined && row.isolation !== "worktree") corrupt(recording, "calls[].isolation", index);
  if (row.budgetDebit !== undefined && typeof row.budgetDebit !== "number") {
    corrupt(recording, "calls[].budgetDebit", index);
  }
  if (row.settlementOrdinal !== undefined && !isPositiveInteger(row.settlementOrdinal)) {
    corrupt(recording, "calls[].settlementOrdinal", index);
  }
  if (row.scope !== undefined && !isNonEmptyString(row.scope)) corrupt(recording, "calls[].scope", index);
  if (row.provenance !== undefined && !isProvenance(row.provenance)) {
    corrupt(recording, "calls[].provenance", index);
  }
  if (row.error !== undefined) validateRecordedError(recording, row.error, index);

  if (row.outcome === "result" && row.error !== undefined) corrupt(recording, "calls[].error", index);
  if ((row.outcome === "null" || row.outcome === "error") && row.error === undefined) {
    corrupt(recording, "calls[].error", index);
  }

  if (row.kind === "agent" && row.origin === "runner") {
    if (!isPositiveInteger(row.attempts) || !isNonEmptyString(row.resolvedCwd)) {
      corrupt(recording, "agent runner row", index);
    }
    if (row.outcome === "null") {
      if (
        !isRecord(row.error) ||
        row.error.form !== "workflow-error" ||
        row.error.recoverable !== true ||
        row.aborted === true
      ) {
        corrupt(recording, "agent runner null row", index);
      }
    }
    if (row.outcome === "error" && row.aborted !== true && isRecord(row.error) && row.error.recoverable !== false) {
      corrupt(recording, "agent runner error row", index);
    }
    if (row.provenance !== undefined && !isProvenance(row.provenance)) {
      corrupt(recording, "calls[].provenance", index);
    }
    return;
  }

  if (row.kind === "agent" && row.origin === "journal-replay") {
    if (
      row.outcome !== "result" ||
      row.attempts !== undefined ||
      row.error !== undefined ||
      row.aborted !== undefined ||
      row.provenance !== undefined
    ) {
      corrupt(recording, "agent journal-replay row", index);
    }
    return;
  }

  if (row.kind === "agent" && row.origin === "engine") {
    if (
      row.outcome !== "error" ||
      !isRecord(row.error) ||
      row.error.form !== "workflow-error" ||
      row.attempts !== undefined ||
      row.usage !== undefined ||
      row.provenance !== undefined
    ) {
      corrupt(recording, "agent engine row", index);
    }
    return;
  }

  if (row.kind === "checkpoint" && (row.origin === "confirm" || row.origin === "headless")) {
    if (
      (row.outcome !== "result" && row.outcome !== "error") ||
      row.attempts !== undefined ||
      row.usage !== undefined ||
      row.worktree !== undefined ||
      row.budgetDebit !== undefined ||
      row.provenance !== undefined
    ) {
      corrupt(recording, "checkpoint row", index);
    }
    if (row.origin === "headless" && row.outcome === "error" && isRecord(row.error) && row.error.form !== "workflow-error") {
      corrupt(recording, "checkpoint headless error", index);
    }
    return;
  }

  if (row.kind === "checkpoint" && row.origin === "journal-replay") {
    if (
      row.outcome !== "result" ||
      row.attempts !== undefined ||
      row.usage !== undefined ||
      row.error !== undefined ||
      row.aborted !== undefined ||
      row.budgetDebit !== undefined ||
      row.provenance !== undefined
    ) {
      corrupt(recording, "checkpoint journal-replay row", index);
    }
    return;
  }

  if (row.kind === "checkpoint" && row.origin === "engine") {
    if (
      row.outcome !== "error" ||
      row.aborted !== true ||
      !isRecord(row.error) ||
      row.error.form !== "workflow-error" ||
      row.error.code !== WorkflowErrorCode.WORKFLOW_ABORTED ||
      row.budgetDebit !== undefined ||
      row.provenance !== undefined
    ) {
      corrupt(recording, "checkpoint engine row", index);
    }
    return;
  }

  corrupt(recording, "calls[] discriminant", index);
}

function validateStructure(recording: PersistedRunState): void {
  if (!isRecord(recording)) corrupt(undefined, "recording");
  if (!isNonEmptyString(recording.runId)) corrupt(recording, "runId");
  if (!isNonEmptyString(recording.script)) corrupt(recording, "script");
  if (typeof recording.status !== "string") corrupt(recording, "status");
  for (const field of ["effectiveCwd", "cwd", "mainModel", "agentsDir"] as const) {
    if (recording[field] !== undefined && typeof recording[field] !== "string") corrupt(recording, field);
  }
  for (const field of ["argsUnreplayable", "nestedWorkflows", "legacyResume", "abortSignaled"] as const) {
    if (recording[field] !== undefined && recording[field] !== true) corrupt(recording, field);
  }
  if (
    recording.executionMode !== undefined &&
    (!isRecord(recording.executionMode) ||
      recording.executionMode.kind !== "isolation" ||
      !isNonEmptyString(recording.executionMode.baselineRunId))
  ) {
    corrupt(recording, "executionMode");
  }
  if (recording.callsAllocated !== undefined && !isNonNegativeInteger(recording.callsAllocated)) {
    corrupt(recording, "callsAllocated");
  }
  if (recording.runtime !== undefined) {
    if (!isRecord(recording.runtime)) corrupt(recording, "runtime");
    if (recording.runtime.node !== undefined && typeof recording.runtime.node !== "string") corrupt(recording, "runtime.node");
    if (recording.runtime.v8 !== undefined && typeof recording.runtime.v8 !== "string") corrupt(recording, "runtime.v8");
    if (recording.runtime.pathFormat !== undefined && !Number.isInteger(recording.runtime.pathFormat)) {
      corrupt(recording, "runtime.pathFormat");
    }
    if (recording.runtime.inputsFormat !== undefined && !Number.isInteger(recording.runtime.inputsFormat)) {
      corrupt(recording, "runtime.inputsFormat");
    }
  }
  if (recording.environment !== undefined) {
    if (!isRecord(recording.environment)) corrupt(recording, "environment");
    if (recording.environment.git !== undefined) {
      if (
        !isRecord(recording.environment.git) ||
        !isNonEmptyString(recording.environment.git.head) ||
        !isNonEmptyString(recording.environment.git.dirtyDigest)
      ) {
        corrupt(recording, "environment.git");
      }
    }
    if (recording.environment.key !== undefined && typeof recording.environment.key !== "string") {
      corrupt(recording, "environment.key");
    }
    if ((recording.environment.git === undefined) === (recording.environment.key === undefined)) {
      corrupt(recording, "environment identity");
    }
  }
  if (recording.limits !== undefined) {
    if (!isRecord(recording.limits)) corrupt(recording, "limits");
    if (!isPositiveInteger(recording.limits.maxAgents)) corrupt(recording, "limits.maxAgents");
    if (!isPositiveInteger(recording.limits.concurrency)) corrupt(recording, "limits.concurrency");
    if (!isNonNegativeInteger(recording.limits.agentRetries)) corrupt(recording, "limits.agentRetries");
    if (
      recording.limits.tokenBudget !== null &&
      (typeof recording.limits.tokenBudget !== "number" || !Number.isFinite(recording.limits.tokenBudget))
    ) {
      corrupt(recording, "limits.tokenBudget");
    }
    if (
      recording.limits.agentTimeoutMs !== null &&
      (typeof recording.limits.agentTimeoutMs !== "number" || !Number.isFinite(recording.limits.agentTimeoutMs))
    ) {
      corrupt(recording, "limits.agentTimeoutMs");
    }
  }

  if (recording.agents !== undefined && !Array.isArray(recording.agents)) corrupt(recording, "agents");
  for (let index = 0; index < (recording.agents ?? []).length; index++) {
    const agent = recording.agents[index] as unknown;
    if (!isRecord(agent) || typeof agent.label !== "string") corrupt(recording, "agents[]", index);
    if (!["queued", "running", "done", "error", "skipped"].includes(String(agent.status))) {
      corrupt(recording, "agents[].status", index);
    }
    if (agent.callIndex !== undefined && !isNonNegativeInteger(agent.callIndex)) corrupt(recording, "agents[].callIndex", index);
    if (agent.scope !== undefined && !isNonEmptyString(agent.scope)) corrupt(recording, "agents[].scope", index);
    if (agent.model !== undefined && typeof agent.model !== "string") corrupt(recording, "agents[].model", index);
    if (agent.usage !== undefined && !isUsage(agent.usage)) corrupt(recording, "agents[].usage", index);
    if (agent.provenance !== undefined && !isProvenance(agent.provenance)) corrupt(recording, "agents[].provenance", index);
  }

  if (recording.journal !== undefined && !Array.isArray(recording.journal)) corrupt(recording, "journal");
  const journalIndexes = new Set<number>();
  for (let position = 0; position < (recording.journal ?? []).length; position++) {
    const entry = recording.journal?.[position] as unknown;
    if (!isRecord(entry) || !isNonNegativeInteger(entry.index)) corrupt(recording, "journal[].index", position);
    if (journalIndexes.has(entry.index)) corrupt(recording, "journal[].index", entry.index);
    journalIndexes.add(entry.index);
    if (!isNonEmptyString(entry.hash)) corrupt(recording, "journal[].hash", entry.index);
    if (entry.kind !== undefined && entry.kind !== "agent" && entry.kind !== "checkpoint") {
      corrupt(recording, "journal[].kind", entry.index);
    }
    if (entry.scope !== undefined && !isNonEmptyString(entry.scope)) corrupt(recording, "journal[].scope", entry.index);
    if (entry.usage !== undefined && !isUsage(entry.usage)) corrupt(recording, "journal[].usage", entry.index);
  }

  if (recording.calls !== undefined && !Array.isArray(recording.calls)) corrupt(recording, "calls");
  for (let position = 0; position < (recording.calls ?? []).length; position++) {
    validateCallStructure(recording, recording.calls?.[position], position);
  }
}

function preflight(recording: PersistedRunState, options: PreflightOptions = {}): PreflightResult {
  validateStructure(recording);
  const calls = recording.calls ?? [];
  const agents = recording.agents ?? [];
  const journal = recording.journal ?? [];

  if (recording.status !== "completed") {
    failRecording(recording, "not-completed", `recording status is ${recording.status}, not completed`);
  }
  try {
    parseWorkflowScript(recording.script);
  } catch (error) {
    failRecording(recording, "script-invalid", `recording script is invalid: ${errorMessage(error)}`);
  }

  const indexes = new Set(calls.map((row) => row.index));
  const missingIndexes: number[] = [];
  const allocated = recording.callsAllocated;
  if (allocated !== undefined) {
    for (let index = 0; index < allocated; index++) if (!indexes.has(index)) missingIndexes.push(index);
  }
  if (
    recording.calls === undefined ||
    allocated === undefined ||
    allocated !== calls.length ||
    indexes.size !== calls.length ||
    missingIndexes.length > 0
  ) {
    failRecording(recording, "incomplete-manifest", "recording call manifest is incomplete", {
      indexes: missingIndexes,
    });
  }

  const foreignScope =
    calls.some((row) => row.scope !== undefined && row.scope !== recording.runId) ||
    journal.some((entry) => entry.scope !== undefined && entry.scope !== recording.runId) ||
    agents.some((agent) => agent.scope !== undefined && agent.scope !== recording.runId);
  if (recording.nestedWorkflows || foreignScope) {
    failRecording(recording, "nested-workflow-recording", "recording contains nested workflow state");
  }
  if (recording.executionMode) {
    failRecording(recording, "isolation-artifact", "an isolation artifact cannot be used as a baseline");
  }
  if (recording.legacyResume) failRecording(recording, "legacy-resume", "recording contains legacy resume state");
  const abortedIndexes = calls.filter((row) => row.aborted).map((row) => row.index);
  if (recording.abortSignaled || abortedIndexes.length > 0) {
    failRecording(recording, "abort-residue", "recording contains abort residue", { indexes: abortedIndexes });
  }
  const engineIndexes = calls.filter((row) => row.origin === "engine").map((row) => row.index);
  if (engineIndexes.length > 0) {
    failRecording(recording, "engine-origin-row", "recording contains engine-origin calls", { indexes: engineIndexes });
  }
  const replayedIndexes = calls
    .filter((row) => row.provenance?.source === "replay")
    .map((row) => row.index);
  if (
    replayedIndexes.length > 0 ||
    agents.some((agent) => agent.provenance?.source === "replay")
  ) {
    failRecording(recording, "replayed-row", "recording contains replay-served calls", { indexes: replayedIndexes });
  }
  const lossyIndexes = calls.filter((row) => row.error?.lossy).map((row) => row.index);
  if (lossyIndexes.length > 0) {
    failRecording(recording, "unreplayable-error", "recording contains a lossy error projection", {
      indexes: lossyIndexes,
    });
  }
  if (recording.argsUnreplayable) {
    failRecording(recording, "args-unreplayable", "recording args are not replayable strict JSON");
  }

  if (!recording.limits) failRecording(recording, "no-limits", "recording has no effective limits");
  if ((recording.callsAllocated as number) >= recording.limits.maxAgents) {
    failRecording(recording, "agent-limit-boundary", "recording reached its agent allocation boundary", {
      indexes: [recording.callsAllocated],
    });
  }
  const ordinals = calls.map((row) => row.settlementOrdinal);
  const expectedOrdinals = new Set(Array.from({ length: calls.length }, (_value, index) => index + 1));
  const trajectoryBad =
    ordinals.some((ordinal) => ordinal === undefined || !expectedOrdinals.has(ordinal)) ||
    new Set(ordinals).size !== calls.length ||
    calls.some((row) => row.kind === "agent" && !isFiniteNonNegative(row.budgetDebit));
  if (trajectoryBad) {
    failRecording(recording, "no-budget-trajectory", "recording has no complete budget trajectory", {
      indexes: calls
        .filter(
          (row) =>
            row.settlementOrdinal === undefined ||
            !expectedOrdinals.has(row.settlementOrdinal) ||
            (row.kind === "agent" && !isFiniteNonNegative(row.budgetDebit)),
        )
        .map((row) => row.index),
    });
  }

  const identities = buildResumeExactIndex(calls, (row) => ({
    kind: row.kind,
    path: row.path ?? "",
    hash: row.hash,
  }));
  const ambiguousIndexes = [...identities.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => group.map((row) => row.index));
  if (ambiguousIndexes.length > 0) {
    failRecording(recording, "ambiguous-identity", "recording contains duplicate call identities", {
      indexes: ambiguousIndexes.sort((a, b) => a - b),
    });
  }

  const missingPaths = calls.filter((row) => !row.path).map((row) => row.index);
  if (missingPaths.length > 0) {
    failRecording(recording, "path-missing", "recording has calls without captured paths", { indexes: missingPaths });
  }
  const runtime = recording.runtime;
  if (
    !runtime ||
    runtime.node !== process.version ||
    runtime.v8 !== process.versions.v8 ||
    runtime.pathFormat !== CALL_PATH_FORMAT ||
    runtime.inputsFormat !== CALL_INPUTS_FORMAT
  ) {
    failRecording(recording, "runtime-mismatch", "recording runtime identity does not match this engine", {
      field: !runtime
        ? "runtime"
        : runtime.node !== process.version
          ? "runtime.node"
          : runtime.v8 !== process.versions.v8
            ? "runtime.v8"
            : runtime.pathFormat !== CALL_PATH_FORMAT
              ? "runtime.pathFormat"
              : "runtime.inputsFormat",
    });
  }

  const executionCwd = options.executionCwd ?? recording.effectiveCwd ?? recording.cwd;
  if (!executionCwd) {
    failRecording(recording, "no-execution-cwd", "recording has no execution directory");
  }
  if (!recording.environment) {
    failRecording(recording, "no-environment-identity", "recording has no environment identity");
  }
  const currentEnvironment = captureRunEnvironment(executionCwd, options.environmentKey);
  if (!environmentsEqual(recording.environment, currentEnvironment)) {
    failRecording(recording, "environment-mismatch", "recording environment identity does not match", {
      field: recording.environment.git ? "environment.git" : "environment.key",
    });
  }

  const journalByIndex = new Map(journal.map((entry) => [entry.index, entry]));
  const journalMismatch = calls
    .filter((row) => {
      if (row.outcome !== "result") return false;
      const entry = journalByIndex.get(row.index);
      return !entry || entry.hash !== row.hash || (entry.kind !== undefined && entry.kind !== row.kind);
    })
    .map((row) => row.index);
  if (journalMismatch.length > 0) {
    failRecording(recording, "journal-manifest-mismatch", "recording journal disagrees with its call manifest", {
      indexes: journalMismatch,
    });
  }

  const notes: string[] = [];
  for (const row of calls) {
    if (row.outcome !== "result") notes.push(`recorded failure at call ${row.index}`);
    if (row.kind === "agent" && row.usage === undefined) notes.push(`call ${row.index} has no recorded usage`);
    if (row.worktree || row.isolation === "worktree") notes.push(`call ${row.index} used worktree isolation`);
  }
  const rowsByIndex = new Map(calls.map((row) => [row.index, row]));
  for (const entry of journal) {
    const row = rowsByIndex.get(entry.index);
    if (
      !row ||
      row.outcome !== "result" ||
      row.hash !== entry.hash ||
      (entry.kind !== undefined && entry.kind !== row.kind)
    ) {
      notes.push(`stale journal entry at index ${entry.index}`);
    }
  }
  if (recording.script.includes("tier:") || recording.script.includes("agentType:")) {
    notes.push("model-resolution inputs must match the recording");
  }
  return { notes };
}

function targetError(target: unknown, reason: string, detail: string, candidates?: number[]): never {
  throw new WorkflowError(detail, WorkflowErrorCode.REPLAY_TARGET_INVALID, {
    recoverable: false,
    details: { target, reason, ...(candidates === undefined ? {} : { candidates }) },
  });
}

function resolveTargets(recording: PersistedRunState, requested: IsolationTarget[]): ResolvedIsolationTarget[] {
  if (!Array.isArray(requested) || requested.length === 0) {
    targetError(undefined, "no-targets", "isolation requires at least one target");
  }
  const calls = recording.calls ?? [];
  const callsByIndex = new Map(calls.map((row) => [row.index, row]));
  const agents = recording.agents ?? [];
  const resolved: ResolvedIsolationTarget[] = [];
  const resolvedIndexes = new Set<number>();

  for (const target of requested) {
    if (!isRecord(target)) targetError(target, "invalid-selector", "target must be an object");
    const byIndex = hasOwn(target, "callIndex");
    const byLabel = hasOwn(target, "label");
    if (byIndex === byLabel) targetError(target, "invalid-selector", "target must select exactly one callIndex or label");
    if (target.model !== undefined && typeof target.model !== "string") {
      targetError(target, "invalid-selector", "target model must be a string");
    }

    let recordedIndex: number;
    if (byIndex) {
      if (!isNonNegativeInteger(target.callIndex)) targetError(target, "invalid-selector", "target callIndex is invalid");
      recordedIndex = target.callIndex;
    } else {
      if (typeof target.label !== "string") targetError(target, "invalid-selector", "target label is invalid");
      const matches = agents.filter(
        (agent) => agent.label === target.label && (agent.status === "done" || agent.status === "error"),
      );
      if (matches.some((agent) => agent.callIndex === undefined)) {
        targetError(
          target,
          "re-record-or-target-by-callindex",
          "label targeting requires recorded agent call indexes",
        );
      }
      const candidates = matches.map((agent) => agent.callIndex as number);
      if (matches.length === 0) targetError(target, "label-not-found", `no recorded agent has label ${target.label}`, []);
      if (matches.length !== 1) {
        targetError(target, "label-ambiguous", `label ${target.label} matches multiple recorded agents`, candidates);
      }
      recordedIndex = candidates[0];
    }

    const row = callsByIndex.get(recordedIndex);
    if (!row) targetError(target, "call-not-found", `recorded call ${recordedIndex} does not exist`);
    if (row.kind !== "agent") targetError(target, "not-agent-call", `recorded call ${recordedIndex} is a checkpoint`);
    if (row.origin === "journal-replay") {
      targetError(target, "journal-replay-target", `recorded call ${recordedIndex} was journal-replayed`);
    }
    if (row.origin !== "runner") targetError(target, "not-runner-call", `recorded call ${recordedIndex} did not run at the seam`);
    if (row.isolation === "worktree" || row.worktree) {
      targetError(target, "worktree-target", `recorded call ${recordedIndex} used an unpinnable worktree`);
    }
    if (!row.inputsHash) targetError(target, "no-input-fingerprint", `recorded call ${recordedIndex} has no input fingerprint`);
    if (!row.path) targetError(target, "path-missing", `recorded call ${recordedIndex} has no call path`);
    if (
      target.model === undefined &&
      (row.modelRequested === undefined || row.modelResolved === undefined || row.modelFallback === true)
    ) {
      targetError(
        target,
        "unproven-baseline-model",
        `recorded call ${recordedIndex} has no positive baseline model evidence; pass target.model`,
      );
    }
    if (resolvedIndexes.has(recordedIndex)) {
      targetError(target, "duplicate-target", `recorded call ${recordedIndex} was selected more than once`, [recordedIndex]);
    }
    resolvedIndexes.add(recordedIndex);
    resolved.push({
      recordedIndex,
      hash: row.hash,
      path: row.path,
      inputsHash: row.inputsHash,
      ...(target.model === undefined ? {} : { model: target.model }),
    });
  }
  return resolved;
}

function jsonClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function reconstructRecordedError(record: WorkflowRecordedError): unknown {
  if (record.form === "workflow-error") {
    return new WorkflowError(record.message as string, record.code as WorkflowErrorCode, {
      recoverable: record.recoverable,
      agentLabel: record.agentLabel,
      details: jsonClone(record.details),
      resetHint: record.resetHint,
      providerUsageLimitContext: jsonClone(record.providerUsageLimitContext),
      authContext: jsonClone(record.authContext),
      checkpointContext: jsonClone(record.checkpointContext),
    });
  }
  if (record.form === "error") {
    const reconstructed = new Error(record.message as string);
    reconstructed.name = record.name as string;
    for (const [key, value] of Object.entries(record.props ?? {})) {
      Object.defineProperty(reconstructed, key, {
        value: jsonClone(value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return reconstructed;
  }
  return jsonClone(record.value);
}

type Binding =
  | {
      kind: "served";
      scope: string;
      liveIndex: number;
      liveHash: string;
      livePath: string;
      row: WorkflowCallRecord;
      report: ReplayCallReport;
    }
  | {
      kind: "target";
      scope: string;
      liveIndex: number;
      liveHash: string;
      livePath: string;
      target: ResolvedIsolationTarget;
      row: WorkflowCallRecord;
      report: ReplayCallReport;
      settled: boolean;
    };

class ReplayRunnerImplementation implements ReplayRunner {
  private readonly recording: PersistedRunState;
  private readonly inner: AgentRunner;
  private readonly rootRunId: string;
  private readonly targets: ResolvedIsolationTarget[];
  private readonly calls: WorkflowCallRecord[];
  private readonly rowsByIndex = new Map<number, WorkflowCallRecord>();
  private readonly rowsByIdentity = new Map<string, WorkflowCallRecord>();
  private readonly agentRowsByPath = new Map<string, WorkflowCallRecord[]>();
  private readonly checkpointRowsByPath = new Map<string, WorkflowCallRecord[]>();
  private readonly targetByIdentity = new Map<string, ResolvedIsolationTarget>();
  private readonly targetsByPath = new Map<string, ResolvedIsolationTarget[]>();
  private readonly journalByIndex: Map<number, NonNullable<PersistedRunState["journal"]>[number]>;
  private readonly bindings = new Map<string, Binding>();
  private readonly visited = new Set<number>();
  private readonly settledTargets = new Set<number>();
  private readonly unverifiedTargets = new Set<number>();
  private readonly callReports: ReplayCallReport[] = [];
  private readonly notes: string[];
  private fatalError?: WorkflowError;
  private finalizedReport?: ReplayReport;
  private targetSettlements = 0;

  constructor(
    recording: PersistedRunState,
    inner: AgentRunner,
    targets: ResolvedIsolationTarget[],
    rootRunId: string,
    notes: string[],
  ) {
    this.recording = recording;
    this.inner = inner;
    this.targets = targets;
    this.rootRunId = rootRunId;
    this.calls = recording.calls ?? [];
    this.notes = notes;
    this.journalByIndex = new Map((recording.journal ?? []).map((entry) => [entry.index, entry]));
    for (const row of this.calls) {
      this.rowsByIndex.set(row.index, row);
      this.rowsByIdentity.set(resumeExactKey(row.kind, row.path as string, row.hash), row);
      const byPath = row.kind === "agent" ? this.agentRowsByPath : this.checkpointRowsByPath;
      const pathRows = byPath.get(row.path as string) ?? [];
      pathRows.push(row);
      byPath.set(row.path as string, pathRows);
    }
    for (const target of targets) {
      this.targetByIdentity.set(resumeExactKey("agent", target.path, target.hash), target);
      const pathTargets = this.targetsByPath.get(target.path) ?? [];
      pathTargets.push(target);
      this.targetsByPath.set(target.path, pathTargets);
    }
  }

  private bindingKey(scope: string, callIndex: number): string {
    return `${scope}\u0000${callIndex}`;
  }

  private ensureActive(): void {
    if (this.finalizedReport) throw new Error("ReplayRunner cannot be used after finalize()");
    if (this.fatalError) throw this.fatalError;
  }

  private diverge(event: ReplayDivergenceEvent): WorkflowError {
    if (this.fatalError) return this.fatalError;
    const frozenEvent = deepFreeze(jsonClone(event));
    this.fatalError = new WorkflowError(event.detail, WorkflowErrorCode.REPLAY_DIVERGENCE, {
      recoverable: false,
      details: frozenEvent,
    });
    return this.fatalError;
  }

  noteNestedWorkflow(detail = "isolation does not support nested workflow() invocations"): WorkflowError {
    return this.diverge({ kind: "nested-workflow-call", detail });
  }

  getFatalError(): WorkflowError | undefined {
    return this.fatalError;
  }

  private rowForTarget(target: ResolvedIsolationTarget): WorkflowCallRecord {
    return this.rowsByIndex.get(target.recordedIndex) as WorkflowCallRecord;
  }

  private reportForBinding(
    liveIndex: number,
    row: WorkflowCallRecord,
    mode: "served" | "live-target",
    hashMatched: boolean,
  ): ReplayCallReport {
    return {
      liveIndex,
      recordedIndex: row.index,
      kind: row.kind,
      mode,
      hashMatched,
      ...(row.label === undefined ? {} : { label: row.label }),
      ...(row.usage === undefined ? {} : { recordedUsage: jsonClone(row.usage) }),
      ...(row.outcome === "null" ? { recordedFailure: true } : {}),
      ...(row.outcome === "error" ? { recordedError: jsonClone(row.error) } : {}),
    };
  }

  private recordBinding(binding: Binding): void {
    this.bindings.set(this.bindingKey(binding.scope, binding.liveIndex), binding);
    this.visited.add(binding.row.index);
    this.callReports.push(binding.report);
  }

  private serve(
    binding: Extract<Binding, { kind: "served" }>,
    options?: RunOptions<import("typebox").TSchema | undefined>,
  ): unknown {
    const row = binding.row;
    options?.onResultProvenance?.({
      source: "replay",
      recordedRunId: this.recording.runId,
      recordedIndex: row.index,
      hashMatched: binding.report.hashMatched,
    });
    if (row.outcome === "result") return jsonClone(this.journalByIndex.get(row.index)?.result);
    if (row.outcome === "null") return null;
    throw reconstructRecordedError(row.error as WorkflowRecordedError);
  }

  private delegate(
    binding: Extract<Binding, { kind: "target" }>,
    prompt: string,
    options: RunOptions<import("typebox").TSchema | undefined>,
  ): Promise<unknown> {
    binding.report.attempts = (binding.report.attempts ?? 0) + 1;
    const overrideModel = binding.target.model ?? options.model;
    options.onResultProvenance?.({
      source: "live",
      ...(overrideModel === undefined ? {} : { overrideModel }),
    });
    return this.inner.run(prompt, { ...options, model: overrideModel }) as Promise<unknown>;
  }

  async run<S extends import("typebox").TSchema | undefined = undefined>(
    prompt: string,
    options: RunOptions<S> = {} as RunOptions<S>,
  ): Promise<AgentResult<S>> {
    this.ensureActive();
    const liveIndex = options.callIndex;
    const hash = options.callHash;
    const scope = options.runId;
    if (!isNonNegativeInteger(liveIndex) || !isNonEmptyString(hash) || typeof scope !== "string") {
      throw new TypeError("ReplayRunner requires callIndex, callHash, and runId identity fields");
    }
    const path = options.callPath;
    if (!isNonEmptyString(path)) {
      throw this.diverge({
        kind: "path-unavailable",
        liveCallIndex: liveIndex,
        detail: "isolation requires a captured call path",
      });
    }
    const key = this.bindingKey(scope, liveIndex);
    const prior = this.bindings.get(key);
    if (prior) {
      if (prior.liveHash !== hash || prior.livePath !== path || prior.row.kind !== "agent") {
        throw this.diverge({
          kind: "identity-reexecuted",
          liveCallIndex: liveIndex,
          path,
          candidateIndexes: [prior.row.index],
          detail: "a bound logical call arrived again with different identity",
        });
      }
      return (prior.kind === "served"
        ? this.serve(prior, options)
        : await this.delegate(prior, prompt, options)) as AgentResult<S>;
    }
    if (scope !== this.rootRunId) {
      throw this.diverge({
        kind: "nested-workflow-call",
        liveCallIndex: liveIndex,
        path,
        detail: `call arrived from foreign workflow scope ${scope}`,
      });
    }

    const exactTarget = this.targetByIdentity.get(resumeExactKey("agent", path, hash));
    if (exactTarget && !this.visited.has(exactTarget.recordedIndex)) {
      const row = this.rowForTarget(exactTarget);
      const fingerprintMatches =
        isNonEmptyString(options.callInputsHash) && options.callInputsHash === exactTarget.inputsHash;
      const cwdMatches = options.cwd === row.resolvedCwd;
      if (!fingerprintMatches || !cwdMatches) {
        throw this.diverge({
          kind: "target-inputs-drift",
          liveCallIndex: liveIndex,
          path,
          candidateIndexes: [exactTarget.recordedIndex],
          detail: `target ${exactTarget.recordedIndex} ${fingerprintMatches ? "cwd" : "input fingerprint"} differs from the recording`,
        });
      }
      const report = this.reportForBinding(liveIndex, row, "live-target", true);
      report.modelRequested = options.model;
      const overrideModel = exactTarget.model ?? options.model;
      if (overrideModel !== undefined) report.overrideModel = overrideModel;
      const binding: Extract<Binding, { kind: "target" }> = {
        kind: "target",
        scope,
        liveIndex,
        liveHash: hash,
        livePath: path,
        target: exactTarget,
        row,
        report,
        settled: false,
      };
      this.recordBinding(binding);
      return (await this.delegate(binding, prompt, options)) as AgentResult<S>;
    }

    const exactRow = this.rowsByIdentity.get(resumeExactKey("agent", path, hash));
    if (exactRow) {
      const reserved = this.targets.some((target) => target.recordedIndex === exactRow.index);
      if (reserved) {
        throw this.diverge({
          kind: "target-site-reexecuted",
          liveCallIndex: liveIndex,
          path,
          candidateIndexes: [exactRow.index],
          detail: `target site ${exactRow.index} was re-executed after it was bound`,
        });
      }
      if (this.visited.has(exactRow.index)) {
        throw this.diverge({
          kind: "identity-reexecuted",
          liveCallIndex: liveIndex,
          path,
          candidateIndexes: [exactRow.index],
          detail: `recorded identity ${exactRow.index} executed more times than recorded`,
        });
      }
      const report = this.reportForBinding(liveIndex, exactRow, "served", true);
      const binding: Extract<Binding, { kind: "served" }> = {
        kind: "served",
        scope,
        liveIndex,
        liveHash: hash,
        livePath: path,
        row: exactRow,
        report,
      };
      this.recordBinding(binding);
      return this.serve(binding, options) as AgentResult<S>;
    }

    const pathTargets = this.targetsByPath.get(path) ?? [];
    if (pathTargets.length > 0) {
      throw this.diverge({
        kind: "dependent-or-drifted-target",
        liveCallIndex: liveIndex,
        path,
        candidateIndexes: pathTargets.map((target) => target.recordedIndex),
        detail: "a target path arrived with a different identity; dependent targets and drift are not comparable",
      });
    }
    const pathRows = this.agentRowsByPath.get(path) ?? [];
    if (pathRows.length === 0) {
      throw this.diverge({
        kind: "unrecorded-call",
        liveCallIndex: liveIndex,
        path,
        detail: "live control flow reached an agent call absent from the recording",
      });
    }
    if (pathRows.length > 1) {
      throw this.diverge({
        kind: "ambiguous-path",
        liveCallIndex: liveIndex,
        path,
        candidateIndexes: pathRows.map((row) => row.index),
        detail: "multiple recorded calls share this path; restructure the fan-out or use propagation mode",
      });
    }
    const row = pathRows[0];
    if (this.visited.has(row.index)) {
      throw this.diverge({
        kind: "identity-reexecuted",
        liveCallIndex: liveIndex,
        path,
        candidateIndexes: [row.index],
        detail: `recorded path ${row.index} executed more times than recorded`,
      });
    }
    const report = this.reportForBinding(liveIndex, row, "served", false);
    const binding: Extract<Binding, { kind: "served" }> = {
      kind: "served",
      scope,
      liveIndex,
      liveHash: hash,
      livePath: path,
      row,
      report,
    };
    this.recordBinding(binding);
    return this.serve(binding, options) as AgentResult<S>;
  }

  confirm = async (
    _promptText: string,
    _options: CheckpointOptions,
    context?: CheckpointCallContext,
  ): Promise<unknown> => {
    this.ensureActive();
    if (!context) {
      throw this.diverge({
        kind: "checkpoint-context-unavailable",
        detail: "isolation requires an engine that threads checkpoint identity",
      });
    }
    if (!isNonNegativeInteger(context.callIndex) || !isNonEmptyString(context.hash) || typeof context.scope !== "string") {
      throw new TypeError("ReplayRunner.confirm requires valid checkpoint identity fields");
    }
    if (!isNonEmptyString(context.path)) {
      throw this.diverge({
        kind: "path-unavailable",
        liveCallIndex: context.callIndex,
        detail: "isolation requires a captured checkpoint path",
      });
    }
    const key = this.bindingKey(context.scope, context.callIndex);
    const prior = this.bindings.get(key);
    if (prior) {
      if (
        prior.kind !== "served" ||
        prior.row.kind !== "checkpoint" ||
        prior.liveHash !== context.hash ||
        prior.livePath !== context.path
      ) {
        throw this.diverge({
          kind: "identity-reexecuted",
          liveCallIndex: context.callIndex,
          path: context.path,
          candidateIndexes: [prior.row.index],
          detail: "a bound checkpoint arrived again with different identity",
        });
      }
      return this.serve(prior);
    }
    if (context.scope !== this.rootRunId) {
      throw this.diverge({
        kind: "nested-workflow-call",
        liveCallIndex: context.callIndex,
        path: context.path,
        detail: `checkpoint arrived from foreign workflow scope ${context.scope}`,
      });
    }

    let row = this.rowsByIdentity.get(resumeExactKey("checkpoint", context.path, context.hash));
    let hashMatched = true;
    if (row && this.visited.has(row.index)) {
      throw this.diverge({
        kind: "identity-reexecuted",
        liveCallIndex: context.callIndex,
        path: context.path,
        candidateIndexes: [row.index],
        detail: `recorded checkpoint ${row.index} executed more times than recorded`,
      });
    }
    if (!row) {
      const candidates = this.checkpointRowsByPath.get(context.path) ?? [];
      if (candidates.length === 0) {
        throw this.diverge({
          kind: "unrecorded-call",
          liveCallIndex: context.callIndex,
          path: context.path,
          detail: "live control flow reached a checkpoint absent from the recording",
        });
      }
      if (candidates.length > 1) {
        throw this.diverge({
          kind: "ambiguous-path",
          liveCallIndex: context.callIndex,
          path: context.path,
          candidateIndexes: candidates.map((candidate) => candidate.index),
          detail: "multiple recorded checkpoints share this path",
        });
      }
      row = candidates[0];
      hashMatched = false;
      if (this.visited.has(row.index)) {
        throw this.diverge({
          kind: "identity-reexecuted",
          liveCallIndex: context.callIndex,
          path: context.path,
          candidateIndexes: [row.index],
          detail: `recorded checkpoint path ${row.index} executed more times than recorded`,
        });
      }
    }
    const report = this.reportForBinding(context.callIndex, row, "served", hashMatched);
    const binding: Extract<Binding, { kind: "served" }> = {
      kind: "served",
      scope: context.scope,
      liveIndex: context.callIndex,
      liveHash: context.hash,
      livePath: context.path,
      row,
      report,
    };
    this.recordBinding(binding);
    return this.serve(binding);
  };

  observeAgentEnd(event: {
    callIndex: number;
    scope: string;
    result: unknown;
    error?: string;
    errorCode?: WorkflowErrorCode;
    errorRecord?: WorkflowRecordedError;
    usage?: AgentUsage;
    modelResolved?: string;
    modelFallbacks?: string[];
    backendId?: string;
  }): ReplayObservation {
    if (event.scope !== this.rootRunId) return { target: false };
    const binding = this.bindings.get(this.bindingKey(event.scope, event.callIndex));
    if (!binding || binding.kind !== "target" || binding.settled) return { target: false };
    binding.settled = true;
    this.settledTargets.add(binding.target.recordedIndex);
    this.targetSettlements++;
    const report = binding.report;
    if (event.usage !== undefined) report.liveUsage = jsonClone(event.usage);
    if (event.modelResolved !== undefined) report.resolvedModel = event.modelResolved;
    if (event.modelFallbacks !== undefined) report.modelFallbacks = jsonClone(event.modelFallbacks);
    if (event.backendId !== undefined) report.backendId = event.backendId;
    const failed = event.errorRecord !== undefined || event.error !== undefined || event.errorCode !== undefined;
    if (failed) {
      if (event.error !== undefined) report.error = event.error;
      if (event.errorCode !== undefined) report.errorCode = event.errorCode;
      return {
        target: true,
        recordedIndex: binding.target.recordedIndex,
        outcome: "failed",
        remainingTargets: this.targets.length - this.settledTargets.size,
      };
    }
    report.liveResult = jsonClone(event.result);
    if ((event.modelFallbacks?.length ?? 0) > 0) {
      this.diverge({
        kind: "candidate-fallback",
        liveCallIndex: event.callIndex,
        path: binding.livePath,
        candidateIndexes: [binding.target.recordedIndex],
        detail: `candidate target ${binding.target.recordedIndex} reported model fallback: ${event.modelFallbacks?.join(", ")}`,
      });
      return {
        target: true,
        recordedIndex: binding.target.recordedIndex,
        outcome: "diverged",
        remainingTargets: this.targets.length - this.settledTargets.size,
      };
    }
    if (event.modelResolved === undefined) {
      report.candidateEvidence = "unverified";
      this.unverifiedTargets.add(binding.target.recordedIndex);
    } else {
      report.candidateEvidence = "verified";
    }
    return {
      target: true,
      recordedIndex: binding.target.recordedIndex,
      outcome: "settled",
      remainingTargets: this.targets.length - this.settledTargets.size,
    };
  }

  private buildReport(finalized: boolean): ReplayReport {
    const report: ReplayReport = {
      baselineRunId: this.recording.runId,
      isolationRunId: this.rootRunId,
      targets: jsonClone(this.targets),
      calls: jsonClone([...this.callReports].sort((left, right) => left.liveIndex - right.liveIndex)),
      finalized,
      notes: [...this.notes],
    };
    const divergence = this.fatalError?.details;
    if (isRecord(divergence) && REPLAY_DIVERGENCE_KINDS.includes(divergence.kind as ReplayDivergenceKind)) {
      report.divergence = jsonClone(divergence as unknown as ReplayDivergenceEvent);
    }
    if (this.targetSettlements > 0) report.unverifiedTargets = [...this.unverifiedTargets].sort((a, b) => a - b);
    return report;
  }

  report(): ReplayReport {
    if (this.finalizedReport) return this.finalizedReport;
    return this.buildReport(false);
  }

  finalize(outcome: { scriptCompleted?: boolean } = {}): ReplayReport {
    if (this.finalizedReport) return this.finalizedReport;
    const report = this.buildReport(true);
    const unsettled = [...this.bindings.values()]
      .filter((binding): binding is Extract<Binding, { kind: "target" }> => binding.kind === "target" && !binding.settled)
      .map((binding) => binding.target.recordedIndex)
      .sort((a, b) => a - b);
    if (unsettled.length > 0) report.targetUnsettled = unsettled;

    if (!this.fatalError && outcome.scriptCompleted === true) {
      report.unvisitedRecordedIndexes = this.calls
        .filter((row) => !this.visited.has(row.index))
        .map((row) => row.index)
        .sort((a, b) => a - b);
      report.unreachedTargets = this.targets
        .filter((target) => !this.visited.has(target.recordedIndex))
        .map((target) => target.recordedIndex)
        .sort((a, b) => a - b);
      if (unsettled.length > 0) {
        const event: ReplayDivergenceEvent = {
          kind: "target-unsettled",
          candidateIndexes: unsettled,
          detail: `live target did not settle before script completion: ${unsettled.join(", ")}`,
        };
        this.fatalError = new WorkflowError(event.detail, WorkflowErrorCode.REPLAY_DIVERGENCE, {
          recoverable: false,
          details: deepFreeze(jsonClone(event)),
        });
        report.divergence = jsonClone(event);
      }
    }
    this.finalizedReport = deepFreeze(report);
    return this.finalizedReport;
  }

  addPersistenceFailure(reason: string): ReplayReport {
    const current = this.finalizedReport ?? this.finalize();
    const updated = jsonClone(current);
    updated.notes.push(`report-persistence-failed: ${reason}`);
    this.finalizedReport = deepFreeze(updated);
    return this.finalizedReport;
  }
}

export function createReplayRunner(options: ReplayRunnerOptions): ReplayRunner {
  let recording: PersistedRunState;
  try {
    recording = JSON.parse(JSON.stringify(options.recording)) as PersistedRunState;
  } catch (error) {
    throw recordingError(
      isRecord(options.recording) ? options.recording : undefined,
      "corrupt-structure",
      `recording cannot be normalized as JSON: ${errorMessage(error)}`,
      { field: "recording" },
    );
  }
  const checked = preflight(recording, {
    executionCwd: options.executionCwd,
    environmentKey: options.environmentKey,
  });
  const targets = resolveTargets(recording, options.live);
  if (!isNonEmptyString(options.rootRunId)) {
    throw new TypeError("ReplayRunner rootRunId must be a non-empty string");
  }
  return new ReplayRunnerImplementation(recording, options.inner, targets, options.rootRunId, checked.notes);
}

function asWorkflowError(error: unknown): WorkflowError {
  return error instanceof WorkflowError
    ? error
    : new WorkflowError(errorMessage(error), WorkflowErrorCode.PERSISTENCE_ERROR, {
        recoverable: false,
      });
}

function errorFromDivergence(event: ReplayDivergenceEvent): WorkflowError {
  return new WorkflowError(event.detail, WorkflowErrorCode.REPLAY_DIVERGENCE, {
    recoverable: false,
    details: deepFreeze(jsonClone(event)),
  });
}

export async function runIsolation<T = unknown>(
  options: RunIsolationOptions,
): Promise<IsolationRunResult<T>> {
  let persistence: ReturnType<typeof createRunPersistence>;
  let recording: PersistedRunState;
  let wrapper!: ReplayRunnerImplementation;
  let manager!: WorkflowManager;
  let rootRunId!: string;
  let executionCwd: string;
  let createAttempt!: () => void;
  const journaling = options.journaling ?? true;

  try {
    const persistenceCwd = options.cwd ?? process.cwd();
    persistence = createRunPersistence(persistenceCwd, undefined, { persistenceRoot: options.persistenceRoot });
    const loaded = persistence.load(options.baselineRunId);
    if (!loaded) {
      throw recordingError(undefined, "not-found", `recording ${options.baselineRunId} was not found`, {
        runId: options.baselineRunId,
      });
    }
    recording = loaded;
    executionCwd = recording.effectiveCwd ?? recording.cwd ?? options.executionCwd ?? "";
    preflight(recording, { executionCwd, environmentKey: options.environmentKey });
    resolveTargets(recording, options.live);
    createAttempt = () => {
      do {
        rootRunId = generateRunId();
      } while (rootRunId === options.baselineRunId || persistence.load(rootRunId) !== null);

      const replay = createReplayRunner({
        recording,
        inner: options.runner,
        live: options.live,
        rootRunId,
        executionCwd,
        environmentKey: options.environmentKey,
      });
      wrapper = replay as ReplayRunnerImplementation;
      manager = new WorkflowManager({
        cwd: persistenceCwd,
        persistenceRoot: options.persistenceRoot,
        journaling,
        agentsDir: options.agentsDir ?? recording.agentsDir,
        mainModel: options.mainModel ?? recording.mainModel,
        environmentKey: options.environmentKey,
        agent: wrapper,
      });
    };
    createAttempt();
  } catch (error) {
    throw asWorkflowError(error);
  }

  const internal = new AbortController();
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, internal.signal])
    : internal.signal;
  let callerAbortObserved = options.signal?.aborted === true;
  options.signal?.addEventListener(
    "abort",
    () => {
      callerAbortObserved = true;
    },
    { once: true },
  );
  let targetFailed = false;
  let targetFailureError: WorkflowError | undefined;
  let stopping = false;
  const stopForObservation = () => {
    if (stopping) return;
    stopping = true;
    internal.abort();
    manager.stop(rootRunId);
  };
  const onAgentEnd = (event: {
    callIndex: number;
    scope: string;
    result: unknown;
    error?: string;
    errorCode?: WorkflowErrorCode;
    errorRecord?: WorkflowRecordedError;
    usage?: AgentUsage;
    modelResolved?: string;
    modelFallbacks?: string[];
    backendId?: string;
  }) => {
    const observation = wrapper.observeAgentEnd(event);
    if (!observation.target || observation.outcome === "settled") return;
    if (observation.outcome === "failed") {
      targetFailed = true;
      targetFailureError = event.errorRecord
        ? (reconstructRecordedError(event.errorRecord) as WorkflowError)
        : new WorkflowError(event.error ?? "live target failed", event.errorCode ?? WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: false,
          });
    }
    stopForObservation();
  };
  let run: WorkflowRunResult<T>;
  for (;;) {
    const attemptManager = manager;
    attemptManager.on("agentEnd", onAgentEnd);
    try {
      const clonedArgs = recording.args === undefined ? undefined : jsonClone(recording.args);
      run = (await attemptManager.runSync(recording.script, clonedArgs, {
        agent: wrapper,
        confirm: wrapper.confirm,
        runId: rootRunId,
        executionMode: { kind: "isolation", baselineRunId: options.baselineRunId },
        cwd: executionCwd,
        journaling,
        scriptBackends: options.scriptBackends,
        onProgress: options.onProgress,
        signal: combinedSignal,
        concurrency: options.concurrency ?? recording.limits?.concurrency,
        agentTimeoutMs:
          options.agentTimeoutMs !== undefined
            ? options.agentTimeoutMs
            : recording.limits?.agentTimeoutMs,
        agentRetries: options.agentRetries ?? recording.limits?.agentRetries,
        maxAgents: recording.limits?.maxAgents,
        onNestedWorkflow: (_ordinal, childRunId) => {
          wrapper.noteNestedWorkflow(`nested workflow scope ${childRunId} was invoked during isolation`);
          stopForObservation();
        },
      })) as WorkflowRunResult<T>;
      break;
    } catch (error) {
      const workflowError = asWorkflowError(error);
      if (
        workflowError.code === WorkflowErrorCode.PERSISTENCE_ERROR &&
        workflowError.message.startsWith("run id already exists:")
      ) {
        stopping = false;
        try {
          createAttempt();
        } catch (attemptError) {
          throw asWorkflowError(attemptError);
        }
        continue;
      }
      throw workflowError;
    } finally {
      attemptManager.off("agentEnd", onAgentEnd);
    }
  }

  if (run.nestedWorkflows && !wrapper.getFatalError()) {
    wrapper.noteNestedWorkflow("the completed isolation run reported a nested workflow invocation");
    internal.abort();
  }
  let report = wrapper.finalize({ scriptCompleted: run.status === "completed" });
  const fatal = wrapper.getFatalError();
  let status: IsolationRunResult<T>["status"];
  let classifiedError: WorkflowError | undefined;

  if (report.divergence?.kind === "target-unsettled") {
    internal.abort();
    status = "failed";
    classifiedError = fatal ?? errorFromDivergence(report.divergence);
  } else if (fatal) {
    status = "diverged";
    classifiedError = fatal;
  } else if (targetFailed) {
    status = "target-failed";
    classifiedError = targetFailureError;
  } else if (callerAbortObserved) {
    status = "failed";
    classifiedError =
      manager.getRun(rootRunId)?.error ??
      new WorkflowError("workflow aborted by caller", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
  } else if (run.status !== "completed") {
    status = "failed";
    classifiedError =
      manager.getRun(rootRunId)?.error ??
      new WorkflowError(run.reason ?? `isolation run ended with status ${run.status}`, WorkflowErrorCode.UNKNOWN, {
        recoverable: false,
      });
  } else if (
    (report.unvisitedRecordedIndexes?.length ?? 0) > 0 ||
    (report.unreachedTargets?.length ?? 0) > 0
  ) {
    status = "diverged";
  } else {
    status = "completed";
  }

  if (journaling) {
    try {
      const lease = persistence.acquireRunLease(rootRunId);
      if (!lease) throw new Error(`isolation artifact ${rootRunId} is leased`);
      try {
        const artifact = persistence.load(rootRunId);
        if (!artifact) throw new Error(`isolation artifact ${rootRunId} is missing`);
        const executionMode = artifact.executionMode as Record<string, unknown> | undefined;
        if (
          !executionMode ||
          Object.keys(executionMode).length !== 2 ||
          executionMode.kind !== "isolation" ||
          executionMode.baselineRunId !== options.baselineRunId
        ) {
          throw new Error(`isolation artifact ${rootRunId} was replaced`);
        }
        persistence.save({ ...artifact, replayReport: report });
      } finally {
        persistence.releaseRunLease(lease);
      }
    } catch (error) {
      const reason = errorMessage(error);
      try {
        console.warn(`[workflow-isolation] ${reason}`);
      } catch {
        // Logging is best-effort; the in-process report is authoritative.
      }
      report = wrapper.addPersistenceFailure(reason);
    }
  }

  return {
    status,
    run,
    ...(classifiedError === undefined ? {} : { error: classifiedError }),
    report,
  };
}
