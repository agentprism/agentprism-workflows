import test from "node:test";
import assert from "node:assert/strict";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

// Internals under test, imported via ../src (same-package unit test).
import {
  clampWorkflowInput,
  parseWorkflowToolInput,
  workflowToolInputSchema,
  workflowToolInputShape,
} from "../src/index.js";

// The runtime schema performs compatibility normalization before canonical validation.
const Schema = workflowToolInputSchema;

test("input shape: primitive validation allows the union and the parser requires a complete branch", () => {
  assert.deepEqual(Schema.parse({}), {}, "script is raw-schema optional so status can omit it");
  assert.throws(() => parseWorkflowToolInput(Schema.parse({})), /Invalid workflow tool input/);
  assert.throws(() => Schema.parse({ script: "" }), "empty script must be rejected (min(1))");
  const ok = parseWorkflowToolInput(Schema.parse({ script: "export const meta = {};" }));
  assert.equal(ok.script, "export const meta = {};");
  assert.equal(ok.action, undefined, "omitted action preserves legacy execution");
  assert.equal(parseWorkflowToolInput(Schema.parse({ action: "run", script: "x" })).action, "run");
});

test("input shape: script description gives the exact optional phase-entry contract", () => {
  assert.match(
    workflowToolInputShape.script.description ?? "",
    /phases MUST be an array of objects shaped `\{ title: string, detail\?: string, model\?: string \}`, never an array of strings/,
  );
});

test("input shape: args is OPTIONAL and accepts an arbitrary JSON value", () => {
  assert.doesNotThrow(() => Schema.parse({ script: "x" }), "args omitted is fine");
  const withArgs = parseWorkflowToolInput(
    Schema.parse({ script: "x", args: { topic: "ai", depth: [1, 2, 3], nested: { a: true } } }),
  );
  assert.deepEqual(withArgs.args, { topic: "ai", depth: [1, 2, 3], nested: { a: true } });
  // args may be any JSON value, not just an object.
  assert.equal(Schema.parse({ script: "x", args: "plain-string" }).args, "plain-string");
  assert.equal(Schema.parse({ script: "x", args: 7 }).args, 7);
});

test("input shape: one tool advertises the exact config, run, resume, status, result, permission, and stop field superset", () => {
  assert.ok(!("startInBackground" in workflowToolInputShape), "startInBackground must not be a tool input");
  assert.deepEqual(
    Object.keys(workflowToolInputShape).sort(),
    [
      "action",
      "agentRetries",
      "args",
      "background",
      "callIndex",
      "checkpointReplies",
      "concurrency",
      "forceOwner",
      "harnesses",
      "labelGlob",
      "lastN",
      "logLines",
      "maxAgents",
      "maxBytes",
      "modelFilter",
      "modelSpecs",
      "offset",
      "permissionId",
      "projectDir",
      "response",
      "resumeFromRunId",
      "resumePolicy",
      "runId",
      "script",
      "scriptPath",
      "waitMs",
    ],
    "the exact config/run/status/result/permission/stop wire fields",
  );
});

test("resume inputs advertise stored-content simplicity and manager-owned fail-to-live admission", () => {
  assert.match(workflowToolInputShape.action.description ?? "", /resume starts a new run from a source run's stored script and args/);
  assert.match(workflowToolInputShape.resumeFromRunId.description ?? "", /With action=run/);
  assert.match(workflowToolInputShape.resumeFromRunId.description ?? "", /Use action=resume with runId for stored-script replay/);
  assert.match(workflowToolInputShape.resumeFromRunId.description ?? "", /manager validates replay eligibility/);
  assert.match(workflowToolInputShape.resumeFromRunId.description ?? "", /runs live wherever reuse is uncertain/);
  assert.match(workflowToolInputShape.resumePolicy.description ?? "", /valid with action=resume or a run carrying resumeFromRunId/);
});

test("resume policy and source validation reject invalid values and combinations", () => {
  assert.equal(
    parseWorkflowToolInput(Schema.parse({ script: "x", resumeFromRunId: "source-1" })).resumePolicy,
    undefined,
  );
  assert.equal(
    parseWorkflowToolInput(
      Schema.parse({ script: "x", resumeFromRunId: "source-1", resumePolicy: "positional" }),
    ).resumePolicy,
    "positional",
  );
  for (const input of [
    { script: "x", resumeFromRunId: "" },
    { script: "x", resumeFromRunId: 1 },
    { script: "x", resumeFromRunId: "source-1", resumePolicy: "future" },
  ]) {
    assert.throws(() => Schema.parse(input));
  }
  for (const input of [
    { script: "x", resumePolicy: "auto" },
    { script: "x", checkpointReplies: { "0": true } },
  ]) {
    assert.throws(
      () => parseWorkflowToolInput(Schema.parse(input)),
      (error: unknown) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams,
    );
  }

  assert.deepEqual(
    parseWorkflowToolInput(
      Schema.parse({
        action: "resume",
        runId: "source-1",
        args: { changed: true },
        resumePolicy: "positional",
        checkpointReplies: { "0": true },
        concurrency: 99,
        background: true,
      }),
    ),
    {
      action: "resume",
      runId: "source-1",
      args: { changed: true },
      maxAgents: undefined,
      concurrency: 99,
      agentRetries: undefined,
      resumePolicy: "positional",
      checkpointReplies: { 0: true },
      background: true,
    },
  );
});

test("background defaults false and accepts explicit false or true on execution actions", () => {
  assert.equal(parseWorkflowToolInput(Schema.parse({ script: "x" })).background, false);
  assert.equal(parseWorkflowToolInput(Schema.parse({ script: "x", background: false })).background, false);
  assert.equal(parseWorkflowToolInput(Schema.parse({ script: "x", background: true })).background, true);
});

test("script and scriptPath are an absolute-path XOR for explicit run and forbidden for simple resume", () => {
  assert.equal(parseWorkflowToolInput(Schema.parse({ scriptPath: "/tmp/workflow.js" })).scriptPath, "/tmp/workflow.js");
  assert.equal(
    parseWorkflowToolInput(Schema.parse({ action: "run", scriptPath: "/tmp/workflow.js", resumeFromRunId: "a-b" })).scriptPath,
    "/tmp/workflow.js",
  );
  assert.throws(() => Schema.parse({ scriptPath: "relative/workflow.js" }), /scriptPath must be an absolute path/);
  for (const input of [
    {},
    { action: "run" },
    { script: "x", scriptPath: "/tmp/workflow.js" },
    { action: "run", script: "x", scriptPath: "/tmp/workflow.js" },
  ]) {
    assert.throws(
      () => parseWorkflowToolInput(Schema.parse(input)),
      /exactly one of script or scriptPath is required/,
    );
  }
  assert.doesNotThrow(() => parseWorkflowToolInput(Schema.parse({ action: "resume", runId: "a-b" })));
  for (const input of [
    { action: "resume" },
    { action: "resume", runId: "a-b", script: "x" },
    { action: "resume", runId: "a-b", scriptPath: "/tmp/workflow.js" },
    { action: "resume", runId: "a-b", projectDir: "/tmp" },
    { action: "resume", runId: "a-b", resumeFromRunId: "c-d" },
    { action: "resume", runId: "a-b", waitMs: 0 },
    { action: "resume", runId: "a-b", lastN: 1 },
  ]) {
    assert.throws(() => parseWorkflowToolInput(Schema.parse(input)));
  }
});

test("config accepts only bounded discovery fields and requires projectDir in daemon mode", () => {
  assert.deepEqual(
    parseWorkflowToolInput(
      Schema.parse({
        action: "config",
        projectDir: "/tmp/project",
        harnesses: ["claude", "team.agent"],
        modelFilter: "opus",
        modelSpecs: ["claude/opus"],
      }),
    ),
    {
      action: "config",
      projectDir: "/tmp/project",
      harnesses: ["claude", "team.agent"],
      modelFilter: "opus",
      modelSpecs: ["claude/opus"],
    },
  );
  assert.throws(
    () => parseWorkflowToolInput(Schema.parse({ action: "config" }), { requireProjectDir: true }),
    /config requires projectDir/,
  );
  for (const input of [
    { action: "config", script: "x" },
    { action: "config", runId: "a-b" },
    { action: "config", args: {} },
    { action: "config", background: true },
    { action: "config", harnesses: [] },
    { action: "config", harnesses: ["bad/name"] },
    { action: "config", modelFilter: "" },
    { action: "config", modelSpecs: [] },
  ]) {
    assert.throws(() => parseWorkflowToolInput(Schema.parse(input)));
  }
});

test("status defaults to immediate observation and accepts the exact wait bounds", () => {
  assert.deepEqual(parseWorkflowToolInput(Schema.parse({ action: "status", runId: "a-b" })), {
    action: "status",
    runId: "a-b",
    waitMs: 0,
    lastN: undefined,
    labelGlob: undefined,
    logLines: undefined,
  });
  assert.equal(parseWorkflowToolInput(Schema.parse({ action: "status", runId: "a-b", waitMs: 0 })).waitMs, 0);
  assert.equal(parseWorkflowToolInput(Schema.parse({ action: "status", runId: "a-b", waitMs: 25_000 })).waitMs, 25_000);
  for (const waitMs of [-1, 25_001, 1.5]) {
    assert.throws(() => Schema.parse({ action: "status", runId: "a-b", waitMs }));
  }
});

test("legacy inspect and await inputs normalize without remaining canonical actions", () => {
  assert.throws(() => workflowToolInputShape.action.parse("inspect"));
  assert.throws(() => workflowToolInputShape.action.parse("await"));
  assert.deepEqual(parseWorkflowToolInput(Schema.parse({ action: "inspect", runId: "a-b" })), {
    action: "status",
    runId: "a-b",
    waitMs: 0,
    lastN: undefined,
    labelGlob: undefined,
    logLines: undefined,
  });
  assert.deepEqual(parseWorkflowToolInput(Schema.parse({ action: "await", runId: "a-b" })), {
    action: "status",
    runId: "a-b",
    waitMs: 20_000,
    lastN: undefined,
    labelGlob: undefined,
    logLines: undefined,
  });
  assert.equal(
    parseWorkflowToolInput(Schema.parse({ action: "await", runId: "a-b", waitMs: 7 })).waitMs,
    7,
  );
  assert.throws(() => Schema.parse({ action: "inspect", runId: "a-b", waitMs: 1 }));
});

test("result retrieval defaults to bounded UTF-8 chunks and rejects mixed fields", () => {
  assert.deepEqual(
    parseWorkflowToolInput(Schema.parse({ action: "result", runId: "a-b" })),
    { action: "result", runId: "a-b", offset: 0, maxBytes: 16_384 },
  );
  assert.deepEqual(
    parseWorkflowToolInput(Schema.parse({ action: "result", runId: "a-b", offset: 7, maxBytes: 4 })),
    { action: "result", runId: "a-b", offset: 7, maxBytes: 4 },
  );
  for (const input of [
    { action: "result" },
    { action: "result", runId: "a-b", offset: -1 },
    { action: "result", runId: "a-b", offset: 1.5 },
    { action: "result", runId: "a-b", maxBytes: 3 },
    { action: "result", runId: "a-b", maxBytes: 16_385 },
    { action: "result", runId: "a-b", waitMs: 0 },
    { action: "result", runId: "a-b", script: "x" },
    { action: "result", runId: "a-b", lastN: 1 },
  ]) {
    assert.throws(() => parseWorkflowToolInput(Schema.parse(input)));
  }
});

test("status accepts bounded filters and rejects invalid IDs, globs, and ranges", () => {
  const bare = parseWorkflowToolInput(Schema.parse({ action: "status", runId: "mabc1234-k9x2pq" }));
  assert.deepEqual(bare, {
    action: "status",
    runId: "mabc1234-k9x2pq",
    waitMs: 0,
    lastN: undefined,
    labelGlob: undefined,
    logLines: undefined,
  });
  assert.doesNotThrow(() =>
    parseWorkflowToolInput(
      Schema.parse({ action: "status", runId: "a-b", lastN: 1, logLines: 0, labelGlob: "review-?" }),
    ),
  );
  assert.doesNotThrow(() =>
    parseWorkflowToolInput(Schema.parse({ action: "status", runId: "a-b", lastN: 50, logLines: 50 })),
  );
  for (const input of [
    { action: "status", runId: "../run" },
    { action: "status", runId: "UPPER-case" },
    { action: "status", runId: "a-b", lastN: 0 },
    { action: "status", runId: "a-b", lastN: 51 },
    { action: "status", runId: "a-b", logLines: -1 },
    { action: "status", runId: "a-b", logLines: 51 },
    { action: "status", runId: "a-b", labelGlob: "" },
    { action: "status", runId: "a-b", labelGlob: "😀".repeat(129) },
  ]) {
    assert.throws(() => Schema.parse(input));
  }
});

test("stop requires runId, accepts an optional per-agent callIndex, and rejects execution fields and waitMs", () => {
  assert.deepEqual(
    parseWorkflowToolInput(
      Schema.parse({
        action: "stop",
        runId: "a-b",
        callIndex: 7,
        lastN: 5,
        labelGlob: "review:*",
        logLines: 2,
      }),
    ),
    { action: "stop", runId: "a-b", callIndex: 7, lastN: 5, labelGlob: "review:*", logLines: 2 },
  );
  assert.equal(
    parseWorkflowToolInput(Schema.parse({ action: "stop", runId: "a-b" })).callIndex,
    undefined,
    "omission retains whole-run stop",
  );
  assert.equal(
    parseWorkflowToolInput(Schema.parse({ action: "stop", runId: "a-b", forceOwner: true })).forceOwner,
    true,
    "whole-run stop can explicitly authorize predecessor termination",
  );
  assert.throws(
    () => parseWorkflowToolInput(Schema.parse({ action: "stop", runId: "a-b", callIndex: 7, forceOwner: true })),
    /forceOwner is forbidden with callIndex/,
  );
  for (const callIndex of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => Schema.parse({ action: "stop", runId: "a-b", callIndex }));
  }
  for (const input of [
    { action: "stop" },
    { action: "stop", runId: "a-b", script: "x" },
    { action: "stop", runId: "a-b", scriptPath: "/tmp/x.js" },
    { action: "stop", runId: "a-b", args: {} },
    { action: "stop", runId: "a-b", background: true },
    { action: "stop", runId: "a-b", waitMs: 0 },
    { action: "status", runId: "a-b", forceOwner: true },
  ]) {
    assert.throws(() => parseWorkflowToolInput(Schema.parse(input)), /Invalid workflow tool input/);
  }
});

test("permissions-response accepts only an exact pending id and ACP response", () => {
  const selected = parseWorkflowToolInput(Schema.parse({
    action: "permissions-response",
    runId: "abc-def",
    permissionId: "123e4567-e89b-12d3-a456-426614174000",
    response: { outcome: { outcome: "selected", optionId: "allow_once" } },
  }));
  assert.equal(selected.action, "permissions-response");
  assert.equal(selected.response.outcome.outcome, "selected");
  assert.throws(() => parseWorkflowToolInput(Schema.parse({
    action: "permissions-response",
    runId: "abc-def",
  })));
  assert.throws(() => Schema.parse({
    action: "permissions-response",
    runId: "abc-def",
    permissionId: "not-a-uuid",
    response: { outcome: { outcome: "cancelled" } },
  }));
  assert.throws(() => parseWorkflowToolInput(Schema.parse({
    action: "permissions-response",
    runId: "abc-def",
    permissionId: "123e4567-e89b-12d3-a456-426614174000",
    response: { outcome: { outcome: "cancelled" } },
    waitMs: 1,
  })));
  assert.throws(() => Schema.parse({
    action: "permissions-response",
    runId: "abc-def",
    permissionId: "123e4567-e89b-12d3-a456-426614174000",
    response: {
      outcome: { outcome: "selected", optionId: "allow_once" },
      _meta: { persist: "always" },
    },
  }), "provider effects must come only from the exact advertised optionId");
});

test("the discriminator rejects every missing or mixed run/status branch", () => {
  for (const input of [
    { action: "run" },
    { action: "status" },
    { runId: "a-b" },
    { action: "status", runId: "a-b", script: "x" },
    { action: "status", runId: "a-b", scriptPath: "/tmp/x.js" },
    { action: "status", runId: "a-b", args: {} },
    { action: "status", runId: "a-b", concurrency: 2 },
    { action: "status", runId: "a-b", resumeFromRunId: "c-d" },
    { action: "status", runId: "a-b", resumePolicy: "auto" },
    { action: "status", runId: "a-b", checkpointReplies: { 0: true } },
    { action: "status", runId: "a-b", background: false },
    { action: "status", runId: "a-b", callIndex: 0 },
    { action: "status", runId: "a-b", maxAgents: 1 },
    { action: "status", runId: "a-b", agentRetries: 1 },
    { script: "x", runId: "a-b" },
    { script: "x", callIndex: 0 },
    { script: "x", waitMs: 0 },
    { action: "run", script: "x", lastN: 1 },
    { action: "run", script: "x", labelGlob: "*" },
    { action: "run", script: "x", logLines: 0 },
    { action: "run", script: "x", harnesses: ["claude"] },
    { action: "status", runId: "a-b", modelFilter: "opus" },
    { action: "status", runId: "a-b", offset: 0 },
    { action: "status", runId: "a-b", maxBytes: 16 },
    { script: "x", offset: 0 },
  ]) {
    const primitive = Schema.parse(input);
    assert.throws(
      () => parseWorkflowToolInput(primitive),
      (error: unknown) =>
        error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams && /Invalid workflow tool input/.test(error.message),
    );
  }
});

test("input shape: checkpointReplies accepts JSON string indexes and coerces them to numeric keys", () => {
  const parsed = Schema.parse({
    script: "x",
    resumeFromRunId: "run-1",
    checkpointReplies: { "0": true, "12": "ship" },
  });
  assert.deepEqual(parsed.checkpointReplies, { 0: true, 12: "ship" });
  assert.throws(
    () => Schema.parse({ script: "x", resumeFromRunId: "run-1", checkpointReplies: { nope: true } }),
    "non-numeric call indexes are rejected",
  );
  assert.throws(
    () => Schema.parse({ script: "x", resumeFromRunId: "run-1", checkpointReplies: { "-1": true } }),
    "negative call indexes are rejected",
  );
  assert.throws(
    () =>
      Schema.parse({
        script: "x",
        resumeFromRunId: "run-1",
        checkpointReplies: { "9007199254740992": true },
      }),
    "unsafe call indexes are rejected",
  );
});

test("input shape: over-max concurrency/agentRetries are ACCEPTED at the schema (no .max())", () => {
  // The contract: bounds are NOT encoded in Zod, so the wire boundary never rejects an
  // over-max knob with InvalidParams — it passes validation unchanged and is clamped later.
  const parsed = Schema.parse({ script: "x", concurrency: 1000, agentRetries: 99 });
  assert.equal(parsed.concurrency, 1000, "concurrency over the runtime max is accepted, not rejected");
  assert.equal(parsed.agentRetries, 99, "agentRetries over the runtime max is accepted, not rejected");
  // agentRetries: 0 is allowed (min(0)); concurrency must still be a positive integer.
  assert.equal(Schema.parse({ script: "x", agentRetries: 0 }).agentRetries, 0);
  assert.throws(() => Schema.parse({ script: "x", concurrency: 0 }), "concurrency must be positive (typed gate stays)");
  assert.throws(() => Schema.parse({ script: "x", concurrency: 1.5 }), "concurrency must be an integer");
});

test("clampWorkflowInput: CLAMPS over-max knobs to the engine maxima (16 / 3), not rejects", () => {
  const clamped = clampWorkflowInput({ script: "x", concurrency: 1000, agentRetries: 99 });
  assert.equal(clamped.concurrency, 16, "concurrency clamped to MAX_CONCURRENCY");
  assert.equal(clamped.agentRetries, 3, "agentRetries clamped to MAX_AGENT_RETRIES");
  assert.equal(clamped.script, "x", "script passes through untouched");
});

test("clampWorkflowInput: in-range values pass through; maxAgents floored to >= 1", () => {
  const within = clampWorkflowInput({ script: "x", concurrency: 8, agentRetries: 2, maxAgents: 50 });
  assert.equal(within.concurrency, 8);
  assert.equal(within.agentRetries, 2);
  assert.equal(within.maxAgents, 50);
  // maxAgents has no upper clamp, only a floor to a positive integer.
  assert.equal(clampWorkflowInput({ script: "x", maxAgents: 0.4 }).maxAgents, 1);
  assert.equal(clampWorkflowInput({ script: "x", maxAgents: 7.9 }).maxAgents, 7);
});

test("clampWorkflowInput: omitted knobs stay undefined (engine defaults apply)", () => {
  const bare = clampWorkflowInput({ script: "x" });
  assert.equal(bare.concurrency, undefined);
  assert.equal(bare.agentRetries, undefined);
  assert.equal(bare.maxAgents, undefined);
});
