import test from "node:test";
import assert from "node:assert/strict";

import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";

import {
  connect,
  NO_AGENT_SCRIPT,
  okRunner,
  ONE_AGENT_SCRIPT,
  structured,
  textOf,
  throwingRunner,
} from "./_harness.js";

/** Read a nested field off an unknown object without `as any`. */
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// Engine-owned run id shape (run-persistence.generateRunId): `${base36ts}-${base36rand}`.
const RUN_ID = /^[a-z0-9]+-[a-z0-9]+$/;

test("tool registration: single `workflow` tool, input requires only `script`, no startInBackground", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1, "exactly one tool is registered");
    const tool = tools[0];
    assert.equal(tool.name, "workflow");

    assert.deepEqual(tool.inputSchema.required, ["script"], "only `script` is required");
    const inputProps = Object.keys(tool.inputSchema.properties ?? {});
    assert.ok(!inputProps.includes("startInBackground"), "startInBackground is not advertised");
    assert.ok(inputProps.includes("resumeFromRunId"), "explicit resume knob is advertised");
    assert.ok(inputProps.includes("checkpointReplies"), "durable checkpoint reply channel is advertised");
    assert.ok(inputProps.includes("concurrency") && inputProps.includes("agentRetries"));

    // The machine-readable output core includes structured pause contexts.
    assert.ok(tool.outputSchema, "an output schema is declared");
    const outProps = Object.keys(field(tool.outputSchema, "properties") ?? {});
    for (const k of ["runId", "status", "result", "tokenUsage", "logs", "authContext", "checkpointContext"]) {
      assert.ok(outProps.includes(k), `output schema exposes ${k}`);
    }
  } finally {
    await dispose();
  }
});

test("completed run -> isError:false, structuredContent is the WorkflowRunResult core (status completed)", async () => {
  // listTools:true caches the client-side output-schema validator, so a green result here
  // also proves the completed structuredContent VALIDATES against the advertised schema.
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });

    assert.equal(res.isError, false, "a completed run is not an error");
    const sc = structured(res);
    assert.ok(sc, "structuredContent is mandatory when an outputSchema is declared");

    assert.equal(typeof sc.runId, "string");
    assert.match(String(sc.runId), RUN_ID, "the engine owns/stamps the run id");
    assert.equal(sc.status, "completed", "the engine stamped a terminal completed status");
    assert.equal(sc.result, "stub:hello", "result is the script's resolved value (raw agent text)");
    assert.ok(Array.isArray(sc.logs), "logs is a string array");

    // tokenUsage is schema-optional, but the engine always summarizes a completed run.
    const usage = sc.tokenUsage;
    assert.ok(usage && typeof usage === "object", "tokenUsage present for a completed run");
    assert.equal(typeof field(usage, "total"), "number");
    assert.equal(typeof field(usage, "input"), "number");

    // A human-readable text block accompanies the structured core.
    const text = textOf(res);
    assert.match(text, /completed/, "summary names the terminal status");
    assert.match(text, /agents:/, "summary reflects engine-computed run stats");
    assert.ok(text.includes(String(sc.runId)), "summary echoes the engine run id");
  } finally {
    await dispose();
  }
});

test("tool boundary: over-max concurrency/agentRetries are CLAMPED, not rejected with InvalidParams", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    // If the boundary rejected these, the SDK would surface an isError result whose text
    // begins "Input validation error: ...". Instead the run executes to completion.
    const res = await client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, concurrency: 1000, agentRetries: 99 },
    });

    assert.equal(res.isError, false, "over-max knobs are accepted, not rejected");
    assert.doesNotMatch(textOf(res), /Input validation error/i, "no InvalidParams was raised");
    const sc = structured(res);
    assert.equal(sc?.status, "completed");
    assert.equal(sc?.result, 42, "the script ran with clamped knobs");
  } finally {
    await dispose();
  }
});

test("paused run -> shell does NOT throw: isError:false, status 'paused', resetHint + resume hint pass through", async () => {
  // A provider usage-limit is non-recoverable -> the engine checkpoints the run as PAUSED
  // (resumable) and resolves a terminal result; the shell projects it without throwing.
  // Regression (output-schema fix): listTools:true caches the client-side output-schema
  // validator, so a paused run with NO `result` (now `.optional()`) must still validate —
  // before the fix this threw McpError -32602 "must have required property 'result'".
  const runner = throwingRunner(
    () =>
      new WorkflowError("usage limit reached. Resets in ~3h", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
        resetHint: "Resets in ~3h",
      }),
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });

    assert.equal(res.isError, false, "paused is resumable, NOT an error");
    const sc = structured(res);
    assert.ok(sc);
    assert.equal(sc.status, "paused", "the engine stamped a paused status (shell did not derive it)");
    assert.match(String(sc.runId), RUN_ID);

    const text = textOf(res);
    assert.match(text, /paused/, "summary reports the paused status");
    assert.ok(text.includes("Resets in ~3h"), "the provider resetHint passes through verbatim");
    assert.ok(text.includes(String(sc.runId)) && text.includes("resumeFromRunId"), "summary tells the host how to resume");
  } finally {
    await dispose();
  }
});

test("failed run -> shell does NOT throw: returns isError:true with status 'failed' (engine-stamped)", async () => {
  // A non-recoverable, non-usage-limit failure -> the engine stamps status 'failed' and
  // runSync RESOLVES (does not reject); the handler maps failed -> isError:true. The shell
  // never throws on fail. Regression: listTools:true (output-schema fix — a failed run omits
  // `result`) AND the reason is the REAL error, not "Unhandled error" (the engine now persists/
  // releases the lease and guards the unheard 'error' emit, so the real WorkflowError propagates).
  const runner = throwingRunner(
    () => new WorkflowError("schema never satisfied", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false }),
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });

    assert.equal(res.isError, true, "a failed run maps to isError:true");
    const sc = structured(res);
    assert.ok(sc, "a failed run still returns a structured terminal result (not a thrown error)");
    assert.equal(sc.status, "failed", "the engine stamped a failed status");
    assert.match(String(sc.runId), RUN_ID);

    const text = textOf(res);
    assert.match(text, /schema never satisfied/, "the failed run's reason is the REAL WorkflowError message");
    assert.ok(!/unhandled error/i.test(text), "the real error is not masked by ERR_UNHANDLED_ERROR");
  } finally {
    await dispose();
  }
});

test("malformed script (no meta export) -> isError:true with the parse message, no structuredContent", async () => {
  // parseWorkflowScript throws BEFORE a run exists (no runId), so the throw propagates to
  // the SDK, which surfaces it as a tool error with NO structuredContent.
  const { client, dispose } = await connect(okRunner());
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: 'await agent("hi");' } });

    assert.equal(res.isError, true, "a parse failure is a tool error");
    assert.equal(res.structuredContent, undefined, "no run -> no structuredContent");
    assert.match(textOf(res), /must be the first statement in the script/, "the parse error explains the meta requirement");
  } finally {
    await dispose();
  }
});

test("malformed script (meta present but invalid) -> isError:true with the validation message", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const res = await client.callTool({
      name: "workflow",
      arguments: { script: 'export const meta = { description: "missing a name" };\nreturn 1;' },
    });

    assert.equal(res.isError, true);
    assert.equal(res.structuredContent, undefined);
    assert.match(textOf(res), /meta\.name must be a non-empty string/, "meta validation rejects a nameless workflow");
  } finally {
    await dispose();
  }
});
