/**
 * Engine-local error helpers.
 *
 * The seam-level error CONTRACT (the WorkflowError runtime class, the WorkflowErrorCode
 * enum, and its guards) lives in @automatalabs/shared-types so the runner (acp-agents)
 * and this engine share ONE class — `instanceof WorkflowError` holds across packages.
 * They are re-exported here so the lifted engine modules can keep importing them from
 * "./errors.js".
 *
 * wrapError / errorMessage / isAbortError stay engine-local: they are
 * the engine's own classification/formatting of the failures it observes when calling
 * the injected runner or executing workflow code.
 */
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";

export {
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
  isAuthRequired,
} from "@automatalabs/shared-types";
export type {
  WorkflowErrorOptions,
  AuthErrorContext,
  CheckpointContext,
  ProviderUsageLimitContext,
} from "@automatalabs/shared-types";

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return readName(error) === "AbortError";
}

/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 */
export function wrapError(error: unknown, context?: { agentLabel?: string }): WorkflowError {
  if (error instanceof WorkflowError) return error;

  if (isAbortError(error)) {
    return new WorkflowError(
      errorMessage(error),
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: true },
    );
  }

  return new WorkflowError(
    errorMessage(error),
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: true, agentLabel: context?.agentLabel, details: error },
  );
}

/**
 * Best-effort text for arbitrary thrown values. All property/stringification reads are
 * guarded because workflow code can throw exotic objects (throwing getters, circular
 * structures, hostile toString) and containment must not leak leases or rejections.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = readMessage(error);
    if (message) return message;
  }
  if (error && typeof error === "object") {
    const message = readMessage(error);
    if (message) return message;
    try {
      const json = JSON.stringify(error);
      if (json) return json;
    } catch {
      // Fall through to String() for cyclic objects or exotic throwables.
    }
  }
  try {
    return String(error);
  } catch {
    return "Unknown thrown value";
  }
}

function readMessage(error: object): string | undefined {
  try {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // Fall back to JSON/String formatting for objects with hostile message getters.
  }
  return undefined;
}

function readName(error: object): string | undefined {
  try {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  } catch {
    // A hostile name getter should not escape timeout classification.
  }
  return undefined;
}
