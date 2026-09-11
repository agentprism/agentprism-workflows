import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "../src/mcp-apps.js";
import { SKILLS_EXTENSION_ID } from "../src/authoring-skills.js";
import { makeProjectDir, startDaemon } from "./_http-harness.js";
import { okRunner } from "./_harness.js";

const SCRIPT = `export const meta = { name: "v1-client", description: "v1 client" }; return 42;`;

test("released SDK v1 client retains the sessionful legacy end-to-end path", async () => {
  const daemon = await startDaemon(okRunner());
  const transport = new StreamableHTTPClientTransport(new URL(daemon.url));
  const client = new Client(
    { name: "released-v1-client", version: "1" },
    {
      capabilities: {
        extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
      },
    },
  );
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION_ID], { directoryRead: true });
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "repl", "workflow", "workflow-events", "workflow-notifications", "workflow-runs", "workflow_monitor",
    ]);
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: SCRIPT, projectDir: makeProjectDir("released-v1-client") },
    });
    assert.equal(accepted.isError, false, JSON.stringify(accepted));
    const acknowledgement = accepted.structuredContent as Record<string, unknown>;
    assert.equal(acknowledgement.accepted, true);
    assert.equal(typeof acknowledgement.runId, "string");
    assert.equal(acknowledgement.result, undefined);
    const runId = acknowledgement.runId as string;
    let status: Record<string, unknown> = {};
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
      assert.equal(response.isError, false, JSON.stringify(response));
      status = response.structuredContent as Record<string, unknown>;
      assert.equal(status.runId, runId);
      if (["completed", "paused", "failed", "aborted"].includes(String(status.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status.status, "completed", JSON.stringify(status));
    assert.equal((status.outcome as Record<string, unknown>).status, "completed");
    assert.equal(status.resultUri, `workflow://runs/${runId}/result`);
    const result = await client.readResource({ uri: status.resultUri as string });
    const content = result.contents[0];
    assert.ok(content && "text" in content && typeof content.text === "string");
    assert.equal(JSON.parse(content.text), 42);
    assert.equal(typeof transport.sessionId, "string");
    assert.equal(daemon.sessions.size, 1);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
});
