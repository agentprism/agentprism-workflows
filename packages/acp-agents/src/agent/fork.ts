// The trait-driven `session/fork` choreography shared by `agent.fork()` and `AcpAgent.fork(ref)`.
// The wire order it guarantees on an id-only backend is forkSession < release(keepOpen) <
// resume|load — so the "Session not found" trap (prompting Claude's un-reattached fork id) is
// impossible by construction: the caller only ever receives the handle that is live.
import type { AcpSessionOptions, PooledConnection, ReattachPreference, SessionHandle } from "../acp-client.js";
import type { Backend } from "../backend.js";
import { forkSessionTrait, type ForkSessionTraitRow } from "../protocol-coverage.js";
import type { BackendRegistry } from "../registry.js";

/** A registered custom backend uses its declared `fork` trait (or the live default); a built-in
 *  uses its `FORK_SESSION_TRAITS` row. A registry lookup, never an identity branch: a custom entry
 *  named like a built-in is a different program and never inherits the built-in's row. */
export function forkTraitFor(backend: Backend, registry: BackendRegistry): ForkSessionTraitRow {
  const custom = registry.get(backend.id);
  return custom ? forkSessionTrait(backend.id, custom.fork ?? { disposition: "live" }) : forkSessionTrait(backend.id);
}

export interface AcquiredFork {
  /** The LIVE session: the fork handle itself (`live`), or the reattached handle (`id-only`). */
  readonly handle: SessionHandle;
  /** How the live handle was obtained. `load` means the agent replayed the transcript. */
  readonly method: "fork" | "resume" | "load";
}

/**
 * Fork `sourceSessionId` on `connection` (a dedicated process; the source's own process is not
 * involved on the wire) and hand back the live handle per `trait`:
 *   - `live`: the fork response IS the session.
 *   - `id-only`: the response names a persisted copy that is not live; release the fork handle
 *     with `keepOpen` (unregister only — no `session/close`, so the reattach's `register()` never
 *     replaces a live state and the slot count stays at one), then reattach it by `reattach` —
 *     `resume` preferred with `load` as the fallback (the live `agent.fork()`, whose child is
 *     seeded from the parent's snapshot), or `load` preferred with `resume` as the fallback (the
 *     cold `AcpAgent.fork(ref)`, which has no parent to seed from and wants the replay). The
 *     catalog/modes come from the reattach response; the bare fork response is never read for them.
 * `prepare` is re-evaluated for the reattach so it sees the same options the fork carried.
 */
export async function acquireForkedSession(
  connection: PooledConnection,
  sourceSessionId: string,
  opts: AcpSessionOptions,
  trait: ForkSessionTraitRow,
  reattach: ReattachPreference = "resume",
): Promise<AcquiredFork> {
  const forkHandle = await connection.forkSession(sourceSessionId, opts);
  if (trait.disposition !== "id-only") return { handle: forkHandle, method: "fork" };
  const forkedId = forkHandle.sessionId;
  await forkHandle.release({ keepOpen: true });
  const { handle, method } = await connection.openPreparedReattachedSession(forkedId, () => opts, undefined, reattach);
  return { handle, method };
}
