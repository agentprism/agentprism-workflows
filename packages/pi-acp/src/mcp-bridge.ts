import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentContext,
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
} from "@agentclientprotocol/sdk";
import type {
  AgentSession,
  ExtensionAPI,
  InlineExtension,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  ErrorCode,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ContentBlock,
  type CreateMessageRequest,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { Type } from "typebox";
import { adapterError } from "./errors.js";
import type { PiAcpDeps } from "./deps.js";
import { createMcpSamplingPayload } from "./mcp-sampling-payload.js";
import { PKG_VERSION } from "./version.js";

const NO_RECONNECT = {
  initialReconnectionDelay: 0,
  maxReconnectionDelay: 0,
  reconnectionDelayGrowFactor: 1,
  maxRetries: 0,
} as const;

const NEVER_ABORTED = new AbortController().signal;

export interface McpSessionBinding {
  sessionId: string;
  cwd: string;
  client: AgentContext;
  sessionSignal: AbortSignal;
  getPi(): AgentSession | undefined;
  getTurnSignal(): AbortSignal | undefined;
  isPublished(): boolean;
  emitDiagnostic(text: string): void;
  /** Adapter-allocated collision-safe token for this configured server. */
  serverToken?: string;
  poison?(server: string): void;
  ownerToken?: object;
  modelRuntime?: PiAcpDeps["modelRuntime"];
}

export interface McpListResult {
  tools: Tool[];
  nextCursor?: string;
  raw?: unknown;
}

export interface McpClientHandle {
  listTools(cursor: string | undefined, signal: AbortSignal, timeoutMs: number): Promise<McpListResult>;
  callTool(
    name: string,
    args: unknown,
    signal: AbortSignal,
    timeoutMs: number,
    onprogress?: (progress: unknown) => void,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
  ping?(signal: AbortSignal, timeoutMs: number): Promise<void>;
  getCapabilities?(): ServerCapabilities | undefined;
  getInstructions?(): string | undefined;
  setLoggingLevel?(signal: AbortSignal, timeoutMs: number): Promise<void>;
  listResources?(cursor: string | undefined, options: RequestOptions): Promise<unknown>;
  listResourceTemplates?(cursor: string | undefined, options: RequestOptions): Promise<unknown>;
  readResource?(uri: string, options: RequestOptions): Promise<unknown>;
  subscribeResource?(uri: string, options: RequestOptions): Promise<unknown>;
  unsubscribeResource?(uri: string, options: RequestOptions): Promise<unknown>;
  listPrompts?(cursor: string | undefined, options: RequestOptions): Promise<unknown>;
  getPrompt?(name: string, args: Record<string, string> | undefined, options: RequestOptions): Promise<unknown>;
  complete?(params: unknown, options: RequestOptions): Promise<unknown>;
  setToolsChangedHandler?(handler: () => void): void;
  setDisabledHandler?(handler: () => void): void;
  disableOnTimeout?(): void;
  getPeerSignal?(): AbortSignal;
  /** The handle's own close implementation enforces the shared physical deadline. */
  closeIsBounded?: boolean;
}

export class McpTimeoutError extends Error {
  constructor() {
    super("MCP operation timed out");
    this.name = "McpTimeoutError";
  }
}

export type McpTerminalCause = "lifecycle" | "session" | "peer" | "timeout";

export class McpOperationTerminalError extends Error {
  constructor(
    readonly terminalCause: McpTerminalCause,
    readonly terminalReason?: unknown,
  ) {
    super(`MCP operation terminated by ${terminalCause}`);
    this.name = "McpOperationTerminalError";
  }
}

export type McpIncomingTerminalCause = "peer" | "session" | "turn" | "timeout";

export class McpIncomingTerminalError extends Error {
  constructor(
    readonly terminalCause: McpIncomingTerminalCause,
    readonly terminalReason?: unknown,
  ) {
    super(`Incoming MCP operation terminated by ${terminalCause}`);
    this.name = "McpIncomingTerminalError";
  }
}

function exactMcpError(code: ErrorCode, message: string): McpError {
  const error = new McpError(code, message);
  // McpError adds a local-display prefix, but Protocol serializes error.message verbatim.
  error.message = message;
  return error;
}

/**
 * One terminal arbiter for every MCP request.  Claims are committed in a
 * microtask so conditions that become observable at the same boundary are
 * resolved by the frozen precedence instead of Promise.race scheduling.
 */
export function settleMcpOperation<T>(
  operation: (requestSignal: AbortSignal) => Promise<T>,
  lifecycleSignal: AbortSignal | undefined,
  sessionSignal: AbortSignal | undefined,
  peerSignal: AbortSignal | undefined,
  timeoutMs: number,
  sleep: PiAcpDeps["sleep"],
): Promise<T> {
  const requestSignal = anySignal([lifecycleSignal, sessionSignal, peerSignal]);
  return new Promise<T>((resolve, reject) => {
    const timer = new AbortController();
    let settled = false;
    let commitQueued = false;
    let timedOut = false;
    let operationOutcome:
      | { status: "fulfilled"; value: T }
      | { status: "rejected"; reason: unknown }
      | undefined;
    const removers: Array<() => void> = [];
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      timer.abort();
      for (const remove of removers) remove();
      callback();
    };
    const commit = () => {
      commitQueued = false;
      if (settled) return;
      if (lifecycleSignal?.aborted) {
        finish(() => reject(new McpOperationTerminalError("lifecycle", lifecycleSignal.reason)));
      } else if (sessionSignal?.aborted) {
        finish(() => reject(new McpOperationTerminalError("session", sessionSignal.reason)));
      } else if (peerSignal?.aborted) {
        finish(() => reject(new McpOperationTerminalError("peer", peerSignal.reason)));
      } else if (timedOut) {
        finish(() => reject(new McpOperationTerminalError("timeout", new McpTimeoutError())));
      } else {
        const outcome = operationOutcome;
        if (outcome?.status === "fulfilled") {
          finish(() => resolve(outcome.value));
        } else if (outcome?.status === "rejected") {
          finish(() => reject(outcome.reason));
        }
      }
    };
    const claim = () => {
      if (settled || commitQueued) return;
      commitQueued = true;
      queueMicrotask(commit);
    };
    const observe = (signal: AbortSignal | undefined) => {
      if (!signal) return;
      if (signal.aborted) claim();
      else {
        signal.addEventListener("abort", claim, { once: true });
        removers.push(() => signal.removeEventListener("abort", claim));
      }
    };
    observe(lifecycleSignal);
    observe(sessionSignal);
    observe(peerSignal);
    const expiry = sleep(timeoutMs, timer.signal).then(
      () => { timedOut = true; claim(); },
      () => undefined,
    );
    expiry.catch(() => undefined);
    const running = Promise.resolve().then(() => {
      if (settled) throw new Error("MCP operation was cancelled before admission");
      return operation(requestSignal);
    });
    running.then(
      (value) => { operationOutcome = { status: "fulfilled", value }; claim(); },
      (reason) => { operationOutcome = { status: "rejected", reason }; claim(); },
    );
  });
}

export async function bounded<T>(
  operation: Promise<T> | (() => Promise<T>),
  signal: AbortSignal,
  timeoutMs: number,
  sleep: PiAcpDeps["sleep"],
): Promise<T> {
  try {
    return await settleMcpOperation(
      () => typeof operation === "function" ? operation() : operation,
      signal,
      undefined,
      undefined,
      timeoutMs,
      sleep,
    );
  } catch (error) {
    if (error instanceof McpOperationTerminalError) {
      if (error.terminalCause === "timeout") throw new McpTimeoutError();
      throw error.terminalReason;
    }
    throw error;
  }
}

export async function settleIncomingMcpOperation<T>(
  operation: (requestSignal: AbortSignal) => Promise<T>,
  peerSignal: AbortSignal,
  sessionSignal: AbortSignal,
  turnSignal: AbortSignal | undefined,
  timeoutMs: number,
  sleep: PiAcpDeps["sleep"],
): Promise<T> {
  try {
    // Positional mapping gives the incoming arbiter its distinct frozen order:
    // peer/transport > session disposal > active turn > timeout > completion.
    return await settleMcpOperation(
      operation,
      peerSignal,
      sessionSignal,
      turnSignal,
      timeoutMs,
      sleep,
    );
  } catch (error) {
    if (!(error instanceof McpOperationTerminalError)) throw error;
    const cause: McpIncomingTerminalCause = error.terminalCause === "lifecycle"
      ? "peer"
      : error.terminalCause === "peer"
        ? "turn"
        : error.terminalCause;
    throw new McpIncomingTerminalError(cause, error.terminalReason);
  }
}

function isMcpTimeout(error: unknown): boolean {
  return error instanceof McpTimeoutError
    || (error instanceof McpOperationTerminalError && error.terminalCause === "timeout");
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length === 0 ? NEVER_ABORTED : AbortSignal.any(present);
}

function headers(values: readonly { name: string; value: string }[]): Headers {
  const result = new Headers();
  for (const { name, value } of values) result.append(name, value);
  return result;
}

export class CloseSignallingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private signalled = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly raw: Transport,
    private readonly terminate: (() => Promise<void>) | undefined,
    private readonly onRawError: (error: Error) => boolean,
    private readonly onRawClose: () => void,
    private readonly timeoutMs: number,
    private readonly sleep: PiAcpDeps["sleep"],
    private readonly serverToken: string,
  ) {
    raw.onclose = () => {
      this.signalClose();
      this.onRawClose();
    };
    raw.onerror = (error) => {
      if (this.onRawError(error)) this.onerror?.(error);
    };
    raw.onmessage = (message, extra) => this.onmessage?.(message, extra);
  }

  get sessionId(): string | undefined { return this.raw.sessionId; }
  setProtocolVersion(version: string): void { this.raw.setProtocolVersion?.(version); }
  start(): Promise<void> { return this.raw.start(); }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.raw.send(message, options);
  }

  signalClose(): void {
    if (this.signalled) return;
    this.signalled = true;
    this.onclose?.();
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOwned();
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    this.signalClose();
    const timer = new AbortController();
    const expired = this.sleep(this.timeoutMs, timer.signal).then(() => {
      throw new McpTimeoutError();
    });
    expired.catch(() => undefined);
    if (this.terminate) {
      try {
        const terminating = this.terminate();
        terminating.catch(() => undefined);
        await Promise.race([terminating, expired]);
      } catch {
        console.error(`[mcp:${this.serverToken}] session termination failed`);
      }
    }
    let physical: Promise<void>;
    try {
      physical = this.raw.close();
    } catch {
      console.error(`[mcp:${this.serverToken}] close failed`);
      timer.abort();
      return;
    }
    physical.catch(() => undefined);
    try {
      await Promise.race([physical, expired]);
    } catch {
      console.error(`[mcp:${this.serverToken}] close failed`);
    } finally {
      timer.abort();
    }
  }
}

function safeToken(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_");
  return sanitized || "_";
}

function createTransport(
  server: McpServer,
  serverToken: string,
  sleep: PiAcpDeps["sleep"],
  fatal: (error?: Error) => void,
  timeoutMs: number,
): CloseSignallingTransport {
  let raw: Transport;
  let terminate: (() => Promise<void>) | undefined;
  if (!("type" in server)) {
    raw = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
    });
  } else if (server.type === "http") {
    let open = true;
    const observedFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      // Fatal disable closes the ordinary fetch lane before the owner invokes
      // close(). The retained raw transport must still be able to send its
      // one explicit session DELETE; permitting DELETE here cannot reconnect
      // either GET or POST traffic.
      if (!open && init?.method !== "DELETE") throw new Error("MCP transport closed");
      const response = await fetch(url, init);
      if (init?.method === "GET" && response.ok && response.headers.get("content-type")?.includes("text/event-stream") && !response.body) {
        throw new Error("MCP event stream has no body");
      }
      return response;
    };
    const http = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: headers(server.headers) },
      fetch: observedFetch,
      reconnectionOptions: NO_RECONNECT,
    });
    raw = http;
    terminate = () => http.terminateSession();
    const wrapper = new CloseSignallingTransport(raw, terminate, (error) => {
      open = false;
      wrapper.signalClose();
      fatal(error);
      void wrapper.close();
      return false;
    }, () => fatal(), timeoutMs, sleep, serverToken);
    return wrapper;
  } else if (server.type === "sse") {
    let open = true;
    const guardedFetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (!open) return Promise.reject(new Error("MCP transport closed"));
      return fetch(url, init);
    };
    raw = new SSEClientTransport(new URL(server.url), {
      requestInit: { headers: headers(server.headers) },
      eventSourceInit: { fetch: guardedFetch },
      fetch: guardedFetch,
    });
    const wrapper = new CloseSignallingTransport(raw, undefined, (error) => {
      open = false;
      wrapper.signalClose();
      fatal(error);
      void wrapper.close();
      return false;
    }, () => fatal(), timeoutMs, sleep, serverToken);
    return wrapper;
  } else {
    throw adapterError("unsupported_mcp_transport", { server: server.name });
  }
  return new CloseSignallingTransport(raw, terminate, (error) => {
    // stdio parser/pipe errors are diagnostic-only; natural close is observed by onclose.
    void error;
    return true;
  }, () => fatal(), timeoutMs, sleep, serverToken);
}

let elicitationCounter = 0n;
let elicitationOwnerCounter = 0n;
const elicitationOwners = new WeakMap<object, bigint>();
const urlElicitations = new Map<string, {
  opaque: string;
  remote: string;
  accepted: boolean;
  declinePending(): void;
}>();
const consumedElicitations = new Set<string>();

function elicitationKey(binding: McpSessionBinding, token: string, remote: string): string {
  const owner = binding.ownerToken ?? binding;
  let ownerId = elicitationOwners.get(owner);
  if (ownerId === undefined) {
    ownerId = ++elicitationOwnerCounter;
    elicitationOwners.set(owner, ownerId);
  }
  return `${ownerId}\u0000${binding.sessionId}\u0000${token}\u0000${remote}`;
}

function clearElicitations(binding: McpSessionBinding | undefined, token: string): void {
  if (!binding) return;
  const prefix = elicitationKey(binding, token, "");
  for (const [key, entry] of urlElicitations) {
    if (key.startsWith(prefix)) {
      entry.declinePending();
      urlElicitations.delete(key);
    }
  }
  for (const key of consumedElicitations) {
    if (key.startsWith(prefix)) consumedElicitations.delete(key);
  }
}

function progress(extra: { sendNotification(notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total: number } }): Promise<void> }, token: string | number | undefined, value: number, diagnostic: () => void): void {
  if (token === undefined) return;
  extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: value, total: 1 } })
    .catch(diagnostic);
}

export function createMcpRootsResult(
  binding: Pick<McpSessionBinding, "cwd" | "sessionSignal">,
  progressToken: string | number | undefined,
  extra: {
    signal: AbortSignal;
    sendNotification(notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total: number } }): Promise<void>;
  },
  onProgressFailure: () => void,
) {
  extra.signal.throwIfAborted();
  binding.sessionSignal.throwIfAborted();
  progress(extra, progressToken, 0, onProgressFailure);
  const result = { roots: [{ uri: pathToFileURL(binding.cwd).href, name: basename(binding.cwd) }] };
  progress(extra, progressToken, 1, onProgressFailure);
  return result;
}

export function mapMcpSamplingResult(message: AssistantMessage, stopSequences: readonly string[] = []) {
  if (message.stopReason === "error") throw exactMcpError(ErrorCode.InternalError, "MCP sampling failed");
  if (message.stopReason === "aborted") throw exactMcpError(ErrorCode.InternalError, "MCP sampling cancelled");
  if (message.content.some((block) => block.type === "toolCall")) {
    throw exactMcpError(ErrorCode.InternalError, "MCP sampling returned unsupported tool output");
  }
  let text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  let stopReason: "endTurn" | "maxTokens" | "stopSequence" = message.stopReason === "length" ? "maxTokens" : "endTurn";
  let earliest = -1;
  for (const stop of stopSequences) {
    const index = text.indexOf(stop);
    if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index;
  }
  if (earliest >= 0) {
    text = text.slice(0, earliest);
    stopReason = "stopSequence";
  }
  return {
    role: "assistant" as const,
    model: `${message.provider}/${message.responseModel ?? message.model}`,
    content: { type: "text" as const, text },
    stopReason,
  };
}

function installClientHandlers(
  client: Client,
  binding: McpSessionBinding | undefined,
  token: string,
  validator: AjvJsonSchemaValidator,
  timeoutMs: number,
  sleep: PiAcpDeps["sleep"],
): void {
  if (!binding) return;
  const diagnostic = (suffix: string) => binding.emitDiagnostic(`[mcp:${token}] ${suffix}`);
  client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
    if (request.params.task || (request.params.includeContext && request.params.includeContext !== "none") || request.params.tools || request.params.toolChoice) {
      throw exactMcpError(ErrorCode.InvalidParams, request.params.task ? "Unsupported experimental MCP task" : "Unsupported MCP sampling capability");
    }
    const progressToken = request.params._meta?.progressToken;
    const turnSignal = binding.getTurnSignal();
    try {
      const result = await settleIncomingMcpOperation((signal) => {
        progress(extra, progressToken, 0, () => diagnostic("progress notification failed"));
        const pi = binding.getPi();
        const model = pi?.model;
        if (!pi || !model) {
          throw exactMcpError(ErrorCode.InternalError, "MCP sampling requires an active pi session model");
        }
        const prepared = createMcpSamplingPayload(request.params, model);
        return (binding.modelRuntime ?? pi.modelRuntime).completeSimple(model, prepared.context, {
          signal,
          maxTokens: request.params.maxTokens,
          temperature: request.params.temperature,
          metadata: request.params.metadata as Record<string, unknown> | undefined,
          onPayload: prepared.onPayload,
        }).then((message) => mapMcpSamplingResult(message, request.params.stopSequences));
      }, extra.signal, binding.sessionSignal, turnSignal, timeoutMs, sleep);
      progress(extra, progressToken, 1, () => diagnostic("progress notification failed"));
      return result;
    } catch (error) {
      if (error instanceof McpIncomingTerminalError) {
        if (error.terminalCause === "peer" || error.terminalCause === "session") {
          throw error.terminalReason;
        }
        if (error.terminalCause === "turn") {
          throw exactMcpError(ErrorCode.InternalError, "MCP sampling cancelled");
        }
        throw exactMcpError(ErrorCode.InternalError, "MCP sampling timed out");
      }
      if (error instanceof McpError) throw error;
      throw exactMcpError(ErrorCode.InternalError, "MCP sampling failed");
    }
  });
  client.setRequestHandler(ListRootsRequestSchema, (request, extra) => createMcpRootsResult(
    binding,
    request.params?._meta?.progressToken,
    extra,
    () => diagnostic("progress notification failed"),
  ));
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    if (request.params.task) throw exactMcpError(ErrorCode.InvalidParams, "Unsupported experimental MCP task");
    // Snapshot publication at handler admission. An elicitation received
    // during open remains local even if session/new publishes while it is
    // settling, while still receiving the ordinary 0/1 progress pair.
    const publishedAtAdmission = binding.isPublished();
    const progressToken = request.params._meta?.progressToken;
    const turnSignal = binding.getTurnSignal();
    let urlKey: string | undefined;
    try {
      const response = await settleIncomingMcpOperation(async () => {
        progress(extra, progressToken, 0, () => diagnostic("progress notification failed"));
        if (!publishedAtAdmission) return { action: "decline" as const };
        if (request.params.mode === "form") {
          let validate: JsonSchemaValidator<Record<string, unknown>>;
          try {
            validate = validator.getValidator(request.params.requestedSchema);
          } catch {
            throw exactMcpError(ErrorCode.InternalError, "MCP elicitation schema validation failed");
          }
          const value = await binding.client.request<CreateElicitationResponse, CreateElicitationRequest>("elicitation/create", {
            sessionId: binding.sessionId,
            mode: "form",
            message: request.params.message,
            requestedSchema: request.params.requestedSchema,
          });
          if (value.action !== "accept") return value;
          const checked = validate(value.content);
          if (!checked.valid) throw exactMcpError(ErrorCode.InvalidParams, "Invalid MCP elicitation response");
          return { action: "accept" as const, content: checked.data };
        }

        const urlParams = request.params as { elicitationId: string; url: string; message: string };
        urlKey = elicitationKey(binding, token, urlParams.elicitationId);
        if (urlElicitations.has(urlKey)) {
          diagnostic("duplicate elicitation id");
          return { action: "decline" as const };
        }
        if (consumedElicitations.has(urlKey)) {
          diagnostic("reused elicitation id");
          return { action: "decline" as const };
        }
        const opaque = `pi-acp-elicitation-${++elicitationCounter}`;
        let declinePending!: () => void;
        const earlyCompletion = new Promise<CreateElicitationResponse>((resolve) => {
          declinePending = () => resolve({ action: "decline" });
        });
        urlElicitations.set(urlKey, { opaque, remote: urlParams.elicitationId, accepted: false, declinePending });
        const acpRequest = binding.client.request<CreateElicitationResponse, CreateElicitationRequest>("elicitation/create", {
          sessionId: binding.sessionId,
          mode: "url",
          message: urlParams.message,
          elicitationId: opaque,
          url: urlParams.url,
        });
        acpRequest.then(() => undefined, () => undefined);
        return Promise.race([acpRequest, earlyCompletion]);
      }, extra.signal, binding.sessionSignal, turnSignal, timeoutMs, sleep);
      if (request.params.mode === "url" && response.action === "accept") {
        const entry = urlKey ? urlElicitations.get(urlKey) : undefined;
        if (entry) entry.accepted = true;
      } else if (urlKey) {
        urlElicitations.delete(urlKey);
        consumedElicitations.add(urlKey);
      }
      progress(extra, progressToken, 1, () => diagnostic("progress notification failed"));
      if (response.action === "accept") {
        return request.params.mode === "form"
          ? { action: "accept" as const, content: response.content as Record<string, unknown> }
          : { action: "accept" as const };
      }
      return { action: response.action };
    } catch (error) {
      if (urlKey) {
        urlElicitations.delete(urlKey);
        consumedElicitations.add(urlKey);
      }
      if (error instanceof McpIncomingTerminalError) {
        if (error.terminalCause === "peer" || error.terminalCause === "session") {
          throw error.terminalReason;
        }
        return { action: "cancel" as const };
      }
      if (error instanceof McpError) throw error;
      progress(extra, progressToken, 1, () => diagnostic("progress notification failed"));
      return { action: "decline" as const };
    }
  });
  client.setNotificationHandler(ElicitationCompleteNotificationSchema, async (notification) => {
    const key = elicitationKey(binding, token, notification.params.elicitationId);
    const entry = urlElicitations.get(key);
    if (!entry) {
      diagnostic(consumedElicitations.has(key) ? "late elicitation completion" : "unknown elicitation completion");
      return;
    }
    urlElicitations.delete(key);
    consumedElicitations.add(key);
    if (!entry.accepted) {
      entry.declinePending();
      diagnostic("late elicitation completion");
      return;
    }
    try {
      await binding.client.notify("elicitation/complete", { elicitationId: entry.opaque });
    } catch {
      diagnostic("ACP elicitation completion failed");
    }
  });
}

export async function connectDefaultMcpClient(
  server: McpServer,
  signal: AbortSignal,
  timeoutMs: number,
  sleep: PiAcpDeps["sleep"],
  binding?: McpSessionBinding,
): Promise<McpClientHandle> {
  const token = binding?.serverToken ?? safeToken(server.name);
  const validator = new AjvJsonSchemaValidator();
  const client = new Client({ name: "@automatalabs/pi-acp", version: PKG_VERSION }, {
    enforceStrictCapabilities: true,
    capabilities: { sampling: {}, roots: { listChanged: false }, elicitation: { form: {}, url: {} } },
    jsonSchemaValidator: validator,
  });
  let state: "opening" | "open" | "disabled" | "closing" | "closed" = "opening";
  const fatalController = new AbortController();
  let disabledHandler: () => void = () => {};
  let toolsChangedHandler: (() => void) | undefined;
  let pendingToolsChanged = false;
  const fatal = () => {
    if (state === "opening") {
      clearElicitations(binding, token);
      fatalController.abort(new Error("MCP transport closed while opening"));
      return;
    }
    if (state !== "open") return;
    state = "disabled";
    fatalController.abort(new Error("MCP peer closed"));
    clearElicitations(binding, token);
    binding?.emitDiagnostic(`[mcp:${token}] connection closed; server disabled`);
    disabledHandler();
  };
  const transport = createTransport(server, token, sleep, fatal, timeoutMs);
  installClientHandlers(client, binding, token, validator, timeoutMs, sleep);
  const capabilityDiagnostic = (method: string) => binding?.emitDiagnostic(`[mcp:${token}] ${method}`);
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    const caps = client.getServerCapabilities();
    if (!caps?.tools?.listChanged) return capabilityDiagnostic("unexpected notifications/tools/list_changed");
    if (toolsChangedHandler) toolsChangedHandler();
    else pendingToolsChanged = true;
  });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    const caps = client.getServerCapabilities();
    capabilityDiagnostic(caps?.resources?.listChanged ? "notifications/resources/list_changed" : "unexpected notifications/resources/list_changed");
  });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    const caps = client.getServerCapabilities();
    capabilityDiagnostic(caps?.resources?.subscribe
      ? `notifications/resources/updated uri=${notification.params.uri}`
      : "unexpected notifications/resources/updated");
  });
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
    const caps = client.getServerCapabilities();
    capabilityDiagnostic(caps?.prompts?.listChanged ? "notifications/prompts/list_changed" : "unexpected notifications/prompts/list_changed");
  });
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    if (!client.getServerCapabilities()?.logging) {
      capabilityDiagnostic("unexpected notifications/message");
      return;
    }
    const data = typeof notification.params.data === "string"
      ? notification.params.data
      : JSON.stringify(notification.params.data) ?? String(notification.params.data);
    binding?.emitDiagnostic(`[mcp:${token}] ${notification.params.level}: ${data}`);
  });
  client.onerror = () => {
    if (state === "opening" || state === "open") binding?.emitDiagnostic(`[mcp:${token}] transport error`);
  };
  try {
    await settleMcpOperation(
      (connectSignal) => client.connect(transport, { timeout: timeoutMs, signal: connectSignal }),
      signal,
      binding?.sessionSignal,
      fatalController.signal,
      timeoutMs,
      sleep,
    );
    state = "open";
  } catch (error) {
    state = "closing";
    await transport.close();
    state = "closed";
    throw error;
  }
  const options = (requestSignal: AbortSignal, requestTimeout: number, onprogress?: (progress: unknown) => void): RequestOptions => ({
    signal: requestSignal,
    timeout: requestTimeout,
    ...(onprogress ? { onprogress } : {}),
  });
  return {
    async listTools(cursor, requestSignal, requestTimeout) {
      const raw = await client.listTools(cursor ? { cursor } : undefined, options(requestSignal, requestTimeout));
      return { tools: raw.tools, nextCursor: raw.nextCursor, raw };
    },
    async callTool(name, args, requestSignal, requestTimeout, onprogress) {
      const result = await client.callTool(
        { name, arguments: typeof args === "object" && args !== null ? args as Record<string, unknown> : {} },
        undefined,
        options(requestSignal, requestTimeout, onprogress),
      );
      if (!("content" in result)) throw new Error("MCP task result did not contain tool content");
      return result as CallToolResult;
    },
    async ping(requestSignal, requestTimeout) { await client.ping(options(requestSignal, requestTimeout)); },
    getCapabilities: () => client.getServerCapabilities(),
    getInstructions: () => client.getInstructions(),
    async setLoggingLevel(requestSignal, requestTimeout) { await client.setLoggingLevel("info", options(requestSignal, requestTimeout)); },
    listResources: (cursor, requestOptions) => client.listResources(cursor ? { cursor } : undefined, requestOptions),
    listResourceTemplates: (cursor, requestOptions) => client.listResourceTemplates(cursor ? { cursor } : undefined, requestOptions),
    readResource: (uri, requestOptions) => client.readResource({ uri }, requestOptions),
    subscribeResource: (uri, requestOptions) => client.subscribeResource({ uri }, requestOptions),
    unsubscribeResource: (uri, requestOptions) => client.unsubscribeResource({ uri }, requestOptions),
    listPrompts: (cursor, requestOptions) => client.listPrompts(cursor ? { cursor } : undefined, requestOptions),
    getPrompt: (name, args, requestOptions) => client.getPrompt({ name, arguments: args }, requestOptions),
    complete: (params, requestOptions) => client.complete(params as Parameters<Client["complete"]>[0], requestOptions),
    setToolsChangedHandler(handler) {
      toolsChangedHandler = handler;
      if (pendingToolsChanged) {
        pendingToolsChanged = false;
        handler();
      }
    },
    setDisabledHandler(handler) {
      disabledHandler = handler;
      if (state === "disabled") handler();
    },
    ...("type" in server && server.type === "http" ? {
      disableOnTimeout: () => {
        fatal();
        void transport.close();
      },
    } : {}),
    getPeerSignal: () => fatalController.signal,
    closeIsBounded: true,
    async close() {
      if (state === "closed" || state === "closing") return;
      state = "closing";
      clearElicitations(binding, token);
      // Protocol._onclose() deliberately drops its transport reference as
      // soon as our logical close signal fires. Retain and close the wrapper
      // owner directly so EOF/fatal paths still join HTTP DELETE + physical
      // close instead of turning Client.close() into a no-op.
      await transport.close();
      state = "closed";
    },
  };
}

export function allocateAlias(server: string, tool: string, used: Set<string>): string {
  const base = `mcp__${safeToken(server)}__${safeToken(tool)}`;
  let candidate = base.slice(0, 128);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, 128 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export function convertMcpContent(content: ContentBlock): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } {
  switch (content.type) {
    case "text": return { type: "text", text: content.text };
    case "image": return { type: "image", data: content.data, mimeType: content.mimeType };
    case "audio": return { type: "text", text: `[audio mime=${content.mimeType} bytes=${Buffer.from(content.data, "base64").byteLength}]` };
    case "resource_link": return { type: "text", text: `[${content.title ?? content.name ?? content.uri}](${content.uri})` };
    case "resource": return "text" in content.resource
      ? { type: "text", text: content.resource.text }
      : { type: "text", text: `[embedded resource uri=${content.resource.uri} mime=${content.resource.mimeType ?? "application/octet-stream"} bytes=${Buffer.from(content.resource.blob, "base64").byteLength}]` };
    default: throw new Error("Unsupported MCP content block");
  }
}

export function convertMcpResult(result: CallToolResult) {
  return { content: result.content.map(convertMcpContent), details: result };
}

export type McpResultProjection = ReturnType<typeof convertMcpResult>;

interface ServerState {
  server: McpServer;
  token: string;
  handle: McpClientHandle;
  tools: Tool[];
  pages: unknown[];
  aliases: Map<string, string>;
  validators: Map<string, JsonSchemaValidator<Record<string, unknown>>>;
  syntheticAliases: string[];
  validAliases: Set<string>;
  peerDead: boolean;
  disabled: boolean;
  dirty: boolean;
  initializing: boolean;
}

export interface McpBridge {
  clients: McpClientHandle[];
  tools: ToolDefinition[];
  aliases: string[];
  aliasServers: Map<string, string>;
  failedResults: Map<string, McpResultProjection>;
  inlineExtension: InlineExtension;
  instructionsExtension: InlineExtension;
  bindSession(session: AgentSession): void;
  assertReady(): void;
  acquireTurnBoundary(): Promise<() => void>;
  /** Synchronously start every owned client close without aborting refresh work. */
  startDisposal(): void;
  /** Abort refresh admission/work after transport and session-lifetime close starts. */
  abortRefreshes(): void;
  /** Reopen refresh admission only after a successful cancel-only generation. */
  resumeRefreshes(): void;
  drainRefreshes(): Promise<void>;
  close(): Promise<void>;
}

const EMPTY_SCHEMA = Type.Object({});
const URI_SCHEMA = Type.Object({ uri: Type.String() });
const PROMPT_SCHEMA = Type.Object({ name: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.String())) });
const COMPLETE_SCHEMA = Type.Object({
  ref: Type.Union([
    Type.Object({ type: Type.Literal("ref/prompt"), name: Type.String() }),
    Type.Object({ type: Type.Literal("ref/resource"), uri: Type.String() }),
  ]),
  argument: Type.Object({ name: Type.String(), value: Type.String() }),
  context: Type.Optional(Type.Object({ arguments: Type.Optional(Type.Record(Type.String(), Type.String())) })),
});

async function pageAll(
  request: (cursor: string | undefined, options: RequestOptions) => Promise<unknown>,
  signal: AbortSignal,
  deps: PiAcpDeps,
  field: "resources" | "resourceTemplates" | "prompts",
  onUpdate?: Parameters<ToolDefinition["execute"]>[3],
  serverToken = "_",
): Promise<{ items: unknown[]; pages: unknown[] }> {
  const items: unknown[] = [];
  const pages: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error("cycling pagination cursor");
      seen.add(cursor);
    }
    const page = await bounded(request(cursor, {
      signal,
      timeout: deps.mcpTimeoutMs,
      ...(onUpdate ? { onprogress: (value) => {
        const item = value as { progress?: unknown; total?: unknown; message?: unknown };
        onUpdate({
          content: [{
            type: "text",
            text: `[mcp:${serverToken}] ${String(item.progress)}${item.total === undefined ? "" : `/${String(item.total)}`}${item.message === undefined ? "" : ` ${String(item.message)}`}`,
          }],
          details: value,
        });
      } } : {}),
    }), signal, deps.mcpTimeoutMs, deps.sleep) as Record<string, unknown>;
    pages.push(page);
    const values = page[field];
    if (!Array.isArray(values)) throw new Error(`invalid ${field} result`);
    items.push(...values);
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return { items, pages };
}

function syntheticTool(
  alias: string,
  description: string,
  parameters: ToolDefinition["parameters"],
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return { name: alias, label: alias, description, parameters, execute };
}

export async function bridgeMcpServers(
  servers: readonly McpServer[],
  openSignal: AbortSignal,
  deps: PiAcpDeps,
  binding?: McpSessionBinding,
): Promise<McpBridge> {
  const seenNames = new Set<string>();
  for (const server of servers) {
    if (seenNames.has(server.name)) throw adapterError("mcp_init_error", { server: server.name });
    seenNames.add(server.name);
    if ("type" in server && server.type === "acp") throw adapterError("unsupported_mcp_transport", { server: server.name });
  }
  const states: ServerState[] = [];
  const acquiredHandles: McpClientHandle[] = [];
  const failedResults = new Map<string, McpResultProjection>();
  const aliasServers = new Map<string, string>();
  const tools: ToolDefinition[] = [];
  const aliases: string[] = [];
  const usedAliases = new Set<string>();
  const usedServerTokens = new Set<string>();
  const validatorProvider = new AjvJsonSchemaValidator();
  let extensionApi: ExtensionAPI | undefined;
  let piSession: AgentSession | undefined;
  let refreshQueue = Promise.resolve();
  let refreshScheduled = false;
  let closing = false;
  let poisoned = false;
  let refreshController = new AbortController();
  let refreshPaused = false;
  let boundaryTail = Promise.resolve();

  const assertReady = (): void => {
    const dead = states.find((state) => state.peerDead || state.handle.getPeerSignal?.().aborted);
    if (dead) throw adapterError("mcp_init_error", { server: dead.server.name });
  };

  const acquireTurnBoundary = async (): Promise<() => void> => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const prior = boundaryTail;
    boundaryTail = prior.then(() => held);
    await prior;
    return release;
  };

  const allocateServerToken = (name: string): string => {
    const base = safeToken(name);
    let candidate = base;
    for (let index = 2; usedServerTokens.has(candidate); index += 1) candidate = `${base}_${index}`;
    usedServerTokens.add(candidate);
    return candidate;
  };

  const requestOptions = (signal: AbortSignal, onprogress?: (progress: unknown) => void): RequestOptions => ({
    signal,
    timeout: deps.mcpTimeoutMs,
    ...(onprogress ? { onprogress } : {}),
  });

  const makeSynthetic = (state: ServerState, operation: string): ToolDefinition => {
    const alias = allocateAlias(state.token, operation, usedAliases);
    state.syntheticAliases.push(alias);
    state.validAliases.add(alias);
    aliases.push(alias);
    aliasServers.set(alias, state.server.name);
    const executeRequest = async (
      toolCallId: string,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<ToolDefinition["execute"]>[3],
      operation: (
        requestSignal: AbortSignal,
        guardedUpdate: Parameters<ToolDefinition["execute"]>[3],
      ) => Promise<unknown>,
    ) => {
      if (state.disabled || !state.validAliases.has(alias)) {
        throw new Error(`MCP tool ${alias} is no longer available`);
      }
      let acceptingUpdates = true;
      const guardedUpdate: Parameters<ToolDefinition["execute"]>[3] = (update) => {
        if (acceptingUpdates) onUpdate?.(update);
      };
      let result: unknown;
      try {
        result = await settleMcpOperation(
          (requestSignal) => operation(requestSignal, guardedUpdate),
          signal,
          binding?.sessionSignal,
          state.peerDead ? undefined : state.handle.getPeerSignal?.(),
          deps.mcpTimeoutMs,
          deps.sleep,
        );
      } catch (error) {
        if (isMcpTimeout(error)) state.handle.disableOnTimeout?.();
        throw new Error(isMcpTimeout(error) ? `MCP tool ${alias} timed out` : `MCP tool ${alias} failed`);
      } finally {
        acceptingUpdates = false;
      }
      void toolCallId;
      return result;
    };
    const updateProgress = (onUpdate: Parameters<ToolDefinition["execute"]>[3]) => (value: unknown) => {
      const item = value as { progress?: unknown; total?: unknown; message?: unknown };
      onUpdate?.({
        content: [{
          type: "text",
          text: `[mcp:${state.token}] ${String(item.progress)}${item.total === undefined ? "" : `/${String(item.total)}`}${item.message === undefined ? "" : ` ${String(item.message)}`}`,
        }],
        details: value,
      });
    };
    switch (operation) {
      case "list_resources": return syntheticTool(alias, "List MCP resources", EMPTY_SCHEMA, async (_id, _params, signal, onUpdate) => {
        const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => pageAll(state.handle.listResources!.bind(state.handle), requestSignal, deps, "resources", guardedUpdate, state.token));
        const paged = result as { items: unknown[]; pages: unknown[] };
        return { content: [{ type: "text", text: JSON.stringify({ resources: paged.items }) }], details: { pages: paged.pages } };
      });
      case "list_resource_templates": return syntheticTool(alias, "List MCP resource templates", EMPTY_SCHEMA, async (_id, _params, signal, onUpdate) => {
        const paged = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => pageAll(state.handle.listResourceTemplates!.bind(state.handle), requestSignal, deps, "resourceTemplates", guardedUpdate, state.token)) as { items: unknown[]; pages: unknown[] };
        return { content: [{ type: "text", text: JSON.stringify({ resourceTemplates: paged.items }) }], details: { pages: paged.pages } };
      });
      case "read_resource": return syntheticTool(alias, "Read an MCP resource", URI_SCHEMA, async (_id, params, signal, onUpdate) => {
        const input = params as { uri: string };
        const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.readResource!(input.uri, requestOptions(requestSignal, updateProgress(guardedUpdate)))) as { contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> };
        return { content: result.contents.map((content) => content.text !== undefined
          ? { type: "text" as const, text: content.text }
          : { type: "text" as const, text: `[embedded resource uri=${content.uri} mime=${content.mimeType ?? "application/octet-stream"} bytes=${Buffer.from(content.blob ?? "", "base64").byteLength}]` }), details: result };
      });
      case "subscribe_resource": return syntheticTool(alias, "Subscribe to an MCP resource", URI_SCHEMA, async (_id, params, signal, onUpdate) => {
        const input = params as { uri: string };
        const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.subscribeResource!(input.uri, requestOptions(requestSignal, updateProgress(guardedUpdate))));
        return { content: [{ type: "text", text: `Subscribed to ${input.uri}` }], details: result };
      });
      case "unsubscribe_resource": return syntheticTool(alias, "Unsubscribe from an MCP resource", URI_SCHEMA, async (_id, params, signal, onUpdate) => {
        const input = params as { uri: string };
        const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.unsubscribeResource!(input.uri, requestOptions(requestSignal, updateProgress(guardedUpdate))));
        return { content: [{ type: "text", text: `Unsubscribed from ${input.uri}` }], details: result };
      });
      case "list_prompts": return syntheticTool(alias, "List MCP prompts", EMPTY_SCHEMA, async (_id, _params, signal, onUpdate) => {
        const paged = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => pageAll(state.handle.listPrompts!.bind(state.handle), requestSignal, deps, "prompts", guardedUpdate, state.token)) as { items: unknown[]; pages: unknown[] };
        return { content: [{ type: "text", text: JSON.stringify({ prompts: paged.items }) }], details: { pages: paged.pages } };
      });
      case "get_prompt": return syntheticTool(alias, "Get an MCP prompt", PROMPT_SCHEMA, async (_id, params, signal, onUpdate) => {
        const input = params as { name: string; arguments?: Record<string, string> };
        const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.getPrompt!(input.name, input.arguments, requestOptions(requestSignal, updateProgress(guardedUpdate)))) as { description?: string; messages: Array<{ role: string; content: ContentBlock }> };
        const content = [
          ...(result.description ? [{ type: "text" as const, text: `[mcp prompt description]\n${result.description}` }] : []),
          ...result.messages.flatMap((message) => [{ type: "text" as const, text: `[mcp prompt role=${message.role}]` }, convertMcpContent(message.content)]),
        ];
        return { content, details: result };
      });
      case "complete": return syntheticTool(alias, "Complete an MCP prompt or resource argument", COMPLETE_SCHEMA, async (_id, params, signal, onUpdate) => {
        const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.complete!(params, requestOptions(requestSignal, updateProgress(guardedUpdate)))) as { completion: unknown };
        return { content: [{ type: "text", text: JSON.stringify(result.completion) }], details: result };
      });
      default: throw new Error("unknown synthetic MCP operation");
    }
  };

  const remoteDefinition = (state: ServerState, remote: Tool, alias: string): ToolDefinition => ({
    name: alias,
    label: remote.title ?? remote.annotations?.title ?? remote.name,
    description: remote.description ?? `MCP tool ${remote.name}`,
    parameters: remote.inputSchema,
    execute: async (toolCallId, params, signal, onUpdate) => {
      if (state.disabled || !state.validAliases.has(alias) || state.aliases.get(remote.name) !== alias) {
        throw new Error(`MCP tool ${alias} is no longer available`);
      }
      let acceptingUpdates = true;
      let result: CallToolResult;
      try {
        result = await settleMcpOperation(
          (requestSignal) => state.handle.callTool(remote.name, params, requestSignal, deps.mcpTimeoutMs, (value) => {
            if (!acceptingUpdates) return;
            const progressValue = value as { progress?: unknown; total?: unknown; message?: unknown };
            const text = `[mcp:${state.token}] ${String(progressValue.progress)}${progressValue.total === undefined ? "" : `/${String(progressValue.total)}`}${progressValue.message === undefined ? "" : ` ${String(progressValue.message)}`}`;
            onUpdate?.({ content: [{ type: "text", text }], details: value });
          }),
          signal,
          binding?.sessionSignal,
          state.peerDead ? undefined : state.handle.getPeerSignal?.(),
          deps.mcpTimeoutMs,
          deps.sleep,
        );
        const validate = state.validators.get(alias);
        if (validate && !result.isError) {
          if (result.structuredContent === undefined || !validate(result.structuredContent).valid) throw new Error("invalid MCP tool output");
        }
      } catch (error) {
        if (isMcpTimeout(error)) state.handle.disableOnTimeout?.();
        throw new Error(isMcpTimeout(error) ? `MCP tool ${alias} timed out` : `MCP tool ${alias} failed`);
      } finally {
        acceptingUpdates = false;
      }
      const projection = convertMcpResult(result);
      if (result.isError) {
        failedResults.set(toolCallId, projection);
        throw new Error(`MCP tool ${alias} failed`);
      }
      return projection;
    },
  });

  const enumerate = async (
    state: ServerState,
    lifecycleSignal: AbortSignal,
  ): Promise<{ tools: Tool[]; pages: unknown[] }> => {
    const listed: Tool[] = [];
    const pages: unknown[] = [];
    const seenCursors = new Set<string>();
    const seenNames = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) throw new Error("cycling tools/list cursor");
        seenCursors.add(cursor);
      }
      let page: Awaited<ReturnType<McpClientHandle["listTools"]>>;
      try {
        page = await settleMcpOperation(
          (requestSignal) => state.handle.listTools(cursor, requestSignal, deps.mcpTimeoutMs),
          lifecycleSignal,
          binding?.sessionSignal,
          state.handle.getPeerSignal?.(),
          deps.mcpTimeoutMs,
          deps.sleep,
        );
      } catch (error) {
        if (isMcpTimeout(error)) state.handle.disableOnTimeout?.();
        throw error;
      }
      pages.push(page.raw ?? page);
      for (const tool of page.tools) {
        if (seenNames.has(tool.name) || tool.execution?.taskSupport === "required") throw new Error("invalid MCP tool catalog");
        seenNames.add(tool.name);
        listed.push(tool);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return { tools: listed, pages };
  };

  const poison = (state: ServerState) => {
    if (poisoned) return;
    poisoned = true;
    closing = true;
    refreshController.abort(new Error("MCP refresh commit failed"));
    binding?.emitDiagnostic(`[mcp:${state.token}] tools/list refresh commit failed; session terminated`);
    binding?.poison?.(state.server.name);
  };

  const refreshOne = async (state: ServerState): Promise<void> => {
    if (closing || refreshPaused || state.peerDead || state.disabled || !extensionApi || !piSession) return;
    let candidate: { tools: Tool[]; pages: unknown[] };
    let candidateUsed: Set<string>;
    let nextAliases: Map<string, string>;
    let definitions: ToolDefinition[];
    let validators: Map<string, JsonSchemaValidator<Record<string, unknown>>>;
    let removed: string[];
    const addedReservations: Array<{ alias: string; server: string }> = [];
    try {
      candidate = await enumerate(state, refreshController.signal);
      candidateUsed = new Set(usedAliases);
      nextAliases = new Map(state.aliases);
      const previousNames = new Set(state.tools.map((tool) => tool.name));
      definitions = [];
      validators = new Map();
      for (const remote of candidate.tools) {
        let alias = nextAliases.get(remote.name);
        if (!alias) {
          alias = allocateAlias(state.token, remote.name, candidateUsed);
          nextAliases.set(remote.name, alias);
          addedReservations.push({ alias, server: state.server.name });
        }
        if (remote.outputSchema) validators.set(alias, validatorProvider.getValidator(remote.outputSchema));
        definitions.push(remoteDefinition(state, remote, alias));
        previousNames.delete(remote.name);
      }
      removed = [...previousNames]
        .map((name) => state.aliases.get(name))
        .filter((value): value is string => value !== undefined);
    } catch (error) {
      if (isMcpTimeout(error)) state.handle.disableOnTimeout?.();
      if (!closing && !refreshPaused && !state.peerDead && !state.disabled) binding?.emitDiagnostic(`[mcp:${state.token}] tools/list refresh failed`);
      return;
    }

    const release = await acquireTurnBoundary();
    if (closing || refreshPaused || state.peerDead || state.disabled || !extensionApi || !piSession) {
      release();
      return;
    }
    let mutationStarted = false;
    try {
      for (const definition of definitions) {
        mutationStarted = true;
        extensionApi.registerTool(definition);
      }
      const active = new Set(piSession.getActiveToolNames());
      for (const alias of removed) active.delete(alias);
      for (const definition of definitions) active.add(definition.name);
      mutationStarted = true;
      piSession.setActiveToolsByName([...active]);

      usedAliases.clear();
      for (const alias of candidateUsed) usedAliases.add(alias);
      for (const reservation of addedReservations) {
        aliases.push(reservation.alias);
        aliasServers.set(reservation.alias, reservation.server);
      }
      state.aliases = nextAliases;
      state.tools = candidate.tools;
      state.pages = candidate.pages;
      state.validators = validators;
      state.validAliases = new Set([...state.syntheticAliases, ...definitions.map(({ name }) => name)]);
    } catch {
      if (mutationStarted) poison(state);
      else binding?.emitDiagnostic(`[mcp:${state.token}] tools/list refresh failed`);
    } finally {
      release();
    }
  };

  const runRefreshBatches = async (): Promise<void> => {
    while (!closing && !refreshPaused) {
      const batch = states.filter((state) => state.dirty && !state.initializing && !state.peerDead && !state.disabled);
      if (batch.length === 0) return;
      for (const state of batch) state.dirty = false;
      for (const state of batch) await refreshOne(state);
    }
  };

  const scheduleRefreshes = () => {
    if (refreshScheduled || closing || refreshPaused || !extensionApi || !piSession) return;
    refreshScheduled = true;
    refreshQueue = refreshQueue
      .then(runRefreshBatches)
      .finally(() => {
        refreshScheduled = false;
        if (!refreshPaused && states.some((state) => state.dirty && !state.initializing && !state.peerDead && !state.disabled)) scheduleRefreshes();
      });
    refreshQueue.catch(() => undefined);
  };

  const refresh = (state: ServerState) => {
    if (closing || state.peerDead || state.disabled) return;
    state.dirty = true;
    if (!state.initializing && !refreshPaused) scheduleRefreshes();
  };

  try {
    for (const server of servers) {
      const token = allocateServerToken(server.name);
      let handle: McpClientHandle;
      let state: ServerState;
      try {
        const serverBinding = binding ? { ...binding, serverToken: token } : undefined;
        const connecting = deps.connectMcpClient(server, openSignal, serverBinding);
        connecting.then(() => undefined, () => undefined);
        try {
          handle = await settleMcpOperation(
            () => connecting,
            openSignal,
            binding?.sessionSignal,
            undefined,
            deps.mcpTimeoutMs,
            deps.sleep,
          );
        } catch (error) {
          // The outer transport-start bound can win before the factory returns its owner. Observe and
          // close a detached late handle so a real stdio child cannot escape rollback.
          void connecting.then((late) => late.close()).catch(() => undefined);
          throw error;
        }
        // Ownership transfers immediately when connect returns.  Ping, logging,
        // and enumeration are all post-connect work and rollback must close
        // this handle if any of them fails.
        acquiredHandles.push(handle);
        state = {
          server,
          token,
          handle,
          tools: [],
          pages: [],
          aliases: new Map(),
          validators: new Map(),
          syntheticAliases: [],
          validAliases: new Set(),
          peerDead: false,
          disabled: false,
          dirty: false,
          initializing: true,
        };
        states.push(state);
        handle.setToolsChangedHandler?.(() => refresh(state));
        handle.setDisabledHandler?.(() => {
          if (state.peerDead || state.disabled || closing) return;
          // Transport death is observable immediately, but alias validity is
          // committed only while holding the turn boundary.  The running turn
          // therefore retains its selected definition and receives the remote
          // connection failure, not a premature tombstone.
          state.peerDead = true;
          state.dirty = false;
          refreshQueue = refreshQueue.then(async () => {
            if (!piSession || closing) return;
            const release = await acquireTurnBoundary();
            try {
              if (!piSession || closing) return;
              const active = new Set(piSession.getActiveToolNames());
              for (const alias of [...state.syntheticAliases, ...state.aliases.values()]) active.delete(alias);
              piSession.setActiveToolsByName([...active]);
              state.validAliases.clear();
              state.disabled = true;
            } catch {
              poison(state);
            } finally {
              release();
            }
          });
          refreshQueue.catch(() => undefined);
        });
        if (handle.ping) {
          await settleMcpOperation(
            (requestSignal) => handle.ping!(requestSignal, deps.mcpTimeoutMs),
            openSignal,
            binding?.sessionSignal,
            handle.getPeerSignal?.(),
            deps.mcpTimeoutMs,
            deps.sleep,
          );
        } else if (handle.getPeerSignal?.().aborted) {
          throw new McpOperationTerminalError("peer", handle.getPeerSignal?.().reason);
        }
      } catch (error) {
        if (error instanceof McpOperationTerminalError
          && (error.terminalCause === "lifecycle" || error.terminalCause === "session")) {
          throw error.terminalReason;
        }
        if (openSignal.aborted) throw openSignal.reason;
        throw adapterError("mcp_init_error", { server: server.name });
      }
      const caps = handle.getCapabilities?.();
      try {
        if (caps?.logging && handle.setLoggingLevel) {
          await settleMcpOperation(
            (requestSignal) => handle.setLoggingLevel!(requestSignal, deps.mcpTimeoutMs),
            openSignal,
            binding?.sessionSignal,
            handle.getPeerSignal?.(),
            deps.mcpTimeoutMs,
            deps.sleep,
          );
        }
        const operations: string[] = [];
        if (caps?.resources) operations.push("list_resources", "list_resource_templates", "read_resource");
        if (caps?.resources?.subscribe) operations.push("subscribe_resource", "unsubscribe_resource");
        if (caps?.prompts) operations.push("list_prompts", "get_prompt");
        if (caps?.completions) operations.push("complete");
        for (const operation of operations) tools.push(makeSynthetic(state, operation));
        let initial = caps?.tools
          ? await enumerate(state, openSignal)
          : { tools: [], pages: [] };
        if (state.dirty) {
          state.dirty = false;
          try {
            initial = caps?.tools
              ? await enumerate(state, openSignal)
              : { tools: [], pages: [] };
          } catch {
            binding?.emitDiagnostic(`[mcp:${state.token}] tools/list refresh failed`);
          }
        }
        if (state.peerDead || handle.getPeerSignal?.().aborted) {
          throw new McpOperationTerminalError("peer", handle.getPeerSignal?.().reason);
        }
        state.initializing = false;
        state.tools = initial.tools;
        state.pages = initial.pages;
      } catch (error) {
        if (error instanceof McpOperationTerminalError
          && (error.terminalCause === "lifecycle" || error.terminalCause === "session")) {
          throw error.terminalReason;
        }
        if (openSignal.aborted) throw openSignal.reason;
        throw adapterError("mcp_init_error", { server: server.name });
      }
      // A notification accepted while the one coalesced extra pass was running becomes ordinary
      // post-publication work and intentionally does not extend the open-time quiescence barrier.
    }
    // Every capability-conditioned synthetic reservation precedes every remote tool reservation.
    for (const state of states) {
      try {
        for (const remote of state.tools) {
          const alias = allocateAlias(state.token, remote.name, usedAliases);
          state.aliases.set(remote.name, alias);
          aliases.push(alias);
          aliasServers.set(alias, state.server.name);
          state.validAliases.add(alias);
          if (remote.outputSchema) state.validators.set(alias, validatorProvider.getValidator(remote.outputSchema));
          tools.push(remoteDefinition(state, remote, alias));
        }
      } catch {
        throw adapterError("mcp_init_error", { server: state.server.name });
      }
    }
  } catch (error) {
    await closeClients(acquiredHandles, deps);
    throw error;
  }

  const inlineExtension: InlineExtension = {
    name: "agentprism-pi-acp-mcp",
    factory(api) {
      extensionApi = api;
      for (const tool of tools) api.registerTool(tool);
    },
  };
  const instructionsExtension: InlineExtension = {
    name: "agentprism-pi-acp-control",
    factory(api) {
      api.on("before_agent_start", (event) => {
        const suffix = states
          .filter((state) => !state.disabled)
          .map((state) => ({ token: state.token, instructions: state.handle.getInstructions?.() }))
          .filter((item): item is { token: string; instructions: string } => Boolean(item.instructions))
          .map((item) => `\n\n# MCP server instructions (${item.token})\n${item.instructions}`)
          .join("");
        return suffix ? { systemPrompt: `${event.systemPrompt}${suffix}` } : undefined;
      });
    },
  };

  let physicalCloses: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const startDisposal = () => {
    if (!closing) closing = true;
    physicalCloses ??= closeClients(states.map(({ handle }) => handle), deps);
    physicalCloses.catch(() => undefined);
  };
  const abortRefreshes = () => {
    refreshPaused = true;
    if (!refreshController.signal.aborted) refreshController.abort(new Error("MCP refresh aborted"));
  };
  return {
    clients: states.map(({ handle }) => handle),
    tools,
    aliases,
    aliasServers,
    failedResults,
    inlineExtension,
    instructionsExtension,
    bindSession(session) {
      assertReady();
      piSession = session;
      scheduleRefreshes();
    },
    assertReady,
    acquireTurnBoundary,
    startDisposal,
    abortRefreshes,
    resumeRefreshes() {
      if (closing || !refreshPaused) return;
      refreshController = new AbortController();
      refreshPaused = false;
      scheduleRefreshes();
    },
    drainRefreshes: () => refreshQueue,
    close() {
      startDisposal();
      abortRefreshes();
      closePromise ??= (async () => {
        await refreshQueue.catch(() => undefined);
        const release = await acquireTurnBoundary();
        release();
        await physicalCloses;
      })();
      return closePromise;
    },
  };
}

async function closeClients(clients: readonly McpClientHandle[], deps: PiAcpDeps): Promise<void> {
  const closes = [...clients].reverse().map((client) => {
    let close: Promise<void>;
    try {
      // Invocation itself is part of the synchronous logical-close prefix.
      close = client.close();
    } catch {
      return Promise.resolve();
    }
    close.catch(() => undefined);
    return client.closeIsBounded
      ? close.catch(() => undefined)
      : bounded(close, NEVER_ABORTED, deps.mcpTimeoutMs, deps.sleep).catch(() => undefined);
  });
  await Promise.allSettled(closes);
}

export async function disposeMcpBridge(clients: readonly McpClientHandle[], deps: PiAcpDeps): Promise<void> {
  await closeClients(clients, deps);
}
