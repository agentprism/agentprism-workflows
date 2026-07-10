import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// Internals under test, imported via ../src (same-package unit test).
import { clampWorkflowInput, workflowToolInputShape } from "../src/index.js";

// The MCP SDK validates a Zod RAW SHAPE before the handler runs; build the object schema
// the SDK would build so we can assert exactly what the wire boundary accepts/rejects.
const Schema = z.object(workflowToolInputShape);

test("input shape: script is REQUIRED and must be non-empty", () => {
  assert.throws(() => Schema.parse({}), "missing script must be rejected");
  assert.throws(() => Schema.parse({ script: "" }), "empty script must be rejected (min(1))");
  // A present, non-empty script alone is a valid input.
  const ok = Schema.parse({ script: "export const meta = {};" });
  assert.equal(ok.script, "export const meta = {};");
});

test("input shape: args is OPTIONAL and accepts an arbitrary JSON value", () => {
  assert.doesNotThrow(() => Schema.parse({ script: "x" }), "args omitted is fine");
  const withArgs = Schema.parse({ script: "x", args: { topic: "ai", depth: [1, 2, 3], nested: { a: true } } });
  assert.deepEqual(withArgs.args, { topic: "ai", depth: [1, 2, 3], nested: { a: true } });
  // args may be any JSON value, not just an object.
  assert.equal(Schema.parse({ script: "x", args: "plain-string" }).args, "plain-string");
  assert.equal(Schema.parse({ script: "x", args: 7 }).args, 7);
});

test("input shape: there is NO startInBackground field (sync run model dropped it)", () => {
  assert.ok(!("startInBackground" in workflowToolInputShape), "startInBackground must not be a tool input");
  assert.deepEqual(
    Object.keys(workflowToolInputShape).sort(),
    [
      "agentRetries",
      "agentTimeoutMs",
      "args",
      "checkpointReplies",
      "concurrency",
      "maxAgents",
      "resumeFromRunId",
      "script",
      "tokenBudget",
    ],
    "the exact wire input fields (no background; resume is explicit via resumeFromRunId)",
  );
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
