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
  WorkflowMeta,
  WorkflowRunFallback,
  WorkflowRunInspectionOptions,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowResumeCallDecision,
  WorkflowResumeReport,
} from "@automatalabs/shared-types";
import { preview, recomputeWorkflowSnapshot, type WorkflowSnapshot } from "./display.js";
import { errorMessage, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { captureRunEnvironment, type RunEnvironmentIdentity } from "./run-environment.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedResumeSeed,
  type PersistedResumeFormat,
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
import { cloneFrozenStrictJson, cloneStrictJsonValue, deepFreeze } from "./strict-json.js";
import {
  CALL_INPUTS_FORMAT,
  CALL_PATH_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  type CheckpointCallContext,
  type CheckpointOptions,
  type EngineRunResult,
  parseWorkflowScript,
  runWorkflow,
} from "./workflow.js";
import { createWorkflowLogTail, projectWorkflowRunStatus } from "./run-observability.js";

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
    node: string;
    v8: string;
    pathFormat: number;
    inputsFormat: number;
    checkpointInputsFormat?: number;
  };
  environment?: RunEnvironmentIdentity;
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
  beforeLive?: () => void;
  afterLive?: () => void;
}

interface ManagerResumeExecution {
  preparedResume: PreparedResume;
  resumeJournal?: Map<number, JournalEntry>;
  injectedCheckpointReplies?: ReadonlySet<number>;
}

interface InitializedRun {
  managed: ManagedRun;
  resumeExecution?: ManagerResumeExecution;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Caller-minted run id. Collision checks happen under the run lease. */
  runId?: string;
  /** Marks this run as an isolation execution from its initial save onward. */
  executionMode?: PersistedRunState["executionMode"];
  /** Non-git environment identity for replay comparability. */
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
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Alias for externalSignal — the engine-owned cancellation the MCP shell threads in. */
  signal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /** Isolation-only recorded budget trajectory. */
  budgetReplay?: { trajectory: Array<{ ordinal: number; debit: number }> };
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (
    promptText: string,
    options: CheckpointOptions,
    context?: CheckpointCallContext,
  ) => Promise<unknown>;
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
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
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
  /** Default non-git environment identity. */
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
    node: process.version,
    v8: process.versions.v8,
    pathFormat: CALL_PATH_FORMAT,
    inputsFormat: CALL_INPUTS_FORMAT,
    checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
  };
}

function latestRootRows<T extends { index: number; scope?: string }>(rows: T[], runId: string): T[] {
  const latest = new Map<number, T>();
  for (const row of rows) {
    if (row.scope === undefined || row.scope === runId) latest.set(row.index, row);
  }
  return [...latest.values()].sort((a, b) => a.index - b.index);
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

function generateEventStreamId(): string {
  return randomBytes(16).toString("hex");
}

function isPersistableRunEvent(event: EngineRunEvent): event is PersistableEngineRunEvent {
  return event.type !== "agentHistory";
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
  private persistence: RunEventPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: AgentRunner;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The current session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultAgentRetries: number;
  private agentsDir?: string;
  private persistenceRoot: string;
  private journaling: boolean;
  private environmentKey?: string;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.agentsDir = options.agentsDir;
    this.persistenceRoot = workflowHomeDir({ persistenceRoot: options.persistenceRoot });
    this.journaling = options.journaling ?? true;
    this.environmentKey = options.environmentKey;
    this.persistence = options.persistence
      ? withRunEvents(options.persistence)
      : createRunPersistence(this.cwd, undefined, { persistenceRoot: this.persistenceRoot });
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

  /** Bind the manager to the current session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            const current = this.persistence.load(p.runId);
            if (current?.status === "running") {
              this.persistence.save({ ...current, status: "paused" });
            }
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
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
        }
      : admission.strategy === "positional-v1"
        ? {
            strategy: admission.strategy,
            sourceRunId: admission.sourceRunId,
            requestedPolicy: admission.requestedPolicy,
            fallbackReason: admission.fallbackReason,
            eligibility: admission.eligibility,
          }
        : {
            strategy: admission.strategy,
            sourceRunId: admission.sourceRunId,
            requestedPolicy: admission.requestedPolicy,
            disabledReason: admission.disabledReason,
          };
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
          node: managed.runtime.node,
          v8: managed.runtime.v8,
          pathFormat: managed.runtime.pathFormat,
          inputsFormat: managed.runtime.inputsFormat,
          checkpointInputsFormat: managed.runtime.checkpointInputsFormat as number,
        },
        environment: managed.environment,
      },
      checkpointReplies: exec.checkpointReplies as Record<string, unknown> | undefined,
    });
    managed.newRunResume = true;
    if (source.resume === undefined || source.legacyResume === true) managed.legacyResume = true;
    managed.resumeReportPlan = this.reportPlan(admission);
    managed.resumeDecisions = new Map();
    managed.resumeReport = buildResumeReport(managed.resumeReportPlan, []);
    managed.preparedContinuation = this.buildPreparedContinuation(source);

    if (admission.strategy === "identity-v1") {
      managed.resumeSeed = admission.seed;
      return {
        preparedResume: {
          strategy: admission.strategy,
          sourceRunId: admission.sourceRunId,
          requestedPolicy: admission.requestedPolicy,
          seed: admission.seed,
          commitSeed: (remaining) => this.commitResumeSeed(managed, remaining),
        },
      };
    }

    if (admission.strategy === "live") {
      return {
        preparedResume: {
          strategy: admission.strategy,
          sourceRunId: admission.sourceRunId,
          requestedPolicy: admission.requestedPolicy,
          disabledReason: admission.disabledReason,
        },
      };
    }

    const sourceJournalRows = this.cloneResumeSourceValue(source.journal ?? [], source.runId);
    const sourceJournal = new Map(
      latestRootRows(sourceJournalRows, source.runId).map((entry) => [entry.index, entry] as const),
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
    managed.calls = latestRootRows(
      this.cloneResumeSourceValue(source.calls ?? [], source.runId),
      source.runId,
    );
    if (admission.checkpointSeed) managed.resumeSeed = admission.checkpointSeed;
    const sourceCalls = admission.eligibility === "legacy"
      ? new Map<number, WorkflowCallRecord>()
      : new Map(managed.calls.map((call) => [call.index, call] as const));
    return {
      preparedResume: {
        strategy: admission.strategy,
        sourceRunId: admission.sourceRunId,
        requestedPolicy: admission.requestedPolicy,
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
      if (source || (managed.journaling && exec.resumeJournal)) this.persistRunOrThrow(managed);
      else this.persistRun(managed);
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
      startedAt: new Date(),
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
      ...(journaling ? { resume: { format: "identity-v1" as const } } : {}),
      resumeActivity: 0,
      resumeFilesystemTainted: false,
      resumeTerminalFinalized: false,
      executionSettled: false,
      environmentKey: exec.environmentKey ?? this.environmentKey,
      callsAllocated: 0,
      mainModel: this.mainModel,
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
    if (!publication.lease) return false;
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

  private publishRunEvent(
    state: EventPublicationState,
    event: EngineRunEvent,
    saveIncompleteMarker: () => void,
    actions: RunEventPublicationActions = {},
  ): boolean {
    if (
      isPersistableRunEvent(event) &&
      state.journaling &&
      state.lease &&
      !state.eventLogIncomplete
    ) {
      try {
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
      } catch (error) {
        state.eventLogIncomplete = true;
        this.reportPersistenceFailure(error);
        saveIncompleteMarker();
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
      agentTimeoutMs,
      externalSignal,
      signal,
      onProgress,
      tokenBudget,
      budgetReplay,
      concurrency,
      agentRetries,
      confirm,
      onNestedWorkflow,
      scriptBackends,
    } = exec;
    const resumeJournal = resumeExecution?.resumeJournal ?? exec.resumeJournal;
    const preparedResume = resumeExecution?.preparedResume;
    const preparedContinuation = managed.preparedContinuation;
    const resolvedAgentTimeoutMs = agentTimeoutMs !== undefined ? agentTimeoutMs : this.defaultAgentTimeoutMs;
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
        agentsDir: managed.agentsDir,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        tokenBudget,
        budgetReplay,
        confirm,
        onNestedWorkflow: (ordinal, childRunId) => {
          managed.nestedWorkflows = true;
          onNestedWorkflow?.(ordinal, childRunId);
        },
        scriptBackends,
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
          publish(this.createRunEvent("agentStart", {
            runId: managed.runId,
            ...event,
            scope: event.scope ?? managed.runId,
          }));
          progress();
        },
        onAgentEnd: (event) => {
          if (this.dropPostTerminal(managed, "agentEnd")) return;
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
      managed.resumeReport = engineResult.resumeReport;
      managed.limits = engineResult.effectiveLimits;
      if (engineResult.abortSignaled) managed.abortSignaled = true;
      if (engineResult.nestedWorkflows) managed.nestedWorkflows = true;
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
      // The engine wraps every fault that crosses the script boundary as a WorkflowError
      // (script crashes are SCRIPT_ERROR), so a bare error HERE is manager/host-level
      // (persistence, fs). Label it UNKNOWN — never WORKFLOW_ABORTED, which is reserved
      // for actual cancellation.
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(errorMessage(error), WorkflowErrorCode.UNKNOWN, { recoverable: false });

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
    this.persistRun(managed);
  }

  private recordJournalEntry(managed: ManagedRun, entry: JournalEntry): void {
    if (this.dropPostTerminal(managed, "journal")) return;
    const rootScope = entry.scope === undefined || entry.scope === managed.runId;
    if (rootScope) {
      managed.journal = managed.journal.filter((e) => e.index !== entry.index);
      managed.journal.push(entry);
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
      mainModel: managed.mainModel,
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
    if (!managed.journaling || !managed.lease) return;
    try {
      this.persistence.save(this.persistedState(managed));
    } catch (err) {
      this.reportPersistenceFailure(err);
    }
  }

  private persistRunOrThrow(managed: ManagedRun): void {
    if (!managed.journaling || !managed.lease) {
      throw new WorkflowError(
        `run ${managed.runId} has no persistence lease`,
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
    const { accepted } = await this.resumeInBackground(runId, exec);
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
    if (exec.resumeFromRunId !== undefined || exec.resumePolicy !== undefined) {
      throw this.scriptValidationError(
        "same-run resume does not accept resumeFromRunId or resumePolicy",
      );
    }
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.journaling === false) throw new Error("journaling disabled for this run");
    if (!this.resolveJournaling(exec)) throw new Error("journaling disabled for this run");
    if (active?.status === "running") return { accepted: false };
    if (active?.status === "aborted") return { accepted: false };

    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return { accepted: false };
    let persisted: PersistedRunState | null;
    try {
      persisted = this.persistence.load(runId);
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      throw error;
    }
    if (
      !persisted?.script ||
      persisted.status === "completed" ||
      persisted.status === "aborted" ||
      persisted.executionMode
    ) {
      this.persistence.releaseRunLease(lease);
      return { accepted: false };
    }
    persisted.legacyResume = true;
    try {
      this.persistence.save(persisted);
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      throw new WorkflowError(
        `failed to persist legacy resume marker for ${runId}: ${errorMessage(error)}`,
        WorkflowErrorCode.PERSISTENCE_ERROR,
        { recoverable: false },
      );
    }
    const publication = this.prepareEventPublicationState(persisted, lease);
    const saveResumeGate = () => {
      this.syncEventWatermark(publication, persisted);
      persisted.updatedAt = new Date().toISOString();
      this.savePersistedState(persisted, publication);
    };

    const checkpointContext =
      persisted.pauseReason === "checkpoint_required" ? persisted.checkpointContext : undefined;
    const hasCheckpointReply =
      checkpointContext !== undefined &&
      exec.checkpointReplies !== undefined &&
      Object.prototype.hasOwnProperty.call(exec.checkpointReplies, checkpointContext.callIndex);
    let checkpointReplySnapshot: unknown;
    if (hasCheckpointReply) {
      const captured = cloneFrozenStrictJson(exec.checkpointReplies?.[checkpointContext?.callIndex ?? -1]);
      if (!captured.ok) {
        this.persistence.releaseRunLease(lease);
        throw new WorkflowError(
          `checkpoint "${checkpointContext?.prompt ?? "pending checkpoint"}" reply is not strict JSON at ${captured.path}`,
          WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          { recoverable: false },
        );
      }
      checkpointReplySnapshot = captured.clone;
    }

    // Cold-resume re-arm (§2.13). An "auth_required" pause is resumable ONLY when the auth
    // survived: warm resume (same process, credentials still in the runner's AuthStore) or a
    // disk-backed intent (native store / env re-read by a fresh spawn). We consult the INJECTED
    // runner's auth controller by DUCK-TYPING — `runner.auth.canResume(backendId)` — never a
    // package import (the engine's AgentRunner seam knows nothing of auth). An in-process
    // (gateway) / spawn-env intent is gone after a cold process, so canResume is false and we
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
          saveResumeGate,
          {
            afterLive: () => {
              if (publication.eventSeq !== gateEventSeq) saveResumeGate();
              this.persistence.releaseRunLease(lease);
              publication.lease = undefined;
            },
          },
        );
        // A normal background execution that reaches a paused terminal state rejects
        // with its WorkflowError. Match that settlement for this synchronous re-pause
        // while handling the rejection internally just like startInBackground.
        const promise = Promise.reject<WorkflowRunResult>(reSupplyError);
        promise.catch(() => {});
        return { accepted: true, promise };
      }
    }

    // Durable checkpoint cold-resume gate. A keyed checkpointReplies value is the explicit
    // out-of-band answer channel; a real confirm callback is the live answer channel. With
    // neither, preserve the exact persisted pause without re-running any agent or script code.
    if (persisted.pauseReason === "checkpoint_required" && !hasCheckpointReply && !exec.confirm) {
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
        saveResumeGate,
        {
          afterLive: () => {
            if (publication.eventSeq !== gateEventSeq) saveResumeGate();
            this.persistence.releaseRunLease(lease);
            publication.lease = undefined;
          },
        },
      );
      const promise = Promise.reject<WorkflowRunResult>(checkpointError);
      promise.catch(() => {});
      return { accepted: true, promise };
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
    const effectiveCwd = exec.cwd ?? persisted.cwd ?? persisted.effectiveCwd ?? this.cwd;
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
      },
      controller,
      startedAt: new Date(),
      script: persisted.script,
      args: capturedArgs.ok ? capturedArgs.clone : persisted.args,
      argsSnapshotOk: capturedArgs.ok,
      ...(persisted.argsUnreplayable || !capturedArgs.ok ? { argsUnreplayable: true as const } : {}),
      // Explicit override wins; else the run resumes in ITS original directory
      // (e.g. the same worktree), never silently in the manager cwd.
      cwd: exec.cwd ?? persisted.cwd,
      meta,
      journal: latestRootRows(persisted.journal ?? [], runId),
      fallbacks: [],
      checkpointsTaken: [],
      calls: latestRootRows(persisted.calls ?? [], runId),
      effectiveCwd,
      runtime: runtimeIdentity(),
      environment: captureRunEnvironment(effectiveCwd, exec.environmentKey ?? this.environmentKey),
      ...(persisted.resume ? { resume: { format: "identity-v1" as const } } : {}),
      ...(persisted.resumeSourceRunId ? { resumeSourceRunId: persisted.resumeSourceRunId } : {}),
      resumeActivity: 0,
      resumeFilesystemTainted: false,
      resumeTerminalFinalized: false,
      executionSettled: false,
      environmentKey: exec.environmentKey ?? this.environmentKey,
      callsAllocated: 0,
      mainModel: persisted.mainModel ?? this.mainModel,
      agentsDir: persisted.agentsDir ?? this.agentsDir,
      legacyResume: true,
      journaling: true,
      background: true,
      lease,
      eventStreamId: publication.eventStreamId,
      eventSeq: publication.eventSeq,
      eventLogIncomplete: publication.eventLogIncomplete,
    };
    managed.preparedContinuation = this.buildPreparedContinuation(persisted);
    this.runs.set(runId, managed);

    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e] as const));
    if (checkpointContext && hasCheckpointReply) {
      const syntheticEntry: JournalEntry = deepFreeze({
        index: checkpointContext.callIndex,
        hash: checkpointContext.hash,
        result: checkpointReplySnapshot,
        kind: "checkpoint",
        scope: managed.runId,
        call: { kind: "checkpoint", label: "checkpoint", phase: persisted.currentPhase },
      });
      resumeJournal.set(syntheticEntry.index, syntheticEntry);
      // Cached entries are replayed without firing onAgentJournal, so seed and persist this
      // synthetic answer now. A crash or later cold replay must never re-ask this checkpoint.
      managed.journal = managed.journal.filter((entry) => entry.index !== syntheticEntry.index);
      managed.journal.push(syntheticEntry);
      this.persistRun(managed);
    }
    this.publishRunEvent(
      managed,
      this.createRunEvent("resumed", { runId, scope: runId }),
      () => this.persistRun(managed),
    );
    // Run in the background; executeRun records status/errors on the managed run.
    // Preserve the original promise for callers while preventing an ignored resume
    // from becoming an unhandled rejection.
    const promise = this.executeRun(managed, persisted.script, { ...exec, resumeJournal });
    promise.catch(() => {});
    return { accepted: true, promise };
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
        },
        options,
      );
    }

    const persisted = this.persistence.load(runId);
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
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
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
