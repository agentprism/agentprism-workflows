import assert from "node:assert/strict";
import test from "node:test";
import {
  client,
  methods,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  AgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { PiAcpAgent } from "../src/agent.js";
import { bridgeMcpServers, type McpSessionBinding } from "../src/mcp-bridge.js";
import { runAcp } from "../src/server.js";
import { context, fakeDeps, fakeMcpHandle, streamPair } from "./helpers/fakes.js";

function kind(error: unknown): unknown {
  return ((error as RequestError).data as { errorKind?: string } | undefined)?.errorKind;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

test("T14/T21 scripted ACP client observes ordered updates before the full-turn response", async () => {
  const setup = fakeDeps();
  const pair = streamPair();
  const updates: SessionUpdate[] = [];
  const clientApp = client({ name: "pi-acp-test" })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }));
  const server = await runAcp({ deps: setup.deps, stream: pair.agent });
  const connection = clientApp.connect(pair.client);
  const initialized = await connection.agent.request(methods.agent.initialize, { protocolVersion: 1 });
  assert.equal(initialized.protocolVersion, 1);
  const opened = await connection.agent.request(methods.agent.session.new, { cwd: setup.cwd, mcpServers: [] });
  const response = await connection.agent.request(methods.agent.session.prompt, {
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  assert.equal(response.stopReason, "end_turn");
  assert.deepEqual(updates.map(({ sessionUpdate }) => sessionUpdate), ["agent_message_chunk", "usage_update"]);
  assert.equal(setup.createOptions[0]?.modelRuntime, setup.deps.modelRuntime);
  connection.close();
  server.connection.close();
  await Promise.all([connection.closed, server.connection.closed]);
  await server.agent.dispose();
});

test("T21 real AgentSession with an injected Agent streamFn completes a credential-free ACP turn", async (t) => {
  const setup = fakeDeps();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = setup.sessionDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "hermetic-key" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  setup.deps.modelRuntime = modelRuntime;
  const model: Model<"openai-completions"> = {
    id: "hermetic-model",
    name: "Hermetic model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
  let constructedWithRuntime: ModelRuntime | undefined;
  setup.deps.createAgentSession = async (options) => {
    constructedWithRuntime = options.modelRuntime;
    const streamFn = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hermetic pong" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 2,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 4,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        const partial = { ...message, content: [{ type: "text" as const, text: "hermetic pong" }] };
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "hermetic pong", partial });
        stream.push({ type: "text_end", contentIndex: 0, content: "hermetic pong", partial });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    };
    const agent = new Agent({
      initialState: { model, systemPrompt: "Hermetic test", tools: [] },
      getApiKey: () => "hermetic-key",
      streamFn,
    });
    const session = new AgentSession({
      agent,
      sessionManager: options.sessionManager ?? SessionManager.inMemory(setup.cwd),
      settingsManager: options.settingsManager,
      cwd: setup.cwd,
      resourceLoader: options.resourceLoader,
      customTools: options.customTools,
      modelRuntime,
      initialActiveToolNames: [],
    });
    return {
      session,
      extensionsResult: options.resourceLoader?.getExtensions(),
      modelFallbackMessage: undefined,
    };
  };

  const pair = streamPair();
  const updates: SessionUpdate[] = [];
  const clientApp = client({ name: "pi-acp-hermetic-test" })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }));
  const server = await runAcp({ deps: setup.deps, stream: pair.agent });
  const connection = clientApp.connect(pair.client);
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1 });
  const opened = await connection.agent.request(methods.agent.session.new, {
    cwd: setup.cwd,
    mcpServers: [],
  });
  const response = await connection.agent.request(methods.agent.session.prompt, {
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "ping" }],
  });
  assert.equal(response.stopReason, "end_turn");
  assert.equal(response.usage?.totalTokens, 4);
  assert.equal(constructedWithRuntime, modelRuntime);
  assert.ok(updates.some((update) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.text === "hermetic pong"));
  connection.close();
  server.connection.close();
  await Promise.all([connection.closed, server.connection.closed]);
  await server.agent.dispose();
});

test("M5 actual Pi turn keeps a selected removed tool, then omits it and tombstones stale calls", async (t) => {
  const setup = fakeDeps();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = setup.sessionDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "hermetic-key" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  setup.deps.modelRuntime = modelRuntime;
  const model: Model<"openai-completions"> = {
    id: "m5-model",
    name: "M5 model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
  const selected = deferred<void>();
  const releaseSelected = deferred<void>();
  const refreshListed = deferred<void>();
  let catalog: Array<{ name: string; inputSchema: { type: string } }> = [
    { name: "selected", inputSchema: { type: "object" } },
  ];
  let changed: (() => void) | undefined;
  let listCalls = 0;
  let remoteCalls = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() {
      listCalls += 1;
      if (listCalls > 1) refreshListed.resolve();
      return { tools: catalog };
    },
    async callTool() {
      remoteCalls += 1;
      selected.resolve();
      await releaseSelected.promise;
      return { content: [{ type: "text", text: "old handle succeeded" }] };
    },
    setToolsChangedHandler(handler) { changed = handler; },
  });
  const toolSnapshots: string[][] = [];
  let streamCall = 0;
  let realSession: AgentSession | undefined;
  setup.deps.createAgentSession = async (options) => {
    const streamFn = (_activeModel: unknown, context: { tools?: Array<{ name: string }> }) => {
      const stream = createAssistantMessageEventStream();
      const names = context.tools?.map(({ name }) => name) ?? [];
      toolSnapshots.push(names);
      const alias = names.find((name) => name === "mcp__turn-removal__selected");
      const toolTurn = streamCall === 0;
      streamCall += 1;
      assert.ok(!toolTurn || alias, "the first real Pi model turn selects the live MCP alias");
      const message: AssistantMessage = {
        role: "assistant",
        content: toolTurn
          ? [{ type: "toolCall", id: "m5-selected-call", name: alias!, arguments: {} }]
          : [{ type: "text", text: "turn complete" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toolTurn ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (!toolTurn) {
          stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "turn complete", partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "turn complete", partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    };
    const agent = new Agent({
      initialState: { model, systemPrompt: "M5 turn boundary", tools: [] },
      getApiKey: () => "hermetic-key",
      streamFn,
    });
    realSession = new AgentSession({
      agent,
      sessionManager: options.sessionManager ?? SessionManager.inMemory(setup.cwd),
      settingsManager: options.settingsManager,
      cwd: setup.cwd,
      resourceLoader: options.resourceLoader,
      customTools: options.customTools,
      modelRuntime,
      initialActiveToolNames: [],
    });
    return {
      session: realSession,
      extensionsResult: options.resourceLoader?.getExtensions(),
      modelFallbackMessage: undefined,
    };
  };

  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({
    cwd: setup.cwd,
    mcpServers: [{ name: "turn-removal", command: "fixture", args: [], env: [] }],
  }));
  const first = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "select the MCP tool" }],
  }));
  await selected.promise;
  catalog = [];
  changed?.();
  await refreshListed.promise;
  assert.equal(realSession?.getActiveToolNames().includes("mcp__turn-removal__selected"), true);
  releaseSelected.resolve();
  assert.equal((await first).stopReason, "end_turn");
  assert.equal(remoteCalls, 1, "the current turn executes the old selected handle successfully");
  await eventually(() => assert.equal(
    realSession?.getActiveToolNames().includes("mcp__turn-removal__selected"),
    false,
  ));

  const stale = realSession?.getToolDefinition("mcp__turn-removal__selected");
  assert.ok(stale);
  await assert.rejects(
    stale.execute("stale-direct", {}, new AbortController().signal),
    /MCP tool mcp__turn-removal__selected is no longer available/,
  );
  const second = await agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "the removed tool must be absent" }],
  }));
  assert.equal(second.stopReason, "end_turn");
  assert.equal(toolSnapshots.at(-1)?.includes("mcp__turn-removal__selected"), false);
  await agent.dispose();
});

test("T14 notify failure rejects notification_error and emits no usage update", async () => {
  const setup = fakeDeps();
  let notifications = 0;
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async () => { notifications += 1; throw new Error("broken transport"); } },
  ));
  await assert.rejects(
    agent.prompt(context({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "x" }] })),
    (error) => kind(error) === "notification_error",
  );
  assert.equal(notifications, 1);
  await agent.dispose();
});

test("M4 MCP diagnostics use the real session FIFO, wait for delivery, and obey gate sinks", async () => {
  const setup = fakeDeps("wedged");
  let binding: McpSessionBinding | undefined;
  setup.deps.connectMcpClient = async (_server, _signal, serverBinding) => {
    binding = serverBinding;
    return fakeMcpHandle({ async listTools() { return { tools: [] }; } });
  };
  const firstDelivery = deferred<void>();
  const usageDelivery = deferred<void>();
  const usageSeen = deferred<void>();
  const updates: SessionUpdate[] = [];
  const stderr: string[] = [];
  const priorError = console.error;
  console.error = (...values: unknown[]) => { stderr.push(values.join(" ")); };
  const agent = new PiAcpAgent(setup.deps);
  try {
    const opened = await agent.newSession(context({
      cwd: setup.cwd,
      mcpServers: [{ name: "diagnostic-fifo", command: "fixture", args: [], env: [] }],
    }, {
      notify: async (_method, params: { update: SessionUpdate }) => {
        updates.push(params.update);
        if (updates.length === 1) await firstDelivery.promise;
        if (params.update.sessionUpdate === "usage_update") {
          binding?.emitDiagnostic("[mcp:diagnostic-fifo] after-gate");
          usageSeen.resolve();
          await usageDelivery.promise;
        }
      },
    }));
    assert.ok(binding);
    binding.emitDiagnostic("[mcp:diagnostic-fifo] outside-turn");
    assert.deepEqual(stderr, ["[mcp:diagnostic-fifo] outside-turn"]);

    const prompt = agent.prompt(context({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "diagnostic order" }],
    }));
    await eventually(() => assert.ok(setup.controls[0]?.resolvePrompt));
    binding.emitDiagnostic("[mcp:diagnostic-fifo] info: log");
    setup.controls[0]!.emit({
      type: "tool_execution_update",
      toolCallId: "ordinary-update",
      toolName: "ordinary",
      partialResult: { content: [{ type: "text", text: "ordinary" }], details: { ordinary: true } },
    } as never);
    binding.emitDiagnostic("[mcp:diagnostic-fifo] notifications/resources/list_changed");
    binding.emitDiagnostic("[mcp:diagnostic-fifo] notifications/resources/updated uri=file:///one");
    binding.emitDiagnostic("[mcp:diagnostic-fifo] unexpected notifications/message");
    binding.emitDiagnostic("[mcp:diagnostic-fifo] progress notification failed");
    binding.emitDiagnostic("[mcp:diagnostic-fifo] tools/list refresh failed");
    firstDelivery.resolve();
    setup.controls[0]!.resolvePrompt?.();
    await usageSeen.promise;
    let promptSettled = false;
    void prompt.finally(() => { promptSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promptSettled, false, "prompt settlement waits for the accepted diagnostic FIFO");
    assert.deepEqual(updates.slice(0, 7).map((update) => update.sessionUpdate), [
      "agent_thought_chunk",
      "tool_call_update",
      "agent_thought_chunk",
      "agent_thought_chunk",
      "agent_thought_chunk",
      "agent_thought_chunk",
      "agent_thought_chunk",
    ]);
    assert.deepEqual(updates.slice(0, 7).map((update) =>
      update.sessionUpdate === "agent_thought_chunk" ? update.content.text : "ordinary"), [
      "[mcp:diagnostic-fifo] info: log",
      "ordinary",
      "[mcp:diagnostic-fifo] notifications/resources/list_changed",
      "[mcp:diagnostic-fifo] notifications/resources/updated uri=file:///one",
      "[mcp:diagnostic-fifo] unexpected notifications/message",
      "[mcp:diagnostic-fifo] progress notification failed",
      "[mcp:diagnostic-fifo] tools/list refresh failed",
    ]);
    usageDelivery.resolve();
    await prompt;
    assert.ok(stderr.includes("[mcp:diagnostic-fifo] after-gate"));

    await agent.closeSession(context({ sessionId: opened.sessionId }));
    const stderrBeforeDispose = stderr.length;
    binding.emitDiagnostic("[mcp:diagnostic-fifo] post-dispose");
    assert.equal(stderr.length, stderrBeforeDispose, "post-dispose diagnostics are suppressed");
  } finally {
    firstDelivery.resolve();
    usageDelivery.resolve();
    await agent.dispose();
    console.error = priorError;
  }
});

test("M4 notification failure plus cleanup failure settles once as child_cleanup_error", async () => {
  const setup = fakeDeps("wedged");
  let binding: McpSessionBinding | undefined;
  setup.deps.connectMcpClient = async (_server, _signal, serverBinding) => {
    binding = serverBinding;
    return fakeMcpHandle({ async listTools() { return { tools: [] }; } });
  };
  const agent = new PiAcpAgent(setup.deps);
  await agent.newSession(context({
    cwd: setup.cwd,
    mcpServers: [{ name: "diagnostic-failure", command: "fixture", args: [], env: [] }],
  }, { notify: async () => { throw new Error("ACP notification failed"); } }));
  const control = setup.controls[0]!;
  control.session.abort = async () => { throw new Error("Pi abort failed"); };
  const prompt = agent.prompt(context({
    sessionId: control.session.sessionManager.getSessionId(),
    prompt: [{ type: "text", text: "fail notification and cleanup" }],
  }));
  await eventually(() => assert.ok(control.resolvePrompt));
  binding?.emitDiagnostic("[mcp:diagnostic-failure] info: trigger failure");
  await assert.rejects(prompt, (error) => kind(error) === "child_cleanup_error");
  control.session.abort = async () => {};
  await agent.dispose();
});

test("M5 cancel keeps the turn boundary through usage drain and prompt settlement", async () => {
  const setup = fakeDeps("wedged");
  let changed: (() => void) | undefined;
  let catalog: Array<{ name: string; inputSchema: { type: string } }> = [
    { name: "held", inputSchema: { type: "object" } },
  ];
  const refreshListed = deferred<void>();
  let lists = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() {
      lists += 1;
      if (lists > 1) refreshListed.resolve();
      return { tools: catalog };
    },
    setToolsChangedHandler(handler) { changed = handler; },
  });
  const usageSeen = deferred<void>();
  const releaseUsage = deferred<void>();
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({
    cwd: setup.cwd,
    mcpServers: [{ name: "cancel-boundary", command: "fixture", args: [], env: [] }],
  }, {
    notify: async (_method, params: { update: SessionUpdate }) => {
      if (params.update.sessionUpdate === "usage_update") {
        usageSeen.resolve();
        await releaseUsage.promise;
      }
    },
  }));
  const control = setup.controls[0]!;
  const setActive = control.session.setActiveToolsByName.bind(control.session);
  let refreshCommits = 0;
  control.session.setActiveToolsByName = (names) => {
    refreshCommits += 1;
    setActive(names);
  };
  const request = new AbortController();
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "cancel with dirty refresh" }],
  }, undefined, request.signal));
  await eventually(() => assert.ok(control.resolvePrompt));
  catalog = [];
  changed?.();
  await refreshListed.promise;
  request.abort(new Error("cancel turn"));
  await usageSeen.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCommits, 0, "dirty refresh cannot commit inside cancelled-turn settlement");
  let promptSettled = false;
  void prompt.finally(() => { promptSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptSettled, false);
  releaseUsage.resolve();
  assert.equal((await prompt).stopReason, "cancelled");
  await eventually(() => assert.equal(refreshCommits, 1));
  assert.equal(control.session.getActiveToolNames().includes("mcp__cancel-boundary__held"), false);
  await agent.dispose();
});

test("T15 lifecycle reservations serialize duplicate load and close is idempotent", async () => {
  const setup = fakeDeps();
  const id = "load-id";
  const manager = SessionManager.create(setup.cwd, setup.sessionDir, { id });
  setup.deps.sessions.list = async () => [{
    path: `${setup.sessionDir}/session.jsonl`, id, cwd: setup.cwd, created: new Date(), modified: new Date(),
    messageCount: 0, firstMessage: "", allMessagesText: "",
  }];
  setup.deps.sessions.open = () => manager;
  const agent = new PiAcpAgent(setup.deps);
  const first = agent.loadSession(context({ cwd: setup.cwd, sessionId: id, mcpServers: [] }));
  assert.throws(
    () => agent.resumeSession(context({ cwd: setup.cwd, sessionId: id, mcpServers: [] })),
    (error) => kind(error) === "session_already_open",
  );
  await first;
  await agent.closeSession(context({ sessionId: id }));
  await agent.closeSession(context({ sessionId: id }));
  assert.throws(() => agent.prompt(context({ sessionId: "missing", prompt: [{ type: "text", text: "x" }] })), (error) => kind(error) === "unknown_session");
  assert.throws(() => agent.newSession(context({ cwd: "relative", mcpServers: [] })), (error) => kind(error) === "invalid_cwd");
  assert.equal(setup.createOptions[0]?.modelRuntime, setup.deps.modelRuntime);
});

test("T15b transactional create failure rolls back the reservation and permits a clean retry", async () => {
  const setup = fakeDeps();
  let fail = true;
  const create = setup.deps.createAgentSession;
  setup.deps.createAgentSession = async (options) => {
    if (fail) {
      fail = false;
      throw new Error("injected construction failure");
    }
    return create(options);
  };
  const fixed = SessionManager.create(setup.cwd, setup.sessionDir, { id: "retry-id" });
  setup.deps.sessions.create = () => fixed;
  const agent = new PiAcpAgent(setup.deps);
  await assert.rejects(agent.newSession(context({ cwd: setup.cwd, mcpServers: [] })), (error) => kind(error) === "internal_error");
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  assert.equal(opened.sessionId, "retry-id");
  await agent.dispose();
});

test("T16 load replays while resume does not, and fork rejects an empty live source categorically", async () => {
  const setup = fakeDeps();
  const id = "replay-id";
  const manager = {
    getSessionId: () => id,
    getBranch: () => [{ type: "message", message: { role: "user", content: "prior" } }],
    getSessionFile: () => `${setup.sessionDir}/missing.jsonl`,
  } as never;
  setup.deps.sessions.list = async () => [{
    path: "path", id, cwd: setup.cwd, created: new Date(), modified: new Date(), messageCount: 1,
    firstMessage: "prior", allMessagesText: "prior",
  }];
  setup.deps.sessions.open = () => manager;
  const updates: SessionUpdate[] = [];
  const agent = new PiAcpAgent(setup.deps);
  await agent.loadSession(context({ cwd: setup.cwd, sessionId: id, mcpServers: [] }, {
    notify: async (_method, params: unknown) => { updates.push((params as { update: SessionUpdate }).update); },
  }));
  assert.equal(updates[0]?.sessionUpdate, "user_message_chunk");
  await assert.rejects(agent.forkSession(context({ cwd: setup.cwd, sessionId: id, mcpServers: [] })), (error) => kind(error) === "session_not_forkable");
  await agent.closeSession(context({ sessionId: id }));
  updates.length = 0;
  await agent.resumeSession(context({ cwd: setup.cwd, sessionId: id, mcpServers: [] }, {
    notify: async (_method, params: unknown) => { updates.push((params as { update: SessionUpdate }).update); },
  }));
  assert.deepEqual(updates, []);
  await agent.dispose();
});

test("T17 list pagination uses canonical base64url offsets and tolerates shrink below cursor", async () => {
  const setup = fakeDeps();
  let count = 150;
  setup.deps.sessions.listAll = async () => Array.from({ length: count }, (_, index) => ({
    path: String(index), id: String(index), cwd: setup.cwd, created: new Date(), modified: new Date(150 - index),
    messageCount: 1, firstMessage: `s${index}`, allMessagesText: "",
  }));
  const agent = new PiAcpAgent(setup.deps);
  const first = await agent.listSessions(context({}));
  assert.equal(first.sessions.length, 100);
  assert.equal(first.nextCursor, "MTAw");
  const second = await agent.listSessions(context({ cursor: first.nextCursor }));
  assert.equal(second.sessions.length, 50);
  count = 90;
  const shrunk = await agent.listSessions(context({ cursor: first.nextCursor }));
  assert.deepEqual(shrunk.sessions, []);
  await assert.rejects(agent.listSessions(context({ cursor: "MDE=" })), (error) => kind(error) === "invalid_cursor");
  await assert.rejects(agent.listSessions(context({ cwd: "" })), (error) => kind(error) === "invalid_cwd");
});

test("T18/T22 cleanup deadline wins before barrier commit, rejects once, tombstones, and close retries", async () => {
  const setup = fakeDeps("wedged");
  let fire: (() => void) | undefined;
  setup.deps.sleep = (_ms, signal) => new Promise<void>((resolve, reject) => {
    fire = resolve;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const pending = agent.prompt(context({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "hang" }] }));
  agent.cancel({ params: { sessionId: opened.sessionId }, signal: new AbortController().signal, client: {} as never });
  fire?.();
  await assert.rejects(pending, (error) => kind(error) === "child_cleanup_error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => agent.prompt(context({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "again" }] })), (error) => kind(error) === "session_terminated");
  assert.ok((setup.controls[0]?.disposeCalls ?? 0) >= 1);
  assert.deepEqual(await agent.closeSession(context({ sessionId: opened.sessionId })), {});
  setup.controls[0]?.resolvePrompt?.();
});

test("T19 non-empty additionalDirectories are accepted and ignored", async () => {
  const setup = fakeDeps();
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [], additionalDirectories: ["/tmp/extra"] }));
  assert.equal(typeof opened.sessionId, "string");
  assert.equal("additionalDirectories" in (setup.createOptions[0] ?? {}), false);
  await agent.dispose();
});

test("T20 MCP bridge enumerates every page, rejects cursor cycles, and closes partial initialization", async () => {
  const setup = fakeDeps();
  const calls: Array<string | undefined> = [];
  let closed = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools(cursor) {
      calls.push(cursor);
      return cursor
        ? { tools: [{ name: "two", inputSchema: { type: "object" } }] }
        : { tools: [{ name: "one", inputSchema: { type: "object" } }], nextCursor: "next" };
    },
    async close() { closed += 1; },
  });
  const bridge = await bridgeMcpServers([{ name: "s", command: "x", args: [], env: [] }], new AbortController().signal, setup.deps);
  assert.deepEqual(calls, [undefined, "next"]);
  assert.deepEqual(bridge.aliases, ["mcp__s__one", "mcp__s__two"]);
  await bridge.clients[0]?.close();
  assert.equal(closed, 1);

  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() { return { tools: [], nextCursor: "cycle" }; },
  });
  await assert.rejects(
    bridgeMcpServers([{ name: "s", command: "x", args: [], env: [] }], new AbortController().signal, setup.deps),
    (error) => kind(error) === "mcp_init_error",
  );
  await assert.rejects(
    bridgeMcpServers([{ type: "acp", name: "a", command: "agent", args: [], env: [] }], new AbortController().signal, setup.deps),
    (error) => kind(error) === "unsupported_mcp_transport",
  );
});
