// The per-agent emitter. One dedicated PooledConnection feeds `sink`; the bus filters by the
// agent's single known session id, buffers events for ids it does not know yet while a session is
// being acquired (session/new's own `session_open` fires inside `register()` before the open
// resolves; an OpenCode-style fork may stream its replay before the fork response carries the new
// id), replays the adopted entries once the id is known, drops the id-only fork hand-off noise
// (`session_close` from `release({ keepOpen: true })` and the reattach's second `session_open`),
// and keeps the first `session_open` sticky for late subscribers.
import type { AcpEventContext, AcpEventSink } from "../events.js";
import type { AcpAgentEventListener, AcpAgentEventMap, AcpAgentEventName } from "./types.js";

/** An internal listener that runs BEFORE public listeners for every dispatched event. */
export type AgentEventTap = <K extends AcpAgentEventName>(name: K, event: AcpAgentEventMap[K]) => void;

interface ListenerEntry {
  readonly name: AcpAgentEventName;
  readonly listener: (event: unknown) => void;
  readonly once: boolean;
  /** Set when this registration received the live (or sticky) `session_open`, so it never sees it twice. */
  sawSessionOpen: boolean;
}

interface BufferedEvent {
  readonly name: AcpAgentEventName;
  readonly event: AcpAgentEventMap[AcpAgentEventName];
}

function sessionIdOf(event: unknown): string | undefined {
  const sid = (event as { sessionId?: unknown } | null)?.sessionId;
  return typeof sid === "string" ? sid : undefined;
}

export class AgentEventBus {
  /** Passed to `PooledConnection.create({ onEvent })`. */
  readonly sink: AcpEventSink;
  readonly #entries: ListenerEntry[] = [];
  readonly #taps = new Set<AgentEventTap>();
  readonly #known = new Set<string>();
  #acquiring = false;
  #buffer: BufferedEvent[] = [];
  readonly #bufferedOpenIds = new Set<string>();
  #sawSessionOpen = false;
  #sticky: AcpEventContext | undefined;
  #closed = false;

  constructor() {
    this.sink = (name, event) => this.#route(name, event);
  }

  on<K extends AcpAgentEventName>(name: K, listener: AcpAgentEventListener<K>): () => void {
    return this.#subscribe(name, listener, false);
  }

  once<K extends AcpAgentEventName>(name: K, listener: AcpAgentEventListener<K>): () => void {
    return this.#subscribe(name, listener, true);
  }

  off<K extends AcpAgentEventName>(name: K, listener: AcpAgentEventListener<K>): void {
    const index = this.#entries.findIndex((entry) => entry.name === name && entry.listener === listener);
    if (index >= 0) this.#entries.splice(index, 1);
  }

  /** Internal observer; runs before public listeners, exception-isolated. Returns the untap thunk. */
  tap(listener: AgentEventTap): () => void {
    this.#taps.add(listener);
    return () => {
      this.#taps.delete(listener);
    };
  }

  /** Buffer events for ids not yet known (a session is being opened/forked/reattached). */
  beginAcquisition(): void {
    this.#acquiring = true;
  }

  /** Adopt `sessionId`: mark it known, replay the buffered entries for it (taps first, then public
   *  listeners) with the acquisition still flagged pending so the hand-off drops stay armed, then
   *  drop everything else. */
  endAcquisition(sessionId: string): void {
    this.#known.add(sessionId);
    const buffered = this.#buffer;
    this.#buffer = [];
    this.#bufferedOpenIds.clear();
    for (const { name, event } of buffered) {
      if (sessionIdOf(event) === sessionId) this.#route(name, event);
    }
    this.#acquiring = false;
  }

  /** Drop the buffer (the open failed). */
  abortAcquisition(): void {
    this.#acquiring = false;
    this.#buffer = [];
    this.#bufferedOpenIds.clear();
  }

  /** After teardown: listeners cleared; `on`/`once` become no-ops returning `() => {}`. */
  close(): void {
    this.#closed = true;
    this.#entries.length = 0;
    this.#taps.clear();
  }

  #subscribe<K extends AcpAgentEventName>(name: K, listener: AcpAgentEventListener<K>, once: boolean): () => void {
    if (this.#closed) return () => {};
    const entry: ListenerEntry = {
      name,
      listener: listener as (event: unknown) => void,
      once,
      sawSessionOpen: false,
    };
    this.#entries.push(entry);
    const off = (): void => {
      const index = this.#entries.indexOf(entry);
      if (index >= 0) this.#entries.splice(index, 1);
    };
    if (name === "session_open" && this.#sticky) {
      // Late subscriber: deliver the retained open once, on the next tick, only if still
      // subscribed and not already served live in the meantime.
      const sticky = this.#sticky;
      queueMicrotask(() => {
        if (entry.sawSessionOpen || !this.#entries.includes(entry)) return;
        this.#deliver(entry, "session_open", sticky);
      });
    }
    return off;
  }

  #route<K extends AcpAgentEventName>(name: K, event: AcpAgentEventMap[K]): void {
    if (this.#closed) return;
    const sid = sessionIdOf(event);
    // Only `backend_error` carries no session id; the connection is dedicated, so it is ours.
    if (sid === undefined) {
      this.#dispatch(name, event);
      return;
    }
    if (this.#known.has(sid)) {
      // The id-only fork registers the same id twice (fork, then reattach) — one open per agent.
      if (name === "session_open" && this.#sawSessionOpen) return;
      // The hand-off release unregisters the id while the reattach is pending — not our close.
      if (name === "session_close" && this.#acquiring) return;
      this.#dispatch(name, event);
      return;
    }
    if (!this.#acquiring) return;
    // Unknown id while acquiring: never buffer a close (it is the hand-off release or a
    // stranger's), buffer at most one open per id (the reattach registers before its wire call),
    // buffer everything else for adoption.
    if (name === "session_close") return;
    if (name === "session_open") {
      if (this.#bufferedOpenIds.has(sid)) return;
      this.#bufferedOpenIds.add(sid);
    }
    this.#buffer.push({ name, event });
  }

  #dispatch<K extends AcpAgentEventName>(name: K, event: AcpAgentEventMap[K]): void {
    if (name === "session_open") {
      this.#sawSessionOpen = true;
      this.#sticky ??= event as AcpEventContext;
    }
    for (const tap of [...this.#taps]) {
      try {
        tap(name, event);
      } catch {
        // Taps are internal observers; a throwing one never breaks delivery.
      }
    }
    // Snapshot so a listener that (un)subscribes during dispatch cannot perturb this emit.
    for (const entry of [...this.#entries]) {
      if (entry.name !== name) continue;
      this.#deliver(entry, name, event);
    }
  }

  #deliver(entry: ListenerEntry, name: AcpAgentEventName, event: unknown): void {
    if (!this.#entries.includes(entry)) return;
    if (entry.once) {
      const index = this.#entries.indexOf(entry);
      if (index >= 0) this.#entries.splice(index, 1);
    }
    if (name === "session_open") entry.sawSessionOpen = true;
    try {
      entry.listener(event);
    } catch {
      // Listeners are observers — never let one break the turn or sibling listeners.
    }
  }
}
