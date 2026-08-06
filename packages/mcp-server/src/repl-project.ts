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
 * First touches are SINGLE-FLIGHT: concurrent first-touch calls share
 * one in-flight promise (phase-D review round 2: an asynchronous null
 * check followed by create/restore used to race — two concurrent first
 * touches could create two VMs and brokers for one project, attach both
 * to the same call store and snapshot path, and overwrite the shared
 * state, violating the one-VM-per-project and single-writer persistence
 * model). The state's `generation` counter makes `dispose`/`reset`
 * during a first touch abort the touch's materialization (the created
 * workspace is torn down without being registered).
 *
 * ## The interrupt signal and the eval deadline (spec-owed mechanism)
 *
 * The `interrupt` tool's eval-break path (no call id) arms a per-project
 * signal that the broker's default per-eval interrupt handler consumes.
 * The daemon is single-threaded, so a request cannot be PROCESSED while
 * an eval is executing — but a runaway eval can never hang the workspace
 * forever: the broker bounds every eval and settlement drain with a
 * per-eval wall-clock deadline enforced by the quickjs interrupt handler
 * (`BrokerOptions.evalTimeoutMs` — the harness's eval guard; phase-D
 * review round 2: the armed signal alone could only break the NEXT VM
 * execution, because a synchronous runaway eval blocks the event loop
 * before a later MCP request can arm it — the deadline makes the
 * CURRENTLY running eval always breakable). The armed signal breaks the
 * next VM execution immediately. The call-cancel path
 * (`interrupt { id }`) is immediate: it drives ACP `session/cancel`
 * downward (lazily re-attaching a drained handle's recorded session
 * first).
 *
 * ## Client presence and the drain (spec-owed decision)
 *
 * The doc's client-presence policy is wired here: `touchReplProject`
 * marks an MCP session present (every `repl` tool call touches);
 * `disconnectReplProject` runs when the session's last connection closed
 * (the daemon's session registry signals it via the `ReplPresenceLedger`
 * — see `src/repl-presence.ts`). A project with NO clients is drained:
 * in-flight subagent turns drain to completion (their results settle
 * into the VM and each settlement boundary snapshots — "close the laptop
 * while two researchers run" ends with the findings durable), then idle
 * children close. The concrete drain bound REUSES the daemon's
 * session-eviction TTL (`SESSION_IDLE_TTL_MS` — the spec-owed decision;
 * the runner's own runaway protections already bound individual turns).
 * The workspace and broker stay alive; the next client's
 * followUp/steer/cancel lazily re-attaches the recorded backend
 * sessions (the broker's capability-gated lazy re-attach).
 *
 * ## Ownership
 *
 * The state owns its store and (through the broker) its ACP runner; the
 * workspace is the caller's per-context lifetime.
 * `disposeReplProjectState` drains with the shutdown bound, tears the
 * broker down (releasing every held ACP session and its processes) and
 * closes the store; `resetReplProjectState` additionally deletes the
 * whole `repl/` directory (the `reset` tool's engine-side).
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
  /** The MCP sessions currently present on this workspace (the
   *  client-presence ledger's per-project set). */
  readonly clients: Set<string>;
  /** The in-flight first-touch promise (single-flight; null when idle). */
  firstTouch: Promise<void> | null;
  /** Bumped by dispose/reset: an in-flight first touch whose generation
   *  changed aborts its materialization. */
  generation: number;
  /** True once the client-presence drain ran (children closed; the
   *  workspace stays live and re-attaches lazily). */
  drained: boolean;
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
    clients: new Set(),
    firstTouch: null,
    generation: 0,
    drained: false,
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

/** The per-eval wall-clock deadline in ms (see module docs; the harness's
 *  eval guard). Overridable for tests; the daemon wires the env knob. */
export const DEFAULT_REPL_EVAL_TIMEOUT_MS = 30_000;

/**
 * The first touch: restore the stored workspace (reconcile included) or
 * create a fresh one. A refused snapshot is CONTAINED on the state (see
 * module docs) — the daemon never crash-loops and never silently
 * discards data. Genuine host failures (wasm load, VM instantiation)
 * still propagate. SINGLE-FLIGHT: concurrent first-touch calls share one
 * in-flight promise (phase-D review round 2 — see module docs), and
 * `dispose`/`reset` during the touch aborts its materialization via the
 * generation counter. `runner` is optional (default: the broker owns a
 * fresh AcpAgentRunner); tests inject a fake and own its lifetime.
 */
export async function ensureReplWorkspace(
  state: ReplProjectState,
  wasm: WasmModule,
  runner?: BrokerRunner,
  evalTimeoutMs: number = DEFAULT_REPL_EVAL_TIMEOUT_MS,
): Promise<void> {
  if (state.workspace !== null) return;
  const flight = state.firstTouch;
  if (flight !== null) return flight;
  const promise = doFirstTouch(state, wasm, runner, evalTimeoutMs);
  state.firstTouch = promise;
  try {
    await promise;
  } finally {
    if (state.firstTouch === promise) state.firstTouch = null;
  }
}

/** The single-flight first touch body (see `ensureReplWorkspace`). */
async function doFirstTouch(
  state: ReplProjectState,
  wasm: WasmModule,
  runner: BrokerRunner | undefined,
  evalTimeoutMs: number,
): Promise<void> {
  const generation = state.generation;
  const attach = async (workspace: Workspace): Promise<void> => {
    if (state.generation !== generation) {
      // dispose/reset won the race: never materialize the workspace.
      workspace.dispose();
      throw new Error("repl workspace touch aborted by reset/dispose");
    }
    const broker = await Broker.attach(workspace, {
      runner,
      store: state.store.callStore(),
      snapshotSink: state.store.snapshotWriter(workspace, wasm),
      interruptHandler: interruptHandlerFor(state),
      evalTimeoutMs,
    });
    if (state.generation !== generation) {
      await broker.dispose();
      workspace.dispose();
      throw new Error("repl workspace touch aborted by reset/dispose");
    }
    state.workspace = workspace;
    state.broker = broker;
  };
  if (state.store.hasSnapshot()) {
    try {
      const restored = state.store.loadSnapshot(wasm);
      const workspace = await Workspace.restore(state.projectDir, restored.snapshot, { wasm });
      await attach(workspace);
      state.source = "restored";
      state.reconcileReport = await state.broker!.reconcile();
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
  await attach(workspace);
  state.source = "fresh";
}

/** Mark an MCP session present on this project's workspace (the
 *  client-presence ledger's touch side; every `repl` tool call touches).
 *  The workspace stays warm while any session is present. */
export function touchReplProject(state: ReplProjectState, clientId: string): void {
  state.clients.add(clientId);
}

/** Remove an MCP session's presence (the ledger's disconnect side); a
 *  project with no clients left is drained by the ledger (see
 *  `ReplPresenceLedger.disconnect`). */
export function disconnectReplProject(state: ReplProjectState, clientId: string): void {
  state.clients.delete(clientId);
}

/**
 * The client-presence drain (the ledger's scheduled half): in-flight
 * subagent turns DRAIN TO COMPLETION (each settlement boundary snapshots
 * — the findings land durable in the workspace), bounded by `boundMs`
 * (the daemon's session-eviction TTL — the spec-owed concrete bound),
 * then every idle child closes. The workspace and broker stay alive; the
 * next client's followUp/steer/cancel lazily re-attaches the recorded
 * backend sessions. A client that reconnected before the drain started
 * skips it (presence is re-checked); one that reconnects mid-drain
 * self-heals via the lazy re-attach (documented in `repl-presence.ts`).
 */
export async function drainReplProject(state: ReplProjectState, boundMs: number): Promise<void> {
  if (state.broker === null || state.clients.size > 0) return;
  if (state.drained) return;
  const drained = await state.broker.drainForDisconnect(boundMs);
  if (state.broker !== null) state.drained = drained;
}

/** Teardown the live workspace and broker (releasing every held ACP
 *  session) and close the store. The `repl/` directory is kept (a later
 *  touch restores from it). The broker's disposal drains what it can
 *  with the shutdown bound before cancelling (the daemon's shutdown
 *  path; the last-client-disconnect path uses the full drain bound). */
export async function disposeReplProjectState(state: ReplProjectState): Promise<void> {
  const { broker, workspace } = state;
  state.broker = null;
  state.workspace = null;
  state.generation++;
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
  state.generation++;
  if (broker !== null) await broker.dispose();
  workspace?.dispose();
  state.store.reset();
  state.source = null;
  state.reconcileReport = null;
  state.restoreError = null;
  state.clients.clear();
  state.drained = false;
}
