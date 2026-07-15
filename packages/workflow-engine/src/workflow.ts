import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type {
  AgentHistoryEntry,
  AgentResultProvenance,
  AgentRunner,
  AgentSessionRecord,
  AgentSessionRef,
  AgentUsage,
  JournalEntry,
  McpServerConfig,
  PromptImage,
  WorkflowBackendConfig,
  WorkflowCallRecord,
  WorkflowCheckpointTaken,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRecordedError,
  WorkflowRunFallback,
  WorkflowRunResult,
} from "@automatalabs/shared-types";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import { errorMessage, WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { loadModelTierConfig, resolveTierModel } from "./model-tier-config.js";
import { projectRecordedError } from "./recorded-error.js";
import { registerRunTripwire } from "./rejection-tripwire.js";
import {
  canonicalStrictJson,
  cloneFrozenStrictJson,
  cloneTelemetry,
  deepFreeze,
} from "./strict-json.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

// WorkflowMeta / WorkflowMetaPhase / JournalEntry / WorkflowRunResult are the shared,
// host-facing types (defined once in @automatalabs/shared-types). The bare engine
// returns the result MINUS the run-manager's terminal status trio; the manager stamps
// status/reason/resetHint on top (the engine seam is never widened).
export type { WorkflowMeta, WorkflowMetaPhase, JournalEntry } from "@automatalabs/shared-types";

/** Bare engine return: the host-facing WorkflowRunResult MINUS the manager's terminal
 *  status trio (status/reason/resetHint). The WorkflowManager composes those on top. */
export type EngineRunResult<T = unknown> = Omit<WorkflowRunResult<T>, "status" | "reason" | "resetHint">;

/**
 * Base run options the engine shares with its callers. De-Pi'd from the old
 * `WorkflowAgentOptions` (which carried pi-coding-agent ToolDefinition[]/session
 * types): the engine no longer constructs an agent, so only the plain fields it
 * threads through remain.
 */
export interface WorkflowAgentOptions {
  /** Base working directory for the run (e.g. the project root). */
  cwd?: string;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model spec. A registered first segment routes and is stripped once;
   * the remaining id is sent verbatim. A backend name alone uses that harness's default.
   */
  mainModel?: string;
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  depth: number;
  /** Root-run-wide workflow() invocation ordinal. Monotonic and never decremented. */
  nestedSeq: number;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  /**
   * REQUIRED injected agent backend. The engine references the runner through this
   * one method only (it is the frozen AgentRunner seam) and calls agent.run() exactly
   * once per agent(). The Pi `?? new WorkflowAgent(options)` default is DROPPED — the
   * engine never constructs an agent and depends on no concrete backend.
   */
  agent: AgentRunner;
  /** The session's main model spec, shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `<cwd>/<AGENTS_DIR>` + `~/<AGENTS_DIR>`.
   * Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  /**
   * Override the directory scanned for `agentType` definitions (`*.md`). When set,
   * it replaces BOTH the project and user defaults — the parameterization of the old
   * hardcoded agents directory. Ignored when `agentRegistry` is supplied directly.
   */
  agentsDir?: string;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  tokenBudget?: number | null;
  /** Recorded budget debits, replayed in settlement-ordinal order before a bound
   *  call's settlement is exposed to workflow code. Isolation-only. */
  budgetReplay?: { trajectory: Array<{ ordinal: number; debit: number }> };
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Absolute workflow persistence root for log persistence; explicit value wins over AGENTPRISM_PERSISTENCE_ROOT. */
  persistenceRoot?: string;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /**
   * Whether this run participates in journal replay/write callbacks. Default true.
   * When false, resume inputs are rejected instead of being silently ignored.
   */
  journaling?: boolean;
  /** Resume: cached agent results keyed by deterministic call index. */
  resumeJournal?: Map<number, JournalEntry>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent/checkpoint completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Checkpoint reply indexes injected for this execution, used only for result attribution. */
  injectedCheckpointReplies?: ReadonlySet<number>;
  /** Observability callbacks; neither participates in journal identity. */
  onFallback?: (entry: WorkflowRunFallback) => void;
  onCheckpointTaken?: (entry: WorkflowCheckpointTaken) => void;
  /** Called at each call's terminal transition after the authoritative manifest append. */
  onCallRecord?: (record: WorkflowCallRecord) => void;
  /** Called synchronously when workflow() allocates a unique child-run ordinal. */
  onNestedWorkflow?: (ordinal: number, childRunId: string) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * APPROVED script-declared custom ACP backends (from `meta.backends`), threaded to every
   * agent() call as RunOptions.backends. The engine NEVER reads meta.backends itself — a
   * composition root must obtain approval (MCP elicitation / SDK allowScriptBackends / env
   * opt-in) and pass the result here, so script backends are inert by default at every
   * layer. ADDITIVE: not part of the resume identity hash.
   */
  scriptBackends?: Record<string, WorkflowBackendConfig>;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => the checkpoint's headless mode applies:
   * default (declared default/true), abort, or the opt-in durable pause.
   */
  confirm?: (
    promptText: string,
    options: CheckpointOptions,
    context?: CheckpointCallContext,
  ) => Promise<unknown>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: {
    label: string;
    phase?: string;
    prompt: string;
    model?: string;
    configOptions?: Record<string, string | boolean>;
    callIndex: number;
    scope: string;
  }) => void;
  onAgentEnd?: (event: {
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    worktree?: string;
    model?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    /** The call's ACP session re-attach record (live or journal-replayed), when one exists. */
    session?: AgentSessionRecord;
    callIndex: number;
    scope: string;
    usage?: AgentUsage;
    modelResolved?: string;
    modelFallbacks?: string[];
    backendId?: string;
    provenance?: AgentResultProvenance;
    errorRecord?: WorkflowRecordedError;
  }) => void;
  onAgentHistory?: (event: {
    label: string;
    phase?: string;
    history: AgentHistoryEntry[];
    callIndex: number;
    scope: string;
  }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent with a model spec. `claude`, `codex`, `opencode`, or a registered custom
   * name may prefix an id and is stripped once; the remainder is sent byte-for-byte. A backend
   * name alone preserves its harness default. Unregistered prefixes go intact to the default.
   */
  model?: string;
  /**
   * ACP session mode id advertised by the selected backend. Strict confinement lever:
   * unsupported modes fail the agent call instead of falling back to an unconfined session.
   */
  mode?: string;
  /**
   * Agent-advertised ACP session config options. Ids and string/boolean values pass through
   * verbatim, in ascending option-id order. The reserved `model` id is rejected; use `model`.
   * Present non-empty maps participate in the journal identity hash.
   */
  configOptions?: Record<string, string | boolean>;
  /**
   * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
   * model-tiers config. An explicit `model` takes precedence; a tier takes
   * precedence over the phase model. When the tier has no configured entry it
   * falls back to the session's main model.
   */
  tier?: string;
  isolation?: "worktree";
  /**
   * Name of a registered subagent definition (`<AGENTS_DIR>/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist, model, and body prompt
   * to this agent. An explicit `model` overrides the definition's model; the
   * definition's model overrides `tier`/phase. An unknown name logs a warning
   * and falls back to default tools/model (with the name as a prose hint).
   */
  agentType?: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
  /**
   * Working directory for this agent's ACP session. A relative path resolves against the
   * run's base cwd (WorkflowRunOptions.cwd). Worktree isolation overrides it (the worktree
   * IS the agent's cwd). ADDITIVE like mcpServers: it wires the agent's environment, not
   * the logical call, so it is intentionally NOT part of the resume identity hash
   * (hashAgentCall).
   */
  cwd?: string;
  /**
   * Client-provided MCP servers attached to this agent's session (threaded into the runner,
   * which sends them at ACP `session/new { mcpServers }`). ADDITIVE: it wires tools, not the
   * logical call, so it is intentionally NOT part of the resume identity hash (hashAgentCall).
   */
  mcpServers?: McpServerConfig[];
  /**
   * Base64 image attachments appended to the prompt as ACP image ContentBlocks by the runner.
   * ADDITIVE: it shapes the agent input, not the logical call identity, so it is intentionally
   * NOT part of the resume identity hash (hashAgentCall).
   */
  images?: readonly PromptImage[];
  /**
   * Generic ACP `_meta` passthrough, SESSION-scoped: merged into the outgoing ACP
   * `session/new` `_meta`, so a script can drive any ACP agent's custom extension surface
   * (pair with a registered custom backend via `model: "<backend-name>"`). User keys merge
   * over a custom backend's static `sessionMeta` defaults; the runner's protocol-critical
   * keys (schema channel, runId stamp) win over both. ADDITIVE: NOT part of the resume
   * identity hash (hashAgentCall) — it shapes the agent, not the logical call.
   */
  meta?: Record<string, unknown>;
  /**
   * Generic ACP `_meta` passthrough, TURN-scoped: merged into the outgoing ACP
   * `session/prompt` `_meta`. Backend-computed keys (e.g. the `outputSchema` forward when a
   * schema is set) win on conflict. ADDITIVE: NOT part of the resume identity hash.
   */
  promptMeta?: Record<string, unknown>;
  /**
   * Keep this agent's ACP session re-openable after the run: the runner skips the
   * release-time best-effort `session/close`, and the session's re-attach record lands in
   * `WorkflowRunResult.agentSessions` (and the journal) either way. Re-open later from the
   * HOST via `runner.loadSession()`/`resumeSession()` — scripts themselves never re-attach.
   * ADDITIVE: it shapes session disposal, not the logical call, so it is intentionally NOT
   * part of the resume identity hash (hashAgentCall).
   */
  keepSession?: boolean;
}

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available and `headless` is "default" (the default mode). */
  default?: unknown;
  /** Headless behavior: take `default`/true, abort, or durably pause. Default "default". */
  headless?: "default" | "abort" | "pause";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
}

/** The engine-computed identity of one checkpoint() call, handed to the confirm
 *  callback as its additive third argument. */
export interface CheckpointCallContext {
  callIndex: number;
  hash: string;
  /** The emitting engine run's runId (root, or `${root}-nested<ordinal>`). */
  scope: string;
  /** The structural call-path key, when captured. */
  path?: string;
}

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
  /** Re-attach records for every ACP session the run observed (live via onSessionOpen,
   *  replayed via JournalEntry.session), in completion order -> result.agentSessions. */
  agentSessions: AgentSessionRecord[];
  fallbacks: WorkflowRunFallback[];
  checkpointsTaken: WorkflowCheckpointTaken[];
  /** Engine-owned terminal-call manifest for this run's local index space. */
  calls: WorkflowCallRecord[];
  /** Run-local terminal transition ordinal. */
  settlementSeq: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

/** Observable call-path capture format. Bump when capture semantics change. */
export const CALL_PATH_FORMAT = 1;
/** Maximum unambiguous raw stack depth retained for call-path capture. */
export const CALL_PATH_RAW_FRAMES = 64;
/** Observable call-input fingerprint format. Bump when its inputs or encoding change. */
export const CALL_INPUTS_FORMAT = 1;

/** Convert a workflow name into the path-free base used for its vm filename. */
export function sanitizeVmName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return sanitized || "workflow";
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<EngineRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const journaling = options.journaling ?? true;
  if (!journaling && (options.resumeJournal || options.resumeFromRunId)) {
    throw new WorkflowError("journaling disabled for this run", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  // Snapshot tier routing once per run. A missing/unparseable file preserves the
  // historical runner-default behavior unless a tier falls through to mainModel.
  const modelTierConfig = loadModelTierConfig();
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const runAgentRetries = normalizeAgentRetries(options.agentRetries ?? 0);
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  const vmFilename = `${sanitizeVmName(meta.name)}.js`;
  const preludeLines = DETERMINISM_PRELUDE.split("\n").length;
  const backendsDigest = options.scriptBackends ? hashCanonicalStrictJson(options.scriptBackends) : null;
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it. The agents
  // directory is parameterized via options.agentsDir (defaults to AGENTS_DIR).
  const agentRegistry =
    options.agentRegistry ??
    loadAgentRegistry(
      baseCwd,
      options.agentsDir ? { projectDir: options.agentsDir, userDir: options.agentsDir } : undefined,
    );

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persistenceRoot: options.persistenceRoot,
    persist: journaling ? (options.persistLogs ?? true) : false,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
    agentSessions: [],
    fallbacks: [],
    checkpointsTaken: [],
    calls: [],
    settlementSeq: 0,
  };

  const agentRunner = options.agent;
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  // Global caps + budget are shared with any nested workflow() so they hold across nesting.
  const shared: SharedRuntime = options.sharedRuntime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
    nestedSeq: 0,
  };
  const limiter = shared.limiter;
  let nestedWorkflows = false;
  let abortSignaled = false;

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });
  const replayTrajectory = options.budgetReplay?.trajectory ?? [];
  let replayCursor = 0;
  const applyBudgetReplay = (settlementOrdinal: number | undefined) => {
    if (!options.budgetReplay || settlementOrdinal === undefined) return;
    while (
      replayCursor < replayTrajectory.length &&
      replayTrajectory[replayCursor].ordinal <= settlementOrdinal
    ) {
      shared.spent += replayTrajectory[replayCursor].debit;
      replayCursor++;
    }
  };

  // Run-scoped fault channel: when the rejection tripwire fires (a promise the SCRIPT
  // floated rejected with nobody listening), the run is already failing with SCRIPT_ERROR —
  // this controller cancels the run's in-flight agents so the zombie script stops spending
  // tokens. Combined with the caller's signal so both channels cancel the same work.
  const faults = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, faults.signal]) : faults.signal;
  if (signal.aborted) abortSignaled = true;
  signal.addEventListener(
    "abort",
    () => {
      abortSignaled = true;
    },
    { once: true },
  );

  const throwIfAborted = () => {
    if (signal.aborted) {
      abortSignaled = true;
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const reportTerminalObserverError = (observer: string, error: unknown) => {
    try {
      logger.error(`${observer} terminal observer failed: ${errorMessage(error)}`);
    } catch {
      // Terminal observer reporting is itself best-effort.
    }
  };

  const guardTerminal = (observer: string, callback: (() => void) | undefined) => {
    if (!callback) return;
    try {
      callback();
    } catch (error) {
      reportTerminalObserverError(observer, error);
    }
  };

  const appendCallRecord = (
    input: Omit<WorkflowCallRecord, "settlementOrdinal" | "scope">,
  ): WorkflowCallRecord => {
    const record = deepFreeze({
      ...input,
      settlementOrdinal: ++state.settlementSeq,
      scope: runId,
    } satisfies WorkflowCallRecord);
    state.calls.push(record);
    guardTerminal("onCallRecord", () => options.onCallRecord?.(record));
    return record;
  };

  const strictSnapshot = (value: unknown, description: string, agentLabel?: string): unknown => {
    const captured = cloneFrozenStrictJson(value);
    if (!captured.ok) {
      throw new WorkflowError(
        `${description} is not strict JSON at ${captured.path}`,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        { recoverable: false, agentLabel },
      );
    }
    return captured.clone;
  };

  const agent = async (prompt: string, agentOptions: AgentOptions = {}) => {
    throwIfAborted();

    // Check agent limit
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }

    const assignedPhase = agentOptions.phase ?? state.currentPhase;

    // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
    // without touching the run's overall budget. Soft (spent accrues post-agent),
    // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
    // work so subsequent phases still proceed.
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }

    const requestedLabel = agentOptions.label?.trim();
    const pendingLabel = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount + 1);

    // Resolve a named agentType to its bound definition (tools/model/prompt).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Model precedence: explicit agentOptions.model > agentType.model > resolved tier >
    // mainModel tier fallback > historical behavior. A tier suppresses phase routing; when
    // it has no configured model and no mainModel fallback, leave model undefined and pass
    // the raw tier through for the runner to route under the same deterministic rules.
    const explicitModel = agentOptions.model ?? agentDef?.model;
    const tierModel =
      !explicitModel && agentOptions.tier && modelTierConfig
        ? resolveTierModel(agentOptions.tier, modelTierConfig)
        : undefined;
    const modelSpec =
      explicitModel ??
      (agentOptions.tier ? tierModel || options.mainModel : resolveModelForPhase(assignedPhase, routingConfig));
    // For display in /workflows: the model this agent runs on — its explicit/phase
    // spec, else the session's main model. The real resolved id overrides this via
    // onModelResolved once the subagent session is created.
    let displayModel = modelSpec ?? options.mainModel;
    if (hasModelConfigOption(agentOptions.configOptions)) {
      // Surface the rejected authored call to validation/observability without invoking the
      // AgentRunner. The following assertion is the pre-session authority.
      options.onAgentStart?.({
        label: pendingLabel,
        phase: assignedPhase,
        prompt,
        model: displayModel,
        configOptions: agentOptions.configOptions,
        callIndex: state.callSeq,
        scope: runId,
      });
    }
    assertNoModelConfigOption(agentOptions.configOptions, pendingLabel);

    const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
    const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
    const retryAttempts =
      agentOptions.retries !== undefined ? normalizeAgentRetries(agentOptions.retries) : runAgentRetries;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount + 1);

    // Every identity component is computed before the index is allocated. A hash
    // serialization failure therefore consumes no index and leaves no journal gap.
    const callHash = hashAgentCall(
      prompt,
      modelSpec,
      agentOptions.mode,
      assignedPhase,
      agentOptions,
      agentDefinitionKey(agentDef),
    );
    const callPath = captureCallPath(vmFilename, preludeLines);
    const callInputsHash = hashCallInputs({
      cwd: agentOptions.cwd ?? null,
      isolation: resolvedIsolation ?? null,
      keepSession: agentOptions.keepSession === true,
      images: agentOptions.images ?? null,
      mcpServers: agentOptions.mcpServers ?? null,
      meta: agentOptions.meta ?? null,
      promptMeta: agentOptions.promptMeta ?? null,
      label,
      timeoutMs: timeout,
      retries: retryAttempts,
      backends: backendsDigest,
    });

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const callIndex = state.callSeq++;

    let settled: WorkflowCallRecord | undefined;
    const settle = (
      terminal: Omit<
        WorkflowCallRecord,
        "index" | "kind" | "hash" | "path" | "inputsHash" | "label" | "modelRequested" | "isolation" | "scope" | "settlementOrdinal"
      >,
    ): WorkflowCallRecord => {
      if (settled) return settled;
      settled = appendCallRecord({
        index: callIndex,
        kind: "agent",
        hash: callHash,
        ...(callPath !== undefined ? { path: callPath } : {}),
        ...(callInputsHash !== undefined ? { inputsHash: callInputsHash } : {}),
        label,
        ...(modelSpec !== undefined ? { modelRequested: modelSpec } : {}),
        ...(resolvedIsolation !== undefined ? { isolation: resolvedIsolation } : {}),
        ...terminal,
      });
      return settled;
    };

    const emitAgentEnd = (
      event: Omit<NonNullable<WorkflowRunOptions["onAgentEnd"]> extends (event: infer E) => void ? E : never, "callIndex" | "scope">,
    ) => {
      const terminalEvent = deepFreeze({ ...event, callIndex, scope: runId });
      guardTerminal("onAgentEnd", () => options.onAgentEnd?.(terminalEvent));
    };

    // Reserve the agent slot synchronously — atomic with the limit/budget gate
    // above (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
    // spent accrues after each agent, matching Claude Code; in-flight agents may
    // push slightly past total, then further agent() calls throw.)
    shared.agentCount++;

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    const cached = journaling ? options.resumeJournal?.get(callIndex) : undefined;
    const hashMatches = cached != null && cached.hash === callHash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
      try {
        options.onAgentStart?.(deepFreeze({
          label,
          phase: assignedPhase,
          prompt,
          model: displayModel,
          configOptions: agentOptions.configOptions,
          callIndex,
          scope: runId,
        }));
        const resultSnapshot = strictSnapshot(cached.result, `agent "${label}" replayed result`, label);
        const cachedSession = cached.session ? cloneTelemetry(cached.session) : undefined;
        const cachedUsage = cached.usage ? copyValidUsage(cached.usage) : undefined;
        if (cachedSession) state.agentSessions.push(cachedSession);
        settle({
          outcome: "result",
          origin: "journal-replay",
          ...(cachedUsage ? { usage: cachedUsage } : {}),
          budgetDebit: 0,
        });
        emitAgentEnd({
          label,
          phase: assignedPhase,
          result: resultSnapshot,
          tokens: 0,
          model: displayModel,
          session: cachedSession,
          usage: cachedUsage,
        });
        return resultSnapshot;
      } catch (error) {
        const errorRecord = projectRecordedError(error);
        const workflowError = wrapError(error, { agentLabel: label });
        settle({ outcome: "error", origin: "engine", error: errorRecord, budgetDebit: 0 });
        emitAgentEnd({
          label,
          phase: assignedPhase,
          result: null,
          tokens: 0,
          model: displayModel,
          error: workflowError.message,
          errorCode: workflowError.code,
          recoverable: workflowError.recoverable,
          errorRecord,
        });
        throw error;
      }
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);

    return limiter(async () => {
      const maxAttempts = retryAttempts + 1;
      let worktree: Worktree | undefined;
      let runCwd: string | undefined;
      let attemptsRan = 0;
      let budgetDebit = 0;
      const sealedUsage: AgentUsage[] = [];
      const modelFallbacks: string[] = [];

      interface AttemptSlots {
        sealed: boolean;
        usage?: AgentUsage;
        sessionRef?: AgentSessionRef;
        modelResolved?: string;
        modelFallbacks: string[];
        provenance?: AgentResultProvenance;
        budgetReplay?: { settlementOrdinal: number };
        history?: AgentHistoryEntry[];
      }

      const recordTokens = (value: unknown, usage: AgentUsage | undefined): number => {
        const tokens = usage && usage.total > 0 ? usage.total : estimateTokens(value) + estimateTokens(prompt);
        if (usage) {
          shared.tokenUsage.input += usage.input;
          shared.tokenUsage.output += usage.output;
          shared.tokenUsage.cost += usage.cost;
          shared.tokenUsage.cacheRead += usage.cacheRead;
          shared.tokenUsage.cacheWrite += usage.cacheWrite;
        }
        shared.tokenUsage.total += tokens;
        if (!options.budgetReplay) shared.spent += tokens;
        budgetDebit += tokens;
        options.onTokenUsage?.({ ...shared.tokenUsage });
        return tokens;
      };

      const sealAttempt = (slot: AttemptSlots) => {
        if (slot.sealed) return;
        slot.sealed = true;
        if (slot.usage) sealedUsage.push(slot.usage);
        modelFallbacks.push(...slot.modelFallbacks);
      };

      const sessionRecord = (slot: AttemptSlots): AgentSessionRecord | undefined =>
        slot.sessionRef
          ? deepFreeze({
              ...slot.sessionRef,
              callIndex,
              label,
              phase: assignedPhase,
              keptOpen: agentOptions.keepSession === true,
            })
          : undefined;

      const terminalUsage = (): AgentUsage | undefined => sumUsage(sealedUsage);

      const emitFailure = (
        thrown: unknown,
        origin: "runner" | "engine",
        outcome: "null" | "error",
        slot: AttemptSlots | undefined,
        aborted: boolean,
      ) => {
        applyBudgetReplay(slot?.budgetReplay?.settlementOrdinal);
        const errorRecord = projectRecordedError(thrown);
        const workflowError = wrapError(thrown, { agentLabel: label });
        const usage = terminalUsage();
        const session = slot ? sessionRecord(slot) : undefined;
        if (session) state.agentSessions.push(session);
        settle({
          outcome,
          origin,
          error: errorRecord,
          ...(aborted ? { aborted: true as const } : {}),
          ...(origin === "runner" ? { attempts: attemptsRan } : {}),
          ...(usage ? { usage } : {}),
          ...(slot?.modelResolved ? { modelResolved: slot.modelResolved } : {}),
          ...(slot?.sessionRef?.backendId ? { backendId: slot.sessionRef.backendId } : {}),
          ...(modelFallbacks.length ? { modelFallback: true as const } : {}),
          ...(worktree?.isolated ? { worktree: true } : {}),
          ...(runCwd !== undefined && origin === "runner" ? { resolvedCwd: runCwd } : {}),
          budgetDebit,
          ...(slot?.provenance ? { provenance: slot.provenance } : {}),
        });
        emitAgentEnd({
          label,
          phase: assignedPhase,
          result: null,
          tokens: budgetDebit,
          worktree: runCwd,
          model: slot?.modelResolved ?? displayModel,
          error: workflowError.message,
          errorCode: workflowError.code,
          recoverable: workflowError.recoverable,
          session,
          usage,
          modelResolved: slot?.modelResolved,
          modelFallbacks: modelFallbacks.length ? [...modelFallbacks] : undefined,
          backendId: slot?.sessionRef?.backendId,
          provenance: slot?.provenance,
          errorRecord,
        });
      };

      try {
        options.onAgentStart?.(deepFreeze({
          label,
          phase: assignedPhase,
          prompt,
          model: displayModel,
          configOptions: agentOptions.configOptions,
          callIndex,
          scope: runId,
        }));

        if (agentOptions.cwd !== undefined && typeof agentOptions.cwd !== "string") {
          throw new WorkflowError(
            `agent "${label}": options.cwd must be a string`,
            WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
            { recoverable: false, agentLabel: label },
          );
        }
        if (resolvedIsolation === "worktree") {
          worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
          if (!worktree.isolated) log(`isolation ignored for "${label}" (${worktree.reason})`);
        }
        runCwd = worktree?.isolated ? worktree.cwd : resolvePath(baseCwd, agentOptions.cwd ?? ".");

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const slot: AttemptSlots = { sealed: false, modelFallbacks: [] };
          try {
            throwIfAborted();
            const attemptController = new AbortController();
            const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
            attemptsRan++;
            let result: unknown;
            try {
              result = await withTimeout(
                agentRunner.run(prompt, {
                  label,
                  schema: agentOptions.schema,
                  signal: attemptSignal,
                  instructions: buildAgentInstructions(
                    options.instructions,
                    assignedPhase,
                    agentOptions,
                    agentDef,
                    resolvedIsolation,
                  ),
                  model: modelSpec,
                  mode: agentOptions.mode,
                  configOptions: agentOptions.configOptions,
                  tier: agentOptions.tier,
                  toolNames: agentDef?.tools,
                  disallowedToolNames: agentDef?.disallowedTools,
                  cwd: runCwd,
                  mcpServers: agentOptions.mcpServers,
                  images: agentOptions.images,
                  meta: agentOptions.meta,
                  promptMeta: agentOptions.promptMeta,
                  backends: options.scriptBackends,
                  runId,
                  keepSession: agentOptions.keepSession,
                  callIndex,
                  callHash,
                  callPath,
                  callInputsHash,
                  onSessionOpen: (ref: AgentSessionRef) => {
                    if (slot.sealed) return;
                    const copied = cloneTelemetry(ref);
                    if (copied) slot.sessionRef = copied;
                  },
                  onModelResolved: (id: string) => {
                    if (slot.sealed) return;
                    slot.modelResolved = id;
                    displayModel = id;
                  },
                  onModelFallback: (spec: string) => {
                    if (slot.sealed) return;
                    slot.modelFallbacks.push(spec);
                    const message = `${label}: model "${spec}" unavailable — using the session default`;
                    log(message);
                    const fallback: WorkflowRunFallback = deepFreeze({
                      callIndex,
                      label,
                      ...(assignedPhase === undefined ? {} : { phase: assignedPhase }),
                      requestedSpec: modelSpec ?? agentOptions.tier ?? spec,
                      ...(slot.sessionRef?.backendId === undefined ? {} : { backendId: slot.sessionRef.backendId }),
                      kind: "model",
                      message,
                    });
                    if (!state.fallbacks.some((entry) => sameFallback(entry, fallback))) {
                      state.fallbacks.push(fallback);
                      options.onFallback?.(fallback);
                    }
                  },
                  onUsage: (reported: AgentUsage) => {
                    if (slot.sealed) return;
                    const copied = copyValidUsage(reported);
                    if (copied) slot.usage = copied;
                    else bestEffortDebug(`agent ${label}: dropped invalid usage report`);
                  },
                  onResultProvenance: (reported: AgentResultProvenance) => {
                    if (slot.sealed) return;
                    const copied = cloneTelemetry(reported);
                    if (copied) slot.provenance = copied;
                  },
                  onBudgetReplay: (reported: { settlementOrdinal: number }) => {
                    if (slot.sealed) return;
                    const copied = cloneTelemetry(reported);
                    if (copied) slot.budgetReplay = copied;
                  },
                  onHistory: (history: AgentHistoryEntry[]) => {
                    if (slot.sealed) return;
                    const copied = cloneTelemetry(history);
                    if (!copied) {
                      bestEffortDebug(`agent ${label}: dropped uncopyable history report`);
                      return;
                    }
                    slot.history = copied;
                    options.onAgentHistory?.(deepFreeze({
                      label,
                      phase: assignedPhase,
                      history: copied,
                      callIndex,
                      scope: runId,
                    }));
                  },
                } as any),
                timeout,
                label,
                () => {
                  sealAttempt(slot);
                  attemptController.abort();
                },
              );
            } finally {
              sealAttempt(slot);
            }

            throwIfAborted();
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }
            const resultSnapshot = strictSnapshot(result, `agent "${label}" result`, label);
            recordTokens(result, slot.usage);
            applyBudgetReplay(slot.budgetReplay?.settlementOrdinal);
            const usage = terminalUsage();
            const session = sessionRecord(slot);
            if (session) state.agentSessions.push(session);
            settle({
              outcome: "result",
              origin: "runner",
              attempts: attemptsRan,
              ...(usage ? { usage } : {}),
              ...(slot.modelResolved ? { modelResolved: slot.modelResolved } : {}),
              ...(slot.sessionRef?.backendId ? { backendId: slot.sessionRef.backendId } : {}),
              ...(modelFallbacks.length ? { modelFallback: true as const } : {}),
              ...(worktree?.isolated ? { worktree: true } : {}),
              resolvedCwd: runCwd,
              budgetDebit,
              ...(slot.provenance ? { provenance: slot.provenance } : {}),
            });
            if (journaling) {
              const entry = deepFreeze({
                index: callIndex,
                hash: callHash,
                result: resultSnapshot,
                kind: "agent" as const,
                scope: runId,
                ...(session ? { session } : {}),
                ...(usage ? { usage } : {}),
                call: {
                  kind: "agent" as const,
                  label,
                  phase: assignedPhase,
                  model: slot.modelResolved ?? displayModel,
                  backendId: session?.backendId,
                },
              });
              guardTerminal("onAgentJournal", () => options.onAgentJournal?.(entry));
            }
            emitAgentEnd({
              label,
              phase: assignedPhase,
              result: resultSnapshot,
              tokens: budgetDebit,
              worktree: runCwd,
              model: slot.modelResolved ?? displayModel,
              session,
              usage,
              modelResolved: slot.modelResolved,
              modelFallbacks: modelFallbacks.length ? [...modelFallbacks] : undefined,
              backendId: slot.sessionRef?.backendId,
              provenance: slot.provenance,
            });
            return result;
          } catch (error) {
            if (!slot.sealed) sealAttempt(slot);
            if (signal.aborted) {
              emitFailure(error, attemptsRan > 0 ? "runner" : "engine", "error", slot, true);
              throw error;
            }

            const workflowError = wrapError(error, { agentLabel: label });
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            recordTokens(null, slot.usage);

            if (workflowError.recoverable && attempt < maxAttempts) {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              continue;
            }

            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              emitFailure(workflowError, "runner", "null", slot, false);
              return null;
            }
            emitFailure(workflowError, "runner", "error", slot, false);
            throw workflowError;
          }
        }
        return null;
      } catch (error) {
        if (!settled) {
          emitFailure(error, attemptsRan > 0 ? "runner" : "engine", "error", undefined, signal.aborted);
        }
        throw error;
      } finally {
        if (worktree?.isolated) await removeWorktree(worktree);
      }
    });
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (signal.aborted) throw error;
          const workflowError = wrapError(error);
          // Non-recoverable failures (token budget / agent limit exhausted) must
          // halt the whole run, exactly like a directly-awaited agent() — not be
          // swallowed into a null in the result array.
          if (!workflowError.recoverable) throw workflowError;
          log(`parallel[${index}] failed: ${workflowError.message}`);
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (signal.aborted) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures halt the whole run (see parallel()).
            if (!workflowError.recoverable) throw workflowError;
            log(`pipeline[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  // Nested workflow(): run a saved workflow (or a raw script) inline, sharing this
  // run's limiter/counters/budget so the global caps hold. One level deep only.
  const workflowFn = async (nameOrScript: string, childArgs?: unknown) => {
    throwIfAborted();
    if (shared.depth >= 1) {
      throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const ordinal = ++shared.nestedSeq;
    const childRunId = `${runId}-nested${ordinal}`;
    nestedWorkflows = true;
    options.onNestedWorkflow?.(ordinal, childRunId);
    const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    shared.depth++;
    try {
      const child = await runWorkflow(childScript, {
        // Spread inherits the PARENT's approved scriptBackends (same trust context — the
        // parent chose to nest); the child's own meta.backends stays inert (nothing here
        // approves it, and only the composition root can).
        ...options,
        args: childArgs,
        // The COMBINED signal, so a parent-side fault/abort cancels the child's agents too
        // (the child layers its own fault controller on top of this).
        signal,
        sharedRuntime: shared,
        // A nested run is its own script; never reuse the parent's resume journal.
        resumeJournal: undefined,
        resumeFromRunId: undefined,
        runId: childRunId,
        persistLogs: false,
      });
      state.fallbacks.push(...(child.fallbacks ?? []));
      state.checkpointsTaken.push(...(child.checkpointsTaken ?? []));
      return child.result;
    } finally {
      shared.depth--;
    }
  };

  // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
  // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
  // Injected as globals so workflow scripts compose them directly. ──

  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_v, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return { real: votes.length > 0 && realCount / votes.length >= threshold, realCount, total: votes.length, votes };
  };

  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallel(
              Array.from(
                { length: judges },
                (_v, j) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      label: `judge ${idx + 1}.${j + 1}`,
                      schema: JUDGE_SCHEMA,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    return best;
  };

  const loopUntilDry = async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
    const maxRounds = opts.maxRounds ?? 50;
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result, don't abort.
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) break;
        throw error;
      }
      const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return all;
  };

  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };
  const completenessCheck = (taskArgs: unknown, results: unknown) =>
    agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
  // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<unknown> | unknown,
    opts: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    let last: unknown;
    let lastVerdict: unknown = null;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      lastVerdict = await validator(last);
      const accepted =
        typeof lastVerdict === "boolean"
          ? lastVerdict
          : Boolean((lastVerdict as { ok?: unknown } | null)?.ok);
      if (accepted) return { ok: true, value: last, verdict: lastVerdict ?? null, attempts: i + 1 };
      feedback =
        typeof lastVerdict === "boolean"
          ? undefined
          : (lastVerdict as { feedback?: string } | null)?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, verdict: lastVerdict ?? null, attempts };
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless defaults remain non-blocking; authors
  // can opt into a persisted pause with headless:"pause".
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const callHash = hashCheckpoint(promptText, checkpointOptions);
    const callPath = captureCallPath(vmFilename, preludeLines);
    const callIndex = state.callSeq++;
    let settled: WorkflowCallRecord | undefined;
    const settle = (
      terminal: Omit<
        WorkflowCallRecord,
        "index" | "kind" | "hash" | "path" | "scope" | "settlementOrdinal"
      >,
    ): WorkflowCallRecord => {
      if (settled) return settled;
      settled = appendCallRecord({
        index: callIndex,
        kind: "checkpoint",
        hash: callHash,
        ...(callPath !== undefined ? { path: callPath } : {}),
        ...terminal,
      });
      return settled;
    };
    const cached = journaling ? options.resumeJournal?.get(callIndex) : undefined;
    if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
      shared.agentCount++;
      try {
        const resultSnapshot = strictSnapshot(cached.result, `checkpoint "${promptText}" replayed reply`);
        settle({ outcome: "result", origin: "journal-replay" });
        const entry: WorkflowCheckpointTaken = deepFreeze({
          callIndex,
          kind: checkpointOptions.kind ?? "confirm",
          decision: resultSnapshot,
          source: options.injectedCheckpointReplies?.has(callIndex) ? "injected" : "journal-replay",
        });
        state.checkpointsTaken.push(entry);
        guardTerminal("onCheckpointTaken", () => options.onCheckpointTaken?.(entry));
        return resultSnapshot;
      } catch (error) {
        settle({ outcome: "error", origin: "journal-replay", error: projectRecordedError(error) });
        throw error;
      }
    }
    if (cached == null || cached.hash !== callHash) state.firstMiss = Math.min(state.firstMiss, callIndex);
    shared.agentCount++;

    const origin = options.confirm ? "confirm" as const : "headless" as const;
    try {
      let reply: unknown;
      if (options.confirm) {
        reply = await options.confirm(promptText, checkpointOptions, {
          callIndex,
          hash: callHash,
          scope: runId,
          path: callPath,
        });
      } else if (checkpointOptions.headless === "abort") {
        throw new WorkflowError(
          `checkpoint "${promptText}" needs human input but none is available (headless run)`,
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: false },
        );
      } else if (checkpointOptions.headless === "pause") {
        throw new WorkflowError(
          `checkpoint "${promptText}" awaits a human decision`,
          WorkflowErrorCode.CHECKPOINT_REQUIRED,
          {
            recoverable: false,
            checkpointContext: {
              callIndex,
              hash: callHash,
              prompt: promptText,
              kind: checkpointOptions.kind ?? "confirm",
              choices: checkpointOptions.choices,
              default: checkpointOptions.default,
            },
          },
        );
      } else {
        reply = checkpointOptions.default ?? true;
      }
      throwIfAborted();
      const replySnapshot = strictSnapshot(reply, `checkpoint "${promptText}" reply`);
      settle({ outcome: "result", origin });
      if (journaling) {
        const entry = deepFreeze({
          index: callIndex,
          hash: callHash,
          result: replySnapshot,
          kind: "checkpoint" as const,
          scope: runId,
          call: { kind: "checkpoint" as const, label: "checkpoint" as const, phase: state.currentPhase },
        });
        guardTerminal("onAgentJournal", () => options.onAgentJournal?.(entry));
      }
      const checkpointTaken: WorkflowCheckpointTaken = deepFreeze({
        callIndex,
        kind: checkpointOptions.kind ?? "confirm",
        decision: replySnapshot,
        source: options.confirm ? "live" : "headless-default",
      });
      state.checkpointsTaken.push(checkpointTaken);
      guardTerminal("onCheckpointTaken", () => options.onCheckpointTaken?.(checkpointTaken));
      return reply;
    } catch (error) {
      const aborted = signal.aborted;
      settle({
        outcome: "error",
        origin: aborted ? "engine" : origin,
        error: projectRecordedError(error),
        ...(aborted ? { aborted: true as const } : {}),
      });
      throw error;
    }
  };

  // Adopt every engine-returned promise into the SCRIPT's realm at the context boundary.
  // This is what makes the rejection tripwire's realm-identity attribution complete: the
  // script can only float (a) promises it created itself — natively realm-owned — or
  // (b) promises these globals returned, plus .then() chains off either — realm-owned via
  // this adoption (species lookup follows the receiver's realm constructor). Bonus: inside
  // the script, `agent(...) instanceof Promise` is now true (host promises weren't).
  // `realmPromiseCtor` is assigned right after createContext(), before any script runs.
  let realmPromiseCtor: PromiseConstructor | undefined;
  const tracked = <F extends (...args: never[]) => unknown>(fn: F): F =>
    ((...args: never[]) => {
      const out = fn(...args);
      return out instanceof Promise && realmPromiseCtor ? realmPromiseCtor.resolve(out) : out;
    }) as F;

  const context = vm.createContext({
    agent: tracked(agent),
    parallel: tracked(parallel),
    pipeline: tracked(pipeline),
    workflow: tracked(workflowFn),
    verify: tracked(verify),
    judgePanel: tracked(judgePanel),
    loopUntilDry: tracked(loopUntilDry),
    completenessCheck: tracked(completenessCheck),
    retry: tracked(retry),
    gate: tracked(gate),
    checkpoint: tracked(checkpoint),
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  realmPromiseCtor = new vm.Script("Promise").runInContext(context) as PromiseConstructor;
  const tripwire = registerRunTripwire({
    realmPromise: realmPromiseCtor,
    // Cancel in-flight agents so a zombie script (still unwinding after the run already
    // failed with SCRIPT_ERROR) stops spending tokens. This is the FAULT channel, not the
    // caller's abort — the manager still classifies the run by the error it receives.
    onTrip: () => faults.abort(),
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  let result: unknown;
  try {
    const scriptPromise = new vm.Script(wrapped, { filename: vmFilename }).runInContext(context) as Promise<unknown>;
    // If the tripwire fires while the script is still running, the run fails NOW with
    // SCRIPT_ERROR; the losing scriptPromise keeps its race handlers, so its own eventual
    // rejection (e.g. WORKFLOW_ABORTED from the fault-channel cancel) never floats.
    result = await Promise.race([scriptPromise, tripwire.tripped]);
    await tripwire.drain();
  } catch (error) {
    // A WorkflowError crossing the script boundary keeps its classification (abort, budget,
    // usage limit, tripwire). Anything else IS the script crashing — label it SCRIPT_ERROR,
    // never WORKFLOW_ABORTED (nobody cancelled anything).
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(errorMessage(error), WorkflowErrorCode.SCRIPT_ERROR, { recoverable: false });
  } finally {
    tripwire.retire();
  }

  // Persist logs
  const logFile = logger.persist();
  if (logFile) {
    log(`Logs persisted to ${logFile}`);
  }

  // Emit final token usage
  options.onTokenUsage?.(shared.tokenUsage);

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: shared.agentCount,
    durationMs: Date.now() - started,
    runId,
    tokenUsage: shared.tokenUsage,
    agentSessions: state.agentSessions,
    ...(state.fallbacks.length === 0 ? {} : { fallbacks: state.fallbacks }),
    ...(state.checkpointsTaken.length === 0 ? {} : { checkpointsTaken: state.checkpointsTaken }),
    calls: Object.freeze([...state.calls]) as WorkflowCallRecord[],
    callsAllocated: state.callSeq,
    effectiveLimits: {
      maxAgents,
      tokenBudget: options.tokenBudget ?? null,
      concurrency,
      agentRetries: runAgentRetries,
      agentTimeoutMs,
    },
    ...(abortSignaled ? { abortSignaled: true as const } : {}),
    ...(nestedWorkflows ? { nestedWorkflows: true as const } : {}),
  };
}

function sameFallback(left: WorkflowRunFallback, right: WorkflowRunFallback): boolean {
  return (
    left.callIndex === right.callIndex &&
    left.label === right.label &&
    left.phase === right.phase &&
    left.requestedSpec === right.requestedSpec &&
    left.resolvedModel === right.resolvedModel &&
    left.backendId === right.backendId &&
    left.kind === right.kind &&
    left.message === right.message
  );
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
    ranges: false,
  }) as AnyNode;

  // This direct-syntax check provides fast author feedback without chasing aliases.
  // DETERMINISM_PRELUDE remains the authoritative runtime enforcement for aliases,
  // computed access, and other forms that intentionally stay outside this AST check.
  const violation = findDeterminismViolation(ast);
  if (violation) {
    const start = violation.node.loc?.start;
    const location = start ? ` at line ${start.line}, column ${start.column + 1}` : "";
    throw new WorkflowError(
      `Workflow scripts must be deterministic: ${violation.api} is unavailable${location}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function findDeterminismViolation(ast: AnyNode): { api: string; node: AnyNode } | undefined {
  const pending = [ast];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const api = nondeterministicApi(node);
    if (api) return { api, node };

    const children: AnyNode[] = [];
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && typeof (item as AnyNode).type === "string") {
            children.push(item as AnyNode);
          }
        }
      } else if (value && typeof value === "object" && typeof (value as AnyNode).type === "string") {
        children.push(value as AnyNode);
      }
    }
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  return undefined;
}

function nondeterministicApi(node: AnyNode): string | undefined {
  if (
    (node.type === "CallExpression" || node.type === "NewExpression") &&
    node.arguments.length === 0 &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "Date"
  ) {
    return node.type === "NewExpression" ? "new Date()" : "Date()";
  }
  if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression" || node.callee.computed) {
    return undefined;
  }
  const object = node.callee.object as AnyNode;
  const property = node.callee.property as AnyNode;
  if (object.type === "Identifier" && object.name === "Date" && property.type === "Identifier" && property.name === "now") {
    return "Date.now()";
  }
  if (
    object.type === "Identifier" &&
    object.name === "Math" &&
    property.type === "Identifier" &&
    property.name === "random"
  ) {
    return "Math.random()";
  }
  return undefined;
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
  if (value.backends !== undefined) validateMetaBackends(value.backends);
}

/** Structural validation of script-declared `meta.backends`. The engine only PARSES these —
 *  it never spawns them; the composition root decides whether to approve and thread them
 *  (ExecOptions.scriptBackends). Deep policy checks (reserved names, etc.) live in the
 *  runner, which re-validates whatever it is handed. */
function validateMetaBackends(backends: unknown): void {
  if (!backends || typeof backends !== "object" || Array.isArray(backends)) {
    throw new Error("meta.backends must be an object of { <name>: { command, args?, env?, sessionMeta?, structuredOutputTool? } }");
  }
  for (const [name, config] of Object.entries(backends as Record<string, unknown>)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`meta.backends.${name} must be an object with at least { command }`);
    }
    const c = config as Record<string, unknown>;
    if (typeof c.command !== "string" || !c.command.trim()) {
      throw new Error(`meta.backends.${name}.command must be a non-empty string`);
    }
    if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === "string"))) {
      throw new Error(`meta.backends.${name}.args must be an array of strings`);
    }
    if (
      c.env !== undefined &&
      (!c.env || typeof c.env !== "object" || Array.isArray(c.env) || Object.values(c.env).some((v) => typeof v !== "string"))
    ) {
      throw new Error(`meta.backends.${name}.env must be an object of string values`);
    }
    if (c.sessionMeta !== undefined && (!c.sessionMeta || typeof c.sessionMeta !== "object" || Array.isArray(c.sessionMeta))) {
      throw new Error(`meta.backends.${name}.sessionMeta must be an object`);
    }
    if (c.structuredOutputTool !== undefined && typeof c.structuredOutputTool !== "boolean") {
      throw new Error(`meta.backends.${name}.structuredOutputTool must be a boolean`);
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function captureCallPath(vmFilename: string, preludeLines: number): string | undefined {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  const originalStackTraceLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = CALL_PATH_RAW_FRAMES + 1;
    Error.prepareStackTrace = (_error, stack) => stack;
    const raw = new Error().stack as unknown as NodeJS.CallSite[];
    if (!Array.isArray(raw) || raw.length === CALL_PATH_RAW_FRAMES + 1) return undefined;

    const selected: NodeJS.CallSite[] = [];
    let selecting = false;
    for (const frame of raw) {
      const selectable = frame.getFileName() === vmFilename && !frame.isAsync();
      if (!selecting) {
        if (!selectable) continue;
        selecting = true;
      } else if (!selectable) {
        break;
      }
      selected.push(frame);
    }
    if (selected.length === 0) return undefined;

    const normalized: string[] = [];
    for (const frame of selected) {
      const frameLine = frame.getLineNumber();
      const column = frame.getColumnNumber();
      if (frameLine === null || column === null) return undefined;
      normalized.push(`${frameLine - (preludeLines + 1)}:${column}`);
    }
    return normalized.join("<");
  } catch {
    return undefined;
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
    Error.stackTraceLimit = originalStackTraceLimit;
  }
}

function hashCanonicalStrictJson(value: unknown): string | undefined {
  const canonical = canonicalStrictJson(value);
  return canonical === undefined ? undefined : createHash("sha256").update(canonical).digest("hex");
}

function hashCallInputs(inputs: {
  cwd: unknown;
  isolation: unknown;
  keepSession: unknown;
  images: unknown;
  mcpServers: unknown;
  meta: unknown;
  promptMeta: unknown;
  label: unknown;
  timeoutMs: unknown;
  retries: unknown;
  backends: unknown;
}): string | undefined {
  return hashCanonicalStrictJson(inputs);
}

/** Stable identity hash for a checkpoint() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  mode: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
): string {
  const configOptions = sortedConfigOptions(options.configOptions);
  const identity = JSON.stringify({
    prompt,
    model: model ?? null,
    // Included only when SET: a mode changes agent behavior (must invalidate resume),
    // but journals written before modes existed must keep replaying for mode-less
    // calls — an unconditional `mode: null` key would cache-miss every old journal.
    ...(mode !== undefined ? { mode } : {}),
    ...(configOptions ? { configOptions } : {}),
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function sortedConfigOptions(
  configOptions: Record<string, string | boolean> | undefined,
): Record<string, string | boolean> | undefined {
  if (!configOptions || Object.keys(configOptions).length === 0) return undefined;
  const ids = Object.keys(configOptions).sort();
  const sorted = Object.fromEntries(ids.map((id) => [id, configOptions[id]]));
  // JSON.stringify normally hoists integer-like object keys into numeric order. ACP option ids
  // are unrestricted strings, so expose the already-sorted key list through [[OwnPropertyKeys]]
  // and keep the contract lexicographic for ids such as "10" and "2" as well.
  return new Proxy(sorted, { ownKeys: () => ids });
}

function assertNoModelConfigOption(
  configOptions: Record<string, string | boolean> | undefined,
  label: string,
): void {
  if (!configOptions || !("model" in configOptions)) return;
  throw new WorkflowError(
    `agent "${label}": configOptions option "model" with authored value ${JSON.stringify(configOptions.model)} is reserved; use the model field instead`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label },
  );
}

function hasModelConfigOption(configOptions: Record<string, string | boolean> | undefined): boolean {
  return Boolean(configOptions && "model" in configOptions);
}

function buildAgentInstructions(
  runInstructions: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  if (runInstructions) lines.push(runInstructions);
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use resolvedIsolation so the annotation fires whether isolation came from
  // the call site or from the agentDef's isolation field.
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

function copyValidUsage(value: AgentUsage): AgentUsage | undefined {
  try {
    const copy: AgentUsage = {
      input: value.input,
      output: value.output,
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
      total: value.total,
      cost: value.cost,
    };
    return Object.values(copy).every((field) => Number.isFinite(field) && field >= 0)
      ? deepFreeze(copy)
      : undefined;
  } catch {
    return undefined;
  }
}

function sumUsage(values: AgentUsage[]): AgentUsage | undefined {
  if (values.length === 0) return undefined;
  return deepFreeze(
    values.reduce<AgentUsage>(
      (sum, usage) => ({
        input: sum.input + usage.input,
        output: sum.output + usage.output,
        cacheRead: sum.cacheRead + usage.cacheRead,
        cacheWrite: sum.cacheWrite + usage.cacheWrite,
        total: sum.total + usage.total,
        cost: sum.cost + usage.cost,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    ),
  );
}

function bestEffortDebug(message: string): void {
  try {
    console.debug(`[workflow-engine] ${message}`);
  } catch {
    // Debug reporting never changes execution.
  }
}

/**
 * Run a promise with a timeout.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Attempt cancellation is best-effort; timeout classification still wins.
      }
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
