import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const FIXTURE = new URL("./fixtures/legacy-0.23-chained.json", import.meta.url);

test("a markerless 0.23 chained journal accepts persisted ancestors but excludes nested scopes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "legacy-chain-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "legacy-chain-runs-"));
  let liveCalls = 0;
  const manager = new WorkflowManager({
    cwd,
    persistenceRoot,
    environmentKey: "legacy-chain-current",
    agent: {
      async run(prompt) {
        liveCalls++;
        return `live:${prompt}`;
      },
    },
  });
  try {
    const source = JSON.parse(readFileSync(FIXTURE, "utf8")) as PersistedRunState;
    const legacyFixture = readFileSync(FIXTURE, "utf8");
    assert.match(legacyFixture, /"tokenBudget"/);
    assert.match(legacyFixture, /"budgetDebit"/);
    assert.match(legacyFixture, /"logicalBudgetDebit"/);
    const ancestorRunId = source.journal?.[0]?.scope;
    assert.equal(typeof ancestorRunId, "string");
    source.effectiveCwd = cwd;
    source.calls = source.calls?.map((call) => ({ ...call, scope: ancestorRunId }));
    source.journal?.push({
      index: 0,
      hash: "f".repeat(64),
      result: "nested collision must not win",
      kind: "agent",
      scope: `${source.runId}-nested1`,
      call: { kind: "agent", label: "nested" },
    });
    source.calls?.push({
      index: 0,
      kind: "agent",
      hash: "f".repeat(64),
      outcome: "result",
      origin: "runner",
      scope: `${source.runId}-nested1`,
    });
    const ancestor: PersistedRunState = {
      ...structuredClone(source),
      runId: ancestorRunId,
      journal: [],
      calls: [],
      callsAllocated: 0,
      result: null,
    };
    const persistence = manager.getPersistence();
    persistence.save(ancestor);
    persistence.save(source);
    const uncountedList = persistence.list.bind(persistence);
    let listCalls = 0;
    persistence.list = () => {
      listCalls++;
      return uncountedList();
    };

    const replayed = await manager.runSync(source.script, source.args, {
      runId: "legacy-chain-target",
      resumeFromRunId: source.runId,
    });
    assert.equal(listCalls, 1, "positional preparation scans persisted run IDs exactly once");
    assert.equal(replayed.status, "completed");
    assert.equal(liveCalls, 0);
    assert.equal(replayed.resumeReport?.strategy, "positional-v1");
    if (replayed.resumeReport?.strategy === "positional-v1") {
      assert.equal(replayed.resumeReport.fallbackReason, "legacy-recording");
      assert.equal(replayed.resumeReport.eligibility, "legacy");
    }
    assert.equal(replayed.resumeReport?.replayed, 3);
    assert.equal(replayed.replayEligibility?.predictedReplayablePrefix, 3);
    assert.equal(replayed.replayEligibility?.replayedPrefix, 3);
    assert.equal(replayed.replayEligibility?.engineVersionComparison, "source-unknown");
    assert.equal(replayed.replayEligibility?.sourceInputsFormat, 1);
    assert.equal(replayed.replayEligibility?.currentInputsFormat, 2);
    assert.deepEqual(replayed.replayEligibility?.operationalChanges, []);
    const persisted = persistence.load("legacy-chain-target");
    assert.equal(persisted?.runtime?.inputsFormat, 2);
    assert.ok(persisted?.runtime?.engineVersion);
    assert.ok(persisted?.journal?.every((entry) => entry.scope === "legacy-chain-target"));
    assert.equal(persisted?.calls?.some((call) => Object.hasOwn(call, "budgetDebit")), false);
    assert.equal(
      persisted?.calls?.some((call) => Object.hasOwn(call.replay ?? {}, "logicalBudgetDebit")),
      false,
    );
    assert.equal(Object.hasOwn(persisted?.limits ?? {}, "tokenBudget"), false);
    const rewritten = readFileSync(join(persistence.getRunsDir(), "legacy-chain-target.json"), "utf8");
    assert.doesNotMatch(rewritten, /"tokenBudget"|"budgetDebit"|"logicalBudgetDebit"/);

    assert.equal(persistence.delete(ancestorRunId), true);
    listCalls = 0;
    const missingAncestor = await manager.runSync(source.script, source.args, {
      runId: "legacy-chain-missing-ancestor",
      resumeFromRunId: source.runId,
    });
    assert.equal(listCalls, 1, "each positional admission performs one persisted-run scan");
    assert.equal(liveCalls, 3, "an absent ancestor remains conservatively ineligible");
    assert.equal(missingAncestor.resumeReport?.replayed, 0);
    assert.deepEqual(
      missingAncestor.resumeReport?.calls.map((decision) =>
        decision.action === "live" ? decision.reason : decision.action),
      ["positional-miss", "positional-suffix", "positional-suffix"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
