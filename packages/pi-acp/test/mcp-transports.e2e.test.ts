import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { AgentContext, McpServer } from "@agentclientprotocol/sdk";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bridgeMcpServers, connectDefaultMcpClient, createMcpRootsResult, type McpSessionBinding } from "../src/mcp-bridge.js";
import { realSleep, resolveDeps } from "../src/deps.js";
import { createConformanceServer } from "./fixtures/full-mcp-server.mjs";

interface Host {
  url: string;
  seenHeaders: string[];
  close(): Promise<void>;
}

async function eventually(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function requestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, value: unknown, sessionId?: string): void {
  res.writeHead(200, {
    "content-type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });
  res.end(JSON.stringify(value));
}

async function fatalStreamableHost(
  deleteMode: "success" | "405" | "error" | "hang" = "success",
  advertiseSession = true,
): Promise<Host & {
  methods: string[];
  waitForGet(): Promise<void>;
  breakGet(mode: "eof" | "error"): void;
}> {
  const methods: string[] = [];
  const sessionId = randomUUID();
  let getResponse: ServerResponse | undefined;
  let getResolve!: () => void;
  const getReady = new Promise<void>((resolve) => { getResolve = resolve; });
  const http = createServer((req, res) => {
    methods.push(req.method ?? "");
    void (async () => {
      if (req.method === "GET") {
        getResponse = res;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": connected\n\n");
        getResolve();
        return;
      }
      if (req.method === "DELETE") {
        if (deleteMode === "hang") return;
        if (deleteMode === "error") {
          req.socket.destroy(new Error("fixture DELETE failure"));
          return;
        }
        res.writeHead(deleteMode === "405" ? 405 : 200).end();
        return;
      }
      if (req.method !== "POST") return void res.writeHead(405).end();
      const message = await requestJson(req);
      if (message.id === undefined) return void res.writeHead(202).end();
      if (message.method === "initialize") {
        const params = message.params as { protocolVersion: string };
        sendJson(res, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: params.protocolVersion,
            capabilities: {},
            serverInfo: { name: "fatal-http", version: "1.0.0" },
          },
        }, advertiseSession ? sessionId : undefined);
        return;
      }
      sendJson(res, { jsonrpc: "2.0", id: message.id, result: {} });
    })().catch((error) => res.destroy(error as Error));
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methods,
    seenHeaders: [],
    waitForGet: () => getReady,
    breakGet(mode) {
      assert.ok(getResponse);
      if (mode === "eof") getResponse.end();
      else getResponse.destroy(new Error("fixture GET stream failure"));
    },
    async close() {
      getResponse?.destroy();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function requestDrivenIdleHost(): Promise<Host & { methods: string[] }> {
  const methods: string[] = [];
  const sessionId = randomUUID();
  const hanging = new Set<ServerResponse>();
  const http = createServer((req, res) => {
    methods.push(req.method ?? "");
    void (async () => {
      if (req.method === "GET") return void res.writeHead(405).end();
      if (req.method === "DELETE") return void res.writeHead(200).end();
      if (req.method !== "POST") return void res.writeHead(405).end();
      const message = await requestJson(req);
      if (message.id === undefined) return void res.writeHead(202).end();
      if (message.method === "initialize") {
        const params = message.params as { protocolVersion: string };
        sendJson(res, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "request-driven-idle", version: "1.0.0" },
          },
        }, sessionId);
        return;
      }
      if (message.method === "tools/list") {
        sendJson(res, {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "hang", inputSchema: { type: "object", additionalProperties: false } }] },
        });
        return;
      }
      if (message.method === "tools/call") {
        hanging.add(res);
        res.once("close", () => hanging.delete(res));
        return;
      }
      sendJson(res, { jsonrpc: "2.0", id: message.id, result: {} });
    })().catch((error) => res.destroy(error as Error));
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methods,
    seenHeaders: [],
    async close() {
      for (const response of hanging) response.destroy();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function fatalSseHost(): Promise<Host & {
  methods: string[];
  breakStream(): void;
}> {
  const methods: string[] = [];
  const sessions = new Map<string, { transport: SSEServerTransport; server: ReturnType<typeof createConformanceServer> }>();
  let stream: ServerResponse | undefined;
  const http = createServer((req, res) => {
    methods.push(req.method ?? "");
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/sse") {
        stream = res;
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
    methods,
    seenHeaders: [],
    breakStream() {
      assert.ok(stream);
      stream.destroy(new Error("fixture SSE stream failure"));
    },
    async close() {
      stream?.destroy();
      await Promise.allSettled([...sessions.values()].flatMap(({ transport, server }) => [server.close(), transport.close()]));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function brokenOpeningHost(kind: "http" | "sse"): Promise<Host & { methods: string[] }> {
  const methods: string[] = [];
  const http = createServer((req, res) => {
    methods.push(req.method ?? "");
    if (kind === "http") {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end("event: endpoint\ndata: https://example.invalid/messages\n\n");
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/${kind}`,
    methods,
    seenHeaders: [],
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
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
  let urlRequests = 0;
  const acpClient = {
    async request(_method: string, params: { mode: string }) {
      if (params.mode === "url") urlRequests += 1;
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
  const deps = await resolveDeps({ modelRuntime, mcpTimeoutMs: 60_000, sleep: realSleep });
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
    urlReuse: { action: string };
  };
  assert.ok(clientFeatures.sampling);
  assert.ok(clientFeatures.sampling.content);
  assert.equal(clientFeatures.sampling.content.text, "sampled");
  assert.equal(clientFeatures.roots.roots[0]?.uri, pathToFileURL(process.cwd()).href);
  assert.deepEqual(clientFeatures.form, { action: "accept", content: { answer: "accepted" } });
  assert.deepEqual(clientFeatures.url, { action: "accept" });
  assert.deepEqual(clientFeatures.urlReuse, { action: "decline" });
  assert.equal(urlRequests, 1, "a consumed URL id must decline without a second ACP request");
  const progressSnapshot = await execute("progress_snapshot");
  const progressBlock = progressSnapshot.content[0];
  assert.equal(progressBlock?.type, "text");
  const incomingProgress = JSON.parse(progressBlock.text) as Record<"sampling" | "roots" | "form" | "url", Array<{ progress: number; total: number }>>;
  for (const [feature, values] of Object.entries(incomingProgress)) {
    if (feature === "roots") continue;
    const expected = [
      { progress: 0, total: 1 },
      { progress: 1, total: 1 },
    ];
    assert.deepEqual(values.map(({ progress, total }) => ({ progress, total })), expected, `${server.name}:${feature}`);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completions.length, 1);
  assert.deepEqual(await execute("list_resources"), {
    content: [{ type: "text", text: JSON.stringify({ resources: [
      { name: "one", uri: "file:///one" },
      { name: "two", uri: "file:///two" },
    ] }) }],
    details: { pages: [
      { resources: [{ uri: "file:///one", name: "one" }], nextCursor: "resource-page-2" },
      { resources: [{ uri: "file:///two", name: "two" }] },
    ] },
  });
  assert.deepEqual(await execute("list_resource_templates"), {
    content: [{ type: "text", text: JSON.stringify({ resourceTemplates: [
      { name: "one", uriTemplate: "file:///one/{name}" },
      { name: "two", uriTemplate: "file:///two/{name}" },
    ] }) }],
    details: { pages: [
      { resourceTemplates: [{ uriTemplate: "file:///one/{name}", name: "one" }], nextCursor: "template-page-2" },
      { resourceTemplates: [{ uriTemplate: "file:///two/{name}", name: "two" }] },
    ] },
  });
  assert.deepEqual(await execute("read_resource", { uri: "file:///one" }), {
    content: [{ type: "text", text: "read:file:///one" }],
    details: { contents: [{ uri: "file:///one", mimeType: "text/plain", text: "read:file:///one" }] },
  });
  assert.deepEqual(await execute("subscribe_resource", { uri: "file:///one" }), {
    content: [{ type: "text", text: "Subscribed to file:///one" }], details: {},
  });
  assert.deepEqual(await execute("unsubscribe_resource", { uri: "file:///one" }), {
    content: [{ type: "text", text: "Unsubscribed from file:///one" }], details: {},
  });
  assert.deepEqual(await execute("list_prompts"), {
    content: [{ type: "text", text: JSON.stringify({ prompts: [
      { name: "one", description: "one" },
      { name: "two", description: "two" },
    ] }) }],
    details: { pages: [
      { prompts: [{ name: "one", description: "one" }], nextCursor: "prompt-page-2" },
      { prompts: [{ name: "two", description: "two" }] },
    ] },
  });
  assert.deepEqual(await execute("get_prompt", { name: "one" }), {
    content: [
      { type: "text", text: "[mcp prompt description]\nprompt:one" },
      { type: "text", text: "[mcp prompt role=user]" },
      { type: "text", text: "prompt body" },
    ],
    details: {
      description: "prompt:one",
      messages: [{ role: "user", content: { type: "text", text: "prompt body" } }],
    },
  });
  const completion = await execute("complete", {
    ref: { type: "ref/prompt", name: "one" }, argument: { name: "arg", value: "a" },
  });
  assert.deepEqual(completion, {
    content: [{ type: "text", text: JSON.stringify({ values: ["alpha", "beta"], total: 2, hasMore: false }) }],
    details: { completion: { values: ["alpha", "beta"], total: 2, hasMore: false } },
  });
  const resourceCompletion = await execute("complete", {
    ref: { type: "ref/resource", uri: "file:///one" }, argument: { name: "arg", value: "a" },
  });
  assert.deepEqual(resourceCompletion, completion);
  const data = Buffer.from([0, 1, 2, 3]).toString("base64");
  const exactProjectionResult = {
    content: [
      { type: "text", text: "plain" },
      { type: "image", data, mimeType: "image/png" },
      { type: "audio", data, mimeType: "audio/wav" },
      { type: "resource_link", uri: "file:///linked", name: "linked", title: "Linked title" },
      { type: "resource", resource: { uri: "file:///embedded-text", mimeType: "text/plain", text: "embedded" } },
      { type: "resource", resource: { uri: "file:///embedded-blob", blob: data } },
    ],
    structuredContent: { exact: true },
    isError: false,
    _meta: { retained: true },
  };
  const projection = await execute("projection");
  assert.deepEqual(projection.details, exactProjectionResult);
  assert.deepEqual(projection.content, [
    { type: "text", text: "plain" },
    { type: "image", data, mimeType: "image/png" },
    { type: "text", text: "[audio mime=audio/wav bytes=4]" },
    { type: "text", text: "[Linked title](file:///linked)" },
    { type: "text", text: "embedded" },
    { type: "text", text: "[embedded resource uri=file:///embedded-blob mime=application/octet-stream bytes=4]" },
  ]);
  await assert.rejects(execute("remote_error"), /MCP tool .* failed/);
  assert.deepEqual(bridge.failedResults.get("call-remote_error"), {
    content: [{ type: "text", text: "peer-declared failure" }],
    details: {
      content: [{ type: "text", text: "peer-declared failure" }],
      isError: true,
      _meta: { retained: "error" },
    },
  });
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

async function raceHarness(server: McpServer) {
  const diagnostics: string[] = [];
  const lifecycle = new AbortController();
  let turn = new AbortController();
  let forceIncomingTimeout = false;
  const forcedTimers: Array<ReturnType<typeof deferred<void>>> = [];
  const starts = new Map<string, ReturnType<typeof deferred<void>>>();
  const late = new Map<string, () => void>();
  const key = (feature: string, cause: string) => `${feature}:${cause}`;
  const prepare = (feature: "sampling" | "form" | "url", cause: string) => {
    const operationStart = deferred<void>();
    starts.set(key(feature, cause), operationStart);
    if (feature === "sampling") {
      const completion = deferred<AssistantMessage>();
      late.set(key(feature, cause), () => completion.resolve(assistant("late-sampling")));
      return completion.promise;
    }
    const completion = deferred<{ action: "accept"; content?: { answer: string } }>();
    late.set(key(feature, cause), () => completion.resolve(feature === "form"
      ? { action: "accept", content: { answer: "late" } }
      : { action: "accept" }));
    return completion.promise;
  };
  const pending = new Map<string, Promise<unknown>>();
  const model = {
    api: "openai-completions", provider: "test", id: "race", name: "race", input: ["text"],
    baseUrl: "https://example.invalid", reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
  } as never;
  const modelRuntime = {
    async completeSimple(_model: unknown, _context: unknown, options: { metadata?: { raceCause?: string } }) {
      const cause = String(options.metadata?.raceCause ?? "ordinary");
      if (cause === "ordinary") return assistant("ordinary");
      starts.get(key("sampling", cause))?.resolve();
      if (cause === "timeout") forcedTimers.at(-1)?.resolve();
      return pending.get(key("sampling", cause)) as Promise<AssistantMessage>;
    },
  } as never;
  const acpClient = {
    async request(_method: string, params: { mode: "form" | "url"; message: string }) {
      const cause = params.message.replace("race:", "");
      if (cause === "ordinary") return params.mode === "form"
        ? { action: "accept", content: { answer: "ordinary" } }
        : { action: "accept" };
      starts.get(key(params.mode, cause))?.resolve();
      if (cause === "timeout") forcedTimers.at(-1)?.resolve();
      return pending.get(key(params.mode, cause));
    },
    async notify() {},
  } as unknown as AgentContext;
  let active: string[] = [];
  const pi = {
    model,
    modelRuntime,
    getActiveToolNames: () => [...active],
    setActiveToolsByName(names: string[]) { active = [...names]; },
  };
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    if (!forceIncomingTimeout) return realSleep(ms, signal);
    const timer = deferred<void>();
    forcedTimers.push(timer);
    const aborted = () => timer.reject(signal?.reason ?? new Error("timer aborted"));
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
    return timer.promise;
  };
  const deps = await resolveDeps({ modelRuntime, mcpTimeoutMs: 2_000, sleep });
  const bridge = await bridgeMcpServers([server], new AbortController().signal, deps, {
    sessionId: `race-${server.name}-${randomUUID()}`,
    cwd: process.cwd(),
    client: acpClient,
    sessionSignal: lifecycle.signal,
    getPi: () => pi as never,
    getTurnSignal: () => turn.signal,
    isPublished: () => true,
    emitDiagnostic: (value) => diagnostics.push(value),
    ownerToken: {},
    modelRuntime,
  });
  const registered = new Map<string, ToolDefinition>();
  const factory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
  await factory({ registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
  active = [...registered.keys()];
  bridge.bindSession(pi as never);
  const tool = [...registered.values()].find(({ name }) => name.endsWith("__race_feature"));
  assert.ok(tool);

  return {
    diagnostics,
    lifecycle,
    bridge,
    arm(feature: "sampling" | "form" | "url", cause: string) {
      pending.set(key(feature, cause), prepare(feature, cause));
      return starts.get(key(feature, cause))!.promise;
    },
    releaseLate(feature: "sampling" | "form" | "url", cause: string) { late.get(key(feature, cause))?.(); },
    nextTurn() { turn = new AbortController(); return turn; },
    timeoutMode(enabled: boolean) {
      forceIncomingTimeout = enabled;
      if (enabled) forcedTimers.length = 0;
    },
    execute(feature: "sampling" | "roots" | "form" | "url", cause: string) {
      const remoteStarted = deferred<void>();
      const running = tool.execute(`race-${feature}-${cause}`, { feature, cause }, new AbortController().signal, (update) => {
        if (JSON.stringify(update).includes(`race-started:${feature}:${cause}`)) remoteStarted.resolve();
      });
      return { running, remoteStarted: remoteStarted.promise };
    },
    async close() {
      await bridge.close();
      lifecycle.abort();
      for (const release of late.values()) release();
    },
  };
}

function raceResult(result: Awaited<ReturnType<ToolDefinition["execute"]>>): { status: string; value?: { action?: string } } {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return JSON.parse(block.text) as { status: string; value?: { action?: string } };
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

test("M1-M7 full MCP transcript is transport-independent across real stdio/http/sse", { timeout: 90_000 }, async () => {
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
      assert.ok(result.diagnostics.some((value) => value.includes("late elicitation completion")));
      assert.ok(result.diagnostics.some((value) => value.includes("unknown elicitation completion")));
      assert.ok(result.diagnostics.some((value) => value.includes("reused elicitation id")));
      assert.equal(result.completions.length, 1);
    }
    assert.ok(http.seenHeaders.some((value) => value === "one, two"));
    assert.ok(sse.seenHeaders.some((value) => value === "one, two"));
  } finally {
    await Promise.allSettled([http.close(), sse.close()]);
  }
});

test("M7 sampling, roots, form, and URL races execute over every real transport", { timeout: 90_000 }, async () => {
  const fixture = new URL("./fixtures/full-mcp-server.mjs", import.meta.url).pathname;
  const http = await httpHost();
  const sse = await sseHost();
  const rows: McpServer[] = [
    { name: "race_stdio", command: process.execPath, args: [fixture], env: [] },
    { name: "race_http", type: "http", url: http.url, headers: [] },
    { name: "race_sse", type: "sse", url: sse.url, headers: [] },
  ];
  const features = ["sampling", "roots", "form", "url"] as const;
  try {
    for (const server of rows) {
      const ordinary = await raceHarness(server);
      try {
        for (const feature of features) {
          const result = raceResult(await ordinary.execute(feature, "ordinary").running);
          assert.equal(result.status, "resolved", `${server.name}/${feature}/ordinary`);
        }
        for (const feature of features) {
          if (feature !== "roots") ordinary.arm(feature, "peer");
          const result = raceResult(await ordinary.execute(feature, "peer").running);
          assert.equal(result.status, "rejected", `${server.name}/${feature}/peer`);
          if (feature !== "roots") ordinary.releaseLate(feature, "peer");
        }
        for (const feature of ["sampling", "form", "url"] as const) {
          const started = ordinary.arm(feature, "turn");
          const turn = ordinary.nextTurn();
          const operation = ordinary.execute(feature, "turn").running;
          await started;
          turn.abort(new Error("turn abort wins"));
          const result = raceResult(await operation);
          if (feature === "sampling") assert.equal(result.status, "rejected", `${server.name}/${feature}/turn`);
          else assert.deepEqual(result, { status: "resolved", value: { action: "cancel" } }, `${server.name}/${feature}/turn`);
          ordinary.releaseLate(feature, "turn");
        }
        for (const feature of ["sampling", "form", "url"] as const) {
          ordinary.arm(feature, "timeout");
          ordinary.timeoutMode(true);
          const result = raceResult(await ordinary.execute(feature, "timeout").running);
          ordinary.timeoutMode(false);
          if (feature === "sampling") assert.equal(result.status, "rejected", `${server.name}/${feature}/timeout`);
          else assert.deepEqual(result, { status: "resolved", value: { action: "cancel" } }, `${server.name}/${feature}/timeout`);
          ordinary.releaseLate(feature, "timeout");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        await ordinary.close();
      }

      const sessionRace = await raceHarness(server);
      try {
        for (const feature of ["sampling", "form", "url"] as const) sessionRace.arm(feature, "session");
        const operations = features.map((feature) => sessionRace.execute(feature, "session"));
        await Promise.all(operations.map(({ remoteStarted }) => remoteStarted));
        sessionRace.bridge.startDisposal();
        sessionRace.lifecycle.abort(new Error("session disposal wins"));
        sessionRace.bridge.abortRefreshes();
        const outcomes = await Promise.allSettled(operations.map(({ running }) => running));
        assert.ok(outcomes.every(({ status }) => status === "rejected"), `${server.name}/session/no-response`);
        for (const feature of ["sampling", "form", "url"] as const) sessionRace.releaseLate(feature, "session");
      } finally {
        await sessionRace.close();
      }

      for (const feature of features) {
        const transportRace = await raceHarness(server);
        try {
          if (feature !== "roots") transportRace.arm(feature, "transport");
          const operation = transportRace.execute(feature, "transport").running;
          await assert.rejects(operation, undefined, `${server.name}/${feature}/transport/no-response`);
          if (feature !== "roots") transportRace.releaseLate(feature, "transport");
        } finally {
          await transportRace.close();
        }
      }
    }
  } finally {
    await Promise.allSettled([http.close(), sse.close()]);
  }
});

test("M7 equal URL ids are isolated across exported agents and reusable only by a fresh client", { timeout: 30_000 }, async () => {
  const { PiAcpAgent } = await import("../src/agent.js");
  const { context, fakeDeps } = await import("./helpers/fakes.js");
  const host = await httpHost();
  const server = { name: "elicitation-isolation", type: "http", url: host.url, headers: [] } as const;

  const open = async (label: string) => {
    const setup = fakeDeps();
    setup.deps.mcpTimeoutMs = 2_000;
    setup.deps.connectMcpClient = (configured, signal, binding) =>
      connectDefaultMcpClient(configured, signal, setup.deps.mcpTimeoutMs, realSleep, binding);
    const request = deferred<{ action: "accept" }>();
    const seen = deferred<{ elicitationId: string }>();
    const completions: string[] = [];
    const agent = new PiAcpAgent(setup.deps);
    const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [server] }, {
      request: async (_method, params: { elicitationId: string }) => {
        seen.resolve(params);
        return request.promise;
      },
      notify: async (_method, params: { elicitationId: string }) => { completions.push(params.elicitationId); },
    }));
    const tool = setup.controls[0]!.tools.find(({ name }) => name.endsWith("__isolate_url"));
    assert.ok(tool, label);
    return { agent, opened, tool, request, seen, completions };
  };

  const first = await open("first");
  const second = await open("second");
  try {
    const firstCall = first.tool.execute("first-url", {}, new AbortController().signal);
    const secondCall = second.tool.execute("second-url", {}, new AbortController().signal);
    firstCall.catch(() => undefined);
    secondCall.catch(() => undefined);
    const [firstRequest, secondRequest] = await Promise.all([first.seen.promise, second.seen.promise]);
    assert.notEqual(firstRequest.elicitationId, secondRequest.elicitationId,
      "separately constructed agents mint distinct opaque ids for one equal remote id");

    await first.agent.closeSession(context({ sessionId: first.opened.sessionId }));
    await assert.rejects(firstCall);
    second.request.resolve({ action: "accept" });
    const secondResult = await secondCall;
    assert.match((secondResult.content[0] as { text: string }).text, /"accept"/);
    await eventually(() => assert.equal(second.completions.length, 1));
    assert.equal(first.completions.length, 0, "disposing one owner cannot complete the other owner's entry");

    await second.agent.closeSession(context({ sessionId: second.opened.sessionId }));
    const fresh = await open("fresh");
    try {
      const freshCall = fresh.tool.execute("fresh-url", {}, new AbortController().signal);
      const freshRequest = await fresh.seen.promise;
      assert.notEqual(freshRequest.elicitationId, secondRequest.elicitationId);
      fresh.request.resolve({ action: "accept" });
      await freshCall;
      await eventually(() => assert.equal(fresh.completions.length, 1));
    } finally {
      await fresh.agent.dispose();
    }
  } finally {
    await Promise.allSettled([first.agent.dispose(), second.agent.dispose()]);
    await host.close();
  }
});

test("M1 advertises HTTP/SSE and keeps client-hosted ACP transport rejected", async () => {
  const { PiAcpAgent } = await import("../src/agent.js");
  const { fakeDeps, context } = await import("./helpers/fakes.js");
  const setup = fakeDeps();
  const agent = new PiAcpAgent(setup.deps);
  const initialized = agent.initialize(context({ protocolVersion: 1, clientCapabilities: {} }));
  assert.deepEqual(initialized.agentCapabilities.mcpCapabilities, { http: true, sse: true });
  await assert.rejects(bridgeMcpServers([
    { type: "acp", name: "client-hosted", command: "fixture", args: [], env: [] },
  ], new AbortController().signal, setup.deps), (error: { code?: unknown; data?: { errorKind?: unknown } }) =>
    error.code === -32602 && error.data?.errorKind === "unsupported_mcp_transport");
  await agent.dispose();
});

test("M2/M8 real Streamable HTTP GET EOF/error disables once, DELETEs once, and never reconnects", { timeout: 20_000 }, async () => {
  for (const mode of ["eof", "error"] as const) {
    const host = await fatalStreamableHost();
    const diagnostics: string[] = [];
    const lifecycle = new AbortController();
    const deps = await resolveDeps({ mcpTimeoutMs: 2_000, sleep: realSleep });
    const bridge = await bridgeMcpServers([{
      name: `fatal-http-${mode}`,
      type: "http",
      url: host.url,
      headers: [],
    }], new AbortController().signal, deps, {
      sessionId: `fatal-http-${mode}`,
      cwd: process.cwd(),
      client: { notify: async () => undefined } as never,
      sessionSignal: lifecycle.signal,
      getPi: () => undefined,
      getTurnSignal: () => undefined,
      isPublished: () => true,
      emitDiagnostic: (value) => diagnostics.push(value),
    });
    try {
      bridge.bindSession({
        getActiveToolNames: () => [],
        setActiveToolsByName() {},
      } as never);
      await host.waitForGet();
      const beforeFatal = host.methods.length;
      host.breakGet(mode);
      await eventually(() => {
        assert.deepEqual(diagnostics, [`[mcp:fatal-http-${mode}] connection closed; server disabled`]);
        assert.equal(host.methods.filter((method) => method === "DELETE").length, 1);
      });
      const afterFatal = host.methods.slice(beforeFatal);
      assert.deepEqual(afterFatal.filter((method) => method === "GET" || method === "POST"), []);
      assert.deepEqual(afterFatal.filter((method) => method === "DELETE"), ["DELETE"]);
      assert.equal(diagnostics.some((value) => value.includes("transport error")), false);
    } finally {
      await bridge.close();
      lifecycle.abort();
      await host.close();
    }
    assert.equal(host.methods.filter((method) => method === "DELETE").length, 1);
  }
});

test("M2 real HTTP close covers absent session, DELETE 405/error/timeout, and unconditional close", { timeout: 20_000 }, async () => {
  {
    const host = await fatalStreamableHost("success", false);
    const deps = await resolveDeps({ mcpTimeoutMs: 200, sleep: realSleep });
    const bridge = await bridgeMcpServers([{
      name: "no-session", type: "http", url: host.url, headers: [],
    }], new AbortController().signal, deps);
    await bridge.close();
    assert.equal(host.methods.filter((method) => method === "DELETE").length, 0);
    await host.close();
  }

  for (const deleteMode of ["405", "error", "hang"] as const) {
    const host = await fatalStreamableHost(deleteMode);
    const diagnostics: string[] = [];
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { stderr.push(values.join(" ")); };
    const lifecycle = new AbortController();
    try {
      const deps = await resolveDeps({ mcpTimeoutMs: 100, sleep: realSleep });
      const bridge = await bridgeMcpServers([{
        name: `delete-${deleteMode}`, type: "http", url: host.url, headers: [],
      }], new AbortController().signal, deps, {
        sessionId: `delete-${deleteMode}`,
        cwd: process.cwd(),
        client: { notify: async () => undefined } as never,
        sessionSignal: lifecycle.signal,
        getPi: () => undefined,
        getTurnSignal: () => undefined,
        isPublished: () => true,
        emitDiagnostic: (value) => diagnostics.push(value),
      });
      bridge.bindSession({ getActiveToolNames: () => [], setActiveToolsByName() {} } as never);
      await host.waitForGet();
      host.breakGet("eof");
      await eventually(() => assert.equal(host.methods.filter((method) => method === "DELETE").length, 1));
      await bridge.close();
      assert.equal(diagnostics.length, 1);
      if (deleteMode === "405") {
        assert.equal(stderr.some((value) => value.includes("session termination failed")), false);
      } else {
        assert.equal(stderr.some((value) => value.includes("session termination failed")), true);
      }
      assert.equal(host.methods.filter((method) => method === "DELETE").length, 1);
    } finally {
      console.error = originalError;
      lifecycle.abort();
      await host.close();
    }
  }
});

test("M2/M8 request-driven HTTP 405 stays live until the next request timeout disables without reconnect", { timeout: 20_000 }, async () => {
  const host = await requestDrivenIdleHost();
  const diagnostics: string[] = [];
  const lifecycle = new AbortController();
  const deps = await resolveDeps({ mcpTimeoutMs: 100, sleep: realSleep });
  const bridge = await bridgeMcpServers([{
    name: "request-idle", type: "http", url: host.url, headers: [],
  }], new AbortController().signal, deps, {
    sessionId: "request-idle",
    cwd: process.cwd(),
    client: { notify: async () => undefined } as never,
    sessionSignal: lifecycle.signal,
    getPi: () => undefined,
    getTurnSignal: () => undefined,
    isPublished: () => true,
    emitDiagnostic: (value) => diagnostics.push(value),
  });
  try {
    const registered = new Map<string, ToolDefinition>();
    const factory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
    await factory({ registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
    let active = [...registered.keys()];
    bridge.bindSession({
      getActiveToolNames: () => [...active],
      setActiveToolsByName(names: string[]) { active = [...names]; },
    } as never);
    await eventually(() => assert.equal(host.methods.filter((method) => method === "GET").length, 1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(diagnostics, [], "405 is request-driven idle, not fatal transport death");
    const hanging = registered.get("mcp__request-idle__hang");
    assert.ok(hanging);
    await assert.rejects(hanging.execute("idle-timeout", {}, new AbortController().signal), /timed out/);
    await eventually(() => {
      assert.deepEqual(diagnostics, ["[mcp:request-idle] connection closed; server disabled"]);
      assert.equal(host.methods.filter((method) => method === "DELETE").length, 1);
    });
    const getCount = host.methods.filter((method) => method === "GET").length;
    const postCount = host.methods.filter((method) => method === "POST").length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(host.methods.filter((method) => method === "GET").length, getCount);
    assert.equal(host.methods.filter((method) => method === "POST").length, postCount);
  } finally {
    await bridge.close();
    lifecycle.abort();
    await host.close();
  }
});

test("M2/M8 real legacy SSE raw error closes synchronously and never reconnects", { timeout: 20_000 }, async () => {
  const host = await fatalSseHost();
  const diagnostics: string[] = [];
  const lifecycle = new AbortController();
  const deps = await resolveDeps({ mcpTimeoutMs: 2_000, sleep: realSleep });
  const bridge = await bridgeMcpServers([{
    name: "fatal-sse", type: "sse", url: host.url, headers: [],
  }], new AbortController().signal, deps, {
    sessionId: "fatal-sse",
    cwd: process.cwd(),
    client: { notify: async () => undefined, request: async () => ({ action: "decline" }) } as never,
    sessionSignal: lifecycle.signal,
    getPi: () => undefined,
    getTurnSignal: () => undefined,
    isPublished: () => true,
    emitDiagnostic: (value) => diagnostics.push(value),
  });
  try {
    bridge.bindSession({ getActiveToolNames: () => [...bridge.aliases], setActiveToolsByName() {} } as never);
    assert.equal(host.methods.filter((method) => method === "GET").length, 1);
    host.breakStream();
    await eventually(() => assert.deepEqual(diagnostics, ["[mcp:fatal-sse] connection closed; server disabled"]));
    const requests = [...host.methods];
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(host.methods, requests, "EventSource is synchronously closed with zero reconnect fetches");
    assert.equal(diagnostics.some((value) => value.includes("transport error")), false);
  } finally {
    await bridge.close();
    lifecycle.abort();
    await host.close();
  }
});

test("M2/M8 real stdio natural close disables through raw onclose without protocol error", { timeout: 20_000 }, async () => {
  const fixture = new URL("./fixtures/fatal-stdio-server.mjs", import.meta.url).pathname;
  const diagnostics: string[] = [];
  const lifecycle = new AbortController();
  const deps = await resolveDeps({ mcpTimeoutMs: 2_000, sleep: realSleep });
  const bridge = await bridgeMcpServers([{
    name: "fatal-stdio", command: process.execPath, args: [fixture], env: [],
  }], new AbortController().signal, deps, {
    sessionId: "fatal-stdio",
    cwd: process.cwd(),
    client: { notify: async () => undefined } as never,
    sessionSignal: lifecycle.signal,
    getPi: () => undefined,
    getTurnSignal: () => undefined,
    isPublished: () => true,
    emitDiagnostic: (value) => diagnostics.push(value),
  });
  try {
    const tool = bridge.tools.find(({ name }) => name === "mcp__fatal-stdio__exit_peer");
    assert.ok(tool);
    bridge.bindSession({ getActiveToolNames: () => [...bridge.aliases], setActiveToolsByName() {} } as never);
    await tool.execute("exit-peer", {}, new AbortController().signal);
    await eventually(() => assert.deepEqual(diagnostics, ["[mcp:fatal-stdio] connection closed; server disabled"]));
    assert.equal(diagnostics.some((value) => value.includes("transport error")), false);
  } finally {
    await bridge.close();
    lifecycle.abort();
  }
});

test("M2/M8 raw HTTP and SSE opening failures are fatal-only with zero reconnect", { timeout: 20_000 }, async () => {
  for (const kind of ["http", "sse"] as const) {
    const host = await brokenOpeningHost(kind);
    const diagnostics: string[] = [];
    const deps = await resolveDeps({ mcpTimeoutMs: 2_000, sleep: realSleep });
    try {
      await assert.rejects(bridgeMcpServers([kind === "http"
        ? { name: `opening-${kind}`, type: "http", url: host.url, headers: [] }
        : { name: `opening-${kind}`, type: "sse", url: host.url, headers: [] }],
      new AbortController().signal, deps, {
        sessionId: `opening-${kind}`,
        cwd: process.cwd(),
        client: { notify: async () => undefined } as never,
        sessionSignal: new AbortController().signal,
        getPi: () => undefined,
        getTurnSignal: () => undefined,
        isPublished: () => false,
        emitDiagnostic: (value) => diagnostics.push(value),
      }), (error: { data?: { errorKind?: unknown; server?: unknown } }) =>
        error.data?.errorKind === "mcp_init_error" && error.data.server === `opening-${kind}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(diagnostics.some((value) => value.includes("transport error")), false);
      assert.equal(host.methods.length, 1, `${kind} opening failure must not reconnect`);
    } finally {
      await host.close();
    }
  }
});
