// AcpAgentPool — POOL-manages the ACP server PROCESS lifecycle so it is decoupled from the
// per-agent SESSION lifecycle. Per backend (claude / codex) it holds a small set of long-lived
// PooledConnections (default 1, configurable via option/env). Each connection is initialized ONCE
// and multiplexes many concurrent sessions; the engine limiter already caps concurrency, so the
// pinned servers run prompts on different sessions concurrently.
//
// acquire() picks a connection and opens a session on it:
//   - reuse an idle live connection if one exists (sequential calls reuse ONE process);
//   - else grow up to `size` (spread concurrent load across processes);
//   - else pile onto the least-loaded live connection (multiplex past `size`).
// A crashed process is evicted (drop) and the next acquire spawns a fresh one. dispose() closes
// every process. A process-exit safety net kills children if the host exits without disposing.
import type { Backend, BackendId } from "./backend.js";
import { PooledConnection, SessionHandle, type AcpSessionOptions } from "./acp-client.js";
import { validateClientHandlers, type ClientHandlers } from "./client-handlers.js";
import { mapThrownError } from "./errors-map.js";
import type { AcpEventSink } from "./events.js";
import type { ElicitationResolver, PermissionResolver } from "./permissions.js";
import type { AuthStore, BackendAuthMachine } from "./auth/auth-store.js";
import type { ProviderStore } from "./provider-store.js";

const DEFAULT_POOL_SIZE = 1;
const POOL_SIZE_ENV = "AGENTPRISM_ACP_POOL_SIZE";

export interface AcpPoolOptions {
  /** Long-lived processes to keep PER backend. Default 1; falls back to AGENTPRISM_ACP_POOL_SIZE. */
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
  }

  /** Acquire a session for one agent() run: get/grow a pooled connection and open a session. */
  async acquire(backend: Backend, opts: AcpSessionOptions): Promise<SessionHandle> {
    if (this.disposed) throw new Error("ACP agent pool is disposed");
    const connection = this.selectConnection(backend);
    try {
      return await connection.openSession(opts);
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
    context: { signal?: AbortSignal; label?: string } = {},
  ): Promise<SessionHandle> {
    if (this.disposed) throw new Error("ACP agent pool is disposed");
    const connection = this.selectConnection(backend);
    try {
      return await connection.openPreparedSession(prepare);
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

  /**
   * Pick the connection to host the next session. Runs SYNCHRONOUSLY (no await) through to the
   * synchronous load-reservation in openSession(), so concurrent acquires never over-spawn or
   * double-book a connection.
   */
  private selectConnection(backend: Backend): PooledConnection {
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
    const idle = usable.find((c) => c.activeSessions === 0);
    if (idle) return idle;

    if (usable.length < this.size) return this.spawn(key, backend);

    // At capacity with every usable connection busy: multiplex onto the least-loaded one.
    return usable.length > 0
      ? usable.reduce((least, c) => (c.activeSessions < least.activeSessions ? c : least))
      : this.spawn(key, backend);
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
        void c.dispose(); // disk/spawn-env: recycle the idle process now
        this.drop(key, c);
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
        void c.dispose();
        this.drop(key, c);
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
    const arr = this.byBackend.get(key);
    if (!arr) return;
    const index = arr.indexOf(connection);
    if (index >= 0) arr.splice(index, 1);
  }

  /** Close every pooled process and clear the pool. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.removeExitHook();
    const all = this.allConnections();
    this.byBackend.clear();
    await Promise.all(all.map((c) => c.dispose()));
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
