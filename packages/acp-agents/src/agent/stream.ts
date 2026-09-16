// The async iterator behind `AcpAgent.stream()`: a buffer the agent pushes this turn's events into
// (never dropping — bounded only by the turn) and the consumer pulls from with `next()`. The agent
// owns the turn; the iterator owns only the hand-off:
//   - `end()` after the terminal `{ type: "turn" }` was pushed: the buffer drains, then `done`.
//   - `fail(error)` when the turn rejected: the buffer drains, then `next()` rejects with that same
//     error exactly once, then `done`.
//   - `return()` / `throw()` (a `break`, an early exit): the consumer is gone, so `stop` is invoked
//     — the agent aborts the turn's per-call signal, which rejects a not-yet-started turn without
//     going on the wire and sends `session/cancel` (with the agent's escalation) to one in flight —
//     and the call resolves only once the turn settled, so nothing keeps running unobserved.
import type { AcpAgentStream, AcpAgentStreamEvent } from "./types.js";

type Result = IteratorResult<AcpAgentStreamEvent, undefined>;

interface Waiter {
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
}

const DONE: Result = { value: undefined, done: true };

export class TurnStream implements AcpAgentStream {
  readonly #buffer: AcpAgentStreamEvent[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #stop: () => Promise<void>;
  /** Nothing more will be pushed: the turn settled (either way) or the consumer left. */
  #closed = false;
  /** The turn's rejection, thrown to the consumer once the buffer has drained. */
  #failure: { error: unknown; thrown: boolean } | undefined;
  #stopping: Promise<void> | undefined;

  /** `stop` aborts the turn and resolves once it settled; called at most once. */
  constructor(stop: () => Promise<void>) {
    this.#stop = stop;
  }

  /** Buffer an event, or hand it straight to a waiting `next()`. Ignored once closed. */
  push(event: AcpAgentStreamEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.#buffer.push(event);
  }

  /** The turn resolved; the terminal event is already buffered. */
  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#settleWaiters();
  }

  /** The turn rejected: buffered events are still delivered, then `error` is thrown once. */
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = { error, thrown: false };
    this.#settleWaiters();
  }

  next(): Promise<Result> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.#closed) return this.#terminal();
    return new Promise<Result>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /** The consumer left early: abort the turn, wait for it to settle, then report `done`. */
  async return(): Promise<Result> {
    await this.#leave();
    return DONE;
  }

  /** Same as `return()`, then rethrow `error` to the caller (async-generator semantics). */
  async throw(error?: unknown): Promise<Result> {
    await this.#leave();
    throw error;
  }

  [Symbol.asyncIterator](): AcpAgentStream {
    return this;
  }

  #terminal(): Promise<Result> {
    if (this.#failure && !this.#failure.thrown) {
      this.#failure.thrown = true;
      return Promise.reject(this.#failure.error);
    }
    return Promise.resolve(DONE);
  }

  /** Waiters exist only while the buffer is empty, so they get the terminal outcome directly. */
  #settleWaiters(): void {
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#failure && !this.#failure.thrown) {
        this.#failure.thrown = true;
        waiter.reject(this.#failure.error);
      } else {
        waiter.resolve(DONE);
      }
    }
  }

  #leave(): Promise<void> {
    this.#stopping ??= this.#stop();
    // Undelivered events are the consumer's to discard; a pending `next()` sees `done`, never a
    // rejection — an early exit is not an error (generator `return()` semantics).
    this.#closed = true;
    this.#failure = undefined;
    this.#buffer.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(DONE);
    return this.#stopping;
  }
}
