// @automatalabs/shared-types — the ONLY module BOTH workflow-engine and acp-agents
// import (they never import each other; mcp-server is the sole composition root).
// Zero Pi / ACP / MCP deps; depends only on `typebox` (type-level for TSchema/Static)
// + carries the WorkflowError RUNTIME class so `instanceof` holds across packages.
// Presented as the package's files, each compilable on its own.

// ===== packages/shared-types/src/errors.ts =====
// The seam-level ERROR contract. Lives HERE (not in the engine) because the runner
// (acp-agents) THROWS these and the engine reads .code + .recoverable via instanceof —
// both sides MUST import the SAME class. Adapted from pi errors.ts (enum + WorkflowError
// class + guards + the PURE, dependency-free classifyProviderLimit text classifier).
// classifyProviderLimit is SHARED because its PRIMARY caller is the runner (acp-agents
// raises PROVIDER_USAGE_LIMIT + resetHint) and the engine's wrapError uses it only as
// defense-in-depth — both import ONE source so they can never diverge. The engine-local
// wrapError/isAbortError/isTimeoutError stay in workflow-engine and import the classifier
// from here.
export enum WorkflowErrorCode {
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
  /** Provider subscription/usage/quota/rate limit. Non-recoverable => engine PAUSES (resumable), not failed. Carries resetHint. */
  PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
  /** The agent requires authentication. Non-recoverable: retrying cannot succeed until the host
   *  completes an auth flow. The machine-readable surface is `WorkflowError.authContext`
   *  (`AuthErrorContext`: advertised method ids/types/names + backendId) — hosts read that, never
   *  the human message. The enriched `.message` is retained for readability only. */
  AUTH_REQUIRED = "AUTH_REQUIRED",
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

export interface WorkflowErrorOptions {
  recoverable?: boolean;
  agentLabel?: string;
  details?: unknown;
  /** For PROVIDER_USAGE_LIMIT: the provider's human reset hint, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  /** For AUTH_REQUIRED: the structured, non-secret auth surface (advertised method ids/types/names). */
  authContext?: AuthErrorContext;
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;
  readonly resetHint?: string;
  readonly authContext?: AuthErrorContext;

  constructor(message: string, code: WorkflowErrorCode, options: WorkflowErrorOptions = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
    this.resetHint = options.resetHint;
    this.authContext = options.authContext;
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

/**
 * Detect a provider subscription/usage/quota/rate-limit exhaustion from free-form
 * error text, and extract the provider's human reset hint when present. PURE +
 * dependency-free — lifted verbatim from pi errors.ts:77-86. SHARED so the runner
 * (acp-agents — PRIMARY caller, raises PROVIDER_USAGE_LIMIT) and the engine's wrapError
 * (defense-in-depth) classify against ONE table and can never diverge.
 *
 * Callers reading SDK message metadata MUST gate on stopReason === "error" before
 * trusting this, so a task whose own output merely mentions "rate limit" is never
 * misclassified. Patterns mirror the SDK's non-retryable-limit table; transient
 * overloaded/5xx errors are deliberately excluded (they stay recoverable and keep retrying).
 */
export function classifyProviderLimit(text: string | undefined): { matched: boolean; resetHint?: string } {
  if (!text) return { matched: false };
  const matched =
    /usage limit|limit reached|insufficient[_\s]?quota|quota exceeded|exceeded your current quota|out of budget|available balance|\bquota\b|rate.?limit|too many requests|\b429\b|GoUsageLimitError|FreeUsageLimitError|\bbilling\b/i.test(
      text,
    );
  if (!matched) return { matched: false };
  const reset = text.match(/resets?\s+(?:in|at)\s+[^.\n]+/i);
  return { matched: true, resetHint: reset?.[0]?.trim() };
}
