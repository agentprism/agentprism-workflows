// AcpAgent error helpers: SDK misuse is uniformly a WorkflowError(INVALID_ARGUMENT) — the SDK's
// own guards raise it directly, and a shared validator's SCRIPT_VALIDATION_ERROR (cwd, the reserved
// "model" config id, the registry, client handlers, systemPrompt support, prompt images, the
// client's mode-selection and lifecycle-capability gates) is re-coded at the agent boundary with
// its message, `recoverable=false`, `agentLabel`, and `details` preserved; wire failures go through
// the same `mapThrownError` ladder the runner uses; an abort is never mapped (the affected promise
// rejects with `signal.reason` untouched); a typed session failure rejects with the runner's
// mapped error carrying the complete turn.
import { WorkflowError, WorkflowErrorCode, isWorkflowError } from "@automatalabs/shared-types";
import { mapThrownError, mapTypedSessionFailure, type ErrorMapContext } from "../errors-map.js";
import type { TypedSessionFailure } from "../typed-failures.js";
import type { AcpAgentTurn, AcpAgentTurnError } from "./types.js";

/** A deterministic caller error (bad option, misuse): INVALID_ARGUMENT, non-recoverable. */
export function agentValidationError(message: string, label?: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.INVALID_ARGUMENT, {
    recoverable: false,
    agentLabel: label,
  });
}

/** Every method except `close()`/`cancel()`/getters after the agent closed, aborted, or its process died. */
export function agentClosedError(label: string | undefined, backendId: string, detail?: string): WorkflowError {
  return new WorkflowError(
    `AcpAgent (${backendId}) is closed${detail ? `: ${detail}` : ""}`,
    WorkflowErrorCode.INVALID_ARGUMENT,
    { recoverable: false, agentLabel: label },
  );
}

/** Re-code a shared validator's SCRIPT_VALIDATION_ERROR as the SDK's INVALID_ARGUMENT, keeping the
 *  message, `recoverable=false`, `agentLabel`, and `details`. Anything else is returned untouched
 *  — the runner and `InteractiveSession` keep SCRIPT_VALIDATION_ERROR; only the AcpAgent boundary
 *  speaks INVALID_ARGUMENT. */
export function asAgentArgumentError(error: unknown): unknown {
  if (!isWorkflowError(error) || error.code !== WorkflowErrorCode.SCRIPT_VALIDATION_ERROR) return error;
  return new WorkflowError(error.message, WorkflowErrorCode.INVALID_ARGUMENT, {
    recoverable: false,
    agentLabel: error.agentLabel,
    details: error.details,
  });
}

/** Run a synchronous validation block; a shared validator's SCRIPT_VALIDATION_ERROR surfaces as
 *  INVALID_ARGUMENT, everything else propagates as thrown. */
export function validateArguments<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw asAgentArgumentError(error);
  }
}

/** Map a thrown wire/lifecycle error onto the seam contract — unless `signal` aborted, in which
 *  case the error is returned untouched so the caller can rethrow `signal.reason` itself. A
 *  validation error the client raised on the agent's behalf (mode selection, a lifecycle
 *  capability the agent does not advertise) is re-coded as INVALID_ARGUMENT. */
export function mapAgentError(error: unknown, ctx: ErrorMapContext, signal?: AbortSignal): unknown {
  if (signal?.aborted) return error;
  return asAgentArgumentError(mapThrownError(error, ctx));
}

/** The `prompt()` rejection for a walled turn: `mapTypedSessionFailure` (codes/recoverable/details
 *  unchanged) with the complete `AcpAgentTurn` attached as `error.turn`. */
export function agentTurnError(
  failure: TypedSessionFailure,
  turn: AcpAgentTurn,
  ctx: ErrorMapContext,
): AcpAgentTurnError {
  const mapped = mapTypedSessionFailure(failure, ctx);
  Object.defineProperty(mapped, "turn", { value: turn, enumerable: false, writable: false, configurable: false });
  return mapped as AcpAgentTurnError;
}

/** Narrow a `prompt()` rejection to the typed-session-failure shape that carries the turn. */
export function isAcpAgentTurnError(error: unknown): error is AcpAgentTurnError {
  return (
    isWorkflowError(error) &&
    typeof (error as { turn?: unknown }).turn === "object" &&
    (error as { turn?: unknown }).turn !== null
  );
}
