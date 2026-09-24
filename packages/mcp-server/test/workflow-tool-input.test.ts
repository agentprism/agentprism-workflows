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
  "setup-response": { action: "setup-response", runId: "source-1", setupId: PERMISSION_ID, response: { action: "accept", content: { approved: true } } },
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

/** One valid value per flat field, used to cross-check the flat rules against the strict branches. */
const sampleFieldValues: Record<string, unknown> = {
  script: "x",
  scriptPath: "/tmp/workflow.js",
  projectDir: "/tmp/project",
  harnesses: ["codex"],
  modelSpecs: ["codex/gpt-5"],
  modelFilter: "gpt",
  args: { any: "json" },
  maxAgents: 3,
  concurrency: 2,
  agentRetries: 1,
  checkpointReplies: { "0": true },
  setupId: PERMISSION_ID,
  runId: "source-1",
  permissionId: PERMISSION_ID,
  callIndex: 0,
  forceOwner: true,
  lastN: 5,
  labelGlob: "review:*",
  logLines: 5,
  offset: 0,
  maxBytes: 1024,
};

function sampleResponse(action: string): unknown {
  return action === "setup-response"
    ? { action: "decline" }
    : { outcome: { outcome: "cancelled" } };
}

test("discovery publishes one flat strict object with no top-level composition keyword", async () => {
  assert.deepEqual(Object.keys(workflowToolInputBranches), [
    "config",
    "run",
    "resume",
    "setup-response",
    "status",
    "result",
    "permissions-response",
    "stop",
    "pause",
  ]);
  const published = object(
    await workflowToolInputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  );
  // The Anthropic API rejects a tool input_schema with top-level oneOf/anyOf/allOf; hosts built on
  // it drop or lossily rewrite such a tool.
  for (const keyword of ["oneOf", "anyOf", "allOf", "not", "if", "then", "else"]) {
    assert.equal(Object.hasOwn(published, keyword), false, `top-level ${keyword}`);
  }
  assert.deepEqual(Object.keys(published), ["$schema", "type", "properties", "required", "additionalProperties"]);
  const properties = object(published.properties);
  const actual = {
    $schema: published.$schema,
    type: published.type,
    required: published.required,
    additionalProperties: published.additionalProperties,
    actions: object(properties.action).enum,
    properties: Object.keys(properties),
  };
  const expected = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "workflow-tool-input-schema.snapshot.json"), "utf8"),
  );
  assert.deepEqual(actual, expected);
  assert.deepEqual(expected.actions, Object.keys(workflowToolInputBranches));
  assert.deepEqual(expected.properties, Object.keys(workflowToolInputShape));
});

test("the flat schema accepts exactly what the strict per-action branches accept, field by field", () => {
  // Schema ends by narrowing through the strict union, so agreement alone cannot catch per-action
  // rules that are too lenient. Every rejection must also come from the flat stage's own issues,
  // never from the trailing union (whose only message is a generic invalid_union).
  const agrees = (input: Record<string, unknown>, label: string) => {
    const flat = Schema.safeParse(input);
    const canonical = workflowToolCanonicalInputSchema.safeParse(input);
    assert.equal(flat.success, canonical.success, label);
    if (!flat.success) {
      assert.ok(flat.error.issues.every((issue) => issue.code !== "invalid_union"), `${label}: rejected only by the strict union`);
    }
  };
  for (const action of Object.keys(workflowToolInputBranches)) {
    const base: Record<string, unknown> = { action };
    if (action !== "config" && action !== "run") base.runId = "source-1";
    if (action === "run") base.script = "x";
    if (action === "setup-response") Object.assign(base, { setupId: PERMISSION_ID, response: sampleResponse(action) });
    if (action === "permissions-response") Object.assign(base, { permissionId: PERMISSION_ID, response: sampleResponse(action) });
    assert.equal(Schema.safeParse(base).success, true, `${action} base`);
    assert.equal(workflowToolCanonicalInputSchema.safeParse(base).success, true, `${action} base canonical`);
    for (const field of Object.keys(workflowToolInputShape)) {
      if (field === "action" || field === "response") continue;
      agrees({ ...base, [field]: sampleFieldValues[field] }, `${action} + ${field}`);
      const without = { ...base };
      delete without[field];
      agrees(without, `${action} - ${field}`);
    }
    for (const responseAction of ["setup-response", "permissions-response"]) {
      agrees({ ...base, response: sampleResponse(responseAction) }, `${action} + ${responseAction} response`);
    }
  }
});

test("per-action violations fail with messages that name the action and the fix", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ action: "run", script: "x", lastN: 1 }, /action "run" does not accept lastN; it accepts script, scriptPath, projectDir/],
    [{ action: "status" }, /action "status" requires runId/],
    [{ action: "run" }, /action "run" requires exactly one of script or scriptPath/],
    [{ action: "run", script: "x", scriptPath: "/tmp/w.js" }, /action "run" requires exactly one of script or scriptPath/],
    [{ action: "stop", runId: "a-b", callIndex: 1, forceOwner: true }, /action "stop" accepts callIndex or forceOwner, not both/],
    [
      { action: "setup-response", runId: "a-b", setupId: PERMISSION_ID, response: { outcome: { outcome: "cancelled" } } },
      /action "setup-response" requires response to be \{ action:"accept"/,
    ],
    [
      { action: "permissions-response", runId: "a-b", permissionId: PERMISSION_ID, response: { action: "decline" } },
      /action "permissions-response" requires response to be \{ outcome:/,
    ],
  ];
  for (const [input, message] of cases) {
    assert.throws(
      () => parseWorkflowToolInput(input),
      (error: unknown) =>
        error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams && message.test(error.message),
      JSON.stringify(input),
    );
  }
});

test("published JSON Schema accepts every canonical action; runtime also rejects cross-action fields", async () => {
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
    // Every field is a flat optional property, so which action owns it is a runtime rule only.
    assert.equal(validate(input).valid, true, `${name} published schema`);
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
    "run background true": { ...canonicalInputs.run, background: true },
    "run background false": { ...canonicalInputs.run, background: false },
    "resume background true": { ...canonicalInputs.resume, background: true },
    "resume background false": { ...canonicalInputs.resume, background: false },
    foreground: { ...canonicalInputs.run, foreground: true },
    mode: { ...canonicalInputs.run, mode: "async" },
    wait: { ...canonicalInputs.resume, wait: true },
    continuationToken: { ...canonicalInputs.resume, continuationToken: "old-token" },
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

  // These reuse fields that another action owns, so only the runtime per-action rules reject them.
  const crossActionOnly = new Set(["resume args", "resume edited inline script", "resume edited script path"]);
  for (const [name, input] of Object.entries(retiredInputs)) {
    assert.equal(workflowToolCanonicalInputSchema.safeParse(input).success, false, `${name} canonical runtime`);
    assert.equal(Schema.safeParse(input).success, false, `${name} runtime`);
    assert.equal(validate(input).valid, crossActionOnly.has(name), `${name} published schema`);
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
    action: "run", script: "x",
    args: ["any", { json: true }],
  });
  assert.equal(run.action, "run");
  assert.deepEqual(run.args, ["any", { json: true }]);
  assert.equal(Object.hasOwn(run, "background"), false);
  const resume = parseWorkflowToolInput({
    action: "resume", runId: "source-1",
    concurrency: 99,
    checkpointReplies: { "0": true, "12": "ship" },
  });
  assert.deepEqual(resume, {
    action: "resume", runId: "source-1",
    concurrency: 99,
    checkpointReplies: { 0: true, 12: "ship" },
  });
  for (const key of ["nope", "-1", "9007199254740992"]) {
    assert.equal(
      Schema.safeParse({
        action: "resume", runId: "source-1",
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

test("field catalog is canonical and points detailed syntax to the authoring skill", () => {
  assert.match(workflowToolInputShape.action.description ?? "", /agentprism-workflow-authoring skill/);
  assert.match(workflowToolInputShape.action.description ?? "", /run\(exactly one of script\|scriptPath, /);
  assert.deepEqual(workflowToolInputShape.action.options, Object.keys(workflowToolInputBranches));
  assert.match(workflowToolInputShape.script.description ?? "", /raw JavaScript workflow source/);
  assert.ok(!("startInBackground" in workflowToolInputShape));
});


test("run and resume carry no retry identity: the retired requestId field is rejected in both schemas", async () => {
  const published = await Schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  const validate = new AjvJsonSchemaValidator().getValidator(published as JsonSchemaType);
  for (const base of [canonicalInputs.run, canonicalInputs.resume]) {
    assert.equal(Schema.safeParse(base).success, true, JSON.stringify(base));
    assert.equal(validate(base).valid, true, JSON.stringify(base));
    for (const requestId of ["a", "retry:42_attempt.2", "x".repeat(128)]) {
      assert.equal(Schema.safeParse({ ...base, requestId }).success, false);
      assert.equal(validate({ ...base, requestId }).valid, false);
    }
  }
  assert.equal("requestId" in workflowToolInputShape, false);
  assert.equal("background" in workflowToolInputShape, false);
});

test("setup responses bind an exact run and pending request without accepting stale aliases", async () => {
  const published = await Schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  const validate = new AjvJsonSchemaValidator().getValidator(published as JsonSchemaType);
  const base = canonicalInputs["setup-response"];
  for (const response of [{ action: "accept", content: { occurrence_0: "claude/opus" } }, { action: "decline" }, { action: "cancel" }]) {
    assert.equal(Schema.safeParse({ ...base, response }).success, true);
    assert.equal(validate({ ...base, response }).valid, true);
  }
  for (const input of [
    { ...base, runId: "" }, { ...base, setupId: "not-a-uuid" }, { ...base, requestId: "retry-1" },
    { ...base, response: { action: "accept" } }, { ...base, response: { action: "approve", content: {} } },
    { ...base, response: { action: "decline", content: {} } }, { ...base, response: { action: "cancel", default: true } },
  ]) {
    assert.equal(Schema.safeParse(input).success, false, JSON.stringify(input));
    assert.equal(validate(input).valid, false, JSON.stringify(input));
  }
});
