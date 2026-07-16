// Full credential-free e2e: real MCP stdio server -> workflow engine -> first-class PiBackend ->
// real pi-acp transport -> real Pi AgentSession with its documented injected stream seam.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const PI_FIXTURE = fileURLToPath(new URL("../../pi-acp/test/fixtures/hermetic-pi-acp.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const SCRIPT = [
  'export const meta = { name: "pi-hermetic-e2e", description: "exercise the first-class Pi ladder" };',
  'const answer = await agent("Reply with hermetic pong.");',
  "return answer;",
].join("\n");

test("first-class pi runs end to end through pi-acp's credential-free AgentSession seam", {
  timeout: 60_000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "agentprism-pi-e2e-home-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      AGENTPRISM_DEFAULT_BACKEND: "pi",
      AGENTPRISM_PI_ACP_CMD: process.execPath,
      AGENTPRISM_PI_ACP_ARGS: PI_FIXTURE,
    } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "pi-hermetic-e2e", version: "0.0.0" }, { capabilities: {} });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });

  try {
    await client.connect(transport);
    await client.listTools();
    const response = await client.callTool({
      name: "workflow",
      arguments: { script: SCRIPT },
    }, undefined, { timeout: 45_000, maxTotalTimeout: 45_000 });
    const result = response.structuredContent as Record<string, unknown> | undefined;
    assert.equal(response.isError, false, stderr);
    assert.equal(result?.status, "completed", stderr);
    assert.equal(result?.result, "hermetic pong", stderr);
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});
