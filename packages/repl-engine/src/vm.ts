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

import { readFile } from 'node:fs/promises';

import { EvalFlags, JSValueHandle, QuickJS } from 'quickjs-wasi';

import { classifyError, type EvalErrorInfo } from './errors.js';
import type { WasmInput, WasmModule } from './types.js';

/** The raw WASM exports the engine drives (the type is not exported by the shim). */
type QuickJSExports = ReturnType<QuickJS['_getExports']>;

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

/** Maximum nesting depth of the trap-free completion-value read. */
const READ_DEPTH_LIMIT = 4;
/** Maximum own enumerable data properties read per object/array level. */
const READ_PROP_LIMIT = 256;

// The shipped binary is compiled once per process and reused across VM
// instantiations (the pattern quickjs-wasi's README recommends).
let shippedModule: Promise<WasmModule> | null = null;

/**
 * Load the `quickjs-wasi` package's shipped `quickjs.wasm` binary and
 * compile it into a reusable module (typed as `WasmModule`, the opaque
 * stand-in for `WebAssembly.Module` — see `types.ts`).
 */
export function loadShippedWasm(): Promise<WasmModule> {
  shippedModule ??= (async () => {
    const resolved = import.meta.resolve('quickjs-wasi/quickjs.wasm');
    const bytes = await readFile(new URL(resolved));
    // The engine is the only producer of `WasmModule` values: the real
    // `WebAssembly.Module` is branded opaque at this boundary so consumers
    // cannot fabricate `WasmInput` values that would fail at runtime.
    return WebAssembly.compile(bytes) as unknown as WasmModule;
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
    this.assertAlive();
    this.assertNotReentrant();

    // Arm the per-eval interrupt slot for the whole operation (eval + its
    // drain). Because the body below is synchronous, this save/restore
    // cannot be reordered by a concurrent eval: operations serialize.
    const previousInterrupt = this.interruptSlot.current;
    this.interruptSlot.current = options.interruptHandler ?? null;
    this.opDepth++;
    let handle: JSValueHandle | undefined;
    try {
      const evaluated = this.evalTrapFree(code, options.filename ?? '<repl>', EvalFlags.ASYNC);
      if (evaluated.kind === 'error') {
        return { kind: 'error', error: evaluated.error };
      }
      handle = evaluated.handle;
      try {
        this.runDrain();
      } catch (e) {
        if (e instanceof DrainJobError) {
          // A drained job threw (the canonical case: the per-eval interrupt
          // firing inside a resumed continuation). The guest exception was
          // consumed and cleared by the raw drain loop, so the VM stays
          // usable; the info was read trap-free.
          return { kind: 'error', error: e.info };
        }
        throw e; // host-side failure, not a guest outcome — fail loudly
      }
      return this.readCompletion(handle);
    } finally {
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
      return this.runDrain();
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
   */
  private readCompletion(handle: JSValueHandle): ReplEvalOutcome {
    try {
      // 0 pending, 1 fulfilled, 2 rejected (quickjs-wasi built-in
      // `promiseState`).
      const state = handle.promiseState;
      if (state === 0) {
        return { kind: 'pending' };
      }
      // For settled promises `qjs_promise_result` returns a new owned
      // reference to the promise's result: the `{ value }` completion
      // wrapper on fulfillment, the raw thrown value on rejection.
      const resultPtr = this.vm._getExports().qjs_promise_result(handle.ptr);
      const result = new JSValueHandle(this.vm, resultPtr);
      try {
        if (state === 2) {
          return { kind: 'error', error: readErrorInfo(result) };
        }
        return { kind: 'value', value: readCompletionValue(result) };
      } finally {
        result.dispose();
      }
    } finally {
      handle.dispose();
    }
  }

  /**
   * The pending-job loop shared by `evalCode` (with the eval's armed
   * handler) and `drainJobs` (with the drain's own armed handler). A
   * failed job's exception is read trap-free and thrown as a
   * `DrainJobError`; the drain stops at the first failure, so jobs queued
   * after it remain pending for a later drain.
   */
  private runDrain(): number {
    const e = this.vm._getExports();
    let count = 0;
    while (e.qjs_is_job_pending() !== 0) {
      const result = e.qjs_execute_pending_job();
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
 * Trap-free unwrap of the engine-created `{ value }` completion wrapper:
 * an own-data-property descriptor read, never `[[Get]]` (R69: a guest
 * `Object.prototype.value` pollution must not be able to hijack eval
 * results). If the wrapper shape is unexpected, the wrapper itself is
 * rendered so the caller always sees *a* value.
 */
function readCompletionValue(wrapper: JSValueHandle): unknown {
  const valueHandle = readOwnDataProperty(wrapper, 'value');
  if (valueHandle === undefined) {
    return readValue(wrapper, 0, new Set());
  }
  try {
    return readValue(valueHandle, 0, new Set());
  } finally {
    valueHandle.dispose();
  }
}

/**
 * Trap-free own-data-property read, driven over the raw
 * `qjs_get_own_property_descriptor` export — **never** through
 * `JSValueHandle.getOwnPropertyDescriptor()`, whose failure path throws a
 * `JSException` whose constructor performs guest-visible `[[Get]]` reads
 * of `name`/`message`/`stack` on the exception value (review regression:
 * a getter installed on `InternalError.prototype.name` would execute while
 * a failing descriptor read was being reported). Here a failed read's
 * exception value is taken out of the runtime and freed — no `JSException`
 * is ever constructed — and the engine-created descriptor object's own
 * data properties are read via raw `qjs_get_prop_value` (OrdinaryGet on
 * own data properties: no guest code runs, even against a polluted
 * `Object.prototype`).
 *
 * Returns `undefined` when the property is absent, the read failed, the
 * property is an accessor (accessors are never invoked — their `get`/`set`
 * handles are owned by the caller and are disposed here; a leaked accessor
 * handle pins guest memory, which review measured exhausting a 1 MiB VM
 * after ~3,128 accessor-valued completions), or the object is a proxy (a
 * descriptor read would fire its `getOwnPropertyDescriptor` trap). The
 * returned handle is owned by the caller and must be disposed.
 */
function readOwnDataProperty(handle: JSValueHandle, key: string): JSValueHandle | undefined {
  // Proxies fire traps on descriptor reads — this is the backstop guard;
  // call sites guard too. Engine-level brand check, never a guest trap.
  if (handle.isProxy) return undefined;

  const vm = handle.vm;
  const e = vm._getExports();
  // `qjs_get_own_property_descriptor` takes the key as a JSValue (like the
  // shim's own descriptor path, which passes `vm.newString(key)`), not as
  // a C string — passing a `_writeString` pointer makes the C engine read
  // raw bytes as a JSValue and report “no such property”. The key handle
  // is engine-created and freed right after the call.
  const keyHandle = vm.newString(key);
  let descPtr: number;
  try {
    descPtr = e.qjs_get_own_property_descriptor(handle.ptr, keyHandle.ptr);
  } finally {
    keyHandle.dispose();
  }
  if (descPtr === 0) return undefined; // no such own property

  const desc = new JSValueHandle(vm, descPtr);
  try {
    if (e.qjs_is_exception(desc.ptr) !== 0) {
      // The C descriptor read failed (allocation failure edge). Take the
      // exception value out of the runtime and free it; never construct
      // quickjs-wasi's `JSException` (guest-visible getters would run in
      // its constructor). The property reads as absent.
      takeAndFreeException(e, vm);
      return undefined;
    }
    // Data vs accessor: `qjs_has_own_property` (raw), which never walks
    // the prototype — an accessor descriptor must not leak a polluted
    // `Object.prototype.value` through the `value` read.
    if (hasOwnRaw(e, vm, desc.ptr, 'value')) {
      return getPropRaw(e, vm, desc.ptr, 'value');
    }
    // Accessor descriptor: never invoke the accessors; free their owned
    // handles so they don't pin guest memory.
    getPropRaw(e, vm, desc.ptr, 'get')?.dispose();
    getPropRaw(e, vm, desc.ptr, 'set')?.dispose();
    return undefined;
  } finally {
    desc.dispose();
  }
}

/**
 * Raw `hasOwnProperty` on an engine-created object (no prototype walk, no
 * traps).
 */
function hasOwnRaw(e: QuickJSExports, vm: QuickJS, objPtr: number, key: string): boolean {
  const { ptr: keyPtr } = vm._writeString(key);
  try {
    return e.qjs_has_own_property(objPtr, keyPtr) !== 0;
  } finally {
    e.wasm_free(keyPtr);
  }
}

/**
 * Raw own-property read on an engine-created object. `qjs_get_prop_value`
 * is OrdinaryGet: on an engine-created plain object with own data
 * properties no guest code can run — but the read itself can still fail
 * (allocation edge), so the exception is taken out and freed and the read
 * reports `undefined` instead of throwing. The returned handle is owned by
 * the caller and must be disposed.
 */
function getPropRaw(e: QuickJSExports, vm: QuickJS, objPtr: number, key: string): JSValueHandle | undefined {
  // `qjs_get_prop_value` takes the key as a JSValue (the shim's `getProp`
  // passes a handle), never as a C string.
  const keyHandle = vm.newString(key);
  let ptr: number;
  try {
    ptr = e.qjs_get_prop_value(objPtr, keyHandle.ptr);
  } finally {
    keyHandle.dispose();
  }
  const handle = new JSValueHandle(vm, ptr);
  if (e.qjs_is_exception(handle.ptr) !== 0) {
    takeAndFreeException(e, vm);
    handle.dispose();
    return undefined;
  }
  return handle;
}

/**
 * Take the runtime's current exception value out and free it. Used by the
 * raw failure paths so a failed C call never leaves a sticky exception
 * behind (the shim's own `keys()` leaves one, which would poison later
 * operations) and never constructs a `JSException`.
 */
function takeAndFreeException(e: QuickJSExports, vm: QuickJS): void {
  // `qjs_get_exception` clears the runtime's slot; with no exception set it
  // returns JS_UNDEFINED (pointer 0), so a non-zero pointer is a real
  // exception value owned by us.
  const excPtr = e.qjs_get_exception();
  if (excPtr !== 0) {
    new JSValueHandle(vm, excPtr).dispose();
  }
}

/**
 * Trap-free own enumerable string keys (`Object.keys` semantics), driven
 * over the raw `qjs_get_own_property_names` export with exception cleanup —
 * the shim's `keys()` leaves a sticky runtime exception behind when the C
 * call fails, which would poison later operations. Returns `[]` on failure.
 */
function rawOwnKeys(handle: JSValueHandle): string[] {
  const vm = handle.vm;
  const e = vm._getExports();
  const keysPtr = e.qjs_get_own_property_names(handle.ptr);
  const keysHandle = new JSValueHandle(vm, keysPtr);
  if (e.qjs_is_exception(keysHandle.ptr) !== 0) {
    takeAndFreeException(e, vm);
    keysHandle.dispose();
    return [];
  }
  try {
    const lenHandle = getPropRaw(e, vm, keysHandle.ptr, 'length');
    if (lenHandle === undefined) return [];
    let len: number;
    try {
      len = lenHandle.toNumber();
    } finally {
      lenHandle.dispose();
    }
    const out: string[] = [];
    for (let i = 0; i < len; i++) {
      const keyPtr = e.qjs_get_prop_uint32(keysHandle.ptr, i);
      const keyHandle = new JSValueHandle(vm, keyPtr);
      if (e.qjs_is_exception(keyHandle.ptr) !== 0) {
        takeAndFreeException(e, vm);
        keyHandle.dispose();
        break;
      }
      try {
        out.push(keyHandle.toString());
      } finally {
        keyHandle.dispose();
      }
    }
    return out;
  } finally {
    keysHandle.dispose();
  }
}

/**
 * Native string form of a symbol, as `String(symbol)` would produce it:
 * `Symbol(description)` — never a fabricated conversion like `NaN`
 * (review regression: the primitive error-rendering default branch called
 * `toNumber()` on symbols). The description is read through the raw
 * `qjs_get_symbol_description` export — native and trap-free; a symbol
 * without a description (or with an empty one) renders as `Symbol()`.
 */
function readSymbolDescription(handle: JSValueHandle): string {
  const vm = handle.vm;
  const e = vm._getExports();
  const outPtr = e.wasm_malloc(4);
  try {
    e.qjs_get_symbol_description(handle.ptr, outPtr);
    // The description is written as a JSValue pointer into the out slot.
    const descPtr = new DataView(e.memory.buffer).getUint32(outPtr, true);
    if (descPtr === 0) return 'Symbol()'; // JS_UNDEFINED — anonymous symbol
    const desc = new JSValueHandle(vm, descPtr);
    try {
      const text = desc.isString ? desc.toString() : '';
      return text ? `Symbol(${text})` : 'Symbol()';
    } finally {
      desc.dispose();
    }
  } finally {
    e.wasm_free(outPtr);
  }
}

/**
 * Render a guest value into host data without ever executing guest code:
 * primitives via native conversions, objects via own enumerable
 * data-property descriptor reads, brand checks for the engine-recognized
 * object kinds (markers), depth/property caps and a cycle guard so
 * adversarial shapes stay bounded.
 *
 * This is the conservative seed of the ObjectPreview rendering the tool
 * result eventually carries (a later phase owns that format); everything
 * read here is trap-free and bounded.
 */
function readValue(handle: JSValueHandle, depth: number, seen: Set<number>): unknown {
  if (handle.isUndefined) return undefined;
  if (handle.isNull) return null;

  const t = handle.typeof;
  switch (t) {
    case 'boolean':
      // JS_ToCString on a boolean primitive is native — no guest code runs.
      return handle.toString() === 'true';
    case 'number':
      return handle.toNumber();
    case 'string':
      return handle.toString();
    case 'bigint':
      return handle.toBigInt();
    case 'symbol':
      return '[Symbol]';
    case 'function':
      return '[Function]';
    default:
      break; // objects
  }

  // Engine-level brand checks: never fire traps, cannot be spoofed from
  // guest JavaScript. Proxies are never touched further (descriptor reads
  // would fire their traps).
  if (handle.isProxy) return '[Proxy]';
  if (handle.isPromise) return '[Promise]';
  if (handle.isDate) return '[Date]';
  if (handle.isMap) return '[Map]';
  if (handle.isSet) return '[Set]';
  if (handle.isWeakMap) return '[WeakMap]';
  if (handle.isWeakSet) return '[WeakSet]';
  if (handle.isWeakRef) return '[WeakRef]';
  if (handle.isRegExp) return '[RegExp]';
  if (handle.isArrayBuffer) return '[ArrayBuffer]';

  const ptr = handle.ptr;
  if (seen.has(ptr)) return '[Circular]';
  if (depth >= READ_DEPTH_LIMIT) return '[Object]';

  seen.add(ptr);
  try {
    if (handle.isArray) {
      const lengthHandle = readOwnDataProperty(handle, 'length');
      const length = lengthHandle === undefined ? 0 : lengthHandle.toNumber();
      lengthHandle?.dispose();
      const out: unknown[] = [];
      const count = Math.min(length, READ_PROP_LIMIT);
      for (let i = 0; i < count; i++) {
        const v = readOwnDataProperty(handle, String(i));
        if (v === undefined) continue; // sparse hole
        try {
          out.push(readValue(v, depth + 1, seen));
        } finally {
          v.dispose();
        }
      }
      if (length > READ_PROP_LIMIT) out.push('[ArrayTruncated]');
      return out;
    }

    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of rawOwnKeys(handle)) {
      if (count >= READ_PROP_LIMIT) {
        out['[Truncated]'] = true;
        break;
      }
      const v = readOwnDataProperty(handle, key);
      if (v === undefined) continue; // accessor or deleted between reads
      try {
        out[key] = readValue(v, depth + 1, seen);
      } finally {
        v.dispose();
      }
      count++;
    }
    return out;
  } finally {
    seen.delete(ptr);
  }
}

/**
 * Trap-free error info: name/message/stack are read as own data
 * properties; primitives thrown as values convert natively (strings and
 * bigints as themselves, booleans as `'true'`/`'false'`, numbers as their
 * native string form, symbols as `Symbol(description)`). Guest getters are
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
        message = readSymbolDescription(handle);
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
