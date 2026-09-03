import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "../src/mcp-apps.js";
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
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["docs", "repl", "workflow", "workflow-events", "workflow-runs"]);
    const result = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: SCRIPT, projectDir: makeProjectDir("released-v1-client") },
    });
    assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.status, "completed");
    assert.equal(typeof transport.sessionId, "string");
    assert.equal(daemon.sessions.size, 1);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
});
