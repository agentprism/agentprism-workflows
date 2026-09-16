// The per-agent FIFO. `prompt`, `fork`, `setMode`, `setConfigOptions`, `close` and the implicit
// open all run through one SerialQueue so no two of them ever overlap (a second concurrent
// `SessionHandle.prompt` would clobber the handle's active turn; pi rejects a fork while the
// source has a turn in flight; Claude would copy a partial transcript). Pure: no ACP imports.

interface Entry {
  readonly op: () => Promise<unknown>;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  removeAbort?: () => void;
}

export class SerialQueue {
  readonly #entries: Entry[] = [];
  #running = false;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle: (() => void) | undefined;

  /** Queued + running. */
  get depth(): number {
    return this.#entries.length + (this.#running ? 1 : 0);
  }

  /** Whether an op is executing right now. */
  get running(): boolean {
    return this.#running;
  }

  /** Resolves once the currently running op (if any) has settled and nothing else is queued. */
  whenIdle(): Promise<void> {
    return this.#idle;
  }

  /**
   * Append `op`; it starts strictly after every earlier entry settled. A `signal` that is already
   * aborted rejects with `signal.reason` without calling `op`; an abort while the entry is still
   * queued removes it and rejects it (the listener is dropped the moment the entry starts — an
   * in-flight abort is the op's own concern).
   */
  run<T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const entry: Entry = {
        op,
        signal,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (signal) {
        const onAbort = (): void => {
          const index = this.#entries.indexOf(entry);
          if (index >= 0) this.#entries.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.#entries.push(entry);
      void this.#pump();
    });
  }

  /** Reject every NOT-YET-STARTED entry with `reason`; the running op is untouched. */
  drain(reason: unknown): void {
    for (const entry of this.#entries.splice(0)) {
      entry.removeAbort?.();
      entry.reject(reason);
    }
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#idle = new Promise<void>((resolve) => {
      this.#resolveIdle = resolve;
    });
    try {
      while (this.#entries.length > 0) {
        const entry = this.#entries.shift()!;
        entry.removeAbort?.();
        if (entry.signal?.aborted) {
          entry.reject(entry.signal.reason);
          continue;
        }
        try {
          entry.resolve(await entry.op());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      this.#running = false;
      this.#resolveIdle?.();
      this.#resolveIdle = undefined;
    }
  }
}
