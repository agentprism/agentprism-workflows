import { extractSkeleton } from "./skeleton.js";
import type { Skeleton } from "./skeleton.js";

/** Existing-run actions observe their input run; run/resume produce a new run id in the result. */
export function observedRunIdFromArgs(
  args: Record<string, unknown> | null,
): string | undefined {
  const action = args?.["action"];
  if (action === undefined || action === "run" || action === "resume" || action === "config") {
    return undefined;
  }
  const runId = args?.["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

/** A resume source has the same admitted script as its child run and can seed the plan view. */
export function skeletonSourceRunIdFromArgs(
  args: Record<string, unknown> | null,
): string | undefined {
  if (args?.["action"] !== "resume") return undefined;
  const runId = args["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

/**
 * Inline run scripts are already present in the MCP Apps tool input. Parse them immediately so
 * foreground calls can show the authored workflow shape before the server can return a run id.
 */
export function inlineSkeletonFromArgs(
  args: Record<string, unknown> | null,
): Skeleton | undefined {
  const action = args?.["action"];
  if (action !== undefined && action !== "run") return undefined;
  const script = args?.["script"];
  return typeof script === "string" ? extractSkeleton(script) : undefined;
}
