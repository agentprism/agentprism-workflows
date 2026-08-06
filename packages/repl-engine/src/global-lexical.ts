/**
 * The host's door into the realm's GLOBAL LEXICAL bindings — top-level
 * `let`/`const`/`class` declarations, the roadmap doc's canonical
 * workspace state (`const research = agent(...)`). The workspace
 * manifest's binding enumeration (see `Workspace.manifest`) and the
 * provenance registry's attribution pass both need these names; this
 * module is the seam that reaches them.
 *
 * ## Why a seam at all
 *
 * ECMAScript's global declarative record is deliberately
 * non-reflectable: no guest API can enumerate global lexical bindings
 * (`Object.getOwnPropertyNames(globalThis)` lists only the object-record
 * side — `var`/function declarations and host globals), and no
 * JS-visible surface exposes them. quickjs-ng (the engine the shipped
 * `quickjs.wasm` binary runs) stores them in an INTERNAL object,
 * `ctx->global_var_obj` — a null-prototype object holding the lexical
 * declarations as own properties (`JS_DefineGlobalVar`), reachable from
 * C but from nothing the guest can see.
 *
 * ## The mechanism
 *
 * The shipped binary (quickjs-ng 0.15.1) exposes `qjs_get_context_ptr()`
 * and the global object's own JSValue through the shim, and — verified
 * against the v0.15.1 source — the `JSContext` struct holds
 * `global_obj` and `global_var_obj` as ADJACENT JSValue fields. The
 * binary is NaN-boxed, so a JSValue is 8 bytes
 * (`[payload u32][tag i32]`, `JS_TAG_OBJECT = -1`) and the object
 * pointer is the payload. This module therefore LOCATES the global-var
 * object with a self-calibrating scan:
 *
 * 1. read the global object's pointer from the shim's cached global
 *    handle (the payload of its JSValue);
 * 2. scan the `JSContext` for the 8-byte slot holding exactly that
 *    pointer with the object tag — that is `global_obj`'s slot;
 * 3. the adjacent slot (offset +8) is `global_var_obj` (the adjacency
 *    invariant);
 * 4. fabricate a handle over that slot: 8 bytes of scratch wasm memory
 *    holding `[global_var_obj pointer][object tag]`, wrapped as a
 *    VM-lifetime handle whose `dispose` is a no-op (the reference it
 *    exposes belongs to the context, never to the scratch).
 *
 * The fabricated handle then exposes the whole trap-free introspection
 * machinery (own-key enumeration, own-property-descriptor reads) over
 * the lexical bindings — the same machinery the manifest uses for
 * global-object bindings.
 *
 * The scan is verified end-to-end by the test suite: a workspace whose
 * evals created lexical bindings must list them in the manifest. A
 * layout the scan cannot find (a quickjs build where the fields moved or
 * the value encoding changed) REFUSES with `LexicalEnumerationError` —
 * a loud, coded error, never silent omission of the workspace's
 * bindings (the package's "never silently discards data" posture; the
 * pinned quickjs-wasi version's layout is stable, and the snapshot
 * envelope already refuses loudly on a binary change).
 */

import { JSValueHandle, type QuickJS } from 'quickjs-wasi';

import { LexicalEnumerationError } from './errors.js';
import { getVmShim, type ReplVm } from './vm.js';
import { getPropRaw, hasOwnRaw, rawOwnKeys } from './trapfree.js';

/** The object tag in the NaN-boxed JSValue encoding (`JS_TAG_OBJECT`). */
const JS_TAG_OBJECT = -1;

/** The JSValue slot size in the NaN-boxed encoding (8 bytes). */
const JSVALUE_BYTES = 8;

/** How far into the `JSContext` struct to scan for the `global_obj`
 *  slot (the field sits ~300 bytes in on the shipped build; the window
 *  is generous). */
const CONTEXT_SCAN_WINDOW = 4096;

/** The per-VM fabricated handle (see the module docs; a VM-lifetime
 *  scratch value, never disposed). */
const lexicalHandles = new WeakMap<ReplVm, JSValueHandle>();

/**
 * The fabricated handle over the realm's global-var object (see the
 * module docs): the VM-lifetime handle the trap-free introspection
 * machinery reads the lexical bindings through. The handle is created
 * once per VM (the scan is self-calibrating per wasm instance) and its
 * `dispose` is a no-op — the object reference it exposes is owned by
 * the context, not by this handle.
 *
 * **Internal**: returns a quickjs-wasi handle type, so it is NOT
 * re-exported from the package index (the published type graph stays
 * free of quickjs-wasi types).
 */
export function globalVarObjectHandle(vm: ReplVm): JSValueHandle {
  const cached = lexicalHandles.get(vm);
  if (cached !== undefined) return cached;
  const shim = getVmShim(vm) as QuickJS;
  const e = shim._getExports();
  const memory = e.memory;
  const view = new DataView(memory.buffer);
  const ctxPtr = e.qjs_get_context_ptr();
  const limit = Math.min(ctxPtr + CONTEXT_SCAN_WINDOW + JSVALUE_BYTES, memory.buffer.byteLength);
  // The global object's pointer: the payload of the shim's cached
  // global handle (an object JSValue — payload + object tag).
  const globalPayload = view.getUint32(shim.global.ptr, true);
  let varSlot = -1;
  for (let off = ctxPtr; off + 2 * JSVALUE_BYTES <= limit; off += JSVALUE_BYTES) {
    if (view.getUint32(off, true) !== globalPayload) continue;
    if (view.getInt32(off + 4, true) !== JS_TAG_OBJECT) continue;
    // The adjacency invariant: the next slot is `global_var_obj` — a
    // plausible object JSValue (a nonzero pointer into wasm memory with
    // the object tag). Without the adjacency check a stray slot holding
    // the global pointer would be misread as the pair.
    const varPayload = view.getUint32(off + JSVALUE_BYTES, true);
    if (varPayload === 0 || varPayload >= memory.buffer.byteLength) continue;
    if (view.getInt32(off + JSVALUE_BYTES + 4, true) !== JS_TAG_OBJECT) continue;
    varSlot = off + JSVALUE_BYTES;
    break;
  }
  if (varSlot < 0) {
    throw new LexicalEnumerationError(
      `no global-var-object slot found in the JSContext (the running binary's layout does not match ` +
        `the adjacency invariant; the manifest cannot enumerate top-level let/const/class bindings)`,
    );
  }
  // Fabricate the handle: an 8-byte scratch JSValue in wasm memory,
  // owned by the VM for its lifetime (never freed — the reference it
  // holds belongs to the context, not to this scratch slot). The
  // singleton flag makes `dispose` a no-op, so no later path can
  // decrement the context's reference.
  const scratch = e.wasm_malloc(JSVALUE_BYTES);
  const write = new DataView(memory.buffer);
  write.setUint32(scratch, view.getUint32(varSlot, true), true);
  write.setInt32(scratch + 4, JS_TAG_OBJECT, true);
  const handle = new JSValueHandle(shim, scratch, true);
  lexicalHandles.set(vm, handle);
  return handle;
}

/**
 * The global lexical binding names of a realm, trap-free: ALL own
 * string keys of the internal global-var object (the semantic
 * equivalent of `Object.getOwnPropertyNames` over the lexical
 * declarations — the same discipline `rawOwnKeys` applies to the global
 * object). **Internal** (see `globalVarObjectHandle`).
 */
export function rawLexicalKeys(vm: ReplVm): string[] {
  return rawOwnKeys(globalVarObjectHandle(vm));
}

/**
 * Resolve a global lexical binding trap-free and return its VALUE
 * handle, or `undefined` when the name is not a lexical binding (or the
 * read failed). The returned handle is owned by the caller. Mirrors the
 * global-object reader (`preview.ts`'s `readSlotValue`) over the
 * global-var object's descriptor machinery. **Internal** (see
 * `globalVarObjectHandle`).
 */
export function readLexicalSlotValue(vm: ReplVm, name: string): JSValueHandle | undefined {
  const shim = getVmShim(vm) as QuickJS;
  const e = shim._getExports();
  const base = globalVarObjectHandle(vm);
  const keyHandle = shim.newString(name);
  let descPtr: number;
  try {
    descPtr = e.qjs_get_own_property_descriptor(base.ptr, keyHandle.ptr);
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
    // Data vs accessor via `hasOwnProperty` on the descriptor object
    // (raw): lexical bindings are always data (let/const/class), but the
    // discipline mirrors the global reader exactly.
    if (hasOwnRaw(e, shim, desc.ptr, 'value')) {
      const valueProp = getPropRaw(e, shim, desc.ptr, 'value');
      if (valueProp !== undefined) return valueProp;
      return undefined; // allocation failure edge — reads as absent
    }
    getPropRaw(e, shim, desc.ptr, 'get')?.dispose();
    getPropRaw(e, shim, desc.ptr, 'set')?.dispose();
    return undefined;
  } finally {
    desc.dispose();
  }
}
