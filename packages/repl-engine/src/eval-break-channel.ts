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
 * (flags + arm sequence numbers + slot generations), written by the
 * worker with `Atomics.store` and read by the main thread inside the
 * eval's interrupt handler with `Atomics.compareExchange` (consume-on-
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
 * are assigned on registration and RELEASED on `unregister` (the broker
 * disposes a workspace's slot when its broker is torn down; a released
 * slot is reused by the next registration). The shared buffer GROWS on
 * demand (a resizable `SharedArrayBuffer`; the worker's length-tracking
 * view follows the growth automatically), so there is no fixed workspace
 * ceiling. `dispose()` closes the HTTP server and terminates the
 * worker. A crashed daemon takes the channel with it — a fresh daemon
 * starts a fresh channel, so no stale flags survive a restart.
 *
 * ## Acknowledged, generation-safe registration (phase-F review round 4)
 *
 * The carried defect: registration was fire-and-forget while the worker
 * applied it asynchronously, and `unregister` immediately cleared and
 * reused the slot. Two concrete failures followed. (a) A FIRST interrupt
 * could 404: the shim fired `/break` before the worker had applied the
 * key→slot mapping (the main thread's map was updated synchronously at
 * `register`), so the out-of-band break was lost and the eval ran to
 * the per-eval deadline. (b) A STALE interrupt could break a later
 * workspace: the worker could still hold the RELEASED key's mapping when
 * a `/break` for it landed (the `unregister`/re-`register` messages were
 * still in flight), arm the REUSED slot's flag with the old key's
 * sequence — and the NEW key's `consumeBreak` read that flag as its own.
 *
 * The fix has two halves:
 *
 * - REGISTRATION IS ACKNOWLEDGED: `register(key)` returns a promise the
 *   worker resolves (`{ type: "ack", key, slot, gen }`) only after it
 *   applied the mapping. The broker awaits the ack before ANY
 *   guest-executing operation runs (`runSerialized`), so by the time an
 *   interrupt can meaningfully arrive (during a running eval) the relay
 *   can never 404 for this workspace. A dead worker rejects the pending
 *   acks, so an awaiting broker degrades to the per-eval deadline bound
 *   instead of hanging.
 * - SLOT ASSIGNMENTS CARRY GENERATIONS: each registration bumps the
 *   slot's generation, the worker writes the ARMING key's generation
 *   into the shared slot (before the flag, release order), and the
 *   main-thread probe drops any consumed flag whose generation does not
 *   match the consuming key's CURRENT generation. A stale arm for a
 *   released incarnation therefore can never break the workspace that
 *   later reuses the slot, even while the worker still held the old
 *   mapping — the old-generation flag is consumed-and-dropped. The
 *   worker additionally clears the flag when a mapping takes the slot
 *   over, and `unregister` clears the flag AND invalidates the
 *   generation word, so the fence holds in every interleaving.
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
 *  project-count cap: ~2 M slots at 12 bytes each). */
export const EVAL_BREAK_CHANNEL_MAX_BYTES = 4 + 2_097_152 * 12;

/** The worker's readiness message (the bound loopback port). */
interface BreakWorkerReady {
  type: "ready";
  port: number;
}

/** The worker's registration acknowledgement (the mapping is APPLIED —
 *  the relay will no longer 404 for this key). */
interface BreakWorkerAck {
  type: "ack";
  key: string;
  slot: number;
  gen: number;
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
   *  A slot freed by `unregister` is reused under a NEW GENERATION.
   *  RESOLVES when the worker ACKNOWLEDGES the mapping — the broker
   *  gates every guest-executing operation on this ack, so a no-id
   *  interrupt can never 404 against an unapplied mapping (phase-F
   *  review round 4). Rejects when the worker dies before
   *  acknowledging (callers degrade to the per-eval deadline bound —
   *  the relay is best-effort by design). */
  register(key: string): Promise<void>;
  /** Release the workspace's slot (the broker's teardown side): the
   *  worker drops the key's mapping and the slot returns to the free
   *  pool for the next registration. The slot's armed flag is cleared
   *  and its generation word INVALIDATED — an arm still in flight for
   *  the released key writes the old generation, which no consume for
   *  the next key can satisfy. Idempotent; unknown keys are a no-op. */
  unregister(key: string): void;
  /** The execution-start marker: the arm-sequence counter's current
   *  value, read at the moment an execution begins and passed to
   *  `consumeBreak` as `sinceSeq`. The sequence gives a total order
   *  across the worker and the main thread (one shared counter), so an
   *  arm that strictly followed the execution's start ALWAYS breaks it
   *  — down to the same instant, with no clock-resolution window. */
  executionStartMarker(): number;
  /** The interrupt-handler probe: consume the break flag when it was
   *  armed after `sinceSeq` (the consuming execution's start marker)
   *  AND under the consuming key's CURRENT slot generation (a stale arm
   *  for a released incarnation of the slot is dropped — it can never
   *  break the workspace that reused the slot). Returns whether THIS
   *  execution must break. Consumes the flag either way — a stale flag
   *  (armed before the execution began, or under an old generation) is
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
 *  sequence counter; slot i occupies words `1 + 3*i` (the flag), `2 +
 *  3*i` (the arm's sequence) and `3 + 3*i` (the ARMING key's slot
 *  generation). The stride is fixed, so a growth only appends — every
 *  side's view of the old range stays valid, and the length-tracking
 *  views (`new Int32Array(sab)` without a length) follow the growth
 *  automatically. */
const SLOT_STRIDE = 3;
const FLAG_WORD = 1;

function slotFlagWord(slot: number): number {
  return FLAG_WORD + SLOT_STRIDE * slot;
}

function slotSeqWord(slot: number): number {
  return FLAG_WORD + SLOT_STRIDE * slot + 1;
}

function slotGenWord(slot: number): number {
  return FLAG_WORD + SLOT_STRIDE * slot + 2;
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

/** One key's slot assignment (the main thread's authoritative map). */
interface SlotAssignment {
  slot: number;
  /** The assignment's generation: bumped on every (re)registration of
   *  the slot — the fence that makes a stale arm for a released
   *  incarnation unreadable by the slot's next key (see `consumeBreak`
   *  and the module docs). */
  gen: number;
}

/** A registration awaiting the worker's acknowledgement. */
interface PendingAck {
  gen: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** The channel implementation (see the module docs). */
export class EvalBreakChannelImpl implements EvalBreakChannel {
  /** The resizable shared buffer: [armSeq][slot 0 flag+seq+gen][slot 1 …]. */
  private readonly sab: SharedArrayBuffer;
  /** The length-tracking view (follows `grow()` automatically — the
   *  worker's identical view follows it too, being the same buffer). */
  private readonly view: Int32Array;
  private readonly slots = new Map<string, SlotAssignment>();
  private readonly freeSlots: number[] = [];
  /** The per-slot generation counter (the NEXT assignment's generation
   *  minus one — see `register`). */
  private readonly slotGenerations: number[] = [];
  /** Registrations awaiting the worker's acknowledgement, by key. */
  private readonly acks = new Map<string, PendingAck>();
  /** Slots ever allocated (the next fresh slot index). */
  private allocated = 0;
  private readonly worker: Worker;
  private readonly ready: Promise<number>;
  /** The worker's message listener is attached ONLY while it is needed
   *  (boot + pending registration acks): Node re-refs the worker's
   *  port when a `message` listener is attached, so a permanently
   *  attached listener would keep the parent process alive after the
   *  channel's work is done (phase-F review round 4 — the ack listener
   *  used to stay attached forever and every test suite that created a
   *  server hung on exit). See `attachWorkerListener` /
   *  `detachWorkerListenerIfIdle`. */
  private workerListenerAttached = false;
  /** The ready promise's resolve (captured for the shared listener). */
  private readyResolve: ((port: number) => void) | undefined;
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
      this.readyResolve = resolve;
      const onError = (error: Error): void => {
        this.worker.off("message", this.onWorkerMessage);
        this.workerListenerAttached = false;
        reject(error);
        this.rejectPendingAcks(error);
      };
      const onExit = (code: number): void => {
        this.worker.off("message", this.onWorkerMessage);
        this.workerListenerAttached = false;
        if (code !== 0) {
          reject(new Error(`eval-break worker exited with code ${code}`));
        }
        // Either way the worker is gone: no pending registration can
        // ever be acknowledged — awaiting callers degrade to the
        // per-eval deadline bound instead of hanging.
        this.rejectPendingAcks(new Error(`eval-break worker exited with code ${code}`));
      };
      this.worker.once("error", onError);
      this.worker.once("exit", onExit);
    });
    this.attachWorkerListener();
  }

  /** The shared message listener: resolves `ready` (the bound loopback
   *  port) and applies registration acknowledgements. Detached when
   *  neither is pending — see `detachWorkerListenerIfIdle`. */
  private readonly onWorkerMessage = (message: unknown): void => {
    const msg = message as Partial<BreakWorkerReady> & Partial<BreakWorkerAck>;
    if (msg.type === "ready" && typeof msg.port === "number") {
      const resolve = this.readyResolve;
      this.readyResolve = undefined;
      resolve?.(msg.port);
      this.detachWorkerListenerIfIdle();
      return;
    }
    if (msg.type === "ack" && typeof msg.key === "string" && typeof msg.gen === "number") {
      this.onAck(msg.key, msg.gen);
      this.detachWorkerListenerIfIdle();
    }
  };

  /** Attach the worker's message listener (idempotent). Needed while
   *  the worker boots (the ready message) and while any registration
   *  awaits its ack. */
  private attachWorkerListener(): void {
    if (this.workerListenerAttached) return;
    this.workerListenerAttached = true;
    this.worker.on("message", this.onWorkerMessage);
  }

  /** Detach the message listener once it has nothing left to hear
   *  (boot done AND no pending acks): a permanently attached listener
   *  re-refs the worker's port and keeps the parent process alive after
   *  the channel's work is done (phase-F review round 4). */
  private detachWorkerListenerIfIdle(): void {
    if (this.acks.size === 0 && this.readyResolve === undefined) {
      this.worker.off("message", this.onWorkerMessage);
      this.workerListenerAttached = false;
    }
  }

  async breakUrl(): Promise<string> {
    const port = await this.ready;
    return `http://127.0.0.1:${port}/break`;
  }

  register(key: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.slots.get(key);
    if (existing !== undefined) {
      // Idempotent re-registration: the live mapping's ack — already
      // resolved once the worker applied it, or still pending when the
      // first registration has not been acknowledged yet (the caller's
      // readiness gate must cover that first application, not a
      // spuriously-resolved duplicate).
      const pending = this.acks.get(key);
      return pending?.promise ?? Promise.resolve();
    }
    const slot = this.freeSlots.pop() ?? this.allocateFreshSlot();
    // The slot's NEXT generation: an arm written for a previous
    // incarnation of this slot (the worker still held the released
    // key's mapping when the arm landed) carries the old generation,
    // which no consume for this key can satisfy (see `consumeBreak`).
    const gen = (this.slotGenerations[slot] ?? 0) + 1;
    this.slotGenerations[slot] = gen;
    this.slots.set(key, { slot, gen });
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.acks.set(key, { gen, promise, resolve, reject });
    // The ack travels as a worker message: make sure the listener is
    // attached (it may have been detached once boot completed and no
    // acks were pending).
    this.attachWorkerListener();
    try {
      this.worker.postMessage({ type: "register", key, slot, gen });
    } catch (error) {
      // A dead worker: roll the assignment back and reject — the
      // awaiting broker degrades to the per-eval deadline bound (the
      // relay is best-effort by design).
      this.acks.delete(key);
      this.slots.delete(key);
      this.freeSlots.push(slot);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  /** The worker's registration acknowledgement: resolve the pending
   *  ack ONLY when its generation matches — an ack for a released
   *  incarnation (the key was unregistered and possibly re-registered
   *  under a new generation while the ack was in flight) resolves
   *  nothing. */
  private onAck(key: string, gen: number): void {
    const pending = this.acks.get(key);
    if (pending === undefined || pending.gen !== gen) return;
    this.acks.delete(key);
    pending.resolve();
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
    const entry = this.slots.get(key);
    if (entry === undefined) return;
    this.slots.delete(key);
    // Drop any armed flag with the slot (a stale flag must never fire
    // for a later workspace that reuses the slot) and INVALIDATE the
    // generation word: an arm still in flight for the released key —
    // the worker can still hold the released mapping until the
    // unregister message lands — writes the OLD generation, which no
    // consume for the next key can satisfy (the generation fence; see
    // the module docs and `consumeBreak`).
    Atomics.store(this.view, slotFlagWord(entry.slot), 0);
    Atomics.store(this.view, slotGenWord(entry.slot), 0);
    this.freeSlots.push(entry.slot);
    this.worker.postMessage({ type: "unregister", key });
    // A registration still awaiting its ack is released with the
    // mapping (the worker drops it when the unregister lands; a
    // re-registered key starts a fresh ack under its new generation,
    // and the old ack's generation never matches it).
    const pending = this.acks.get(key);
    if (pending !== undefined) {
      this.acks.delete(key);
      pending.resolve();
      this.detachWorkerListenerIfIdle();
    }
  }

  executionStartMarker(): number {
    return Atomics.load(this.view, 0);
  }

  consumeBreak(key: string, sinceSeq: number): boolean {
    if (this.disposed) return false;
    const entry = this.slots.get(key);
    if (entry === undefined) return false;
    // Consume the flag first (a stale flag must not survive into a
    // later execution), then decide by the arm's sequence AND
    // generation.
    if (Atomics.compareExchange(this.view, slotFlagWord(entry.slot), 1, 0) !== 1) return false;
    // The worker writes the arm's sequence AND the arming key's
    // generation BEFORE the flag (release order), so a consumed flag
    // always carries both.
    const armedSeq = Atomics.load(this.view, slotSeqWord(entry.slot));
    const armedGen = Atomics.load(this.view, slotGenWord(entry.slot));
    // The GENERATION fence (phase-F review round 4): an arm written for
    // a PREVIOUS incarnation of this slot — the worker still held the
    // released key's mapping when its `/break` landed — carries the old
    // generation and can never break THIS key's execution. The stale
    // flag is consumed-and-dropped, exactly like an arm-before-start.
    if (armedGen !== entry.gen) return false;
    return armedSeq > sinceSeq;
  }

  clearBreak(key: string): void {
    if (this.disposed) return;
    const entry = this.slots.get(key);
    if (entry === undefined) return;
    Atomics.store(this.view, slotFlagWord(entry.slot), 0);
  }

  /** Reject every pending registration ack (the worker is gone — no
   *  pending registration can ever be applied). */
  private rejectPendingAcks(error: Error): void {
    for (const pending of this.acks.values()) pending.reject(error);
    this.acks.clear();
    this.detachWorkerListenerIfIdle();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPendingAcks(new Error("eval-break channel disposed"));
    try {
      this.worker.postMessage({ type: "dispose" });
    } catch {
      // The worker already died — nothing to signal.
    }
    await this.worker.terminate().catch(() => undefined);
  }
}

/** Create the channel (the daemon's composition root). */
export function createEvalBreakChannel(): EvalBreakChannel {
  return new EvalBreakChannelImpl();
}

// The worker's HTTP contract is implemented in `eval-break-worker.js`
// (the shim's fire side posts `{ key }` to `POST /break`).
