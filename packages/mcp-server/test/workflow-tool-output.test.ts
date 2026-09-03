import test from "node:test";
import assert from "node:assert/strict";

import type { WorkflowRunFallback, WorkflowRunResult } from "@automatalabs/shared-types";

import { toWorkflowToolResult, workflowToolOutputShape } from "../src/workflow-tool-output.js";

const baseRun: WorkflowRunResult<null> = {
  runId: "continuation-schema-run",
  status: "completed",
  meta: { name: "continuation-schema", description: "MCP continuation fallback schema" },
  result: null,
  phases: [],
  agentCount: 0,
  durationMs: 0,
  logs: [],
  effectiveLimits: {
    maxAgents: 50,
    concurrency: 3,
    agentRetries: 2,
  },
};

const resources = {
  scriptSource: "inline" as const,
  scriptUri: "workflow://runs/continuation-schema-run/script",
  resultUri: "workflow://runs/continuation-schema-run/result",
  eventsUri: "workflow://runs/continuation-schema-run/events",
};

test("resolved run limits survive MCP run-result projection and schema parsing", () => {
  const projected = toWorkflowToolResult(baseRun, resources);
  const parsed = workflowToolOutputShape.safeParse(projected);

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.message);
  assert.deepEqual(projected.limits, baseRun.effectiveLimits);
  assert.deepEqual(parsed.data.limits, baseRun.effectiveLimits);
  assert.equal(projected.resultUri, resources.resultUri);
  assert.equal(projected.eventsUri, resources.eventsUri);
});

test("result URI projection is restricted to completed workflow outcomes", () => {
  const projected = toWorkflowToolResult(
    { ...baseRun, status: "paused", result: undefined },
    resources,
  );
  assert.equal(projected.resultUri, undefined);
  assert.equal(workflowToolOutputShape.safeParse(projected).success, true);
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
