import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  AgentHistoryEntry,
  AgentResultProvenance,
  AgentUsage,
  RunOptions,
  WorkflowCallRecord,
} from "@automatalabs/shared-types";
import { runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const script = `export const meta = { name: 'settlement', description: 'settlement tests' }
return await agent('work', { label: 'work' })`;

const usage = (total: number): AgentUsage => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost: total / 100,
});

describe("guarded exactly-once settlement", () => {
  it("swallows terminal observer throws, preserves success, and orders observers", async () => {
    const order: string[] = [];
    let runs = 0;
    const logs: string[] = [];
    const result = await runWorkflow(script, {
      agent: {
        async run() {
          runs++;
          return "ok";
        },
      },
      agentRetries: 2,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onCallRecord: () => order.push("record"),
      onAgentJournal: () => order.push("journal"),
      onAgentEnd: () => {
        order.push("end");
        throw new Error("end observer exploded");
      },
    });

    assert.equal(result.result, "ok");
    assert.equal(runs, 1);
    assert.deepEqual(order, ["record", "journal", "end"]);
    assert.equal(result.calls?.length, 1);
    assert.ok(logs.some((line) => line.includes("onAgentEnd terminal observer failed")));
  });

  it("keeps the engine-owned row when onCallRecord throws", async () => {
    let delivered = 0;
    const result = await runWorkflow(script, {
      agent: { async run() { return "ok"; } },
      persistLogs: false,
      onCallRecord: () => {
        delivered++;
        throw new Error("record observer exploded");
      },
    });
    assert.equal(delivered, 1);
    assert.equal(result.calls?.length, 1);
    assert.equal(result.calls?.[0].outcome, "result");
  });

  it("does not let a terminal onProgress throw retry or fail a managed success", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "settlement-progress-"));
    const root = mkdtempSync(join(tmpdir(), "settlement-progress-root-"));
    try {
      let runs = 0;
      const manager = new WorkflowManager({
        cwd,
        persistenceRoot: root,
        agent: { async run() { runs++; return "ok"; } },
      });
      let threw = false;
      const result = await manager.runSync(script, undefined, {
        agentRetries: 2,
        onProgress: (snapshot) => {
          if (snapshot.doneCount === 1 && !threw) {
            threw = true;
            throw new Error("terminal progress exploded");
          }
        },
      });
      assert.equal(result.status, "completed");
      assert.equal(result.result, "ok");
      assert.equal(runs, 1);
      assert.equal(result.calls?.length, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the last valid cumulative usage snapshot, copies at receipt, and sums attempts", async () => {
    let invocation = 0;
    let terminal: WorkflowCallRecord | undefined;
    const result = await runWorkflow(script, {
      agentRetries: 1,
      persistLogs: false,
      agent: {
        async run(_prompt, options) {
          invocation++;
          if (invocation === 1) {
            const mutable = usage(3);
            options?.onUsage?.(usage(1));
            options?.onUsage?.(mutable);
            mutable.total = 300;
            mutable.input = 300;
            return "";
          }
          options?.onUsage?.(usage(4));
          options?.onUsage?.({ ...usage(9), cost: Number.NaN });
          options?.onUsage?.({ ...usage(9), input: -1 });
          return "ok";
        },
      },
      onCallRecord: (row) => { terminal = row; },
    });

    assert.equal(result.result, "ok");
    assert.deepEqual(terminal?.usage, {
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 7,
      cost: 0.07,
    });
    assert.equal(terminal?.attempts, 2);
  });
});
