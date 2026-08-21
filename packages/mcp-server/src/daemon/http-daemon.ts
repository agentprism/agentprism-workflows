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
import { DAEMON_NAME, HEALTHZ_PATH, MCP_ENDPOINT_PATH, REPL_DRAIN_BOUND_MS } from "./constants.js";
import { envFingerprint, isSupersededBy } from "./daemon-info.js";
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
   * The concrete REPL client-presence drain bound: a project whose last
   * client disconnected drains its in-flight subagent turns up to this
   * bound, then closes idle children. Defaults to `REPL_DRAIN_BOUND_MS`
   * (its own knob — decoupled from the session-eviction TTL, which is
   * now short enough to collect dead clients promptly).
   */
  replDrainBoundMs?: number;
  /** @deprecated alias of `replDrainBoundMs` (the two used to share one constant). */
  sessionTtlMs?: number;
  /** The REPL eval-break relay (phase-F review round 2; see
   *  repl-engine's `EvalBreakChannel`): the worker-thread channel whose
   *  loopback endpoint the shim fires while the daemon's main thread is
   *  blocked in a synchronous eval. The daemon passes its own channel
   *  (single-project servers own one by default — round 3: the
   *  in-process mode's relay transport fires it, see
   *  `repl-stdio-transport.ts`). */
  evalBreakChannel?: EvalBreakChannel;
  /**
   * This daemon's identity for discovery/succession accounting. Defaults to `process.pid`;
   * injected in tests. It is the pid reported by /healthz and compared against `daemon.json`
   * to decide lame-duck (superseded) status.
   */
  ownPid?: number;
  /**
   * The version string reported by /healthz. Defaults to `SERVER_VERSION`; injected in tests
   * to simulate a divergent (older/newer) daemon that a current-version shim must supersede.
   */
  version?: string;
  /**
   * Whether this daemon has been superseded (a newer daemon owns discovery). A lame-duck
   * daemon admits no new MCP sessions. Defaults to the stateless `daemon.json` pid check
   * (`isSupersededBy(ownPid)`), re-evaluated on every admission so discovery pointing back at
   * this daemon transparently restores normal service. Injected in tests.
   */
  isSuperseded?: () => boolean;
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
  /** Requests (POSTs) being processed right now, across every session. */
  inflightRequestCount(): number;
  /** True when a newer daemon owns this family's discovery pointer (this one is a lame duck). */
  isSuperseded(): boolean;
  /**
   * The lame-duck migration: close every session with no request in flight and no REPL
   * workspace mid-turn, so its client transparently re-initializes on the successor. Returns
   * the closed session ids.
   */
  evictDrainableSessions(): string[];
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
  const ownPid = options.ownPid ?? process.pid;
  const version = options.version ?? SERVER_VERSION;
  // A lame duck (a newer daemon owns discovery) admits no new sessions. Re-evaluated per
  // request so that if discovery is ever repointed back at this daemon it resumes service.
  const isSuperseded = options.isSuperseded ?? (() => isSupersededBy(ownPid));

  const sessions = new SessionRegistry();
  // ONE registry shared by every session: run calls select their project via the required
  // projectDir tool argument, and all sessions see all projects' runs.
  const projects = new WorkflowProjectRegistry(options.runner);
  // The REPL client-presence ledger: every session touches the projects it addresses; on
  // last-connection-closed a project with no clients left is drained (the doc's
  // client-presence policy; the bound reuses the session-eviction TTL).
  const replDrainBoundMs = options.replDrainBoundMs ?? options.sessionTtlMs ?? REPL_DRAIN_BOUND_MS;
  const replPresence = new ReplPresenceLedger(replDrainBoundMs);
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
      // A POST is work in flight (a GET is only the standalone stream; a DELETE ends the
      // session): the lame-duck migration never cuts a request being processed.
      const isRequest = req.method === "POST";
      if (isRequest) sessions.requestStarted(sessionId);
      res.on("close", () => {
        if (isRequest) sessions.requestFinished(sessionId);
        sessions.connectionClosed(sessionId);
      });
      await record.transport.handleRequest(req, res);
      return;
    }

    // No session header: this must be an initialize request (the SDK transport 400s
    // anything else). A superseded daemon is a lame duck — a newer daemon owns discovery, so
    // this one finishes its existing sessions and runs but admits NO new sessions. Every new
    // client therefore lands on the current daemon, and this daemon can drain and exit. (The
    // check is stateless: if discovery is repointed back at us we admit again.)
    if (isSuperseded()) {
      writeJsonRpcError(
        res,
        503,
        `${DAEMON_NAME} (pid ${ownPid}) has been superseded by a newer daemon and is draining; reconnect to reach the current daemon`,
      );
      return;
    }

    // Sessions are project-agnostic — every run call names its project.
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
      replDrainBoundMs,
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
            version,
            pid: ownPid,
            port: boundPort,
            startedAt,
            sessions: sessions.size,
            activeRuns: projects.activeRunCount(),
            envFingerprint: envFingerprint(env),
            projects: projects.snapshot(),
            lameDuck: isSuperseded(),
            inflightRequests: sessions.inflightCount(),
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
    inflightRequestCount: () => sessions.inflightCount(),
    isSuperseded,
    evictDrainableSessions: () => sessions.evictDrainable((sessionId) => replPresence.sessionHasBusyWorkspace(sessionId)),
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
