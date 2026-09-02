// ===== packages/shared-types/src/workflow-result.ts =====

import type { AgentResultProvenance, AgentUsage, ContinuationSkipReason } from "./agent-run.js";
import type { AuthErrorContext, CheckpointContext, WorkflowErrorCode, WorkflowRecordedError } from "./errors.js";

/** Aggregate token/cost usage for a whole run (engine-summed; matches the
 *  onTokenUsage shape at workflow.ts:112-119). */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

/** One SCRIPT-DECLARED custom ACP backend (`meta.backends[name]`) — how to spawn an agent
 *  server the workflow wants to route `agent()` calls to. Structurally identical to the
 *  host-level registry config (acp-agents `CustomBackendConfig`), but declared by the SCRIPT
 *  AUTHOR, so it is a TRUST-GATED input: the engine parses it and otherwise ignores it; only
 *  a composition root that has obtained approval (MCP elicitation, the SDK's
 *  `allowScriptBackends`, or the AGENTPRISM_ALLOW_SCRIPT_BACKENDS env opt-in) threads it
 *  into the run via ExecOptions.scriptBackends. */
export interface WorkflowBackendConfig {
  /** The ACP server executable (absolute path or on PATH). */
  command: string;
  /** Arguments for the command. Default []. */
  args?: string[];
  /** Extra environment for the subprocess, merged OVER the inherited process.env. */
  env?: Record<string, string>;
  /** Static `_meta` sent on every session/new for this backend (defaults; per-call
   *  RunOptions.meta merges over them). */
  sessionMeta?: Record<string, unknown>;
  /** Enable client-hosted StructuredOutput MCP tool injection when schema runs negotiate HTTP MCP.
   *  Default true; set false to keep this backend on the prompt/_meta fallback path. */
  structuredOutputTool?: boolean;
}

/** The `export const meta = {...}` literal parsed from the head of a script. */
export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model/tier. */
  model?: string;
  /** Script-declared custom ACP backends, keyed by routing name (`agent({ model: "<name>" })`
   *  or `"<name>/<inner-model>"`). INERT unless the composition root approves and threads
   *  them (see WorkflowBackendConfig); host-registered names always win on conflict. */
  backends?: Record<string, WorkflowBackendConfig>;
}

/**
 * The re-attach handle for ONE ACP session opened by a run — the identity a host needs to
 * re-open or fork the agent's persisted conversation later via `runner.loadSession()` /
 * `runner.resumeSession()` / `runner.forkSession()`. Delivered OUT-OF-BAND via
 * RunOptions.onSessionOpen (never via run()'s return value — AgentResult is the bare payload
 * by contract). Contains NO secrets
 * and is JSON-round-trippable (it rides journal entries and run results).
 *
 * Re-openability is AGENT-persistence-gated: the `reopen` flags mirror what the connected
 * agent advertised at initialize (loadSession / sessionCapabilities.resume / .list / .fork).
 * An agent that persists nothing advertises none of them — for those, a session is only
 * reachable while held open (InteractiveSession), and this ref is a tombstone once released.
 */
export interface AgentSessionRef {
  /** The ACP session id assigned when this session was created or forked. */
  sessionId: string;
  /** The backend that owns the session (built-in id or registered custom name). */
  backendId: string;
  /** The effective pool identity of the process that owns this session: the runner's resolved
   *  Backend.poolKey (`backend.ts:60-66`). For a custom backend that is `name` + a spawn-config hash
   *  over command/args/env; for a first-class backend it is deliberately the logical agent id
   *  (backendId), matching the pool's own process-identity model, which keys built-ins by bare id
   *  (`pool.ts:129`). A first-class backend's spawn config is NOT fixed — `spawnConfig()` varies with
   *  `AGENTPRISM_*_ACP_CMD/ARGS` env overrides and with installed-bin-vs-npx resolution
   *  (`backends/claude.ts:44-58`, and codex/opencode/pi) and built-ins define no explicit `poolKey` — but
   *  every such launch of the same first-class agent shares one agent-side session store, so reattach
   *  stays semantically valid and the logical-agent identity is correct by design; a genuinely
   *  different program bound behind an env override is caught at the reopen RPC (`reattach-failed` →
   *  fresh), not by this field. Persisted so a COLD resume can prove the currently-resolved backend
   *  is the SAME logical process identity that owns the recorded session. ADDITIVE and NOT a hash
   *  input; absent on legacy pre-poolKey refs. */
  poolKey?: string;
  /** Recursively frozen JSON snapshot of initialize-response `_meta`, when the agent sent it. */
  initializeMeta?: Readonly<Record<string, unknown>>;
  /** ABSOLUTE working directory the session was opened with. Sessions are cwd-scoped on
   *  agents that key their stores by workspace — pass this back when re-opening. */
  cwd: string;
  /** Which re-open paths the agent advertised at initialize (NegotiatedCapabilities). */
  reopen: {
    /** `session/load` — re-open WITH history replay (`runner.loadSession`). */
    load: boolean;
    /** `session/resume` — re-open WITHOUT replay (`runner.resumeSession`). */
    resume: boolean;
    /** `session/list` — enumerable via `runner.listSessions`. */
    list: boolean;
    /** `session/fork` — driven via `runner.forkSession()`; optional for pre-fork records. */
    fork?: boolean;
  };
}

/** One run's session ref PLUS its workflow-call context — what lands in JournalEntry.session,
 *  the agent snapshot, and WorkflowRunResult.agentSessions. `keptOpen` records whether the
 *  release-time best-effort `session/close` was SKIPPED (agent({ keepSession: true })). */
export interface AgentSessionRecord extends AgentSessionRef {
  /** The owning agent() call's deterministic index (same key as JournalEntry.index). */
  callIndex: number;
  label: string;
  phase?: string;
  keptOpen: boolean;
}

/** One notice observed while serving an agent() call: a model-selection degrade
 *  (kind "model"/"modifier") OR a continuation attempt on resume (kind "continuation"). */
export interface WorkflowRunFallback {
  /** The owning agent() call's deterministic index. */
  callIndex: number;
  label: string;
  phase?: string;
  /** For continuation: the model/tier spec the engine asked the runner to serve on the continued
   *  call (identical to the interrupted call's — the hash proves it). */
  requestedSpec: string;
  /** Concrete model selected by the runner, when it reported one. */
  resolvedModel?: string;
  /** Actual backend that opened the session, when the runner reported one. */
  backendId?: string;
  kind: "model" | "modifier" | "continuation";
  /** The human-readable line emitted to the workflow log. */
  message: string;
  /** Present when — and only when — the engine emits `kind: "continuation"`. See the emission
   *  invariant; the type keeps it structurally optional so the flat interface stays non-breaking
   *  and no consumer must switch on `kind` to parse. */
  continuation?:
    | { outcome: "reattached"; method: "resume" | "load" }
    | { outcome: "skipped"; reason: ContinuationSkipReason };
}

/** How a checkpoint() decision was obtained in this execution. */
export type WorkflowCheckpointSource = "live" | "headless-default" | "journal-replay" | "injected";

/** One checkpoint() call that resolved during a workflow execution. */
export interface WorkflowCheckpointTaken {
  callIndex: number;
  kind: "confirm" | "input" | "select";
  /** The exact decision value stored in (or replayed from) the journal. */
  decision: unknown;
  source: WorkflowCheckpointSource;
}

/** One cached agent()/checkpoint() result, keyed by its deterministic call index
 *  (PersistedRunState.journal, run-persistence.ts). The frozen AgentResult MUST
 *  round-trip through this JSON unchanged for resume. */
export type JournalCallMetadata =
  | {
      kind: "agent";
      label: string;
      phase?: string;
      /** Resolved model when the runner reported one; otherwise the engine's best-known spec. */
      model?: string;
      /** Actual backend from onSessionOpen; absent when the runner supplied no session ref. */
      backendId?: string;
      /** Diagnostic-only: present when this result was produced by reattaching to a paused session
       *  and continuing the interrupted turn, and which reopen method reattached. NOT part of
       *  replay identity — replay restores it verbatim (`workflow.ts` replayPreparedAgent) and never
       *  consults it; the run-event journal projection preserves it (`run-observability.ts`). */
      continuation?: { method: "resume" | "load" };
    }
  | {
      kind: "checkpoint";
      label: "checkpoint";
      phase?: string;
    };

export interface JournalEntry {
  index: number;
  /** sha256 of the call identity (prompt + model + tier + phase + agentType + agentDef + schema). */
  hash: string;
  result: unknown;
  /** The call's ACP session record, when one was opened live. ADDITIVE: absent on
   *  pre-session-ref journals and on checkpoint entries; replay restores it as-is. */
  session?: AgentSessionRecord;
  /** Additive diagnostic metadata; it is not part of replay identity. */
  call?: JournalCallMetadata;
  /** Which primitive journaled this entry. Absent on old journals ("unknown"). */
  kind?: "agent" | "checkpoint";
  /** The logical call's provider-reported usage: the per-call sum. Absent on old
   *  journals, on checkpoint entries, and when no attempt reported in time. A
   *  present value is a LOWER BOUND on true spend. The chars/4 estimate is never
   *  written here. Replay carries it verbatim. */
  usage?: AgentUsage;
  /** The emitting engine run's runId. Absent on old journals (treated as root).
   *  The manager persists only root-scope entries. */
  scope?: string;
}

/** Resume correspondence policy selected for a manager-prepared new execution. */
export type ResumePolicy = "auto" | "positional";

export type WorkflowResumeStrategy = "identity-v1" | "positional-v1" | "live";

export type WorkflowResumeMatch = "path-hash" | "unique-hash" | "index-hash";

export type WorkflowResumeFallbackReason =
  | "legacy-recording"
  | "crash-residue"
  | "inputs-format-legacy"
  | "forced-positional"
  | "unsafe-recording"
  | "nested-workflows"
  | "legacy-resume";

export type WorkflowResumeDisabledReason =
  | "unsupported-format"
  | "source-not-terminal"
  | "abort-residue"
  | "isolation-recording"
  | "resume-metadata-missing"
  | "manifest-invalid"
  | "cwd-mismatch"
  | "runtime-mismatch"
  | "environment-missing"
  | "environment-mismatch"
  | "source-environment-drift"
  | "resume-seed-invalid";

export type WorkflowResumeCallLiveReason =
  | "strategy-live"
  | "positional-miss"
  | "positional-suffix"
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
  | "worktree-degraded";

export type WorkflowResumeCallFailedReason =
  | "seed-persistence-error"
  | "resume-fatal-latch";

export type WorkflowCheckpointReplyNotAppliedReason =
  | "checkpoint-identity-mismatch"
  | "checkpoint-not-reached-at-recorded-call-site";

export interface WorkflowCheckpointReplyNotApplied {
  recordedIndex: number;
  status: "not-applied";
  reason: WorkflowCheckpointReplyNotAppliedReason;
  /** Safe host-facing explanation. The supplied decision value is never included. */
  message: string;
  /** Current checkpoint call that exposed the mismatch, when one was reached. */
  callIndex?: number;
}

export type WorkflowCheckpointReplyReport =
  | {
      recordedIndex: number;
      status: "applied";
      callIndex: number;
    }
  | WorkflowCheckpointReplyNotApplied;

/** Legacy source-world classifications retained for journal compatibility and diagnostics.
 * They never determine replay eligibility. */
export type WorkflowResumeSafety =
  | "declared-read-only"
  | "isolated-worktree";

export interface WorkflowCallReplayProvenance {
  sourceRunId: string;
  recordedIndex: number;
  match: WorkflowResumeMatch;
  /** Agents only: legacy source-world classification retained as diagnostic
   *  provenance. It never determines whether a call is replayable. */
  sourceResumeSafety?: WorkflowResumeSafety;
  /** Checkpoints only: diagnostic origin marker for a host-confirmed or injected
   *  decision. It never determines whether a completed checkpoint can replay. */
  checkpointHostDecision?: true;
  checkpointInjected?: true;
}

export type WorkflowResumeCallDecision =
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "replayed";
      sourceRunId: string;
      recordedIndex: number;
      match: WorkflowResumeMatch;
      reason?: never;
      checkpointInjected?: true;
    }
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "live";
      reason: WorkflowResumeCallLiveReason;
      /** Present on a live checkpoint decision when a supplied reply did not exactly
       *  target that checkpoint occurrence. */
      checkpointReply?: WorkflowCheckpointReplyNotApplied;
      sourceRunId?: never;
      recordedIndex?: never;
      match?: never;
      checkpointInjected?: never;
    }
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "failed";
      reason: WorkflowResumeCallFailedReason;
      sourceRunId?: never;
      recordedIndex?: never;
      match?: never;
      checkpointInjected?: never;
    };

interface WorkflowResumeReportBase {
  sourceRunId: string;
  requestedPolicy: ResumePolicy;
  replayed: number;
  live: number;
  failed: number;
  /** One decision per root call, ordered by current execution index. */
  calls: WorkflowResumeCallDecision[];
  /** Outcome of the single durable checkpoint reply admitted for this execution. */
  checkpointReply?: WorkflowCheckpointReplyReport;
}

export type WorkflowResumeReport = WorkflowResumeReportBase &
  (
    | {
        strategy: "identity-v1";
        fallbackReason?: never;
        disabledReason?: never;
        eligibility?: never;
      }
    | {
        strategy: "positional-v1";
        fallbackReason: WorkflowResumeFallbackReason;
        eligibility: "legacy" | "safe-prefix" | "all-live";
        disabledReason?: never;
      }
    | {
        strategy: "live";
        disabledReason: WorkflowResumeDisabledReason;
        fallbackReason?: never;
        eligibility?: never;
      }
  );

export type WorkflowReplayOperationalOption =
  | "agentRetries"
  | "concurrency";

/** One operational run-bound change observed between a resume source and its new run.
 *  These values are diagnostic only and never gate replay eligibility. */
export interface WorkflowReplayOperationalChange {
  option: WorkflowReplayOperationalOption;
  source: number | null;
  current: number | null;
  detail: string;
}

export type WorkflowReplayProvenanceField =
  | "runtime.node"
  | "runtime.v8"
  | "environment.identity"
  | "environment.git.head"
  | "environment.git.dirtyDigest"
  | "environment.key";

/** One recorded-world difference observed between a resume source and its new run.
 *  These values are provenance only and never gate admission, strategy, or replay. */
export interface WorkflowReplayProvenanceChange {
  field: WorkflowReplayProvenanceField;
  source: string | null;
  current: string | null;
  detail: string;
}

export interface WorkflowReplayFirstNonReplay {
  index: number;
  action: "live" | "failed";
  reason:
    | WorkflowResumeCallLiveReason
    | WorkflowResumeCallFailedReason
    | WorkflowResumeDisabledReason
    | WorkflowResumeFallbackReason;
  /** Safe diagnostic naming the differing admission or operational value when known. */
  detail?: string;
}

interface WorkflowReplayEligibilityBase {
  sourceRunId: string;
  /** Admission-time upper bound from the durable source prefix. Actual call identity
   *  and inputs are still checked before any result is replayed. */
  predictedReplayablePrefix: number;
  /** Contiguous replayed prefix observed so far in the new run. */
  replayedPrefix: number;
  replayed: number;
  live: number;
  failed: number;
  firstNonReplay?: WorkflowReplayFirstNonReplay;
  sourceEngineVersion?: string;
  currentEngineVersion: string;
  engineVersionComparison: "same" | "different" | "source-unknown";
  sourceInputsFormat?: number;
  currentInputsFormat: number;
  /** Additive for persisted eligibility records written before provenance diagnostics. */
  provenanceChanges?: WorkflowReplayProvenanceChange[];
  operationalChanges: WorkflowReplayOperationalChange[];
}

/** Bounded resume plan and progress summary suitable for admission, polling, and
 *  inspection responses. The full per-call decisions remain in WorkflowResumeReport. */
export type WorkflowReplayEligibility = WorkflowReplayEligibilityBase &
  (
    | {
        strategy: "identity-v1";
        fallbackReason?: never;
        disabledReason?: never;
        eligibility?: never;
      }
    | {
        strategy: "positional-v1";
        fallbackReason: WorkflowResumeFallbackReason;
        eligibility: "legacy" | "safe-prefix" | "all-live";
        disabledReason?: never;
      }
    | {
        strategy: "live";
        disabledReason: WorkflowResumeDisabledReason;
        fallbackReason?: never;
        eligibility?: never;
      }
  );

/** One record per TERMINATED call of an engine run, emitted at the call's terminal
 *  transition — including calls that never journal (failures, caught throws,
 *  engine-side deaths, aborts). What the journal is to results, this is to structure. */
export interface WorkflowCallRecord {
  /** Same space as JournalEntry.index. */
  index: number;
  kind: "agent" | "checkpoint";
  /** hashAgentCall / hashCheckpoint at call time. Present on every record. */
  hash: string;
  /** The structural call-path key, when captured. */
  path?: string;
  /** hashCallInputs() for an agent or hashCheckpointInputs() for a checkpoint,
   *  when the corresponding strict fingerprint was computable. */
  inputsHash?: string;
  /** options.label as resolved by the engine (agent calls). */
  label?: string;
  /** "result" — a value returned to the script; "null" — recoverable exhaustion
   *  resolved null; "error" — a throw propagated into the script (catchable there). */
  outcome: "result" | "null" | "error";
  /** Which mechanism terminated the call. */
  origin: "runner" | "journal-replay" | "confirm" | "headless" | "engine";
  /** REQUIRED on outcome "null"/"error", forbidden on "result": the projection of
   *  the terminal error/thrown value. */
  error?: WorkflowRecordedError;
  /** True exactly on the signal-abort exits. */
  aborted?: boolean;
  /** Runner attempts that ran (origin "runner"; >=1). */
  attempts?: number;
  /** The logical call's usage: the per-call sum — present for failed calls too.
   *  A LOWER BOUND. Journal-replayed calls carry the entry's usage verbatim. */
  usage?: AgentUsage;
  /** The REQUESTED (script-resolved) model spec the engine passed to the runner.
   *  This is what the hash proves. NOT the served model. */
  modelRequested?: string;
  /** The runner-reported concrete model id from the terminal attempt. */
  modelResolved?: string;
  /** The terminal attempt's runner-reported backendId, when reported. */
  backendId?: string;
  /** True when any attempt reported a model fallback. */
  modelFallback?: true;
  /** True when the engine created a git worktree for this call. */
  worktree?: boolean;
  /** The resolved isolation request at call time; absent when none. */
  isolation?: "worktree";
  /** The post-resolution execution directory handed to the runner. */
  resolvedCwd?: string;
  /** Legacy source-world classification retained for diagnostics and old journal
   *  compatibility. Replay eligibility is based on recorded call correspondence,
   *  not this marker. */
  resumeSafety?: WorkflowResumeSafety;
  /** Manager-owned provenance for a resumeFromRunId journal replay. */
  replay?: WorkflowCallReplayProvenance;
  /** 1-based position of this call's terminal transition in the run's settlement
   *  sequence. */
  settlementOrdinal?: number;
  /** The terminal attempt's runner-reported result provenance. Permitted only on
   *  origin "runner" rows. */
  provenance?: AgentResultProvenance;
  /** The emitting engine run's runId. Manager persists root-scope records only. */
  scope?: string;
}


export interface WorkflowRunInspectionOptions {
  /** Latest matching journal entries. Default 20; valid range 1..50. */
  lastN?: number;
  /** Case-sensitive whole-label glob. Omitted means all call kinds. */
  labelGlob?: string;
  /** Latest run-log lines. Default 20; valid range 0..50. */
  logLines?: number;
}

export interface WorkflowLogTail {
  lines: string[];
  totalLines: number;
  omittedLines: number;
  truncatedLines: number;
  redactedLines: number;
}

export interface WorkflowRunCallStatus {
  index: number;
  kind: "agent" | "checkpoint" | "unknown";
  label?: string;
  phase?: string;
  model?: string;
  backendId?: string;
  /** Terminal agent error, including recoverable failures that settled the call to null. */
  errorCode?: WorkflowErrorCode;
  /** Present only while the call is in flight on a live run; settled calls omit it. */
  status?: "queued" | "running";
  /** Compact JSON text after structural compaction and redaction; never the raw result. */
  resultPreview: string;
  resultRedacted: boolean;
  resultTruncated: boolean;
}

export interface WorkflowRunStatusTruncation {
  maxStructuredBytes: number;
  byteCapApplied: boolean;
  phases: { total: number; returned: number; shortened: number };
  logs: { total: number; returned: number; shortened: number; redacted: number };
  calls: {
    total: number;
    matched: number;
    returned: number;
    shortenedResults: number;
    redactedResults: number;
  };
}

/** Host-resolved execution bounds in force for one run. */
export interface WorkflowRunLimits {
  maxAgents: number;
  concurrency: number;
  agentRetries: number;
}

/** Safe, bounded, point-in-time status used by every run-inspection/polling host. */
export interface WorkflowRunStatus {
  runId: string;
  status: RunStatus;
  workflowName: string;
  phases: string[];
  currentPhase?: string;
  reason?: string;
  errorCode?: WorkflowErrorCode;
  /** Resolved execution bounds. Absent only on legacy persisted rows that predate limits. */
  limits?: WorkflowRunLimits;
  /** Resume eligibility and progress. Present only on a run admitted from a source run. */
  replayEligibility?: WorkflowReplayEligibility;
  logTail: WorkflowLogTail;
  calls: WorkflowRunCallStatus[];
  filter: { lastN: number; logLines: number; labelGlob?: string };
  truncation: WorkflowRunStatusTruncation;
}

/** Persisted run lifecycle (run-persistence.ts:11). A host-facing WorkflowRunResult
 *  always carries a TERMINAL value: "completed" | "paused" | "failed" | "aborted". */
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

/**
 * The PUBLIC, host-facing result of a workflow run — also the MCP tool's
 * structuredContent shape. It is the engine's `runWorkflow<T>()` return
 * (meta/result/logs/phases/agentCount/durationMs/runId/tokenUsage — pi
 * workflow.ts:122-138, lifted) PLUS the run-manager's terminal status trio
 * (status/reason/resetHint).
 *
 * The ENGINE SEAM IS UNCHANGED: bare `runWorkflow()` returns
 *   Omit<WorkflowRunResult<T>, "status" | "reason" | "resetHint">  (runId optional there)
 * and the WorkflowManager STAMPS status/reason/resetHint on top and guarantees runId.
 * So hosts get a complete, resumable result without widening the engine's return.
 */
export interface WorkflowRunResult<T = unknown> {
  /** Stable id; pass back as `resumeFromRunId` to continue a paused run from its journal. */
  runId: string;
  /** Terminal status. "paused" => resumable (usage limit / auth / durable checkpoint). */
  status: RunStatus;
  /** The script's parsed `meta`. */
  meta: WorkflowMeta;
  /** The value the script's top level resolved to (must be JSON-serializable). */
  result: T;
  /** Phase titles in declaration/visit order. */
  phases: string[];
  /** Number of agent() calls executed (live + replayed). */
  agentCount: number;
  /** Wall-clock duration (ms). */
  durationMs: number;
  /** Aggregate token/cost usage (omitted if never measured — ACP usage is experimental). */
  tokenUsage?: TokenUsage;
  /** Captured log lines. */
  logs: string[];
  /** Redacted final log lines for a paused, failed, or aborted run. */
  logTail?: WorkflowLogTail;
  /** Present when status !== "completed": human-readable cause (e.g. "usage_limit",
   *  "auth_required", "checkpoint_required"). NOT the machine-readable contract — hosts branch
   *  on `reason`, then read the corresponding structured context when present. */
  reason?: string;
  /** Provider reset hint for a usage-limit pause (verbatim, e.g. "Resets in ~3h"). */
  resetHint?: string;
  /** Present when a run paused with reason "auth_required" (§2.12): the structured, NON-SECRET
   *  auth surface (backendId + advertised method ids/types/names). Carries no credential
   *  material (Principle 9). Hosts read this — never the `reason` message string. */
  authContext?: AuthErrorContext;
  /** Present when status is "paused" with reason "checkpoint_required": the structured,
   *  NON-SECRET pending checkpoint surface a host uses to collect and resume with a reply. */
  checkpointContext?: CheckpointContext;
  /** Re-attach records for every ACP session the run opened (live + journal-replayed),
   *  in call order. The host's hand-off to `runner.loadSession()`/`resumeSession()` —
   *  present even when journaling is off (it rides the result, not the journal). */
  agentSessions?: AgentSessionRecord[];
  /** Model-selection degrades observed on live agent calls. Absent when none occurred. */
  fallbacks?: WorkflowRunFallback[];
  /** Checkpoint calls resolved in this execution. Absent when none resolved. */
  checkpointsTaken?: WorkflowCheckpointTaken[];
  /** The engine-owned authoritative manifest: one frozen record per terminated call. */
  calls?: WorkflowCallRecord[];
  /** Manager-owned correspondence report for a resumeFromRunId execution. */
  resumeReport?: WorkflowResumeReport;
  /** Bounded admission/progress summary for a resumeFromRunId execution. */
  replayEligibility?: WorkflowReplayEligibility;
  /** Final number of agent()/checkpoint() call indexes allocated by this engine run. */
  callsAllocated?: number;
  /** The resolved execution inputs in force for this engine run. */
  effectiveLimits?: WorkflowRunLimits;
  /** Set iff the composed signal was ever observed aborted. */
  abortSignaled?: true;
  /** True when this run invoked workflow(), including a zero-call child workflow. */
  nestedWorkflows?: true;
}
