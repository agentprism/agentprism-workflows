import type {
  AgentSessionRecord,
  AgentUsage,
  CheckpointContext,
  JournalEntry,
  ResumePolicy,
  WorkflowCallRecord,
  WorkflowResumeCallDecision,
  WorkflowResumeCallLiveReason,
  WorkflowResumeDisabledReason,
  WorkflowResumeFallbackReason,
  WorkflowResumeReport,
  WorkflowResumeSafety,
} from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  type PersistedCheckpointInjection,
  type PersistedResumeCandidate,
  type PersistedResumeSeed,
  type PersistedRunState,
} from "./run-persistence.js";
import type { RunEnvironmentIdentity } from "./run-environment.js";
import {
  appendIndexValue,
  buildResumeExactIndex,
  environmentsEqual,
  isRunEnvironmentIdentity,
  resumeContentKey,
  resumeExactKey,
  resumeOccurrenceKey,
  type ResumeContentKey,
  type ResumeExactKey,
} from "./resume-identity.js";
import { validateResumeSafetyMarker } from "./resume.js";
import { cloneFrozenStrictJson, cloneStrictJsonValue, deepFreeze } from "./strict-json.js";

const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL_STATUSES = new Set(["completed", "paused", "failed"]);
const RESUME_MATCHES = new Set(["path-hash", "unique-hash", "index-hash"]);
const RESUME_SAFETY = new Set(["declared-read-only", "isolated-worktree"]);

export interface ResumeRuntimeIdentity {
  engineVersion?: string;
  node: string;
  v8: string;
  pathFormat: number;
  inputsFormat: number;
  checkpointInputsFormat: number;
}

export interface ResumeAdmissionInput {
  source: PersistedRunState;
  requestedPolicy: ResumePolicy;
  current: {
    effectiveCwd: string;
    runtime: ResumeRuntimeIdentity;
    environment?: RunEnvironmentIdentity;
  };
  checkpointReplies?: Record<string, unknown>;
}

export interface ResumeAdmissionFacts {
  pendingRepresented: boolean;
  allCallsRepresented: boolean;
  filesystemStable: boolean;
  allAgentsSafe: boolean;
  allCheckpointResultsHostDecisions: boolean;
}

export type ResumeAdmissionDecision =
  | {
      strategy: "identity-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      seed: PersistedResumeSeed;
      facts: ResumeAdmissionFacts;
    }
  | {
      strategy: "positional-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      fallbackReason: WorkflowResumeFallbackReason;
      eligibility: "legacy" | "safe-prefix" | "all-live";
      checkpointSeed?: PersistedResumeSeed;
      legacyCheckpointReply?: ParsedCheckpointReply;
      facts?: ResumeAdmissionFacts;
    }
  | {
      strategy: "live";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      disabledReason: WorkflowResumeDisabledReason;
      facts?: ResumeAdmissionFacts;
    };

export interface ParsedCheckpointReply {
  recordedIndex: number;
  decision: unknown;
}

export type IndexedResumeSource =
  | { type: "candidate"; candidate: PersistedResumeCandidate }
  | { type: "injection"; injection: PersistedCheckpointInjection };

export interface ResumeCandidateIndexes {
  readonly exact: ReadonlyMap<ResumeExactKey, readonly IndexedResumeSource[]>;
  readonly content: Readonly<
    Record<"agent" | "checkpoint", ReadonlyMap<ResumeContentKey, readonly IndexedResumeSource[]>>
  >;
  readonly hash: Readonly<
    Record<"agent" | "checkpoint", ReadonlyMap<string, readonly IndexedResumeSource[]>>
  >;
}

export interface ResumeMatchInput {
  kind: "agent" | "checkpoint";
  hash: string;
  path?: string;
  inputsHash?: string;
  cacheOpen: boolean;
  consumed: ReadonlySet<string>;
  hasSchema?: boolean;
  resumeDeclared?: boolean;
  resolvedIsolation?: "worktree";
  hasAgentCwd?: boolean;
}

export type ResumeMatchDecision =
  | {
      action: "replay";
      source: IndexedResumeSource;
      match: "path-hash" | "unique-hash";
    }
  | {
      action: "live";
      reason: Extract<
        WorkflowResumeCallLiveReason,
        | "not-recorded"
        | "path-missing"
        | "inputs-missing"
        | "inputs-changed"
        | "ambiguous-identity"
        | "ambiguous-content"
        | "candidate-consumed"
        | "empty-output"
        | "safety-changed"
        | "unsafe-suffix"
      >;
      remove?: IndexedResumeSource;
      closesSuffix?: true;
    };

export interface PositionalResumeMatchInput {
  index: number;
  kind: "agent" | "checkpoint";
  hash: string;
  inputsHash?: string;
  eligibility: "legacy" | "safe-prefix" | "all-live";
  firstMiss: number;
  cached?: JournalEntry;
  sourceCall?: WorkflowCallRecord;
  hasSchema?: boolean;
  resumeDeclared?: boolean;
  resolvedIsolation?: "worktree";
  hasAgentCwd?: boolean;
}

export type PositionalResumeMatchDecision =
  | {
      action: "replay";
      entry: JournalEntry;
      match: "index-hash";
      logicalBudgetDebit?: number;
      nextFirstMiss: number;
    }
  | {
      action: "live";
      reason: "positional-miss" | "positional-suffix";
      nextFirstMiss: number;
    };

type ValidatedManifest = {
  calls: WorkflowCallRecord[];
  journalByIndex: Map<number, JournalEntry>;
};

type ValidatedSeed = {
  candidates: PersistedResumeCandidate[];
  injections: PersistedCheckpointInjection[];
};

class ImmutableMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(map: Map<K, V>) {
    this.#map = map;
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#map.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPath(value: unknown): value is string {
  return isNonEmptyString(value) && !value.includes("\u0000");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStrictJson(value: unknown): boolean {
  return cloneStrictJsonValue(value).ok;
}

function strictClone<T>(value: T): T | undefined {
  const cloned = cloneFrozenStrictJson(value);
  return cloned.ok ? cloned.clone as T : undefined;
}

function isUsage(value: unknown): value is AgentUsage {
  if (!isRecord(value)) return false;
  return ["input", "output", "cacheRead", "cacheWrite", "total", "cost"].every((field) =>
    isFiniteNonNegative(value[field]),
  ) && isStrictJson(value);
}

function isSession(value: unknown): value is AgentSessionRecord {
  if (!isRecord(value) || !isRecord(value.reopen)) return false;
  return (
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.backendId) &&
    isNonEmptyString(value.cwd) &&
    isNonNegativeSafeInteger(value.callIndex) &&
    typeof value.label === "string" &&
    (value.phase === undefined || typeof value.phase === "string") &&
    typeof value.keptOpen === "boolean" &&
    typeof value.reopen.load === "boolean" &&
    typeof value.reopen.resume === "boolean" &&
    typeof value.reopen.list === "boolean" &&
    (value.reopen.fork === undefined || typeof value.reopen.fork === "boolean") &&
    isStrictJson(value)
  );
}

function isResumeSafety(value: unknown): value is WorkflowResumeSafety {
  return typeof value === "string" && RESUME_SAFETY.has(value);
}

function isReplayProvenance(value: unknown): value is NonNullable<WorkflowCallRecord["replay"]> {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "sourceRunId",
    "recordedIndex",
    "match",
    "logicalBudgetDebit",
    "sourceResumeSafety",
    "checkpointHostDecision",
    "checkpointInjected",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return (
    isNonEmptyString(value.sourceRunId) &&
    isNonNegativeSafeInteger(value.recordedIndex) &&
    typeof value.match === "string" &&
    RESUME_MATCHES.has(value.match) &&
    (value.logicalBudgetDebit === undefined || isFiniteNonNegative(value.logicalBudgetDebit)) &&
    (value.sourceResumeSafety === undefined || isResumeSafety(value.sourceResumeSafety)) &&
    (value.checkpointHostDecision === undefined || value.checkpointHostDecision === true) &&
    (value.checkpointInjected === undefined || value.checkpointInjected === true) &&
    (value.checkpointInjected !== true || value.checkpointHostDecision === true) &&
    isStrictJson(value)
  );
}

function effectiveLogicalDebit(call: WorkflowCallRecord): number | undefined {
  if (call.origin === "runner") {
    return isFiniteNonNegative(call.budgetDebit) ? call.budgetDebit : undefined;
  }
  if (call.origin === "journal-replay") {
    return call.budgetDebit === 0 && isFiniteNonNegative(call.replay?.logicalBudgetDebit)
      ? call.replay.logicalBudgetDebit
      : undefined;
  }
  return undefined;
}

function isHostCheckpointDecision(call: WorkflowCallRecord): boolean {
  return call.kind === "checkpoint" && call.outcome === "result" && (
    call.origin === "confirm" ||
    (call.origin === "journal-replay" && call.replay?.checkpointHostDecision === true)
  );
}

function isValidSafetyMarker(call: WorkflowCallRecord): boolean {
  return validateResumeSafetyMarker(call, false);
}

function validateReplayForCall(call: WorkflowCallRecord): boolean {
  const mustHaveReplay = call.origin === "journal-replay" && call.outcome === "result";
  if (!mustHaveReplay) return call.replay === undefined;
  if (!isReplayProvenance(call.replay)) return false;
  if (call.kind === "agent") {
    return (
      isFiniteNonNegative(call.replay.logicalBudgetDebit) &&
      isResumeSafety(call.replay.sourceResumeSafety) &&
      call.replay.sourceResumeSafety === call.resumeSafety &&
      call.replay.checkpointHostDecision === undefined &&
      call.replay.checkpointInjected === undefined
    );
  }
  return (
    call.replay.logicalBudgetDebit === undefined &&
    call.replay.sourceResumeSafety === undefined &&
    call.replay.checkpointHostDecision === true
  );
}

function validateBasicCall(value: unknown, sourceRunId: string): value is WorkflowCallRecord {
  if (!isRecord(value)) return false;
  if (
    !isNonNegativeSafeInteger(value.index) ||
    (value.kind !== "agent" && value.kind !== "checkpoint") ||
    !isHash(value.hash) ||
    !["result", "null", "error"].includes(String(value.outcome)) ||
    !["runner", "journal-replay", "confirm", "headless", "engine"].includes(String(value.origin)) ||
    value.scope !== sourceRunId
  ) {
    return false;
  }
  if (value.path !== undefined && typeof value.path !== "string") return false;
  if (value.inputsHash !== undefined && typeof value.inputsHash !== "string") return false;
  if (value.resumeSafety !== undefined && !isResumeSafety(value.resumeSafety)) return false;
  if (value.isolation !== undefined && value.isolation !== "worktree") return false;
  if (value.worktree !== undefined && value.worktree !== true) return false;
  if (value.budgetDebit !== undefined && !isFiniteNonNegative(value.budgetDebit)) return false;
  if (value.settlementOrdinal !== undefined && !isPositiveSafeInteger(value.settlementOrdinal)) return false;
  if (value.usage !== undefined && !isUsage(value.usage)) return false;
  if (value.outcome === "result") {
    if (value.error !== undefined) return false;
  } else if (!hasOwn(value, "error") || !isStrictJson(value.error)) {
    return false;
  }
  return isStrictJson(value);
}

function validateCallFacts(call: WorkflowCallRecord): boolean {
  if (!isValidSafetyMarker(call) || !validateReplayForCall(call)) return false;
  if (
    call.worktree === true &&
    (call.kind !== "agent" || call.origin !== "runner" || call.isolation !== "worktree")
  ) {
    return false;
  }
  if (call.outcome !== "result") return true;
  if (!isPath(call.path) || !isHash(call.inputsHash)) return false;
  if (call.kind === "agent") {
    if (call.origin !== "runner" && call.origin !== "journal-replay") return false;
    return effectiveLogicalDebit(call) !== undefined;
  }
  if (call.budgetDebit !== undefined) return false;
  return call.origin === "confirm" || call.origin === "headless" || isHostCheckpointDecision(call);
}

function validateJournalEntry(value: unknown, sourceRunId: string): value is JournalEntry {
  if (!isRecord(value)) return false;
  if (value.session !== undefined && (!isSession(value.session) || value.session.callIndex !== value.index)) {
    return false;
  }
  return (
    isNonNegativeSafeInteger(value.index) &&
    isHash(value.hash) &&
    (value.kind === "agent" || value.kind === "checkpoint") &&
    value.scope === sourceRunId &&
    hasOwn(value, "result") &&
    isStrictJson(value.result) &&
    (value.session === undefined || isSession(value.session)) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.call === undefined || isStrictJson(value.call)) &&
    isStrictJson(value)
  );
}

function validateManifest(source: PersistedRunState, sourceRunId: string): ValidatedManifest | undefined {
  const calls = source.calls as unknown[];
  const journal = source.journal as unknown[];
  const allocated = source.callsAllocated as number;
  const callsByIndex = new Map<number, WorkflowCallRecord>();
  for (const value of calls) {
    if (!validateBasicCall(value, sourceRunId) || callsByIndex.has(value.index)) return undefined;
    callsByIndex.set(value.index, value);
  }
  if (callsByIndex.size !== allocated) return undefined;
  for (let index = 0; index < allocated; index++) {
    if (!callsByIndex.has(index)) return undefined;
  }

  const journalByIndex = new Map<number, JournalEntry>();
  for (const value of journal) {
    if (!validateJournalEntry(value, sourceRunId) || journalByIndex.has(value.index)) return undefined;
    journalByIndex.set(value.index, value);
  }

  for (const call of callsByIndex.values()) {
    const entry = journalByIndex.get(call.index);
    if (call.outcome === "result") {
      if (!entry || entry.hash !== call.hash || entry.kind !== call.kind) return undefined;
    } else if (entry) {
      return undefined;
    }
  }
  for (const entry of journalByIndex.values()) {
    const call = callsByIndex.get(entry.index);
    if (!call || call.outcome !== "result" || call.hash !== entry.hash || call.kind !== entry.kind) {
      return undefined;
    }
  }
  return {
    calls: [...callsByIndex.values()].sort((left, right) => left.index - right.index),
    journalByIndex,
  };
}

function validateCandidate(value: unknown): PersistedResumeCandidate | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.sourceRunId) ||
    !isNonNegativeSafeInteger(value.recordedIndex)
  ) {
    return undefined;
  }
  if (!validateBasicCall(value.call, value.sourceRunId) || !validateCallFacts(value.call)) return undefined;
  if (!validateJournalEntry(value.entry, value.sourceRunId)) return undefined;
  if (
    value.call.index !== value.recordedIndex ||
    value.entry.index !== value.recordedIndex ||
    value.call.outcome !== "result" ||
    value.call.kind !== value.entry.kind ||
    value.call.hash !== value.entry.hash
  ) {
    return undefined;
  }
  if (value.call.kind === "agent") {
    const debit = effectiveLogicalDebit(value.call);
    if (value.call.resumeSafety === undefined || debit === undefined || value.logicalBudgetDebit !== debit) {
      return undefined;
    }
  } else if (value.logicalBudgetDebit !== undefined || !isHostCheckpointDecision(value.call)) {
    return undefined;
  }
  return strictClone(value as unknown as PersistedResumeCandidate);
}

function validateInjection(value: unknown): PersistedCheckpointInjection | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.sourceRunId) ||
    !isNonNegativeSafeInteger(value.recordedIndex) ||
    !isHash(value.hash) ||
    !isPath(value.path) ||
    !isHash(value.inputsHash) ||
    !hasOwn(value, "decision") ||
    !isStrictJson(value.decision)
  ) {
    return undefined;
  }
  return strictClone(value as unknown as PersistedCheckpointInjection);
}

function validateSeed(source: PersistedRunState, sourceRunId: string): ValidatedSeed | undefined {
  if (source.resumeSeed === undefined) return { candidates: [], injections: [] };
  const seed = source.resumeSeed as unknown;
  if (
    !isRecord(seed) ||
    seed.format !== "identity-v1" ||
    seed.sourceRunId !== sourceRunId ||
    !Array.isArray(seed.candidates) ||
    (seed.checkpointInjections !== undefined && !Array.isArray(seed.checkpointInjections))
  ) {
    return undefined;
  }
  const candidates: PersistedResumeCandidate[] = [];
  const injections: PersistedCheckpointInjection[] = [];
  const occurrences = new Set<string>();
  for (const value of seed.candidates) {
    const candidate = validateCandidate(value);
    if (!candidate) return undefined;
    const key = resumeOccurrenceKey(candidate.sourceRunId, candidate.recordedIndex);
    if (occurrences.has(key)) return undefined;
    occurrences.add(key);
    candidates.push(candidate);
  }
  for (const value of seed.checkpointInjections ?? []) {
    const injection = validateInjection(value);
    if (!injection) return undefined;
    const key = resumeOccurrenceKey(injection.sourceRunId, injection.recordedIndex);
    if (occurrences.has(key)) return undefined;
    occurrences.add(key);
    injections.push(injection);
  }
  return { candidates, injections };
}

function validationError(message: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

function pendingCheckpointContext(source: PersistedRunState): CheckpointContext | undefined {
  if (source.pauseReason !== "checkpoint_required" || !isRecord(source.checkpointContext)) return undefined;
  return source.checkpointContext as unknown as CheckpointContext;
}

export function parseCheckpointReplies(
  replies: Record<string, unknown> | undefined,
  context: CheckpointContext | undefined,
): ParsedCheckpointReply | undefined {
  if (replies === undefined) return undefined;
  if (!isRecord(replies)) throw validationError("checkpointReplies must be an object");
  const keys = Reflect.ownKeys(replies).filter((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(replies, key);
    return descriptor?.enumerable === true;
  });
  if (keys.length === 0) return undefined;
  if (!context || !isNonNegativeSafeInteger(context.callIndex)) {
    throw validationError("checkpointReplies requires a pending durable checkpoint");
  }
  let selected: { key: string; index: number } | undefined;
  for (const key of keys) {
    if (typeof key !== "string") throw validationError("checkpointReplies keys must be canonical indexes");
    const index = Number(key);
    if (!isNonNegativeSafeInteger(index) || String(index) !== key) {
      throw validationError(`checkpointReplies key ${JSON.stringify(key)} is not a canonical index`);
    }
    if (index !== context.callIndex || selected !== undefined) {
      throw validationError(`checkpointReplies key ${JSON.stringify(key)} does not name the pending checkpoint`);
    }
    selected = { key, index };
  }
  if (!selected) return undefined;
  let decision: unknown;
  try {
    decision = Reflect.get(replies, selected.key);
  } catch {
    throw new WorkflowError("checkpoint reply could not be read", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
      recoverable: false,
    });
  }
  const captured = cloneFrozenStrictJson(decision);
  if (!captured.ok) {
    throw new WorkflowError(
      `checkpoint reply is not strict JSON at ${captured.path}`,
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      { recoverable: false },
    );
  }
  return { recordedIndex: selected.index, decision: captured.clone };
}

function pendingInjection(
  source: PersistedRunState,
  calls: readonly WorkflowCallRecord[],
  seed: ValidatedSeed,
  reply: ParsedCheckpointReply | undefined,
): { valid: boolean; injection?: PersistedCheckpointInjection } {
  if (!reply) return { valid: true };
  const context = pendingCheckpointContext(source);
  const call = calls.find((candidate) => candidate.index === reply.recordedIndex);
  if (
    source.status !== "paused" ||
    !context ||
    !isHash(context.hash) ||
    call?.kind !== "checkpoint" ||
    call.outcome !== "error" ||
    call.origin !== "headless" ||
    !isRecord(call.error) ||
    call.error.form !== "workflow-error" ||
    call.error.code !== WorkflowErrorCode.CHECKPOINT_REQUIRED ||
    call.hash !== context.hash ||
    !isPath(call.path) ||
    !isHash(call.inputsHash)
  ) {
    return { valid: false };
  }
  const duplicateRoot = calls.some((other) =>
    other.kind === "checkpoint" &&
    other.index !== call.index &&
    other.hash === call.hash &&
    other.inputsHash === call.inputsHash,
  );
  const duplicateCandidate = seed.candidates.some((candidate) =>
    candidate.call.kind === "checkpoint" &&
    candidate.call.hash === call.hash &&
    candidate.call.inputsHash === call.inputsHash,
  );
  const duplicateInjection = seed.injections.some((injection) =>
    injection.hash === call.hash && injection.inputsHash === call.inputsHash,
  );
  if (duplicateRoot || duplicateCandidate || duplicateInjection) return { valid: true };
  const injection = strictClone<PersistedCheckpointInjection>({
    sourceRunId: source.runId,
    recordedIndex: call.index,
    hash: call.hash,
    path: call.path,
    inputsHash: call.inputsHash,
    decision: reply.decision,
  });
  return injection ? { valid: true, injection } : { valid: false };
}

export function cloneResumeCandidate(
  sourceRunId: string,
  entry: JournalEntry,
  call: WorkflowCallRecord,
): PersistedResumeCandidate | undefined {
  if (
    !isNonEmptyString(sourceRunId) ||
    !validateBasicCall(call, sourceRunId) ||
    !validateCallFacts(call) ||
    !validateJournalEntry(entry, sourceRunId) ||
    call.outcome !== "result" ||
    call.index !== entry.index ||
    call.hash !== entry.hash ||
    call.kind !== entry.kind
  ) {
    return undefined;
  }
  const logicalBudgetDebit = call.kind === "agent" ? effectiveLogicalDebit(call) : undefined;
  if (call.kind === "agent" && (call.resumeSafety === undefined || logicalBudgetDebit === undefined)) {
    return undefined;
  }
  if (call.kind === "checkpoint" && !isHostCheckpointDecision(call)) return undefined;
  return strictClone({
    sourceRunId,
    recordedIndex: call.index,
    entry,
    call,
    ...(logicalBudgetDebit === undefined ? {} : { logicalBudgetDebit }),
  });
}

export function normalizeResumeSeed(input: {
  sourceRunId: string;
  promoted?: readonly PersistedResumeCandidate[];
  retained?: readonly PersistedResumeCandidate[];
  retainedInjections?: readonly PersistedCheckpointInjection[];
  pendingInjection?: PersistedCheckpointInjection;
}): PersistedResumeSeed | undefined {
  if (!isNonEmptyString(input.sourceRunId)) return undefined;
  const candidates: PersistedResumeCandidate[] = [];
  const checkpointInjections: PersistedCheckpointInjection[] = [];
  const occurrences = new Set<string>();
  for (const value of [...(input.promoted ?? []), ...(input.retained ?? [])]) {
    const candidate = validateCandidate(value);
    if (!candidate) return undefined;
    const key = resumeOccurrenceKey(candidate.sourceRunId, candidate.recordedIndex);
    if (occurrences.has(key)) return undefined;
    occurrences.add(key);
    candidates.push(candidate);
  }
  for (const value of [
    ...(input.retainedInjections ?? []),
    ...(input.pendingInjection ? [input.pendingInjection] : []),
  ]) {
    const injection = validateInjection(value);
    if (!injection) return undefined;
    const key = resumeOccurrenceKey(injection.sourceRunId, injection.recordedIndex);
    if (occurrences.has(key)) return undefined;
    occurrences.add(key);
    checkpointInjections.push(injection);
  }
  return deepFreeze({
    format: "identity-v1",
    sourceRunId: input.sourceRunId,
    candidates,
    ...(checkpointInjections.length === 0 ? {} : { checkpointInjections }),
  });
}

function liveDecision(
  sourceRunId: string,
  requestedPolicy: ResumePolicy,
  disabledReason: Extract<ResumeAdmissionDecision, { strategy: "live" }>["disabledReason"],
  facts?: ResumeAdmissionFacts,
): ResumeAdmissionDecision {
  return {
    strategy: "live",
    sourceRunId,
    requestedPolicy,
    disabledReason,
    ...(facts ? { facts } : {}),
  };
}

export function admitResumeSource(input: ResumeAdmissionInput): ResumeAdmissionDecision {
  const { source, requestedPolicy, current } = input;
  const sourceRunId = typeof source?.runId === "string" ? source.runId : "";
  const reply = parseCheckpointReplies(input.checkpointReplies, pendingCheckpointContext(source));
  const markerAbsent = !isRecord(source) || !hasOwn(source, "resume") || source.resume === undefined;
  if (!markerAbsent && (!isRecord(source.resume) || source.resume.format !== "identity-v1")) {
    return liveDecision(sourceRunId, requestedPolicy, "unsupported-format");
  }
  if (source.status === "aborted" || source.abortSignaled === true) {
    return liveDecision(sourceRunId, requestedPolicy, "abort-residue");
  }
  if (!TERMINAL_STATUSES.has(String(source.status))) {
    return liveDecision(sourceRunId, requestedPolicy, "source-not-terminal");
  }
  if (source.executionMode !== undefined) {
    return liveDecision(sourceRunId, requestedPolicy, "isolation-recording");
  }
  if (markerAbsent || source.legacyResume === true) {
    return {
      strategy: "positional-v1",
      sourceRunId,
      requestedPolicy,
      fallbackReason: markerAbsent ? "legacy-recording" : "legacy-resume",
      eligibility: "legacy",
      ...(reply ? { legacyCheckpointReply: reply } : {}),
    };
  }

  const resume = source.resume as NonNullable<PersistedRunState["resume"]>;
  if (
    !isNonEmptyString(sourceRunId) ||
    typeof source.effectiveCwd !== "string" ||
    !isRecord(source.runtime) ||
    typeof source.runtime.node !== "string" ||
    typeof source.runtime.v8 !== "string" ||
    !Number.isSafeInteger(source.runtime.pathFormat) ||
    !Number.isSafeInteger(source.runtime.inputsFormat) ||
    !Number.isSafeInteger(source.runtime.checkpointInputsFormat) ||
    !Array.isArray(source.journal) ||
    !Array.isArray(source.calls) ||
    !isNonNegativeSafeInteger(source.callsAllocated)
  ) {
    return liveDecision(sourceRunId, requestedPolicy, "resume-metadata-missing");
  }
  if (source.effectiveCwd !== current.effectiveCwd) {
    return liveDecision(sourceRunId, requestedPolicy, "cwd-mismatch");
  }
  const inputsFormatLegacy =
    source.runtime.inputsFormat < 2 && current.runtime.inputsFormat === 2;
  if (
    source.runtime.node !== current.runtime.node ||
    source.runtime.v8 !== current.runtime.v8 ||
    source.runtime.pathFormat !== current.runtime.pathFormat ||
    (!inputsFormatLegacy && source.runtime.inputsFormat !== current.runtime.inputsFormat) ||
    source.runtime.checkpointInputsFormat !== current.runtime.checkpointInputsFormat
  ) {
    return liveDecision(sourceRunId, requestedPolicy, "runtime-mismatch");
  }

  if (
    resume.terminalEnvironment === undefined &&
    source.status === "paused" &&
    source.pauseReason === "interrupted"
  ) {
    const environmentStable =
      isRunEnvironmentIdentity(source.environment) &&
      isRunEnvironmentIdentity(current.environment) &&
      environmentsEqual(source.environment, current.environment);
    return {
      strategy: "positional-v1",
      sourceRunId,
      requestedPolicy,
      fallbackReason: "crash-residue",
      eligibility: environmentStable ? "legacy" : "all-live",
      ...(reply ? { legacyCheckpointReply: reply } : {}),
    };
  }
  if (inputsFormatLegacy) {
    return {
      strategy: "positional-v1",
      sourceRunId,
      requestedPolicy,
      fallbackReason: "inputs-format-legacy",
      eligibility: "legacy",
      ...(reply ? { legacyCheckpointReply: reply } : {}),
    };
  }

  if (
    !isRunEnvironmentIdentity(resume.terminalEnvironment) ||
    !isRunEnvironmentIdentity(source.environment) ||
    !isRunEnvironmentIdentity(current.environment)
  ) {
    return liveDecision(sourceRunId, requestedPolicy, "environment-missing");
  }
  if (!environmentsEqual(resume.terminalEnvironment, current.environment)) {
    return liveDecision(sourceRunId, requestedPolicy, "environment-mismatch");
  }

  const manifest = validateManifest(source, sourceRunId);
  if (!manifest) return liveDecision(sourceRunId, requestedPolicy, "manifest-invalid");
  if (!manifest.calls.every(validateCallFacts)) {
    return liveDecision(sourceRunId, requestedPolicy, "manifest-invalid");
  }
  const retained = validateSeed(source, sourceRunId);
  if (!retained) return liveDecision(sourceRunId, requestedPolicy, "resume-seed-invalid");
  const preparedInjection = pendingInjection(source, manifest.calls, retained, reply);
  if (!preparedInjection.valid) return liveDecision(sourceRunId, requestedPolicy, "manifest-invalid");

  const pendingRepresented =
    source.status === "paused" &&
    source.pauseReason === "checkpoint_required" &&
    preparedInjection.injection !== undefined;
  const pendingIndex = preparedInjection.injection?.recordedIndex;
  const allCallsRepresented = manifest.calls.every((call) =>
    call.outcome === "result" || (pendingRepresented && call.index === pendingIndex),
  );
  const filesystemStable = environmentsEqual(source.environment, resume.terminalEnvironment);
  const allAgentsSafe =
    manifest.calls.every((call) => call.kind !== "agent" || call.resumeSafety !== undefined) &&
    retained.candidates.every((candidate) =>
      candidate.call.kind !== "agent" || candidate.call.resumeSafety !== undefined,
    );
  const allCheckpointResultsHostDecisions = manifest.calls.every((call) =>
    call.kind !== "checkpoint" || call.outcome !== "result" || isHostCheckpointDecision(call),
  );
  const facts: ResumeAdmissionFacts = {
    pendingRepresented,
    allCallsRepresented,
    filesystemStable,
    allAgentsSafe,
    allCheckpointResultsHostDecisions,
  };

  const fallbackReason: WorkflowResumeFallbackReason | undefined =
    requestedPolicy === "positional"
      ? "forced-positional"
      : source.nestedWorkflows === true
        ? "nested-workflows"
        : !allAgentsSafe || !allCheckpointResultsHostDecisions || !allCallsRepresented
          ? "unsafe-recording"
          : undefined;
  if (fallbackReason) {
    const checkpointSeed = preparedInjection.injection
      ? normalizeResumeSeed({ sourceRunId, pendingInjection: preparedInjection.injection })
      : undefined;
    return {
      strategy: "positional-v1",
      sourceRunId,
      requestedPolicy,
      fallbackReason,
      eligibility: source.nestedWorkflows === true || !filesystemStable ? "all-live" : "safe-prefix",
      ...(checkpointSeed ? { checkpointSeed } : {}),
      facts,
    };
  }
  if (!filesystemStable) {
    return liveDecision(sourceRunId, requestedPolicy, "source-environment-drift", facts);
  }
  const promoted: PersistedResumeCandidate[] = [];
  for (const call of manifest.calls) {
    if (call.outcome !== "result") continue;
    if (call.kind === "checkpoint" && !isHostCheckpointDecision(call)) continue;
    const candidate = cloneResumeCandidate(
      sourceRunId,
      manifest.journalByIndex.get(call.index) as JournalEntry,
      call,
    );
    if (candidate) promoted.push(candidate);
  }
  const seed = normalizeResumeSeed({
    sourceRunId,
    promoted,
    retained: retained.candidates,
    retainedInjections: retained.injections,
    pendingInjection: preparedInjection.injection,
  });
  if (!seed) return liveDecision(sourceRunId, requestedPolicy, "resume-seed-invalid", facts);
  return { strategy: "identity-v1", sourceRunId, requestedPolicy, seed, facts };
}

function indexedSourceFacts(source: IndexedResumeSource): {
  kind: "agent" | "checkpoint";
  hash: string;
  path: string;
  inputsHash: string;
} {
  if (source.type === "injection") {
    return { kind: "checkpoint", ...source.injection };
  }
  return {
    kind: source.candidate.call.kind,
    hash: source.candidate.call.hash,
    path: source.candidate.call.path as string,
    inputsHash: source.candidate.call.inputsHash as string,
  };
}

export function buildResumeCandidateIndexes(seed: PersistedResumeSeed): ResumeCandidateIndexes {
  const sources: IndexedResumeSource[] = [
    ...seed.candidates.map((candidate) => ({ type: "candidate" as const, candidate })),
    ...(seed.checkpointInjections ?? []).map((injection) => ({ type: "injection" as const, injection })),
  ];
  const exact = buildResumeExactIndex(sources, indexedSourceFacts);
  const content = {
    agent: new Map<ResumeContentKey, IndexedResumeSource[]>(),
    checkpoint: new Map<ResumeContentKey, IndexedResumeSource[]>(),
  };
  const hash = {
    agent: new Map<string, IndexedResumeSource[]>(),
    checkpoint: new Map<string, IndexedResumeSource[]>(),
  };
  for (const source of sources) {
    const facts = indexedSourceFacts(source);
    appendIndexValue(content[facts.kind], resumeContentKey(facts.hash, facts.inputsHash), source);
    appendIndexValue(hash[facts.kind], facts.hash, source);
  }
  for (const values of [
    ...exact.values(),
    ...content.agent.values(),
    ...content.checkpoint.values(),
    ...hash.agent.values(),
    ...hash.checkpoint.values(),
  ]) Object.freeze(values);
  return Object.freeze({
    exact: new ImmutableMapView(exact),
    content: Object.freeze({
      agent: new ImmutableMapView(content.agent),
      checkpoint: new ImmutableMapView(content.checkpoint),
    }),
    hash: Object.freeze({
      agent: new ImmutableMapView(hash.agent),
      checkpoint: new ImmutableMapView(hash.checkpoint),
    }),
  });
}

export function indexedSourceOccurrence(source: IndexedResumeSource): string {
  const value = source.type === "candidate" ? source.candidate : source.injection;
  return resumeOccurrenceKey(value.sourceRunId, value.recordedIndex);
}

function selectedSource(
  indexes: ResumeCandidateIndexes,
  input: ResumeMatchInput,
): {
  source?: IndexedResumeSource;
  match?: "path-hash" | "unique-hash";
  reason?: ResumeMatchDecision & { action: "live" };
} {
  const exact = indexes.exact.get(resumeExactKey(input.kind, input.path as string, input.hash)) ?? [];
  if (exact.length > 1) return { reason: { action: "live", reason: "ambiguous-identity" } };
  if (exact.length === 1) {
    const source = exact[0];
    if (indexedSourceFacts(source).inputsHash !== input.inputsHash) {
      return { reason: { action: "live", reason: "inputs-changed" } };
    }
    if (input.consumed.has(indexedSourceOccurrence(source))) {
      return { reason: { action: "live", reason: "candidate-consumed" } };
    }
    return { source, match: "path-hash" };
  }
  const content = indexes.content[input.kind].get(
    resumeContentKey(input.hash, input.inputsHash as string),
  ) ?? [];
  if (content.length > 1) return { reason: { action: "live", reason: "ambiguous-content" } };
  if (content.length === 0) {
    const hashRows = indexes.hash[input.kind].get(input.hash) ?? [];
    return { reason: { action: "live", reason: hashRows.length === 0 ? "not-recorded" : "inputs-changed" } };
  }
  const source = content[0];
  if (input.consumed.has(indexedSourceOccurrence(source))) {
    return { reason: { action: "live", reason: "candidate-consumed" } };
  }
  return { source, match: "unique-hash" };
}

function currentSafety(input: ResumeMatchInput): WorkflowResumeSafety | undefined {
  if (input.kind !== "agent" || input.resumeDeclared !== true) return undefined;
  if (input.resolvedIsolation === undefined) return "declared-read-only";
  return input.hasAgentCwd === true ? undefined : "isolated-worktree";
}

function positionalCurrentSafety(input: PositionalResumeMatchInput): WorkflowResumeSafety | undefined {
  return currentSafety({
    kind: input.kind,
    hash: input.hash,
    inputsHash: input.inputsHash,
    cacheOpen: true,
    consumed: new Set(),
    resumeDeclared: input.resumeDeclared,
    resolvedIsolation: input.resolvedIsolation,
    hasAgentCwd: input.hasAgentCwd,
  });
}

export function initialPositionalFirstMiss(
  eligibility: PositionalResumeMatchInput["eligibility"],
): number {
  return eligibility === "all-live" ? 0 : Number.POSITIVE_INFINITY;
}

export function selectPositionalResume(
  input: PositionalResumeMatchInput,
): PositionalResumeMatchDecision {
  const firstMiss = input.eligibility === "all-live" ? 0 : input.firstMiss;
  if (input.index >= firstMiss) {
    return { action: "live", reason: "positional-suffix", nextFirstMiss: firstMiss };
  }
  const hashMatches = input.cached !== undefined && input.cached.hash === input.hash;
  const emptyAgent =
    hashMatches &&
    input.kind === "agent" &&
    input.hasSchema !== true &&
    typeof input.cached?.result === "string" &&
    input.cached.result.trim().length === 0;
  let safePrefixMatches = true;
  if (input.eligibility === "safe-prefix") {
    const source = input.sourceCall;
    safePrefixMatches =
      source !== undefined &&
      source.index === input.index &&
      source.kind === input.kind &&
      source.hash === input.hash &&
      source.outcome === "result" &&
      isHash(source.inputsHash) &&
      source.inputsHash === input.inputsHash &&
      (input.kind === "agent"
        ? isValidSafetyMarker(source) &&
          source.resumeSafety !== undefined &&
          source.resumeSafety === positionalCurrentSafety(input)
        : isHostCheckpointDecision(source));
  }
  if (!hashMatches || emptyAgent || !safePrefixMatches) {
    return { action: "live", reason: "positional-miss", nextFirstMiss: input.index };
  }
  const logicalBudgetDebit = input.sourceCall?.kind === "agent"
    ? effectiveLogicalDebit(input.sourceCall)
    : undefined;
  return {
    action: "replay",
    entry: input.cached as JournalEntry,
    match: "index-hash",
    ...(logicalBudgetDebit === undefined ? {} : { logicalBudgetDebit }),
    nextFirstMiss: firstMiss,
  };
}

export function selectResumeCandidate(
  indexes: ResumeCandidateIndexes,
  input: ResumeMatchInput,
): ResumeMatchDecision {
  if (!input.cacheOpen) return { action: "live", reason: "unsafe-suffix" };
  if (!isPath(input.path)) return { action: "live", reason: "path-missing" };
  if (!isHash(input.inputsHash)) return { action: "live", reason: "inputs-missing" };
  const selected = selectedSource(indexes, input);
  if (selected.reason) return selected.reason;
  const source = selected.source as IndexedResumeSource;
  if (
    input.kind === "agent" &&
    source.type === "candidate" &&
    input.hasSchema !== true &&
    typeof source.candidate.entry.result === "string" &&
    source.candidate.entry.result.trim().length === 0
  ) {
    return { action: "live", reason: "empty-output", remove: source };
  }
  if (
    input.kind === "agent" &&
    (source.type !== "candidate" || source.candidate.call.resumeSafety !== currentSafety(input))
  ) {
    return {
      action: "live",
      reason: "safety-changed",
      remove: source,
      ...(currentSafety(input) === undefined ? { closesSuffix: true as const } : {}),
    };
  }
  return { action: "replay", source, match: selected.match as "path-hash" | "unique-hash" };
}

export type ResumeReportPlan =
  | { strategy: "identity-v1"; sourceRunId: string; requestedPolicy: ResumePolicy }
  | {
      strategy: "positional-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      fallbackReason: WorkflowResumeFallbackReason;
      eligibility: "legacy" | "safe-prefix" | "all-live";
    }
  | {
      strategy: "live";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      disabledReason: Extract<ResumeAdmissionDecision, { strategy: "live" }>["disabledReason"];
    };

export function buildResumeReport(
  plan: ResumeReportPlan,
  decisions: readonly WorkflowResumeCallDecision[],
): WorkflowResumeReport {
  const indexes = new Set<number>();
  for (const decision of decisions) {
    if (!isNonNegativeSafeInteger(decision.index) || indexes.has(decision.index)) {
      throw new TypeError("resume decisions must have unique non-negative safe-integer indexes");
    }
    indexes.add(decision.index);
  }
  const calls = [...decisions].sort((left, right) => left.index - right.index);
  const report = {
    strategy: plan.strategy,
    sourceRunId: plan.sourceRunId,
    requestedPolicy: plan.requestedPolicy,
    replayed: calls.filter((decision) => decision.action === "replayed").length,
    live: calls.filter((decision) => decision.action === "live").length,
    failed: calls.filter((decision) => decision.action === "failed").length,
    calls,
    ...(plan.strategy === "positional-v1"
      ? { fallbackReason: plan.fallbackReason, eligibility: plan.eligibility }
      : plan.strategy === "live"
        ? { disabledReason: plan.disabledReason }
        : {}),
  };
  const cloned = cloneFrozenStrictJson(report);
  if (!cloned.ok) throw new TypeError(`resume report is not strict JSON at ${cloned.path}`);
  return cloned.clone as unknown as WorkflowResumeReport;
}
