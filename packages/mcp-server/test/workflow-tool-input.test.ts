import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";

import {
  clampWorkflowInput,
  parseWorkflowToolInput,
  workflowToolCanonicalInputSchema,
  workflowToolInputBranches,
  workflowToolInputSchema,
  workflowToolInputShape,
} from "../src/index.js";

const Schema = workflowToolInputSchema;
const PERMISSION_ID = "123e4567-e89b-12d3-a456-426614174000";

const canonicalInputs = {
  config: { action: "config", projectDir: "/tmp/project", harnesses: ["codex"] },
  run: { action: "run", script: "export const meta = {};" },
  resume: { action: "resume", runId: "source-1" },
  status: { action: "status", runId: "source-1" },
  result: { action: "result", runId: "source-1", offset: 0, maxBytes: 16_384 },
  "permissions-response": {
    action: "permissions-response",
    runId: "source-1",
    permissionId: PERMISSION_ID,
    response: { outcome: { outcome: "selected", optionId: "allow_once" } },
  },
  stop: { action: "stop", runId: "source-1", callIndex: 0 },
} as const;

const crossActionInputs = {
  "config + run field": { action: "config", script: "x" },
  "run + status field": { action: "run", script: "x", lastN: 1 },
  "resume + run field": { action: "resume", runId: "source-1", script: "x" },
  "status + control field": { action: "status", runId: "source-1", callIndex: 0 },
  "result + status field": { action: "result", runId: "source-1", lastN: 1 },
  "permissions-response + result field": {
    action: "permissions-response",
    runId: "source-1",
    permissionId: PERMISSION_ID,
    response: { outcome: { outcome: "cancelled" } },
    offset: 0,
  },
  "stop + result field": { action: "stop", runId: "source-1", offset: 1 },
} as const;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function branchSnapshot(schema: JsonObject): JsonObject {
  const variants = schema.oneOf;
  if (Array.isArray(variants)) {
    return { variants: variants.map((variant) => branchSnapshot(object(variant))) };
  }
  const properties = object(schema.properties);
  return {
    action: object(properties.action).const,
    properties: Object.keys(properties),
    required: schema.required,
    additionalProperties: schema.additionalProperties,
  };
}

test("canonical schema publishes seven strict action branches and matches the committed snapshot", async () => {
  assert.deepEqual(Object.keys(workflowToolInputBranches), [
    "config",
    "run",
    "resume",
    "status",
    "result",
    "permissions-response",
    "stop",
  ]);
  const published = object(
    await workflowToolInputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  );
  assert.deepEqual(Object.keys(published), ["$schema", "oneOf", "type"]);
  const oneOf = published.oneOf;
  assert.ok(Array.isArray(oneOf));
  assert.equal(oneOf.length, 7);
  const actual = {
    $schema: published.$schema,
    type: published.type,
    branches: oneOf.map((branch) => branchSnapshot(object(branch))),
  };
  const expected = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "workflow-tool-input-schema.snapshot.json"), "utf8"),
  );
  assert.deepEqual(actual, expected);
});

test("runtime and published JSON Schema accept every canonical action and reject cross-action fields", async () => {
  const published = await workflowToolInputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  const validate = new AjvJsonSchemaValidator().getValidator(published as JsonSchemaType);
  for (const [name, input] of Object.entries(canonicalInputs)) {
    assert.equal(workflowToolCanonicalInputSchema.safeParse(input).success, true, `${name} canonical runtime`);
    assert.equal(Schema.safeParse(input).success, true, `${name} runtime`);
    assert.equal(validate(input).valid, true, `${name} published schema`);
    assert.equal(parseWorkflowToolInput(input).action, input.action, `${name} parser`);
  }
  for (const [name, input] of Object.entries(crossActionInputs)) {
    assert.equal(workflowToolCanonicalInputSchema.safeParse(input).success, false, `${name} canonical runtime`);
    assert.equal(Schema.safeParse(input).success, false, `${name} runtime`);
    assert.equal(validate(input).valid, false, `${name} published schema`);
    assert.throws(
      () => parseWorkflowToolInput(input),
      (error: unknown) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams,
      `${name} parser`,
    );
  }
});

test("run requires exactly one explicit script source and rejects fields outside its branch", () => {
  for (const input of [
    { action: "run", script: "x" },
    { action: "run", scriptPath: "/tmp/workflow.js" },
  ]) {
    assert.equal(Schema.safeParse(input).success, true, JSON.stringify(input));
  }
  for (const input of [
    {},
    { action: "run" },
    { action: "run", script: "x", scriptPath: "/tmp/workflow.js" },
    { action: "run", scriptPath: "relative/workflow.js" },
    { action: "run", script: "x", checkpointReplies: { "0": true } },
    { action: "run", script: "x", offset: 0 },
  ]) {
    assert.equal(Schema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test("unknown and omitted actions fail at the same strict runtime boundary", () => {
  assert.throws(() => workflowToolInputShape.action.parse("unknown-action"));
  assert.equal(
    workflowToolCanonicalInputSchema.safeParse({ action: "unknown-action", runId: "a-b" }).success,
    false,
  );
  assert.throws(() => parseWorkflowToolInput({ action: "unknown-action", runId: "a-b" }));
  assert.throws(() => parseWorkflowToolInput({ script: "x" }));
});

test("published and runtime schemas reject every retired wait, alias, and edited-replay input", async () => {
  const published = await workflowToolInputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  const validate = new AjvJsonSchemaValidator().getValidator(published as JsonSchemaType);
  const retiredInputs = {
    waitMs: { action: "status", runId: "source-1", waitMs: 20_000 },
    inspect: { action: "inspect", runId: "source-1" },
    await: { action: "await", runId: "source-1" },
    "omitted action": { runId: "source-1" },
    resumeFromRunId: { action: "run", script: "x", resumeFromRunId: "source-1" },
    resumePolicy: { action: "run", script: "x", resumePolicy: "positional" },
    "resume args": { action: "resume", runId: "source-1", args: { changed: true } },
    "resume edited inline script": { action: "resume", runId: "source-1", script: "return 'edited';" },
    "resume edited script path": { action: "resume", runId: "source-1", scriptPath: "/tmp/edited.js" },
  } as const;

  for (const [name, input] of Object.entries(retiredInputs)) {
    assert.equal(workflowToolCanonicalInputSchema.safeParse(input).success, false, `${name} canonical runtime`);
    assert.equal(Schema.safeParse(input).success, false, `${name} runtime`);
    assert.equal(validate(input).valid, false, `${name} published schema`);
    assert.throws(
      () => parseWorkflowToolInput(input),
      (error: unknown) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams,
      `${name} parser`,
    );
  }
});

test("config/run require projectDir only in shared-daemon mode", () => {
  assert.doesNotThrow(() => parseWorkflowToolInput({ action: "config" }));
  assert.doesNotThrow(() => parseWorkflowToolInput({ action: "run", script: "x" }));
  assert.throws(
    () => parseWorkflowToolInput({ action: "config" }, { requireProjectDir: true }),
    /config requires projectDir/,
  );
  assert.throws(
    () => parseWorkflowToolInput({ action: "run", script: "x" }, { requireProjectDir: true }),
    /run requires projectDir/,
  );
  assert.doesNotThrow(() =>
    parseWorkflowToolInput(
      { action: "run", script: "x", projectDir: "/tmp/project" },
      { requireProjectDir: true },
    ),
  );
});

test("run args and same-ID resume checkpoint replies use disjoint strict fields", () => {
  const run = parseWorkflowToolInput({
    action: "run",
    script: "x",
    args: ["any", { json: true }],
  });
  assert.equal(run.action, "run");
  assert.deepEqual(run.args, ["any", { json: true }]);
  assert.equal(run.background, false);
  const resume = parseWorkflowToolInput({
    action: "resume",
    runId: "source-1",
    concurrency: 99,
    checkpointReplies: { "0": true, "12": "ship" },
    background: true,
  });
  assert.deepEqual(resume, {
    action: "resume",
    runId: "source-1",
    concurrency: 99,
    checkpointReplies: { 0: true, 12: "ship" },
    background: true,
  });
  for (const key of ["nope", "-1", "9007199254740992"]) {
    assert.equal(
      Schema.safeParse({
        action: "resume",
        runId: "source-1",
        checkpointReplies: { [key]: true },
      }).success,
      false,
      key,
    );
  }
});

test("status/result apply request defaults and retain their exact bounds", () => {
  assert.deepEqual(parseWorkflowToolInput({ action: "status", runId: "a-b" }), {
    action: "status",
    runId: "a-b",
  });
  assert.deepEqual(parseWorkflowToolInput({ action: "result", runId: "a-b" }), {
    action: "result",
    runId: "a-b",
    offset: 0,
    maxBytes: 16_384,
  });
  for (const input of [
    { action: "status", runId: "a-b", lastN: 0 },
    { action: "status", runId: "a-b", lastN: 51 },
    { action: "status", runId: "a-b", logLines: -1 },
    { action: "status", runId: "a-b", labelGlob: "" },
    { action: "result", runId: "a-b", offset: -1 },
    { action: "result", runId: "a-b", maxBytes: 3 },
    { action: "result", runId: "a-b", maxBytes: 16_385 },
  ]) {
    assert.equal(Schema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test("stop structurally separates whole-run force from targeted cancellation", () => {
  assert.equal(Schema.safeParse({ action: "stop", runId: "a-b" }).success, true);
  assert.equal(Schema.safeParse({ action: "stop", runId: "a-b", forceOwner: true }).success, true);
  assert.equal(Schema.safeParse({ action: "stop", runId: "a-b", callIndex: 7 }).success, true);
  assert.equal(
    Schema.safeParse({ action: "stop", runId: "a-b", callIndex: 7, forceOwner: true }).success,
    false,
  );
  for (const callIndex of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(Schema.safeParse({ action: "stop", runId: "a-b", callIndex }).success, false);
  }
});

test("permissions-response preserves the exact strict ACP response variants", () => {
  assert.equal(Schema.safeParse(canonicalInputs["permissions-response"]).success, true);
  assert.equal(
    Schema.safeParse({
      action: "permissions-response",
      runId: "source-1",
      permissionId: PERMISSION_ID,
      response: { outcome: { outcome: "cancelled" } },
    }).success,
    true,
  );
  for (const input of [
    { action: "permissions-response", runId: "source-1" },
    {
      action: "permissions-response",
      runId: "source-1",
      permissionId: "not-a-uuid",
      response: { outcome: { outcome: "cancelled" } },
    },
    {
      action: "permissions-response",
      runId: "source-1",
      permissionId: PERMISSION_ID,
      response: { outcome: { outcome: "cancelled" }, _meta: { persist: true } },
    },
  ]) {
    assert.equal(Schema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test("execution resource knobs remain clamp-at-runtime rather than schema maxima", () => {
  const accepted = Schema.parse({ action: "run", script: "x", concurrency: 1000, agentRetries: 99 });
  assert.equal(accepted.concurrency, 1000);
  assert.equal(accepted.agentRetries, 99);
  const clamped = clampWorkflowInput(
    parseWorkflowToolInput({ action: "run", script: "x", concurrency: 1000, agentRetries: 99 }),
  );
  assert.equal(clamped.concurrency, 16);
  assert.equal(clamped.agentRetries, 3);
  assert.equal(clampWorkflowInput({ action: "run", script: "x", maxAgents: 0.4 }).maxAgents, 1);
  assert.equal(clampWorkflowInput({ action: "run", script: "x", maxAgents: 7.9 }).maxAgents, 7);
});

test("field catalog is canonical and points detailed syntax to selective docs", () => {
  assert.match(workflowToolInputShape.action.description ?? "", /workflow\/run-lifecycle/);
  assert.match(workflowToolInputShape.script.description ?? "", /raw JavaScript workflow source/);
  assert.ok(!("startInBackground" in workflowToolInputShape));
});
