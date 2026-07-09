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
  JournalEntry,
  TokenUsage,
  WorkflowBackendConfig,
  WorkflowMeta,
  WorkflowRunResult,
} from "@automatalabs/shared-types";
import { preview, recomputeWorkflowSnapshot, type WorkflowSnapshot } from "./display.js";
import { errorMessage, WorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import { workflowHomeDir } from "./workflow-paths.js";
import { type EngineRunResult, parseWorkflowScript, runWorkflow } from "./workflow.js";

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
  /** THIS run's working directory (ExecOptions.cwd), when it overrides the manager cwd.
   *  Persisted so resume() re-runs in the same directory (e.g. the same worktree). */
  cwd?: string;
  /** Parsed meta, kept so a terminal (paused/failed) result can still report it. */
  meta?: WorkflowMeta;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
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
  /**
   * Whether THIS run writes/reads the engine persistence journal. Default is the
   * manager setting. When false, no run-state/log files are written and resume
   * rejects with "journaling disabled for this run".
   */
  journaling?: boolean;
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
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
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

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const runId = generateRunId();
    const controller = new AbortController();
    const parsed = parseWorkflowScript(script);
    const journaling = this.resolveJournaling(exec);
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
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
      controller,
      startedAt: new Date(),
      script,
      args,
      meta: parsed.meta,
      cwd: exec.cwd,
      journal: [],
      journaling,
      background: true,
      lease: lease ?? undefined,
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state
      if (managed.journaling) {
        this.persistence.save({
          runId,
          workflowName: parsed.meta.name,
          script,
          args,
          cwd: exec.cwd,
          sessionId: this.sessionId,
          status: "running",
          phases: managed.snapshot.phases,
          agents: [],
          logs: [],
          startedAt: managed.startedAt.toISOString(),
          updatedAt: managed.startedAt.toISOString(),
        });
      }
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
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
    const managed = this.createManaged(script, args, this.resolveJournaling(exec), exec.cwd);
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    try {
      return await this.executeRun(managed, script, args, exec);
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
    cwd?: string,
  ): ManagedRun {
    const parsed = parseWorkflowScript(script);
    return {
      runId: generateRunId(),
      cwd,
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
      args,
      meta: parsed.meta,
      journal: [],
      journaling,
      background: false,
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
    const reason =
      managed.status === "completed"
        ? undefined
        : managed.status === "paused"
          ? usageLimit
            ? "usage_limit"
            : authRequired
              ? "auth_required"
              : error?.message
          : error?.message;
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
      reason,
      resetHint: usageLimit ? error?.resetHint : undefined,
      // Structured, NON-SECRET auth surface for an auth pause (§2.12) — hosts read this,
      // never the reason message. Absent on every other outcome.
      authContext: authRequired ? error?.authContext : undefined,
      // Fall back to the snapshot's per-agent records when the engine returned no result
      // (pause/failure mid-run) so re-attach handles survive an interrupted run.
      agentSessions:
        engineResult?.agentSessions ??
        managed.snapshot.agents.map((a) => a.session).filter((s): s is NonNullable<typeof s> => s != null),
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
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
      const engineResult = await runWorkflow(script, {
        cwd: managed.cwd ?? this.cwd,
        args,
        agent,
        mainModel: this.mainModel,
        agentsDir: this.agentsDir,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        tokenBudget,
        confirm,
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
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
          });
          this.emit("agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          const agentSnapshot = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agentSnapshot) {
            agentSnapshot.status = event.result === null ? "error" : "done";
            agentSnapshot.resultPreview = preview(event.result);
            agentSnapshot.error = event.error;
            agentSnapshot.errorCode = event.errorCode;
            agentSnapshot.recoverable = event.recoverable;
            agentSnapshot.tokens = event.tokens;
            if (event.model) agentSnapshot.model = event.model;
            if (event.session) agentSnapshot.session = event.session;
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          const agentSnapshot = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
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

      // Two recoverable-by-external-action fault codes checkpoint the run as PAUSED (not failed),
      // so resume() replays the journaled prefix instead of restarting from scratch (§2.12):
      //  - PROVIDER_USAGE_LIMIT: a provider quota refills over time.
      //  - AUTH_REQUIRED: a host completes an auth step (both are recoverable:false, so the
      //    retry ladder already skipped them — only the pause branch was missing).
      const authPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.AUTH_REQUIRED;
      const usageLimitPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
      const paused = usageLimitPaused || authPaused;
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

      // Persist final state + release the lease BEFORE emitting, so a consumer that did not
      // subscribe to 'error' (EventEmitter throws ERR_UNHANDLED_ERROR on an unheard 'error')
      // can never skip cleanup and leak the run lease / lose the persisted "failed" state.
      this.persistRun(managed);
      this.releaseRunLease(managed);

      if (paused) {
        // The emit is untyped (WorkflowManager extends EventEmitter with an untyped override
        // emit); the payload is a bare literal. `reason` is a free-form string, so it just takes
        // "auth_required"/"usage_limit". resetHint is usage-limit-only; authContext is the
        // structured, NON-SECRET auth surface (§1.5) present only on the auth pause.
        this.emit("paused", {
          runId: managed.runId,
          reason: authPaused ? "auth_required" : "usage_limit",
          error: workflowError,
          resetHint: authPaused ? undefined : workflowError.resetHint,
          authContext: authPaused ? workflowError.authContext : undefined,
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
    // Append (crash-safe-ish): keep the latest entry per index, then persist.
    managed.journal = managed.journal.filter((e) => e.index !== entry.index);
    managed.journal.push(entry);
    if (managed.journaling) this.persistRun(managed);
    if (this.listenerCount("journal") > 0) this.emit("journal", { runId: managed.runId, entry });
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
        // The per-run working directory, so resume() re-runs in the SAME place.
        cwd: managed.cwd,
        sessionId: this.sessionId,
        journal: managed.journal,
        status: managed.status,
        // Why a pause happened, so the navigator / a future cold start can show it and
        // re-arm resume (§2.12). Selector switches on the paused run's error code:
        // AUTH_REQUIRED -> "auth_required", PROVIDER_USAGE_LIMIT -> "usage_limit".
        pauseReason:
          managed.status === "paused"
            ? managed.error?.code === WorkflowErrorCode.AUTH_REQUIRED
              ? "auth_required"
              : managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
                ? "usage_limit"
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
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.journaling === false) throw new Error("journaling disabled for this run");
    if (!this.resolveJournaling(exec)) throw new Error("journaling disabled for this run");
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;

    const persisted = this.persistence.load(runId);
    if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted") return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;

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
        return true;
      }
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
      args: persisted.args,
      // Explicit override wins; else the run resumes in ITS original directory
      // (e.g. the same worktree), never silently in the manager cwd.
      cwd: exec.cwd ?? persisted.cwd,
      meta,
      journal: persisted.journal ?? [],
      journaling: true,
      background: true,
      lease,
    };
    this.runs.set(runId, managed);

    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e] as const));
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    void this.executeRun(managed, persisted.script, persisted.args, { ...exec, resumeJournal }).catch(() => {});
    return true;
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
