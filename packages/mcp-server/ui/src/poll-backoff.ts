// Pure timing and stop-condition policy for the run-monitor event poll (main.tsx useRunModel).
// Kept out of the React effect so the backoff and give-up rules can be unit-tested without a DOM,
// fake timers, or a live host.

/** Base live-poll cadence (2s) — matches the ext-apps "Polling for live data" pattern. */
export const POLL_MS = 2000;
/** Backoff cap shared by idle polls and error retries: a quiet or unreachable run is read at most
 *  this often. */
export const MAX_BACKOFF_MS = 15_000;
/** Consecutive read faults tolerated before the panel gives up for good and renders disconnected,
 *  rather than retrying a long-gone run forever at the backoff cap. */
export const MAX_POLL_FAILURES = 5;

export type PollFailureKind = "rebuild" | "run-not-found" | "retry";

/** Classify tool failures without changing the poll loop's established recovery semantics. */
export function classifyPollFailure(error: unknown): PollFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("STREAM_MISMATCH") || message.includes("CURSOR_AHEAD")) return "rebuild";
  if (
    message.includes("RUN_NOT_FOUND") ||
    message.includes("ORPHANED_LOG") ||
    message.includes("No workflow run found")
  ) {
    return "run-not-found";
  }
  return "retry";
}

/**
 * Next delay for a live (non-finalized) poll. A poll that brought new events resets to the base
 * cadence; an idle poll (cursor unchanged, zero new events) doubles the delay toward the cap, so a
 * quiet or paused run is polled 2s → 4s → 8s → 15s instead of every 2s forever.
 */
export function nextIdleDelayMs(currentMs: number, gotEvents: boolean): number {
  return gotEvents ? POLL_MS : Math.min(currentMs * 2, MAX_BACKOFF_MS);
}

/** Next error-retry delay after a read fault: double the current delay toward the cap. */
export function nextErrorBackoffMs(currentMs: number): number {
  return Math.min(currentMs * 2, MAX_BACKOFF_MS);
}

/**
 * True once consecutive read faults reach the bound. The poll loop then stops for good and the
 * panel renders a disconnected/stale state instead of retrying a dead run indefinitely.
 */
export function shouldGiveUp(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_POLL_FAILURES;
}
