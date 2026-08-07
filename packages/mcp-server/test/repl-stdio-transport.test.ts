/**
 * Phase-F review round 4 pins for `ReplRelayStdioTransport.send`:
 * SEND COMPLETION MEANS FLUSHED — a `write()` that reports
 * backpressure (`false`) must not resolve until the stdout `drain`
 * event fires, exactly like the `StdioServerTransport` this transport
 * replaces (the old fire-and-forget write resolved immediately,
 * allowing unbounded buffering against a slow client and violating
 * send-completion semantics for all in-process MCP traffic).
 *
 * Only `send` is exercised here: `start()` spawns the stdin-reader
 * worker, which must never run inside the test process (it owns fd 0).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { ReplRelayStdioTransport, type ReplRelayStdioSink } from "../src/repl-stdio-transport.js";

/** A controllable stdout seam: reports backpressure on demand and lets
 *  the test fire `drain`/`error` events. */
class FakeSink extends EventEmitter implements ReplRelayStdioSink {
  written: string[] = [];
  drainBlocked = false;

  write(chunk: string): boolean {
    this.written.push(chunk);
    return !this.drainBlocked;
  }
}

function transportFor(sink: FakeSink): ReplRelayStdioTransport {
  // The breakUrl source is never consulted without start() — send()
  // alone never touches the worker or the channel.
  return new ReplRelayStdioTransport(
    () => Promise.resolve("http://127.0.0.1:0/break"),
    () => undefined,
    sink,
  );
}

test("send resolves immediately when stdout accepts the frame", async () => {
  const sink = new FakeSink();
  const transport = transportFor(sink);
  const message = { jsonrpc: "2.0" as const, method: "notifications/initialized" };
  let settled = false;
  const send = transport.send(message).then(() => {
    settled = true;
  });
  // No drain event needed: a successful write resolves synchronously
  // (well, microtask-wise) — drainBlocked is false, so no listener is
  // ever attached.
  await send;
  assert.equal(settled, true, "the send completed");
  assert.deepEqual(sink.written, [`${JSON.stringify(message)}\n`], "the frame is written verbatim with its newline");
});

test("send WAITS FOR DRAIN when stdout reports backpressure — completion means flushed (round 4)", async () => {
  const sink = new FakeSink();
  sink.drainBlocked = true;
  const transport = transportFor(sink);
  const message = { jsonrpc: "2.0" as const, method: "notifications/cancelled", params: {} };
  let settled = false;
  const send = transport.send(message).then(() => {
    settled = true;
  });
  // Give any (wrong) immediate resolution a chance to surface: the
  // write returned false, so the promise must still be pending.
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(settled, false, "the send is pending while the stream is backpressured");
  // The drain event releases it — exactly the SDK semantics.
  sink.emit("drain");
  await send;
  assert.equal(settled, true, "the send completed once the stream drained");
  assert.deepEqual(sink.written, [`${JSON.stringify(message)}\n`], "the frame was written once");
});

test("backpressure releases only its OWN drain: an earlier drain never resolves a later send early", async () => {
  const sink = new FakeSink();
  sink.drainBlocked = true;
  const transport = transportFor(sink);
  const first = { jsonrpc: "2.0" as const, method: "notifications/initialized" };
  const second = { jsonrpc: "2.0" as const, method: "notifications/initialized" };
  let firstDone = false;
  let secondDone = false;
  const send1 = transport.send(first).then(() => {
    firstDone = true;
  });
  const send2 = transport.send(second).then(() => {
    secondDone = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  sink.emit("drain");
  await send1;
  await send2;
  assert.equal(firstDone && secondDone, true, "each send resolves on the drain");
  assert.equal(sink.written.length, 2, "both frames were written");
});
