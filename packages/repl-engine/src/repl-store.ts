/**
 * The daemon's per-project REPL store — the roadmap doc's §Snapshots
 * storage: "Snapshots and the call store live in the daemon's existing
 * per-project store — a `repl/` subdirectory next to the workflow state
 * under `workflowHomeDir()/projects/<key>/`".
 *
 * The layout reuses the workflow store-layout helpers verbatim
 * (`workflowProjectPaths` from `@automatalabs/workflows` — the same
 * helpers the mcp-server project registry uses, so the store key derives
 * from the project directory exactly as the workflow engine's and one
 * project has one repl store):
 *
 * ```text
 * workflowHomeDir()/projects/<key>/
 *   project.json        (the workflow engine's manifest: key → projectDir)
 *   runs/…              (workflow run state — untouched)
 *   repl/
 *     snapshot.bin      the enveloped VM snapshot (see snapshot-envelope.ts)
 *     calls.jsonl       the append-only call store (JsonlCallStore)
 * ```
 *
 * ## Snapshot-write mechanics (spec-owed decisions)
 *
 * - **Cadence**: the broker fires a state-changing boundary after each
 *   eval and after each settlement drain that changed VM state
 *   (`BrokerOptions.snapshotSink`); the daemon wires it to
 *   `snapshotWriter(workspace, wasm)`, the debounced writer this store
 *   provides. `boundary()` marks the workspace dirty;
 *   `flush()` — fired by the broker at the end of each serialized
 *   operation, the burst boundary — writes once per burst. A broker
 *   eval that first pumps settled calls and then drains the eval itself
 *   is therefore ONE atomic write, taken before the eval's promise
 *   resolves (the debounce knob: `SnapshotWriteOptions.debounceBursts`,
 *   default true; false writes synchronously at every boundary). The
 *   debounced gap is always covered by the call store: settlements are
 *   recorded BEFORE they settle, so a restore replays them from the
 *   store arm.
 * - **Atomicity**: every write goes to `<snapshot.bin>.tmp`, fsynced,
 *   then renamed over `snapshot.bin` (a kill at any moment leaves
 *   either the old complete snapshot or the new complete one — never a
 *   torn file), then the directory is fsynced (best-effort) so the
 *   rename itself is durable. The tmp file is fixed-name (single-writer
 *   discipline: one daemon per project, like the call store) and is
 *   removed on failure; a crash leaves it for the next write to
 *   overwrite.
 * - **Failure posture**: a snapshot write that fails throws loudly (the
 *   previous snapshot file is untouched) and a corrupt or truncated
 *   snapshot file refuses loudly on load (`SnapshotEnvelopeError`,
 *   naming the file and the problem) — a single-shot error, never a
 *   silent pass and never a retry loop. A failed write also leaves the
 *   writer's dirty boundary IN PLACE, so the next flush retries the
 *   same state (phase-D review round 6: the boundary used to clear
 *   before the write, silently dropping a failed last-disconnect
 *   snapshot). The store stays usable: a fresh `writeSnapshot` replaces
 *   the bad file, or `reset()` clears the whole `repl/` directory (the
 *   `reset` tool's engine-side).
 * - **Config knobs** (decided names): `ReplStoreOptions.persistenceRoot`
 *   (overrides `workflowHomeDir` — tests and `AGENTPRISM_PERSISTENCE_ROOT`
 *   parity), `ReplStoreOptions.env` (workflow-path env overrides),
 *   `ReplStoreOptions.snapshotWrite.debounceBursts` and
 *   `snapshotWrite.fsync` (defaults: true, true).
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { workflowProjectPaths } from '@automatalabs/workflows';

import type { SnapshotSink } from './broker.js';
import {
  deserializeSnapshot,
  serializeSnapshot,
  SnapshotEnvelopeError,
  wasmSha256Of,
} from './snapshot-envelope.js';
import { JsonlCallStore } from './store.js';
import type { ReplSnapshot, WasmInput } from './types.js';
import type { Workspace } from './workspace.js';

/** The `repl/` subdirectory name next to the workflow state. */
export const REPL_STORE_SUBDIR = 'repl';
/** The enveloped snapshot file name inside the repl directory. */
export const SNAPSHOT_FILENAME = 'snapshot.bin';
/** The call-store log file name inside the repl directory. */
export const CALL_STORE_FILENAME = 'calls.jsonl';
/** The tmp file the atomic write stages into (fixed name — one daemon
 *  per project, the same single-writer discipline as the call store). */
const TMP_SUFFIX = '.tmp';

/** The snapshot-write policy knobs (names decided here; see module docs). */
export interface SnapshotWriteOptions {
  /**
   * Coalesce the state-changing boundaries of one drain burst (a broker
   * eval's pump-drain + eval-drain) into a single atomic write at the
   * burst boundary. Default true — the doc's "debounce within a single
   * drain burst". When false, every boundary writes synchronously.
   */
  debounceBursts?: boolean;
  /**
   * fsync the snapshot file (and, best-effort, its directory) before a
   * write is acknowledged. Default true — a kill at any moment loses
   * nothing that was acknowledged.
   */
  fsync?: boolean;
}

/** Options for opening a project's repl store. */
export interface ReplStoreOptions {
  /**
   * Override for the workflow home root the store lives under (see
   * `workflowHomeDir`; tests use it; the environment's
   * `AGENTPRISM_PERSISTENCE_ROOT` wins when this is omitted).
   */
  persistenceRoot?: string;
  /** Injectable env map for the workflow-path helpers (tests). */
  env?: Record<string, string | undefined>;
  /** The snapshot-write policy knobs. */
  snapshotWrite?: SnapshotWriteOptions;
}

/** A snapshot restored from the store, with its identity meta. */
export interface RestoredReplSnapshot {
  /** The raw VM snapshot, ready for `Workspace.restore`. */
  snapshot: ReplSnapshot;
  /** The wasm binary sha256 the envelope recorded. */
  wasmSha256: string;
  /** The envelope format version (validated against the engine's). */
  formatVersion: number;
  /** When the envelope was written. */
  createdAtMs: number;
}

/** Store-level counters (the status seam + the debounce tests). */
export interface ReplStoreStats {
  /** Successful atomic snapshot writes since open (or since reset). */
  snapshotWrites: number;
}

/**
 * One project's REPL store: the enveloped snapshot plus the call store,
 * under `workflowHomeDir()/projects/<key>/repl`. All operations are
 * synchronous — a state-changing boundary persists before the caller's
 * promise resolves (the broker's sink contract).
 */
export class ReplWorkspaceStore {
  /** The project directory this store belongs to. */
  readonly projectDir: string;
  /** The `repl/` directory holding this store's files. */
  readonly replDir: string;
  /** The enveloped snapshot file (`<replDir>/snapshot.bin`). */
  readonly snapshotPath: string;
  /** The call-store log file (`<replDir>/calls.jsonl`). */
  readonly callStorePath: string;

  private readonly options: { debounceBursts: boolean; fsync: boolean };
  private callStoreInstance: JsonlCallStore | null = null;
  private snapshotWriteCount = 0;

  private constructor(projectDir: string, replDir: string, options: { debounceBursts: boolean; fsync: boolean }) {
    this.projectDir = projectDir;
    this.replDir = replDir;
    this.snapshotPath = join(replDir, SNAPSHOT_FILENAME);
    this.callStorePath = join(replDir, CALL_STORE_FILENAME);
    this.options = options;
  }

  /**
   * Open (and create, on first touch) the project's repl store. The
   * daemon passes the VALIDATED project directory (its project registry
   * realpaths it, exactly like the workflow tool's `projectDir`).
   */
  static open(projectDir: string, options: ReplStoreOptions = {}): ReplWorkspaceStore {
    const paths = workflowProjectPaths(projectDir, {
      persistenceRoot: options.persistenceRoot,
      env: options.env,
    });
    const replDir = join(paths.rootDir, REPL_STORE_SUBDIR);
    mkdirSync(replDir, { recursive: true });
    return new ReplWorkspaceStore(projectDir, replDir, {
      debounceBursts: options.snapshotWrite?.debounceBursts ?? true,
      fsync: options.snapshotWrite?.fsync ?? true,
    });
  }

  /** True when an enveloped snapshot exists at the store path. */
  hasSnapshot(): boolean {
    return existsSync(this.snapshotPath);
  }

  /**
   * Write a snapshot of the workspace's VM to disk: serialize into the
   * identity envelope (wasm sha256 + format version + gzip) and replace
   * the snapshot file atomically (tmp + rename + fsync). The wasm
   * binary's hash is computed here, so the envelope always records the
   * binary that actually laid out the memory.
   */
  writeSnapshot(snapshot: ReplSnapshot, wasm: WasmInput): void {
    const envelope = serializeSnapshot(snapshot, wasmSha256Of(wasm));
    this.writeAtomic(envelope);
    this.snapshotWriteCount++;
  }

  /**
   * Load the enveloped snapshot and verify its identity against the
   * binary the host is about to restore with. A wasm-hash mismatch
   * REFUSES LOUDLY naming both hashes (never a restore into garbage —
   * the doc's transfer lesson 5; the check runs INSIDE the envelope
   * deserializer, between the header parse and the payload decode, so a
   * snapshot recorded by another binary refuses as WASM_HASH_MISMATCH
   * even when its payload would not deserialize here — a phase-D review
   * regression: the comparison used to happen after the payload was
   * interpreted, so an incompatible old payload failed as
   * CORRUPT_PAYLOAD without naming the hashes); a version bump or a
   * corrupt/truncated file refuses with `SnapshotEnvelopeError` naming
   * the file and the problem. Single-shot: the error propagates to the
   * caller, and the store stays usable (a fresh `writeSnapshot` or
   * `reset()`).
   */
  loadSnapshot(wasm: WasmInput): RestoredReplSnapshot {
    if (!existsSync(this.snapshotPath)) {
      throw new SnapshotEnvelopeError(
        'BAD_HEADER',
        `no snapshot at ${this.snapshotPath} — the workspace was never snapshotted`,
        { path: this.snapshotPath },
      );
    }
    const envelope = deserializeSnapshot(readFileSync(this.snapshotPath), {
      path: this.snapshotPath,
      expectedWasmSha256: wasmSha256Of(wasm),
    });
    return {
      snapshot: envelope.snapshot,
      wasmSha256: envelope.meta.wasmSha256,
      formatVersion: envelope.meta.formatVersion,
      createdAtMs: envelope.meta.createdAtMs,
    };
  }

  /**
   * The project's append-only call store (`calls.jsonl` — a durable
   * `JsonlCallStore`, opened lazily on first use and closed by `close`/
   * `reset`). One store per project: forks of one snapshot mint
   * overlapping call ids, so each project keeps its own ledger. The
   * `repl/` directory is recreated when missing (after a `reset()` a
   * fresh use self-heals, like the snapshot writer does).
   */
  callStore(): JsonlCallStore {
    mkdirSync(this.replDir, { recursive: true });
    this.callStoreInstance ??= JsonlCallStore.open(this.callStorePath);
    return this.callStoreInstance;
  }

  /**
   * The debounced snapshot writer the daemon wires to the broker's
   * state-changing-boundary sink (`BrokerOptions.snapshotSink`): every
   * `boundary()` marks the workspace dirty; `flush()` — the broker's
   * end-of-operation burst boundary — writes once per burst (when
   * `debounceBursts` is false, every boundary writes synchronously
   * instead). The write snapshots the LIVE workspace through the same
   * `writeSnapshot` atomic path.
   */
  snapshotWriter(workspace: Workspace, wasm: WasmInput): SnapshotSink {
    const debounce = this.options.debounceBursts;
    let dirty = false;
    return {
      boundary: () => {
        if (!debounce) {
          this.writeSnapshot(workspace.snapshot(), wasm);
          return;
        }
        dirty = true;
      },
      flush: () => {
        if (!dirty) return;
        // The write happens BEFORE the boundary clears (phase-D review
        // round 6): a failing write leaves the boundary dirty, so the
        // next flush — the next drain burst, or the next disconnect's
        // retried drain — retries the SAME state instead of silently
        // dropping it (the old order cleared `dirty` first, so a failed
        // last-disconnect snapshot was lost without a trace). The write's
        // throw propagates to the broker's operation — the failure is
        // loud at the surface that triggered the boundary.
        this.writeSnapshot(workspace.snapshot(), wasm);
        dirty = false;
      },
    };
  }

  /**
   * Teardown the store: close the call store and delete the whole
   * `repl/` directory (the `reset` tool's engine-side — the workspace's
   * VM and stored state are dropped together).
   */
  reset(): void {
    this.close();
    rmSync(this.replDir, { recursive: true, force: true });
    this.snapshotWriteCount = 0;
  }

  /** Close the call store's log file (idempotent; the store stays
   *  readable through a later `callStore()`). */
  close(): void {
    this.callStoreInstance?.close();
    this.callStoreInstance = null;
  }

  /** Store-level counters. */
  stats(): ReplStoreStats {
    return { snapshotWrites: this.snapshotWriteCount };
  }

  /** The atomic replace: stage into `<snapshot>.tmp`, fsync, rename,
   *  best-effort directory fsync. The store directory is recreated when
   *  missing (after a `reset()`, a fresh write self-heals). Any failure
   *  removes the tmp file and throws — the previous snapshot file is
   *  untouched. */
  private writeAtomic(bytes: Uint8Array): void {
    const tmp = `${this.snapshotPath}${TMP_SUFFIX}`;
    let fd: number | undefined;
    try {
      mkdirSync(this.replDir, { recursive: true });
      fd = openSync(tmp, 'w');
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      if (this.options.fsync) fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.snapshotPath);
      if (this.options.fsync) this.fsyncDir();
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Best effort — the tmp file is removed below regardless.
        }
      }
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best effort — the next write's open truncates a stale tmp.
      }
      throw error;
    }
  }

  /** Directory fsync so the rename itself is durable; best-effort
   *  (some platforms do not support opening directories for sync). */
  private fsyncDir(): void {
    let dirFd: number | undefined;
    try {
      dirFd = openSync(this.replDir, 'r');
      fsyncSync(dirFd);
    } catch {
      // Best effort — the file fsync is the load-bearing one.
    } finally {
      if (dirFd !== undefined) {
        try {
          closeSync(dirFd);
        } catch {
          // Best effort.
        }
      }
    }
  }
}
