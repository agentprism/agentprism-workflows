// Public held-open ACP session API. This is intentionally NOT the AgentRunner seam: it exposes
// a multi-turn session for hosts that want to drive an ACP agent directly while run() remains the
// one-shot workflow-engine contract.
import type {
  AgentNotificationMethod,
  AgentNotificationParamsByMethod,
  AgentRequestMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  ContentBlock,
  SendRequestOptions,
  SessionModeState,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { AgentHistoryEntry, AgentSessionRef, McpServerConfig, PromptImage } from "@automatalabs/shared-types";
import type { RunOptions } from "@automatalabs/shared-types";
import type { Backend, BackendId } from "./backend.js";
import type { NegotiatedCapabilities } from "./capabilities.js";
import type { PooledConnection, SessionHandle } from "./acp-client.js";
import type { AcpEventListener, AcpEventName } from "./events.js";
import type { ElicitationResolver, PermissionResolver } from "./permissions.js";
import {
  appendPromptImages,
  mergeTurnMeta,
  validatePromptImages,
} from "./prompt.js";

/** Options for AcpAgentRunner.openSession(): backend selection and session/new inputs for one
 *  held-open interactive ACP session. `cwd` is required and absolute; unlike run(), there is no
 *  default to process.cwd() because the session can span many turns. The session-scoped
 *  permission/elicitation resolvers win over the runner-wide defaults; tool allow/deny policy is
 *  used only when no permission resolver is present. */
export interface InteractiveSessionOptions {
  /** Model spec (`provider/modelId`, bare model id, or registered custom backend route). */
  model?: string;
  /** Agent-advertised session mode id. Strict: openSession fails rather than running unconfined. */
  mode?: string;
  /** Coarse tier consulted only when `model` is unset. */
  tier?: string;
  /** Absolute working directory for ACP session/new. Required for held-open sessions. */
  cwd: string;
  /** Tool allow-list used by the headless permission auto-responder. */
  toolNames?: string[];
  /** Tool deny-list, applied after the allow-list. */
  disallowedToolNames?: string[];
  /** Session-scoped permission resolver; overrides the runner-wide resolver for this session. */
  onPermissionRequest?: PermissionResolver;
  /** Session-scoped elicitation resolver; overrides the runner-wide resolver for this session. */
  onElicitation?: ElicitationResolver;
  /** The actually-resolved concrete model id (display/telemetry). */
  onModelResolved?: RunOptions["onModelResolved"];
  /** A requested model/tier spec that was not found and fell back to the session default. */
  onModelFallback?: RunOptions["onModelFallback"];
  /** Event/telemetry label stamped onto this session's emitted ACP events. */
  label?: string;
  /** Correlation id stamped into session/new `_meta` and emitted event context. */
  runId?: string;
  /** Generic session-scoped `_meta` passthrough merged under backend-computed session meta. */
  meta?: Record<string, unknown>;
  /** CODEX-ONLY base instruction override, forwarded at session/new. */
  baseInstructions?: string;
  /** CODEX-ONLY developer instruction override, forwarded at session/new. */
  developerInstructions?: string;
  /** Client-provided MCP servers to attach at session/new. */
  mcpServers?: McpServerConfig[];
  /** Keep accumulated text/history after each prompt turn; default false for held-open sessions. */
  retainSessionLog?: boolean;
  /** Skip the release-time best-effort ACP `session/close` so the agent-persisted session stays
   *  re-openable later (`loadSession`/`resumeSession` with this session's `sessionRef`). The
   *  dedicated process is disposed either way. Default false (close when advertised). */
  keepSession?: boolean;
  /** Host-owned cancellation. Aborting releases this interactive session. */
  signal?: AbortSignal;
}

/** One completed interactive prompt turn. `text` is the assistant text from THIS turn only:
 *  it is read from SessionHandle.currentTurnText(), the same turn-segmented accessor run() uses
 *  for structured-output repair turns. */
export interface InteractiveTurn {
  readonly stopReason: StopReason;
  readonly text: string;
}

type Subscribe = <K extends AcpEventName>(name: K, listener: AcpEventListener<K>) => () => void;

/** Internal construction bag for the runner-owned wrapper around an already-open ACP session. */
interface InteractiveSessionDeps {
  readonly session: SessionHandle;
  readonly connection: PooledConnection;
  readonly backend: Backend;
  readonly subscribe: Subscribe;
  readonly onRelease: (self: InteractiveSession) => void;
  readonly signal?: AbortSignal;
  readonly label?: string;
  readonly cwd: string;
  readonly keepSession: boolean;
}

/** A held-open multi-turn ACP session backed by a dedicated agent process. Only one prompt may
 *  be in flight at a time; hosts that want queued turns should serialize calls themselves so
 *  cancellation, permissions, and turn text stay attributable to a single active turn. If the
 *  dedicated process dies, the runner observes that per session by auto-releasing this wrapper:
 *  session-scoped listeners are removed, later prompt() calls fail with the released-session
 *  error, and `session_close` is emitted on this session's event stream. The connection-scoped
 *  `backend_error` event is emitted on the runner bus only; it is not delivered through
 *  session.on(). */
export class InteractiveSession {
  readonly sessionId: string;
  readonly backendId: BackendId;

  private readonly session: SessionHandle;
  private readonly connection: PooledConnection;
  private readonly backend: Backend;
  private readonly subscribe: Subscribe;
  private readonly onReleaseCallback: (self: InteractiveSession) => void;
  private readonly signal: AbortSignal | undefined;
  private readonly label: string | undefined;
  private readonly subscriptions = new Set<() => void>();
  private readonly cwd: string;
  private readonly keepSession: boolean;
  private removeAbort: (() => void) | undefined;
  private promptInFlight = false;
  private releasePromise: Promise<void> | undefined;

  /** Construct the public wrapper around an already-open ACP session. Hosts normally receive
   *  instances from AcpAgentRunner.openSession(), which supplies the internal session/connection
   *  dependencies and owns lifecycle tracking. */
  constructor(deps: InteractiveSessionDeps) {
    this.session = deps.session;
    this.connection = deps.connection;
    this.backend = deps.backend;
    this.subscribe = deps.subscribe;
    this.onReleaseCallback = deps.onRelease;
    this.signal = deps.signal;
    this.label = deps.label;
    this.cwd = deps.cwd;
    this.keepSession = deps.keepSession;
    this.sessionId = deps.session.sessionId;
    this.backendId = deps.connection.backendId;

    if (deps.signal) {
      const signal = deps.signal;
      const onAbort = () => {
        void this.release();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.removeAbort = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) void this.release();
    }
  }

  /** Negotiated initialize capabilities for this session's dedicated connection. */
  get capabilities(): NegotiatedCapabilities | undefined {
    return this.connection.capabilities;
  }

  /** Agent-advertised session mode catalog plus the currently active mode, if supported. */
  get modes(): SessionModeState | null | undefined {
    return this.session.modes;
  }

  /** Assistant text accumulated in this session's retained log. */
  get text(): string {
    return this.session.text;
  }

  /** Message/tool history accumulated in this session's retained log. */
  get history(): readonly AgentHistoryEntry[] {
    return this.session.history;
  }

  /** Send one prompt turn. A concurrent prompt on the same InteractiveSession is rejected with a
   *  clear host-side error; queueing is deliberately left to the host so turn boundaries remain
   *  explicit. Per-turn images are appended only to this prompt, and SessionHandle.prompt()
   *  performs capability adaptation before sending. */
  async prompt(
    content: string | ContentBlock[],
    opts: { images?: readonly PromptImage[]; promptMeta?: Record<string, unknown> } = {},
  ): Promise<InteractiveTurn> {
    if (this.releasePromise) throw new Error("InteractiveSession has been released");
    this.signal?.throwIfAborted();
    if (this.promptInFlight) {
      throw new Error("InteractiveSession.prompt() already has a prompt in flight; await it before sending another turn");
    }
    validatePromptImages(opts.images, this.label);

    this.promptInFlight = true;
    try {
      const turnContent = appendPromptImages(content, opts.images);
      const promptMeta = mergeTurnMeta(opts.promptMeta, this.backend.promptMeta(undefined));
      const response = await this.session.prompt(turnContent, promptMeta);
      return {
        stopReason: response.stopReason,
        text: this.session.currentTurnText(),
      };
    } finally {
      this.promptInFlight = false;
    }
  }

  /** RAW protocol escape hatch for held-open sessions. Params carry `sessionId` explicitly;
   *  use `session.sessionId` so the wire call targets this session. Prefer named wrappers when
   *  they exist because they preserve engine semantics such as accumulation/drain and usage
   *  recording; calling session/prompt here bypasses those paths. */
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
  async request(method: string, params?: unknown, options?: SendRequestOptions): Promise<unknown> {
    if (this.releasePromise) throw new Error("InteractiveSession has been released");
    return this.connection.request(method, params, options);
  }

  /** Switch this session's ACP operating mode. Fails strictly when the agent did not advertise it. */
  async setMode(modeId: string): Promise<void> {
    if (this.releasePromise) throw new Error("InteractiveSession has been released");
    this.signal?.throwIfAborted();
    await this.session.setMode(modeId);
  }

  /** RAW protocol notification escape hatch for held-open sessions. Params carry `sessionId`
   *  explicitly; use `session.sessionId` so the wire call targets this session. */
  notify<Method extends AgentNotificationMethod>(
    method: Method,
    params: AgentNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify<Params = unknown>(method: string, params?: Params): Promise<void>;
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.releasePromise) throw new Error("InteractiveSession has been released");
    await this.connection.notify(method, params);
  }

  /** Best-effort ACP session/cancel for the active turn. Pending permission/elicitation
   *  resolvers are settled as cancelled by the SessionHandle/PooledConnection cancel path. */
  async cancel(): Promise<void> {
    if (this.releasePromise) return;
    await this.session.cancel();
  }

  /** Subscribe to runner events for THIS ACP session only. Events from other one-shot or
   *  interactive sessions on the same runner are filtered out by sessionId. The returned
   *  unsubscribe thunk and every still-live subscription are removed automatically on release. */
  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    if (this.releasePromise) return () => {};
    const wrapped: AcpEventListener<K> = (event) => {
      if ((event as { sessionId?: string }).sessionId === this.sessionId) listener(event);
    };
    const removeRunnerListener = this.subscribe(name, wrapped);
    let active = true;
    const off = () => {
      if (!active) return;
      active = false;
      removeRunnerListener();
      this.subscriptions.delete(off);
    };
    this.subscriptions.add(off);
    return off;
  }

  /** Release the ACP session and close the dedicated process. Idempotent. Session close is
   *  best-effort and bounded by SessionHandle; process disposal mirrors pool teardown. */
  release(): Promise<void> {
    this.releasePromise ??= this.doRelease();
    return this.releasePromise;
  }

  /** The re-attach handle for this session — persist it, then re-open later with
   *  `runner.loadSession()`/`resumeSession()` (`backendId` doubles as the `model` routing spec).
   *  Reopen flags mirror the connected agent's advertised persistence; an agent that persists
   *  nothing leaves them all false and this ref is a tombstone once released. */
  get sessionRef(): AgentSessionRef {
    const caps = this.connection.capabilities;
    return {
      sessionId: this.sessionId,
      backendId: this.backendId,
      cwd: this.cwd,
      reopen: {
        load: caps?.supportsLoadSession === true,
        resume: caps?.supportsResumeSession === true,
        list: caps?.supportsListSessions === true,
        fork: caps?.supportsForkSession === true,
      },
    };
  }

  private async doRelease(): Promise<void> {
    this.removeAbort?.();
    this.removeAbort = undefined;
    try {
      await this.session.release({ keepOpen: this.keepSession });
    } catch {
      // best-effort: release must still dispose the dedicated process and unregister.
    }
    try {
      await this.connection.dispose();
    } catch {
      // best-effort: mirrors pool disposal semantics.
    } finally {
      this.removeSubscriptions();
      this.onReleaseCallback(this);
    }
  }

  private removeSubscriptions(): void {
    const subscriptions = [...this.subscriptions];
    for (const off of subscriptions) off();
    this.subscriptions.clear();
  }
}
