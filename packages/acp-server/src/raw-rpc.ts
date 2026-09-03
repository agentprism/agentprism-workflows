import {
  RequestError,
  type AnyMessage,
  type AnyNotification,
  type AnyRequest,
  type JsonRpcId,
  type Result,
  type Stream,
} from "@agentclientprotocol/sdk";

export interface RawRpcHandler {
  request(message: AnyRequest, signal: AbortSignal): Promise<Result<unknown>> | Result<unknown>;
  notification(message: AnyNotification): Promise<void> | void;
}

interface PendingRequest {
  resolve(result: Result<unknown>): void;
  reject(error: unknown): void;
}

/** Minimal bidirectional JSON-RPC peer used only by router-owned discovery connections. */
export class RawRpcPeer {
  private readonly reader: ReadableStreamDefaultReader<AnyMessage>;
  private readonly writer: WritableStreamDefaultWriter<AnyMessage>;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly incoming = new Map<JsonRpcId, AbortController>();
  private nextRequestId = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private closeReason: unknown;
  readonly closed: Promise<void>;

  constructor(stream: Stream, private readonly handler: RawRpcHandler) {
    this.reader = stream.readable.getReader();
    this.writer = stream.writable.getWriter();
    this.closed = this.receive().finally(() => {
      const reason = this.closeReason ?? new Error("ACP JSON-RPC connection closed");
      for (const pending of this.pending.values()) pending.reject(reason);
      this.pending.clear();
      for (const controller of this.incoming.values()) controller.abort(reason);
      this.incoming.clear();
    });
    this.closed.catch(() => {});
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = `agentprism-${(this.nextRequestId += 1)}`;
    const message: AnyRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    const onAbort = () => {
      void this.notify("$/cancel_request", { requestId: id });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    return new Promise<Result<unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.write(message).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    }).finally(() => signal?.removeEventListener("abort", onAbort));
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async close(reason?: unknown): Promise<void> {
    this.closeReason = reason;
    await Promise.allSettled([
      this.reader.cancel(reason),
      this.writeQueue.then(() => this.writer.close()),
    ]);
    await this.closed.catch(() => {});
    try {
      this.writer.releaseLock();
    } catch {}
  }

  private write(message: AnyMessage): Promise<void> {
    const operation = this.writeQueue.then(() => this.writer.write(message));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  private async receive(): Promise<void> {
    try {
      while (true) {
        const item = await this.reader.read();
        if (item.done) return;
        const message = item.value;
        if ("result" in message || "error" in message) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          pending.resolve("result" in message ? { result: message.result } : { error: message.error });
          continue;
        }
        if (!("id" in message)) {
          if (message.method === "$/cancel_request") {
            const requestId = cancelRequestId(message.params);
            if (requestId !== undefined) this.incoming.get(requestId)?.abort(RequestError.requestCancelled());
            continue;
          }
          void Promise.resolve(this.handler.notification(message)).catch(() => {});
          continue;
        }
        this.dispatchRequest(message);
      }
    } finally {
      this.reader.releaseLock();
    }
  }

  private dispatchRequest(message: AnyRequest): void {
    const controller = new AbortController();
    this.incoming.set(message.id, controller);
    void Promise.resolve()
      .then(() => this.handler.request(message, controller.signal))
      .catch((error): Result<unknown> => ({ error: errorResponse(error) }))
      .then((result) => this.write({ jsonrpc: "2.0", id: message.id, ...result }))
      .catch(() => {})
      .finally(() => this.incoming.delete(message.id));
  }
}

export function errorResponse(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RequestError) return error.toErrorResponse();
  return RequestError.internalError(undefined, error instanceof Error ? error.message : String(error)).toErrorResponse();
}

function cancelRequestId(params: unknown): JsonRpcId | undefined {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return undefined;
  const value = (params as Record<string, unknown>).requestId;
  return typeof value === "string" || typeof value === "number" || value === null ? value : undefined;
}
