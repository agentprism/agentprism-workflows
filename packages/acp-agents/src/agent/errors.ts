// AcpAgent error helpers: SDK misuse is uniformly a WorkflowError(SCRIPT_VALIDATION_ERROR); wire
// failures go through the same `mapThrownError` ladder the runner uses; an abort is never mapped
// (the affected promise rejects with `signal.reason` untouched); a typed session failure rejects
// with the runner's mapped error carrying the complete turn.
import { WorkflowError, WorkflowErrorCode, isWorkflowError } from "@automatalabs/shared-types";
import { mapThrownError, mapTypedSessionFailure, type ErrorMapContext } from "../errors-map.js";
import type { TypedSessionFailure } from "../typed-failures.js";
import type { AcpAgentTurn, AcpAgentTurnError } from "./types.js";

/** A deterministic caller error (bad option, misuse): SCRIPT_VALIDATION_ERROR, non-recoverable. */
export function agentValidationError(message: string, label?: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
    recoverable: false,
    agentLabel: label,
  });
}

/** Every method except `close()`/`cancel()`/getters after the agent closed, aborted, or its process died. */
export function agentClosedError(label: string | undefined, backendId: string, detail?: string): WorkflowError {
  return new WorkflowError(
    `AcpAgent (${backendId}) is closed${detail ? `: ${detail}` : ""}`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label },
  );
}

/** Map a thrown wire/lifecycle error onto the seam contract — unless `signal` aborted, in which
 *  case the error is returned untouched so the caller can rethrow `signal.reason` itself. */
export function mapAgentError(error: unknown, ctx: ErrorMapContext, signal?: AbortSignal): unknown {
  if (signal?.aborted) return error;
  return mapThrownError(error, ctx);
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
