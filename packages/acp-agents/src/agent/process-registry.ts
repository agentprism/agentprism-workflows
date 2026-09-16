// The module-level process-exit registry for every dedicated AcpAgent / probe connection in this
// process. Exactly ONE `process.once("exit")` listener regardless of how many agents are live
// (Node's defaultMaxListeners is 10; the runner, the pool, and raw connections each add their own),
// installed when the first connection is retained and removed when the last one is released.
import type { PooledConnection } from "../acp-client.js";

const live = new Set<PooledConnection>();
let installed = false;

/** `killNow()` is synchronous and idempotent — the only thing an `exit` handler may call. */
const onExit = (): void => {
  for (const connection of live) connection.killNow();
};

/** Register a connection for the exit hook; call right after `PooledConnection.create`. */
export function retainOnExit(connection: PooledConnection): void {
  live.add(connection);
  if (!installed) {
    installed = true;
    process.once("exit", onExit);
  }
}

/** Forget a connection; call in the `finally` of every teardown path. Removes the listener with
 *  the last connection so the process never accumulates dead hooks. */
export function releaseOnExit(connection: PooledConnection): void {
  live.delete(connection);
  if (installed && live.size === 0) {
    installed = false;
    process.removeListener("exit", onExit);
  }
}

/** Test seam: how many connections the hook currently guards. */
export function liveConnectionCount(): number {
  return live.size;
}
