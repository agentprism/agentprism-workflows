import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { WorkflowRunResult } from "@automatalabs/shared-types";
import { WorkflowManager } from "../src/workflow-manager.js";

const ENVIRONMENT_KEY = "checkpoint-reply-live-prefix-v1";
const workflow = (body: string, name: string) =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "checkpoint reply regression" }\n${body}`;

function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-reply-live-prefix-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function unappliedReply(result: WorkflowRunResult) {
  const reply = result.resumeReport?.checkpointReply;
  assert.equal(reply?.status, "not-applied");
  if (reply?.status !== "not-applied") assert.fail("expected an unapplied checkpoint reply");
  assert.match(reply.message, /checkpointReplies for call \d+ was not applied/);
  const checkpointDecision = result.resumeReport?.calls.find(
    (decision) => decision.kind === "checkpoint" && decision.action === "live",
  );
  assert.equal(checkpointDecision?.action, "live");
  if (checkpointDecision?.action !== "live") assert.fail("expected a live checkpoint decision");
  assert.deepEqual(checkpointDecision.checkpointReply, reply);
  return reply;
}

describe("checkpointReplies with journal replay and live calls", () => {
  it("continues an ordinary undeclared-agent script by exact checkpoint call identity", async () => {
    const dirs = tempRoot();
    let generation = "source";
    const livePrompts: string[] = [];
    const manager = new WorkflowManager({
      persistenceRoot: dirs.root,
      environmentKey: ENVIRONMENT_KEY,
      agent: {
        async run(prompt) {
          livePrompts.push(prompt);
          return `${generation}:${prompt}`;
        },
      },
    });
    const script = workflow(`
const first = await agent("prefix-one", { label: "prefix-one" })
const second = await agent("prefix-two", { label: "prefix-two" })
const approval = await checkpoint("approve static release", { headless: "pause", default: false })
const after = await agent("after-checkpoint", { label: "after-checkpoint" })
return { first, second, approval, after }`, "ordinary-checkpoint-reply");
    try {
      const paused = await manager.runSync(script);
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);
      assert.deepEqual(livePrompts, ["prefix-one", "prefix-two"]);

      generation = "resumed";
      livePrompts.length = 0;
      const resumed = await manager.runSync(script, undefined, {
        resumeFromRunId: paused.runId,
        checkpointReplies: { [paused.checkpointContext.callIndex]: true },
      });

      assert.equal(resumed.status, "completed");
      assert.equal(resumed.resumeReport?.strategy, "identity-v1");
      assert.equal(resumed.replayEligibility?.predictedReplayablePrefix, 3);
      assert.deepEqual(livePrompts, ["after-checkpoint"]);
      assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), {
        first: "source:prefix-one",
        second: "source:prefix-two",
        approval: true,
        after: "resumed:after-checkpoint",
      });
      assert.deepEqual(resumed.checkpointsTaken, [
        { callIndex: 2, kind: "confirm", decision: true, source: "injected" },
      ]);
      assert.deepEqual(resumed.resumeReport?.checkpointReply, {
        recordedIndex: paused.checkpointContext.callIndex,
        status: "applied",
        callIndex: 2,
      });
      assert.equal(resumed.resumeReport?.calls[2]?.action, "replayed");
      assert.equal(resumed.resumeReport?.calls[2]?.match, "path-hash");
    } finally {
      dirs.cleanup();
    }
  });

  it("does not inject at a different checkpoint call site with identical content", async () => {
    const dirs = tempRoot();
    let source = true;
    const manager = new WorkflowManager({
      persistenceRoot: dirs.root,
      environmentKey: ENVIRONMENT_KEY,
      agent: { async run() { return source ? "source-route" : "diverged-route"; } },
    });
    const script = workflow(`
const route = await agent("choose-route", { label: "choose-route" })
if (route === "source-route") {
  return await checkpoint("approve same text", { headless: "pause", default: false })
}
return await checkpoint("approve same text", { headless: "pause", default: false })`, "checkpoint-site-divergence");
    const changedScript = script.replace('agent("choose-route"', 'agent("choose-route-changed"');
    try {
      const paused = await manager.runSync(script);
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);

      source = false;
      const resumed = await manager.runSync(changedScript, undefined, {
        resumeFromRunId: paused.runId,
        checkpointReplies: { [paused.checkpointContext.callIndex]: true },
      });

      assert.equal(resumed.status, "paused");
      assert.equal(resumed.reason, "checkpoint_required");
      assert.equal(resumed.checkpointsTaken, undefined);
      assert.equal(unappliedReply(resumed).reason, "checkpoint-not-reached-at-recorded-call-site");
    } finally {
      dirs.cleanup();
    }
  });

  it("does not inject when a live prefix changes interpolated checkpoint content", async () => {
    const dirs = tempRoot();
    let generation = "recorded";
    const manager = new WorkflowManager({
      persistenceRoot: dirs.root,
      environmentKey: ENVIRONMENT_KEY,
      agent: { async run() { return `${generation}-artifact`; } },
    });
    const script = workflow(`
const artifact = await agent("produce-artifact", { label: "produce-artifact" })
return await checkpoint(\`approve artifact: \${artifact}\`, { headless: "pause", default: false })`, "checkpoint-input-divergence");
    const changedScript = script.replace('agent("produce-artifact"', 'agent("produce-artifact-changed"');
    try {
      const paused = await manager.runSync(script);
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);

      generation = "changed";
      const resumed = await manager.runSync(changedScript, undefined, {
        resumeFromRunId: paused.runId,
        checkpointReplies: { [paused.checkpointContext.callIndex]: true },
      });

      assert.equal(resumed.status, "paused");
      assert.equal(resumed.checkpointContext?.prompt, "approve artifact: changed-artifact");
      assert.equal(resumed.checkpointsTaken, undefined);
      unappliedReply(resumed);
    } finally {
      dirs.cleanup();
    }
  });

  it("does not inject at an exact call site when the checkpoint input fingerprint changed", async () => {
    const dirs = tempRoot();
    let generation = "recorded";
    const manager = new WorkflowManager({
      persistenceRoot: dirs.root,
      environmentKey: ENVIRONMENT_KEY,
      agent: { async run() { return `${generation}-artifact`; } },
    });
    const script = workflow(`
const artifact = await agent("produce-default", { label: "produce-default" })
return await checkpoint("approve artifact", { headless: "pause", default: artifact })`, "checkpoint-fingerprint-divergence");
    const changedScript = script.replace('agent("produce-default"', 'agent("produce-default-changed"');
    try {
      const paused = await manager.runSync(script);
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);

      generation = "changed";
      const resumed = await manager.runSync(changedScript, undefined, {
        resumeFromRunId: paused.runId,
        checkpointReplies: { [paused.checkpointContext.callIndex]: true },
      });

      assert.equal(resumed.status, "paused");
      assert.equal(resumed.checkpointsTaken, undefined);
      assert.equal(unappliedReply(resumed).reason, "checkpoint-identity-mismatch");
    } finally {
      dirs.cleanup();
    }
  });

  it("injects at the exact static checkpoint after a nondeterministic live prefix", async () => {
    const dirs = tempRoot();
    let generation = "recorded";
    const manager = new WorkflowManager({
      persistenceRoot: dirs.root,
      environmentKey: ENVIRONMENT_KEY,
      agent: { async run() { return `${generation}-state`; } },
    });
    const script = workflow(`
const current = await agent("inspect-current-state", { label: "inspect-current-state" })
const approved = await checkpoint("approve current state", { headless: "pause", default: false })
return { current, approved }`, "checkpoint-exact-after-live");
    const changedScript = script.replace(
      'agent("inspect-current-state"',
      'agent("inspect-current-state-changed"',
    );
    try {
      const paused = await manager.runSync(script);
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);

      generation = "changed";
      const resumed = await manager.runSync(changedScript, undefined, {
        resumeFromRunId: paused.runId,
        checkpointReplies: { [paused.checkpointContext.callIndex]: true },
      });

      assert.equal(resumed.status, "completed");
      assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), {
        current: "changed-state",
        approved: true,
      });
      assert.equal(resumed.resumeReport?.calls[0]?.action, "live");
      assert.equal(resumed.resumeReport?.calls[1]?.action, "replayed");
      assert.equal(resumed.resumeReport?.calls[1]?.match, "path-hash");
      assert.equal(resumed.checkpointsTaken?.[0]?.source, "injected");
    } finally {
      dirs.cleanup();
    }
  });

  it("replays an ordinary source without requiring filesystem declarations", async () => {
    const dirs = tempRoot();
    let liveCalls = 0;
    const manager = new WorkflowManager({
      persistenceRoot: dirs.root,
      environmentKey: ENVIRONMENT_KEY,
      agent: { async run(prompt) { liveCalls++; return `live:${prompt}:${liveCalls}`; } },
    });
    const script = workflow(`
await agent("ordinary-one", { label: "ordinary-one" })
return await agent("ordinary-two", { label: "ordinary-two" })`, "safe-prefix-prediction");
    try {
      const source = await manager.runSync(script);
      assert.equal(source.status, "completed");
      const resumed = await manager.runSync(script, undefined, { resumeFromRunId: source.runId });
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.resumeReport?.strategy, "identity-v1");
      assert.equal(resumed.replayEligibility?.predictedReplayablePrefix, 2);
      assert.equal(resumed.replayEligibility?.replayedPrefix, 2);
      assert.equal(resumed.resumeReport?.replayed, 2);
      assert.equal(resumed.resumeReport?.live, 0);
      assert.equal(liveCalls, 2);
    } finally {
      dirs.cleanup();
    }
  });
});
