/**
 * The stdio shim: what MCP clients spawn. A raw bidirectional pump between the client's
 * stdio and the daemon's Streamable HTTP endpoint — no Client/Server protocol layer, frames
 * are forwarded verbatim so the daemon negotiates directly with the real client. The shim
 * process is disposable by design: the client may kill it at will; runs live in the daemon.
 *
 * The only frames the shim inspects:
 *  - the client's `initialize` request — cached for 404 recovery, and its response sniffed
 *    to call setProtocolVersion() (there is no protocol layer to do it);
 *  - the `initialized` notification — forwarded verbatim; the SDK client transport then
 *    auto-opens the standalone GET stream (SSE) for server-initiated messages;
 *  - a 404 on send — the spec's "session terminated": the shim transparently re-ensures the
 *    daemon (it may have restarted on a new port), re-initializes a fresh session with the
 *    cached initialize, and retries. The client never notices an eviction or daemon restart.
 */

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isJSONRPCRequest, isJSONRPCResponse } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

import { DAEMON_NAME } from "../daemon/constants.js";
import { ensureDaemonRunning } from "./ensure-daemon.js";

export interface RunShimOptions {
  /** Entry file spawned with --daemon-run when no daemon is running (the shim's own bundle). */
  bundlePath: string;
  port?: number;
}

function initializeResultProtocolVersion(message: JSONRPCMessage): string | undefined {
  if (!isJSONRPCResponse(message)) return undefined;
  const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === "string" ? version : undefined;
}

export async function runShim(options: RunShimOptions): Promise<void> {
  const log = (line: string) => console.error(line);
  const info = await ensureDaemonRunning({ bundlePath: options.bundlePath, port: options.port, log });
  // The REPL eval-break relay (phase-F review round 2): the worker-
  // thread channel whose loopback endpoint stays reachable while the
  // daemon's main thread is blocked in a synchronous eval. The shim
  // fires the `repl` interrupt tool's no-id break here BEFORE forwarding
  // the request to the daemon — the out-of-band delivery that makes the
  // documented quickjs-interrupt behavior real for a never-yielding
  // eval (the daemon processes the forwarded request only after the
  // eval ends or breaks; the relay's flag is what breaks it mid-run).
  let replBreakUrl: string | undefined = info.replBreakUrl;

  /** Fire the out-of-band break for a `repl` interrupt without an id
   *  (best-effort, fire-and-forget: the daemon's own processing clears
   *  the flag when it lands; a missing/stale relay URL or a dead relay
   *  degrades to the per-eval deadline bound). The key is REALPATH'd
   *  exactly like the daemon's own project validation (phase-F review
   *  round 3: the raw caller-supplied path used to be posted verbatim,
   *  while the tool realpaths it and the channel registers the
   *  canonical path — a valid absolute symlink or a path with
   *  redundant components therefore got a relay 404 and could not
   *  interrupt the running eval). An unresolvable path is skipped: the
   *  tool call itself is refused as an invalid projectDir. */
  function fireOutOfBandBreak(projectDir: unknown): void {
    if (typeof projectDir !== "string" || replBreakUrl === undefined) return;
    let key: string;
    try {
      if (!isAbsolute(projectDir)) return;
      key = realpathSync(projectDir);
    } catch {
      return; // invalid/unresolvable — the daemon's own validation refuses the call
    }
    void fetch(replBreakUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(1000),
    }).catch(() => {
      // Best-effort: a dead relay must never break the forwarding path.
    });
  }

  const stdio = new StdioServerTransport();

  let cachedInitialize: JSONRPCMessage | undefined;
  let clientInitializeId: RequestId | undefined;
  let pendingReinitId: string | undefined;
  let reinitCounter = 0;
  let reinitializing = false;
  const queue: JSONRPCMessage[] = [];
  // Client resource subscriptions, tracked so a recovered session (404 re-initialize after
  // eviction or daemon restart) can be transparently re-subscribed — the daemon's new session
  // starts with none. Responses to replayed subscribes are shim-internal and swallowed.
  const subscribedUris = new Set<string>();
  const swallowedIds = new Set<string>();

  const makeHttpTransport = (url: string): StreamableHTTPClientTransport => {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    transport.onmessage = onDaemonMessage;
    transport.onerror = (error) => log(`[${DAEMON_NAME} shim] http transport error: ${String(error)}`);
    return transport;
  };

  let http = makeHttpTransport(info.url);

  function onDaemonMessage(message: JSONRPCMessage): void {
    if (pendingReinitId !== undefined && isJSONRPCResponse(message) && message.id === pendingReinitId) {
      // Shim-internal re-initialize: swallow the response, restore protocol state, re-arm
      // the client's subscriptions on the fresh session, then drain.
      pendingReinitId = undefined;
      const version = initializeResultProtocolVersion(message);
      if (version !== undefined) http.setProtocolVersion(version);
      void http
        .send({ jsonrpc: "2.0", method: "notifications/initialized" })
        .then(async () => {
          let replayed = 0;
          for (const uri of subscribedUris) {
            const id = `__shim_resub_${++reinitCounter}__`;
            swallowedIds.add(id);
            await http
              .send({ jsonrpc: "2.0", id, method: "resources/subscribe", params: { uri } })
              .then(() => replayed++)
              .catch(() => {
                swallowedIds.delete(id);
                log(`[${DAEMON_NAME} shim] could not re-subscribe ${uri} after session recovery`);
              });
          }
          if (replayed > 0) log(`[${DAEMON_NAME} shim] re-subscribed ${replayed} resource(s) after session recovery`);
          flushQueue();
        })
        .catch((error: unknown) => failPump(`re-initialize handshake failed: ${String(error)}`));
      return;
    }
    if (isJSONRPCResponse(message) && typeof message.id === "string" && swallowedIds.delete(message.id)) {
      return;
    }
    if (clientInitializeId !== undefined && isJSONRPCResponse(message) && message.id === clientInitializeId) {
      const version = initializeResultProtocolVersion(message);
      if (version !== undefined) http.setProtocolVersion(version);
      clientInitializeId = undefined;
    }
    void stdio.send(message).catch((error: unknown) => log(`[${DAEMON_NAME} shim] stdio write failed: ${String(error)}`));
  }

  function flushQueue(): void {
    reinitializing = false;
    for (const message of queue.splice(0)) void pumpSend(message);
  }

  function failPump(reason: string): void {
    log(`[${DAEMON_NAME} shim] fatal: ${reason}`);
    // A dead pump is a dead server as far as the client is concerned — exit so the host
    // applies its normal stdio-server-died handling instead of hanging on silence.
    void shutdown(1);
  }

  async function startReinitialize(): Promise<void> {
    if (reinitializing) return;
    reinitializing = true;
    if (cachedInitialize === undefined) {
      failPump("daemon session lost before the client ever initialized");
      return;
    }
    try {
      await http.close().catch(() => undefined);
      // Re-ensure: the daemon may have restarted (new port).
      const fresh = await ensureDaemonRunning({ bundlePath: options.bundlePath, port: options.port, log });
      replBreakUrl = fresh.replBreakUrl;
      http = makeHttpTransport(fresh.url);
      await http.start();
      pendingReinitId = `__shim_reinit_${++reinitCounter}__`;
      const reinit = { ...(cachedInitialize as object), id: pendingReinitId } as JSONRPCMessage;
      await http.send(reinit);
      // Continues in onDaemonMessage when the InitializeResult for pendingReinitId arrives.
    } catch (error) {
      failPump(`could not re-establish a daemon session: ${String(error)}`);
    }
  }

  // Session loss (spec 404 after eviction/daemon restart) and daemon death (network error —
  // undici surfaces those as TypeError "fetch failed") both recover the same way: re-ensure
  // the daemon and re-initialize a fresh session. The streak counter stops a crash-looping
  // daemon from cycling forever; any successful send resets it.
  let recoveryStreak = 0;
  function isRecoverableSendError(error: unknown): boolean {
    if (error instanceof StreamableHTTPError && error.code === 404) return true;
    return error instanceof TypeError;
  }

  async function pumpSend(message: JSONRPCMessage): Promise<void> {
    if (reinitializing) {
      queue.push(message);
      return;
    }
    try {
      await http.send(message);
      recoveryStreak = 0;
    } catch (error) {
      if (isRecoverableSendError(error) && recoveryStreak < 3) {
        recoveryStreak++;
        queue.push(message);
        void startReinitialize();
        return;
      }
      log(`[${DAEMON_NAME} shim] send failed: ${String(error)}`);
      if (isJSONRPCRequest(message)) {
        void stdio
          .send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: `workflow daemon unreachable: ${String(error)}` },
          })
          .catch(() => undefined);
      }
    }
  }

  stdio.onmessage = (message) => {
    if (isJSONRPCRequest(message)) {
      if (message.method === "initialize") {
        cachedInitialize = structuredClone(message);
        clientInitializeId = message.id;
      } else if (message.method === "resources/subscribe" || message.method === "resources/unsubscribe") {
        const uri = (message.params as { uri?: unknown } | undefined)?.uri;
        if (typeof uri === "string") {
          if (message.method === "resources/subscribe") subscribedUris.add(uri);
          else subscribedUris.delete(uri);
        }
      } else if (message.method === "tools/call") {
        // The out-of-band repl eval-break (phase-F review round 2): a
        // `repl` interrupt WITHOUT a call id fires the relay first — the
        // daemon may be blocked in a synchronous eval, and the relay's
        // worker thread is the only path that can reach it mid-run. The
        // forwarded request is still sent (when the daemon is
        // responsive, its own arm/refuse/clear handling owns the
        // break; the flag is consumed on first observation or cleared
        // by the daemon — never a stale break).
        const params = message.params as { name?: unknown; arguments?: Record<string, unknown> } | undefined;
        if (params?.name === "repl") {
          const args = params.arguments ?? {};
          if (args.action === "interrupt" && args.id === undefined) {
            fireOutOfBandBreak(args.projectDir);
          }
        }
      }
    }
    void pumpSend(message);
  };

  let exiting = false;
  async function shutdown(code: number): Promise<void> {
    if (exiting) return;
    exiting = true;
    // Politely end our session (spec DELETE); the daemon and its runs live on regardless.
    await http.terminateSession().catch(() => undefined);
    await http.close().catch(() => undefined);
    await stdio.close().catch(() => undefined);
    process.exit(code);
  }

  stdio.onclose = () => void shutdown(0);
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  await http.start();
  await stdio.start();
}
