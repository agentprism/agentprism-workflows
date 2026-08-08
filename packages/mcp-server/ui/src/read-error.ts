// Classification of a resource-read failure for the run-monitor panel (main.tsx onReadError and
// useSkeleton). Kept out of the React effect so the branch table is unit-testable without a DOM or
// a live host — the same way poll-backoff.ts holds the timing policy.
//
// The decisive case is HOST_NO_APP_RESOURCES: some MCP-Apps hosts never wired resources/read for
// app-originated requests. pi is the measured example — its host bridge answers app-originated
// resources/read with JSON-RPC -32601 "Method not found" for BOTH the canonical and query URI forms
// (pi-mcp-adapter 2.21.0, constructed with a null client and no serverResources capability). That is
// a PERMANENT property of the host, NOT a transient fault: it must never feed degrade() (which would
// spin "reconnecting…" for ~42s and then latch "disconnected — updates stopped"). Instead the panel
// switches to the pi push channel or the honest static fallback. Classify by the ERROR CODE, never by
// string-matching the message: the measured shape is name:"McpError", code:-32601.

/** JSON-RPC "Method not found" — a host with no app-originated resources/read answers reads with it. */
export const METHOD_NOT_FOUND_CODE = -32601;

export type ReadErrorClass =
  /** Stream generation changed (run deleted/recreated): rebuild and re-bootstrap. */
  | "stream-rebuild"
  /** The run is gone from the store for good: fatal, stop reading. */
  | "run-not-found"
  /** The host does not serve app-originated resource reads at all: permanent, switch modes. */
  | "host-no-app-resources"
  /** Anything else: a genuinely transient fault on a host where reads can succeed — degrade/retry. */
  | "transient";

/** Extract a numeric JSON-RPC error code from an unknown thrown value (McpError carries `.code`). */
export function readErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

/**
 * Classify a resource-read rejection. Message-specific faults (stream rebuild, run-not-found) are
 * matched first because they are authored by our own server with stable tokens; the host-capability
 * case is then decided purely by the -32601 code so a message reword can never misroute it.
 */
export function classifyReadError(error: unknown): ReadErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("STREAM_MISMATCH") || message.includes("CURSOR_AHEAD")) return "stream-rebuild";
  if (
    message.includes("RUN_NOT_FOUND") ||
    message.includes("ORPHANED_LOG") ||
    message.includes("No workflow run found")
  ) {
    return "run-not-found";
  }
  if (readErrorCode(error) === METHOD_NOT_FOUND_CODE) return "host-no-app-resources";
  return "transient";
}
