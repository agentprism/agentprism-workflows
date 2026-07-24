// AcpAgentPool — POOL-manages the ACP server PROCESS lifecycle so it is decoupled from the
// per-agent SESSION lifecycle. Per backend it holds a small steady-state set of long-lived
// PooledConnections (default 1, configurable via option/env). Each connection is initialized ONCE
// and multiplexes many concurrent sessions; the engine limiter already caps concurrency, so the
// pinned servers run prompts on different sessions concurrently.
//
// acquire() picks a connection and opens a session on it:
//   - reuse an idle live connection if one exists (sequential calls reuse ONE process);
//   - else grow up to `size` (spread concurrent load across processes);
//   - else pile onto the least-loaded live connection (multiplex past `size`).
// Injected StructuredOutput runs instead reserve one process exclusively from other injected runs,
// growing elastically past `size` when necessary. Surplus idle processes are reaped after a warm
// keep-alive. A crashed process is evicted (drop) and the next acquire spawns a fresh one. dispose()
// closes every process. A process-exit safety net kills children if the host exits without disposing.
import type { Backend, BackendId } from "./backend.js";
import {
  PooledConnection,
  ReattachCapabilityUnavailable,
  SessionHandle,
  type AcpSessionOptions,
} from "./acp-client.js";
import { validateClientHandlers, type ClientHandlers } from "./client-handlers.js";
import { mapThrownError } from "./errors-map.js";
import type { AcpEventSink } from "./events.js";
import type { ElicitationResolver, PermissionResolver } from "./permissions.js";
import type { AuthStore, BackendAuthMachine } from "./auth/auth-store.js";
import type { ProviderStore } from "./provider-store.js";

const DEFAULT_POOL_SIZE = 1;
const POOL_SIZE_ENV = "AGENTPRISM_ACP_POOL_SIZE";
const ELASTIC_POOL_IDLE_KEEP_ALIVE_MS = 30_000;

interface PoolSelection {
  key: string;
  connection: PooledConnection;
  injected: boolean;
}

interface IdleTimer {
  set(callback: () => void, ms: number): { unref?(): void };
  clear(timer: { unref?(): void }): void;
}

export interface AcpPoolOptions {
  /** Steady-state processes to keep PER backend. Default 1; falls back to AGENTPRISM_ACP_POOL_SIZE. */
  size?: number;
  /** Client-side ACP fs/terminal handlers advertised at initialize and routed per session. */
  clientHandlers?: ClientHandlers;
}

/** Internal wiring the runner injects (NOT part of the public AcpPoolOptions surface): the typed
 *  event sink and runner-default permission resolver forwarded to every PooledConnection. */
export interface AcpPoolDeps {
  onEvent?: AcpEventSink;
  permissionResolver?: PermissionResolver;
  elicitationResolver?: ElicitationResolver;
  advertiseElicitation?: boolean;
  /** Initialize-time client auth advertisement (§1.2), forwarded to every PooledConnection.
   *  Undefined omits the `auth` capability — the default-OFF baseline. */
  authCapabilities?: { terminal?: boolean; gateway?: boolean };
  /** The runner's single auth store (§2). When present, connection selection is generation-gated:
   *  no session is ever opened on a connection whose applied intent-generation is stale. Undefined
   *  => no gating, byte-identical to the pre-auth baseline. */
  authStore?: AuthStore;
  /** The runner's single provider-intent store. When present, connection selection is also gated
   *  on the provider-routing generation, so no session is ever opened on a process still running
   *  under stale (or missing) client-configured provider routing. Undefined or never-recorded =>
   *  no gating, byte-identical baseline. */
  providerStore?: ProviderStore;
  /** Deterministic elastic-idle clock seam. Production uses the platform timers. */
  idleTimer?: IdleTimer;
}

/** Resolve the per-backend pool size: explicit option wins, else env, else 1. Clamped to >= 1. */
export function resolvePoolSize(option?: number): number {
  if (typeof option === "number" && Number.isFinite(option) && option >= 1) {
    return Math.floor(option);
  }
  const env = process.env[POOL_SIZE_ENV];
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_POOL_SIZE;
}

export class AcpAgentPool {
  private readonly size: number;
  private readonly clientHandlers: ClientHandlers | undefined;
  private readonly byBackend = new Map<BackendId, PooledConnection[]>();
  /** Connections whose async disposal is still in progress, including ones already removed from admission. */
  private readonly disposingConnections = new Set<PooledConnection>();
  /** Warm keep-alive timers for currently idle connections above the steady-state pool size. */
  private readonly elasticIdleTimers = new Map<PooledConnection, { unref?(): void }>();
  private readonly idleTimer: IdleTimer;
  private readonly onProcessExit = () => this.killAllSync();
  private exitHookInstalled = false;
  private disposed = false;

  constructor(
    options: AcpPoolOptions = {},
    private readonly deps: AcpPoolDeps = {},
  ) {
    validateClientHandlers(options.clientHandlers);
    this.size = resolvePoolSize(options.size);
    this.clientHandlers = options.clientHandlers;
    this.idleTimer = deps.idleTimer ?? {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
  }

  /** Acquire a session for one agent() run: get/grow a pooled connection and open a session. */
  async acquire(backend: Backend, opts: AcpSessionOptions): Promise<SessionHandle> {
    if (this.disposed) throw new Error("ACP agent pool is disposed");
    const selection = this.selectConnection(backend, false);
    const { connection } = selection;
    try {
      return await connection.openSession(opts, () => this.releaseSelection(selection));
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw mapThrownError(error, {
        label: opts.label,
        backendId: connection.backendId,
        backend,
        authMethods: connection.capabilities?.authMethods,
      });
    }
  }

  /** Acquire a connection slot, then let the caller prepare session/new after initialize. */
  async acquirePrepared(
    backend: Backend,
    prepare: (connection: PooledConnection) => AcpSessionOptions | Promise<AcpSessionOptions>,
    context: { signal?: AbortSignal; label?: string; injected?: boolean } = {},
  ): Promise<SessionHandle> {
    if (this.disposed) throw new Error("ACP agent pool is disposed");
    const selection = this.selectConnection(backend, context.injected === true);
    const { connection } = selection;
    try {
      return await connection.openPreparedSession(prepare, () => this.releaseSelection(selection));
    } catch (error) {
      if (context.signal?.aborted) throw error;
      throw mapThrownError(error, {
        label: context.label,
        backendId: connection.backendId,
        backend,
        authMethods: connection.capabilities?.authMethods,
      });
    }
  }

  /** Acquire a ready connection slot and reattach by the best capability negotiated on it. */
  async acquirePreparedReattach(
    backend: Backend,
    sessionId: string,
    prepare: (connection: PooledConnection) => AcpSessionOptions | Promise<AcpSessionOptions>,
    context: { signal?: AbortSignal; label?: string; injected?: boolean } = {},
  ): Promise<{ handle: SessionHandle; method: "resume" | "load" }> {
    if (this.disposed) throw new Error("ACP agent pool is disposed");
    const selection = this.selectConnection(backend, context.injected === true);
    const { connection } = selection;
    try {
      return await connection.openPreparedReattachedSession(
        sessionId,
        prepare,
        () => this.releaseSelection(selection),
      );
    } catch (error) {
      if (context.signal?.aborted) throw error;
      if (error instanceof ReattachCapabilityUnavailable) throw error;
      throw mapThrownError(error, {
        label: context.label,
        backendId: connection.backendId,
        backend,
        authMethods: connection.capabilities?.authMethods,
      });
    }
  }

  /**
   * Pick the connection to host the next session. Runs SYNCHRONOUSLY (no await) through both the
   * injected-process reservation here and the load reservation in openSession(), so concurrent
   * acquires never over-spawn or double-book a connection.
   */
  private selectConnection(backend: Backend, injected: boolean): PoolSelection {
    // Pool identity: poolKey (id + spawn-config hash for custom backends) over bare id, so two
    // runs declaring the same NAME with different COMMANDS never share a process.
    const key = backend.poolKey ?? backend.id;
    // Generation-gated selection (§2.6): reuse any idle live connection that is NOT stale,
    // reconciling stale ones first. This is the mechanical proof that no session is served under
    // stale auth. `existing` (not `machineFor`) so the default-OFF path never lazily creates a
    // machine — undefined machine ⇒ nothing is ever stale, byte-identical to the pre-auth baseline.
    const machine = this.deps.authStore?.existing(key);
    const connections = this.connectionsFor(key);

    if (machine) this.reconcileStale(key, machine);
    this.reconcileProviderStale(key);

    const usable = connections.filter(
      (c) =>
        c.alive &&
        !c.recyclePending &&
        !machine?.isStale(c.authStamp) &&
        !this.deps.providerStore?.isStale(key, c.providerStamp),
    );

    if (injected) {
      // Space-based isolation for every injecting backend: one live injected run per process.
      // The reservation is taken in this no-await selection path, so a concurrent acquire sees it
      // immediately and can never choose the same process. Existing non-injected sessions do not
      // disqualify a process, matching the previous FIFO's risk profile.
      const available = usable.filter((c) => !c.injectedRunReserved);
      const connection = available.length > 0
        ? available.reduce((least, c) => (c.activeSessions < least.activeSessions ? c : least))
        : this.spawn(key, backend);
      if (!connection.tryReserveInjectedRun()) {
        throw new Error(`ACP pool invariant violated: injected process ${connection.id} was double-booked`);
      }
      this.cancelElasticReap(connection);
      return { key, connection, injected: true };
    }

    const idle = usable.find((c) => c.activeSessions === 0);
    if (idle) {
      this.cancelElasticReap(idle);
      return { key, connection: idle, injected: false };
    }

    if (usable.length < this.size) {
      return { key, connection: this.spawn(key, backend), injected: false };
    }

    // At capacity with every usable connection busy: multiplex onto the least-loaded one.
    const connection = usable.length > 0
      ? usable.reduce((least, c) => (c.activeSessions < least.activeSessions ? c : least))
      : this.spawn(key, backend);
    this.cancelElasticReap(connection);
    return { key, connection, injected: false };
  }

  /** Release the selection-owned reservation only after SessionHandle.release() has completed,
   *  then retain surplus processes warm for one idle keep-alive before shrinking. */
  private releaseSelection(selection: PoolSelection): void {
    if (selection.injected) selection.connection.releaseInjectedRun();
    this.scheduleElasticReap(selection.key, selection.connection);
  }

  /** Reconcile every live connection for a key to the current generation (§2.6). Stale-but-busy
   *  connections are DRAINED (recycled on release), not disposed synchronously, so in-flight prompts
   *  finish under the auth they started with. Never blocks. */
  private reconcileStale(key: string, machine: BackendAuthMachine): void {
    for (const c of this.connectionsFor(key).filter((c) => c.alive)) {
      if (!machine.isStale(c.authStamp)) continue;
      if (c.canLiveReapply(machine) && c.activeSessions === 0) {
        c.scheduleReapply(machine); // in-process: re-auth the idle connection live
      } else if (c.activeSessions === 0) {
        this.disposeAndDrop(key, c); // disk/spawn-env: recycle the idle process now
      } else {
        c.markForRecycleWhenIdle(machine); // BUSY: drain, then recycle on release
      }
    }
  }

  /** Reconcile every live connection for a key to the current provider-routing generation. There
   *  is no live re-apply lane here (provider changes are rare host-level config): an idle stale
   *  process is recycled now, a busy one drains and recycles on release — mirroring the
   *  disk/spawn-env branches of reconcileStale. Never blocks. */
  private reconcileProviderStale(key: string): void {
    const store = this.deps.providerStore;
    if (!store) return;
    for (const c of this.connectionsFor(key).filter((c) => c.alive)) {
      if (!store.isStale(key, c.providerStamp)) continue;
      if (c.activeSessions === 0) {
        this.disposeAndDrop(key, c);
      } else {
        c.recyclePending = true; // BUSY: drain, then dispose-and-drop on release
      }
    }
  }

  /** Public: reconcile every live connection for a backend to the current generation (§2.6). Called
   *  by the runner immediately after a host-completed auth — or a provider-routing change — so a
   *  subsequent run() lands current. */
  recycle(poolKey: string): void {
    if (this.disposed) return;
    const machine = this.deps.authStore?.existing(poolKey);
    if (machine) this.reconcileStale(poolKey, machine);
    this.reconcileProviderStale(poolKey);
  }

  /** Spawn a fresh pooled connection (a fresh process primes the current intent at initialize). */
  private spawn(key: string, backend: Backend): PooledConnection {
    this.installExitHook();
    const connection = PooledConnection.create(backend, {
      onDead: (dead) => this.drop(key, dead),
      onEvent: this.deps.onEvent,
      permissionResolver: this.deps.permissionResolver,
      elicitationResolver: this.deps.elicitationResolver,
      advertiseElicitation: this.deps.advertiseElicitation,
      authCapabilities: this.deps.authCapabilities,
      authStore: this.deps.authStore,
      providerStore: this.deps.providerStore,
      clientHandlers: this.clientHandlers,
    });
    this.connectionsFor(key).push(connection);
    return connection;
  }

  private connectionsFor(key: string): PooledConnection[] {
    let arr = this.byBackend.get(key);
    if (!arr) {
      arr = [];
      this.byBackend.set(key, arr);
    }
    return arr;
  }

  /** Evict a dead connection so it is never handed out again. */
  private drop(key: string, connection: PooledConnection): void {
    this.cancelElasticReap(connection);
    const arr = this.byBackend.get(key);
    if (!arr) return;
    const index = arr.indexOf(connection);
    if (index >= 0) arr.splice(index, 1);
  }

  /**
   * Remove a stale connection from admission while retaining its disposal promise. A later pool
   * shutdown must await this graceful teardown, and its deadline must still be able to force-kill
   * the process tree if it has not settled yet.
   */
  private disposeAndDrop(key: string, connection: PooledConnection): void {
    this.drop(key, connection);
    void this.trackDisposal(connection);
  }

  /** Retain one memoized connection disposal until it settles, without leaking a rejection. */
  private trackDisposal(connection: PooledConnection): Promise<void> {
    this.disposingConnections.add(connection);
    const disposal = connection.dispose();
    void disposal.then(
      () => this.disposingConnections.delete(connection),
      () => this.disposingConnections.delete(connection),
    );
    return disposal;
  }

  /** Schedule one warm-idle reap for a surplus connection. Floor connections stay pinned. */
  private scheduleElasticReap(key: string, connection: PooledConnection): void {
    if (
      this.disposed ||
      !connection.alive ||
      connection.recyclePending ||
      connection.activeSessions !== 0 ||
      connection.injectedRunReserved ||
      this.elasticIdleTimers.has(connection)
    ) {
      return;
    }
    const connections = this.byBackend.get(key);
    if (!connections?.includes(connection) || connections.length <= this.size) return;

    const timer = this.idleTimer.set(() => {
      this.elasticIdleTimers.delete(connection);
      if (this.disposed) return;
      const current = this.byBackend.get(key);
      if (
        !current?.includes(connection) ||
        current.length <= this.size ||
        !connection.alive ||
        connection.recyclePending ||
        connection.activeSessions !== 0 ||
        connection.injectedRunReserved
      ) {
        return;
      }
      this.disposeAndDrop(key, connection);
    }, ELASTIC_POOL_IDLE_KEEP_ALIVE_MS);
    timer.unref?.();
    this.elasticIdleTimers.set(connection, timer);
  }

  /** A synchronous admission cancels the idle countdown before any await can let it fire. */
  private cancelElasticReap(connection: PooledConnection): void {
    const timer = this.elasticIdleTimers.get(connection);
    if (!timer) return;
    this.elasticIdleTimers.delete(connection);
    this.idleTimer.clear(timer);
  }

  private clearElasticReaps(): void {
    for (const timer of this.elasticIdleTimers.values()) this.idleTimer.clear(timer);
    this.elasticIdleTimers.clear();
  }

  /**
   * Close every pooled process and clear the admission registry. Connections remain reachable
   * through `disposingConnections` until their asynchronous graceful teardown settles so a host
   * lifecycle deadline can still synchronously force-kill them.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.removeExitHook();
    this.clearElasticReaps();
    // Include stale connections that were removed from admission by reconciliation but whose
    // graceful disposal has not settled. Otherwise a host lifecycle could see dispose() resolve,
    // cancel its deadline, and exit while such a backend process tree is still alive.
    const all = [...new Set([...this.allConnections(), ...this.disposingConnections])];
    this.byBackend.clear();
    try {
      const results = await Promise.allSettled(all.map((connection) => this.trackDisposal(connection)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    } finally {
      for (const connection of all) this.disposingConnections.delete(connection);
    }
  }

  /** Synchronously kill live pooled and in-progress-disposal backend process trees. */
  forceKill(): void {
    this.killAllSync();
    for (const connection of this.disposingConnections) connection.killNow();
  }

  private allConnections(): PooledConnection[] {
    const all: PooledConnection[] = [];
    for (const arr of this.byBackend.values()) all.push(...arr);
    return all;
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
    for (const connection of this.allConnections()) connection.killNow();
  }
}
