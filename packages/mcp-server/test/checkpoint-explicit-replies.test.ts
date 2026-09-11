import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createWorkflowServer } from "../src/index.js";
import { okRunner, structured, textOf, waitForRun } from "./_harness.js";

const cases = [
  { kind: "confirm", options: { kind: "confirm", timeoutMs: 10 }, answer: false },
  { kind: "input", options: { kind: "input", timeoutMs: 10 }, answer: "" },
  { kind: "select", options: { kind: "select", choices: ["ship", "hold"], timeoutMs: 10 }, answer: "hold" },
] as const;

for (const scenario of cases) {
  test(`non-App ${scenario.kind} checkpoints preserve an unanswered timeout and return the explicit answer`, async () => {
    const server = createWorkflowServer(okRunner());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "checkpoint-explicit-reply", version: "0.0.0" }, {
      capabilities: { elicitation: { form: {} } },
    });
    let inlineRequests = 0;
    client.setRequestHandler("elicitation/create", async () => {
      inlineRequests += 1;
      return { action: "decline" };
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.listTools();
      const accepted = await client.callTool({ name: "workflow", arguments: {
        action: "run", script: `export const meta = { name: "explicit-${scenario.kind}", description: "durable answer" };\nreturn await checkpoint("Choose", ${JSON.stringify(scenario.options)});`,
      } });
      assert.equal(accepted.isError, false, textOf(accepted));
      assert.equal(structured(accepted)?.accepted, true);
      const runId = String(structured(accepted)?.runId);
      await waitForRun(client, runId, status => status.status === "paused");
      await setTimeout(25);
      const observation = structured(await client.callTool({ name: "workflow", arguments: { action: "status", runId } }));
      assert.equal(observation?.status, "paused", "an interaction deadline cannot answer or cancel a checkpoint");
      const outcome = observation?.outcome as Record<string, unknown>;
      const context = outcome.checkpointContext as Record<string, unknown>;
      assert.equal(context.kind, scenario.kind);
      assert.equal(context.timeoutMs, 10);
      assert.equal("default" in context, false);
      assert.equal("headless" in context, false);
      assert.equal(outcome.result, undefined);
      assert.equal(inlineRequests, 0, "form capability never opens an inline checkpoint request");

      const resumed = await client.callTool({ name: "workflow", arguments: {
        action: "resume", runId, checkpointReplies: { "0": scenario.answer },
      } });
      assert.equal(resumed.isError, false, textOf(resumed));
      assert.equal(structured(resumed)?.accepted, true);
      const completed = structured(await waitForRun(client, runId, status => status.status === "completed"));
      assert.equal((completed?.outcome as Record<string, unknown>).result, scenario.answer);
      assert.equal(inlineRequests, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });
}
