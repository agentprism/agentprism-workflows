// AcpAgentRunner — the AgentRunner seam implementation (the LEAF the engine injects against).
// One method, two backend strategies behind it. Per run():
//   1. pick the backend by model/tier (cross-provider routing = which ACP server to spawn)
//   2. ACQUIRE a pooled connection + session/new { cwd } (per-session cwd = worktree isolation;
//      the PROCESS is pool-managed and REUSED across runs — never spawned/killed per run)
//   3. select the model via session/set_config_option (onModelResolved / onModelFallback)
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
  WorkflowError,
  WorkflowErrorCode,
  type AgentResult,
  type AgentRunner,
  type RunOptions,
} from "@automatalabs/shared-types";
import type {
  DeleteSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { TSchema } from "typebox";
import { PooledConnection, type AcpSessionOptions, type SessionHandle } from "./acp-client.js";
import { AcpAgentPool, type AcpPoolOptions } from "./pool.js";
import {
  TypedEventEmitter,
  type AcpEventListener,
  type AcpEventName,
  type AcpEventSink,
  type AcpRunnerEventMap,
} from "./events.js";
import type { Backend } from "./backend.js";
import { InteractiveSession, type InteractiveSessionOptions } from "./interactive.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { CustomAcpBackend } from "./backends/custom.js";
import {
  registryWithRunBackends,
  resolveBackendRegistry,
  type BackendRegistry,
  type CustomBackendConfig,
} from "./registry.js";
import { mapThrownError } from "./errors-map.js";
import type { PermissionResolver, ToolPolicy } from "./permissions.js";
import { resolveStructuredOutput, type StructuredSession } from "./structured-output.js";
import {
  buildRunPrompt,
  mergeTurnMeta,
  promptWithImages,
  validatePromptImages,
} from "./prompt.js";
import type { ClientHandlers } from "./client-handlers.js";

type AnyRunOptions = RunOptions<TSchema | undefined>;

interface SessionPreparationOptions {
  model?: string;
  mode?: string;
  tier?: string;
  toolNames?: string[];
  disallowedToolNames?: string[];
  mcpServers?: AnyRunOptions["mcpServers"];
  meta?: Record<string, unknown>;
  runId?: string;
  label?: string;
  baseInstructions?: string;
  developerInstructions?: string;
}

interface SessionPreparationConfig {
  cwd: string;
  schema: TSchema | undefined;
  registry: BackendRegistry;
  signal?: AbortSignal;
  permissionResolver?: PermissionResolver;
  retainSessionLog?: boolean;
}

interface PreparedSession {
  backend: Backend;
  modelSpec: string | undefined;
  sessionOptions: AcpSessionOptions;
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

/** Options for AcpAgentRunner.loadSession() and resumeSession(). */
export interface ReattachSessionOptions extends InteractiveSessionOptions {
  /** Existing backend session id to route before the lifecycle request is sent. */
  sessionId: string;
  /** Alias for onPermissionRequest for hosts that name the resolver by role. */
  permissionResolver?: PermissionResolver;
}

type InteractiveAssemblyOptions = InteractiveSessionOptions & {
  readonly permissionResolver?: PermissionResolver;
};

/** Constructor options for the runner: pool sizing, client-side handlers, and the custom-backend
 *  registry. `backends` merges over (and wins against) env-declared AGENTPRISM_BACKENDS entries. */
export interface AcpRunnerOptions extends AcpPoolOptions {
  /** Custom ACP backends, keyed by registered name (see registry.ts for the config shape
   *  and the routing rules). Names are case-insensitive; "claude"/"codex" are reserved. */
  backends?: Record<string, CustomBackendConfig>;
  /** Runner-wide human-in-the-loop permission resolver. When set, it replaces ToolPolicy
   *  auto-decisions for every session that does not provide its own resolver. */
  onPermissionRequest?: PermissionResolver;
}

export class AcpAgentRunner implements AgentRunner {
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
    this.pool = new AcpAgentPool(options, {
      onEvent: this.emitEvent,
      permissionResolver: options.onPermissionRequest,
    });
    this.backends = resolveBackendRegistry(options.backends);
  }

  /**
   * Listen in on the live ACP stream. `name` is an ACP `sessionUpdate` discriminant
   * ("agent_message_chunk", "tool_call", "usage_update", …) or one of the cross-cutting events
   * ("session_update" catch-all, "permission_pending", "permission_request", "raw_message",
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
    const schema = opts.schema;
    // Layer any run-scoped backends (an APPROVED script-declared meta.backends) under the
    // host registry. Malformed/reserved entries fail the call loudly and are NOT retried —
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
    const session: SessionHandle = await this.pool.acquire(prepared.backend, prepared.sessionOptions);
    try {
      opts.signal?.throwIfAborted();
      // For a CUSTOM backend chosen by its registered name, the name itself is routing, not a
      // model id: "browser" selects nothing; "browser/foo" selects "foo". Built-ins get the
      // full spec unchanged (their catalogs match provider-prefixed and bare ids).
      await applyModelSelection(session, prepared.modelSpec, opts);
      opts.signal?.throwIfAborted();
      if (opts.mode) await session.setMode(opts.mode);

      const text = buildRunPrompt(prompt, opts, schema, prepared.backend);
      const initialPrompt =
        opts.images && opts.images.length > 0 ? promptWithImages(text, opts.images) : text;
      // Generic turn-scoped _meta passthrough merged UNDER the backend-computed keys (e.g. the
      // outputSchema forward when a schema is set) — user meta never clobbers the schema channel.
      const promptMeta = mergeTurnMeta(opts.promptMeta, prepared.backend.promptMeta(schema));
      const response = await session.prompt(initialPrompt, promptMeta);
      opts.signal?.throwIfAborted();
      // Inspect the turn's stop reason BEFORE the text/schema path: a refusal or truncation
      // must surface distinctly here, never be misread as empty output or burned through the
      // schema-repair ladder into SCHEMA_NONCOMPLIANCE.
      assertNormalStopReason(response.stopReason, opts.label);

      if (schema) {
        const structuredSession: StructuredSession = {
          prompt: async (repromptText: string) => {
            const repromptResponse = await session.prompt(repromptText, promptMeta);
            // A repair turn that refuses / truncates / cancels must also surface distinctly
            // instead of silently continuing the ladder.
            assertNormalStopReason(repromptResponse.stopReason, opts.label);
          },
          lastText: () => session.currentTurnText(),
          tryNative: () => prepared.backend.nativeStructured(session),
        };
        const result = await resolveStructuredOutput(structuredSession, schema, {
          maxSchemaRetries: opts.maxSchemaRetries,
          signal: opts.signal,
          label: opts.label,
        });
        return result as AgentResult<S>;
      }

      const finalText = session.currentTurnText().trim();
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
      throw mapThrownError(error, opts.label);
    } finally {
      // Read real usage on BOTH success and error so partial usage is never lost.
      try {
        opts.onUsage?.(session.usage.toAgentUsage());
      } catch {
        // usage is best-effort; never let it mask the real result/error.
      }
      try {
        opts.onHistory?.(session.history);
      } catch {
        // history is diagnostic only.
      }
      // Release the SESSION (best-effort session/close) WITHOUT killing the pooled process.
      try {
        await session.release();
      } catch {
        // release is best-effort (session already untracked); never mask the real result/error.
      }
    }
  }

  /** Tear down the whole pool (close every long-lived process). Call when the run ends / the
   *  runner is disposed. Beyond the AgentRunner seam (additive) — never enters the resume hash. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.removeExitHook();
    const sessions = [...this.interactiveSessions.keys()];
    await Promise.all(sessions.map((session) => session.release()));
    await this.pool.dispose();
    this.events.removeAllListeners();
  }

  private async createInteractiveSession(
    opts: InteractiveAssemblyOptions,
    methodName: "openSession" | "loadSession" | "resumeSession",
    open: (connection: PooledConnection, prepared: PreparedSession) => Promise<SessionHandle>,
  ): Promise<InteractiveSession> {
    if (this.disposed) throw new Error("ACP agent runner is disposed");
    validateInteractiveCwd(opts.cwd, opts.label, methodName);
    opts.signal?.throwIfAborted();

    const prepared = this.prepareSession(opts, {
      cwd: opts.cwd,
      schema: undefined,
      registry: this.backends,
      permissionResolver: opts.permissionResolver ?? opts.onPermissionRequest,
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
      throw error;
    }
  }

  private createDedicatedConnection(backend: Backend, onDead: () => void): PooledConnection {
    return PooledConnection.create(backend, {
      onDead,
      onEvent: this.emitEvent,
      permissionResolver: this.permissionResolver,
      clientHandlers: this.clientHandlers,
    });
  }

  /** Build the backend choice, model-selection spec, tool policy, and session/new options in one
   *  place for run() and openSession() so new AcpSessionOptions fields cannot drift by path. */
  private prepareSession(opts: SessionPreparationOptions, config: SessionPreparationConfig): PreparedSession {
    const backend = selectBackend(opts, config.registry);
    const hasPermissionResolver = Boolean(config.permissionResolver ?? this.permissionResolver);
    const policy: ToolPolicy = {
      allow: opts.toolNames,
      deny: opts.disallowedToolNames,
      defaultOutcome: opts.mode && !hasPermissionResolver ? "deny" : undefined,
    };
    return {
      backend,
      modelSpec: innerModelSpec(opts.model ?? opts.tier, backend),
      sessionOptions: {
        cwd: config.cwd,
        schema: config.schema,
        policy,
        permissionResolver: config.permissionResolver,
        signal: config.signal,
        mcpServers: opts.mcpServers,
        // Generic session-scoped _meta passthrough (RunOptions.meta) — merged UNDER the
        // backend-computed keys and the runId stamp in openSession. Additive; never hashed.
        meta: opts.meta,
        // Engine correlation id -> session/new _meta (META_KEYS.runId). Additive; never hashed.
        runId: opts.runId,
        // Stamped onto emitted ACP events as context (never sent on the wire).
        label: opts.label,
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

async function applyModelSelection(
  session: SessionHandle,
  spec: string | undefined,
  opts: { onModelResolved?: (modelId: string) => void; onModelFallback?: (requestedSpec: string) => void },
): Promise<void> {
  // `spec` is opts.model ?? opts.tier (`model` wins — frozen contract), with a custom
  // backend's routing name already stripped by innerModelSpec.
  if (!spec) return;
  const { matched, resolved, modifierFallbacks } = await session.selectModel(spec);
  if (matched) opts.onModelResolved?.(resolved ?? spec);
  else opts.onModelFallback?.(spec);
  // Symmetric to model fallback: a requested reasoning_effort / Fast-mode value the catalog
  // does not advertise is a silent no-op in the session. Surface it on the SAME channel so
  // incorrect tiering is observable (best-effort — reported, never thrown).
  for (const fallback of modifierFallbacks ?? []) opts.onModelFallback?.(fallback);
}

/** Pick the backend by model/tier. Cross-provider routing = which ACP server to spawn.
 *  Registered CUSTOM names resolve FIRST (exact name, or `name/<inner-model>` prefix) so a
 *  registry entry is never shadowed by the built-in heuristics; then the claude/codex
 *  heuristics; then the default backend (AGENTPRISM_DEFAULT_BACKEND — which may itself name
 *  a registered custom backend). */
export function selectBackend(opts: { model?: string; tier?: string }, registry?: BackendRegistry): Backend {
  const custom = customBackendForSpec(opts.model, registry) ?? customBackendForSpec(opts.tier, registry);
  if (custom) return custom;
  const id = backendIdForSpec(opts.model) ?? backendIdForSpec(opts.tier) ?? defaultBackendId(registry);
  if (typeof id !== "string") return id; // the default resolved to a registered custom backend
  return id === "codex" ? new CodexBackend() : new ClaudeBackend();
}

/** Match a model/tier spec against the registry: the whole spec, or its `<name>/` prefix. */
function customBackendForSpec(spec: string | undefined, registry?: BackendRegistry): Backend | undefined {
  if (!spec || !registry || registry.size === 0) return undefined;
  const lower = spec.toLowerCase();
  const slash = lower.indexOf("/");
  const name = slash > 0 ? lower.slice(0, slash) : lower;
  const config = registry.get(name);
  return config ? new CustomAcpBackend(config) : undefined;
}

/** Strip a custom backend's routing name off the model/tier spec: the spec `"name"` selects no
 *  inner model; `"name/foo"` selects `"foo"`. Built-in backends receive the spec unchanged, and
 *  a spec that reached a custom DEFAULT backend without naming it also passes through (the
 *  agent's own catalog may know it). */
function innerModelSpec(spec: string | undefined, backend: Backend): string | undefined {
  if (!spec || !(backend instanceof CustomAcpBackend)) return spec;
  const lower = spec.toLowerCase();
  if (lower === backend.id) return undefined;
  if (lower.startsWith(`${backend.id}/`)) return spec.slice(backend.id.length + 1) || undefined;
  return spec;
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
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new WorkflowError(
      `${methodName} requires sessionId to be a non-empty string`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false, agentLabel: label },
    );
  }
}

async function disposeBestEffort(connection: PooledConnection): Promise<void> {
  try {
    await connection.dispose();
  } catch {
    // Dedicated lifecycle processes are already no longer useful; never mask the request result.
  }
}

function backendIdForSpec(spec: string | undefined): "claude" | "codex" | undefined {
  if (!spec) return undefined;
  const lower = spec.toLowerCase();
  const slash = lower.indexOf("/");
  const provider = slash > 0 ? lower.slice(0, slash) : "";
  if (provider === "openai" || provider === "codex") return "codex";
  if (provider === "anthropic" || provider === "claude") return "claude";

  const id = slash > 0 ? lower.slice(slash + 1) : lower;
  if (/codex|gpt|openai|\bo\d/.test(id)) return "codex";
  if (/claude|opus|sonnet|haiku|anthropic/.test(id)) return "claude";
  return undefined;
}

/** Resolve the default backend: a registered custom name wins (returned as a Backend), else
 *  the built-in id. An unknown/unset value falls back to "claude" (the historical default). */
function defaultBackendId(registry?: BackendRegistry): "claude" | "codex" | Backend {
  const name = process.env.AGENTPRISM_DEFAULT_BACKEND?.toLowerCase();
  if (name && registry) {
    const config = registry.get(name);
    if (config) return new CustomAcpBackend(config);
  }
  return name === "codex" ? "codex" : "claude";
}
