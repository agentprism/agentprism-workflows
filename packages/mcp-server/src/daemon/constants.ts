/** Shared constants for the AgentPrism workflow daemon and its stdio shim. */

export const DAEMON_NAME = "agentprism-daemon";

/** Single MCP endpoint path required by the Streamable HTTP transport spec. */
export const MCP_ENDPOINT_PATH = "/mcp";
/** Non-MCP identity/stats probe used by the shim and `daemon status`. */
export const HEALTHZ_PATH = "/healthz";

export const DEFAULT_DAEMON_PORT = 29888;
export const DAEMON_PORT_ENV = "AGENTPRISM_DAEMON_PORT";

/** Comma-separated exact-match Origin allowlist beyond the loopback defaults. */
export const DAEMON_ALLOWED_ORIGINS_ENV = "AGENTPRISM_DAEMON_ALLOWED_ORIGINS";

/**
 * Daemon exits after this long with zero sessions and zero active runs. 0 disables. A
 * SUPERSEDED daemon (a newer one owns its family's discovery) does not wait for this: it exits
 * as soon as nothing is in flight.
 */
export const DAEMON_IDLE_TTL_MS = 15 * 60_000;
export const DAEMON_IDLE_TTL_ENV = "AGENTPRISM_DAEMON_IDLE_TTL_MS";

/**
 * A session with no open connections and no requests for this long is evicted. Live clients
 * hold the standalone GET stream (or an in-flight POST), so only dead clients that never sent
 * the spec's DELETE trip this; the shim recovers from eviction via 404 re-initialize anyway.
 * The SDK client gives up re-opening a dropped GET stream within seconds, so a session that
 * stayed connection-less for minutes belongs to a dead client — and every such session keeps
 * the daemon alive (it counts as busy), so the TTL is short.
 */
export const SESSION_IDLE_TTL_MS = 5 * 60_000;
export const SESSION_IDLE_TTL_ENV = "AGENTPRISM_SESSION_TTL_MS";

/**
 * The REPL client-presence drain bound: after a project's last client disconnects, in-flight
 * subagent turns may drain for up to this long before idle children are closed. Its own knob,
 * deliberately decoupled from the session-eviction TTL above (the two used to share one
 * constant, which forced dead-client eviction to wait hours).
 */
export const REPL_DRAIN_BOUND_MS = 2 * 60 * 60_000;
export const REPL_DRAIN_BOUND_ENV = "AGENTPRISM_REPL_DRAIN_BOUND_MS";

export const REAPER_INTERVAL_MS = 60_000;

export const EVENT_STORE_MAX_EVENTS_PER_STREAM = 1_000;
export const EVENT_STORE_MAX_TOTAL_EVENTS = 10_000;

/** How long the shim waits for a freshly spawned daemon to report healthy. */
export const SPAWN_HEALTH_TIMEOUT_MS = 10_000;
