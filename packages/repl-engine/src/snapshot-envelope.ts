/**
 * The at-rest identity envelope for quickjs-wasi snapshots — transfer
 * lesson 5 from the roadmap doc (docs/roadmap/repl-orchestrator.md):
 * "quickjs-wasi snapshots are raw WASM linear memory — valid only against
 * the byte-identical `quickjs.wasm` build. A package upgrade plus a disk
 * snapshot = a restore into garbage with no diagnosis, unless the snapshot
 * file itself records which binary laid it out."
 *
 * The envelope wraps the shim's own `serializeSnapshot()` output (the
 * versioned binary: QJSS magic + version + extension metadata + raw
 * memory — quickjs-wasi's documented at-rest form) in:
 *
 * ```text
 * <JSON header line>\n<gzip(serialized snapshot)>
 *
 * header = {
 *   "format":        "repl-snapshot",   — the envelope format name
 *   "formatVersion": 1,                 — the envelope format version
 *   "wasmSha256":    "<64 hex>",        — sha256 of the wasm binary that
 *                                        laid out this memory
 *   "createdAtMs":   <unix ms>
 * }
 * ```
 *
 * The identity check lives at restore: the recorded `wasmSha256` is
 * compared against the hash of the binary the host is about to restore
 * with, and a mismatch REFUSES LOUDLY naming both hashes — never a silent
 * restore into garbage. The envelope format version is the second refusal
 * axis: a bump (an incompatible envelope layout, or a guest-library major
 * the host can no longer serve) refuses old snapshots naming both
 * versions. gzip is the compression (the doc's choice: JS runtimes
 * decompress it natively; measured at ~7.9x on real snapshots).
 *
 * Snapshot compatibility therefore holds across daemon restarts and
 * machines running the same quickjs-wasi package version; a version bump
 * makes old snapshots refuse loudly instead of corrupting. Portability
 * with the Rust harness is explicitly not a goal — different binary,
 * different layout — and the envelope makes that a clean rejection rather
 * than a surprise.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { QuickJS, type Snapshot } from 'quickjs-wasi';

import type { ReplSnapshot, WasmInput, WasmModule } from './types.js';

/** The envelope format name (the header's `format` field). */
export const SNAPSHOT_FORMAT = 'repl-snapshot';

/**
 * The envelope format version. Bumped when the envelope layout or the
 * snapshot payload format changes incompatibly (a quickjs-wasi upgrade,
 * a guest-library major the host cannot serve): an envelope carrying a
 * different version refuses loudly naming both versions instead of
 * attempting a restore.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

/** The header is one JSON line; refuse anything longer as not-our-file. */
const MAX_HEADER_BYTES = 4096;

/** The envelope header as recorded at rest. */
export interface SnapshotEnvelopeMeta {
  format: typeof SNAPSHOT_FORMAT;
  formatVersion: number;
  /** Hex sha256 of the wasm binary whose layout produced the snapshot. */
  wasmSha256: string;
  createdAtMs: number;
}

/** The parsed envelope: the decompressed snapshot plus its identity meta. */
export interface SnapshotEnvelope {
  snapshot: ReplSnapshot;
  meta: SnapshotEnvelopeMeta;
}

/** The envelope failure vocabulary (see `SnapshotEnvelopeError`). */
export type SnapshotEnvelopeErrorCode =
  | 'BAD_HEADER'
  | 'FORMAT_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'CORRUPT_PAYLOAD'
  | 'WASM_HASH_MISMATCH'
  | 'RESTORE_CORRUPT';

/**
 * A loud envelope failure. `WASM_HASH_MISMATCH` is raised by the restore
 * path (the store's `loadSnapshot`), which compares the recorded hash
 * against the running binary; `RESTORE_CORRUPT` is raised by
 * `Workspace.restore` when a payload that PASSED every decode check
 * cannot be materialized (or initialized) — the corruption class that no
 * at-rest check can see (a structurally valid envelope whose VM header
 * or memory content is garbage, phase-D review rejection); the other
 * codes are raised by `deserializeSnapshot` itself. Every message names
 * the offending file path (when one was given) and the recorded vs
 * expected values, so a restore that refuses can never be mistaken for a
 * silent pass.
 */
export class SnapshotEnvelopeError extends Error {
  readonly code: SnapshotEnvelopeErrorCode;
  /** The snapshot file path, when the failure happened at a path. */
  readonly path: string | undefined;
  /** The value recorded in the envelope (version, hash, format…). */
  readonly recorded: string | undefined;
  /** The value the host expected. */
  readonly expected: string | undefined;

  constructor(
    code: SnapshotEnvelopeErrorCode,
    message: string,
    details: { path?: string; recorded?: string; expected?: string } = {},
  ) {
    super(message);
    this.name = 'SnapshotEnvelopeError';
    this.code = code;
    this.path = details.path;
    this.recorded = details.recorded;
    this.expected = details.expected;
  }
}

/**
 * A restore-time corruption refusal (`code: 'RESTORE_CORRUPT'`, part of
 * the `SnapshotEnvelopeError` family so one containment catch covers the
 * whole load path — decode AND materialization): the envelope's own
 * checks passed (format, version, wasm hash, gzip, the shim's binary
 * parse, the shape/bounds check), yet restoring the VM from the payload
 * failed — `RuntimeError: memory access out of bounds` on a corrupted
 * in-range VM header (a context/runtime/stack pointer patched to a
 * wrong-but-in-bounds value), a guest surface that cannot be rehosted, a
 * provenance registry that cannot bootstrap. This is exactly the doc's
 * "restore into garbage" class, caught one step later than the envelope
 * can see it: the refusal must be CONTAINED (recorded as a stable
 * refusal by the daemon, never crash-looped, never retried into
 * garbage). `Workspace.restore` raises it after disposing any partially
 * created VM; the original failure's message travels inside the refusal
 * so the tool result names the problem.
 */
export class SnapshotRestoreError extends SnapshotEnvelopeError {
  constructor(message: string, details: { cause?: unknown } = {}) {
    super('RESTORE_CORRUPT', message);
    this.name = 'SnapshotRestoreError';
    if (details.cause !== undefined) {
      // ES2022 `Error` cause (target-compatible; the declaration stays
      // self-contained — no explicit `cause` field is declared, the
      // option is the standard constructor one).
      (this as Error & { cause?: unknown }).cause = details.cause;
    }
  }
}

/**
 * Serialize a raw VM snapshot into the at-rest identity envelope: the
 * shim's versioned binary serialization, gzip-compressed, with a JSON
 * header line carrying the format name, the envelope format version, the
 * wasm-binary sha256 and the creation time. The envelope is what the
 * per-project store persists (`ReplWorkspaceStore.writeSnapshot`); the
 * `wasmSha256` is the binary's identity the restore path compares
 * against (`wasmSha256Of`).
 *
 * Synchronous (gzip of a ~1.5 MB memory image is a few ms), so a state-
 * changing boundary can persist before the caller's promise resolves.
 */
export function serializeSnapshot(
  snapshot: ReplSnapshot,
  wasmSha256: string,
  options: { createdAtMs?: number } = {},
): Uint8Array {
  // The hash is the envelope's identity: a malformed value would corrupt
  // the restore comparison — refuse at write time.
  if (typeof wasmSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(wasmSha256)) {
    throw new Error(`serializeSnapshot: wasmSha256 must be a 64-char lowercase hex string (got ${JSON.stringify(wasmSha256)})`);
  }
  const serialized = QuickJS.serializeSnapshot(snapshot as unknown as Snapshot);
  const gz = gzipSync(serialized);
  const header: SnapshotEnvelopeMeta = {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    wasmSha256,
    createdAtMs: options.createdAtMs ?? Date.now(),
  };
  const head = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');
  const envelope = new Uint8Array(head.length + gz.length);
  envelope.set(head, 0);
  envelope.set(gz, head.length);
  return envelope;
}

/**
 * Deserialize an at-rest envelope: split the header line, validate the
 * format name and the format version (REFUSING LOUDLY — naming both
 * versions — when a bump invalidated the file), verify the recorded
 * wasm-binary hash against the binary the host is about to restore with
 * (REFUSING LOUDLY — naming both hashes — BEFORE any payload
 * interpretation, so an incompatible old payload can never masquerade
 * as a corrupt file), then gunzip the payload and run the shim's binary
 * deserializer. Every failure is a `SnapshotEnvelopeError` with a
 * specific code; a corrupted or truncated file is a loud single-shot
 * error, never a silent pass and never a retry loop.
 *
 * The identity check is an option (`expectedWasmSha256`) rather than a
 * separate post-hoc step so it runs between the header parse and the
 * payload decode: a snapshot recorded by another binary — whose raw
 * memory layout is garbage to this binary — must refuse as
 * `WASM_HASH_MISMATCH` naming both hashes, never as `CORRUPT_PAYLOAD`
 * (phase-D review regression: the payload used to be gunzipped and
 * passed through `QuickJS.deserializeSnapshot()` before the running
 * hash was compared, so an incompatible old payload failed as
 * CORRUPT_PAYLOAD without naming the hashes).
 */
export function deserializeSnapshot(
  bytes: Uint8Array,
  options: { path?: string; expectedWasmSha256?: string } = {},
): SnapshotEnvelope {
  const path = options.path;
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) {
    throw new SnapshotEnvelopeError(
      'BAD_HEADER',
      `${label(path)}no envelope header line — expected a newline-terminated JSON header followed by the gzip payload`,
      { path },
    );
  }
  if (nl > MAX_HEADER_BYTES) {
    throw new SnapshotEnvelopeError('BAD_HEADER', `${label(path)}envelope header exceeds ${MAX_HEADER_BYTES} bytes`, {
      path,
    });
  }
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(bytes.subarray(0, nl)).toString('utf8'));
  } catch (error) {
    throw new SnapshotEnvelopeError('BAD_HEADER', `${label(path)}unparseable envelope header (${(error as Error).message})`, {
      path,
    });
  }
  const meta = validateHeader(header, path);
  if (options.expectedWasmSha256 !== undefined) {
    // The recorded hash versus the running binary, BEFORE the payload is
    // touched: a mismatched restore refuses naming both hashes even when
    // the old binary's payload would not even parse here (review
    // regression: the comparison used to happen after deserialization).
    if (meta.wasmSha256 !== options.expectedWasmSha256) {
      throw new SnapshotEnvelopeError(
        'WASM_HASH_MISMATCH',
        `${label(path)}snapshot was laid out by wasm binary sha256 ${meta.wasmSha256}, but the running ` +
          `binary hashes to ${options.expectedWasmSha256} — refusing to restore into garbage (a quickjs-wasi ` +
          `upgrade invalidated this snapshot; recreate the workspace)`,
        { path, recorded: meta.wasmSha256, expected: options.expectedWasmSha256 },
      );
    }
  }
  const payload = bytes.subarray(nl + 1);
  let raw: Uint8Array;
  try {
    raw = gunzipSync(payload);
  } catch (error) {
    throw new SnapshotEnvelopeError(
      'CORRUPT_PAYLOAD',
      `${label(path)}gzip payload corrupt or truncated (${(error as Error).message}) — the snapshot cannot be restored`,
      { path },
    );
  }
  let snapshot: unknown;
  try {
    snapshot = QuickJS.deserializeSnapshot(raw);
  } catch (error) {
    throw new SnapshotEnvelopeError(
      'CORRUPT_PAYLOAD',
      `${label(path)}serialized snapshot corrupt or truncated (${(error as Error).message}) — the snapshot cannot be restored`,
      { path },
    );
  }
  if (!isReplSnapshot(snapshot)) {
    throw new SnapshotEnvelopeError(
      'CORRUPT_PAYLOAD',
      `${label(path)}deserialized snapshot has an unrecognized shape — the snapshot cannot be restored`,
      { path },
    );
  }
  return { snapshot, meta };
}

/**
 * The sha256 (hex) of a wasm binary — the identity the envelope records
 * and the restore path compares. Raw bytes hash directly; a compiled
 * module hashes through the engine's module registry (populated by
 * `loadShippedWasm` — the only producer of `WasmModule` values). A
 * module the engine did not load cannot be hashed (its bytes are not
 * recoverable from the compiled form); pass raw bytes instead.
 */
export function wasmSha256Of(wasm: WasmInput): string {
  if (wasm instanceof ArrayBuffer) {
    return sha256Hex(new Uint8Array(wasm));
  }
  if (ArrayBuffer.isView(wasm)) {
    return sha256Hex(new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength));
  }
  const recorded = moduleHashes.get(wasm);
  if (recorded === undefined) {
    throw new Error(
      'wasmSha256Of: cannot hash a WasmModule that was not produced by loadShippedWasm — pass the raw wasm bytes instead',
    );
  }
  return recorded;
}

/**
 * @internal Record a compiled module's binary hash — called by
 * `loadShippedWasm` when it compiles the shipped binary. Not part of the
 * published API (not re-exported from the index); `wasmSha256Of` reads
 * the registry.
 */
export function noteWasmModuleHash(module: WasmModule, sha256HexHash: string): void {
  moduleHashes.set(module, sha256HexHash);
}

/** Compiled-module → binary-hash registry (see `noteWasmModuleHash`). */
const moduleHashes = new WeakMap<WasmModule, string>();

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Validate the parsed header object; refuse loudly on any mismatch. */
function validateHeader(raw: unknown, path: string | undefined): SnapshotEnvelopeMeta {
  if (typeof raw !== 'object' || raw === null) {
    throw new SnapshotEnvelopeError('BAD_HEADER', `${label(path)}envelope header is not an object`, { path });
  }
  const h = raw as Record<string, unknown>;
  if (h.format !== SNAPSHOT_FORMAT) {
    throw new SnapshotEnvelopeError(
      'FORMAT_MISMATCH',
      `${label(path)}snapshot carries envelope format ${JSON.stringify(h.format)} — this engine only serves ${JSON.stringify(SNAPSHOT_FORMAT)}; refusing to restore`,
      { path, recorded: typeof h.format === 'string' ? h.format : String(h.format) },
    );
  }
  if (h.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new SnapshotEnvelopeError(
      'VERSION_MISMATCH',
      `${label(path)}snapshot carries format version ${String(h.formatVersion)}, but this engine supports version ${SNAPSHOT_FORMAT_VERSION} — a format upgrade invalidated it; refusing to restore into garbage (recreate the workspace)`,
      { path, recorded: String(h.formatVersion), expected: String(SNAPSHOT_FORMAT_VERSION) },
    );
  }
  if (typeof h.wasmSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(h.wasmSha256)) {
    throw new SnapshotEnvelopeError('BAD_HEADER', `${label(path)}envelope header carries an invalid wasmSha256`, {
      path,
    });
  }
  if (typeof h.createdAtMs !== 'number' || !Number.isFinite(h.createdAtMs)) {
    throw new SnapshotEnvelopeError('BAD_HEADER', `${label(path)}envelope header carries an invalid createdAtMs`, {
      path,
    });
  }
  return {
    format: SNAPSHOT_FORMAT,
    formatVersion: h.formatVersion as number,
    wasmSha256: h.wasmSha256,
    createdAtMs: h.createdAtMs,
  };
}

/** The shim's deserialized snapshot must satisfy the engine's shape —
 *  and its pointers must be STRUCTURALLY SANE (phase-D review rejection:
 *  the check used to be type-only, so a valid gzip/QJSS payload with a
 *  corrupted in-range-format VM header — `contextPtr` patched to
 *  `0xfffffff0`, say — deserialized cleanly and then crashed the restore
 *  with `RuntimeError: memory access out of bounds`, an uncoded failure
 *  the daemon could not contain). A quickjs runtime/context pointer is a
 *  malloc'd offset into the snapshot's own linear memory: never 0, never
 *  negative, never at/above the memory end — a pointer outside (0,
 *  memory.length) cannot be a legitimate restored VM. The stack pointer
 *  is the wasm stack's top, likewise strictly inside the memory. These
 *  bounds cannot prove a payload GOOD (in-memory corruption stays
 *  invisible to any at-rest check — the restore-time containment in
 *  `Workspace.restore` catches that class), but they make the cheap,
 *  obvious header-corruption class a clean `CORRUPT_PAYLOAD` refusal at
 *  decode, before any VM exists. */
function isReplSnapshot(value: unknown): value is ReplSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as ReplSnapshot;
  return (
    v.memory instanceof Uint8Array &&
    typeof v.stackPointer === 'number' &&
    typeof v.runtimePtr === 'number' &&
    typeof v.contextPtr === 'number' &&
    Array.isArray(v.extensions) &&
    sanePointer(v.stackPointer, v.memory.byteLength) &&
    sanePointer(v.runtimePtr, v.memory.byteLength) &&
    sanePointer(v.contextPtr, v.memory.byteLength)
  );
}

/** A quickjs-wasi VM pointer: a non-negative integer strictly inside the
 *  snapshot memory (malloc'd offsets are never 0 — see `isReplSnapshot`). */
function sanePointer(ptr: number, memoryLength: number): boolean {
  return Number.isInteger(ptr) && ptr > 0 && ptr < memoryLength;
}

function label(path: string | undefined): string {
  return path === undefined ? '' : `snapshot ${path}: `;
}
