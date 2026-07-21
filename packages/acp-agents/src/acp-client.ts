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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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
  type ForkSessionRequest,
  type ForkSessionResponse,
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
import type { Backend, BackendId, ProviderErrorMetadata, StructuredSource } from "./backend.js";
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
import {
  redactSecrets,
  type AuthStore,
  type BackendAuthMachine,
  type ConnectionAuthStamp,
} from "./auth/auth-store.js";
import type { ProviderStore } from "./provider-store.js";
import { providerVertexMeta } from "./provider-store.js";

/** A benign client identity. NOT JetBrains/IntelliJ 2026.1 — that exact identity makes
 *  codex-acp disable session config options (including the model-selection channel). */
const CLIENT_INFO = {
  name: "agentprism-workflows",
  title: "AgentPrism Workflows",
  version: "0.1.0",
} as const;

const CLAUDE_RAW_MESSAGE_METHOD = "_claude/sdkMessage";
/** Bound the best-effort session/close round-trip so a slow agent can't hang run()'s finally. */
const CLOSE_SESSION_TIMEOUT_MS = 5_000;
/** Grace for a cancelled prompt/config lifecycle to settle before close + process quarantine. */
export const CANCEL_NOT_HONORED_GRACE_MS = 5_000;
export const PI_CHILD_CLEANUP_DEADLINE_MS = 5_000;
export const PI_CLOSE_DELIVERY_MARGIN_MS = 1_000;
export const PI_CLOSE_SESSION_TIMEOUT_MS = PI_CHILD_CLEANUP_DEADLINE_MS + PI_CLOSE_DELIVERY_MARGIN_MS;
/** Bound the graceful SIGTERM shutdown before escalating to SIGKILL. */
const DISPOSE_SIGKILL_GRACE_MS = 2_000;
export const PI_PROCESS_SHUTDOWN_ENVELOPE_MS = 66_000;
export const PI_PROCESS_EXIT_MARGIN_MS = 1_000;
export const PI_DISPOSE_SIGKILL_GRACE_MS = PI_PROCESS_SHUTDOWN_ENVELOPE_MS + PI_PROCESS_EXIT_MARGIN_MS;
const TOMBSTONE_SESSION_CAP = 64;
const GUARDED_STATEFUL_REQUESTS = new Map<string, string>([
  [AGENT_METHODS.session_new, "use openSession()"],
  [AGENT_METHODS.session_load, "use loadSession()"],
  [AGENT_METHODS.session_resume, "use resumeSession()"],
  [AGENT_METHODS.session_fork, "use forkSession()"],
]);

interface RawResultSuccess {
  type: string;
  subtype: string;
  structured_output?: unknown;
}

/** Monotonic seq for process-unique PooledConnection ids (auth-machine event tagging, §2.3). */
let nextConnectionSeq = 0;

interface SessionTombstone {
  readonly cwd: string;
  readonly label?: string;
  readonly runId?: string;
  readonly callIndex?: number;
  readonly initializeMeta?: Readonly<Record<string, unknown>>;
}

const parseConnectMcpRequest = (params: unknown): ConnectMcpRequest => params as ConnectMcpRequest;
const parseMessageMcpRequest = (params: unknown): MessageMcpRequest => params as MessageMcpRequest;
const parseMessageMcpNotification = (params: unknown): MessageMcpNotification =>
  params as MessageMcpNotification;
const parseDisconnectMcpRequest = (params: unknown): DisconnectMcpRequest => params as DisconnectMcpRequest;

/**
 * Snapshot an ACP server's descendants before terminating its group. Pi's terminal commands
 * deliberately run in their own process groups, so group-killing the ACP server alone would not
 * reach a command that has not yet been cleaned up by the graceful shutdown path. Linux reads
 * procfs directly; other POSIX hosts use the portable `ps` parent map.
 */
function processDescendantPids(rootPid: number): number[] {
  const descendants: number[] = [];
  const childrenByParent = new Map<number, number[]>();
  if (process.platform === "linux") {
    const pending = [rootPid];
    const visited = new Set<number>(pending);
    while (pending.length > 0) {
      const pid = pending.pop()!;
      try {
        const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((childPid) => Number.isSafeInteger(childPid) && childPid > 0);
        for (const childPid of children) {
          if (visited.has(childPid)) continue;
          visited.add(childPid);
          descendants.push(childPid);
          pending.push(childPid);
        }
      } catch {
        // The process can exit while its tree is being inspected; the group/direct kill below
        // remains the best-effort fallback.
      }
    }
    return descendants;
  }
  if (process.platform === "win32") return descendants;
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 250,
    });
    for (const row of rows.split("\n")) {
      const match = row.match(/^\s*(\d+)\s+(\d+)\s*$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(pid);
      childrenByParent.set(parentPid, children);
    }
  } catch {
    return descendants;
  }
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      descendants.push(childPid);
      pending.push(childPid);
    }
  }
  return descendants;
}

/** A descendant PID paired with Linux's process-creation tick when the platform exposes it. */
interface ProcessIdentity {
  readonly pid: number;
  readonly startTime?: string;
}

/**
 * Linux keeps a process's creation tick in field 22 of `/proc/<pid>/stat`. Pairing it with a PID
 * lets delayed teardown distinguish the original detached descendant from a later PID reuse.
 */
function linuxProcessStartTime(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` is parenthesized and can contain spaces or parentheses, so field splitting must begin
    // after its final closing parenthesis. The remaining list begins at stat field 3 (state).
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const startTime = fields[19]; // field 22 (starttime) minus the leading field 3.
    return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

function snapshotProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (process.platform !== "linux") return { pid };
  const startTime = linuxProcessStartTime(pid);
  // Do not retain an unverifiable Linux PID: a later direct signal could hit a reused PID.
  return startTime === undefined ? undefined : { pid, startTime };
}

function isSameTrackedProcess(identity: ProcessIdentity): boolean {
  if (process.platform === "linux") {
    return identity.startTime !== undefined && linuxProcessStartTime(identity.pid) === identity.startTime;
  }
  try {
    process.kill(identity.pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  providerErrorMetadata: ProviderErrorMetadata | undefined;
  modes: SessionModeState | null | undefined;
  private turnStartIndex = 0;
  private finalMessageStartIndex = 0;

  /** `label`/`runId`/`callIndex` are carried here ONLY so the MultiplexClient can stamp them onto emitted
   *  events as context — they never affect routing or the wire request. */
  constructor(
    readonly cwd: string,
    readonly policy: ToolPolicy,
    readonly permissionResolver?: PermissionResolver,
    readonly elicitationResolver?: ElicitationResolver,
    readonly label?: string,
    readonly runId?: string,
    readonly callIndex?: number,
    readonly initializeMeta?: Readonly<Record<string, unknown>>,
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
    this.finalMessageStartIndex = this.turnStartIndex;
    this.rawResultSuccess = undefined;
    this.providerErrorMetadata = undefined;
  }

  currentTurnText(): string {
    return this.textChunks.slice(this.turnStartIndex).join("");
  }

  /** The turn's FINAL assistant message: only the chunks streamed after the last content event
   *  that isn't an assistant message chunk (tool call, thought, plan). A backend whose schema
   *  constraint applies turn-wide (Codex) emits schema-shaped intermediate progress messages;
   *  structured extraction must read this, never the whole-turn concatenation. */
  finalMessageText(): string {
    return this.textChunks.slice(this.finalMessageStartIndex).join("");
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
        this.finalMessageStartIndex = this.textChunks.length;
        this.history.push({
          role: "tool",
          kind: "toolCall",
          text: update.title,
          toolName: toolNameFromMeta(update._meta) ?? update.kind,
          timestamp: Date.now(),
        });
        break;
      }
      // Any other CONTENT event also ends the in-flight assistant message — text streamed after
      // it belongs to a new message. Bookkeeping updates (usage, mode) never break a message.
      case "user_message_chunk":
      case "agent_thought_chunk":
      case "tool_call_update":
      case "plan": {
        this.finalMessageStartIndex = this.textChunks.length;
        break;
      }
      case "usage_update": {
        this.usage.recordCost(update.cost);
        // Also feed the context token counts so AgentUsage.total is non-zero for backends
        // that report tokens via usage_update but never via PromptResponse.usage.
        this.usage.recordContextTokens(update.used, update.size);
        const providerErrorMetadata = claudeProviderErrorMetadata(update._meta);
        if (providerErrorMetadata) this.providerErrorMetadata = providerErrorMetadata;
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

function claudeProviderErrorMetadata(meta: unknown): ProviderErrorMetadata | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const rateLimit = (meta as Record<string, unknown>)["_claude/rateLimit"];
  if (!rateLimit || typeof rateLimit !== "object") return undefined;
  const values = rateLimit as Record<string, unknown>;
  const primary = finiteEpochSeconds(values.resetsAt);
  const overage = finiteEpochSeconds(values.overageResetsAt);
  const resetEpoch = values.status === "rejected"
    ? primary
    : values.overageStatus === "rejected"
      ? overage ?? primary
      : primary ?? overage;
  if (resetEpoch === undefined) return undefined;
  try {
    return { resetAt: new Date(resetEpoch * 1_000).toISOString() };
  } catch {
    return undefined;
  }
}

function finiteEpochSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Clone the JSON-RPC value once per session and recursively freeze that session-owned snapshot. */
function initializeMetaSnapshot(
  capabilities: NegotiatedCapabilities | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const source = capabilities?.initializeMeta;
  if (source === undefined || source === null) return undefined;
  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  return freezeJson(clone) as Readonly<Record<string, unknown>>;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
    return Object.freeze(value);
  }
  return value;
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

  private contextFor(sessionId: string): AcpEventContext {
    const context = this.sessions.get(sessionId) ?? this.tombstones.get(sessionId);
    return {
      sessionId,
      backendId: this.backendId,
      ...(context?.label !== undefined ? { label: context.label } : {}),
      ...(context?.runId !== undefined ? { runId: context.runId } : {}),
      ...(context?.callIndex !== undefined ? { callIndex: context.callIndex } : {}),
      ...(context?.initializeMeta !== undefined
        ? { initializeMeta: context.initializeMeta }
        : {}),
    };
  }

  private handlerContext(params: { sessionId: string }): AcpSessionContext {
    const state = this.sessions.get(params.sessionId);
    if (state) return { sessionId: params.sessionId, cwd: state.cwd, label: state.label, runId: state.runId };
    const tombstone = this.tombstones.get(params.sessionId);
    if (tombstone) {
      return {
        sessionId: params.sessionId,
        cwd: tombstone.cwd,
        label: tombstone.label,
        runId: tombstone.runId,
      };
    }
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
    this.onEvent?.("session_open", this.contextFor(sessionId));
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
        callIndex: state.callIndex,
        initializeMeta: state.initializeMeta,
      });
      while (this.tombstones.size > TOMBSTONE_SESSION_CAP) {
        const oldest = this.tombstones.keys().next().value;
        if (oldest === undefined) break;
        this.tombstones.delete(oldest);
      }
      this.onEvent?.("session_close", this.contextFor(sessionId));
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
    const ctx = this.contextFor(params.sessionId);
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
    const ctx = this.contextFor(sessionId);
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
      emitSessionUpdate(this.onEvent, params.update, this.contextFor(params.sessionId));
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
      ...this.contextFor(sessionId),
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

/** Internal typed sentinel for the continuation path. It is deliberately thrown only after
 * initialize completes and before any session/load or session/resume wire request is sent. */
export class ReattachCapabilityUnavailable extends Error {
  constructor(
    readonly backendId: BackendId,
    readonly sessionId: string,
  ) {
    super(
      `ACP agent (${backendId}) cannot reattach session ${sessionId}: ` +
        "neither session/resume nor session/load is advertised",
    );
    this.name = "ReattachCapabilityUnavailable";
  }
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
  /** `RunOptions.callIndex`, propagated onto emitted events as context. NOT sent on the wire. */
  callIndex?: number;
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
  /** Initialize-time client auth advertisement (§1.2); fixed per connection like elicitation.
   *  Undefined (the default) omits the `auth` capability entirely — the default-OFF baseline. */
  authCapabilities?: { terminal?: boolean; gateway?: boolean };
  /** The runner's single auth store (§2). When present, this connection reconciles to the current
   *  intent at the end of `initialize` (replay for in-process creds), overlays the spawn env with
   *  collected `env_var` values, and carries a generation stamp the pool gates selection on.
   *  Undefined => no auth wiring, byte-identical to the pre-auth baseline (default-OFF). */
  authStore?: AuthStore;
  /** The runner's single provider-intent store. When present, this connection replays the recorded
   *  `providers/set` intents at the end of `initialize` (provider routing is in-process agent state
   *  for e.g. codex-acp — the same dispose-after-configure class as auth gap 3) and carries a
   *  generation stamp the pool gates selection on. Undefined or empty => byte-identical baseline. */
  providerStore?: ProviderStore;
  /** Client-side ACP fs/terminal handlers advertised once and routed by sessionId. */
  clientHandlers?: ClientHandlers;
  /** Deterministic disposal-clock seam. Production uses the platform timers. */
  disposeTimer?: {
    set(callback: () => void, ms: number): { unref?(): void };
    clear(timer: { unref?(): void }): void;
  };
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
  /** Process-unique connection id, used only to tag `BackendAuthMachine` events (§2.3). */
  readonly id: string = `conn-${(nextConnectionSeq += 1)}`;
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
  private readonly authCapabilities: { terminal?: boolean; gateway?: boolean } | undefined;
  private readonly authStore: AuthStore | undefined;
  private readonly providerStore: ProviderStore | undefined;
  private readonly disposeTimer: NonNullable<PooledConnectionDeps["disposeTimer"]>;
  /** Which intent-generation THIS process reflects (§2.4). Starts at -1/false so a connection with
   *  no applied intent is stale against a machine that has ever advanced past generation 0. */
  authStamp: ConnectionAuthStamp = { appliedGeneration: -1, applied: false, trippedAuthRequired: false };
  /** Which provider-store generation THIS process replayed at initialize. Starts at 0 (== the
   *  store's empty-pool generation), so the pre-provider baseline is never stale; the first
   *  recorded intent advances the store past it and recycles older processes. */
  providerStamp = 0;
  /** Set by the pool when a busy stale connection must be recycled once it drains (§2.6). While set,
   *  the connection is never handed a new session and is disposed-and-dropped on release. */
  recyclePending = false;
  /** Set true at the start of dispose() so the graceful-shutdown death is NOT reported as a crash. */
  private disposing = false;
  private disposePromise: Promise<void> | undefined;
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
  /**
   * Detached commands can outlive an ACP parent's graceful exit. Capture their identities before
   * that exit so disposal retains a route to them until they have died or an escalation kills them.
   */
  private readonly retainedDescendants = new Map<number, ProcessIdentity>();

  private constructor(backend: Backend, deps: PooledConnectionDeps) {
    this.backend = backend;
    this.backendId = backend.id;
    this.onDead = deps.onDead;
    this.onEvent = deps.onEvent;
    this.clientHandlers = deps.clientHandlers;
    this.advertiseElicitation = deps.advertiseElicitation ?? Boolean(deps.elicitationResolver);
    this.authCapabilities = deps.authCapabilities;
    this.authStore = deps.authStore;
    this.providerStore = deps.providerStore;
    this.disposeTimer = deps.disposeTimer ?? {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
    this.client = new MultiplexClient(
      this.backendId,
      this.onEvent,
      deps.clientHandlers,
      deps.permissionResolver,
      deps.elicitationResolver,
    );

    const { command, args, env } = backend.spawnConfig();
    // Spawn-env auth overlay (§2.8): host-collected `env_var` values (and, for a profiled backend,
    // its `spawnAuthEnv` contribution) stacked ABOVE the backend's own env. Undefined when nothing is
    // held — byte-identical to today. Passed straight to spawn; never logged (§2.14, Principle 9).
    const authOverlay = this.authStore?.spawnEnvFor(backend.poolKey ?? backend.id);
    // NOTE: deliberately NO `cwd` here. cwd is per-SESSION (session/new), so one pooled process
    // serves runs in different worktrees without losing isolation.
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: authOverlay ? { ...env, ...authOverlay } : env,
      // Give every backend its own process group. This lets force-kill tear down the normal
      // backend subtree without ever signalling the host process group.
      detached: process.platform !== "win32",
    });
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
              : method === AGENT_METHODS.session_fork
                ? this.negotiated?.supportsForkSession
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
    // The dying connection's stamp is dropped with it; the machine's auth state is unchanged (§2.3).
    this.authStore?.existing(this.backend.poolKey ?? this.backend.id)?.send({ t: "process_death", connectionId: this.id });
    // A crash (not a graceful dispose) is worth surfacing for observability; the engine still
    // handles it by retrying the run on a fresh process. Best-effort, after death is recorded.
    if (this.onEvent && !this.disposing) {
      this.onEvent("backend_error", { backendId: this.backendId, error });
    }
    this.onDead(this);
  }

  private stderrSuffix(): string {
    // Redact credential-shaped substrings before the tail can appear in any error suffix (§2.14):
    // a spawned agent that echoes an injected env var to stderr must not leak it into an error.
    const tail = redactSecrets(this.stderrTail).trim();
    return tail ? `\n${tail}` : "";
  }

  /** Resolve this connection's `BackendAuthMachine` from the runner's store, or undefined when no
   *  store is wired (default-OFF) — the machine is keyed by the backend's poolKey (§2.3). */
  private authMachine(): BackendAuthMachine | undefined {
    return this.authStore?.machineFor(this.backend.poolKey ?? this.backend.id, this.backend.authProfile);
  }

  /** The client `auth` advertisement for THIS connection (§1.2), refined per-backend by the pure-data
   *  `AuthProfile.clientAuthCapabilities` (§3.1). When the host advertised nothing (default-OFF) the
   *  key is omitted verbatim — no profile is consulted, so behavior stays byte-identical. When the
   *  host opted in, the backend's profile maps the host affordances (`onAuth` ⇐ gateway desired,
   *  `terminal` ⇐ host TTY) onto the method TYPES this backend can actually service (e.g. codex never
   *  advertises terminal; opencode never advertises gateway). A custom backend has NO profile → the
   *  host's advertisement passes through unchanged (conformance-by-absence, §3.5). */
  private effectiveAuthCapabilities(): { terminal?: boolean; gateway?: boolean } | undefined {
    const base = this.authCapabilities;
    if (!base) return undefined; // default-OFF: omit `auth` entirely (byte-identical baseline)
    const profile = this.backend.authProfile;
    if (!profile) return base;
    return profile.clientAuthCapabilities({ onAuth: Boolean(base.gateway), terminal: Boolean(base.terminal) });
  }

  /** Mark this connection current against `generation` (nothing more to apply). */
  private stampApplied(generation: number): void {
    this.authStamp = { appliedGeneration: generation, applied: true, trippedAuthRequired: false };
  }

  /** true iff the current intent is an in-process (gateway) cred, so an idle connection can be
   *  re-primed with an authenticate RPC replay instead of being recycled (§2.6). */
  canLiveReapply(machine: BackendAuthMachine): boolean {
    return machine.currentKlassIsInProcess();
  }

  /** Reconcile this connection to the current intent at the end of `initialize` (§2.5). For an
   *  in-process cred, replay `authenticate({methodId,_meta})`; for disk/spawn-env a fresh process
   *  already carries the credential, so only stamp it current. */
  private async applyAuthIntent(machine: BackendAuthMachine): Promise<void> {
    if (machine.state !== "credentials_held" && machine.state !== "authenticated") {
      this.stampApplied(machine.generation); // nothing to apply; mark current
      return;
    }
    const intent = machine.intentView();
    if (intent?.klass !== "in-process") {
      // disk (native store) + spawn-env (env at spawn) need no RPC — a fresh process already has them.
      this.stampApplied(machine.generation);
      return;
    }
    const meta = machine.applyMeta();
    try {
      await this.rawAgentRequest<AuthenticateResponse | void, AuthenticateRequest>(AGENT_METHODS.authenticate, {
        methodId: intent.methodId,
        ...(meta ? { _meta: meta } : {}),
      });
      this.stampApplied(machine.generation);
      machine.send({ t: "apply_ok", connectionId: this.id, generation: machine.generation });
    } catch (err) {
      machine.send({ t: "apply_failed", connectionId: this.id, generation: machine.generation, error: err });
      throw err; // -> AUTH_REQUIRED via §1.5; connection unusable
    }
  }

  /** Idle in-process connection: re-send `authenticate` and re-stamp so the next session opens under
   *  the current gateway cred without a process recycle (§2.6). Returns true iff a re-apply ran. */
  async reapplyAuthIfStale(machine: BackendAuthMachine): Promise<boolean> {
    if (!machine.isStale(this.authStamp) || !this.canLiveReapply(machine)) return false;
    await this.ready;
    await this.applyAuthIntent(machine);
    return true;
  }

  /** Fire-and-forget idle live re-apply (§2.6). Any failure disposes the connection so the pool
   *  respawns a fresh process rather than serving a session under a failed replay. */
  scheduleReapply(machine: BackendAuthMachine): void {
    void this.reapplyAuthIfStale(machine).catch(() => {
      this.recyclePending = true;
      void this.dispose();
    });
  }

  /** Mark a BUSY stale connection for recycle once it drains (§2.6): finish in-flight prompts under
   *  the auth they started with, then dispose-and-drop on release. */
  markForRecycleWhenIdle(_machine: BackendAuthMachine): void {
    this.recyclePending = true;
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
              // Per-backend profile refinement (§1.2/§3.1); undefined => no `auth` key emitted (default-OFF).
              auth: this.effectiveAuthCapabilities(),
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
      // Reconcile this connection to the current auth intent (§2.5). Runs identically on pooled,
      // dedicated, and interactive connections — the intent is durable in the AuthStore, so a fresh
      // process always re-primes an in-process (gateway) credential here, which is the direct fix
      // for the dispose-after-authenticate bug (gap 3). Disk/spawn-env intents are only stamped.
      const machine = this.authMachine();
      if (machine) {
        machine.send({ t: "initialize_ok", connectionId: this.id, advertised: negotiated.authMethods });
        await this.applyAuthIntent(machine);
      }
      // Replay recorded provider-routing intents (the providers/* sibling of the auth replay
      // above): provider config is in-process agent state for e.g. codex-acp, so every fresh
      // process must be re-routed here or its sessions would silently run on default routing.
      await this.applyProviderIntents();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Replay the recorded `providers/set` intents at the end of `initialize`, then stamp the
   *  generation this process reflects. Advertise-gated: an agent that advertises the unstable
   *  providers block replays every recorded intent; a replay FAILURE throws, failing the connection
   *  loudly because silently opening sessions without the host-configured gateway routing would
   *  mis-route traffic. A fresh process that does NOT advertise providers WHILE routing is still
   *  configured (`intentsFor` non-empty) hits the same wall from the other side — an intent can only
   *  have been recorded against an advertising agent, so a lost advertisement means the agent surface
   *  regressed under us (an npx-resolved backend version change, a command override/wrapper, a custom
   *  backend whose advertisement depends on startup state). Stamping it current would silently route
   *  every later session direct-to-provider instead of through the gateway, so we FAIL LOUDLY here
   *  too, non-recoverably, with both operator exits named. With no recorded intent — the default-OFF
   *  baseline, or after a `disable` emptied the intents — there is nothing to route, so a
   *  non-advertising process is stamped current, byte-identical to the pre-provider baseline. */
  private async applyProviderIntents(): Promise<void> {
    const store = this.providerStore;
    if (!store) return;
    const poolKey = this.backend.poolKey ?? this.backend.id;
    const generation = store.generation(poolKey);
    const intents = store.intentsFor(poolKey);
    if (this.negotiated?.supportsProviders === true) {
      for (const intent of intents) {
        await this.rawAgentRequest<SetProviderResponse | void, SetProviderRequest>(AGENT_METHODS.providers_set, {
          providerId: intent.providerId,
          apiType: intent.apiType,
          baseUrl: intent.baseUrl,
          ...(intent.headers ? { headers: intent.headers } : {}),
          ...(intent.vertex ? { _meta: providerVertexMeta(intent.vertex) } : {}),
        });
      }
    } else if (intents.length > 0) {
      throw new WorkflowError(
        `ACP agent (${this.backendId}) has host-configured gateway provider routing (pool key "${poolKey}", ` +
          `${intents.length} provider${intents.length === 1 ? "" : "s"} recorded), but this freshly started agent ` +
          `process no longer advertises the \`providers\` capability, so the recorded routing cannot be replayed — ` +
          `refusing to open sessions that would silently run direct-to-provider instead of through the configured ` +
          `gateway. Restore or fix the backend so it advertises \`providers\` again, or disable the configured ` +
          `provider to accept direct-to-provider traffic (the runner's \`disableProvider\` API).${this.stderrSuffix()}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    this.providerStamp = generation;
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

  /** Reserve one connection slot, await initialize, choose the best currently-advertised reopen
   * method, prepare against that same ready connection, and reattach under the single reservation. */
  async openPreparedReattachedSession(
    sessionId: string,
    prepare: (connection: PooledConnection) => AcpSessionOptions | Promise<AcpSessionOptions>,
  ): Promise<{ handle: SessionHandle; method: "resume" | "load" }> {
    this._activeSessions += 1;
    try {
      await this.ready;
      const caps = this.negotiated;
      const method: "resume" | "load" | undefined = caps?.supportsResumeSession
        ? "resume"
        : caps?.supportsLoadSession
          ? "load"
          : undefined;
      if (method === undefined) throw new ReattachCapabilityUnavailable(this.backendId, sessionId);
      const opts = await prepare(this);
      const handle = await this.reattachReadySession(
        method === "resume" ? AGENT_METHODS.session_resume : AGENT_METHODS.session_load,
        sessionId,
        opts,
      );
      return { handle, method };
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
    const initializeMeta = initializeMetaSnapshot(this.negotiated);
    const state = new SessionState(
      opts.cwd,
      opts.policy,
      opts.permissionResolver,
      opts.elicitationResolver,
      opts.label,
      opts.runId,
      opts.callIndex,
      initializeMeta,
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

  /** Create a new independent session seeded from an existing session's conversation context. */
  async forkSession(sourceSessionId: string, opts: AcpSessionOptions): Promise<SessionHandle> {
    this._activeSessions += 1;
    let registeredSessionId: string | undefined;
    try {
      await this.ready;
      this.assertLifecycleSupported(AGENT_METHODS.session_fork, opts.label);
      this.assertSupportedMcpServers(opts);
      const state = new SessionState(
        opts.cwd,
        opts.policy,
        opts.permissionResolver,
        opts.elicitationResolver,
        opts.label,
        opts.runId,
        opts.callIndex,
        initializeMetaSnapshot(this.negotiated),
        undefined,
        acpMcpServerIds(opts.mcpServers),
        opts.retainSessionLog ?? true,
      );
      const meta = this.sessionRequestMeta(opts);
      const request = {
        sessionId: sourceSessionId,
        cwd: opts.cwd,
        mcpServers: opts.mcpServers ?? [],
        ...(meta ? { _meta: meta } : {}),
      };
      const forkRequest: ForkSessionRequest = request;
      const response = await this.rawAgentRequest<ForkSessionResponse, ForkSessionRequest>(
        AGENT_METHODS.session_fork,
        forkRequest,
      );
      state.modes = response.modes;

      // Unlike load/resume, the routable id exists only in the response, so registration must
      // happen after the wire call. Updates arriving between send and response cannot be routed;
      // that is acceptable for a freshly-forked session, which has no reason to emit before its
      // creation response, and matches the same tradeoff made by session/new.
      this.client.register(response.sessionId, state);
      registeredSessionId = response.sessionId;
      return new SessionHandle(this, response.sessionId, state, response.configOptions ?? [], opts);
    } catch (error) {
      if (registeredSessionId !== undefined) this.client.unregister(registeredSessionId);
      this._activeSessions -= 1;
      throw error;
    }
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
    try {
      return await this.reattachReadySession(method, sessionId, opts);
    } catch (error) {
      this._activeSessions -= 1;
      throw error;
    }
  }

  /** Reattach under a reservation already owned by the caller. */
  private async reattachReadySession(
    method: typeof AGENT_METHODS.session_load | typeof AGENT_METHODS.session_resume,
    sessionId: string,
    opts: AcpSessionOptions,
  ): Promise<SessionHandle> {
    let registered = false;
    try {
      await this.ready;
      this.assertLifecycleSupported(method, opts.label);
      this.assertSupportedMcpServers(opts);
      const state = new SessionState(
        opts.cwd,
        opts.policy,
        opts.permissionResolver,
        opts.elicitationResolver,
        opts.label,
        opts.runId,
        opts.callIndex,
        initializeMetaSnapshot(this.negotiated),
        undefined,
        acpMcpServerIds(opts.mcpServers),
        opts.retainSessionLog ?? true,
      );
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

  /** Send ACP cancel for one session. SessionHandle owns the grace/close escalation policy. */
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

  /** Quarantine a child whose session ignored cancellation. Existing sibling sessions drain;
   *  an already-idle connection disposes immediately, otherwise the final release disposes it. */
  quarantineAfterIgnoredCancel(): void {
    this.recyclePending = true;
    if (this._activeSessions === 0 && this._alive) {
      void this.dispose();
    }
  }

  /**
   * Release a session: move it to teardown-only routing, free the load slot, and best-effort
   * session/close on the wire (capability-gated, bounded, never fatal). The PROCESS is NOT
   * killed — it returns to the pool for the next agent() call.
   */
  async releaseSession(sessionId: string, keepOpen = false): Promise<void> {
    let childCleanupError: unknown;
    // Enter teardown-only routing before asking the agent to close so notifications produced by
    // session/close retain their correlation. Active accounting stays held until the close attempt
    // finishes, which prevents recycle-triggered disposal from preempting the wire request.
    this.client.unregister(sessionId);
    // keepOpen: the caller intends to re-open this session later (session/load|resume), so the
    // agent-persisted session must be left untouched — skip the best-effort close entirely.
    if (!keepOpen && this.negotiated?.supportsClose && this._alive) {
      try {
        await this.race(withTimeout(
          this.connection.agent.request(AGENT_METHODS.session_close, { sessionId }),
          this.backendId === "pi" ? PI_CLOSE_SESSION_TIMEOUT_MS : CLOSE_SESSION_TIMEOUT_MS,
        ));
      } catch (error) {
        if (isChildCleanupError(error)) {
          this.recyclePending = true;
          childCleanupError = error;
        }
      }
    }
    if (this._activeSessions > 0) this._activeSessions -= 1;
    if (this.recyclePending && this._activeSessions === 0 && this._alive) {
      void this.dispose();
    }
    if (childCleanupError) throw childCleanupError;
  }

  /** Snapshot descendants while the ACP parent can still prove their lineage. */
  private retainDescendants(): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    for (const descendantPid of processDescendantPids(pid)) {
      if (this.retainedDescendants.has(descendantPid)) continue;
      const identity = snapshotProcessIdentity(descendantPid);
      if (identity) this.retainedDescendants.set(descendantPid, identity);
    }
  }

  /** Synchronously signal retained descendants, verifying Linux PID identity before every kill. */
  private killRetainedDescendants(): void {
    for (const identity of [...this.retainedDescendants.values()].reverse()) {
      if (!isSameTrackedProcess(identity)) continue;
      try {
        process.kill(identity.pid, "SIGKILL");
      } catch {
        // A descendant can exit between identity verification and this synchronous escalation.
      }
    }
  }

  /** Wait until all retained descendants have exited, so pool disposal cannot release them early. */
  private async waitForRetainedDescendants(): Promise<void> {
    while ([...this.retainedDescendants.values()].some(isSameTrackedProcess)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * Synchronous best-effort force kill for process-exit and bounded shutdown paths. The parent
   * ACP server gets an isolated process group; retained detached descendants remain reachable
   * after a graceful parent exit so the host deadline can still tear down their process groups.
   */
  killNow(): void {
    const parentAlive = this._alive;
    const pid = parentAlive ? this.child.pid : undefined;
    if (parentAlive) this.retainDescendants();
    if (pid !== undefined && process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 1_000,
        });
      } catch {
        // The direct kill below remains the best-effort fallback when taskkill races an exit.
      }
    } else if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process group may already be gone; direct kills below cover any surviving child.
      }
    }
    this.killRetainedDescendants();
    if (parentAlive) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  /** Close the process (pool teardown): end stdin, SIGTERM, escalate to SIGKILL, await exit. */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOwned();
    return this.disposePromise;
  }

  private async disposeOwned(): Promise<void> {
    if (!this._alive) return;
    // Mark graceful shutdown so the imminent process-exit `die()` does not emit `backend_error`.
    this.disposing = true;
    // Capture detached descendants before stdin EOF or SIGTERM lets a cooperative ACP parent
    // exit and orphan them. The retained identities keep this disposal pending until escalation.
    this.retainDescendants();
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
    const sigkill = this.disposeTimer.set(() => {
      this.killNow();
    }, this.backendId === "pi" ? PI_DISPOSE_SIGKILL_GRACE_MS : DISPOSE_SIGKILL_GRACE_MS);
    sigkill.unref?.();
    try {
      await exited;
      await this.waitForRetainedDescendants();
    } finally {
      this.disposeTimer.clear(sigkill);
    }
  }
}

export function isChildCleanupError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; data?: unknown };
  if (candidate.code !== -32603 || !candidate.data || typeof candidate.data !== "object") return false;
  return (candidate.data as { errorKind?: unknown }).errorKind === "child_cleanup_error";
}

type ModelSelectOption = Extract<SessionConfigOption, { type: "select" }>;

interface ActiveTurn {
  ended: Promise<void>;
  resolveEnded(): void;
  cancellation?: Promise<void>;
}

/**
 * One agent() run's ACP session on a pooled connection. Owns the per-session cwd/schema/policy,
 * the model-selection state, and the abort wiring. On release() it lets go of the session
 * WITHOUT killing the pooled process. Implements StructuredSource for the backend's native read.
 */
export class SessionHandle implements StructuredSource {
  private configOptions: SessionConfigOption[];
  private removeAbort: (() => void) | undefined;
  private releasePromise: Promise<void> | undefined;
  private abortCancellation: Promise<void> | undefined;
  private activeTurn: ActiveTurn | undefined;
  private resolveReleaseStarted!: () => void;
  private readonly releaseStarted = new Promise<void>((resolve) => {
    this.resolveReleaseStarted = resolve;
  });

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
        void this.cancelAfterAbort().catch(() => {
          // release() replays the same rejection to the runner so child_cleanup_error remains
          // observable without turning the fire-and-forget abort listener into an unhandled one.
        });
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        this.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /** Per-session usage accumulator (read by the runner on BOTH success and error paths). */
  get usage(): UsageAccumulator {
    return this.state.usage;
  }

  /** Structured provider metadata observed before the current prompt rejected. */
  get providerErrorMetadata(): ProviderErrorMetadata | undefined {
    return this.state.providerErrorMetadata;
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

  /** Stable per-session initialize metadata snapshot used by refs and every event context. */
  get initializeMeta(): Readonly<Record<string, unknown>> | undefined {
    return this.state.initializeMeta;
  }

  /** The agent-advertised session config options in their verbatim ACP wire shapes. */
  get advertisedConfigOptions(): SessionConfigOption[] {
    return this.configOptions;
  }

  /** Pass the routed model id straight to the agent. Its catalog and validation are authoritative. */
  async selectModel(spec: string): Promise<void> {
    await this.applyConfigOption("model", spec);
  }

  /** Apply authored session config options verbatim in deterministic option-id order. */
  async setConfigOptions(options: Record<string, string | boolean> | undefined): Promise<void> {
    for (const id of Object.keys(options ?? {}).sort()) {
      await this.applyConfigOption(id, options![id]);
    }
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
    let resolveEnded!: () => void;
    const turn: ActiveTurn = {
      ended: new Promise<void>((resolve) => {
        resolveEnded = resolve;
      }),
      resolveEnded: () => resolveEnded(),
    };
    this.activeTurn = turn;
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
    try {
      const response = await this.pooled.prompt(request);
      this.state.usage.recordPromptUsage(response.usage);
      return response;
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
      turn.resolveEnded();
    }
  }

  /** StructuredSource — the latest turn's assistant text. */
  currentTurnText(): string {
    return this.state.currentTurnText();
  }

  /** StructuredSource — the latest turn's FINAL assistant message (see SessionState). */
  finalMessageText(): string {
    return this.state.finalMessageText();
  }

  /** StructuredSource — Claude's raw structured_output for the latest turn, if any. */
  rawStructuredOutput(): unknown {
    return this.state.rawResultSuccess?.structured_output;
  }

  /** Cancel the active turn. A backend that does not settle within the grace window is closed and
   *  its pooled child is quarantined for recycle after sibling sessions drain. */
  async cancel(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      await this.pooled.cancelSession(this.sessionId);
      return;
    }
    await this.cancelTurn(turn);
  }

  private cancelAfterAbort(): Promise<void> {
    const turn = this.activeTurn;
    if (turn) return this.cancelTurn(turn);
    this.abortCancellation ??= this.cancelAndEscalate(this.releaseStarted);
    return this.abortCancellation;
  }

  private cancelTurn(turn: ActiveTurn): Promise<void> {
    turn.cancellation ??= this.cancelAndEscalate(turn.ended);
    return turn.cancellation;
  }

  private async cancelAndEscalate(observedEnd: Promise<void>): Promise<void> {
    await this.pooled.cancelSession(this.sessionId);
    if (await resolvesWithin(observedEnd, CANCEL_NOT_HONORED_GRACE_MS)) return;
    this.pooled.quarantineAfterIgnoredCancel();
    await this.release();
  }

  /** Let go of this session WITHOUT killing the pooled process; idempotent.
   *  `keepOpen` skips the release-time best-effort `session/close` so an agent-persisted
   *  session stays re-openable via session/load|resume (RunOptions.keepSession). */
  release(options: { keepOpen?: boolean } = {}): Promise<void> {
    this.releasePromise ??= this.releaseOwned(options.keepOpen === true);
    return this.releasePromise;
  }

  private async releaseOwned(keepOpen: boolean): Promise<void> {
    this.resolveReleaseStarted();
    this.removeAbort?.();
    this.removeAbort = undefined;
    await this.pooled.releaseSession(this.sessionId, keepOpen);
  }
}

/** Resolve true when `op` settles before the grace period and false when the grace wins. */
function resolvesWithin(op: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void op.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
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

function isModeConfigOption(option: SessionConfigOption): option is ModelSelectOption {
  return option.type === "select" && (option.id === "mode" || option.category === "mode");
}

function flattenSelectOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  const out: SessionConfigSelectOption[] = [];
  for (const entry of options) {
    if ("options" in entry) out.push(...entry.options);
    else out.push(entry);
  }
  return out;
}
