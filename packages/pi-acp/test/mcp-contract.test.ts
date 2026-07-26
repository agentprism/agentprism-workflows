import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type AgentSession, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  CloseSignallingTransport,
  McpOperationTerminalError,
  McpIncomingTerminalError,
  bridgeMcpServers,
  convertMcpContent,
  convertMcpResult,
  disposeMcpBridge,
  settleIncomingMcpOperation,
  settleMcpOperation,
  type McpSessionBinding,
} from "../src/mcp-bridge.js";
import { context, fakeDeps, fakeMcpHandle } from "./helpers/fakes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("M2 close wrapper delegates, signals once, and invokes stdio/SSE raw close synchronously", async () => {
  const physical = deferred<void>();
  const events: string[] = [];
  const raw = {
    sessionId: "transport-session",
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    onmessage: undefined as ((message: unknown) => void) | undefined,
    setProtocolVersion(version: string) { events.push(`version:${version}`); },
    async start() { events.push("start"); },
    async send() { events.push("send"); },
    close() { events.push("raw-close"); return physical.promise; },
  };
  const wrapper = new CloseSignallingTransport(
    raw as never,
    undefined,
    () => { events.push("raw-error"); return true; },
    () => events.push("raw-natural-close"),
    73,
    async () => new Promise<void>(() => undefined),
    "close-unit",
  );
  wrapper.onclose = () => events.push("logical-close");
  assert.equal(wrapper.sessionId, "transport-session");
  wrapper.setProtocolVersion("2025-11-25");
  await wrapper.start();
  await wrapper.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const first = wrapper.close();
  const second = wrapper.close();
  assert.equal(first, second);
  assert.deepEqual(events, [
    "version:2025-11-25",
    "start",
    "send",
    "logical-close",
    "raw-close",
  ]);
  raw.onclose?.();
  assert.equal(events.filter((value) => value === "logical-close").length, 1);
  physical.resolve();
  await first;
});

test("M2 HTTP DELETE and raw close share one injected absolute deadline", async () => {
  const deadline = deferred<void>();
  const terminate = deferred<void>();
  const physical = deferred<void>();
  const events: string[] = [];
  const sleeps: number[] = [];
  const raw = {
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    onmessage: undefined as ((message: unknown) => void) | undefined,
    async start() {},
    async send() {},
    close() { events.push("raw-close"); return physical.promise; },
  };
  const wrapper = new CloseSignallingTransport(
    raw as never,
    () => { events.push("delete"); return terminate.promise; },
    () => false,
    () => undefined,
    91,
    (ms) => { sleeps.push(ms); return deadline.promise; },
    "http-close-unit",
  );
  wrapper.onclose = () => events.push("logical-close");
  const priorError = console.error;
  const diagnostics: string[] = [];
  console.error = (...values: unknown[]) => { diagnostics.push(values.join(" ")); };
  try {
    const closing = wrapper.close();
    assert.deepEqual(events, ["logical-close", "delete"]);
    assert.deepEqual(sleeps, [91]);
    deadline.resolve();
    await closing;
    assert.deepEqual(events, ["logical-close", "delete", "raw-close"]);
    assert.deepEqual(sleeps, [91], "raw close must consume the original deadline, not start a second clock");
    assert.ok(diagnostics.some((value) => value.includes("session termination failed")));
    assert.ok(diagnostics.some((value) => value.includes("close failed")));
  } finally {
    console.error = priorError;
    terminate.resolve();
    physical.resolve();
  }
});

test("M2 all client closes start synchronously in reverse acquisition order", async () => {
  const setup = fakeDeps();
  const order: number[] = [];
  const clients = [1, 2, 3].map((id) => fakeMcpHandle({
    close() { order.push(id); return Promise.resolve(); },
  }));
  await disposeMcpBridge(clients, setup.deps);
  assert.deepEqual(order, [3, 2, 1]);
});

test("A4 disposal starts MCP close before refresh/Pi abort and drains refresh before Pi dispose", async () => {
  const setup = fakeDeps();
  const events: string[] = [];
  const refreshStarted = deferred<void>();
  let changed: (() => void) | undefined;
  let lists = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools(_cursor, signal) {
      lists += 1;
      if (lists === 1) return { tools: [{ name: "one", inputSchema: { type: "object" } }] };
      refreshStarted.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          events.push("refresh-abort");
          reject(signal.reason);
        }, { once: true });
      });
    },
    setToolsChangedHandler(handler) { changed = handler; },
    close() { events.push("mcp-close"); return Promise.resolve(); },
  });
  const { PiAcpAgent } = await import("../src/agent.js");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({
    cwd: setup.cwd,
    mcpServers: [{ name: "ordered-disposal", command: "fixture", args: [], env: [] }],
  }));
  const control = setup.controls[0];
  assert.ok(control);
  control.session.abort = async () => { events.push("pi-abort"); };
  control.session.dispose = () => { events.push("pi-dispose"); };
  changed?.();
  await refreshStarted.promise;
  await agent.closeSession(context({ sessionId: opened.sessionId }));
  assert.deepEqual(events, ["mcp-close", "refresh-abort", "pi-abort", "pi-dispose"]);
  await agent.dispose();
});

test("M2 outgoing settleOnce uses lifecycle > session > peer > timeout > completion", async () => {
  const rows = [
    { expected: "lifecycle" as const, fire: (signals: AbortController[]) => signals.forEach((item) => item.abort()) },
    { expected: "session" as const, fire: (signals: AbortController[]) => signals.slice(1).forEach((item) => item.abort()) },
    { expected: "peer" as const, fire: (signals: AbortController[]) => signals[2]!.abort() },
    { expected: "timeout" as const, fire: (_signals: AbortController[], timeout: ReturnType<typeof deferred<void>>) => timeout.resolve() },
  ];
  for (const row of rows) {
    const operation = deferred<string>();
    const timeout = deferred<void>();
    const signals = [new AbortController(), new AbortController(), new AbortController()];
    const running = settleMcpOperation(
      () => operation.promise,
      signals[0]!.signal,
      signals[1]!.signal,
      signals[2]!.signal,
      60_000,
      () => timeout.promise,
    );
    operation.resolve("late completion");
    row.fire(signals, timeout);
    await assert.rejects(running, (error) =>
      error instanceof McpOperationTerminalError && error.terminalCause === row.expected);
  }

  const timeout = deferred<void>();
  assert.equal(await settleMcpOperation(
    async () => "completed",
    new AbortController().signal,
    new AbortController().signal,
    new AbortController().signal,
    60_000,
    () => timeout.promise,
  ), "completed");
});

test("M7 incoming settleOnce uses peer > session > turn > timeout > completion", async () => {
  const rows = [
    { expected: "peer" as const, start: 0 },
    { expected: "session" as const, start: 1 },
    { expected: "turn" as const, start: 2 },
  ];
  for (const row of rows) {
    const operation = deferred<string>();
    const timeout = deferred<void>();
    const signals = [new AbortController(), new AbortController(), new AbortController()];
    const running = settleIncomingMcpOperation(
      () => operation.promise,
      signals[0]!.signal,
      signals[1]!.signal,
      signals[2]!.signal,
      60_000,
      () => timeout.promise,
    );
    operation.resolve("late completion");
    for (const signal of signals.slice(row.start)) signal.abort();
    await assert.rejects(running, (error) =>
      error instanceof McpIncomingTerminalError && error.terminalCause === row.expected);
  }
  const operation = deferred<string>();
  const timeout = deferred<void>();
  const running = settleIncomingMcpOperation(
    () => operation.promise,
    new AbortController().signal,
    new AbortController().signal,
    new AbortController().signal,
    60_000,
    () => timeout.promise,
  );
  operation.resolve("late completion");
  timeout.resolve();
  await assert.rejects(running, (error) =>
    error instanceof McpIncomingTerminalError && error.terminalCause === "timeout");
});

test("M7 URL accept-vs-completion barrier commits registry state inside settleOnce", async () => {
  const operation = deferred<{ action: "accept" }>();
  const timeout = deferred<void>();
  const committed = deferred<void>();
  let registryState: "pending" | "accepted" | "consumed" = "pending";
  const completionObservations: string[] = [];
  const running = settleIncomingMcpOperation(
    () => operation.promise,
    new AbortController().signal,
    new AbortController().signal,
    new AbortController().signal,
    60_000,
    () => timeout.promise,
    (outcome) => {
      registryState = outcome.status === "fulfilled" && outcome.value.action === "accept"
        ? "accepted"
        : "consumed";
      completionObservations.push(registryState);
      committed.resolve();
    },
  );
  operation.resolve({ action: "accept" });
  await committed.promise;
  assert.equal(registryState, "accepted");
  assert.deepEqual(completionObservations, ["accepted"]);
  assert.deepEqual(await running, { action: "accept" });

  const terminalTimeout = deferred<void>();
  const never = deferred<{ action: "accept" }>();
  registryState = "pending";
  const cancelled = settleIncomingMcpOperation(
    () => never.promise,
    new AbortController().signal,
    new AbortController().signal,
    new AbortController().signal,
    60_000,
    () => terminalTimeout.promise,
    () => { registryState = "consumed"; },
  );
  terminalTimeout.resolve();
  await assert.rejects(cancelled, (error) =>
    error instanceof McpIncomingTerminalError && error.terminalCause === "timeout");
  assert.equal(registryState, "consumed", "losing branches tombstone before publishing their outcome");
});

test("M8 ping failure closes the post-connect owner exactly once", async () => {
  const setup = fakeDeps();
  let closes = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async ping() { throw new Error("ping failed"); },
    async close() { closes += 1; },
  });
  await assert.rejects(
    bridgeMcpServers(
      [{ name: "ping", command: "fixture", args: [], env: [] }],
      new AbortController().signal,
      setup.deps,
    ),
    (error: { data?: { errorKind?: unknown } }) => error.data?.errorKind === "mcp_init_error",
  );
  assert.equal(closes, 1);
});

test("M3 canonical projection is total and rawOutput is the exact validated result", () => {
  const encoded = Buffer.from([0, 1, 2, 3]).toString("base64");
  assert.deepEqual(convertMcpContent({ type: "text", text: "plain" }), { type: "text", text: "plain" });
  assert.deepEqual(convertMcpContent({ type: "image", data: encoded, mimeType: "image/png" }), {
    type: "image", data: encoded, mimeType: "image/png",
  });
  assert.deepEqual(convertMcpContent({ type: "audio", data: encoded, mimeType: "audio/wav" }), {
    type: "text", text: "[audio mime=audio/wav bytes=4]",
  });
  assert.deepEqual(convertMcpContent({
    type: "resource_link", uri: "file:///one", name: "one", title: "One title",
  }), { type: "text", text: "[One title](file:///one)" });
  assert.deepEqual(convertMcpContent({
    type: "resource", resource: { uri: "file:///text", mimeType: "text/plain", text: "embedded" },
  }), { type: "text", text: "embedded" });
  assert.deepEqual(convertMcpContent({
    type: "resource", resource: { uri: "file:///blob", blob: encoded },
  }), { type: "text", text: "[embedded resource uri=file:///blob mime=application/octet-stream bytes=4]" });
  assert.throws(() => convertMcpContent({ type: "future" } as never), /Unsupported MCP content block/);
  const raw = {
    content: [{ type: "text" as const, text: "ok" }],
    structuredContent: { exact: true },
    isError: false,
    _meta: { retained: true },
  };
  const projected = convertMcpResult(raw);
  assert.equal(projected.details, raw);
  assert.deepEqual(projected.content, [{ type: "text", text: "ok" }]);
});

test("M3 strict resources-only capability never sends an unadvertised tools/list", async () => {
  const setup = fakeDeps();
  let lists = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    getCapabilities: () => ({ resources: {} }),
    async listTools() { lists += 1; throw new Error("unadvertised tools/list"); },
    async listResources() { return { resources: [] }; },
    async listResourceTemplates() { return { resourceTemplates: [] }; },
    async readResource() { return { contents: [] }; },
  });
  const bridge = await bridgeMcpServers(
    [{ name: "resources", command: "fixture", args: [], env: [] }],
    new AbortController().signal,
    setup.deps,
  );
  assert.equal(lists, 0);
  assert.deepEqual(bridge.aliases, [
    "mcp__resources__list_resources",
    "mcp__resources__list_resource_templates",
    "mcp__resources__read_resource",
  ]);
  await bridge.close();
});

test("M8 peer death retains the current-turn alias until the shared boundary commits", async () => {
  const setup = fakeDeps();
  const peer = new AbortController();
  let disable: (() => void) | undefined;
  let remoteCalls = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    getPeerSignal: () => peer.signal,
    setDisabledHandler(handler) { disable = handler; },
    async listTools() {
      return { tools: [{ name: "held", inputSchema: { type: "object" } }] };
    },
    async callTool() {
      remoteCalls += 1;
      throw new Error("connection closed");
    },
  });
  const lifecycle = new AbortController();
  let active: string[] = [];
  const binding: McpSessionBinding = {
    sessionId: "peer-boundary",
    cwd: setup.cwd,
    client: { notify: async () => undefined } as never,
    sessionSignal: lifecycle.signal,
    getPi: () => undefined,
    getTurnSignal: () => undefined,
    isPublished: () => true,
    emitDiagnostic() {},
  };
  const bridge = await bridgeMcpServers(
    [{ name: "peer", command: "fixture", args: [], env: [] }],
    new AbortController().signal,
    setup.deps,
    binding,
  );
  const registered = new Map<string, ToolDefinition>();
  const api = { registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI;
  const factory = typeof bridge.inlineExtension === "function"
    ? bridge.inlineExtension
    : bridge.inlineExtension.factory;
  await factory(api);
  active = [...registered.keys()];
  bridge.bindSession({
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names: string[]) => { active = [...names]; },
  } as unknown as AgentSession);
  const alias = "mcp__peer__held";
  const selected = registered.get(alias);
  assert.ok(selected);
  const release = await bridge.acquireTurnBoundary();
  peer.abort(new Error("peer closed"));
  disable?.();
  await assert.rejects(selected.execute("held-call", {}, new AbortController().signal), /MCP tool .* failed/);
  assert.equal(remoteCalls, 1);
  release();
  await bridge.drainRefreshes();
  assert.equal(active.includes(alias), false);
  await assert.rejects(selected.execute("stale-call", {}, new AbortController().signal), /no longer available/);
  assert.equal(remoteCalls, 1);
  await bridge.close();
  lifecycle.abort();
});

test("M8 peer death between enumeration and publication fails the opening transaction", async () => {
  const setup = fakeDeps();
  const peer = new AbortController();
  let disable: (() => void) | undefined;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    getPeerSignal: () => peer.signal,
    setDisabledHandler(handler) { disable = handler; },
    async listTools() { return { tools: [{ name: "ready", inputSchema: { type: "object" } }] }; },
  });
  const bridge = await bridgeMcpServers(
    [{ name: "dies-before-publish", command: "fixture", args: [], env: [] }],
    new AbortController().signal,
    setup.deps,
  );
  peer.abort(new Error("peer closed before session publication"));
  disable?.();
  await flush();
  assert.throws(() => bridge.bindSession({} as AgentSession),
    (error: { data?: { errorKind?: unknown; server?: unknown } }) =>
      error.data?.errorKind === "mcp_init_error" && error.data.server === "dies-before-publish");
  await bridge.close();
});

test("M5 refresh keeps stable aliases across change, invalid-catalog rollback, remove, and re-add", async () => {
  const setup = fakeDeps();
  let revision = 1;
  let catalog: Array<Record<string, unknown>> = [{
    name: "alpha", title: "Alpha v1", description: "first", inputSchema: { type: "object" },
  }];
  let changed: (() => void) | undefined;
  const calls: string[] = [];
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() { return { tools: catalog as never, raw: { tools: catalog, revision } }; },
    async callTool(name) {
      calls.push(`${name}:${revision}`);
      return { content: [{ type: "text", text: `${name}:${revision}` }] };
    },
    setToolsChangedHandler(handler) { changed = handler; },
  });
  const diagnostics: string[] = [];
  const binding: McpSessionBinding = {
    sessionId: "dynamic-refresh",
    cwd: setup.cwd,
    client: { notify: async () => undefined } as never,
    sessionSignal: new AbortController().signal,
    getPi: () => undefined,
    getTurnSignal: () => undefined,
    isPublished: () => true,
    emitDiagnostic: (value) => diagnostics.push(value),
  };
  const bridge = await bridgeMcpServers(
    [{ name: "dynamic", command: "fixture", args: [], env: [] }],
    new AbortController().signal,
    setup.deps,
    binding,
  );
  const registered = new Map<string, ToolDefinition>();
  const factory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
  await factory({ registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
  let active = [...registered.keys()];
  bridge.bindSession({
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names: string[]) => { active = [...names]; },
  } as unknown as AgentSession);
  const alias = "mcp__dynamic__alpha";
  assert.equal(registered.get(alias)?.label, "Alpha v1");

  revision = 2;
  catalog = [{ name: "alpha", title: "Alpha v2", description: "changed", inputSchema: { type: "object" } }];
  changed?.();
  await bridge.drainRefreshes();
  assert.equal(registered.get(alias)?.label, "Alpha v2");
  assert.equal(active.includes(alias), true);

  catalog = [catalog[0]!, { ...catalog[0] }];
  changed?.();
  await bridge.drainRefreshes();
  assert.equal(registered.get(alias)?.label, "Alpha v2");
  assert.ok(diagnostics.some((value) => value.includes("tools/list refresh failed")));

  catalog = [{ ...catalog[0]!, execution: { taskSupport: "required" } }];
  changed?.();
  await bridge.drainRefreshes();
  assert.equal(active.includes(alias), true, "task-required refresh retains the prior valid snapshot");

  catalog = [];
  changed?.();
  await bridge.drainRefreshes();
  assert.equal(active.includes(alias), false);
  await assert.rejects(registered.get(alias)!.execute("removed", {}, new AbortController().signal), /no longer available/);

  revision = 3;
  catalog = [{ name: "alpha", title: "Alpha v3", inputSchema: { type: "object" } }];
  changed?.();
  await bridge.drainRefreshes();
  assert.equal(active.includes(alias), true);
  assert.equal(registered.get(alias)?.label, "Alpha v3");
  assert.match((await registered.get(alias)!.execute("readded", {}, new AbortController().signal)).content[0]!.text, /alpha:3/);
  assert.deepEqual(calls, ["alpha:3"]);
  await bridge.close();
});

test("M5/M8 colliding server slugs use the allocated token for aliases and diagnostics", async () => {
  const setup = fakeDeps();
  const handlers = new Map<string, () => void>();
  const calls = new Map<string, number>();
  setup.deps.connectMcpClient = async (server) => fakeMcpHandle({
    async listTools() {
      const count = (calls.get(server.name) ?? 0) + 1;
      calls.set(server.name, count);
      if (count > 1) throw new Error("refresh failure");
      return { tools: [{ name: "same", inputSchema: { type: "object" } }] };
    },
    setToolsChangedHandler(handler) { handlers.set(server.name, handler); },
  });
  const diagnostics: string[] = [];
  const bridge = await bridgeMcpServers([
    { name: "a b", command: "fixture", args: [], env: [] },
    { name: "a_b", command: "fixture", args: [], env: [] },
  ], new AbortController().signal, setup.deps, {
    sessionId: "colliding-server-slugs",
    cwd: setup.cwd,
    client: { notify: async () => undefined } as never,
    sessionSignal: new AbortController().signal,
    getPi: () => undefined,
    getTurnSignal: () => undefined,
    isPublished: () => true,
    emitDiagnostic: (value) => diagnostics.push(value),
  });
  assert.deepEqual(bridge.aliases, [
    "mcp__a_b__same",
    "mcp__a_b_2__same",
  ]);
  const registered = new Map<string, ToolDefinition>();
  const factory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
  await factory({ registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
  let active = [...registered.keys()];
  bridge.bindSession({
    getActiveToolNames: () => [...active],
    setActiveToolsByName(names: string[]) { active = [...names]; },
  } as unknown as AgentSession);
  handlers.get("a_b")?.();
  await bridge.drainRefreshes();
  assert.deepEqual(diagnostics, ["[mcp:a_b_2] tools/list refresh failed"]);
  await bridge.close();
});

test("M5 simultaneous two-server refreshes rebase in configuration order without losing deltas", async () => {
  const setup = fakeDeps();
  const common = "s".repeat(130);
  const names = [`${common} a`, `${common} b`];
  const catalogs = new Map<string, Array<Record<string, unknown>>>([
    [names[0]!, [
      { name: "keep-a", title: "keep a v1", inputSchema: { type: "object" } },
      { name: "remove-a", inputSchema: { type: "object" } },
    ]],
    [names[1]!, [
      { name: "keep-b", title: "keep b v1", inputSchema: { type: "object" } },
      { name: "remove-b", inputSchema: { type: "object" } },
    ]],
  ]);
  const handlers = new Map<string, () => void>();
  const listOrder: string[] = [];
  setup.deps.connectMcpClient = async (server) => fakeMcpHandle({
    async listTools() {
      listOrder.push(server.name);
      return { tools: catalogs.get(server.name) as never };
    },
    setToolsChangedHandler(handler) { handlers.set(server.name, handler); },
  });
  const bridge = await bridgeMcpServers(names.map((name) => ({
    name, command: "fixture", args: [], env: [],
  })), new AbortController().signal, setup.deps);
  const registered = new Map<string, ToolDefinition>();
  const factory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
  await factory({ registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
  let active = [...registered.keys()];
  bridge.bindSession({
    getActiveToolNames: () => [...active],
    setActiveToolsByName(values: string[]) { active = [...values]; },
  } as unknown as AgentSession);
  const initialByServer = names.map((name) => bridge.aliases.filter((alias) => bridge.aliasServers.get(alias) === name));
  catalogs.set(names[0]!, [
    { name: "keep-a", title: "keep a v2", inputSchema: { type: "object" } },
    { name: "add-a", inputSchema: { type: "object" } },
  ]);
  catalogs.set(names[1]!, [
    { name: "keep-b", title: "keep b v2", inputSchema: { type: "object" } },
    { name: "add-b", inputSchema: { type: "object" } },
  ]);
  // Reverse arrival is intentionally batched; preparation remains configured-order.
  handlers.get(names[1]!)?.();
  handlers.get(names[0]!)?.();
  await bridge.drainRefreshes();
  assert.deepEqual(listOrder.slice(-2), names);
  const finalByServer = names.map((name) => bridge.aliases.filter((alias) => bridge.aliasServers.get(alias) === name));
  assert.equal(new Set(bridge.aliases).size, bridge.aliases.length);
  assert.ok(bridge.aliases.every((alias) => alias.length <= 128));
  assert.ok(bridge.aliases.some((alias) => /_2$/.test(alias)), "truncation collision must use an ordered suffix");
  for (let index = 0; index < names.length; index += 1) {
    const [kept, removed] = initialByServer[index]!;
    const added = finalByServer[index]!.find((alias) => !initialByServer[index]!.includes(alias));
    assert.ok(kept && removed && added);
    assert.ok(active.includes(kept));
    assert.ok(active.includes(added));
    assert.equal(active.includes(removed), false);
  }
  assert.equal(registered.get(initialByServer[0]![0]!)?.label, "keep a v2");
  assert.equal(registered.get(initialByServer[1]![0]!)?.label, "keep b v2");
  await bridge.close();
});

test("M5 opening waits for one coalesced dirty pass and defers a notification during that pass", async () => {
  const setup = fakeDeps();
  const pages = [deferred<{ tools: Array<{ name: string; inputSchema: { type: string } }> }>(), deferred<{ tools: Array<{ name: string; inputSchema: { type: string } }> }>()];
  const starts = [deferred<void>(), deferred<void>(), deferred<void>()];
  let changed: (() => void) | undefined;
  let calls = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() {
      const index = calls++;
      starts[index]?.resolve();
      if (index < 2) return pages[index]!.promise;
      return { tools: [{ name: "third", inputSchema: { type: "object" } }] };
    },
    setToolsChangedHandler(handler) { changed = handler; },
  });
  let opened = false;
  const opening = bridgeMcpServers([
    { name: "initial-dirty", command: "fixture", args: [], env: [] },
  ], new AbortController().signal, setup.deps).then((bridge) => {
    opened = true;
    return bridge;
  });
  await starts[0]!.promise;
  changed?.();
  pages[0]!.resolve({ tools: [{ name: "first", inputSchema: { type: "object" } }] });
  await starts[1]!.promise;
  assert.equal(opened, false, "session publication waits for the coalesced extra enumeration");
  changed?.();
  pages[1]!.resolve({ tools: [{ name: "second", inputSchema: { type: "object" } }] });
  const bridge = await opening;
  assert.equal(calls, 2, "a notification during the extra pass does not extend the opening barrier");
  assert.ok(bridge.aliases.includes("mcp__initial-dirty__second"));
  assert.equal(bridge.aliases.some((alias) => alias.endsWith("__first")), false);
  const registered = new Map<string, ToolDefinition>();
  const factory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
  await factory({ registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
  let active = [...registered.keys()];
  bridge.bindSession({
    getActiveToolNames: () => [...active],
    setActiveToolsByName(names: string[]) { active = [...names]; },
  } as unknown as AgentSession);
  await starts[2]!.promise;
  await bridge.drainRefreshes();
  assert.equal(calls, 3, "the deferred dirty bit becomes ordinary post-publication work");
  assert.ok(active.includes("mcp__initial-dirty__third"));
  await bridge.close();
});

test("M5 multi-server publication waits for an earlier server dirtied while a later server connects", async () => {
  const setup = fakeDeps();
  const secondConnecting = deferred<void>();
  const releaseSecond = deferred<void>();
  const refreshStarted = deferred<void>();
  const refreshPage = deferred<{ tools: Array<{ name: string; inputSchema: { type: string } }> }>();
  let firstChanged: (() => void) | undefined;
  let firstLists = 0;
  setup.deps.connectMcpClient = async (server) => {
    if (server.name === "second") {
      secondConnecting.resolve();
      await releaseSecond.promise;
      return fakeMcpHandle({ async listTools() { return { tools: [] }; } });
    }
    return fakeMcpHandle({
      async listTools() {
        firstLists += 1;
        if (firstLists === 1) return { tools: [{ name: "stale", inputSchema: { type: "object" } }] };
        refreshStarted.resolve();
        return refreshPage.promise;
      },
      setToolsChangedHandler(handler) { firstChanged = handler; },
    });
  };
  let opened = false;
  const opening = bridgeMcpServers([
    { name: "first", command: "fixture", args: [], env: [] },
    { name: "second", command: "fixture", args: [], env: [] },
  ], new AbortController().signal, setup.deps).then((bridge) => {
    opened = true;
    return bridge;
  });
  await secondConnecting.promise;
  firstChanged?.();
  releaseSecond.resolve();
  await refreshStarted.promise;
  assert.equal(opened, false, "the bridge-wide publication barrier includes the earlier dirty server");
  refreshPage.resolve({ tools: [{ name: "fresh", inputSchema: { type: "object" } }] });
  const bridge = await opening;
  assert.equal(firstLists, 2);
  assert.equal(bridge.aliases.includes("mcp__first__stale"), false);
  assert.equal(bridge.aliases.includes("mcp__first__fresh"), true);
  await bridge.close();
});

test("M3 output validators retain each handle's per-server provider and isolate equal schema ids", async () => {
  const setup = fakeDeps();
  const providers = new Map<string, AjvJsonSchemaValidator>();
  setup.deps.connectMcpClient = async (server) => {
    const provider = new AjvJsonSchemaValidator();
    providers.set(server.name, provider);
    const property = server.name === "a"
      ? { a: { type: "string" } }
      : { b: { type: "number" } };
    return fakeMcpHandle({
      jsonSchemaValidator: provider,
      async listTools() {
        return { tools: [{
          name: "validate",
          inputSchema: { type: "object" },
          outputSchema: {
            $id: "https://example.test/shared-output-schema",
            type: "object",
            required: [server.name],
            properties: property,
            additionalProperties: false,
          },
        }] as never };
      },
      async callTool() {
        return {
          content: [{ type: "text", text: "accepted" }],
          structuredContent: server.name === "a" ? { a: "ok" } : { b: 7 },
        };
      },
    });
  };
  const bridge = await bridgeMcpServers([
    { name: "a", command: "fixture", args: [], env: [] },
    { name: "b", command: "fixture", args: [], env: [] },
  ], new AbortController().signal, setup.deps);
  assert.notEqual(providers.get("a"), providers.get("b"));
  const second = bridge.tools.find(({ name }) => name === "mcp__b__validate");
  assert.ok(second);
  const result = await second.execute("validate-b", {}, new AbortController().signal);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "accepted");
  assert.deepEqual(result.details, {
    content: [{ type: "text", text: "accepted" }],
    structuredContent: { b: 7 },
  });
  await bridge.close();
});

test("M5 refresh discards pre-commit aliases and poisons the session after mutation begins", async () => {
  {
    const setup = fakeDeps();
    let catalog: Array<{ name: string; inputSchema: { type: string } }> = [
      { name: "base", inputSchema: { type: "object" } },
    ];
    let changed: (() => void) | undefined;
    setup.deps.connectMcpClient = async () => fakeMcpHandle({
      async listTools() { return { tools: catalog }; },
      setToolsChangedHandler(handler) { changed = handler; },
    });
    const bridge = await bridgeMcpServers([
      { name: "precommit", command: "fixture", args: [], env: [] },
    ], new AbortController().signal, setup.deps);
    const registered = new Map<string, ToolDefinition>();
    const factory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
    await factory({ registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
    let active = [...registered.keys()];
    bridge.bindSession({
      getActiveToolNames: () => [...active],
      setActiveToolsByName(names: string[]) { active = [...names]; },
    } as unknown as AgentSession);
    catalog = [
      { name: "base", inputSchema: { type: "object" } },
      { name: "candidate", inputSchema: { type: "object" } },
      { name: "candidate", inputSchema: { type: "object" } },
    ];
    changed?.();
    await bridge.drainRefreshes();
    assert.equal(bridge.aliases.some((alias) => alias.includes("candidate")), false);
    catalog = [
      { name: "base", inputSchema: { type: "object" } },
      { name: "candidate", inputSchema: { type: "object" } },
    ];
    changed?.();
    await bridge.drainRefreshes();
    assert.ok(bridge.aliases.includes("mcp__precommit__candidate"));
    assert.equal(bridge.aliases.some((alias) => alias.endsWith("candidate_2")), false,
      "discarded candidates consume no suffix reservation");
    await bridge.close();
  }

  {
    const setup = fakeDeps();
    let catalog: Array<{ name: string; inputSchema: { type: string } }> = [
      { name: "base", inputSchema: { type: "object" } },
    ];
    let changed: (() => void) | undefined;
    setup.deps.connectMcpClient = async () => fakeMcpHandle({
      async listTools() { return { tools: catalog }; },
      setToolsChangedHandler(handler) { changed = handler; },
    });
    const diagnostics: string[] = [];
    let poisonCalls = 0;
    const bridge = await bridgeMcpServers([
      { name: "commit-fault", command: "fixture", args: [], env: [] },
    ], new AbortController().signal, setup.deps, {
      sessionId: "commit-fault",
      cwd: setup.cwd,
      client: { notify: async () => undefined } as never,
      sessionSignal: new AbortController().signal,
      getPi: () => undefined,
      getTurnSignal: () => undefined,
      isPublished: () => true,
      emitDiagnostic: (value) => diagnostics.push(value),
      poison: () => { poisonCalls += 1; },
    });
    let rejectRegistration = false;
    const registered = new Map<string, ToolDefinition>();
    const factory = typeof bridge.inlineExtension === "function" ? bridge.inlineExtension : bridge.inlineExtension.factory;
    await factory({
      registerTool(tool: ToolDefinition) {
        if (rejectRegistration && tool.name.endsWith("__added")) throw new Error("injected registry mutation failure");
        registered.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);
    let active = [...registered.keys()];
    bridge.bindSession({
      getActiveToolNames: () => [...active],
      setActiveToolsByName(names: string[]) { active = [...names]; },
    } as unknown as AgentSession);
    rejectRegistration = true;
    catalog = [
      { name: "base", inputSchema: { type: "object" } },
      { name: "added", inputSchema: { type: "object" } },
    ];
    changed?.();
    await bridge.drainRefreshes();
    assert.equal(poisonCalls, 1);
    assert.deepEqual(diagnostics, ["[mcp:commit-fault] tools/list refresh commit failed; session terminated"]);
    assert.equal(bridge.aliases.some((alias) => alias.endsWith("__added")), false,
      "adapter snapshot and reservation remain unpublished after mutation poison");
    changed?.();
    await bridge.drainRefreshes();
    assert.equal(poisonCalls, 1, "poison suppresses all later registration work");
    await bridge.close();
  }
});

test("M4 turn cancellation suppresses every late remote progress and settlement", async () => {
  const setup = fakeDeps();
  const remote = deferred<Awaited<ReturnType<ReturnType<typeof fakeMcpHandle>["callTool"]>>>();
  let sendProgress: ((value: unknown) => void) | undefined;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() {
      return { tools: [{ name: "progress", inputSchema: { type: "object" } }] };
    },
    callTool(_name, _args, _signal, _timeout, onprogress) {
      sendProgress = onprogress;
      return remote.promise;
    },
  });
  const bridge = await bridgeMcpServers(
    [{ name: "updates", command: "fixture", args: [], env: [] }],
    new AbortController().signal,
    setup.deps,
  );
  const tool = bridge.tools.find(({ name }) => name === "mcp__updates__progress");
  assert.ok(tool);
  const updates: unknown[] = [];
  const turn = new AbortController();
  const running = tool.execute("progress-call", {}, turn.signal, (value) => updates.push(value));
  await flush();
  sendProgress?.({ progress: 1, total: 3, message: "accepted" });
  assert.equal(updates.length, 1);
  turn.abort(new Error("turn settled"));
  await assert.rejects(running, /MCP tool .* failed/);
  sendProgress?.({ progress: 2, total: 3, message: "late" });
  remote.resolve({ content: [{ type: "text", text: "late result" }] });
  await flush();
  assert.equal(updates.length, 1);
  await bridge.close();
});

test("M6 only the MCP extension moves first; configured order and control-last stay exact", async () => {
  const setup = fakeDeps();
  const agentDir = join(setup.cwd, "pi-agent-dir");
  const extensionDir = join(agentDir, "extensions");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, "01-first.ts"), `
    export default function (pi) {
      pi.registerTool({ name: "bash", label: "configured bash", description: "first", parameters: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: "configured" }] }) });
    }
  `);
  writeFileSync(join(extensionDir, "02-second.ts"), `
    export default function (pi) {
      pi.registerTool({ name: "configured_second", label: "second", description: "second", parameters: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: "second" }] }) });
    }
  `);
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() { return { tools: [{ name: "remote", inputSchema: { type: "object" } }] }; },
  });
  // Injected as a dependency, not by mutating process.env: the agent dir is what newSession()
  // builds its settings manager and resource loader from, so a test that needs specific
  // extensions loaded says so directly instead of reaching through a global.
  setup.deps.agentDir = agentDir;
  const agent = new (await import("../src/agent.js")).PiAcpAgent(setup.deps);
  try {
    await agent.newSession(context({
      cwd: setup.cwd,
      mcpServers: [{ name: "ordered", command: "fixture", args: [], env: [] }],
    }));
    const loaded = setup.createOptions[0]?.resourceLoader?.getExtensions();
    assert.ok(loaded);
    assert.deepEqual(loaded.errors, []);
    const paths = loaded.extensions.map(({ path }) => path);
    assert.equal(paths[0], "<inline:agentprism-pi-acp-mcp>");
    assert.match(paths[1] ?? "", /01-first\.ts$/);
    assert.match(paths[2] ?? "", /02-second\.ts$/);
    assert.equal(paths.at(-1), "<inline:agentprism-pi-acp-control>");
    assert.equal(loaded.extensions[1]?.tools.has("bash"), true);
    assert.equal(loaded.extensions.at(-1)?.tools.has("bash"), false,
      "the core fallback must not compete with an already-configured bash owner");
  } finally {
    await agent.dispose();
  }
});

test("M8 partial-open rollback closes every acquired handle in reverse order", async () => {
  const setup = fakeDeps();
  const closed: string[] = [];
  setup.deps.connectMcpClient = async (server) => fakeMcpHandle({
    async ping() {
      if (server.name === "third") throw new Error("post-connect ping failed");
    },
    async close() { closed.push(server.name); },
  });
  await assert.rejects(bridgeMcpServers([
    { name: "first", command: "fixture", args: [], env: [] },
    { name: "second", command: "fixture", args: [], env: [] },
    { name: "third", command: "fixture", args: [], env: [] },
  ], new AbortController().signal, setup.deps), (error: { data?: { server?: unknown } }) =>
    error.data?.server === "third");
  assert.deepEqual(closed, ["third", "second", "first"]);
});

test("M9 actual new/load/resume/fork connections never restore subscriptions or mutate history", async () => {
  const setup = fakeDeps();
  const subscriptions = [0, 0, 0, 0, 0];
  let connection = 0;
  setup.deps.connectMcpClient = async () => {
    const index = connection++;
    return fakeMcpHandle({
      getCapabilities: () => ({ resources: { subscribe: true } }),
      async listResources() { return { resources: [] }; },
      async listResourceTemplates() { return { resourceTemplates: [] }; },
      async readResource() { return { contents: [] }; },
      async subscribeResource() { subscriptions[index]! += 1; return {}; },
      async unsubscribeResource() { return {}; },
    });
  };
  const { PiAcpAgent } = await import("../src/agent.js");
  const agent = new PiAcpAgent(setup.deps);
  const server = { name: "same", command: "fixture", args: [], env: [] } as const;

  const created = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [server] }));
  const createdManager = setup.createOptions[0]!.sessionManager!;
  const createdBranch = structuredClone(createdManager.getBranch());
  const firstSubscribe = setup.controls[0]!.tools.find(({ name }) => name.endsWith("__subscribe_resource"));
  assert.ok(firstSubscribe);
  assert.equal(subscriptions[0], 0);
  await firstSubscribe.execute("new-explicit", { uri: "file:///one" }, new AbortController().signal);
  assert.equal(subscriptions[0], 1);
  assert.deepEqual(createdManager.getBranch(), createdBranch, "explicit subscription is ephemeral, not journaled");
  assert.deepEqual(setup.controls[0]!.session.agent.state.messages, [], "subscription never enters model context");
  await agent.closeSession(context({ sessionId: created.sessionId }));

  const source = SessionManager.create(setup.cwd, setup.sessionDir, { id: "m9-source" });
  source.appendMessage({ role: "user", content: "source prompt", timestamp: 1 } as never);
  source.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source answer" }],
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  } as never);
  const sourcePath = source.getSessionFile();
  assert.ok(sourcePath);
  const sourceBranch = structuredClone(source.getBranch());
  const sourceBytes = readFileSync(sourcePath, "utf8");
  const replay: unknown[] = [];

  await agent.loadSession(context({
    cwd: setup.cwd, sessionId: source.getSessionId(), mcpServers: [server],
  }, { notify: async (_method, params) => { replay.push(params); } }));
  assert.equal(subscriptions[1], 0, "load starts with no inherited subscription");
  assert.deepEqual(setup.createOptions[1]!.sessionManager!.getBranch(), sourceBranch);
  assert.deepEqual(setup.controls[1]!.session.agent.state.messages, [], "replay does not inject MCP state into model context");
  assert.ok(replay.length > 0, "load still emits its ordinary replay transcript");
  assert.equal(JSON.stringify(replay).includes("subscribe_resource"), false);
  await agent.closeSession(context({ sessionId: source.getSessionId() }));

  await agent.resumeSession(context({ cwd: setup.cwd, sessionId: source.getSessionId(), mcpServers: [server] }));
  assert.equal(subscriptions[2], 0, "resume starts with no inherited subscription");
  assert.deepEqual(setup.createOptions[2]!.sessionManager!.getBranch(), sourceBranch);
  assert.deepEqual(setup.controls[2]!.session.agent.state.messages, []);
  await agent.closeSession(context({ sessionId: source.getSessionId() }));

  const forked = await agent.forkSession(context({ cwd: setup.cwd, sessionId: source.getSessionId(), mcpServers: [server] }));
  assert.equal(subscriptions[3], 0, "fork starts with no inherited subscription despite copied history");
  const forkManager = setup.createOptions[3]!.sessionManager!;
  assert.deepEqual(forkManager.getBranch(), sourceBranch);
  assert.deepEqual(setup.controls[3]!.session.agent.state.messages, []);
  const forkSubscribe = setup.controls[3]!.tools.find(({ name }) => name.endsWith("__subscribe_resource"));
  assert.ok(forkSubscribe);
  await forkSubscribe.execute("fork-explicit", { uri: "file:///one" }, new AbortController().signal);
  assert.equal(subscriptions[3], 1, "only a later explicit call re-subscribes");
  assert.deepEqual(forkManager.getBranch(), sourceBranch);
  await agent.closeSession(context({ sessionId: forked.sessionId }));

  const originalAvailable = setup.deps.modelRuntime.getAvailable.bind(setup.deps.modelRuntime);
  setup.deps.modelRuntime.getAvailable = async () => { throw new Error("M9 open failure"); };
  await assert.rejects(agent.loadSession(context({
    cwd: setup.cwd, sessionId: source.getSessionId(), mcpServers: [server],
  })));
  setup.deps.modelRuntime.getAvailable = originalAvailable;
  assert.equal(subscriptions[4], 0, "failed open does not restore a subscription");
  assert.deepEqual(source.getBranch(), sourceBranch);
  assert.equal(readFileSync(sourcePath, "utf8"), sourceBytes, "load/resume/fork/open-failure add no source journal marker");
  assert.deepEqual(subscriptions, [1, 0, 0, 1, 0]);
  assert.equal(connection, 5);
  await agent.dispose();
});

test("C4 config refresh reserves prompt, config, and fork admission synchronously", async () => {
  const setup = fakeDeps();
  const refresh = deferred<readonly { provider: string; id: string; name: string; contextWindow: number }[]>();
  let reads = 0;
  const model = { provider: "test", id: "model", name: "Test model", contextWindow: 100 };
  setup.deps.modelRuntime = {
    getModel: () => model,
    getAvailable() {
      reads += 1;
      return reads === 1 ? Promise.resolve([model]) : refresh.promise;
    },
    hasConfiguredAuth: () => true,
  } as never;
  const agent = new (await import("../src/agent.js")).PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const setting = agent.setConfigOption(context({
    sessionId: opened.sessionId, configId: "thinkingLevel", value: "high",
  }));
  await assert.rejects(agent.prompt(context({
    sessionId: opened.sessionId, prompt: [{ type: "text", text: "busy" }],
  })), (error: { data?: { errorKind?: unknown } }) => error.data?.errorKind === "session_busy");
  await assert.rejects(agent.setConfigOption(context({
    sessionId: opened.sessionId, configId: "thinkingLevel", value: "low",
  })), (error: { data?: { errorKind?: unknown } }) => error.data?.errorKind === "session_busy");
  assert.throws(() => agent.forkSession(context({
    sessionId: opened.sessionId, cwd: setup.cwd, mcpServers: [],
  })), (error: { data?: { errorKind?: unknown } }) => error.data?.errorKind === "session_busy");
  refresh.resolve([model]);
  assert.equal((await setting).configOptions[0]?.currentValue, "high");
  await agent.dispose();
  await flush();
});
