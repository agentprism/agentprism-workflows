import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
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
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { PiAcpAgent } from "../src/agent.js";
import { runAcp } from "../src/server.js";
import {
  SESSION_STEERING_METHOD,
  steeringRequestParser,
  type SteeringRequest,
  type SteeringResponse,
} from "../src/steering.js";
import {
  LOADED_TURN_QUERY_METHOD,
  type LoadedTurnQueryRequest,
  type LoadedTurnQueryResponse,
} from "../src/loaded-turn.js";
import {
  context,
  fakeDeps,
  streamPair,
  type FakeDepsResult,
} from "./helpers/fakes.js";

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

const MODEL: Model<"openai-completions"> = {
  id: "steering-model",
  name: "Steering model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

function complete(
  stream: AssistantMessageEventStream,
  text: string,
  input = 2,
  output = 2,
): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const empty = { ...message, content: [{ type: "text" as const, text: "" }] };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "text_start", contentIndex: 0, partial: empty });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
}

interface RealSessionHarness {
  session(): AgentSession;
  nativePromptCalls(): number;
  nativeSteerCalls(): Array<{ text: string; images: ImageContent[] | undefined }>;
}

async function installRealSession(
  t: TestContext,
  setup: FakeDepsResult,
  streamFn: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): Promise<RealSessionHarness> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = setup.sessionDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "hermetic-key" }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  setup.deps.modelRuntime = modelRuntime;

  let session: AgentSession | undefined;
  let nativePromptCalls = 0;
  const nativeSteerCalls: Array<{ text: string; images: ImageContent[] | undefined }> = [];
  setup.deps.createAgentSession = async (options: CreateAgentSessionOptions) => {
    const agent = new Agent({
      initialState: { model: MODEL, systemPrompt: "Hermetic steering test", tools: [] },
      getApiKey: () => "hermetic-key",
      streamFn,
    });
    session = new AgentSession({
      agent,
      sessionManager: options.sessionManager ?? SessionManager.inMemory(setup.cwd),
      settingsManager: options.settingsManager!,
      cwd: setup.cwd,
      resourceLoader: options.resourceLoader!,
      customTools: options.customTools,
      modelRuntime,
      initialActiveToolNames: [],
    });
    const nativePrompt = session.prompt.bind(session);
    session.prompt = async (...args) => {
      nativePromptCalls += 1;
      return nativePrompt(...args);
    };
    const nativeSteer = session.steer.bind(session);
    session.steer = async (text, images) => {
      nativeSteerCalls.push({ text, images });
      return nativeSteer(text, images);
    };
    return {
      session,
      extensionsResult: options.resourceLoader!.getExtensions(),
      modelFallbackMessage: undefined,
    };
  };

  return {
    session() {
      if (!session) throw new Error("real AgentSession has not been constructed");
      return session;
    },
    nativePromptCalls: () => nativePromptCalls,
    nativeSteerCalls: () => nativeSteerCalls,
  };
}

test("steering custom parser accepts ACP content/meta and rejects malformed requests", () => {
  const valid: SteeringRequest = {
    sessionId: "session",
    prompt: [
      { type: "text", text: "text" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
      { type: "resource_link", uri: "file:///spec", name: "spec" },
      { type: "resource", resource: { uri: "file:///embedded", text: "embedded" } },
    ],
    _meta: { trace: "opaque" },
  };
  assert.equal(steeringRequestParser.parse(valid), valid);

  for (const malformed of [
    null,
    {},
    { sessionId: 1, prompt: [] },
    { sessionId: "session", prompt: "text" },
    { sessionId: "session", prompt: [{ type: "text" }] },
    { sessionId: "session", prompt: [{ type: "image", data: "raw" }] },
    { sessionId: "session", prompt: [{ type: "unknown" }] },
    { sessionId: "session", prompt: [], _meta: [] },
  ]) {
    assert.throws(
      () => steeringRequestParser.parse(malformed),
      (error) => error instanceof RequestError && error.code === -32602,
    );
  }
});

test("PiSession uses native steer with converted content and leaves the original prompt in control", async () => {
  const setup = fakeDeps("wedged");
  const updates: SessionUpdate[] = [];
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async (_method: string, params: { update: SessionUpdate }) => { updates.push(params.update); } },
  ));

  const request = new AbortController();
  let promptSettled = false;
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "original prompt" }],
  }, undefined, request.signal));
  void prompt.finally(() => { promptSettled = true; });
  await eventually(() => assert.ok(setup.controls[0]?.resolvePrompt));

  const response = await agent.steer(context({
    sessionId: opened.sessionId,
    prompt: [
      { type: "text", text: "turn correction" },
      {
        type: "resource_link",
        uri: "file:///spec",
        name: "spec",
        title: "Spec",
      },
      {
        type: "resource",
        resource: { uri: "file:///embedded", text: "embedded" },
      },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    _meta: { private: "ignored" },
  }));
  assert.deepEqual(response, { outcome: "injected" });
  assert.equal(promptSettled, false);
  assert.equal(setup.controls[0]?.promptCalls.length, 1);
  assert.deepEqual(setup.controls[0]?.steerCalls, [{
    text: [
      "turn correction",
      "[Spec](file:///spec)",
      "embedded",
      "[unsupported audio content omitted]",
    ].join("\n\n"),
    images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
  }]);
  assert.deepEqual(updates, [], "steering owns no adapter output or usage");

  request.abort(new Error("cancel original turn"));
  assert.equal((await prompt).stopReason, "cancelled");
  assert.deepEqual(setup.controls[0]?.operationLog.slice(0, 3), [
    "steer",
    "clearQueue",
    "abort",
  ]);

  // After the cancelled turn settles, steering is idle and cannot start work.
  assert.deepEqual(
    await agent.steer(context({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "late" }] })),
    { outcome: "promptRequired", reason: "noRunningTurn" },
  );
  assert.equal(setup.controls[0]?.promptCalls.length, 1);
  await agent.dispose();
});

test("idle steering returns promptRequired and sends no hidden Pi operation", async () => {
  const setup = fakeDeps("wedged");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const control = setup.controls[0]!;

  assert.deepEqual(
    await agent.steer(context({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "start from idle" }],
    })),
    { outcome: "promptRequired", reason: "noRunningTurn" },
  );
  assert.deepEqual(
    await agent.steer(context({
      sessionId: opened.sessionId,
      prompt: [],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    })),
    { outcome: "promptRequired", reason: "noRunningTurn" },
  );
  assert.equal(control.promptCalls.length, 0, "idle steering never calls prompt");
  assert.equal(control.steerCalls.length, 0, "idle steering never calls native steer");
  assert.deepEqual(control.operationLog, [], "idle steering never calls followUp or another Pi operation");
  await agent.dispose();
});

test("steering racing an in-progress cancel requires a prompt without restarting generation", async () => {
  const setup = fakeDeps("wedged");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const request = new AbortController();
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "original" }],
  }, undefined, request.signal));
  await eventually(() => assert.ok(setup.controls[0]?.resolvePrompt));

  request.abort(new Error("cancel"));
  const steer = agent.steer(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "too late" }],
  }));
  assert.deepEqual(await steer, { outcome: "promptRequired", reason: "noRunningTurn" });
  assert.equal(setup.controls[0]?.steerCalls.length, 0, "cancellation wins before the enqueue");
  assert.equal((await prompt).stopReason, "cancelled");
  assert.equal(setup.controls[0]?.promptCalls.length, 1, "no steering-started restart after cancel");
  await agent.dispose();
});

test("unconsumed native steering is discarded at settlement and never hidden in the next prompt", async () => {
  const setup = fakeDeps("wedged");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const control = setup.controls[0]!;
  control.retainSteeredMessages = true;
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "original" }],
  }));
  await eventually(() => assert.ok(control.resolvePrompt));

  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  assert.deepEqual(
    await agent.steer(context({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "left in queue" }, image],
    })),
    { outcome: "injected" },
  );
  assert.deepEqual(control.steeringQueue, ["left in queue"]);

  control.resolvePrompt?.();
  assert.equal((await prompt).stopReason, "end_turn");
  assert.equal(control.promptCalls.length, 1, "settlement never starts a hidden prompt");
  assert.deepEqual(control.steeringQueue, [], "settlement removes native queue residue");

  control.retainSteeredMessages = false;
  const nextPrompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "explicit next prompt" }],
  }));
  await eventually(() => assert.equal(control.promptCalls.length, 2));
  assert.equal(control.promptCalls[1]?.text, "explicit next prompt");
  assert.deepEqual(control.steeringQueue, [], "the next prompt contains no hidden steering input");
  control.resolvePrompt?.();
  assert.equal((await nextPrompt).stopReason, "end_turn");
  await agent.dispose();
});

test("a steer that lands as the run settles returns promptRequired and starts no hidden turn", async () => {
  const setup = fakeDeps("wedged");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const control = setup.controls[0]!;
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "original" }],
  }));
  await eventually(() => assert.ok(control.resolvePrompt));

  // Model the residual end-of-turn window: the enqueue reaches pi's queue only after
  // the run has fully settled, so no run will ever poll it.
  const enqueueGate = deferred<void>();
  control.session.steer = async (text: string) => {
    control.operationLog.push("steer");
    await enqueueGate.promise;
    control.steeringQueue.push(text);
  };
  const steer = agent.steer(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "late arrival" }],
  }));
  await eventually(() => assert.ok(control.operationLog.includes("steer")));
  control.resolvePrompt?.();
  assert.equal((await prompt).stopReason, "end_turn");
  enqueueGate.resolve();

  assert.deepEqual(await steer, { outcome: "promptRequired", reason: "noRunningTurn" });
  assert.equal(control.promptCalls.length, 1, "settlement-race steering never calls prompt");
  assert.deepEqual(control.steeringQueue, [], "the recovered message left pi's queue");

  const nextPrompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "explicit work only" }],
  }));
  await eventually(() => assert.equal(control.promptCalls.length, 2));
  assert.equal(control.promptCalls[1]?.text, "explicit work only");
  assert.deepEqual(control.steeringQueue, [], "late steering did not leak into the next prompt");
  control.resolvePrompt?.();
  assert.equal((await nextPrompt).stopReason, "end_turn");
  await agent.dispose();
});

test("native steer failures reject without settling the prompt or starting another", async () => {
  const setup = fakeDeps("wedged");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "original" }],
  }));
  await eventually(() => assert.ok(setup.controls[0]?.resolvePrompt));
  const control = setup.controls[0]!;
  control.session.steer = async () => { throw new Error("native steering failure"); };
  await assert.rejects(
    agent.steer(context({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "correction" }],
    })),
    (error) => kind(error) === "internal_error",
  );
  control.resolvePrompt?.();
  assert.equal((await prompt).stopReason, "end_turn");
  assert.equal(control.promptCalls.length, 1);
  await agent.dispose();
});

test("cleanup attempts abort after clearQueue throws and keeps clearQueue-before-abort order", async () => {
  const setup = fakeDeps("wedged");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "original" }],
  }));
  await eventually(() => assert.ok(setup.controls[0]?.resolvePrompt));
  const calls: string[] = [];
  const control = setup.controls[0]!;
  control.session.clearQueue = () => {
    calls.push("clearQueue");
    throw new Error("clear failed");
  };
  control.session.abort = async () => {
    calls.push("abort");
    control.rejectPrompt?.(new Error("aborted"));
  };
  agent.cancel({
    params: { sessionId: opened.sessionId },
    signal: new AbortController().signal,
    client: {} as never,
  });
  await assert.rejects(prompt, (error) => kind(error) === "child_cleanup_error");
  assert.deepEqual(calls, ["clearQueue", "abort"]);

  control.session.clearQueue = () => ({ steering: [], followUp: [] });
  control.session.abort = async () => {};
  await agent.closeSession(context({ sessionId: opened.sessionId }));
});

test("wire server advertises top-level steering, parses the extension, and routes through requireLive", async () => {
  const setup = fakeDeps("wedged");
  const pair = streamPair();
  const app = client({ name: "pi-acp-steering-wire" })
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }));
  const server = await runAcp({ deps: setup.deps, stream: pair.agent });
  const connection = app.connect(pair.client);
  try {
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
    });
    assert.deepEqual(initialized._meta, { steering: { supported: true }, loadedTurn: { supported: true } });
    assert.equal(
      "_meta" in (initialized.agentCapabilities as Record<string, unknown>),
      false,
      "steering is advertised only at the initialize-response top level",
    );

    await assert.rejects(
      connection.agent.request(SESSION_STEERING_METHOD, {
        sessionId: 123,
        prompt: [],
      }),
      (error) => error instanceof RequestError && error.code === -32602,
    );
    // The loaded-turn query parses strictly and routes through requireLive
    // (the same -32602 invalid-params shape for a malformed request).
    await assert.rejects(
      connection.agent.request(LOADED_TURN_QUERY_METHOD, {
        sessionId: 123,
      }),
      (error) => error instanceof RequestError && error.code === -32602,
    );
    await assert.rejects(
      connection.agent.request<LoadedTurnQueryResponse, LoadedTurnQueryRequest>(
        LOADED_TURN_QUERY_METHOD,
        { sessionId: "missing" },
      ),
      (error) => kind(error) === "unknown_session",
    );

    const opened = await connection.agent.request(methods.agent.session.new, {
      cwd: setup.cwd,
      mcpServers: [],
    });
    const prompt = connection.agent.request(methods.agent.session.prompt, {
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "original" }],
    });
    await eventually(() => assert.ok(setup.controls[0]?.resolvePrompt));
    assert.deepEqual(
      await connection.agent.request<SteeringResponse, SteeringRequest>(
        SESSION_STEERING_METHOD,
        {
          sessionId: opened.sessionId,
          prompt: [{ type: "text", text: "wire correction" }],
          _meta: { opaque: "metadata" },
        },
      ),
      { outcome: "injected" },
    );
    assert.deepEqual(setup.controls[0]?.steerCalls, [{
      text: "wire correction",
      images: [],
    }]);
    setup.controls[0]!.session.steer = async () => { throw new Error("wire steering failure"); };
    await assert.rejects(
      connection.agent.request<SteeringResponse, SteeringRequest>(
        SESSION_STEERING_METHOD,
        {
          sessionId: opened.sessionId,
          prompt: [{ type: "text", text: "wire failure" }],
        },
      ),
      (error) => kind(error) === "internal_error",
    );
    assert.equal(setup.controls[0]?.promptCalls.length, 1, "failed wire steering starts no prompt");
    setup.controls[0]?.resolvePrompt?.();
    assert.equal((await prompt).stopReason, "end_turn");

    assert.deepEqual(
      await connection.agent.request<SteeringResponse, SteeringRequest>(
        SESSION_STEERING_METHOD,
        { sessionId: opened.sessionId, prompt: [{ type: "text", text: "idle wire steer" }] },
      ),
      { outcome: "promptRequired", reason: "noRunningTurn" },
    );
    assert.equal(setup.controls[0]?.promptCalls.length, 1, "idle wire steering starts no prompt");
  } finally {
    connection.close();
    server.connection.close();
    await Promise.all([connection.closed, server.connection.closed]);
    await server.agent.dispose();
  }
});

test("real AgentSession keeps steered generation under the original ACP prompt", async (t) => {
  const setup = fakeDeps();
  const firstStarted = deferred<void>();
  let firstStream: AssistantMessageEventStream | undefined;
  const contexts: Context[] = [];
  let streamCalls = 0;
  const harness = await installRealSession(t, setup, (_model, streamContext) => {
    streamCalls += 1;
    contexts.push(streamContext);
    const stream = createAssistantMessageEventStream();
    if (streamCalls === 1) {
      firstStream = stream;
      firstStarted.resolve();
    } else {
      queueMicrotask(() => complete(stream, "after steering", 3, 2));
    }
    return stream;
  });
  const updates: SessionUpdate[] = [];
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async (_method: string, params: { update: SessionUpdate }) => { updates.push(params.update); } },
  ));
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "original" }],
  }));
  await firstStarted.promise;
  assert.equal(harness.session().isStreaming, true);

  assert.deepEqual(await agent.steer(context({
    sessionId: opened.sessionId,
    prompt: [
      { type: "text", text: "native correction" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
  })), { outcome: "injected" });
  assert.equal(harness.nativePromptCalls(), 1);
  assert.deepEqual(harness.nativeSteerCalls(), [{
    text: "native correction",
    images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
  }]);

  if (!firstStream) throw new Error("first stream was not captured");
  complete(firstStream, "before steering");
  const response = await prompt;
  assert.equal(response.stopReason, "end_turn");
  assert.equal(response.usage?.totalTokens, 9);
  assert.equal(streamCalls, 2);
  assert.equal(harness.nativePromptCalls(), 1, "steering never creates another Pi prompt");
  const lastInput = contexts[1]?.messages.at(-1);
  assert.equal(lastInput?.role, "user");
  assert.deepEqual(lastInput?.content, [
    { type: "text", text: "native correction" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ]);
  assert.deepEqual(
    updates
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) =>
        update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
          ? update.content.text
          : ""),
    ["before steering", "after steering"],
  );
  assert.equal(
    updates.filter((update) => update.sessionUpdate === "usage_update").length,
    1,
    "the original prompt alone owns usage",
  );
  await agent.dispose();
});

test("real AgentSession idle steering requires a prompt and performs no native operation", async (t) => {
  const setup = fakeDeps();
  const harness = await installRealSession(t, setup, () => {
    throw new Error("idle steering must not start a provider stream");
  });
  const updates: SessionUpdate[] = [];
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async (_method: string, params: { update: SessionUpdate }) => { updates.push(params.update); } },
  ));

  assert.deepEqual(await agent.steer(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "start now" }],
  })), { outcome: "promptRequired", reason: "noRunningTurn" });
  assert.equal(harness.nativePromptCalls(), 0, "idle steering never calls native prompt");
  assert.equal(harness.nativeSteerCalls().length, 0);
  assert.deepEqual(updates, [], "idle steering emits no hidden turn output");
  await agent.dispose();
});

test("real AgentSession cancellation clears queued steering before abort can restart generation", async (t) => {
  const setup = fakeDeps();
  const firstStarted = deferred<void>();
  let firstStream: AssistantMessageEventStream | undefined;
  let streamCalls = 0;
  const harness = await installRealSession(t, setup, () => {
    streamCalls += 1;
    const stream = createAssistantMessageEventStream();
    if (streamCalls === 1) {
      firstStream = stream;
      firstStarted.resolve();
    } else {
      queueMicrotask(() => complete(stream, "must not run"));
    }
    return stream;
  });
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const request = new AbortController();
  const prompt = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "original" }],
  }, undefined, request.signal));
  await firstStarted.promise;
  assert.deepEqual(await agent.steer(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "queued steering" }],
  })), { outcome: "injected" });
  assert.equal(harness.session().pendingMessageCount, 1);

  request.abort(new Error("cancel with steering queued"));
  assert.equal(
    harness.session().pendingMessageCount,
    0,
    "cleanup clears Pi's native queue synchronously before waiting for abort",
  );
  if (!firstStream) throw new Error("first stream was not captured");
  complete(firstStream, "finishing after cancellation");
  assert.equal((await prompt).stopReason, "cancelled");
  assert.equal(streamCalls, 1, "queued steering did not trigger a post-cancel provider call");
  assert.deepEqual(harness.session().getSteeringMessages(), []);
  await agent.dispose();
});
