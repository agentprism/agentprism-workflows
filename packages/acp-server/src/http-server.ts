import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Stream } from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
  createNodeHttpHandler,
  createNodeWebSocketUpgradeHandler,
} from "@agentclientprotocol/sdk/experimental/node";
import type { CustomBackendConfig } from "@automatalabs/acp-agents";
import { WebSocketServer } from "ws";
import {
  ACP_BACKEND_ID_PATTERN,
  indexBackendTargets,
  resolveBackendTargets,
  type BackendTarget,
} from "./backends.js";
import { serveAcpServer, type AcpServerEndpoint } from "./server.js";

export const DEFAULT_ACP_HTTP_HOST = "127.0.0.1" as const;
export const DEFAULT_ACP_HTTP_PORT = 7331 as const;
export const DEFAULT_ACP_HTTP_BASE_PATH = "/acp" as const;

export interface ListenAcpHttpServerOptions {
  /** Interface to bind. Defaults to loopback. */
  host?: string;
  /** TCP port to bind. Pass zero to allocate an ephemeral port. */
  port?: number;
  /** Base for /discovery and /backends/{id}. Defaults to /acp. */
  basePath?: string;
  /** Maximum JSON request body accepted by each Streamable HTTP adapter. */
  maxRequestBodyBytes?: number;
  /** Programmatic custom backends merged over AGENTPRISM_BACKENDS. */
  backends?: Record<string, CustomBackendConfig>;
  /** Exact backend targets, primarily for embedding and deterministic tests. */
  targets?: readonly BackendTarget[];
  /** Package version advertised on the discovery endpoint. */
  version?: string;
  /** Stops the listener and every active transport connection when aborted. */
  signal?: AbortSignal;
}

export interface AcpNetworkEndpoint {
  readonly path: string;
  readonly url: string;
  readonly webSocketUrl: string;
}

export interface AcpBackendNetworkEndpoint extends AcpNetworkEndpoint {
  readonly backendId: string;
}

export interface AcpHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly discovery: AcpNetworkEndpoint;
  readonly backends: readonly AcpBackendNetworkEndpoint[];
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface EndpointTransport {
  readonly path: string;
  readonly transportServer: AcpServer;
  readonly webSocketServer: WebSocketServer;
  readonly handleHttp: ReturnType<typeof createNodeHttpHandler>;
  readonly handleUpgrade: ReturnType<typeof createNodeWebSocketUpgradeHandler>;
}

export function acpDiscoveryPath(basePath: string = DEFAULT_ACP_HTTP_BASE_PATH): string {
  return `${requireBasePath(basePath)}/discovery`;
}

export function acpBackendPath(
  backendId: string,
  basePath: string = DEFAULT_ACP_HTTP_BASE_PATH,
): string {
  if (!ACP_BACKEND_ID_PATTERN.test(backendId)) {
    throw new TypeError(
      `ACP backend id ${JSON.stringify(backendId)} must match ${ACP_BACKEND_ID_PATTERN}`,
    );
  }
  return `${requireBasePath(basePath)}/backends/${backendId}`;
}

/** Listen for ACP V1 over explicit discovery and per-backend HTTP/WebSocket paths. */
export async function listenAcpHttpServer(
  options: ListenAcpHttpServerOptions = {},
): Promise<AcpHttpServerHandle> {
  options.signal?.throwIfAborted();
  const host = requireHost(options.host ?? DEFAULT_ACP_HTTP_HOST);
  const port = requirePort(options.port ?? DEFAULT_ACP_HTTP_PORT);
  const basePath = requireBasePath(options.basePath ?? DEFAULT_ACP_HTTP_BASE_PATH);
  const targets = options.targets
    ? [...options.targets]
    : resolveBackendTargets({ backends: options.backends });
  indexBackendTargets(targets);

  const endpointDefinitions: Array<{ endpoint: AcpServerEndpoint; path: string }> = [
    { endpoint: { kind: "discovery" }, path: acpDiscoveryPath(basePath) },
    ...targets.map((target) => ({
      endpoint: { kind: "backend" as const, backendId: target.id },
      path: acpBackendPath(target.id, basePath),
    })),
  ];
  const transports = endpointDefinitions.map(({ endpoint, path }) => createEndpointTransport(
    endpoint,
    path,
    targets,
    options,
  ));
  const transportsByPath = new Map(transports.map((transport) => [transport.path, transport]));

  const httpServer = createServer((request, response) => {
    const path = requestPath(request);
    const transport = path === undefined ? undefined : transportsByPath.get(path);
    if (!transport) {
      notFound(response);
      return;
    }
    transport.handleHttp(request, response);
  });
  httpServer.on("upgrade", (request, socket, head) => {
    const path = requestPath(request);
    const transport = path === undefined ? undefined : transportsByPath.get(path);
    if (!transport) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    transport.handleUpgrade(request, socket, head);
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
    await closeEndpointTransports(transports).catch(() => undefined);
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
      httpServer.closeIdleConnections();
      const results = await Promise.allSettled([
        stopListening,
        closeEndpointTransports(transports),
      ]);
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
  const origin = `http://${endpointHost}:${address.port}`;
  const webSocketOrigin = `ws://${endpointHost}:${address.port}`;
  const discoveryPath = acpDiscoveryPath(basePath);
  return {
    host,
    port: address.port,
    basePath,
    discovery: networkEndpoint(discoveryPath, origin, webSocketOrigin),
    backends: targets.map((target) => ({
      backendId: target.id,
      ...networkEndpoint(acpBackendPath(target.id, basePath), origin, webSocketOrigin),
    })),
    closed,
    close,
  };
}

function createEndpointTransport(
  endpoint: AcpServerEndpoint,
  path: string,
  targets: readonly BackendTarget[],
  options: ListenAcpHttpServerOptions,
): EndpointTransport {
  const transportServer = new AcpServer({
    createAgent: () => ({
      connect(stream) {
        // AcpServer exposes a batch-capable transport stream so it can also host draft ACP V2.
        // This package serves ACP V1 and therefore receives individual messages after initialize.
        const closed = serveAcpServer({
          endpoint,
          stream: stream as unknown as Stream,
          targets,
          ...(options.version === undefined ? {} : { version: options.version }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }).catch((error) => {
          console.error(`ACP network connection failed at ${path}:`, error);
        });
        return { closed };
      },
    }),
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  return {
    path,
    transportServer,
    webSocketServer,
    handleHttp: createNodeHttpHandler(transportServer, {
      ...(options.maxRequestBodyBytes === undefined
        ? {}
        : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
    }),
    handleUpgrade: createNodeWebSocketUpgradeHandler(transportServer, webSocketServer),
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

function requireBasePath(value: string): string {
  if (
    !value.startsWith("/") ||
    value === "/" ||
    value.endsWith("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(
      "ACP HTTP basePath must be a non-root absolute path without a trailing slash, query, or fragment",
    );
  }
  const parsed = new URL(value, "http://localhost");
  if (parsed.pathname !== value) {
    throw new TypeError("ACP HTTP basePath must be a canonical URL path");
  }
  return value;
}

function requestPath(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function networkEndpoint(path: string, origin: string, webSocketOrigin: string): AcpNetworkEndpoint {
  return { path, url: `${origin}${path}`, webSocketUrl: `${webSocketOrigin}${path}` };
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

async function closeEndpointTransports(transports: readonly EndpointTransport[]): Promise<void> {
  const errors: unknown[] = [];
  for (const transport of transports) {
    for (const client of transport.webSocketServer.clients) client.terminate();
    const results = await Promise.allSettled([
      transport.transportServer.close(),
      closeWebSocketServer(transport.webSocketServer),
    ]);
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Failed to close ACP endpoint transports");
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
