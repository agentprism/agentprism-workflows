// End-to-end isolation smoke over the real default ACP backend. The normal workspace suite is
// credential-free: opt in explicitly, then a missing/invalid backend credential fails loudly.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunPersistence } from "@automatalabs/workflow-engine";
import { createAcpRunner, runIsolation, WorkflowManager } from "../src/index.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const ENVIRONMENT_KEY = "workflows-isolation-live-e2e";

const SCRIPT = `export const meta = { name: "isolation-live", description: "two-step live smoke" }
const first = await agent("Reply with exactly: held-one", { label: "step-1" })
return await agent("Reply with exactly: held-two. Prior step: " + first, { label: "step-2" })`;

test(
  "default ACP backend records two steps and isolates step 2 with sealed evidence",
  { skip: LIVE ? false : "gated live isolation e2e — set AGENTPRISM_LIVE_E2E=1 with backend credentials" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "automatalabs-isolation-live-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "automatalabs-isolation-live-cwd-"));
    const runner = createAcpRunner();
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      environmentKey: ENVIRONMENT_KEY,
      agent: runner,
    });
    try {
      const baseline = await manager.runSync(SCRIPT, undefined, {
        runId: "isolation-live-baseline",
        maxAgents: 10,
        tokenBudget: null,
        concurrency: 1,
        agentRetries: 0,
        agentTimeoutMs: null,
        environmentKey: ENVIRONMENT_KEY,
      });
      assert.equal(baseline.status, "completed");
      assert.equal(baseline.calls?.length, 2);

      const modelOverride =
        process.env.AGENTPRISM_ISOLATION_E2E_MODEL ??
        "claude/sonnet";
      const isolated = await runIsolation({
        baselineRunId: baseline.runId,
        live: [{ label: "step-2", model: modelOverride }],
        runner,
        cwd,
        persistenceRoot: root,
        environmentKey: ENVIRONMENT_KEY,
      });

      assert.equal(isolated.status, "completed");
      const served = isolated.report.calls.find((row) => row.mode === "served");
      const target = isolated.report.calls.find((row) => row.mode === "live-target");
      assert.equal(served?.label, "step-1");
      assert.equal(target?.label, "step-2");
      assert.ok(target?.resolvedModel, "live target must carry sealed resolved-model evidence");
      assert.ok(target.liveUsage, "live target must carry sealed provider usage");

      const artifact = createRunPersistence(cwd, undefined, { persistenceRoot: root }).load(
        isolated.report.isolationRunId,
      );
      assert.equal(artifact?.executionMode?.kind, "isolation");
      assert.equal(artifact?.executionMode?.baselineRunId, baseline.runId);
      assert.equal(artifact?.calls?.find((row) => row.label === "step-1")?.provenance?.source, "replay");
      assert.equal(artifact?.calls?.find((row) => row.label === "step-2")?.provenance?.source, "live");
      assert.deepEqual(artifact?.replayReport, isolated.report);
    } finally {
      manager.dispose();
      await runner.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
