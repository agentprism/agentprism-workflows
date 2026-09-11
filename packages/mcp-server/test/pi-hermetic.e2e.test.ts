// Full credential-free e2e: real MCP stdio server -> workflow engine -> first-class PiBackend ->
// real pi-acp transport -> real Pi AgentSession with its documented injected stream seam.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const SERVER_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const PI_FIXTURE = fileURLToPath(new URL("../../pi-acp/test/fixtures/hermetic-pi-acp.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const SCRIPT = [
  'export const meta = { model: "pi", name: "pi-hermetic-e2e", description: "exercise the first-class Pi ladder" };',
  'const answer = await agent("Reply with hermetic pong.");',
  "return answer;",
].join("\n");

const STRUCTURED_SCRIPT = [
  'export const meta = { model: "pi", name: "pi-hermetic-structured-e2e", description: "exercise Pi StructuredOutput injection" };',
  'const answer = await agent("Return the requested structured answer.", { schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } } });',
  "return answer;",
].join("\n");

async function runAndReadExactResult(client: Client, script: string): Promise<unknown> {
  const deadline = Date.now() + 45_000;
  const call = (arguments_: Record<string, unknown>) => {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "Pi workflow observation exceeded 45 seconds");
    return client.callTool({ name: "workflow", arguments: arguments_ }, {
      timeout: remaining, maxTotalTimeout: remaining,
    });
  };
  const accepted = await call({ action: "run", script });
  assert.equal(accepted.isError, false, JSON.stringify(accepted));
  const acknowledgement = accepted.structuredContent as Record<string, unknown>;
  assert.equal(acknowledgement.accepted, true);
  assert.equal(typeof acknowledgement.runId, "string");
  assert.equal(acknowledgement.result, undefined);
  const runId = acknowledgement.runId as string;
  let status: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await call({ action: "status", runId });
    assert.equal(response.isError, false, JSON.stringify(response));
    status = response.structuredContent as Record<string, unknown>;
    assert.equal(status.runId, runId);
    if (["completed", "paused", "failed", "aborted"].includes(String(status.status))) break;
    assert.notEqual((status.setup as Record<string, unknown> | undefined)?.state, "input-required",
      `The configured hermetic Pi backend must execute without setup input: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, "completed", JSON.stringify(status));
  const outcome = status.outcome as Record<string, unknown>;
  assert.equal(outcome.runId, runId);
  assert.equal(outcome.status, "completed");
  assert.equal(status.resultUri, `workflow://runs/${runId}/result`);
  const result = await client.readResource({ uri: status.resultUri as string });
  const content = result.contents[0];
  assert.ok(content && "text" in content && typeof content.text === "string");
  return JSON.parse(content.text);
}

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
    assert.equal(await runAndReadExactResult(client, SCRIPT), "hermetic pong", stderr);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n${stderr}`);
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("first-class pi captures schema output through the injected HTTP MCP tool", {
  timeout: 60_000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "agentprism-pi-structured-e2e-home-"));
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
  const client = new Client({ name: "pi-hermetic-structured-e2e", version: "0.0.0" }, { capabilities: {} });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
  try {
    await client.connect(transport);
    await client.listTools();
    assert.deepEqual(await runAndReadExactResult(client, STRUCTURED_SCRIPT), { answer: "pong" }, stderr);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n${stderr}`);
  } finally {
    try { await client.close(); } finally {
      await transport.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});
