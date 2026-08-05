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
import type { TSchema } from "typebox";
import type { Backend, BackendId } from "./backend.js";
import type { NegotiatedCapabilities } from "./capabilities.js";
import {
  isChildCleanupError,
  type PooledConnection,
  type SessionHandle,
  type SteeringOutcome,
} from "./acp-client.js";
import type { AcpEventListener, AcpEventName } from "./events.js";
import { mapThrownError } from "./errors-map.js";
import type { ElicitationResolver, PermissionResolver } from "./permissions.js";
import {
  appendPromptImages,
  buildRunPrompt,
  mergeTurnMeta,
  validatePromptImages,
} from "./prompt.js";

/** Options for AcpAgentRunner.openSession(): backend selection and session/new inputs for one
 *  held-open interactive ACP session. `cwd` is required and absolute; unlike run(), there is no
 *  default to process.cwd() because the session can span many turns. The session-scoped
 *  permission/elicitation resolvers win over the runner-wide defaults; tool allow/deny policy is
 *  used only when no permission resolver is present. */
export interface InteractiveSessionOptions {
  /** Model spec: registered first segment routes once; any remaining id is sent verbatim. */
  model?: string;
  /** Structured-output contract for this session's turns (same dialect `run()` accepts).
   *  Folded into the backend's native schema channels exactly like `run()`: session/new
   *  `_meta` for backends that carry the schema there (Claude), per-turn `_meta` for
   *  backends that forward it on the turn (Codex, custom), and — for backends whose agent
   *  may ignore the `_meta` forward entirely (`embedSchemaInPrompt`) — into the prompt
   *  text itself. The schema does not change the interactive contract otherwise: the host
   *  drives the repair ladder itself (e.g. `resolveStructuredOutput` over the session) and
   *  reads the result through `currentTurnText()`/`finalMessageText()`/`rawStructuredOutput()`.
   *  The client-hosted StructuredOutput capture tool is never injected on the interactive
   *  path (it is a per-call run() device). */
  schema?: TSchema;
  /** Agent-advertised session mode id. Strict: openSession fails rather than running unconfined. */
  mode?: string;
  /** Agent-advertised ACP session config options, applied verbatim in sorted option-id order. */
  configOptions?: Record<string, string | boolean>;
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
  /** The model id accepted for the session (display/telemetry). */
  onModelResolved?: RunOptions["onModelResolved"];
  /** Compatibility callback for non-resolution subsystems or third-party runners. */
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
  /** The session's structured-output contract (see `InteractiveSessionOptions.schema`). */
  readonly schema: TSchema | undefined;
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
  /** The re-attach arm's release watchers (see `waitForRelease`). */
  private readonly releaseWatchers = new Set<() => void>();
  private readonly cwd: string;
  private readonly keepSession: boolean;
  /** The session's structured-output contract (see `InteractiveSessionOptions.schema`). */
  private readonly schema: TSchema | undefined;
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
    this.schema = deps.schema;
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

  /** The latest turn's assistant text (turn-segmented, like `run()`'s
   *  no-schema result path). Added for the REPL broker's result shaping;
   *  additive passthrough to `SessionHandle`. */
  currentTurnText(): string {
    return this.session.currentTurnText();
  }

  /** The latest turn's FINAL assistant message (the schema-extraction
   *  source `run()` uses; prose extraction over the whole turn would
   *  resurrect the first-JSON-wins bug for schema-shaped progress
   *  messages). Added for the REPL broker's structured-output ladder;
   *  additive passthrough to `SessionHandle`. */
  finalMessageText(): string {
    return this.session.finalMessageText();
  }

  /** This session's structured-output contract (set at open via
   *  `InteractiveSessionOptions.schema`), or undefined for plain sessions. */
  get outputSchema(): TSchema | undefined {
    return this.schema;
  }

  /** Claude's raw `structured_output` for the latest turn, if any (the
   *  native structured channel the runner's ladder tries first). Added
   *  for the REPL broker's structured-output ladder; additive passthrough
   *  to `SessionHandle`. */
  rawStructuredOutput(): unknown {
    return this.session.rawStructuredOutput();
  }

  /** Message/tool history accumulated in this session's retained log. */
  get history(): readonly AgentHistoryEntry[] {
    return this.session.history;
  }

  /** Send one prompt turn. A concurrent prompt on the same InteractiveSession is rejected with a
   *  clear host-side error; queueing is deliberately left to the host so turn boundaries remain
   *  explicit. Per-turn images are appended only to this prompt, and SessionHandle.prompt()
   *  performs capability adaptation before sending.
   *
   *  The `onHandoff` option is the host's explicit handoff acknowledgment: it fires exactly
   *  once the prompt has passed every preflight check (released session, aborted signal,
   *  prompt-in-flight, image validation) AND the underlying ACP session/prompt request has
   *  actually been invoked — the call below runs synchronously through request construction
   *  and the wire send, so by the time the acknowledgment fires the payload is on the wire:
   *  the point of no return. A host that records a "delivered" marker for the prompt (the
   *  REPL broker's queued-steer delivery marker) MUST record it here rather than when the
   *  returned promise is created: an async pre-handoff rejection (released session, aborted
   *  signal, or prompt-in-flight) never reaches this line, and a marker recorded before it
   *  would make a restore skip a turn that was never delivered. The acknowledgment firing
   *  AFTER the invocation is the crash-boundary contract (review regression: it used to
   *  fire BEFORE, so a crash in that interval left a durable "delivered" marker on a prompt
   *  the backend never received — and a restore then skipped a never-delivered turn): a
   *  crash before the acknowledgment leaves the prompt undelivered-in-the-store and a
   *  restore re-issues it (at-least-once); a crash after it would replay a turn that is
   *  already on the wire, which the marker's host prevents. A throwing callback aborts the
   *  turn — its error propagates through the normal mapping — but the backend prompt is
   *  ALREADY invoked at that point, so the turn is the host's delivery-failure path, never
   *  a not-sent turn. */
  async prompt(
    content: string | ContentBlock[],
    opts: {
      images?: readonly PromptImage[];
      promptMeta?: Record<string, unknown>;
      onHandoff?: () => void;
    } = {},
  ): Promise<InteractiveTurn> {
    if (this.releasePromise) throw new Error("InteractiveSession has been released");
    this.signal?.throwIfAborted();
    if (this.promptInFlight) {
      throw new Error("InteractiveSession.prompt() already has a prompt in flight; await it before sending another turn");
    }
    validatePromptImages(opts.images, this.label);

    this.promptInFlight = true;
    try {
      // Same request shaping as run(): a schema-bearing generic backend whose agent may
      // ignore the `_meta` forward gets the contract stated in-band; the backend-computed
      // turn meta (e.g. Codex's outputSchema forward) merges UNDER the user meta so the
      // schema channel is never clobbered.
      const shaped =
        typeof content === "string" && this.schema !== undefined && this.backend.embedSchemaInPrompt
          ? buildRunPrompt(content, {}, this.schema, this.backend)
          : content;
      const turnContent = appendPromptImages(shaped, opts.images);
      const promptMeta = mergeTurnMeta(opts.promptMeta, this.backend.promptMeta(this.schema));
      // The handoff acknowledgment (see the method docs above): fires only after the
      // underlying ACP session/prompt request has been invoked — the call below runs
      // synchronously through request construction and the wire send, so the payload is
      // on the wire before the acknowledgment (review crash-boundary regression: the
      // acknowledgment used to fire BEFORE the invocation, so a crash in that interval
      // left a durable host "delivered" marker on a prompt the backend never received).
      const responsePromise = this.session.prompt(turnContent, promptMeta);
      try {
        opts.onHandoff?.();
      } catch (error) {
        // The prompt is already on the wire: the marker write failed (or the host's
        // acknowledgment threw) AFTER the hand-off, so the turn is a delivery failure,
        // not a not-sent turn. The abandoned response must not become an unhandled
        // rejection in the host process.
        responsePromise.catch(() => {});
        throw error;
      }
      const response = await responsePromise;
      return {
        stopReason: response.stopReason,
        text: this.session.currentTurnText(),
      };
    } catch (error) {
      if (this.signal?.aborted) throw error;
      throw mapThrownError(error, {
        label: this.label,
        backendId: this.backendId,
        backend: this.backend,
        providerErrorMetadata: this.session.providerErrorMetadata,
        authMethods: this.capabilities?.authMethods,
      });
    } finally {
      this.promptInFlight = false;
    }
  }

  /** Inject a follow-up into the prompt currently in flight. Idle callers must use prompt():
   *  steering has no client-owned turn, output, usage, or retry path. Concurrent steer calls are
   *  sent independently and left to the backend's ordering semantics. */
  async steer(
    content: string | ContentBlock[],
    opts: { images?: readonly PromptImage[]; promptMeta?: Record<string, unknown> } = {},
  ): Promise<SteeringOutcome> {
    if (this.releasePromise) throw new Error("InteractiveSession has been released");
    this.signal?.throwIfAborted();
    if (!this.promptInFlight) {
      throw new Error(
        "InteractiveSession.steer() requires prompt() to be in flight; use prompt() when the session is idle",
      );
    }
    validatePromptImages(opts.images, this.label);

    try {
      const steeringContent = appendPromptImages(content, opts.images);
      const promptMeta = mergeTurnMeta(opts.promptMeta, this.backend.promptMeta(undefined));
      return await this.session.steer(steeringContent, promptMeta);
    } catch (error) {
      if (this.signal?.aborted) throw error;
      throw mapThrownError(error, {
        label: this.label,
        backendId: this.backendId,
        backend: this.backend,
        providerErrorMetadata: this.session.providerErrorMetadata,
        authMethods: this.capabilities?.authMethods,
      });
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

  /**
   * The loaded session's founding-turn completion — the re-attach arm's task
   * source (phase D of the REPL orchestrator roadmap; the broker drives this
   * on a session re-opened with `runner.loadSession()` after a daemon
   * restart). Resolves with the turn that was in flight at the backend when
   * the session was loaded, so a re-attached call's continuation fires
   * exactly once, through the same record → settle → consume pump as a live
   * call.
   *
   * **What is observable over the ACP protocol** (the spec-owed decision,
   * documented here — phase-D review: the seam used to judge completion
   * from a trailing `agent_message_chunk` at load time and reject a
   * still-streaming turn, so partial output of a live turn could be
   * settled as success and a loaded session with its founding turn still
   * running was released and re-issued, risking duplicated work):
   * `session/load` obliges the agent to replay the entire persisted
   * conversation via `session/update` notifications and only THEN resolve
   * the load request. A turn that ended while this host was down has its
   * final message in the replay; a turn still running at the backend
   * continues streaming AFTER the load response. Over the wire the two are
   * indistinguishable until the stream settles, so this seam OBSERVES the
   * update stream instead of probing a single instant:
   *
   * 1. A transcript with no user message at all (the recorded session
   *    never received its prompt) rejects immediately — re-issue is safe
   *    there (nothing reached the backend).
   * 2. Otherwise the seam waits for the stream to SETTLE: no
   *    session/update for this session for `LOADED_TURN_SETTLE_GRACE_MS`
   *    (default 250 ms; `AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS`).
   *    Any update kind (message chunk, thought, tool call, usage) resets
   *    the quiet clock — ACP message chunks are PROGRESS, never terminal
   *    markers, so a still-streaming turn is never settled with partial
   *    output.
   * 3. When the stream has settled AND the trailing content event is an
   *    assistant message, this resolves with `{ stopReason: "end_turn",
   *    text }` — the stop reason is synthesized because the protocol's
   *    replay carries no stop reason for a turn this client did not
   *    start; the text is the founding turn's REAL accumulated outcome,
   *    and the broker's result-shaping ladder (`finalMessageText`/schema
   *    extraction, the empty-output gate) reads the same transcript. The
   *    loaded session stays ATTACHED (phase-D review: a successfully
   *    loaded session with its founding turn still running used to be
   *    released and re-issued — duplicated work; now the seam waits for
   *    the turn's authoritative completion).
   * 4. When the stream has settled but the trailing content is NOT a
   *    terminal assistant message (a user message, a thought, a tool
   *    call, a plan — the turn ended without a terminal message: refusal,
   *    silent death), the seam keeps waiting for more updates up to
   *    `LOADED_TURN_MAX_WAIT_MS` (default 15 min;
   *    `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS`) — the turn may be
   *    mid-tool-call. On expiry it rejects with a plain host-side Error
   *    (never a wire error) naming the condition; the broker degrades to
   *    re-issue through its documented honest fallback. The bound is the
   *    "a re-attached call can never hang unobserved" backstop: a
   *    backend that never ends the turn (and never dies — a dead backend
   *    auto-releases the session, which also rejects the wait) must not
   *    park the call forever.
   */
  async awaitCurrentTurn(): Promise<InteractiveTurn> {
    if (this.releasePromise) {
      throw new Error("InteractiveSession has been released");
    }
    const probe = this.session.loadedTurnState();
    if (!probe.hasUserMessage) {
      throw new Error(
        "the loaded session's transcript shows no user message — the founding turn never reached the backend " +
          "(its outcome is unobservable; re-issue is the honest fallback)",
      );
    }
    const start = Date.now();
    const settleGraceMs = loadedTurnSettleGraceMs();
    const maxWaitMs = loadedTurnMaxWaitMs();
    for (;;) {
      if (this.releasePromise) {
        throw new Error(
          "InteractiveSession has been released while awaiting the loaded session's founding turn",
        );
      }
      const elapsed = Date.now() - start;
      const quietForMs = Date.now() - this.session.lastUpdateAtMs();
      if (quietForMs >= settleGraceMs) {
        const state = this.session.loadedTurnState();
        if (state.trailingContentKind === "assistant-message") {
          // The stream settled with the founding turn's final message in
          // the transcript — the turn observably completed (while this
          // host was down, or just now). The loaded session stays
          // attached; the broker settles the call from this authoritative
          // completion.
          return { stopReason: "end_turn", text: this.session.loadedTurnText() };
        }
        if (elapsed >= maxWaitMs) {
          throw new Error(
            `the loaded session's founding turn never reached a terminal assistant message within ` +
              `${maxWaitMs} ms of the load (the replayed transcript's trailing content is not a terminal ` +
              `assistant message, and no further updates arrived) — its outcome is not observable over the ` +
              `ACP protocol; re-issue is the honest fallback`,
          );
        }
        // Quiet, but the trailing content is not a terminal assistant
        // message: the turn may be mid-tool-call. Keep waiting for more
        // updates (the next update resets the quiet clock).
      }
      // Wait for the next update, the quiet-clock expiry, the max-wait
      // expiry, or the session's release — whichever comes first (no
      // polling: a long still-running turn is observed with zero busy
      // work).
      const quietRemaining = Math.max(0, settleGraceMs - quietForMs);
      const budgetRemaining = Math.max(0, maxWaitMs - elapsed);
      const waitMs = quietRemaining > 0 ? quietRemaining : budgetRemaining;
      await Promise.race([
        this.nextLoadedTurnUpdate(),
        sleep(waitMs),
        this.waitForRelease(),
      ]);
    }
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

  /** Resolve on the session's next update (the re-attach arm's wait
   *  primitive — zero polling; the subscription is one-shot and removed
   *  the moment it fires). */
  private nextLoadedTurnUpdate(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.session.subscribeUpdates(() => {
        off();
        resolve();
      });
    });
  }

  /** Resolve when the session is released (or immediately when it
   *  already is) — the re-attach arm's release watch, so a session that
   *  dies or is disposed while the seam waits unblocks the wait instead
   *  of parking it until the max-wait expiry. */
  private waitForRelease(): Promise<void> {
    return new Promise((resolve) => {
      if (this.releasePromise) {
        resolve();
        return;
      }
      const watcher = () => {
        this.releaseWatchers.delete(watcher);
        resolve();
      };
      this.releaseWatchers.add(watcher);
    });
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
      ...(this.session.initializeMeta !== undefined
        ? { initializeMeta: this.session.initializeMeta }
        : {}),
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
    // Wake the re-attach arm's release watchers FIRST: an awaiting
    // `awaitCurrentTurn` must unblock the moment the session is released
    // (its loop re-checks `releasePromise` and rejects).
    for (const watcher of [...this.releaseWatchers]) {
      this.releaseWatchers.delete(watcher);
      watcher();
    }
    let childFailure: unknown;
    try {
      await this.session.release({ keepOpen: this.keepSession });
    } catch (error) {
      if (isChildCleanupError(error)) childFailure = error;
    }
    try {
      await this.connection.dispose();
    } catch {
      // best-effort: mirrors pool disposal semantics.
    } finally {
      this.removeSubscriptions();
      this.onReleaseCallback(this);
    }
    if (childFailure) throw childFailure;
  }

  private removeSubscriptions(): void {
    const subscriptions = [...this.subscriptions];
    for (const off of subscriptions) off();
    this.subscriptions.clear();
  }
}

/** The loaded-session founding-turn stream-settled grace: how long the
 *  update stream must stay quiet before the re-attach arm treats the turn
 *  as observably complete (see `awaitCurrentTurn`). A still-running turn
 *  streams progress — any update kind resets the quiet clock — so the
 *  grace is the classifier between "a turn that ended while the host was
 *  down" (replay ended, nothing more arrives) and "a turn still running"
 *  (live chunks keep arriving after the load response). Default 250 ms;
 *  `AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS` overrides (clamped to
 *  >= 1 ms). */
function loadedTurnSettleGraceMs(): number {
  const env = process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return 250;
}

/** The loaded-session founding-turn max wait: the re-attach arm's
 *  "never hang unobserved" backstop (see `awaitCurrentTurn`). A still-
 *  running turn whose stream settled WITHOUT a terminal assistant message
 *  (trailing user message / thought / tool call / plan) is waited out up
 *  to this bound — it may be mid-tool-call — then the seam rejects with
 *  the honest host-side error and the broker re-issues. Default 15 min;
 *  `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS` overrides (clamped to
 *  >= 1 ms). */
function loadedTurnMaxWaitMs(): number {
  const env = process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return 15 * 60 * 1000;
}

/** Timer sleep (the re-attach arm's quiet-wait primitive). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
