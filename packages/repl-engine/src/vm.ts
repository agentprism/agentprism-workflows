/**
 * The QuickJS-in-WASM VM layer of the REPL engine.
 *
 * This module is the "runtime shim" tier of the roadmap doc's mapping
 * table (docs/roadmap/repl-orchestrator.md): `quickjs-wasi` is used as-is,
 * including the npm package's shipped `quickjs.wasm` binary (we never build
 * our own binary — snapshot portability with the harness is explicitly not
 * a goal, and the shipped binary keeps snapshots compatible across daemons
 * running the same quickjs-wasi version).
 *
 * What this layer adds on top of the shim:
 *
 * - **Wasm loading** — the shipped binary, resolved through the package's
 *   own export map and compiled once per process into a
 *   `WebAssembly.Module`, which quickjs-wasi recommends reusing across
 *   VM instantiations.
 * - **Eval with top-level `await`** — `EvalFlags.ASYNC`, the script-global
 *   REPL mode the harness pinned (R69): bindings persist on `globalThis`,
 *   sloppy mode, completion value = last expression, top-level `return`
 *   stays a syntax error (the parser's "return not in function" check is
 *   independent of the async flag). The eval returns a Promise whose
 *   fulfillment is an engine-created `{ value }` wrapper around the
 *   completion value.
 * - **The job drain** — the same pending-job loop quickjs-wasi's
 *   built-in `executePendingJobs()` runs (its own implementation is
 *   exactly `while (qjs_is_job_pending()) qjs_execute_pending_job()`),
 *   surfaced as `drainJobs()`. Because the interrupt stays armed across
 *   the drain (the wasm interrupt import fires per bytecode instruction,
 *   including inside drained jobs), a runaway microtask loop is bounded
 *   by the same handler that bounds the eval itself.
 * - **Per-VM `memoryLimit`** — passed straight through to
 *   `QuickJSOptions.memoryLimit` (quickjs-wasi built-in, `JS_SetMemoryLimit`).
 * - **Per-eval and per-drain `interruptHandler`** — quickjs-wasi's
 *   `interruptHandler` is a per-VM create-time option; the engine composes
 *   per-operation semantics on top of that built-in by installing one
 *   VM-level handler that delegates to a mutable per-operation slot. The
 *   slot is armed for the duration of one eval **or one standalone
 *   settlement drain** and restored afterwards, so handlers never leak
 *   across operations — and a settlement drain that resumes a suspended
 *   continuation carries its own interrupt signal (a continuation left
 *   queued by an interrupted drain would otherwise run with no protection).
 * - **Serialized VM operations** — `evalCode` performs **no `await`**:
 *   host execution is synchronous from the caller's perspective, so an
 *   eval cannot be interleaved with `dispose()` (review regression: the
 *   completion read used to yield through an already-settled host promise,
 *   and `const p = ws.eval('6*7'); ws.dispose(); await p` crashed reading
 *   nulled WASM exports) and the interrupt slot's save/restore cannot be
 *   reordered by concurrent evals (review regression: two overlapping
 *   evals restored out of nesting order and left a stale handler armed
 *   for later operations). An `opDepth` guard makes the serialization
 *   invariant structural, so a future host-callback path that tries to
 *   re-enter the VM fails loudly instead of corrupting the slot.
 * - **A trap-free evaluation and error boundary** — the doc's mandatory
 *   rule (transfer lesson R69): never execute guest getters while
 *   rendering guest state. This is enforced structurally, not by review
 *   discipline, because two quickjs-wasi paths would otherwise violate it:
 *   - `QuickJS.evalCode()` wraps synchronous failures (parse errors) in a
 *     `JSException` whose **constructor** performs guest-visible `[[Get]]`
 *     reads of `name`/`message`/`stack` on the guest exception — before
 *     any host `catch` can intercept. The engine therefore never calls
 *     `evalCode()`: it drives the same raw `qjs_eval` export (via the
 *     package's public `_getExports()`/`_writeString()` accessors) and
 *     handles a synchronous exception itself, with own-property-descriptor
 *     reads only.
 *   - `JSValueHandle.getOwnPropertyDescriptor()` throws a `JSException`
 *     when the C descriptor read fails (allocation edge), and that
 *     constructor runs the same guest-visible getters. The engine's own
 *     descriptor path drives `qjs_get_own_property_descriptor` directly,
 *     takes a failed read's exception value out of the runtime and frees
 *     it (never constructing `JSException`), and reads the descriptor
 *     object's own data properties through raw `qjs_get_prop_value` —
 *     OrdinaryGet on an engine-created plain object, so even a polluted
 *     `Object.prototype` cannot run guest code.
 *   - `QuickJS.executePendingJobs()` renders a job error through
 *     `exc.toString()`, a JavaScript string conversion that **executes
 *     guest code** (`toString()`/`valueOf()`/`Symbol.toPrimitive`, proxy
 *     traps). The engine's drain uses the same built-in job loop over the
 *     raw exports but reads the failed job's exception trap-free and
 *     reports it as a `DrainJobError` carrying `EvalErrorInfo`.
 *   - Proxies are never touched: a proxy fires traps on descriptor, key,
 *     and prototype reads, so every descriptor read is guarded with
 *     `isProxy` first (engine-level brand check, spoof-proof), and a
 *     thrown proxy reports a trap-free marker.
 *   - Every handle the engine takes from the shim is disposed — including
 *     the exception value of a failed eval, a failed descriptor read, and
 *     the `get`/`set` handles of accessor descriptors — so failed paths
 *     never accumulate guest memory inside a long-lived VM (both leaks
 *     were measured during review: a 1 MiB VM exhausted after ~4,018
 *     syntax errors / ~3,128 accessor completions).
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { EvalFlags, JSValueHandle, QuickJS } from 'quickjs-wasi';

import { classifyError, type EvalErrorInfo } from './errors.js';
import { noteWasmModuleHash } from './snapshot-envelope.js';
import { readOwnDataProperty, readValue, takeAndFreeException } from './trapfree.js';
import type { ReplSnapshot, WasmInput, WasmModule } from './types.js';

/** Options for creating a VM. */
export interface ReplVmOptions {
  /**
   * WASM bytes or a pre-compiled module (`WasmInput` — a self-contained
   * stand-in for `WebAssembly.Module | BufferSource`, see `types.ts`).
   * Defaults to the `quickjs-wasi` package's shipped `quickjs.wasm`
   * binary, resolved through the package export map and compiled once per
   * process.
   */
  wasm?: WasmInput;
  /**
   * Per-VM malloc limit in bytes (quickjs-wasi `memoryLimit` built-in).
   * When exceeded, allocations fail and surface as
   * `InternalError: out of memory` (an `EvalErrorInfo` with
   * `outOfMemory: true`). Defaults to `ReplVm.DEFAULT_MEMORY_LIMIT`.
   */
  memoryLimit?: number;
}

/** The per-job CONTINUATION-LEASE seam (the eval-break targeting
 *  identity — see the broker and `guest-library.ts`): the drain loop
 *  reads the guest library's continuation lease before each job (the VM
 *  is idle between jobs) and clears it after a job that started with
 *  one, so the lease is set exactly while a suspended eval's
 *  continuation segment executes (and during the library's
 *  lease-setting reaction that immediately precedes it). `cell.current`
 *  is the host-side mirror of the CURRENT job's lease — an interrupt
 *  handler consulted DURING the job reads it to learn which eval's
 *  continuation (if any) is executing. */
export interface ReplJobLease {
  /** Read the current continuation-lease token (string) or undefined. */
  read(): string | undefined;
  /** Clear the continuation lease (drain start, and after a job that
   *  started with one). */
  clear(): void;
  /** The host-side mirror of the current job's lease, set before each
   *  job executes. */
  cell: { current: string | undefined };
}

/** Options for a single eval. */
export interface ReplEvalOptions {
  /** Filename used in guest stack traces. Defaults to `'<repl>'`. */
  filename?: string;
  /**
   * Per-eval interrupt handler. The VM-level quickjs-wasi interrupt
   * handler (a built-in consulted by the wasm interrupt import, roughly
   * once per bytecode instruction) delegates to this slot while the eval
   * and its drain are running. Return `true` to abort execution with
   * `InternalError: interrupted` (`EvalErrorInfo.interrupted === true`).
   * The slot is restored to its previous value afterwards, so the handler
   * never leaks into later operations.
   */
  interruptHandler?: () => boolean;
  /**
   * An interrupt handler consulted ONLY by the eval's OWN job drain —
   * never by the eval code itself. The eval-break signal's direct-eval
   * seam: a suspended eval's continuation can be resumed by a
   * SYNCHRONOUS host-callback settlement (`checkpoint.answer` in a
   * later eval resolves the checkpoint's deferred right there), and
   * that resumed continuation executes inside the answering eval's own
   * drain — an execution the settlement-drain handler cannot reach.
   * The eval's own code deliberately never consults this handler: an
   * unrelated eval's code must never be broken by a signal armed
   * against another eval (the phase-E review rejection's leak).
   */
  drainInterruptHandler?: () => boolean;
  /**
   * The per-job continuation-lease plumbing (see `ReplJobLease`): the
   * drain loop maintains the lease mirror so the drain-phase interrupt
   * handler can tell WHICH eval's continuation is executing. The broker
   * passes its lease; a bare workspace passes none (no tracking).
   */
  jobLease?: ReplJobLease;
  /**
   * Called exactly once per eval, AFTER the script's synchronous code
   * phase and BEFORE the job drain. The code-phase boundary: the
   * script's synchronous execution — including every synchronous host
   * callback it made — has finished, and the drain phase (which runs
   * the continuations the code phase queued) is next. The callback
   * runs while the VM is idle (the code phase returned; no guest code
   * is on the stack), so the caller may perform host-side VM reads.
   */
  beforeDrain?: () => void;
  /**
   * Attach the engine's uncaught-rejection bridge when the eval SUSPENDS
   * (its completion promise is still pending after the drain): the bridge
   * — `p.then(undefined, err => console.error(err))` — routes a late
   * rejection of the completion promise into the ordinary console bridge,
   * so it surfaces as an error-level console line in the next tool
   * result instead of vanishing (the doc's transfer lesson 3: "late
   * uncaught rejections surface as error-level console lines in the next
   * tool result"). Attached only on the pending arm; a completion that
   * resolves is dropped exactly as a `.then` continuation's would be, and
   * one that rejects within the drain is the eval's ordinary error
   * outcome. Best-effort by contract: the bridge call runs guest code
   * (`Promise.prototype.then`), which a hostile realm may have sabotaged
   * — a throw there is taken out and freed and the pending outcome is
   * reported unchanged (the harness's stance: a root that sabotages
   * `Promise.prototype.then` is sabotaging only itself).
   */
  rejectionBridge?: boolean;
}

/** Options for a standalone settlement drain (`ReplVm.drainJobs`). */
export interface ReplDrainOptions {
  /**
   * Interrupt handler armed for the duration of this drain. A suspended
   * eval's handler is removed when the eval returns, so a later settlement
   * drain that resumes a runaway continuation must carry its own signal —
   * without one, the continuation would run with no interrupt protection.
   * Return `true` to abort the drained job with
   * `InternalError: interrupted` (surfaced as a `DrainJobError`).
   */
  interruptHandler?: () => boolean;
  /**
   * The per-job continuation-lease plumbing (see `ReplJobLease`): the
   * drain loop maintains the lease mirror so the drain's interrupt
   * handler can tell WHICH eval's continuation is executing. The broker
   * passes its lease; a bare workspace passes none (no tracking).
   */
  jobLease?: ReplJobLease;
}

/**
 * The outcome of one eval, after the job drain:
 *
 * - `{ kind: 'value', value }` — the eval's completion promise fulfilled
 *   within the drain; `value` is the trap-free read of the completion
 *   value (a shallow read; the ObjectPreview rendering that the tool
 *   result eventually carries is a later phase's job).
 * - `{ kind: 'pending' }` — the completion promise is still pending after
 *   the drain (a top-level `await` suspended on an unsettled promise).
 *   The harness's pinned shape: no fabricated value; the continuation
 *   resumes at settlement like a `.then`.
 * - `{ kind: 'error', error }` — the eval threw (synchronously, via a
 *   rejected completion promise, or via a job error during the drain —
 *   the typical drain error is the per-eval interrupt firing inside a
 *   drained continuation).
 */
export type ReplEvalOutcome =
  | { kind: 'value'; value: unknown }
  | { kind: 'pending' }
  | { kind: 'error'; error: EvalErrorInfo };

/**
 * A job-drain failure, carrying trap-free error info.
 *
 * quickjs-wasi's own `executePendingJobs()` renders the failed job's
 * exception through `exc.toString()` — a JavaScript string conversion
 * that executes guest code (`toString`/`valueOf`/`Symbol.toPrimitive`,
 * proxy traps). The engine's drain reads the exception value
 * own-property-descriptor-wise instead, so the message is built from
 * `EvalErrorInfo` data and no guest code runs while a drain error is
 * reported.
 */
export class DrainJobError extends Error {
  /** Trap-free structured information about the failed job's exception. */
  readonly info: EvalErrorInfo;

  constructor(info: EvalErrorInfo) {
    super(`Job execution error: ${info.name}: ${info.message}`);
    this.name = 'DrainJobError';
    this.info = info;
  }
}

/**
 * The result of the trap-free eval call: a live promise handle, or a
 * trap-free report of a synchronous (parse/compile) failure.
 */
type EvalResult =
  | { kind: 'ok'; handle: JSValueHandle }
  | { kind: 'error'; error: EvalErrorInfo };

// The shipped binary is compiled once per process and reused across VM
// instantiations (the pattern quickjs-wasi's README recommends).
let shippedModule: Promise<WasmModule> | null = null;

// The structured-clone extension (.so) is loaded once per process and
// attached to every VM: the guest library's $N freezing uses
// `structuredClone` (the roadmap doc pins the mechanism), and the
// extension travels in snapshots, so the restore path must attach the same
// byte-identical artifact it was snapshotted with (quickjs-wasi restores
// extension memory against the descriptors it was created with).
let structuredCloneExtension: Promise<Uint8Array> | null = null;

async function loadStructuredCloneExtension(): Promise<Uint8Array> {
  structuredCloneExtension ??= (async () => {
    // Resolved through the package export map, like the shipped wasm
    // binary (`quickjs-wasi/structured-clone.so`).
    const resolved = import.meta.resolve('quickjs-wasi/structured-clone.so');
    return readFile(new URL(resolved));
  })();
  return structuredCloneExtension;
}

/**
 * Load the `quickjs-wasi` package's shipped `quickjs.wasm` binary and
 * compile it into a reusable module (typed as `WasmModule`, the opaque
 * stand-in for `WebAssembly.Module` — see `types.ts`).
 *
 * The binary's sha256 is recorded against the compiled module in the
 * envelope registry (`noteWasmModuleHash` — see `snapshot-envelope.ts`):
 * the at-rest snapshot envelope records which binary laid out the VM
 * memory, and the restore path compares that recorded hash against the
 * module it restores with. `loadShippedWasm` is the ONLY producer of
 * `WasmModule` values, so the registry covers every compiled module the
 * engine can be asked to hash.
 */
export function loadShippedWasm(): Promise<WasmModule> {
  shippedModule ??= (async () => {
    const resolved = import.meta.resolve('quickjs-wasi/quickjs.wasm');
    const bytes = await readFile(new URL(resolved));
    // The engine is the only producer of `WasmModule` values: the real
    // `WebAssembly.Module` is branded opaque at this boundary so consumers
    // cannot fabricate `WasmInput` values that would fail at runtime.
    const module = (await WebAssembly.compile(bytes)) as unknown as WasmModule;
    noteWasmModuleHash(module, createHash('sha256').update(bytes).digest('hex'));
    return module;
  })();
  return shippedModule;
}

/**
 * A QuickJS-in-WASM VM with the REPL engine's eval/drain semantics.
 *
 * One `ReplVm` backs exactly one workspace; the workspace owns its
 * lifecycle (`create` → `evalCode`/`drainJobs` → `dispose`).
 *
 * All operations are serialized: `evalCode` and `drainJobs` are
 * synchronous from the caller's perspective (no `await` between arming
 * the interrupt slot and restoring it), so operations can never interleave
 * with each other or with `dispose()`.
 */
export class ReplVm {
  /** Default per-VM malloc limit when the caller configures none. */
  static readonly DEFAULT_MEMORY_LIMIT = 64 * 1024 * 1024;

  private readonly vm: QuickJS;
  private readonly memoryLimitBytes: number;
  private readonly interruptSlot: { current: (() => boolean) | null };
  /** Active-operation depth; > 0 means a VM operation is running. */
  private opDepth = 0;
  private disposed = false;

  private constructor(
    vm: QuickJS,
    memoryLimitBytes: number,
    interruptSlot: { current: (() => boolean) | null },
  ) {
    this.vm = vm;
    this.memoryLimitBytes = memoryLimitBytes;
    this.interruptSlot = interruptSlot;
    // The bridge and previewer modules drive the shim through this
    // module-scoped map (see `getVmShim`): the public type graph must stay
    // free of quickjs-wasi types, because a consumer with a non-DOM lib
    // and `skipLibCheck: false` type-checks the published declarations
    // cleanly — quickjs-wasi's own declarations need DOM globals.
    vmShims.set(this, vm);
  }

  /**
   * Create a fresh VM. The wasm module (shipped binary by default) may be
   * shared across VMs; each VM gets its own isolated runtime and context.
   */
  static async create(options: ReplVmOptions = {}): Promise<ReplVm> {
    const wasm = options.wasm ?? (await loadShippedWasm());
    const memoryLimitBytes = options.memoryLimit ?? ReplVm.DEFAULT_MEMORY_LIMIT;

    // quickjs-wasi's `interruptHandler` is a per-VM create-time option; the
    // per-operation semantics are composed on top of the built-in by
    // delegating through a slot that `evalCode`/`drainJobs` arm per call
    // (see the module docs). The slot object is captured by the VM-level
    // closure, so it must be shared with the instance rather than assigned
    // after creation.
    const interruptSlot: { current: (() => boolean) | null } = { current: null };
    const vm = await QuickJS.create({
      wasm,
      memoryLimit: memoryLimitBytes,
      // The structured-clone extension ships with the quickjs-wasi package
      // and is attached to every VM: the guest library's console bridge
      // freezes logged values into the $N store via `structuredClone` (the
      // roadmap doc's pinned mechanism). The extension also travels inside
      // snapshots, so `restore()` attaches the same artifact.
      extensions: [{ name: 'structured-clone', wasm: await loadStructuredCloneExtension() }],
      interruptHandler: () => interruptSlot.current?.() ?? false,
    });

    return new ReplVm(vm, memoryLimitBytes, interruptSlot);
  }

  /**
   * Restore a VM from a quickjs-wasi snapshot (the same wasm build and the
   * same structured-clone extension it was snapshotted with). Host
   * callbacks are NOT restored by the shim — the caller re-registers them
   * by name (the roadmap doc's restore path: a quickjs-wasi built-in) and
   * then reconciles the in-VM pending-call registry through the guest
   * library's reconciliation surface.
   *
   * Snapshot compatibility holds only across the same quickjs-wasi package
   * version (the doc's rule: a version bump must refuse old snapshots
   * loudly, never restore them silently); the at-rest identity envelope is
   * a later phase's concern.
   */
  static async restore(snapshot: ReplSnapshot, options: ReplVmOptions = {}): Promise<ReplVm> {
    const wasm = options.wasm ?? (await loadShippedWasm());
    const memoryLimitBytes = options.memoryLimit ?? ReplVm.DEFAULT_MEMORY_LIMIT;

    const interruptSlot: { current: (() => boolean) | null } = { current: null };
    const vm = await QuickJS.restore(snapshot, {
      wasm,
      memoryLimit: memoryLimitBytes,
      extensions: [{ name: 'structured-clone', wasm: await loadStructuredCloneExtension() }],
      interruptHandler: () => interruptSlot.current?.() ?? false,
    });

    return new ReplVm(vm, memoryLimitBytes, interruptSlot);
  }


  /** The configured malloc limit in bytes (per-VM, set at create time). */
  get memoryLimit(): number {
    return this.memoryLimitBytes;
  }

  /** True once `dispose()` has been called. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Run one script: evaluate with top-level-await semantics, drain the
   * microtask/job queue, and report the completion.
   *
   * The returned promise is fulfilled **synchronously** — the body performs
   * no `await`, so the eval cannot be interleaved with `dispose()` or with
   * another eval (the interrupt-slot save/restore and the raw handle reads
   * are atomic with respect to every other VM operation). The whole
   * boundary is trap-free: a synchronous parse failure never passes through
   * quickjs-wasi's `JSException` constructor (which performs guest-visible
   * `[[Get]]` reads), a failed descriptor read never constructs one either,
   * and a drain failure never passes through its `toString()`-based error
   * rendering — see the module docs.
   */
  async evalCode(code: string, options: ReplEvalOptions = {}): Promise<ReplEvalOutcome> {
    const { outcome, completion } = this.evalCodeWithCompletion(code, options);
    // The completion handle is owned by the caller of
    // evalCodeWithCompletion — this public entry discards it, so it must
    // dispose it (review regression: a resolved eval with
    // `rejectionBridge: true` used to leak the handle — an adversarial
    // 2 MiB VM probe died at eval ~19,346). Rejection bridging is
    // decided by `options.rejectionBridge` alone (see
    // `evalCodeWithCompletion`): a caller that wants the bridge does not
    // thereby own a completion handle.
    if (completion !== undefined) (completion as JSValueHandle).dispose();
    return outcome;
  }

  /**
   * The package-internal eval entry the broker layer drives: like
   * `evalCode`, but the completion handle is returned alongside the
   * shallow snapshot read (`completion`, OWNED BY THE CALLER — the
   * caller must dispose it). For a RESOLVED eval it is the live
   * completion-value handle the broker previews for the tool result's
   * `result` line; for a PENDING eval (the completion suspended on a
   * host call) it is the eval WRAPPER promise handle — the broker's
   * active-eval tracking probe: the wrapper stays pending while the
   * eval's continuation is in flight and settles when the continuation
   * completes or is broken (phase-E review rejection: the pending
   * completion used to be dropped, so the workspace had no host-side
   * notion of "an eval is running" and the interrupt tool could not
   * target it). For `error` outcomes `completion` is undefined and the
   * caller owns nothing. The published type graph never names the
   * handle type: this method is not re-exported from the package index
   * (the bridge's `getVmShim` precedent), and `completion` is typed
   * `unknown` so the declaration stays self-contained.
   */
  evalCodeWithCompletion(
    code: string,
    options: ReplEvalOptions = {},
  ): { outcome: ReplEvalOutcome; completion?: unknown; interruptedInDrain?: boolean } {
    this.assertAlive();
    this.assertNotReentrant();

    // Rejection bridging and completion ownership are SEPARATE decisions
    // (review regression: they used to be one flag, so a resolved eval
    // leaked its completion wrapper and a discarded completion was never
    // disposed): the bridge attaches to a SUSPENDED completion when
    // `rejectionBridge` is set; the live completion handle is returned
    // to this internal entry's caller on every resolved eval, and the
    // caller (the broker, or `evalCode` which disposes it) owns it.
    const attachBridge = options.rejectionBridge === true;

    // Arm the per-eval interrupt slot for the whole operation (eval + its
    // drain). Because the body below is synchronous, this save/restore
    // cannot be reordered by a concurrent eval: operations serialize.
    const previousInterrupt = this.interruptSlot.current;
    const evalHandler = options.interruptHandler ?? null;
    this.interruptSlot.current = evalHandler;
    this.opDepth++;
    let handle: JSValueHandle | undefined;
    try {
      const evaluated = this.evalTrapFree(code, options.filename ?? '<repl>', EvalFlags.ASYNC);
      if (evaluated.kind === 'error') {
        return { outcome: { kind: 'error', error: evaluated.error } };
      }
      handle = evaluated.handle;
      // The drain phase arms the eval's own handler PLUS the drain-phase
      // extra handler (see `ReplEvalOptions.drainInterruptHandler`): a
      // continuation resumed by a synchronous host-callback settlement
      // (a checkpoint answer) executes here and must be breakable by the
      // armed interrupt signal even though the eval's own code never
      // consults it.
      this.interruptSlot.current =
        options.drainInterruptHandler === undefined
          ? evalHandler
          : evalHandler === null
            ? options.drainInterruptHandler
            : () => evalHandler() || options.drainInterruptHandler!();
      // The code-phase boundary (see `ReplEvalOptions.beforeDrain`): the
      // script's synchronous execution — including every synchronous
      // host callback it made — has finished, and the drain phase (which
      // runs the continuations the code phase queued) is next. The VM is
      // idle here, so the callback may touch the VM.
      options.beforeDrain?.();
      try {
        this.runDrain(options.jobLease);
      } catch (e) {
        if (e instanceof DrainJobError) {
          // The drain was INTERRUPTED (the armed eval-break signal, or
          // the per-eval deadline): the interrupted continuation's
          // engine wrapper never settles (the quickjs interrupt aborts
          // the async job without rejecting its promise), so the
          // caller — the broker — must release its tracked running eval
          // (exactly like the pump path's `noteInterruptedDrain`). The
          // flag distinguishes this from a code-phase interrupt (the
          // fresh eval's own code hitting the deadline), which affects
          // no tracked eval.
          return { outcome: { kind: 'error', error: e.info }, interruptedInDrain: true };
        }
        throw e; // host-side failure, not a guest outcome — fail loudly
      }
      return this.readCompletion(handle, true, attachBridge);
    } finally {
      // The wrapper is disposed here on every arm except the retained-
      // pending one: `readCompletion` returns a DUP for the retained
      // arm (the caller owns it) and disposes the original itself, so
      // this dispose is either a no-op (the value arm already disposed
      // it) or the genuine release (the error/DrainJobError arms).
      handle?.dispose();
      this.interruptSlot.current = previousInterrupt;
      this.opDepth--;
    }
  }

  /**
   * Run the job drain loop: execute all pending microtask jobs (promise
   * reactions, resumed top-level-await continuations). This is
   * quickjs-wasi's built-in `executePendingJobs()` loop driven over the
   * package's own exports (`qjs_is_job_pending` / `qjs_execute_pending_job`
   * — the built-in's implementation is exactly that loop).
   *
   * A suspended eval's per-eval handler is removed when the eval returns;
   * this standalone drain therefore arms **its own** interrupt signal for
   * its duration (`options.interruptHandler`), so a continuation left
   * queued by an interrupted eval — or resumed by host-side settlement
   * (subagent calls in a later phase) — cannot run away unguarded.
   *
   * The one deliberate difference from the built-in: a failed job's
   * exception is read trap-free and thrown as a `DrainJobError` instead of
   * being rendered through `toString()`, which would execute guest code.
   * Returns the number of jobs executed.
   */
  drainJobs(options: ReplDrainOptions = {}): number {
    this.assertAlive();
    this.assertNotReentrant();

    const previousInterrupt = this.interruptSlot.current;
    this.interruptSlot.current = options.interruptHandler ?? null;
    this.opDepth++;
    try {
      return this.runDrain(options.jobLease);
    } finally {
      this.interruptSlot.current = previousInterrupt;
      this.opDepth--;
    }
  }

  /** Dispose the VM, releasing the WASM instance. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.interruptSlot.current = null;
    this.vm.dispose();
  }

  /** Support for `using` declarations (Explicit Resource Management). */
  [Symbol.dispose](): void {
    this.dispose();
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error('ReplVm: eval/drain on a disposed VM');
    }
  }

  /**
   * VM operations are serialized (an op is synchronous and cannot nest).
   * This guard makes that invariant structural: a future host-callback
   * path that re-enters the VM mid-operation fails loudly here instead of
   * corrupting the interrupt slot.
   */
  private assertNotReentrant(): void {
    if (this.opDepth > 0) {
      throw new Error('ReplVm: reentrant VM operation (eval/drain while an operation is active)');
    }
  }

  /**
   * Evaluate one script through the raw `qjs_eval` export, never through
   * `QuickJS.evalCode()`: quickjs-wasi's wrapper converts a synchronous
   * failure into a `JSException` whose constructor performs guest-visible
   * `[[Get]]` reads of `name`/`message`/`stack` on the guest exception —
   * a getter installed on `SyntaxError.prototype.name` executes during
   * error construction, before any host `catch` could intercept it. Here
   * the exception value is read own-property-descriptor-wise (see
   * `readErrorInfo`) and freed immediately, so the eval/error boundary
   * cannot invoke guest getters.
   */
  private evalTrapFree(code: string, filename: string, flags: number): EvalResult {
    const e = this.vm._getExports();
    const codeStr = this.vm._writeString(code);
    const fnStr = this.vm._writeString(filename);
    const resultPtr = e.qjs_eval(codeStr.ptr, codeStr.len, fnStr.ptr, flags);
    e.wasm_free(codeStr.ptr);
    e.wasm_free(fnStr.ptr);
    if (e.qjs_is_exception(resultPtr) !== 0) {
      // Synchronous eval failure (parse/compile errors — with
      // `EvalFlags.ASYNC`, runtime throws surface as a rejected completion
      // promise instead). Mirror the shim's `throwIfException` ordering:
      // take the exception value out of the runtime first, then free the
      // exception-sentinel result.
      const exc = new JSValueHandle(this.vm, e.qjs_get_exception());
      e.qjs_free_value(resultPtr);
      try {
        return { kind: 'error', error: readErrorInfo(exc) };
      } finally {
        exc.dispose();
      }
    }
    return { kind: 'ok', handle: new JSValueHandle(this.vm, resultPtr) };
  }

  /**
   * Read the completion of an already-drained eval promise. **Fully
   * synchronous**: for a settled promise the result is taken straight from
   * the runtime via the raw `qjs_promise_result` export — never through
   * `resolvePromise()`, whose host promise yields through the microtask
   * queue even when it is already settled. That yield is what let
   * `dispose()` interleave with an in-flight eval (review regression:
   * `const p = ws.eval('6*7'); ws.dispose(); await p` crashed with
   * `TypeError: Cannot read properties of null (reading 'qjs_is_proxy')`
   * once the WASM exports were nulled); a synchronous read makes the race
   * structurally impossible.
   *
   * With `keepCompletion` the resolved arm returns the live completion
   * VALUE handle (the engine-created `{ value }` wrapper unwrapped
   * trap-free via its own descriptor — the broker previews the value, not
   * the wrapper), owned by the caller; the wrapper itself is disposed on
   * that path (review regression: it used to be retained, so every
   * resolved eval leaked it — a 2 MiB VM died at eval ~19,346). The
   * pending arm attaches the uncaught-rejection bridge first when
   * `attachBridge` is set (see `ReplEvalOptions.rejectionBridge`) —
   * bridging is independent of completion ownership, so a caller that
   * discards the completion (public `evalCode`) still gets the bridge
   * and never leaks the handle.
   */
  private readCompletion(
    handle: JSValueHandle,
    keepCompletion: boolean,
    attachBridge: boolean,
  ): { outcome: ReplEvalOutcome; completion?: unknown } {
    try {
      // 0 pending, 1 fulfilled, 2 rejected (quickjs-wasi built-in
      // `promiseState`).
      const state = handle.promiseState;
      if (state === 0) {
        if (attachBridge) this.attachRejectionBridge(handle);
        if (keepCompletion) {
          // Retained-pending arm: the caller owns a DUP of the wrapper
          // promise handle (the completion stays pending — the eval
          // suspended on a host call; its continuation runs at a later
          // settlement drain, and the wrapper settles when the
          // continuation completes or is broken — the broker's
          // active-eval probe). The original is disposed by the finally
          // below like every other arm.
          return { outcome: { kind: 'pending' }, completion: handle.dup() };
        }
        return { outcome: { kind: 'pending' } };
      }
      // For settled promises `qjs_promise_result` returns a new owned
      // reference to the promise's result: the `{ value }` completion
      // wrapper on fulfillment, the raw thrown value on rejection.
      const resultPtr = this.vm._getExports().qjs_promise_result(handle.ptr);
      const result = new JSValueHandle(this.vm, resultPtr);
      // `result` is disposed in the finally unless the caller took
      // ownership of it (the wrapper-as-completion fallback below).
      let callerOwnsWrapper = false;
      try {
        if (state === 2) {
          return { outcome: { kind: 'error', error: readErrorInfo(result) } };
        }
        // Trap-free unwrap of the engine-created `{ value }` wrapper — an
        // own-data-property descriptor read, never `[[Get]]` (R69: a guest
        // `Object.prototype.value` pollution must not be able to hijack
        // eval results). When the wrapper shape is unexpected (the
        // pollution quirk the README pins: the engine's [[Set]] silently
        // no-ops, leaving the wrapper with no own `value`), the wrapper
        // itself is read so the caller always sees *a* value.
        const valueHandle = readOwnDataProperty(result, 'value');
        const snapshot =
          valueHandle === undefined ? readValue(result, 0, new Set()) : readValue(valueHandle, 0, new Set());
        if (keepCompletion) {
          if (valueHandle !== undefined) {
            // The caller owns the unwrapped value handle; the wrapper is
            // disposed by the finally below.
            return { outcome: { kind: 'value', value: snapshot }, completion: valueHandle };
          }
          callerOwnsWrapper = true;
          return { outcome: { kind: 'value', value: snapshot }, completion: result };
        }
        valueHandle?.dispose();
        return { outcome: { kind: 'value', value: snapshot } };
      } finally {
        if (!callerOwnsWrapper) result.dispose();
      }
    } finally {
      handle.dispose();
    }
  }

  /**
   * The uncaught-rejection bridge for a suspended eval completion (the
   * doc's transfer lesson 3): attach `p.then(undefined, err =>
   * console.error(err))` so a late rejection of the completion promise
   * travels the ordinary console bridge — frozen into a `$N`, previewed
   * under the existing rules, delivered at the settlement drain's natural
   * point — never a new intent-plane surface. Best-effort: the bridge
   * script is evaluated with the engine's own trap-free eval, the call's
   * result (including an exception result, whose runtime exception is
   * taken out and freed) is disposed, and any failure leaves the pending
   * outcome unchanged.
   */
  private attachRejectionBridge(handle: JSValueHandle): void {
    const e = this.vm._getExports();
    let bridge: JSValueHandle | undefined;
    try {
      const evaluated = this.evalTrapFree(
        '(p) => { p.then(undefined, (err) => { console.error(err); }); }',
        '<repl-rejection-bridge>',
        0,
      );
      if (evaluated.kind === 'error') return;
      bridge = evaluated.handle;
      // Raw `qjs_call` with one borrowed argument (the completion promise);
      // the result — including an exception result — is disposed here.
      const argv = e.wasm_malloc(4);
      let resultPtr: number;
      try {
        new DataView(e.memory.buffer).setUint32(argv, handle.ptr, true);
        resultPtr = e.qjs_call(bridge.ptr, this.vm.undefined.ptr, 1, argv);
      } finally {
        e.wasm_free(argv);
      }
      const result = new JSValueHandle(this.vm, resultPtr);
      try {
        if (e.qjs_is_exception(result.ptr) !== 0) {
          // The guest sabotaged `Promise.prototype.then`; the rejection
          // bridge cannot be attached — the pending outcome is unchanged.
          takeAndFreeException(e, this.vm);
        }
      } finally {
        result.dispose();
      }
    } finally {
      bridge?.dispose();
    }
  }

  /**
   * The pending-job loop shared by `evalCode` (with the eval's armed
   * handler) and `drainJobs` (with the drain's own armed handler). A
   * failed job's exception is read trap-free and thrown as a
   * `DrainJobError`; the drain stops at the first failure, so jobs queued
   * after it remain pending for a later drain.
   *
   * With a `jobLease` (see `ReplJobLease`) the loop maintains the
   * continuation-lease mirror: the guest lease is cleared at drain start
   * (a stale lease left by an interrupted drain must never leak into this
   * drain's first job), read before each job into `cell.current` (the
   * interrupt handler consulted during the job reads the mirror), and
   * cleared again after a job that started with one. The guest library's
   * lease-setting reaction sets the lease DURING its own job, so the job
   * AFTER it — the eval's continuation segment — starts with the lease
   * set, and the segment's end (the next loop iteration) clears it: the
   * lease is set exactly while the segment executes.
   */
  private runDrain(lease?: ReplJobLease): number {
    const e = this.vm._getExports();
    let count = 0;
    lease?.clear();
    if (lease !== undefined) lease.cell.current = undefined;
    while (e.qjs_is_job_pending() !== 0) {
      // The current job's lease, read between jobs (the VM is idle).
      const jobLease = lease?.read();
      if (lease !== undefined) lease.cell.current = jobLease;
      const result = e.qjs_execute_pending_job();
      // The lease-carrying job ended: clear the guest lease so a later
      // job (or a later drain) never starts under a stale lease. The
      // mirror keeps the value until the next job's read — the only
      // reader (the interrupted-drain release) runs right after the
      // drain throws.
      if (jobLease !== undefined) lease?.clear();
      if (result < 0) {
        // The failed job's exception is the runtime's current exception.
        // `qjs_get_exception` moves it out (the runtime's slot is cleared,
        // exactly like the shim's `executePendingJobs`), so the handle owns
        // the only reference; the VM stays usable after it is disposed.
        const exc = new JSValueHandle(this.vm, e.qjs_get_exception());
        try {
          throw new DrainJobError(readErrorInfo(exc));
        } finally {
          exc.dispose();
        }
      }
      count++;
    }
    return count;
  }
}

/**
/**
 * Trap-free error info: name/message/stack are read as own data
 * properties; primitives thrown as values convert natively (strings and
 * bigints as themselves, booleans as `'true'`/`'false'`, numbers as their
 * native string form, symbols as the bare brand `Symbol`). Guest getters are
 * never invoked while rendering the error.
 *
 * Two adversarial shapes are guarded before any descriptor/prototype
 * inspection: a thrown **proxy** would fire traps on every descriptor and
 * prototype read (review measured three traps from one thrown proxy), and
 * an error whose **prototype is a proxy** (`Object.setPrototypeOf`)
 * would fire its traps on the prototype's `name` read. Both report a
 * trap-free marker instead: `[Proxy]` for a thrown proxy, a fallback
 * `name` (`'Error'`) when the real name lives behind an accessor or a
 * proxy and is therefore unreachable without running guest code.
 */
function readErrorInfo(handle: JSValueHandle): EvalErrorInfo {
  // A proxy fires traps on descriptor, key, and prototype reads. Never
  // touch one while rendering an error: report a trap-free marker.
  if (handle.isProxy) return classifyError('Error', '[Proxy]');
  if (handle.isUndefined) return classifyError('Error', 'undefined');
  if (handle.isNull) return classifyError('Error', 'null');

  const t = handle.typeof;
  if (t !== 'object' && t !== 'function') {
    let message: string;
    switch (t) {
      case 'string':
        message = handle.toString();
        break;
      case 'bigint':
        message = handle.toBigInt().toString();
        break;
      case 'symbol':
        // FORMAT.md §1.1/§5.7: a symbol's description sits behind
        // `qjs_get_symbol_description`, which invokes guest `Symbol.keyFor`
        // — a forbidden seam (guest code would run, and a guest that
        // replaces `Symbol.keyFor` could forge the classification). The
        // bare brand is the only trap-free rendering.
        message = 'Symbol';
        break;
      default:
        message = String(t === 'boolean' ? handle.toString() === 'true' : handle.toNumber());
        break;
    }
    return classifyError('Error', message);
  }

  let nameHandle: JSValueHandle | undefined;
  let messageHandle: JSValueHandle | undefined;
  let stackHandle: JSValueHandle | undefined;
  let protoHandle: JSValueHandle | undefined;
  try {
    nameHandle = readOwnDataProperty(handle, 'name');
    messageHandle = readOwnDataProperty(handle, 'message');
    stackHandle = readOwnDataProperty(handle, 'stack');
    let name = nameHandle && nameHandle.typeof === 'string' ? nameHandle.toString() : undefined;
    if (name === undefined && handle.isError) {
      // Error constructor names live on the error prototype (`name` is not
      // an own property of error instances in quickjs-ng). Reading the
      // prototype's own data property stays trap-free: getPrototypeOf fires
      // no traps on real errors, and the descriptor read never invokes a
      // getter. The prototype may itself be a proxy (errors are ordinary
      // objects — `Object.setPrototypeOf` works), so it is guarded before
      // inspection; an accessor `name` (guest-installed getter) reads as
      // absent and the name falls back to `'Error'` — never invoked.
      protoHandle = handle.getPrototypeOf();
      if (
        protoHandle &&
        !protoHandle.isNull &&
        !protoHandle.isUndefined &&
        !protoHandle.isProxy
      ) {
        const protoName = readOwnDataProperty(protoHandle, 'name');
        if (protoName) {
          try {
            if (protoName.typeof === 'string') name = protoName.toString();
          } finally {
            protoName.dispose();
          }
        }
      }
    }
    const message =
      messageHandle && messageHandle.typeof === 'string' ? messageHandle.toString() : '';
    const stack =
      stackHandle && stackHandle.typeof === 'string' ? stackHandle.toString() : undefined;
    return classifyError(name ?? 'Error', message, stack);
  } finally {
    nameHandle?.dispose();
    messageHandle?.dispose();
    stackHandle?.dispose();
    protoHandle?.dispose();
  }
}

/**
 * Module-scoped shim registry, populated by the `ReplVm` constructor (see
 * there for why the public type graph must not name quickjs-wasi types).
 * WeakMap: disposed VMs drop out with their instances.
 */
const vmShims = new WeakMap<ReplVm, unknown>();

/**
 * The underlying quickjs-wasi instance of a VM. **Internal** — the bridge
 * and previewer modules cast this to the shim's `QuickJS`; not part of the
 * package's public API (not re-exported from the index). The `unknown`
 * return keeps quickjs-wasi types out of the published declarations.
 */
export function getVmShim(vm: ReplVm): unknown {
  return vmShims.get(vm);
}
