import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { AgentContext, McpServer } from "@agentclientprotocol/sdk";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bridgeMcpServers, createMcpRootsResult, type McpSessionBinding } from "../src/mcp-bridge.js";
import { realSleep, resolveDeps } from "../src/deps.js";
import { createConformanceServer } from "./fixtures/full-mcp-server.mjs";

interface Host {
  url: string;
  seenHeaders: string[];
  close(): Promise<void>;
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function httpHost(): Promise<Host> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createConformanceServer> }>();
  const seenHeaders: string[] = [];
  const http = createServer((req, res) => {
    void (async () => {
      seenHeaders.push(String(req.headers["x-repeat"] ?? ""));
      const sessionId = req.headers["mcp-session-id"];
      let entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!entry && req.method === "POST") {
        const protocol = createConformanceServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized(id) { sessions.set(id, { transport, server: protocol }); },
          onsessionclosed(id) { sessions.delete(id); },
        });
        entry = { transport, server: protocol };
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
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenHeaders,
    async close() {
      await Promise.allSettled([...sessions.values()].flatMap(({ transport, server }) => [server.close(), transport.close()]));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function sseHost(): Promise<Host> {
  const sessions = new Map<string, { transport: SSEServerTransport; server: ReturnType<typeof createConformanceServer> }>();
  const seenHeaders: string[] = [];
  const http = createServer((req, res) => {
    void (async () => {
      seenHeaders.push(String(req.headers["x-repeat"] ?? ""));
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        const protocol = createConformanceServer();
        sessions.set(transport.sessionId, { transport, server: protocol });
        await protocol.connect(transport);
        return;
      }
      if (req.method === "POST" && url.pathname === "/messages") {
        const entry = sessions.get(url.searchParams.get("sessionId") ?? "");
        if (!entry) return void res.writeHead(404).end();
        await entry.transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
      else res.destroy(error as Error);
    });
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/sse`,
    seenHeaders,
    async close() {
      await Promise.allSettled([...sessions.values()].flatMap(({ transport, server }) => [server.close(), transport.close()]));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "fixture",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function transcript(server: McpServer): Promise<{ updates: unknown[]; diagnostics: string[]; completions: string[] }> {
  const diagnostics: string[] = [];
  const completions: string[] = [];
  const model = {
    api: "openai-completions", provider: "test", id: "fixture", name: "fixture", input: ["text"],
    baseUrl: "https://example.invalid", reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
  } as never;
  const modelRuntime = {
    async completeSimple(_model: unknown, context: { systemPrompt?: string }, options: { onPayload?: (payload: unknown) => unknown }) {
      assert.equal(context.systemPrompt, "fixture system");
      options.onPayload?.({ messages: [{ role: "user", content: "sample me" }] });
      return assistant("sampled");
    },
  } as never;
  const acpClient = {
    async request(_method: string, params: { mode: string }) {
      return params.mode === "form"
        ? { action: "accept", content: { answer: "accepted" } }
        : { action: "accept" };
    },
    async notify(_method: string, params: { elicitationId: string }) { completions.push(params.elicitationId); },
  } as unknown as AgentContext;
  let pi: {
    model: typeof model;
    modelRuntime: typeof modelRuntime;
    getActiveToolNames(): string[];
    setActiveToolsByName(names: string[]): void;
  } | undefined;
  const lifecycle = new AbortController();
  const binding: McpSessionBinding = {
    sessionId: `session-${server.name}`,
    cwd: process.cwd(),
    client: acpClient,
    sessionSignal: lifecycle.signal,
    getPi: () => pi as never,
    getTurnSignal: () => undefined,
    isPublished: () => true,
    emitDiagnostic: (value) => diagnostics.push(value),
    ownerToken: {},
    modelRuntime,
  };
  const deps = await resolveDeps({ modelRuntime, mcpTimeoutMs: 5_000, sleep: realSleep });
  const bridge = await bridgeMcpServers([server], new AbortController().signal, deps, binding);
  try {
  const registered = new Map<string, ToolDefinition>();
  const hooks: Array<(event: { systemPrompt: string }) => unknown> = [];
  const api = {
    registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); },
    on(event: string, handler: (value: { systemPrompt: string }) => unknown) { if (event === "before_agent_start") hooks.push(handler); },
  } as unknown as ExtensionAPI;
  const mcpFactory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
  const instructionFactory = typeof bridge.instructionsExtension === "function" ? bridge.instructionsExtension : bridge.instructionsExtension.factory;
  await mcpFactory(api);
  await instructionFactory(api);
  let active = [...registered.keys()];
  pi = {
    model,
    modelRuntime,
    getActiveToolNames: () => [...active],
    setActiveToolsByName(names) { active = [...names]; },
  };
  bridge.bindSession(pi as never);
  assert.match(String(hooks[0]?.({ systemPrompt: "base" }) && (hooks[0]?.({ systemPrompt: "base" }) as { systemPrompt: string }).systemPrompt), /fixture instructions/);

  const updates: unknown[] = [];
  const execute = async (suffix: string, params: Record<string, unknown> = {}, controller = new AbortController()) => {
    const tool = [...registered.values()].find(({ name }) => name.endsWith(`__${suffix}`));
    assert.ok(tool, `${server.name}:${suffix}`);
    return tool.execute(`call-${suffix}`, params, controller.signal, (update) => updates.push(update));
  };
  const exercised = await execute("exercise");
  assert.equal(exercised.details !== undefined, true);
  const clientFeatures = (exercised.details as { structuredContent: unknown }).structuredContent as {
    sampling: { content: { type: string; text: string } };
    roots: { roots: Array<{ uri: string }> };
    form: { action: string; content: { answer: string } };
    url: { action: string };
    incomingProgress: Record<"sampling" | "roots" | "form" | "url", Array<{ progress: number; total: number }>>;
  };
  assert.ok(clientFeatures.sampling);
  assert.ok(clientFeatures.sampling.content);
  assert.equal(clientFeatures.sampling.content.text, "sampled");
  assert.equal(clientFeatures.roots.roots[0]?.uri, pathToFileURL(process.cwd()).href);
  assert.deepEqual(clientFeatures.form, { action: "accept", content: { answer: "accepted" } });
  assert.deepEqual(clientFeatures.url, { action: "accept" });
  for (const [feature, values] of Object.entries(clientFeatures.incomingProgress)) {
    if (feature === "roots") continue;
    const expected = [
      { progress: 0, total: 1 },
      { progress: 1, total: 1 },
    ];
    assert.deepEqual(values.map(({ progress, total }) => ({ progress, total })), expected, `${server.name}:${feature}`);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completions.length, 1);
  assert.equal((await execute("list_resources")).details !== undefined, true);
  assert.equal((await execute("list_resource_templates")).details !== undefined, true);
  assert.equal((await execute("read_resource", { uri: "file:///one" })).details !== undefined, true);
  await execute("subscribe_resource", { uri: "file:///one" });
  await execute("unsubscribe_resource", { uri: "file:///one" });
  assert.equal((await execute("list_prompts")).details !== undefined, true);
  assert.equal((await execute("get_prompt", { name: "one" })).details !== undefined, true);
  const completion = await execute("complete", {
    ref: { type: "ref/prompt", name: "one" }, argument: { name: "arg", value: "a" },
  });
  assert.match((completion.content[0] as { text: string }).text, /alpha/);
  const resourceCompletion = await execute("complete", {
    ref: { type: "ref/resource", uri: "file:///one" }, argument: { name: "arg", value: "a" },
  });
  assert.match((resourceCompletion.content[0] as { text: string }).text, /beta/);
  const cancellation = new AbortController();
  const hanging = execute("hang", {}, cancellation);
  setImmediate(() => cancellation.abort(new Error("fixture abort")));
  await assert.rejects(hanging, /MCP tool .* failed/);
  await execute("trigger_dynamic");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await bridge.drainRefreshes();
  assert.ok(registered.has(`mcp__${server.name}__dynamic`));
  assert.ok(active.includes(`mcp__${server.name}__dynamic`));
  return { updates, diagnostics, completions };
  } finally {
    await bridge.close();
    lifecycle.abort();
  }
}

test("M7 roots sends the exact synchronous progress pair around its result", () => {
  const lifecycle = new AbortController();
  const request = new AbortController();
  const notifications: unknown[] = [];
  const result = createMcpRootsResult(
    { cwd: process.cwd(), sessionSignal: lifecycle.signal },
    "roots-progress",
    {
      signal: request.signal,
      async sendNotification(notification) { notifications.push(notification); },
    },
    () => assert.fail("progress send unexpectedly failed"),
  );
  assert.deepEqual(notifications, [
    { method: "notifications/progress", params: { progressToken: "roots-progress", progress: 0, total: 1 } },
    { method: "notifications/progress", params: { progressToken: "roots-progress", progress: 1, total: 1 } },
  ]);
  assert.deepEqual(result, { roots: [{ uri: pathToFileURL(process.cwd()).href, name: process.cwd().split("/").at(-1) }] });
});

test("M1-M7 full MCP transcript is transport-independent across real stdio/http/sse", { timeout: 30_000 }, async () => {
  const fixture = new URL("./fixtures/full-mcp-server.mjs", import.meta.url).pathname;
  const http = await httpHost();
  const sse = await sseHost();
  try {
    const rows: McpServer[] = [
      { name: "stdio", command: process.execPath, args: [fixture], env: [] },
      { name: "http", type: "http", url: http.url, headers: [{ name: "x-repeat", value: "one" }, { name: "x-repeat", value: "two" }] },
      { name: "sse", type: "sse", url: sse.url, headers: [{ name: "x-repeat", value: "one" }, { name: "x-repeat", value: "two" }] },
    ];
    const results = [];
    for (const row of rows) results.push(await transcript(row));
    for (const result of results) {
      assert.ok(result.updates.some((value) => JSON.stringify(value).includes("half")));
      assert.ok(result.diagnostics.some((value) => value.includes("info")));
      assert.ok(result.diagnostics.some((value) => value.includes("notifications/resources/list_changed")));
      assert.ok(result.diagnostics.some((value) => value.includes("notifications/resources/updated")));
      assert.ok(result.diagnostics.some((value) => value.includes("notifications/prompts/list_changed")));
      assert.equal(result.completions.length, 1);
    }
    assert.ok(http.seenHeaders.some((value) => value === "one, two"));
    assert.ok(sse.seenHeaders.some((value) => value === "one, two"));
  } finally {
    await Promise.allSettled([http.close(), sse.close()]);
  }
});
