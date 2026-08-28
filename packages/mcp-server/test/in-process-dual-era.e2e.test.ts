import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "../src/mcp-apps.js";

const distEntry = resolve(fileURLToPath(import.meta.url), "../../dist/entry.js");
const SCRIPT = `export const meta = { name: "stdio-modern", description: "stdio modern" }; return 42;`;

async function connectModern(apps: boolean) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry, "--in-process"],
    stderr: "pipe",
  });
  const client = new Client(
    { name: "in-process-modern-test", version: "1" },
    {
      capabilities: apps
        ? { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } }
        : {},
      versionNegotiation: { mode: "auto" },
    },
  );
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => undefined) };
}

test("--in-process uses serveStdio to serve modern and capability-project the Apps surface", async () => {
  const capable = await connectModern(true);
  try {
    assert.equal(capable.client.getProtocolEra(), "modern");
    const tools = await capable.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["docs", "repl", "workflow", "workflow-events"]);
    const result = await capable.client.callTool({ name: "workflow", arguments: { script: SCRIPT } });
    assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.status, "completed");
  } finally {
    await capable.close();
  }

  const incapable = await connectModern(false);
  try {
    assert.equal(incapable.client.getProtocolEra(), "modern");
    const tools = await incapable.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["docs", "repl", "workflow"]);
    assert.equal(tools.tools.find((tool) => tool.name === "workflow")?._meta, undefined);
  } finally {
    await incapable.close();
  }
});
