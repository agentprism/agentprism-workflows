// BoundedEventStore: the SDK EventStore contract (storeEvent/getStreamIdForEventId/
// replayEventsAfter) plus the bounding behavior the daemon depends on — per-stream ring,
// global LRU cap, and replay-miss degrading to "re-bind the stream, replay what remains".
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { BoundedEventStore } from "../../src/daemon/event-store.js";

function msg(n: number): JSONRPCMessage {
  return { jsonrpc: "2.0", method: "notifications/message", params: { n } } as JSONRPCMessage;
}

async function replayAll(store: BoundedEventStore, lastEventId: string) {
  const seen: Array<{ eventId: string; message: JSONRPCMessage }> = [];
  const streamId = await store.replayEventsAfter(lastEventId, {
    send: async (eventId, message) => {
      seen.push({ eventId, message });
    },
  });
  return { streamId, seen };
}

test("event IDs are per-stream monotonic, parseable, and ordered", async () => {
  const store = new BoundedEventStore();
  const a1 = await store.storeEvent("stream-a", msg(1));
  const a2 = await store.storeEvent("stream-a", msg(2));
  const b1 = await store.storeEvent("stream-b", msg(3));
  assert.equal(a1, "stream-a_0000000001");
  assert.equal(a2, "stream-a_0000000002");
  assert.ok(a1 < a2);
  assert.equal(await store.getStreamIdForEventId(a2), "stream-a");
  assert.equal(await store.getStreamIdForEventId(b1), "stream-b");
});

test("the SDK's underscored standalone stream id parses back losslessly", async () => {
  const store = new BoundedEventStore();
  const id = await store.storeEvent("_GET_stream", msg(1));
  assert.equal(id, "_GET_stream_0000000001");
  assert.equal(await store.getStreamIdForEventId(id), "_GET_stream");
  const { streamId, seen } = await replayAll(store, id);
  assert.equal(streamId, "_GET_stream");
  assert.equal(seen.length, 0);
});

test("replayEventsAfter replays exactly the suffix after the cursor, in order", async () => {
  const store = new BoundedEventStore();
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) ids.push(await store.storeEvent("s", msg(i)));
  const { streamId, seen } = await replayAll(store, ids[1]);
  assert.equal(streamId, "s");
  assert.deepEqual(
    seen.map((e) => e.eventId),
    ids.slice(2),
  );
  assert.deepEqual(
    seen.map((e) => (e.message as { params: { n: number } }).params.n),
    [3, 4, 5],
  );
});

test("per-stream cap drops the oldest events; replay from an evicted cursor still re-binds", async () => {
  const store = new BoundedEventStore({ maxPerStream: 3, maxTotal: 100 });
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) ids.push(await store.storeEvent("s", msg(i)));
  // Events 1-2 evicted; cursor at evicted event 1 replays the surviving 3..5.
  const { streamId, seen } = await replayAll(store, ids[0]);
  assert.equal(streamId, "s");
  assert.deepEqual(
    seen.map((e) => e.eventId),
    ids.slice(2),
  );
});

test("global cap evicts least-recently-written OTHER streams before the writing stream", async () => {
  const store = new BoundedEventStore({ maxPerStream: 100, maxTotal: 4 });
  const cold: string[] = [];
  for (let i = 1; i <= 2; i++) cold.push(await store.storeEvent("cold", msg(i)));
  const hot: string[] = [];
  for (let i = 1; i <= 4; i++) hot.push(await store.storeEvent("hot", msg(10 + i)));
  // Total would be 6; the two cold events are evicted to get back to 4.
  const coldReplay = await replayAll(store, cold[0]);
  assert.equal(coldReplay.streamId, "cold");
  assert.equal(coldReplay.seen.length, 0);
  const hotReplay = await replayAll(store, `hot_${"0".repeat(10)}`);
  assert.equal(hotReplay.seen.length, 4);
});

test("a stream evicted by the global cap keeps its monotonic counter on later writes", async () => {
  const store = new BoundedEventStore({ maxPerStream: 100, maxTotal: 2 });
  const first = await store.storeEvent("a", msg(1));
  await store.storeEvent("b", msg(2));
  await store.storeEvent("b", msg(3)); // evicts stream a entirely
  const second = await store.storeEvent("a", msg(4));
  assert.ok(second > first, `expected ${second} > ${first}`);
  assert.equal(second, "a_0000000002");
});

test("an unparseable Last-Event-ID throws (SDK surfaces a 500, client falls back to fresh GET)", async () => {
  const store = new BoundedEventStore();
  await assert.rejects(() => replayAll(store, "garbage"), /Unparseable Last-Event-ID/);
});
