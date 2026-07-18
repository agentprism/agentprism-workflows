import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner } from "@automatalabs/shared-types";
import {
  AGENTPRISM_PERSISTENCE_ROOT_ENV,
  RESUME_DISABLED_REASONS,
  RESUME_FALLBACK_REASONS,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager,
  runDynamicWorkflow,
  type ResumePolicy,
  type WorkflowReplayEligibility,
  type WorkflowResumeReport,
} from "../src/index.js";

const ENVIRONMENT_KEY = "incremental-sdk-v1";
const script = (body: string, name = "incremental-sdk") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "SDK resume" }\n${body}`;

function stringRunner(run: (prompt: string) => string): AgentRunner {
  return { async run(prompt) { return run(prompt) as never; } };
}

function dirs(): { cwd: string; root: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "incremental-sdk-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "incremental-sdk-root-"));
  return {
    cwd,
    root,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const SAFE_SCRIPT = script(`
const values = await parallel([
  () => agent("one", { label: "one", resume: { filesystem: "read-only" } }),
  () => agent("two", { label: "two", resume: { filesystem: "read-only" } }),
])
return values`, "sdk-safe");

describe("incremental resume SDK surface", () => {
  it("passes resumeFromRunId and resumePolicy through runDynamicWorkflow", async () => {
    const paths = dirs();
    const previousRoot = process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
    process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV] = paths.root;
    try {
      const source = await runDynamicWorkflow(SAFE_SCRIPT, {
        cwd: paths.cwd,
        runner: stringRunner((prompt) => `source:${prompt}`),
        exec: { environmentKey: ENVIRONMENT_KEY },
      });
      const live: string[] = [];
      const resumed = await runDynamicWorkflow(SAFE_SCRIPT, {
        cwd: paths.cwd,
        runner: stringRunner((prompt) => { live.push(prompt); return `live:${prompt}`; }),
        exec: {
          environmentKey: ENVIRONMENT_KEY,
          resumeFromRunId: source.runId,
          resumePolicy: "auto",
        },
      });
      assert.deepEqual(live, []);
      assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), ["source:one", "source:two"]);
      assert.equal(resumed.resumeReport?.strategy, "identity-v1");
      assert.equal(resumed.resumeReport?.replayed, 2);

      await assert.rejects(
        runDynamicWorkflow(SAFE_SCRIPT, {
          cwd: paths.cwd,
          runner: stringRunner(() => "unused"),
          exec: { resumePolicy: "auto" },
        }),
        (error: unknown) =>
          error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      );
    } finally {
      if (previousRoot === undefined) delete process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
      else process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV] = previousRoot;
      paths.cleanup();
    }
  });

  it("keeps same-run resume positional, report-free, and permanently legacy-marked", async () => {
    const paths = dirs();
    try {
      const runner = stringRunner((prompt) => `source:${prompt}`);
      const manager = new WorkflowManager({
        cwd: paths.cwd,
        persistenceRoot: paths.root,
        environmentKey: ENVIRONMENT_KEY,
        agent: runner,
      });
      const paused = await manager.runSync(script(`
const one = await agent("one", { label: "one", resume: { filesystem: "read-only" } })
const approval = await checkpoint("approve", { headless: "pause" })
return { one, approval }`, "same-run"));
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);

      await assert.rejects(
        manager.resumeInBackground(paused.runId, { resumePolicy: "auto" }),
        (error: unknown) =>
          error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      );
      const resumed = await manager.resumeInBackground(paused.runId, {
        checkpointReplies: { [paused.checkpointContext.callIndex]: true },
      });
      assert.equal(resumed.accepted, true);
      if (!resumed.accepted) assert.fail("same-run resume should be accepted");
      const result = await resumed.promise;
      assert.equal(result.status, "completed");
      assert.equal(result.resumeReport, undefined);
      assert.equal(manager.getPersistence().load(paused.runId)?.legacyResume, true);
    } finally {
      paths.cleanup();
    }
  });

  it("re-exports the policy, report, and frozen reason constants", () => {
    const policy: ResumePolicy = "auto";
    const report: WorkflowResumeReport = {
      strategy: "identity-v1",
      sourceRunId: "source",
      requestedPolicy: policy,
      replayed: 0,
      live: 0,
      failed: 0,
      calls: [],
    };
    const eligibility: WorkflowReplayEligibility = {
      strategy: "identity-v1",
      sourceRunId: "source",
      predictedReplayablePrefix: 0,
      replayedPrefix: 0,
      replayed: 0,
      live: 0,
      failed: 0,
      currentEngineVersion: "0.27.0",
      engineVersionComparison: "source-unknown",
      currentInputsFormat: 2,
      provenanceChanges: [],
      operationalChanges: [],
    };
    assert.equal(report.requestedPolicy, "auto");
    assert.equal(eligibility?.strategy, "identity-v1");
    assert.deepEqual(RESUME_FALLBACK_REASONS, [
      "legacy-recording",
      "crash-residue",
      "inputs-format-legacy",
      "forced-positional",
      "unsafe-recording",
      "nested-workflows",
      "legacy-resume",
    ]);
    assert.ok(RESUME_DISABLED_REASONS.includes("resume-seed-invalid"));
  });
});
