import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import { createWorkflowServer } from "../src/index.js";
import { okRunner, structured, textOf, type ToolCallResult } from "./_harness.js";

interface CheckpointConnection {
  callWorkflow: (script: string, options?: Record<string, unknown>) => Promise<ToolCallResult>;
  requests: () => ElicitRequest[];
  dispose: () => Promise<void>;
}

async function connectCheckpoint(
  respond: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>,
): Promise<CheckpointConnection> {
  const server = createWorkflowServer(okRunner());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-checkpoint-test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  const requests: ElicitRequest[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    requests.push(request);
    return await respond(request);
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    callWorkflow: (script: string, options: Record<string, unknown> = {}) =>
      client.callTool({ name: "workflow", arguments: { script, ...options } }),
    requests: () => requests,
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

function formSchema(request: ElicitRequest) {
  assert.ok("requestedSchema" in request.params, "checkpoint elicitation should use form mode");
  return request.params.requestedSchema;
}

test("checkpoint select uses an enum field and returns the selected choice", async () => {
  const conn = await connectCheckpoint(() => ({ action: "accept", content: { choice: "alpha" } }));
  try {
    const script = `export const meta = { name: 'select-cp', description: 'select checkpoint' }
return await checkpoint('Pick one', { kind: 'select', choices: ['alpha', 'beta'], default: 'beta' })`;

    const res = await conn.callWorkflow(script);

    assert.equal(res.isError, false);
    assert.equal(structured(res)?.result, "alpha");
    assert.equal(conn.requests().length, 1);
    const schema = formSchema(conn.requests()[0]);
    assert.deepEqual(schema.properties.choice, {
      type: "string",
      title: "Choice",
      description: "Select one option for this checkpoint.",
      enum: ["alpha", "beta"],
      default: "beta",
    });
    assert.deepEqual(schema.required, ["choice"]);
  } finally {
    await conn.dispose();
  }
});

test("checkpoint timeout falls back to the declared default", async () => {
  const conn = await connectCheckpoint(() => new Promise<ElicitResult>(() => {}));
  try {
    const script = `export const meta = { name: 'timeout-cp', description: 'checkpoint timeout' }
return await checkpoint('Name?', { kind: 'input', default: 'fallback-name', timeoutMs: 5 })`;

    const res = await conn.callWorkflow(script);

    assert.equal(res.isError, false);
    assert.equal(structured(res)?.result, "fallback-name");
    assert.equal(conn.requests().length, 1, "the server tried to elicit before timing out");
  } finally {
    await conn.dispose();
  }
});

test("changed checkpoint timeout/default inputs run the host channel instead of replaying a stale decision", async () => {
  const conn = await connectCheckpoint(() => new Promise<ElicitResult>(() => {}));
  try {
    const sourceScript = `export const meta = { name: 'timeout-resume', description: 'checkpoint input identity' }
return await checkpoint('Proceed?', { kind: 'confirm', default: false, timeoutMs: 0 })`;
    const changedScript = `export const meta = { name: 'timeout-resume', description: 'checkpoint input identity' }
return await checkpoint('Proceed?', { kind: 'confirm', default: true, timeoutMs: 0 })`;
    const source = await conn.callWorkflow(sourceScript);
    assert.equal(structured(source)?.result, false);

    const resumed = await conn.callWorkflow(changedScript, {
      resumeFromRunId: String(structured(source)?.runId),
    });
    assert.equal(structured(resumed)?.result, true);
    const report = structured(resumed)?.resumeReport as Record<string, unknown> | undefined;
    assert.equal(report?.strategy, "identity-v1");
    assert.equal(report?.replayed, 0);
    assert.equal(report?.live, 1);
    assert.deepEqual(report?.calls, [
      { index: 0, kind: "checkpoint", action: "live", reason: "inputs-changed" },
    ]);
    assert.equal(conn.requests().length, 2, "the changed call invokes MCP elicitation again");
    assert.match(
      textOf(resumed),
      /^WARNING: resume: identity-v1; predicted replayable prefix 1; replayed prefix 0; 0 replayed, 1 live, 0 failed$/m,
    );
    assert.match(textOf(resumed), /first non-replay: call 0 inputs-changed/);
  } finally {
    await conn.dispose();
  }
});

test("checkpoint confirm keeps the existing approve boolean path", async () => {
  const conn = await connectCheckpoint(() => ({ action: "accept", content: { approve: false } }));
  try {
    const script = `export const meta = { name: 'confirm-cp', description: 'confirm checkpoint' }
return await checkpoint('Proceed?', { kind: 'confirm', default: true })`;

    const res = await conn.callWorkflow(script);

    assert.equal(res.isError, false);
    assert.equal(structured(res)?.result, false);
    assert.equal(conn.requests().length, 1);
    const schema = formSchema(conn.requests()[0]);
    assert.deepEqual(schema.properties.approve, {
      type: "boolean",
      title: "Approve",
      description: "Approve this checkpoint to let the workflow continue.",
    });
    assert.deepEqual(schema.required, ["approve"]);
    assert.equal("choice" in schema.properties, false);
    assert.equal("value" in schema.properties, false);
  } finally {
    await conn.dispose();
  }
});
