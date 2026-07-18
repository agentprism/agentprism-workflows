import test from "node:test";
import assert from "node:assert/strict";

import type {
  WorkflowReplayEligibility,
  WorkflowRunFallback,
  WorkflowRunResult,
} from "@automatalabs/shared-types";

import { toWorkflowToolResult, workflowToolOutputShape } from "../src/workflow-tool-output.js";

const replayEligibility = {
  strategy: "positional-v1",
  sourceRunId: "source-run",
  fallbackReason: "inputs-format-legacy",
  eligibility: "legacy",
  predictedReplayablePrefix: 2,
  replayedPrefix: 0,
  replayed: 0,
  live: 0,
  failed: 0,
  sourceEngineVersion: "0.26.0",
  currentEngineVersion: "0.27.0",
  engineVersionComparison: "different",
  sourceInputsFormat: 1,
  currentInputsFormat: 2,
  provenanceChanges: [{
    field: "runtime.node",
    source: "v24.16.0",
    current: "v24.17.1",
    detail: "source recorded runtime.node=v24.16.0; this run: v24.17.1",
  }],
  operationalChanges: [{
    option: "agentTimeoutMs",
    source: 900_000,
    current: null,
    detail: "source recorded agentTimeoutMs=900000; this run: none",
  }],
} as const satisfies WorkflowReplayEligibility;

const baseRun: WorkflowRunResult<null> = {
  runId: "continuation-schema-run",
  status: "completed",
  meta: { name: "continuation-schema", description: "MCP continuation fallback schema" },
  result: null,
  phases: [],
  agentCount: 0,
  durationMs: 0,
  logs: [],
  replayEligibility,
  effectiveLimits: {
    maxAgents: 50,
    tokenBudget: 100_000,
    concurrency: 3,
    agentRetries: 2,
    agentTimeoutMs: 45_000,
  },
};

const resources = {
  scriptSource: "inline" as const,
  scriptUri: "workflow://runs/continuation-schema-run/script",
};

test("resolved run limits survive MCP run-result projection and schema parsing", () => {
  const projected = toWorkflowToolResult(baseRun, resources);
  const parsed = workflowToolOutputShape.safeParse(projected);

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.message);
  assert.deepEqual(projected.limits, baseRun.effectiveLimits);
  assert.deepEqual(parsed.data.limits, baseRun.effectiveLimits);
  assert.deepEqual(projected.replayEligibility, replayEligibility);
  assert.deepEqual(parsed.data.replayEligibility, replayEligibility);
});

test("continuation fallbacks survive MCP tool-result projection and schema parsing", () => {
  const fallbacks = [
    {
      callIndex: 0,
      label: "resume-continuation",
      requestedSpec: "codex/gpt",
      backendId: "codex",
      kind: "continuation",
      message: "continuation: reattached via session/resume",
      continuation: { outcome: "reattached", method: "resume" },
    },
    {
      callIndex: 1,
      label: "load-continuation",
      phase: "Recover",
      requestedSpec: "claude/sonnet",
      backendId: "claude",
      kind: "continuation",
      message: "continuation: reattached via session/load",
      continuation: { outcome: "reattached", method: "load" },
    },
    {
      callIndex: 2,
      label: "skipped-continuation",
      requestedSpec: "opencode/model",
      kind: "continuation",
      message: "continuation skipped (runner-declined) — running fresh",
      continuation: { outcome: "skipped", reason: "runner-declined" },
    },
  ] as const satisfies readonly WorkflowRunFallback[];

  for (const fallback of fallbacks) {
    const projected = toWorkflowToolResult({ ...baseRun, fallbacks: [fallback] }, resources);
    const parsed = workflowToolOutputShape.safeParse(projected);

    assert.equal(parsed.success, true);
    if (!parsed.success) assert.fail(parsed.error.message);
    assert.deepEqual(parsed.data, projected);
    assert.deepEqual(parsed.data.fallbacks, [fallback]);
  }
});

test("fallback schema remains flat and permissive across continuation detail correlation", () => {
  const fallbacks = [
    {
      callIndex: 3,
      label: "legacy-model",
      requestedSpec: "default",
      kind: "model",
      message: "using the session default",
    },
    {
      callIndex: 4,
      label: "continuation-without-detail",
      requestedSpec: "codex/gpt",
      kind: "continuation",
      message: "accepted without continuation detail",
    },
    {
      callIndex: 5,
      label: "model-with-continuation-detail",
      requestedSpec: "codex/gpt",
      kind: "model",
      message: "accepted with continuation detail on a model fallback",
      continuation: { outcome: "skipped", reason: "hash-mismatch" },
    },
  ] as const satisfies readonly WorkflowRunFallback[];

  for (const fallback of fallbacks) {
    const projected = toWorkflowToolResult({ ...baseRun, fallbacks: [fallback] }, resources);
    const parsed = workflowToolOutputShape.safeParse(projected);

    assert.equal(parsed.success, true);
    if (!parsed.success) assert.fail(parsed.error.message);
    assert.deepEqual(parsed.data, projected);
    assert.deepEqual(parsed.data.fallbacks, [fallback]);
  }
});
