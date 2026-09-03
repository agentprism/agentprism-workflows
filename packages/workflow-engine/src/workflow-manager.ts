/**
 * Workflow manager for background execution, pause/resume, and run management.
 *
 * The injected agent backend is an `AgentRunner` (the frozen seam from
 * @automatalabs/shared-types); the manager never constructs a concrete agent. It
 * COMPOSES the host-facing `WorkflowRunResult` (which carries the terminal status
 * trio) on top of the engine's bare `EngineRunResult` — the engine seam stays
 * unchanged. `runSync` (the path the MCP shell drives) resolves to a TERMINAL
 * result even on pause/fail/abort, so the caller can read `run.status` without a
 * try/catch.
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type {
  AgentRunner,
  AgentSessionRecord,
  EngineRunEvent,
  EngineRunEventName,
  EngineRunEventPayloadMap,
  JournalEntry,
  PersistableEngineRunEvent,
  ResumePolicy,
  TokenUsage,
  WorkflowBackendConfig,
  WorkflowCallRecord,
  WorkflowCheckpointTaken,
  WorkflowCheckpointResolution,
  WorkflowContinuationResult,
  WorkflowMeta,
  WorkflowRunFallback,
  WorkflowRunInspectionOptions,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowReplayEligibility,
  WorkflowReplayFirstNonReplay,
  WorkflowReplayOperationalChange,
  WorkflowReplayProvenanceChange,
  WorkflowResumeCallDecision,
  WorkflowResumeReport,
} from "@automatalabs/shared-types";
import type { RunEventLogRecord } from "@automatalabs/shared-types";
import { preview, recomputeWorkflowSnapshot, type WorkflowSnapshot } from "./display.js";
import { errorMessage, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { captureRunEnvironment, type RunEnvironmentIdentity } from "./run-environment.js";
import { isRunEnvironmentIdentity } from "./resume-identity.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedResumeSeed,
  type PersistedResumeFormat,
  type PersistedRunAdmission,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import {
  admitResumeSource,
  buildResumeReport,
  type ResumeAdmissionDecision,
  type ResumeReportPlan,
} from "./resume-matcher.js";
import type {
  ContinuationCandidate,
  PreparedContinuation,
  PreparedResume,
} from "./resume.js";
import { withRunEvents, type RunEventPersistence } from "./run-event-persistence.js";
import { projectRecordedError } from "./recorded-error.js";
import { workflowHomeDir } from "./workflow-paths.js";
import { canonicalStrictJson, cloneFrozenStrictJson, cloneStrictJsonValue, deepFreeze } from "./strict-json.js";
import {
  CALL_INPUTS_FORMAT,
  CALL_PATH_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  type CheckpointCallContext,
  type CheckpointOptions,
  type EngineRunResult,
  type WorkflowAgentAttemptControl,
  type WorkflowAgentConfiguration,
  type WorkflowRunOptions,
  canonicalizeWorkflowAgentConfigurations,
  hashWorkflowAdmissionSelection,
  parseWorkflowScript,
  resolveWorkflowRunLimits,
  runWorkflow,
} from "./workflow.js";
import { createWorkflowLogTail, projectWorkflowRunStatus } from "./run-observability.js";
import {
  LiveAgentObservability,
  type WorkflowAgentActivity,
} from "./agent-live-observability.js";

const ENGINE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  /** The composed host-facing result (with terminal status), set once the run settles. */
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** True when managed.args is a faithful strict-JSON pre-execution snapshot. */
  argsSnapshotOk: boolean;
  argsUnreplayable?: true;
  /** THIS run's working directory (ExecOptions.cwd), when it overrides the manager cwd.
   *  Persisted so resume() re-runs in the same directory (e.g. the same worktree). */
  cwd?: string;
  /** Parsed meta, kept so a terminal (paused/failed) result can still report it. */
  meta?: WorkflowMeta;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /** Result-only observability collected during this execution. */
  fallbacks: WorkflowRunFallback[];
  checkpointsTaken: WorkflowCheckpointTaken[];
  calls: WorkflowCallRecord[];
  effectiveCwd: string;
  runtime: {
    engineVersion: string;
    node: string;
    v8: string;
    pathFormat: number;
    inputsFormat: number;
    checkpointInputsFormat?: number;
  };
  environment?: RunEnvironmentIdentity;
  admission?: PersistedRunAdmission;
  continuation?: WorkflowContinuationResult;
  sameRunContinuation?: true;
  resume?: PersistedResumeFormat;
  resumeActivity?: number;
  resumeActivityInvalid?: true;
  resumeFilesystemTainted?: boolean;
  resumeTerminalFinalized?: boolean;
  executionSettled?: boolean;
  environmentKey?: string;
  callsAllocated?: number;
  limits?: NonNullable<WorkflowRunResult["effectiveLimits"]>;
  abortSignaled?: true;
  mainModel?: string;
  /** Host-pinned fallback for otherwise unmodelled agent calls in this execution. */
  defaultModel?: string;
  agentsDir?: string;
  nestedWorkflows?: true;
  legacyResume?: true;
  /** A fresh run seeded from another execution; terminal saves replace inherited rows. */
  newRunResume?: true;
  /** Immediate resumeFromRunId ancestor, fixed when the new run is admitted. */
  readonly resumeSourceRunId?: string;
  /** Manager-owned remaining correspondence state for a new-run resume. */
  resumeSeed?: PersistedResumeSeed;
  /** Resume-only interrupted root calls eligible for live session continuation. */
  preparedContinuation?: PreparedContinuation;
  /** Manager-owned report, incrementally updated while the engine is executing. */
  resumeReport?: WorkflowResumeReport;
  replayEligibility?: WorkflowReplayEligibility;
  replayEligibilityPlan?: ReplayEligibilityPlan;
  resumeReportPlan?: ResumeReportPlan;
  resumeDecisions?: Map<number, WorkflowResumeCallDecision>;
  executionMode?: PersistedRunState["executionMode"];
  /**
   * False for host-owned transcript storage. The run stays fully tracked in memory,
   * but the engine writes no run-state/log journal files and resume is forbidden.
   */
  journaling: boolean;
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  eventStreamId?: string;
  eventSeq?: number;
  eventLogIncomplete?: true;
  /** Request-owned progress callback used by live activity appends; never persisted. */
  liveProgress?: () => void;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
}

interface EventPublicationState {
  runId: string;
  journaling: boolean;
  lease?: RunLease;
  eventStreamId?: string;
  eventSeq?: number;
  eventLogIncomplete?: true;
}

interface RunEventPublicationActions {
  afterAppend?: (record: RunEventLogRecord) => void;
  beforeLive?: () => void;
  afterLive?: () => void;
}

interface ManagerResumeExecution {
  preparedResume?: PreparedResume;
  resumeJournal?: Map<number, JournalEntry>;
  injectedCheckpointReplies?: ReadonlySet<number>;
}

interface ReplayEligibilityPlan {
  sourceRunId: string;
  strategy: WorkflowReplayEligibility["strategy"];
  fallbackReason?: Extract<WorkflowReplayEligibility, { strategy: "positional-v1" }>["fallbackReason"];
  eligibility?: Extract<WorkflowReplayEligibility, { strategy: "positional-v1" }>["eligibility"];
  disabledReason?: Extract<WorkflowReplayEligibility, { strategy: "live" }>["disabledReason"];
  predictedReplayablePrefix: number;
  initialFirstNonReplay?: WorkflowReplayFirstNonReplay;
  sourceEngineVersion?: string;
  currentEngineVersion: string;
  engineVersionComparison: WorkflowReplayEligibility["engineVersionComparison"];
  sourceInputsFormat?: number;
  currentInputsFormat: number;
  provenanceChanges: WorkflowReplayProvenanceChange[];
  operationalChanges: WorkflowReplayOperationalChange[];
}

interface InitializedRun {
  managed: ManagedRun;
  resumeExecution?: ManagerResumeExecution;
}

/** Durable acknowledgement for one host-cancelled agent call. */
export interface WorkflowAgentCallCancellation {
  runId: string;
  callIndex: number;
  label: string;
  scope: string;
  errorCode: WorkflowErrorCode.AGENT_CANCELLED;
}

export type WorkflowContinuationRefusalReason =
  | "running"
  | "terminal"
  | "owned-elsewhere"
  | "missing"
  | "not-continuable"
  | "admission-missing"
  | "admission-invalid"
  | "admission-uncovered"
  | "checkpoint-required"
  | "checkpoint-mismatch"
  | "auth-required";

export type WorkflowContinuationStart =
  | {
      accepted: false;
      reason: WorkflowContinuationRefusalReason;
      resolvedCheckpoints?: WorkflowCheckpointResolution[];
    }
  | {
      accepted: true;
      runId: string;
      continuation: WorkflowContinuationResult;
      promise: Promise<WorkflowRunResult>;
    };

interface PendingAgentCancellation {
  promise: Promise<WorkflowAgentCallCancellation>;
  resolve: (result: WorkflowAgentCallCancellation) => void;
  reject: (error: WorkflowError) => void;
  settled: boolean;
}

interface RegisteredAgentAttempt extends WorkflowAgentAttemptControl {
  cancellation?: PendingAgentCancellation;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Caller-minted run id. Collision checks happen under the run lease. */
  runId?: string;
  /** Marks this run as an isolation execution from its initial save onward. */
  executionMode?: PersistedRunState["executionMode"];
  /** Non-git environment label reported in replay provenance diagnostics only. */
  environmentKey?: string;
  /**
   * The agent backend for THIS run. Overrides the manager's constructor-injected
   * `agent`. Either this or the constructor `agent` must be set, or the run fails
   * with a clear AGENT_EXECUTION_ERROR (the engine never constructs an agent).
   */
  agent?: AgentRunner;
  /**
   * Working directory for THIS run, overriding the manager's constructor `cwd` —
   * the natural fit for hosts that run each workflow inside its own git worktree.
   * Every subagent ACP session runs here (unless worktree isolation or a per-agent
   * `agent({ cwd })` overrides it further). Persisted with the run so `resume()`
   * re-runs in the SAME directory. Run STATE stays keyed to the manager cwd, so
   * listRuns()/resume() are unaffected by the per-run directory's lifetime.
   */
  cwd?: string;
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Load this persisted run as the source for a new managed execution. */
  resumeFromRunId?: string;
  /** Default "auto". "positional" requests the historical index/prefix matcher. */
  resumePolicy?: ResumePolicy;
  /** Durable-checkpoint answer channel: pending checkpoint call index to the host's decision. */
  checkpointReplies?: Record<number, unknown>;
  /**
   * Optional host admission latch. Initialization and the first persisted save complete before
   * startInBackground returns, but workflow VM evaluation waits for this decision. A denied
   * admission settles through the normal abort/error path without evaluating authored code.
   */
  executionAdmission?: Promise<"admitted" | "denied">;
  /**
   * Whether THIS run writes/reads the engine persistence journal. Default is the
   * manager setting. When false, no run-state/log files are written and resume
   * rejects with "journaling disabled for this run".
   */
  journaling?: boolean;
  /** Resume seed for the root-scope call manifest. */
  resumeCalls?: WorkflowCallRecord[];
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Alias for externalSignal — the engine-owned cancellation the MCP shell threads in. */
  signal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /**
   * Host-pinned model/backend for agent calls with no authored model, agentType model,
   * tier, or phase/meta route. Persisted with the run and included in call identity.
   */
  defaultModel?: string;
  /** Host-selected configuration for each root-execution-wide agent occurrence ordinal. */
  agentConfigurations?: Readonly<Record<number, WorkflowAgentConfiguration>>;
  /** Refuse any live occurrence that was not covered by agentConfigurations. */
  requireAgentConfiguration?: boolean;
  /** Records who made the canonical strict selection persisted at admission. */
  agentConfigurationSource?: PersistedRunAdmission["source"];
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (
    promptText: string,
    options: CheckpointOptions,
    context?: CheckpointCallContext,
  ) => Promise<unknown>;
  /** Force every checkpoint to pause durably for an out-of-band host reply. */
  pauseOnCheckpoint?: boolean;
  /** Called synchronously when workflow() allocates a unique child-run ordinal. */
  onNestedWorkflow?: (ordinal: number, childRunId: string) => void;
  /**
   * APPROVED script-declared custom ACP backends (`meta.backends`) for this run. The
   * composition root owns the approval decision (MCP elicitation, SDK allowScriptBackends,
   * or the env opt-in) — omitting this leaves script-declared backends inert. Threaded to
   * runWorkflow's scriptBackends verbatim.
   */
  scriptBackends?: Record<string, WorkflowBackendConfig>;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * The injected agent backend (the frozen AgentRunner seam). May be overridden
   * per-run via ExecOptions.agent. The engine depends on this injection and never
   * constructs an agent itself.
   */
  agent?: AgentRunner;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /** The session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Override the directory scanned for `agentType` definitions (defaults to AGENTS_DIR). */
  agentsDir?: string;
  /**
   * Absolute workflow persistence root. Precedence is this explicit option >
   * AGENTPRISM_PERSISTENCE_ROOT > `~/.agentprism/workflows`.
   */
  persistenceRoot?: string;
  /**
   * Custom run persistence implementation. When omitted, the manager constructs
   * the default filesystem persistence for `cwd` and `persistenceRoot`.
   */
  persistence?: RunPersistence;
  /** Default journaling policy for runs created by this manager. Default true. */
  journaling?: boolean;
  /** Opaque host/process generation identity attached to newly acquired filesystem leases. */
  leaseOwnerId?: string;
  /** Default non-git environment label for replay provenance diagnostics. */
  environmentKey?: string;
}

type ArgsSnapshot = { ok: true; clone: unknown } | { ok: false };

function snapshotArgs(value: unknown): ArgsSnapshot {
  if (value === undefined) return { ok: true, clone: undefined };
  const captured = cloneStrictJsonValue(value);
  return captured.ok ? { ok: true, clone: captured.clone } : { ok: false };
}

function runtimeIdentity(): ManagedRun["runtime"] {
  return {
    engineVersion: ENGINE_VERSION,
    node: process.version,
    v8: process.versions.v8,
    pathFormat: CALL_PATH_FORMAT,
    inputsFormat: CALL_INPUTS_FORMAT,
    checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
  };
}

function positionalSourceRows<T extends { index: number; scope?: string }>(
  rows: T[],
  sourceRunId: string,
  persistedRunIds: ReadonlySet<string>,
): T[] {
  const latest = new Map<number, T>();
  for (const row of rows) {
    if (
      row.scope === undefined ||
      row.scope === sourceRunId ||
      persistedRunIds.has(row.scope)
    ) {
      latest.set(row.index, row);
    }
  }
  return [...latest.values()].sort((left, right) => left.index - right.index);
}

function contiguousIndexes(indexes: Iterable<number>): number {
  const available = new Set(indexes);
  let prefix = 0;
  while (available.has(prefix)) prefix++;
  return prefix;
}

function predictedPositionalReplayablePrefix(
  eligibility: Extract<ResumeAdmissionDecision, { strategy: "positional-v1" }>["eligibility"],
  journal: ReadonlyMap<number, JournalEntry>,
  calls: readonly WorkflowCallRecord[],
): number {
  if (eligibility === "all-live") return 0;
  if (eligibility === "legacy") return contiguousIndexes(journal.keys());
  const callsByIndex = new Map(calls.map((call) => [call.index, call] as const));
  let prefix = 0;
  while (true) {
    const entry = journal.get(prefix);
    const call = callsByIndex.get(prefix);
    if (
      entry === undefined ||
      call === undefined ||
      call.outcome !== "result" ||
      call.hash !== entry.hash
    ) {
      return prefix;
    }
    prefix++;
  }
}

function displayOperationalValue(value: number | null): string {
  return value === null ? "none" : String(value);
}

function displayProvenanceValue(value: string | null): string {
  return value === null ? "unavailable" : value;
}

function latestRootRows<T extends { index: number; scope?: string }>(rows: T[], runId: string): T[] {
  const latest = new Map<number, T>();
  for (const row of rows) {
    if (row.scope === undefined || row.scope === runId) latest.set(row.index, row);
  }
  return [...latest.values()].sort((a, b) => a.index - b.index);
}

function stripLegacyCallBudgetFields(call: WorkflowCallRecord): WorkflowCallRecord {
  const { budgetDebit: _budgetDebit, ...currentCall } = call as WorkflowCallRecord & {
    budgetDebit?: unknown;
  };
  if (currentCall.replay === undefined) return currentCall;
  const { logicalBudgetDebit: _logicalBudgetDebit, ...currentReplay } = currentCall.replay as
    NonNullable<WorkflowCallRecord["replay"]> & { logicalBudgetDebit?: unknown };
  return { ...currentCall, replay: currentReplay };
}

function latestRows<T extends { index: number }>(rows: T[]): T[] {
  const latest = new Map<number, T>();
  for (const row of rows) latest.set(row.index, row);
  return [...latest.values()].sort((a, b) => a.index - b.index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isContinuationSession(
  value: unknown,
): value is AgentSessionRecord & { cwd?: string } {
  if (!isRecord(value) || !isRecord(value.reopen)) return false;
  return (
    typeof value.sessionId === "string" &&
    typeof value.backendId === "string" &&
    (value.cwd === undefined || typeof value.cwd === "string") &&
    isOptionalString(value, "poolKey") &&
    typeof value.reopen.load === "boolean" &&
    typeof value.reopen.resume === "boolean" &&
    typeof value.reopen.list === "boolean" &&
    (value.reopen.fork === undefined || typeof value.reopen.fork === "boolean") &&
    isNonNegativeSafeInteger(value.callIndex) &&
    typeof value.label === "string" &&
    isOptionalString(value, "phase") &&
    typeof value.keptOpen === "boolean"
  );
}

function runReason(status: RunStatus, error: WorkflowError | undefined): string | undefined {
  if (status === "completed" || status === "pending" || status === "running") return undefined;
  if (status !== "paused") return error?.message;
  if (error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT) return "usage_limit";
  if (error?.code === WorkflowErrorCode.AUTH_REQUIRED) return "auth_required";
  if (error?.code === WorkflowErrorCode.CHECKPOINT_REQUIRED) return "checkpoint_required";
  return error?.message;
}

function interruptedRunReason(ownerPid: number | undefined): string {
  return ownerPid === undefined
    ? "Interrupted: the owning process exited before completion (PID unavailable); recovered to a resumable pause."
    : `Interrupted: owning process PID ${ownerPid} exited before completion; recovered to a resumable pause.`;
}

function generateEventStreamId(): string {
  return randomBytes(16).toString("hex");
}

function isPersistableRunEvent(event: EngineRunEvent): event is PersistableEngineRunEvent {
  return event.type !== "agentHistory";
}

export interface PersistedRunStopResult {
  outcome: "stopped" | "already-terminal" | "owned-elsewhere" | "missing";
  state?: PersistedRunState;
}

export interface WorkflowManager {
  addListener<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  on<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  once<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  removeListener<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  off<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  emit<Name extends EngineRunEventName>(
    eventName: Name,
    payload: EngineRunEventPayloadMap[Name],
  ): boolean;

  addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  once(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  emit(eventName: string | symbol, ...args: any[]): boolean;
}

/**
 * Stateful workflow run manager. Events are OBSERVABILITY ONLY: listeners are
 * best-effort observers, isolated from sibling listeners and from run execution. A
 * throwing host observer never fails, pauses, aborts, or masks cleanup for the run.
 */
export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private agentAttempts = new Map<string, Set<RegisteredAgentAttempt>>();
  private persistence: RunEventPersistence;
  /** The manager's project directory — keys the persistence store and is the default run cwd. */
  readonly cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: AgentRunner;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The current session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentRetries: number;
  private agentsDir?: string;
  private persistenceRoot: string;
  private journaling: boolean;
  private environmentKey?: string;
  private readonly liveAgentObservability: LiveAgentObservability<ManagedRun>;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.sessionId = options.sessionId;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.agentsDir = options.agentsDir;
    this.persistenceRoot = workflowHomeDir({ persistenceRoot: options.persistenceRoot });
    this.journaling = options.journaling ?? true;
    this.environmentKey = options.environmentKey;
    this.persistence = options.persistence
      ? withRunEvents(options.persistence)
      : createRunPersistence(this.cwd, undefined, {
          persistenceRoot: this.persistenceRoot,
          leaseOwnerId: options.leaseOwnerId,
        });
    this.liveAgentObservability = new LiveAgentObservability<ManagedRun>({
      eligible: (run) => Boolean(run.journaling && run.lease && !run.eventLogIncomplete),
      publish: (run, event, afterAppend) => {
        this.publishRunEvent(run, event, () => this.persistRun(run), { afterAppend });
      },
      progress: (run, record) => {
        if (record.event.type !== "agentProgress") return;
        const { type: _type, ...progress } = record.event;
        run.snapshot.latestActivity = {
          seq: record.seq,
          progress,
        };
        run.liveProgress?.();
      },
    });
    // Stale-run recovery mutates the PERSISTED run store, so it is gated on this manager's
    // journaling default: a `journaling: false` manager (host keeps its own transcript/audit
    // store) must never rewrite run state that belongs to journaling processes.
    if (this.journaling) this.recoverStaleRuns();
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const listeners = this.rawListeners(eventName);
    for (const listener of listeners) {
      try {
        // rawListeners() returns EventEmitter's once-wrappers. Calling the wrapper
        // preserves once() self-removal while isolating each observer's throw.
        Reflect.apply(listener, this, args);
      } catch {
        // Manager events are live observability; bad listeners cannot perturb runs.
      }
    }
    return listeners.length > 0;
  }

  /** Resolve one host-served workflow by name without executing it. Validation uses the
   * same resolver as live execution so a mocked preflight cannot disagree with admission. */
  resolveSavedWorkflow(name: string): string | undefined {
    return this.loadSavedWorkflow?.(name);
  }

  /** Bind the manager to the current session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  private reconcileListedRun(candidate: PersistedRunState): PersistedRunState | null {
    if (
      !this.journaling ||
      this.runs.has(candidate.runId) ||
      (candidate.status !== "pending" && candidate.status !== "running")
    ) {
      return candidate;
    }

    let lease: RunLease | null;
    try {
      lease = this.persistence.acquireRunLease(candidate.runId);
    } catch {
      return candidate;
    }
    if (!lease) return candidate;

    try {
      const current = this.persistence.load(candidate.runId);
      if (!current) return null;
      if (
        this.runs.has(candidate.runId) ||
        (current.status !== "pending" && current.status !== "running")
      ) {
        return current;
      }
      if (this.persistence.validateRunLease?.(lease) === false) return current;
      const reconciled: PersistedRunState = {
        ...current,
        status: "paused",
        pauseReason: "interrupted",
        reason: interruptedRunReason(lease.recoveredOwnerPid),
      };
      this.persistence.save(reconciled);
      return reconciled;
    } catch {
      return candidate;
    } finally {
      this.persistence.releaseRunLease(lease);
    }
  }

  private reconcileListedRuns(rows: PersistedRunState[]): PersistedRunState[] {
    if (!this.journaling) return rows;
    const reconciled: PersistedRunState[] = [];
    for (const row of rows) {
      const current = this.reconcileListedRun(row);
      if (current) reconciled.push(current);
    }
    return reconciled.sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  }

  /**
   * Reconcile one persisted run whose owning process may have exited. The lease
   * acquisition preserves live/EPERM owners, removes stale or corrupt locks, and
   * the under-lease reload lets a concurrent completion win over recovery.
   */
  reconcileExternallyDeadRun(runId: string): PersistedRunState | undefined {
    const persisted = this.persistence.load(runId);
    if (!persisted) return undefined;
    return this.reconcileListedRun(persisted) ?? undefined;
  }

  /** Reconcile externally interrupted persisted runs when the manager starts. */
  private recoverStaleRuns(): void {
    try {
      this.reconcileListedRuns(this.persistence.list());
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Resolve the agent backend for a run: per-run override wins, else the
   * constructor-injected one. Throws when neither is set (the engine never
   * constructs an agent). */
  private resolveAgent(exec: ExecOptions): AgentRunner {
    const agent = exec.agent ?? this.agent;
    if (!agent) {
      throw new WorkflowError(
        "WorkflowManager requires an AgentRunner — inject one via `new WorkflowManager({ agent })` or pass `runSync(script, args, { agent })`.",
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        { recoverable: false },
      );
    }
    return agent;
  }

  private acquireNewRunIdentity(requestedRunId?: string): { runId: string; lease: RunLease } {
    for (;;) {
      const runId = requestedRunId ?? generateRunId();
      const lease = this.persistence.acquireRunLease(runId);
      if (!lease) {
        if (requestedRunId) {
          throw new WorkflowError(`run id already exists: ${runId}`, WorkflowErrorCode.PERSISTENCE_ERROR, {
            recoverable: false,
          });
        }
        continue;
      }
      let persistedExists: boolean;
      try {
        persistedExists = this.persistence.load(runId) !== null;
      } catch (error) {
        this.persistence.releaseRunLease(lease);
        throw error;
      }
      if (!this.runs.has(runId) && !persistedExists) return { runId, lease };
      this.persistence.releaseRunLease(lease);
      if (requestedRunId) {
        throw new WorkflowError(`run id already exists: ${runId}`, WorkflowErrorCode.PERSISTENCE_ERROR, {
          recoverable: false,
        });
      }
    }
  }

  private scriptValidationError(message: string): WorkflowError {
    return new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  }

  private persistenceError(message: string, error?: unknown): WorkflowError {
    return new WorkflowError(message, WorkflowErrorCode.PERSISTENCE_ERROR, {
      recoverable: false,
      ...(error === undefined ? {} : { details: error }),
    });
  }

  private validateNewRunOptions(exec: ExecOptions, journaling: boolean): void {
    const hasSource = exec.resumeFromRunId !== undefined;
    if (hasSource && (typeof exec.resumeFromRunId !== "string" || exec.resumeFromRunId.length === 0)) {
      throw this.scriptValidationError("resumeFromRunId must be a non-empty string");
    }
    if (exec.resumePolicy !== undefined && exec.resumePolicy !== "auto" && exec.resumePolicy !== "positional") {
      throw this.scriptValidationError('resumePolicy must be "auto" or "positional"');
    }
    if (exec.resumeJournal !== undefined && (hasSource || exec.resumePolicy !== undefined)) {
      throw this.scriptValidationError(
        "resumeJournal is mutually exclusive with resumeFromRunId and resumePolicy",
      );
    }
    if (exec.resumePolicy !== undefined && !hasSource) {
      throw this.scriptValidationError("resumePolicy requires resumeFromRunId");
    }
    if (exec.checkpointReplies !== undefined && !hasSource) {
      throw this.scriptValidationError("checkpointReplies requires resumeFromRunId on new-run APIs");
    }
    if (hasSource && !journaling) {
      throw this.scriptValidationError("resumeFromRunId requires journaling");
    }
    if (hasSource && exec.runId === exec.resumeFromRunId) {
      throw this.scriptValidationError("runId must differ from resumeFromRunId");
    }
  }

  private acquireResumeSource(runId: string): { lease: RunLease; source: PersistedRunState } {
    let lease: RunLease | null;
    try {
      this.reconcileExternallyDeadRun(runId);
      lease = this.persistence.acquireRunLease(runId);
    } catch (error) {
      throw this.persistenceError(`failed to acquire resume source lease for ${runId}: ${errorMessage(error)}`, error);
    }
    if (!lease) {
      throw this.persistenceError(`resume source is currently leased: ${runId}`);
    }
    try {
      const source = this.persistence.load(runId);
      if (!source) throw this.persistenceError(`resume source does not exist: ${runId}`);
      return { lease, source };
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      if (error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR) throw error;
      throw this.persistenceError(`failed to load resume source ${runId}: ${errorMessage(error)}`, error);
    }
  }

  private reportPlan(admission: ResumeAdmissionDecision): ResumeReportPlan {
    return admission.strategy === "identity-v1"
      ? {
          strategy: admission.strategy,
          sourceRunId: admission.sourceRunId,
          requestedPolicy: admission.requestedPolicy,
          ...(admission.checkpointReplyIndex === undefined
            ? {}
            : { checkpointReplyIndex: admission.checkpointReplyIndex }),
        }
      : admission.strategy === "positional-v1"
        ? {
            strategy: admission.strategy,
            sourceRunId: admission.sourceRunId,
            requestedPolicy: admission.requestedPolicy,
            ...(admission.checkpointReplyIndex === undefined
              ? {}
              : { checkpointReplyIndex: admission.checkpointReplyIndex }),
            fallbackReason: admission.fallbackReason,
            eligibility: admission.eligibility,
          }
        : {
            strategy: admission.strategy,
            sourceRunId: admission.sourceRunId,
            requestedPolicy: admission.requestedPolicy,
            ...(admission.checkpointReplyIndex === undefined
              ? {}
              : { checkpointReplyIndex: admission.checkpointReplyIndex }),
            disabledReason: admission.disabledReason,
          };
  }

  private operationalChanges(
    source: PersistedRunState,
    managed: ManagedRun,
  ): WorkflowReplayOperationalChange[] {
    if (!source.limits || !managed.limits) return [];
    const options = ["agentRetries", "concurrency"] as const;
    const changes: WorkflowReplayOperationalChange[] = [];
    for (const option of options) {
      const sourceValue = source.limits[option];
      const currentValue = managed.limits[option];
      if (sourceValue === currentValue) continue;
      changes.push({
        option,
        source: sourceValue,
        current: currentValue,
        detail:
          `source recorded ${option}=${displayOperationalValue(sourceValue)}; ` +
          `this run: ${displayOperationalValue(currentValue)}`,
      });
    }
    return changes;
  }

  private provenanceChanges(
    admission: ResumeAdmissionDecision,
    source: PersistedRunState,
    managed: ManagedRun,
  ): WorkflowReplayProvenanceChange[] {
    const changes: WorkflowReplayProvenanceChange[] = [];
    const append = (
      field: WorkflowReplayProvenanceChange["field"],
      sourceValue: string | null,
      currentValue: string | null,
      label: string,
    ): void => {
      if (sourceValue === currentValue) return;
      changes.push({
        field,
        source: sourceValue,
        current: currentValue,
        detail:
          `source recorded ${label}=${displayProvenanceValue(sourceValue)}; ` +
          `this run: ${displayProvenanceValue(currentValue)}`,
      });
    };

    append("runtime.node", source.runtime?.node ?? null, managed.runtime.node, "runtime.node");
    append("runtime.v8", source.runtime?.v8 ?? null, managed.runtime.v8, "runtime.v8");

    const recordedTerminal = source.resume?.terminalEnvironment;
    const recordedEnvironment = isRunEnvironmentIdentity(recordedTerminal)
      ? recordedTerminal
      : source.environment;
    const sourceEnvironment = isRunEnvironmentIdentity(recordedEnvironment)
      ? recordedEnvironment
      : undefined;
    const currentEnvironment = isRunEnvironmentIdentity(managed.environment)
      ? managed.environment
      : undefined;
    const sourceKind = sourceEnvironment?.git ? "git" : sourceEnvironment?.key !== undefined ? "key" : null;
    const currentKind = currentEnvironment?.git ? "git" : currentEnvironment?.key !== undefined ? "key" : null;
    if (sourceKind !== currentKind) {
      append("environment.identity", sourceKind, currentKind, "environment identity");
    } else if (sourceEnvironment?.git && currentEnvironment?.git) {
      append("environment.git.head", sourceEnvironment.git.head, currentEnvironment.git.head, "git HEAD");
      append(
        "environment.git.dirtyDigest",
        sourceEnvironment.git.dirtyDigest,
        currentEnvironment.git.dirtyDigest,
        "git dirty digest",
      );
    } else if (sourceEnvironment?.key !== undefined && currentEnvironment?.key !== undefined) {
      append("environment.key", sourceEnvironment.key, currentEnvironment.key, "environment key");
    }
    return changes;
  }

  private admissionDetail(
    admission: ResumeAdmissionDecision,
    source: PersistedRunState,
    managed: ManagedRun,
  ): string | undefined {
    if (admission.strategy !== "live") return undefined;
    if (admission.disabledReason === "runtime-mismatch") {
      const sourceRuntime = source.runtime;
      const comparisons = [
        ["pathFormat", sourceRuntime?.pathFormat, managed.runtime.pathFormat],
        ["inputsFormat", sourceRuntime?.inputsFormat, managed.runtime.inputsFormat],
        [
          "checkpointInputsFormat",
          sourceRuntime?.checkpointInputsFormat,
          managed.runtime.checkpointInputsFormat,
        ],
      ] as const;
      const changed = comparisons.find(([, sourceValue, currentValue]) => sourceValue !== currentValue);
      if (changed) return `source ${changed[0]}=${String(changed[1])}; this run: ${String(changed[2])}`;
    }
    if (admission.disabledReason === "cwd-mismatch") {
      return "source effectiveCwd differs from this run";
    }
    if (admission.disabledReason === "source-not-terminal") {
      return "source status is not terminal";
    }
    if (admission.disabledReason === "unsupported-format") {
      return "source resume format is unsupported; this run supports identity-v1";
    }
    return undefined;
  }

  private replayEligibilityPlan(
    admission: ResumeAdmissionDecision,
    source: PersistedRunState,
    managed: ManagedRun,
    predictedReplayablePrefix: number,
  ): ReplayEligibilityPlan {
    const sourceEngineVersion = typeof source.runtime?.engineVersion === "string"
      ? source.runtime.engineVersion
      : undefined;
    const sourceInputsFormat = Number.isSafeInteger(source.runtime?.inputsFormat)
      ? source.runtime?.inputsFormat
      : undefined;
    const operationalChanges = this.operationalChanges(source, managed);
    const provenanceChanges = this.provenanceChanges(admission, source, managed);
    let initialFirstNonReplay: WorkflowReplayFirstNonReplay | undefined;
    if (admission.strategy === "live") {
      const detail = this.admissionDetail(admission, source, managed);
      initialFirstNonReplay = {
        index: 0,
        action: "live",
        reason: admission.disabledReason,
        ...(detail === undefined ? {} : { detail }),
      };
    } else if (admission.strategy === "positional-v1" && admission.eligibility === "all-live") {
      initialFirstNonReplay = {
        index: 0,
        action: "live",
        reason: admission.fallbackReason,
        detail: `resume fallback ${admission.fallbackReason} admits no replayable prefix`,
      };
    } else if (
      predictedReplayablePrefix === 0 ||
      (
        Number.isSafeInteger(source.callsAllocated) &&
        predictedReplayablePrefix < (source.callsAllocated as number)
      )
    ) {
      initialFirstNonReplay = {
        index: predictedReplayablePrefix,
        action: "live",
        reason: "not-recorded",
        detail: `source has no contiguous replayable result at call ${predictedReplayablePrefix}`,
      };
    }
    return {
      sourceRunId: admission.sourceRunId,
      strategy: admission.strategy,
      ...(admission.strategy === "positional-v1"
        ? { fallbackReason: admission.fallbackReason, eligibility: admission.eligibility }
        : admission.strategy === "live"
          ? { disabledReason: admission.disabledReason }
          : {}),
      predictedReplayablePrefix,
      ...(initialFirstNonReplay === undefined ? {} : { initialFirstNonReplay }),
      ...(sourceEngineVersion === undefined ? {} : { sourceEngineVersion }),
      currentEngineVersion: managed.runtime.engineVersion,
      engineVersionComparison: sourceEngineVersion === undefined
        ? "source-unknown"
        : sourceEngineVersion === managed.runtime.engineVersion
          ? "same"
          : "different",
      ...(sourceInputsFormat === undefined ? {} : { sourceInputsFormat }),
      currentInputsFormat: managed.runtime.inputsFormat,
      provenanceChanges,
      operationalChanges,
    };
  }

  private buildReplayEligibility(
    plan: ReplayEligibilityPlan,
    report: WorkflowResumeReport,
  ): WorkflowReplayEligibility {
    const decisions = [...report.calls].sort((left, right) => left.index - right.index);
    const byIndex = new Map(decisions.map((decision) => [decision.index, decision] as const));
    let replayedPrefix = 0;
    while (byIndex.get(replayedPrefix)?.action === "replayed") replayedPrefix++;
    const firstDecision = decisions.find((decision) => decision.action !== "replayed");
    const operationalDetail = plan.operationalChanges.map((change) => change.detail).join("; ");
    const firstNonReplay: WorkflowReplayFirstNonReplay | undefined = firstDecision
      ? {
          index: firstDecision.index,
          action: firstDecision.action,
          reason: firstDecision.reason,
          ...(
            operationalDetail.length > 0 &&
            firstDecision.action === "live" &&
            (firstDecision.reason === "inputs-changed" || firstDecision.reason === "positional-miss")
              ? { detail: operationalDetail }
              : {}
          ),
        }
      : plan.initialFirstNonReplay;
    const summary = {
      sourceRunId: plan.sourceRunId,
      strategy: plan.strategy,
      ...(plan.strategy === "positional-v1"
        ? { fallbackReason: plan.fallbackReason, eligibility: plan.eligibility }
        : plan.strategy === "live"
          ? { disabledReason: plan.disabledReason }
          : {}),
      predictedReplayablePrefix: plan.predictedReplayablePrefix,
      replayedPrefix,
      replayed: report.replayed,
      live: report.live,
      failed: report.failed,
      ...(firstNonReplay === undefined ? {} : { firstNonReplay }),
      ...(plan.sourceEngineVersion === undefined ? {} : { sourceEngineVersion: plan.sourceEngineVersion }),
      currentEngineVersion: plan.currentEngineVersion,
      engineVersionComparison: plan.engineVersionComparison,
      ...(plan.sourceInputsFormat === undefined ? {} : { sourceInputsFormat: plan.sourceInputsFormat }),
      currentInputsFormat: plan.currentInputsFormat,
      provenanceChanges: plan.provenanceChanges,
      operationalChanges: plan.operationalChanges,
    };
    const captured = cloneFrozenStrictJson(summary);
    if (!captured.ok) throw new TypeError(`replay eligibility is not strict JSON at ${captured.path}`);
    return captured.clone as unknown as WorkflowReplayEligibility;
  }

  private initializeResumeReporting(
    managed: ManagedRun,
    source: PersistedRunState,
    admission: ResumeAdmissionDecision,
    predictedReplayablePrefix: number,
  ): void {
    managed.resumeReportPlan = this.reportPlan(admission);
    managed.resumeDecisions = new Map();
    managed.resumeReport = buildResumeReport(managed.resumeReportPlan, []);
    managed.replayEligibilityPlan = this.replayEligibilityPlan(
      admission,
      source,
      managed,
      predictedReplayablePrefix,
    );
    managed.replayEligibility = this.buildReplayEligibility(
      managed.replayEligibilityPlan,
      managed.resumeReport,
    );
  }

  private commitResumeSeed(managed: ManagedRun, remaining: PersistedResumeSeed): void {
    managed.resumeSeed = remaining;
    try {
      this.persistRunOrThrow(managed);
    } catch (error) {
      managed.resumeSeed = undefined;
      throw error;
    }
  }

  private cloneResumeSourceValue<T>(value: T, runId: string): T {
    try {
      return structuredClone(value);
    } catch (error) {
      throw this.persistenceError(`failed to clone resume source ${runId}: ${errorMessage(error)}`, error);
    }
  }

  /** Build a defensive, snapshot-only continuation projection. Bad persistence can
   *  only remove candidates; it can never make resume throw. */
  private buildPreparedContinuation(
    persisted: PersistedRunState,
  ): PreparedContinuation | undefined {
    if (
      !isRecord(persisted) ||
      persisted.status !== "paused" ||
      (persisted.pauseReason !== "usage_limit" && persisted.pauseReason !== "auth_required") ||
      typeof persisted.runId !== "string"
    ) {
      return undefined;
    }

    const agents = Array.isArray(persisted.agents) ? persisted.agents : [];
    const joinedAgents = new Map<number, AgentSessionRecord & { cwd?: string }>();
    for (const value of agents) {
      if (!isRecord(value)) continue;
      if (value.scope !== undefined && value.scope !== persisted.runId) continue;
      if (value.status !== "error") continue;
      if (!Object.prototype.hasOwnProperty.call(value, "callIndex")) continue;
      if (!isNonNegativeSafeInteger(value.callIndex)) continue;
      if (!isContinuationSession(value.session)) continue;
      if (value.session.callIndex !== value.callIndex) continue;
      if (
        value.errorCode !== WorkflowErrorCode.PROVIDER_USAGE_LIMIT &&
        value.errorCode !== WorkflowErrorCode.AUTH_REQUIRED
      ) {
        continue;
      }
      joinedAgents.set(value.callIndex, value.session);
    }

    const calls = Array.isArray(persisted.calls) ? persisted.calls : [];
    const inputsFormat = isRecord(persisted.runtime) &&
        isNonNegativeSafeInteger(persisted.runtime.inputsFormat)
      ? persisted.runtime.inputsFormat
      : undefined;
    const rootCalls = new Map<number, Record<string, unknown>>();
    for (const value of calls) {
      if (!isRecord(value) || !isNonNegativeSafeInteger(value.index)) continue;
      if (value.scope !== undefined && value.scope !== persisted.runId) continue;
      rootCalls.set(value.index, value);
    }

    const candidatesByIndex = new Map<number, ContinuationCandidate>();
    for (const index of [...rootCalls.keys()].sort((left, right) => left - right)) {
      const record = rootCalls.get(index) as Record<string, unknown>;
      const joined = joinedAgents.get(index);
      if (!joined || record.kind !== "agent" || record.outcome !== "error") continue;
      if (typeof record.hash !== "string") continue;
      if (record.inputsHash !== undefined && typeof record.inputsHash !== "string") continue;
      if (typeof record.backendId !== "string" || joined.backendId !== record.backendId) continue;
      if (record.resolvedCwd !== undefined && typeof record.resolvedCwd !== "string") continue;
      if (
        joined.cwd !== undefined &&
        record.resolvedCwd !== undefined &&
        joined.cwd !== record.resolvedCwd
      ) {
        continue;
      }
      if (joined.reopen.resume !== true && joined.reopen.load !== true) continue;
      const recordedCwd = record.resolvedCwd ?? joined.cwd;
      if (typeof recordedCwd !== "string") continue;
      candidatesByIndex.set(index, {
        callIndex: index,
        hash: record.hash,
        ...(typeof record.inputsHash === "string" ? { inputsHash: record.inputsHash } : {}),
        ...(inputsFormat === undefined ? {} : { inputsFormat }),
        sessionRef: joined,
        recordedCwd,
      });
    }

    return candidatesByIndex.size === 0 ? undefined : { candidatesByIndex };
  }

  private prepareManagedResume(
    managed: ManagedRun,
    source: PersistedRunState,
    exec: ExecOptions,
  ): ManagerResumeExecution {
    const requestedPolicy = exec.resumePolicy ?? "auto";
    const admission = admitResumeSource({
      source,
      requestedPolicy,
      current: {
        effectiveCwd: managed.effectiveCwd,
        runtime: {
          pathFormat: managed.runtime.pathFormat,
          inputsFormat: managed.runtime.inputsFormat,
          checkpointInputsFormat: managed.runtime.checkpointInputsFormat as number,
        },
      },
      checkpointReplies: exec.checkpointReplies as Record<string, unknown> | undefined,
    });
    managed.newRunResume = true;
    if (source.resume === undefined || source.legacyResume === true) managed.legacyResume = true;
    managed.preparedContinuation = this.buildPreparedContinuation(source);

    if (admission.strategy === "identity-v1") {
      this.initializeResumeReporting(
        managed,
        source,
        admission,
        contiguousIndexes([
          ...admission.seed.candidates.map((candidate) => candidate.recordedIndex),
          ...(admission.seed.checkpointInjections ?? []).map((injection) => injection.recordedIndex),
        ]),
      );
      managed.resumeSeed = admission.seed;
      return {
        preparedResume: {
          strategy: admission.strategy,
          sourceRunId: admission.sourceRunId,
          requestedPolicy: admission.requestedPolicy,
          ...(admission.checkpointReplyIndex === undefined
            ? {}
            : { checkpointReplyIndex: admission.checkpointReplyIndex }),
          seed: admission.seed,
          commitSeed: (remaining) => this.commitResumeSeed(managed, remaining),
        },
      };
    }

    if (admission.strategy === "live") {
      this.initializeResumeReporting(managed, source, admission, 0);
      return {
        preparedResume: {
          strategy: admission.strategy,
          sourceRunId: admission.sourceRunId,
          requestedPolicy: admission.requestedPolicy,
          ...(admission.checkpointReplyIndex === undefined
            ? {}
            : { checkpointReplyIndex: admission.checkpointReplyIndex }),
          disabledReason: admission.disabledReason,
        },
      };
    }

    const sourceJournalRows = this.cloneResumeSourceValue(source.journal ?? [], source.runId);
    const sourceCallRows = this.cloneResumeSourceValue(source.calls ?? [], source.runId);
    const persistedRunIds = new Set(this.persistence.list().map((row) => row.runId));
    const sourceJournal = new Map(
      positionalSourceRows(sourceJournalRows, source.runId, persistedRunIds)
        .map((entry) => [entry.index, entry] as const),
    );
    const injectedCheckpointReplies = new Set<number>();
    if (admission.legacyCheckpointReply) {
      const syntheticEntry: JournalEntry = deepFreeze({
        index: admission.legacyCheckpointReply.recordedIndex,
        hash: source.checkpointContext?.hash ?? "",
        result: admission.legacyCheckpointReply.decision,
        kind: "checkpoint",
        scope: managed.runId,
        call: { kind: "checkpoint", label: "checkpoint", phase: source.currentPhase },
      });
      sourceJournal.set(syntheticEntry.index, syntheticEntry);
      injectedCheckpointReplies.add(syntheticEntry.index);
    }
    managed.journal = latestRows([...sourceJournal.values()]);
    managed.calls = positionalSourceRows(sourceCallRows, source.runId, persistedRunIds)
      .map(stripLegacyCallBudgetFields);
    this.initializeResumeReporting(
      managed,
      source,
      admission,
      predictedPositionalReplayablePrefix(admission.eligibility, sourceJournal, managed.calls),
    );
    if (admission.checkpointSeed) managed.resumeSeed = admission.checkpointSeed;
    // Marked format-1 rows can republish matching diagnostic provenance under format 2;
    // markerless legacy rows have no trustworthy source-call facts to promote.
    const retainSourceCallFacts =
      admission.eligibility !== "legacy" ||
      admission.fallbackReason === "inputs-format-legacy";
    const sourceCalls = retainSourceCallFacts
      ? new Map(managed.calls.map((call) => [call.index, call] as const))
      : new Map<number, WorkflowCallRecord>();
    return {
      preparedResume: {
        strategy: admission.strategy,
        sourceRunId: admission.sourceRunId,
        requestedPolicy: admission.requestedPolicy,
        ...(admission.checkpointReplyIndex === undefined
          ? {}
          : { checkpointReplyIndex: admission.checkpointReplyIndex }),
        fallbackReason: admission.fallbackReason,
        eligibility: admission.eligibility,
        sourceCalls,
        ...(admission.checkpointSeed
          ? {
              checkpoint: {
                seed: admission.checkpointSeed,
                commitSeed: (remaining: PersistedResumeSeed) => this.commitResumeSeed(managed, remaining),
              },
            }
          : {}),
      },
      resumeJournal: sourceJournal,
      ...(injectedCheckpointReplies.size === 0 ? {} : { injectedCheckpointReplies }),
    };
  }

  private initializeRun(
    script: string,
    args: unknown | undefined,
    exec: ExecOptions,
    background: boolean,
  ): InitializedRun {
    const journaling = this.resolveJournaling(exec);
    this.validateNewRunOptions(exec, journaling);
    const source = exec.resumeFromRunId === undefined
      ? undefined
      : this.acquireResumeSource(exec.resumeFromRunId);
    let identity: { runId: string; lease: RunLease } | undefined;
    try {
      identity = this.acquireNewRunIdentity(exec.runId);
      const managed = this.createManaged(script, args, journaling, exec, background, identity);
      const resumeExecution = source
        ? this.prepareManagedResume(managed, source.source, exec)
        : undefined;
      if (!source && managed.journaling && exec.resumeJournal) {
        managed.journal = latestRows([...exec.resumeJournal.values()]);
      }
      if (!source && managed.journaling && exec.resumeCalls) {
        managed.calls = latestRows(exec.resumeCalls);
      }
      this.runs.set(managed.runId, managed);
      if (managed.journaling && (source || managed.admission || exec.resumeJournal)) {
        this.persistRunOrThrow(managed);
      } else {
        this.persistRun(managed);
      }
      return { managed, resumeExecution };
    } catch (error) {
      if (identity) this.persistence.releaseRunLease(identity.lease);
      if (identity) this.runs.delete(identity.runId);
      throw error;
    } finally {
      if (source) this.persistence.releaseRunLease(source.lease);
    }
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const { managed, resumeExecution } = this.initializeRun(script, args, exec, true);

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, exec, resumeExecution);
    promise.catch(() => {});

    return { runId: managed.runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the run navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   *
   * Unlike the background path, runSync resolves to a TERMINAL WorkflowRunResult
   * (status completed|paused|failed|aborted) even when the run does not complete,
   * so the MCP shell can project `run.status` without catching.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const { managed, resumeExecution } = this.initializeRun(script, args, exec, false);
    try {
      return await this.executeRun(managed, script, exec, resumeExecution);
    } catch (error) {
      const wfError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(errorMessage(error), WorkflowErrorCode.UNKNOWN, {
              recoverable: false,
            });
      // executeRun's own catch already settled status + persisted + released the
      // lease for the failure modes it handles. If the throw came from before that
      // (e.g. a missing AgentRunner), settle a terminal status here too.
      if (managed.status === "running") {
        managed.status = managed.controller.signal.aborted ? "aborted" : "failed";
        managed.error = wfError;
        this.persistRun(managed);
        this.releaseRunLease(managed);
      }
      return this.composeResult(managed, wfError);
    }
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(
    script: string,
    args: unknown | undefined,
    journaling: boolean,
    exec: ExecOptions,
    background: boolean,
    identity: { runId: string; lease: RunLease },
  ): ManagedRun {
    const parsed = parseWorkflowScript(script);
    const capturedArgs = snapshotArgs(args);
    const effectiveCwd = exec.cwd ?? this.cwd;
    const startedAt = new Date();
    const admission = createRunAdmission(exec, startedAt.toISOString());
    return {
      runId: identity.runId,
      cwd: exec.cwd,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt,
      script,
      args: capturedArgs.ok ? capturedArgs.clone : args,
      argsSnapshotOk: capturedArgs.ok,
      ...(!capturedArgs.ok ? { argsUnreplayable: true as const } : {}),
      meta: parsed.meta,
      journal: [],
      fallbacks: [],
      checkpointsTaken: [],
      calls: [],
      effectiveCwd,
      runtime: runtimeIdentity(),
      environment: captureRunEnvironment(effectiveCwd, exec.environmentKey ?? this.environmentKey),
      ...(admission ? { admission } : {}),
      ...(journaling ? { resume: { format: "identity-v1" as const } } : {}),
      resumeActivity: 0,
      resumeFilesystemTainted: false,
      resumeTerminalFinalized: false,
      executionSettled: false,
      environmentKey: exec.environmentKey ?? this.environmentKey,
      callsAllocated: 0,
      limits: resolveWorkflowRunLimits({
        maxAgents: exec.maxAgents,
        concurrency: exec.concurrency ?? this.concurrency,
        agentRetries: exec.agentRetries ?? this.defaultAgentRetries,
      }),
      mainModel: this.mainModel,
      defaultModel: exec.defaultModel,
      agentsDir: this.agentsDir,
      executionMode: exec.executionMode,
      ...(exec.resumeFromRunId ? { resumeSourceRunId: exec.resumeFromRunId } : {}),
      ...(exec.resumeJournal ? { legacyResume: true as const, newRunResume: true as const } : {}),
      journaling,
      background,
      lease: identity.lease,
      ...(journaling ? { eventStreamId: generateEventStreamId(), eventSeq: 0 } : {}),
    };
  }

  private resolveJournaling(exec: ExecOptions): boolean {
    return exec.journaling ?? this.journaling;
  }

  private createRunEvent<Name extends EngineRunEventName>(
    type: Name,
    payload: EngineRunEventPayloadMap[Name],
  ): EngineRunEvent {
    return Object.assign({ type }, payload as object) as unknown as EngineRunEvent;
  }

  private reportPersistenceFailure(error: unknown): void {
    try {
      console.warn("[workflow-manager] Persist run failed:", error);
    } catch {
      // Persistence diagnostics are best-effort.
    }
  }

  private savePersistedState(state: PersistedRunState, publication: EventPublicationState): boolean {
    if (!publication.lease || this.persistence.validateRunLease?.(publication.lease) === false) return false;
    try {
      this.persistence.save(state);
      return true;
    } catch (error) {
      this.reportPersistenceFailure(error);
      return false;
    }
  }

  private syncEventWatermark(state: EventPublicationState, snapshot: PersistedRunState): void {
    snapshot.eventStreamId = state.eventStreamId;
    snapshot.eventSeq = state.eventSeq;
    if (state.eventLogIncomplete) snapshot.eventLogIncomplete = true;
  }

  private prepareEventPublicationState(
    snapshot: PersistedRunState,
    lease: RunLease,
  ): EventPublicationState {
    const state: EventPublicationState = {
      runId: snapshot.runId,
      journaling: true,
      lease,
      eventStreamId: snapshot.eventStreamId,
      eventSeq: snapshot.eventSeq,
      eventLogIncomplete: snapshot.eventLogIncomplete,
    };

    if (snapshot.eventStreamId === undefined && snapshot.eventSeq === undefined) {
      state.eventStreamId = generateEventStreamId();
      state.eventSeq = 0;
      this.syncEventWatermark(state, snapshot);
      if (!this.savePersistedState(snapshot, state)) {
        state.eventLogIncomplete = true;
        snapshot.eventLogIncomplete = true;
        this.savePersistedState(snapshot, state);
        return state;
      }
    }

    if (state.eventLogIncomplete) return state;

    try {
      const tail = this.persistence.readEvents(snapshot.runId).endCursor;
      state.eventSeq = tail;
    } catch (error) {
      state.eventLogIncomplete = true;
      snapshot.eventLogIncomplete = true;
      this.reportPersistenceFailure(error);
      this.savePersistedState(snapshot, state);
    }
    return state;
  }

  private deliverRunEvent(event: EngineRunEvent): boolean {
    if (event.type === "error" && this.listenerCount("error") === 0) return false;
    const { type, ...payload } = event;
    return this.emit(type, payload);
  }

  /** Backend-neutral, best-effort ingress used by the SDK ACP adapter. */
  protected observeAgentActivity(activity: WorkflowAgentActivity): void {
    this.liveAgentObservability.observe(activity);
  }

  private publishRunEvent(
    state: EventPublicationState,
    event: EngineRunEvent,
    saveIncompleteMarker: () => void,
    actions: RunEventPublicationActions = {},
  ): boolean {
    let appendedRecord: RunEventLogRecord | undefined;
    if (
      isPersistableRunEvent(event) &&
      state.journaling &&
      state.lease &&
      !state.eventLogIncomplete
    ) {
      try {
        if (this.persistence.validateRunLease?.(state.lease) === false) {
          throw new Error(`run ${state.runId} no longer owns its persistence lease`);
        }
        if (state.eventStreamId === undefined || state.eventSeq === undefined) {
          throw new Error(`run ${state.runId} has no event publication watermark`);
        }
        const candidate = state.eventSeq + 1;
        const record = this.persistence.appendEvent(state.runId, {
          seq: candidate,
          timestamp: new Date().toISOString(),
          event,
        });
        state.eventSeq = record.seq;
        appendedRecord = record;
      } catch (error) {
        state.eventLogIncomplete = true;
        this.reportPersistenceFailure(error);
        saveIncompleteMarker();
        const managed = this.runs.get(state.runId);
        if (managed === state) this.liveAgentObservability.clearRun(managed);
      }
    }

    if (appendedRecord !== undefined) {
      // Stable host seam for protocol-native resource update publication. Emitted only after
      // the append is durable; consumers may safely direct readers to the new watermark.
      this.emit("runEventPersisted", appendedRecord);
      try {
        actions.afterAppend?.(appendedRecord);
      } catch (error) {
        this.reportPersistenceFailure(error);
      }
    }

    actions.beforeLive?.();
    const delivered = this.deliverRunEvent(event);
    actions.afterLive?.();
    return delivered;
  }

  /**
   * Compose the host-facing WorkflowRunResult (status trio included) from a managed
   * run plus the engine's bare result. status is already settled on `managed`; this
   * is a pure narrowing — the engine seam is never widened.
   */
  private composeResult(
    managed: ManagedRun,
    error: WorkflowError | undefined,
    engineResult?: EngineRunResult,
  ): WorkflowRunResult {
    const usageLimit = error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
    const authRequired = error?.code === WorkflowErrorCode.AUTH_REQUIRED;
    const checkpointRequired = error?.code === WorkflowErrorCode.CHECKPOINT_REQUIRED;
    const reason = runReason(managed.status, error);
    const snapshotUsage = managed.snapshot.tokenUsage;
    const tokenUsage: TokenUsage | undefined =
      engineResult?.tokenUsage ??
      (snapshotUsage
        ? {
            input: snapshotUsage.input,
            output: snapshotUsage.output,
            total: snapshotUsage.total,
            cost: snapshotUsage.cost ?? 0,
            cacheRead: snapshotUsage.cacheRead,
            cacheWrite: snapshotUsage.cacheWrite,
          }
        : undefined);
    const { fallbacks, checkpointsTaken } = managed;
    return {
      runId: managed.runId,
      status: managed.status,
      meta: managed.meta ?? {
        name: managed.snapshot.name,
        description: managed.snapshot.description ?? "",
        phases: managed.snapshot.phases.map((title) => ({ title })),
      },
      result: engineResult?.result,
      phases: engineResult?.phases ?? managed.snapshot.phases,
      agentCount: engineResult?.agentCount ?? managed.snapshot.agents.length,
      durationMs: engineResult?.durationMs ?? Date.now() - managed.startedAt.getTime(),
      tokenUsage,
      logs: engineResult?.logs ?? managed.snapshot.logs,
      ...(managed.status === "completed"
        ? {}
        : { logTail: createWorkflowLogTail(engineResult?.logs ?? managed.snapshot.logs, 20) }),
      reason,
      resetHint: usageLimit ? error?.resetHint : undefined,
      // Structured, NON-SECRET auth surface for an auth pause (§2.12) — hosts read this,
      // never the reason message. Absent on every other outcome.
      authContext: authRequired ? error?.authContext : undefined,
      // Structured, NON-SECRET pending durable checkpoint surface. Absent on every
      // other outcome; hosts use it to collect a reply for checkpointReplies.
      checkpointContext: checkpointRequired ? error?.checkpointContext : undefined,
      // Fall back to the snapshot's per-agent records when the engine returned no result
      // (pause/failure mid-run) so re-attach handles survive an interrupted run.
      agentSessions:
        engineResult?.agentSessions ??
        managed.snapshot.agents.map((a) => a.session).filter((s): s is NonNullable<typeof s> => s != null),
      ...(fallbacks.length === 0 ? {} : { fallbacks }),
      ...(checkpointsTaken.length === 0 ? {} : { checkpointsTaken }),
      calls: engineResult?.calls ?? managed.calls,
      callsAllocated: engineResult?.callsAllocated ?? managed.callsAllocated,
      ...(engineResult?.resumeReport ?? managed.resumeReport
        ? { resumeReport: engineResult?.resumeReport ?? managed.resumeReport }
        : {}),
      ...(managed.replayEligibility ? { replayEligibility: managed.replayEligibility } : {}),
      ...(managed.continuation ? { continuation: managed.continuation } : {}),
      effectiveLimits: engineResult?.effectiveLimits ?? managed.limits,
      ...(engineResult?.abortSignaled || managed.abortSignaled ? { abortSignaled: true as const } : {}),
      ...(engineResult?.nestedWorkflows || managed.nestedWorkflows ? { nestedWorkflows: true as const } : {}),
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    exec: ExecOptions = {},
    resumeExecution?: ManagerResumeExecution,
  ): Promise<WorkflowRunResult> {
    const {
      maxAgents,
      externalSignal,
      signal,
      onProgress,
      concurrency,
      agentRetries,
      confirm,
      pauseOnCheckpoint,
      onNestedWorkflow,
      scriptBackends,
    } = exec;
    const resumeJournal = resumeExecution?.resumeJournal ?? exec.resumeJournal;
    const preparedResume = resumeExecution?.preparedResume;
    const preparedContinuation = managed.preparedContinuation;
    const resolvedConcurrency = concurrency ?? this.concurrency;
    const resolvedAgentRetries = agentRetries ?? this.defaultAgentRetries;
    // Sync the derived counters (agentCount/runningCount/doneCount/errorCount) from the
    // agents array BEFORE every emission: the mutation sites below only push/patch
    // `snapshot.agents`, so without this the counters stay frozen at their initial 0s and
    // every onProgress consumer reads "0/0" forever.
    const progress = () => {
      Object.assign(managed.snapshot, recomputeWorkflowSnapshot(managed.snapshot));
      onProgress?.(managed.snapshot);
    };
    managed.liveProgress = progress;
    const publish = (event: EngineRunEvent, actions?: RunEventPublicationActions) =>
      this.publishRunEvent(managed, event, () => this.persistRun(managed), actions);
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    const hostSignal = externalSignal ?? signal;
    if (hostSignal) {
      if (hostSignal.aborted) managed.controller.abort();
      else hostSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
      if (exec.executionAdmission && await exec.executionAdmission !== "admitted") {
        throw new WorkflowError(
          "workflow execution was denied because host admission did not become durable",
          WorkflowErrorCode.PERSISTENCE_ERROR,
          { recoverable: false },
        );
      }
      if (!managed.journaling && resumeJournal) {
        throw new WorkflowError("journaling disabled for this run", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        });
      }
      // Resolve the injected agent backend (per-run override > constructor). The
      // engine REQUIRES an AgentRunner and never constructs one.
      const agent = this.resolveAgent(exec);
      const vmArgsSnapshot = managed.argsSnapshotOk ? snapshotArgs(managed.args) : { ok: false as const };
      const argsForVm = vmArgsSnapshot.ok ? vmArgsSnapshot.clone : managed.args;
      const engineResult = await runWorkflow(script, {
        cwd: managed.effectiveCwd,
        args: argsForVm,
        agent,
        mainModel: managed.mainModel,
        defaultModel: managed.admission?.defaultModel ?? managed.defaultModel,
        agentConfigurations: managed.admission?.agentConfigurations ?? exec.agentConfigurations,
        requireAgentConfiguration: managed.admission?.strict ?? exec.requireAgentConfiguration,
        agentsDir: managed.agentsDir,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents,
        confirm,
        pauseOnCheckpoint,
        onNestedWorkflow: (ordinal, childRunId) => {
          managed.nestedWorkflows = true;
          onNestedWorkflow?.(ordinal, childRunId);
        },
        scriptBackends: managed.admission?.scriptBackends ?? scriptBackends,
        loadSavedWorkflow: this.loadSavedWorkflow,
        // Manager-level `journal` events are observation, not persistence. Keep the engine's
        // deterministic journal callback active even when file journaling is disabled; the
        // manager decides below whether an entry is persisted or only emitted.
        journaling: true,
        persistLogs: managed.journaling,
        persistenceRoot: this.persistenceRoot,
        resumeJournal: managed.journaling ? resumeJournal : undefined,
        resumeFromRunId: managed.journaling
          ? preparedResume?.sourceRunId ?? (resumeJournal ? managed.runId : undefined)
          : undefined,
        sameRunContinuation: managed.sameRunContinuation,
        tokenUsageBaseline: managed.sameRunContinuation
          ? {
              input: managed.snapshot.tokenUsage?.input ?? 0,
              output: managed.snapshot.tokenUsage?.output ?? 0,
              total: managed.snapshot.tokenUsage?.total ?? 0,
              cost: managed.snapshot.tokenUsage?.cost ?? 0,
              cacheRead: managed.snapshot.tokenUsage?.cacheRead ?? 0,
              cacheWrite: managed.snapshot.tokenUsage?.cacheWrite ?? 0,
            }
          : undefined,
        preparedResume,
        preparedContinuation,
        runId: managed.runId,
        onResumeFilesystemTainted: () => {
          managed.resumeFilesystemTainted = true;
        },
        onResumeActivity: (active) => {
          if (
            !Number.isSafeInteger(active) ||
            active < 0 ||
            Math.abs(active - (managed.resumeActivity ?? 0)) !== 1
          ) {
            managed.resumeActivityInvalid = true;
            return;
          }
          managed.resumeActivity = active;
        },
        onResumeCallAllocated: (allocated) => {
          if (!Number.isSafeInteger(allocated) || allocated !== (managed.callsAllocated ?? 0) + 1) {
            managed.resumeActivityInvalid = true;
            return;
          }
          managed.callsAllocated = allocated;
        },
        onResumeDecision: (decision) => this.recordResumeDecision(managed, decision),
        onAgentJournal: (entry) => this.recordJournalEntry(managed, entry),
        injectedCheckpointReplies: resumeExecution?.injectedCheckpointReplies ?? new Set(
          Object.keys(preparedResume ? {} : exec.checkpointReplies ?? {}).map((index) => Number(index)),
        ),
        onFallback: (entry) => {
          managed.fallbacks.push(entry);
          this.persistRun(managed);
        },
        onCheckpointTaken: (entry) => {
          managed.checkpointsTaken.push(entry);
          this.persistRun(managed);
        },
        onCallRecord: (record) => this.recordCallRecord(managed, record),
        onAgentAttempt: (attempt) => this.registerAgentAttempt(managed, attempt),
        onLog: (message, context) => {
          managed.snapshot.logs.push(message);
          publish(this.createRunEvent("log", {
            runId: managed.runId,
            scope: context?.scope ?? managed.runId,
            message,
          }));
          progress();
        },
        onPhase: (title, context) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          publish(this.createRunEvent("phase", {
            runId: managed.runId,
            scope: context?.scope ?? managed.runId,
            title,
          }));
          progress();
        },
        onAgentStart: (event) => {
          if (this.dropPostTerminal(managed, "agentStart")) return;
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
            callIndex: event.callIndex,
            scope: event.scope,
          });
          const scope = event.scope ?? managed.runId;
          publish(this.createRunEvent("agentStart", {
            runId: managed.runId,
            ...event,
            scope,
          }), {
            afterAppend: (record) => {
              this.liveAgentObservability.register(managed, {
                rootRunId: managed.runId,
                scope,
                callIndex: event.callIndex,
                label: event.label,
                ...(event.phase === undefined ? {} : { phase: event.phase }),
                executionStartSeq: record.seq,
              });
            },
          });
          progress();
        },
        onAgentEnd: (event) => {
          if (this.dropPostTerminal(managed, "agentEnd")) return;
          this.liveAgentObservability.finish(event.scope ?? managed.runId, event.callIndex, managed);
          const agentSnapshot = event.callIndex === undefined
            ? [...managed.snapshot.agents]
                .reverse()
                .find((a) => a.label === event.label && a.status === "running")
            : managed.snapshot.agents.find(
                (a) =>
                  a.scope === event.scope &&
                  a.callIndex === event.callIndex &&
                  a.status === "running",
              );
          if (agentSnapshot) {
            agentSnapshot.status =
              event.errorRecord || (event.provenance?.source === "replay" && event.result === null)
                ? "error"
                : "done";
            agentSnapshot.resultPreview = preview(event.result);
            agentSnapshot.error = event.error;
            agentSnapshot.errorCode = event.errorCode;
            agentSnapshot.recoverable = event.recoverable;
            agentSnapshot.tokens = event.tokens;
            agentSnapshot.callIndex = event.callIndex;
            agentSnapshot.scope = event.scope;
            agentSnapshot.usage = event.usage;
            agentSnapshot.provenance = event.provenance;
            if (event.model) agentSnapshot.model = event.model;
            if (event.session) agentSnapshot.session = event.session;
          }
          publish(this.createRunEvent("agentEnd", {
            runId: managed.runId,
            ...event,
            scope: event.scope ?? managed.runId,
          }));
          this.completeAgentCancellation(managed, event);
          progress();
        },
        onAgentHistory: (event) => {
          if (this.dropPostTerminal(managed, "agentHistory")) return;
          const agentSnapshot = event.callIndex === undefined
            ? [...managed.snapshot.agents]
                .reverse()
                .find((a) => a.label === event.label && a.status === "running")
            : managed.snapshot.agents.find(
                (a) =>
                  a.scope === event.scope &&
                  a.callIndex === event.callIndex &&
                  a.status === "running",
              );
          if (agentSnapshot) {
            agentSnapshot.history = event.history;
          }
          publish(this.createRunEvent("agentHistory", {
            runId: managed.runId,
            ...event,
            scope: event.scope ?? managed.runId,
          }));
          progress();
        },
        onTokenUsage: (usage, context) => {
          managed.snapshot.tokenUsage = usage;
          publish(this.createRunEvent("tokenUsage", {
            runId: managed.runId,
            scope: context?.scope ?? managed.runId,
            usage,
          }));
          progress();
        },
      });

      managed.executionSettled = true;
      managed.calls = engineResult.calls ?? [];
      managed.callsAllocated = engineResult.callsAllocated;
      if (engineResult.resumeReport && managed.resumeReportPlan) {
        managed.resumeReport = buildResumeReport(
          managed.resumeReportPlan,
          engineResult.resumeReport.calls,
          true,
        );
        engineResult.resumeReport = managed.resumeReport;
        if (managed.replayEligibilityPlan) {
          managed.replayEligibility = this.buildReplayEligibility(
            managed.replayEligibilityPlan,
            managed.resumeReport,
          );
        }
      } else {
        managed.resumeReport = engineResult.resumeReport;
      }
      managed.limits = engineResult.effectiveLimits;
      if (engineResult.abortSignaled) managed.abortSignaled = true;
      if (engineResult.nestedWorkflows) managed.nestedWorkflows = true;
      this.liveAgentObservability.finishRun(managed);
      managed.liveProgress = undefined;
      managed.status = "completed";
      const result = this.composeResult(managed, undefined, engineResult);
      managed.result = result;
      publish(
        this.createRunEvent("complete", {
          runId: managed.runId,
          scope: managed.runId,
          result,
        }),
        {
          afterLive: () => {
            this.persistRun(managed);
            this.releaseRunLease(managed);
          },
        },
      );

      return result;
    } catch (error) {
      managed.executionSettled = true;
      this.liveAgentObservability.finishRun(managed);
      managed.liveProgress = undefined;
      // The engine wraps every fault that crosses the script boundary as a WorkflowError
      // (script crashes are SCRIPT_ERROR), so a bare error HERE is manager/host-level
      // (persistence, fs). Label it UNKNOWN — never WORKFLOW_ABORTED, which is reserved
      // for actual cancellation.
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(errorMessage(error), WorkflowErrorCode.UNKNOWN, { recoverable: false });
      const uncovered = readUncoveredOccurrence(workflowError.details);
      if (managed.admission && uncovered) {
        managed.admission = deepFreeze({
          ...managed.admission,
          uncoveredOccurrence: { ...uncovered, recordedAt: new Date().toISOString() },
        });
      }

      // Three recoverable-by-external-action fault codes checkpoint the run as PAUSED (not failed),
      // so resume() replays the journaled prefix instead of restarting from scratch (§2.12):
      //  - PROVIDER_USAGE_LIMIT: a provider quota refills over time.
      //  - AUTH_REQUIRED: a host completes an auth step.
      //  - CHECKPOINT_REQUIRED: a host supplies the pending durable checkpoint decision.
      // All are recoverable:false, so the retry ladder skips them.
      const authPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.AUTH_REQUIRED;
      const usageLimitPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
      const checkpointPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.CHECKPOINT_REQUIRED;
      const paused = usageLimitPaused || authPaused || checkpointPaused;
      if (managed.controller.signal.aborted) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
        if (managed.status === "running") {
          managed.status = "aborted";
        }
      } else if (paused) {
        managed.status = "paused";
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      this.finalizeResumeReport(managed);
      managed.result = this.composeResult(managed, workflowError);

      if (paused) {
        const errorRecord = projectRecordedError(workflowError);
        const pausedEvent = authPaused
          ? this.createRunEvent("paused", {
              runId: managed.runId,
              scope: managed.runId,
              reason: "auth_required",
              error: workflowError,
              errorRecord,
              authContext: workflowError.authContext,
            })
          : checkpointPaused
            ? this.createRunEvent("paused", {
                runId: managed.runId,
                scope: managed.runId,
                reason: "checkpoint_required",
                error: workflowError,
                errorRecord,
                checkpointContext: workflowError.checkpointContext,
              })
            : this.createRunEvent("paused", {
                runId: managed.runId,
                scope: managed.runId,
                reason: "usage_limit",
                error: workflowError,
                errorRecord,
                resetHint: workflowError.resetHint,
              });
        publish(pausedEvent, {
          beforeLive: () => {
            this.persistRun(managed);
            this.releaseRunLease(managed);
          },
        });
      } else {
        publish(
          this.createRunEvent("error", {
            runId: managed.runId,
            scope: managed.runId,
            error: workflowError,
            errorRecord: projectRecordedError(workflowError),
          }),
          {
            beforeLive: () => {
              this.persistRun(managed);
              this.releaseRunLease(managed);
            },
          },
        );
      }

      throw workflowError;
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private recordResumeDecision(managed: ManagedRun, decision: WorkflowResumeCallDecision): void {
    if (!managed.resumeReportPlan || !managed.resumeDecisions) return;
    managed.resumeDecisions.set(decision.index, decision);
    managed.resumeReport = buildResumeReport(
      managed.resumeReportPlan,
      [...managed.resumeDecisions.values()],
    );
    if (managed.replayEligibilityPlan) {
      managed.replayEligibility = this.buildReplayEligibility(
        managed.replayEligibilityPlan,
        managed.resumeReport,
      );
    }
    this.persistRun(managed);
  }

  private finalizeResumeReport(managed: ManagedRun): void {
    if (!managed.resumeReportPlan || !managed.resumeDecisions) return;
    managed.resumeReport = buildResumeReport(
      managed.resumeReportPlan,
      [...managed.resumeDecisions.values()],
      true,
    );
    if (managed.replayEligibilityPlan) {
      managed.replayEligibility = this.buildReplayEligibility(
        managed.replayEligibilityPlan,
        managed.resumeReport,
      );
    }
  }

  private recordJournalEntry(managed: ManagedRun, entry: JournalEntry): void {
    if (this.dropPostTerminal(managed, "journal")) return;
    const rootScope = entry.scope === undefined || entry.scope === managed.runId;
    if (rootScope) {
      managed.journal = managed.journal.filter((e) => e.index !== entry.index);
      managed.journal.push(entry);
      if (entry.kind === "checkpoint") this.persistRunOrThrow(managed);
    }
    this.publishRunEvent(
      managed,
      this.createRunEvent("journal", {
        runId: managed.runId,
        scope: entry.scope ?? managed.runId,
        entry,
      }),
      () => this.persistRun(managed),
      rootScope ? { beforeLive: () => this.persistRun(managed) } : undefined,
    );
  }

  private recordCallRecord(managed: ManagedRun, record: WorkflowCallRecord): void {
    if (this.dropPostTerminal(managed, "callRecord")) return;
    const rootScope = record.scope === undefined || record.scope === managed.runId;
    if (rootScope) {
      if (record.origin === "journal-replay" && record.outcome === "result") {
        const source = managed.journal.find(
          (entry) => entry.index === record.index && entry.hash === record.hash,
        );
        if (source) {
          const phase = record.kind === "checkpoint" ? managed.snapshot.currentPhase : source.call?.phase;
          const label = record.kind === "agent" ? record.label ?? source.call?.label ?? "agent" : "checkpoint";
          const rebound = deepFreeze({
            ...source,
            kind: record.kind,
            scope: managed.runId,
            ...(source.session
              ? {
                  session: {
                    ...source.session,
                    callIndex: record.index,
                    label,
                    ...(phase === undefined ? {} : { phase }),
                  },
                }
              : {}),
            call: record.kind === "agent"
              ? {
                  ...source.call,
                  kind: "agent" as const,
                  label,
                  ...(phase === undefined ? {} : { phase }),
                }
              : {
                  kind: "checkpoint" as const,
                  label: "checkpoint" as const,
                  phase,
                },
          } satisfies JournalEntry);
          managed.journal = latestRows([
            ...managed.journal.filter((entry) => entry.index !== record.index),
            rebound,
          ]);
        }
      }
      managed.calls = managed.calls.filter((row) => row.index !== record.index);
      managed.calls.push(record);
    }
    this.publishRunEvent(
      managed,
      this.createRunEvent("callRecord", {
        runId: managed.runId,
        scope: record.scope ?? managed.runId,
        record,
      }),
      () => this.persistRun(managed),
      rootScope ? { beforeLive: () => this.persistRun(managed) } : undefined,
    );
  }

  private registerAgentAttempt(
    managed: ManagedRun,
    control: WorkflowAgentAttemptControl,
  ): () => void {
    const attempt: RegisteredAgentAttempt = { ...control };
    let attempts = this.agentAttempts.get(managed.runId);
    if (!attempts) {
      attempts = new Set();
      this.agentAttempts.set(managed.runId, attempts);
    }
    attempts.add(attempt);

    return () => {
      const current = this.agentAttempts.get(managed.runId);
      current?.delete(attempt);
      if (current?.size === 0) this.agentAttempts.delete(managed.runId);
      if (attempt.cancellation && !attempt.cancellation.settled) {
        this.rejectAgentCancellation(
          attempt.cancellation,
          new WorkflowError(
            `Agent call ${attempt.callIndex} ("${attempt.label}") settled before host cancellation won the race.`,
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            { recoverable: false },
          ),
        );
      }
    };
  }

  private completeAgentCancellation(
    managed: ManagedRun,
    event: NonNullable<WorkflowRunOptions["onAgentEnd"]> extends (event: infer Event) => void
      ? Event
      : never,
  ): void {
    const matching = [...(this.agentAttempts.get(managed.runId) ?? [])].filter(
      (attempt) =>
        attempt.callIndex === event.callIndex &&
        attempt.scope === event.scope &&
        attempt.cancellation !== undefined &&
        !attempt.cancellation.settled,
    );
    if (matching.length === 0) return;

    let persistenceError: WorkflowError | undefined;
    if (managed.journaling) {
      try {
        this.persistRunOrThrow(managed);
        if (managed.eventLogIncomplete) {
          throw new WorkflowError(
            `Agent call ${event.callIndex} cancellation for run ${managed.runId} could not be durably acknowledged because its event log is incomplete.`,
            WorkflowErrorCode.PERSISTENCE_ERROR,
            { recoverable: false },
          );
        }
      } catch (error) {
        persistenceError = error instanceof WorkflowError
          ? error
          : new WorkflowError(
              `Agent call ${event.callIndex} cancellation for run ${managed.runId} could not be persisted: ${errorMessage(error)}`,
              WorkflowErrorCode.PERSISTENCE_ERROR,
              { recoverable: false },
            );
      }
    }

    for (const attempt of matching) {
      const pending = attempt.cancellation!;
      if (persistenceError) {
        this.rejectAgentCancellation(pending, persistenceError);
      } else if (event.errorCode !== WorkflowErrorCode.AGENT_CANCELLED) {
        this.rejectAgentCancellation(
          pending,
          new WorkflowError(
            `Agent call ${event.callIndex} ("${attempt.label}") settled before host cancellation won the race.`,
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            { recoverable: false },
          ),
        );
      } else {
        pending.settled = true;
        pending.resolve({
          runId: managed.runId,
          callIndex: attempt.callIndex,
          label: attempt.label,
          scope: attempt.scope,
          errorCode: WorkflowErrorCode.AGENT_CANCELLED,
        });
      }
    }
  }

  private rejectAgentCancellation(pending: PendingAgentCancellation, error: WorkflowError): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.reject(error);
  }

  private currentAgentAttempts(runId: string): RegisteredAgentAttempt[] {
    return [...(this.agentAttempts.get(runId) ?? [])]
      .filter((attempt) => !attempt.controller.signal.aborted || attempt.cancellation !== undefined)
      .sort((left, right) =>
        left.callIndex - right.callIndex ||
        left.label.localeCompare(right.label) ||
        left.scope.localeCompare(right.scope)
      );
  }

  private agentCancellationSelectionError(
    runId: string,
    callIndex: number,
    message: string,
    inFlight = this.currentAgentAttempts(runId),
  ): WorkflowError {
    const listing = inFlight.length === 0
      ? "none"
      : inFlight
          .map((attempt) =>
            `${attempt.callIndex} (${JSON.stringify(attempt.label)}, scope ${JSON.stringify(attempt.scope)})`
          )
          .join(", ");
    return new WorkflowError(
      `${message} Currently in-flight agent calls (callIndex, label, scope): ${listing}.`,
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      {
        recoverable: false,
        details: {
          runId,
          callIndex,
          inFlight: inFlight.map((attempt) => ({
            callIndex: attempt.callIndex,
            label: attempt.label,
            scope: attempt.scope,
          })),
        },
      },
    );
  }

  private dropPostTerminal(managed: ManagedRun, event: string): boolean {
    if (managed.status === "running") return false;
    try {
      console.debug(`[workflow-manager] dropped post-terminal ${event} for ${managed.runId}`);
    } catch {
      // Debug reporting is best-effort.
    }
    return true;
  }

  private prepareTerminalResumeState(managed: ManagedRun): void {
    if (managed.status === "running") return;
    if (managed.newRunResume) {
      managed.calls = latestRows(managed.calls.filter((row) => row.scope === managed.runId));
      const resultRows = new Map(
        managed.calls
          .filter((row) => row.outcome === "result")
          .map((row) => [row.index, row] as const),
      );
      managed.journal = latestRows(
        managed.journal.filter((entry) => {
          if (entry.scope !== managed.runId) return false;
          const row = resultRows.get(entry.index);
          return row !== undefined && entry.kind === row.kind && entry.hash === row.hash;
        }),
      );
      if (managed.status === "completed") {
        managed.resumeSeed = undefined;
      } else if (managed.resumeSeed) {
        managed.resumeSeed = deepFreeze({
          ...managed.resumeSeed,
          sourceRunId: managed.runId,
        });
      }
      if (managed.resumeSeed?.checkpointInjections) {
        const checkpointKeys = new Set(
          managed.calls
            .filter((row) => row.kind === "checkpoint")
            .map((row) => `${row.hash}\u0000${row.inputsHash ?? ""}`),
        );
        const checkpointInjections = managed.resumeSeed.checkpointInjections.filter(
          (injection) => !checkpointKeys.has(`${injection.hash}\u0000${injection.inputsHash}`),
        );
        if (checkpointInjections.length !== managed.resumeSeed.checkpointInjections.length) {
          const { checkpointInjections: _discarded, ...remainingSeed } = managed.resumeSeed;
          managed.resumeSeed = deepFreeze({
            ...remainingSeed,
            ...(checkpointInjections.length === 0 ? {} : { checkpointInjections }),
          });
        }
      }
    }
    if (managed.resumeTerminalFinalized) return;
    managed.resumeTerminalFinalized = true;
    if (!managed.resume) return;
    managed.resume = { format: "identity-v1" };
    if (!managed.executionSettled || managed.resumeActivityInvalid || (managed.resumeActivity ?? 0) !== 0) return;
    const terminalEnvironment = captureRunEnvironment(managed.effectiveCwd, managed.environmentKey);
    if (terminalEnvironment?.git) {
      managed.resume = { format: "identity-v1", terminalEnvironment };
    } else if (terminalEnvironment?.key !== undefined && !managed.resumeFilesystemTainted) {
      managed.resume = { format: "identity-v1", terminalEnvironment };
    }
  }

  private persistedState(managed: ManagedRun): PersistedRunState {
    this.prepareTerminalResumeState(managed);
    return {
      runId: managed.runId,
      workflowName: managed.snapshot.name,
      // Persist the real script + journal so the run can be resumed. Runs live
      // in workflow run storage — protect via directory permissions, not blanking.
      script: managed.script,
      args: managed.args,
      argsUnreplayable: managed.argsUnreplayable,
      // The per-run working directory, so resume() re-runs in the SAME place.
      cwd: managed.cwd,
      effectiveCwd: managed.effectiveCwd,
      runtime: managed.runtime,
      environment: managed.environment,
      ...(managed.resume ? { resume: managed.resume } : {}),
      ...(managed.resumeSourceRunId ? { resumeSourceRunId: managed.resumeSourceRunId } : {}),
      ...(managed.resumeSeed ? { resumeSeed: managed.resumeSeed } : {}),
      ...(managed.resumeReport ? { resumeReport: managed.resumeReport } : {}),
      ...(managed.replayEligibility ? { replayEligibility: managed.replayEligibility } : {}),
      ...(managed.admission ? { admission: managed.admission } : {}),
      ...(managed.continuation ? { continuation: managed.continuation } : {}),
      mainModel: managed.mainModel,
      defaultModel: managed.defaultModel,
      agentsDir: managed.agentsDir,
      executionMode: managed.executionMode,
      eventStreamId: managed.eventStreamId,
      eventSeq: managed.eventSeq,
      eventLogIncomplete: managed.eventLogIncomplete,
      nestedWorkflows: managed.nestedWorkflows,
      legacyResume: managed.legacyResume,
      sessionId: this.sessionId,
      journal: managed.journal,
      ...(managed.fallbacks.length === 0 ? {} : { fallbacks: managed.fallbacks }),
      ...(managed.checkpointsTaken.length === 0 ? {} : { checkpointsTaken: managed.checkpointsTaken }),
      calls: managed.calls,
      callsAllocated: managed.callsAllocated,
      limits: managed.limits,
      ...(managed.abortSignaled || managed.controller.signal.aborted
        ? { abortSignaled: true as const }
        : {}),
      status: managed.status,
      reason: runReason(managed.status, managed.error),
      errorCode: managed.error?.code,
      // Why a pause happened, so the navigator / a future cold start can show it and
      // re-arm resume (§2.12). Selector switches on the paused run's error code:
      // AUTH_REQUIRED -> "auth_required", PROVIDER_USAGE_LIMIT -> "usage_limit",
      // CHECKPOINT_REQUIRED -> "checkpoint_required".
      pauseReason:
        managed.status === "paused"
          ? managed.error?.code === WorkflowErrorCode.AUTH_REQUIRED
            ? "auth_required"
            : managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
              ? "usage_limit"
              : managed.error?.code === WorkflowErrorCode.CHECKPOINT_REQUIRED
                ? "checkpoint_required"
                : undefined
          : undefined,
      // resetHint stays usage-limit-only.
      resetHint:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
          ? managed.error.resetHint
          : undefined,
      // The NON-SECRET auth surface for an auth pause — backendId + advertised method
      // ids/types/names only (never authenticateMeta/envValues; Principle 9, §2.14). It
      // arms resume()'s cold re-check (§2.13).
      authContext:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.AUTH_REQUIRED
          ? managed.error.authContext
          : undefined,
      // The NON-SECRET pending durable checkpoint surface. Its callIndex/hash pair arms
      // resume() to inject the host's decision as a deterministic journal entry.
      checkpointContext:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.CHECKPOINT_REQUIRED
          ? managed.error.checkpointContext
          : undefined,
      phases: managed.snapshot.phases,
      currentPhase: managed.snapshot.currentPhase,
      agents: managed.snapshot.agents.map((a) => ({
        ...a,
        startedAt: managed.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
      })),
      logs: managed.snapshot.logs,
      result: managed.result?.result,
      tokenUsage: managed.snapshot.tokenUsage
        ? {
            input: managed.snapshot.tokenUsage.input,
            output: managed.snapshot.tokenUsage.output,
            total: managed.snapshot.tokenUsage.total,
            cost: managed.snapshot.tokenUsage.cost,
            cacheRead: managed.snapshot.tokenUsage.cacheRead,
            cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
          }
        : undefined,
      startedAt: managed.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
      durationMs: managed.result?.durationMs,
    };
  }

  private persistRun(managed: ManagedRun) {
    if (
      !managed.journaling ||
      !managed.lease ||
      this.persistence.validateRunLease?.(managed.lease) === false
    ) return;
    try {
      this.persistence.save(this.persistedState(managed));
    } catch (err) {
      this.reportPersistenceFailure(err);
    }
  }

  private persistRunOrThrow(managed: ManagedRun): void {
    const leaseFailure = !managed.journaling
      ? "journaling is disabled"
      : !managed.lease
        ? "the lease is missing"
        : this.persistence.validateRunLease?.(managed.lease) === false
          ? "the lease is no longer owned"
          : undefined;
    if (leaseFailure) {
      throw new WorkflowError(
        `run ${managed.runId} cannot be durably updated because ${leaseFailure}`,
        WorkflowErrorCode.PERSISTENCE_ERROR,
        { recoverable: false },
      );
    }
    try {
      this.persistence.save(this.persistedState(managed));
    } catch (error) {
      throw new WorkflowError(
        `failed to persist resume state for ${managed.runId}: ${errorMessage(error)}`,
        WorkflowErrorCode.PERSISTENCE_ERROR,
        { recoverable: false },
      );
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    this.liveAgentObservability.finishRun(managed);
    managed.status = "paused";
    this.publishRunEvent(
      managed,
      this.createRunEvent("paused", { runId, scope: runId }),
      () => this.persistRun(managed),
      {
        afterLive: () => {
          this.persistRun(managed);
          this.releaseRunLease(managed);
        },
      },
    );
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   */
  async resume(runId: string, exec: ExecOptions = {}): Promise<boolean> {
    const { accepted } = await this.continueRunInternal(runId, exec, false);
    return accepted;
  }

  /**
   * Resume an interrupted run while exposing the resumed execution's settlement.
   * Rejected resumptions have no completion promise; accepted resumptions retain
   * the same background result contract as startInBackground.
   */
  async resumeInBackground(
    runId: string,
    exec: ExecOptions = {},
  ): Promise<
    | { accepted: false; promise?: undefined }
    | { accepted: true; promise: Promise<WorkflowRunResult> }
  > {
    const started = await this.continueRunInternal(runId, exec, false);
    return started.accepted
      ? { accepted: true, promise: started.promise }
      : { accepted: false };
  }

  /** Continue the exact persisted run under its lease without creating an execution child. */
  async continueRun(
    runId: string,
    exec: ExecOptions = {},
  ): Promise<WorkflowContinuationStart> {
    return this.continueRunInternal(runId, exec, true);
  }

  private async continueRunInternal(
    runId: string,
    exec: ExecOptions,
    requireCanonicalAdmission: boolean,
  ): Promise<WorkflowContinuationStart> {
    if (
      exec.resumeFromRunId !== undefined ||
      exec.resumePolicy !== undefined ||
      exec.resumeJournal !== undefined ||
      exec.resumeCalls !== undefined ||
      exec.cwd !== undefined ||
      exec.defaultModel !== undefined ||
      exec.agentConfigurations !== undefined ||
      exec.requireAgentConfiguration !== undefined ||
      exec.agentConfigurationSource !== undefined ||
      exec.scriptBackends !== undefined ||
      exec.executionMode !== undefined ||
      exec.journaling === false
    ) {
      throw this.scriptValidationError(
        "same-run continuation accepts only runtime controls; script, args, cwd, provider configuration, and replay inputs are immutable",
      );
    }
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.journaling === false) throw new Error("journaling disabled for this run");
    if (!this.resolveJournaling(exec)) throw new Error("journaling disabled for this run");
    if (active?.status === "running") {
      const durable = this.persistence.load(runId);
      const classified = durable
        ? classifyCheckpointReplies(durable, exec.checkpointReplies, false)
        : { resolutions: [] as WorkflowCheckpointResolution[] };
      return {
        accepted: false,
        reason: classified.mismatch ? "checkpoint-mismatch" : "running",
        ...(classified.resolutions.length === 0
          ? {}
          : { resolvedCheckpoints: classified.resolutions }),
      };
    }
    if (active?.status === "aborted") return { accepted: false, reason: "terminal" };

    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) {
      // A concurrent owner may already have durably committed this checkpoint reply. Read-only
      // classification makes retries/conflicts idempotent across processes without stealing the
      // run lease or inventing a second continuation.
      const durable = this.persistence.load(runId);
      const classified = durable
        ? classifyCheckpointReplies(durable, exec.checkpointReplies, false)
        : { resolutions: [] as WorkflowCheckpointResolution[] };
      const settledReply = !classified.mismatch && classified.resolutions.length > 0;
      return {
        accepted: false,
        reason: settledReply && durable?.status === "running"
          ? "running"
          : settledReply && (durable?.status === "completed" || durable?.status === "aborted")
            ? "terminal"
            : "owned-elsewhere",
        ...(classified.resolutions.length === 0
          ? {}
          : { resolvedCheckpoints: classified.resolutions }),
      };
    }
    let persisted: PersistedRunState | null;
    try {
      persisted = this.persistence.load(runId);
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      throw error;
    }
    if (!persisted) {
      this.persistence.releaseRunLease(lease);
      return { accepted: false, reason: "missing" };
    }
    const checkpointReplies = classifyCheckpointReplies(persisted, exec.checkpointReplies, true);
    if (checkpointReplies.mismatch) {
      this.persistence.releaseRunLease(lease);
      return {
        accepted: false,
        reason: "checkpoint-mismatch",
        ...(checkpointReplies.resolutions.length === 0
          ? {}
          : { resolvedCheckpoints: checkpointReplies.resolutions }),
      };
    }
    if (persisted.status === "completed" || persisted.status === "aborted") {
      this.persistence.releaseRunLease(lease);
      return {
        accepted: false,
        reason: "terminal",
        ...(checkpointReplies.resolutions.length === 0
          ? {}
          : { resolvedCheckpoints: checkpointReplies.resolutions }),
      };
    }
    if (!persisted.script || persisted.executionMode || persisted.argsUnreplayable) {
      this.persistence.releaseRunLease(lease);
      return { accepted: false, reason: "not-continuable" };
    }
    if (requireCanonicalAdmission) {
      const admissionProblem = validatePersistedAdmission(persisted);
      if (admissionProblem) {
        this.persistence.releaseRunLease(lease);
        return { accepted: false, reason: admissionProblem };
      }
    } else {
      // The lower-level SDK same-ID recovery API remains available independently of the MCP
      // continuation contract. Preserve its explicit legacy marker; MCP never enters this branch.
      persisted.legacyResume = true;
      try {
        if (this.persistence.validateRunLease?.(lease) === false) {
          throw new Error(`run ${runId} no longer owns its persistence lease`);
        }
        this.persistence.save(persisted);
      } catch (error) {
        this.persistence.releaseRunLease(lease);
        throw new WorkflowError(
          `failed to persist legacy resume marker for ${runId}: ${errorMessage(error)}`,
          WorkflowErrorCode.PERSISTENCE_ERROR,
          { recoverable: false },
        );
      }
    }
    const publication = this.prepareEventPublicationState(persisted, lease);
    const saveLegacyGate = () => {
      this.syncEventWatermark(publication, persisted);
      persisted.updatedAt = new Date().toISOString();
      this.savePersistedState(persisted, publication);
    };

    const checkpointContext =
      persisted.pauseReason === "checkpoint_required" ? persisted.checkpointContext : undefined;
    // Only a newly accepted answer for the pending checkpoint (or a live confirm callback) may move
    // the run past its durable pause. Idempotent repeats or ignored conflicts for already-journaled
    // checkpoints are reported but never substitute for the missing human decision.
    const hasCheckpointReply = checkpointReplies.accepted !== undefined;

    // Cold-resume re-arm (§2.13). An "auth_required" pause is resumable ONLY when the auth
    // survived: warm resume (same process, credentials still in the runner's AuthStore) or a
    // disk-backed intent (native store / env re-read by a fresh spawn). We consult the INJECTED
    // runner's auth controller by DUCK-TYPING — `runner.auth.canResume(backendId)` — never a
    // package import (the engine's AgentRunner seam knows nothing of auth). An in-process
    // (gateway) intent is gone after a cold process, so canResume is false and we
    // re-pause immediately with a re-supply message rather than re-running into the same wall.
    // A runner with no auth controller (default-off host) cannot confirm resumability -> re-pause.
    if (persisted.pauseReason === "auth_required") {
      const agent = exec.agent ?? this.agent;
      const authController = (
        agent as { auth?: { canResume?: (backendId: string) => boolean } } | undefined
      )?.auth;
      const backendId = persisted.authContext?.backendId ?? "";
      const canResume = typeof authController?.canResume === "function" && authController.canResume(backendId);
      if (!canResume) {
        if (!requireCanonicalAdmission) {
          const backendLabel = persisted.authContext?.backendId ?? "the backend";
          const reSupplyError = new WorkflowError(
            `re-supply credentials for ${backendLabel} via runner auth before resuming`,
            WorkflowErrorCode.AUTH_REQUIRED,
            { recoverable: false, authContext: persisted.authContext },
          );
          const gateEventSeq = publication.eventSeq;
          this.publishRunEvent(
            publication,
            this.createRunEvent("paused", {
              runId,
              scope: runId,
              reason: "auth_required",
              error: reSupplyError,
              errorRecord: projectRecordedError(reSupplyError),
              authContext: persisted.authContext,
            }),
            saveLegacyGate,
            {
              afterLive: () => {
                if (publication.eventSeq !== gateEventSeq) saveLegacyGate();
                this.persistence.releaseRunLease(lease);
                publication.lease = undefined;
              },
            },
          );
          const promise = Promise.reject<WorkflowRunResult>(reSupplyError);
          promise.catch(() => {});
          return {
            accepted: true,
            runId,
            continuation: persisted.continuation ?? deepFreeze({
              generation: 0,
              replayedPrefix: contiguousJournalPrefix(persisted.journal ?? [], runId),
            }),
            promise,
          };
        }
        this.persistence.releaseRunLease(lease);
        publication.lease = undefined;
        return {
          accepted: false,
          reason: "auth-required",
          ...(checkpointReplies.resolutions.length === 0
            ? {}
            : { resolvedCheckpoints: checkpointReplies.resolutions }),
        };
      }
    }

    // Durable checkpoint cold-resume gate. A keyed checkpointReplies value is the explicit
    // out-of-band answer channel; a real confirm callback is the live answer channel. With
    // neither, preserve the exact persisted pause without re-running any agent or script code.
    if (persisted.pauseReason === "checkpoint_required" && !hasCheckpointReply && !exec.confirm) {
      if (!requireCanonicalAdmission) {
        const checkpointError = new WorkflowError(
          `checkpoint "${checkpointContext?.prompt ?? "pending checkpoint"}" awaits a human decision`,
          WorkflowErrorCode.CHECKPOINT_REQUIRED,
          { recoverable: false, checkpointContext },
        );
        const gateEventSeq = publication.eventSeq;
        this.publishRunEvent(
          publication,
          this.createRunEvent("paused", {
            runId,
            scope: runId,
            reason: "checkpoint_required",
            error: checkpointError,
            errorRecord: projectRecordedError(checkpointError),
            checkpointContext,
          }),
          saveLegacyGate,
          {
            afterLive: () => {
              if (publication.eventSeq !== gateEventSeq) saveLegacyGate();
              this.persistence.releaseRunLease(lease);
              publication.lease = undefined;
            },
          },
        );
        const promise = Promise.reject<WorkflowRunResult>(checkpointError);
        promise.catch(() => {});
        return {
          accepted: true,
          runId,
          continuation: persisted.continuation ?? deepFreeze({
            generation: 0,
            replayedPrefix: contiguousJournalPrefix(persisted.journal ?? [], runId),
          }),
          promise,
        };
      }
      this.persistence.releaseRunLease(lease);
      publication.lease = undefined;
      return {
        accepted: false,
        reason: "checkpoint-required",
        ...(checkpointReplies.resolutions.length === 0
          ? {}
          : { resolvedCheckpoints: checkpointReplies.resolutions }),
      };
    }

    const controller = new AbortController();
    let meta: WorkflowMeta | undefined;
    try {
      meta = parseWorkflowScript(persisted.script).meta;
    } catch {
      // A previously-valid script that no longer parses still resumes by journal;
      // the snapshot name carries the run identity.
      meta = undefined;
    }
    const capturedArgs = snapshotArgs(persisted.args);
    const effectiveCwd = persisted.effectiveCwd ?? persisted.cwd ?? this.cwd;
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        ...(persisted.tokenUsage
          ? {
              tokenUsage: {
                input: persisted.tokenUsage.input,
                output: persisted.tokenUsage.output,
                total: persisted.tokenUsage.total,
                cost: persisted.tokenUsage.cost ?? 0,
                cacheRead: persisted.tokenUsage.cacheRead ?? 0,
                cacheWrite: persisted.tokenUsage.cacheWrite ?? 0,
              },
            }
          : {}),
      },
      controller,
      startedAt: new Date(persisted.startedAt),
      script: persisted.script,
      args: capturedArgs.ok ? capturedArgs.clone : persisted.args,
      argsSnapshotOk: capturedArgs.ok,
      ...(persisted.argsUnreplayable || !capturedArgs.ok ? { argsUnreplayable: true as const } : {}),
      cwd: persisted.cwd,
      meta,
      journal: latestRootRows(persisted.journal ?? [], runId),
      fallbacks: persisted.fallbacks ?? [],
      checkpointsTaken: [],
      calls: latestRootRows(persisted.calls ?? [], runId).map(stripLegacyCallBudgetFields),
      effectiveCwd,
      runtime: runtimeIdentity(),
      environment: persisted.environment,
      admission: persisted.admission,
      ...(persisted.legacyResume ? { legacyResume: true as const } : {}),
      ...(persisted.resume ? { resume: { format: "identity-v1" as const } } : {}),
      ...(persisted.resumeSourceRunId ? { resumeSourceRunId: persisted.resumeSourceRunId } : {}),
      resumeActivity: 0,
      resumeFilesystemTainted: false,
      resumeTerminalFinalized: false,
      executionSettled: false,
      environmentKey: this.environmentKey,
      callsAllocated: 0,
      limits: resolveWorkflowRunLimits({
        maxAgents: exec.maxAgents ?? persisted.limits?.maxAgents,
        concurrency: exec.concurrency ?? persisted.limits?.concurrency ?? this.concurrency,
        agentRetries: exec.agentRetries ?? persisted.limits?.agentRetries ?? this.defaultAgentRetries,
      }),
      mainModel: persisted.mainModel ?? this.mainModel,
      defaultModel: persisted.admission?.defaultModel ?? persisted.defaultModel,
      agentsDir: persisted.agentsDir ?? this.agentsDir,
      sameRunContinuation: true,
      journaling: true,
      background: true,
      lease,
      eventStreamId: publication.eventStreamId,
      eventSeq: publication.eventSeq,
      eventLogIncomplete: publication.eventLogIncomplete,
    };
    managed.preparedContinuation = this.buildPreparedContinuation(persisted);

    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e] as const));
    if (checkpointReplies.accepted) {
      const syntheticEntry = checkpointReplies.accepted;
      resumeJournal.set(syntheticEntry.index, syntheticEntry);
      // Cached entries are replayed without firing onAgentJournal, so seed and persist this
      // synthetic answer now. A crash or later cold replay must never re-ask this checkpoint.
      managed.journal = managed.journal.filter((entry) => entry.index !== syntheticEntry.index);
      managed.journal.push(syntheticEntry);
    }
    const continuation: WorkflowContinuationResult = deepFreeze({
      generation: (persisted.continuation?.generation ?? 0) + 1,
      replayedPrefix: contiguousJournalPrefix(managed.journal, runId),
      ...(checkpointReplies.resolutions.length === 0
        ? {}
        : { resolvedCheckpoints: checkpointReplies.resolutions }),
    });
    managed.continuation = continuation;
    try {
      this.persistRunOrThrow(managed);
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      managed.lease = undefined;
      throw error;
    }
    this.runs.set(runId, managed);
    this.publishRunEvent(
      managed,
      this.createRunEvent("resumed", { runId, scope: runId }),
      () => this.persistRun(managed),
    );
    // Run in the background; executeRun records status/errors on the managed run.
    // Preserve the original promise for callers while preventing an ignored resume
    // from becoming an unhandled rejection.
    const promise = this.executeRun(managed, persisted.script, {
      agent: exec.agent,
      maxAgents: managed.limits?.maxAgents,
      concurrency: managed.limits?.concurrency,
      agentRetries: managed.limits?.agentRetries,
      externalSignal: exec.externalSignal,
      signal: exec.signal,
      onProgress: exec.onProgress,
      confirm: exec.confirm,
      pauseOnCheckpoint: exec.pauseOnCheckpoint,
      onNestedWorkflow: exec.onNestedWorkflow,
      resumeJournal,
    }, checkpointReplies.accepted
      ? {
          resumeJournal,
          injectedCheckpointReplies: new Set([checkpointReplies.accepted.index]),
        }
      : { resumeJournal });
    promise.catch(() => {});
    return { accepted: true, runId, continuation, promise };
  }

  /**
   * Cancel exactly one in-flight agent call without aborting its owning run. The promise
   * resolves only after the failed call record and agentEnd state are durable.
   */
  async cancelAgentCall(runId: string, callIndex: number): Promise<WorkflowAgentCallCancellation> {
    if (!Number.isSafeInteger(callIndex) || callIndex < 0) {
      throw this.agentCancellationSelectionError(
        runId,
        callIndex,
        `Agent call index must be a non-negative safe integer; received ${String(callIndex)}.`,
      );
    }

    const managed = this.runs.get(runId);
    if (!managed) {
      throw this.agentCancellationSelectionError(
        runId,
        callIndex,
        `Workflow run "${runId}" is not live and owned by this manager.`,
      );
    }
    if (managed.status !== "running") {
      const state = managed.status === "completed" || managed.status === "failed" || managed.status === "aborted"
        ? `already terminal (${managed.status})`
        : managed.status;
      throw this.agentCancellationSelectionError(
        runId,
        callIndex,
        `Workflow run "${runId}" is ${state}; no agent call can be cancelled.`,
      );
    }

    const inFlight = this.currentAgentAttempts(runId);
    const matching = inFlight.filter((attempt) => attempt.callIndex === callIndex);
    if (matching.length === 0) {
      throw this.agentCancellationSelectionError(
        runId,
        callIndex,
        `Agent call ${callIndex} is not currently in flight in run "${runId}"; it may already be settled, not yet allocated, or a checkpoint.`,
        inFlight,
      );
    }
    if (matching.length > 1) {
      throw this.agentCancellationSelectionError(
        runId,
        callIndex,
        `Agent call index ${callIndex} is ambiguous in run "${runId}" because ${matching.length} in-flight calls share it.`,
        inFlight,
      );
    }

    const attempt = matching[0]!;
    if (!attempt.cancellation) {
      let resolve!: (result: WorkflowAgentCallCancellation) => void;
      let reject!: (error: WorkflowError) => void;
      const promise = new Promise<WorkflowAgentCallCancellation>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      attempt.cancellation = { promise, resolve, reject, settled: false };
      attempt.controller.abort(
        new WorkflowError(
          "agent call cancelled by host",
          WorkflowErrorCode.AGENT_CANCELLED,
          { recoverable: true },
        ),
      );
    }
    return attempt.cancellation.promise;
  }

  /** Number of process-local workflow executions that still own live execution state. */
  activeExecutionCount(): number {
    let total = 0;
    for (const run of this.runs.values()) {
      if (run.status === "running") total += 1;
    }
    return total;
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;

    let pausedSnapshot: PersistedRunState | undefined;
    if (managed.status === "paused" && !managed.lease) {
      const lease = this.persistence.acquireRunLease(runId);
      if (!lease) return false;
      managed.lease = lease;
      if (managed.journaling) {
        let current: PersistedRunState | null;
        try {
          current = this.persistence.load(runId);
        } catch (error) {
          this.reportPersistenceFailure(error);
          this.releaseRunLease(managed);
          return false;
        }
        if (current?.status !== "paused") {
          this.releaseRunLease(managed);
          return false;
        }
        pausedSnapshot = current;
        const publication = this.prepareEventPublicationState(current, lease);
        managed.eventStreamId = publication.eventStreamId;
        managed.eventSeq = publication.eventSeq;
        managed.eventLogIncomplete = publication.eventLogIncomplete;
      }
    }

    managed.controller.abort();
    this.liveAgentObservability.finishRun(managed);
    managed.status = "aborted";
    if (pausedSnapshot) {
      pausedSnapshot.status = "aborted";
      pausedSnapshot.reason = undefined;
      pausedSnapshot.errorCode = undefined;
      pausedSnapshot.pauseReason = undefined;
      pausedSnapshot.resetHint = undefined;
      pausedSnapshot.authContext = undefined;
      pausedSnapshot.checkpointContext = undefined;
      pausedSnapshot.abortSignaled = true;
    }
    const saveStopped = () => {
      if (!managed.lease) return;
      if (!pausedSnapshot) {
        this.persistRun(managed);
        return;
      }
      this.syncEventWatermark(managed, pausedSnapshot);
      pausedSnapshot.updatedAt = new Date().toISOString();
      this.savePersistedState(pausedSnapshot, managed);
    };
    this.publishRunEvent(
      managed,
      this.createRunEvent("stopped", { runId, scope: runId }),
      saveStopped,
      {
        afterLive: () => {
          saveStopped();
          this.releaseRunLease(managed);
        },
      },
    );
    return true;
  }

  /**
   * Stop a persisted run while holding its cross-process lease. This is the location-
   * independent counterpart to stop(): it never steals a live owner's lease and lets a
   * concurrently terminal snapshot win after the under-lease reload.
   */
  stopPersistedRun(runId: string): PersistedRunStopResult {
    const managed = this.runs.get(runId);
    if (managed) {
      const current = this.persistence.load(runId);
      if (current && (current.status === "completed" || current.status === "failed" || current.status === "aborted")) {
        return { outcome: "already-terminal", state: current };
      }
      if (managed.status === "running" || managed.status === "paused") {
        if (!this.stop(runId)) return { outcome: "owned-elsewhere", ...(current ? { state: current } : {}) };
        return { outcome: "stopped", state: this.persistence.load(runId) ?? undefined };
      }
      // The in-memory execution already settled but its final snapshot did not. Fall through
      // to the lease-safe cold path; stop() has released its lease and cannot repair it.
    }

    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return { outcome: "owned-elsewhere", state: this.persistence.load(runId) ?? undefined };
    try {
      const current = this.persistence.load(runId);
      if (!current) return { outcome: "missing" };
      if (current.status === "completed" || current.status === "failed" || current.status === "aborted") {
        return { outcome: "already-terminal", state: current };
      }

      const publication = this.prepareEventPublicationState(current, lease);
      let stoppedEventAlreadyDurable = false;
      if (
        publication.eventStreamId !== undefined &&
        publication.eventSeq !== undefined &&
        publication.eventSeq > 0
      ) {
        try {
          const tail = this.persistence.readEvents(runId, {
            streamId: publication.eventStreamId,
            after: publication.eventSeq - 1,
            limit: 1,
          });
          stoppedEventAlreadyDurable = tail.events.some(
            (record) => record.seq === publication.eventSeq && record.event.type === "stopped",
          );
        } catch {
          stoppedEventAlreadyDurable = false;
        }
      }
      current.status = "aborted";
      current.reason = undefined;
      current.errorCode = undefined;
      current.pauseReason = undefined;
      current.resetHint = undefined;
      current.authContext = undefined;
      current.checkpointContext = undefined;
      current.abortSignaled = true;

      const saveStopped = () => {
        this.syncEventWatermark(publication, current);
        current.updatedAt = new Date().toISOString();
        this.savePersistedState(current, publication);
      };
      if (stoppedEventAlreadyDurable) {
        saveStopped();
      } else {
        this.publishRunEvent(
          publication,
          this.createRunEvent("stopped", { runId, scope: runId }),
          saveStopped,
          { afterLive: saveStopped },
        );
      }
      return { outcome: "stopped", state: this.persistence.load(runId) ?? current };
    } finally {
      this.persistence.releaseRunLease(lease);
    }
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /** Return a safe, bounded, live-first point-in-time run projection. */
  inspectRun(runId: string, options?: WorkflowRunInspectionOptions): WorkflowRunStatus | undefined {
    const managed = this.runs.get(runId);
    if (managed) {
      return projectWorkflowRunStatus(
        {
          runId: managed.runId,
          status: managed.status,
          workflowName: managed.snapshot.name,
          phases: managed.snapshot.phases,
          currentPhase: managed.snapshot.currentPhase,
          reason: runReason(managed.status, managed.error),
          errorCode: managed.error?.code,
          logs: managed.snapshot.logs,
          journal: managed.journal,
          agents: managed.snapshot.agents,
          limits: managed.limits,
          replayEligibility: managed.replayEligibility,
        },
        options,
      );
    }

    const persisted = this.reconcileExternallyDeadRun(runId);
    if (!persisted) return undefined;
    return projectWorkflowRunStatus(
      {
        runId: persisted.runId,
        status: persisted.status,
        workflowName: persisted.workflowName,
        phases: persisted.phases ?? [],
        currentPhase: persisted.currentPhase,
        reason: persisted.reason ?? persisted.pauseReason,
        errorCode: persisted.errorCode,
        logs: persisted.logs ?? [],
        journal: persisted.journal ?? [],
        agents: persisted.agents ?? [],
        limits: persisted.limits,
        replayEligibility: persisted.replayEligibility,
      },
      options,
    );
  }

  /**
   * Cold-restart counterpart of WorkflowRunResult.agentSessions: the hand-off a host
   * feeds to runner.loadSession()/resumeSession(). Derived from persisted state, so it
   * works on a fresh manager instance with no in-memory run.
   */
  getPersistedAgentSessions(runId: string): AgentSessionRecord[] | undefined {
    const persisted = this.persistence.load(runId);
    if (!persisted) return undefined;

    const sessions = persisted.agents
      .map((agent) => agent.session)
      .filter((session): session is AgentSessionRecord => session != null);
    const callIndexes = new Set(sessions.map((session) => session.callIndex));
    for (const entry of persisted.journal ?? []) {
      if (entry.session && !callIndexes.has(entry.session.callIndex)) {
        sessions.push(entry.session);
        callIndexes.add(entry.session.callIndex);
      }
    }
    return sessions.sort((a, b) => a.callIndex - b.callIndex);
  }

  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.reconcileListedRuns(this.persistence.list());
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** Bounded active/recent dashboard projection from one authoritative project store. */
  listRecentRuns(limit = 12): PersistedRunState[] {
    const bounded = Math.max(1, Math.min(24, Math.floor(limit)));
    return this.listRuns()
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, bounded);
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.reconcileListedRuns(this.persistence.list());
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) this.liveAgentObservability.clearRun(managed);
    const lease = managed?.lease ?? this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    let deleted = false;
    try {
      deleted = this.persistence.delete(runId);
    } finally {
      this.persistence.releaseRunLease(lease);
      if (managed) managed.lease = undefined;
      this.runs.delete(runId);
    }
    if (deleted) this.emit("runDeleted", { runId });
    return deleted;
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunEventPersistence {
    return this.persistence;
  }
}

function createRunAdmission(
  exec: ExecOptions,
  recordedAt: string,
): PersistedRunAdmission | undefined {
  if (exec.requireAgentConfiguration !== true) return undefined;
  if (exec.agentConfigurations === undefined) {
    throw new WorkflowError(
      "strict host admission requires a canonical agentConfigurations map",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  const agentConfigurations = canonicalizeWorkflowAgentConfigurations(exec.agentConfigurations);
  let scriptBackends: Record<string, WorkflowBackendConfig> | undefined;
  if (exec.scriptBackends !== undefined) {
    const captured = cloneFrozenStrictJson(exec.scriptBackends);
    if (!captured.ok) {
      throw new WorkflowError(
        `scriptBackends are not strict JSON at ${captured.path}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    scriptBackends = captured.clone as unknown as Record<string, WorkflowBackendConfig>;
  }
  const selectionHash = hashWorkflowAdmissionSelection({
    format: 1,
    agentConfigurations,
    ...(exec.defaultModel === undefined ? {} : { defaultModel: exec.defaultModel }),
    ...(scriptBackends === undefined ? {} : { scriptBackends }),
  });
  return deepFreeze({
    format: 1 as const,
    strict: true as const,
    agentConfigurations,
    ...(exec.defaultModel === undefined ? {} : { defaultModel: exec.defaultModel }),
    ...(scriptBackends === undefined ? {} : { scriptBackends }),
    selectionHash,
    source: exec.agentConfigurationSource ?? "host",
    recordedAt,
  });
}

function readUncoveredOccurrence(
  details: unknown,
): { ordinal: number; label: string; phase?: string } | undefined {
  const candidate = details && typeof details === "object"
    ? (details as { uncoveredOccurrence?: unknown }).uncoveredOccurrence
    : undefined;
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as { ordinal?: unknown; label?: unknown; phase?: unknown };
  if (!Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0 || typeof value.label !== "string") {
    return undefined;
  }
  if (value.phase !== undefined && typeof value.phase !== "string") return undefined;
  return {
    ordinal: Number(value.ordinal),
    label: value.label,
    ...(value.phase === undefined ? {} : { phase: value.phase }),
  };
}

function validatePersistedAdmission(state: PersistedRunState): WorkflowContinuationRefusalReason | undefined {
  const admission = state.admission;
  if (!admission) return "admission-missing";
  if (typeof admission !== "object" || Array.isArray(admission)) return "admission-invalid";
  if (admission.uncoveredOccurrence) return "admission-uncovered";
  if (admission.format !== 1 || admission.strict !== true) return "admission-invalid";
  if (
    !/^[0-9a-f]{64}$/.test(admission.selectionHash) ||
    !["mcp-elicitation", "mcp-routing", "host"].includes(admission.source) ||
    typeof admission.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(admission.recordedAt)) ||
    (admission.defaultModel !== undefined &&
      (typeof admission.defaultModel !== "string" || admission.defaultModel.trim() === ""))
  ) return "admission-invalid";
  try {
    const canonical = canonicalizeWorkflowAgentConfigurations(admission.agentConfigurations);
    const selectionHash = hashWorkflowAdmissionSelection({
      format: 1,
      agentConfigurations: canonical,
      ...(admission.defaultModel === undefined ? {} : { defaultModel: admission.defaultModel }),
      ...(admission.scriptBackends === undefined ? {} : { scriptBackends: admission.scriptBackends }),
    });
    return selectionHash === admission.selectionHash ? undefined : "admission-invalid";
  } catch {
    return "admission-invalid";
  }
}

interface CheckpointReplyClassification {
  resolutions: WorkflowCheckpointResolution[];
  accepted?: JournalEntry;
  mismatch?: true;
}

function classifyCheckpointReplies(
  state: PersistedRunState,
  replies: Record<number, unknown> | undefined,
  allowPendingAnswer: boolean,
): CheckpointReplyClassification {
  if (replies === undefined) return { resolutions: [] };
  if (!replies || typeof replies !== "object" || Array.isArray(replies)) {
    throw new WorkflowError(
      "checkpointReplies must be an object keyed by non-negative checkpoint indexes",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  const journal = new Map<number, JournalEntry>();
  for (const entry of state.journal ?? []) {
    if ((entry.scope === undefined || entry.scope === state.runId) && entry.kind === "checkpoint") {
      journal.set(entry.index, entry);
    }
  }
  const resolutions: WorkflowCheckpointResolution[] = [];
  let accepted: JournalEntry | undefined;
  for (const [rawIndex, supplied] of Object.entries(replies)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(rawIndex) || !Number.isSafeInteger(Number(rawIndex))) {
      throw new WorkflowError(
        `checkpointReplies key ${JSON.stringify(rawIndex)} must be a non-negative safe integer`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const callIndex = Number(rawIndex);
    const captured = cloneFrozenStrictJson(supplied);
    if (!captured.ok) {
      throw new WorkflowError(
        `checkpoint reply ${callIndex} is not strict JSON at ${captured.path}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const durable = journal.get(callIndex);
    if (durable) {
      const same = canonicalStrictJson(durable.result) === canonicalStrictJson(captured.clone);
      resolutions.push(deepFreeze({
        callIndex,
        outcome: same ? "same" as const : "different" as const,
        decision: durable.result,
        ...(same ? {} : { ignored: captured.clone }),
      }));
      continue;
    }
    const pending = state.pauseReason === "checkpoint_required" ? state.checkpointContext : undefined;
    if (!allowPendingAnswer || !pending || pending.callIndex !== callIndex || accepted) {
      return {
        resolutions: resolutions.filter((entry) => entry.outcome !== "accepted"),
        mismatch: true,
      };
    }
    accepted = deepFreeze({
      index: pending.callIndex,
      hash: pending.hash,
      result: captured.clone,
      kind: "checkpoint" as const,
      scope: state.runId,
      call: { kind: "checkpoint" as const, label: "checkpoint" as const, phase: state.currentPhase },
    });
    resolutions.push(deepFreeze({
      callIndex,
      outcome: "accepted" as const,
      decision: captured.clone,
    }));
  }
  return { resolutions, ...(accepted ? { accepted } : {}) };
}

function contiguousJournalPrefix(entries: readonly JournalEntry[], runId: string): number {
  const indexes = new Set(
    entries
      .filter((entry) => entry.scope === undefined || entry.scope === runId)
      .map((entry) => entry.index),
  );
  let index = 0;
  while (indexes.has(index)) index++;
  return index;
}
