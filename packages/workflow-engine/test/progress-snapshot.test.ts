import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowManager } from "../src/workflow-manager.js";
import type { WorkflowSnapshot } from "../src/display.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// onProgress hands consumers the live snapshot. The manager's mutation sites only touch
// `snapshot.agents`, so the derived counters (agentCount/runningCount/doneCount/errorCount)
// must be recomputed before every emission — they used to stay frozen at their initial 0s,
// making hosts render "0/0 agents" for the whole run.

const TWO_AGENT_SCRIPT = `export const meta = { name: 'p', description: 'progress' }
const a = await agent('one', { label: 'first' })
const b = await agent('two', { label: 'second' })
return [a, b]`;

test("onProgress snapshots carry live agent counters, not frozen 0s", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "wf-progress-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
    const seen: Array<Pick<WorkflowSnapshot, "agentCount" | "runningCount" | "doneCount" | "errorCount">> = [];
    const runningLabels: string[] = [];
    const manager = new WorkflowManager({
      agent: { run: async () => "ok" },
    });
    const result = await manager.runSync(TWO_AGENT_SCRIPT, undefined, {
      journaling: false,
      onProgress: (snapshot) => {
        seen.push({
          agentCount: snapshot.agentCount,
          runningCount: snapshot.runningCount,
          doneCount: snapshot.doneCount,
          errorCount: snapshot.errorCount,
        });
        for (const agent of snapshot.agents) {
          if (agent.status === "running" && !runningLabels.includes(agent.label)) {
            runningLabels.push(agent.label);
          }
        }
      },
    });

    assert.equal(result.status, "completed");
    assert.ok(seen.length > 0, "onProgress fired");

    // While an agent runs, the counters must reflect it (this was the frozen-0s bug).
    assert.ok(
      seen.some((s) => s.runningCount === 1 && s.agentCount >= 1),
      "some snapshot shows a running agent in the counters",
    );
    // The running agents are identifiable by label through snapshot.agents.
    assert.deepEqual(runningLabels, ["first", "second"]);

    // The last emission has both agents settled.
    const last = seen[seen.length - 1];
    assert.equal(last.agentCount, 2);
    assert.equal(last.doneCount, 2);
    assert.equal(last.runningCount, 0);
    assert.equal(last.errorCount, 0);
    });
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
