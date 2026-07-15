// Unit tests for the typed ACP event bus (TypedEventEmitter + emitSessionUpdate). No ACP wire —
// the end-to-end bubbling through a real runner is covered by runner-events.integration.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TypedEventEmitter,
  emitSessionUpdate,
  type AcpEventContext,
  type AcpEventSink,
  type AcpRunnerEventMap,
  type AcpSessionUpdate,
} from "../src/events.js";

test("on/emit delivers the typed payload to every listener in order", () => {
  const em = new TypedEventEmitter<{ ping: { n: number } }>();
  const seen: number[] = [];
  em.on("ping", (e) => seen.push(e.n));
  em.on("ping", (e) => seen.push(e.n * 10));
  em.emit("ping", { n: 2 });
  assert.deepEqual(seen, [2, 20]);
});

test("on() returns an unsubscribe thunk; off() also unsubscribes; listenerCount tracks it", () => {
  const em = new TypedEventEmitter<{ x: number }>();
  const seen: number[] = [];
  const off1 = em.on("x", (n) => seen.push(n));
  const l2 = (n: number) => seen.push(n * 100);
  em.on("x", l2);
  assert.equal(em.listenerCount("x"), 2);

  em.emit("x", 1); // both: 1, 100
  off1();
  em.emit("x", 2); // only l2: 200
  em.off("x", l2);
  em.emit("x", 3); // none

  assert.deepEqual(seen, [1, 100, 200]);
  assert.equal(em.listenerCount("x"), 0);
});

test("once fires exactly once then auto-unsubscribes", () => {
  const em = new TypedEventEmitter<{ e: string }>();
  const seen: string[] = [];
  em.once("e", (s) => seen.push(s));
  em.emit("e", "a");
  em.emit("e", "b");
  assert.deepEqual(seen, ["a"]);
  assert.equal(em.listenerCount("e"), 0);
});

test("a throwing listener is isolated: siblings still run and emit never throws", () => {
  const em = new TypedEventEmitter<{ e: number }>();
  const seen: number[] = [];
  em.on("e", () => {
    throw new Error("boom");
  });
  em.on("e", (n) => seen.push(n));
  assert.doesNotThrow(() => em.emit("e", 7));
  assert.deepEqual(seen, [7]);
});

test("removeAllListeners clears one event or all", () => {
  const em = new TypedEventEmitter<{ a: number; b: number }>();
  em.on("a", () => {});
  em.on("b", () => {});
  em.removeAllListeners("a");
  assert.equal(em.listenerCount("a"), 0);
  assert.equal(em.listenerCount("b"), 1);
  em.removeAllListeners();
  assert.equal(em.listenerCount("b"), 0);
});

// ---- emitSessionUpdate dispatch ------------------------------------------------------

function sinkOf(em: TypedEventEmitter<AcpRunnerEventMap>): AcpEventSink {
  return (name, event) => em.emit(name, event);
}
const CTX: AcpEventContext = {
  sessionId: "s1",
  backendId: "claude",
  label: "L",
  runId: "R",
  callIndex: 7,
};

test("emitSessionUpdate fans out to the per-discriminant event AND the wildcard, merging context", () => {
  const em = new TypedEventEmitter<AcpRunnerEventMap>();
  const chunks: string[] = [];
  const wild: string[] = [];

  em.on("agent_message_chunk", (e) => {
    assert.equal(e.sessionId, "s1");
    assert.equal(e.backendId, "claude");
    assert.equal(e.label, "L");
    assert.equal(e.runId, "R");
    assert.equal(e.callIndex, 7);
    if (e.content.type === "text") chunks.push(e.content.text);
  });
  em.on("session_update", (e) => wild.push(e.update.sessionUpdate));

  const update = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  } as AcpSessionUpdate;
  emitSessionUpdate(sinkOf(em), update, CTX);

  assert.deepEqual(chunks, ["hi"]);
  assert.deepEqual(wild, ["agent_message_chunk"]);
});

test("emitSessionUpdate routes each discriminant ONLY to its own event (+ wildcard)", () => {
  const em = new TypedEventEmitter<AcpRunnerEventMap>();
  const got: string[] = [];
  em.on("tool_call", (e) => got.push(`tool:${e.sessionUpdate}`));
  em.on("plan", (e) => got.push(`plan:${e.sessionUpdate}`));
  em.on("agent_message_chunk", () => got.push("chunk-should-not-fire"));
  const wild: string[] = [];
  em.on("session_update", (e) => wild.push(e.update.sessionUpdate));

  emitSessionUpdate(
    sinkOf(em),
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "x", kind: "read" } as AcpSessionUpdate,
    CTX,
  );
  emitSessionUpdate(sinkOf(em), { sessionUpdate: "plan", entries: [] } as AcpSessionUpdate, CTX);

  assert.deepEqual(got, ["tool:tool_call", "plan:plan"]);
  assert.deepEqual(wild, ["tool_call", "plan"]);
});
