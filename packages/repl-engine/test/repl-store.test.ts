/**
 * Per-project store tests (phase D): the `repl/` subdirectory under
 * `workflowHomeDir()/projects/<key>/` holding the enveloped snapshot and
 * the call store. Pins:
 *
 * - the layout (the workflow store-layout helpers' key, verbatim),
 * - the atomic write mechanics (snapshot file replaced; a stale tmp
 *   from a crashed write does not corrupt the next one),
 * - the load path with the wasm-hash-mismatch REFUSAL naming BOTH
 *   hashes (never a restore into garbage),
 * - the version-bump refusal through the store,
 * - corrupted/truncated snapshot handling: loud single-shot failure,
 *   the store stays usable (no crash-loop),
 * - the snapshot-write cadence + debounce (one write per drain burst;
 *   `debounceBursts: false` writes per boundary),
 * - the call store + snapshot coexisting in the same `repl/` directory,
 * - `reset()` teardown.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  CALL_STORE_FILENAME,
  GUEST_LIBRARY_VERSION,
  REPL_STORE_SUBDIR,
  SNAPSHOT_FILENAME,
  SNAPSHOT_FORMAT_VERSION,
  ReplWorkspaceStore,
  SnapshotEnvelopeError,
  Workspace,
  loadShippedWasm,
  wasmSha256Of,
} from '../src/index.js';
import { workflowHomeDir, workflowProjectPaths } from '@automatalabs/workflows';

const PROJECT = '/tmp/repl-store-project';

/** `assert.throws` returns undefined at runtime — capture the error. */
function captureThrows(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  assert.fail('expected the call to throw');
}

/** A scratch persistence root for the store (workflowHomeDir override). */
function root(): string {
  return mkdtempSync(join(tmpdir(), 'repl-store-root-'));
}

async function setup() {
  const dir = root();
  const module = await loadShippedWasm();
  const store = ReplWorkspaceStore.open(PROJECT, { persistenceRoot: dir });
  return { dir, module, store };
}

function teardown(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────────
// Layout
// ────────────────────────────────────────────────────────────────────────

test('layout: the repl/ store sits next to the workflow state under workflowHomeDir()/projects/<key>/', () => {
  const dir = root();
  const store = ReplWorkspaceStore.open(PROJECT, { persistenceRoot: dir });
  const paths = workflowProjectPaths(PROJECT, { persistenceRoot: dir });
  assert.equal(store.replDir, join(paths.rootDir, REPL_STORE_SUBDIR));
  assert.equal(store.snapshotPath, join(paths.rootDir, REPL_STORE_SUBDIR, SNAPSHOT_FILENAME));
  assert.equal(store.callStorePath, join(paths.rootDir, REPL_STORE_SUBDIR, CALL_STORE_FILENAME));
  // The workflow engine's own store directory is the sibling (the repl
  // dir is "next to the workflow state", never inside it).
  assert.ok(store.replDir.startsWith(join(workflowHomeDir({ persistenceRoot: dir }), 'projects')), store.replDir);
  assert.ok(store.replDir.includes(`projects/${paths.key}/repl`), store.replDir);
  assert.equal(store.hasSnapshot(), false, 'a fresh store has no snapshot');
  teardown(dir);
});

// ────────────────────────────────────────────────────────────────────────
// Write + load round trip; hash-mismatch refusal
// ────────────────────────────────────────────────────────────────────────

test('write/load round trip: the enveloped snapshot restores the workspace; the call store coexists in the same repl/ dir', async () => {
  const { dir, module, store } = await setup();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval('const durable = { n: 41 }; globalThis.tag = "before-crash";');
  store.writeSnapshot(ws.snapshot(), module);
  assert.equal(store.hasSnapshot(), true);
  assert.equal(store.stats().snapshotWrites, 1);

  // The call store lives beside the snapshot.
  const calls = store.callStore();
  calls.recordDispatched({
    callId: 'c1',
    kind: 'agent',
    detail: 'task',
    optionsJson: null,
    modelSpec: 'pi/x',
    backendId: null,
    foundingCallId: null,
    admittedAtMs: 1,
    admissionSequence: 1,
    dispatchedAtMs: 1,
    reissues: 0,
    completion: null,
    sessionId: null,
    queuedAtMs: null,
    handoffAtMs: null,
    cancelledAtMs: null,
  });
  calls.recordCompleted('c1', { outcome: 'resolve', value: 'done', completedAtMs: 2 });
  store.close();
  // Reopening the store replays the call log and reads the snapshot.
  const reopened = ReplWorkspaceStore.open(PROJECT, { persistenceRoot: dir });
  assert.equal(reopened.callStore().lookup('c1')!.completion!.value, 'done');
  const loaded = reopened.loadSnapshot(module);
  assert.equal(loaded.wasmSha256, wasmSha256Of(module));
  assert.equal(loaded.formatVersion, SNAPSHOT_FORMAT_VERSION);
  const ws2 = await Workspace.restore(PROJECT, loaded.snapshot, { wasm: module });
  const outcome = await ws2.eval('durable.n + 1 + "/" + tag');
  assert.equal(outcome.kind, 'value');
  assert.equal(outcome.value, '42/before-crash');
  ws.dispose();
  ws2.dispose();
  reopened.close();
  teardown(dir);
});

test('hash-mismatch refusal: a snapshot recorded by another binary refuses LOUDLY naming both hashes', async () => {
  const { dir, module, store } = await setup();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval('globalThis.x = 1;');
  store.writeSnapshot(ws.snapshot(), module);
  ws.dispose();

  // A different binary: the same shipped wasm with one byte flipped. The
  // restore must refuse before instantiating anything.
  const resolved = import.meta.resolve('quickjs-wasi/quickjs.wasm');
  const { readFile } = await import('node:fs/promises');
  const bytes = new Uint8Array(await readFile(new URL(resolved)));
  bytes[1024] ^= 0xff;
  const foreign = bytes;

  const error = captureThrows(() => store.loadSnapshot(foreign));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal((error as SnapshotEnvelopeError).code, 'WASM_HASH_MISMATCH');
  // NAMES BOTH HASHES — never a silent restore into garbage.
  const recordedHash = wasmSha256Of(module);
  const runningHash = wasmSha256Of(foreign);
  assert.ok(error.message.includes(recordedHash), `names the recorded hash: ${error.message}`);
  assert.ok(error.message.includes(runningHash), `names the running hash: ${error.message}`);
  assert.equal(error.recorded, recordedHash);
  assert.equal(error.expected, runningHash);
  teardown(dir);
});

test('hash-mismatch refusal PRECEDES payload interpretation: a foreign-binary payload that cannot be deserialized refuses as WASM_HASH_MISMATCH, never CORRUPT_PAYLOAD', async () => {
  // The phase-D review regression: the payload used to be gunzipped and
  // passed through `QuickJS.deserializeSnapshot()` BEFORE the running wasm
  // hash was compared — so a snapshot recorded by an incompatible binary
  // (whose raw memory layout is garbage to this binary) failed as
  // CORRUPT_PAYLOAD without naming the hashes. The identity check now
  // lives between the header parse and the payload decode.
  const { dir, module, store } = await setup();
  const runningHash = wasmSha256Of(module);
  // A FOREIGN recorded hash (valid hex, not the running binary's) over a
  // payload that is a VALID gzip stream but NOT a serialized snapshot (a
  // foreign binary's memory image would look exactly like this to this
  // binary: gunzip succeeds, deserialization would fail).
  const foreignHash = 'f'.repeat(64);
  const gz = gzipSync(Buffer.from('not a quickjs snapshot payload'));
  const header = Buffer.from(
    JSON.stringify({
      format: 'repl-snapshot',
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      wasmSha256: foreignHash,
      createdAtMs: Date.now(),
    }) + '\n',
    'utf8',
  );
  writeFileSync(store.snapshotPath, Buffer.concat([header, gz]));

  const error = captureThrows(() => store.loadSnapshot(module));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal((error as SnapshotEnvelopeError).code, 'WASM_HASH_MISMATCH', `names the hashes instead of the payload: ${error.message}`);
  assert.ok(error.message.includes(foreignHash), `names the recorded hash: ${error.message}`);
  assert.ok(error.message.includes(runningHash), `names the running hash: ${error.message}`);
  assert.equal(error.recorded, foreignHash);
  assert.equal(error.expected, runningHash);
  teardown(dir);
});

test('version-bump refusal through the store: an upgraded format version refuses naming both versions', async () => {
  const { dir, module, store } = await setup();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval('globalThis.x = 1;');
  store.writeSnapshot(ws.snapshot(), module);
  ws.dispose();
  // Forge a bumped envelope over the file (a future format release).
  const raw = readFileSync(store.snapshotPath);
  const nl = raw.indexOf(0x0a);
  const header = JSON.parse(raw.subarray(0, nl).toString('utf8'));
  writeFileSync(store.snapshotPath, Buffer.concat([
    Buffer.from(JSON.stringify({ ...header, formatVersion: SNAPSHOT_FORMAT_VERSION + 1 }) + '\n'),
    raw.subarray(nl + 1),
  ]));
  const error = captureThrows(() => store.loadSnapshot(module));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal((error as SnapshotEnvelopeError).code, 'VERSION_MISMATCH');
  assert.ok(error.message.includes(String(SNAPSHOT_FORMAT_VERSION + 1)), error.message);
  assert.ok(error.message.includes(String(SNAPSHOT_FORMAT_VERSION)), error.message);
  assert.ok(error.message.includes(store.snapshotPath), error.message);
  teardown(dir);
});

test('format 3 / guest 0.5: a format-2 snapshot is refused before old guest state can be restored or executed', async () => {
  assert.equal(SNAPSHOT_FORMAT_VERSION, 3);
  assert.equal(GUEST_LIBRARY_VERSION, '0.5.0');
  const { dir, module, store } = await setup();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval(`
    globalThis.oldGuestExecutionSentinel = "must never be observed by a new workspace";
    globalThis.followUp = () => { throw new Error("old guest followUp executed"); };
  `);
  store.writeSnapshot(ws.snapshot(), module);
  ws.dispose();

  const raw = readFileSync(store.snapshotPath);
  const nl = raw.indexOf(0x0a);
  const header = JSON.parse(raw.subarray(0, nl).toString('utf8'));
  writeFileSync(store.snapshotPath, Buffer.concat([
    Buffer.from(JSON.stringify({ ...header, formatVersion: 2 }) + '\n'),
    raw.subarray(nl + 1),
  ]));

  const error = captureThrows(() => store.loadSnapshot(module));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal((error as SnapshotEnvelopeError).code, 'VERSION_MISMATCH');
  assert.equal(error.recorded, '2');
  assert.equal(error.expected, '3');
  assert.match(error.message, /format version 2/);
  // No decoded snapshot is returned, so Workspace.restore — the only path
  // that can register callbacks or resume guest jobs — is never reachable.
  assert.equal(store.hasSnapshot(), true, 'the incompatible bytes remain available for the refusal/rename-aside path');
  teardown(dir);
});

// ────────────────────────────────────────────────────────────────────────
// Corrupted / truncated handling
// ────────────────────────────────────────────────────────────────────────

test('corrupted/truncated snapshot: loud single-shot failure, no crash-loop, the store stays usable', async () => {
  const { dir, module, store } = await setup();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval('globalThis.x = 1;');
  store.writeSnapshot(ws.snapshot(), module);

  // Garbage over the file: loud refusal naming the file.
  writeFileSync(store.snapshotPath, 'this is not a snapshot file at all');
  let error = captureThrows(() => store.loadSnapshot(module));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);

  // Truncated envelope (the gzip body cut): loud refusal, same code.
  store.writeSnapshot(ws.snapshot(), module);
  const valid = readFileSync(store.snapshotPath);
  writeFileSync(store.snapshotPath, valid.subarray(0, Math.floor(valid.length / 2)));
  error = captureThrows(() => store.loadSnapshot(module));
  assert.ok(error instanceof SnapshotEnvelopeError, error.message);
  assert.equal((error as SnapshotEnvelopeError).code, 'CORRUPT_PAYLOAD');

  // No crash-loop: the store is immediately usable — a fresh write
  // replaces the bad file and the load succeeds again.
  store.writeSnapshot(ws.snapshot(), module);
  assert.equal(store.hasSnapshot(), true);
  const loaded = store.loadSnapshot(module);
  const ws2 = await Workspace.restore(PROJECT, loaded.snapshot, { wasm: module });
  const outcome = await ws2.eval('x + 1');
  assert.equal(outcome.kind, 'value');
  assert.equal(outcome.value, 2);
  ws.dispose();
  ws2.dispose();
  teardown(dir);
});

test('a snapshot write that fails leaves the previous snapshot untouched and removes the tmp file', async () => {
  const { dir, module, store } = await setup();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval('globalThis.x = 1;');
  store.writeSnapshot(ws.snapshot(), module);

  // Make the atomic replace fail: rename over a DIRECTORY at the target
  // path is impossible, so the write throws loudly.
  rmSync(store.snapshotPath);
  mkdirSync(store.snapshotPath);
  assert.throws(() => store.writeSnapshot(ws.snapshot(), module), /EISDIR|ENOTDIR|EEXIST|ENOTEMPTY|rename/);
  // The tmp file was cleaned up; the target directory is still there
  // (the failure happened before any destructive step).
  const { readdirSync } = await import('node:fs');
  const entries = readdirSync(store.replDir);
  assert.ok(!entries.some((e) => e.endsWith('.tmp')), `no tmp file left behind: ${entries.join(', ')}`);

  // The store stays usable: remove the blocking directory and write again.
  rmSync(store.snapshotPath, { recursive: true });
  store.writeSnapshot(ws.snapshot(), module);
  const reloaded = store.loadSnapshot(module);
  const ws2 = await Workspace.restore(PROJECT, reloaded.snapshot, { wasm: module });
  assert.equal((await ws2.eval('x + 1')).value, 2, 'the store is fully usable after the failed write');
  ws2.dispose();
  ws.dispose();
  teardown(dir);
});

// ────────────────────────────────────────────────────────────────────────
// Cadence, debounce, and teardown
// ────────────────────────────────────────────────────────────────────────

test('snapshotWriter: one atomic write per drain burst (the doc\'s debounce), boundaries coalesced', async () => {
  const { dir, module, store } = await setup();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  const sink = store.snapshotWriter(ws, module);

  // A burst of boundaries coalesces into ONE write at the flush.
  sink.boundary('settlement');
  sink.boundary('eval');
  assert.equal(store.stats().snapshotWrites, 0, 'debounced: nothing written inside the burst');
  sink.flush();
  assert.equal(store.stats().snapshotWrites, 1, 'one write for the whole burst');
  // An empty flush writes nothing.
  sink.flush();
  assert.equal(store.stats().snapshotWrites, 1);

  // The written snapshot reflects the LIVE workspace state at flush time.
  await ws.eval('globalThis.burstState = "yes";');
  sink.boundary('eval');
  await ws.eval('globalThis.burstState = "mutated-after-boundary";');
  sink.flush();
  const loaded = store.loadSnapshot(module);
  const ws2 = await Workspace.restore(PROJECT, loaded.snapshot, { wasm: module });
  const burstOutcome = await ws2.eval('burstState');
  assert.equal(burstOutcome.kind, 'value');
  assert.equal(burstOutcome.value, 'mutated-after-boundary', 'the snapshot carries the state at FLUSH time, not at boundary time');
  ws.dispose();
  ws2.dispose();
  teardown(dir);
});

test('debounceBursts: false writes synchronously at every boundary', async () => {
  const dir = root();
  const module = await loadShippedWasm();
  const store = ReplWorkspaceStore.open(PROJECT, {
    persistenceRoot: dir,
    snapshotWrite: { debounceBursts: false },
  });
  const ws = await Workspace.create(PROJECT, { wasm: module });
  const sink = store.snapshotWriter(ws, module);
  sink.boundary('eval');
  assert.equal(store.stats().snapshotWrites, 1, 'the boundary wrote immediately');
  sink.boundary('settlement');
  sink.flush();
  assert.equal(store.stats().snapshotWrites, 2, 'every boundary writes when the debounce is off');
  ws.dispose();
  teardown(dir);
});

test('THE REVIEW REGRESSION: a failed flush RETAINS the dirty boundary — the next flush retries the SAME state, never a silent drop (phase-D review round 6: the boundary used to clear before the write)', async () => {
  const dir = root();
  const module = await loadShippedWasm();
  const store = ReplWorkspaceStore.open(PROJECT, { persistenceRoot: dir });
  const ws = await Workspace.create(PROJECT, { wasm: module });
  await ws.eval('globalThis.pending = "must survive";');
  const sink = store.snapshotWriter(ws, module);
  sink.boundary('eval');
  // Sabotage the atomic write: a DIRECTORY at the tmp path makes the
  // write's open fail (EISDIR) — the previous snapshot file, if any,
  // is untouched.
  mkdirSync(`${store.snapshotPath}.tmp`);
  const error = captureThrows(() => sink.flush());
  assert.ok(error instanceof Error, 'the failed write throws loudly');
  assert.equal(store.stats().snapshotWrites, 0, 'the failed write is not counted');
  assert.equal(existsSync(store.snapshotPath), false, 'no partial snapshot file');
  // The boundary is STILL DIRTY: after the obstruction is removed, the
  // next flush writes the same state (the failed boundary is retained
  // for retry — a kill after the failure loses nothing that was
  // acknowledged, and the next drain burst persists it).
  rmSync(`${store.snapshotPath}.tmp`, { recursive: true, force: true });
  sink.flush();
  assert.equal(store.stats().snapshotWrites, 1, 'the retained boundary wrote on the retry');
  const loaded = store.loadSnapshot(module);
  const ws2 = await Workspace.restore(PROJECT, loaded.snapshot, { wasm: module });
  const outcome = await ws2.eval('globalThis.pending');
  assert.equal(outcome.kind, 'value');
  assert.equal(outcome.value, 'must survive', 'the retried snapshot carries the SAME state the failed flush was asked to persist');
  ws.dispose();
  ws2.dispose();
  teardown(dir);
});

test('reset tears the repl/ directory down (the reset() guest function\'s engine-side) — §6.1 [C]13: a renamed-aside refused snapshot is NEVER deleted', async () => {
  const { dir, module, store } = await setup();
  const ws = await Workspace.create(PROJECT, { wasm: module });
  store.writeSnapshot(ws.snapshot(), module);
  store.callStore().recordDispatched({
    callId: 'c1',
    kind: 'checkpoint',
    detail: 'question?',
    optionsJson: null,
    modelSpec: null,
    backendId: null,
    foundingCallId: null,
    admittedAtMs: 1,
    admissionSequence: 1,
    dispatchedAtMs: 1,
    reissues: 0,
    completion: null,
    sessionId: null,
    queuedAtMs: null,
    handoffAtMs: null,
    cancelledAtMs: null,
  });
  assert.equal(store.hasSnapshot(), true);
  // A refused snapshot that auto-reset renamed aside survives the wipe
  // (the §6.1 data-safety guarantee — auto-reset is never silent data
  // destruction, and neither is a later reset()).
  const refusedAside = `${store.snapshotPath}.refused-1720000000000`;
  writeFileSync(refusedAside, 'refused bytes');
  store.reset();
  assert.equal(store.hasSnapshot(), false, 'the snapshot is gone');
  assert.equal(store.stats().snapshotWrites, 0, 'the counters reset');
  assert.equal(existsSync(store.replDir), true, 'the repl/ directory itself stays');
  assert.deepEqual(
    [...readdirSync(store.replDir)],
    ['snapshot.bin.refused-1720000000000'],
    'every store file was dropped — EXCEPT the renamed-aside refused snapshot',
  );
  // The store is usable again from scratch.
  store.writeSnapshot(ws.snapshot(), module);
  assert.equal(store.hasSnapshot(), true);
  assert.equal(store.callStore().lookup('c1'), undefined, 'the call log was dropped with the directory contents');
  ws.dispose();
  teardown(dir);
});
