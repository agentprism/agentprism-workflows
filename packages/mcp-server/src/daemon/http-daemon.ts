/**
 * The workflow daemon's HTTP face: a plain node:http server on loopback exposing the single
 * MCP endpoint required by the Streamable HTTP spec (2025-11-25), plus a non-MCP /healthz
 * identity probe. One StreamableHTTPServerTransport + WorkflowServer per session (the SDK
 * transport is single-session by design), all sessions of a project sharing that project's
 * WorkflowManager and BackgroundRunRegistry.
 *
 * The SDK transport owns the spec mechanics — session id issuance, 400-on-missing-session,
 * protocol-version validation, DELETE termination, SSE priming/resume via the injected
 * EventStore. This module owns what the SDK deliberately leaves outside: routing by
 * Mcp-Session-Id (including the spec's 404 for unknown sessions, which tells clients to
 * re-initialize), Origin/Host validation, and project binding.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentRunner } from "@automatalabs/shared-types";
import type { BrokerRunner, EvalBreakChannel } from "@automatalabs/repl-engine";

import { createWorkflowServer, SERVER_VERSION } from "../server.js";
import { WorkflowProjectRegistry } from "../project-registry.js";
import { ReplPresenceLedger } from "../repl-presence.js";
import { DAEMON_NAME, HEALTHZ_PATH, MCP_ENDPOINT_PATH, SESSION_IDLE_TTL_MS } from "./constants.js";
import { envFingerprint } from "./daemon-info.js";
import { BoundedEventStore } from "./event-store.js";
import { validateRequest } from "./middleware.js";
import { SessionRegistry } from "./session-registry.js";

export interface CreateDaemonOptions {
  runner: AgentRunner;
  /** 0 binds an ephemeral port (tests); the actually bound port is on the handle. */
  port: number;
  host?: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /**
   * The REPL workspaces' ACP runner (the broker's structural seam;
   * omitted: every workspace's broker owns its own `AcpAgentRunner`).
   */
  replRunner?: BrokerRunner;
  /**
   * The concrete REPL client-presence drain bound (the doc's spec-owed
   * decision): the daemon REUSES its session-eviction TTL — a project
   * whose last client disconnected drains its in-flight subagent turns
   * up to this bound, then closes idle children. Defaults to
   * `SESSION_IDLE_TTL_MS` (the same knob the session registry evicts
   * dead clients with).
   */
  sessionTtlMs?: number;
  /** The REPL eval-break relay (phase-F review round 2; see
   *  repl-engine's `EvalBreakChannel`): the worker-thread channel whose
   *  loopback endpoint the shim fires while the daemon's main thread is
   *  blocked in a synchronous eval. Omitted in single-project mode
   *  (there is no separate shim to fire it — the per-eval deadline
   *  remains the bound). */
  evalBreakChannel?: EvalBreakChannel;
}

export interface DaemonHandle {
  port: number;
  url: string;
  startedAt: string;
  sessions: SessionRegistry;
  projects: WorkflowProjectRegistry;
  activeRunCount(): number;
  /**
   * The number of REPL workspaces with a client-presence drain scheduled
   * or in flight (the daemon idleness accounting seam — phase-E review
   * rejection round 2: a drain may legitimately run for the full
   * session-eviction TTL after the last session is gone, and the idle
   * shutdown must never replace that bound with the shutdown deadline).
   */
  activeReplDrainCount(): number;
  close(): Promise<void>;
}

export class DaemonPortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already in use`);
    this.name = "DaemonPortInUseError";
  }
}

function writeJsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function createDaemon(options: CreateDaemonOptions): Promise<DaemonHandle> {
  const host = options.host ?? "127.0.0.1";
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));
  const startedAt = new Date().toISOString();

  const sessions = new SessionRegistry();
  // ONE registry shared by every session: run calls select their project via the required
  // projectDir tool argument, and all sessions see all projects' runs.
  const projects = new WorkflowProjectRegistry(options.runner);
  // The REPL client-presence ledger: every session touches the projects it addresses; on
  // last-connection-closed a project with no clients left is drained (the doc's
  // client-presence policy; the bound reuses the session-eviction TTL).
  const replPresence = new ReplPresenceLedger(options.sessionTtlMs ?? SESSION_IDLE_TTL_MS);
  // The three presence signals (phase-E review rejection: only the
  // disconnect was wired — a transient standalone-GET drop followed by a
  // reconnect of the SAME live session used to leave the session's
  // projects draining while the client was connected, because the
  // reconnect never re-added its presence). A connection OPEN re-adds
  // the session's project presence from its retained affinity; the
  // last-connection-closed removes presence and schedules the drain; a
  // session DELETE drops the retained affinity.
  sessions.onConnectionOpened = (sessionId) => replPresence.reconnect(sessionId);
  sessions.onLastConnectionClosed = (sessionId) => replPresence.disconnect(sessionId);
  sessions.onSessionDeleted = (sessionId) => replPresence.forget(sessionId);
  let boundPort = options.port;

  const handleMcpRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;

    if (sessionId !== undefined) {
      const record = sessions.get(sessionId);
      if (record === undefined) {
        // Spec: after termination the server MUST 404 the old session id; the client MUST
        // then re-initialize. This is also the recovery path after a daemon restart.
        writeJsonRpcError(res, 404, "Session not found; re-initialize");
        return;
      }
      sessions.connectionOpened(sessionId);
      res.on("close", () => sessions.connectionClosed(sessionId));
      await record.transport.handleRequest(req, res);
      return;
    }

    // No session header: this must be an initialize request (the SDK transport 400s
    // anything else). Sessions are project-agnostic — every run call names its project.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: new BoundedEventStore(),
      onsessioninitialized: (sid) => {
        sessions.add({
          sessionId: sid,
          transport,
          server,
          lastActivityAt: Date.now(),
          openConnections: 0,
        });
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
      },
    });
    const server = createWorkflowServer(options.runner, {
      projects,
      requireProjectDir: true,
      replRunner: options.replRunner,
      replPresence,
      replClientId: () => transport.sessionId,
      replDrainBoundMs: options.sessionTtlMs ?? SESSION_IDLE_TTL_MS,
      replEvalBreakChannel: options.evalBreakChannel,
    });
    await server.connect(transport);
    // The SDK protocol layer takes ownership of transport.onclose during connect, so chain
    // (not set) our registry cleanup after it — the same dance as installMcpServerLifecycle.
    const protocolOnClose = transport.onclose;
    transport.onclose = () => {
      try {
        protocolOnClose?.();
      } catch {
        // Registry cleanup must run even if a protocol close hook throws.
      }
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };
    await transport.handleRequest(req, res);
    if (transport.sessionId !== undefined && !res.closed) {
      sessions.connectionOpened(transport.sessionId);
      res.on("close", () => {
        if (transport.sessionId !== undefined) sessions.connectionClosed(transport.sessionId);
      });
    }
  };

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const verdict = validateRequest(req.headers, boundPort, env);
      if (!verdict.ok) {
        writeJsonRpcError(res, verdict.status, verdict.message);
        return;
      }
      const url = new URL(req.url ?? "/", `http://${host}:${boundPort}`);
      if (url.pathname === HEALTHZ_PATH && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            name: DAEMON_NAME,
            version: SERVER_VERSION,
            pid: process.pid,
            port: boundPort,
            startedAt,
            sessions: sessions.size,
            activeRuns: projects.activeRunCount(),
            envFingerprint: envFingerprint(env),
            projects: projects.snapshot(),
          }),
        );
        return;
      }
      if (url.pathname !== MCP_ENDPOINT_PATH) {
        writeJsonRpcError(res, 404, "Not Found");
        return;
      }
      await handleMcpRequest(req, res);
    })().catch((error: unknown) => {
      log(`[${DAEMON_NAME}] request failed: ${String(error)}`);
      if (!res.headersSent) writeJsonRpcError(res, 500, "Internal error");
      else res.end();
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    httpServer.once("error", (error: NodeJS.ErrnoException) => {
      rejectPromise(error.code === "EADDRINUSE" ? new DaemonPortInUseError(options.port) : error);
    });
    httpServer.listen(options.port, host, () => resolvePromise());
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Daemon HTTP server bound to a non-TCP address");
  }
  boundPort = address.port;

  return {
    port: boundPort,
    url: `http://${host}:${boundPort}${MCP_ENDPOINT_PATH}`,
    startedAt,
    sessions,
    projects,
    activeRunCount: () => projects.activeRunCount(),
    activeReplDrainCount: () => replPresence.drainingCount(),
    async close() {
      const closed = new Promise<void>((resolvePromise) => {
        httpServer.close(() => resolvePromise());
      });
      // Shutdown drains each repl workspace with the shutdown bound
      // before the broker teardown (the reviewer-mandated drain-then-
      // close posture; the last-client-disconnect path uses the full
      // session-eviction TTL instead).
      await projects.disposeReplStates();
      replPresence.disconnectAll();
      await sessions.closeAll();
      httpServer.closeAllConnections();
      await closed;
    },
  };
}
