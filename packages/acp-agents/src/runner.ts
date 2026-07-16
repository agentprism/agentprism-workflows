// AcpAgentRunner — the AgentRunner seam implementation (the LEAF the engine injects against).
// One method, backend strategies behind it. Per run():
//   1. pick the backend by model/tier (cross-provider routing = which ACP server to spawn)
//   2. ACQUIRE a pooled connection + session/new { cwd } (per-session cwd = worktree isolation;
//      the PROCESS is pool-managed and REUSED across runs — never spawned/killed per run)
//   3. select the model verbatim via session/set_config_option (onModelResolved)
//   4. apply the schema per backend (Claude: at session/new; Codex: per-turn _meta)
//   5. prompt + drain; enforce the tool allow/deny policy via permission auto-responses
//   6. schema  -> native -> validate -> re-prompt ladder -> SCHEMA_NONCOMPLIANCE
//      no schema -> final assistant text (empty -> AGENT_EMPTY_OUTPUT, recoverable)
//      provider wall (thrown) -> PROVIDER_USAGE_LIMIT (non-recoverable, resetHint)
//      pooled process crash (thrown) -> recoverable AGENT_EXECUTION_ERROR (engine retries on a
//        fresh process; the dead connection is evicted from the pool)
//   7. usage -> onUsage on BOTH the success and error paths; honor opts.signal (-> session/cancel)
//   8. RELEASE the session (session/close) WITHOUT killing the process; return it to the pool
//
// Timeout and abort are the ENGINE's job: we honor opts.signal (wired to ACP session/cancel)
// and re-throw on abort, but never implement our own timeout.
import { isAbsolute } from "node:path";
import {
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  type AgentResult,
  type AgentRunner,
  type AgentSessionRef,
  type ContinuationSkipReason,
  type RunOptions,
} from "@automatalabs/shared-types";
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  AuthMethod,
  DeleteSessionRequest,
  DisableProviderRequest,
  DisableProviderResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LogoutRequest,
  LogoutResponse,
  SetProviderRequest,
  SetProviderResponse,
  SessionConfigOption,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { TSchema } from "typebox";
import {
  PooledConnection,
  ReattachCapabilityUnavailable,
  type AcpSessionOptions,
  type SessionHandle,
} from "./acp-client.js";
import { AcpAgentPool, type AcpPoolOptions } from "./pool.js";
import {
  TypedEventEmitter,
  type AcpEventListener,
  type AcpEventName,
  type AcpEventSink,
  type AcpRunnerEventMap,
} from "./events.js";
import type { Backend, BuiltinBackendId } from "./backend.js";
import { InteractiveSession, type InteractiveSessionOptions } from "./interactive.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { OpenCodeBackend } from "./backends/opencode.js";
import { CustomAcpBackend } from "./backends/custom.js";
import {
  registryWithRunBackends,
  resolveBackendRegistry,
  type BackendRegistry,
  type CustomBackendConfig,
} from "./registry.js";
import { mapThrownError } from "./errors-map.js";
import {
  buildAuthDescriptor,
  type AuthContext,
  type AuthMethodDescriptor,
  type AuthResolution,
  type AuthResolver,
} from "./auth/auth-types.js";
import {
  AuthStore,
  classifyCredential,
  type AuthIntent,
  type AuthMethodType,
  type BackendAuthState,
} from "./auth/auth-store.js";
import { ProviderStore } from "./provider-store.js";
import type { ElicitationResolver, PermissionResolver, ToolPolicy } from "./permissions.js";
import { resolveStructuredOutput, type StructuredSession } from "./structured-output.js";
import {
  STRUCTURED_OUTPUT_SERVER_NAME,
  StructuredOutputToolHost,
  type StructuredOutputToolRegistration,
} from "./structured-tool.js";
import {
  buildRunPrompt,
  mergeTurnMeta,
  promptWithImages,
  validatePromptImages,
} from "./prompt.js";
import type { ClientHandlers } from "./client-handlers.js";
import type { UsageBaseline } from "./usage.js";

type AnyRunOptions = RunOptions<TSchema | undefined>;

const STRUCTURED_TOOL_REPROMPT_TEXT =
  "You did not call the StructuredOutput tool. Call the StructuredOutput tool now, exactly once, with your final answer as its arguments conforming to its parameter schema. Do not reply with plain text.";

const CONTINUATION_INSTRUCTION =
  "Your previous turn was interrupted before it finished — the provider paused it for a usage " +
  "limit or expired credentials, not because the task was complete. The full task and all prior " +
  "context are already in this session's history; do not restart or repeat work you already did. " +
  "Continue from where you stopped and produce the COMPLETE final answer to the original task now.";

interface SessionPreparationOptions {
  model?: string;
  mode?: string;
  configOptions?: Record<string, string | boolean>;
  tier?: string;
  toolNames?: string[];
  disallowedToolNames?: string[];
  mcpServers?: AnyRunOptions["mcpServers"];
  meta?: Record<string, unknown>;
  runId?: string;
  label?: string;
  callIndex?: number;
  baseInstructions?: string;
  developerInstructions?: string;
}

interface SessionPreparationConfig {
  cwd: string;
  schema: TSchema | undefined;
  registry: BackendRegistry;
  signal?: AbortSignal;
  permissionResolver?: PermissionResolver;
  elicitationResolver?: ElicitationResolver;
  retainSessionLog?: boolean;
}

interface PreparedSession {
  backend: Backend;
  modelSpec: string | undefined;
  sessionOptions: AcpSessionOptions;
}

export interface ProbedConfigOptions {
  backendId: string;
  /** The agent-advertised options, verbatim ACP shapes (id, name, type, currentValue, choices). */
  options: SessionConfigOption[];
}

interface LifecycleRoutingOptions {
  /** Model spec used only to select the backend process. */
  model?: string;
  /** Coarse tier consulted only when `model` is unset. */
  tier?: string;
  /** Event/telemetry label used in strict capability errors. */
  label?: string;
  /** Host-owned cancellation while the lifecycle request is in flight. */
  signal?: AbortSignal;
}

/** Options for AcpAgentRunner.authMethods(). */
export interface AuthMethodsOptions {
  /** Model spec used only to select the backend process. */
  model?: string;
  /** Coarse tier consulted only when `model` is unset. */
  tier?: string;
}

/** Options for AcpAgentRunner.listSessions(). */
export interface ListSessionsOptions extends LifecycleRoutingOptions {
  /** Optional absolute working-directory filter. */
  cwd?: string;
  /** Opaque pagination cursor from the previous response. */
  cursor?: string;
  /** Generic ACP `_meta` passthrough for session/list. */
  meta?: Record<string, unknown>;
}

/** Options for AcpAgentRunner.deleteSession(). */
export interface DeleteSessionOptions extends LifecycleRoutingOptions {
  /** Session id returned by session/list or previously persisted by the backend. */
  sessionId: string;
  /** Generic ACP `_meta` passthrough for session/delete. */
  meta?: Record<string, unknown>;
}

interface AuthProviderRoutingOptions extends LifecycleRoutingOptions {
  /** Generic ACP `_meta` passthrough for the request. */
  meta?: Record<string, unknown>;
}

/** Options for AcpAgentRunner.authenticate(). */
export interface AuthenticateOptions extends AuthProviderRoutingOptions {
  /** Authentication method id advertised by runner.authMethods(). */
  methodId: AuthenticateRequest["methodId"];
}

/** Options for AcpAgentRunner.listProviders(). */
export interface ListProvidersOptions extends AuthProviderRoutingOptions {}

/** Options for AcpAgentRunner.setProvider(). */
export interface SetProviderOptions extends AuthProviderRoutingOptions {
  providerId: SetProviderRequest["providerId"];
  apiType: SetProviderRequest["apiType"];
  baseUrl: SetProviderRequest["baseUrl"];
  headers?: SetProviderRequest["headers"];
}

/** Options for AcpAgentRunner.disableProvider(). */
export interface DisableProviderOptions extends AuthProviderRoutingOptions {
  providerId: DisableProviderRequest["providerId"];
}

/** Options for AcpAgentRunner.logout(). */
export interface LogoutOptions extends AuthProviderRoutingOptions {}

/** Options for AcpAgentRunner.loadSession(), resumeSession(), and forkSession(). */
export interface ReattachSessionOptions extends InteractiveSessionOptions {
  /** Existing backend session id to reattach, or the source session id for forkSession(). */
  sessionId: string;
  /** Alias for onPermissionRequest for hosts that name the resolver by role. */
  permissionResolver?: PermissionResolver;
}

type InteractiveAssemblyOptions = InteractiveSessionOptions & {
  readonly permissionResolver?: PermissionResolver;
};

/** Options for AcpAgentRunner.completeAuth() (§1.3, §4.1). */
export interface CompleteAuthOptions extends AuthMethodsOptions {
  /** A method id from describeAuthMethods(). */
  methodId: string;
  /** The host-collected resolution (env values / gateway meta / completed / cancelled) (§1.3). */
  resolution: AuthResolution;
  /** Event/telemetry label used in strict capability errors. */
  label?: string;
  signal?: AbortSignal;
}

/** The outcome of a host-completed auth step (§1.3, §4.1). Carries no secret. */
export type AuthOutcome = { status: "authenticated" | "cancelled"; methodId: string; recycled: boolean };

/** Redacted status view surfaced by the controller, MCP tool, and web (canonical shape; §2.14). */
export interface AuthStatusSnapshot {
  backendId: string;
  poolKey: string;
  state: BackendAuthState;
  authenticated: boolean;
  canResume: boolean;
  methods: { id: string; type: AuthMethodType; name?: string }[];
}

/** The `runner.auth` controller — the auth verbs as one addressable object (§2.10, §4.1). */
export interface AuthController {
  /** Alias of describeAuthMethods(). */
  methods(opts?: AuthMethodsOptions): Promise<AuthMethodDescriptor[]>;
  /** Alias of completeAuth(). */
  authenticate(opts: CompleteAuthOptions): Promise<AuthOutcome>;
  /** Clears the AuthStore for the backend, zeroizes secrets (§2.14), and recycles the pool. */
  logout(opts?: LogoutOptions): Promise<void>;
  /** Redacted, synchronous snapshot — ids/types/names + state only, NEVER secrets (§2.14). */
  status(opts?: { backend?: string }): AuthStatusSnapshot[];
  /** Cold-resume re-arm predicate (§2.13): true iff state ∈ {authenticated,credentials_held} or diskBacked. */
  canResume(backendId: string): boolean;
}

/** Structural capability interface the MCP composition root duck-types to register auth tools
 *  without widening the frozen `AgentRunner` seam (§4.1). `AcpAgentRunner` implements it. */
export interface AuthCapableRunner {
  describeAuthMethods(opts?: AuthMethodsOptions): Promise<AuthMethodDescriptor[]>;
  completeAuth(opts: CompleteAuthOptions): Promise<AuthOutcome>;
  /** Ids of every configured backend (built-ins + AcpRunnerOptions.backends), whether or not it
   *  yet has a BackendAuthMachine. */
  listBackends(): string[];
  readonly auth: AuthController;
}

/** Structural capability interface the MCP composition root duck-types to register the provider
 *  tools, symmetric to AuthCapableRunner and equally seam-preserving. `AcpAgentRunner` implements
 *  it. This is the GENERIC base-spec `providers/*` surface: every method is advertise-gated per
 *  backend (`agentCapabilities.providers`), so any spec-conformant agent that advertises the
 *  unstable providers block is served with zero agent-specific code. */
export interface ProviderCapableRunner {
  listProviders(opts?: ListProvidersOptions): Promise<ListProvidersResponse>;
  setProvider(opts: SetProviderOptions): Promise<SetProviderResponse | void>;
  disableProvider(opts: DisableProviderOptions): Promise<DisableProviderResponse | void>;
  /** Ids of every configured backend (built-ins + AcpRunnerOptions.backends). */
  listBackends(): string[];
}

/** Constructor options for the runner: pool sizing, client-side handlers, and the custom-backend
 *  registry. `backends` merges over (and wins against) env-declared AGENTPRISM_BACKENDS entries. */
export interface AcpRunnerOptions extends AcpPoolOptions {
  /** Custom ACP backends, keyed by registered name (see registry.ts for the config shape
   *  and the routing rules). Names are ASCII-case-insensitive and shadow built-in ids. */
  backends?: Record<string, CustomBackendConfig>;
  /** Runner-wide human-in-the-loop permission resolver. When set, it replaces ToolPolicy
   *  auto-decisions for every session that does not provide its own resolver. */
  onPermissionRequest?: PermissionResolver;
  /** Runner-wide ACP elicitation responder. When set, initialize advertises unstable
   *  elicitation form/url support on every connection; sessions may override the resolver. */
  onElicitation?: ElicitationResolver;
  /** Which auth method TYPES this host can complete (§1.2). When set, initialize advertises the
   *  matching client auth capability (`auth.terminal` + top-level `_meta["terminal-auth"]`, and/or
   *  `auth._meta.gateway`) on every connection, fixed for the connection lifetime. Unset (and
   *  `onAuth` unset) omits the `auth` capability entirely — the default-OFF, zero-behavior-change
   *  baseline. When `onAuth` is set but this is unset it derives to `{ terminal: false, gateway: true }`
   *  (§1.2). A native-TTY CLI host passes `{ terminal: true, gateway: true }`. */
  authCapabilities?: { terminal?: boolean; gateway?: boolean };
  /** Inline auth resolver (§1.3, §2.11). When set, a -32000 at session/new resolves-and-retries-once
   *  and the run NEVER pauses; when unset, a -32000 run pauses with reason:"auth_required" (§2.12,
   *  PR4). Mutually exclusive with pause by construction. */
  onAuth?: AuthResolver;
}

/**
 * ACP-backed AgentRunner implementation. The caller that constructs an AcpAgentRunner owns it:
 * pass it into managers/runs as needed, then call dispose() (or use `await using`) when that
 * owner is done with the pooled and dedicated backend processes.
 */
export class AcpAgentRunner implements AgentRunner, AuthCapableRunner, ProviderCapableRunner {
  private readonly pool: AcpAgentPool;
  /** The resolved custom-backend registry (env + option, validated at construction). */
  private readonly backends: BackendRegistry;
  /** Typed bus carrying every ACP event from every pooled or interactive session. Beyond the
   *  AgentRunner seam (additive observability) — subscribing never affects a run and never enters
   *  the resume hash. */
  private readonly events = new TypedEventEmitter<AcpRunnerEventMap>();
  private readonly emitEvent: AcpEventSink = (name, event) => this.events.emit(name, event);
  /** Client-side handlers and the runner-wide permission resolver are initialize/session wiring,
   *  so dedicated interactive connections must receive the SAME deps the pool receives. */
  private readonly clientHandlers: ClientHandlers | undefined;
  private readonly permissionResolver: PermissionResolver | undefined;
  private readonly elicitationResolver: ElicitationResolver | undefined;
  /** Client auth advertisement, derived ONCE at construction and fixed for every connection this
   *  runner opens (pooled and dedicated). Undefined => the `auth` capability is omitted (§1.2). */
  private readonly authCapabilities: { terminal?: boolean; gateway?: boolean } | undefined;
  /** Inline auth resolver (§2.11). When set, run() resolves a -32000 and retries once instead of
   *  surfacing AUTH_REQUIRED. Undefined => the (PR4) pause-and-resume path. */
  private readonly onAuth: AuthResolver | undefined;
  /** The single per-runner auth store (§2.2). Holds every backend's `BackendAuthMachine`; the only
   *  home for credential material in the library. Threaded into the pool and every dedicated
   *  connection so all connection types reconcile to the same intent. */
  private readonly authStore = new AuthStore();
  /** The single per-runner provider-intent store — the providers/* sibling of the AuthStore.
   *  setProvider records here after the wire call succeeds; every connection (pooled and
   *  dedicated) replays the recorded routing at initialize, so client-configured providers
   *  survive pool recycles and dispose-after-use dedicated connections. */
  private readonly providerStore = new ProviderStore();
  /** The auth verbs as one addressable object (§2.10). */
  readonly auth: AuthController;
  private readonly structuredOutputTools = new StructuredOutputToolHost();
  /** FIFO turn queue per pooled connection for injected-tool schema runs (see the injection
   *  site for why concurrent injected sessions on one process cannot be isolated). */
  private readonly structuredToolTurns = new WeakMap<object, Promise<void>>();
  /** Held-open interactive sessions own dedicated ACP processes outside the pool. The runner
   *  tracks their connections so dispose() can release them and the process-exit hook can
   *  synchronously kill any dedicated children if the host exits without release(). */
  private readonly interactiveSessions = new Map<InteractiveSession, PooledConnection>();
  private readonly onProcessExit = () => this.killAllSync();
  private exitHookInstalled = false;
  private disposed = false;

  constructor(options: AcpRunnerOptions = {}) {
    this.clientHandlers = options.clientHandlers;
    this.permissionResolver = options.onPermissionRequest;
    this.elicitationResolver = options.onElicitation;
    this.onAuth = options.onAuth;
    // Default derivation (§1.2): explicit `authCapabilities` wins; else, when an `onAuth` resolver is
    // present, derive `{ terminal: false, gateway: true }` (gateway is cheap and non-destructive;
    // terminal needs a real TTY a generic programmatic host lacks); else omit `auth` entirely — the
    // default-OFF, byte-identical baseline.
    this.authCapabilities =
      options.authCapabilities ?? (options.onAuth ? { terminal: false, gateway: true } : undefined);
    this.pool = new AcpAgentPool(options, {
      onEvent: this.emitEvent,
      permissionResolver: options.onPermissionRequest,
      elicitationResolver: options.onElicitation,
      advertiseElicitation: Boolean(options.onElicitation),
      authCapabilities: this.authCapabilities,
      authStore: this.authStore,
      providerStore: this.providerStore,
    });
    this.backends = resolveBackendRegistry(options.backends);
    this.auth = {
      methods: (opts?: AuthMethodsOptions) => this.describeAuthMethods(opts),
      authenticate: (opts: CompleteAuthOptions) => this.completeAuth(opts),
      logout: async (opts?: LogoutOptions) => {
        await this.logout(opts ?? {});
      },
      status: (opts?: { backend?: string }) => this.authStatus(opts),
      canResume: (backendId: string) => this.canResume(backendId),
    };
  }

  /**
   * Listen in on the live ACP stream. `name` is an ACP `sessionUpdate` discriminant
   * ("agent_message_chunk", "tool_call", "usage_update", …) or one of the cross-cutting events
   * ("session_update" catch-all, "permission_pending", "permission_request",
   * "elicitation_pending", "elicitation_request", "elicitation_complete", "raw_message",
   * "session_open", "session_close", "backend_error"). The listener is typed to the event.
   * Returns an unsubscribe thunk. A pooled runner multiplexes many concurrent runs, so each
   * event carries `{ sessionId, backendId, label?, runId? }` for filtering. Listeners are
   * best-effort observers: a throwing listener is isolated and never affects the run.
   */
  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.events.on(name, listener);
  }

  /** Subscribe once; the listener auto-unsubscribes after its first delivery. */
  once<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.events.once(name, listener);
  }

  off<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): void {
    this.events.off(name, listener);
  }

  removeAllListeners(name?: AcpEventName): void {
    this.events.removeAllListeners(name);
  }

  listenerCount(name: AcpEventName): number {
    return this.events.listenerCount(name);
  }

  /**
   * Open a held ACP session for multi-turn callers. Unlike run(), this does NOT acquire a pool
   * slot: it spawns one dedicated backend process, opens one ACP session on it, and hands the
   * caller an InteractiveSession that must be released. The dedicated process means a long-lived
   * chat/debug loop never starves one-shot run() calls on the same backend (the default pool size
   * is one).
   */
  async openSession(opts: InteractiveSessionOptions): Promise<InteractiveSession> {
    return this.createInteractiveSession(opts, "openSession", (connection, prepared) =>
      connection.openSession(prepared.sessionOptions),
    );
  }

  /** Route a model spec, open exactly one session without prompting, and return the agent's
   *  advertised config-option catalog verbatim. */
  async probeConfigOptions(spec?: string, opts: { cwd?: string } = {}): Promise<ProbedConfigOptions> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    const cwd = opts.cwd ?? process.cwd();
    const prepared = this.prepareSession({ model: spec }, {
      cwd,
      schema: undefined,
      registry: this.backends,
    });
    let session: SessionHandle | undefined;
    try {
      session = await this.pool.acquire(prepared.backend, prepared.sessionOptions);
      return {
        backendId: prepared.backend.id,
        options: session.advertisedConfigOptions,
      };
    } finally {
      try {
        await session?.release();
      } catch {
        // Probe cleanup is best-effort and must not mask spawn/auth/session errors.
      }
    }
  }

  /** Return the selected backend's initialize-advertised authentication methods. */
  async authMethods(opts: AuthMethodsOptions = {}): Promise<AuthMethod[]> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");

    const backend = selectBackend(opts, this.backends);
    const connection = this.createDedicatedConnection(backend, () => undefined);
    try {
      if (this.disposed) throw new Error("ACP agent runner is disposed");
      return await connection.authMethods();
    } finally {
      await disposeBestEffort(connection);
    }
  }

  /** Drive ACP authenticate on the selected backend. REBUILT off dispose-after-authenticate (§2.9):
   *  instead of opening a dedicated connection and disposing it in `finally` — which lost any
   *  in-process (gateway) credential the agent stored on that process (gap 3) — this records the
   *  credential into the durable `AuthStore` and recycles the pool. A method with `_meta` records an
   *  in-process/disk intent replayed on every pooled connection's initialize; a bare method with no
   *  `_meta` fires the one-shot `agent-login` RPC so the agent runs its own login. */
  async authenticate(opts: AuthenticateOptions): Promise<AuthenticateResponse | void> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    validateRequiredString(opts.methodId, opts.label, "authenticate", "methodId");
    opts.signal?.throwIfAborted();

    const backend = selectBackend(opts, this.backends);
    const { methods } = await this.probeAuthMethods(backend);
    const resolution: AuthResolution = opts.meta
      ? { outcome: "meta", methodId: opts.methodId, meta: opts.meta }
      : { outcome: "agent-login", methodId: opts.methodId };
    await this.applyResolution(backend, resolution, methods, opts.methodId, opts.label);
    opts.signal?.throwIfAborted();
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    return;
  }

  /** Proactively enumerate the selected backend's advertised methods, already type-dispatched (§1.3)
   *  and label-enriched by the backend's `AuthProfile.describe` (§3.1, identity for a profile-less
   *  custom backend). A read-only probe: opens a dedicated connection, reads the initialize-advertised
   *  methods, runs the base dispatcher through the profile seam, and disposes. */
  async describeAuthMethods(opts: AuthMethodsOptions = {}): Promise<AuthMethodDescriptor[]> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    const backend = selectBackend(opts, this.backends);
    return (await this.probeAuthMethods(backend)).descriptors;
  }

  /** Record the host-collected resolution into the AuthStore, advance the generation, and recycle
   *  the pool (§2.9/§2.6) so a subsequent run() always lands on a current connection. */
  async completeAuth(opts: CompleteAuthOptions): Promise<AuthOutcome> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    validateRequiredString(opts.methodId, opts.label, "completeAuth", "methodId");
    opts.signal?.throwIfAborted();
    const backend = selectBackend(opts, this.backends);
    const { methods } = await this.probeAuthMethods(backend);
    return this.applyResolution(backend, opts.resolution, methods, opts.methodId, opts.label);
  }

  /** Ids of every configured backend (built-ins + AcpRunnerOptions.backends). */
  listBackends(): string[] {
    const ids = new Set<string>(["claude", "codex", "opencode"]);
    for (const name of this.backends.keys()) ids.add(name);
    return [...ids];
  }

  /** List configurable providers from the selected backend. */
  async listProviders(opts: ListProvidersOptions = {}): Promise<ListProvidersResponse> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    opts.signal?.throwIfAborted();

    const backend = selectBackend(opts, this.backends);
    const connection = this.createDedicatedConnection(backend, () => undefined);
    try {
      const request: ListProvidersRequest = {
        ...(opts.meta ? { _meta: opts.meta } : {}),
      };
      const response = await connection.listProviders(request, opts.label);
      opts.signal?.throwIfAborted();
      if (this.disposed) throw new Error("ACP agent runner is disposed");
      return response;
    } finally {
      await disposeBestEffort(connection);
    }
  }

  /** Configure one provider on the selected backend. The wire call validates against the live
   *  agent (unknown providerId/apiType errors surface immediately); on success the routing is
   *  recorded as a durable intent — provider config is in-process agent state for e.g. codex-acp,
   *  so without the record this dedicated connection's dispose would silently discard it (the
   *  providers/* sibling of the dispose-after-authenticate bug). Every later connection replays
   *  the intent at initialize, and the pool recycles so no session runs under stale routing.
   *  The request-scoped `meta` passthrough rides the immediate call only; it is not replayed. */
  async setProvider(opts: SetProviderOptions): Promise<SetProviderResponse | void> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    validateRequiredString(opts.providerId, opts.label, "setProvider", "providerId");
    validateRequiredString(opts.apiType, opts.label, "setProvider", "apiType");
    validateRequiredString(opts.baseUrl, opts.label, "setProvider", "baseUrl");
    opts.signal?.throwIfAborted();

    const backend = selectBackend(opts, this.backends);
    const connection = this.createDedicatedConnection(backend, () => undefined);
    try {
      const request: SetProviderRequest = {
        providerId: opts.providerId,
        apiType: opts.apiType,
        baseUrl: opts.baseUrl,
        ...(opts.headers ? { headers: opts.headers } : {}),
        ...(opts.meta ? { _meta: opts.meta } : {}),
      };
      const response = await connection.setProvider(request, opts.label);
      this.providerStore.record(backend.poolKey ?? backend.id, {
        providerId: opts.providerId,
        apiType: opts.apiType,
        baseUrl: opts.baseUrl,
        ...(opts.headers ? { headers: opts.headers } : {}),
      });
      this.pool.recycle(backend.poolKey ?? backend.id);
      opts.signal?.throwIfAborted();
      if (this.disposed) throw new Error("ACP agent runner is disposed");
      return response;
    } finally {
      await disposeBestEffort(connection);
    }
  }

  /** Disable one provider on the selected backend, drop its recorded routing intent, and recycle
   *  the pool so no future session replays it. Idempotent like the wire method. */
  async disableProvider(opts: DisableProviderOptions): Promise<DisableProviderResponse | void> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    validateRequiredString(opts.providerId, opts.label, "disableProvider", "providerId");
    opts.signal?.throwIfAborted();

    const backend = selectBackend(opts, this.backends);
    const connection = this.createDedicatedConnection(backend, () => undefined);
    try {
      const request: DisableProviderRequest = {
        providerId: opts.providerId,
        ...(opts.meta ? { _meta: opts.meta } : {}),
      };
      const response = await connection.disableProvider(request, opts.label);
      this.providerStore.remove(backend.poolKey ?? backend.id, opts.providerId);
      this.pool.recycle(backend.poolKey ?? backend.id);
      opts.signal?.throwIfAborted();
      if (this.disposed) throw new Error("ACP agent runner is disposed");
      return response;
    } finally {
      await disposeBestEffort(connection);
    }
  }

  /** Logout through the selected backend. REBUILT (§2.9): first clear the AuthStore machine
   *  (zeroizing `authenticateMeta`/`envValues`, §2.14) and recycle the pool so no pooled process
   *  replays a stale gateway credential, THEN issue the agent `logout` RPC only where advertised
   *  (gated on `supportsLogout`; opencode advertises none → store-clear + recycle, no RPC, §3.4). */
  async logout(opts: LogoutOptions = {}): Promise<LogoutResponse | void> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    opts.signal?.throwIfAborted();

    const backend = selectBackend(opts, this.backends);
    const poolKey = backend.poolKey ?? backend.id;
    this.authStore.machineFor(poolKey, backend.authProfile).send({ t: "logout" });
    this.pool.recycle(poolKey);

    const connection = this.createDedicatedConnection(backend, () => undefined);
    try {
      // await ready + negotiate before reading the logout advertisement.
      await connection.authMethods();
      if (!connection.capabilities?.supportsLogout) {
        opts.signal?.throwIfAborted();
        if (this.disposed) throw new Error("ACP agent runner is disposed");
        return; // logout unadvertised — store already cleared + recycled, no RPC (§3.4)
      }
      const request: LogoutRequest = {
        ...(opts.meta ? { _meta: opts.meta } : {}),
      };
      const response = await connection.logout(request, opts.label);
      opts.signal?.throwIfAborted();
      if (this.disposed) throw new Error("ACP agent runner is disposed");
      return response;
    } finally {
      await disposeBestEffort(connection);
    }
  }

  /** List persisted ACP sessions from the selected backend. */
  async listSessions(opts: ListSessionsOptions = {}): Promise<ListSessionsResponse> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    validateOptionalLifecycleCwd(opts.cwd, opts.label, "listSessions");
    opts.signal?.throwIfAborted();

    const backend = selectBackend(opts, this.backends);
    const connection = this.createDedicatedConnection(backend, () => undefined);
    try {
      const request: ListSessionsRequest = {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
        ...(opts.meta ? { _meta: opts.meta } : {}),
      };
      const response = await connection.listSessions(request, opts.label);
      opts.signal?.throwIfAborted();
      if (this.disposed) throw new Error("ACP agent runner is disposed");
      return response;
    } finally {
      await disposeBestEffort(connection);
    }
  }

  /** Delete a persisted ACP session from the selected backend. */
  async deleteSession(opts: DeleteSessionOptions): Promise<void> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    if (typeof opts.sessionId !== "string" || opts.sessionId.trim() === "") {
      throw new WorkflowError(
        "deleteSession requires sessionId to be a non-empty string",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: opts.label },
      );
    }
    opts.signal?.throwIfAborted();

    const backend = selectBackend(opts, this.backends);
    const connection = this.createDedicatedConnection(backend, () => undefined);
    try {
      const request: DeleteSessionRequest = {
        sessionId: opts.sessionId,
        ...(opts.meta ? { _meta: opts.meta } : {}),
      };
      await connection.deleteSession(request, opts.label);
      opts.signal?.throwIfAborted();
      if (this.disposed) throw new Error("ACP agent runner is disposed");
    } finally {
      await disposeBestEffort(connection);
    }
  }

  /** Load an existing ACP session and return a live, routed InteractiveSession. */
  async loadSession(opts: ReattachSessionOptions): Promise<InteractiveSession> {
    validateLifecycleSessionId(opts.sessionId, opts.label, "loadSession");
    return this.createInteractiveSession(opts, "loadSession", (connection, prepared) =>
      connection.loadSession(opts.sessionId, prepared.sessionOptions),
    );
  }

  /**
   * Fork an existing ACP session into a new independent session seeded with the source's context.
   * The returned InteractiveSession and its sessionRef carry the NEW session id. This unstable SDK
   * method is gated on sessionCapabilities.fork and fails before any session/fork wire request when
   * the selected backend does not advertise it.
   */
  async forkSession(opts: ReattachSessionOptions): Promise<InteractiveSession> {
    validateLifecycleSessionId(opts.sessionId, opts.label, "forkSession");
    return this.createInteractiveSession(opts, "forkSession", (connection, prepared) =>
      connection.forkSession(opts.sessionId, prepared.sessionOptions),
    );
  }

  /** Resume an existing ACP session without replay and return a live, routed InteractiveSession. */
  async resumeSession(opts: ReattachSessionOptions): Promise<InteractiveSession> {
    validateLifecycleSessionId(opts.sessionId, opts.label, "resumeSession");
    return this.createInteractiveSession(opts, "resumeSession", (connection, prepared) =>
      connection.resumeSession(opts.sessionId, prepared.sessionOptions),
    );
  }

  async run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options: RunOptions<S> = {},
  ): Promise<AgentResult<S>> {
    const opts = options as AnyRunOptions;
    assertNoModelConfigOption(opts.configOptions, opts.label);
    const schema = opts.schema;
    // Layer any run-scoped backends (an APPROVED script-declared meta.backends) under the
    // host registry. Malformed entries fail the call loudly and are NOT retried —
    // re-running a misdeclared registry can never succeed.
    let registry: BackendRegistry;
    try {
      registry = registryWithRunBackends(this.backends, opts.backends);
    } catch (error) {
      throw new WorkflowError((error as Error).message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
        agentLabel: opts.label,
      });
    }
    const cwd = opts.cwd ?? process.cwd();
    validatePromptImages(opts.images, opts.label);

    const prepared = this.prepareSession(opts, {
      cwd,
      schema,
      registry,
      signal: opts.signal,
    });
    let session: SessionHandle | undefined;
    let structuredTool: StructuredOutputToolRegistration | undefined;
    let structuredToolActive = false;
    let releaseStructuredToolTurn: (() => void) | undefined;
    let continuationUsageBaseline: UsageBaseline | undefined;
    let continuationMethod: "resume" | "load" | undefined;
    let keepOpenOnRelease = opts.keepSession === true;

    const reportContinuation = (
      continuation:
        | { reattached: true; method: "resume" | "load" }
        | { reattached: false; reason: ContinuationSkipReason },
    ): void => {
      try {
        opts.onResultProvenance?.({ source: "live", continuation });
      } catch {
        // Provenance is diagnostic; a throwing observer never changes the live call outcome.
      }
    };

    const cleanupFailedAcquisition = async (): Promise<void> => {
      try {
        releaseStructuredToolTurn?.();
      } catch {
        // best-effort cleanup before another acquire.
      }
      releaseStructuredToolTurn = undefined;
      try {
        structuredTool?.release();
      } catch {
        // best-effort cleanup before another acquire.
      }
      structuredTool = undefined;
      structuredToolActive = false;
      const discarded = session;
      session = undefined;
      try {
        await discarded?.release({ keepOpen: false });
      } catch {
        // best-effort cleanup before another acquire.
      }
    };

    try {
      const prepare = async (connection: PooledConnection): Promise<AcpSessionOptions> => {
        let sessionOptions = prepared.sessionOptions;
        if (shouldInjectStructuredOutputTool(schema, prepared.backend, connection.capabilities)) {
          // Injected runs are SERIALIZED per connection, and the server name stays CONSTANT.
          // Agents with instance-global, name-keyed MCP registries (OpenCode) expose every
          // registered tool to EVERY session on the process, so concurrent same-named
          // registrations collide and concurrent unique-named ones are cross-visible — either
          // way one session's model can call another session's tool and leak its capture.
          // Same-name registration REPLACES the previous entry; holding this per-connection
          // turn for the whole run guarantees the single live registration belongs to the
          // active session. Scale schema-run parallelism with pool size (one registry per
          // process), not sessions.
          releaseStructuredToolTurn = await this.acquireStructuredToolTurn(connection);
          structuredTool = await this.structuredOutputTools.register(schema);
          structuredToolActive = true;
          sessionOptions = {
            ...sessionOptions,
            mcpServers: [
              ...(sessionOptions.mcpServers ?? []),
              {
                type: "http",
                name: availableMcpServerName(STRUCTURED_OUTPUT_SERVER_NAME, sessionOptions.mcpServers),
                url: structuredTool.url,
                headers: [],
              },
            ],
          };
        }
        return sessionOptions;
      };

      // Continuation is a one-shot acquisition before and outside the fresh inline-auth loop.
      if (opts.continueFromSession) {
        const recorded = opts.continueFromSession;
        const recordedPoolKey = recorded.poolKey ?? recorded.backendId;
        const resolvedPoolKey = prepared.backend.poolKey ?? prepared.backend.id;
        let skipReason: ContinuationSkipReason | undefined;

        if (recorded.backendId !== prepared.backend.id || recordedPoolKey !== resolvedPoolKey) {
          skipReason = "backend-mismatch";
        } else {
          try {
            const reattached = await this.pool.acquirePreparedReattach(
              prepared.backend,
              recorded.sessionId,
              prepare,
              { signal: opts.signal, label: opts.label },
            );
            session = reattached.handle;
            continuationMethod = reattached.method;
            // Provenance is committed at the reopen-handle boundary, before any post-open setup.
            reportContinuation({ reattached: true, method: reattached.method });
            continuationUsageBaseline = session.usage.baseline();
          } catch (error) {
            if (opts.signal?.aborted) throw error;
            skipReason = error instanceof ReattachCapabilityUnavailable
              ? "capability-missing"
              : "reattach-failed";
          }
        }

        if (skipReason) {
          await cleanupFailedAcquisition();
          // An abort that landed during acquire/cleanup wins before skip provenance is reported.
          opts.signal?.throwIfAborted();
          reportContinuation({ reattached: false, reason: skipReason });
          // Mandated checked boundary immediately before the fresh acquire loop.
          opts.signal?.throwIfAborted();
        }
      }

      // Inline resolve-and-retry-once (§2.11): when `onAuth` is set, a -32000 at session/new is
      // resolved via the resolver and the acquire retried EXACTLY once — the run never pauses. A
      // second -32000 propagates as AUTH_REQUIRED. When `onAuth` is unset this loop runs once and
      // the error propagates unchanged (the PR4 pause-and-resume path), byte-identical to today.
      if (!session) {
        let authRetried = false;
        for (;;) {
          try {
            session = await this.pool.acquirePrepared(prepared.backend, prepare, {
              signal: opts.signal,
              label: opts.label,
            });
            break;
          } catch (error) {
            if (this.onAuth && !authRetried && !opts.signal?.aborted && isAuthRequiredError(error)) {
              authRetried = true;
              // Discard the failed attempt's partial structured-tool registration so the retry's
              // prepare re-registers cleanly (the failure happened at session/new, after prepare ran).
              await cleanupFailedAcquisition();
              const resolved = await this.resolveInlineAuth(prepared.backend, opts, error);
              if (!resolved) throw error; // cancelled/unresolved -> propagate AUTH_REQUIRED
              continue;
            }
            throw error;
          }
        }
      }
      const activeSession = session;
      opts.signal?.throwIfAborted();
      // Hand the host the re-attach identity BEFORE any turn runs: the session id plus the
      // agent-advertised reopen surface (session/load|resume|list). Best-effort observer —
      // a throwing host callback never fails the run.
      if (opts.onSessionOpen) {
        try {
          opts.onSessionOpen(sessionRefFor(activeSession, prepared.backend, cwd));
        } catch {
          // observer only; the run result never depends on it.
        }
      }
      // A registered first segment is routing only. Everything after it is sent verbatim;
      // an unregistered first segment leaves the entire authored string intact for the default.
      await applyModelSelection(activeSession, prepared.modelSpec, opts);
      opts.signal?.throwIfAborted();
      await activeSession.setConfigOptions(opts.configOptions);
      opts.signal?.throwIfAborted();
      if (opts.mode) await activeSession.setMode(opts.mode);

      const text = buildRunPrompt(
        continuationMethod ? CONTINUATION_INSTRUCTION : prompt,
        opts,
        schema,
        prepared.backend,
        structuredToolActive,
      );
      const initialPrompt = continuationMethod
        ? text
        : opts.images && opts.images.length > 0
          ? promptWithImages(text, opts.images)
          : text;
      // Generic turn-scoped _meta passthrough merged UNDER the backend-computed keys (e.g. the
      // outputSchema forward when a schema is set) — user meta never clobbers the schema channel.
      const promptMeta = mergeTurnMeta(opts.promptMeta, prepared.backend.promptMeta(schema));
      const response = await activeSession.prompt(initialPrompt, promptMeta);
      opts.signal?.throwIfAborted();
      // Inspect the turn's stop reason BEFORE the text/schema path: a refusal or truncation
      // must surface distinctly here, never be misread as empty output or burned through the
      // schema-repair ladder into SCHEMA_NONCOMPLIANCE.
      assertNormalStopReason(response.stopReason, opts.label);

      if (schema) {
        const structuredSession: StructuredSession = {
          prompt: async (repromptText: string) => {
            const repromptResponse = await activeSession.prompt(repromptText, promptMeta);
            // A repair turn that refuses / truncates / cancels must also surface distinctly
            // instead of silently continuing the ladder.
            assertNormalStopReason(repromptResponse.stopReason, opts.label);
          },
          // Final message only, matching nativeStructured: prose extraction over the whole turn
          // would resurrect the first-JSON-wins bug for schema-shaped progress messages.
          lastText: () => activeSession.finalMessageText(),
          tryCaptured: structuredTool ? () => structuredTool?.tryCaptured() : undefined,
          tryNative: () => prepared.backend.nativeStructured(activeSession),
        };
        const result = await resolveStructuredOutput(structuredSession, schema, {
          maxSchemaRetries: opts.maxSchemaRetries,
          signal: opts.signal,
          label: opts.label,
          ...(structuredToolActive ? { repromptText: STRUCTURED_TOOL_REPROMPT_TEXT } : {}),
        });
        return result as AgentResult<S>;
      }

      const finalText = activeSession.currentTurnText().trim();
      if (!finalText) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: opts.label,
        });
      }
      return finalText as unknown as AgentResult<S>;
    } catch (error) {
      // Abort is the engine's concern (throwIfAborted before/after the call) — re-throw it raw.
      if (opts.signal?.aborted) throw error;
      const mapped = mapThrownError(error, {
        label: opts.label,
        backendId: prepared.backend.id,
        backend: prepared.backend,
        providerErrorMetadata: session?.providerErrorMetadata,
        authMethods: session?.capabilities?.authMethods,
      });
      if (isProviderUsageLimitError(mapped) || isAuthRequiredError(mapped)) keepOpenOnRelease = true;
      throw mapped;
    } finally {
      try {
        try {
          structuredTool?.release();
        } catch {
          // best-effort tool cleanup; never mask the run result, error, or caller cancellation.
        }
        if (session) {
          // Read real usage on BOTH success and error so partial usage is never lost.
          try {
            opts.onUsage?.(
              continuationUsageBaseline
                ? session.usage.delta(continuationUsageBaseline)
                : session.usage.toAgentUsage(),
            );
          } catch {
            // usage is best-effort; never let it mask the real result/error.
          }
          try {
            opts.onHistory?.(session.history);
          } catch {
            // history is diagnostic only.
          }
          // Release the SESSION (best-effort session/close) WITHOUT killing the pooled process.
          // keepSession skips the close so the agent-persisted session stays re-openable.
          try {
            await session.release({ keepOpen: keepOpenOnRelease });
          } catch {
            // release is best-effort (session already untracked); never mask the real result/error.
          }
        }
      } finally {
        // The injected-tool turn spans the WHOLE run incl. session close, so the next queued
        // schema run's session/new (same-name registry replacement) never overlaps this one.
        try {
          releaseStructuredToolTurn?.();
        } catch {
          // best-effort turn release; never mask the run outcome.
        }
      }
    }
  }

  /** Tear down the whole pool (close every long-lived process). Call when the run ends / the
   *  runner is disposed. Beyond the AgentRunner seam (additive) — never enters the resume hash. */
  /** Await the connection's current injected-run chain and append this run's turn. The
   *  returned release MUST be called (run finally) or the connection's schema runs starve. */
  private async acquireStructuredToolTurn(connection: object): Promise<() => void> {
    const previous = this.structuredToolTurns.get(connection) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.structuredToolTurns.set(connection, previous.then(() => turn));
    await previous;
    return release;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.removeExitHook();
    const sessions = [...this.interactiveSessions.keys()];
    await Promise.all(sessions.map((session) => session.release()));
    try {
      await this.pool.dispose();
    } finally {
      await this.structuredOutputTools.dispose();
    }
    this.events.removeAllListeners();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private async createInteractiveSession(
    opts: InteractiveAssemblyOptions,
    methodName: "openSession" | "loadSession" | "forkSession" | "resumeSession",
    open: (connection: PooledConnection, prepared: PreparedSession) => Promise<SessionHandle>,
  ): Promise<InteractiveSession> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    assertNoModelConfigOption(opts.configOptions, opts.label);
    validateInteractiveCwd(opts.cwd, opts.label, methodName);
    opts.signal?.throwIfAborted();

    const prepared = this.prepareSession(opts, {
      cwd: opts.cwd,
      schema: undefined,
      registry: this.backends,
      permissionResolver: opts.permissionResolver ?? opts.onPermissionRequest,
      elicitationResolver: opts.onElicitation,
      retainSessionLog: opts.retainSessionLog ?? false,
    });
    this.installExitHook();
    let interactive: InteractiveSession | undefined;
    const connection = this.createDedicatedConnection(prepared.backend, () => {
      // Dedicated connections are not stored in pool arrays, so there is nothing to evict.
      // Once the public wrapper exists, process death releases it through the normal path:
      // subscriptions are removed, session_close is emitted, and future prompt() calls fail
      // with the clean released-session error. Before then, this method's catch tears down.
      void interactive?.release();
    });
    let session: SessionHandle | undefined;
    try {
      session = await open(connection, prepared);
      opts.signal?.throwIfAborted();
      await applyModelSelection(session, prepared.modelSpec, opts);
      opts.signal?.throwIfAborted();
      await session.setConfigOptions(opts.configOptions);
      opts.signal?.throwIfAborted();
      if (opts.mode) await session.setMode(opts.mode);
      opts.signal?.throwIfAborted();
      if (this.disposed) throw new Error("ACP agent runner is disposed");

      interactive = new InteractiveSession({
        session,
        connection,
        backend: prepared.backend,
        subscribe: (name, listener) => this.events.on(name, listener),
        onRelease: (self) => this.interactiveSessions.delete(self),
        signal: opts.signal,
        label: opts.label,
        cwd: opts.cwd,
        keepSession: opts.keepSession === true,
      });
      this.interactiveSessions.set(interactive, connection);
      return interactive;
    } catch (error) {
      try {
        await session?.release();
      } catch {
        // best-effort: lifecycle setup failed, so teardown must never mask the real error.
      }
      await disposeBestEffort(connection);
      if (opts.signal?.aborted) throw error;
      throw mapThrownError(error, {
        label: opts.label,
        backendId: prepared.backend.id,
        backend: prepared.backend,
        providerErrorMetadata: session?.providerErrorMetadata,
        authMethods: connection.capabilities?.authMethods,
      });
    }
  }

  private createDedicatedConnection(backend: Backend, onDead: () => void): PooledConnection {
    return PooledConnection.create(backend, {
      onDead,
      onEvent: this.emitEvent,
      permissionResolver: this.permissionResolver,
      elicitationResolver: this.elicitationResolver,
      advertiseElicitation: Boolean(this.elicitationResolver),
      authCapabilities: this.authCapabilities,
      // Same stores as the pool: a dedicated connection re-primes the durable auth intent AND the
      // recorded provider routing at its own initialize (§2.5) — the direct fix for the
      // dispose-after-authenticate bug (gap 3) and its providers/* sibling.
      authStore: this.authStore,
      providerStore: this.providerStore,
      clientHandlers: this.clientHandlers,
    });
  }

  /** Read the selected backend's initialize-advertised auth methods on a dedicated connection and
   *  build their type-dispatched descriptors (§1.3). A read-only probe; the connection is disposed. */
  private async probeAuthMethods(
    backend: Backend,
  ): Promise<{ methods: AuthMethod[]; descriptors: AuthMethodDescriptor[] }> {
    const connection = this.createDedicatedConnection(backend, () => undefined);
    try {
      const methods = await connection.authMethods();
      return { methods, descriptors: describeMethods(methods, backend) };
    } finally {
      await disposeBestEffort(connection);
    }
  }

  /** The shared write path (§2.9) behind completeAuth, the inline resolver (§2.11), and the rebuilt
   *  legacy authenticate(). Records the payload/methodType from the outcome but DERIVES `klass` from
   *  the chosen method's type + `_meta` shape (§2.1) — never from the resolution outcome. */
  private async applyResolution(
    backend: Backend,
    resolution: AuthResolution,
    advertised: readonly AuthMethod[],
    methodIdHint: string | undefined,
    label: string | undefined,
  ): Promise<AuthOutcome> {
    const poolKey = backend.poolKey ?? backend.id;
    const machine = this.authStore.machineFor(poolKey, backend.authProfile);

    if (resolution.outcome === "cancelled") {
      return { status: "cancelled", methodId: methodIdHint ?? "", recycled: false };
    }

    const methodId = resolutionMethodId(resolution) ?? methodIdHint ?? inferMethodId(resolution, advertised);
    if (!methodId) {
      throw new WorkflowError(
        "completeAuth requires a methodId to record the resolution",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    }
    const chosen = advertised.find((m) => m.id === methodId);
    const methodType: AuthMethodType = chosen ? authMethodType(chosen) : resolution.outcome === "env" ? "env_var" : "agent";
    const advertisedMeta = chosen ? authMethodMeta(chosen) : undefined;

    if (resolution.outcome === "agent-login") {
      // The sole path from which the bare-`agent` login RPC ever fires (§2.9 step 3): the agent runs
      // its own login on a live connection and persists to its native store, so every subsequent
      // fresh initialize re-reads it and needs no replay.
      const connection = this.createDedicatedConnection(backend, () => undefined);
      try {
        await connection.authenticate({ methodId }, label);
      } catch (error) {
        throw mapThrownError(error, { label, backendId: backend.id, backend, authMethods: [...advertised] });
      } finally {
        await disposeBestEffort(connection);
      }
      const intent: AuthIntent = { backendId: backend.id, poolKey, methodId, methodType, klass: "disk", diskBacked: true };
      machine.send({ t: "host_authenticate", intent });
      machine.send({ t: "apply_ok", connectionId: "host", generation: machine.generation });
      this.pool.recycle(poolKey);
      return { status: "authenticated", methodId, recycled: true };
    }

    // meta / env / completed: derive klass from the chosen advertised method (§2.1), never the outcome.
    const { klass, diskBacked } = classifyCredential(methodType, advertisedMeta);
    // A `meta` payload passes through the backend's pure-data `AuthProfile.buildMeta` (§3.1) so the
    // agent's expected authenticate `_meta` shape is honored; a custom backend (no profile), or one
    // whose advertised method could not be matched, records the host-supplied `meta` verbatim
    // (conformance-by-absence). buildMeta is SECRET-preserving — it only reshapes the payload, never
    // logs it (§2.14/Principle 9).
    let authenticateMeta: Record<string, unknown> | undefined;
    if (resolution.outcome === "meta") {
      const buildMeta = backend.authProfile?.buildMeta;
      authenticateMeta = buildMeta && chosen ? buildMeta(chosen, resolution) : resolution.meta;
    }
    const envValues = resolution.outcome === "env" ? resolution.values : undefined;
    const intent: AuthIntent = {
      backendId: backend.id,
      poolKey,
      methodId,
      methodType,
      klass,
      diskBacked,
      ...(authenticateMeta ? { authenticateMeta } : {}),
      ...(envValues ? { envValues } : {}),
    };
    machine.send({ t: "host_authenticate", intent });
    this.pool.recycle(poolKey);
    return { status: "authenticated", methodId, recycled: true };
  }

  /** Inline resolve-and-retry-once at the run() session-acquisition seam (§2.11). Builds the
   *  AuthContext from the backend's advertised methods, invokes `onAuth`, and applies the result.
   *  Returns false on a cancelled/absent resolution (the caller propagates AUTH_REQUIRED). */
  private async resolveInlineAuth(backend: Backend, opts: AnyRunOptions, error: unknown): Promise<boolean> {
    const { methods, descriptors } = await this.probeAuthMethods(backend);
    // Mark the machine's authenticated->auth_required transition on the protocol signal (§2.3).
    this.authStore
      .machineFor(backend.poolKey ?? backend.id, backend.authProfile)
      .send({ t: "auth_required_tripped", connectionId: "run", error });
    const ctx: AuthContext = {
      backendId: backend.id,
      ...(opts.label ? { label: opts.label } : {}),
      methods: descriptors,
      cause: "required",
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const resolution = await this.onAuth!(ctx);
    if (resolution.outcome === "cancelled") return false;
    await this.applyResolution(backend, resolution, methods, undefined, opts.label);
    return true;
  }

  /** Redacted status snapshots (§2.10/§4.1). Enumerates every configured backend when `backend` is
   *  omitted; never exposes secrets. */
  private authStatus(opts?: { backend?: string }): AuthStatusSnapshot[] {
    const ids = opts?.backend ? [opts.backend] : this.listBackends();
    return ids.map((id) => this.snapshotFor(id));
  }

  private snapshotFor(backendId: string): AuthStatusSnapshot {
    const backend = selectBackend({ model: backendId }, this.backends);
    const poolKey = backend.poolKey ?? backend.id;
    const machine = this.authStore.existing(poolKey);
    const state: BackendAuthState = machine?.state ?? "unauthenticated";
    return {
      backendId: backend.id,
      poolKey,
      state,
      authenticated: state === "authenticated",
      canResume: machine?.canResume() ?? false,
      methods: (machine?.advertised ?? []).map((m) => ({
        id: m.id,
        type: authMethodType(m),
        ...(m.name ? { name: m.name } : {}),
      })),
    };
  }

  /** Cold-resume re-arm predicate (§2.13). */
  canResume(backendId: string): boolean {
    const backend = selectBackend({ model: backendId }, this.backends);
    return this.authStore.existing(backend.poolKey ?? backend.id)?.canResume() ?? false;
  }

  /** Build the backend choice, model-selection spec, tool policy, and session/new options in one
   *  place for run() and openSession() so new AcpSessionOptions fields cannot drift by path. */
  private prepareSession(opts: SessionPreparationOptions, config: SessionPreparationConfig): PreparedSession {
    const route = resolveModelRoute(opts.model ?? opts.tier, config.registry);
    const backend = route.backend;
    const hasPermissionResolver = Boolean(config.permissionResolver ?? this.permissionResolver);
    const policy: ToolPolicy = {
      allow: opts.toolNames,
      deny: opts.disallowedToolNames,
      defaultOutcome: opts.mode && !hasPermissionResolver ? "deny" : undefined,
    };
    return {
      backend,
      modelSpec: route.modelSpec,
      sessionOptions: {
        cwd: config.cwd,
        schema: config.schema,
        policy,
        permissionResolver: config.permissionResolver,
        elicitationResolver: config.elicitationResolver,
        signal: config.signal,
        mcpServers: opts.mcpServers,
        // Generic session-scoped _meta passthrough (RunOptions.meta) — merged UNDER the
        // backend-computed keys and the runId stamp in openSession. Additive; never hashed.
        meta: opts.meta,
        // Engine correlation id -> session/new _meta (META_KEYS.runId). Additive; never hashed.
        runId: opts.runId,
        // Stamped onto emitted ACP events as context (never sent on the wire).
        label: opts.label,
        // Direct engine-call correlation on emitted events only; never sent on the ACP wire.
        callIndex: opts.callIndex,
        // CODEX-ONLY session instruction overrides -> session/new _meta bare keys. Additive;
        // never hashed. The Claude backend ignores them.
        baseInstructions: opts.baseInstructions,
        developerInstructions: opts.developerInstructions,
        retainSessionLog: config.retainSessionLog,
      },
    };
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.once("exit", this.onProcessExit);
  }

  private removeExitHook(): void {
    if (!this.exitHookInstalled) return;
    this.exitHookInstalled = false;
    process.removeListener("exit", this.onProcessExit);
  }

  /** Synchronous best-effort child kill for the process-exit hook (no async work is possible). */
  private killAllSync(): void {
    for (const connection of this.interactiveSessions.values()) connection.killNow();
  }
}

/** Factory the mcp-server composition root calls to inject the runner into the engine. The pool
 *  size and the custom-backend registry are runner-level options — NOT RunOptions fields, so they
 *  never enter hashAgentCall / the resume identity. Env fallbacks: AGENTPRISM_ACP_POOL_SIZE for
 *  size, AGENTPRISM_BACKENDS (JSON) for backends. */
export function createAcpRunner(options?: AcpRunnerOptions): AcpAgentRunner {
  return new AcpAgentRunner(options);
}

/**
 * Map a PromptResponse.stopReason onto the seam's error contract. `end_turn` (and any
 * unknown future reason) is a normal completion — fall through to the text/schema path.
 * The abnormal reasons each get a DISTINCT, non-recoverable failure so the engine never
 * retries a refused/truncated prompt (burning the retry budget) and never mistakes it for
 * recoverable empty output:
 *   - refusal             -> AGENT_EXECUTION_ERROR "model refused to respond"
 *   - max_tokens / max_turn_requests -> AGENT_EXECUTION_ERROR "output truncated"
 *   - cancelled           -> WORKFLOW_ABORTED
 */
function assertNormalStopReason(stopReason: StopReason, label?: string): void {
  switch (stopReason) {
    case "refusal":
      throw new WorkflowError("model refused to respond", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
        recoverable: false,
        agentLabel: label,
      });
    case "max_tokens":
    case "max_turn_requests":
      throw new WorkflowError(
        `output truncated (stop reason: ${stopReason})`,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    case "cancelled":
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
        recoverable: false,
        agentLabel: label,
      });
    default:
      // "end_turn" and any unrecognized future reason: normal completion.
      return;
  }
}

function shouldInjectStructuredOutputTool(
  schema: TSchema | undefined,
  backend: Backend,
  capabilities: PooledConnection["capabilities"],
): schema is TSchema {
  return Boolean(schema && backend.injectStructuredOutputTool && supportsStructuredOutputToolTransport(capabilities));
}

function supportsStructuredOutputToolTransport(capabilities: PooledConnection["capabilities"]): boolean {
  return capabilities?.agent.mcpCapabilities?.http === true;
}

function availableMcpServerName(base: string, servers: AnyRunOptions["mcpServers"] | undefined): string {
  const used = new Set((servers ?? []).map((server) => server.name));
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function applyModelSelection(
  session: SessionHandle,
  spec: string | undefined,
  opts: { onModelResolved?: (modelId: string) => void },
): Promise<void> {
  if (spec === undefined) return;
  await session.selectModel(spec);
  opts.onModelResolved?.(spec);
}

function assertNoModelConfigOption(
  configOptions: Record<string, string | boolean> | undefined,
  label: string | undefined,
): void {
  if (!configOptions || !("model" in configOptions)) return;
  throw new WorkflowError(
    `Agent call${label ? ` "${label}"` : ""} configOptions must not contain reserved option id "model"; use the model field instead`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label },
  );
}

/** Pick the backend for the effective model spec (`model` wins over `tier`). The first segment
 *  routes only when it is a registered custom or built-in harness name; everything else goes to
 *  the configured default backend without interpretation. */
export function selectBackend(opts: { model?: string; tier?: string }, registry?: BackendRegistry): Backend {
  return resolveModelRoute(opts.model ?? opts.tier, registry).backend;
}

function builtinBackend(id: BuiltinBackendId): Backend {
  switch (id) {
    case "claude":
      return new ClaudeBackend();
    case "codex":
      return new CodexBackend();
    case "opencode":
      return new OpenCodeBackend();
  }
}

interface ModelRoute {
  backend: Backend;
  modelSpec: string | undefined;
}

/** Resolve routing and the verbatim model value together so backend choice and prefix stripping
 *  cannot drift. A registered custom name has priority over a built-in on collision. */
function resolveModelRoute(spec: string | undefined, registry?: BackendRegistry): ModelRoute {
  if (spec === undefined) return { backend: defaultBackend(registry), modelSpec: undefined };

  const slash = spec.indexOf("/");
  const firstSegment = asciiLowercase(slash >= 0 ? spec.slice(0, slash) : spec);
  const inner = slash >= 0 ? spec.slice(slash + 1) : undefined;
  const custom = registry?.get(firstSegment);
  if (custom) return { backend: new CustomAcpBackend(custom), modelSpec: inner };

  if (firstSegment === "claude" || firstSegment === "codex" || firstSegment === "opencode") {
    return { backend: builtinBackend(firstSegment), modelSpec: inner };
  }

  return { backend: defaultBackend(registry), modelSpec: spec };
}

/** The re-attach handle for an open session: id + backend routing name + cwd + the
 *  agent-advertised reopen surface. Contains no secrets; JSON-round-trippable. `backendId`
 *  doubles as the `model` routing spec for loadSession/resumeSession/listSessions. */
function sessionRefFor(session: SessionHandle, backend: Backend, cwd: string): AgentSessionRef {
  const caps = session.capabilities;
  return {
    sessionId: session.sessionId,
    backendId: backend.id,
    poolKey: backend.poolKey ?? backend.id,
    cwd,
    reopen: {
      load: caps?.supportsLoadSession === true,
      resume: caps?.supportsResumeSession === true,
      list: caps?.supportsListSessions === true,
      fork: caps?.supportsForkSession === true,
    },
  };
}

/** Interactive sessions are public and long-lived, so fail before spawning a dedicated process
 *  when the required worktree root is absent or not absolute. */
function validateInteractiveCwd(cwd: string, label: string | undefined, methodName: string): void {
  if (typeof cwd !== "string" || cwd.trim() === "" || !isAbsolute(cwd)) {
    throw new WorkflowError(
      `${methodName} requires cwd to be a non-empty absolute path`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false, agentLabel: label },
    );
  }
}

function validateOptionalLifecycleCwd(cwd: string | undefined, label: string | undefined, methodName: string): void {
  if (cwd === undefined || cwd === null) return;
  validateInteractiveCwd(cwd, label, methodName);
}

function validateLifecycleSessionId(sessionId: string, label: string | undefined, methodName: string): void {
  validateRequiredString(sessionId, label, methodName, "sessionId");
}

function validateRequiredString(
  value: string,
  label: string | undefined,
  methodName: string,
  fieldName: string,
): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowError(
      `${methodName} requires ${fieldName} to be a non-empty string`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false, agentLabel: label },
    );
  }
}

/** The mapped run error is a WorkflowError; the auth-required classification already ran in the
 *  pool via mapThrownError (§1.5), so the inline seam keys on the code, not the raw -32000. */
function isAuthRequiredError(error: unknown): boolean {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.AUTH_REQUIRED;
}

function isProviderUsageLimitError(error: unknown): boolean {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
}

/** The SDK types a missing `type` discriminant as `agent`. */
/** Dispatch each advertised method through the base §1.3 dispatcher, then hand the result to the
 *  backend's pure-data `AuthProfile.describe` (§3.1) for label enrichment. A custom backend has NO
 *  profile, so the base descriptor is returned verbatim (conformance-by-absence, §3.5). The profile
 *  may only relabel; it never changes the `type` discriminant the base dispatcher chose (§3.1). */
function describeMethods(methods: readonly AuthMethod[], backend: Backend): AuthMethodDescriptor[] {
  const spawn = backend.spawnConfig();
  const profile = backend.authProfile;
  return methods.map((method) => {
    const base = buildAuthDescriptor(method, spawn);
    return profile ? profile.describe(method, base) : base;
  });
}

function authMethodType(method: AuthMethod): AuthMethodType {
  return (("type" in method ? method.type : undefined) ?? "agent") as AuthMethodType;
}

/** The advertised method's `_meta`, or undefined. This is agent-PUBLISHED metadata (e.g.
 *  `gateway.protocol`), never a credential — the credential is only the resolver's payload. */
function authMethodMeta(method: AuthMethod): Record<string, unknown> | undefined {
  const meta = (method as { _meta?: Record<string, unknown> | null })._meta;
  return meta ?? undefined;
}

/** A resolution that names its own method (meta / agent-login), else undefined. */
function resolutionMethodId(resolution: AuthResolution): string | undefined {
  if (resolution.outcome === "meta" || resolution.outcome === "agent-login") return resolution.methodId;
  if (resolution.outcome === "env" || resolution.outcome === "completed") return resolution.methodId;
  return undefined;
}

/** Infer the target method for an env/completed resolution that did not name one: match by outcome
 *  against the advertised methods (there is typically exactly one env_var / terminal method). */
function inferMethodId(resolution: AuthResolution, advertised: readonly AuthMethod[]): string | undefined {
  if (resolution.outcome === "env") {
    return advertised.find((m) => authMethodType(m) === "env_var")?.id ?? advertised.find((m) => authMethodType(m) === "agent")?.id;
  }
  if (resolution.outcome === "completed") {
    return (
      advertised.find((m) => authMethodType(m) === "terminal")?.id ??
      advertised.find((m) => authMethodType(m) === "agent")?.id ??
      advertised[0]?.id
    );
  }
  return undefined;
}

async function disposeBestEffort(connection: PooledConnection): Promise<void> {
  try {
    await connection.dispose();
  } catch {
    // Dedicated lifecycle processes are already no longer useful; never mask the request result.
  }
}

/** Resolve the default backend: a registered custom name wins (returned as a Backend), else
 *  the built-in id. An unknown/unset value falls back to "claude" (the historical default). */
function defaultBackend(registry?: BackendRegistry): Backend {
  const configured = process.env.AGENTPRISM_DEFAULT_BACKEND;
  const name = configured === undefined ? undefined : asciiLowercase(configured);
  if (name && registry) {
    const config = registry.get(name);
    if (config) return new CustomAcpBackend(config);
  }
  if (name === "opencode" || name === "codex") return builtinBackend(name);
  return builtinBackend("claude");
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}
