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

  add(record: SessionRecord): void {
    this.sessions.set(record.sessionId, record);
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
