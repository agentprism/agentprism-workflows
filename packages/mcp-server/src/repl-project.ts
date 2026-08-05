/**
 * The REPL workspace's daemon wiring — phase D of the REPL orchestrator
 * roadmap (docs/roadmap/repl-orchestrator.md): the per-project context
 * opens the daemon's `repl/` store, attaches the broker's state-changing
 * boundary sink, and on FIRST TOUCH either restores the stored workspace
 * (VM from the enveloped snapshot, then the three-way reconcile) or
 * creates a fresh one. This is the production wiring the phase D review
 * demanded: `ReplWorkspaceStore` used to be exported/tested only, with no
 * daemon project context opening it — the workspace did not survive
 * daemon restarts.
 *
 * ## First-touch semantics (spec-owed decision)
 *
 * `ensureReplWorkspace` runs once per project context, on the first `repl`
 * tool call that addresses the project:
 *
 * - **No stored snapshot** → a fresh workspace is created, the broker is
 *   attached (call store + snapshot sink + the interrupt signal), and
 *   every state-changing boundary persists from then on.
 * - **A stored snapshot that loads** → the VM is restored with the same
 *   wasm binary the envelope's hash was compared against, the broker is
 *   attached, and `reconcile()` runs the three-way arm (completed-while-
 *   down → settle from the call store; still resumable at the backend →
 *   re-attach via `loadSession`; lost → re-issue). The reconcile report
 *   and the source (`restored`) are recorded on the state for `status`.
 * - **A stored snapshot that REFUSES** (corrupt/truncated, a format
 *   version bump, or a wasm-hash mismatch naming both hashes) → the
 *   failure is CONTAINED: the `SnapshotEnvelopeError` is recorded on the
 *   state, no workspace is created, the daemon keeps serving (every
 *   subsequent `repl` call surfaces the refusal loudly in its result),
 *   and `reset` clears the `repl/` store so a fresh workspace can start.
 *   The alternative — re-creating a fresh VM over a refused snapshot —
 *   would silently discard the user's data; propagating the throw would
 *   crash-loop the daemon at every first touch. This is the doc's "a
 *   version bump makes old snapshots refuse loudly instead of
 *   corrupting" made daemon-safe.
 *
 * ## The interrupt signal (spec-owed mechanism)
 *
 * The `interrupt` tool's eval-break path (no call id) arms a per-project
 * signal that the broker's default per-eval interrupt handler consumes.
 * The daemon is single-threaded, so a runaway eval that is CURRENTLY
 * executing cannot observe a later request; the signal breaks the next
 * VM execution that runs with it armed (the settlement drain of a `wait`
 * or the next eval) — the honest single-threaded semantics, documented
 * in the tool description. The call-cancel path (`interrupt { id }`)
 * is immediate: it drives ACP `session/cancel` downward.
 *
 * ## Ownership
 *
 * The state owns its store and (through the broker) its ACP runner; the
 * workspace is the caller's per-context lifetime. `disposeReplProjectState`
 * tears the broker down (releasing every held ACP session and its
 * processes) and closes the store; `resetReplProjectState` additionally
 * deletes the whole `repl/` directory (the `reset` tool's engine-side).
 */

import {
  Broker,
  ReplWorkspaceStore,
  SnapshotEnvelopeError,
  Workspace,
  type BrokerRunner,
  type ReconcileReport,
  type ReplStoreOptions,
  type WasmModule,
} from "@automatalabs/repl-engine";

/** The per-project interrupt signal (see module docs). */
export interface ReplInterruptSignal {
  armed: boolean;
}

/** One project context's REPL workspace: the store plus the live
 *  workspace/broker pair, created on first touch. */
export interface ReplProjectState {
  readonly projectDir: string;
  /** The daemon's per-project repl store (snapshot + call store). */
  readonly store: ReplWorkspaceStore;
  /** The live VM workspace; null until the first touch. */
  workspace: Workspace | null;
  /** The attached broker; null until the first touch. */
  broker: Broker | null;
  /** Where the workspace came from on first touch. */
  source: "restored" | "fresh" | null;
  /** The last restore's three-way reconcile report (restored only). */
  reconcileReport: ReconcileReport | null;
  /** A stored snapshot's contained refusal (corrupt / version bump /
   *  wasm-hash mismatch) — surfaced in every repl tool result until
   *  `reset` clears the store. Null when no refusal occurred. */
  restoreError: SnapshotEnvelopeError | null;
  /** The interrupt tool's eval-break signal (see module docs). */
  readonly interrupt: ReplInterruptSignal;
}

/** Open (and create, on first touch) the project's repl state. */
export function createReplProjectState(
  projectDir: string,
  options: ReplStoreOptions = {},
): ReplProjectState {
  return {
    projectDir,
    store: ReplWorkspaceStore.open(projectDir, options),
    workspace: null,
    broker: null,
    source: null,
    reconcileReport: null,
    restoreError: null,
    interrupt: { armed: false },
  };
}

/** The broker's default per-eval interrupt handler for this project: the
 *  interrupt tool's signal, consumed on first observation. */
function interruptHandlerFor(state: ReplProjectState): () => boolean {
  return () => {
    const armed = state.interrupt.armed;
    state.interrupt.armed = false;
    return armed;
  };
}

/**
 * The first touch: restore the stored workspace (reconcile included) or
 * create a fresh one. A refused snapshot is CONTAINED on the state (see
 * module docs) — the daemon never crash-loops and never silently
 * discards data. Genuine host failures (wasm load, VM instantiation)
 * still propagate. Idempotent: a touched state is never touched twice.
 * `runner` is optional (default: the broker owns a fresh AcpAgentRunner);
 * tests inject a fake and own its lifetime.
 */
export async function ensureReplWorkspace(
  state: ReplProjectState,
  wasm: WasmModule,
  runner?: BrokerRunner,
): Promise<void> {
  if (state.workspace !== null) return;
  if (state.store.hasSnapshot()) {
    try {
      const restored = state.store.loadSnapshot(wasm);
      const workspace = await Workspace.restore(state.projectDir, restored.snapshot, { wasm });
      const broker = await Broker.attach(workspace, {
        runner,
        store: state.store.callStore(),
        snapshotSink: state.store.snapshotWriter(workspace, wasm),
        interruptHandler: interruptHandlerFor(state),
      });
      state.workspace = workspace;
      state.broker = broker;
      state.source = "restored";
      state.reconcileReport = await broker.reconcile();
      return;
    } catch (error) {
      if (error instanceof SnapshotEnvelopeError) {
        // Contained: the refusal is loud (surfaced in every repl result),
        // the daemon keeps serving, and reset clears the store.
        state.restoreError = error;
        return;
      }
      throw error;
    }
  }
  const workspace = await Workspace.create(state.projectDir, { wasm });
  const broker = await Broker.attach(workspace, {
    runner,
    store: state.store.callStore(),
    snapshotSink: state.store.snapshotWriter(workspace, wasm),
    interruptHandler: interruptHandlerFor(state),
  });
  state.workspace = workspace;
  state.broker = broker;
  state.source = "fresh";
}

/** Teardown the live workspace and broker (releasing every held ACP
 *  session) and close the store. The `repl/` directory is kept (a later
 *  touch restores from it). */
export async function disposeReplProjectState(state: ReplProjectState): Promise<void> {
  const { broker, workspace } = state;
  state.broker = null;
  state.workspace = null;
  if (broker !== null) await broker.dispose();
  workspace?.dispose();
  state.store.close();
}

/** The `reset` tool's engine-side: teardown the workspace and delete the
 *  whole `repl/` directory, clearing any contained refusal. */
export async function resetReplProjectState(state: ReplProjectState): Promise<void> {
  const { broker, workspace } = state;
  state.broker = null;
  state.workspace = null;
  if (broker !== null) await broker.dispose();
  workspace?.dispose();
  state.store.reset();
  state.source = null;
  state.reconcileReport = null;
  state.restoreError = null;
}
