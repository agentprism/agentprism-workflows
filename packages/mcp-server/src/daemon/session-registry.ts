/**
 * The daemon's session table: one StreamableHTTPServerTransport + one WorkflowServer per
 * MCP session, keyed by the spec's Mcp-Session-Id.
 *
 * Liveness is connection presence, not recent traffic: a live client always holds an open
 * connection (the standalone GET stream, or an in-flight POST), and the kernel closes those
 * sockets when the client process dies. Idle eviction therefore only collects sessions with
 * zero open connections that also went quiet — dead clients that never sent the spec's
 * DELETE. Eviction closes the transport; runs are unaffected (they live in the per-project
 * manager), and a wrongly-evicted client re-initializes on the spec's 404.
 *
 * The presence signals are tri-state, and the REPL ledger needs all three (the roadmap
 * doc's client-presence policy):
 *
 * - `onConnectionOpened` — a connection opened on a live session. A TRANSIENT drop of the
 *   standalone GET stream closes the session's LAST connection (the signal below) but the
 *   session itself is still alive; when the client reconnects, this signal re-adds its
 *   presence (the ledger keeps the session's project affinity across the drop, so the
 *   reconnect restores presence WITHOUT a new tool call — a scheduled drain must not close
 *   children while that client is connected).
 * - `onLastConnectionClosed` — the session's LAST open connection closed (or the session
 *   was deleted): the client is gone, project presence is removed, and the REPL drain
 *   policy evaluates.
 * - `onSessionDeleted` — the session record is gone outright (DELETE, transport close,
 *   eviction): the ledger drops the session's retained project affinity (a re-initialized
 *   client gets a NEW session id and must re-touch projects).
 */

import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { WorkflowServer } from "../server.js";

export interface SessionRecord {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: WorkflowServer;
  lastActivityAt: number;
  openConnections: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  /**
   * Fired when a connection OPENS on a live session — the daemon's
   * client-RECONNECT signal. The daemon wires it to the REPL presence
   * ledger, which re-adds the session's project presence from its
   * retained affinity (see `repl-presence.ts`): a transient GET drop
   * followed by a reconnect of the SAME session must not leave the
   * session's projects draining while the client is connected
   * (phase-E review rejection: only disconnects were wired, so a
   * reconnect did not restore presence until the client's next tool
   * call — the already-scheduled drain could close children while that
   * client was connected).
   */
  onConnectionOpened: ((sessionId: string) => void) | undefined;
  /**
   * Fired when a session's LAST open connection closed (or the session
   * was deleted outright) — the daemon's client-presence signal. The
   * daemon wires it to the REPL presence ledger, which drains projects
   * whose client set became empty (the roadmap doc's last-client-
   * disconnect drain; phase-D review round 2: the registry used to
   * maintain connection counts without ever signaling project REPL
   * lifecycle).
   */
  onLastConnectionClosed: ((sessionId: string) => void) | undefined;
  /**
   * Fired when the session record is deleted (DELETE, transport close,
   * eviction) — the daemon's session-GONE signal. The daemon wires it
   * to the REPL presence ledger, which drops the session's retained
   * project affinity (the session can never reconnect; a re-initialized
   * client carries a new session id). Fired AFTER
   * `onLastConnectionClosed` (the disconnect's drain evaluation needs
   * the affinity to remove the session's presence from its projects
   * first).
   */
  onSessionDeleted: ((sessionId: string) => void) | undefined;

  add(record: SessionRecord): void {
    this.sessions.set(record.sessionId, record);
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    // Disconnect FIRST (the ledger's presence removal walks the
    // session's retained project affinity), then drop the affinity
    // itself.
    this.onLastConnectionClosed?.(sessionId);
    this.onSessionDeleted?.(sessionId);
  }

  touch(sessionId: string, now = Date.now()): void {
    const record = this.sessions.get(sessionId);
    if (record !== undefined) record.lastActivityAt = now;
  }

  connectionOpened(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    record.openConnections++;
    record.lastActivityAt = Date.now();
    // A connection opened on a live session: the client (re)connected
    // — restore its project presence (the ledger re-adds it from the
    // retained affinity).
    this.onConnectionOpened?.(sessionId);
  }

  connectionClosed(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    record.openConnections = Math.max(0, record.openConnections - 1);
    record.lastActivityAt = Date.now();
    if (record.openConnections === 0) {
      // The last connection closed: the client is gone (a live client
      // always holds an open connection — the standalone GET stream or
      // an in-flight POST). Signal the lifecycle hook.
      this.onLastConnectionClosed?.(sessionId);
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  values(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  /** Close (and thereby unregister, via transport.onclose) every idle dead-client session. */
  evictIdle(ttlMs: number, now = Date.now()): string[] {
    const evicted: string[] = [];
    for (const record of this.sessions.values()) {
      if (record.openConnections > 0) continue;
      if (now - record.lastActivityAt <= ttlMs) continue;
      evicted.push(record.sessionId);
      void record.transport.close().catch(() => undefined);
    }
    return evicted;
  }

  async closeAll(): Promise<void> {
    const records = [...this.sessions.values()];
    await Promise.allSettled(records.map((record) => record.transport.close()));
    this.sessions.clear();
  }
}
