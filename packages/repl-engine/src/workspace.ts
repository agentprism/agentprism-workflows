/**
 * The workspace layer of the REPL engine.
 *
 * One VM per workspace. The workspace object owns the VM lifecycle:
 * `create` (instantiate the VM), `evalCode` (eval + job drain), `drainJobs`
 * (a settlement drain), and `dispose`. Workspaces are keyed by project
 * directory, mirroring the daemon's project model that the `repl` tool
 * (a later phase) addresses them by; the `WorkspaceRegistry` enforces the
 * one-VM-per-workspace invariant — including under concurrent first
 * touches, by deduplicating the in-flight creation promise rather than
 * creating duplicate VMs and disposing losers (review regression: two
 * concurrent `get('/same')` calls instantiated two VMs before one was torn
 * down, violating the invariant and multiplying memory use).
 */

import { JSValueHandle, type QuickJS } from 'quickjs-wasi';

import {
  provenanceBootstrap,
  provenanceRecord,
  provenanceView,
  baselineLexicalKeys,
  type ProvenanceOrigin,
  type ProvenanceView,
} from './provenance.js';
import { SnapshotRestoreError } from './snapshot-envelope.js';
import { ReplVm, getVmShim, loadShippedWasm, type ReplDrainOptions, type ReplEvalOptions, type ReplEvalOutcome } from './vm.js';
import type { ReplSnapshot, WasmInput } from './types.js';
import {
  GUEST_LEASE_GLOBAL,
  clearContinuationLease,
  installGuestBridge,
  readContinuationLease,
  readGuestSurface,
  readRealmSlotTypeToken,
  registerGuestHostCallbacks,
  type ConsoleEvent,
  type GuestBridgeHandlers,
  type GuestCall,
  type GuestSurface,
} from './bridge.js';
import { rawLexicalKeys } from './global-lexical.js';
import { inspectGlobal, manifestBinding } from './preview.js';
import { rawOwnKeys } from './trapfree.js';

/** One user binding of the workspace manifest (see `Workspace.manifest`). */
export interface WorkspaceBinding {
  name: string;
  /** Structure-only token (type/shape/size — never value content), or
   *  `agent handle` for a live agent handle. */
  token: string;
  /** The machine-readable structure-only type label (see preview.ts's
   *  `manifestTypeLabel`): `string`, `number`, `object`, `array`,
   *  `agent handle`, … — the structured manifest's type field, so a
   *  structured consumer never has to parse the token (phase-E review
   *  round 4: the type used to live only inside the formatted token). */
  type: string;
  /** The trap-free byte-size estimate of the binding's value (the doc's
   *  manifest contract: every top-level binding reports name, type, AND
   *  size; 0 only for the unreadable accessor/sabotage cases). */
  sizeBytes: number;
  /** The stable call id when the binding is an agent handle (the broker
   *  appends the live-handle status from the call store); null otherwise. */
  handleCallId: string | null;
  /** The sanitized provenance label (`eval 3`, `worker c2`, `session
   *  restore`), or null when untracked. */
  provenance: string | null;
  /** Wall clock of the provenance attribution (ms since epoch). */
  provenanceAtMs: number | null;
}

/** The workspace manifest — `ls` for the data plane (see `Workspace.manifest`). */
export interface WorkspaceManifest {
  /** Every user top-level binding, sorted by name. */
  bindings: WorkspaceBinding[];
  /** The `$N` log-ref globals as a range — always empty since 0.4.0
   *  (the `$N` capture system is deleted); the field stays for
   *  report-shape compatibility with the older manifest surface. */
  logs: { first: number | null; last: number | null; count: number };
  /** The registry's snapshot-durable eval counter. */
  evalSeq: number;
}

export type { ReplDrainOptions, ReplEvalOptions, ReplEvalOutcome } from './vm.js';
export type { WasmInput, WasmModule } from './types.js';

/** Options for creating a workspace (per-VM configuration). */
export interface WorkspaceOptions {
  /**
   * WASM bytes or a pre-compiled module (`WasmInput` — a self-contained
   * stand-in for `WebAssembly.Module | BufferSource`; the published type
   * graph must not depend on the consumer's lib, see `types.ts`).
   * Defaults to the `quickjs-wasi` package's shipped `quickjs.wasm`
   * binary.
   */
  wasm?: WasmInput;
  /**
   * Per-VM malloc limit in bytes. Resource limits are server
   * configuration, invisible to the guest; the default is
   * `ReplVm.DEFAULT_MEMORY_LIMIT` (64 MiB).
   */
  memoryLimit?: number;
  /**
   * Host handlers for the guest bridge, installed at VM creation — the
   * doc's injection discipline (the library and its `__host_*` callbacks
   * are in place from the first eval on; a workspace never exposes the
   * DSL as undefined). When omitted, the workspace installs its default
   * **parking bridge**: agent/checkpoint/steer calls park (they pend in
   * the guest registry, visible through `surface()`/`parkedCalls()`, and
   * stay unsolved until a later phase attaches real backends — parking
   * never fabricates a result). The one deliberate exception is
   * `checkpoint.answer`: answering a parked question settles the matching
   * pending checkpoint first-wins (the data plane interrupting the intent
   * plane works even with no backends attached). Console events
   * accumulate in `consoleEvents()`. A later phase that wires real
   * backends swaps handlers via `registerGuestHostCallbacks` (the same
   * re-registration the restore path uses).
   */
  handlers?: GuestBridgeHandlers;
}

/**
 * A persistent JavaScript REPL workspace: one QuickJS-in-WASM VM plus the
 * per-workspace policy around it. State persists between evals because it
 * lives in the VM, not in a transcript.
 */
export class Workspace {
  /** The project directory this workspace belongs to. */
  readonly projectDir: string;
  /** The configured per-VM malloc limit in bytes. */
  readonly memoryLimit: number;

  private readonly vm: ReplVm;
  private readonly consoleEventBuffer: ConsoleEvent[] = [];
  private readonly parkedCallsBuffer = new Map<string, GuestCall>();
  /** The fresh-realm baseline key set (the manifest's user-binding
   *  difference; captured once per process, see `provenance.ts`). */
  private readonly baselineKeysSet: Set<string>;
  /** The fresh-realm baseline GLOBAL LEXICAL key set (top-level
   *  `let`/`const`/`class` bindings the library itself carries — empty
   *  on the shipped library; see `provenance.ts`'s `baselineLexicalKeys`). */
  private readonly baselineLexicalKeysSet: Set<string>;
  /** The fresh-realm baseline TYPE TOKENS (name → trap-free `typeof`
   *  token of the pristine value): the manifest's changed-binding
   *  detector — a user REBINDING of a baseline global (`Math = 42`)
   *  changes the token, so the binding is listed with its provenance
   *  (phase-E review rejection: the baseline filter hid overwritten
   *  built-ins entirely). */
  private readonly baselineTypes = new Map<string, string>();
  /** Parked CHECKPOINT calls only, by call id — the answer-delivery
   *  table of the parking bridge. Kept separate from `parkedCallsBuffer`
   *  so `checkpoint.answer` can settle a pending question first-wins
   *  without ever touching a parked agent/steer call that happens to
   *  share the id space (review regression: the bridge rejected every
   *  answer with `false`, leaving the original promise pending forever). */
  private readonly parkedCheckpointCalls = new Map<string, GuestCall>();
  /** The parking bridge's per-call KIND (agent/steer/checkpoint) and
   *  per-call question text — the introspection handlers (`workspace()`/
   *  `agents()`) serve them in the §4.5 shapes. */
  private readonly parkedKinds = new Map<string, 'agent' | 'steer' | 'checkpoint'>();
  private readonly parkedQuestions = new Map<string, string>();
  /** The parking bridge's per-call AGENT data (the §4.5 agents() shape
   *  serves the real model spec and task — a parked call records what
   *  the guest asked for; never fabricated empties). */
  private readonly parkedModelSpecs = new Map<string, string>();
  private readonly parkedTasks = new Map<string, string>();
  /** The parking bridge's `reset()` request: the teardown runs after the
   *  current eval completes (see `eval`). */
  private pendingReset = false;
  /** The parking bridge's retained SUSPENDED-eval completions (one per
   *  suspended eval — `eval` keeps the wrapper; the drain's sweep reads
   *  the settled value into `_` and releases it). */
  private readonly suspendedCompletions = new Set<JSValueHandle>();
  /** The retained completion of the eval that called `reset()` while it
   *  suspended (the teardown owes AFTER that eval completes). */
  private pendingResetCompletion: JSValueHandle | null = null;
  private disposed = false;

  private constructor(projectDir: string, vm: ReplVm, baseline: Set<string>) {
    this.projectDir = projectDir;
    this.vm = vm;
    this.memoryLimit = vm.memoryLimit;
    this.baselineKeysSet = baseline;
    this.baselineLexicalKeysSet = new Set();
  }

  /**
   * Create a workspace: instantiate its VM (defaulting to the shipped
   * `quickjs.wasm` binary and the default memory limit), install the
   * guest bridge — the version-marked library plus its `__host_*`
   * callbacks — so the DSL (`agent`, `checkpoint`, `console`, the
   * combinators) is live from the first eval on (the doc's injection
   * discipline; see `WorkspaceOptions.handlers` for the default parking
   * bridge), and bootstrap the per-binding provenance registry (the
   * workspace manifest's provenance seam; a fresh workspace starts with
   * the baseline `known` set and no origins — the first eval's
   * maintenance pass attributes its bindings to `eval 1`).
   */
  static async create(projectDir: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const wasm = options.wasm ?? (await loadShippedWasm());
    const vm = await ReplVm.create({ wasm, memoryLimit: options.memoryLimit });
    const workspace = new Workspace(projectDir, vm, new Set());
    await installGuestBridge(vm, options.handlers ?? workspace.defaultHandlers());
    const [bootstrap, lexicalBaseline] = await Promise.all([provenanceBootstrap(vm, wasm), baselineLexicalKeys(wasm)]);
    workspace.baselineKeysSet.clear();
    for (const key of bootstrap.baseline) workspace.baselineKeysSet.add(key);
    for (const key of lexicalBaseline) workspace.baselineLexicalKeysSet.add(key);
    for (const [name, token] of bootstrap.baselineTypes) workspace.baselineTypes.set(name, token);
    return workspace;
  }

  /**
   * Restore a workspace from a quickjs-wasi snapshot: the VM is restored
   * and the host callbacks are re-registered by name (`registerGuestHostCallbacks`
   * — the guest library and its pending-call registry travel INSIDE the
   * snapshot; the library is never re-evaluated). The
   * provenance registry travels with the snapshot too; a PRE-PROVENANCE
   * snapshot (whose library predates the registry) gets the registry
   * installed by the host bootstrap and its pre-existing bindings are
   * swept as `session restore` — "first seen at restore", never a
   * guessed origin. This is the restore-path constructor the daemon
   * layer (a later phase) uses with the identity-enveloped snapshots; it
   * exists now so the settlement machinery (store → guest exactly-once
   * delivery across a simulated crash) is testable at the workspace
   * boundary.
   *
   * A payload that PASSED every envelope check (hash, version, gzip,
   * shape, pointer bounds) but cannot be materialized — a corrupted
   * in-range VM header (a pointer patched to a wrong-but-in-bounds
   * value), garbage the shim's binary parse accepted, a guest surface
   * that cannot be rehosted, a provenance registry that cannot
   * bootstrap — REFUSES as `SnapshotRestoreError` (code
   * `RESTORE_CORRUPT`, the envelope family's restore-time member), and
   * any partially created VM is DISPOSED before the refusal propagates
   * (phase-D review rejection: the callback/provenance initialization
   * used to throw with the half-built VM still live, and the raw
   * `RuntimeError` leaked past the daemon's `SnapshotEnvelopeError`
   * containment, so every subsequent touch retried the restore into
   * garbage). The refusal is single-shot and coded — the daemon records
   * it as a stable refusal and never crash-loops.
   */
  static async restore(projectDir: string, snapshot: ReplSnapshot, options: WorkspaceOptions = {}): Promise<Workspace> {
    const wasm = options.wasm ?? (await loadShippedWasm());
    let vm: ReplVm;
    try {
      vm = await ReplVm.restore(snapshot, { wasm, memoryLimit: options.memoryLimit });
    } catch (error) {
      // The VM never materialized (nothing to dispose): the shim's
      // restore choked on the payload — a structurally valid envelope
      // whose in-range header or memory is garbage. Raise the coded
      // refusal with the underlying failure named, never a raw wasm
      // `RuntimeError` (the daemon's containment catches the envelope
      // family only).
      throw new SnapshotRestoreError(
        `restoring the workspace VM from the snapshot failed (${(error as Error)?.message ?? String(error)})`, // eslint-disable-line max-len
        { cause: error },
      );
    }
    const workspace = new Workspace(projectDir, vm, new Set());
    try {
      registerGuestHostCallbacks(vm, options.handlers ?? workspace.defaultHandlers());
      const [bootstrap, lexicalBaseline] = await Promise.all([provenanceBootstrap(vm, wasm), baselineLexicalKeys(wasm)]);
      workspace.baselineKeysSet.clear();
      for (const key of bootstrap.baseline) workspace.baselineKeysSet.add(key);
      for (const key of lexicalBaseline) workspace.baselineLexicalKeysSet.add(key);
      for (const [name, token] of bootstrap.baselineTypes) workspace.baselineTypes.set(name, token);
      if (bootstrap.created) {
        // The pre-provenance restore sweep: attribute bindings that existed
        // before this host started tracking.
        provenanceRecord(vm, { kind: 'restore' });
      }
      return workspace;
    } catch (error) {
      // The VM EXISTS but cannot be rehosted/bootstraped: dispose it
      // (a partial VM must never be left live — phase-D review
      // rejection) and raise the same coded refusal.
      vm.dispose();
      throw new SnapshotRestoreError(
        `initializing the restored workspace failed (${(error as Error)?.message ?? String(error)})`, // eslint-disable-line max-len
        { cause: error },
      );
    }
  }

  /**
   * Snapshot the workspace's VM: raw WASM linear memory plus runtime
   * pointers (the quickjs-wasi snapshot). The guest library and the
   * pending-call registry travel inside; the host callbacks do not
   * (re-register by name after restore — `rehost`). The at-rest
   * identity envelope (wasm hash + format version + gzip) is the daemon
   * layer's wrap, a later phase; this is the raw snapshot seam.
   */
  snapshot(): ReplSnapshot {
    this.assertAlive();
    return (getVmShim(this.vm) as QuickJS).snapshot();
  }

  /**
   * Evaluate a script in the workspace's VM: eval + job drain + completion
   * report. See `ReplVm.evalCode` for the outcome shapes. The returned
   * promise is fulfilled synchronously (the VM layer performs no `await`),
   * so an eval cannot race `dispose()`.
   *
   * The §4.4 result-history global is maintained HERE (the workspace
   * level owns `_` for its own evals — the broker sets it for its evals
   * through the same `setGlobal` seam): a RESOLVED eval's completion
   * value becomes `_` (an undefined completion — an empty poll — leaves
   * it unchanged, like an error); a SUSPENDED eval retains its
   * completion wrapper and `drainJobs`'s sweep sets `_` once the
   * continuation settles.
   *
   * The parking bridge's `reset()` teardown runs AFTER the current eval
   * completes (the doc's §4.5): a completed eval disposes now; a
   * SUSPENDED eval keeps the workspace alive until its continuation
   * settles at the drain (`drainJobs`'s sweep), then disposes — the
   * continuation runs to completion first, and the eval that called
   * reset() is the one whose completion owes the teardown.
   */
  eval(code: string, options?: ReplEvalOptions): Promise<ReplEvalOutcome> {
    this.assertAlive();
    const { outcome, completion } = this.vm.evalCodeWithCompletion(code, options);
    if (completion !== undefined) {
      if (outcome.kind === 'value') {
        try {
          // An undefined completion (an empty script — the documented
          // poll idiom) is not "a value": `_` stays unchanged, like
          // after an error.
          if (!(completion as JSValueHandle).isUndefined) this.setGlobal('_', completion);
        } catch {
          // A failed `_` write must not fail the eval that produced the
          // value.
        }
        (completion as JSValueHandle).dispose();
      } else {
        // A suspended eval: retain the wrapper — the drain's sweep reads
        // the settled value into `_` and releases the handle. The
        // reset-owning completion is tracked separately (a reset() the
        // eval called owes its teardown only once THIS eval completes).
        this.suspendedCompletions.add(completion as JSValueHandle);
        if (this.pendingReset && this.pendingResetCompletion === null) {
          this.pendingResetCompletion = completion as JSValueHandle;
        }
      }
    }
    // The teardown for an eval that COMPLETED within this call runs now
    // (its output above is already captured); a suspended eval's
    // teardown runs at the drain (see `drainJobs`). A reset owed by an
    // EARLIER still-suspended eval (`pendingResetCompletion` set) keeps
    // the workspace alive until that eval completes.
    if (outcome.kind !== 'pending' && this.pendingReset && this.pendingResetCompletion === null) this.dispose();
    return Promise.resolve(outcome);
  }

  /**
   * @internal Package-internal eval seam for the broker layer: like
   * `eval`, but when the eval RESOLVED the live completion-value handle
   * comes back alongside the shallow snapshot (`completion` — an opaque
   * quickjs-wasi `JSValueHandle`, OWNED BY THE CALLER, who must dispose it
   * after previewing; for a SUSPENDED eval (the completion pending on a
   * host call) it is the eval wrapper promise handle — the caller's
   * active-eval probe (the wrapper settles when the continuation
   * completes or is broken; the caller owns and must dispose it);
   * `undefined` for error outcomes). The broker
   * previews it trap-free for the tool result's `result` line. Not part of
   * the published API (not re-exported from the index); `completion` is
   * typed `unknown` so the public declaration graph stays self-contained.
   */
  evalWithCompletion(
    code: string,
    options?: ReplEvalOptions,
  ): { outcome: ReplEvalOutcome; completion?: unknown; interruptedInDrain?: boolean } {
    this.assertAlive();
    return this.vm.evalCodeWithCompletion(code, options);
  }

  /**
   * Re-register the four `__host_*` callbacks by name — the same
   * re-registration the snapshot-restore path uses. This is the seam the
   * broker (a later phase wires real backends) takes over a workspace
   * with: the guest library and its pending-call registry are untouched
   * (never re-injected), and the guest's `issueCall` looks the host
   * function up by name at call time, so replacing the host-side
   * trampoline routes every subsequent call to the new handler. Safe on a
   * live VM and on a restored one.
   */
  rehost(handlers: GuestBridgeHandlers): void {
    this.assertAlive();
    registerGuestHostCallbacks(this.vm, handlers);
  }

  /**
   * Run the job drain loop (settle what can be settled). Used after an
   * eval that suspended, when host-side settlement (subagent calls in a
   * later phase) has made progress. Because a suspended eval's interrupt
   * handler is no longer armed, the drain accepts its own per-drain
   * `interruptHandler` so a resumed runaway continuation stays bounded.
   *
   * After the drain, the RETAINED-SUSPENDED-EVAL sweep runs: a
   * continuation that completed during the drain is the PREVIOUS eval —
   * its completion value becomes `_` — and a reset() the settled eval
   * requested tears the workspace down now that the eval completed (the
   * §4.5 host-side effect).
   */
  drainJobs(options?: ReplDrainOptions): number {
    this.assertAlive();
    const count = this.vm.drainJobs(options);
    this.sweepSuspendedEvals();
    return count;
  }

  /**
   * One pass over the retained suspended-eval completions (the parking
   * bridge's `_` / reset() bookkeeping): a settled wrapper's fulfilled
   * value becomes `_` (a rejection — the eval errored late — leaves `_`
   * unchanged), the handle is released, and when the reset-requesting
   * eval's own completion settled the teardown runs (the workspace is
   * disposed after its last eval completed). Runs after every drain;
   * between VM operations only.
   */
  private sweepSuspendedEvals(): void {
    if (this.suspendedCompletions.size === 0) return;
    for (const completion of [...this.suspendedCompletions]) {
      if (completion.promiseState === 0) continue; // still pending
      this.suspendedCompletions.delete(completion);
      try {
        const value = this.vm.readRetainedCompletion(completion) as JSValueHandle | undefined;
        if (value !== undefined) {
          try {
            this.setGlobal('_', value);
          } catch {
            // A failed `_` write must not fail the drain.
          }
          value.dispose();
        }
      } catch {
        // Best-effort bookkeeping: a hostile completion shape must not
        // break the drain.
      }
      completion.dispose();
    }
    if (this.pendingReset && this.pendingResetCompletion !== null && !this.suspendedCompletions.has(this.pendingResetCompletion)) {
      // The reset-requesting eval completed (its continuation settled at
      // this drain): the teardown runs now — the host-side effect the
      // deleted `reset` action performed.
      this.pendingReset = false;
      this.pendingResetCompletion = null;
      this.dispose();
    }
  }

  /**
   * Teardown: dispose the VM and drop all stored state. In-flight work is
   * cancelled by the caller (the tool layer); the VM itself is gone after
   * this. Because every VM operation is synchronous, no operation can be
   * in flight when this runs.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const completion of this.suspendedCompletions) completion.dispose();
    this.suspendedCompletions.clear();
    this.pendingResetCompletion = null;
    this.vm.dispose();
  }

  /** Support for `using` declarations (Explicit Resource Management). */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /** True once `dispose()` has been called. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * @internal The continuation-lease READ seam (the broker's eval-break
   * targeting identity — see `ReplJobLease` in vm.ts): reads the guest
   * library's `__replLease` accessor between VM operations. Best-effort
   * (a missing/broken accessor reads as `undefined`).
   */
  readContinuationLease(): string | undefined {
    this.assertAlive();
    return readContinuationLease(this.vm);
  }

  /**
   * @internal Write a live guest value into a realm global slot — the
   * `_` seam (the broker sets the previous eval's completion value; see
   * `ReplVm.setGlobal`).
   */
  setGlobal(name: string, value: unknown): void {
    this.assertAlive();
    this.vm.setGlobal(name, value);
  }

  /**
   * @internal Read a RETAINED suspended-eval completion wrapper after it
   *  settled (the broker's active-eval sweep, and this workspace's own
   *  parking-bridge sweep): the fulfilled completion value handle,
   *  owned by the caller (dispose after use), or undefined for a
   *  rejected/still-pending completion (`_` stays unchanged then). See
   *  `ReplVm.readRetainedCompletion`. Called between VM operations.
   */
  readRetainedCompletion(completion: unknown): unknown {
    this.assertAlive();
    return this.vm.readRetainedCompletion(completion as JSValueHandle);
  }

  /**
   * @internal The continuation-lease CLEAR seam (see
   * `readContinuationLease`): the drain loop clears the lease at drain
   * start and after every lease-carrying job.
   */
  clearContinuationLease(): void {
    this.assertAlive();
    clearContinuationLease(this.vm);
  }

  /**
   * The console events accumulated by the default parking bridge, in
   * order (only populated when `options.handlers` was omitted — custom
   * handlers own their events). Each event carries the guest-rendered
   * ONE line per console.* call.
   */
  consoleEvents(): readonly ConsoleEvent[] {
    return this.consoleEventBuffer;
  }

  /**
   * The parked host calls of the default parking bridge, by call id
   * (only populated when `options.handlers` was omitted). A later phase
   * that attaches real backends settles these `GuestCall`s (or takes
   * them over) — parking is the honest no-backend state, it never
   * fabricates results.
   *
   * Parked checkpoint QUESTIONS are in this map too, but answers do NOT
   * arrive through here: `checkpoint.answer` settles the matching
   * pending checkpoint directly (see `defaultHandlers`) — the entry is
   * removed from both maps on delivery, so this map only ever lists
   * still-parked calls.
   */
  parkedCalls(): ReadonlyMap<string, GuestCall> {
    return this.parkedCallsBuffer;
  }

  /**
   * The guest library's reconciliation surface — the host's door back
   * into the pending-call registry (`pending`/`settle`/`stats`, used by
   * `status` and by the post-restore reconciliation loop). `undefined`
   * only when the bridge is not installed (it always is on workspaces
   * created through this class).
   */
  surface(): GuestSurface | undefined {
    this.assertAlive();
    return readGuestSurface(this.vm);
  }

  /**
   * Content-free metadata for one realm global slot — the workspace-
   * manifest seam (`status`): name, type, size; metadata, never content.
   */
  inspectBinding(name: string): { kind: 'data' | 'accessor' | 'absent'; label: string; sizeBytes: number } {
    this.assertAlive();
    return inspectGlobal(this.vm, name);
  }

  /**
   * One maintenance pass of the per-binding provenance registry (the
   * workspace manifest's provenance seam): attribute new/rebound user
   * bindings to the operation that created them. The broker drives this
   * after each eval and each settlement drain; `Workspace.restore` sweeps
   * pre-provenance snapshots itself. Orientation metadata only — never
   * errors upward.
   */
  provenanceRecord(origin: ProvenanceOrigin): void {
    this.assertAlive();
    provenanceRecord(this.vm, origin);
  }

  /**
   * The sanitized provenance registry (see `provenance.ts`): which eval
   * or worker settlement created/rebound each user binding, with the
   * registry's eval counter. The manifest renderer's provenance seam.
   */
  provenanceView(): ProvenanceView {
    this.assertAlive();
    return provenanceView(this.vm);
  }

  /**
   * The workspace manifest — `ls` for the data plane (the roadmap doc's
   * `status` manifest): every user top-level binding (fresh-realm
   * baseline set difference — the guest library's own globals and the
   * realm builtins are never listed — plus user bindings that SHADOW or
   * OVERWRITE baseline globals: a lexical declaration always wins over
   * the baseline (a user `const Math = 42` is listed with the lexical
   * value's metadata), and a baseline global whose value's type token
   * changed from the fresh-realm baseline has been rebinding by user
   * code and is listed too — phase-E review round 5: the baseline
   * filter used to remove both; a baseline global whose VALUE is no
   * longer the pristine baseline object (a SAME-TYPE overwrite —
   * `Math = { userOwned: true }` keeps the `object` token) is listed
   * the same way through the registry's changed-known read — phase-E
   * review rejection round 6: the token-only detector missed same-type
   * replacements entirely), with its structure-only token
   * (type/shape/size — metadata, never content), its provenance label
   * (`via eval N` / `via worker cN` — null when untracked), and the
   * live-handle call id when the binding is an agent handle (the caller
   * — the broker — appends the handle status from the call store). The
   * GLOBAL LEXICAL bindings (top-level `let`/`const`/`class` — the
   * roadmap's canonical `const research = agent(...)` state) are
   * enumerated too, through the engine's internal global-var object
   * (see `global-lexical.ts`): lexical bindings are not global-object
   * properties, and they SHADOW a same-named global-object property for
   * identifier resolution, so a name present in both lists yields ONE
   * binding — the lexical view (what the orchestrator's code sees). The
   * `$N` log-ref globals are listed separately as a range, mirroring the
   * harness manifest's logs breakdown. Trap-free throughout: descriptor
   * reads only, accessors never invoked.
   */
  manifest(): WorkspaceManifest {
    this.assertAlive();
    const baseline = this.baselineKeys();
    const lexicalBaseline = this.baselineLexicalKeys();
    const lexicalKeys = new Set(rawLexicalStringKeys(this.vm));
    const names = unionNames(rawGlobalStringKeys(this.vm), rawLexicalStringKeys(this.vm));
    const view = provenanceView(this.vm);
    const user = names.filter((name) => {
      if (!baseline.has(name) && !lexicalBaseline.has(name)) return true;
      // A GLOBAL LEXICAL binding SHADOWS a same-named baseline global
      // for identifier resolution (a user `const Math = 42`): the
      // binding the orchestrator's code sees is the user's, so the
      // manifest lists it — the lexical view, the same rule as the
      // one-binding-per-name union (phase-E review rejection: the
      // baseline filter removed shadowing bindings entirely).
      if (lexicalKeys.has(name) && !lexicalBaseline.has(name)) return true;
      // A baseline GLOBAL REBINDING (a `Math = 42` assignment): the
      // value's trap-free type token changed from the fresh-realm
      // baseline — the user overwrote the built-in, and the manifest
      // lists the overwrite like any other user binding (phase-E
      // review rejection: overwritten built-ins were hidden). A
      // SAME-TYPE overwrite (`Math = { userOwned: true }` — both
      // values are objects, so the token cannot see it) is caught by
      // the registry's changed-known list, which compares the current
      // value against the ORIGINAL baseline value (SameValue —
      // phase-E review rejection round 6: same-type overwrites stayed
      // absent from the manifest with no provenance).
      if (this.baselineChanged(name) || view.changed.has(name)) return true;
      return false;
    });
    const bindings: WorkspaceBinding[] = [];
    for (const name of user) {
      const info = manifestBinding(this.vm, name);
      if (info === null) continue;
      const origin = view.origins.get(name);
      bindings.push({
        name,
        token: info.token,
        type: info.type,
        sizeBytes: info.sizeBytes,
        handleCallId: info.handleCallId,
        provenance: origin === undefined ? null : origin.via,
        provenanceAtMs: origin === undefined ? null : origin.at,
      });
    }
    bindings.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      bindings,
      // The `$N` capture system is deleted (0.4.0): the range is always
      // empty. Kept for report-shape compatibility with the older
      // manifest surface.
      logs: { first: null, last: null, count: 0 },
      evalSeq: view.evalSeq,
    };
  }

  private baselineKeys(): Set<string> {
    return this.baselineKeysSet;
  }

  private baselineLexicalKeys(): Set<string> {
    return this.baselineLexicalKeysSet;
  }

  /** Whether a baseline name's current type token differs from the
   *  fresh-realm baseline's (a user rebinding of the built-in). Trap-
   *  free: descriptor read only, never a `[[Get]]`. Same-type
   *  replacements (`Math = { userOwned: true }`) keep the token and
   *  are detected by the registry's changed-known list instead (see
   *  `manifest`) — the value identity the token cannot provide. */
  private baselineChanged(name: string): boolean {
    const baselineType = this.baselineTypes.get(name);
    if (baselineType === undefined) return false;
    try {
      return readRealmSlotTypeToken(this.vm, name) !== baselineType;
    } catch {
      return false;
    }
  }

  private defaultHandlers(): GuestBridgeHandlers {
    const events = this.consoleEventBuffer;
    const parked = this.parkedCallsBuffer;
    const parkedCheckpoints = this.parkedCheckpointCalls;
    const parkedKinds = this.parkedKinds;
    const parkedQuestions = this.parkedQuestions;
    const parkedModelSpecs = this.parkedModelSpecs;
    const parkedTasks = this.parkedTasks;
    const workspace = this;
    return {
      agent: (call, callId, modelSpec, task) => {
        parked.set(callId, call);
        parkedKinds.set(callId, 'agent');
        // The §4.5 agents() shape serves the call's REAL model spec and
        // task (the parking bridge keeps them verbatim; a later broker
        // that takes over the workspace reads them from the registry
        // surface).
        parkedModelSpecs.set(callId, modelSpec);
        parkedTasks.set(callId, task);
      },
      checkpoint: (call, callId, question, _optionsJson, answerJson) => {
        if (answerJson !== null) {
          // Answer mode: the orchestrator is delivering the user's answer
          // for a parked checkpoint. Find the matching pending checkpoint
          // (checkpoints are tracked SEPARATELY from parked agent/steer
          // calls — a checkpoint.answer must never settle an agent call
          // that shares the id space), parse the JSON answer, settle the
          // call, and report delivery. First-wins: the entry is removed
          // before settling, so a second delivery of the same id reports
          // false (unknown or already-answered), exactly like the guest's
          // idempotent settle-by-call-id. A malformed answer (a host-side
          // contract violation — the guest only sends JSON.stringify
          // output) rejects the call rather than parking the question
          // forever.
          const pending = parkedCheckpoints.get(callId);
          if (pending === undefined) return false;
          parkedCheckpoints.delete(callId);
          parked.delete(callId);
          parkedKinds.delete(callId);
          parkedQuestions.delete(callId);
          parkedModelSpecs.delete(callId);
          parkedTasks.delete(callId);
          let answer: unknown;
          try {
            answer = JSON.parse(answerJson);
          } catch {
            pending.reject(
              new Error(`checkpoint ${callId}: answer was not valid JSON`),
            );
            return true;
          }
          pending.resolve(answer);
          return true;
        }
        // Question mode: park the call in both tables — the general
        // parked-calls map (the no-backend state a later phase settles
        // or takes over) and the checkpoint table (answer delivery).
        parked.set(callId, call!);
        parkedCheckpoints.set(callId, call!);
        parkedKinds.set(callId, 'checkpoint');
        parkedQuestions.set(callId, question ?? '');
        return undefined;
      },
      steer: (call, callId) => {
        parked.set(callId, call);
        parkedKinds.set(callId, 'steer');
      },
      console: (event) => {
        events.push(event);
      },
      // The eval-plane helpers under the parking bridge: `sleep` is a
      // real host-side timer (the VM itself stays timer-free); the
      // introspection pair serve the parking state in the doc's §4.5
      // shapes (no backends attached — diagnostics are all empty);
      // `reset` marks the teardown the eval consumes after completing.
      sleep: (call, ms) => {
        const delay = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 2 ** 31 - 1) : 0;
        setTimeout(() => {
          try {
            call.resolve(undefined);
          } catch {
            // The workspace was disposed before the timer fired — the
            // call is gone with it; nothing to settle.
          }
        }, delay);
      },
      workspace: () => {
        const manifest = workspace.manifest();
        const inFlightIds: string[] = [];
        for (const id of parked.keys()) {
          if (!inFlightIds.includes(id)) inFlightIds.push(id);
        }
        return JSON.stringify({
          bindings: manifest.bindings.map((b) => ({
            name: b.name,
            type: b.type,
            sizeBytes: b.sizeBytes,
            provenance: b.provenance,
            task: null,
            ...(b.handleCallId !== null ? { callId: b.handleCallId } : {}),
            ...(b.handleCallId !== null
              ? { status: parked.has(b.handleCallId) ? 'pending' : 'settled' }
              : {}),
          })),
          inFlight: inFlightIds,
          checkpoints: [...parkedCheckpoints.keys()].map((id) => ({
            id,
            question: parkedQuestions.get(id) ?? '',
          })),
          diagnostics: { reconcile: null, drainError: null, childrenClosed: false },
        });
      },
      agents: () =>
        JSON.stringify(
          [...parked.entries()]
            .filter(([callId]) => parkedKinds.get(callId) === 'agent')
            .map(([callId]) => ({
              callId,
              // The §4.5 shape: the call's REAL model spec and task (the
              // parking bridge recorded them verbatim at issue — never
              // fabricated empties).
              modelSpec: parkedModelSpecs.get(callId) ?? '',
              task: parkedTasks.get(callId) ?? '',
              state: 'opening',
              supportsSteering: false,
              queuedSteers: 0,
            })),
        ),
      reset: () => {
        workspace.pendingReset = true;
      },
      defaultBackend: () => undefined,
    };
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error(`Workspace ${this.projectDir}: operation on a disposed workspace`);
    }
  }
}

/** The realm global's string-key set, trap-free (raw own-key read). */
function rawGlobalStringKeys(vm: ReplVm): string[] {
  const shim = getVmShim(vm) as QuickJS;
  return rawOwnKeys(shim.global);
}

/** The realm's GLOBAL LEXICAL string-key set, trap-free (the internal
 *  global-var object's own keys — top-level `let`/`const`/`class`
 *  declarations; see `global-lexical.ts`). */
function rawLexicalStringKeys(vm: ReplVm): string[] {
  return rawLexicalKeys(vm);
}

/** The union of two name lists, first-seen order (the manifest's
 *  binding namespace: global-object keys plus global lexical keys). */
function unionNames(a: string[], b: string[]): string[] {
  const seen = new Set<string>(a);
  const out = [...a];
  for (const name of b) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Options for a `WorkspaceRegistry`. */
export interface WorkspaceRegistryOptions {
  /**
   * WASM bytes or module shared as the default by every workspace the
   * registry creates (see `WasmInput` in `types.ts`). Defaults to the
   * shipped `quickjs.wasm` binary.
   */
  wasm?: WasmInput;
  /**
   * Default per-VM malloc limit in bytes for workspaces created without
   * their own `memoryLimit` (per-workspace limits override this).
   */
  memoryLimit?: number;
  /**
   * Default guest-bridge handlers for workspaces created without their
   * own `handlers` (per-workspace handlers override this). See
   * `WorkspaceOptions.handlers` for the default parking bridge.
   */
  handlers?: GuestBridgeHandlers;
}

/** An in-flight workspace creation, tracked so concurrent `get`s dedupe. */
interface PendingCreate {
  /** The creation promise every concurrent `get` for this key awaits. */
  promise: Promise<Workspace>;
  /**
   * Set by `dispose`/`disposeAll` to veto materialization: the created
   * workspace is torn down without being registered, and the waiting
   * caller's promise rejects.
   */
  cancelled: boolean;
}

/**
 * Project-keyed registry of workspaces, enforcing one VM per workspace.
 * This is the engine boundary the `repl` MCP tool (a later phase) calls:
 * the tool resolves its `projectDir` argument through here, exactly like
 * the daemon's project registry resolves project contexts for `workflow`.
 */
export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pending = new Map<string, PendingCreate>();
  private readonly options: WorkspaceRegistryOptions;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.options = options;
  }

  /**
   * Get the workspace for a project directory, creating it on first touch.
   * The same project directory always yields the same workspace (and thus
   * the same VM) for the lifetime of the registry.
   *
   * Concurrent first-touches of one key share a single in-flight creation
   * promise: exactly one VM is instantiated, and both callers receive the
   * same workspace. When concurrent callers pass different options, the
   * first caller's options win (first-touch-wins is the registry's
   * documented policy — the workspace exists once, so its configuration
   * is decided once).
   */
  async get(projectDir: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const existing = this.workspaces.get(projectDir);
    if (existing) return existing;

    // Deduplicate the in-flight creation itself — not just the completed
    // result (review regression: two concurrent first-touches each ran a
    // full `Workspace.create`, instantiating two VMs for one project).
    const flight = this.pending.get(projectDir);
    if (flight) return flight.promise;

    const pending: PendingCreate = { cancelled: false, promise: undefined! };
    const merged: WorkspaceOptions = {
      wasm: options.wasm ?? this.options.wasm,
      memoryLimit: options.memoryLimit ?? this.options.memoryLimit,
      handlers: options.handlers ?? this.options.handlers,
    };
    pending.promise = Workspace.create(projectDir, merged).then(
      (created) => {
        // Only remove our own entry: `dispose` may have removed it already
        // and a later `get` may have installed a fresh one.
        if (this.pending.get(projectDir) === pending) this.pending.delete(projectDir);
        if (pending.cancelled) {
          // `dispose`/`disposeAll` won the race: never materialize the
          // workspace. Tear the fresh VM down immediately — no VM is left
          // behind either way.
          created.dispose();
          throw new Error(`Workspace ${projectDir}: creation cancelled by dispose`);
        }
        this.workspaces.set(projectDir, created);
        return created;
      },
      (error) => {
        if (this.pending.get(projectDir) === pending) this.pending.delete(projectDir);
        throw error;
      },
    );
    this.pending.set(projectDir, pending);
    return pending.promise;
  }

  /** True when a workspace exists for this project directory. */
  has(projectDir: string): boolean {
    return this.workspaces.has(projectDir);
  }

  /** The number of live workspaces. */
  get size(): number {
    return this.workspaces.size;
  }

  /** The project directories with live workspaces. */
  keys(): string[] {
    return [...this.workspaces.keys()];
  }

  /**
   * Dispose and drop the workspace for a project directory. Returns true
   * when a live workspace was disposed. When only a creation is in flight
   * (no live workspace yet), it is cancelled: the created workspace is
   * torn down without materializing and the waiting `get` caller's promise
   * rejects — the invariant "dispose means the workspace is gone" holds
   * even under the race, and a later `get` creates a fresh workspace.
   */
  dispose(projectDir: string): boolean {
    const workspace = this.workspaces.get(projectDir);
    if (workspace) {
      this.workspaces.delete(projectDir);
      workspace.dispose();
      return true;
    }
    const flight = this.pending.get(projectDir);
    if (flight) {
      this.pending.delete(projectDir);
      flight.cancelled = true;
    }
    return false;
  }

  /** Dispose and drop every workspace; cancel every in-flight creation. */
  disposeAll(): void {
    for (const workspace of this.workspaces.values()) {
      workspace.dispose();
    }
    this.workspaces.clear();
    for (const flight of this.pending.values()) {
      flight.cancelled = true;
    }
    this.pending.clear();
  }
}
