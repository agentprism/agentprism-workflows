/**
 * The host side of the guest-library bridge.
 *
 * Installs the four `__host_*` callbacks the guest library consumes
 * (the realm's entire effect surface — the dispatch table stays almost
 * embarrassingly small by design), evaluates the library once at VM
 * creation, and exposes the host's doors back into the realm: the
 * reconciliation surface (post-restore settlement), the trap-free `$N`
 * slot reader, and the console-event channel.
 *
 * Settlement contract (see the package README's "Guest library ⇄ host
 * contract"): each `__host_agent` / `__host_checkpoint` (question mode) /
 * `__host_agent_steer` callback creates a `GuestCall` — a quickjs-wasi
 * `Deferred` whose promise handle is returned into the realm as the
 * thenable the guest chains onto — and hands it to the handler. The
 * handler settles it (`resolve`/`reject`) whenever its work completes,
 * then drains; alternatively the host returns nothing and settles later
 * through `readGuestSurface().settle(...)`. Both routes converge on the
 * guest's idempotent settle-by-call-id; the first settlement wins.
 * `checkpoint.answer` is the synchronous answer mode: a PRESENT fourth
 * argument to `__host_checkpoint` means answer delivery, and the callback
 * returns the handler's boolean synchronously (no registry entry is
 * minted — nothing new pends).
 *
 * Every callback path is defensive: protocol violations (non-string
 * arguments) throw, which the shim turns into a guest-thrown error that
 * the guest library converts into a call rejection — the documented
 * "synchronous host refusal" path. A throwing handler behaves the same.
 *
 * The public type graph stays free of quickjs-wasi types (a consumer with
 * a non-DOM lib and `skipLibCheck: false` must type-check the published
 * declarations cleanly); the shim is reached through `getVmShim`, and
 * `GuestCall`'s internals are private.
 */

import { JSValueHandle, type HostFunction, type QuickJS } from 'quickjs-wasi';

import {
  GUEST_SURFACE_KEY,
  HOST_AGENT,
  HOST_CHECKPOINT,
  HOST_CONSOLE,
  HOST_STEER,
  buildGuestLibrarySource,
} from './guest/guest-library.js';
import { getVmShim, type ReplVm } from './vm.js';
import type { EvalErrorInfo } from './errors.js';
import { getPropRaw, hasOwnRaw, readOwnDataProperty, readValue, takeAndFreeException, type QuickJSExports } from './trapfree.js';

/** The console levels the guest bridge emits. */
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/**
 * One console event crossing the bridge: `refs` names the real realm
 * globals just created (one per logged argument, in argument order) — the
 * authoritative channel; `args` is the best-effort JSON-safe encoding
 * (capped; the full value always lives untruncated in `$N`).
 */
export interface ConsoleEvent {
  level: ConsoleLevel;
  /** `["$14", …]` — the $N realm globals holding the frozen arguments. */
  refs: string[];
  /** Best-effort JSON-safe encodings of the same arguments. */
  args: unknown[];
}

/**
 * A host call in flight: wraps a promise created through the raw
 * `qjs_new_promise` export whose parts (promise + resolve/reject
 * functions) the call owns and disposes completely.
 *
 * The handler settles the call with a host value (`resolve`) or a host
 * error value (`reject`); both are marshalled into the realm (plain data,
 * errors, arrays, objects — never guest code). Settlement is first-wins: a
 * second resolve/reject is a no-op, matching the guest's own idempotent
 * settle-by-call-id. The caller must run a job drain after settling for
 * the guest's continuations to fire.
 *
 * Handle ownership (mirrors the Rust reference broker's Deferred
 * discipline): the marshalled value handle handed to `resolve`/`reject`
 * is disposed here after the call — the engine does not consume it — and
 * settling disposes BOTH resolving functions. This deliberately does NOT
 * use the shim's `newPromise()` Deferred, whose reject-function handle is
 * pinned in the VM's `_ownedHandles` set until VM dispose even when the
 * promise is resolved — measured at ~2 objects + 7 heap boxes per call,
 * which exhausted a 2 MiB VM after roughly 5,000 sequential resolved
 * agent calls (review regression, pinned by test).
 *
 * The promise handle itself is returned into the realm once (the
 * host-callback trampoline dups it and the shim's host_call path never
 * frees the host-side original), then released through `releaseToRealm`,
 * which defers the dispose to a microtask so it runs only after the
 * trampoline's synchronous dup.
 */
export class GuestCall {
  /** The owning VM (private — elided from the published declarations). */
  private readonly vm: ReplVm;
  /** The raw deferred; its `handle` is the guest promise. */
  private readonly deferred: {
    handle: JSValueHandle;
    resolve(value: JSValueHandle): void;
    reject(value: JSValueHandle): void;
    /** Free both resolving functions without settling (see `dispose`). */
    dispose(): void;
  };
  private settled = false;
  /** True once the promise handle was released to the realm. */
  private released = false;

  constructor(vm: ReplVm) {
    this.vm = vm;
    const shim = getVmShim(vm) as QuickJS;
    this.deferred = newRawDeferred(shim);
    guestCallHandles.set(this, this.deferred.handle);
  }

  /**
   * Dispose every part this call still owns, WITHOUT settling: the raw
   * promise handle (when it was never released to the realm) and both
   * resolving functions (when no settlement consumed them). This is the
   * throwing-handler path — a handler that refuses by throwing leaves the
   * call unsettled and its promise never returned into the realm, so
   * nothing the call owns is reachable afterwards. Without this, every
   * refusal leaked the raw promise plus its two resolving functions
   * (~3 JSValues + heap boxes per call — measured: 30,000 rejected
   * calls filled a 2 MiB VM and the next agent call failed with
   * `Error: null`; review regression, pinned by test).
   *
   * Idempotent, and safe in every order with resolve/reject/
   * releaseToRealm: after dispose the call reads as settled (nothing can
   * settle it), a released promise handle is left to its queued microtask
   * dispose, and the deferred's own dispose is a no-op once settlement
   * consumed the functions.
   */
  dispose(): void {
    this.settled = true;
    if (!this.released) {
      const handle = guestCallHandles.get(this);
      if (handle !== undefined) {
        guestCallHandles.delete(this);
        // Safe to free synchronously on this path: when the handler
        // threw, the host-call trampoline never dupped a return value
        // (there was none), so no other reference to this promise exists
        // host-side. (`releaseToRealm` defers only because the trampoline
        // dups the pointer AFTER a successful callback returns.)
        handle.dispose();
      }
    }
    this.deferred.dispose();
  }

  /**
   * Resolve the call with a host value (marshalled into the realm). The
   * promise's reactions fire on the next job drain.
   */
  resolve(value: unknown): void {
    this.settle((shim) => {
      const valueHandle = marshalValue(shim, value);
      try {
        this.deferred.resolve(valueHandle);
      } finally {
        // The raw call borrows the value; the caller owns it and must
        // release it (Rust reference: the broker disposes the marshalled
        // value after settling).
        valueHandle.dispose();
      }
    });
  }

  /**
   * Reject the call with a host error value (an Error, or a plain
   * `{ message, name?, code?, recoverable? }` object — the guest
   * normalizes both). The promise's reactions fire on the next job drain.
   */
  reject(error: unknown): void {
    this.settle((shim) => {
      const valueHandle = marshalValue(shim, error);
      try {
        this.deferred.reject(valueHandle);
      } finally {
        valueHandle.dispose();
      }
    });
  }

  /**
   * Release this call's host-side reference to the realm promise. Called
   * by the host-function wrappers after the promise handle has been
   * returned into the realm: the trampoline dups the returned pointer
   * synchronously after the callback returns, so the dispose is deferred
   * to a microtask — it runs only once that dup has happened. After this
   * the handle must not be used (settlement goes through the deferred's
   * resolve/reject functions, which are independent of the promise
   * handle).
   */
  releaseToRealm(): void {
    if (this.released) return;
    this.released = true;
    const handle = guestCallHandles.get(this);
    if (handle === undefined) return;
    queueMicrotask(() => handle.dispose());
  }

  /** True once the call has been settled (first-wins). */
  get isSettled(): boolean {
    return this.settled;
  }

  private shim(): QuickJS {
    return getVmShim(this.vm) as QuickJS;
  }

  private settle(apply: (shim: QuickJS) => void): void {
    if (this.settled) return; // first settlement wins, like the guest registry
    this.settled = true;
    apply(this.shim());
  }
}

/**
 * Create a promise through the raw `qjs_new_promise` export and return a
 * deferred over the three owned parts — the TS analogue of the Rust
 * reference broker's `new_promise_raw`/`Deferred` (which settles by
 * calling the resolving function and then disposes BOTH functions, plus
 * the promise handle at `releaseToRealm` time). `dispose()` frees the
 * resolving functions without settling — the throwing-handler path, where
 * a call is abandoned before its promise is ever returned to the realm
 * (see `GuestCall.dispose`). See `GuestCall` for why the shim's
 * `newPromise()` Deferred is not used.
 */
function newRawDeferred(shim: QuickJS): {
  handle: JSValueHandle;
  resolve(value: JSValueHandle): void;
  reject(value: JSValueHandle): void;
  dispose(): void;
} {
  const e = shim._getExports() as QuickJSExports;
  const resolveOut = e.wasm_malloc(4);
  const rejectOut = e.wasm_malloc(4);
  let promise: JSValueHandle | undefined;
  let resolveFn: JSValueHandle | undefined;
  let rejectFn: JSValueHandle | undefined;
  try {
    const promisePtr = e.qjs_new_promise(resolveOut, rejectOut);
    const view = new DataView(e.memory.buffer);
    const resolvePtr = view.getUint32(resolveOut, true);
    const rejectPtr = view.getUint32(rejectOut, true);
    promise = new JSValueHandle(shim, promisePtr);
    resolveFn = new JSValueHandle(shim, resolvePtr);
    rejectFn = new JSValueHandle(shim, rejectPtr);
  } finally {
    e.wasm_free(resolveOut);
    e.wasm_free(rejectOut);
  }

  let settled = false;
  const freeFunctions = (): void => {
    resolveFn?.dispose();
    rejectFn?.dispose();
    resolveFn = undefined;
    rejectFn = undefined;
  };
  const settleWith = (fn: JSValueHandle, value: JSValueHandle): void => {
    if (settled) return;
    settled = true;
    try {
      // Raw `qjs_call` with one borrowed argument (mirrors the shim's own
      // callFunctionRaw, which is private). The result — including an
      // exception result, whose runtime exception is taken out and freed
      // — is disposed here; the engine never consumes the argument.
      const argv = e.wasm_malloc(4);
      let resultPtr: number;
      try {
        new DataView(e.memory.buffer).setUint32(argv, value.ptr, true);
        resultPtr = e.qjs_call(fn.ptr, shim.undefined.ptr, 1, argv);
      } finally {
        e.wasm_free(argv);
      }
      const result = new JSValueHandle(shim, resultPtr);
      try {
        if (e.qjs_is_exception(result.ptr) !== 0) {
          takeAndFreeException(e, shim);
        }
      } finally {
        result.dispose();
      }
    } finally {
      // Settling consumes both resolving functions (Rust reference:
      // `Deferred::dispose` releases every part the deferred still owns).
      freeFunctions();
    }
  };

  return {
    handle: promise!,
    resolve: (value) => settleWith(resolveFn!, value),
    reject: (value) => settleWith(rejectFn!, value),
    dispose: () => {
      // Free the resolving functions without calling them. A settled
      // deferred's functions are already freed (settleWith's finally);
      // the `settled` flag makes a post-dispose resolve/reject a no-op,
      // so a handler that (pathologically) kept a reference to the call
      // and settles it later can never call into freed memory.
      settled = true;
      freeFunctions();
    },
  };
}

// Registered by the constructor above; read by `guestCallHandle` so the
// public `GuestCall` class never names a quickjs-wasi type.
const guestCallHandles = new WeakMap<GuestCall, JSValueHandle>();

/** The guest promise handle of a call (bridge-internal). */
function guestCallHandle(call: GuestCall): JSValueHandle {
  return guestCallHandles.get(call)!;
}

/**
 * Marshal a host value into the realm. `hostToHandle` handles primitives,
 * arrays, plain objects, errors and buffers; a value it cannot marshal (a
 * local symbol) falls back to a guest Error carrying the string form — a
 * rejection must never throw host-side. The returned handle is owned by
 * the caller, who must dispose it after handing it to the deferred
 * (promise settlement dups its own reference).
 */
function marshalValue(shim: QuickJS, value: unknown): JSValueHandle {
  try {
    return shim.hostToHandle(value);
  } catch (err) {
    return shim.newError(err instanceof Error ? err : String(err));
  }
}

/** The host's handlers for the four guest calls. */
export interface GuestBridgeHandlers {
  /**
   * An `agent(modelSpec, task, options?)` call. `modelSpec` is the
   * backend-routing spec (`"pi/deepseek-v4-flash-max"`), `task` the
   * worker's prompt; `optionsJson` is the JSON-encoded options bag
   * (or `null` when none were given). Settle `call` when the worker's
   * result (final text, or the schema-validated object when the options
   * carried a schema) is ready.
   */
  agent(
    call: GuestCall,
    callId: string,
    modelSpec: string,
    task: string,
    optionsJson: string | null,
  ): void;
  /**
   * A checkpoint question (question mode: `call` is a fresh `GuestCall`,
   * `answerJson` is `null`) or answer delivery (answer mode: `call` is
   * `null`, `answerJson` is the JSON-encoded answer). In answer mode the
   * handler settles the ORIGINAL pending checkpoint (through its own
   * records) and returns a boolean — truthy iff a checkpoint with that id
   * was pending when the call was made. Nothing new pends in answer mode.
   */
  checkpoint(
    call: GuestCall | null,
    callId: string,
    question: string | null,
    optionsJson: string | null,
    answerJson: string | null,
  ): boolean | void;
  /**
   * A steering operation on a live agent handle: `callId` is the
   * operation's OWN registry id (the settlement key — the host keys its
   * live bookkeeping by it), `sessionId` the FOUNDING call id of the
   * session being steered (the dispatch and post-restore re-issue
   * target), `action` is `"followUp"` | `"steer"` | `"cancel"` and
   * `payloadJson` the JSON-encoded `{ prompt, options }` bag for
   * followUp/steer or `null` for cancel. Settle `call` with what actually
   * happened (the steering outcome — live injection vs queued delivery,
   * mirroring the outcome values acp-agents surfaces in its steering
   * events).
   */
  steer(
    call: GuestCall,
    callId: string,
    sessionId: string,
    action: string,
    payloadJson: string | null,
  ): void;
  /**
   * A console event (log/info/warn/error/debug). The frozen arguments are
   * already stored in the realm as the `$N` globals named by
   * `event.refs` — the handler renders them through the previewer (never
   * guest code). A throw becomes a guest error inside the library's own
   * swallow-guard — console never breaks guest code by contract.
   */
  console(event: ConsoleEvent): void;
}

/**
 * Install the guest bridge on a fresh VM: register the four host
 * callbacks, expose them as realm globals, and evaluate the guest library
 * once. Re-injecting over a workspace that already carries the library is
 * a no-op (the resident version stays authoritative for the life of the
 * workspace — the doc's rule: never re-inject over a workspace).
 */
export async function installGuestBridge(vm: ReplVm, handlers: GuestBridgeHandlers): Promise<void> {
  if (readGuestSurface(vm) !== undefined) return; // never re-inject
  const shim = getVmShim(vm) as QuickJS;
  const callbacks = makeCallbacks(vm, handlers);
  for (const [name, fn] of callbacks) {
    const fnHandle = shim.newFunction(name, fn);
    shim.setProp(shim.global, name, fnHandle);
    fnHandle.dispose();
  }
  // The library is a plain script with no top-level await; the eval and
  // its drain complete synchronously (the returned promise is already
  // fulfilled — `await` only unwraps).
  const outcome = await vm.evalCode(buildGuestLibrarySource(), { filename: '<guest-library>' });
  if (outcome.kind === 'error') {
    throw new GuestLibraryInstallError(outcome.error);
  }
}

/**
 * Re-register the four host callbacks by name on a VM restored from a
 * snapshot. This is the quickjs-wasi restore discipline: the library (and
 * its pending-call registry) travels inside the snapshot; only the
 * host-side name → callback map must be re-attached (the guest function
 * values already exist in the restored memory). Do NOT re-evaluate the
 * library — and do NOT call this on a fresh VM (the guest function values
 * do not exist yet; that is `installGuestBridge`'s job).
 */
export function registerGuestHostCallbacks(vm: ReplVm, handlers: GuestBridgeHandlers): void {
  const shim = getVmShim(vm) as QuickJS;
  for (const [name, fn] of makeCallbacks(vm, handlers)) {
    shim.registerHostCallback(name, fn);
  }
}

/** The four (name, host function) pairs the bridge installs. */
function makeCallbacks(vm: ReplVm, handlers: GuestBridgeHandlers): Array<[string, HostFunction]> {
  return [
    [HOST_AGENT, makeAgentHostFunction(vm, handlers)],
    [HOST_CHECKPOINT, makeCheckpointHostFunction(vm, handlers)],
    [HOST_STEER, makeSteerHostFunction(vm, handlers)],
    [HOST_CONSOLE, makeConsoleHostFunction(vm, handlers)],
  ];
}

/**
 * The `__host_agent` shape: mint a `GuestCall`, hand it to the handler,
 * return its promise handle into the realm. The guest chains onto the
 * returned thenable; settlement happens whenever the handler settles the
 * call (then a drain).
 *
 * A handler that throws synchronously (the documented refusal path)
 * leaves the call unsettled and its promise never returned into the
 * realm: dispose every owned part BEFORE the shim converts the throw
 * into a guest error (which the guest library turns into a call
 * rejection), then re-throw — otherwise each refusal strands the raw
 * promise plus both resolving functions (measured: repeated refusals
 * corrupt the VM until a normal agent call fails with `Error: null`;
 * review regression, pinned by the 30,000-refusals bounded-memory test).
 */
function makeAgentHostFunction(vm: ReplVm, handlers: GuestBridgeHandlers): HostFunction {
  return function (this: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    const callId = requireString(args[0], HOST_AGENT, 'callId');
    const modelSpec = requireString(args[1], HOST_AGENT, 'modelSpec');
    const task = requireString(args[2], HOST_AGENT, 'task');
    const optionsJson = optionalString(args[3]);
    const call = new GuestCall(vm);
    try {
      handlers.agent(call, callId, modelSpec, task, optionsJson);
    } catch (err) {
      call.dispose();
      throw err;
    }
    // The trampoline dups the returned pointer after this callback
    // returns; release the host-side reference once that has happened.
    call.releaseToRealm();
    return guestCallHandle(call);
  };
}

/**
 * The `__host_agent_steer` shape: same pattern as `__host_agent`, with
 * the operation's own call id FIRST (the settlement key) and the founding
 * `sessionId` second (the session being steered), then `action`
 * ("followUp" | "steer" | "cancel") and a JSON-encoded payload (or null
 * for cancel). The guest records both ids in its pending-call registry,
 * so a pending steer is snapshot-reconcilable: the host settles it by
 * call id and re-issues it against the session.
 */
function makeSteerHostFunction(vm: ReplVm, handlers: GuestBridgeHandlers): HostFunction {
  return function (this: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    const callId = requireString(args[0], HOST_STEER, 'callId');
    const sessionId = requireString(args[1], HOST_STEER, 'sessionId');
    const action = requireString(args[2], HOST_STEER, 'action');
    const payloadJson = optionalString(args[3]);
    const call = new GuestCall(vm);
    try {
      handlers.steer(call, callId, sessionId, action, payloadJson);
    } catch (err) {
      // Same disposal discipline as `__host_agent` (see there): a
      // throwing steer handler must not strand the raw promise and its
      // resolving functions.
      call.dispose();
      throw err;
    }
    call.releaseToRealm();
    return guestCallHandle(call);
  };
}

/**
 * The `__host_checkpoint` shape, with the answer mode: a PRESENT fourth
 * argument (the JSON-encoded answer) flips the call into answer delivery —
 * the handler's boolean is returned synchronously and no `GuestCall` is
 * minted (nothing new pends; a snapshot can never capture an answer in
 * flight).
 */
function makeCheckpointHostFunction(vm: ReplVm, handlers: GuestBridgeHandlers): HostFunction {
  const shim = getVmShim(vm) as QuickJS;
  return function (this: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    const callId = requireString(args[0], HOST_CHECKPOINT, 'callId');
    if (args.length >= 4) {
      // Answer mode.
      const answerJson = requireString(args[3], HOST_CHECKPOINT, 'answerJson');
      const answered = handlers.checkpoint(null, callId, null, null, answerJson);
      return answered ? shim.true : shim.false;
    }
    const question = optionalString(args[1]);
    const optionsJson = optionalString(args[2]);
    const call = new GuestCall(vm);
    try {
      handlers.checkpoint(call, callId, question, optionsJson, null);
    } catch (err) {
      // Same disposal discipline as `__host_agent` (see there): a
      // throwing checkpoint handler must not strand the raw promise and
      // its resolving functions. (Answer mode mints no GuestCall, so a
      // throw there has nothing to dispose — it propagates as the
      // documented protocol-violation guest error.)
      call.dispose();
      throw err;
    }
    call.releaseToRealm();
    return guestCallHandle(call);
  };
}

/**
 * The `__host_console` shape: parse the payload JSON and dispatch. Never
 * throws host-side for malformed payloads (the guest never sends one; a
 * malformed payload is dropped).
 */
function makeConsoleHostFunction(vm: ReplVm, handlers: GuestBridgeHandlers): HostFunction {
  const shim = getVmShim(vm) as QuickJS;
  return function (this: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    const level = optionalString(args[0]);
    const payloadJson = optionalString(args[1]);
    if (level !== null && payloadJson !== null && isConsoleLevel(level)) {
      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        payload = undefined;
      }
      if (isConsolePayload(payload)) {
        handlers.console({ level, refs: payload.refs, args: payload.args });
      }
    }
    return shim.undefined;
  };
}

function isConsoleLevel(level: string): level is ConsoleLevel {
  return level === 'log' || level === 'info' || level === 'warn' || level === 'error' || level === 'debug';
}

function isConsolePayload(value: unknown): value is { refs: string[]; args: unknown[] } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { refs?: unknown; args?: unknown };
  return (
    Array.isArray(v.refs) &&
    v.refs.every((r) => typeof r === 'string') &&
    Array.isArray(v.args)
  );
}

function requireString(arg: JSValueHandle | undefined, hostFn: string, what: string): string {
  if (arg === undefined || !arg.isString) {
    throw new TypeError(`${hostFn}: ${what} must be a string (guest protocol violation)`);
  }
  return arg.toString();
}

function optionalString(arg: JSValueHandle | undefined): string | null {
  if (arg === undefined || !arg.isString) return null;
  return arg.toString();
}

/** A guest-library install failure (the library script failed to evaluate). */
export class GuestLibraryInstallError extends Error {
  /** Trap-free error info from the failed evaluation. */
  readonly info: EvalErrorInfo;

  constructor(info: EvalErrorInfo) {
    super(`Guest library install failed: ${info.name}: ${info.message}`);
    this.name = 'GuestLibraryInstallError';
    this.info = info;
  }
}

// ────────────────────────────────────────────────────────────────────────
// The reconciliation surface and realm-slot access
// ────────────────────────────────────────────────────────────────────────

/** The surface read's array bound: the pending-call registry is the
 *  host's own reconciliation metadata (bounded by the VM's memory), so
 *  the generic 256-element preview cap would silently truncate the
 *  doc's `pending: [...]` surface. 16 384 pending calls is far beyond
 *  any realistic orchestration (the doc caps concurrent SUBAGENTS at
 *  6; parked checkpoints are the only piling kind) and keeps a
 *  pathological guest's registry from making every `pending` read
 *  pathological. */
const SURFACE_READ_MAX_LEN = 16384;

/** One entry of the guest's pending-call manifest. */
export interface GuestSurfaceEntry {
  id: string;
  /** `"agent"` | `"checkpoint"` | `"steer"`. */
  kind: string;
  /** Verbatim prompt / question / action. */
  detail: string | null;
  /** Verbatim options JSON string, or null. */
  optionsJson: string | null;
  /** Realm `Date.now()` at issue time. */
  createdAt: number;
  /**
   * The id the host addresses this call by: the call's own id for agent/
   * checkpoint calls, the FOUNDING session id for steering calls — the
   * correlation a restore needs to settle (by `id`) or re-issue (to the
   * session) a pending steer.
   */
  sessionId: string;
  /** The agent call's backend-routing spec (null for other kinds). */
  modelSpec: string | null;
}

/**
 * The host's door back into the guest's pending-call registry — the
 * post-restore reconciliation surface
 * (`globalThis[Symbol.for("repl.guest")]`). `pending`/`settle`/`stats`
 * execute the guest library's own frozen closure functions (never
 * guest-authored code — the surface object is frozen and its global
 * binding is non-configurable), and the member reads are trap-free.
 */
export interface GuestSurface {
  /** The resident guest library version (equals `__REPL_GUEST_VERSION`). */
  version: string;
  /** Manifest of every pending host call, oldest first. */
  pending(): GuestSurfaceEntry[];
  /**
   * Settle a pending call by id. Returns true iff an entry was pending;
   * false for unknown/already-settled ids (idempotent). The caller must
   * drain afterwards so continuations fire.
   */
  settle(callId: string, outcome: 'resolve' | 'reject', value: unknown): boolean;
  /** Counters for diagnostics and the workspace manifest. */
  stats(): { version: string; callSeq: number; logSeq: number; pendingCalls: number };
}

/**
 * Read the reconciliation surface from a VM. Returns `undefined` when the
 * guest library is not installed (a bare VM, or a host that has not yet
 * injected it).
 *
 * The returned surface object pins NO guest memory: it is plain data plus
 * closures over the VM. Every handle it needs (the surface object itself,
 * the member functions) is acquired per call and disposed on the spot —
 * a long-lived surface must not accumulate handles (review: the previous
 * shape captured three owned function handles in closures with no
 * disposal contract).
 */
export function readGuestSurface(vm: ReplVm): GuestSurface | undefined {
  const shim = getVmShim(vm) as QuickJS;
  const symbol = shim.newSymbolFor(GUEST_SURFACE_KEY);
  let surfaceHandle: JSValueHandle | undefined;
  try {
    surfaceHandle = shim.getProp(shim.global, symbol);
    if (surfaceHandle.isUndefined || !surfaceHandle.isObject) return undefined;

    const versionHandle = readOwnDataProperty(surfaceHandle, 'version');
    let version = 'unknown';
    if (versionHandle !== undefined) {
      try {
        if (versionHandle.isString) version = versionHandle.toString();
      } finally {
        versionHandle.dispose();
      }
    }

    // Presence check once: the three functions must exist for the surface
    // to be usable. The handles are only touched here — the closures below
    // re-acquire per call (see `callSurfaceFunction`).
    const pendingHandle = readOwnDataProperty(surfaceHandle, 'pending');
    const settleHandle = readOwnDataProperty(surfaceHandle, 'settle');
    const statsHandle = readOwnDataProperty(surfaceHandle, 'stats');
    const complete =
      pendingHandle !== undefined &&
      settleHandle !== undefined &&
      statsHandle !== undefined &&
      pendingHandle.isFunction &&
      settleHandle.isFunction &&
      statsHandle.isFunction;
    pendingHandle?.dispose();
    settleHandle?.dispose();
    statsHandle?.dispose();
    if (!complete) return undefined;

    return {
      version,
      pending: () => callSurfaceFunction(vm, 'pending') as GuestSurfaceEntry[],
      settle: (callId, outcome, value) => callSurfaceSettle(vm, callId, outcome, value),
      stats: () => callSurfaceFunction(vm, 'stats') as ReturnType<GuestSurface['stats']>,
    };
  } finally {
    symbol.dispose();
    surfaceHandle?.dispose();
  }
}

/**
 * Raw `qjs_call` (the shim's private `callFunctionRaw` drives the same
 * export): invoke a guest function with borrowed arguments and return the
 * raw result pointer (owned by the caller). The arguments are written into
 * a wasm argv array exactly like the shim's own path; they are NOT
 * consumed by the call.
 */
function callRaw(e: QuickJSExports, shim: QuickJS, fnPtr: number, args: JSValueHandle[]): number {
  const argc = args.length;
  let argvPtr = 0;
  if (argc > 0) {
    argvPtr = e.wasm_malloc(argc * 4);
    const view = new DataView(e.memory.buffer);
    for (let i = 0; i < argc; i++) {
      view.setUint32(argvPtr + i * 4, args[i].ptr, true);
    }
  }
  try {
    return e.qjs_call(fnPtr, shim.undefined.ptr, argc, argvPtr);
  } finally {
    if (argvPtr !== 0) e.wasm_free(argvPtr);
  }
}

/**
 * Acquire the surface and one of its member functions, call it with the
 * given arguments, and read the result trap-free. Every handle is
 * disposed on every path — nothing is retained by the caller.
 *
 * The functions are the library's frozen closures (no guest-authored code
 * can be substituted), and settle's arguments are pre-validated so the
 * library functions cannot throw; the raw call is still checked for an
 * exception result and the runtime exception is taken out and freed —
 * never routed through quickjs-wasi's `JSException` constructor (which
 * performs guest-visible `[[Get]]` reads of name/message/stack on the
 * exception value).
 */
function callSurfaceFunction(
  vm: ReplVm,
  member: 'pending' | 'stats',
): unknown {
  const shim = getVmShim(vm) as QuickJS;
  const e = shim._getExports() as QuickJSExports;
  const symbol = shim.newSymbolFor(GUEST_SURFACE_KEY);
  let surfaceHandle: JSValueHandle | undefined;
  let fn: JSValueHandle | undefined;
  try {
    surfaceHandle = shim.getProp(shim.global, symbol);
    if (surfaceHandle.isUndefined || !surfaceHandle.isObject) return undefined;
    fn = readOwnDataProperty(surfaceHandle, member);
    if (fn === undefined || !fn.isFunction) return undefined;
    const result = new JSValueHandle(shim, callRaw(e, shim, fn.ptr, []));
    try {
      if (e.qjs_is_exception(result.ptr) !== 0) {
        takeAndFreeException(e, shim);
        return undefined;
      }
      if (result.isUndefined) return undefined;
      // The pending-call registry is the host's own reconciliation
      // metadata (call ids, kinds, verbatim options — created by the
      // frozen guest library, never by guest code), not guest content:
      // the read's array cap is lifted so `pending` reports the WHOLE
      // registry (phase-E review round 3: the generic 256-element cap
      // silently truncated the list, and its `[ArrayTruncated]` marker
      // leaked into the broker's id lists as an `undefined` hole). The
      // bound is still generous-but-finite — the registry is bounded by
      // the VM's memory, and a pathological guest's registry must not
      // make every `pending` read pathological.
      return readValue(result, 0, new Set(), SURFACE_READ_MAX_LEN);
    } finally {
      result.dispose();
    }
  } finally {
    fn?.dispose();
    surfaceHandle?.dispose();
    symbol.dispose();
  }
}

function callSurfaceSettle(
  vm: ReplVm,
  callId: string,
  outcome: 'resolve' | 'reject',
  value: unknown,
): boolean {
  // Pre-validate host-side: the guest's own settle throws a TypeError for
  // an invalid outcome, and surfacing that through the shim's callFunction
  // would construct a `JSException` (whose constructor performs
  // guest-visible [[Get]] reads of name/message/stack on the guest
  // exception — a polluted Error.prototype.name getter would fire). With
  // the outcome validated here, the library function cannot throw.
  if (outcome !== 'resolve' && outcome !== 'reject') {
    throw new TypeError('settle(callId, outcome, value): outcome must be "resolve" or "reject"');
  }
  const shim = getVmShim(vm) as QuickJS;
  const e = shim._getExports();
  const symbol = shim.newSymbolFor(GUEST_SURFACE_KEY);
  let surfaceHandle: JSValueHandle | undefined;
  let settleFn: JSValueHandle | undefined;
  let callIdHandle: JSValueHandle | undefined;
  let outcomeHandle: JSValueHandle | undefined;
  let valueHandle: JSValueHandle | undefined;
  try {
    surfaceHandle = shim.getProp(shim.global, symbol);
    if (surfaceHandle.isUndefined || !surfaceHandle.isObject) return false;
    settleFn = readOwnDataProperty(surfaceHandle, 'settle');
    if (settleFn === undefined || !settleFn.isFunction) return false;
    callIdHandle = shim.newString(callId);
    outcomeHandle = shim.newString(outcome);
    valueHandle = marshalValue(shim, value);
    const result = new JSValueHandle(
      shim,
      callRaw(e, shim, settleFn.ptr, [callIdHandle, outcomeHandle, valueHandle]),
    );
    try {
      if (e.qjs_is_exception(result.ptr) !== 0) {
        takeAndFreeException(e, shim);
        return false;
      }
      if (!result.isBool) return false;
      return result.toBoolean();
    } finally {
      result.dispose();
    }
  } finally {
    callIdHandle?.dispose();
    outcomeHandle?.dispose();
    valueHandle?.dispose();
    settleFn?.dispose();
    surfaceHandle?.dispose();
    symbol.dispose();
  }
}

/**
 * How a realm global slot resolved, trap-free. The `$N` store is the
 * agent's own workspace — guest code CAN redefine a slot as an accessor;
 * the resolver reads the slot through its own property descriptor, never
 * a `[[Get]]` (an accessor is never invoked).
 */
export type RealmSlot = { kind: 'data' } | { kind: 'accessor' } | { kind: 'absent' };

/**
 * Resolve a realm global slot trap-free (own-descriptor read on
 * `globalThis` only): `data` when the slot holds a value, `accessor` when
 * guest code rebound it to a getter (observing it would execute guest
 * code — render a marker instead), `absent` when it does not exist.
 */
export function readRealmSlot(vm: ReplVm, name: string): RealmSlot {
  const shim = getVmShim(vm) as QuickJS;
  const global = shim.global; // cached singleton — do not dispose
  const e = shim._getExports();
  const keyHandle = shim.newString(name);
  let descPtr: number;
  try {
    descPtr = e.qjs_get_own_property_descriptor(global.ptr, keyHandle.ptr);
  } finally {
    keyHandle.dispose();
  }
  if (descPtr === 0) return { kind: 'absent' };
  const desc = new JSValueHandle(shim, descPtr);
  try {
    if (e.qjs_is_exception(desc.ptr) !== 0) {
      // Failed read: take the exception out and free it; the slot reads as
      // absent rather than throwing through JSException.
      const excPtr = e.qjs_get_exception();
      if (excPtr !== 0) new JSValueHandle(shim, excPtr).dispose();
      return { kind: 'absent' };
    }
    // Data vs accessor via `hasOwnProperty` on the descriptor object (raw):
    // `getPropRaw` alone returns an undefined-valued handle for a plain
    // miss, which would misread an accessor as data.
    if (hasOwnRaw(e, shim, desc.ptr, 'value')) {
      getPropRaw(e, shim, desc.ptr, 'value')?.dispose();
      return { kind: 'data' };
    }
    // Accessor: never invoke; free the owned get/set handles.
    getPropRaw(e, shim, desc.ptr, 'get')?.dispose();
    getPropRaw(e, shim, desc.ptr, 'set')?.dispose();
    return { kind: 'accessor' };
  } finally {
    desc.dispose();
  }
}
