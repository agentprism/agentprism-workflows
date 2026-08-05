/**
 * The previewer — the CDP-style collapsed preview of guest values that
 * reaches the client agent's context. The Chrome DevTools Protocol's
 * `RemoteObject`/`ObjectPreview` model, adopted as a spec; the exact rules
 * (field order, caps, truncation, per-brand renderings) follow the
 * harness's normative `previewer/FORMAT.md` (the roadmap doc names it as
 * the normative reference — imitated, not copied).
 *
 * **The absolute rule: preview generation is side-effect-free.** Only the
 * trap-free introspection surface is used (`trapfree.ts`): engine brand
 * checks (never `instanceof`, never prototype inspection, never
 * `Symbol.toStringTag`), `Reflect.ownKeys`-style key listing, and
 * own-property-descriptor reads that never invoke getters. Proxies are
 * detected FIRST and previewed as proxies (never enumerated); strings/
 * numbers/booleans/bigints are extracted only after brand checks; the
 * only indexed `[[Get]]`s are on brand-checked typed arrays, where
 * integer-indexed element access is guest-code-free by the language.
 * Observing a value never executes guest code and never mutates guest
 * state — a hostile getter, a polluted `Object.prototype`, or a
 * trap-counting proxy cannot influence anything rendered here.
 *
 * `estimateByteSize` is the bounded, trap-free byte-size estimate for the
 * header (FORMAT.md leaves the estimate to the caller); `renderRefLine`
 * is the tool-side seam: resolve a `$N` realm slot trap-free, preview it,
 * render the line. A slot rebound to an accessor renders an explicit
 * sabotage marker (the getter is never invoked); a slot that cannot be
 * previewed degrades to a line built from the console event's best-effort
 * `args` encoding — preview failure must never lose output.
 */

import { JSValueHandle, type QuickJS } from 'quickjs-wasi';

import { getVmShim, type ReplVm } from './vm.js';
import {
  arrayBufferByteLength,
  getPropRaw,
  hasOwnRaw,
  readOwnDataProperty,
  readOwnDescriptor,
  rawOwnKeysAll,
  readProxyTarget,
  typedArrayInfo,
  type OwnDescriptor,
  type TypedArrayInfo,
} from './trapfree.js';

// ---- Caps (normative — FORMAT.md §3). All character counts are Unicode
// scalar values (code points), not bytes and not UTF-16 units. ----

/** Named properties listed per preview. */
export const MAX_PREVIEW_PROPERTIES = 8;
/** Leading array / typed-array entries. */
export const MAX_PREVIEW_ARRAY_ITEMS = 8;
/** String content chars in a property value. */
export const MAX_PROPERTY_VALUE_CHARS = 40;
/** Head kept when a property string is elided. */
export const PROPERTY_STRING_HEAD_CHARS = 24;
/** Tail kept when a property string is elided. */
export const PROPERTY_STRING_TAIL_CHARS = 8;
/** Error-description chars (top level). */
export const MAX_ERROR_MESSAGE_CHARS = 120;
/** Longest top-level string rendered whole. */
export const MAX_STRING_PREVIEW_CHARS = 200;
/** Head kept when a top-level string is elided. */
export const STRING_HEAD_CHARS = 120;
/** Tail kept when a top-level string is elided. */
export const STRING_TAIL_CHARS = 40;
/** Hard backstop on the rendered collapsed body. */
export const MAX_COLLAPSED_CHARS = 400;

// ---- The preview model (CDP shape — FORMAT.md §4). Field order is
// normative for serialized forms. ----

export type PreviewType =
  | 'object'
  | 'function'
  | 'undefined'
  | 'string'
  | 'number'
  | 'boolean'
  | 'symbol'
  | 'bigint';

export type PreviewSubtype =
  | 'array'
  | 'null'
  | 'regexp'
  | 'date'
  | 'map'
  | 'set'
  | 'weakmap'
  | 'weakset'
  | 'weakref'
  | 'error'
  | 'proxy'
  | 'promise'
  | 'typedarray'
  | 'arraybuffer'
  | 'dataview';

export type PropertyPreviewKind = PreviewType | 'accessor';

export interface PropertyPreview {
  name: string;
  type: PropertyPreviewKind;
  /** Abbreviated token; absent for accessors. */
  value?: string;
  subtype?: PreviewSubtype;
}

export interface ObjectPreview {
  type: PreviewType;
  subtype?: PreviewSubtype;
  description: string;
  overflow: boolean;
  properties: PropertyPreview[];
}

// ---- Character helpers (code points, not UTF-16 units) ----

function toChars(s: string): string[] {
  return Array.from(s);
}

/** FORMAT.md §5.4: `\` `"` and C0 controls, everything else verbatim. */
export function escapeString(s: string): string {
  let out = '';
  for (const c of s) {
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      default: {
        const code = c.codePointAt(0)!;
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += c;
        }
      }
    }
  }
  return out;
}

/** FORMAT.md §5.2: ECMAScript Number::toString(10), plus -0/NaN/Infinity. */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';
  // Host Number::toString implements the spec's shortest round-trip
  // decimal with exponent notation outside [1e-6, 1e21) and an explicit
  // '+' for positive exponents — exactly FORMAT.md §5.2.
  return n.toString();
}

/** Head+tail truncation for UNQUOTED description text (FORMAT.md §5.10). */
export function headTailDescription(s: string, cap: number): string {
  const chars = toChars(s);
  if (chars.length <= cap) return s;
  const headChars = Math.floor((cap * 3) / 5);
  const tailChars = Math.floor(cap / 5);
  const head = chars.slice(0, headChars).join('');
  const tail = chars.slice(chars.length - tailChars).join('');
  const elided = chars.length - headChars - tailChars;
  return `${head}…[${elided} chars elided]…${tail}`;
}

/** Head-only truncation with a trailing marker (function names). */
function truncateChars(s: string, cap: number): string {
  const chars = toChars(s);
  if (chars.length <= cap) return s;
  return chars.slice(0, cap).join('') + '…';
}

/** FORMAT.md §5.5: top-level strings — whole ≤ 200, else head AND tail. */
export function stringDescription(s: string): string {
  const chars = toChars(s);
  if (chars.length <= MAX_STRING_PREVIEW_CHARS) {
    return `"${escapeString(s)}"`;
  }
  const head = chars.slice(0, STRING_HEAD_CHARS).join('');
  const tail = chars.slice(chars.length - STRING_TAIL_CHARS).join('');
  const elided = chars.length - STRING_HEAD_CHARS - STRING_TAIL_CHARS;
  return `"${escapeString(head)}" …[${elided} chars elided]… "${escapeString(tail)}"`;
}

/** FORMAT.md §5.6: property-level strings — whole ≤ 40, else head AND tail
 *  inside one quoted token. */
export function shortString(s: string): string {
  const chars = toChars(s);
  if (chars.length <= MAX_PROPERTY_VALUE_CHARS) {
    return `"${escapeString(s)}"`;
  }
  const head = chars.slice(0, PROPERTY_STRING_HEAD_CHARS).join('');
  const tail = chars.slice(chars.length - PROPERTY_STRING_TAIL_CHARS).join('');
  const elided = chars.length - PROPERTY_STRING_HEAD_CHARS - PROPERTY_STRING_TAIL_CHARS;
  return `"${escapeString(head)}…[${elided} chars elided]…${escapeString(tail)}"`;
}

// ---- Preview generation ----

function leaf(
  type: PreviewType,
  subtype: PreviewSubtype | undefined,
  description: string,
): ObjectPreview {
  return { type, subtype, description, overflow: false, properties: [] };
}

/**
 * Generate a collapsed first-level preview of any guest value.
 * Side-effect-free by construction (module docs).
 */
/**
 * Generate a collapsed first-level preview of any guest value.
 * Side-effect-free by construction (module docs). Internal: takes a raw
 * shim handle, so it is not exported from this module's public surface
 * (the published declarations must stay free of quickjs-wasi types); the
 * public seams are `renderGlobalLine`/`renderRefLine`/`inspectGlobal`.
 */
function previewHandle(handle: JSValueHandle): ObjectPreview {
  // ---- Primitives (brand-checked before any conversion) ----
  if (handle.isUndefined) return leaf('undefined', undefined, 'undefined');
  if (handle.isNull) return leaf('object', 'null', 'null');
  if (handle.isBool) return leaf('boolean', undefined, handle.toBoolean() ? 'true' : 'false');
  if (handle.isNumber) return leaf('number', undefined, formatNumber(handle.toNumber()));
  if (handle.isString) return leaf('string', undefined, stringDescription(handle.toString()));
  if (handle.isBigInt) return leaf('bigint', undefined, handle.toBigInt().toString() + 'n');
  if (handle.isSymbol) {
    // The description is not readable trap-free (it sits behind
    // Symbol.prototype.description / Symbol.keyFor, both guest-replaceable)
    // — render the bare brand. FORMAT.md §5.7.
    return leaf('symbol', undefined, 'Symbol');
  }

  // ---- Proxy: detected BEFORE any other object handling (CDP convention)
  // — a proxy is previewed as a proxy, never enumerated. ----
  if (handle.isProxy) {
    return proxyPreview(handle);
  }

  if (handle.isFunction) {
    return leaf('function', undefined, functionDescription(handle));
  }

  // ---- Branded objects ----
  if (handle.isPromise) return promisePreview(handle);
  if (handle.isError) return errorPreview(handle, MAX_ERROR_MESSAGE_CHARS);
  if (handle.isMap) return brandedPreview(handle, 'map', 'Map(?)', []);
  if (handle.isSet) return brandedPreview(handle, 'set', 'Set(?)', []);
  if (handle.isWeakMap) return brandedPreview(handle, 'weakmap', 'WeakMap', []);
  if (handle.isWeakSet) return brandedPreview(handle, 'weakset', 'WeakSet', []);
  if (handle.isWeakRef) return brandedPreview(handle, 'weakref', 'WeakRef', []);
  if (handle.isDate) return brandedPreview(handle, 'date', 'Date', []);
  if (handle.isRegExp) {
    return brandedPreview(handle, 'regexp', 'RegExp', ['lastIndex']);
  }
  if (handle.isArrayBuffer) {
    const len = arrayBufferByteLength(handle) ?? 0;
    return brandedPreview(handle, 'arraybuffer', `ArrayBuffer(${len})`, []);
  }
  if (handle.isDataView) return brandedPreview(handle, 'dataview', 'DataView(?)', []);
  const tinfo = typedArrayInfo(handle);
  if (tinfo !== undefined) return typedArrayPreview(handle, tinfo);
  if (handle.isArray) return arrayPreview(handle);
  if (handle.isObject) return plainObjectPreview(handle);

  // Unreachable for well-formed values; be total anyway.
  return leaf('object', undefined, 'unknown');
}

/** FORMAT.md §5.8: `Proxy(<Brand>)` — the target's engine brand, read
 *  without traps; `Proxy(revoked)` for revoked proxies. */
function proxyPreview(handle: JSValueHandle): ObjectPreview {
  const target = readProxyTarget(handle);
  let description = 'Proxy(revoked)';
  if (target !== undefined) {
    try {
      description = `Proxy(${brandWord(target)})`;
    } finally {
      target.dispose();
    }
  }
  return { type: 'object', subtype: 'proxy', description, overflow: false, properties: [] };
}

/** The engine brand of a value as a constructor-style word. */
function brandWord(handle: JSValueHandle): string {
  if (handle.isProxy) return 'Proxy';
  if (handle.isFunction) return 'Function';
  if (handle.isPromise) return 'Promise';
  if (handle.isError) return 'Error';
  if (handle.isMap) return 'Map';
  if (handle.isSet) return 'Set';
  if (handle.isWeakMap) return 'WeakMap';
  if (handle.isWeakSet) return 'WeakSet';
  if (handle.isWeakRef) return 'WeakRef';
  if (handle.isDate) return 'Date';
  if (handle.isRegExp) return 'RegExp';
  if (handle.isArrayBuffer) return 'ArrayBuffer';
  if (handle.isDataView) return 'DataView';
  const tinfo = typedArrayInfo(handle);
  if (tinfo !== undefined) return typedArrayKind(handle, tinfo);
  if (handle.isArray) return 'Array';
  return 'Object';
}

/** FORMAT.md §5.9: `ƒ <name>()` — own data string `name` only (an accessor
 *  `name` renders anonymous), capped at 40 chars. */
function functionDescription(handle: JSValueHandle): string {
  const nameHandle = readOwnDataProperty(handle, 'name');
  let name = '';
  if (nameHandle !== undefined) {
    try {
      if (nameHandle.isString) name = truncateChars(nameHandle.toString(), MAX_PROPERTY_VALUE_CHARS);
    } finally {
      nameHandle.dispose();
    }
  }
  return name === '' ? 'ƒ ()' : `ƒ ${name}()`;
}

/** FORMAT.md §5.11: `Promise {<state>}` / `Promise {<state>: result}`. */
function promisePreview(handle: JSValueHandle): ObjectPreview {
  const state = handle.promiseState; // 0 pending, 1 fulfilled, 2 rejected
  const stateStr = state === 0 ? 'pending' : state === 1 ? 'fulfilled' : 'rejected';
  const properties: PropertyPreview[] = [
    { name: '[[PromiseState]]', type: 'string', value: stateStr },
  ];
  if (state !== 0) {
    const shim = handle.vm;
    const resultPtr = shim._getExports().qjs_promise_result(handle.ptr);
    const result = new JSValueHandle(shim, resultPtr);
    try {
      properties.push(propertyPreviewOf('[[PromiseResult]]', result));
    } finally {
      result.dispose();
    }
  }
  return {
    type: 'object',
    subtype: 'promise',
    description: 'Promise',
    overflow: false,
    properties,
  };
}

/** FORMAT.md §5.10: `<name>: <message>` — own data strings only, head+tail
 *  truncation with the given budget. */
function errorDescription(handle: JSValueHandle, cap: number): string {
  const name = ownDataString(handle, 'name') ?? 'Error';
  const message = ownDataString(handle, 'message') ?? '';
  if (message === '') return headTailDescription(name, cap);
  return headTailDescription(`${name}: ${message}`, cap);
}

function errorPreview(handle: JSValueHandle, cap: number): ObjectPreview {
  const description = errorDescription(handle, cap);
  // `name`/`message` are folded into the description; `stack` is a
  // structural own property present on every engine error — none of the
  // three counts as "more to see" (FORMAT.md §5.10).
  return brandedPreview(handle, 'error', description, ['name', 'message', 'stack']);
}

/** Branded object (Map, Date, ArrayBuffer, ...): fixed description plus
 *  any own enumerable string-keyed expando properties. */
function brandedPreview(
  handle: JSValueHandle,
  subtype: PreviewSubtype,
  description: string,
  exempt: string[],
): ObjectPreview {
  const { properties, overflow } = ownStringProperties(handle, MAX_PREVIEW_PROPERTIES, exempt, false);
  return { type: 'object', subtype, description, overflow, properties };
}

/** FORMAT.md §5.12: `<Kind>(<len>)` with leading elements via
 *  integer-indexed [[Get]] (guest-code-free on brand-checked typed
 *  arrays); overflow when len exceeds the cap or when expando keys exist
 *  (own-key count > element count — read engine-side, no descriptors). */
function typedArrayPreview(handle: JSValueHandle, info: TypedArrayInfo): ObjectPreview {
  const kindName = typedArrayKind(handle, info);
  const len = info.length;
  const show = Math.min(len, MAX_PREVIEW_ARRAY_ITEMS);
  const properties: PropertyPreview[] = [];
  for (let i = 0; i < show; i++) {
    const elem = handle.vm._getExports().qjs_get_prop_uint32(handle.ptr, i);
    const elemHandle = new JSValueHandle(handle.vm, elem);
    try {
      properties.push(propertyPreviewOf(String(i), elemHandle));
    } finally {
      elemHandle.dispose();
    }
  }
  const ownKeys = ownKeyCount(handle);
  const hasExpandos = ownKeys.count > len;
  return {
    type: 'object',
    subtype: 'typedarray',
    description: `${kindName}(${len})`,
    // FORMAT.md §6: a corrupted key materialization degrades with
    // overflow:true — omitted or unverifiable expandos must never be
    // concealed behind a fabricated "no expandos" count (review: the
    // corrupted count read as zero, hiding the expando signal).
    overflow: len > show || hasExpandos || ownKeys.corrupted,
    properties,
  };
}

/** Resolve the precise typed-array kind from the engine class id, anchored
 *  to a host-created Uint8Array (no guest code) and cross-checked against
 *  the element width. Falls back to "TypedArray" if the layout of the
 *  binary's class table ever changes. FORMAT.md §5.12. */
function typedArrayKind(handle: JSValueHandle, info: TypedArrayInfo): string {
  // quickjs-ng registers the typed-array classes contiguously in this
  // order (verified against the shipped binary: Uint8ClampedArray=-2 …
  // Float64Array=+9 relative to the Uint8Array anchor); the anchor probe
  // plus the bytes-per-element cross-check makes relying on that order
  // safe (mismatch -> generic fallback).
  const KINDS: Array<[number, string, number]> = [
    [-2, 'Uint8ClampedArray', 1],
    [-1, 'Int8Array', 1],
    [0, 'Uint8Array', 1],
    [1, 'Int16Array', 2],
    [2, 'Uint16Array', 2],
    [3, 'Int32Array', 4],
    [4, 'Uint32Array', 4],
    [5, 'BigInt64Array', 8],
    [6, 'BigUint64Array', 8],
    [7, 'Float16Array', 2],
    [8, 'Float32Array', 4],
    [9, 'Float64Array', 8],
  ];
  const classId = handle.classId;
  const anchorPtr = handle.vm._getExports().qjs_new_uint8_array(0, 0);
  const anchor = new JSValueHandle(handle.vm, anchorPtr);
  let anchorId = 0;
  try {
    anchorId = anchor.classId;
  } finally {
    anchor.dispose();
  }
  const delta = classId - anchorId;
  for (const [d, name, bpe] of KINDS) {
    if (d === delta && bpe === info.bytesPerElement) return name;
  }
  return 'TypedArray';
}

/** FORMAT.md §5.14: `Array(<len>)` — length from the own descriptor,
 *  leading entries via own descriptors (holes render `empty`, accessor
 *  elements render `(...)`), then named own enumerable properties.
 *  Overflow: len > 8, named props cut, or hidden properties. */
function arrayPreview(handle: JSValueHandle): ObjectPreview {
  const lengthHandle = readOwnDataProperty(handle, 'length');
  const len = lengthHandle === undefined ? 0 : lengthHandle.toNumber();
  lengthHandle?.dispose();

  const show = Math.min(len, MAX_PREVIEW_ARRAY_ITEMS);
  const properties: PropertyPreview[] = [];
  for (let i = 0; i < show; i++) {
    const desc = readOwnDescriptor(handle, String(i));
    if (desc === undefined) {
      // A hole. Reading it with [[Get]] would consult the prototype chain
      // (which can carry guest accessors), so it renders as a hole.
      properties.push({ name: String(i), type: 'undefined', value: 'empty' });
      continue;
    }
    properties.push(descriptorPreview(String(i), desc));
  }
  let overflow = len > show;

  // Named own properties on the array (`arr.foo = 1`), after the index
  // entries — "length" is carried in the description and exempt.
  const named = ownStringProperties(handle, MAX_PREVIEW_PROPERTIES, ['length'], true);
  overflow = overflow || named.overflow;
  properties.push(...named.properties);

  return {
    type: 'object',
    subtype: 'array',
    description: `Array(${len})`,
    overflow,
    properties,
  };
}

function plainObjectPreview(handle: JSValueHandle): ObjectPreview {
  const { properties, overflow } = ownStringProperties(handle, MAX_PREVIEW_PROPERTIES, [], false);
  return { type: 'object', description: 'Object', overflow, properties };
}

/**
 * Own ENUMERABLE string-keyed properties (in `Reflect.ownKeys` order,
 * which puts canonical indices first), abbreviated, up to `cap`.
 *
 * With `skipIndices` (the array path, which renders index entries
 * positionally), canonical array indices are skipped; names in `exempt`
 * always are. Overflow is set when enumerable properties were cut by the
 * cap, or when symbol-keyed / non-enumerable properties exist at all (they
 * are never listed — the preview says "there is more here" — FORMAT.md
 * §5.16). A corrupted key enumeration degrades to "list nothing, flag
 * overflow" (FORMAT.md §6).
 */
function ownStringProperties(
  handle: JSValueHandle,
  cap: number,
  exempt: string[],
  skipIndices: boolean,
): { properties: PropertyPreview[]; overflow: boolean } {
  const { keys, corrupted } = rawOwnKeysAll(handle);
  if (corrupted) return { properties: [], overflow: true };
  const properties: PropertyPreview[] = [];
  let overflow = false;
  for (const key of keys) {
    if (key.symbol) {
      overflow = true;
      continue;
    }
    const name = key.name!;
    if (exempt.includes(name) || (skipIndices && isCanonicalIndex(name))) continue;
    const desc = readOwnDescriptor(handle, name);
    if (desc === undefined) {
      overflow = true; // vanished between calls; count it
      continue;
    }
    if (!desc.enumerable || properties.length >= cap) {
      // Omitted from the preview, but the descriptor's owned value handle
      // must still be disposed — an omitted property is not listed, yet
      // its handle is just as owned as a listed one's (review regression:
      // every omitted data-property handle leaked, pinning one JSValue
      // box per preview call; a 20,000-call previewGlobal() probe on a
      // 100-property object grew WASM memory from 1.31 MB to 30.74 MB).
      if (desc.kind === 'data') desc.value.dispose();
      overflow = true;
      continue;
    }
    properties.push(descriptorPreview(name, desc));
  }
  return { properties, overflow };
}

/** Abbreviate one property from its descriptor: data properties preview
 *  their value; accessor properties render `(...)` with the getter left
 *  unfired (CDP `accessor`). */
function descriptorPreview(name: string, desc: OwnDescriptor): PropertyPreview {
  if (desc.kind === 'accessor') {
    return { name, type: 'accessor' };
  }
  try {
    return propertyPreviewOf(name, desc.value);
  } finally {
    desc.value.dispose();
  }
}

/** First-level abbreviation of a property VALUE (CDP `PropertyPreview`):
 *  primitives render inline (with string truncation); objects render as
 *  shorthand brand tokens, never expanded. Trap-free on every path.
 *
 *  The constructed object's FIELD ORDER is normative (FORMAT.md §4:
 *  `name`, `type`, `value`, `subtype` — the serialized form must put
 *  `subtype` AFTER `value`; review regression: it was inserted before).
 *  `value` is the abbreviated token, absent for accessors; `subtype` is
 *  absent for primitives (and omitted by JSON serialization). */
function propertyPreviewOf(name: string, value: JSValueHandle): PropertyPreview {
  const { type, subtype, token } = shortForm(value);
  return { name, type, value: token, subtype };
}

/** FORMAT.md §5.17: the property-level shorthand tokens. */
function shortForm(value: JSValueHandle): {
  type: PropertyPreviewKind;
  subtype?: PreviewSubtype;
  token: string;
} {
  if (value.isUndefined) return { type: 'undefined', token: 'undefined' };
  if (value.isNull) return { type: 'object', subtype: 'null', token: 'null' };
  if (value.isBool) return { type: 'boolean', token: value.toBoolean() ? 'true' : 'false' };
  if (value.isNumber) return { type: 'number', token: formatNumber(value.toNumber()) };
  if (value.isString) return { type: 'string', token: shortString(value.toString()) };
  if (value.isBigInt) return { type: 'bigint', token: value.toBigInt().toString() + 'n' };
  if (value.isSymbol) return { type: 'symbol', token: 'Symbol' };
  if (value.isProxy) return { type: 'object', subtype: 'proxy', token: 'Proxy' };
  if (value.isFunction) return { type: 'function', token: 'ƒ' };
  if (value.isPromise) return { type: 'object', subtype: 'promise', token: 'Promise' };
  if (value.isError) return { type: 'object', subtype: 'error', token: errorDescription(value, MAX_PROPERTY_VALUE_CHARS) };
  if (value.isMap) return { type: 'object', subtype: 'map', token: 'Map(?)' };
  if (value.isSet) return { type: 'object', subtype: 'set', token: 'Set(?)' };
  if (value.isWeakMap) return { type: 'object', subtype: 'weakmap', token: 'WeakMap' };
  if (value.isWeakSet) return { type: 'object', subtype: 'weakset', token: 'WeakSet' };
  if (value.isWeakRef) return { type: 'object', subtype: 'weakref', token: 'WeakRef' };
  if (value.isDate) return { type: 'object', subtype: 'date', token: 'Date' };
  if (value.isRegExp) return { type: 'object', subtype: 'regexp', token: 'RegExp' };
  if (value.isArrayBuffer) {
    const len = arrayBufferByteLength(value) ?? 0;
    return { type: 'object', subtype: 'arraybuffer', token: `ArrayBuffer(${len})` };
  }
  if (value.isDataView) return { type: 'object', subtype: 'dataview', token: 'DataView(?)' };
  const tinfo = typedArrayInfo(value);
  if (tinfo !== undefined) {
    return {
      type: 'object',
      subtype: 'typedarray',
      token: `${typedArrayKind(value, tinfo)}(${tinfo.length})`,
    };
  }
  if (value.isArray) {
    const lengthHandle = readOwnDataProperty(value, 'length');
    const len = lengthHandle === undefined ? 0 : lengthHandle.toNumber();
    lengthHandle?.dispose();
    return { type: 'object', subtype: 'array', token: `Array(${len})` };
  }
  return { type: 'object', token: '{…}' };
}

function ownDataString(handle: JSValueHandle, name: string): string | undefined {
  const valueHandle = readOwnDataProperty(handle, name);
  if (valueHandle === undefined) return undefined;
  try {
    return valueHandle.isString ? valueHandle.toString() : undefined;
  } finally {
    valueHandle.dispose();
  }
}

/** The own-key COUNT (Reflect.ownKeys length), materialized engine-side —
 *  no descriptor reads, no getters. Used for the typed-array expando
 *  signal (FORMAT.md §5.12). A corrupted materialization reports
 *  `corrupted: true` (count 0) so callers degrade with `overflow: true`
 *  instead of concealing the expando question (FORMAT.md §6). */
function ownKeyCount(handle: JSValueHandle): { count: number; corrupted: boolean } {
  const { keys, corrupted } = rawOwnKeysAll(handle);
  return { count: corrupted ? 0 : keys.length, corrupted };
}

// ---- Rendering ----

/** FORMAT.md §5.18: canonical array indices render positionally. */
export function isCanonicalIndex(name: string): boolean {
  if (!/^\d+$/.test(name)) return false;
  const n = Number(name);
  return Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === name;
}

/** The header label: the CDP subtype when present, else the type. */
function label(preview: ObjectPreview): string {
  return preview.subtype ?? preview.type;
}

/** Render the collapsed preview body (everything after the header), capped
 *  at MAX_COLLAPSED_CHARS (FORMAT.md §3). */
export function renderCollapsed(preview: ObjectPreview): string {
  let body: string;
  if (preview.type !== 'object') {
    // Primitives, functions, symbols: the description IS the preview.
    body = preview.description;
  } else if (preview.subtype === 'null') {
    body = 'null';
  } else if (preview.subtype === 'array' || preview.subtype === 'typedarray') {
    body = `${preview.description} [${entries(preview)}]`;
  } else if (preview.subtype === 'promise') {
    body = renderPromise(preview);
  } else if (preview.subtype === undefined && preview.description === 'Object') {
    // Plain objects: bare braces, no "Object" prefix.
    body = `{${entries(preview)}}`;
  } else {
    // Everything else (branded objects, proxies): description, plus braces
    // only when there is something to put in them.
    body =
      preview.properties.length === 0 && !preview.overflow
        ? preview.description
        : `${preview.description} {${entries(preview)}}`;
  }
  return hardCap(body, MAX_COLLAPSED_CHARS);
}

function hardCap(s: string, cap: number): string {
  const chars = toChars(s);
  if (chars.length <= cap) return s;
  return chars.slice(0, cap - 1).join('') + '…';
}

/** Comma-joined property list: canonical-index names render positionally
 *  (value only); named properties render `name: value`; accessors render
 *  `(...)`; the overflow flag appends a final `…` entry. */
function entries(preview: ObjectPreview): string {
  const parts: string[] = [];
  for (const p of preview.properties) {
    parts.push(renderProperty(p));
  }
  if (preview.overflow) parts.push('…');
  return parts.join(', ');
}

function renderProperty(p: PropertyPreview): string {
  const value = p.type === 'accessor' ? '(...)' : (p.value ?? '');
  if (isCanonicalIndex(p.name)) return value;
  return `${p.name}: ${value}`;
}

function renderPromise(preview: ObjectPreview): string {
  const state =
    preview.properties.find((p) => p.name === '[[PromiseState]]')?.value ?? 'pending';
  const result = preview.properties.find((p) => p.name === '[[PromiseResult]]');
  if (result === undefined) return `Promise {<${state}>}`;
  const token = result.type === 'accessor' ? '(...)' : (result.value ?? '');
  return `Promise {<${state}>: ${token}}`;
}

/**
 * The full context line (FORMAT.md §2):
 * `[$14 · object · 48kB] {sections: Array(12), title: "Auth flow", …}`.
 */
export function renderPreviewLine(address: number, byteSize: number, preview: ObjectPreview): string {
  return `[$${address} · ${label(preview)} · ${formatByteSize(byteSize)}] ${renderCollapsed(preview)}`;
}

/** Decimal byte-size formatting (FORMAT.md §2.2): `B`, then `kB`/`MB`/`GB`/
 *  `TB` at multiples of 1000, one decimal with a trailing `.0` stripped.
 *  The DISPLAYED value is kept below 1000: a value that one-decimal
 *  rounding would render as `1000.0` (anything ≥ 999.95) moves to the next
 *  unit instead — `999_999` is `1MB`, never `1000kB`. */
export function formatByteSize(n: number): string {
  if (n < 1000) return `${n}B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  value /= 1000;
  while (value >= 999.95 && unit + 1 < units.length) {
    value /= 1000;
    unit += 1;
  }
  const s = value.toFixed(1);
  const stripped = s.endsWith('.0') ? s.slice(0, -2) : s;
  return `${stripped}${units[unit]}`;
}

// ---- Byte-size estimation ----

/** Traversal bounds for the byte-size estimate: honest up to these
 *  budgets, degrading to an undercount beyond them (documented; the
 *  preview line marks sizes, it does not meter them). */
const SIZE_MAX_NODES = 2048;
const SIZE_MAX_DEPTH = 32;

/**
 * Bounded, trap-free byte-size estimate of a guest value (internal; the
 * public seams are `renderGlobalLine`/`inspectGlobal`). Uses only the
 * introspection surface (brand checks, own-key listing, descriptor access
 * that never fires getters, engine object identity), an explicit work
 * stack (no recursion), a real VISITED SET (each object counts once,
 * however many paths reach it — cycles terminate, shared subgraphs are
 * never recounted) and node/depth budgets — so a hostile or cyclic graph
 * costs bounded work and can never execute guest code. Sizes are estimates
 * by design and the failure mode is an UNDERcount: strings count UTF-8
 * bytes, primitives use fixed costs, and container INTERNALS that are not
 * readable trap-free (Map/Set entries, the Date time value, RegExp source)
 * use a flat token — their own string-keyed expando properties, which ARE
 * readable trap-free, count normally on top of it.
 */
function estimateSize(handle: JSValueHandle): number {
  let total = 0;
  let expanded = 0;
  const visited = new Set<number>();
  const stack: Array<{ handle: JSValueHandle; depth: number }> = [{ handle, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (expanded >= SIZE_MAX_NODES) {
      // Budget exhausted: dispose the remainder and stop sizing.
      frame.handle.dispose();
      for (const rest of stack) rest.handle.dispose();
      break;
    }
    // Identity dedup (engine object pointer): a value reached twice — a
    // cycle or a shared subgraph — is counted exactly once. Identity 0 is
    // non-heap (primitives), which never recurse anyway.
    const id = frame.handle.identity;
    if (id !== 0) {
      if (visited.has(id)) {
        frame.handle.dispose();
        continue;
      }
      visited.add(id);
    }
    expanded += 1;
    total += nodeSize(frame.handle, frame.depth, stack);
    frame.handle.dispose();
  }
  return total;
}

function nodeSize(
  node: JSValueHandle,
  depth: number,
  stack: Array<{ handle: JSValueHandle; depth: number }>,
): number {
  // Primitives first (brand-checked before any conversion).
  if (node.isUndefined || node.isNull) return 4;
  if (node.isBool) return 4;
  if (node.isNumber) return 8;
  if (node.isBigInt) return 16;
  if (node.isString) return byteLength(node.toString());
  if (node.isSymbol || node.isFunction) return 32;
  if (!node.isObject) return 8;

  // Objects: proxies are never traversed; buffer-backed values report
  // their real byte length; brands with unobservable internals get a
  // flat token PLUS their trap-free-readable own expando properties.
  if (node.isProxy) return 32;
  const tinfo = typedArrayInfo(node);
  if (tinfo !== undefined) return 16 + tinfo.byteLength;
  const abLen = arrayBufferByteLength(node);
  if (abLen !== undefined) return 16 + abLen;
  const opaqueBrand =
    node.isMap ||
    node.isSet ||
    node.isDate ||
    node.isRegExp ||
    node.isWeakRef ||
    node.isWeakMap ||
    node.isWeakSet ||
    node.isDataView ||
    node.isPromise;

  // Base cost: a flat token for opaque internals (entries/time/source are
  // not readable trap-free — an undercount by design), 16 bytes overhead
  // for ordinary objects. Both then count own string keys and
  // (data-property) values within the depth budget.
  let size = opaqueBrand ? 32 : 16;
  if (depth >= SIZE_MAX_DEPTH) return size;
  const { keys, corrupted } = rawOwnKeysAll(node);
  if (corrupted) return size;
  for (const key of keys) {
    if (key.symbol) {
      size += 16;
      continue;
    }
    const name = key.name!;
    size += byteLength(name);
    const desc = readOwnDescriptor(node, name);
    if (desc === undefined) continue;
    if (desc.kind === 'data') {
      stack.push({ handle: desc.value, depth: depth + 1 });
    } else {
      size += 16;
    }
  }
  return size;
}

/** UTF-8 byte length of a host string. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ---- The $N slot seam ----

/** The explicit marker line for a `$N` slot rebound to an accessor: the
 *  preview names the sabotage instead of firing the getter (or lying with
 *  the stale logged args). */
function sabotagedSlotLine(ref: string): string {
  return `[${ref} · accessor · ?B] (slot rebound to a getter — not invoked; the logged value was replaced)`;
}

/** Last-resort line when the realm global is unavailable: the guest's
 *  best-effort JSON encoding, capped. */
function fallbackLine(ref: string | undefined, arg: unknown): string {
  const CAP = 400;
  let body: string;
  if (arg !== undefined) {
    let s: string;
    try {
      s = JSON.stringify(arg);
    } catch {
      s = String(arg);
    }
    const chars = toChars(s);
    body = chars.length > CAP ? chars.slice(0, CAP - 1).join('') + '…' : s;
  } else {
    body = '…';
  }
  return ref === undefined ? body : `[${ref}] ${body}`;
}

/**
 * Resolve a realm global slot trap-free and return the VALUE handle, or
 * `undefined` when the slot is absent, rebound to an accessor (never
 * invoked), or the read failed. The returned handle is owned by the
 * caller.
 */
function readSlotValue(vm: ReplVm, name: string): JSValueHandle | undefined {
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
  if (descPtr === 0) return undefined;
  const desc = new JSValueHandle(shim, descPtr);
  try {
    if (e.qjs_is_exception(desc.ptr) !== 0) {
      const excPtr = e.qjs_get_exception();
      if (excPtr !== 0) new JSValueHandle(shim, excPtr).dispose();
      return undefined;
    }
    // Data vs accessor via `hasOwnProperty` on the descriptor object (raw):
    // `getPropRaw` alone cannot distinguish an absent property (it returns
    // an undefined-valued handle for a plain miss — a prototype walk on the
    // engine-created descriptor, which is guest-code-free but ambiguous).
    // A data descriptor whose VALUE is undefined is still data.
    if (hasOwnRaw(e, shim, desc.ptr, 'value')) {
      const valueProp = getPropRaw(e, shim, desc.ptr, 'value');
      if (valueProp !== undefined) return valueProp;
      return undefined; // allocation failure edge — reads as absent
    }
    // Accessor: never invoke; free the owned get/set handles.
    getPropRaw(e, shim, desc.ptr, 'get')?.dispose();
    getPropRaw(e, shim, desc.ptr, 'set')?.dispose();
    return undefined;
  } finally {
    desc.dispose();
  }
}

/**
 * Render the preview line for one `$N` ref: `[$14 · object · 48kB] {…}`.
 * See `renderGlobalLine` for the full resolution contract.
 */
export function renderRefLine(vm: ReplVm, ref: string, fallbackArg?: unknown): string {
  if (/^\$\d+$/.test(ref)) {
    return renderGlobalLine(vm, ref, fallbackArg);
  }
  return fallbackLine(ref, fallbackArg);
}

/**
 * Render the preview line for any realm global slot (a `$N` ref or any
 * other top-level binding): `[name · object · 48kB] {…}`.
 *
 * Resolution is trap-free: the slot is read through its own property
 * descriptor — a slot rebound to a getter renders the explicit sabotage
 * marker (the getter is never invoked), an absent slot reads as
 * `undefined`, and any preview failure degrades to a line built from the
 * caller's best-effort fallback encoding (`fallbackArg`) — preview
 * failure must never lose output.
 */
export function renderGlobalLine(vm: ReplVm, name: string, fallbackArg?: unknown): string {
  const value = readSlotValue(vm, name);
  if (value === undefined) {
    // The slot is absent (reads as undefined — the same thing a [[Get]]
    // would have said, minus the trap risk), an accessor (sabotage
    // marker), or unreadable. Distinguish the accessor case for the
    // marker line.
    const slot = readRealmSlotKind(vm, name);
    if (slot === 'accessor') return sabotagedSlotLine(name);
    return fallbackLine(name, fallbackArg);
  }
  try {
    const preview = previewHandle(value);
    const size = estimateSize(value);
    return renderPreviewLine(slotAddress(name), size, preview);
  } catch {
    return fallbackLine(name, fallbackArg);
  } finally {
    value.dispose();
  }
}

/** The numeric address of a `$N`-style name (0 for arbitrary names — the
 *  header renders `[name · …]` in that case). */
function slotAddress(name: string): number {
  const n = /^\$(\d+)$/.exec(name)?.[1];
  return n === undefined ? 0 : Number(n);
}

/**
 * The structured preview of a realm global slot — the ObjectPreview
 * object behind `renderGlobalLine`'s rendered line: the CDP model the
 * tool-result seam is built on, as plain data (JSON-serializable, with
 * the FORMAT.md §4 normative field order preserved — pinned by the
 * serialization-vector test). Trap-free by construction (module docs):
 * own-property-descriptor reads only, no guest getters, no guest code.
 * Returns `undefined` when the slot is absent, rebound to an accessor
 * (never invoked), or unreadable — the same resolution contract as
 * `renderGlobalLine` (which degrades to a fallback line; callers that
 * need the structured form instead can degrade themselves).
 */
export function previewGlobal(vm: ReplVm, name: string): ObjectPreview | undefined {
  const value = readSlotValue(vm, name);
  if (value === undefined) return undefined;
  try {
    return previewHandle(value);
  } catch {
    return undefined;
  } finally {
    value.dispose();
  }
}

/**
 * Metadata for one realm global slot, content-free: the CDP label (type
 * or subtype), the byte-size estimate, and the resolution kind. This is
 * the workspace-manifest seam — `ls` for the data plane (the doc: top-
 * level bindings with name, type, size; metadata, never content). The
 * full preview is available through `renderGlobalLine` (or the
 * structured form through `previewGlobal`).
 */
export function inspectGlobal(vm: ReplVm, name: string): {
  kind: 'data' | 'accessor' | 'absent';
  label: string;
  sizeBytes: number;
} {
  const value = readSlotValue(vm, name);
  if (value === undefined) {
    const kind = readRealmSlotKind(vm, name);
    return { kind, label: 'undefined', sizeBytes: 0 };
  }
  try {
    const preview = previewHandle(value);
    return {
      kind: 'data',
      label: preview.subtype ?? preview.type,
      sizeBytes: estimateSize(value),
    };
  } finally {
    value.dispose();
  }
}

/** The slot kind for the sabotage distinction (reuses bridge's reader —
 *  kept local to avoid a cross-module dependency on bridge internals). */
function readRealmSlotKind(vm: ReplVm, name: string): 'data' | 'accessor' | 'absent' {
  // Own-descriptor read on globalThis, same discipline as bridge.ts's
  // readRealmSlot (which callers may use instead; this one only
  // distinguishes the accessor case for the marker line).
  const shim = getVmShim(vm) as QuickJS;
  const global = shim.global;
  const e = shim._getExports();
  const keyHandle = shim.newString(name);
  let descPtr: number;
  try {
    descPtr = e.qjs_get_own_property_descriptor(global.ptr, keyHandle.ptr);
  } finally {
    keyHandle.dispose();
  }
  if (descPtr === 0) return 'absent';
  const desc = new JSValueHandle(shim, descPtr);
  try {
    if (e.qjs_is_exception(desc.ptr) !== 0) {
      const excPtr = e.qjs_get_exception();
      if (excPtr !== 0) new JSValueHandle(shim, excPtr).dispose();
      return 'absent';
    }
    if (hasOwnRaw(e, shim, desc.ptr, 'value')) {
      getPropRaw(e, shim, desc.ptr, 'value')?.dispose();
      return 'data';
    }
    getPropRaw(e, shim, desc.ptr, 'get')?.dispose();
    getPropRaw(e, shim, desc.ptr, 'set')?.dispose();
    return 'accessor';
  } finally {
    desc.dispose();
  }
}
