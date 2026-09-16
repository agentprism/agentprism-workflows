// The per-turn collector and turn builder (src/agent/turn.ts) with synthetic events on a real
// AgentEventBus and a duck-typed handle — no fake agent. Pins the verbatim-clone contract, the
// tool-call fold, the per-turn usage model (§3.3/§4.8) and the history slice.
import test from "node:test";
import assert from "node:assert/strict";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { AgentHistoryEntry } from "@automatalabs/shared-types";
import { ClaudeBackend } from "../../src/index.js";
import type { UsageBaseline } from "../../src/usage.js";
import { AgentEventBus } from "../../src/agent/events.js";
import { TurnCollector, addUsage, buildTurn, turnUsageOf, type TurnHandle } from "../../src/agent/turn.js";

const SESSION = "s";
const ctx = { sessionId: SESSION, backendId: "claude" as const };

function bus(): AgentEventBus {
  const b = new AgentEventBus();
  b.beginAcquisition();
  b.endAcquisition(SESSION);
  return b;
}

function handle(overrides: Partial<TurnHandle> & { history?: AgentHistoryEntry[]; gauge?: UsageBaseline } = {}): TurnHandle {
  const history = overrides.history ?? [];
  let gauge = overrides.gauge ?? { costAmount: 0, contextUsedTokens: 0 };
  const h: TurnHandle & { setGauge(next: UsageBaseline): void } = {
    history,
    usage: { baseline: () => ({ ...gauge }) },
    foldedTurnText: () => "folded",
    currentTurnText: () => "current",
    finalMessageText: () => "final",
    rawStructuredOutput: () => undefined,
    setGauge: (next) => {
      gauge = next;
    },
    ...overrides,
  };
  return h;
}

test("update records are deep clones", () => {
  const b = bus();
  const collector = new TurnCollector(b, handle());
  const original = {
    sessionUpdate: "tool_call" as const,
    toolCallId: "tc-1",
    title: "Read",
    kind: "read" as const,
    status: "in_progress" as const,
    _meta: { vendor: { nested: [1, 2] } },
  };
  b.sink("session_update", { ...ctx, update: original });
  const rawMessage = { type: "result", payload: { deep: true } };
  b.sink("raw_message", { ...ctx, method: "_claude/sdkMessage", message: rawMessage });

  // Mutate the originals AFTER capture: the records must be untouched.
  original.title = "MUTATED";
  original._meta.vendor.nested.push(3);
  rawMessage.payload.deep = false;

  assert.equal(collector.updates.length, 1);
  const record = collector.updates[0]!;
  assert.notEqual(record.update, original, "a copy, not the same reference");
  assert.deepEqual(record.update, {
    sessionUpdate: "tool_call",
    toolCallId: "tc-1",
    title: "Read",
    kind: "read",
    status: "in_progress",
    _meta: { vendor: { nested: [1, 2] } },
  });
  assert.equal(typeof record.receivedAt, "number");
  assert.deepEqual(collector.raw, [
    { method: "_claude/sdkMessage", message: { type: "result", payload: { deep: true } }, receivedAt: collector.raw[0]!.receivedAt },
  ]);

  // Stopped collectors ignore later events.
  collector.stop();
  b.sink("session_update", { ...ctx, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } });
  assert.equal(collector.updates.length, 1);
});

test("tool calls fold by toolCallId in first-seen order, merging fields and _meta", () => {
  const b = bus();
  const collector = new TurnCollector(b, handle());
  b.sink("session_update", {
    ...ctx,
    update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read", kind: "read", status: "in_progress", name: "read_file", _meta: { a: 1 } },
  });
  // An update for an id never announced with tool_call creates a bare entry.
  b.sink("session_update", { ...ctx, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", rawInput: { q: 1 } } });
  b.sink("session_update", {
    ...ctx,
    update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "x", _meta: { b: 2 } },
  });

  assert.deepEqual(collector.toolCalls, [
    { toolCallId: "tc-1", name: "read_file", title: "Read", kind: "read", status: "completed", rawOutput: "x", meta: { a: 1, b: 2 } },
    { toolCallId: "tc-2", title: "", status: "pending", rawInput: { q: 1 } },
  ]);
  // The getter hands out copies: mutating one never leaks back.
  const [first] = collector.toolCalls as Array<{ title: string }>;
  first!.title = "changed";
  assert.equal(collector.toolCalls[0]!.title, "Read");
});

test("usage.turn maps response.usage per turn, cost is the clamped gauge delta, and the no-usage fallback is the context delta", () => {
  const before: UsageBaseline = { costAmount: 0.1, contextUsedTokens: 100 };
  const after: UsageBaseline = { costAmount: 0.25, contextUsedTokens: 140 };
  const usage = { inputTokens: 30, outputTokens: 10, totalTokens: 40, cachedReadTokens: 5 };
  const response: PromptResponse = { stopReason: "end_turn", usage };

  const mapped = turnUsageOf(response, before, after);
  assert.deepEqual(mapped.turn, { input: 30, output: 10, cacheRead: 5, cacheWrite: 0, total: 40, cost: 0.15 });
  assert.equal(mapped.response, usage, "usage.response is the wire object itself");

  // A cost gauge that went DOWN clamps to zero (never negative).
  const down = turnUsageOf(response, { costAmount: 0.5, contextUsedTokens: 0 }, { costAmount: 0.2, contextUsedTokens: 0 });
  assert.equal(down.turn.cost, 0);

  // No `usage` on the response: tokens fall back to the context-gauge delta, exactly like the accumulator.
  const fallback = turnUsageOf({ stopReason: "end_turn", usage: null }, before, after);
  assert.deepEqual(fallback.turn, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 40, cost: 0.15 });
  assert.equal("response" in fallback, false, "no wire usage → no `response` key");
  const shrunk = turnUsageOf({ stopReason: "end_turn" }, { costAmount: 0, contextUsedTokens: 200 }, { costAmount: 0, contextUsedTokens: 50 });
  assert.equal(shrunk.turn.total, 0, "a context gauge that shrank clamps to zero");

  // The session sum adds every field; `cost` is the LATEST gauge value, never a sum of deltas.
  const session = addUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.1 }, mapped.turn, after);
  assert.deepEqual(session, { input: 40, output: 15, cacheRead: 5, cacheWrite: 0, total: 55, cost: 0.25 });
});

test("history is the turn's slice of copies", () => {
  const b = bus();
  const seed: AgentHistoryEntry[] = [
    { role: "user", kind: "text", text: "earlier prompt", timestamp: 1 },
    { role: "assistant", kind: "text", text: "earlier answer", timestamp: 2 },
  ];
  const h = handle({ history: seed });
  const collector = new TurnCollector(b, h);
  assert.equal(collector.historyStart, 2);
  assert.deepEqual(collector.gaugeBefore, { costAmount: 0, contextUsedTokens: 0 });

  const added: AgentHistoryEntry[] = [
    { role: "user", kind: "text", text: "this prompt", timestamp: 3 },
    { role: "assistant", kind: "toolCall", text: "read_file", toolName: "read_file", timestamp: 4 },
    { role: "assistant", kind: "text", text: "this answer", timestamp: 5 },
  ];
  h.history.push(...added);
  collector.stop();

  const turn = buildTurn({
    response: { stopReason: "end_turn" },
    collector,
    handle: h,
    backend: new ClaudeBackend(),
    schema: undefined,
    captured: undefined,
    sessionBefore: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
  });
  assert.equal(turn.history.length, 3, "only the entries appended during the turn");
  assert.deepEqual(turn.history, added);
  for (const [index, entry] of turn.history.entries()) {
    assert.notEqual(entry, added[index], "a copy, not the accumulator's own object");
  }
  assert.equal(turn.text, "folded", "text is the handle's foldedTurnText()");
  assert.equal(turn.stopReason, "end_turn");
  assert.deepEqual(turn.usage.turn, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
  assert.deepEqual(turn.usage.session, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 });
  assert.equal("structured" in turn, false, "no schema → no structured keys at all");
  assert.equal("structuredError" in turn, false);

  // retainHistory:false: the handle CLEARS its accumulator at beginTurn() (after the collector was
  // constructed), so the turn's slice starts at 0 — the previous length would drop this entry.
  const truncated = handle({ history: [seed[0]!, seed[1]!] });
  const c2 = new TurnCollector(bus(), truncated, { retainHistory: false });
  assert.equal(c2.historyStart, 0);
  truncated.history.length = 0;
  truncated.history.push(added[2]!);
  c2.stop();
  const t2 = buildTurn({
    response: { stopReason: "end_turn" },
    collector: c2,
    handle: truncated,
    backend: new ClaudeBackend(),
    schema: undefined,
    captured: undefined,
    sessionBefore: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  });
  assert.deepEqual(t2.history, [added[2]]);
});
