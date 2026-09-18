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
 * Connections and REQUESTS are tracked separately: the standalone GET stream is a connection
 * but not work, while an in-flight POST is both. A superseded (lame-duck) daemon uses the
 * distinction to migrate sessions that have nothing in flight — closing such a session costs
 * the client nothing but a transparent re-initialize on the successor — while never cutting a
 * request that is being processed.
 */
import type { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { WorkflowServer } from "../server.js";

export interface SessionRecord {
  sessionId: string;
  transport: NodeStreamableHTTPServerTransport;
  server: WorkflowServer;
  lastActivityAt: number;
  openConnections: number;
  /** Requests (POSTs) currently being processed on this session. */
  inflightRequests: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  add(record: Omit<SessionRecord, "inflightRequests"> & { inflightRequests?: number }): void {
    this.sessions.set(record.sessionId, { ...record, inflightRequests: record.inflightRequests ?? 0 });
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
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
  }

  connectionClosed(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    record.openConnections = Math.max(0, record.openConnections - 1);
    record.lastActivityAt = Date.now();
  }

  /** A request (POST) started being processed on the session. */
  requestStarted(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record !== undefined) record.inflightRequests++;
  }

  /** The request's response finished (or its connection closed). */
  requestFinished(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record !== undefined) record.inflightRequests = Math.max(0, record.inflightRequests - 1);
  }

  /** Requests being processed right now, across every session. */
  inflightCount(): number {
    let total = 0;
    for (const record of this.sessions.values()) total += record.inflightRequests;
    return total;
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

  /**
   * Close every session with NO request in flight — the lame-duck migration: the client's
   * next frame (or its standalone GET stream ending) makes it re-initialize on the successor.
   */
  evictDrainable(): string[] {
    const evicted: string[] = [];
    for (const record of this.sessions.values()) {
      if (record.inflightRequests > 0) continue;
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
