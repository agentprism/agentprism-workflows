// ACP failure -> WorkflowError{code, recoverable, providerUsageLimitContext}.
//
// Every hard backend failure REJECTS the ACP request (claude-agent-acp `failActive(...)`,
// codex-acp request errors), so the runner catches one thrown error and classifies it HERE.
// Provider usage/quota/rate walls arrive as an adapter-owned structured discriminant. A wall
// becomes PROVIDER_USAGE_LIMIT (non-recoverable -> the engine PAUSES and resumes instead of
// retrying into the same wall). Any unavoidable provider-prose fallback lives inside the
// concrete adapter, never in this generic mapper or the workflow engine.
// Everything else is a recoverable AGENT_EXECUTION_ERROR (transient process/ACP faults that
// the engine retries). WorkflowErrors raised inside the ladder (SCHEMA_NONCOMPLIANCE,
// AGENT_EMPTY_OUTPUT) pass through unchanged.
import { isWorkflowError, WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { AuthErrorContext } from "@automatalabs/shared-types";
import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { Backend, ProviderErrorClassification, ProviderErrorMetadata } from "./backend.js";

export const ACP_AUTH_REQUIRED_ERROR_CODE = -32000;

// JSON-RPC codes the SDK reserves for NON-auth failures (jsonrpc.js:764-829). A different reserved
// code that merely mentions the auth phrase must NEVER mis-route to pause-for-auth. -32000 is
// deliberately EXCLUDED — it is the primary auth code (reserved exclusively for authRequired,
// jsonrpc.js:818-823) and is matched code-only above the fallback.
const OTHER_RESERVED = new Set([-32700, -32600, -32601, -32602, -32603, -32800, -32002]);

export interface ErrorMapContext {
  label?: string;
  backendId?: string;
  backend?: Backend;
  providerErrorMetadata?: ProviderErrorMetadata;
  authMethods?: readonly AuthMethod[];
}

export function errorText(error: unknown): string {
  const base = baseErrorText(error);
  // A JSON-RPC RequestError can carry only a generic channel label in `.message` ("Internal error")
  // while the provider's real text lives in the structured `.data` (codex-acp's usageLimitExceeded
  // wraps the quota/reset text as RequestError.internalError({ message }) => code -32603, message
  // "Internal error", text in `.data.message`). That `.data` is still the ERROR channel — a rejected
  // request's payload, never task output — so fold its `message`/`details` into the classifiable
  // text. Backend-generic: any ACP agent that stuffs detail into `.data` benefits.
  const detail = errorDataText(error);
  if (detail && !base.includes(detail)) return base ? `${base}: ${detail}` : detail;
  return base;
}

function baseErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function errorDataText(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return "";
  const parts: string[] = [];
  for (const key of ["message", "details"] as const) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  }
  return parts.join(": ");
}

/** Map any thrown error from the run path onto a seam-level WorkflowError. */
export function mapThrownError(error: unknown, labelOrContext?: string | ErrorMapContext): WorkflowError {
  // Already a seam error (e.g. SCHEMA_NONCOMPLIANCE / AGENT_EMPTY_OUTPUT raised in-band).
  if (isWorkflowError(error)) return error;

  const context = typeof labelOrContext === "string" ? { label: labelOrContext } : (labelOrContext ?? {});
  const message = errorText(error);
  if (isAcpAuthRequired(error, message)) {
    // authContext sources ONLY agent-advertised AuthMethod fields (ids/types/names) — never our
    // sent _meta/env values (Principle 9). This is the machine-readable contract every downstream
    // host reads; the enriched message is human-readable only.
    const methods: AuthErrorContext["methods"] = (context.authMethods ?? []).map((m) => ({
      id: m.id,
      // AuthMethodAgent carries no `type` field (the SDK treats a missing discriminant as "agent").
      type: ("type" in m ? m.type : undefined) ?? "agent",
      name: m.name,
    }));
    return new WorkflowError(authRequiredMessage(message, context), WorkflowErrorCode.AUTH_REQUIRED, {
      recoverable: false,
      agentLabel: context.label,
      authContext: { backendId: context.backendId, methods },
      details: error,
    });
  }

  const providerError = classifyProviderError(error, context);
  if (providerError?.kind === "provider_usage_limit") {
    const resetHint = providerError.context.resetAt
      ? `Resets at ${providerError.context.resetAt}`
      : undefined;
    return new WorkflowError(
      message || "Provider usage/quota limit reached",
      WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
      {
        recoverable: false,
        agentLabel: context.label,
        resetHint,
        providerUsageLimitContext: providerError.context,
        details: error,
      },
    );
  }

  return new WorkflowError(message || "Subagent execution failed", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
    recoverable: true,
    agentLabel: context.label,
    details: error,
  });
}

function classifyProviderError(
  error: unknown,
  context: ErrorMapContext,
): ProviderErrorClassification | undefined {
  try {
    return context.backend?.classifyProviderError?.(error, context.providerErrorMetadata);
  } catch {
    // A hostile thrown object must remain a recoverable execution error, not escape containment.
    return undefined;
  }
}

function isAcpAuthRequired(error: unknown, message: string): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // PRIMARY (spec-faithful): -32000 is reserved EXCLUSIVELY for authRequired (jsonrpc.js:818-823;
  // no other constructor in jsonrpc.js:764-829 emits it). Code alone, ANY message — this unblocks
  // conformant agents that localize or rephrase the text.
  if (code === ACP_AUTH_REQUIRED_ERROR_CODE) return true;
  // FALLBACK: a non-conformant agent that signals auth in prose without the reserved code. A
  // DIFFERENT reserved code that merely mentions the phrase must NEVER mis-route to pause-for-auth.
  return typeof code === "number"
    ? !OTHER_RESERVED.has(code) && /\bauthentication required\b/i.test(message)
    : /\bauthentication required\b/i.test(message);
}

function authRequiredMessage(message: string, context: ErrorMapContext): string {
  const backend = context.backendId ? ` (${context.backendId})` : "";
  const detail = message.replace(/^Authentication required:?\s*/i, "").trim();
  const methodIds = (context.authMethods ?? []).map((method) => method.id).filter(Boolean);
  const hint = methodIds.length > 0 ? `; run authenticate() with one of: ${methodIds.join(", ")}` : "";
  return `ACP agent${backend} requires authentication${detail ? `: ${detail}` : ""}${hint}`;
}
