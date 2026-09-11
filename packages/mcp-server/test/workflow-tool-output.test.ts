import test from "node:test";
import assert from "node:assert/strict";

import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { WorkflowRunFallback, WorkflowRunResult } from "@automatalabs/shared-types";

import { toWorkflowExecutionOutcome, workflowToolOutputShape } from "../src/workflow-tool-output.js";

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

function observation(outcome?: ReturnType<typeof toWorkflowExecutionOutcome>) {
  return {
    runId: baseRun.runId, status: outcome?.status ?? "running", scriptUri: resources.scriptUri,
    eventsUri: resources.eventsUri, workflowName: baseRun.meta.name, phases: [], calls: [],
    logTail: { lines: [], totalLines: 0, omittedLines: 0, truncatedLines: 0, redactedLines: 0 },
    filter: { lastN: 20, logLines: 20 },
    truncation: {
      maxStructuredBytes: 24576, byteCapApplied: false,
      phases: { total: 0, returned: 0, shortened: 0 },
      logs: { total: 0, returned: 0, shortened: 0, redacted: 0 },
      calls: { total: 0, matched: 0, returned: 0, shortenedResults: 0, redactedResults: 0 },
    },
    ...(outcome ? { outcome } : {}),
  };
}

test("resolved run limits survive terminal status outcome projection", () => {
  const projected = toWorkflowExecutionOutcome(baseRun, resources);
  const parsed = workflowToolOutputShape.safeParse(observation(projected));

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.message);
  assert.deepEqual(projected.limits, baseRun.effectiveLimits);
  assert.deepEqual(parsed.data.outcome?.limits, baseRun.effectiveLimits);
  assert.equal(projected.resultUri, resources.resultUri);
  assert.equal(projected.eventsUri, resources.eventsUri);
});

test("result URI projection is restricted to completed workflow outcomes", () => {
  const projected = toWorkflowExecutionOutcome(
    { ...baseRun, status: "paused", result: undefined },
    resources,
  );
  assert.equal(projected.resultUri, undefined);
  assert.equal(workflowToolOutputShape.safeParse(observation(projected)).success, true);
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
    const projected = toWorkflowExecutionOutcome({ ...baseRun, fallbacks: [fallback] }, resources);
    const parsed = workflowToolOutputShape.safeParse(observation(projected));

    assert.equal(parsed.success, true);
    if (!parsed.success) assert.fail(parsed.error.message);
    assert.deepEqual(parsed.data.outcome, projected);
    assert.deepEqual(parsed.data.outcome?.fallbacks, [fallback]);
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
    const projected = toWorkflowExecutionOutcome({ ...baseRun, fallbacks: [fallback] }, resources);
    const parsed = workflowToolOutputShape.safeParse(observation(projected));

    assert.equal(parsed.success, true);
    if (!parsed.success) assert.fail(parsed.error.message);
    assert.deepEqual(parsed.data.outcome, projected);
    assert.deepEqual(parsed.data.outcome?.fallbacks, [fallback]);
  }
});


test("runtime and published schemas isolate acceptance, setup, observation, and exact-result branches", async () => {
  const published = await workflowToolOutputShape["~standard"].jsonSchema.output({ target: "draft-2020-12" });
  const validate = new AjvJsonSchemaValidator().getValidator(published as JsonSchemaType);
  const accepted = {
    action: "run", accepted: true, runId: baseRun.runId,
    status: "running", scriptSource: "inline", scriptUri: resources.scriptUri,
    eventsUri: resources.eventsUri, limits: baseRun.effectiveLimits,
  };
  const resumed = { ...accepted, action: "resume", scriptSource: "stored", continuation: { generation: 1, replayedPrefix: 0 } };
  const setupRequest = {
    id: "00000000-0000-4000-8000-000000000001", kind: "backend-approval",
    title: "Approve workflow backend", message: "Approve the custom command", requestedSchema: {
      type: "object", properties: { approve: { type: "boolean" } }, required: ["approve"], additionalProperties: false,
    },
  };
  const setup = { action: "setup-response", runId: baseRun.runId, setupId: setupRequest.id, status: "pending", scriptUri: resources.scriptUri };
  const config = { action: "config", ok: true, harnessOptions: [], omittedHarnesses: 0, models: [], authoringSummary: { harnesses: [], omittedHarnesses: 0 } };
  const result = { action: "result", runId: baseRun.runId, status: "completed", resultUri: resources.resultUri, mimeType: "application/json", encoding: "utf-8", totalBytes: 2, offset: 0, endOffset: 2, hasMore: false, chunk: "42" };
  const terminal = observation(toWorkflowExecutionOutcome(baseRun, resources));
  const stopped = { ...observation(), status: "aborted", stopped: true, alreadyTerminal: false };
  const pendingStop = { ...observation(), stopped: false, alreadyTerminal: false, control: { state: "pending", operationId: setupRequest.id, requestedAt: "2026-09-08T12:00:00Z" } };
  const valid = {
    accepted, resumed, config, result, terminal, running: observation(), stopped, pendingStop, setup,
    preparing: { ...accepted, setup: { state: "preparing" } },
    waiting: { ...observation(), setup: { state: "input-required", request: setupRequest } },
    "parked acceptance": { ...accepted, status: "pending", setup: { state: "input-required", request: setupRequest } },
  };
  for (const [name, input] of Object.entries(valid)) {
    assert.equal(workflowToolOutputShape.safeParse(input).success, true, `${name} runtime`);
    assert.equal(validate(input).valid, true, `${name} published`);
  }
  const without = (value: Record<string, unknown>, field: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
  const invalid: Record<string, Record<string, unknown>> = {
    "old foreground result": { ...toWorkflowExecutionOutcome(baseRun, resources), scriptSource: "inline" },
    "old background acceptance": { runId: baseRun.runId, status: "running", scriptSource: "inline", scriptUri: resources.scriptUri, eventsUri: resources.eventsUri, limits: baseRun.effectiveLimits },
    "retired requestId": { ...accepted, requestId: "retry-1" },
    "retired duplicate receipt": { ...accepted, duplicate: true },
    "missing eventsUri": without(accepted, "eventsUri"),
    "missing limits": without(accepted, "limits"),
    "acceptance carries immediate result": { ...accepted, result: 42 },
    "settled acceptance carries resultUri": { ...accepted, status: "completed", resultUri: resources.resultUri },
    "run carries continuation": { ...accepted, continuation: { generation: 1, replayedPrefix: 0 } },
    "resume lacks continuation": without(resumed, "continuation"),
    "resume has arbitrary continuation": { ...resumed, continuation: { arbitrary: true } },
    "running outcome": { ...observation(), outcome: terminal.outcome },
    "terminal missing outcome": without(terminal, "outcome"),
    "result missing chunk": without(result, "chunk"),
    "result carries scriptUri": { ...result, scriptUri: resources.scriptUri },
    "config carries runId": { ...config, runId: baseRun.runId },
    "obsolete agent configuration setup": { ...accepted, setup: { state: "input-required", request: { ...setupRequest, kind: "agent-configuration" } } },
    "waiting missing request": { ...accepted, setup: { state: "input-required" } },
    "preparing carries request": { ...accepted, setup: { state: "preparing", request: setupRequest } },
    "setup response without setupId": without(setup, "setupId"),
    "pending stop claims completion": { ...pendingStop, stopped: true },
    "stopped carries outcome": { ...stopped, outcome: terminal.outcome },
    "retired checkpoint default": { ...terminal, outcome: { ...terminal.outcome, checkpointContext: { callIndex: 0, hash: "hash", prompt: "p", kind: "confirm", default: true } } },
  };
  for (const [name, value] of Object.entries({ accepted: true, setup: { state: "preparing" }, setupId: setupRequest.id, continuation: { generation: 1, replayedPrefix: 0 } })) {
    invalid[`config carries ${name}`] = { ...config, [name]: value };
    invalid[`result carries ${name}`] = { ...result, [name]: value };
  }
  for (const [name, input] of Object.entries(invalid)) {
    assert.equal(workflowToolOutputShape.safeParse(input).success, false, `${name} runtime`);
    assert.equal(validate(input).valid, false, `${name} published`);
  }
});
