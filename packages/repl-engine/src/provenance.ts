/**
 * The host side of the workspace manifest's per-binding provenance (the
 * roadmap doc's `status` manifest: "provenance (which subagent produced
 * the value, from what task, when)" — metadata only, never content).
 *
 * The registry itself lives INSIDE the realm under
 * `Symbol.for("repl.provenance")` (see `src/guest/guest-library.ts`): the
 * guest library installs it at VM creation, so it travels inside
 * snapshots, survives restore, and rolls back coherently with a workspace
 * snapshot. This module drives it from the host:
 *
 * - `baselineGlobalKeys` — the fresh-realm key set (builtins + the four
 *   host functions + the guest library's globals + the structured-clone
 *   extension's `structuredClone`), captured once per process from a
 *   throwaway VM provisioned exactly like a real workspace. User bindings
 *   are recognized by set difference against this baseline (the harness
 *   manifest's own discipline), so the manifest lists exactly what the
 *   orchestrator (or its workers' results) put in the global scope.
 * - `provenanceBootstrap` — fills the registry's `known` set from the
 *   baseline and CREATES the registry when a snapshot predates the
 *   feature (a pre-provenance restore: the library is never re-evaluated
 *   over a restored workspace, so the host installs a byte-identical
 *   registry and the restore sweep attributes pre-existing bindings to
 *   `session restore` — "first seen at restore", never a guessed origin).
 * - `provenanceRecord` — one maintenance pass after a guest-entering
 *   operation (an eval, a settlement drain, the restore sweep): diffs the
 *   global scope against the registry's `prev`/`known` sets and
 *   attributes NEW or REBOUND bindings (SameValue — NaN is stable) to the
 *   operation's host-shaped origin label (`eval N` with the registry's
 *   own monotonic, snapshot-durable counter; `worker c1+c2`; `session
 *   restore`). GLOBAL LEXICAL bindings (top-level let/const/class) are
 *   tracked by their VALUES: the host reads each binding's current value
 *   through the internal global-var object and hands it to the registry,
 *   which RE-ATTRIBUTES a changed value to the operation that produced
 *   it — a `let` binding assigned a worker result, or a suspended `const
 *   finding = await research` whose continuation assigned the settled
 *   value, re-attributes to the settlement's `worker cN` label, so the
 *   manifest reports which subagent produced the current value, from
 *   what task, when. In-place mutation of a binding's VALUE (a property
 *   of the bound object, say) deliberately does NOT re-attribute (the
 *   binding still refers to the value its recorded origin produced).
 *   The pass is trap-free by construction: own-property-descriptor reads
 *   only (an accessor-rebound binding is detected through its getter
 *   FUNCTION identity, never invoked), and the whole pass is the guest
 *   library's frozen closure — no guest-authored code runs.
 * - `provenanceView` — the registry read for rendering, SANITIZED: only
 *   host-shaped labels survive (`eval N` / `worker <ids>` / `session
 *   restore`); a vandalized registry degrades to missing provenance,
 *   never to content in the manifest.
 *
 * The maintenance pass is a guest-side function (the library's frozen
 * closure) driven over the raw call machinery — the same discipline as
 * the reconciliation surface's member calls.
 */

import { JSValueHandle, type QuickJS } from 'quickjs-wasi';

import { installGuestBridge, type GuestBridgeHandlers } from './bridge.js';
import { GUEST_PROVENANCE_KEY, PROVENANCE_FACTORY } from './guest/guest-library.js';
import { rawLexicalKeys, readLexicalSlotValue } from './global-lexical.js';
import { wasmSha256Of } from './snapshot-envelope.js';import {
  getPropRaw,
  hasOwnRaw,
  rawOwnKeys,
  readValueComplete,
  takeAndFreeException,
  type QuickJSExports,
} from './trapfree.js';
import type { WasmInput } from './types.js';
import { ReplVm, getVmShim } from './vm.js';

/** The origin of one maintenance pass (see the module docs). */
export type ProvenanceOrigin =
  /** A root eval: the label is `eval N` with the registry's own counter. */
  | { kind: 'eval' }
  /** A settlement batch: the calls settled into the guest (`worker c3`, or
   *  `worker c3+c4` for a multi-call batch — batch granularity is honest
   *  ambiguity). */
  | { kind: 'settlement'; callIds: string[] }
  /** The restore sweep for PRE-PROVENANCE snapshots (`session restore`). */
  | { kind: 'restore' };

/** One binding's provenance as read back for rendering (unvalidated until
 *  `provenanceView` sanitizes it). */
export interface OriginRecord {
  via: string;
  at: number;
}

/** The sanitized registry contents used for rendering. */
export interface ProvenanceView {
  evalSeq: number;
  origins: Map<string, OriginRecord>;
}

/** A fresh-realm baseline key set (see the module docs). */
export type BaselineKeys = string[];

// The baseline is computed once per process per wasm binary (a throwaway
// VM instantiation); the shipped binary dominates, and a custom wasm
// input hashes directly.
const baselineCache = new Map<string, Promise<BaselineKeys>>();
const baselineCacheByModule = new WeakMap<object, Promise<BaselineKeys>>();

/**
 * The fresh-realm global key set for a wasm binary: a throwaway VM is
 * provisioned exactly like a real workspace (same binary, same
 * structured-clone extension, same host functions, same guest library)
 * and its string-key set is captured trap-free. Cached per process per
 * binary. Used both as the manifest's user-binding baseline and as the
 * provenance registry's `known` set.
 */
export function baselineGlobalKeys(wasm: WasmInput): Promise<BaselineKeys> {
  let key: string | undefined;
  try {
    key = wasmSha256Of(wasm);
  } catch {
    key = undefined;
  }
  if (key !== undefined) {
    const cached = baselineCache.get(key);
    if (cached !== undefined) return cached;
  } else if (typeof wasm === 'object' && wasm !== null) {
    const cached = baselineCacheByModule.get(wasm as object);
    if (cached !== undefined) return cached;
  }
  const promise = computeBaseline(wasm);
  if (key !== undefined) baselineCache.set(key, promise);
  else if (typeof wasm === 'object' && wasm !== null) baselineCacheByModule.set(wasm as object, promise);
  return promise;
}

/** The throwaway-VM baseline computation (see `baselineGlobalKeys`). */
async function computeBaseline(wasm: WasmInput): Promise<BaselineKeys> {
  const vm = await ReplVm.create({ wasm });
  try {
    await installGuestBridge(vm, NOOP_HANDLERS);
    const shim = getVmShim(vm) as QuickJS;
    return rawOwnKeys(shim.global);
  } finally {
    vm.dispose();
  }
}

// The fresh-realm LEXICAL baseline: top-level `let`/`const`/`class`
// bindings a provisioned realm carries before any user eval. The guest
// library deliberately declares only `var`s inside its IIFE, so the set
// is EMPTY on the shipped library — but a future library that used
// lexical declarations would otherwise leak its internals into the
// manifest's user bindings, so the baseline is computed, cached and
// subtracted exactly like the global one.
const lexicalBaselineCache = new Map<string, Promise<string[]>>();
const lexicalBaselineCacheByModule = new WeakMap<object, Promise<string[]>>();

/**
 * The fresh-realm GLOBAL LEXICAL key set for a wasm binary (top-level
 * `let`/`const`/`class` bindings — see `global-lexical.ts`): a throwaway
 * VM is provisioned exactly like a real workspace and its lexical key
 * set is captured through the internal global-var object. Cached per
 * process per binary, mirroring `baselineGlobalKeys`. The workspace
 * manifest subtracts this set (alongside the global baseline) from its
 * user-binding enumeration.
 */
export function baselineLexicalKeys(wasm: WasmInput): Promise<string[]> {
  let key: string | undefined;
  try {
    key = wasmSha256Of(wasm);
  } catch {
    key = undefined;
  }
  if (key !== undefined) {
    const cached = lexicalBaselineCache.get(key);
    if (cached !== undefined) return cached;
  } else if (typeof wasm === 'object' && wasm !== null) {
    const cached = lexicalBaselineCacheByModule.get(wasm as object);
    if (cached !== undefined) return cached;
  }
  const promise = computeLexicalBaseline(wasm);
  if (key !== undefined) lexicalBaselineCache.set(key, promise);
  else if (typeof wasm === 'object' && wasm !== null) lexicalBaselineCacheByModule.set(wasm as object, promise);
  return promise;
}

/** The throwaway-VM lexical baseline computation (see
 *  `baselineLexicalKeys`). */
async function computeLexicalBaseline(wasm: WasmInput): Promise<string[]> {
  const vm = await ReplVm.create({ wasm });
  try {
    await installGuestBridge(vm, NOOP_HANDLERS);
    return rawLexicalKeys(vm);
  } finally {
    vm.dispose();
  }
}

/** The parking-bridge stand-in for the throwaway baseline VM: the four
 *  host functions exist (the library only needs the names). */
const NOOP_HANDLERS: GuestBridgeHandlers = {
  agent: () => undefined,
  checkpoint: () => undefined,
  steer: () => undefined,
  console: () => undefined,
};

/**
 * Install (or complete) the provenance registry on a workspace's VM:
 * fills the `known` baseline set from `baselineGlobalKeys(wasm)` and
 * CREATES the registry when the snapshot predates the feature (a
 * pre-provenance restore). Returns whether the registry was created by
 * this call (the caller then runs the `session restore` sweep so
 * pre-existing bindings are attributed as "first seen at restore", never
 * guessed) plus the baseline key set (the manifest's user-binding
 * baseline). Never errors upward: provenance is orientation metadata; a
 * realm hostile enough to break the bootstrap simply has none.
 */
export async function provenanceBootstrap(
  vm: ReplVm,
  wasm: WasmInput,
): Promise<{ created: boolean; baseline: BaselineKeys }> {
  const baseline = await baselineGlobalKeys(wasm);
  const shim = getVmShim(vm) as QuickJS;
  const symbol = shim.newSymbolFor(GUEST_PROVENANCE_KEY);
  let existing: JSValueHandle | undefined;
  try {
    existing = shim.getProp(shim.global, symbol);
    const namesJson = JSON.stringify(baseline);
    if (existing.isUndefined || !existing.isObject) {
      // A pre-provenance snapshot: install the byte-identical registry
      // (the same factory the library evaluates at install time) with the
      // baseline as its `known` set.
      const source =
        `(function () { try { var KEY = Symbol.for(${JSON.stringify(GUEST_PROVENANCE_KEY)}); ` +
        `var reg = (${PROVENANCE_FACTORY})(${namesJson}); ` +
        `Object.defineProperty(globalThis, KEY, { value: reg, writable: false, enumerable: false, ` +
        `configurable: false }); return 1; } catch (e) { return 0; } })()`;
      const outcome = await vm.evalCode(source, { filename: '<provenance-bootstrap>' });
      return { created: outcome.kind !== 'error', baseline };
    }
    // The registry already exists (a fresh install, or a post-feature
    // snapshot whose registry travels with the workspace): fill the
    // `known` set from the current baseline (a same-version snapshot's
    // set is already identical — this is a no-op; an older-library
    // snapshot's known set legitimately reflects the older library and is
    // left alone except for names the current baseline adds).
    const source =
      `(function () { try { var KEY = Symbol.for(${JSON.stringify(GUEST_PROVENANCE_KEY)}); ` +
      `var reg = globalThis[KEY]; if (!reg || typeof reg !== 'object') return 0; ` +
      `var names = ${namesJson}; for (var i = 0; i < names.length; i++) reg.known[names[i]] = true; ` +
      `return 1; } catch (e) { return 0; } })()`;
    const outcome = await vm.evalCode(source, { filename: '<provenance-bootstrap>' });
    void outcome;
    return { created: false, baseline };
  } finally {
    existing?.dispose();
    symbol.dispose();
  }
}

/**
 * One maintenance pass (see the module docs): attribute new/rebound user
 * bindings (including `$N` globals) to the operation's origin. Errors are
 * swallowed by design — provenance is orientation metadata.
 */
export function provenanceRecord(vm: ReplVm, origin: ProvenanceOrigin): void {
  const shim = getVmShim(vm) as QuickJS;
  const e = shim._getExports();
  const symbol = shim.newSymbolFor(GUEST_PROVENANCE_KEY);
  let registryHandle: JSValueHandle | undefined;
  let recordFn: JSValueHandle | undefined;
  let labelHandle: JSValueHandle | undefined;
  let ownsLabel = false;
  let atHandle: JSValueHandle | undefined;
  let lexHandle: JSValueHandle | undefined;
  try {
    registryHandle = shim.getProp(shim.global, symbol);
    if (registryHandle.isUndefined || !registryHandle.isObject) return;
    recordFn = readOwnDataPropertyShim(e, shim, registryHandle, 'record');
    if (recordFn === undefined || !recordFn.isFunction) return;
    if (origin.kind === 'eval') {
      // The registry computes `eval N` from its own snapshot-durable
      // counter; the null/undefined label is the "eval pass" marker. The
      // singleton undefined handle is NOT owned by this function.
      labelHandle = shim.undefined;
    } else {
      const label =
        origin.kind === 'settlement' ? `worker ${origin.callIds.join('+')}` : 'session restore';
      labelHandle = shim.newString(label);
      ownsLabel = true;
    }
    atHandle = shim.newNumber(Date.now());
    // The pass's THIRD argument: the realm's global LEXICAL binding
    // names as a JSON array string (see the factory in
    // `guest-library.ts`). Lexical bindings cannot be enumerated
    // guest-side; the host reaches them through the engine's internal
    // global-var object (see `global-lexical.ts`) and hands the names
    // over here — the same host-driven channel as every other aspect of
    // the pass (no guest-visible surface grows for it). A registry whose
    // record closure predates the feature (an older snapshot) simply
    // ignores the argument.
    const lexNames = rawLexicalKeys(vm);
    lexHandle = shim.newString(JSON.stringify(lexNames));
    // The pass's FOURTH+ arguments: the realm's CURRENT LEXICAL VALUES,
    // one realm value per name in the names array's order (the factory
    // reads them at `arguments[3 + i]`). The host reads each binding
    // through the internal global-var object's descriptor machinery and
    // hands the VALUES over so the registry can detect a CHANGE
    // (SameValue) and RE-ATTRIBUTE: a `let` binding assigned a worker
    // result, or a suspended `const finding = await research` whose
    // continuation assigned the settled value, re-attributes to the
    // settlement's `worker cN` label — the manifest then reports WHICH
    // subagent produced the current value, from what task, when
    // (phase-E review rejection: the lexical entry was recorded on
    // first sight only, so a value the worker settlement produced kept
    // the declaring eval's label with no task). A registry whose record
    // closure predates the feature (an older snapshot) ignores the
    // extra arguments and degrades to first-sight-only attribution.
    // The handles are BORROWED by the call (callRaw never frees its
    // arguments) and disposed afterwards; `shim.undefined` (a cached
    // singleton — dispose is a no-op) stands in for an unreadable
    // binding (a TDZ cell reads as its raw uninitialized marker, which
    // is passed through unchanged — SameValue against the settled value
    // differs, so the re-attribution still fires).
    const lexValues: JSValueHandle[] = [];
    for (const name of lexNames) {
      const value = readLexicalSlotValue(vm, name);
      lexValues.push(value ?? shim.undefined);
    }
    try {
      const result = new JSValueHandle(
        shim,
        callRaw(e, shim, recordFn.ptr, [labelHandle, atHandle, lexHandle, ...lexValues]),
      );
      try {
        if (e.qjs_is_exception(result.ptr) !== 0) takeAndFreeException(e, shim);
      } finally {
        result.dispose();
      }
    } finally {
      for (const value of lexValues) value.dispose();
    }
  } finally {
    if (ownsLabel) labelHandle?.dispose();
    atHandle?.dispose();
    lexHandle?.dispose();
    recordFn?.dispose();
    registryHandle?.dispose();
    symbol.dispose();
  }
}

/**
 * Read the registry for rendering, SANITIZED: only host-shaped origin
 * labels survive (`eval N` / `worker <ids>` / `session restore`); a
 * vandalized registry degrades to missing provenance, never to content in
 * the manifest. The read itself is trap-free and COMPLETE (the registry's
 * own `read` closure returns plain data; `readValueComplete` reads own
 * data properties with no property-count cap — phase-E review round 4:
 * the generic 256-property cap silently dropped bindings 256+ from the
 * manifest's provenance, reporting null provenance for bindings the eval
 * did create; the registry is the host's own metadata, bounded by the
 * VM's memory like the bindings it describes).
 */
export function provenanceView(vm: ReplVm): ProvenanceView {
  const shim = getVmShim(vm) as QuickJS;
  const e = shim._getExports();
  const symbol = shim.newSymbolFor(GUEST_PROVENANCE_KEY);
  let registryHandle: JSValueHandle | undefined;
  let readFn: JSValueHandle | undefined;
  try {
    registryHandle = shim.getProp(shim.global, symbol);
    if (registryHandle.isUndefined || !registryHandle.isObject) return emptyView();
    readFn = readOwnDataPropertyShim(e, shim, registryHandle, 'read');
    if (readFn === undefined || !readFn.isFunction) return emptyView();
    const result = new JSValueHandle(shim, callRaw(e, shim, readFn.ptr, []));
    try {
      if (e.qjs_is_exception(result.ptr) !== 0) {
        takeAndFreeException(e, shim);
        return emptyView();
      }
      if (result.isUndefined) return emptyView();
      const data = readValueComplete(result) as { evalSeq?: unknown; origins?: unknown } | null;
      if (typeof data !== 'object' || data === null) return emptyView();
      const origins = new Map<string, OriginRecord>();
      if (typeof data.origins === 'object' && data.origins !== null) {
        for (const [name, record] of Object.entries(data.origins as Record<string, unknown>)) {
          const r = record as { via?: unknown; at?: unknown } | null;
          if (typeof r !== 'object' || r === null) continue;
          if (typeof r.via !== 'string' || !isValidOriginLabel(r.via)) continue;
          origins.set(name, { via: r.via, at: typeof r.at === 'number' ? r.at : 0 });
        }
      }
      return {
        evalSeq: typeof data.evalSeq === 'number' ? data.evalSeq : 0,
        origins,
      };
    } finally {
      result.dispose();
    }
  } finally {
    readFn?.dispose();
    registryHandle?.dispose();
    symbol.dispose();
  }
}

function emptyView(): ProvenanceView {
  return { evalSeq: 0, origins: new Map() };
}

/** Whether an origin label matches one of the shapes this host writes
 *  (see the module docs; the harness manifest's validation shapes). */
export function isValidOriginLabel(label: string): boolean {
  if (label === 'session restore') return true;
  if (label.startsWith('eval ')) {
    const digits = label.slice('eval '.length);
    return digits.length > 0 && digits.length <= 10 && /^[0-9]+$/.test(digits);
  }
  if (label.startsWith('worker ')) {
    const ids = label.slice('worker '.length);
    return ids.length > 0 && ids.split('+').every((id) => isValidCallId(id));
  }
  return false;
}

/** A plausible call id: short, no whitespace, the guest id charset. */
function isValidCallId(id: string): boolean {
  return id.length > 0 && id.length <= 32 && /^[A-Za-z0-9_-]+$/.test(id);
}

/** Raw own-data-property read over the exports (no JSException ever). */
function readOwnDataPropertyShim(
  e: QuickJSExports,
  shim: QuickJS,
  handle: JSValueHandle,
  key: string,
): JSValueHandle | undefined {
  if (handle.isProxy) return undefined;
  const keyHandle = shim.newString(key);
  let descPtr: number;
  try {
    descPtr = e.qjs_get_own_property_descriptor(handle.ptr, keyHandle.ptr);
  } finally {
    keyHandle.dispose();
  }
  if (descPtr === 0) return undefined;
  const desc = new JSValueHandle(shim, descPtr);
  try {
    if (e.qjs_is_exception(desc.ptr) !== 0) {
      const excPtr = e.qjs_get_exception();
      if (excPtr !== 0) new JSValueHandle(shim, excPtr).dispose();
      return undefined;
    }
    // Has an own "value" (data descriptor)? Read it raw.
    const has = hasOwnRaw(e, shim, desc.ptr, 'value');
    if (!has) {
      getPropRaw(e, shim, desc.ptr, 'get')?.dispose();
      getPropRaw(e, shim, desc.ptr, 'set')?.dispose();
      return undefined;
    }
    return getPropRaw(e, shim, desc.ptr, 'value');
  } finally {
    desc.dispose();
  }
}

/** Raw `qjs_call` with borrowed arguments (mirrors bridge.ts's callRaw). */
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
