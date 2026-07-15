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

import { EventEmitter } from "node:events";
import type {
  AgentRunner,
  AgentSessionRecord,
  JournalEntry,
  TokenUsage,
  WorkflowBackendConfig,
  WorkflowCallRecord,
  WorkflowCheckpointTaken,
  WorkflowMeta,
  WorkflowRunFallback,
  WorkflowRunInspectionOptions,
  WorkflowRunResult,
  WorkflowRunStatus,
} from "@automatalabs/shared-types";
import { preview, recomputeWorkflowSnapshot, type WorkflowSnapshot } from "./display.js";
import { errorMessage, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { captureRunEnvironment, type RunEnvironmentIdentity } from "./run-environment.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import { workflowHomeDir } from "./workflow-paths.js";
import { cloneFrozenStrictJson, cloneStrictJsonValue, deepFreeze } from "./strict-json.js";
import {
  CALL_INPUTS_FORMAT,
  CALL_PATH_FORMAT,
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
  runtime: { node: string; v8: string; pathFormat: number; inputsFormat: number };
  environment?: RunEnvironmentIdentity;
  callsAllocated?: number;
  limits?: NonNullable<WorkflowRunResult["effectiveLimits"]>;
  abortSignaled?: true;
  mainModel?: string;
  agentsDir?: string;
  nestedWorkflows?: true;
  legacyResume?: true;
  executionMode?: PersistedRunState["executionMode"];
  /**
   * False for host-owned transcript storage. The run stays fully tracked in memory,
   * but the engine writes no run-state/log journal files and resume is forbidden.
   */
  journaling: boolean;
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
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
  /** Durable-checkpoint answer channel: pending checkpoint call index to the host's decision. */
  checkpointReplies?: Record<number, unknown>;
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

function runReason(status: RunStatus, error: WorkflowError | undefined): string | undefined {
  if (status === "completed" || status === "pending" || status === "running") return undefined;
  if (status !== "paused") return error?.message;
  if (error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT) return "usage_limit";
  if (error?.code === WorkflowErrorCode.AUTH_REQUIRED) return "auth_required";
  if (error?.code === WorkflowErrorCode.CHECKPOINT_REQUIRED) return "checkpoint_required";
  return error?.message;
}

/**
 * Stateful workflow run manager. Events are OBSERVABILITY ONLY: listeners are
 * best-effort observers, isolated from sibling listeners and from run execution. A
 * throwing host observer never fails, pauses, aborts, or masks cleanup for the run.
 */
export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: RunPersistence;
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
    this.persistence = options.persistence ?? createRunPersistence(this.cwd, undefined, { persistenceRoot: this.persistenceRoot });
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
            this.persistence.save({ ...p, status: "paused" });
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

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const journaling = this.resolveJournaling(exec);
    const identity = this.acquireNewRunIdentity(exec.runId);
    let managed: ManagedRun;
    try {
      managed = this.createManaged(script, args, journaling, exec, true, identity);
      if (managed.journaling && exec.resumeJournal) {
        managed.journal = latestRows([...exec.resumeJournal.values()]);
      }
      this.runs.set(managed.runId, managed);
      this.persistRun(managed);
    } catch (err) {
      this.persistence.releaseRunLease(identity.lease);
      this.runs.delete(identity.runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, exec);
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
    const identity = this.acquireNewRunIdentity(exec.runId);
    let managed: ManagedRun;
    try {
      managed = this.createManaged(script, args, this.resolveJournaling(exec), exec, false, identity);
    } catch (error) {
      this.persistence.releaseRunLease(identity.lease);
      throw error;
    }
    if (managed.journaling && exec.resumeJournal) {
      // runSync is also the MCP shell's explicit-resume path. Replayed entries do not fire
      // onAgentJournal, so carry the hydrated prefix into this new managed run up front; any
      // synthetic checkpoint reply in the map must survive another cold resume from this run.
      managed.journal = latestRows([...exec.resumeJournal.values()]);
    }
    if (managed.journaling && exec.resumeCalls) {
      managed.calls = latestRows(exec.resumeCalls);
    }
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    try {
      return await this.executeRun(managed, script, exec);
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
      mainModel: this.mainModel,
      agentsDir: this.agentsDir,
      executionMode: exec.executionMode,
      journaling,
      background,
      lease: identity.lease,
    };
  }

  private resolveJournaling(exec: ExecOptions): boolean {
    return exec.journaling ?? this.journaling;
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
      effectiveLimits: engineResult?.effectiveLimits ?? managed.limits,
      ...(engineResult?.abortSignaled || managed.abortSignaled ? { abortSignaled: true as const } : {}),
      ...(engineResult?.nestedWorkflows || managed.nestedWorkflows ? { nestedWorkflows: true as const } : {}),
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const {
      resumeJournal,
      maxAgents,
      agentTimeoutMs,
      externalSignal,
      signal,
      onProgress,
      tokenBudget,
      concurrency,
      agentRetries,
      confirm,
      onNestedWorkflow,
      scriptBackends,
    } = exec;
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
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    const hostSignal = externalSignal ?? signal;
    if (hostSignal) {
      if (hostSignal.aborted) managed.controller.abort();
      else hostSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
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
        resumeFromRunId: managed.journaling && resumeJournal ? managed.runId : undefined,
        runId: managed.runId,
        onAgentJournal: (entry) => this.recordJournalEntry(managed, entry),
        injectedCheckpointReplies: new Set(
          Object.keys(exec.checkpointReplies ?? {}).map((index) => Number(index)),
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
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
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
          this.emit("agentStart", { runId: managed.runId, ...event });
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
            agentSnapshot.status = event.errorRecord ? "error" : "done";
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
          this.emit("agentEnd", { runId: managed.runId, ...event });
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
          this.emit("agentHistory", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          managed.snapshot.tokenUsage = usage;
          this.emit("tokenUsage", { runId: managed.runId, usage });
          progress();
        },
      });

      managed.calls = engineResult.calls ?? [];
      managed.callsAllocated = engineResult.callsAllocated;
      managed.limits = engineResult.effectiveLimits;
      if (engineResult.abortSignaled) managed.abortSignaled = true;
      if (engineResult.nestedWorkflows) managed.nestedWorkflows = true;
      managed.status = "completed";
      const result = this.composeResult(managed, undefined, engineResult);
      managed.result = result;
      this.emit("complete", { runId: managed.runId, result });

      // Persist final state
      this.persistRun(managed);
      this.releaseRunLease(managed);

      return result;
    } catch (error) {
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

      // Persist final state + release the lease BEFORE emitting, so a consumer that did not
      // subscribe to 'error' (EventEmitter throws ERR_UNHANDLED_ERROR on an unheard 'error')
      // can never skip cleanup and leak the run lease / lose the persisted "failed" state.
      this.persistRun(managed);
      this.releaseRunLease(managed);

      if (paused) {
        // The emit is untyped (WorkflowManager extends EventEmitter with an untyped override
        // emit); the payload is a bare literal. `reason` is a free-form string, so it just takes
        // "auth_required"/"usage_limit"/"checkpoint_required". resetHint is usage-limit-only;
        // each structured context is present only for its corresponding pause reason.
        this.emit("paused", {
          runId: managed.runId,
          reason: authPaused ? "auth_required" : checkpointPaused ? "checkpoint_required" : "usage_limit",
          error: workflowError,
          resetHint: usageLimitPaused ? workflowError.resetHint : undefined,
          authContext: authPaused ? workflowError.authContext : undefined,
          checkpointContext: checkpointPaused ? workflowError.checkpointContext : undefined,
        });
      } else if (this.listenerCount("error") > 0) {
        // Only emit 'error' when someone is listening: an unheard 'error' would throw
        // ERR_UNHANDLED_ERROR here, masking the real workflowError thrown below (which
        // pollutes the failed run's reason) — guard so the real error always propagates.
        this.emit("error", { runId: managed.runId, error: workflowError });
      }

      throw workflowError;
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private recordJournalEntry(managed: ManagedRun, entry: JournalEntry): void {
    if (this.dropPostTerminal(managed, "journal")) return;
    const rootScope = entry.scope === undefined || entry.scope === managed.runId;
    if (rootScope) {
      managed.journal = managed.journal.filter((e) => e.index !== entry.index);
      managed.journal.push(entry);
      if (managed.journaling) this.persistRun(managed);
    }
    if (this.listenerCount("journal") > 0) this.emit("journal", { runId: managed.runId, entry });
  }

  private recordCallRecord(managed: ManagedRun, record: WorkflowCallRecord): void {
    if (this.dropPostTerminal(managed, "callRecord")) return;
    const rootScope = record.scope === undefined || record.scope === managed.runId;
    if (rootScope) {
      managed.calls = managed.calls.filter((row) => row.index !== record.index);
      managed.calls.push(record);
      if (managed.journaling) this.persistRun(managed);
    }
    if (this.listenerCount("callRecord") > 0) {
      this.emit("callRecord", { runId: managed.runId, record });
    }
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

  private persistRun(managed: ManagedRun) {
    if (!managed.journaling) return;
    try {
      this.persistence.save({
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
        mainModel: managed.mainModel,
        agentsDir: managed.agentsDir,
        executionMode: managed.executionMode,
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
      });
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
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
    this.emit("paused", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
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
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.journaling === false) throw new Error("journaling disabled for this run");
    if (!this.resolveJournaling(exec)) throw new Error("journaling disabled for this run");
    if (active?.status === "running") return { accepted: false };
    if (active?.status === "aborted") return { accepted: false };

    const persisted = this.persistence.load(runId);
    if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted") {
      return { accepted: false };
    }
    if (persisted.executionMode) return { accepted: false };
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return { accepted: false };

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
        // The on-disk state is already a valid "auth_required" pause (journal + authContext
        // intact), so we do NOT re-persist — that would risk clobbering the journal. We surface
        // the re-supply cause on the "paused" event and release the lease we just took.
        this.emit("paused", {
          runId,
          reason: "auth_required",
          error: reSupplyError,
          resetHint: undefined,
          authContext: persisted.authContext,
        });
        this.persistence.releaseRunLease(lease);
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
      this.emit("paused", {
        runId,
        reason: "checkpoint_required",
        error: checkpointError,
        resetHint: undefined,
        authContext: undefined,
        checkpointContext,
      });
      this.persistence.releaseRunLease(lease);
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
      mainModel: persisted.mainModel ?? this.mainModel,
      agentsDir: persisted.agentsDir ?? this.agentsDir,
      ...(persisted.calls === undefined || persisted.legacyResume ? { legacyResume: true as const } : {}),
      journaling: true,
      background: true,
      lease,
    };
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
    this.emit("resumed", { runId });
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

    managed.controller.abort();
    managed.status = "aborted";
    this.emit("stopped", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
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
    if (managed) this.releaseRunLease(managed);
    this.runs.delete(runId);
    return this.persistence.delete(runId);
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
