import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";

const SCRIPT = `export const meta = { name: 'fallbacks', description: 'fallbacks', phases: [{ title: 'Review' }] }
const first = await agent('one', { label: 'whole', model: 'missing-model' })
const second = await agent('two', { label: 'modifier', phase: 'Review', model: 'gpt-example[high]' })
const decision = await checkpoint('Release?', { kind: 'confirm', default: false })
return { first, second, decision }`;

function fallbackRunner(): AgentRunner {
  let call = 0;
  return {
    run: (async (_prompt: string, options: RunOptions = {}) => {
      options.onSessionOpen?.({
        sessionId: `session-${call}`,
        backendId: "codex",
        cwd: "/workspace",
        reopen: { load: true, resume: true, list: true },
      });
      if (call === 0) {
        options.onModelFallback?.("missing-model");
      } else {
        options.onModelResolved?.("gpt-example");
        const descriptor = 'gpt-example[high]: reasoning_effort "high" not advertised';
        options.onModelFallback?.(descriptor);
        options.onModelFallback?.(descriptor);
      }
      call++;
      return "ok";
    }) as AgentRunner["run"],
  };
}

test("run result records compatibility fallback callbacks without parsing modifier prose", async () => {
  const result = await runWorkflow(SCRIPT, { agent: fallbackRunner(), persistLogs: false });

  assert.deepEqual(result.fallbacks, [
    {
      callIndex: 0,
      label: "whole",
      phase: "Review",
      requestedSpec: "missing-model",
      backendId: "codex",
      kind: "model",
      message: 'whole: model "missing-model" unavailable — using the session default',
    },
    {
      callIndex: 1,
      label: "modifier",
      phase: "Review",
      requestedSpec: "gpt-example[high]",
      backendId: "codex",
      kind: "model",
      message:
        'modifier: model "gpt-example[high]: reasoning_effort "high" not advertised" unavailable — using the session default',
    },
  ]);
  assert.equal(
    result.logs[0],
    "agent timeout admission: total-wall ceiling none; idle ceiling disabled; each retry re-arms both clocks",
  );
  assert.deepEqual(result.logs.slice(1, 3), result.fallbacks?.map((entry) => entry.message));
  assert.equal(result.logs.length, 4, "deduplication does not change the existing log channel");
});

test("manager persists fallback observability and replay-only executions omit it", async () => {
  const persistenceRoot = mkdtempSync(join(tmpdir(), "agentprism-result-observability-"));
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-result-observability-cwd-"));
  try {
    const manager = new WorkflowManager({ cwd, persistenceRoot, agent: fallbackRunner() });
    const first = await manager.runSync(SCRIPT);
    assert.equal(first.status, "completed");
    assert.equal(first.fallbacks?.length, 2);

    const persisted = manager.getPersistence().load(first.runId);
    assert.deepEqual(persisted?.fallbacks, first.fallbacks);
    assert.deepEqual(persisted?.checkpointsTaken, [
      { callIndex: 2, kind: "confirm", decision: false, source: "headless-default" },
    ]);

    let replayCalls = 0;
    const replay = new WorkflowManager({
      cwd,
      persistenceRoot,
      agent: {
        async run() {
          replayCalls++;
          return "unexpected";
        },
      },
    });
    const resumeJournal = new Map((persisted?.journal ?? []).map((entry) => [entry.index, entry] as const));
    const replayed = await replay.runSync(SCRIPT, undefined, { resumeJournal });
    assert.equal(replayed.status, "completed");
    assert.equal(replayCalls, 0);
    assert.equal(replayed.fallbacks, undefined, "fallback entries arise only from live calls in this execution");
    assert.deepEqual(replayed.checkpointsTaken, [
      { callIndex: 2, kind: "confirm", decision: false, source: "journal-replay" },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
