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

  it("seals timed-out attempts, aborts only their signal, and drops late telemetry", async () => {
    const histories: AgentHistoryEntry[][] = [];
    const ends: Array<{
      usage?: AgentUsage;
      modelResolved?: string;
      provenance?: AgentResultProvenance;
      modelFallbacks?: string[];
    }> = [];
    const attemptSignals: AbortSignal[] = [];
    let invocation = 0;
    const result = await runWorkflow(script, {
      runId: "timeout-seal",
      agentRetries: 1,
      agentTimeoutMs: 10,
      persistLogs: false,
      agent: {
        async run(_prompt: string, options?: RunOptions) {
          invocation++;
          assert.ok(options?.signal);
          attemptSignals.push(options.signal);
          if (invocation === 1) {
            return await new Promise<string>(() => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  options.onUsage?.(usage(1000));
                  options.onModelResolved?.("late-model");
                  options.onModelFallback?.("late-fallback");
                  options.onResultProvenance?.({ source: "replay", recordedIndex: 99 });
                  options.onHistory?.([{ role: "assistant", kind: "text", text: "late" }]);
                },
                { once: true },
              );
            });
          }
          options.onUsage?.(usage(5));
          options.onModelResolved?.("sealed-model");
          options.onModelFallback?.("kept-fallback");
          options.onResultProvenance?.({ source: "live", overrideModel: "candidate" });
          options.onHistory?.([{ role: "assistant", kind: "text", text: "kept" }]);
          return "ok";
        },
      },
      onAgentHistory: (event) => histories.push(event.history),
      onAgentEnd: (event) => ends.push(event),
    });

    assert.equal(result.result, "ok");
    assert.equal(attemptSignals.length, 2);
    assert.equal(attemptSignals[0].aborted, true);
    assert.equal(attemptSignals[1].aborted, false);
    assert.deepEqual(histories, [[{ role: "assistant", kind: "text", text: "kept" }]]);
    assert.deepEqual(ends[0].usage, usage(5));
    assert.equal(ends[0].modelResolved, "sealed-model");
    assert.deepEqual(ends[0].modelFallbacks, ["kept-fallback"]);
    assert.deepEqual(ends[0].provenance, { source: "live", overrideModel: "candidate" });
    assert.equal(result.calls?.[0].modelResolved, "sealed-model");
    assert.equal(result.calls?.[0].modelFallback, true);
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
