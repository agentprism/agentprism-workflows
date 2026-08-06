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
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import type { Backend, BackendId } from "./backend.js";
import type { NegotiatedCapabilities } from "./capabilities.js";
import {
  isChildCleanupError,
  type LoadedTurnStatus,
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
   * **The authoritative-completion seam** (the spec-owed decision,
   * documented here — phase-D review round 3: the quiet-grace heuristic
   * (a settled stream with a trailing assistant chunk treated as
   * completion) and the blind re-issue fallback were both rejected,
   * because a restored transcript ending in an assistant PARTIAL was
   * durably settled as a completed-while-down turn when the next live
   * chunk arrived later, and a still-running backend turn was re-issued
   * (duplicated work). Completion evidence is now the `_session/loaded_turn`
   * vendor extension — an AUTHORITATIVE turn-terminal channel for loaded
   * sessions, advertised at initialize (`_meta.loadedTurn.supported ===
   * true`, the steering-extension precedent): `session/load` still obliges
   * the agent to replay the entire persisted conversation before resolving
   * (the runner marks the LOAD BOUNDARY synchronously after the response),
   * and the seam then asks the backend `_session/loaded_turn/query`
   * whether the founding turn is still running RIGHT NOW. The backend
   * answers with one of three terminal classifications:
   *
   * - **`running`** — the founding turn is still executing at the backend
   *   (its replay transcript is PARTIAL, whatever its trailing content).
   *   The seam KEEPS THE LOADED SESSION ATTACHED and waits for the
   *   `_session/loaded_turn/ended` notification — the turn's authoritative
   *   terminal marker (a quiet gap is only a progress-stream gap, never
   *   terminal evidence; the notification fires when the turn ends,
   *   carrying the stop reason or the error). It absorbs the turn's live
   *   `session/update` stream meanwhile, so a completion settles with the
   *   turn's REAL accumulated text. The wait is bounded by
   *   `LOADED_TURN_MAX_WAIT_MS` (default 15 min;
   *   `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS` — the "never hang
   *   unobserved" backstop); a bound expiry rejects with the
   *   `LoadedTurnStillRunningError` (re-armable: the notification may
   *   still arrive later).
   * - **`completed`** — no turn is running, and the founding turn
   *   observably completed while this host was down: the replay's
   *   trailing assistant message is its FINAL message, so the seam
   *   resolves with it IMMEDIATELY (`{ stopReason: "end_turn", text }` —
   *   the stop reason is synthesized because the protocol's replay
   *   carries none; the text is the turn's real accumulated outcome, and
   *   the broker's result-shaping ladder reads the same transcript).
   *   A backend that answers `completed` while the replay does NOT end
   *   with an assistant message contradicts itself — the final message is
   *   not in the replay, so the seam rejects with the safe-re-issue
   *   class.
   * - **`interrupted`** — no turn is running, and the founding turn ended
   *   without a terminal assistant message (it was interrupted/failed/
   *   abandoned while the host was down). Its outcome is not observable,
   *   but nothing is running at the backend, so the seam rejects with the
   *   SAFE-RE-ISSUE class (the broker re-issues under the same call id —
   *   no duplication possible).
   *
   * **Backends WITHOUT the extension degrade guest-visibly** (the doc's
   * established pattern for missing capabilities — never by settling
   * partial output and never by duplicate issue): the terminal state is
   * unobservable, so the seam rejects immediately with the
   * `LoadedTurnStillRunningError` (non-re-armable) — the broker keeps the
   * loaded session attached, leaves the call pending, and surfaces the
   * condition guest-visibly (cancelable), never settling a quiet gap and
   * never re-issuing a turn that may still be running. The same
   * classification applies when the `_session/loaded_turn/query` wire
   * request itself fails (the capability gate or a wire error): the
   * answer is the one thing that makes completion observable, and its
   * absence is the missing extension.
   *
   * The unconditional arms stay: a handle that was never load-marked
   * (not produced by the runner's `loadSession` path), and a transcript
   * with no user message at all (the recorded session never received its
   * prompt — nothing reached the backend), both reject immediately with
   * the safe-re-issue class. A released/dead session mid-wait rejects
   * through the same plain class (a dead process means the backend turn
   * died with it — re-issue is safe; the broker's own teardown releases
   * are handled by the broker's drain state).
   */
  async awaitCurrentTurn(): Promise<InteractiveTurn> {
    if (this.releasePromise) {
      throw new Error("InteractiveSession has been released");
    }
    const boundary = this.session.loadBoundaryState();
    if (!boundary.marked) {
      throw new Error(
        "the loaded session's founding-turn boundary was not recorded at load " +
          "— its completion is not observable over the ACP protocol; re-issue is the honest fallback",
      );
    }
    if (!boundary.hasUserMessage) {
      throw new Error(
        "the loaded session's transcript shows no user message — the founding turn never reached the backend " +
          "(its outcome is unobservable; re-issue is the honest fallback)",
      );
    }
    // The terminal-state gate: a backend without the `_session/loaded_turn`
    // extension cannot answer the one question that makes the founding
    // turn's completion observable. Degrade guest-visibly — never settle
    // partial output (a quiet gap is only a progress gap) and never
    // re-issue (the backend turn may still be running) — by rejecting
    // with the non-re-armable still-running class: the broker keeps the
    // loaded session attached and the call pending, surfaced.
    const capabilities = this.connection.capabilities;
    if (capabilities?.supportsLoadedTurnTerminalState !== true) {
      throw new LoadedTurnStillRunningError(
        `the loaded session's founding-turn terminal state is unobservable: ${this.backendId} does not ` +
          `advertise the _session/loaded_turn extension — the turn may still be running at the backend, and ` +
          `its completion has no ACP v1 terminal marker; the call is left pending (never settled from a quiet ` +
          `gap, never re-issued)`,
        false,
      );
    }
    // Subscribe to the ended channel BEFORE the query: a turn that ends
    // between the query response and this wait must not be missed (the
    // notification is recorded on the session state, first-wins).
    let status: LoadedTurnStatus;
    try {
      status = (await this.connection.queryLoadedTurn(this.sessionId, this.label)).status;
    } catch (error) {
      // The wire query failed (the capability gate or a wire error): the
      // authoritative answer is unavailable, so the terminal state is
      // unobservable — the same degradation as a backend without the
      // extension (never settle, never re-issue).
      throw new LoadedTurnStillRunningError(
        `the loaded session's founding-turn terminal state is unobservable: _session/loaded_turn/query ` +
          `failed (${thrownMessageOf(error)}) — the turn may still be running at the backend; the call is left ` +
          `pending (never settled from a quiet gap, never re-issued)`,
        false,
      );
    }
    if (status === "completed") {
      if (boundary.trailingContentKind !== "assistant-message") {
        // The backend claims the founding turn completed, but its final
        // assistant message is not the replay's last content event: the
        // outcome is not in the transcript. Nothing is running (the
        // backend said so), so the safe-re-issue class applies.
        throw new Error(
          `the loaded session's backend reported the founding turn completed, but the replayed transcript ` +
            `does not end with an assistant message — the turn's final outcome is not in the replay; re-issue ` +
            `is the honest fallback`,
        );
      }
      // Completed-while-down: the replay's trailing assistant message IS
      // the founding turn's final message (the backend's authoritative
      // answer, not a quiet-gap guess). Settle from the transcript.
      return { stopReason: "end_turn", text: this.session.loadedTurnText() };
    }
    if (status === "interrupted") {
      throw new Error(
        `the loaded session's founding turn ended without a terminal assistant message (it was interrupted ` +
          `or failed while this host was down) and no turn is running at the backend — its outcome is not ` +
          `observable over the ACP protocol; re-issue is the honest fallback (nothing is running to duplicate)`,
      );
    }
    // status === "running": the authoritative terminal wait. The turn is
    // still executing at the backend; the loaded session stays attached
    // and the seam waits for the `_session/loaded_turn/ended` notification
    // (absorbing the turn's live update stream — the settle text is the
    // accumulated transcript at the notification, the turn's REAL outcome).
    const start = Date.now();
    const maxWaitMs = loadedTurnMaxWaitMs();
    for (;;) {
      if (this.releasePromise) {
        throw new Error(
          "InteractiveSession has been released while awaiting the loaded session's founding turn",
        );
      }
      const ended = this.session.loadedTurnEndedState();
      if (ended !== null) {
        return this.loadedTurnEndedResult(ended);
      }
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) {
        // The "never hang unobserved" backstop: the turn is STILL running
        // and its terminal notification has not arrived. Never settle a
        // quiet gap and never re-issue a possibly-running turn — reject
        // with the re-armable still-running class (the broker keeps the
        // loaded session attached, leaves the call pending, warns
        // guest-visibly, and re-arms the seam so a later notification —
        // or a cancel — still settles the call).
        throw new LoadedTurnStillRunningError(
          `the loaded session's founding turn is still running at the backend, and its terminal notification ` +
            `has not arrived within ${maxWaitMs} ms of the query — settling a quiet gap could durably record ` +
            `partial output, and re-issuing could duplicate the running turn; the call stays pending on the ` +
            `attached session`,
          true,
        );
      }
      // Wait for the ended notification, the max-wait expiry, or the
      // session's release — whichever comes first (no polling: a long
      // still-running turn is observed with zero busy work).
      await Promise.race([
        this.nextLoadedTurnEnded(),
        sleep(maxWaitMs - elapsed),
        this.waitForRelease(),
      ]);
    }
  }

  /** The `_session/loaded_turn/ended` resolution: the turn that was running
   *  at load ended. A turn that ended with an ERROR is a definite
   *  rejection (never settled as success — `LoadedTurnFailedError`, the
   *  settle-as-rejection class the broker records and delivers); a turn
   *  that ended with a response resolves with its stop reason (the
   *  notification's, restricted to the ACP vocabulary — a server-specific
   *  reason the seam does not speak synthesizes `end_turn`, exactly like
   *  the completed-while-down arm) and the accumulated text. */
  private loadedTurnEndedResult(ended: { stopReason?: string; error?: { name: string; message: string } }): InteractiveTurn {
    if (ended.error !== undefined) {
      throw new LoadedTurnFailedError(
        `the loaded session's founding turn failed at the backend: ${ended.error.message}`,
      );
    }
    const stopReason = ended.stopReason ?? "end_turn";
    return {
      stopReason: LOADED_TURN_STOP_REASONS.has(stopReason as StopReason) ? (stopReason as StopReason) : "end_turn",
      text: this.session.loadedTurnText(),
    };
  }

  /** Resolve on the session's next `_session/loaded_turn/ended`
   *  notification (the re-attach arm's authoritative terminal wait —
   *  zero polling; the subscription is one-shot and removed the moment it
   *  fires, and a notification that already arrived fires immediately). */
  private nextLoadedTurnEnded(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.session.subscribeLoadedTurnEnded(() => {
        off();
        resolve();
      });
    });
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

/** The loaded-session founding-turn max wait: the re-attach arm's
 *  "never hang unobserved" backstop (see `awaitCurrentTurn`). A turn the
 *  backend classifies as `running` is waited out up to this bound for its
 *  `_session/loaded_turn/ended` notification — it may legitimately run
 *  for many minutes — then the seam rejects with the re-armable
 *  `LoadedTurnStillRunningError` (the broker keeps the loaded session
 *  attached and the call pending, and re-arms the wait so a later
 *  notification still settles it). Default 15 min;
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

/** The ACP stop-reason vocabulary the loaded-turn ended notification may
 *  carry (a server-specific reason the seam does not speak synthesizes
 *  `end_turn`, exactly like the completed-while-down arm). */
const LOADED_TURN_STOP_REASONS = new Set<StopReason>([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

/** The re-attach arm's duplicate-risk rejection: the loaded session's
 *  founding turn MAY STILL BE RUNNING at the backend and its terminal
 *  state is unobservable — the backend does not advertise the
 *  `_session/loaded_turn` extension (or its query failed), or a turn
 *  classified `running` produced no terminal notification within the
 *  max-wait bound. The host must NOT settle partial output (a quiet gap
 *  is only a progress-stream gap) and must NOT re-issue (the backend
 *  turn may still be running — duplicated work); the honest degradation
 *  is to keep the loaded session attached, leave the call pending, and
 *  surface the condition guest-visibly (cancelable). `rearmable` is true
 *  only when a terminal notification may still arrive (a `running` turn
 *  past its max-wait bound): the broker then re-arms the seam on the
 *  still-attached session. It is false when nothing observable will ever
 *  arrive (the extension is absent) — re-arming would loop forever. The
 *  marker property is structural, so third-party adapter seams can throw
 *  the same class of rejection. */
export class LoadedTurnStillRunningError extends Error {
  readonly loadedTurnStillRunning = true;
  constructor(
    message: string,
    readonly rearmable: boolean,
  ) {
    super(message);
    this.name = "LoadedTurnStillRunningError";
  }
}

/** The re-attach arm's settle-as-rejection class: the loaded session's
 *  founding turn RAN and FAILED at the backend (the `_session/loaded_turn/
 *  ended` notification carried its error). A definite outcome — the host
 *  records and settles it as a rejection, exactly like a live prompt that
 *  rejects; it is never re-issued (the task already ran to a terminal
 *  state) and never settled as success (partial text is not an outcome).
 *  Marker property is structural, like `LoadedTurnStillRunningError`. */
export class LoadedTurnFailedError extends WorkflowError {
  readonly loadedTurnFailed = true;
  constructor(message: string) {
    super(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
  }
}

/** Is this a loaded-turn still-running rejection (the broker's
 *  no-settle/no-re-issue classification)? Structural marker, so
 *  third-party adapter seams can throw the same class. */
export function isLoadedTurnStillRunningError(error: unknown): error is LoadedTurnStillRunningError {
  return (
    error instanceof LoadedTurnStillRunningError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { loadedTurnStillRunning?: unknown }).loadedTurnStillRunning === true)
  );
}

/** Is this a loaded-turn failed-at-backend rejection (the broker's
 *  settle-as-rejection classification)? Structural marker, so third-party
 *  adapter seams can throw the same class. */
export function isLoadedTurnFailedError(error: unknown): error is LoadedTurnFailedError {
  return (
    error instanceof LoadedTurnFailedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { loadedTurnFailed?: unknown }).loadedTurnFailed === true)
  );
}

/** Normalize any thrown value into a message (the query-failure arm of
 *  the seam's degradation message). */
function thrownMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Timer sleep (the re-attach arm's wait primitive). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
