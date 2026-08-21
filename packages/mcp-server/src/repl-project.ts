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
 *   and the source (`restored`) are recorded on the state; the report
 *   demotes to `workspace().diagnostics` (§6.2), with a one-line notice
 *   in the next eval's output only when calls were LOST (`failedLost`).
 * - **A stored snapshot that REFUSES** (corrupt/truncated, a format
 *   version bump, a wasm-hash mismatch naming both hashes, or a
 *   payload that passes every at-rest check but cannot be RESTORED — a
 *   corrupted in-range VM header, `SnapshotRestoreError`) → §6.1
 *   AUTO-RESET: the refused file is renamed aside (`.refused-<ts>`,
 *   NEVER deleted — auto-reset must not be silent data destruction;
 *   the destination is COLLISION-SAFE — a same-millisecond second
 *   refusal bumps a counter suffix instead of overwriting an earlier
 *   aside), the CALL LEDGER is cleared with it (a fresh VM restarts
 *   ids at `c1`, and the store's first-wins replay must never hand a
 *   new call an old record's completion), a fresh workspace starts,
 *   and the next eval's output leads with a loud one-line notice
 *   naming the file and the reason. The daemon never crash-loops and
 *   never silently discards the data; a version bump therefore routes
 *   old snapshots through this path on first touch, exactly as the
 *   redesign intends.
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
 * ## The eval-break interrupt and the eval deadline (spec-owed mechanism)
 *
 * The `interrupt` tool's eval-break path (no call id) targets the
 * RUNNING eval through the broker (`Broker.armEvalBreak` — phase-E
 * review rejection round 1: the signal used to live here as a
 * project-wide boolean that an idle workspace's next eval — or an
 * unrelated drain — could consume; the broker now tracks the in-flight
 * eval's completion, refuses to arm when nothing is running, and the
 * armed signal is consumed by the first subsequent execution of that
 * eval — a settlement drain resuming its continuation, or a direct
 * eval's own drain when a synchronous host-callback settlement like
 * `checkpoint.answer` resumes it — phase-E review rejection round 2),
 * breaking it MID-RUN through the quickjs interrupt handler. The daemon
 * is single-threaded, so a request cannot be PROCESSED while a
 * fully synchronous (never-yielding) eval executes — phase-F review
 * round 2: the OUT-OF-BAND eval-break channel closes that gap (a
 * worker-thread relay the MCP shim fires before forwarding; the
 * running eval's quickjs interrupt handler consumes the shared-memory
 * break flag mid-execution — see `repl-engine`'s `eval-break-channel.ts`),
 * and the per-eval wall-clock deadline (the harness's eval guard)
 * remains the last-resort bound: every eval and settlement drain runs
 * under `BrokerOptions.evalTimeoutMs` enforced by the quickjs interrupt
 * handler, so a runaway eval can never hang the workspace forever. An
 * eval that YIELDS (suspends on a subagent call or a checkpoint) is
 * interruptible at its next execution; the wait tool's pumps release
 * the broker chain between iterations, so an interrupt lands promptly
 * mid-wait. The call-cancel path
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
 * children close. The concrete drain bound is the daemon's
 * `REPL_DRAIN_BOUND_MS` (`AGENTPRISM_REPL_DRAIN_BOUND_MS`; it used to
 * reuse the session-eviction TTL, which has since been decoupled so dead
 * clients are collected promptly — the runner's own runaway protections
 * already bound individual turns).
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
  type EvalBreakChannel,
  type ReconcileReport,
  type ReplStoreOptions,
  type WasmModule,
} from "@automatalabs/repl-engine";

import { existsSync, renameSync } from "node:fs";

import { SHUTDOWN_DEADLINE_MS } from "./lifecycle.js";

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
  /** The MCP sessions currently present on this workspace (the
   *  client-presence ledger's per-project set). */
  readonly clients: Set<string>;
  /** The in-flight first-touch promise (single-flight; null when idle). */
  firstTouch: Promise<void> | null;
  /** Bumped by dispose/reset: an in-flight first touch whose generation
   *  changed aborts its materialization. */
  generation: number;
  /** True once the client-presence drain ran (children closed; the
   *  workspace stays live and re-attaches lazily). The latch resets on
   *  every client touch, and the drain's skip guard double-checks the
   *  broker's authoritative warmth — a second disconnect after a
   *  re-attach must drain again (phase-D review). */
  drained: boolean;
  /** The last client-presence drain's failure (a snapshot-flush failure
   *  mid-drain, for example), recorded LOUDLY by the presence ledger and
   *  surfaced by the §6.2 [C]14 one-line notice in the next eval's output
   *  (the failure lost state — the workspace was not persisted — so it
   *  is never silent). The drain latch stays clear on failure, so the
   *  next disconnect retries. */
  drainError: { name: string; message: string } | null;
  /** §6.1: a refused stored snapshot was AUTO-RESET at first touch — the
   *  file was renamed aside (`.refused-<ts>`, never deleted) and a fresh
   *  workspace started. The next eval's output leads with the loud
   *  one-line notice naming the file and the refusal reason; consumed on
   *  first render. */
  autoResetNotice: { file: string; reason: string } | null;
  /** §6.2 [C]14: pending one-line LOSS notices — a restore that lost
   *  calls (`failedLost` non-empty) and a client-presence drain failure
   *  that lost state. Each surfaces ONCE, in the next eval's output
   *  (losses are never silent); consumed on render. */
  lossNotices: string[];
  /** The §3.1 empty-eval poll seam: the continuation tokens of evals
   *  THIS tool returned as still-running (their held calls ended with
   *  the bound elapsed, so no wait will ever read their token-keyed
   *  settlement). The engine's `claimSweptEvalSettlement` reads an
   *  entry only when its token is in this set — a concurrent client's
   *  still-pumping wait can never lose its attribution — and the
   *  claimed token leaves the set (its settlement was reported). */
  timedOutEvalTokens: Set<string>;
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
    clients: new Set(),
    firstTouch: null,
    generation: 0,
    drained: false,
    drainError: null,
    autoResetNotice: null,
    lossNotices: [],
    timedOutEvalTokens: new Set(),
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
  evalBreakChannel?: EvalBreakChannel,
): Promise<void> {
  // The in-flight first-touch promise is awaited BEFORE the workspace
  // fast path (phase-D review rejection: the fast path used to check
  // `state.workspace` first, while `doFirstTouch` publishes the
  // workspace/broker before awaiting the restore's reconcile — a
  // concurrent request could bypass an in-progress restore
  // reconciliation and observe or use partially restored state). While
  // `firstTouch` is non-null the touch (reconcile included) is not
  // complete, so every concurrent toucher shares it.
  const flight = state.firstTouch;
  if (flight !== null) return flight;
  if (state.workspace !== null) return;
  const promise = doFirstTouch(state, wasm, runner, evalTimeoutMs, evalBreakChannel);
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
  evalBreakChannel: EvalBreakChannel | undefined,
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
      // The eval-break signal no longer lives here — the broker owns it
      // (see `Broker.armEvalBreak`; phase-E review rejection: the
      // project-wide boolean used to be consumable by an unrelated eval
      // or drain). The per-eval wall-clock deadline still bounds every
      // eval and drain, and the OUT-OF-BAND eval-break channel (phase-F
      // review round 2) makes the interrupt tool's no-id path
      // deliverable to a synchronously running eval.
      evalTimeoutMs,
      evalBreakChannel,
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
      // The restore's source/report are published only AFTER the
      // reconciliation completes, and its completion is
      // GENERATION-CHECKED (phase-D review rejection: the old code wrote
      // `source` before awaiting the reconcile and wrote the report
      // after it with no generation check, so a reset/dispose during a
      // parked restore-time loadSession left a stale "restored" report
      // on the torn-down state — the broker's own disposal fences
      // released the late-loaded sessions, and the report of a reconcile
      // that outlived the state it describes must not be published).
      const broker = state.broker!;
      const report = await broker.reconcile();
      if (state.generation !== generation) {
        // reset/dispose won while the reconciliation was in flight: the
        // report belongs to a torn-down state — it is dropped, and the
        // touch aborts loudly exactly like the attach race.
        throw new Error("repl workspace touch aborted by reset/dispose");
      }
      state.source = "restored";
      state.reconcileReport = report;
      // §6.2 [C]14: a restore that LOST calls (failedLost non-empty) is
      // never silent — a one-line notice leads the next eval's output
      // (the full report lives in workspace().diagnostics.reconcile).
      if (report.failedLost.length > 0) {
        state.lossNotices.push(
          `restore lost ${report.failedLost.length} call(s) (${report.failedLost.join(", ")}) — ` +
            `their outcomes were unknowable and they were settled failed/re-issued; the full reconcile ` +
            `report lives in workspace().diagnostics.reconcile`,
        );
      }
      return;
    } catch (error) {
      if (error instanceof SnapshotEnvelopeError) {
        // §6.1 — a refused snapshot AUTO-RESETS: the file is renamed
        // aside (`.refused-<ts>`, never deleted — auto-reset must not
        // be silent data destruction) and a FRESH workspace starts. The
        // envelope family covers the whole load path — the decode-time
        // refusals (hash/version/gzip/shape) AND the restore-time
        // corruption (`SnapshotRestoreError` — a payload that passed
        // every at-rest check but failed to materialize). The next
        // eval's output leads with the loud one-line notice naming the
        // file and the reason (consumed once by the tool).
        //
        // A restore that got as far as attaching a workspace/broker
        // before refusing (a restore-time corruption surfacing at the
        // reconcile arm) is torn down before the fresh workspace starts
        // — never two live workspaces for one project.
        const attachedBroker = state.broker;
        const attachedWorkspace = state.workspace;
        state.broker = null;
        state.workspace = null;
        if (attachedBroker !== null) {
          try {
            await attachedBroker.dispose(SHUTDOWN_DEADLINE_MS);
          } catch {
            // Best-effort: the fresh workspace must still start.
          }
        }
        attachedWorkspace?.dispose();
        const aside = renameAsideNeverOverwriting(state.store.snapshotPath, Date.now());
        try {
          renameSync(state.store.snapshotPath, aside);
        } catch (renameError) {
          // The rename is the data-safety guarantee — if it fails the
          // fresh workspace's first snapshot write would silently
          // replace the refused file. Fail loudly instead.
          throw new Error(
            `the stored snapshot refused (${error.message}) and could not be renamed aside: ` +
              `${renameError instanceof Error ? renameError.message : String(renameError)}`,
          );
        }
        // §6.1 auto-reset is a FULL reset: the CALL LEDGER is cleared
        // with the snapshot (review finding — the old code renamed only
        // `snapshot.bin` and left `calls.jsonl` intact, so the fresh
        // VM's ids restarting at c1 hit the store's first-wins replay
        // and a new c1 inherited an old c1's record AND completion).
        // `store.reset()` closes the call store and wipes the `repl/`
        // directory ENTRY-WISE, preserving the renamed-aside
        // `.refused-*` file (§6.1 [C]13 — never deleted), and the next
        // `callStore()` reopens an empty ledger for the fresh ids.
        state.store.reset();
        state.autoResetNotice = { file: aside, reason: error.message };
        // Fall through: the fresh workspace starts below.
      } else {
        throw error;
      }
    }
  }
  const workspace = await Workspace.create(state.projectDir, { wasm });
  await attach(workspace);
  state.source = "fresh";
}

/**
 * §6.1 [C]13: the refused snapshot's rename-aside destination —
 * collision-safe, never an overwrite. POSIX `renameSync` SILENTLY
 * REPLACES an existing destination, so a plain
 * `<snapshot>.refused-<Date.now()>` name could delete an earlier
 * refused snapshot when two auto-resets land in the same millisecond
 * (a second refusal on a fresh snapshot, or a test driving two
 * refusals) — refused snapshots are never deleted. The daemon is
 * single-threaded, so the existence check and the rename below cannot
 * race; a collision bumps a counter suffix instead of replacing.
 * Exported for the collision regression test.
 */
export function renameAsideNeverOverwriting(snapshotPath: string, atMs: number): string {
  let attempt = 0;
  for (;;) {
    const suffix = attempt === 0 ? `${atMs}` : `${atMs}-${attempt}`;
    const candidate = `${snapshotPath}.refused-${suffix}`;
    if (!existsSync(candidate)) return candidate;
    attempt += 1;
  }
}

/** Mark an MCP session present on this project's workspace (the
 *  client-presence ledger's touch side; every `repl` tool call touches).
 *  The workspace stays warm while any session is present, and the drain
 *  latch resets: a present client makes the workspace warmable again, so
 *  the NEXT disconnect must drain whatever the workspace warmed (phase-D
 *  review: drain → reconnect → followUp re-attaches children → a second
 *  disconnect used to skip the drain and leave the reattached children
 *  running). */
export function touchReplProject(state: ReplProjectState, clientId: string): void {
  state.clients.add(clientId);
  state.drained = false;
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
 * skips it (presence is re-checked); one that reconnects MID-DRAIN
 * ABORTS it — the broker's `drainForDisconnect` consults this state's
 * client set every iteration and before every destructive phase, so the
 * children stay warm while any client is connected (phase-D review
 * round 6: the drain used to run to its release phase and close every
 * child regardless of presence).
 *
 * A failing drain — a snapshot-flush failure mid-drain, for example —
 * is recorded on the state (`drainError`, surfaced loudly in every repl
 * tool result) and the drain latch stays clear, so the next disconnect
 * retries the drain (phase-D review round 6: the failure used to be
 * discarded silently, and a failed snapshot write left the boundary
 * clean — the dirty boundary is retained for retry by the store's
 * writer).
 *
 * The latch is not a permanent skip: `touchReplProject` clears it on
 * every connect, and a stale latch (the broker reports warm children —
 * a lazy re-attach after the latch was set) never skips the drain
 * (phase-D review: drain → reconnect → followUp → second disconnect
 * left the reattached child running).
 */
export async function drainReplProject(state: ReplProjectState, boundMs: number): Promise<void> {
  if (state.broker === null || state.clients.size > 0) return;
  if (state.drained && state.broker.isDrained) return;
  try {
    // The mid-drain presence probe: the drain aborts the moment a
    // client is connected again (children stay warm).
    const drained = await state.broker.drainForDisconnect(boundMs, () => state.clients.size > 0);
    if (state.broker !== null) {
      state.drained = drained;
      if (drained) state.drainError = null;
    }
  } catch (error) {
    // Loud + retained: the ledger records the failure on the state and
    // every repl tool result surfaces it; the drain latch stays clear
    // so the next disconnect retries. The rethrow reaches the ledger's
    // catch — the drain runs detached, so the state record IS the
    // loudness.
    state.drainError = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
    // §6.2: the retained drain error lives under
    // workspace().diagnostics.drainError (the demoted diagnostics
    // home) — the broker's own drain paths retain their internal
    // failures there, and the tool layer pushes ITS observation of a
    // rethrown failure into the same record.
    state.broker?.retainDrainError(state.drainError.name, state.drainError.message);
    // §6.2 [C]14: the failed drain LOST STATE (the workspace was not
    // persisted — the store's dirty boundary is retained for retry) and
    // losses are never silent: a one-line notice leads the next eval's
    // output (consumed once; the record itself stays until the next
    // drain succeeds or reset clears it).
    state.lossNotices.push(
      `warn: the last client-presence drain failed (${state.drainError.name}: ${state.drainError.message}) — ` +
        `the workspace state was not persisted; the next disconnect retries the drain`,
    );
    throw error;
  }
}

/** Detach a stale in-flight first-touch flight (reset/dispose during a
 *  parked restore-time reconcile): the flight is dropped from the state
 *  so a fresh touch starts a NEW first touch instead of awaiting the
 *  never-resolving promise forever, and its eventual rejection — the
 *  generation check aborting the stale touch when the parked
 *  loadSession finally lands — is marked handled (the original toucher
 *  still observes it; a detached promise must never become an unhandled
 *  rejection). Phase-D review rejection: reset/dispose used to leave
 *  `state.firstTouch` parked — the generation check only ran after
 *  `broker.reconcile()` resolved — so every subsequent touch returned
 *  the stale promise and hung forever. */
function detachFirstTouch(state: ReplProjectState): void {
  const flight = state.firstTouch;
  state.firstTouch = null;
  if (flight !== null) {
    void flight.catch(() => undefined);
  }
}

/** Teardown the live workspace and broker (releasing every held ACP
 *  session) and close the store. The `repl/` directory is kept (a later
 *  touch restores from it). The broker's disposal drains what it can
 *  with the shutdown bound before cancelling (the daemon's shutdown
 *  path; the last-client-disconnect path uses the full drain bound).
 *  `boundMs` defaults to the daemon's shutdown deadline; the shutdown
 *  path passes the REMAINING time after its drain (phase-D review round
 *  7: the teardown used to run unbounded — a failed or deadline-expired
 *  drain was followed by a disposal that awaited hung cancel/release
 *  forever, so daemon shutdown could hang on the exact hung backend the
 *  drain had already caught). */
export async function disposeReplProjectState(
  state: ReplProjectState,
  boundMs: number = SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  const { broker, workspace } = state;
  state.broker = null;
  state.workspace = null;
  state.generation++;
  detachFirstTouch(state);
  try {
    if (broker !== null) await broker.dispose(boundMs);
  } finally {
    // The VM release and the store close run in the FINALLY path
    // (phase-D review round 8: a disposal rejection — its op-end flush
    // retrying the retained dirty boundary from a failed drain and
    // failing again, or an owned-runner teardown failure — used to skip
    // both, leaving the actual VM and the call store open while the
    // state already claimed to be torn down; the registry swallows the
    // disposal's rejection at shutdown, so the cleanup must never
    // depend on the disposal resolving).
    workspace?.dispose();
    state.store.close();
  }
}

/** The `reset()` guest function's host-side effect: teardown the
 *  workspace and delete the `repl/` store's contents. The broker
 *  teardown is bounded like the shutdown path's (a hung backend must
 *  not hang it either). Renamed-aside refused snapshots
 *  (`snapshot.bin.refused-*`) survive the wipe (§6.1 [C]13 — never
 *  deleted; the store's `reset()` preserves them). The stale
 *  first-touch flight is detached
 *  like the shutdown path's (see `disposeReplProjectState`): a reset
 *  during a parked restore-time reconcile must not leave every
 *  subsequent touch awaiting the never-resolving promise forever.
 *
 * The client PRESENCE is deliberately NOT reset: `state.clients` (and
 * the presence ledger's maps — they are always in sync) track
 * CONNECTION liveness, not workspace state. The workspace is dropped,
 * but the clients that are connected to the project stay connected —
 * clearing the set here would desync it from the ledger, and a later
 * disconnect of the reset-issuing client would drain work started
 * after the reset while another project client is still connected
 * (phase-E review rejection: reset used to clear `state.clients`, so
 * the drain decision — which the ledger derives from its own maps —
 * could fire against a project that still had a connected client).
 * The `drained` latch resets (the next disconnect must re-evaluate
 * whatever the fresh workspace warmed) and `drainError` clears (the
 * dropped state's stale failure is gone with it). */
export async function resetReplProjectState(
  state: ReplProjectState,
  boundMs: number = SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  const { broker, workspace } = state;
  state.broker = null;
  state.workspace = null;
  state.generation++;
  detachFirstTouch(state);
  try {
    if (broker !== null) await broker.dispose(boundMs);
  } finally {
    // The VM release and the store reset run in the FINALLY path — a
    // disposal rejection must never leave the VM or the `repl/` store
    // behind while the state claims to be reset (see
    // `disposeReplProjectState`).
    workspace?.dispose();
    state.store.reset();
  }
  state.source = null;
  state.reconcileReport = null;
  state.autoResetNotice = null;
  state.lossNotices = [];
  // Presence survives the reset: the connected clients remain present
  // (see the module docs above) — the next touch re-establishes the
  // workspace under the SAME presence, and the drain policy keeps
  // working against the ledger's authoritative per-project set.
  state.drained = false;
  state.drainError = null;
}
