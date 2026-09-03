import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRunner } from "@automatalabs/shared-types";
import { WorkflowManager } from "../src/workflow-manager.js";

function fixture(runner: AgentRunner) {
  const cwd = mkdtempSync(join(tmpdir(), "same-run-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "same-run-store-"));
  return {
    manager: new WorkflowManager({ cwd, persistenceRoot, agent: runner }),
    cleanup() {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    },
  };
}

test("strict continuation keeps one run id, immutable inputs, admitted config, and cumulative usage", async () => {
  let betaFails = true;
  const prompts: string[] = [];
  const runner: AgentRunner = {
    async run(prompt, options) {
      prompts.push(prompt);
      if (prompt === "alpha") {
        options.onUsage?.({ input: 4, output: 6, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.1 });
        return "alpha-result";
      }
      if (betaFails) {
        betaFails = false;
        options.onUsage?.({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.03 });
        throw new Error("beta failed once");
      }
      options.onUsage?.({ input: 2, output: 5, cacheRead: 0, cacheWrite: 0, total: 7, cost: 0.07 });
      return "beta-result";
    },
  };
  const testRun = fixture(runner);
  try {
    const script = `export const meta = { name: "same-run-usage", description: "same run usage" };
const alpha = await agent("alpha", { label: "alpha" });
const beta = await agent("beta", { label: "beta" });
if (beta === null) throw new Error("beta is required");
return { alpha, beta, marker: args.marker };`;
    const first = await testRun.manager.runSync(script, { marker: "original" }, {
      runId: "same-run-usage",
      agentConfigurations: { 0: { model: "claude/opus" }, 1: { model: "codex/gpt" } },
      requireAgentConfiguration: true,
      agentConfigurationSource: "host",
    });
    assert.equal(first.status, "failed");
    assert.equal(first.tokenUsage?.total, 13);
    const beforeEvents = testRun.manager.getPersistence().readEvents(first.runId, { limit: 1_000 });

    const started = await testRun.manager.continueRun(first.runId);
    assert.equal(started.accepted, true);
    if (!started.accepted) assert.fail(`continuation refused: ${started.reason}`);
    assert.equal(started.runId, first.runId);
    assert.equal(started.continuation.generation, 1);
    assert.equal(started.continuation.replayedPrefix, 1);
    const completed = await started.promise;

    assert.equal(completed.runId, first.runId);
    assert.equal(completed.status, "completed");
    assert.deepEqual(structuredClone(completed.result), {
      alpha: "alpha-result",
      beta: "beta-result",
      marker: "original",
    });
    assert.equal(completed.tokenUsage?.total, 20);
    assert.equal(completed.tokenUsage?.cost, 0.2);
    assert.deepEqual(prompts, ["alpha", "beta", "beta"]);
    const continuationEvents = testRun.manager.getPersistence().readEvents(first.runId, {
      after: beforeEvents.endCursor,
      limit: 1_000,
      streamId: beforeEvents.streamId,
    });
    assert.equal(continuationEvents.streamId, beforeEvents.streamId);
    assert.equal(continuationEvents.events[0]?.event.type, "resumed");

    const persisted = testRun.manager.getPersistence().load(first.runId);
    assert.equal(persisted?.admission?.format, 1);
    assert.equal(persisted?.admission?.agentConfigurations[0]?.model, "claude/opus");
    assert.equal(persisted?.admission?.agentConfigurations[1]?.model, "codex/gpt");
    assert.deepEqual(persisted?.args, { marker: "original" });
    assert.equal(persisted?.tokenUsage?.total, 20);
  } finally {
    testRun.cleanup();
  }
});

test("an uncovered strict occurrence is durable and permanently blocks continuation", async () => {
  let calls = 0;
  const testRun = fixture({
    async run() {
      calls++;
      return "covered";
    },
  });
  try {
    const script = `export const meta = { name: "uncovered", description: "uncovered" };
const values = [];
for (let index = 0; index < args.count; index++) values.push(await agent(String(index), { label: String(index) }));
return values;`;
    const result = await testRun.manager.runSync(script, { count: 2 }, {
      runId: "uncovered-run",
      agentConfigurations: { 0: { model: "claude/opus" } },
      requireAgentConfiguration: true,
    });
    assert.equal(result.status, "failed");
    assert.equal(calls, 1);
    const persisted = testRun.manager.getPersistence().load(result.runId);
    assert.deepEqual(persisted?.admission?.uncoveredOccurrence && {
      ordinal: persisted.admission.uncoveredOccurrence.ordinal,
      label: persisted.admission.uncoveredOccurrence.label,
    }, { ordinal: 1, label: "1" });

    const continued = await testRun.manager.continueRun(result.runId);
    assert.deepEqual(continued, { accepted: false, reason: "admission-uncovered" });
    assert.equal(calls, 1);
  } finally {
    testRun.cleanup();
  }
});

test("the first leased checkpoint answer wins; repeats are idempotent and conflicts stay ignored", async () => {
  const testRun = fixture({ async run() { return "unused"; } });
  try {
    const script = `export const meta = { name: "checkpoint-race", description: "checkpoint race" };
return await checkpoint("ship?", { kind: "select", choices: ["ship", "hold"], headless: "pause" });`;
    const paused = await testRun.manager.runSync(script, undefined, {
      runId: "checkpoint-race",
      agentConfigurations: {},
      requireAgentConfiguration: true,
    });
    assert.equal(paused.status, "paused");

    const [first, conflicting] = await Promise.all([
      testRun.manager.continueRun(paused.runId, { checkpointReplies: { 0: "ship" } }),
      testRun.manager.continueRun(paused.runId, { checkpointReplies: { 0: "hold" } }),
    ]);
    assert.equal(first.accepted, true);
    if (!first.accepted) assert.fail(`first answer refused: ${first.reason}`);
    assert.equal(conflicting.accepted, false);
    assert.deepEqual(conflicting.resolvedCheckpoints, [{
      callIndex: 0,
      outcome: "different",
      decision: "ship",
      ignored: "hold",
    }]);
    const completed = await first.promise;
    assert.equal(completed.result, "ship");

    const repeated = await testRun.manager.continueRun(paused.runId, {
      checkpointReplies: { 0: "ship" },
    });
    assert.equal(repeated.accepted, false);
    assert.equal(repeated.reason, "terminal");
    assert.deepEqual(repeated.resolvedCheckpoints, [{
      callIndex: 0,
      outcome: "same",
      decision: "ship",
    }]);

    const persisted = testRun.manager.getPersistence().load(paused.runId);
    assert.equal(persisted?.journal?.find((entry) => entry.index === 0)?.result, "ship");
  } finally {
    testRun.cleanup();
  }
});

test("a mismatched checkpoint batch never reports or persists a provisional answer", async () => {
  const testRun = fixture({ async run() { return "unused"; } });
  try {
    const script = `export const meta = { name: "checkpoint-batch", description: "checkpoint batch" };
return await checkpoint("ship?", { headless: "pause" });`;
    const paused = await testRun.manager.runSync(script, undefined, {
      runId: "checkpoint-batch",
      agentConfigurations: {},
      requireAgentConfiguration: true,
    });
    assert.equal(paused.status, "paused");

    const refused = await testRun.manager.continueRun(paused.runId, {
      checkpointReplies: { 0: true, 1: false },
    });
    assert.deepEqual(refused, {
      accepted: false,
      reason: "checkpoint-mismatch",
    });
    assert.equal(
      testRun.manager.getPersistence().load(paused.runId)?.journal?.some((entry) => entry.index === 0),
      false,
    );

    const continued = await testRun.manager.continueRun(paused.runId, {
      checkpointReplies: { 0: true },
    });
    assert.equal(continued.accepted, true);
    if (continued.accepted) assert.equal((await continued.promise).result, true);
  } finally {
    testRun.cleanup();
  }
});

test("a repeated earlier answer never moves the run past a later pending checkpoint", async () => {
  const testRun = fixture({ async run() { return "unused"; } });
  try {
    const script = `export const meta = { name: "two-gates", description: "two gates" };
const first = await checkpoint("first?", { kind: "confirm", default: true });
const second = await checkpoint("second?", { kind: "confirm", default: true });
return { first, second };`;
    const paused = await testRun.manager.runSync(script, undefined, {
      runId: "two-gates",
      agentConfigurations: {},
      requireAgentConfiguration: true,
      pauseOnCheckpoint: true,
    });
    assert.equal(paused.status, "paused");
    assert.equal(paused.checkpointContext?.callIndex, 0);

    const answered = await testRun.manager.continueRun("two-gates", {
      checkpointReplies: { 0: false },
      pauseOnCheckpoint: true,
    });
    assert.equal(answered.accepted, true);
    if (!answered.accepted) assert.fail(answered.reason);
    await answered.promise.catch(() => undefined);
    const pausedAgain = testRun.manager.getPersistence().load("two-gates");
    assert.equal(pausedAgain?.pauseReason, "checkpoint_required");
    assert.equal(pausedAgain?.checkpointContext?.callIndex, 1);
    const before = testRun.manager.getPersistence().readEvents("two-gates", { limit: 1_000 });

    // The idempotent repeat is reported, but it is not an answer for checkpoint 1: the run must
    // stay paused rather than resolve the second gate to its authored default.
    const repeated = await testRun.manager.continueRun("two-gates", { checkpointReplies: { 0: false } });
    assert.deepEqual(repeated, {
      accepted: false,
      reason: "checkpoint-required",
      resolvedCheckpoints: [{ callIndex: 0, outcome: "same", decision: false }],
    });
    const after = testRun.manager.getPersistence().readEvents("two-gates", {
      after: before.endCursor,
      limit: 1_000,
      streamId: before.streamId,
    });
    assert.deepEqual(after.events.map((record) => record.event.type), []);
    assert.equal(testRun.manager.getPersistence().load("two-gates")?.status, "paused");

    const conflicting = await testRun.manager.continueRun("two-gates", { checkpointReplies: { 0: true } });
    assert.deepEqual(conflicting, {
      accepted: false,
      reason: "checkpoint-required",
      resolvedCheckpoints: [{ callIndex: 0, outcome: "different", decision: false, ignored: true }],
    });

    const finished = await testRun.manager.continueRun("two-gates", { checkpointReplies: { 0: false, 1: false } });
    assert.equal(finished.accepted, true);
    if (!finished.accepted) assert.fail(finished.reason);
    const completed = await finished.promise;
    assert.equal(completed.status, "completed");
    assert.deepEqual(structuredClone(completed.result), { first: false, second: false });
  } finally {
    testRun.cleanup();
  }
});

test("SDK same-ID recovery keeps the persisted default model and replays the journaled prefix", async () => {
  const models: Array<string | undefined> = [];
  let failBeta = true;
  const testRun = fixture({
    async run(prompt, options) {
      models.push(options.model);
      if (prompt === "beta" && failBeta) {
        failBeta = false;
        throw new Error("beta failed once");
      }
      return `ok:${prompt}`;
    },
  });
  try {
    const script = `export const meta = { name: "default-model", description: "default model" };
const alpha = await agent("alpha");
const beta = await agent("beta");
if (beta === null) throw new Error("beta is required");
return { alpha, beta };`;
    const first = await testRun.manager.runSync(script, undefined, { runId: "default-model", defaultModel: "codex/gpt" });
    assert.equal(first.status, "failed");
    assert.equal(testRun.manager.getPersistence().load("default-model")?.defaultModel, "codex/gpt");

    const resumed = await testRun.manager.resumeInBackground("default-model");
    assert.equal(resumed.accepted, true);
    const completed = await resumed.promise!;
    assert.equal(completed.status, "completed");
    assert.deepEqual(models, ["codex/gpt", "codex/gpt", "codex/gpt"], "alpha replays; beta re-runs under the persisted default");
  } finally {
    testRun.cleanup();
  }
});

test("a fresh manager dispatches the persisted canonical selection unchanged on cold continuation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "same-run-cold-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "same-run-cold-store-"));
  const dispatched: Array<{ model?: string; mode?: string; configOptions?: unknown }> = [];
  let failBeta = true;
  const runner: AgentRunner = {
    async run(prompt, options) {
      dispatched.push({ model: options.model, mode: options.mode, configOptions: options.configOptions });
      if (prompt === "beta" && failBeta) {
        failBeta = false;
        throw new Error("beta failed once");
      }
      return `ok:${prompt}`;
    },
  };
  try {
    const script = `export const meta = { name: "cold-dispatch", description: "cold dispatch" };
const alpha = await agent("alpha", { label: "alpha" });
const beta = await agent("beta", { label: "beta" });
if (beta === null) throw new Error("beta is required");
return { alpha, beta };`;
    const selection = {
      0: { model: "claude/opus", mode: "bypassPermissions", configOptions: { effort: "high", verbose: true } },
      1: { model: "codex/gpt", mode: "agent", configOptions: { reasoning_effort: "xhigh" } },
    } as const;
    const warm = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
    const first = await warm.runSync(script, undefined, {
      runId: "cold-dispatch",
      agentConfigurations: selection,
      requireAgentConfiguration: true,
      agentConfigurationSource: "mcp-elicitation",
    });
    assert.equal(first.status, "failed");
    assert.deepEqual(dispatched.map((call) => call.model), ["claude/opus", "codex/gpt"]);

    const cold = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
    const started = await cold.continueRun("cold-dispatch");
    assert.equal(started.accepted, true);
    if (!started.accepted) assert.fail(started.reason);
    const completed = await started.promise;
    assert.equal(completed.status, "completed");
    assert.equal(dispatched.length, 3, "alpha replays from the journal; only beta runs live");
    assert.deepEqual(structuredClone(dispatched[2]), {
      model: "codex/gpt",
      mode: "agent",
      configOptions: { reasoning_effort: "xhigh" },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
