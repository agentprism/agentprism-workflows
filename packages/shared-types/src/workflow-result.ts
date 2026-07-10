// ===== packages/shared-types/src/workflow-result.ts =====

import type { AuthErrorContext } from "./errors.js";

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

/** One cached agent()/checkpoint() result, keyed by its deterministic call index
 *  (PersistedRunState.journal, run-persistence.ts). The frozen AgentResult MUST
 *  round-trip through this JSON unchanged for resume. */
export interface JournalEntry {
  index: number;
  /** sha256 of the call identity (prompt + model + tier + phase + agentType + agentDef + schema). */
  hash: string;
  result: unknown;
  /** The call's ACP session record, when one was opened live. ADDITIVE: absent on
   *  pre-session-ref journals and on checkpoint entries; replay restores it as-is. */
  session?: AgentSessionRecord;
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
  /** Terminal status. "paused" => resumable (provider usage limit / headless checkpoint). */
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
  /** Present when status !== "completed": human-readable cause (e.g. "usage_limit",
   *  "auth_required"). NOT the machine-readable contract — hosts branch on `reason` for the
   *  coarse cause and read `authContext` for the structured auth surface (§2.12). */
  reason?: string;
  /** Provider reset hint for a usage-limit pause (verbatim, e.g. "Resets in ~3h"). */
  resetHint?: string;
  /** Present when a run paused with reason "auth_required" (§2.12): the structured, NON-SECRET
   *  auth surface (backendId + advertised method ids/types/names). Carries no credential
   *  material (Principle 9). Hosts read this — never the `reason` message string. */
  authContext?: AuthErrorContext;
  /** Re-attach records for every ACP session the run opened (live + journal-replayed),
   *  in call order. The host's hand-off to `runner.loadSession()`/`resumeSession()` —
   *  present even when journaling is off (it rides the result, not the journal). */
  agentSessions?: AgentSessionRecord[];
}
