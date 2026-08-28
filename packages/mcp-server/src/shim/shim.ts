/**
 * The stdio shim: what MCP clients spawn. A raw bidirectional pump between the client's
 * stdio and the daemon's Streamable HTTP endpoint — no Client/Server protocol layer, frames
 * are forwarded verbatim so the daemon negotiates directly with the real client. The shim
 * process is disposable by design: the client may kill it at will; runs live in the daemon.
 *
 * The only frames the shim inspects:
 *  - a legacy client's `initialize` request — cached for session recovery, and its response
 *    sniffed to call setProtocolVersion() (there is no protocol layer in this proxy);
 *  - the legacy `initialized` notification — forwarded before the standalone GET stream opens;
 *  - client requests in either era — ids are tracked until their response arrives, so an
 *    ambiguous request on a dead daemon is failed rather than replayed or left hanging.
 *
 * Legacy session recovery — the spec's 404 after eviction or a daemon restart, a 503 from a
 * superseded (lame-duck) daemon, a network error because the daemon died, or the standalone
 * GET stream failing for any of those reasons — always takes the same path: re-ensure the
 * daemon (it may have been replaced by a newer one on another port), re-initialize a fresh
 * session with the cached initialize, re-arm subscriptions, and drain the queue. The client
 * never notices an eviction, a daemon restart, or a version upgrade. Recovery is triggered
 * PROACTIVELY from the GET stream's failure (not only from the client's next frame) so that
 * server-push continuity resumes promptly after a migration. Modern traffic has no session:
 * recovery replaces only the upstream HTTP transport, fails ambiguous ordinary in-flight work,
 * reopens idempotent `subscriptions/listen` streams, and forwards later stateless requests
 * without inventing initialize or session state.
 */

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  SdkHttpError,
  StreamableHTTPClientTransport,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/client";
import type { JSONRPCMessage, JSONRPCRequest, RequestId } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { DAEMON_NAME } from "../daemon/constants.js";
import { probeHealthz } from "../daemon/daemon-info.js";
import { ensureDaemonRunning, type EnsuredDaemonInfo } from "./ensure-daemon.js";

export interface RunShimOptions {
  /** Entry file spawned with --daemon-run when no daemon is running (the shim's own bundle). */
  bundlePath: string;
  port?: number;
}

/** Recoveries allowed inside the window before the shim gives up (a crash-looping daemon). */
const RECOVERY_WINDOW_MS = 60_000;
const RECOVERY_MAX_PER_WINDOW = 6;

function initializeResultProtocolVersion(message: JSONRPCMessage): string | undefined {
  if (!isJSONRPCResultResponse(message)) return undefined;
  const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === "string" ? version : undefined;
}

/**
 * Session loss in every shape it reaches the shim:
 *  - 404: the spec's "session terminated" (eviction, migration off a lame duck, daemon restart);
 *  - 503: a superseded daemon refusing a new session (discovery moved between our probe and
 *    our request) — re-ensure finds the successor;
 *  - TypeError: undici's network failure ("fetch failed") — the daemon died;
 *  - the SDK client's stream-recovery exhaustion/refusal messages, which wrap the above after
 *    the standalone GET (or a resumable POST stream) failed to reconnect.
 */
function isRecoverableError(error: unknown): boolean {
  if (error instanceof SdkHttpError) return error.status === 404 || error.status === 503;
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    return /Maximum reconnection attempts|Failed to reconnect|Failed to open SSE stream/.test(error.message);
  }
  return false;
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
  let exiting = false;
  let compatibilityDrainTimer: NodeJS.Timeout | undefined;

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
  // Modern subscriptions/listen requests are idempotent stream establishments. Keep their
  // original ids/envelopes so daemon replacement can reopen them without ending the client's
  // still-live subscription handle. Ordinary requests are never replayed after ambiguity.
  const modernSubscriptions = new Map<string, JSONRPCRequest>();

  // Client requests forwarded to the daemon whose response has not arrived yet, keyed by
  // request id and remembering which transport carried them. When that transport is retired
  // (its session is gone) every request still pending on it is answered with an error — the
  // daemon will never answer it, and a request left unanswered hangs the host forever.
  interface PendingRequest {
    transport: StreamableHTTPClientTransport;
    message: JSONRPCRequest;
  }
  const pending = new Map<string, PendingRequest>();
  const keyOf = (id: RequestId): string => `${typeof id}:${String(id)}`;
  /** Transports taken out of service (their session is gone); their late errors/replies are noise. */
  const retired = new WeakSet<StreamableHTTPClientTransport>();

  const recoveryTimes: number[] = [];
  function recoveryAllowed(now = Date.now()): boolean {
    while (recoveryTimes.length > 0 && now - recoveryTimes[0]! > RECOVERY_WINDOW_MS) recoveryTimes.shift();
    return recoveryTimes.length < RECOVERY_MAX_PER_WINDOW;
  }

  const makeHttpTransport = (url: string): StreamableHTTPClientTransport => {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    transport.onmessage = (message) => onDaemonMessage(message, transport);
    transport.onerror = (error) => onTransportError(transport, error);
    return transport;
  };

  let http = makeHttpTransport(info.url);

  function failPendingOn(transport: StreamableHTTPClientTransport, reason: string): number {
    let failed = 0;
    for (const [key, entry] of [...pending.entries()]) {
      if (entry.transport !== transport || modernSubscriptions.has(key)) continue;
      pending.delete(key);
      failed++;
      void stdio
        .send({
          jsonrpc: "2.0",
          id: entry.message.id,
          error: {
            code: -32603,
            message:
              `workflow daemon session lost before the response arrived (${reason}); ` +
              `the request may or may not have completed — inspect before retrying`,
          },
        })
        .catch(() => undefined);
    }
    return failed;
  }

  /**
   * Take a transport out of service: its session is gone, so nothing pending on it can
   * complete. The pending sweep is deferred one macrotask: the SDK reports a failed send
   * through `onerror` BEFORE throwing it to the sender, and the sender's own catch must get
   * to un-register (and re-queue) that frame first — it never reached the daemon, so it is
   * replayed, not failed.
   */
  function retireTransport(transport: StreamableHTTPClientTransport, reason: string): void {
    retired.add(transport);
    void transport.close().catch(() => undefined);
    setImmediate(() => {
      const failed = failPendingOn(transport, reason);
      if (failed > 0) log(`[${DAEMON_NAME} shim] ${failed} in-flight request(s) failed with the lost session (${reason})`);
    });
  }

  function onTransportError(transport: StreamableHTTPClientTransport, error: unknown): void {
    if (retired.has(transport) || exiting) return; // a retired transport's late errors are noise
    log(`[${DAEMON_NAME} shim] http transport error: ${String(error)}`);
    // The active transport's standalone stream (or a resumable request stream) is gone for a
    // reason that means the session is gone: recover now rather than on the client's next
    // frame, so server-push (subscriptions, notifications) resumes promptly.
    if (isRecoverableError(error)) void startReinitialize(`stream error: ${String(error)}`);
  }

  function onDaemonMessage(message: JSONRPCMessage, transport: StreamableHTTPClientTransport): void {
    if (retired.has(transport)) return; // a retired transport's late replies belong to a dead session
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== null && message.id !== undefined) {
      const key = keyOf(message.id);
      if (modernSubscriptions.has(key) && isJSONRPCResultResponse(message)) {
        // A modern listen stream ending without a client cancellation is an upstream loss,
        // not the end of the stdio client's subscription handle. Swallow the terminal result
        // and reopen the idempotent stream through the normal stateless recovery path.
        void startReinitialize("modern subscriptions/listen stream ended");
        return;
      }
      pending.delete(key);
      modernSubscriptions.delete(key);
    }
    if (pendingReinitId !== undefined && isJSONRPCResultResponse(message) && message.id === pendingReinitId) {
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
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && typeof message.id === "string" && swallowedIds.delete(message.id)) {
      return;
    }
    if (clientInitializeId !== undefined && isJSONRPCResultResponse(message) && message.id === clientInitializeId) {
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

  function armCompatibilityDrain(candidate: EnsuredDaemonInfo): void {
    if (compatibilityDrainTimer !== undefined) {
      clearInterval(compatibilityDrainTimer);
      compatibilityDrainTimer = undefined;
    }
    if (candidate.compatibilityDrain !== true) return;
    compatibilityDrainTimer = setInterval(() => {
      void (async () => {
        if (exiting || reinitializing) return;
        const health = await probeHealthz(candidate.port, 1_000);
        if (
          health === undefined ||
          health.pid !== candidate.pid ||
          (health.activeRuns === 0 && (health.inflightRequests ?? 0) === 0)
        ) {
          if (compatibilityDrainTimer !== undefined) clearInterval(compatibilityDrainTimer);
          compatibilityDrainTimer = undefined;
          await startReinitialize(
            health === undefined
              ? "compatibility-drain predecessor became unavailable"
              : "compatibility-drain predecessor became idle",
          );
        }
      })().catch((error: unknown) => log(`[${DAEMON_NAME} shim] compatibility-drain monitor failed: ${String(error)}`));
    }, 1_000);
    compatibilityDrainTimer.unref();
  }

  async function startReinitialize(reason: string): Promise<void> {
    if (reinitializing || exiting) return;
    if (!recoveryAllowed()) {
      failPump(`daemon session recovery is looping (${RECOVERY_MAX_PER_WINDOW} attempts within ${RECOVERY_WINDOW_MS}ms; last: ${reason})`);
      return;
    }
    recoveryTimes.push(Date.now());
    reinitializing = true;
    log(
      cachedInitialize === undefined
        ? `[${DAEMON_NAME} shim] recovering the modern stateless daemon path (${reason})`
        : `[${DAEMON_NAME} shim] recovering the daemon session (${reason})`,
    );
    try {
      retireTransport(http, reason);
      // Re-ensure: the daemon may have restarted (new port) or been superseded by a newer one.
      const fresh = await ensureDaemonRunning({ bundlePath: options.bundlePath, port: options.port, log });
      replBreakUrl = fresh.replBreakUrl;
      armCompatibilityDrain(fresh);
      http = makeHttpTransport(fresh.url);
      await http.start();
      if (cachedInitialize === undefined) {
        // Modern 2026-07-28 traffic is per-request: there is no initialize/session state to
        // reconstruct. Reopen only idempotent listen streams. Ordinary in-flight calls are
        // failed by retireTransport as ambiguous and are never replayed.
        let reopened = 0;
        for (const [key, subscription] of modernSubscriptions) {
          pending.set(key, { transport: http, message: subscription });
          await http.send(subscription);
          reopened += 1;
        }
        log(`[${DAEMON_NAME} shim] modern stateless path ready; reopened ${reopened} subscription(s)`);
        flushQueue();
        return;
      }
      pendingReinitId = `__shim_reinit_${++reinitCounter}__`;
      const reinit = { ...cachedInitialize, id: pendingReinitId } as JSONRPCMessage;
      await http.send(reinit);
      // Continues in onDaemonMessage when the InitializeResult for pendingReinitId arrives.
    } catch (error) {
      if (isRecoverableError(error) && recoveryAllowed()) {
        // Discovery moved again underneath us (a second succession, a lame duck's 503):
        // take the recovery path once more rather than dying on a transient.
        reinitializing = false;
        pendingReinitId = undefined;
        setTimeout(() => void startReinitialize(`retry after: ${String(error)}`), 250);
        return;
      }
      failPump(`could not re-establish a daemon session: ${String(error)}`);
    }
  }

  async function pumpSend(message: JSONRPCMessage): Promise<void> {
    if (reinitializing) {
      queue.push(message);
      return;
    }
    const transport = http;
    if (isJSONRPCRequest(message)) pending.set(keyOf(message.id), { transport, message });
    try {
      await transport.send(message);
    } catch (error) {
      if (isRecoverableError(error)) {
        if (cachedInitialize !== undefined) {
          // Preserve the established legacy recovery behavior. Modern send failures are
          // ambiguous (the daemon may have executed before response headers were lost), so
          // their pending request stays registered for retireTransport to fail exactly once.
          if (isJSONRPCRequest(message)) pending.delete(keyOf(message.id));
          queue.push(message);
        }
        void startReinitialize(`send failed: ${String(error)}`);
        return;
      }
      if (isJSONRPCRequest(message)) pending.delete(keyOf(message.id));
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

  /** Serializes client→daemon forwarding so frames reach the daemon in the order sent. */
  let sendChain: Promise<void> = Promise.resolve();

  stdio.onmessage = (message) => {
    if (isJSONRPCRequest(message)) {
      if (message.method === "initialize") {
        cachedInitialize = structuredClone(message);
        clientInitializeId = message.id;
      } else if (message.method === "subscriptions/listen") {
        modernSubscriptions.set(keyOf(message.id), message);
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
    } else if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
      const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const key = keyOf(requestId);
        modernSubscriptions.delete(key);
        pending.delete(key);
      }
    }
    // Forward in the order the client sent. pumpSend is async, so firing each frame
    // without sequencing let consecutive frames race as concurrent POSTs and reach the
    // daemon out of order — a client that pipelines `notifications/initialized` with its
    // first request could have the request processed first. Chaining serializes only the
    // POST *initiation*: the SDK's send() resolves on the response headers and streams the
    // reply separately, so concurrent tool calls stay concurrent.
    sendChain = sendChain.then(() => pumpSend(message)).catch(() => undefined);
  };

  async function shutdown(code: number): Promise<void> {
    if (exiting) return;
    exiting = true;
    if (compatibilityDrainTimer !== undefined) clearInterval(compatibilityDrainTimer);
    compatibilityDrainTimer = undefined;
    // Politely end our session (spec DELETE); the daemon and its runs live on regardless.
    await http.terminateSession().catch(() => undefined);
    await http.close().catch(() => undefined);
    await stdio.close().catch(() => undefined);
    process.exit(code);
  }

  stdio.onclose = () => void shutdown(0);
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  armCompatibilityDrain(info);
  await http.start();
  await stdio.start();
}
