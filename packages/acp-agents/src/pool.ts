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
    const connections = this.connectionsFor(key);
    const live = connections.filter((c) => c.alive);

    const idle = live.find((c) => c.activeSessions === 0);
    if (idle) return idle;

    if (live.length < this.size) {
      this.installExitHook();
      const connection = PooledConnection.create(backend, {
        onDead: (dead) => this.drop(key, dead),
        onEvent: this.deps.onEvent,
        permissionResolver: this.deps.permissionResolver,
        elicitationResolver: this.deps.elicitationResolver,
        advertiseElicitation: this.deps.advertiseElicitation,
        clientHandlers: this.clientHandlers,
      });
      connections.push(connection);
      return connection;
    }

    // At capacity with every connection busy: multiplex onto the least-loaded one.
    return live.reduce((least, c) => (c.activeSessions < least.activeSessions ? c : least));
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
