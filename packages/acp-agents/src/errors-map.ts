// ACP failure -> WorkflowError{code, recoverable, resetHint}.
//
// Every hard backend failure REJECTS the ACP request (claude-agent-acp `failActive(...)`,
// codex-acp request errors), so the runner catches one thrown error and classifies it HERE.
// Provider usage/quota/rate walls are detected by running the thrown error's MESSAGE through
// classifyProviderLimit (shared-types) — this is the "gate on the error channel, never task
// text" rule: we only ever classify text that arrived via an error/reject, never the
// assistant's normal output. A matched wall becomes PROVIDER_USAGE_LIMIT (non-recoverable +
// resetHint -> the engine PAUSES and resumes instead of retrying into the same wall).
// Everything else is a recoverable AGENT_EXECUTION_ERROR (transient process/ACP faults that
// the engine retries). WorkflowErrors raised inside the ladder (SCHEMA_NONCOMPLIANCE,
// AGENT_EMPTY_OUTPUT) pass through unchanged.
import { classifyProviderLimit, isWorkflowError, WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { AuthMethod } from "@agentclientprotocol/sdk";

export const ACP_AUTH_REQUIRED_ERROR_CODE = -32000;

export interface ErrorMapContext {
  label?: string;
  backendId?: string;
  authMethods?: readonly AuthMethod[];
}

export function errorText(error: unknown): string {
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

/** Map any thrown error from the run path onto a seam-level WorkflowError. */
export function mapThrownError(error: unknown, labelOrContext?: string | ErrorMapContext): WorkflowError {
  // Already a seam error (e.g. SCHEMA_NONCOMPLIANCE / AGENT_EMPTY_OUTPUT raised in-band).
  if (isWorkflowError(error)) return error;

  const context = typeof labelOrContext === "string" ? { label: labelOrContext } : (labelOrContext ?? {});
  const message = errorText(error);
  if (isAcpAuthRequired(error, message)) {
    return new WorkflowError(authRequiredMessage(message, context), WorkflowErrorCode.AUTH_REQUIRED, {
      recoverable: false,
      agentLabel: context.label,
      details: error,
    });
  }

  const { matched, resetHint } = classifyProviderLimit(message);
  if (matched) {
    return new WorkflowError(
      message || "Provider usage/quota limit reached",
      WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
      { recoverable: false, agentLabel: context.label, resetHint, details: error },
    );
  }

  return new WorkflowError(message || "Subagent execution failed", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
    recoverable: true,
    agentLabel: context.label,
    details: error,
  });
}

function isAcpAuthRequired(error: unknown, message: string): boolean {
  return (
    Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === ACP_AUTH_REQUIRED_ERROR_CODE) &&
    /^Authentication required\b/i.test(message)
  );
}

function authRequiredMessage(message: string, context: ErrorMapContext): string {
  const backend = context.backendId ? ` (${context.backendId})` : "";
  const detail = message.replace(/^Authentication required:?\s*/i, "").trim();
  const methodIds = (context.authMethods ?? []).map((method) => method.id).filter(Boolean);
  const hint = methodIds.length > 0 ? `; run authenticate() with one of: ${methodIds.join(", ")}` : "";
  return `ACP agent${backend} requires authentication${detail ? `: ${detail}` : ""}${hint}`;
}
