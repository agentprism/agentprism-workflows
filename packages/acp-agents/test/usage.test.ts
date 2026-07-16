// Area (6, unit): ACP usage -> AgentUsage. The accumulator must tolerate EITHER, BOTH, or
// NEITHER of the two experimental channels firing — `total === 0` is the "provider reported
// nothing" sentinel the engine reads.
import test from "node:test";
import assert from "node:assert/strict";
import type { Cost, Usage } from "@agentclientprotocol/sdk";
import { UsageAccumulator } from "../src/index.js";

test("neither channel fired => all-zero sentinel (engine will estimate)", () => {
  assert.deepEqual(new UsageAccumulator().toAgentUsage(), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
  });
});

test("recordPromptUsage maps every field per the frozen contract", () => {
  const acc = new UsageAccumulator();
  const usage: Usage = {
    totalTokens: 150,
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 20,
    cachedWriteTokens: 5,
  };
  acc.recordPromptUsage(usage);
  assert.deepEqual(acc.toAgentUsage(), {
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 5,
    total: 150,
    cost: 0, // no usage_update cost yet
  });
});

test("missing cache fields default to 0 (?? 0)", () => {
  const acc = new UsageAccumulator();
  acc.recordPromptUsage({ totalTokens: 7, inputTokens: 4, outputTokens: 3 });
  const u = acc.toAgentUsage();
  assert.equal(u.cacheRead, 0);
  assert.equal(u.cacheWrite, 0);
  assert.equal(u.total, 7);
});

test("recordPromptUsage tolerates null/undefined (keeps prior or stays zero)", () => {
  const acc = new UsageAccumulator();
  acc.recordPromptUsage(undefined);
  acc.recordPromptUsage(null);
  assert.equal(acc.toAgentUsage().total, 0);
  // a real usage then sticks even if a later null arrives
  acc.recordPromptUsage({ totalTokens: 9, inputTokens: 9, outputTokens: 0 });
  acc.recordPromptUsage(undefined);
  assert.equal(acc.toAgentUsage().total, 9);
});

test("recordCost takes the latest finite USD amount from usage_update.cost", () => {
  const acc = new UsageAccumulator();
  acc.recordCost({ amount: 0.12, currency: "USD" } as Cost);
  acc.recordCost({ amount: 0.34, currency: "USD" } as Cost); // cumulative -> latest wins
  assert.equal(acc.toAgentUsage().cost, 0.34);
});

test("recordCost ignores null/non-finite amounts", () => {
  const acc = new UsageAccumulator();
  acc.recordCost({ amount: 0.5, currency: "USD" } as Cost);
  acc.recordCost(null);
  acc.recordCost({ amount: Number.NaN, currency: "USD" } as Cost);
  acc.recordCost({ amount: Number.POSITIVE_INFINITY, currency: "USD" } as Cost);
  assert.equal(acc.toAgentUsage().cost, 0.5); // unchanged by the bad updates
});

test("both channels combine: tokens from PromptResponse, cost from usage_update", () => {
  const acc = new UsageAccumulator();
  acc.recordCost({ amount: 1.25, currency: "USD" } as Cost);
  acc.recordPromptUsage({ totalTokens: 30, inputTokens: 20, outputTokens: 10 });
  assert.deepEqual(acc.toAgentUsage(), {
    input: 20,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    total: 30,
    cost: 1.25,
  });
});

test("usage_update token counts populate total when no PromptResponse.usage arrived", () => {
  // The ONLY token channel that fired is usage_update (used=tokens-in-context). The engine
  // must see a non-zero total instead of the all-zero "estimate me" sentinel.
  const acc = new UsageAccumulator();
  acc.recordContextTokens(1234, 200000);
  assert.deepEqual(acc.toAgentUsage(), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1234,
    cost: 0,
  });
});

test("usage_update tokens + cost combine when PromptResponse.usage is absent", () => {
  const acc = new UsageAccumulator();
  acc.recordContextTokens(50, 200000);
  acc.recordCost({ amount: 0.02, currency: "USD" } as Cost);
  const u = acc.toAgentUsage();
  assert.equal(u.total, 50);
  assert.equal(u.cost, 0.02);
});

test("authoritative PromptResponse.usage WINS over usage_update context tokens", () => {
  // When BOTH fired, the per-turn breakdown is authoritative for total (and carries the
  // input/output/cache split that usage_update cannot provide).
  const acc = new UsageAccumulator();
  acc.recordContextTokens(999, 200000); // context tokens (would be the fallback)
  acc.recordPromptUsage({ totalTokens: 42, inputTokens: 30, outputTokens: 12 });
  const u = acc.toAgentUsage();
  assert.equal(u.total, 42); // not 999
  assert.equal(u.input, 30);
  assert.equal(u.output, 12);
});

test("recordContextTokens ignores negative/non-finite used (stays the zero sentinel)", () => {
  const acc = new UsageAccumulator();
  acc.recordContextTokens(-5);
  acc.recordContextTokens(Number.NaN);
  acc.recordContextTokens(null);
  acc.recordContextTokens(undefined);
  assert.equal(acc.toAgentUsage().total, 0);
});

test("baseline snapshots only cumulative cost and context gauge", () => {
  const acc = new UsageAccumulator();
  acc.recordCost({ amount: 1.25, currency: "USD" } as Cost);
  acc.recordContextTokens(800, 200000);
  assert.deepEqual(acc.baseline(), { costAmount: 1.25, contextUsedTokens: 800 });
});

test("delta keeps authoritative per-turn prompt usage unchanged and subtracts only cost", () => {
  const acc = new UsageAccumulator();
  acc.recordCost({ amount: 4, currency: "USD" } as Cost);
  acc.recordContextTokens(1_000, 200000);
  const baseline = acc.baseline();
  acc.recordPromptUsage({
    inputTokens: 12,
    outputTokens: 8,
    cachedReadTokens: 5,
    cachedWriteTokens: 3,
    totalTokens: 20,
  });
  acc.recordCost({ amount: 4.75, currency: "USD" } as Cost);
  acc.recordContextTokens(1_900, 200000);

  assert.deepEqual(acc.delta(baseline), {
    input: 12,
    output: 8,
    cacheRead: 5,
    cacheWrite: 3,
    total: 20,
    cost: 0.75,
  });
});

test("delta without prompt usage reports context growth and cumulative cost growth", () => {
  const acc = new UsageAccumulator();
  acc.recordCost({ amount: 2, currency: "USD" } as Cost);
  acc.recordContextTokens(400, 200000);
  const baseline = acc.baseline();
  acc.recordCost({ amount: 2.25, currency: "USD" } as Cost);
  acc.recordContextTokens(525, 200000);

  assert.deepEqual(acc.delta(baseline), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 125,
    cost: 0.25,
  });
});

test("delta clamps counter resets and context compaction to non-negative values", () => {
  const acc = new UsageAccumulator();
  acc.recordCost({ amount: 9, currency: "USD" } as Cost);
  acc.recordContextTokens(5_000, 200000);
  const baseline = acc.baseline();
  acc.recordCost({ amount: 1, currency: "USD" } as Cost);
  acc.recordContextTokens(4_000, 200000);

  assert.deepEqual(acc.delta(baseline), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
  });
});

test("delta with no post-baseline update preserves the all-zero sentinel", () => {
  const acc = new UsageAccumulator();
  acc.recordCost({ amount: 3, currency: "USD" } as Cost);
  acc.recordContextTokens(700, 200000);
  const baseline = acc.baseline();

  assert.deepEqual(acc.delta(baseline), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
  });
});
