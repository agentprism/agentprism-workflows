import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { AcpAgentRunner } from "../../acp-agents/dist/index.js";
import { StructuredOutputToolHost } from "../../acp-agents/dist/structured-tool.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const MODEL = process.env.AGENTPRISM_PI_E2E_MODEL;
const HAS_KEY = Boolean(
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.XAI_API_KEY ||
  process.env.OPENROUTER_API_KEY,
);
function liveReady(): boolean {
  if (!LIVE) return false;
  assert.ok(MODEL, "AGENTPRISM_LIVE_E2E=1 requires AGENTPRISM_PI_E2E_MODEL");
  assert.ok(HAS_KEY, "AGENTPRISM_LIVE_E2E=1 requires the selected provider key");
  return true;
}

function installPiCommand(): () => void {
  const priorCommand = process.env.AGENTPRISM_PI_ACP_CMD;
  const priorArgs = process.env.AGENTPRISM_PI_ACP_ARGS;
  process.env.AGENTPRISM_PI_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_PI_ACP_ARGS = new URL("../dist/index.js", import.meta.url).pathname;
  return () => {
    if (priorCommand === undefined) delete process.env.AGENTPRISM_PI_ACP_CMD;
    else process.env.AGENTPRISM_PI_ACP_CMD = priorCommand;
    if (priorArgs === undefined) delete process.env.AGENTPRISM_PI_ACP_ARGS;
    else process.env.AGENTPRISM_PI_ACP_ARGS = priorArgs;
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(`condition did not become true within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function liveToolHost(): Promise<{ url: string; calls: () => number; close(): Promise<void> }> {
  let callCount = 0;
  const sessions = new Map<string, { protocol: Server; transport: StreamableHTTPServerTransport }>();
  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      const sessionId = req.headers["mcp-session-id"];
      let entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!entry && req.method === "POST") {
        const protocol = new Server(
          { name: "pi-live-http", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        protocol.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [{
            name: "live_echo",
            description: "Return the fixed live MCP sentinel",
            inputSchema: { type: "object", additionalProperties: false },
          }],
        }));
        protocol.setRequestHandler(CallToolRequestSchema, ({ params }) => {
          assert.equal(params.name, "live_echo");
          callCount += 1;
          return { content: [{ type: "text", text: "LIVE_HTTP_MCP_ROUND_TRIP_OK" }] };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized(id) { sessions.set(id, { protocol, transport }); },
          onsessionclosed(id) { sessions.delete(id); },
        });
        entry = { protocol, transport };
        await protocol.connect(transport);
      }
      if (!entry) {
        res.writeHead(404).end();
        return;
      }
      await entry.transport.handleRequest(req, res);
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
      else res.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls: () => callCount,
    async close() {
      await Promise.allSettled([...sessions.values()].flatMap(({ protocol, transport }) => [
        protocol.close(),
        transport.close(),
      ]));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

test("T23 built-in PiBackend validates through injected StructuredOutput plus common fallback", async () => {
  if (!liveReady()) {
    assert.equal(LIVE, false, "credential-free CI must leave the explicit live gate closed");
    return;
  }
  const restore = installPiCommand();
  const originalRegister = StructuredOutputToolHost.prototype.register;
  const captures: Array<{ reads: number; values: unknown[] }> = [];
  StructuredOutputToolHost.prototype.register = async function observedRegister(schema) {
    const registration = await originalRegister.call(this, schema);
    const observation = { reads: 0, values: [] as unknown[] };
    captures.push(observation);
    const tryCaptured = registration.tryCaptured;
    return {
      ...registration,
      tryCaptured() {
        observation.reads += 1;
        const value = tryCaptured();
        if (value !== undefined) observation.values.push(value);
        return value;
      },
    };
  };
  const runner = new AcpAgentRunner();
  try {
    const schema = Type.Object({ answer: Type.String() }, { additionalProperties: false });
    const result = await runner.run('Call the StructuredOutput tool exactly once with {"answer":"pong"}. After the tool call, reply only with the plain words capture complete, not JSON.', {
      model: `pi/${MODEL}`,
      schema,
    });
    assert.deepEqual(result, { answer: "pong" });
    assert.equal(captures[0]?.reads > 0, true);
    assert.deepEqual(captures[0]?.values, [{ answer: "pong" }], "the injected HTTP tool capture is the primary result");

    const fallback = await runner.run('Do not call any tool. Return exactly {"answer":"fallback"} and no other text.', {
      model: `pi/${MODEL}`,
      schema,
    });
    assert.deepEqual(fallback, { answer: "fallback" });
    assert.equal(captures[1]?.reads > 0, true);
    for (const value of captures[1]?.values ?? []) {
      // A live model may answer through the injected tool despite the prompt; either
      // channel must yield the validated result, and an empty capture proves the
      // last-text fallback path instead.
      assert.deepEqual(value, { answer: "fallback" });
    }
  } finally {
    await runner.dispose();
    StructuredOutputToolHost.prototype.register = originalRegister;
    restore();
  }
});

test("L1 real HTTP MCP round-trip and stopped sleep child is reaped", { timeout: 240_000 }, async () => {
  if (!liveReady()) {
    assert.equal(LIVE, false, "credential-free CI must leave the explicit live gate closed");
    return;
  }
  const restore = installPiCommand();
  const runner = new AcpAgentRunner();
  const host = await liveToolHost();
  const scratch = await mkdtemp(join(tmpdir(), "agentprism-pi-live-"));
  const pidFile = join(scratch, "sleep.pid");
  try {
    const result = await runner.run(
      "Call the live_echo tool exactly once, then return its exact result text and nothing else.",
      {
        model: `pi/${MODEL}`,
        mcpServers: [{ type: "http", name: "live_http", url: host.url, headers: [] }],
      },
    );
    assert.equal(host.calls(), 1);
    assert.match(result, /LIVE_HTTP_MCP_ROUND_TRIP_OK/);

    const controller = new AbortController();
    const running = runner.run(
      `Use the bash tool now to run exactly this command and wait for it: echo $$ > ${pidFile}; exec sleep 180`,
      { model: `pi/${MODEL}`, signal: controller.signal },
    );
    await waitFor(async () => readFile(pidFile, "utf8").then(() => true, () => false), 90_000);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid tracked child pid: ${pid}`);
    assert.equal(processIsGone(pid), false);
    controller.abort(new Error("live stop-and-reap proof"));
    await assert.rejects(running);
    await waitFor(() => processIsGone(pid), 15_000);
  } finally {
    await Promise.allSettled([runner.dispose(), host.close()]);
    await rm(scratch, { recursive: true, force: true });
    restore();
  }
});
