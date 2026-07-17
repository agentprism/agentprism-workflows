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
import { bridgeMcpServers } from "../src/mcp-bridge.js";
import { runAcp } from "../src/server.js";
import { context, fakeDeps, fakeMcpHandle, streamPair } from "./helpers/fakes.js";

function kind(error: unknown): unknown {
  return ((error as RequestError).data as { errorKind?: string } | undefined)?.errorKind;
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
