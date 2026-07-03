/**
 * Engine-local error helpers.
 *
 * The seam-level error CONTRACT (the WorkflowError runtime class, the
 * WorkflowErrorCode enum, isWorkflowError/isProviderUsageLimit, and the pure
 * classifyProviderLimit text classifier) lives in @automatalabs/shared-types so the
 * runner (acp-agents) and this engine share ONE class — `instanceof WorkflowError`
 * holds across packages. They are re-exported here so the lifted engine modules can
 * keep importing them from "./errors.js".
 *
 * wrapError / isAbortError / isTimeoutError stay engine-local: they are the engine's
 * own classification of the failures it observes when calling the injected runner.
 */
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";

export {
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
  classifyProviderLimit,
} from "@automatalabs/shared-types";
export type { WorkflowErrorOptions } from "@automatalabs/shared-types";

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\btimeout\b/i.test(error.message) || error.name === "TimeoutError";
}

/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 */
export function wrapError(error: unknown, context?: { agentLabel?: string }): WorkflowError {
  if (error instanceof WorkflowError) return error;

  if (isAbortError(error)) {
    return new WorkflowError(
      error instanceof Error ? error.message : "Workflow was aborted",
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: true },
    );
  }

  if (isTimeoutError(error)) {
    return new WorkflowError(
      error instanceof Error ? error.message : "Agent timed out",
      WorkflowErrorCode.AGENT_TIMEOUT,
      { recoverable: true, agentLabel: context?.agentLabel },
    );
  }

  // Defense-in-depth: the runner normally raises PROVIDER_USAGE_LIMIT itself, but a
  // backend might throw a raw provider error. Classify a thrown limit here too —
  // recoverable:false so the run checkpoints (paused) instead of being retried into
  // the same wall or silently nulled.
  if (error instanceof Error) {
    const limit = classifyProviderLimit(error.message);
    if (limit.matched) {
      return new WorkflowError(error.message, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
        agentLabel: context?.agentLabel,
        resetHint: limit.resetHint,
      });
    }
  }

  return new WorkflowError(
    errorMessage(error),
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: true, agentLabel: context?.agentLabel, details: error },
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
    try {
      const json = JSON.stringify(error);
      if (json) return json;
    } catch {
      // Fall through to String() for cyclic objects or exotic throwables.
    }
  }
  return String(error);
}
