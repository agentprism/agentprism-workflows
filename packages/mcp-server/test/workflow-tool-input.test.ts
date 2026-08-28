import test from "node:test";
import assert from "node:assert/strict";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";

// Internals under test, imported via ../src (same-package unit test).
import { clampWorkflowInput, parseWorkflowToolInput, workflowToolInputShape } from "../src/index.js";

// The MCP SDK validates a Zod RAW SHAPE before the handler runs; build the object schema
// the SDK would build so we can assert exactly what the wire boundary accepts/rejects.
const Schema = z.object(workflowToolInputShape);

test("input shape: primitive validation allows the union and the parser requires a complete branch", () => {
  assert.deepEqual(Schema.parse({}), {}, "script is raw-schema optional so inspect can omit it");
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

test("input shape: one tool advertises the exact config, run, inspect, await, and stop field superset", () => {
  assert.ok(!("startInBackground" in workflowToolInputShape), "startInBackground must not be a tool input");
  assert.deepEqual(
    Object.keys(workflowToolInputShape).sort(),
    [
      "action",
      "agentRetries",
      "agentTimeoutMs",
      "args",
      "background",
      "callIndex",
      "checkpointReplies",
      "concurrency",
      "harnesses",
      "labelGlob",
      "lastN",
      "logLines",
      "maxAgents",
      "modelFilter",
      "modelSpecs",
      "probeTimeoutMs",
      "projectDir",
      "resumeFromRunId",
      "resumePolicy",
      "runId",
      "script",
      "scriptPath",
      "waitMs",
    ],
    "the exact config/run/inspect/await/stop wire fields",
  );
});

test("resume inputs advertise manager-owned fail-to-live admission", () => {
  assert.match(workflowToolInputShape.resumeFromRunId.description ?? "", /Re-send the script via script or scriptPath/);
  assert.match(workflowToolInputShape.resumeFromRunId.description ?? "", /manager validates replay eligibility/);
  assert.match(workflowToolInputShape.resumeFromRunId.description ?? "", /runs live wherever reuse is uncertain/);
  assert.match(workflowToolInputShape.resumePolicy.description ?? "", /requires resumeFromRunId/);
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
});

test("background defaults false and accepts explicit false or true on run only", () => {
  assert.equal(parseWorkflowToolInput(Schema.parse({ script: "x" })).background, false);
  assert.equal(parseWorkflowToolInput(Schema.parse({ script: "x", background: false })).background, false);
  assert.equal(parseWorkflowToolInput(Schema.parse({ script: "x", background: true })).background, true);
});

test("script and scriptPath are an absolute-path XOR for every run and resume", () => {
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
        probeTimeoutMs: 5_000,
      }),
    ),
    {
      action: "config",
      projectDir: "/tmp/project",
      harnesses: ["claude", "team.agent"],
      modelFilter: "opus",
      modelSpecs: ["claude/opus"],
      probeTimeoutMs: 5_000,
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
    { action: "config", probeTimeoutMs: 0 },
  ]) {
    assert.throws(() => parseWorkflowToolInput(Schema.parse(input)));
  }
});

test("await applies its default and accepts the exact wait bounds", () => {
  assert.deepEqual(parseWorkflowToolInput(Schema.parse({ action: "await", runId: "a-b" })), {
    action: "await",
    runId: "a-b",
    waitMs: 20_000,
    lastN: undefined,
    labelGlob: undefined,
    logLines: undefined,
  });
  assert.equal(parseWorkflowToolInput(Schema.parse({ action: "await", runId: "a-b", waitMs: 0 })).waitMs, 0);
  assert.equal(parseWorkflowToolInput(Schema.parse({ action: "await", runId: "a-b", waitMs: 25_000 })).waitMs, 25_000);
  for (const waitMs of [-1, 25_001, 1.5]) {
    assert.throws(() => Schema.parse({ action: "await", runId: "a-b", waitMs }));
  }
});

test("inspection accepts defaults and exact bounds, and rejects invalid IDs/globs/ranges", () => {
  const bare = parseWorkflowToolInput(Schema.parse({ action: "inspect", runId: "mabc1234-k9x2pq" }));
  assert.deepEqual(bare, {
    action: "inspect",
    runId: "mabc1234-k9x2pq",
    lastN: undefined,
    labelGlob: undefined,
    logLines: undefined,
  });
  assert.doesNotThrow(() =>
    parseWorkflowToolInput(
      Schema.parse({ action: "inspect", runId: "a-b", lastN: 1, logLines: 0, labelGlob: "review-?" }),
    ),
  );
  assert.doesNotThrow(() =>
    parseWorkflowToolInput(Schema.parse({ action: "inspect", runId: "a-b", lastN: 50, logLines: 50 })),
  );
  for (const input of [
    { action: "inspect", runId: "../run" },
    { action: "inspect", runId: "UPPER-case" },
    { action: "inspect", runId: "a-b", lastN: 0 },
    { action: "inspect", runId: "a-b", lastN: 51 },
    { action: "inspect", runId: "a-b", logLines: -1 },
    { action: "inspect", runId: "a-b", logLines: 51 },
    { action: "inspect", runId: "a-b", labelGlob: "" },
    { action: "inspect", runId: "a-b", labelGlob: "😀".repeat(129) },
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
  ]) {
    assert.throws(() => parseWorkflowToolInput(Schema.parse(input)), /Invalid workflow tool input/);
  }
});

test("the discriminator rejects every missing or mixed run/inspect/await branch", () => {
  for (const input of [
    { action: "run" },
    { action: "inspect" },
    { runId: "a-b" },
    { action: "inspect", runId: "a-b", script: "x" },
    { action: "inspect", runId: "a-b", scriptPath: "/tmp/x.js" },
    { action: "inspect", runId: "a-b", args: {} },
    { action: "inspect", runId: "a-b", concurrency: 2 },
    { action: "inspect", runId: "a-b", resumeFromRunId: "c-d" },
    { action: "inspect", runId: "a-b", resumePolicy: "auto" },
    { action: "inspect", runId: "a-b", checkpointReplies: { 0: true } },
    { action: "inspect", runId: "a-b", background: false },
    { action: "inspect", runId: "a-b", waitMs: 0 },
    { action: "inspect", runId: "a-b", callIndex: 0 },
    { action: "await" },
    { action: "await", runId: "a-b", script: "x" },
    { action: "await", runId: "a-b", scriptPath: "/tmp/x.js" },
    { action: "await", runId: "a-b", args: {} },
    { action: "await", runId: "a-b", maxAgents: 1 },
    { action: "await", runId: "a-b", concurrency: 1 },
    { action: "await", runId: "a-b", agentRetries: 1 },
    { action: "await", runId: "a-b", agentTimeoutMs: 1 },
    { action: "await", runId: "a-b", resumeFromRunId: "c-d" },
    { action: "await", runId: "a-b", resumePolicy: "auto" },
    { action: "await", runId: "a-b", checkpointReplies: { 0: true } },
    { action: "await", runId: "a-b", background: true },
    { action: "await", runId: "a-b", callIndex: 0 },
    { script: "x", runId: "a-b" },
    { script: "x", callIndex: 0 },
    { script: "x", waitMs: 0 },
    { action: "run", script: "x", lastN: 1 },
    { action: "run", script: "x", labelGlob: "*" },
    { action: "run", script: "x", logLines: 0 },
    { action: "run", script: "x", harnesses: ["claude"] },
    { action: "inspect", runId: "a-b", modelFilter: "opus" },
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
