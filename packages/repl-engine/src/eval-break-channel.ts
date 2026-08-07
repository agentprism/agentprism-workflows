/**
 * The out-of-band eval-break channel — the `interrupt` tool's no-id path
 * made deliverable to a SYNCHRONOUSLY RUNNING eval (the REPL orchestrator
 * roadmap: "break a runaway eval (the quickjs interrupt handler)").
 *
 * ## Why a channel at all
 *
 * The broker runs the QuickJS VM on the daemon's single thread. A
 * fully synchronous (never-yielding) eval — `while (true) {}` — blocks
 * that thread, so the interrupt tool call itself cannot be PROCESSED by
 * the daemon (its HTTP request sits in the kernel backlog until the eval
 * ends or the per-eval wall-clock deadline breaks it). The quickjs
 * interrupt handler is the only thing that runs DURING the eval — it is
 * invoked periodically by the VM, synchronously, inside the execution.
 * The interrupt therefore needs a side channel that stays writable while
 * the main thread is blocked: a WORKER THREAD.
 *
 * ## The mechanism
 *
 * The channel owns one worker thread per daemon. The worker hosts a tiny
 * loopback HTTP endpoint (`POST /break` with the workspace key). The
 * worker's event loop never blocks (it is a separate thread), so the
 * MCP server's shim can reach it while the daemon's main thread is
 * wedged in the eval. The break flag lives in a `SharedArrayBuffer`
 * (flags + arm sequence numbers), written by the worker with
 * `Atomics.store` and read by the main thread inside the eval's
 * interrupt handler with `Atomics.compareExchange` (consume-on-
 * observation).
 *
 * ## The arm-after-start rule (no stale breaks, no lost breaks)
 *
 * A bare flag would let an interrupt armed while the workspace was idle
 * break a LATER, unrelated eval — the phase-E review's targeting
 * discipline. The channel therefore orders every arm against every
 * execution start on a SHARED MONOTONIC ARM-SEQUENCE COUNTER (one
 * `Atomics.add` per arm, the first word of the buffer), giving a TOTAL
 * order across the worker and the main thread — no clock comparison at
 * all (phase-F review round 3: the old scheme compared millisecond
 * `Date.now()` stamps and required `armedAt > executionStartMs`, so a
 * break arriving in the SAME millisecond as the execution start was
 * consumed as stale and permanently lost; a sequence number has no
 * resolution window — an arm strictly after an execution's start marker
 * ALWAYS carries a greater sequence, an arm before it ALWAYS carries a
 * lesser one). The probe (`consumeBreak(key, sinceSeq)`) consumes the
 * flag ONLY when its arm sequence exceeds the sequence observed at the
 * consuming execution's start: an eval that was already running when
 * the interrupt arrived is broken; a fresh eval that starts after the
 * interrupt was armed is not (the stale flag is consumed-and-dropped by
 * its first execution — the daemon's own interrupt handling clears it
 * too, see the repl tool).
 *
 * ## Scoping and lifecycle (no project-count ceiling)
 *
 * One channel per daemon, keyed by the workspace's projectDir; slots
 * are assigned on first registration (fire-and-forget message to the
 * worker) and RELEASED on `unregister` (the broker disposes a
 * workspace's slot when its broker is torn down; a released slot is
 * reused by the next registration). The shared buffer GROWS on demand
 * (a resizable `SharedArrayBuffer`; the worker's length-tracking view
 * follows the growth automatically), so there is no fixed workspace
 * ceiling (phase-F review round 3: the old fixed 64-slot array threw
 * on the 65th registered project and never released slots — the
 * roadmap defines per-project workspaces with no project-count cap).
 * `dispose()` closes the HTTP server and terminates the worker. A
 * crashed daemon takes the channel with it — a fresh daemon starts a
 * fresh channel, so no stale flags survive a restart.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** The channel's initial slot capacity (workspace keys); the shared
 *  buffer grows by doubling when it is exhausted, so this is a starting
 *  size, never a ceiling. */
export const EVAL_BREAK_CHANNEL_INITIAL_SLOTS = 16;

/** The shared buffer's absolute ceiling in bytes (the growth bound —
 *  a memory bound for the resizable `SharedArrayBuffer`, not a
 *  project-count cap: ~2 M slots at 8 bytes each). */
export const EVAL_BREAK_CHANNEL_MAX_BYTES = 4 + 2_097_152 * 8;

/** The worker's readiness message (the bound loopback port). */
interface BreakWorkerReady {
  type: "ready";
  port: number;
}

/** The channel's published surface (the broker's probe + the daemon's
 *  wiring). */
export interface EvalBreakChannel {
  /** The worker's loopback break endpoint (`POST /break` with a JSON
   *  `{ key }` body) — the address the MCP shim fires while the daemon's
   *  main thread is blocked in a synchronous eval. Resolves once the
   *  worker is listening. */
  breakUrl(): Promise<string>;
  /** Assign the workspace's slot (idempotent; the worker learns the
   *  key→slot mapping for its HTTP endpoint). Grows the shared buffer
   *  when the current capacity is exhausted — no project-count ceiling.
   *  A slot freed by `unregister` is reused. */
  register(key: string): void;
  /** Release the workspace's slot (the broker's teardown side): the
   *  worker drops the key's mapping and the slot returns to the free
   *  pool for the next registration. Idempotent; unknown keys are a
   *  no-op. */
  unregister(key: string): void;
  /** The execution-start marker: the arm-sequence counter's current
   *  value, read at the moment an execution begins and passed to
   *  `consumeBreak` as `sinceSeq`. The sequence gives a total order
   *  across the worker and the main thread (one shared counter), so an
   *  arm that strictly followed the execution's start ALWAYS breaks it
   *  — down to the same instant, with no clock-resolution window. */
  executionStartMarker(): number;
  /** The interrupt-handler probe: consume the break flag when it was
   *  armed after `sinceSeq` (the consuming execution's start marker).
   *  Returns whether THIS execution must break. Consumes the flag
   *  either way — a stale flag (armed before the execution began) is
   *  dropped so it can never break a later execution. */
  consumeBreak(key: string, sinceSeq: number): boolean;
  /** Clear the workspace's flag (the daemon's own interrupt handling —
   *  once the request is processed, the continuation-targeted signal
   *  owns the break). */
  clearBreak(key: string): void;
  dispose(): Promise<void>;
}

/** The worker entry: the compiled `eval-break-worker.js` in dist, or
 *  the TypeScript source when running from src (tsx dev/tests — the
 *  worker inherits the parent's loader, so the .ts runs directly). */
function workerEntryUrl(): URL {
  const tsEntry = new URL("./eval-break-worker.ts", import.meta.url);
  if (existsSync(fileURLToPath(tsEntry))) return tsEntry;
  return new URL("./eval-break-worker.js", import.meta.url);
}

/** The shared-buffer layout (all Int32 words): word 0 is the arm
 *  sequence counter; slot i occupies words `1 + 2*i` (the flag) and
 *  `2 + 2*i` (the arm's sequence). The stride is fixed, so a growth
 *  only appends — every side's view of the old range stays valid, and
 *  the length-tracking views (`new Int32Array(sab)` without a length)
 *  follow the growth automatically. */
const SLOT_STRIDE = 2;
const FLAG_WORD = 1;

function slotFlagWord(slot: number): number {
  return FLAG_WORD + SLOT_STRIDE * slot;
}

function slotSeqWord(slot: number): number {
  return FLAG_WORD + SLOT_STRIDE * slot + 1;
}

/** The resizable-`SharedArrayBuffer` surface (the ES2024 `SharedArrayBuffer`;
 *  the repo's `lib` target is ES2022, so the growth surface is declared
 *  locally — Node ≥ 22 implements it at runtime, and the package's
 *  consumer fixtures pin the shipped behavior). */
type ResizableSharedArrayBuffer = SharedArrayBuffer & {
  readonly growable: boolean;
  readonly maxByteLength: number;
  grow(newByteLength: number): void;
};

/** The ES2024 constructor surface (the `{ maxByteLength }` option). */
interface ResizableSharedArrayBufferCtor {
  new (byteLength: number, options: { maxByteLength: number }): ResizableSharedArrayBuffer;
}

/** The channel implementation (see the module docs). */
export class EvalBreakChannelImpl implements EvalBreakChannel {
  /** The resizable shared buffer: [armSeq][slot 0 flag+seq][slot 1 …]. */
  private readonly sab: SharedArrayBuffer;
  /** The length-tracking view (follows `grow()` automatically — the
   *  worker's identical view follows it too, being the same buffer). */
  private readonly view: Int32Array;
  private readonly slots = new Map<string, number>();
  private readonly freeSlots: number[] = [];
  /** Slots ever allocated (the next fresh slot index). */
  private allocated = 0;
  private readonly worker: Worker;
  private readonly ready: Promise<number>;
  private disposed = false;

  constructor() {
    this.sab = new (SharedArrayBuffer as unknown as ResizableSharedArrayBufferCtor)(
      (FLAG_WORD + SLOT_STRIDE * EVAL_BREAK_CHANNEL_INITIAL_SLOTS) * 4,
      { maxByteLength: EVAL_BREAK_CHANNEL_MAX_BYTES },
    );
    this.view = new Int32Array(this.sab);
    this.worker = new Worker(workerEntryUrl(), {
      workerData: { sab: this.sab },
    });
    this.worker.unref();
    this.ready = new Promise<number>((resolve, reject) => {
      const onMessage = (message: unknown) => {
        if ((message as BreakWorkerReady | undefined)?.type === "ready") {
          this.worker.off("message", onMessage);
          resolve((message as BreakWorkerReady).port);
        }
      };
      this.worker.on("message", onMessage);
      this.worker.once("error", (error) => reject(error));
      this.worker.once("exit", (code) => {
        this.worker.off("message", onMessage);
        if (code !== 0) reject(new Error(`eval-break worker exited with code ${code}`));
      });
    });
  }

  async breakUrl(): Promise<string> {
    const port = await this.ready;
    return `http://127.0.0.1:${port}/break`;
  }

  register(key: string): void {
    if (this.disposed) return;
    if (this.slots.has(key)) return;
    const slot = this.freeSlots.pop() ?? this.allocateFreshSlot();
    this.slots.set(key, slot);
    this.worker.postMessage({ type: "register", key, slot });
  }

  private allocateFreshSlot(): number {
    if (this.allocated >= this.slotsPerCapacity()) {
      // No fixed ceiling: grow the shared buffer (doubling). The
      // worker's length-tracking view follows the growth automatically,
      // and existing slots' layout is unchanged (the stride is fixed,
      // growth only appends), so no re-view handshake is needed.
      const capacity = this.slotsPerCapacity();
      const next = Math.min(capacity * 2, Math.floor((EVAL_BREAK_CHANNEL_MAX_BYTES / 4 - FLAG_WORD) / SLOT_STRIDE));
      if (next <= capacity) {
        throw new Error(
          `eval-break channel shared-buffer ceiling (${EVAL_BREAK_CHANNEL_MAX_BYTES} bytes) exhausted — ` +
            `too many repl workspaces in one daemon`,
        );
      }
      (this.sab as ResizableSharedArrayBuffer).grow((FLAG_WORD + SLOT_STRIDE * next) * 4);
    }
    const slot = this.allocated;
    this.allocated++;
    return slot;
  }

  /** The current capacity in slots (the view is length-tracking, so it
   *  reflects the latest growth). */
  private slotsPerCapacity(): number {
    return Math.floor((this.view.length - FLAG_WORD) / SLOT_STRIDE);
  }

  unregister(key: string): void {
    if (this.disposed) return;
    const slot = this.slots.get(key);
    if (slot === undefined) return;
    this.slots.delete(key);
    // Drop any armed flag with the slot (a stale flag must never fire
    // for a later workspace that reuses the slot).
    Atomics.store(this.view, slotFlagWord(slot), 0);
    this.freeSlots.push(slot);
    this.worker.postMessage({ type: "unregister", key });
  }

  executionStartMarker(): number {
    return Atomics.load(this.view, 0);
  }

  consumeBreak(key: string, sinceSeq: number): boolean {
    if (this.disposed) return false;
    const slot = this.slots.get(key);
    if (slot === undefined) return false;
    // Consume the flag first (a stale flag must not survive into a
    // later execution), then decide by the arm sequence.
    if (Atomics.compareExchange(this.view, slotFlagWord(slot), 1, 0) !== 1) return false;
    // The worker writes the arm's sequence BEFORE the flag (release
    // order), so a consumed flag always carries its arm sequence.
    const armedSeq = Atomics.load(this.view, slotSeqWord(slot));
    return armedSeq > sinceSeq;
  }

  clearBreak(key: string): void {
    if (this.disposed) return;
    const slot = this.slots.get(key);
    if (slot === undefined) return;
    Atomics.store(this.view, slotFlagWord(slot), 0);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.postMessage({ type: "dispose" });
    await this.worker.terminate().catch(() => undefined);
  }
}

/** Create the channel (the daemon's composition root). */
export function createEvalBreakChannel(): EvalBreakChannel {
  return new EvalBreakChannelImpl();
}

// The worker's HTTP contract is implemented in `eval-break-worker.js`
// (the shim's fire side posts `{ key }` to `POST /break`).
