import test from "node:test";
import assert from "node:assert/strict";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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

test("input shape: one tool advertises run and inspect fields without detached-run fields", () => {
  assert.ok(!("startInBackground" in workflowToolInputShape), "startInBackground must not be a tool input");
  assert.deepEqual(
    Object.keys(workflowToolInputShape).sort(),
    [
      "action",
      "agentRetries",
      "agentTimeoutMs",
      "args",
      "checkpointReplies",
      "concurrency",
      "labelGlob",
      "lastN",
      "logLines",
      "maxAgents",
      "resumeFromRunId",
      "runId",
      "script",
      "tokenBudget",
    ],
    "the exact run/inspect wire fields (background and await belong to the sibling spec)",
  );
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

test("the discriminator rejects every missing or mixed run/inspect branch", () => {
  for (const input of [
    { action: "run" },
    { action: "inspect" },
    { runId: "a-b" },
    { action: "inspect", runId: "a-b", script: "x" },
    { action: "inspect", runId: "a-b", args: {} },
    { action: "inspect", runId: "a-b", concurrency: 2 },
    { action: "inspect", runId: "a-b", resumeFromRunId: "c-d" },
    { action: "inspect", runId: "a-b", checkpointReplies: { 0: true } },
    { script: "x", runId: "a-b" },
    { action: "run", script: "x", lastN: 1 },
    { action: "run", script: "x", labelGlob: "*" },
    { action: "run", script: "x", logLines: 0 },
  ]) {
    const primitive = Schema.parse(input);
    assert.throws(
      () => parseWorkflowToolInput(primitive),
      (error: unknown) =>
        error instanceof McpError && error.code === ErrorCode.InvalidParams && /Invalid workflow tool input/.test(error.message),
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
