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
 * (flags + arm timestamps), written by the worker with `Atomics.store`
 * and read by the main thread inside the eval's interrupt handler with
 * `Atomics.compareExchange` (consume-on-observation).
 *
 * ## The arm-after-start rule (no stale breaks)
 *
 * A bare flag would let an interrupt armed while the workspace was idle
 * break a LATER, unrelated eval — the phase-E review's targeting
 * discipline. The channel records the wall-clock moment each break was
 * armed, and the probe (`consumeBreak(key, sinceMs)`) consumes the flag
 * ONLY when it was armed AFTER the consuming execution began: an eval
 * that was already running when the interrupt arrived is broken; a
 * fresh eval that starts after the interrupt was armed is not (the
 * stale flag is consumed-and-dropped by its first execution — the
 * daemon's own interrupt handling clears it too, see the repl tool).
 * Both sides of the comparison run in the same process (the worker's
 * `Date.now()` and the main thread's are one clock).
 *
 * ## Scoping and lifecycle
 *
 * One channel per daemon, keyed by the workspace's projectDir; slots
 * are assigned on first registration (fire-and-forget message to the
 * worker). `dispose()` closes the HTTP server and terminates the
 * worker. A crashed daemon takes the channel with it — a fresh daemon
 * starts a fresh channel, so no stale flags survive a restart.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** The per-channel slot capacity (concurrent workspace keys; a registry
 *  past this is a host configuration error, refused at registration). */
export const EVAL_BREAK_CHANNEL_SLOTS = 64;

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
   *  key→slot mapping for its HTTP endpoint). */
  register(key: string): void;
  /** The interrupt-handler probe: consume the break flag when it was
   *  armed after `sinceMs` (the consuming execution's start). Returns
   *  whether THIS execution must break. Consumes the flag either way —
   *  a stale flag (armed before the execution began) is dropped so it
   *  can never break a later execution. */
  consumeBreak(key: string, sinceMs: number): boolean;
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

/** The channel implementation (see the module docs). */
export class EvalBreakChannelImpl implements EvalBreakChannel {
  private readonly sab: SharedArrayBuffer;
  private readonly flags: Int32Array;
  private readonly times: Float64Array;
  private readonly slots = new Map<string, number>();
  private readonly worker: Worker;
  private readonly ready: Promise<number>;
  private disposed = false;

  constructor() {
    // Layout: 64 Int32 flag slots, then 64 Float64 arm timestamps (the
    // 256-byte offset keeps the doubles 8-aligned).
    this.sab = new SharedArrayBuffer(EVAL_BREAK_CHANNEL_SLOTS * 4 + EVAL_BREAK_CHANNEL_SLOTS * 8);
    this.flags = new Int32Array(this.sab, 0, EVAL_BREAK_CHANNEL_SLOTS);
    this.times = new Float64Array(this.sab, EVAL_BREAK_CHANNEL_SLOTS * 4, EVAL_BREAK_CHANNEL_SLOTS);
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
    if (this.slots.size >= EVAL_BREAK_CHANNEL_SLOTS) {
      throw new Error(
        `eval-break channel slot capacity (${EVAL_BREAK_CHANNEL_SLOTS}) exhausted — too many repl workspaces`,
      );
    }
    const slot = this.slots.size;
    this.slots.set(key, slot);
    this.worker.postMessage({ type: "register", key, slot });
  }

  consumeBreak(key: string, sinceMs: number): boolean {
    if (this.disposed) return false;
    const slot = this.slots.get(key);
    if (slot === undefined) return false;
    // Consume the flag first (a stale flag must not survive into a
    // later execution), then decide by the arm moment.
    if (Atomics.compareExchange(this.flags, slot, 1, 0) !== 1) return false;
    // The worker writes the timestamp BEFORE the flag (release order),
    // so a consumed flag always carries its arm moment.
    const armedAt = this.times[slot];
    return armedAt > sinceMs;
  }

  clearBreak(key: string): void {
    if (this.disposed) return;
    const slot = this.slots.get(key);
    if (slot === undefined) return;
    Atomics.store(this.flags, slot, 0);
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
