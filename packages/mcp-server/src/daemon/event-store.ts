/**
 * Bounded in-memory EventStore backing the SDK's Streamable HTTP resumability (priming
 * events, disconnected-message buffering, Last-Event-ID replay). One instance per session;
 * streams within it are the SDK's per-POST streams plus the standalone GET stream.
 *
 * Bounded on purpose: replay here is a transport nicety for notifications in flight. Run
 * truth always lives in the persisted journal and the status action, so eviction
 * degrades to a missed notification, never to lost run state. On a replay whose cursor was
 * evicted, the parsed streamId is still returned so the SDK re-binds the reconnected stream
 * to live traffic.
 */
import type { EventStore, JSONRPCMessage } from "@modelcontextprotocol/server";
import { EVENT_STORE_MAX_EVENTS_PER_STREAM, EVENT_STORE_MAX_TOTAL_EVENTS } from "./constants.js";

interface StoredEvent {
  eventId: string;
  message: JSONRPCMessage;
}

/**
 * Event IDs are `${streamId}_${zero-padded seq}`: globally unique within the session (spec
 * requirement) and parseable back to the originating stream even after eviction. The SDK's
 * standalone stream id (`_GET_stream`) itself contains underscores, so parsing always splits
 * on the LAST underscore.
 */
function eventIdFor(streamId: string, seq: number): string {
  return `${streamId}_${String(seq).padStart(10, "0")}`;
}

function streamIdOf(eventId: string): string | undefined {
  const split = eventId.lastIndexOf("_");
  if (split <= 0) return undefined;
  const seq = eventId.slice(split + 1);
  if (!/^\d{10}$/.test(seq)) return undefined;
  return eventId.slice(0, split);
}

export interface BoundedEventStoreOptions {
  maxPerStream?: number;
  maxTotal?: number;
}

export class BoundedEventStore implements EventStore {
  private readonly maxPerStream: number;
  private readonly maxTotal: number;
  /** Insertion order doubles as write-recency for global LRU eviction (re-set on write). */
  private readonly streams = new Map<string, StoredEvent[]>();
  /** Monotonic per-stream counters survive stream eviction so event IDs never regress. */
  private readonly counters = new Map<string, number>();
  private total = 0;

  constructor(options: BoundedEventStoreOptions = {}) {
    this.maxPerStream = options.maxPerStream ?? EVENT_STORE_MAX_EVENTS_PER_STREAM;
    this.maxTotal = options.maxTotal ?? EVENT_STORE_MAX_TOTAL_EVENTS;
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const seq = (this.counters.get(streamId) ?? 0) + 1;
    this.counters.set(streamId, seq);
    const eventId = eventIdFor(streamId, seq);

    let events = this.streams.get(streamId);
    if (events === undefined) {
      events = [];
    } else {
      this.streams.delete(streamId); // Re-insert below so map order tracks write recency.
    }
    events.push({ eventId, message });
    this.streams.set(streamId, events);
    this.total++;

    while (events.length > this.maxPerStream) {
      events.shift();
      this.total--;
    }
    if (this.total > this.maxTotal) this.evictOldest(streamId, events);
    return eventId;
  }

  private evictOldest(currentStreamId: string, currentEvents: StoredEvent[]): void {
    for (const [sid, evs] of this.streams) {
      if (sid === currentStreamId) continue;
      while (evs.length > 0 && this.total > this.maxTotal) {
        evs.shift();
        this.total--;
      }
      if (evs.length === 0) this.streams.delete(sid);
      if (this.total <= this.maxTotal) return;
    }
    // Only the writing stream remains: trim it, but never below its newest event.
    while (this.total > this.maxTotal && currentEvents.length > 1) {
      currentEvents.shift();
      this.total--;
    }
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return streamIdOf(eventId);
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const streamId = streamIdOf(lastEventId);
    if (streamId === undefined) {
      throw new Error(`Unparseable Last-Event-ID: ${lastEventId}`);
    }
    const events = this.streams.get(streamId) ?? [];
    for (const event of events) {
      // Same stream + fixed-width seq ⇒ lexicographic order is numeric order.
      if (event.eventId > lastEventId) {
        await send(event.eventId, event.message);
      }
    }
    return streamId;
  }
}
