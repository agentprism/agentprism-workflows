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
import { getPropRaw, hasOwnRaw, readOwnDataProperty, readValue } from './trapfree.js';

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
 * A host call in flight: wraps a quickjs-wasi `Deferred` whose promise
 * handle was returned into the realm. The handler settles the call with a
 * host value (`resolve`) or a host error value (`reject`); both are
 * marshalled into the realm (plain data, errors, arrays, objects — never
 * guest code). Settlement is first-wins: a second resolve/reject is a
 * no-op, matching the guest's own idempotent settle-by-call-id. The
 * caller must run a job drain after settling for the guest's
 * continuations to fire.
 */
export class GuestCall {
  /** The owning VM (private — elided from the published declarations). */
  private readonly vm: ReplVm;
  /** The quickjs-wasi Deferred; its `handle` is the guest promise. */
  private readonly deferred: {
    handle: JSValueHandle;
    resolve(value: JSValueHandle): void;
    reject(value: JSValueHandle): void;
  };
  private settled = false;

  constructor(vm: ReplVm) {
    this.vm = vm;
    const shim = getVmShim(vm) as QuickJS;
    this.deferred = shim.newPromise();
    guestCallHandles.set(this, this.deferred.handle);
  }

  /**
   * Resolve the call with a host value (marshalled into the realm). The
   * promise's reactions fire on the next job drain.
   */
  resolve(value: unknown): void {
    this.settle(() => this.deferred.resolve(marshalValue(this.shim(), value)));
  }

  /**
   * Reject the call with a host error value (an Error, or a plain
   * `{ message, name?, code?, recoverable? }` object — the guest
   * normalizes both). The promise's reactions fire on the next job drain.
   */
  reject(error: unknown): void {
    this.settle(() => this.deferred.reject(marshalValue(this.shim(), error)));
  }

  private shim(): QuickJS {
    return getVmShim(this.vm) as QuickJS;
  }

  private settle(apply: () => void): void {
    if (this.settled) return; // first settlement wins, like the guest registry
    this.settled = true;
    apply();
  }
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
   * An `agent()` call. `optionsJson` is the JSON-encoded options bag
   * (or `null` when none were given). Settle `call` when the worker's
   * result (final text, or the schema-validated object when the options
   * carried a schema) is ready.
   */
  agent(call: GuestCall, callId: string, prompt: string, optionsJson: string | null): void;
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
   * A steering operation on a live agent handle: `action` is
   * `"followUp"` | `"steer"` | `"cancel"`; `payloadJson` is the
   * JSON-encoded `{ prompt, options }` bag for followUp/steer or `null`
   * for cancel. Settle `call` with what actually happened (the steering
   * outcome — live injection vs queued delivery — mirroring the outcome
   * values acp-agents surfaces in its steering events).
   */
  steer(call: GuestCall, callId: string, action: string, payloadJson: string | null): void;
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
 */
function makeAgentHostFunction(vm: ReplVm, handlers: GuestBridgeHandlers): HostFunction {
  return function (this: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    const callId = requireString(args[0], HOST_AGENT, 'callId');
    const prompt = requireString(args[1], HOST_AGENT, 'prompt');
    const optionsJson = optionalString(args[2]);
    const call = new GuestCall(vm);
    handlers.agent(call, callId, prompt, optionsJson);
    return guestCallHandle(call);
  };
}

/**
 * The `__host_agent_steer` shape: same pattern as `__host_agent`, with
 * `action` ("followUp" | "steer" | "cancel") and a JSON-encoded payload
 * (or null for cancel).
 */
function makeSteerHostFunction(vm: ReplVm, handlers: GuestBridgeHandlers): HostFunction {
  return function (this: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    const callId = requireString(args[0], HOST_STEER, 'callId');
    const action = requireString(args[1], HOST_STEER, 'action');
    const payloadJson = optionalString(args[2]);
    const call = new GuestCall(vm);
    handlers.steer(call, callId, action, payloadJson);
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
    handlers.checkpoint(call, callId, question, optionsJson, null);
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
    const pendingHandle = readOwnDataProperty(surfaceHandle, 'pending');
    const settleHandle = readOwnDataProperty(surfaceHandle, 'settle');
    const statsHandle = readOwnDataProperty(surfaceHandle, 'stats');
    if (
      pendingHandle === undefined ||
      settleHandle === undefined ||
      statsHandle === undefined ||
      !pendingHandle.isFunction ||
      !settleHandle.isFunction ||
      !statsHandle.isFunction
    ) {
      return undefined;
    }
    return {
      version,
      pending: () => readCallFunction(vm, pendingHandle) as GuestSurfaceEntry[],
      settle: (callId, outcome, value) => callSettle(vm, settleHandle, callId, outcome, value),
      stats: () => readCallFunction(vm, statsHandle) as ReturnType<GuestSurface['stats']>,
    };
  } finally {
    symbol.dispose();
    surfaceHandle?.dispose();
  }
}

/**
 * Call one of the library's own surface functions and read its result
 * trap-free. The functions are the library's frozen closures (no
 * guest-authored code can be substituted), and the arguments are
 * pre-validated so the library functions cannot throw; the result read
 * uses the trap-free `readValue` path.
 */
function readCallFunction(vm: ReplVm, fn: JSValueHandle): unknown {
  const shim = getVmShim(vm) as QuickJS;
  const result = shim.callFunction(fn, shim.undefined);
  try {
    if (result.isUndefined) return undefined;
    return readValue(result, 0, new Set());
  } finally {
    result.dispose();
  }
}

function callSettle(
  vm: ReplVm,
  settleFn: JSValueHandle,
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
  const callIdHandle = shim.newString(callId);
  const outcomeHandle = shim.newString(outcome);
  const valueHandle = marshalValue(shim, value);
  let result: JSValueHandle | undefined;
  try {
    result = shim.callFunction(settleFn, shim.undefined, callIdHandle, outcomeHandle, valueHandle);
    if (!result.isBool) return false;
    return result.toBoolean();
  } finally {
    callIdHandle.dispose();
    outcomeHandle.dispose();
    valueHandle.dispose();
    result?.dispose();
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
