import { readFileSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  RequestError,
  methods,
  ndJsonStream,
  type AnyMessage,
  type AnyRequest,
  type AnyResponse,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionResponse,
  type Result,
  type Stream,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import type { CustomBackendConfig, RawBackendConnection } from "@automatalabs/acp-agents";
import { resolveBackendTargets, type BackendTarget } from "./backends.js";
import {
  ACP_BACKENDS_PROBE_METHOD,
  ACP_ROUTER_META_NAMESPACE,
  assertSessionBackend,
  discoveryInitializeResponse,
  isRecord,
  mergeBackendInitializeResponse,
  parseProbeBackendsParams,
  parseRouterInitialize,
  type BackendProbe,
  type ProbeBackendsParams,
  type ProbeBackendsResult,
} from "./protocol.js";
import { RawRpcPeer, errorResponse, type RawRpcHandler } from "./raw-rpc.js";

export interface ServeAcpServerOptions {
  /** Outer ACP stream. Defaults to process stdin/stdout. */
  stream?: Stream;
  /** Programmatic custom backends merged over AGENTPRISM_BACKENDS. */
  backends?: Record<string, CustomBackendConfig>;
  /** Exact backend targets, primarily for embedding and deterministic tests. */
  targets?: readonly BackendTarget[];
  /** Package version advertised on discovery connections. */
  version?: string;
  /** Closes the active outer and downstream connections when aborted. */
  signal?: AbortSignal;
}

/** Serve one connection-pinned AgentPrism ACP V1 stream until either side closes. */
export async function serveAcpServer(options: ServeAcpServerOptions = {}): Promise<void> {
  const stream = options.stream ?? stdioStream();
  const targets = options.targets ? [...options.targets] : resolveBackendTargets({ backends: options.backends });
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  if (targetsById.size !== targets.length) throw new Error("ACP backend target ids must be unique");

  const outerReader = stream.readable.getReader();
  const first = await readFirst(outerReader, options.signal);
  if (!first) {
    outerReader.releaseLock();
    return;
  }
  const remainingReadable = readableFromReader(outerReader);
  const firstRequest = asInitializeRequest(first);
  if (!firstRequest) {
    await rejectFirstMessage(stream.writable, first);
    await remainingReadable.cancel();
    return;
  }

  let parsed;
  try {
    parsed = parseRouterInitialize(firstRequest.params);
  } catch (error) {
    await writeResponseAndClose(stream.writable, {
      jsonrpc: "2.0",
      id: firstRequest.id,
      error: errorResponse(error),
    });
    await remainingReadable.cancel();
    return;
  }

  if (parsed.selection.mode === "discovery") {
    await serveDiscoveryConnection(
      { readable: remainingReadable, writable: stream.writable },
      firstRequest,
      parsed.request,
      targets,
      options.version ?? packageVersion(),
      options.signal,
    );
    return;
  }

  const target = targetsById.get(parsed.selection.backend);
  if (!target) {
    await writeResponseAndClose(stream.writable, {
      jsonrpc: "2.0",
      id: firstRequest.id,
      error: RequestError.invalidParams(
        undefined,
        `unknown AgentPrism ACP backend ${JSON.stringify(parsed.selection.backend)}`,
      ).toErrorResponse(),
    });
    await remainingReadable.cancel();
    return;
  }

  await serveBackendConnection(
    { readable: remainingReadable, writable: stream.writable },
    firstRequest,
    target,
    options.signal,
  );
}

function stdioStream(): Stream {
  return ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
}

async function serveDiscoveryConnection(
  stream: Stream,
  initializeMessage: AnyRequest,
  initializeRequest: InitializeRequest,
  targets: readonly BackendTarget[],
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  const writer = stream.writable.getWriter();
  await writer.write({
    jsonrpc: "2.0",
    id: initializeMessage.id,
    result: discoveryInitializeResponse(version),
  });
  writer.releaseLock();

  let peer!: RawRpcPeer;
  const handler: RawRpcHandler = {
    request: async (message, requestSignal) => {
      if (message.method !== ACP_BACKENDS_PROBE_METHOD) {
        return { error: RequestError.methodNotFound(message.method).toErrorResponse() };
      }
      try {
        const params = parseProbeBackendsParams(message.params);
        return {
          result: await probeBackends(targets, initializeRequest, params, peer, requestSignal),
        };
      } catch (error) {
        return { error: errorResponse(error) };
      }
    },
    notification: () => {},
  };
  peer = new RawRpcPeer(stream, handler);
  const onAbort = () => void peer.close(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await peer.closed;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await peer.close();
  }
}

async function probeBackends(
  targets: readonly BackendTarget[],
  initializeRequest: InitializeRequest,
  params: ProbeBackendsParams,
  outer: RawRpcPeer,
  signal: AbortSignal,
): Promise<ProbeBackendsResult> {
  const backends = await Promise.all(
    targets.map((target) => probeBackend(target, initializeRequest, params, outer, signal)),
  );
  return { backends };
}

async function probeBackend(
  target: BackendTarget,
  initializeRequest: InitializeRequest,
  params: ProbeBackendsParams,
  outer: RawRpcPeer,
  signal: AbortSignal,
): Promise<BackendProbe> {
  let downstream: RawBackendConnection | undefined;
  let peer: RawRpcPeer | undefined;
  let sessionId: string | undefined;
  let stage: "initialize" | "session/new" = "initialize";
  try {
    signal.throwIfAborted();
    downstream = await target.open();
    peer = new RawRpcPeer(downstream.stream, {
      request: (message, requestSignal) => outer.request(message.method, message.params, requestSignal),
      notification: (message) => outer.notify(message.method, message.params),
    });

    const initialized = await peer.request(methods.agent.initialize, initializeRequest, signal);
    if ("error" in initialized) throw new RequestError(
      initialized.error.code,
      initialized.error.message,
      initialized.error.data,
    );
    const initializeResponse = requireInitializeResponse(initialized.result);

    stage = "session/new";
    const created = await peer.request(methods.agent.session.new, params, signal);
    if ("error" in created) throw new RequestError(created.error.code, created.error.message, created.error.data);
    const sessionResponse = requireNewSessionResponse(created.result);
    sessionId = sessionResponse.sessionId;

    return {
      id: target.id,
      name: target.name,
      available: true,
      ...(initializeResponse.agentInfo === undefined ? {} : { agentInfo: initializeResponse.agentInfo }),
      ...(initializeResponse.agentCapabilities === undefined
        ? {}
        : { agentCapabilities: initializeResponse.agentCapabilities }),
      ...(sessionResponse.modes === undefined ? {} : { modes: sessionResponse.modes }),
      ...(sessionResponse.configOptions === undefined ? {} : { configOptions: sessionResponse.configOptions }),
      ...(initializeResponse._meta === undefined ? {} : { initializeMeta: initializeResponse._meta }),
      ...(sessionResponse._meta === undefined ? {} : { sessionMeta: sessionResponse._meta }),
    };
  } catch (error) {
    return {
      id: target.id,
      name: target.name,
      available: false,
      stage,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (peer && sessionId) {
      await peer.request(methods.agent.session.close, { sessionId }).catch(() => undefined);
    }
    await peer?.close();
    await downstream?.close();
  }
}

async function serveBackendConnection(
  outerStream: Stream,
  initializeMessage: AnyRequest,
  target: BackendTarget,
  signal?: AbortSignal,
): Promise<void> {
  let downstream: RawBackendConnection | undefined;
  const outerWriter = outerStream.writable.getWriter();
  const outerReader = outerStream.readable.getReader();
  let innerWriter: WritableStreamDefaultWriter<AnyMessage> | undefined;
  let innerReader: ReadableStreamDefaultReader<AnyMessage> | undefined;
  let initializeResponded = false;
  const onAbort = () => {
    void outerReader.cancel(signal?.reason);
    void innerReader?.cancel(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    downstream = await target.open();
    innerWriter = downstream.stream.writable.getWriter();
    innerReader = downstream.stream.readable.getReader();
    await innerWriter.write(initializeMessage);

    const initialized = await readInitializeResponse(innerReader, outerWriter, initializeMessage.id);
    if ("error" in initialized) {
      await outerWriter.write(initialized);
      initializeResponded = true;
      return;
    }

    const response = requireInitializeResponse(initialized.result);
    await outerWriter.write({
      ...initialized,
      result: mergeBackendInitializeResponse(response, target.id),
    });
    initializeResponded = true;

    const clientToBackend = pumpClientToBackend(outerReader, innerWriter, outerWriter, target.id, signal);
    const backendToClient = pumpUnchanged(innerReader, outerWriter, signal);
    await Promise.race([clientToBackend, backendToClient]);
    await Promise.allSettled([
      outerReader.cancel(),
      innerReader.cancel(),
      clientToBackend,
      backendToClient,
    ]);
  } catch (error) {
    if (!initializeResponded && !signal?.aborted) {
      await outerWriter.write({
        jsonrpc: "2.0",
        id: initializeMessage.id,
        error: errorResponse(error),
      }).catch(() => undefined);
      initializeResponded = true;
    } else if (!signal?.aborted) {
      throw error;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await Promise.allSettled([
      innerWriter?.close() ?? Promise.resolve(),
      outerWriter.close(),
    ]);
    try {
      innerReader?.releaseLock();
    } catch {}
    try {
      outerReader.releaseLock();
    } catch {}
    try {
      innerWriter?.releaseLock();
    } catch {}
    try {
      outerWriter.releaseLock();
    } catch {}
    await downstream?.close();
  }
}

async function readInitializeResponse(
  reader: ReadableStreamDefaultReader<AnyMessage>,
  outerWriter: WritableStreamDefaultWriter<AnyMessage>,
  initializeId: AnyRequest["id"],
): Promise<AnyResponse> {
  while (true) {
    const item = await reader.read();
    if (item.done) throw new Error("ACP backend closed before initialize completed");
    const message = item.value;
    if (("result" in message || "error" in message) && message.id === initializeId) return message;
    await outerWriter.write(message);
  }
}

async function pumpClientToBackend(
  reader: ReadableStreamDefaultReader<AnyMessage>,
  backendWriter: WritableStreamDefaultWriter<AnyMessage>,
  clientWriter: WritableStreamDefaultWriter<AnyMessage>,
  backendId: string,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    const item = await reader.read();
    if (item.done) return;
    const message = item.value;

    if ("method" in message && message.method === methods.agent.session.new && "id" in message) {
      try {
        assertSessionBackend(message.params, backendId);
      } catch (error) {
        await clientWriter.write({ jsonrpc: "2.0", id: message.id, error: errorResponse(error) });
        continue;
      }
    }

    if ("method" in message && message.method.startsWith("_automatalabs/agentprism/")) {
      if ("id" in message) {
        await clientWriter.write({
          jsonrpc: "2.0",
          id: message.id,
          error: RequestError.methodNotFound(message.method).toErrorResponse(),
        });
      }
      continue;
    }

    await backendWriter.write(message);
  }
}

async function pumpUnchanged(
  reader: ReadableStreamDefaultReader<AnyMessage>,
  writer: WritableStreamDefaultWriter<AnyMessage>,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    const item = await reader.read();
    if (item.done) return;
    await writer.write(item.value);
  }
}

function requireInitializeResponse(value: unknown): InitializeResponse {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`ACP backend returned an invalid protocol-${PROTOCOL_VERSION} initialize response`);
  }
  return value as InitializeResponse;
}

function requireNewSessionResponse(value: unknown): NewSessionResponse {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("ACP backend returned an invalid session/new response");
  }
  return value as unknown as NewSessionResponse;
}

function asInitializeRequest(message: AnyMessage): AnyRequest | undefined {
  return "method" in message && "id" in message && message.method === methods.agent.initialize
    ? message
    : undefined;
}

async function rejectFirstMessage(writable: Stream["writable"], message: AnyMessage): Promise<void> {
  if ("method" in message && "id" in message) {
    await writeResponseAndClose(writable, {
      jsonrpc: "2.0",
      id: message.id,
      error: RequestError.invalidRequest(undefined, "first ACP request must be initialize").toErrorResponse(),
    });
    return;
  }
  const writer = writable.getWriter();
  await writer.close();
  writer.releaseLock();
}

async function writeResponseAndClose(writable: Stream["writable"], response: AnyResponse): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.write(response);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

async function readFirst(
  reader: ReadableStreamDefaultReader<AnyMessage>,
  signal?: AbortSignal,
): Promise<AnyMessage | undefined> {
  if (!signal) {
    const item = await reader.read();
    return item.done ? undefined : item.value;
  }
  if (signal.aborted) return undefined;
  return new Promise<AnyMessage | undefined>((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(signal.reason);
      resolve(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (item) => {
        signal.removeEventListener("abort", onAbort);
        resolve(item.done ? undefined : item.value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function readableFromReader(reader: ReadableStreamDefaultReader<AnyMessage>): ReadableStream<AnyMessage> {
  return new ReadableStream<AnyMessage>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          controller.close();
          reader.releaseLock();
        } else {
          controller.enqueue(item.value);
        }
      } catch (error) {
        controller.error(error);
        try {
          reader.releaseLock();
        } catch {}
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      try {
        reader.releaseLock();
      } catch {}
    },
  });
}

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}
