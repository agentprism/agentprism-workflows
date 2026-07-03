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
// session/prompt response, in wire order on one stream. Our Client handlers are synchronous
// (they only push into the routed session's arrays), so by the time `rpc.prompt(...)` resolves,
// every update for THAT session's turn has already been folded into its accumulator — even while
// other sessions' updates interleave on the same wire.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  CLIENT_METHODS,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type ContentBlock,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
  type SessionNotification,
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
  gateCustomMeta,
  isSupportedProtocolVersion,
  negotiateCapabilities,
  unsupportedMcpServer,
  type NegotiatedCapabilities,
} from "./capabilities.js";
import { emitSessionUpdate, type AcpEventContext, type AcpEventSink } from "./events.js";
import { decidePermission, type PermissionResolver, type ToolPolicy } from "./permissions.js";
import { UsageAccumulator } from "./usage.js";
import {
  clientCapabilitiesFor,
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

/** Per-session accumulator: assistant text, tool history, usage, the Claude raw structured_output,
 *  and the permission policy/resolver used to answer permission requests for THIS session. */
class SessionState {
  readonly textChunks: string[] = [];
  readonly history: AgentHistoryEntry[] = [];
  readonly usage = new UsageAccumulator();
  readonly pendingPermissions = new Set<(outcome: RequestPermissionResponse) => void>();
  rawResultSuccess: RawResultSuccess | undefined;
  private turnStartIndex = 0;

  /** `label`/`runId` are carried here ONLY so the MultiplexClient can stamp them onto emitted
   *  events as context — they never affect routing or the wire request. */
  constructor(
    readonly cwd: string,
    readonly policy: ToolPolicy,
    readonly permissionResolver?: PermissionResolver,
    readonly label?: string,
    readonly runId?: string,
    private readonly retainSessionLog = true,
  ) {}

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
}

/** The single ACP Client handler for one pooled connection. It ROUTES every notification and
 *  permission request to the per-session SessionState by `sessionId`, so one process can serve
 *  many concurrent sessions without their streams crossing. */
class MultiplexClient implements Client {
  private readonly sessions = new Map<string, SessionState>();
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
    this.onEvent?.("session_open", this.contextFor(sessionId, state));
  }

  unregister(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    state?.settlePendingPermissions();
    this.sessions.delete(sessionId);
    if (state) {
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

  settleAllPendingPermissions(): void {
    for (const state of this.sessions.values()) {
      state.settlePendingPermissions();
    }
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
}

function unknownSession(sessionId: string): RequestError {
  return RequestError.invalidParams({ sessionId }, `unknown session: ${sessionId}`);
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function methodNotAdvertised(method: string): RequestError {
  return new RequestError(-32601, `${method} was not advertised by this client`, { method });
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
  /** Client-side ACP fs/terminal handlers advertised once and routed by sessionId. */
  clientHandlers?: ClientHandlers;
}

/**
 * One long-lived ACP server subprocess + its held ACP client connection. Initialized ONCE and
 * reused across agent() calls; it multiplexes many concurrent sessions. The process is NOT killed
 * between sessions — only dispose() (pool teardown) or a crash ends it.
 */
export class PooledConnection {
  readonly backendId: BackendId;
  /** The held ACP connection; SessionHandles drive their session/* calls through it. */
  readonly rpc: ClientSideConnection;

  private readonly backend: Backend;
  private readonly child: ChildProcess;
  private readonly client: MultiplexClient;
  private readonly onDead: (connection: PooledConnection) => void;
  private readonly onEvent: AcpEventSink | undefined;
  private readonly clientHandlers: ClientHandlers | undefined;
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
    this.client = new MultiplexClient(this.backendId, this.onEvent, deps.clientHandlers, deps.permissionResolver);

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
    this.rpc = new ClientSideConnection(() => this.client, stream);

    // Death detection. The connection's `signal` aborts the INSTANT the underlying stream closes
    // (process crash or our own dispose) — in the SAME close() that rejects pending requests — so
    // it is the earliest, DETERMINISTIC death signal: a connection is marked dead and evicted
    // before its in-flight prompt's rejection even propagates, so a concurrent acquire can never
    // hand out a connection whose process has already died. The child 'exit'/'error' events are a
    // belt-and-suspenders backstop (and carry the exit code for a clearer message).
    this.rpc.signal.addEventListener(
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

  /** Mark this connection dead exactly once, then ask the pool to evict it. Idempotent. */
  private die(error: Error): void {
    if (!this._alive) return;
    this._alive = false;
    this.deathError = error;
    this.resolveDead();
    this.client.settleAllPendingPermissions();
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
          this.rpc.initialize({
            protocolVersion: PROTOCOL_VERSION,
            // Truthful advertisement: computed from the consumer-provided handlers registered on
            // this runner. Omitted flags are unsupported; false flags are never sent deliberately.
            clientCapabilities: clientCapabilitiesFor(this.clientHandlers),
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
      // Capability gate: reject a client-provided MCP server whose transport the connected agent
      // does not advertise (http/sse gated on mcpCapabilities; stdio is always serviceable).
      // Fail-fast and non-recoverable — re-running the same incompatible transport can never
      // succeed. Lenient for agents that advertise no mcpCapabilities (the legacy passthrough).
      const unsupported = this.negotiated
        ? unsupportedMcpServer(opts.mcpServers, this.negotiated.agent)
        : undefined;
      if (unsupported) {
        throw new WorkflowError(
          `MCP server "${unsupported.name}" uses the "${unsupported.transport}" transport, which the ` +
            `${this.backendId} agent does not support`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false, agentLabel: opts.label },
        );
      }
      const state = new SessionState(
        opts.cwd,
        opts.policy,
        opts.permissionResolver,
        opts.label,
        opts.runId,
        opts.retainSessionLog ?? true,
      );
      // session/new `_meta`, layered lowest-to-highest precedence: the backend's static
      // defaults (a custom registry entry's `sessionMeta`), then the generic user passthrough
      // (opts.meta), then the backend's protocol-critical `_meta` (Claude schema channel;
      // Codex base/developer instructions), then the engine runId correlation stamp. The result
      // is gated against the agent's advertised custom capabilities (a declared key the agent
      // said it does not honor is dropped). When no layer survives, no `_meta` is sent.
      const meta = this.gateCustomMeta(
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
      const request: NewSessionRequest = {
        cwd: opts.cwd,
        // Client-provided MCP servers (additive run input), else the default empty list.
        mcpServers: opts.mcpServers ?? [],
        ...(meta ? { _meta: meta } : {}),
      };
      const response = await this.race(this.rpc.newSession(request));
      this.client.register(response.sessionId, state);
      return new SessionHandle(this, response.sessionId, state, response.configOptions ?? [], opts);
    } catch (error) {
      this._activeSessions -= 1;
      throw error;
    }
  }

  /** Best-effort ACP cancel for one session (wired to opts.signal). The PROCESS stays pooled. */
  async cancelSession(sessionId: string): Promise<void> {
    this.client.settlePendingPermissions(sessionId);
    if (!this._alive) return;
    try {
      await this.rpc.cancel({ sessionId });
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
      await this.race(withTimeout(this.rpc.closeSession({ sessionId }), CLOSE_SESSION_TIMEOUT_MS));
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

    // Fast mode: a `fast` token turns the advertised toggle on.
    if (fastRequested && !effortAbsorbedByModel) {
      const fastOption = this.configOptions.find(isFastModeOption);
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

    return fallbacks;
  }

  /** Set one session config option via the wire method and adopt the echoed catalog. */
  private async applyConfigOption(configId: string, value: string): Promise<void> {
    const response = await this.pooled.race(
      this.pooled.rpc.setSessionConfigOption({ sessionId: this.sessionId, configId, value }),
    );
    this.configOptions = response.configOptions;
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
    const response = await this.pooled.race(this.pooled.rpc.prompt(request));
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

function isFastModeOption(option: SessionConfigOption): option is ModelSelectOption {
  return option.type === "select" && (option.id === "fast-mode" || option.category === "fast-mode");
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
