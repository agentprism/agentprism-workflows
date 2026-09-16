// The per-agent emitter (src/agent/events.ts) driven with synthetic `sink(name, event)` calls —
// no fake agent. Pins the routing rules the id-only fork hand-off depends on: known-id filtering,
// the acquisition buffer, the open/close dedupe, sticky session_open, and tap ordering/isolation.
import test from "node:test";
import assert from "node:assert/strict";
import type { AcpEventContext } from "../../src/events.js";
import { AgentEventBus } from "../../src/agent/events.js";

const ctx = (sessionId: string): AcpEventContext => ({ sessionId, backendId: "claude" });

function chunk(sessionId: string, text: string) {
  return {
    ...ctx(sessionId),
    update: { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text } },
  };
}

function microtask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

test("dispatches only the known session id; backend_error always", () => {
  const bus = new AgentEventBus();
  bus.beginAcquisition();
  bus.endAcquisition("a");

  const seen: string[] = [];
  bus.on("session_update", (event) => seen.push(`update:${event.sessionId}`));
  bus.on("session_close", (event) => seen.push(`close:${event.sessionId}`));
  const errors: unknown[] = [];
  bus.on("backend_error", (event) => errors.push(event.error));

  bus.sink("session_update", chunk("a", "mine"));
  bus.sink("session_update", chunk("b", "a stranger's"));
  bus.sink("session_close", ctx("b"));
  bus.sink("session_close", ctx("a"));
  const crash = new Error("process exited");
  bus.sink("backend_error", { backendId: "claude", error: crash });

  assert.deepEqual(seen, ["update:a", "close:a"], "only the known id reaches listeners");
  assert.deepEqual(errors, [crash], "backend_error carries no session id and is always ours");
});

test("buffers unknown-id events during acquisition, replays adopted ones in order, drops the rest", () => {
  const bus = new AgentEventBus();
  const seen: string[] = [];
  bus.on("session_update", (event) => {
    const update = event.update;
    seen.push(`${event.sessionId}:${update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : "?"}`);
  });
  bus.on("session_open", (event) => seen.push(`open:${event.sessionId}`));

  bus.beginAcquisition();
  bus.sink("session_update", chunk("b", "one"));
  bus.sink("session_update", chunk("c", "stranger"));
  bus.sink("session_open", ctx("b"));
  bus.sink("session_update", chunk("b", "two"));
  assert.deepEqual(seen, [], "nothing is delivered while the id is unknown");

  bus.endAcquisition("b");
  assert.deepEqual(seen, ["b:one", "open:b", "b:two"], "b's events replay in arrival order; c's are dropped");

  // Acquisition is over: a stranger's event is dropped outright, b's are live.
  bus.sink("session_update", chunk("c", "late stranger"));
  bus.sink("session_update", chunk("b", "three"));
  assert.deepEqual(seen, ["b:one", "open:b", "b:two", "b:three"]);
});

test("dedupes a second session_open for the known id and drops session_close while acquiring — live AND buffered", () => {
  // (a) the id is already known and a reattach is acquiring on the SAME id (the id-only hand-off
  //     seen from a bus that adopted the fork id first).
  {
    const bus = new AgentEventBus();
    bus.beginAcquisition();
    bus.endAcquisition("a");
    const opens: string[] = [];
    const closes: string[] = [];
    bus.on("session_open", (event) => opens.push(event.sessionId));
    bus.on("session_close", (event) => closes.push(event.sessionId));

    bus.beginAcquisition();
    bus.sink("session_open", ctx("a"));
    bus.sink("session_close", ctx("a"));
    bus.sink("session_open", ctx("a"));
    bus.endAcquisition("a");
    assert.deepEqual(opens, ["a"], "exactly one session_open");
    assert.deepEqual(closes, [], "the hand-off release is not our close");

    bus.sink("session_close", ctx("a"));
    assert.deepEqual(closes, ["a"], "a close after the acquisition IS delivered");
  }

  // (b) the id is UNKNOWN: fork registers b (open), releases it keepOpen (close), the reattach
  //     registers b again (open) — all before the agent learns the id.
  {
    const bus = new AgentEventBus();
    const opens: string[] = [];
    const closes: string[] = [];
    bus.on("session_open", (event) => opens.push(event.sessionId));
    bus.on("session_close", (event) => closes.push(event.sessionId));

    bus.beginAcquisition();
    bus.sink("session_open", ctx("b"));
    bus.sink("session_close", ctx("b"));
    bus.sink("session_open", ctx("b"));
    assert.deepEqual(opens, []);
    bus.endAcquisition("b");
    assert.deepEqual(opens, ["b"], "the buffered opens collapse to one");
    assert.deepEqual(closes, [], "the buffered hand-off close is never replayed");

    bus.sink("session_close", ctx("b"));
    assert.deepEqual(closes, ["b"], "the agent's real close after endAcquisition is delivered");
  }
});

test("sticky session_open reaches a late subscriber once and never re-fires for a live subscriber", async () => {
  const bus = new AgentEventBus();
  let a = 0;
  let b = 0;
  let c = 0;
  bus.on("session_open", () => {
    a += 1;
  });
  bus.beginAcquisition();
  bus.sink("session_open", ctx("s"));
  bus.endAcquisition("s");
  assert.equal(a, 1, "A saw it live");

  bus.on("session_open", () => {
    b += 1;
  });
  assert.equal(b, 0, "the sticky delivery is asynchronous (next microtask)");
  await microtask();
  assert.equal(b, 1, "B (registered after the open) received it once");

  const cListener = (): void => {
    c += 1;
  };
  bus.on("session_open", cListener);
  bus.on("session_open", cListener);
  await microtask();
  assert.equal(c, 2, "C registered twice gets it once per registration");

  // A second live open for the same id (the id-only reattach shape) never re-fires anywhere.
  bus.sink("session_open", ctx("s"));
  await microtask();
  assert.deepEqual([a, b, c], [1, 1, 2]);

  // A late subscriber that unsubscribes before the microtask runs never sees it.
  let d = 0;
  const offD = bus.on("session_open", () => {
    d += 1;
  });
  offD();
  await microtask();
  assert.equal(d, 0);

  // `once` semantics hold for the sticky path too: one delivery, then the entry is gone.
  let e = 0;
  bus.once("session_open", () => {
    e += 1;
  });
  await microtask();
  bus.sink("session_open", ctx("s"));
  await microtask();
  assert.equal(e, 1);
});

test("taps run before public listeners and are exception-isolated", () => {
  const bus = new AgentEventBus();
  bus.beginAcquisition();
  bus.endAcquisition("s");
  const order: string[] = [];
  bus.tap(() => {
    throw new Error("a throwing tap must not stop delivery");
  });
  bus.on("session_update", () => order.push("listener"));
  const untap = bus.tap((name) => order.push(`tap:${name}`));
  bus.on("session_update", () => {
    throw new Error("a throwing listener must not break its siblings");
  });
  bus.on("session_update", () => order.push("sibling"));

  bus.sink("session_update", chunk("s", "x"));
  assert.deepEqual(order, ["tap:session_update", "listener", "sibling"]);

  untap();
  bus.sink("session_update", chunk("s", "y"));
  assert.deepEqual(order, ["tap:session_update", "listener", "sibling", "listener", "sibling"], "an untapped tap is gone");

  // After close: nothing is delivered and new subscriptions are inert no-ops.
  bus.close();
  const off = bus.on("session_update", () => order.push("after close"));
  bus.sink("session_update", chunk("s", "z"));
  off();
  assert.equal(order.includes("after close"), false);
});
