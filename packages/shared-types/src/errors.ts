// @automatalabs/shared-types — the ONLY module BOTH workflow-engine and acp-agents
// import (they never import each other; mcp-server is the sole composition root).
// Zero Pi / ACP / MCP deps; depends only on `typebox` (type-level for TSchema/Static)
// + carries the WorkflowError RUNTIME class so `instanceof` holds across packages.
// Presented as the package's files, each compilable on its own.

// ===== packages/shared-types/src/errors.ts =====
// The seam-level ERROR contract. Lives HERE (not in the engine) because the runner
// (acp-agents) THROWS these and the engine reads .code + .recoverable via instanceof —
// both sides MUST import the SAME class. Adapted from pi errors.ts (enum + WorkflowError
// class + guards). Provider adapters classify their own structured error surfaces before
// constructing this shared error; no provider prose classifier lives at the seam.
export enum WorkflowErrorCode {
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
  /** Provider subscription/usage/quota/rate limit. Non-recoverable => engine PAUSES (resumable), not failed. */
  PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
  /** The agent requires authentication. Non-recoverable: retrying cannot succeed until the host
   *  completes an auth flow. The machine-readable surface is `WorkflowError.authContext`
   *  (`AuthErrorContext`: advertised method ids/types/names + backendId) — hosts read that, never
   *  the human message. The enriched `.message` is retained for readability only. */
  AUTH_REQUIRED = "AUTH_REQUIRED",
  /** A durable checkpoint needs a human reply. The manager pauses the run and persists the
   *  non-secret `checkpointContext` so a host can collect and journal the decision on resume. */
  CHECKPOINT_REQUIRED = "CHECKPOINT_REQUIRED",
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  /** The workflow SCRIPT crashed at runtime: an uncaught throw or an unhandled promise
   *  rejection inside the script body. Distinct from WORKFLOW_ABORTED (someone cancelled the
   *  run) and SCRIPT_VALIDATION_ERROR (the script never parsed). Non-recoverable: rerunning
   *  the same deterministic script crashes the same way. */
  SCRIPT_ERROR = "SCRIPT_ERROR",
  /** A schema agent never produced valid structured output (after repair + extraction). Non-recoverable. */
  SCHEMA_NONCOMPLIANCE = "SCHEMA_NONCOMPLIANCE",
  /** A non-schema agent completed with no assistant text. Recoverable. */
  AGENT_EMPTY_OUTPUT = "AGENT_EMPTY_OUTPUT",
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
  PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
  /** A recording is unusable as an isolation baseline. Non-recoverable.
   *  details: { reason: string; runId?: string; indexes?: number[] }. */
  RECORDING_UNUSABLE = "RECORDING_UNUSABLE",
  /** A target could not be resolved to exactly one admissible recorded agent call.
   *  Non-recoverable. details: { target, reason, candidates? }. */
  REPLAY_TARGET_INVALID = "REPLAY_TARGET_INVALID",
  /** The re-executed script left the recording, or correspondence was unprovable.
   *  Non-recoverable. details: ReplayDivergenceEvent. */
  REPLAY_DIVERGENCE = "REPLAY_DIVERGENCE",
  UNKNOWN = "UNKNOWN",
}

/**
 * The machine-readable auth surface carried on an `AUTH_REQUIRED` `WorkflowError`. Sources ONLY
 * agent-advertised `AuthMethod` fields (ids/types/names) and the backend id — never our sent
 * `_meta`, env values, or any credential material (Principle 9). Every downstream host (engine
 * pause path, MCP `auth_required` summary, SDK `isAuthRequired` helper) reads this structurally
 * rather than parsing the enriched human message.
 */
export type AuthErrorContext = {
  backendId?: string;
  methods: { id: string; type: "agent" | "terminal" | "env_var"; name?: string }[];
};

/** Machine-readable provider-limit metadata carried by a `PROVIDER_USAGE_LIMIT` error.
 *  `resetAt` is an RFC 3339 instant derived from provider-owned numeric metadata, never prose. */
export interface ProviderUsageLimitContext {
  backendId: string;
  source: "provider" | "adapter_fallback";
  providerCode?: string;
  resetAt?: string;
}

/**
 * The structured, NON-SECRET surface of a pending durable checkpoint — persisted with a paused
 * run and shown to the host so it can collect a decision; `hash`/`callIndex` let resume inject
 * the reply as a journal entry.
 */
export interface CheckpointContext {
  callIndex: number;
  hash: string;
  prompt: string;
  kind: "confirm" | "input" | "select";
  choices?: string[];
  default?: unknown;
}

/** Strict-JSON projection of a thrown value recorded in a run's call manifest. */
export interface WorkflowRecordedError {
  /** "workflow-error" — instanceof WorkflowError; "error" — any other Error;
   *  "value" — a non-Error thrown value. */
  form: "workflow-error" | "error" | "value";
  /** Form "error": the error's name (guarded read). */
  name?: string;
  /** REQUIRED for forms "workflow-error" and "error". A guarded read that fails or
   *  yields a non-string sets lossy instead of omitting silently. */
  message?: string;
  /** Form "workflow-error": every public WorkflowError field. */
  code?: WorkflowErrorCode;
  recoverable?: boolean;
  agentLabel?: string;
  /** Strict-JSON projected. */
  details?: unknown;
  resetHint?: string;
  providerUsageLimitContext?: ProviderUsageLimitContext;
  authContext?: AuthErrorContext;
  checkpointContext?: CheckpointContext;
  /** Form "error": JSON-safe own enumerable data properties of the Error. */
  props?: Record<string, unknown>;
  /** Form "value": the thrown value, strict-JSON projected. */
  value?: unknown;
  /** True when any consumed part failed strict-JSON projection or a property read
   *  threw. Lossy rows make a recording unusable as a baseline. */
  lossy?: boolean;
}

export interface WorkflowErrorOptions {
  recoverable?: boolean;
  agentLabel?: string;
  details?: unknown;
  /** For PROVIDER_USAGE_LIMIT: a human hint synthesized from structured reset metadata. */
  resetHint?: string;
  /** For PROVIDER_USAGE_LIMIT: backend/code plus a provider-derived reset instant when available. */
  providerUsageLimitContext?: ProviderUsageLimitContext;
  /** For AUTH_REQUIRED: the structured, non-secret auth surface (advertised method ids/types/names). */
  authContext?: AuthErrorContext;
  /** For CHECKPOINT_REQUIRED: the structured, non-secret pending checkpoint surface. */
  checkpointContext?: CheckpointContext;
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;
  readonly resetHint?: string;
  readonly providerUsageLimitContext?: ProviderUsageLimitContext;
  readonly authContext?: AuthErrorContext;
  readonly checkpointContext?: CheckpointContext;

  constructor(message: string, code: WorkflowErrorCode, options: WorkflowErrorOptions = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
    this.resetHint = options.resetHint;
    this.providerUsageLimitContext = options.providerUsageLimitContext;
    this.authContext = options.authContext;
    this.checkpointContext = options.checkpointContext;
  }
}

export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}

export function isProviderUsageLimit(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
}

export function isAuthRequired(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.AUTH_REQUIRED;
}
