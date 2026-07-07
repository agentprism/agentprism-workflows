// The ACP transport, POOL-managed. A backend's ACP server (claude-agent-acp / patched
// codex-acp) is spawned ONCE as a long-lived child process and its held ACP client connection
// is REUSED across many agent() calls. The PROCESS lifecycle is pool-managed (PooledConnection);
// the SESSION lifecycle stays per-agent (SessionHandle):
//   PooledConnection.start: spawn + initialize (ONCE; benign clientInfo so Codex config options
//                           stay enabled). NO cwd here — cwd is per-SESSION.
//   openSession -> session/new { cwd }   (per-session cwd PRESERVES worktree isolation)
//             -> session/set_config_option (model selection)
//             -> session/prompt (+ drain session/update)
//             -> session/cancel (on opts.signal)
//             -> session/close   (release the session; the PROCESS stays pooled)
//
// One connection multiplexes MANY concurrent sessions (the engine limiter caps concurrency, and
// a pinned server runs prompts on different sessions concurrently). The single ACP Client handler
// (MultiplexClient) therefore ROUTES every notification/permission request to the right
// per-session accumulator (SessionState) by `sessionId`.
//
// Draining: ACP delivers a prompt turn as session/update notifications followed by the
// session/prompt response, in wire order on one stream. Our client handlers are synchronous
// (they only push into the routed session's arrays), so by the time the session/prompt request
// resolves, every update for THAT session's turn has already been folded into its accumulator —
// even while other sessions' updates interleave on the same wire.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  AGENT_METHODS,
  client,
  CLIENT_METHODS,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AuthMethod,
  type ClientConnection,
  type CompleteElicitationNotification,
  type ConnectMcpRequest,
  type ConnectMcpResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ContentBlock,
  type AgentNotificationMethod,
  type AgentNotificationParamsByMethod,
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type DisableProviderRequest,
  type DisableProviderResponse,
  type DisconnectMcpRequest,
  type DisconnectMcpResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type ListProvidersRequest,
  type ListProvidersResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  type McpConnectionId,
  type MessageMcpNotification,
  type MessageMcpRequest,
  type MessageMcpResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SendRequestOptions,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
  type SessionModeState,
  type SessionNotification,
  type SetProviderRequest,
  type SetProviderResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { TSchema } from "typebox";
import {
  META_KEYS,
  WorkflowError,
  WorkflowErrorCode,
  type AgentHistoryEntry,
  type McpServerConfig,
} from "@automatalabs/shared-types";
import type { Backend, BackendId, StructuredSource } from "./backend.js";
import {
  adaptPromptContent,
  describeAuthProviderAdvertisement,
  describeLifecycleAdvertisement,
  gateCustomMeta,
  isSupportedProtocolVersion,
  negotiateCapabilities,
  unsupportedMcpServer,
  type NegotiatedCapabilities,
} from "./capabilities.js";
import { emitSessionUpdate, type AcpEventContext, type AcpEventSink } from "./events.js";
import {
  decidePermission,
  type ElicitationResolver,
  type PermissionResolver,
  type ToolPolicy,
} from "./permissions.js";
import { UsageAccumulator } from "./usage.js";
import {
  clientCapabilitiesFor,
  hasFullMcpHandlers,
  type AcpSessionContext,
  type ClientHandlers,
  type TerminalHandlers,
} from "./client-handlers.js";

/** A benign client identity. NOT JetBrains/IntelliJ 2026.1 — that exact identity makes
 *  codex-acp disable session config options (our model/effort routing channel). */
const CLIENT_INFO = {
  name: "agentprism-workflows",
  title: "AgentPrism Workflows",
  version: "0.1.0",
} as const;

const CLAUDE_RAW_MESSAGE_METHOD = "_claude/sdkMessage";
/** Bound the best-effort session/close round-trip so a slow agent can't hang run()'s finally. */
const CLOSE_SESSION_TIMEOUT_MS = 5_000;
/** Bound the graceful SIGTERM shutdown before escalating to SIGKILL. */
const DISPOSE_SIGKILL_GRACE_MS = 2_000;
const TOMBSTONE_SESSION_CAP = 64;
const GUARDED_STATEFUL_REQUESTS = new Map<string, string>([
  [AGENT_METHODS.session_new, "use openSession()"],
  [AGENT_METHODS.session_load, "use loadSession()"],
  [AGENT_METHODS.session_resume, "use resumeSession()"],
  [
    AGENT_METHODS.session_fork,
    "no driven wrapper yet; raw forked sessions cannot be routed (permissions auto-cancel)",
  ],
]);

interface RawResultSuccess {
  type: string;
  subtype: string;
  structured_output?: unknown;
}

interface SessionTombstone {
  readonly cwd: string;
  readonly label?: string;
  readonly runId?: string;
}

const parseConnectMcpRequest = (params: unknown): ConnectMcpRequest => params as ConnectMcpRequest;
const parseMessageMcpRequest = (params: unknown): MessageMcpRequest => params as MessageMcpRequest;
const parseMessageMcpNotification = (params: unknown): MessageMcpNotification =>
  params as MessageMcpNotification;
const parseDisconnectMcpRequest = (params: unknown): DisconnectMcpRequest => params as DisconnectMcpRequest;

/** Per-session accumulator: assistant text, tool history, usage, the Claude raw structured_output,
 *  and the permission policy/resolver used to answer permission requests for THIS session. */
class SessionState {
  readonly textChunks: string[] = [];
  readonly history: AgentHistoryEntry[] = [];
  readonly usage = new UsageAccumulator();
  readonly pendingPermissions = new Set<(outcome: RequestPermissionResponse) => void>();
  readonly pendingElicitations = new Set<(outcome: CreateElicitationResponse) => void>();
  readonly urlElicitationIds = new Set<string>();
  readonly mcpConnectionIds = new Set<McpConnectionId>();
  rawResultSuccess: RawResultSuccess | undefined;
  modes: SessionModeState | null | undefined;
  private turnStartIndex = 0;

  /** `label`/`runId` are carried here ONLY so the MultiplexClient can stamp them onto emitted
   *  events as context — they never affect routing or the wire request. */
  constructor(
    readonly cwd: string,
    readonly policy: ToolPolicy,
    readonly permissionResolver?: PermissionResolver,
    readonly elicitationResolver?: ElicitationResolver,
    readonly label?: string,
    readonly runId?: string,
    modes?: SessionModeState | null,
    readonly mcpServerIds: readonly string[] = [],
    private readonly retainSessionLog = true,
  ) {
    this.modes = modes;
  }

  /** Mark the start of a new turn so currentTurnText()/structured_output read only this turn.
   *  Long-lived interactive sessions can opt out of retaining old text/history because hosts
   *  stream live events and keep their own transcript; clearing here prevents dead logs from
   *  growing for the lifetime of a held-open session. */
  beginTurn(): void {
    if (this.retainSessionLog) {
      this.turnStartIndex = this.textChunks.length;
    } else {
      this.textChunks.length = 0;
      this.history.length = 0;
      this.turnStartIndex = 0;
    }
    this.rawResultSuccess = undefined;
  }

  currentTurnText(): string {
    return this.textChunks.slice(this.turnStartIndex).join("");
  }

  applyUpdate(update: SessionNotification["update"]): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.textChunks.push(update.content.text);
          this.history.push({
            role: "assistant",
            kind: "text",
            text: update.content.text,
            timestamp: Date.now(),
          });
        }
        break;
      }
      case "tool_call": {
        this.history.push({
          role: "tool",
          kind: "toolCall",
          text: update.title,
          toolName: toolNameFromMeta(update._meta) ?? update.kind,
          timestamp: Date.now(),
        });
        break;
      }
      case "usage_update": {
        this.usage.recordCost(update.cost);
        // Also feed the context token counts so AgentUsage.total is non-zero for backends
        // that report tokens via usage_update but never via PromptResponse.usage.
        this.usage.recordContextTokens(update.used, update.size);
        break;
      }
      case "current_mode_update": {
        this.modes = {
          ...(this.modes ?? { availableModes: [] }),
          currentModeId: update.currentModeId,
        };
        break;
      }
      default:
        break;
    }
  }

  applyRawMessage(message: RawResultSuccess | undefined): void {
    if (message && message.type === "result" && message.subtype === "success") {
      this.rawResultSuccess = message;
    }
  }

  /** Settle every deferred permission still parked on this session. Used by release/cancel/death
   *  teardown so an interactive resolver can never strand an ACP prompt turn. */
  settlePendingPermissions(): void {
    for (const settle of [...this.pendingPermissions]) settle(cancelledPermissionResponse());
  }

  /** Same teardown guarantee for elicitation/create: a parked human prompt must not survive
   *  release/cancel/death after its ACP session is gone. */
  settlePendingElicitations(): void {
    for (const settle of [...this.pendingElicitations]) settle(cancelledElicitationResponse());
  }
}

/** The single client-side handler set for one pooled connection (registered on the SDK's fluent
 *  client() app). It ROUTES every notification and permission request to the per-session
 *  SessionState by `sessionId`, so one process can serve many concurrent sessions without their
 *  streams crossing. */
class MultiplexClient {
  private readonly sessions = new Map<string, SessionState>();
  private readonly urlElicitationContexts = new Map<string, AcpEventContext>();
  private readonly mcpServerSessions = new Map<string, string>();
  private readonly mcpConnectionSessions = new Map<McpConnectionId, string>();
  /** Recently unregistered sessions kept ONLY for the teardown window: ACP agents may
   *  legitimately release terminals (or finish fs/terminal cleanup) after this client releases
   *  the session because session/close is cancel + free resources and the Agent owns terminal
   *  release. Store only the slim routing context and cap it FIFO so the memory cost is bounded. */
  private readonly tombstones = new Map<string, SessionTombstone>();

  /** `backendId` stamps event context; `onEvent` (optional) bubbles every notification, permission
   *  request and session lifecycle change up to the runner's typed bus. `permissionResolver` is
   *  the runner-wide default; a SessionState resolver wins when present. */
  constructor(
    private readonly backendId: BackendId,
    private readonly onEvent?: AcpEventSink,
    private readonly handlers?: ClientHandlers,
    private readonly permissionResolver?: PermissionResolver,
    private readonly elicitationResolver?: ElicitationResolver,
  ) {}

  private contextFor(sessionId: string, state: SessionState | undefined): AcpEventContext {
    return { sessionId, backendId: this.backendId, label: state?.label, runId: state?.runId };
  }

  private handlerContext(params: { sessionId: string }): AcpSessionContext {
    const state = this.sessions.get(params.sessionId);
    if (state) return { sessionId: params.sessionId, cwd: state.cwd, label: state.label, runId: state.runId };
    const tombstone = this.tombstones.get(params.sessionId);
    if (tombstone) return { sessionId: params.sessionId, ...tombstone };
    throw unknownSession(params.sessionId);
  }

  private dispatch<P extends { sessionId: string }, R>(
    params: P,
    wireMethod: string,
    handler: ((params: P, ctx: AcpSessionContext) => R) | undefined,
  ): R {
    if (typeof handler !== "function") throw methodNotAdvertised(wireMethod);
    const ctx = this.handlerContext(params);
    return handler(params, ctx);
  }

  register(sessionId: string, state: SessionState): void {
    this.tombstones.delete(sessionId);
    this.sessions.set(sessionId, state);
    for (const serverId of state.mcpServerIds) this.mcpServerSessions.set(serverId, sessionId);
    this.onEvent?.("session_open", this.contextFor(sessionId, state));
  }

  unregister(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    state?.settlePendingPermissions();
    state?.settlePendingElicitations();
    if (state) this.disconnectMcpConnectionsForSession(sessionId, state);
    this.sessions.delete(sessionId);
    if (state) {
      for (const serverId of state.mcpServerIds) {
        if (this.mcpServerSessions.get(serverId) === sessionId) this.mcpServerSessions.delete(serverId);
      }
      for (const elicitationId of state.urlElicitationIds) this.urlElicitationContexts.delete(elicitationId);
      this.tombstones.set(sessionId, {
        cwd: state.cwd,
        label: state.label,
        runId: state.runId,
      });
      while (this.tombstones.size > TOMBSTONE_SESSION_CAP) {
        const oldest = this.tombstones.keys().next().value;
        if (oldest === undefined) break;
        this.tombstones.delete(oldest);
      }
      this.onEvent?.("session_close", this.contextFor(sessionId, state));
    }
  }

  settlePendingPermissions(sessionId: string): void {
    this.sessions.get(sessionId)?.settlePendingPermissions();
  }

  settlePendingElicitations(sessionId: string): void {
    this.sessions.get(sessionId)?.settlePendingElicitations();
  }

  settleAllPendingPermissions(): void {
    for (const state of this.sessions.values()) {
      state.settlePendingPermissions();
    }
  }

  settleAllPendingElicitations(): void {
    for (const state of this.sessions.values()) {
      state.settlePendingElicitations();
    }
  }

  disconnectAllMcpConnections(): void {
    for (const [sessionId, state] of this.sessions) {
      this.disconnectMcpConnectionsForSession(sessionId, state);
    }
    this.mcpServerSessions.clear();
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> | RequestPermissionResponse {
    const state = this.sessions.get(params.sessionId);
    // Unknown/closed session: refuse rather than silently allow a tool we can't attribute.
    if (!state) return cancelledPermissionResponse();
    const ctx = this.contextFor(params.sessionId, state);
    const resolver = state.permissionResolver ?? this.permissionResolver;
    if (resolver) return this.requestPermissionViaResolver(params, state, ctx, resolver);
    const outcome = decidePermission(params, state.policy);
    this.onEvent?.("permission_request", {
      ...ctx,
      request: params,
      outcome,
    });
    return outcome;
  }

  private requestPermissionViaResolver(
    params: RequestPermissionRequest,
    state: SessionState,
    ctx: AcpEventContext,
    resolver: PermissionResolver,
  ): Promise<RequestPermissionResponse> {
    let settled = false;
    let settle!: (outcome: RequestPermissionResponse) => void;
    const response = new Promise<RequestPermissionResponse>((resolve) => {
      settle = (outcome) => {
        if (settled) return;
        settled = true;
        state.pendingPermissions.delete(settle);
        this.onEvent?.("permission_request", { ...ctx, request: params, outcome });
        resolve(outcome);
      };
      state.pendingPermissions.add(settle);
      this.onEvent?.("permission_pending", { ...ctx, request: params });

      try {
        Promise.resolve(resolver(params, ctx)).then(
          (outcome) => {
            settle(outcome);
          },
          () => {
            // No session-scoped resolver-error event exists; the permission_request event still
            // reports the FINAL outcome exactly once, so rejection is observable as cancellation.
            settle(cancelledPermissionResponse());
          },
        );
      } catch {
        settle(cancelledPermissionResponse());
      }
    });
    response.catch(() => {});
    return response;
  }

  requestElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> | CreateElicitationResponse {
    const sessionId = sessionIdFromElicitationRequest(params);
    if (!sessionId) return declinedElicitationResponse();

    const state = this.sessions.get(sessionId);
    const ctx = this.contextFor(sessionId, state);
    // Unknown/closed session: decline rather than asking a human for a prompt we cannot route.
    if (!state) {
      const outcome = declinedElicitationResponse();
      this.onEvent?.("elicitation_request", { ...ctx, request: params, outcome });
      return outcome;
    }

    this.trackUrlElicitation(params, state, ctx);
    const resolver = state.elicitationResolver ?? this.elicitationResolver;
    if (resolver) return this.requestElicitationViaResolver(params, state, ctx, resolver);

    const outcome = declinedElicitationResponse();
    this.onEvent?.("elicitation_request", { ...ctx, request: params, outcome });
    return outcome;
  }

  private requestElicitationViaResolver(
    params: CreateElicitationRequest,
    state: SessionState,
    ctx: AcpEventContext,
    resolver: ElicitationResolver,
  ): Promise<CreateElicitationResponse> {
    let settled = false;
    let settle!: (outcome: CreateElicitationResponse) => void;
    const response = new Promise<CreateElicitationResponse>((resolve) => {
      settle = (outcome) => {
        if (settled) return;
        settled = true;
        state.pendingElicitations.delete(settle);
        this.onEvent?.("elicitation_request", { ...ctx, request: params, outcome });
        resolve(outcome);
      };
      state.pendingElicitations.add(settle);
      this.onEvent?.("elicitation_pending", { ...ctx, request: params });

      try {
        Promise.resolve(resolver(params, ctx)).then(
          (outcome) => {
            settle(outcome);
          },
          () => {
            // Resolver failure is observable as the FINAL cancel outcome; no extra error event is
            // needed, and the prompt turn continues instead of hanging behind a rejected promise.
            settle(cancelledElicitationResponse());
          },
        );
      } catch {
        settle(cancelledElicitationResponse());
      }
    });
    response.catch(() => {});
    return response;
  }

  private trackUrlElicitation(
    params: CreateElicitationRequest,
    state: SessionState,
    ctx: AcpEventContext,
  ): void {
    const elicitationId = urlElicitationId(params);
    if (!elicitationId) return;
    state.urlElicitationIds.add(elicitationId);
    this.urlElicitationContexts.set(elicitationId, ctx);
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> | ReadTextFileResponse {
    return this.dispatch(params, CLIENT_METHODS.fs_read_text_file, this.handlers?.fs?.readTextFile);
  }

  writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse | void> | WriteTextFileResponse | void {
    return this.dispatch(params, CLIENT_METHODS.fs_write_text_file, this.handlers?.fs?.writeTextFile);
  }

  createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> | CreateTerminalResponse {
    return this.dispatch(params, CLIENT_METHODS.terminal_create, this.handlers?.terminal?.createTerminal);
  }

  terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> | TerminalOutputResponse {
    return this.dispatch(params, CLIENT_METHODS.terminal_output, this.handlers?.terminal?.terminalOutput);
  }

  releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse | void> | ReleaseTerminalResponse | void {
    return this.dispatch(params, CLIENT_METHODS.terminal_release, this.handlers?.terminal?.releaseTerminal);
  }

  waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> | WaitForTerminalExitResponse {
    return this.dispatch(
      params,
      CLIENT_METHODS.terminal_wait_for_exit,
      this.handlers?.terminal?.waitForTerminalExit,
    );
  }

  killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse | void> | KillTerminalResponse | void {
    return this.dispatch(params, CLIENT_METHODS.terminal_kill, this.handlers?.terminal?.killTerminal);
  }

  async mcpConnect(params: ConnectMcpRequest): Promise<ConnectMcpResponse> {
    const handler = this.handlers?.mcp?.connect;
    if (typeof handler !== "function") throw methodNotAdvertised(CLIENT_METHODS.mcp_connect);
    const sessionId = this.mcpServerSessions.get(params.serverId);
    if (!sessionId) throw unknownMcpServer(params.serverId);
    const response = await handler(params, this.handlerContext({ sessionId }));
    this.mcpConnectionSessions.set(response.connectionId, sessionId);
    this.sessions.get(sessionId)?.mcpConnectionIds.add(response.connectionId);
    return response;
  }

  async mcpMessage(params: MessageMcpRequest): Promise<MessageMcpResponse> {
    const handler = this.handlers?.mcp?.message;
    if (typeof handler !== "function") throw methodNotAdvertised(CLIENT_METHODS.mcp_message);
    const ctx = this.handlerContext({ sessionId: this.sessionIdForMcpConnection(params.connectionId) });
    return handler(params, ctx);
  }

  mcpMessageNotification(params: MessageMcpNotification): void {
    const handler = this.handlers?.mcp?.message;
    if (typeof handler !== "function") return;
    const sessionId = this.mcpConnectionSessions.get(params.connectionId);
    if (!sessionId) return;
    try {
      Promise.resolve(handler(params, this.handlerContext({ sessionId }))).catch(() => {});
    } catch {
      // Notifications have no response path; teardown remains best-effort and non-fatal.
    }
  }

  async mcpDisconnect(params: DisconnectMcpRequest): Promise<DisconnectMcpResponse> {
    const handler = this.handlers?.mcp?.disconnect;
    if (typeof handler !== "function") throw methodNotAdvertised(CLIENT_METHODS.mcp_disconnect);
    const sessionId = this.sessionIdForMcpConnection(params.connectionId);
    try {
      return (await handler(params, this.handlerContext({ sessionId }))) ?? {};
    } finally {
      this.dropMcpConnection(params.connectionId, sessionId);
    }
  }

  sessionUpdate(params: SessionNotification): void {
    const state = this.sessions.get(params.sessionId);
    // Fold into the accumulator FIRST (the drain contract), THEN bubble the event up unchanged.
    state?.applyUpdate(params.update);
    if (this.onEvent) {
      emitSessionUpdate(this.onEvent, params.update, this.contextFor(params.sessionId, state));
    }
  }

  extNotification(method: string, params: Record<string, unknown>): void {
    if (method !== CLAUDE_RAW_MESSAGE_METHOD) return;
    // claude-agent-acp stamps the owning sessionId on every raw _claude/sdkMessage; route by it
    // so structured_output lands in the right session under concurrency.
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!sessionId) return;
    const rawMessage = (params as { message?: unknown }).message;
    const state = this.sessions.get(sessionId);
    state?.applyRawMessage(rawMessage as RawResultSuccess | undefined);
    this.onEvent?.("raw_message", {
      ...this.contextFor(sessionId, state),
      method,
      message: rawMessage,
    });
  }

  elicitationComplete(params: CompleteElicitationNotification): void {
    const ctx = this.urlElicitationContexts.get(params.elicitationId);
    if (!ctx) return;
    this.urlElicitationContexts.delete(params.elicitationId);
    this.sessions.get(ctx.sessionId)?.urlElicitationIds.delete(params.elicitationId);
    this.onEvent?.("elicitation_complete", { ...ctx, notification: params });
  }

  private sessionIdForMcpConnection(connectionId: McpConnectionId): string {
    const sessionId = this.mcpConnectionSessions.get(connectionId);
    if (!sessionId) throw unknownMcpConnection(connectionId);
    return sessionId;
  }

  private dropMcpConnection(connectionId: McpConnectionId, sessionId: string): void {
    this.mcpConnectionSessions.delete(connectionId);
    this.sessions.get(sessionId)?.mcpConnectionIds.delete(connectionId);
  }

  private disconnectMcpConnectionsForSession(sessionId: string, state: SessionState): void {
    const handler = this.handlers?.mcp?.disconnect;
    const ctx: AcpSessionContext = { sessionId, cwd: state.cwd, label: state.label, runId: state.runId };
    for (const connectionId of [...state.mcpConnectionIds]) {
      this.mcpConnectionSessions.delete(connectionId);
      state.mcpConnectionIds.delete(connectionId);
      if (typeof handler !== "function") continue;
      try {
        Promise.resolve(handler({ connectionId }, ctx)).catch(() => {});
      } catch {
        // Best-effort teardown: a broken MCP cleanup hook must not block session release/death.
      }
    }
  }
}

function unknownSession(sessionId: string): RequestError {
  return RequestError.invalidParams({ sessionId }, `unknown session: ${sessionId}`);
}

function unknownMcpServer(serverId: string): RequestError {
  return RequestError.invalidParams({ serverId }, `unknown MCP-over-ACP server: ${serverId}`);
}

function unknownMcpConnection(connectionId: McpConnectionId): RequestError {
  return RequestError.invalidParams({ connectionId }, `unknown MCP-over-ACP connection: ${connectionId}`);
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function declinedElicitationResponse(): CreateElicitationResponse {
  return { action: "decline" };
}

function cancelledElicitationResponse(): CreateElicitationResponse {
  return { action: "cancel" };
}

function sessionIdFromElicitationRequest(params: CreateElicitationRequest): string | undefined {
  return "sessionId" in params && typeof params.sessionId === "string" ? params.sessionId : undefined;
}

function urlElicitationId(params: CreateElicitationRequest): string | undefined {
  return params.mode === "url" && "elicitationId" in params && typeof params.elicitationId === "string"
    ? params.elicitationId
    : undefined;
}

function methodNotAdvertised(method: string): RequestError {
  return new RequestError(-32601, `${method} was not advertised by this client`, { method });
}

function assertSafeRawRequest(method: string): void {
  const guidance = GUARDED_STATEFUL_REQUESTS.get(method);
  if (!guidance) return;
  throw new Error(
    `Raw ACP request "${method}" is guarded: ${guidance}. Sessions created, reopened, or forked ` +
      "outside the router are unregistered: session/update notifications do not fold into an " +
      "accumulator, permission requests auto-cancel, and fs/terminal dispatch fails for unknown sessions.",
  );
}

function modeIds(modes: SessionModeState | null | undefined): string[] {
  return modes?.availableModes.map((mode) => mode.id) ?? [];
}

function modeStateFromConfigOption(option: ModelSelectOption, currentModeId: string): SessionModeState {
  return {
    currentModeId,
    availableModes: flattenSelectOptions(option.options).map((value) => ({
      id: value.value,
      name: value.name,
      ...(value.description !== undefined ? { description: value.description } : {}),
      ...(value._meta !== undefined ? { _meta: value._meta } : {}),
    })),
  };
}

function modeSelectionError(
  backendId: BackendId,
  requested: string,
  advertisedIds: string[],
  label: string | undefined,
  cause?: unknown,
): WorkflowError {
  const advertised = advertisedIds.length > 0 ? advertisedIds.join(", ") : "none";
  const suffix = cause ? `: ${thrownMessage(cause)}` : "";
  return new WorkflowError(
    `ACP agent (${backendId}) cannot apply session mode "${requested}" (advertised modes: ${advertised})${suffix}`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label, details: cause },
  );
}

function lifecycleCapabilityError(
  backendId: BackendId,
  method: string,
  capabilities: NegotiatedCapabilities | undefined,
  label: string | undefined,
): WorkflowError {
  const advertised = capabilities
    ? describeLifecycleAdvertisement(capabilities.agent)
    : "initialize did not complete";
  return new WorkflowError(
    `ACP agent (${backendId}) does not advertise ${method}; advertised lifecycle capabilities: ${advertised}`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label },
  );
}

function authProviderCapabilityError(
  backendId: BackendId,
  method: string,
  capabilities: NegotiatedCapabilities | undefined,
  label: string | undefined,
): WorkflowError {
  const advertised = capabilities
    ? describeAuthProviderAdvertisement(capabilities.agent, capabilities.authMethods)
    : "initialize did not complete";
  return new WorkflowError(
    `ACP agent (${backendId}) does not advertise ${method}; advertised auth/provider capabilities: ${advertised}`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label },
  );
}

function isMethodNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === -32601);
}

function agentMethodNotFoundError(
  backendId: BackendId,
  method: string,
  label: string | undefined,
  cause: unknown,
): WorkflowError {
  return new WorkflowError(
    `ACP agent (${backendId}) does not implement ${method}: ${thrownMessage(cause)}`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label, details: cause },
  );
}

function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

const DEFAULT_INIT_TIMEOUT_MS = 60_000;

/** Deadline for the one-time ACP `initialize` handshake per pooled process. Overridable via
 *  AGENTPRISM_ACP_INIT_TIMEOUT_MS (e.g. for slow cold-start backends). Clamped to >= 1s. */
function initializeTimeoutMs(): number {
  const env = process.env.AGENTPRISM_ACP_INIT_TIMEOUT_MS;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 1000) return parsed;
  }
  return DEFAULT_INIT_TIMEOUT_MS;
}

/** Shallow-merge `_meta` layers lowest-to-highest precedence, treating empty layers as absent
 *  so an unconfigured session keeps sending NO `_meta` at all. */
function layerMeta(...layers: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const present = layers.filter((l): l is Record<string, unknown> => Boolean(l && Object.keys(l).length > 0));
  if (present.length === 0) return undefined;
  return Object.assign({}, ...present);
}

function acpMcpServerIds(servers: McpServerConfig[] | undefined): string[] {
  return servers
    ?.filter((server): server is Extract<McpServerConfig, { type: "acp" }> => "type" in server && server.type === "acp")
    .map((server) => server.serverId) ?? [];
}

/** Merge the engine runId correlation stamp into a backend's session/new `_meta`. Returns the
 *  meta unchanged when no runId is given (so a backend that sends no `_meta` keeps sending none). */
function stampRunId(
  meta: Record<string, unknown> | undefined,
  runId: string | undefined,
): Record<string, unknown> | undefined {
  if (!runId) return meta;
  return { ...(meta ?? {}), [META_KEYS.runId]: runId };
}

function toolNameFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  for (const value of Object.values(meta as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const toolName = (value as Record<string, unknown>).toolName;
      if (typeof toolName === "string") return toolName;
    }
  }
  return undefined;
}

export interface AcpSessionOptions {
  /** Absolute working directory for the ACP session (worktree isolation). */
  cwd: string;
  /** The schema for this run, if any (drives the backend's session/prompt `_meta`). */
  schema: TSchema | undefined;
  policy: ToolPolicy;
  /** Session-scoped permission resolver. When present it wins over the runner default and
   *  replaces the synchronous ToolPolicy auto-response path for this session. */
  permissionResolver?: PermissionResolver;
  /** Session-scoped elicitation resolver. When present it wins over the runner default for this
   *  session; initialize-time advertisement still depends on the runner-wide resolver. */
  elicitationResolver?: ElicitationResolver;
  signal?: AbortSignal;
  /** Client-provided MCP servers to attach at session/new. Omitted => `[]` (the default). */
  mcpServers?: McpServerConfig[];
  /** Generic session-scoped `_meta` passthrough (RunOptions.meta). Merged FIRST, under the
   *  backend-computed `_meta` and the runId stamp, so user keys never clobber the schema /
   *  correlation channels. Omitted => the request `_meta` is whatever the backend set. */
  meta?: Record<string, unknown>;
  /** Engine run id, stamped onto session/new `_meta` (META_KEYS.runId) as a correlation id.
   *  Omitted => no runId `_meta` is stamped (the request `_meta` is whatever the backend set). */
  runId?: string;
  /** `RunOptions.label`, propagated onto emitted events as context. NOT sent on the wire. */
  label?: string;
  /** CODEX-ONLY session instruction overrides. The backend folds these into session/new `_meta`
   *  (bare keys) for the codex-acp adapter; the Claude backend ignores them. Omitted => unset. */
  baseInstructions?: string;
  developerInstructions?: string;
  /** Retain accumulated assistant text/tool history for the lifetime of this ACP session.
   *  Default true preserves run()'s diagnostic history contract. Held-open interactive sessions
   *  pass false because hosts stream live events / keep their own transcript; retaining old turns
   *  there is dead memory for day-long sessions. */
  retainSessionLog?: boolean;
}

/** Notified by a PooledConnection when its process dies, so the pool can drop it. */
export interface PooledConnectionDeps {
  onDead(connection: PooledConnection): void;
  /** Optional typed event sink. When present, every ACP notification / permission request /
   *  session lifecycle change on this connection is bubbled up through it (additive observability;
   *  it is invoked AFTER the drain accumulation and never affects the run). */
  onEvent?: AcpEventSink;
  /** Runner-wide permission resolver default. SessionState.permissionResolver overrides it. */
  permissionResolver?: PermissionResolver;
  /** Runner-wide elicitation resolver default. SessionState.elicitationResolver overrides it. */
  elicitationResolver?: ElicitationResolver;
  /** Initialize-time elicitation advertisement; fixed per connection, so it is driven by the
   *  runner-wide resolver rather than session-scoped responders attached later. */
  advertiseElicitation?: boolean;
  /** Client-side ACP fs/terminal handlers advertised once and routed by sessionId. */
  clientHandlers?: ClientHandlers;
}

interface RawAgentRequestContext {
  sendRequest<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    mapResponse?: undefined,
    options?: SendRequestOptions,
  ): Promise<Response>;
}

/**
 * One long-lived ACP server subprocess + its held ACP client connection. Initialized ONCE and
 * reused across agent() calls; it multiplexes many concurrent sessions. The process is NOT killed
 * between sessions — only dispose() (pool teardown) or a crash ends it.
 */
export class PooledConnection {
  readonly backendId: BackendId;
  /** The held ACP connection (fluent client() app); session/* calls go through its
   *  `agent` ClientContext via the typed wrappers below. */
  private readonly connection: ClientConnection;

  private readonly backend: Backend;
  private readonly child: ChildProcess;
  private readonly client: MultiplexClient;
  private readonly onDead: (connection: PooledConnection) => void;
  private readonly onEvent: AcpEventSink | undefined;
  private readonly clientHandlers: ClientHandlers | undefined;
  private readonly advertiseElicitation: boolean;
  /** Set true at the start of dispose() so the graceful-shutdown death is NOT reported as a crash. */
  private disposing = false;
  /** Resolves once `initialize` completed (or rejects if the process died first). */
  private readonly ready: Promise<void>;
  /** Resolves when the process dies; `race()` turns it into a thrown, descriptive error. */
  private readonly whenDead: Promise<void>;
  private resolveDead!: () => void;
  private deathError: Error | undefined;

  /** Set from the one-time initialize handshake; undefined until it completes (or if it failed). */
  private negotiated: NegotiatedCapabilities | undefined;
  private _alive = true;
  private _activeSessions = 0;
  private stderrTail = "";

  private constructor(backend: Backend, deps: PooledConnectionDeps) {
    this.backend = backend;
    this.backendId = backend.id;
    this.onDead = deps.onDead;
    this.onEvent = deps.onEvent;
    this.clientHandlers = deps.clientHandlers;
    this.advertiseElicitation = deps.advertiseElicitation ?? Boolean(deps.elicitationResolver);
    this.client = new MultiplexClient(
      this.backendId,
      this.onEvent,
      deps.clientHandlers,
      deps.permissionResolver,
      deps.elicitationResolver,
    );

    const { command, args, env } = backend.spawnConfig();
    // NOTE: deliberately NO `cwd` here. cwd is per-SESSION (session/new), so one pooled process
    // serves runs in different worktrees without losing isolation.
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    this.child = child;

    if (!child.stdin || !child.stdout) {
      throw new Error(`Failed to spawn ACP agent (${backend.id}): missing stdio pipes`);
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    // Swallow stdio pipe errors (EPIPE/ECONNRESET when the child dies mid-write) so they don't
    // bubble up as an "Unhandled 'error' event" and crash the host. Process death is handled via
    // the 'exit'/'error' events on `child` below.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});

    this.whenDead = new Promise<void>((resolve) => {
      this.resolveDead = resolve;
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    // The fluent client() app: every inbound agent->client request/notification is registered
    // here and dispatched to the MultiplexClient router. All request handlers are registered
    // unconditionally — MultiplexClient.dispatch() answers a method the consumer provided no
    // handler for with the same -32601 "not advertised" error as before, so behavior is
    // identical to the previous Client-interface wiring.
    //
    // ORDER MATTERS: the two accumulation-feeding notifications MUST be registered FIRST.
    // The SDK Connection runs only the first matching handler synchronously inside the
    // read-loop turn; later handlers each cost a microtask hop, which lets an in-flight
    // session/prompt RESPONSE continuation overtake a session/update notification that
    // arrived before it on the wire. Registering session/update (and the Claude raw-message
    // channel) first preserves the drain contract this file documents — every update for a
    // turn is folded into its accumulator before that turn's prompt() resolves — exactly as
    // the SDK's own (deprecated) ClientSideConnection wrapper registered them.
    this.connection = client({ name: CLIENT_INFO.name })
      .onNotification(CLIENT_METHODS.session_update, ({ params }) => this.client.sessionUpdate(params))
      .onNotification(
        CLAUDE_RAW_MESSAGE_METHOD,
        (params: unknown) => (params ?? {}) as Record<string, unknown>,
        ({ params }) => this.client.extNotification(CLAUDE_RAW_MESSAGE_METHOD, params),
      )
      .onNotification(CLIENT_METHODS.elicitation_complete, ({ params }) => this.client.elicitationComplete(params))
      .onRequest(CLIENT_METHODS.session_request_permission, ({ params }) => this.client.requestPermission(params))
      .onRequest(CLIENT_METHODS.elicitation_create, ({ params }) => this.client.requestElicitation(params))
      .onRequest(CLIENT_METHODS.fs_read_text_file, ({ params }) => this.client.readTextFile(params))
      .onRequest(CLIENT_METHODS.fs_write_text_file, ({ params }) => this.client.writeTextFile(params))
      .onRequest(CLIENT_METHODS.terminal_create, ({ params }) => this.client.createTerminal(params))
      .onRequest(CLIENT_METHODS.terminal_output, ({ params }) => this.client.terminalOutput(params))
      .onRequest(CLIENT_METHODS.terminal_release, ({ params }) => this.client.releaseTerminal(params))
      .onRequest(CLIENT_METHODS.terminal_wait_for_exit, ({ params }) => this.client.waitForTerminalExit(params))
      .onRequest(CLIENT_METHODS.terminal_kill, ({ params }) => this.client.killTerminal(params))
      .onRequest(CLIENT_METHODS.mcp_connect, parseConnectMcpRequest, ({ params }) => this.client.mcpConnect(params))
      .onRequest(CLIENT_METHODS.mcp_message, parseMessageMcpRequest, ({ params }) => this.client.mcpMessage(params))
      .onRequest(CLIENT_METHODS.mcp_disconnect, parseDisconnectMcpRequest, ({ params }) =>
        this.client.mcpDisconnect(params),
      )
      .onNotification(CLIENT_METHODS.mcp_message, parseMessageMcpNotification, ({ params }) =>
        this.client.mcpMessageNotification(params),
      )
      .connect(stream);

    // Death detection. The connection's `signal` aborts the INSTANT the underlying stream closes
    // (process crash or our own dispose) — in the SAME close() that rejects pending requests — so
    // it is the earliest, DETERMINISTIC death signal: a connection is marked dead and evicted
    // before its in-flight prompt's rejection even propagates, so a concurrent acquire can never
    // hand out a connection whose process has already died. The child 'exit'/'error' events are a
    // belt-and-suspenders backstop (and carry the exit code for a clearer message).
    this.connection.signal.addEventListener(
      "abort",
      () => this.die(new Error(`ACP agent (${this.backendId}) connection closed${this.stderrSuffix()}`)),
      { once: true },
    );
    child.once("error", (err: Error) => this.die(err));
    child.once("exit", (code: number | null, sig: NodeJS.Signals | null) => {
      this.die(
        new Error(`ACP agent (${this.backendId}) process exited (code=${code}, signal=${sig})${this.stderrSuffix()}`),
      );
    });

    this.ready = this.initialize();
    // The connection may be created and discarded (process dies) before anyone awaits `ready`.
    this.ready.catch(() => {});
  }

  /** Spawn the backend and kick off the single `initialize`. Returns immediately; callers await
   *  readiness implicitly via openSession(). */
  static create(backend: Backend, deps: PooledConnectionDeps): PooledConnection {
    return new PooledConnection(backend, deps);
  }

  get alive(): boolean {
    return this._alive;
  }

  get activeSessions(): number {
    return this._activeSessions;
  }

  /** The capabilities negotiated on this connection's one-time initialize handshake, or undefined
   *  until it completes — derived-state-behind-a-getter, like `alive`/`activeSessions`. */
  get capabilities(): NegotiatedCapabilities | undefined {
    return this.negotiated;
  }

  /** Drop the backend-declared bare `_meta` keys the connected agent did not advertise support
   *  for (see gateCustomMeta). Applied to BOTH session/new and session/prompt `_meta`. */
  gateCustomMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    return gateCustomMeta(meta, this.negotiated?.customMetaSupport, this.negotiated?.gatedKeys);
  }

  private assertSupportedMcpServers(opts: AcpSessionOptions): void {
    const unsupported = this.negotiated
      ? unsupportedMcpServer(opts.mcpServers, this.negotiated.agent, {
          clientCanServeAcp: hasFullMcpHandlers(this.clientHandlers?.mcp),
        })
      : undefined;
    if (!unsupported) return;
    if (unsupported.reason === "client") {
      throw new WorkflowError(
        `MCP server "${unsupported.name}" uses the "acp" transport, but this runner has no ` +
          "complete clientHandlers.mcp implementation to serve it",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: opts.label },
      );
    }
    throw new WorkflowError(
      `MCP server "${unsupported.name}" uses the "${unsupported.transport}" transport, which the ` +
        `${this.backendId} agent does not support`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false, agentLabel: opts.label },
    );
  }

  private sessionRequestMeta(opts: AcpSessionOptions): Record<string, unknown> | undefined {
    return this.gateCustomMeta(
      stampRunId(
        layerMeta(
          this.backend.sessionMetaDefaults?.(),
          opts.meta,
          this.backend.sessionMeta(opts.schema, {
            baseInstructions: opts.baseInstructions,
            developerInstructions: opts.developerInstructions,
          }),
        ),
        opts.runId,
      ),
    );
  }

  private assertLifecycleSupported(method: string, label: string | undefined): void {
    const supported =
      method === AGENT_METHODS.session_load
        ? this.negotiated?.supportsLoadSession
        : method === AGENT_METHODS.session_list
          ? this.negotiated?.supportsListSessions
          : method === AGENT_METHODS.session_delete
            ? this.negotiated?.supportsDeleteSession
            : method === AGENT_METHODS.session_resume
              ? this.negotiated?.supportsResumeSession
              : false;
    if (supported) return;
    throw lifecycleCapabilityError(this.backendId, method, this.negotiated, label);
  }

  private assertAuthProviderSupported(method: string, label: string | undefined): void {
    const supported =
      method === AGENT_METHODS.logout
        ? this.negotiated?.supportsLogout
        : method === AGENT_METHODS.providers_list ||
            method === AGENT_METHODS.providers_set ||
            method === AGENT_METHODS.providers_disable
          ? this.negotiated?.supportsProviders
          : true;
    if (supported) return;
    throw authProviderCapabilityError(this.backendId, method, this.negotiated, label);
  }

  /** Mark this connection dead exactly once, then ask the pool to evict it. Idempotent. */
  private die(error: Error): void {
    if (!this._alive) return;
    this._alive = false;
    this.deathError = error;
    this.resolveDead();
    this.client.settleAllPendingPermissions();
    this.client.settleAllPendingElicitations();
    this.client.disconnectAllMcpConnections();
    // A crash (not a graceful dispose) is worth surfacing for observability; the engine still
    // handles it by retrying the run on a fresh process. Best-effort, after death is recorded.
    if (this.onEvent && !this.disposing) {
      this.onEvent("backend_error", { backendId: this.backendId, error });
    }
    this.onDead(this);
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim();
    return tail ? `\n${tail}` : "";
  }

  /** Race a wire call against process death so a crash surfaces a clear error instead of hanging
   *  on a JSON-RPC response that will never come. */
  async race<T>(op: Promise<T>): Promise<T> {
    if (!this._alive) throw this.deathError ?? new Error(`ACP agent (${this.backendId}) connection closed`);
    const dead = this.whenDead.then((): never => {
      throw this.deathError ?? new Error(`ACP agent (${this.backendId}) connection closed`);
    });
    dead.catch(() => {});
    return Promise.race([op, dead]);
  }

  private async initialize(): Promise<void> {
    // Handshake deadline: a command that is NOT an ACP server never answers `initialize`, and
    // without a deadline the first openSession() would hang forever. On timeout the process is
    // killed and a legible error surfaces (fail-fast hygiene — this is NOT a security gate;
    // the process has already been spawned by then). Tunable for slow cold starts.
    const timeoutMs = initializeTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `ACP agent (${this.backendId}) did not complete the ACP initialize handshake within ${timeoutMs}ms — ` +
              `is the configured command an ACP server?${this.stderrSuffix()}`,
          ),
        );
        this.killNow();
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const response = await Promise.race([
        this.race(
          this.connection.agent.request(AGENT_METHODS.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            // Truthful advertisement: computed from the consumer-provided handlers registered on
            // this runner. Omitted flags are unsupported; false flags are never sent deliberately.
            clientCapabilities: clientCapabilitiesFor(this.clientHandlers, {
              elicitation: this.advertiseElicitation,
            }),
            clientInfo: { ...CLIENT_INFO },
          }),
        ),
        deadline,
      ]);
      const negotiated = negotiateCapabilities(response, this.backend.customCapabilities);
      // Version negotiation: the agent replies with the version it chose (our requested version if
      // it supports it, else its own latest). If this client cannot speak it, the ACP spec says
      // CLOSE the connection and inform the user — kill the process (so the pool evicts it) and
      // surface a legible error instead of proceeding on an unspoken protocol. Non-recoverable: a
      // deterministic protocol incompatibility must fail fast, not be retried as a transient
      // AGENT_EXECUTION_ERROR.
      if (!isSupportedProtocolVersion(negotiated.protocolVersion)) {
        this.killNow();
        throw new WorkflowError(
          `ACP agent (${this.backendId}) selected protocol version ${negotiated.protocolVersion}, which ` +
            `this client (protocol v${PROTOCOL_VERSION}) does not support — closing the connection.${this.stderrSuffix()}`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
      this.negotiated = negotiated;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Open a new per-agent session on this pooled connection: session/new { cwd }, register its
   * accumulator for routing, and return a SessionHandle. `activeSessions` is reserved
   * synchronously (before the first await) so the pool's load accounting is race-free.
   */
  async openSession(opts: AcpSessionOptions): Promise<SessionHandle> {
    this._activeSessions += 1;
    try {
      await this.ready;
      return await this.openReadySession(opts);
    } catch (error) {
      this._activeSessions -= 1;
      throw error;
    }
  }

  /** Reserve a session slot before initialize, then let the caller shape session/new with
   *  negotiated capabilities in hand. */
  async openPreparedSession(
    prepare: (connection: PooledConnection) => AcpSessionOptions | Promise<AcpSessionOptions>,
  ): Promise<SessionHandle> {
    this._activeSessions += 1;
    try {
      await this.ready;
      const opts = await prepare(this);
      return await this.openReadySession(opts);
    } catch (error) {
      this._activeSessions -= 1;
      throw error;
    }
  }

  private async openReadySession(opts: AcpSessionOptions): Promise<SessionHandle> {
    // Capability gate: reject a client-provided MCP server whose transport the connected agent
    // does not advertise (http/sse gated on mcpCapabilities; stdio is always serviceable).
    // Fail-fast and non-recoverable — re-running the same incompatible transport can never
    // succeed. Lenient for agents that advertise no mcpCapabilities (the legacy passthrough).
    this.assertSupportedMcpServers(opts);
    // session/new `_meta`, layered lowest-to-highest precedence: the backend's static
    // defaults (a custom registry entry's `sessionMeta`), then the generic user passthrough
    // (opts.meta), then the backend's protocol-critical `_meta` (Claude schema channel;
    // Codex base/developer instructions), then the engine runId correlation stamp. The result
    // is gated against the agent's advertised custom capabilities (a declared key the agent
    // said it does not honor is dropped). When no layer survives, no `_meta` is sent.
    const meta = this.sessionRequestMeta(opts);
    const request: NewSessionRequest = {
      cwd: opts.cwd,
      // Client-provided MCP servers (additive run input), else the default empty list.
      mcpServers: opts.mcpServers ?? [],
      ...(meta ? { _meta: meta } : {}),
    };
    const response = await this.race(this.connection.agent.request(AGENT_METHODS.session_new, request));
    const state = new SessionState(
      opts.cwd,
      opts.policy,
      opts.permissionResolver,
      opts.elicitationResolver,
      opts.label,
      opts.runId,
      response.modes,
      acpMcpServerIds(opts.mcpServers),
      opts.retainSessionLog ?? true,
    );
    this.client.register(response.sessionId, state);
    return new SessionHandle(this, response.sessionId, state, response.configOptions ?? [], opts);
  }

  /** Reopen an existing session and replay its transcript through the router before resolving. */
  loadSession(sessionId: string, opts: AcpSessionOptions): Promise<SessionHandle> {
    return this.reattachSession(AGENT_METHODS.session_load, sessionId, opts);
  }

  /** Reopen an existing session without transcript replay. */
  resumeSession(sessionId: string, opts: AcpSessionOptions): Promise<SessionHandle> {
    return this.reattachSession(AGENT_METHODS.session_resume, sessionId, opts);
  }

  private rawAgentRequest<Response, Params>(method: string, params: Params): Promise<Response> {
    // Some SDK ClientContext convenience methods collapse responses through emptyObjectResponse
    // (session/load in 1.2.0, plus auth/provider methods with optional _meta). Driven wrappers
    // need the wire response as-is. This bypasses only the SDK response mapper, not JSON-RPC
    // validation/racing.
    const agent = this.connection.agent as unknown as RawAgentRequestContext;
    return this.race(agent.sendRequest<Response, Params>(method, params));
  }

  private async reattachSession(
    method: typeof AGENT_METHODS.session_load | typeof AGENT_METHODS.session_resume,
    sessionId: string,
    opts: AcpSessionOptions,
  ): Promise<SessionHandle> {
    this._activeSessions += 1;
    let registered = false;
    const state = new SessionState(
      opts.cwd,
      opts.policy,
      opts.permissionResolver,
      opts.elicitationResolver,
      opts.label,
      opts.runId,
      undefined,
      acpMcpServerIds(opts.mcpServers),
      opts.retainSessionLog ?? true,
    );
    try {
      await this.ready;
      this.assertLifecycleSupported(method, opts.label);
      this.assertSupportedMcpServers(opts);
      const meta = this.sessionRequestMeta(opts);
      const request = {
        sessionId,
        cwd: opts.cwd,
        mcpServers: opts.mcpServers ?? [],
        ...(meta ? { _meta: meta } : {}),
      };

      // Replayed updates and permission requests can arrive before the response, so the
      // caller-provided id must be routable before the wire call leaves this process.
      this.client.register(sessionId, state);
      registered = true;

      let response: LoadSessionResponse | ResumeSessionResponse;
      if (method === AGENT_METHODS.session_load) {
        const loadRequest: LoadSessionRequest = request;
        response = await this.rawAgentRequest<LoadSessionResponse, LoadSessionRequest>(
          AGENT_METHODS.session_load,
          loadRequest,
        );
      } else {
        const resumeRequest: ResumeSessionRequest = request;
        response = await this.rawAgentRequest<ResumeSessionResponse, ResumeSessionRequest>(
          AGENT_METHODS.session_resume,
          resumeRequest,
        );
      }
      state.modes = response.modes;
      return new SessionHandle(this, sessionId, state, response.configOptions ?? [], opts);
    } catch (error) {
      if (registered) this.client.unregister(sessionId);
      this._activeSessions -= 1;
      throw error;
    }
  }

  /** session/list on a dedicated connection, gated on the initialize advertisement. */
  async listSessions(request: ListSessionsRequest, label?: string): Promise<ListSessionsResponse> {
    await this.ready;
    this.assertLifecycleSupported(AGENT_METHODS.session_list, label);
    return this.race(this.connection.agent.request(AGENT_METHODS.session_list, request));
  }

  /** session/delete on a dedicated connection, gated on the initialize advertisement. */
  async deleteSession(request: DeleteSessionRequest, label?: string): Promise<void> {
    await this.ready;
    this.assertLifecycleSupported(AGENT_METHODS.session_delete, label);
    await this.race(
      this.connection.agent.request(AGENT_METHODS.session_delete, request) as Promise<DeleteSessionResponse>,
    );
  }

  /** Authentication methods advertised in initialize, available without opening a session. */
  async authMethods(): Promise<AuthMethod[]> {
    await this.ready;
    return [...(this.negotiated?.authMethods ?? [])];
  }

  /** authenticate has no AgentCapabilities gate; authMethods advertises choices, not method support. */
  async authenticate(request: AuthenticateRequest, label?: string): Promise<AuthenticateResponse | void> {
    await this.ready;
    try {
      return await this.rawAgentRequest<AuthenticateResponse | void, AuthenticateRequest>(
        AGENT_METHODS.authenticate,
        request,
      );
    } catch (error) {
      if (isMethodNotFound(error)) throw agentMethodNotFoundError(this.backendId, AGENT_METHODS.authenticate, label, error);
      throw error;
    }
  }

  /** providers/list on a dedicated connection, gated on the unstable providers advertisement. */
  async listProviders(request: ListProvidersRequest, label?: string): Promise<ListProvidersResponse> {
    await this.ready;
    this.assertAuthProviderSupported(AGENT_METHODS.providers_list, label);
    try {
      return await this.rawAgentRequest<ListProvidersResponse, ListProvidersRequest>(
        AGENT_METHODS.providers_list,
        request,
      );
    } catch (error) {
      if (isMethodNotFound(error)) throw agentMethodNotFoundError(this.backendId, AGENT_METHODS.providers_list, label, error);
      throw error;
    }
  }

  /** providers/set on a dedicated connection, gated on the unstable providers advertisement. */
  async setProvider(request: SetProviderRequest, label?: string): Promise<SetProviderResponse | void> {
    await this.ready;
    this.assertAuthProviderSupported(AGENT_METHODS.providers_set, label);
    try {
      return await this.rawAgentRequest<SetProviderResponse | void, SetProviderRequest>(
        AGENT_METHODS.providers_set,
        request,
      );
    } catch (error) {
      if (isMethodNotFound(error)) throw agentMethodNotFoundError(this.backendId, AGENT_METHODS.providers_set, label, error);
      throw error;
    }
  }

  /** providers/disable on a dedicated connection, gated on the unstable providers advertisement. */
  async disableProvider(request: DisableProviderRequest, label?: string): Promise<DisableProviderResponse | void> {
    await this.ready;
    this.assertAuthProviderSupported(AGENT_METHODS.providers_disable, label);
    try {
      return await this.rawAgentRequest<DisableProviderResponse | void, DisableProviderRequest>(
        AGENT_METHODS.providers_disable,
        request,
      );
    } catch (error) {
      if (isMethodNotFound(error)) {
        throw agentMethodNotFoundError(this.backendId, AGENT_METHODS.providers_disable, label, error);
      }
      throw error;
    }
  }

  /** logout on a dedicated connection, gated on agentCapabilities.auth.logout. */
  async logout(request: LogoutRequest, label?: string): Promise<LogoutResponse | void> {
    await this.ready;
    this.assertAuthProviderSupported(AGENT_METHODS.logout, label);
    try {
      return await this.rawAgentRequest<LogoutResponse | void, LogoutRequest>(AGENT_METHODS.logout, request);
    } catch (error) {
      if (isMethodNotFound(error)) throw agentMethodNotFoundError(this.backendId, AGENT_METHODS.logout, label, error);
      throw error;
    }
  }

  /** session/prompt on this connection, raced against process death. */
  prompt(request: PromptRequest): Promise<PromptResponse> {
    return this.race(this.connection.agent.request(AGENT_METHODS.session_prompt, request));
  }

  /** session/set_config_option on this connection, raced against process death. */
  setSessionConfigOption(request: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return this.race(this.connection.agent.request(AGENT_METHODS.session_set_config_option, request));
  }

  /** session/set_mode on this connection, raced against process death. */
  setSessionMode(request: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return this.race(this.connection.agent.request(AGENT_METHODS.session_set_mode, request));
  }

  /** RAW protocol escape hatch: this makes the full ACP spec reachable (for example
   *  session/set_mode, session/fork, authenticate). Prefer the named wrappers when they exist
   *  because they preserve engine semantics such as accumulation/drain and usage recording;
   *  calling session/prompt here bypasses those paths. */
  request<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    options?: SendRequestOptions,
  ): Promise<AgentRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request(method: string, params?: unknown, options?: SendRequestOptions): Promise<unknown> {
    assertSafeRawRequest(method);
    return this.race(this.connection.agent.request(method, params, options));
  }

  /** RAW protocol notification escape hatch. Prefer named wrappers when they exist because
   *  wrapper paths carry engine-specific lifecycle semantics that raw protocol calls do not. */
  notify<Method extends AgentNotificationMethod>(
    method: Method,
    params: AgentNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify<Params = unknown>(method: string, params?: Params): Promise<void>;
  notify(method: string, params?: unknown): Promise<void> {
    return this.race(this.connection.agent.notify(method, params));
  }

  /** Best-effort ACP cancel for one session (wired to opts.signal). The PROCESS stays pooled. */
  async cancelSession(sessionId: string): Promise<void> {
    this.client.settlePendingPermissions(sessionId);
    this.client.settlePendingElicitations(sessionId);
    if (!this._alive) return;
    try {
      await this.connection.agent.notify(AGENT_METHODS.session_cancel, { sessionId });
    } catch {
      // best-effort: the session settles as "cancelled" regardless.
    }
  }

  /**
   * Release a session: move it to teardown-only routing, free the load slot, and best-effort
   * session/close on the wire (capability-gated, bounded, never fatal). The PROCESS is NOT
   * killed — it returns to the pool for the next agent() call.
   */
  async releaseSession(sessionId: string): Promise<void> {
    this.client.unregister(sessionId);
    if (this._activeSessions > 0) this._activeSessions -= 1;
    if (!this.negotiated?.supportsClose || !this._alive) return;
    try {
      await this.race(
        withTimeout(
          this.connection.agent.request(AGENT_METHODS.session_close, { sessionId }),
          CLOSE_SESSION_TIMEOUT_MS,
        ),
      );
    } catch {
      // best-effort: the session is already untracked; the process stays pooled.
    }
  }

  /** Synchronous best-effort kill for a process-exit hook (no time to await a graceful close). */
  killNow(): void {
    if (!this._alive) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  /** Close the process (pool teardown): end stdin, SIGTERM, escalate to SIGKILL, await exit. */
  async dispose(): Promise<void> {
    if (!this._alive) return;
    // Mark graceful shutdown so the imminent process-exit `die()` does not emit `backend_error`.
    this.disposing = true;
    const exited = new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
    });
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    const sigkill = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, DISPOSE_SIGKILL_GRACE_MS);
    sigkill.unref?.();
    try {
      await exited;
    } finally {
      clearTimeout(sigkill);
    }
  }
}

type ModelSelectOption = Extract<SessionConfigOption, { type: "select" }>;

/**
 * One agent() run's ACP session on a pooled connection. Owns the per-session cwd/schema/policy,
 * the model-selection state, and the abort wiring. On release() it lets go of the session
 * WITHOUT killing the pooled process. Implements StructuredSource for the backend's native read.
 */
export class SessionHandle implements StructuredSource {
  private configOptions: SessionConfigOption[];
  private removeAbort: (() => void) | undefined;
  private released = false;

  constructor(
    private readonly pooled: PooledConnection,
    readonly sessionId: string,
    private readonly state: SessionState,
    configOptions: SessionConfigOption[],
    private readonly opts: AcpSessionOptions,
  ) {
    this.configOptions = configOptions;
    if (opts.signal) {
      const signal = opts.signal;
      const onAbort = () => {
        void this.cancel();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.removeAbort = () => signal.removeEventListener("abort", onAbort);
    }
  }

  /** Per-session usage accumulator (read by the runner on BOTH success and error paths). */
  get usage(): UsageAccumulator {
    return this.state.usage;
  }

  /** Diagnostic message/tool history accumulated across this session's run. */
  get history(): AgentHistoryEntry[] {
    return this.state.history;
  }

  /** Assistant text accumulated across the retained session log. */
  get text(): string {
    return this.state.textChunks.join("");
  }

  /** Agent-advertised session mode catalog plus the currently active mode, if supported. */
  get modes(): SessionModeState | null | undefined {
    return this.state.modes;
  }

  /** The connection-level initialize response parsed before this session was opened. */
  get capabilities(): NegotiatedCapabilities | undefined {
    return this.pooled.capabilities;
  }

  /**
   * Select the model for this session from the agent-advertised config options (§5.4).
   * Returns `matched:false` (the caller fires onModelFallback) when the catalog has no value
   * matching the spec, leaving the session default in place.
   *
   * Beyond the `model` select, this also drives the sibling config options the catalog may
   * advertise (codex-acp), decoded from the `model[effort]` spec encoding:
   *   - `reasoning_effort` (id "reasoning_effort" / category "thought_level"): set to the
   *     bracketed effort token, e.g. `gpt-5.1-codex[high]` -> "high".
   *   - Fast mode (id "fast-mode" / category "fast-mode"): turned on when the bracket carries
   *     a `fast` token.
   * Each is best-effort and advertise-gated: when the catalog does not expose the option, or
   * the requested value is not among its choices, the modifier is NOT applied — but, unlike
   * before, that silent no-op is now SURFACED. `modifierFallbacks` lists a descriptor for every
   * requested effort/Fast value that could not be applied, so the caller can fire the same
   * onModelFallback channel model selection uses (incorrect tiering becomes observable). It
   * stays best-effort: an unmet modifier is reported, never thrown.
   */
  async selectModel(
    spec: string,
  ): Promise<{ matched: boolean; resolved?: string; modifierFallbacks?: string[] }> {
    const option = this.configOptions.find(isModelSelectOption);
    if (!option) return { matched: false };

    const values = flattenSelectOptions(option.options);
    const target = matchModelValue(values, spec);
    if (!target) return { matched: false };

    if (option.currentValue !== target.value) {
      await this.applyConfigOption(option.id, target.value);
    }

    const modifierFallbacks = await this.applyModelModifiers(spec, target.value);
    return { matched: true, resolved: target.value, modifierFallbacks };
  }

  /**
   * Drive reasoning_effort + Fast-mode from the `model[effort]` spec bracket, when advertised.
   * Returns a descriptor for each requested modifier that could NOT be applied because the
   * catalog does not advertise the option or the requested value — the symmetric signal to
   * model fallback, so the no-op is observable rather than silent. When the resolved model id
   * already ENCODES the bracket (e.g. a `gpt-5-codex[high]` catalog value), the effort is
   * carried by the model select itself, so it is treated as satisfied (no fallback).
   */
  private async applyModelModifiers(spec: string, modelValue: string): Promise<string[]> {
    const fallbacks: string[] = [];
    const tokens = bracketTokens(spec);
    if (tokens.length === 0) return fallbacks;

    // The model id already carries the bracket (e.g. "gpt-5-codex[high]") -> effort is applied
    // via the model select; the separate effort/Fast options are not the channel here.
    const effortAbsorbedByModel = modelValue.includes("[");
    const fastRequested = tokens.some((t) => t.toLowerCase() === "fast");
    const effortTokens = tokens.filter((t) => t.toLowerCase() !== "fast");

    // reasoning_effort: set to the bracket token that matches one of its advertised values.
    if (effortTokens.length > 0 && !effortAbsorbedByModel) {
      const effortOption = this.configOptions.find(isReasoningEffortOption);
      const match = effortOption
        ? matchToken(flattenSelectOptions(effortOption.options), effortTokens)
        : undefined;
      if (effortOption && match) {
        if (effortOption.currentValue !== match.value) {
          await this.applyConfigOption(effortOption.id, match.value);
        }
      } else {
        // No reasoning_effort option, or none of its choices match the requested effort.
        fallbacks.push(`${spec}: reasoning_effort "${effortTokens.join(",")}" not advertised`);
      }
    }

    // Fast mode: a `fast` token turns the advertised toggle on. The agent may advertise
    // it as a `type: "boolean"` option (agents gate that shape on our
    // session.configOptions.boolean capability) or as the legacy on/off select.
    if (fastRequested && !effortAbsorbedByModel) {
      const fastOption = this.configOptions.find(isFastModeOption);
      if (fastOption?.type === "boolean") {
        if (fastOption.currentValue !== true) {
          await this.applyConfigOption(fastOption.id, true);
        }
      } else {
        const onValue = fastOption ? fastModeOnValue(flattenSelectOptions(fastOption.options)) : undefined;
        if (fastOption && onValue) {
          if (fastOption.currentValue !== onValue) {
            await this.applyConfigOption(fastOption.id, onValue);
          }
        } else {
          // No Fast-mode option, or it advertises no "on" value.
          fallbacks.push(`${spec}: Fast mode not advertised`);
        }
      }
    }

    return fallbacks;
  }

  /** Set one session config option via the wire method and adopt the echoed catalog.
   *  A boolean value drives a `type: "boolean"` option (the request must carry the type
   *  discriminator on the wire); a string value drives a select option. */
  private async applyConfigOption(configId: string, value: string | boolean): Promise<void> {
    const request: SetSessionConfigOptionRequest =
      typeof value === "boolean"
        ? { sessionId: this.sessionId, configId, value, type: "boolean" }
        : { sessionId: this.sessionId, configId, value };
    const response = await this.pooled.setSessionConfigOption(request);
    this.configOptions = response.configOptions;
  }

  /** Switch the session's operating mode through ACP's strict confinement channel. */
  async setMode(modeId: string): Promise<void> {
    const modes = this.state.modes;
    const ids = modeIds(modes);
    if (modes) {
      if (!ids.includes(modeId)) {
        throw modeSelectionError(this.pooled.backendId, modeId, ids, this.opts.label);
      }
      try {
        await this.pooled.setSessionMode({ sessionId: this.sessionId, modeId });
      } catch (error) {
        throw modeSelectionError(this.pooled.backendId, modeId, ids, this.opts.label, error);
      }
      this.state.modes = { ...modes, currentModeId: modeId };
      return;
    }

    const modeOption = this.configOptions.find(isModeConfigOption);
    const configModeIds = modeOption ? flattenSelectOptions(modeOption.options).map((mode) => mode.value) : [];
    if (!modeOption || !configModeIds.includes(modeId)) {
      throw modeSelectionError(this.pooled.backendId, modeId, configModeIds, this.opts.label);
    }

    try {
      await this.applyConfigOption(modeOption.id, modeId);
    } catch (error) {
      throw modeSelectionError(this.pooled.backendId, modeId, configModeIds, this.opts.label, error);
    }
    this.state.modes = modeStateFromConfigOption(modeOption, modeId);
  }

  /** Send a prompt turn and drain it; returns the final PromptResponse. */
  async prompt(content: string | ContentBlock[], promptMeta?: Record<string, unknown>): Promise<PromptResponse> {
    this.opts.signal?.throwIfAborted();
    this.state.beginTurn();
    const prompt: ContentBlock[] | string =
      typeof content === "string"
        ? content
        : adaptPromptContent(content, this.pooled.capabilities?.agent ?? {}, this.pooled.backendId);
    // Gate the turn `_meta` against the agent's advertised custom capabilities: a declared
    // turn-level key is dropped when the connected agent said it does not honor it.
    const gatedMeta = this.pooled.gateCustomMeta(promptMeta);
    const request: PromptRequest = {
      sessionId: this.sessionId,
      prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
      ...(gatedMeta ? { _meta: gatedMeta } : {}),
    };
    const response = await this.pooled.prompt(request);
    this.state.usage.recordPromptUsage(response.usage);
    return response;
  }

  /** StructuredSource — the latest turn's assistant text. */
  currentTurnText(): string {
    return this.state.currentTurnText();
  }

  /** StructuredSource — Claude's raw structured_output for the latest turn, if any. */
  rawStructuredOutput(): unknown {
    return this.state.rawResultSuccess?.structured_output;
  }

  /** Best-effort ACP cancel (wired to opts.signal). The agent settles the turn as "cancelled". */
  async cancel(): Promise<void> {
    await this.pooled.cancelSession(this.sessionId);
  }

  /** Let go of this session WITHOUT killing the pooled process; idempotent. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.removeAbort?.();
    this.removeAbort = undefined;
    await this.pooled.releaseSession(this.sessionId);
  }
}

/** Resolve `op`, but reject after `ms` so a stuck best-effort wire call can't hang a caller. */
function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ACP request timed out after ${ms}ms`)), ms);
    timer.unref?.();
    op.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isModelSelectOption(option: SessionConfigOption): option is ModelSelectOption {
  return option.type === "select" && (option.category === "model" || option.id === "model");
}

function isReasoningEffortOption(option: SessionConfigOption): option is ModelSelectOption {
  return option.type === "select" && (option.id === "reasoning_effort" || option.category === "thought_level");
}

function isModeConfigOption(option: SessionConfigOption): option is ModelSelectOption {
  return option.type === "select" && (option.id === "mode" || option.category === "mode");
}

/** Fast mode is matched by its stable id (upstream codex-acp moved the category to
 *  "model_config"; the legacy category match is kept for older agents). Both the
 *  `type: "boolean"` and the legacy on/off select shapes qualify — the caller branches
 *  on `type`. */
function isFastModeOption(option: SessionConfigOption): boolean {
  return option.id === "fast-mode" || option.category === "fast-mode";
}

/** Split the trailing `[...]` of a `model[effort]` spec into its comma/space/plus-separated
 *  tokens (e.g. `gpt-5.1-codex[high]` -> ["high"], `gpt-5-codex[high fast]` -> ["high","fast"]). */
function bracketTokens(spec: string): string[] {
  const match = spec.match(/\[([^\]]+)\]\s*$/);
  if (!match) return [];
  return match[1]
    .split(/[\s,+]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** First advertised value whose id matches any of the given tokens (case-insensitive). */
function matchToken(
  values: SessionConfigSelectOption[],
  tokens: string[],
): SessionConfigSelectOption | undefined {
  const wanted = new Set(tokens.map((token) => token.toLowerCase()));
  return values.find((value) => wanted.has(value.value.toLowerCase()));
}

/** The "on" value of a Fast-mode select (codex-acp advertises value "on"; tolerate name too). */
function fastModeOnValue(values: SessionConfigSelectOption[]): string | undefined {
  const on = values.find(
    (value) => value.value.toLowerCase() === "on" || value.name.toLowerCase() === "on",
  );
  return on?.value;
}

function flattenSelectOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  const out: SessionConfigSelectOption[] = [];
  for (const entry of options) {
    if ("options" in entry) out.push(...entry.options);
    else out.push(entry);
  }
  return out;
}

/**
 * Best-effort match of a model spec (`provider/modelId`, a bare `modelId`, or a tier word)
 * against the agent's catalog. Tries, in priority order: exact spec, exact id-after-slash,
 * the bare base id (with the `[effort]` bracket stripped, so `gpt-5.1-codex[high]` matches a
 * bare `gpt-5.1-codex` model value while the bracket separately drives reasoning_effort), the
 * Codex `base[effort]` encoding, exact option name, then substring fallbacks. The effort
 * bracket itself is applied via applyModelModifiers, not folded into the model select.
 */
function matchModelValue(
  values: SessionConfigSelectOption[],
  spec: string,
): SessionConfigSelectOption | undefined {
  const afterSlash = spec.includes("/") ? spec.slice(spec.indexOf("/") + 1) : spec;
  const fullLower = spec.toLowerCase();
  const idLower = afterSlash.toLowerCase();
  const baseLower = stripEffortBracket(afterSlash).toLowerCase();
  const tests: Array<(value: SessionConfigSelectOption) => boolean> = [
    (value) => value.value.toLowerCase() === fullLower,
    (value) => value.value.toLowerCase() === idLower,
    (value) => value.value.toLowerCase() === baseLower,
    (value) => value.value.toLowerCase().startsWith(`${baseLower}[`),
    (value) => value.name.toLowerCase() === idLower,
    (value) => value.name.toLowerCase() === baseLower,
    (value) => value.value.toLowerCase().includes(baseLower),
    (value) => value.name.toLowerCase().includes(baseLower),
  ];
  for (const test of tests) {
    const found = values.find(test);
    if (found) return found;
  }
  return undefined;
}

/** Drop a trailing `[effort]` bracket from a model id, leaving the base model id. */
function stripEffortBracket(spec: string): string {
  const open = spec.indexOf("[");
  return open >= 0 ? spec.slice(0, open) : spec;
}
