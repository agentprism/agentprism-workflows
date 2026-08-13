/**
 * Previewer tests for the eval-plane redesign: the §4.4 depth-limited
 * completion repr (renderCompletionLine — direct strings whole, objects/
 * arrays to depth 2, 20 entries per level, nested strings head-limited at
 * 200 chars, NO byte ceiling), the RETAINED metadata-formatting token
 * rules (§7: stringDescription/shortString/headTailDescription,
 * formatNumber/formatByteSize, the manifest seam), and the trap-freedom
 * discipline around the completion rendering (never execute guest
 * getters — the R69 rule).
 *
 * The old `$N`-line previewer surface (renderRefLine/renderGlobalLine/
 * renderCollapsed over `$N` slots) and the EMISSION_STRING_MAX_CHARS
 * emission budget are DELETED features — their tests are deleted with
 * them.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ReplVm,
  Workspace,
  escapeString,
  formatByteSize,
  formatNumber,
  headTailDescription,
  installGuestBridge,
  inspectGlobal,
  isCanonicalIndex,
  manifestBinding,
  shortString,
  stringDescription,
  MAX_COLLAPSED_CHARS,
  REPR_MAX_DEPTH,
  REPR_MAX_ENTRIES,
  REPR_NESTED_STRING_CHARS,
} from '../src/index.js';
import { renderCompletionLine } from '../src/preview.js';
import { getVmShim } from '../src/vm.js';
import type { JSValueHandle, QuickJS } from 'quickjs-wasi';

// ────────────────────────────────────────────────────────────────────────
// Host-side repr probes: eval a source expression, read the LIVE
// completion handle (exactly what the broker's render does), and run the
// completion repr over it.
// ────────────────────────────────────────────────────────────────────────

/** Eval a script in a bare VM, returning the live completion handle for a
 *  RESOLVED eval (owned by the caller). */
function describeOutcome(outcome: unknown): string {
  try {
    return JSON.stringify(outcome);
  } catch {
    return String(outcome);
  }
}

function evalCompletion(vm: ReplVm, source: string): JSValueHandle {
  const { outcome, completion } = vm.evalCodeWithCompletion(source);
  assert.equal(outcome.kind, 'value', `expected value, got ${describeOutcome(outcome)}`);
  assert.ok(completion !== undefined);
  return completion as JSValueHandle;
}

function reprOf(vm: ReplVm, source: string): string {
  const handle = evalCompletion(vm, source);
  try {
    return renderCompletionLine(handle);
  } finally {
    handle.dispose();
  }
}

async function createVm(): Promise<ReplVm> {
  const vm = await ReplVm.create();
  await installGuestBridge(vm, {
    agent: () => undefined,
    checkpoint: () => undefined,
    steer: () => undefined,
    console: () => undefined,
    sleep: () => undefined,
    workspace: () => '{}',
    agents: () => '[]',
    reset: () => undefined,
    defaultBackend: () => undefined,
  });
  return vm;
}

// ────────────────────────────────────────────────────────────────────────
// The §4.4 completion repr (the rules, whole direct strings included)
// ────────────────────────────────────────────────────────────────────────

test('§4.4 completion repr: a string completion value prints WHOLE with no upper bound', async () => {
  using vm = await createVm();
  assert.equal(reprOf(vm, '"hi"'), 'hi');
  const short = 'a'.repeat(200);
  assert.equal(reprOf(vm, JSON.stringify(short)), short);
  // NO byte ceiling: the Python posture — the whole string is the result.
  const long = 'x'.repeat(50_000);
  assert.equal(reprOf(vm, JSON.stringify(long)), long);
  const multiline = 'line1\nline2\n' + 'y'.repeat(5000);
  assert.equal(reprOf(vm, JSON.stringify(multiline)), multiline);
});

test('§4.4 completion repr: primitives', async () => {
  using vm = await createVm();
  assert.equal(reprOf(vm, 'undefined'), 'undefined');
  assert.equal(reprOf(vm, 'null'), 'null');
  assert.equal(reprOf(vm, 'true'), 'true');
  assert.equal(reprOf(vm, 'false'), 'false');
  assert.equal(reprOf(vm, '42'), '42');
  assert.equal(reprOf(vm, '-0'), '-0');
  assert.equal(reprOf(vm, 'NaN'), 'NaN');
  assert.equal(reprOf(vm, 'Infinity'), 'Infinity');
  assert.equal(reprOf(vm, '123n'), '123n');
});

test('§4.4 completion repr: objects/arrays to depth 2; deeper levels render as {…}/[…]', async () => {
  using vm = await createVm();
  assert.equal(reprOf(vm, '({ a: 1, b: [1, 2] })'), '{a: 1, b: [1, 2]}');
  assert.equal(reprOf(vm, '({ a: { b: { c: 2 } } })'), '{a: {b: {…}}}');
  assert.equal(reprOf(vm, '[[1, 2], [3, [4]]]'), '[[1, 2], [3, […]]]');
  // Level-0 entries expand; level-2 values collapse.
  assert.equal(reprOf(vm, '({ deep: { deeper: { deepest: [1] } }, arr: [0, { x: { y: 1 } }] })'), '{deep: {deeper: {…}}, arr: [0, {…}]}');
});

test('§4.4 completion repr: 20 entries per level, then … +N more', async () => {
  using vm = await createVm();
  const arr = reprOf(vm, 'Array.from({ length: 22 }, (_, i) => i)');
  assert.equal(arr, '[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, … +2 more]');
  const obj = reprOf(vm, '(function () { const o = {}; for (let i = 0; i < 25; i++) o["k" + i] = i; return o; })()');
  assert.ok(obj.endsWith('… +5 more}'), obj);
  assert.ok(obj.split(', ').length === 21, obj);
});

test('§4.4 completion repr: nested strings head-limited at 200 chars, quoted', async () => {
  using vm = await createVm();
  const long = 'y'.repeat(500);
  const rendered = reprOf(vm, `({ long: ${JSON.stringify(long)}, short: 'hi', list: [${JSON.stringify(long)}] })`);
  assert.ok(rendered.includes(`long: '${'y'.repeat(200)}…'`), rendered);
  assert.ok(rendered.includes("short: 'hi'"), rendered);
  assert.ok(rendered.includes(`['${'y'.repeat(200)}…'`), rendered);
});

test('§4.4 completion repr: functions, symbols, branded objects and errors render as predictable leaves', async () => {
  using vm = await createVm();
  assert.equal(reprOf(vm, '(function named() {})'), 'ƒ named()');
  assert.equal(reprOf(vm, 'Symbol()'), 'Symbol');
  assert.equal(reprOf(vm, 'new Date(0)'), 'Date');
  assert.equal(reprOf(vm, '/ab+c/gi'), 'RegExp');
  assert.equal(reprOf(vm, 'new Map()'), 'Map');
  assert.equal(reprOf(vm, 'new Set()'), 'Set');
  assert.equal(reprOf(vm, 'new WeakMap()'), 'WeakMap');
  assert.equal(reprOf(vm, 'new ArrayBuffer(8)'), 'ArrayBuffer(8)');
  assert.equal(reprOf(vm, 'new Uint8Array(4)'), 'Uint8Array');
  assert.equal(reprOf(vm, 'new Error("boom")'), 'Error: boom');
});

test('§4.4 completion repr: cycles and shared refs collapse to {…}/[…]', async () => {
  using vm = await createVm();
  const ring = reprOf(vm, '(function () { const o = { name: "ring" }; o.self = o; return o; })()');
  assert.equal(ring, "{name: 'ring', self: {…}}");
  const arr = reprOf(vm, '(function () { const a = [1]; a.push(a); return a; })()');
  assert.equal(arr, '[1, […]]');
});

test('§4.4 completion repr: the repr constants carry the bible numbers', () => {
  assert.equal(REPR_MAX_DEPTH, 2);
  assert.equal(REPR_MAX_ENTRIES, 20);
  assert.equal(REPR_NESTED_STRING_CHARS, 200);
});

// ────────────────────────────────────────────────────────────────────────
// Trap-freedom around the completion rendering (the R69 discipline: the
// renderer never executes guest getters)
// ────────────────────────────────────────────────────────────────────────

test('trap-freedom: hostile getters on the completion value never fire while rendering', async () => {
  using vm = await createVm();
  const out = reprOf(
    vm,
    `(function () {
      let traps = 0;
      globalThis.__traps = () => traps;
      return {
        get hostile() { traps++; return 'x'; },
        nested: { get also() { traps++; return 'y'; } },
        safe: 'ok',
      };
    })()`,
  );
  assert.equal(out, "{hostile: (…), nested: {also: (…)}, safe: 'ok'}", 'accessors render as (…) — the getters never fired');
  // The traps counter can be observed through a global counter instead.
  const counter = await createVm();
  const rendered = reprOf(
    counter,
    `(function () {
      globalThis.traps = 0;
      return {
        get hostile() { globalThis.traps++; return 'x'; },
        safe: 'ok',
      };
    })()`,
  );
  assert.equal(rendered, "{hostile: (…), safe: 'ok'}");
  const read = await counter.evalCode('globalThis.traps');
  assert.equal(read.kind, 'value');
  assert.equal((read as { value: unknown }).value, 0, 'no getter ran');
});

test('trap-freedom: Object.prototype.value pollution cannot hijack the completion repr', async () => {
  // Review regression lineage (R69): the engine's completion read takes
  // the value own-property-descriptor-wise; a polluted Object.prototype
  // getter must never FIRE and its forged value must never leak into a
  // rendered result. (The engine's pinned quirk — the completion
  // wrapper's [[Set]] silently no-ops under the pollution — may change
  // WHICH value renders, but the forged "polluted" string never does.)
  using vm = await createVm();
  assert.equal(reprOf(vm, '42'), '42');
  const prep = await vm.evalCode('Object.defineProperty(Object.prototype, "value", { get() { return "polluted"; } }); "done"');
  assert.equal(prep.kind, 'value');
  const rendered = reprOf(vm, '42');
  assert.ok(!rendered.includes('polluted'), `the forged value never leaks (got ${rendered})`);
  const obj = reprOf(vm, '({ a: 1 })');
  assert.ok(!obj.includes('polluted'), `the forged value never leaks (got ${obj})`);
});

test('trap-freedom: proxy traps never fire while rendering the completion repr', async () => {
  using vm = await createVm();
  const out = reprOf(
    vm,
    `(function () {
      globalThis.pTraps = 0;
      const p = new Proxy({ a: 1 }, {
        get() { globalThis.pTraps++; return 7; },
        ownKeys() { globalThis.pTraps++; return ['a']; },
      });
      return p;
    })()`,
  );
  assert.equal(out, 'Proxy(Object)');
  const read = await vm.evalCode('globalThis.pTraps');
  assert.equal(read.kind, 'value');
  assert.equal((read as { value: unknown }).value, 0, 'no proxy trap ran');
});

// ────────────────────────────────────────────────────────────────────────
// Retained metadata formatting (§7: the internal 200-char previews the
// engine still uses — manifest tokens, checkpoint-question previews)
// ────────────────────────────────────────────────────────────────────────

test('retained token rules: formatNumber and formatByteSize', () => {
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
  assert.equal(formatByteSize(3), '3B');
  assert.equal(formatByteSize(999), '999B');
  assert.equal(formatByteSize(1000), '1kB');
  assert.equal(formatByteSize(48000), '48kB');
  assert.equal(formatByteSize(999_999), '1MB');
});

test('retained token rules: stringDescription/shortString/headTailDescription/escapeString/isCanonicalIndex', () => {
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
  const elided = headTailDescription('e'.repeat(200), 120);
  assert.ok(elided.startsWith('e'.repeat(72)));
  assert.ok(elided.endsWith('e'.repeat(24)));
  assert.ok(elided.includes('[104 chars elided]'));
  assert.equal(escapeString('a"b\\c\nd\te\rf\u0001g'), 'a\\"b\\\\c\\nd\\te\\rf\\u0001g');
  assert.equal(isCanonicalIndex('0'), true);
  assert.equal(isCanonicalIndex('01'), false);
  assert.equal(isCanonicalIndex('-1'), false);
  assert.equal(isCanonicalIndex('4294967295'), false);
});

test('retained seam: inspectGlobal and manifestBinding still serve the workspace manifest (metadata, never content)', async () => {
  using vm = await createVm();
  const prep = await vm.evalCode('var userValue = { a: 1 }; "done"');
  assert.equal(prep.kind, 'value');
  const meta = inspectGlobal(vm, 'userValue');
  assert.equal(meta.kind, 'data');
  assert.ok(meta.label.length > 0);
  assert.ok(meta.sizeBytes > 0);
  const binding = manifestBinding(vm, 'userValue');
  assert.ok(binding !== null);
  assert.match(binding.token, /B/);
  assert.equal(binding.handleCallId, null);
  // The manifest seam stays trap-free: an accessor binding reads as
  // absent/sabotage, never fired.
  await vm.evalCode('Object.defineProperty(globalThis, "getterThing", { get() { return 1; } }); "ok"');
  assert.equal(inspectGlobal(vm, 'getterThing').kind, 'accessor');
});

test('MAX_COLLAPSED_CHARS is retained (the collapsed-preview backstop constant)', () => {
  assert.equal(typeof MAX_COLLAPSED_CHARS, 'number');
  assert.ok(MAX_COLLAPSED_CHARS > 0);
});

// ────────────────────────────────────────────────────────────────────────
// The workspace manifest remains functional (the retained metadata seam
// the workspace()/status surface builds on)
// ────────────────────────────────────────────────────────────────────────

test('the workspace manifest lists user bindings; the deleted $N refs never appear', async () => {
  const ws = await Workspace.create('/tmp/repl-preview-project');
  try {
    await ws.eval('const findings = [1, 2, 3]; "done"');
    const manifest = ws.manifest();
    const names = manifest.bindings.map((b) => b.name);
    assert.ok(names.includes('findings'));
    assert.ok(!names.some((n) => /^\$\d+$/.test(n)), 'no $N refs in the manifest');
    assert.deepEqual(manifest.logs, { first: null, last: null, count: 0 });
  } finally {
    ws.dispose();
  }
});

// The trap-free read path is exercised through the workspace eval below
// (a completion repr over a live handle from a real workspace).
test('the completion repr round-trips through a real workspace eval', async () => {
  const ws = await Workspace.create('/tmp/repl-preview-project-2');
  try {
    const { outcome, completion } = ws.evalWithCompletion('({ answer: 42, nested: { deep: true } })');
    assert.equal(outcome.kind, 'value');
    const handle = completion as JSValueHandle;
    try {
      assert.equal(renderCompletionLine(handle), '{answer: 42, nested: {deep: true}}');
    } finally {
      handle.dispose();
    }
  } finally {
    ws.dispose();
  }
});

// The raw shim import is kept referenced for the trap-free handle probes.
void getVmShim;
void (undefined as unknown as QuickJS);

test('§7: the $N capture previewer surface is DELETED from the public exports (renderRefLine / renderGlobalLine / renderPreviewLine / previewGlobal)', async () => {
  const index = await import('../src/index.js');
  assert.equal('renderRefLine' in index, false, 'renderRefLine must be deleted');
  assert.equal('renderGlobalLine' in index, false, 'renderGlobalLine must be deleted');
  assert.equal('renderPreviewLine' in index, false, 'renderPreviewLine must be deleted');
  assert.equal('previewGlobal' in index, false, 'previewGlobal must be deleted');
  assert.equal('Workspace' in index, true, 'the retained seams stay exported');
  // The retained metadata-formatting tokens and the manifest seam stay.
  assert.equal('inspectGlobal' in index, true);
  assert.equal('stringDescription' in index, true);
  assert.equal('renderCollapsed' in index, true);
});
