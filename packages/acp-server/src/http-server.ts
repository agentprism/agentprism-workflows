import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
  createNodeHttpHandler,
  createNodeWebSocketUpgradeHandler,
} from "@agentclientprotocol/sdk/experimental/node";
import type { Stream } from "@agentclientprotocol/sdk";
import type { CustomBackendConfig } from "@automatalabs/acp-agents";
import { WebSocketServer } from "ws";
import { resolveBackendTargets, type BackendTarget } from "./backends.js";
import { serveAcpServer } from "./server.js";

export const DEFAULT_ACP_HTTP_HOST = "127.0.0.1" as const;
export const DEFAULT_ACP_HTTP_PORT = 7331 as const;
export const DEFAULT_ACP_HTTP_PATH = "/acp" as const;

export interface ListenAcpHttpServerOptions {
  /** Interface to bind. Defaults to loopback. */
  host?: string;
  /** TCP port to bind. Pass zero to allocate an ephemeral port. */
  port?: number;
  /** Exact HTTP and WebSocket endpoint path. Defaults to /acp. */
  path?: string;
  /** Maximum JSON request body accepted by the Streamable HTTP adapter. */
  maxRequestBodyBytes?: number;
  /** Programmatic custom backends merged over AGENTPRISM_BACKENDS. */
  backends?: Record<string, CustomBackendConfig>;
  /** Exact backend targets, primarily for embedding and deterministic tests. */
  targets?: readonly BackendTarget[];
  /** Package version advertised on discovery connections. */
  version?: string;
  /** Stops the listener and every active transport connection when aborted. */
  signal?: AbortSignal;
}

export interface AcpHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly url: string;
  readonly webSocketUrl: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Listen for ACP V1 Streamable HTTP and WebSocket connections on one endpoint.
 *
 * Each accepted transport connection receives an independent connection-pinned router. The
 * experimental SDK surface used here is the official ACP HTTP/WebSocket transport implementation;
 * the router protocol carried over it remains ACP V1.
 */
export async function listenAcpHttpServer(
  options: ListenAcpHttpServerOptions = {},
): Promise<AcpHttpServerHandle> {
  options.signal?.throwIfAborted();
  const host = requireHost(options.host ?? DEFAULT_ACP_HTTP_HOST);
  const port = requirePort(options.port ?? DEFAULT_ACP_HTTP_PORT);
  const path = requirePath(options.path ?? DEFAULT_ACP_HTTP_PATH);
  const targets = options.targets
    ? [...options.targets]
    : resolveBackendTargets({ backends: options.backends });
  requireUniqueTargets(targets);

  const transportServer = new AcpServer({
    createAgent: () => ({
      connect(stream) {
        // AcpServer exposes a batch-capable transport stream so it can also host draft ACP V2.
        // This router rejects non-V1 initialize requests, after which the SDK guarantees that V1
        // connections contain individual messages only.
        const closed = serveAcpServer({
          stream: stream as unknown as Stream,
          targets,
          ...(options.version === undefined ? {} : { version: options.version }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }).catch((error) => {
          // One failed client connection must not become a process-level unhandled rejection or
          // stop the shared listener. AcpServer observes this lifecycle promise to tear down only
          // the affected transport connection.
          console.error("ACP network connection failed:", error);
        });
        return { closed };
      },
    }),
  });
  const httpHandler = createNodeHttpHandler(transportServer, {
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  const upgradeHandler = createNodeWebSocketUpgradeHandler(transportServer, webSocketServer);
  const httpServer = createServer((request, response) => {
    if (!isAcpPath(request, path)) {
      notFound(response);
      return;
    }
    httpHandler(request, response);
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (!isAcpPath(request, path)) {
      socket.destroy();
      return;
    }
    upgradeHandler(request, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });

  const address = httpServer.address();
  if (!isAddressInfo(address)) {
    await closeNodeServer(httpServer).catch(() => undefined);
    await transportServer.close();
    throw new Error("ACP HTTP server did not bind to a TCP address");
  }

  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  closed.catch(() => {});
  let closePromise: Promise<void> | undefined;
  let runtimeError: unknown;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      options.signal?.removeEventListener("abort", onAbort);
      const stopListening = closeNodeServer(httpServer);
      const results = await Promise.allSettled([
        transportServer.close(),
        stopListening,
      ]);
      for (const client of webSocketServer.clients) client.terminate();
      await closeWebSocketServer(webSocketServer).catch((error) => {
        results.push({ status: "rejected", reason: error });
      });
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (runtimeError !== undefined) errors.unshift(runtimeError);
      if (errors.length > 0) throw new AggregateError(errors, "Failed to close ACP HTTP server");
    })();
    closePromise.then(resolveClosed, rejectClosed);
    return closePromise;
  };

  const onAbort = () => {
    void close();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  httpServer.on("error", (error) => {
    runtimeError = error;
    void close();
  });
  if (options.signal?.aborted) void close();

  const endpointHost = formatUrlHost(host);
  return {
    host,
    port: address.port,
    path,
    url: `http://${endpointHost}:${address.port}${path}`,
    webSocketUrl: `ws://${endpointHost}:${address.port}${path}`,
    closed,
    close,
  };
}

function requireHost(value: string): string {
  const host = value.trim();
  if (host.length === 0) throw new TypeError("ACP HTTP host must not be empty");
  return host;
}

function requirePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError("ACP HTTP port must be an integer from 0 through 65535");
  }
  return value;
}

function requirePath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new TypeError("ACP HTTP path must be an absolute path without a query or fragment");
  }
  const parsed = new URL(value, "http://localhost");
  if (parsed.pathname !== value) {
    throw new TypeError("ACP HTTP path must be a canonical URL path");
  }
  return value;
}

function requireUniqueTargets(targets: readonly BackendTarget[]): void {
  const ids = new Set(targets.map((target) => target.id));
  if (ids.size !== targets.length) throw new Error("ACP backend target ids must be unique");
}

function isAcpPath(request: IncomingMessage, path: string): boolean {
  return new URL(request.url ?? "/", "http://localhost").pathname === path;
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("Not Found");
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object";
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function closeNodeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
