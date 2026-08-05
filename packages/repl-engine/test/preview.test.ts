/**
 * Phase B tests: the previewer — CDP ObjectPreview model per the harness's
 * normative FORMAT.md (the roadmap doc names it as the reference), plus
 * the trap-freedom guarantees (hostile getters, Object.prototype/Array
 * prototype pollution, proxy traps) and the byte-size estimate.
 *
 * Values are previewed through the public seam: evaluate an expression
 * into a `$N`-named realm slot, then `renderRefLine`/`inspectGlobal`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ReplVm,
  applyOutputCaps,
  escapeString,
  formatByteSize,
  formatNumber,
  headTailDescription,
  inspectGlobal,
  previewGlobal,
  renderRefLine,
  shortString,
  stringDescription,
  type ConsoleEvent,
  type GuestBridgeHandlers,
  type GuestCall,
} from '../src/index.js';
import { installGuestBridge } from '../src/index.js';
import { getVmShim } from '../src/vm.js';
import { EvalFlags, JSValueHandle, type QuickJS } from 'quickjs-wasi';

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

let slotSeq = 100;

/** Preview `expr` by storing it in a fresh `$N` slot and rendering the line.
 *  `expr` must be a single expression (wrap statements in an IIFE). */
async function lineOf(vm: ReplVm, expr: string): Promise<string> {
  const slot = `$${slotSeq++}`;
  const out = await vm.evalCode(`globalThis[${JSON.stringify(slot)}] = ${expr}; "stored"`);
  assert.equal(out.kind, 'value', `store failed for ${expr}: ${JSON.stringify(out)}`);
  return renderRefLine(vm, slot);
}

/** The collapsed body of a rendered line (everything after the header). */
function body(line: string): string {
  const idx = line.indexOf('] ');
  return line.slice(idx + 2);
}

/** The header of a rendered line, e.g. `[$7 · object · 48kB]`. */
function header(line: string): string {
  const idx = line.indexOf('] ');
  return line.slice(0, idx + 1);
}

async function createVm(): Promise<ReplVm> {
  const vm = await ReplVm.create();
  // Install the bridge so console events can be captured in the
  // end-to-end case; previews themselves need no bridge.
  const handlers: GuestBridgeHandlers = {
    agent: (_call: GuestCall, _callId: string) => undefined,
    checkpoint: () => undefined,
    steer: () => undefined,
    console: (_event: ConsoleEvent) => undefined,
  };
  await installGuestBridge(vm, handlers);
  return vm;
}

// ────────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────────

test('primitives: undefined, null, booleans, numbers (incl. -0/NaN/Infinity), bigint', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, 'undefined')), 'undefined');
  assert.match(header(await lineOf(vm, 'undefined')), /^\[\$\d+ · undefined · 4B\]$/);
  assert.equal(body(await lineOf(vm, 'null')), 'null');
  assert.match(header(await lineOf(vm, 'null')), /^\[\$\d+ · null · 4B\]$/);
  assert.equal(body(await lineOf(vm, 'true')), 'true');
  assert.match(header(await lineOf(vm, 'true')), /^\[\$\d+ · boolean · 4B\]$/);
  assert.equal(body(await lineOf(vm, '42')), '42');
  assert.equal(body(await lineOf(vm, '0.1')), '0.1');
  assert.equal(body(await lineOf(vm, '1e21')), '1e+21');
  assert.equal(body(await lineOf(vm, '1e-7')), '1e-7');
  assert.equal(body(await lineOf(vm, 'NaN')), 'NaN');
  assert.equal(body(await lineOf(vm, 'Infinity')), 'Infinity');
  assert.equal(body(await lineOf(vm, '-Infinity')), '-Infinity');
  assert.equal(body(await lineOf(vm, '-0')), '-0');
  assert.equal(body(await lineOf(vm, '123n')), '123n');
});

test('formatNumber: ECMAScript Number::toString(10) semantics', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(-0), '-0');
  assert.equal(formatNumber(0.1), '0.1');
  assert.equal(formatNumber(1e21), '1e+21');
  assert.equal(formatNumber(1e-7), '1e-7');
  assert.equal(formatNumber(123.456), '123.456');
  assert.equal(formatNumber(NaN), 'NaN');
  assert.equal(formatNumber(Infinity), 'Infinity');
  assert.equal(formatNumber(-Infinity), '-Infinity');
  assert.equal(formatNumber(1 / 3), String(1 / 3));
});

test('strings: whole ≤ 200; head AND tail with elision counts beyond; escaping', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, '"hi"')), '"hi"');
  const short = 'a'.repeat(200);
  assert.equal(body(await lineOf(vm, JSON.stringify(short))), `"${short}"`);
  const long = 'x'.repeat(201);
  assert.equal(
    body(await lineOf(vm, JSON.stringify(long))),
    `"${'x'.repeat(120)}" …[41 chars elided]… "${'x'.repeat(40)}"`,
  );
  const mixed = 'head' + 'm'.repeat(200) + 'tail';
  assert.equal(
    body(await lineOf(vm, JSON.stringify(mixed))),
    `"head${'m'.repeat(116)}" …[48 chars elided]… "${'m'.repeat(36)}tail"`,
  );
  // Escaping: quote, backslash, LF, TAB, CR, other C0 controls.
  assert.equal(
    body(await lineOf(vm, JSON.stringify('a"b\\c\nd\te\rf\u0001g'))),
    '"a\\"b\\\\c\\nd\\te\\rf\\u0001g"',
  );
});

test('stringDescription/shortString/headTailDescription/escapeString: pure token rules', () => {
  assert.equal(stringDescription('ok'), '"ok"');
  assert.equal(stringDescription('x'.repeat(200)).length, 202);
  const longDesc = stringDescription('y'.repeat(201));
  assert.ok(longDesc.startsWith(`"${'y'.repeat(120)}"`));
  assert.ok(longDesc.endsWith(`"${'y'.repeat(40)}"`));
  assert.ok(longDesc.includes('[41 chars elided]'));
  assert.equal(shortString('v'.repeat(40)), `"${'v'.repeat(40)}"`);
  const longShort = shortString('z'.repeat(41));
  assert.equal(longShort, `"${'z'.repeat(24)}…[9 chars elided]…${'z'.repeat(8)}"`);
  assert.equal(headTailDescription('short', 120), 'short');
  // cap 120 → head 72, tail 24.
  const elided = headTailDescription('e'.repeat(200), 120);
  assert.equal(elided, `${'e'.repeat(72)}…[104 chars elided]…${'e'.repeat(24)}`);
  assert.equal(escapeString('a"\\\n\t\r\u0002b'), 'a\\"\\\\\\n\\t\\r\\u0002b');
});

test('symbols render the bare brand (description is not readable trap-free)', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, 'Symbol("secret")')), 'Symbol');
  assert.match(header(await lineOf(vm, 'Symbol("secret")')), /^\[\$\d+ · symbol · 32B\]$/);
});

// ────────────────────────────────────────────────────────────────────────
// Functions, errors, promises
// ────────────────────────────────────────────────────────────────────────

test('functions: ƒ <name>(), anonymous, capped names, accessor name renders anonymous', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, 'function researchAgent() {}')), 'ƒ researchAgent()');
  assert.equal(body(await lineOf(vm, '(() => 1)')), 'ƒ ()');
  assert.match(header(await lineOf(vm, '(() => 1)')), /^\[\$\d+ · function · 32B\]$/);
  const longName = 'f'.repeat(60);
  assert.equal(
    body(await lineOf(vm, `Object.defineProperty(function () {}, 'name', { value: ${JSON.stringify(longName)} })`)),
    `ƒ ${'f'.repeat(40)}…()`,
  );
  // A getter-backed `name` must never fire — renders anonymous.
  const traps = await lineOf(vm, `(() => {
    globalThis.__fnameTraps = 0;
    const fn = function () {};
    Object.defineProperty(fn, 'name', { configurable: true, get() { globalThis.__fnameTraps++; return 'evil'; } });
    return fn;
  })()`);
  assert.equal(body(traps), 'ƒ ()');
  assert.equal(await readCounter(vm, 'globalThis.__fnameTraps'), 0);
});

test('errors: name: message with head+tail budget; subclass names from own data only', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, 'new Error("boom")')), 'Error: boom');
  assert.match(header(await lineOf(vm, 'new Error("boom")')), /^\[\$\d+ · error · \d+B\]$/);
  // Subclass names live on prototypes — not readable trap-free — so the
  // engine brand "Error" is the honest token (FORMAT.md §5.10).
  assert.equal(body(await lineOf(vm, 'new TypeError("nope")')), 'Error: nope');
  // Empty message renders the bare name.
  assert.equal(body(await lineOf(vm, 'new Error("")')), 'Error');
  // Long messages keep head AND tail (72/24 at top level).
  const longMsg = 'm'.repeat(200);
  const e = await lineOf(vm, `new Error(${JSON.stringify(longMsg)})`);
  assert.equal(
    body(e),
    `Error: ${'m'.repeat(65)}…[111 chars elided]…${'m'.repeat(24)}`,
  );
  // Own expando properties list normally; name/message/stack are exempt.
  const withProps = await lineOf(vm, 'Object.assign(new Error("x"), { note: 1 })');
  assert.equal(body(withProps), 'Error: x {note: 1}');
  vm.dispose();
});

test('errors: a getter-backed name/message is never fired (own data strings only)', async () => {
  using vm = await createVm();
  await vm.evalCode('globalThis.__errTraps = 0');
  const line = await lineOf(vm, `(() => {
    const err = new Error("real message");
    Object.defineProperty(err, 'name', { configurable: true, get() { globalThis.__errTraps++; return 'TypeError'; } });
    Object.defineProperty(err, 'message', { configurable: true, get() { globalThis.__errTraps++; return 'evil'; } });
    return err;
  })()`);
  // The real own data values were replaced by accessors → falls back to
  // the engine brand and an empty message — the getters never ran.
  assert.equal(body(line), 'Error');
  assert.equal(await readCounter(vm, 'globalThis.__errTraps'), 0);
});

test('promises: state and settled result via engine-level reads', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, 'new Promise(() => {})')), 'Promise {<pending>}');
  assert.equal(body(await lineOf(vm, 'Promise.resolve(42)')), 'Promise {<fulfilled>: 42}');
  assert.equal(
    body(await lineOf(vm, '(() => { const p = Promise.reject(new Error("boom")); p.catch(() => {}); return p; })()')),
    'Promise {<rejected>: Error: boom}',
  );
  assert.match(header(await lineOf(vm, 'Promise.resolve(1)')), /^\[\$\d+ · promise · 32B\]$/);
});

// ────────────────────────────────────────────────────────────────────────
// Arrays and objects
// ────────────────────────────────────────────────────────────────────────

test('arrays: length, leading entries, holes, named props, overflow', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, '[0,1,2,3,4,5,6,7,8,9,10,11]')), 'Array(12) [0, 1, 2, 3, 4, 5, 6, 7, …]');
  assert.match(header(await lineOf(vm, '[0,1,2,3,4,5,6,7,8,9,10,11]')), /^\[\$\d+ · array · \d+B\]$/);
  assert.equal(body(await lineOf(vm, '[1,,3]')), 'Array(3) [1, empty, 3]');
  assert.equal(body(await lineOf(vm, '(() => { const a = [1, 2]; a.total = 3; return a; })()')), 'Array(2) [1, 2, total: 3]');
  assert.equal(body(await lineOf(vm, '[]')), 'Array(0) []');
  // Nested values render as shorthand tokens.
  assert.equal(body(await lineOf(vm, '[1, [2, 3], {a: 1}]')), 'Array(3) [1, Array(2), {…}]');
});

test('plain objects: braces, property cap with overflow, accessors as (...), positional indices', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, '({})')), '{}');
  assert.equal(body(await lineOf(vm, '({ a: 1, b: "two" })')), '{a: 1, b: "two"}');
  assert.match(header(await lineOf(vm, '({ a: 1 })')), /^\[\$\d+ · object · \d+B\]$/);
  // Nine properties → eight listed + overflow marker.
  const nine = await lineOf(vm, '({ k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, k8: 8 })');
  assert.equal(body(nine), '{k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, …}');
  // Accessors render (...), never fired.
  assert.equal(body(await lineOf(vm, '({ a: 1, get b() { return 2 } })')), '{a: 1, b: (...)}');
  // Canonical-index keys render positionally (FORMAT.md §5.18).
  assert.equal(body(await lineOf(vm, '({ 0: "a", x: 1 })')), '{"a", x: 1}');
  // Symbol-keyed and non-enumerable properties set overflow, never list.
  assert.equal(
    body(await lineOf(vm, '(() => { const o = { a: 1 }; o[Symbol("s")] = 2; Object.defineProperty(o, "hidden", { value: 3, enumerable: false }); return o; })()')),
    '{a: 1, …}',
  );
  // Property-level string truncation (24 + 8 around one marker).
  assert.equal(
    body(await lineOf(vm, '({ s: "1234567890123456789012345678901234567890123" })')),
    '{s: "123456789012345678901234…[11 chars elided]…67890123"}',
  );
});

test('nested objects never expand (shorthand tokens at property level)', async () => {
  using vm = await createVm();
  const line = await lineOf(vm, `({
    plain: { deep: true },
    arr: [1, 2, 3],
    map: new Map(),
    set: new Set(),
    date: new Date(0),
    re: /x/g,
    err: new Error("short"),
    p: Promise.resolve(1),
    u: new Uint8Array([1]),
    ab: new ArrayBuffer(4),
    dv: new DataView(new ArrayBuffer(8)),
    sym: Symbol("s"),
    fn: function foo() {},
    proxy: new Proxy({}, {}),
    big: 5n,
  })`);
  assert.equal(
    body(line),
    '{plain: {…}, arr: Array(3), map: Map(?), set: Set(?), date: Date, re: RegExp, err: Error: short, p: Promise, …}',
  );
});

// ────────────────────────────────────────────────────────────────────────
// Branded objects
// ────────────────────────────────────────────────────────────────────────

test('branded objects: Map/Set/Weak*/Date/RegExp/ArrayBuffer/DataView with expando support', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, 'new Map()')), 'Map(?)');
  assert.equal(body(await lineOf(vm, 'new Set()')), 'Set(?)');
  assert.equal(body(await lineOf(vm, 'new WeakMap()')), 'WeakMap');
  assert.equal(body(await lineOf(vm, 'new WeakSet()')), 'WeakSet');
  assert.equal(body(await lineOf(vm, 'new WeakRef({})')), 'WeakRef');
  assert.equal(body(await lineOf(vm, 'new Date(0)')), 'Date');
  assert.equal(body(await lineOf(vm, '/x/g')), 'RegExp');
  assert.equal(body(await lineOf(vm, 'new ArrayBuffer(16)')), 'ArrayBuffer(16)');
  assert.equal(body(await lineOf(vm, 'new DataView(new ArrayBuffer(8))')), 'DataView(?)');
  // Expandos list after the description (lastIndex on RegExp is exempt).
  assert.equal(body(await lineOf(vm, '(() => { const m = new Map(); m.note = "x"; return m; })()')), 'Map(?) {note: "x"}');
  assert.equal(body(await lineOf(vm, '(() => { const r = /x/; r.lastIndex = 5; r.custom = 1; return r; })()')), 'RegExp {custom: 1}');
});

test('typed arrays: kind resolution, leading elements, overflow for expandos', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, 'new Uint8Array([7, 9])')), 'Uint8Array(2) [7, 9]');
  assert.equal(body(await lineOf(vm, 'new Uint16Array([1, 2, 3])')), 'Uint16Array(3) [1, 2, 3]');
  assert.equal(body(await lineOf(vm, 'new Float64Array([1.5])')), 'Float64Array(1) [1.5]');
  assert.equal(body(await lineOf(vm, 'new BigInt64Array([1n, 2n])')), 'BigInt64Array(2) [1n, 2n]');
  assert.equal(body(await lineOf(vm, 'new Int8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])')), 'Int8Array(9) [1, 2, 3, 4, 5, 6, 7, 8, …]');
  // Expando keys are never listed but set overflow (FORMAT.md §5.12).
  assert.equal(
    body(await lineOf(vm, 'Object.assign(new Uint8Array([7, 9]), { note: "x" })')),
    'Uint8Array(2) [7, 9, …]',
  );
  assert.match(header(await lineOf(vm, 'new Uint8Array([1, 2, 3])')), /^\[\$\d+ · typedarray · 19B\]$/);
});

test('a corrupted key materialization degrades with overflow (FORMAT.md §6) — typed arrays and plain objects', async () => {
  // Review regression: the typed-array expando signal converted a corrupted
  // own-key enumeration into a count of zero, so overflow stayed false and
  // omitted/unknown expandos were concealed. Corrupted materialization must
  // degrade with overflow:true — list nothing, flag there-is-more.
  using vm = await createVm();
  await vm.evalCode('globalThis.$900 = new Uint8Array([7, 9]); "stored"');
  await vm.evalCode('globalThis.$901 = { a: 1 }; "stored"');

  // Force every key materialization to produce a HOLEY guest array — a
  // binary contract violation (FORMAT.md §6: holes must not be read back
  // with [[Get]] and must not fabricate keys). The real export is restored
  // in the finally below.
  const qjs = (vm as unknown as { vm: QuickJS }).vm;
  const originalExports = qjs._getExports();
  const patched = Object.create(originalExports);
  Object.defineProperty(patched, 'qjs_get_own_property_keys', {
    configurable: true,
    writable: true,
    value: () => {
      const code = qjs._writeString('(() => { const a = []; a.length = 3; a[0] = "k0"; a[2] = "k2"; return a; })()');
      const fn = qjs._writeString('<corrupt>');
      const arr = originalExports.qjs_eval(code.ptr, code.len, fn.ptr, EvalFlags.TYPE_GLOBAL);
      originalExports.wasm_free(code.ptr);
      originalExports.wasm_free(fn.ptr);
      return arr;
    },
  });
  (qjs as unknown as { exports: typeof originalExports }).exports = patched;
  try {
    // Typed array: the element entries stay (descriptor/index reads do not
    // touch the materialization path) but overflow must be true.
    assert.equal(body(renderRefLine(vm, '$900')), 'Uint8Array(2) [7, 9, …]');
    // Plain object: properties list nothing, overflow flags there-is-more.
    assert.equal(body(renderRefLine(vm, '$901')), '{…}');
  } finally {
    (qjs as unknown as { exports: typeof originalExports }).exports = originalExports;
  }
});

test('repeated previews of many-property objects do not leak omitted property handles (bounded memory)', async () => {
  // Review regression: ownStringProperties read every key's descriptor but
  // only disposed the value handle of properties that were LISTED — a
  // property omitted because it was non-enumerable or beyond the
  // eight-property cap left its owned value handle undisposed. Each
  // leaked handle pinned a JSValue box in WASM memory: a 20,000-call
  // previewGlobal() probe on a 100-property object grew WASM memory from
  // 1.31 MB to 30.74 MB (92 omitted handles × 16 bytes × 20,000 calls)
  // despite the 2 MiB VM limit. The boxes are dlmalloc'd — outside the
  // runtime's counted heap, so JSMemoryUsage.mallocSize stays flat and
  // JS_SetMemoryLimit does not stop them; the growth shows in the WASM
  // linear-memory size (memory.buffer.byteLength), which is the metric
  // pinned here. Omitted data handles are disposed on the spot now; the
  // probe below must stay flat.
  const vm = await ReplVm.create({ memoryLimit: 2 * 1024 * 1024 });
  await vm.evalCode(
    `globalThis.$950 = (() => { const o = {}; for (let i = 0; i < 100; i++) o['k' + i] = i; Object.defineProperty(o, 'hidden', { value: 1, enumerable: false }); return o; })(); "stored"`,
  );
  const e = (getVmShim(vm) as QuickJS)._getExports();
  const before = e.memory.buffer.byteLength;
  for (let i = 0; i < 20000; i++) {
    const preview = previewGlobal(vm, '$950');
    assert.ok(preview !== undefined, 'structured preview is available');
    // The object exercises BOTH omitted paths: 92 properties beyond the
    // eight-property cap and one non-enumerable hidden property.
    assert.equal(preview.overflow, true);
  }
  const after = e.memory.buffer.byteLength;
  // The broken code grew ~29 MB here (right through the 2 MiB limit); the
  // fixed code stays flat — the measured delta is exactly 0, 1 MiB slack
  // covers page-granular dlmalloc noise without hiding a real leak.
  assert.ok(
    after - before < 1024 * 1024,
    `previewing must not grow WASM linear memory: ${before} -> ${after} bytes`,
  );
  // The VM is fully healthy afterwards.
  assert.equal((await vm.evalCode('1 + 1')).kind, 'value');
  vm.dispose();
});

test('repeated revoked-proxy and typed-array previews do not accumulate guest memory', async () => {
  // Review regression: raw exports returning heap-allocated JSValues were
  // not disposed on all paths — typedArrayInfo leaked the backing
  // ArrayBuffer handle and readProxyTarget leaked the revoked-proxy
  // exception box, so repeated previews grew WASM/QuickJS allocations
  // until a small VM died. Both paths now dispose every owned handle.
  const vm = await ReplVm.create({ memoryLimit: 2 * 1024 * 1024 });
  await vm.evalCode(`globalThis.$902 = (() => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; })(); "stored"`);
  await vm.evalCode('globalThis.$903 = new Uint16Array([1, 2, 3, 4, 5]); "stored"');
  for (let i = 0; i < 3000; i++) {
    assert.equal(body(renderRefLine(vm, '$902')), 'Proxy(revoked)');
    assert.equal(body(renderRefLine(vm, '$903')), 'Uint16Array(5) [1, 2, 3, 4, 5]');
  }
  // The VM is fully healthy afterwards.
  assert.equal((await vm.evalCode('1 + 1')).kind, 'value');
  vm.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Proxies
// ────────────────────────────────────────────────────────────────────────

test('proxies preview as proxies with the target brand; revoked proxies render Proxy(revoked)', async () => {
  using vm = await createVm();
  assert.equal(body(await lineOf(vm, 'new Proxy({}, {})')), 'Proxy(Object)');
  assert.equal(body(await lineOf(vm, 'new Proxy([], {})')), 'Proxy(Array)');
  assert.equal(body(await lineOf(vm, 'new Proxy(function () {}, {})')), 'Proxy(Function)');
  assert.equal(body(await lineOf(vm, 'new Proxy(new Map(), {})')), 'Proxy(Map)');
  assert.equal(body(await lineOf(vm, 'new Proxy(new Proxy({}, {}), {})')), 'Proxy(Proxy)');
  assert.equal(body(await lineOf(vm, '(() => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; })()')), 'Proxy(revoked)');
  // A proxy property value renders the bare token.
  assert.equal(body(await lineOf(vm, '({ p: new Proxy({}, {}) })')), '{p: Proxy}');
});

// ────────────────────────────────────────────────────────────────────────
// Trap-freedom
// ────────────────────────────────────────────────────────────────────────

test('trap-freedom: hostile getters on Object.prototype never fire while previewing', async () => {
  using vm = await createVm();
  await vm.evalCode('globalThis.__traps = 0');
  await vm.evalCode(`
    // NOTE: 'then' is deliberately NOT polluted here. quickjs-ng's async-eval
    // machinery performs the spec-mandated thenability check on the
    // completion wrapper (a [[Get]] of 'then'), so a 'then' getter fires
    // once per eval from inside the ENGINE — before any of our code runs.
    // That fire is the engine's, not the previewer's; the previewer's own
    // trap-freedom is what these tests pin.
    for (const key of ['value', 'name', 'message', 'stack', 'toString']) {
      try {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() { globalThis.__traps++; return 'polluted'; },
        });
      } catch (err) { /* non-configurable engine property — skip */ }
    }
    'installed'
  `);
  // NOTE: the install eval itself fires some getters (quickjs-ng's
  // completion machinery touches the freshly installed accessors during
  // the very eval that installs them — engine-internal, outside our
  // layer). The contract under test is stricter and cleaner: from the
  // post-install baseline on, NOTHING the previewer does may fire them.
  const baseline = readGlobalNumber(vm, '__traps');
  const line = await lineOf(vm, '({ a: 1, b: [1, 2], c: "text", d: { nested: true } })');
  assert.equal(body(line), '{a: 1, b: Array(2), c: "text", d: {…}}');
  const line2 = await lineOf(vm, '[{ x: 1 }, 2, "three"]');
  assert.equal(body(line2), 'Array(3) [{…}, 2, "three"]');
  // NOTE: under `Object.prototype.value` GETTER pollution, quickjs-ng's
  // async-eval completion wrapper comes out empty (engine-internal, no
  // guest code runs — pinned separately), so eval completions read as {}
  // even for plain numbers; the counter is read descriptor-wise instead.
  assert.equal(readGlobalNumber(vm, '__traps'), baseline, 'previewing fired guest getters');
});

test('trap-freedom: Object.prototype.value pollution cannot leak into previews (R69 discipline)', async () => {
  using vm = await createVm();
  await vm.evalCode('Object.prototype.value = "polluted"; "installed"');
  const line = await lineOf(vm, '({ real: 42 })');
  assert.equal(body(line), '{real: 42}');
  const arr = await lineOf(vm, '[1, 2, 3]');
  assert.equal(body(arr), 'Array(3) [1, 2, 3]');
  // The pollution itself previews fine as an own property of Object.prototype.
  const proto = await lineOf(vm, 'Object.prototype');
  assert.match(header(proto), /object/);
});

test('trap-freedom: Array.prototype index accessors cannot fire or corrupt enumeration', async () => {
  using vm = await createVm();
  await vm.evalCode('globalThis.__arrTraps = 0');
  await vm.evalCode(`
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      get() { globalThis.__arrTraps++; return 'polluted'; },
    });
    'installed'
  `);
  const line = await lineOf(vm, '[10, 20, 30]');
  // Own element descriptors win and the polluted prototype accessor never
  // fires. The named-properties enumeration degrades to "overflow" (FORMAT.md
  // §6: under a corrupted key materialization the preview lists nothing and
  // flags overflow rather than fabricating keys) — the positional entries
  // come from direct index descriptor reads and stay intact.
  assert.equal(body(line), 'Array(3) [10, 20, 30, …]');
  assert.equal(await readCounter(vm, 'globalThis.__arrTraps'), 0);
});

test('trap-freedom: proxy traps never fire while previewing (previewed as proxy, never enumerated)', async () => {
  using vm = await createVm();
  await vm.evalCode('globalThis.__proxyTraps = 0');
  const line = await lineOf(vm, `(() => {
    const p = new Proxy({ secret: 1 }, {
      get(t, k) { globalThis.__proxyTraps++; return Reflect.get(t, k); },
      getOwnPropertyDescriptor(t, k) { globalThis.__proxyTraps++; return Reflect.getOwnPropertyDescriptor(t, k); },
      ownKeys(t) { globalThis.__proxyTraps++; return Reflect.ownKeys(t); },
      getPrototypeOf(t) { globalThis.__proxyTraps++; return Reflect.getPrototypeOf(t); },
      has(t, k) { globalThis.__proxyTraps++; return Reflect.has(t, k); },
    });
    return p;
  })()`);
  assert.equal(body(line), 'Proxy(Object)');
  assert.equal(await readCounter(vm, 'globalThis.__proxyTraps'), 0, 'no proxy trap ran');
});

test('trap-freedom: a $N slot rebound to an accessor renders the sabotage marker (getter never fired)', async () => {
  using vm = await createVm();
  await vm.evalCode('globalThis.__slotTraps = 0');
  await vm.evalCode(`
    globalThis.$99 = { original: true };
    Object.defineProperty(globalThis, '$99', {
      configurable: true,
      get() { globalThis.__slotTraps++; return 'evil'; },
    });
    'installed'
  `);
  const line = renderRefLine(vm, '$99');
  assert.equal(
    line,
    '[$99 · accessor · ?B] (slot rebound to a getter — not invoked; the logged value was replaced)',
  );
  assert.equal(await readCounter(vm, 'globalThis.__slotTraps'), 0);
  // inspectGlobal reports the same kind, trap-free.
  assert.equal(inspectGlobal(vm, '$99').kind, 'accessor');
});

test('trap-freedom: a hostile getter on the previewed object itself never fires', async () => {
  using vm = await createVm();
  await vm.evalCode('globalThis.__hostile = 0');
  const line = await lineOf(vm, `(() => {
    const o = { plain: 1 };
    Object.defineProperty(o, 'secret', { enumerable: true, get() { globalThis.__hostile++; return 'gotcha'; } });
    return o;
  })()`);
  assert.equal(body(line), '{plain: 1, secret: (...)}');
  assert.equal(await readCounter(vm, 'globalThis.__hostile'), 0);
});

// ────────────────────────────────────────────────────────────────────────
// The line format, caps, sizes
// ────────────────────────────────────────────────────────────────────────

test('the rendered line carries the $N address, label, size and collapsed preview (middle-dot separators)', async () => {
  using vm = await createVm();
  await vm.evalCode('console.log({ sections: [1, 2, 3], title: "Auth flow" }); "done"');
  const line = renderRefLine(vm, '$1');
  assert.equal(body(line), '{sections: Array(3), title: "Auth flow"}');
  assert.match(header(line), /^\[\$1 · object · \d+B\]$/);
  // The address is the one the orchestrator slices deeper with.
  assert.match(line, /^\[\$1 ·/);
});

test('formatByteSize: decimal units with the promotion rule', () => {
  assert.equal(formatByteSize(0), '0B');
  assert.equal(formatByteSize(999), '999B');
  assert.equal(formatByteSize(1000), '1kB');
  assert.equal(formatByteSize(1500), '1.5kB');
  assert.equal(formatByteSize(48_000), '48kB');
  assert.equal(formatByteSize(999_940), '999.9kB');
  assert.equal(formatByteSize(999_999), '1MB');
  assert.equal(formatByteSize(2_100_000), '2.1MB');
  assert.equal(formatByteSize(7_000_000_000), '7GB');
  assert.equal(formatByteSize(3_200_000_000_000), '3.2TB');
});

test('PropertyPreview serialization preserves the FORMAT.md field order: name, type, value, subtype', async () => {
  // Review regression: propertyPreviewOf constructed { name, type,
  // subtype, value } — the serialized form put subtype BEFORE value,
  // violating FORMAT.md §4 ("field order is normative for serialized
  // forms"). The serialization vector below pins the order end-to-end,
  // with an object-valued property (subtype present) exercising the full
  // field set.
  using vm = await createVm();
  await vm.evalCode(`globalThis.$910 = { arr: [1, 2], n: 42, get g() { return 1; } }; "stored"`);
  const preview = previewGlobal(vm, '$910');
  assert.ok(preview !== undefined, 'structured preview is available');
  assert.equal(
    JSON.stringify(preview),
    '{"type":"object","description":"Object","overflow":false,' +
      '"properties":[' +
      '{"name":"arr","type":"object","value":"Array(2)","subtype":"array"},' +
      '{"name":"n","type":"number","value":"42"},' +
      '{"name":"g","type":"accessor"}' +
      ']}',
  );
  // previewGlobal and the rendered line agree on the same slot.
  assert.equal(body(renderRefLine(vm, '$910')), '{arr: Array(2), n: 42, g: (...)}');
  // Absent / accessor slots resolve to undefined (same contract as
  // renderGlobalLine, which renders the sabotage marker instead).
  assert.equal(previewGlobal(vm, '$911'), undefined);
});

test('estimateByteSize is bounded, trap-free and counts shared subgraphs once', async () => {
  using vm = await createVm();
  // String size = UTF-8 bytes.
  assert.equal(inspectGlobal(vm, await storeIn(vm, '"héllo"')).sizeBytes, 6);
  // Objects grow with content.
  const small = inspectGlobal(vm, await storeIn(vm, '({ a: 1 })')).sizeBytes;
  const big = inspectGlobal(vm, await storeIn(vm, '({ a: 1, longerKey: "more content here" })')).sizeBytes;
  assert.ok(big > small, 'bigger objects estimate bigger');
  // Cycles terminate and are counted once (bounded work).
  const cyclic = inspectGlobal(vm, await storeIn(vm, '(() => { const o = { a: 1 }; o.self = o; return o; })()')).sizeBytes;
  assert.ok(cyclic > 0 && cyclic < 10_000, 'cyclic estimate stays bounded');
  // Proxies use a flat token (never traversed).
  assert.equal(inspectGlobal(vm, await storeIn(vm, 'new Proxy({ huge: "x".repeat(1000) }, {})')).sizeBytes, 32);
  // Typed arrays report their real byte length.
  const ta = inspectGlobal(vm, await storeIn(vm, 'new Uint16Array(10)')).sizeBytes;
  assert.equal(ta, 16 + 20);
});

async function storeIn(vm: ReplVm, expr: string): Promise<string> {
  const slot = `$${slotSeq++}`;
  const out = await vm.evalCode(`globalThis[${JSON.stringify(slot)}] = ${expr}; "stored"`);
  assert.equal(out.kind, 'value', `store failed for ${expr}: ${JSON.stringify(out)}`);
  return slot;
}

/** Read a guest trap counter (a value outcome). */
async function readCounter(vm: ReplVm, name: string): Promise<number> {
  const out = await vm.evalCode(name);
  assert.equal(out.kind, 'value');
  return out.value as number;
}

/**
 * Read a numeric global slot through the raw own-descriptor path. Needed
 * under `Object.prototype.value` GETTER pollution: quickjs-ng's async-eval
 * completion wrapper comes out empty in that case (engine-internal, no
 * guest code runs — verified), so eval completions read as `{}` even for
 * plain numbers; descriptor reads are unaffected.
 */
function readGlobalNumber(vm: ReplVm, name: string): number {
  const shim = getVmShim(vm) as QuickJS;
  const e = shim._getExports();
  const global = shim.global;
  const key = shim.newString(name);
  let descPtr: number;
  try {
    descPtr = e.qjs_get_own_property_descriptor(global.ptr, key.ptr);
  } finally {
    key.dispose();
  }
  if (descPtr === 0) return -1;
  const C = JSValueHandle;
  const desc = new C(shim, descPtr);
  try {
    const k2 = shim.newString('value');
    let vp: number;
    try {
      vp = e.qjs_get_prop_value(desc.ptr, k2.ptr);
    } finally {
      k2.dispose();
    }
    const v = new C(shim, vp);
    try {
      return v.isNumber ? v.toNumber() : -1;
    } finally {
      v.dispose();
    }
  } finally {
    desc.dispose();
  }
}

test('the collapsed body is capped at 400 chars (hard backstop)', async () => {
  using vm = await createVm();
  const line = await lineOf(
    vm,
    `({ k0: "${'a'.repeat(60)}", k1: "${'b'.repeat(60)}", k2: "${'c'.repeat(60)}", k3: "${'d'.repeat(60)}", k4: "${'e'.repeat(60)}", k5: "${'f'.repeat(60)}", k6: "${'g'.repeat(60)}", k7: "${'h'.repeat(60)}" })`,
  );
  const collapsed = body(line);
  assert.ok(collapsed.length <= 400, `collapsed body must be ≤ 400 chars, got ${collapsed.length}`);
  assert.ok(collapsed.endsWith('…'), 'capped body ends with the ellipsis');
});

test('renderRefLine degrades gracefully: absent slots, non-$ refs, fallback args', async () => {
  using vm = await createVm();
  assert.equal(renderRefLine(vm, '$9999'), '[$9999] …');
  assert.equal(renderRefLine(vm, '$9999', { hello: 'world' }), '[$9999] {"hello":"world"}');
  assert.equal(renderRefLine(vm, 'not-a-ref'), '[not-a-ref] …');
  assert.equal(renderRefLine(vm, 'not-a-ref', [1, 2]), '[not-a-ref] [1,2]');
});

test('the doc headline: previewed $N lines let the orchestrator slice deeper in later evals', async () => {
  using vm = await createVm();
  await vm.evalCode(
    'console.log({ sections: [{ title: "Auth flow", steps: 12 }, { title: "Billing", steps: 4 }] }); "done"',
  );
  const line = renderRefLine(vm, '$1');
  // The full structure lives in $1; the orchestrator slices it in a later
  // eval — the exact workflow the doc describes.
  assert.equal(body(line), '{sections: Array(2)}');
  const sliced = await vm.evalCode('$1.sections.map((s) => s.title)');
  assert.equal(sliced.kind, 'value');
  assert.deepEqual(sliced.value, ['Auth flow', 'Billing']);
});

test('a property name carrying line feeds renders verbatim and caps count its physical lines (review regression)', async () => {
  // FORMAT.md §5.18: property names render verbatim (no quoting, no
  // escaping) — a name that carries \n characters therefore puts PHYSICAL
  // newlines into the rendered line. The tool-result line cap counts
  // physical lines, so one such rendered line is several lines of output
  // (previously an entry with 300 embedded LFs was retained whole with
  // truncated: false — 301 serialized lines inside the tool result).
  using vm = await createVm();
  const out = await vm.evalCode(`globalThis.$951 = { ['a\\nb\\nc']: 1 }; "stored"`);
  assert.equal(out.kind, 'value');
  const line = renderRefLine(vm, '$951');
  assert.ok(line.includes('a\nb\nc'), 'the LF-carrying name renders verbatim');
  // The cap pipeline counts the rendered line as 3 PHYSICAL lines: 253
  // ordinary lines + this line = exactly 256 → fits (254 entries kept,
  // not truncated); adding one more line trips the cap and drops the
  // tail (line-granular), reporting truncation.
  const fit = applyOutputCaps([...Array.from({ length: 253 }, () => 'x'), line]);
  assert.equal(fit.lines.length, 254);
  assert.equal(fit.truncated, false);
  assert.equal(fit.lines.join('\n').split('\n').length, 256);
  const capped = applyOutputCaps([...Array.from({ length: 253 }, () => 'x'), line, 'tail']);
  assert.equal(capped.lines.length, 254);
  assert.equal(capped.truncated, true);
  assert.equal(capped.lines.join('\n').split('\n').length, 256);
});
