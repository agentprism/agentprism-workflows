/**
 * Trap-free introspection primitives — the engine's read surface for guest
 * state.
 *
 * Every function here drives the raw `qjs_*` exports of the quickjs-wasi
 * shim and **never executes guest code**: own-property-DESCRIPTOR reads
 * only (accessors are never invoked), engine-level brand checks (never
 * `instanceof`, never prototype inspection, never `Symbol.toStringTag`),
 * proxies guarded before any descriptor/key/prototype read (a proxy fires
 * traps on all of them), and raw native conversions only on values already
 * brand-checked as the matching primitive.
 *
 * This is the module the roadmap doc's transfer lesson R69 is enforced in:
 * a guest `Object.prototype.value` pollution, a getter installed on
 * `SyntaxError.prototype.name`, or a proxy whose every trap counts
 * executions must not be able to influence anything the host reads from
 * the realm. Failure modes degrade to `undefined`/`[]`/markers rather than
 * throwing through quickjs-wasi's `JSException` constructor (which
 * performs guest-visible `[[Get]]` reads of `name`/`message`/`stack` on
 * the exception value before any host `catch` can intercept).
 *
 * Handle ownership: every function that returns a `JSValueHandle` hands
 * ownership to the caller, who must dispose it. Every accessor `get`/`set`
 * handle encountered on a descriptor is disposed here — a leaked accessor
 * handle pins guest memory (review measured a 1 MiB VM exhausting after
 * ~3,128 accessor-valued completions).
 */

import { JSValueHandle, type QuickJS } from 'quickjs-wasi';

/** The raw WASM exports the engine drives (the type is not exported by the shim). */
export type QuickJSExports = ReturnType<QuickJS['_getExports']>;

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
export function readOwnDataProperty(handle: JSValueHandle, key: string): JSValueHandle | undefined {
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
 * The full trap-free own-property-descriptor read the previewer needs: the
 * value AND the `enumerable` flag, with accessors never invoked (their
 * handles are freed here). Failure modes (exception, accessor, proxy)
 * degrade to `undefined` exactly like `readOwnDataProperty`.
 */
export type OwnDescriptor =
  | { kind: 'data'; value: JSValueHandle; enumerable: boolean }
  | { kind: 'accessor'; enumerable: boolean };

export function readOwnDescriptor(handle: JSValueHandle, key: string): OwnDescriptor | undefined {
  // Proxies fire traps on descriptor reads — never touch one.
  if (handle.isProxy) return undefined;

  const vm = handle.vm;
  const e = vm._getExports();
  const keyHandle = vm.newString(key);
  let descPtr: number;
  try {
    descPtr = e.qjs_get_own_property_descriptor(handle.ptr, keyHandle.ptr);
  } finally {
    keyHandle.dispose();
  }
  if (descPtr === 0) return undefined;

  const desc = new JSValueHandle(vm, descPtr);
  try {
    if (e.qjs_is_exception(desc.ptr) !== 0) {
      takeAndFreeException(e, vm);
      return undefined;
    }
    const enumerable = readFlag(e, vm, desc.ptr, 'enumerable');
    if (hasOwnRaw(e, vm, desc.ptr, 'value')) {
      const value = getPropRaw(e, vm, desc.ptr, 'value');
      if (value === undefined) return undefined;
      return { kind: 'data', value, enumerable };
    }
    // Accessor: never invoke; free the owned get/set handles.
    getPropRaw(e, vm, desc.ptr, 'get')?.dispose();
    getPropRaw(e, vm, desc.ptr, 'set')?.dispose();
    return { kind: 'accessor', enumerable };
  } finally {
    desc.dispose();
  }
}

/**
 * Raw `hasOwnProperty` on an engine-created object (no prototype walk, no
 * traps).
 */
export function hasOwnRaw(e: QuickJSExports, vm: QuickJS, objPtr: number, key: string): boolean {
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
export function getPropRaw(
  e: QuickJSExports,
  vm: QuickJS,
  objPtr: number,
  key: string,
): JSValueHandle | undefined {
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
export function takeAndFreeException(e: QuickJSExports, vm: QuickJS): void {
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
export function rawOwnKeys(handle: JSValueHandle): string[] {
  const vm = handle.vm;
  const e = vm._getExports();
  // ALL own string keys (enumerable or not) — the semantic equivalent of
  // the guest's `Object.getOwnPropertyNames`: the provenance registry's
  // maintenance pass and the manifest's user-binding diff must agree on
  // the global key set, and the realm builtins (non-enumerable on
  // globalThis) belong in it. The shim's plain names export is
  // ENUM_ONLY (review probe: 16 keys on a fresh realm vs 70 for the
  // guest's getOwnPropertyNames) — never use it for scope enumeration.
  const keysPtr = e.qjs_get_own_property_names_all(handle.ptr);
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
 * Trap-free `Reflect.ownKeys` listing (strings AND symbols, enumerable or
 * not), with the materialized key array read back through own-property
 * descriptors per the preview format's enumeration-fill rule (FORMAT.md
 * §6): a hole in the materialized array is a binary contract violation and
 * reports `corrupted: true` instead of a fabricated key list.
 *
 * The returned `keys` entries are in `Reflect.ownKeys` order: canonical
 * array indices first, then string keys by insertion order, then symbols
 * (symbols carry no name — the previewer only counts them for the overflow
 * flag). `corrupted` callers must degrade to "list nothing, flag overflow".
 */
export interface OwnKey {
  /** The property name for string keys; `undefined` for symbol keys. */
  name: string | undefined;
  symbol: boolean;
}

export function rawOwnKeysAll(handle: JSValueHandle): { keys: OwnKey[]; corrupted: boolean } {
  const vm = handle.vm;
  const e = vm._getExports();
  // Proxies fire the ownKeys trap — never reached here (callers guard with
  // isProxy first), but the backstop guard costs nothing.
  if (handle.isProxy) return { keys: [], corrupted: true };
  const keysPtr = e.qjs_get_own_property_keys(handle.ptr);
  const keysHandle = new JSValueHandle(vm, keysPtr);
  if (e.qjs_is_exception(keysHandle.ptr) !== 0) {
    takeAndFreeException(e, vm);
    keysHandle.dispose();
    return { keys: [], corrupted: true };
  }
  try {
    const lenHandle = getPropRaw(e, vm, keysHandle.ptr, 'length');
    if (lenHandle === undefined) return { keys: [], corrupted: true };
    let len: number;
    try {
      len = lenHandle.toNumber();
    } finally {
      lenHandle.dispose();
    }
    const keys: OwnKey[] = [];
    for (let i = 0; i < len; i++) {
      // Descriptor read of the materialized element — never a plain [[Get]]
      // (FORMAT.md §6: under a broken fill a [[Get]] would fire a polluted
      // prototype accessor and fabricate keys). A hole is a binary
      // contract violation: degrade honestly.
      const element = readOwnDescriptor(keysHandle, String(i));
      if (element === undefined || element.kind !== 'data') {
        return { keys: [], corrupted: true };
      }
      try {
        if (element.value.isSymbol) {
          keys.push({ name: undefined, symbol: true });
        } else if (element.value.isString) {
          keys.push({ name: element.value.toString(), symbol: false });
        } else {
          // The materialized array holds only strings and symbols.
          return { keys: [], corrupted: true };
        }
      } finally {
        element.value.dispose();
      }
    }
    return { keys, corrupted: false };
  } finally {
    keysHandle.dispose();
  }
}

/**
 * Brand-checked typed-array info via the raw `qjs_get_typed_array_buffer`
 * export: byte length and bytes-per-element of the view. Returns
 * `undefined` for values that are not typed arrays (including DataView —
 * callers check `isDataView` first) and for failed reads (exception taken
 * out and freed). `length` is the element count (`byteLength / bpe`).
 */
export interface TypedArrayInfo {
  byteLength: number;
  bytesPerElement: number;
  length: number;
}

export function typedArrayInfo(handle: JSValueHandle): TypedArrayInfo | undefined {
  const vm = handle.vm;
  const e = vm._getExports();
  const outPtr = e.wasm_malloc(12);
  try {
    // The export returns the view's backing ArrayBuffer as an OWNED JSValue
    // (heap box) — or the exception sentinel box for non-views. Both are
    // owned by us and both are disposed here: a leaked buffer handle pins
    // the entire backing store of the view, so repeated previews without
    // disposal accumulate WASM/QuickJS allocations (review measured the
    // same class of leak exhausting small VMs). The exception path also
    // takes the runtime exception the C read set, out and frees it.
    const bufferPtr = e.qjs_get_typed_array_buffer(handle.ptr, outPtr, outPtr + 4, outPtr + 8);
    if (bufferPtr === 0) return undefined; // allocation edge — nothing owned
    const buffer = new JSValueHandle(vm, bufferPtr);
    try {
      if (e.qjs_is_exception(buffer.ptr) !== 0) {
        // Not a typed-array view: free the sentinel box and clear the
        // pending engine exception it set (mirrors the Rust reference
        // implementation's typed_array_info).
        takeAndFreeException(e, vm);
        return undefined;
      }
      const view = new DataView(e.memory.buffer);
      const byteLength = view.getUint32(outPtr + 4, true);
      const bytesPerElement = view.getUint32(outPtr + 8, true);
      if (bytesPerElement === 0) return undefined;
      return {
        byteLength,
        bytesPerElement,
        length: byteLength / bytesPerElement,
      };
    } finally {
      buffer.dispose();
    }
  } finally {
    e.wasm_free(outPtr);
  }
}

/**
 * ArrayBuffer byte length via the raw `qjs_get_array_buffer` export
 * (returns the data pointer and writes the byte length to the out slot).
 * `undefined` for non-ArrayBuffers and failed reads.
 */
export function arrayBufferByteLength(handle: JSValueHandle): number | undefined {
  const vm = handle.vm;
  const e = vm._getExports();
  // Callers brand-check `isArrayBuffer` first (FORMAT.md §1: engine brand
  // checks only). The export returns a RAW byte pointer into WASM linear
  // memory — NOT a JSValue — so it must never be passed to
  // `qjs_is_exception`: a guest-controlled buffer could begin with the
  // exception tag and be misread as a failed read (review: a 16-byte
  // buffer then rendered as `ArrayBuffer(0)`). A NULL return means not an
  // ArrayBuffer, a detached buffer, or an allocation edge; the runtime
  // exception slot is cleared defensively (the C read may set one — the
  // Rust reference implementation does the same).
  const outPtr = e.wasm_malloc(4);
  try {
    const dataPtr = e.qjs_get_array_buffer(handle.ptr, outPtr);
    if (dataPtr === 0) {
      takeAndFreeException(e, vm);
      return undefined;
    }
    return new DataView(e.memory.buffer).getUint32(outPtr, true);
  } finally {
    e.wasm_free(outPtr);
  }
}

/**
 * The `[[ProxyTarget]]` of a proxy, trap-free (read through the raw export,
 * no traps). Returns `undefined` for revoked proxies and failed reads —
 * never constructs quickjs-wasi's `JSException`. The returned handle is
 * owned by the caller and must be disposed.
 */
export function readProxyTarget(handle: JSValueHandle): JSValueHandle | undefined {
  const vm = handle.vm;
  const e = vm._getExports();
  // The export returns an OWNED heap box: the target for a live proxy, or
  // the exception sentinel for a revoked one (the C read also sets a
  // pending runtime exception). Every non-success path disposes the box
  // AND takes the runtime exception out — a leaked exception box
  // accumulates on every revoked-proxy preview (review: repeated previews
  // grew WASM/QuickJS allocations).
  const targetPtr = e.qjs_get_proxy_target(handle.ptr);
  if (targetPtr === 0) return undefined; // allocation edge — nothing owned
  const target = new JSValueHandle(vm, targetPtr);
  if (e.qjs_is_exception(target.ptr) !== 0) {
    target.dispose();
    takeAndFreeException(e, vm);
    return undefined; // revoked proxy
  }
  if (target.isUndefined || target.isNull) {
    target.dispose();
    return undefined; // revoked
  }
  return target; // owned by the caller — must be disposed
}

/**
 * Render a guest value into host data without ever executing guest code:
 * primitives via native conversions, objects via own enumerable
 * data-property descriptor reads, brand checks for the engine-recognized
 * object kinds (markers), depth/property caps and a cycle guard so
 * adversarial shapes stay bounded.
 *
 * `maxLen` bounds the ARRAY read (default 256): the general preview read
 * (a completion value, a provenance registry) truncates arrays past the
 * cap with a `'[ArrayTruncated]'` marker. The COMPLETE read — the
 * host-owned metadata surfaces (`readValueComplete`: the pending-call
 * registry, the await log, the provenance registry's `read()` result) —
 * lifts both caps: those surfaces are the frozen guest library's own
 * metadata, never guest content, and truncating them leaks markers into
 * the broker's id lists (phase-E review round 3: the 16 384-element cap
 * truncated the pending registry and its marker mapped to `undefined`;
 * the 256-property cap dropped bindings 256+ from the manifest's
 * provenance).
 *
 * This is the conservative seed of the ObjectPreview rendering the tool
 * result eventually carries (the full CDP-style previewer is
 * `preview.ts`); everything read here is trap-free and bounded.
 */
export function readValue(handle: JSValueHandle, depth: number, seen: Set<number>, maxLen = 256): unknown {
  return readValueBounded(handle, depth, seen, maxLen, 256);
}

/**
 * The COMPLETE trap-free read for host-owned metadata surfaces — the
 * guest-surface reads (the pending-call registry, the await log) and the
 * provenance registry's `read()` result. Identical discipline to
 * `readValue` (own-data-property descriptor reads, engine brand checks,
 * cycle guard, depth bound) with NO array-length or object-key cap: the
 * pending-call registry must report the WHOLE registry (phase-E review
 * rejection: the 16 384-element array cap silently truncated the list
 * and its `[ArrayTruncated]` marker leaked into the broker's id lists as
 * an `undefined` hole) and the provenance registry must report every
 * binding's origin (phase-E review rejection: the 256-property object
 * cap dropped bindings 256+ from the manifest's provenance). These
 * surfaces are the frozen guest library's own metadata (call ids,
 * kinds, options strings, origin labels) — never guest-authored content
 * — so the adversarial caps don't apply; the read is bounded by the VM's
 * memory like the metadata itself.
 */
export function readValueComplete(handle: JSValueHandle, depth = 0, seen = new Set<number>()): unknown {
  return readValueBounded(handle, depth, seen, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
}

function readValueBounded(
  handle: JSValueHandle,
  depth: number,
  seen: Set<number>,
  maxLen: number,
  maxKeys: number,
): unknown {
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
  if (depth >= 4) return '[Object]';

  seen.add(ptr);
  try {
    if (handle.isArray) {
      const lengthHandle = readOwnDataProperty(handle, 'length');
      const length = lengthHandle === undefined ? 0 : lengthHandle.toNumber();
      lengthHandle?.dispose();
      const out: unknown[] = [];
      const count = Math.min(length, maxLen);
      for (let i = 0; i < count; i++) {
        const v = readOwnDataProperty(handle, String(i));
        if (v === undefined) continue; // sparse hole
        try {
          out.push(readValueBounded(v, depth + 1, seen, maxLen, maxKeys));
        } finally {
          v.dispose();
        }
      }
      if (length > maxLen) out.push('[ArrayTruncated]');
      return out;
    }

    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of rawOwnKeys(handle)) {
      if (count >= maxKeys) {
        out['[Truncated]'] = true;
        break;
      }
      const v = readOwnDataProperty(handle, key);
      if (v === undefined) continue; // accessor or deleted between reads
      try {
        out[key] = readValueBounded(v, depth + 1, seen, maxLen, maxKeys);
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
 * Read one boolean flag off an engine-created descriptor object (`value`/
 * `get`/`set`/`writable`/`enumerable`/`configurable`). `false` on any read
 * failure — flags only matter in the false direction for the previewer
 * (non-enumerable means "not listed").
 */
function readFlag(e: QuickJSExports, vm: QuickJS, objPtr: number, key: string): boolean {
  const handle = getPropRaw(e, vm, objPtr, key);
  if (handle === undefined) return false;
  try {
    return handle.isBool ? handle.toBoolean() : false;
  } finally {
    handle.dispose();
  }
}
