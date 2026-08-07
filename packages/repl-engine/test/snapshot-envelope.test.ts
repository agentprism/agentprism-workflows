/**
 * Snapshot-envelope tests (phase D): the at-rest identity envelope for
 * quickjs-wasi snapshots — wasm-binary sha256 + format version + gzip,
 * per the roadmap doc's transfer lesson 5. Pins:
 *
 * - the envelope round trip (serialize → deserialize → restore → state
 *   intact, gzip actually compressing),
 * - `wasmSha256Of` (raw bytes hash directly; a module from
 *   `loadShippedWasm` hashes to the same value; an unknown module
 *   refuses),
 * - the version-bump refusal (an envelope carrying a newer format
 *   version refuses loudly naming BOTH versions — never a silent
 *   restore),
 * - the format-name refusal,
 * - corrupt/truncated header and payload refusals (loud, single-shot).
 *
 * The wasm-hash-mismatch refusal (naming both hashes) is pinned in
 * `repl-store.test.ts`, where the comparison lives.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_VERSION,
  SnapshotEnvelopeError,
  Workspace,
  deserializeSnapshot,
  loadShippedWasm,
  serializeSnapshot,
  wasmSha256Of,
  type ReplSnapshot,
  type WasmModule,
} from '../src/index.js';

const PROJECT = '/tmp/repl-envelope-project';

/** `assert.throws` returns undefined at runtime — capture the error. */
function captureThrows(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  assert.fail('expected the call to throw');
}

/** The shipped binary's raw bytes (the identity the envelope records). */
async function shippedBytes(): Promise<Uint8Array> {
  const resolved = import.meta.resolve('quickjs-wasi/quickjs.wasm');
  return new Uint8Array(await readFile(new URL(resolved)));
}

/** A tiny but structurally valid snapshot stand-in for the pure
 *  envelope round trip (the shim's deserialize accepts the header +
 *  memory layout). The pointers are IN-RANGE integers (strictly inside
 *  the 4-byte memory, nonzero) — the shape/bounds check the engine's
 *  decoder applies (phase-D review rejection: the check used to be
 *  type-only). */
function tinySnapshot(memory: Uint8Array = new Uint8Array([1, 2, 3, 4])): ReplSnapshot {
  return {
    memory,
    stackPointer: 1,
    runtimePtr: 2,
    contextPtr: 3,
    extensions: [],
  };
}

// ────────────────────────────────────────────────────────────────────────
// Envelope round trip
// ────────────────────────────────────────────────────────────────────────

test('envelope round trip: serialize → deserialize → restore keeps the workspace state', async () => {
  const module = await loadShippedWasm();
  const hash = wasmSha256Of(module);
  assert.match(hash, /^[0-9a-f]{64}$/);

  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval('const findings = ["alpha", "beta"]; globalThis.stage = "live";');
  const raw = ws.snapshot();
  const envelope = serializeSnapshot(raw, hash);

  // The envelope is the header line + a gzip payload (gzip magic 0x1f 0x8b).
  assert.equal(Buffer.from(envelope.subarray(0, 1))[0], 0x7b, 'the envelope starts with the JSON header line');
  const nl = envelope.indexOf(0x0a);
  assert.ok(nl > 0, 'the header is newline-terminated');
  assert.equal(envelope[nl + 1], 0x1f, 'the payload starts with the gzip magic (0x1f)');
  assert.equal(envelope[nl + 2], 0x8b, 'the payload starts with the gzip magic (0x8b)');
  // Compression is real: a fresh VM's memory is mostly zeros.
  assert.ok(envelope.length < raw.memory.byteLength, 'the envelope is smaller than the raw memory');

  const restored = deserializeSnapshot(envelope);
  assert.equal(restored.meta.format, SNAPSHOT_FORMAT);
  assert.equal(restored.meta.formatVersion, SNAPSHOT_FORMAT_VERSION);
  assert.equal(restored.meta.wasmSha256, hash);
  assert.ok(typeof restored.meta.createdAtMs === 'number');

  // The full restore path: the same wasm module, the deserialized snapshot.
  const ws2 = await Workspace.restore(PROJECT, restored.snapshot, { wasm: module });
  const outcome = await ws2.eval('findings.join("+") + "/" + stage');
  assert.equal(outcome.kind, 'value');
  assert.equal(outcome.value, 'alpha+beta/live');
  ws.dispose();
  ws2.dispose();
});

test('wasmSha256Of: raw bytes hash directly; a loadShippedWasm module hashes to the same value; an unknown module refuses', async () => {
  const bytes = await shippedBytes();
  const fromBytes = wasmSha256Of(bytes);
  assert.match(fromBytes, /^[0-9a-f]{64}$/);
  // A view over the same bytes hashes identically (byteOffset respected).
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 1, bytes.byteLength - 1);
  assert.notEqual(wasmSha256Of(view), fromBytes, 'a shifted view hashes differently');
  assert.equal(wasmSha256Of(bytes.slice(1)), wasmSha256Of(view), 'the same bytes hash identically');

  const module = await loadShippedWasm();
  assert.equal(wasmSha256Of(module), fromBytes, 'the compiled module hashes to its binary');
  assert.equal(wasmSha256Of(new Uint8Array([0, 97, 115, 109])).length, 64);

  // A module the engine did not load cannot be hashed (bytes are not
  // recoverable from the compiled form) — loud refusal.
  const foreign = (await WebAssembly.compile(bytes)) as unknown as WasmModule;
  assert.throws(() => wasmSha256Of(foreign), /was not produced by loadShippedWasm/);
});

test('serializeSnapshot rejects a malformed wasm hash (identity must be trustworthy)', () => {
  assert.throws(() => serializeSnapshot(tinySnapshot(), 'not-a-hash'), /must be a 64-hex|wasmSha256/);
});

// ────────────────────────────────────────────────────────────────────────
// Version-bump and format refusals
// ────────────────────────────────────────────────────────────────────────

test('version-bump refusal: an envelope carrying a newer format version refuses naming BOTH versions', () => {
  const envelope = serializeSnapshot(tinySnapshot(), 'a'.repeat(64));
  const nl = envelope.indexOf(0x0a);
  const header = JSON.parse(Buffer.from(envelope.subarray(0, nl)).toString('utf8'));
  const bumped = Buffer.concat([
    Buffer.from(JSON.stringify({ ...header, formatVersion: 999 }) + '\n'),
    envelope.subarray(nl + 1),
  ]);
  const error = captureThrows(() => deserializeSnapshot(bumped));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal(error.code, 'VERSION_MISMATCH');
  assert.ok(error.message.includes('999'), `names the recorded version: ${error.message}`);
  assert.ok(error.message.includes(String(SNAPSHOT_FORMAT_VERSION)), `names the supported version: ${error.message}`);
  assert.equal(error.recorded, '999');
  assert.equal(error.expected, String(SNAPSHOT_FORMAT_VERSION));
});

test('format-name refusal: an envelope carrying another format refuses naming the format', () => {
  const envelope = serializeSnapshot(tinySnapshot(), 'a'.repeat(64));
  const nl = envelope.indexOf(0x0a);
  const header = JSON.parse(Buffer.from(envelope.subarray(0, nl)).toString('utf8'));
  const other = Buffer.concat([
    Buffer.from(JSON.stringify({ ...header, format: 'harness-snapshot' }) + '\n'),
    envelope.subarray(nl + 1),
  ]);
  const error = captureThrows(() => deserializeSnapshot(other));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal(error.code, 'FORMAT_MISMATCH');
  assert.ok(error.message.includes('harness-snapshot'), error.message);
  assert.ok(error.message.includes(SNAPSHOT_FORMAT), error.message);
});

// ────────────────────────────────────────────────────────────────────────
// Corrupt / truncated handling
// ────────────────────────────────────────────────────────────────────────

test('a snapshot whose VM-header pointers are out of bounds refuses as CORRUPT_PAYLOAD at decode — the corrupted in-range-format header never reaches the restore (phase-D review rejection: the shape check used to be type-only, so a valid gzip/QJSS payload with `contextPtr` patched to `0xfffffff0` decoded cleanly and then crashed `Workspace.restore` with `RuntimeError: memory access out of bounds`)', async () => {
  const module = await loadShippedWasm();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  const raw = ws.snapshot();
  ws.dispose();
  const hash = wasmSha256Of(module);
  const cases: Array<[string, number]> = [
    // The reviewer's repro: a pointer patched far outside the memory.
    ['contextPtr', 0xfffffff0],
    // Just past the memory end.
    ['runtimePtr', raw.memory.byteLength],
    // Zeroed (malloc'd offsets are never 0).
    ['stackPointer', 0],
    // Negative (wraps in the wasm ABI).
    ['runtimePtr', -1],
  ];
  for (const [field, value] of cases) {
    const corrupted = { ...raw, [field]: value };
    const envelope = serializeSnapshot(corrupted, hash);
    const error = captureThrows(() => deserializeSnapshot(envelope, { expectedWasmSha256: hash }));
    assert.ok(error instanceof SnapshotEnvelopeError, `${field}=${value}: ${error.message}`);
    assert.equal(error.code, 'CORRUPT_PAYLOAD');
    assert.ok(error.message.includes('unrecognized shape'), `${field}=${value}: ${error.message}`);
  }
});

test('a corrupted in-range VM header that PASSES the decode checks refuses at RESTORE as SnapshotRestoreError (RESTORE_CORRUPT), never a raw RuntimeError', async () => {
  const module = await loadShippedWasm();
  const hash = wasmSha256Of(module);
  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval('globalThis.x = 1');
  const raw = ws.snapshot();
  ws.dispose();
  // The stack pointer patched to an in-range-but-wrong value (1): the
  // envelope is fully valid (same binary hash, proper gzip), the QJSS
  // payload parses, and the shape/bounds check passes — yet the wasm
  // restore traps (`RuntimeError: memory access out of bounds`) the
  // moment the stack is used. This is the corruption class NO at-rest
  // check can see; `Workspace.restore` must refuse it as a coded,
  // single-shot error naming the underlying failure.
  const corrupted = { ...raw, stackPointer: 1 };
  const envelope = serializeSnapshot(corrupted, hash);
  const decoded = deserializeSnapshot(envelope, { expectedWasmSha256: hash });
  assert.equal(decoded.snapshot.stackPointer, 1, 'decode accepts the in-range header (the corruption is invisible at rest)');
  let error: unknown;
  try {
    await Workspace.restore(PROJECT, decoded.snapshot, { wasm: module });
    assert.fail('expected the restore to refuse');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SnapshotEnvelopeError, `the refusal is in the envelope family: ${(error as Error).message}`);
  assert.equal((error as SnapshotEnvelopeError).code, 'RESTORE_CORRUPT');
  // The trap lands on the FIRST wasm call after the memory copy — the
  // host-callback re-registration (`registerGuestHostCallbacks`) — so
  // this payload exercises the INITIALIZATION-stage wrap (the partial-VM
  // disposal path, the reviewer's exact "callback/provenation
  // initialization throws" case). Either stage names itself; both are
  // the same coded refusal.
  const stage = (error as Error).message;
  assert.ok(
    stage.includes('restoring the workspace VM from the snapshot failed') ||
      stage.includes('initializing the restored workspace failed'),
    `names the restore stage: ${stage}`,
  );
  assert.ok(stage.includes('memory access out of bounds'), `names the cause: ${stage}`);
  // Repeatable and stable: a second attempt refuses identically (and the
  // failed attempt's partial VM was disposed — a good snapshot still
  // restores right after).
  try {
    await Workspace.restore(PROJECT, decoded.snapshot, { wasm: module });
    assert.fail('expected the second restore to refuse identically');
  } catch (caught) {
    assert.ok(caught instanceof SnapshotEnvelopeError && caught.code === 'RESTORE_CORRUPT', String(caught));
  }
  const good = await Workspace.restore(PROJECT, raw, { wasm: module });
  const outcome = await good.eval('x');
  assert.equal(outcome.kind, 'value');
  assert.equal(outcome.value, 1, 'an uncorrupted snapshot restores after the refused attempts');
  good.dispose();
});

test('corrupt envelopes refuse loudly, naming the file and the problem (single-shot, no silent pass)', () => {
  // No header line at all.
  const noHeader = new Uint8Array([1, 2, 3, 4, 5]);
  let error = captureThrows(() => deserializeSnapshot(noHeader, { path: '/tmp/x.bin' }));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal(error.code, 'BAD_HEADER');
  assert.ok(error.message.includes('/tmp/x.bin'), error.message);

  // A header that is not JSON.
  const badJson = Buffer.from('not json at all\nrest-of-file');
  error = captureThrows(() => deserializeSnapshot(badJson));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);

  // A header with a missing/invalid wasmSha256.
  const badHash = Buffer.from(`${JSON.stringify({ format: SNAPSHOT_FORMAT, formatVersion: SNAPSHOT_FORMAT_VERSION, createdAtMs: 1 })}\npayload`);
  error = captureThrows(() => deserializeSnapshot(badHash));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);

  // A truncated gzip payload (the body cut mid-stream — after the
  // header line, so the header itself stays intact).
  const envelope = serializeSnapshot(tinySnapshot(), 'a'.repeat(64));
  const headerEnd = envelope.indexOf(0x0a) + 1;
  const truncated = envelope.subarray(0, headerEnd + Math.floor((envelope.length - headerEnd) / 2));
  error = captureThrows(() => deserializeSnapshot(truncated));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal((error as SnapshotEnvelopeError).code, 'CORRUPT_PAYLOAD');
  assert.ok(error.message.includes('corrupt or truncated'), error.message);

  // A payload that gunzips but is not a serialized snapshot.
  const garbagePayload = Buffer.concat([
    Buffer.from(`${JSON.stringify({ format: SNAPSHOT_FORMAT, formatVersion: SNAPSHOT_FORMAT_VERSION, wasmSha256: 'a'.repeat(64), createdAtMs: 1 })}\n`),
    Buffer.from('this is not a snapshot'),
  ]);
  error = captureThrows(() => deserializeSnapshot(garbagePayload));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal((error as SnapshotEnvelopeError).code, 'CORRUPT_PAYLOAD');
});
