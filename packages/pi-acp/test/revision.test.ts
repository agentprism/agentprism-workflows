import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  client,
  methods,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { PiAcpAgent } from "../src/agent.js";
import { classifyPreflight } from "../src/errors.js";
import { bridgeMcpServers } from "../src/mcp-bridge.js";
import { runAcp } from "../src/server.js";
import {
  context,
  fakeDeps,
  fakeMcpHandle,
  fakeSession,
  streamPair,
} from "./helpers/fakes.js";

const RETIRED_STRUCTURED_TOOL = "__acp_structured_output";

function errorKind(error: unknown): unknown {
  return ((error as RequestError).data as { errorKind?: string } | undefined)?.errorKind;
}

function sessionUpdate(params: unknown): SessionUpdate {
  return (params as { update: SessionUpdate }).update;
}

test("§8.2 preflight classifier applies every ordered predicate and the generic fallback", async (t) => {
  const cases = [
    { name: "no model is invalid_model", message: "NO MODEL SELECTED", code: -32602, kind: "invalid_model" },
    { name: "missing key is auth_error", message: "No API key found for test/model", code: -32000, kind: "auth_error" },
    { name: "authentication failure is auth_error", message: "Authentication failed for test/model", code: -32000, kind: "auth_error" },
    { name: "login guidance is auth_error", message: "Please run '/login provider'", code: -32000, kind: "auth_error" },
    { name: "unmatched failure is provider_error", message: "provider handshake failed", code: -32603, kind: "provider_error" },
  ] as const;
  for (const item of cases) {
    await t.test(item.name, () => {
      const classified = classifyPreflight(new Error(item.message));
      assert.equal(classified.code, item.code);
      assert.equal(errorKind(classified), item.kind);
    });
  }
});

test("T9 no-model preflight uses the DI fake and rejects invalid_model rather than auth", async () => {
  const setup = fakeDeps("preflight");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  await assert.rejects(
    agent.prompt(context({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "hello" }] })),
    (error) => {
      assert.equal((error as RequestError).code, -32602);
      assert.equal(errorKind(error), "invalid_model");
      assert.notEqual(errorKind(error), "auth_error");
      return true;
    },
  );
  assert.equal(setup.controls[0]?.promptCalls.length, 1);
  await agent.dispose();
});

test("T6 preflight rejection emits no usage_update", async () => {
  const setup = fakeDeps("preflight");
  const updates: SessionUpdate[] = [];
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async (_method, params) => { updates.push(sessionUpdate(params)); } },
  ));
  await assert.rejects(
    agent.prompt(context({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "hello" }] })),
    (error) => errorKind(error) === "invalid_model",
  );
  assert.equal(updates.length, 0);
  assert.equal(updates.some(({ sessionUpdate }) => sessionUpdate === "usage_update"), false);
  await agent.dispose();
});

test("T6 terminal provider error emits and drains usage_update before rejecting", async () => {
  const setup = fakeDeps("provider-error");
  const order: string[] = [];
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async (_method, params) => { order.push(sessionUpdate(params).sessionUpdate); } },
  ));
  const rejected = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "bill the failed attempt" }],
  })).catch((error) => {
    order.push("request_rejected");
    throw error;
  });
  await assert.rejects(rejected, (error) => {
    assert.equal((error as RequestError).code, -32603);
    return errorKind(error) === "provider_error";
  });
  assert.equal(order.filter((item) => item === "usage_update").length, 1, order.join(","));
  assert.ok(order.indexOf("usage_update") < order.indexOf("request_rejected"), order.join(","));
  await agent.dispose();
});

test("T6 compaction drop lowers used while cumulative cost remains monotonic", async () => {
  const setup = fakeDeps();
  const updates: SessionUpdate[] = [];
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async (_method, params) => { updates.push(sessionUpdate(params)); } },
  ));
  const control = setup.controls[0];
  if (!control) throw new Error("missing fake session control");
  const snapshots = [
    { used: 80, cost: 1.25 },
    { used: 20, cost: 1.75 },
  ];
  control.session.getContextUsage = () => {
    const snapshot = snapshots[Math.max(0, control.promptCalls.length - 1)];
    return { tokens: snapshot?.used ?? 0, contextWindow: 100, percent: snapshot?.used ?? 0 };
  };
  control.session.getSessionStats = () => ({ cost: snapshots[Math.max(0, control.promptCalls.length - 1)]?.cost ?? 0 }) as never;

  for (const text of ["before compaction", "after compaction"]) {
    assert.equal((await agent.prompt(context({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text }],
    }))).stopReason, "end_turn");
  }
  const usage = updates.filter((update) => update.sessionUpdate === "usage_update");
  assert.equal(usage.length, 2);
  assert.deepEqual(usage.map((update) => update.sessionUpdate === "usage_update"
    ? { used: update.used, cost: update.cost?.amount }
    : undefined), [
    { used: 80, cost: 1.25 },
    { used: 20, cost: 1.75 },
  ]);
  assert.ok(usage[1]!.used < usage[0]!.used);
  assert.ok(usage[1]!.cost!.amount > usage[0]!.cost!.amount);
  await agent.dispose();
});

test("T9 journal-restored model/thinking values are initial and later sets win and persist", async () => {
  const setup = fakeDeps();
  const manager = SessionManager.create(setup.cwd, setup.sessionDir, { id: "journal-precedence" });
  manager.appendMessage({ role: "user", content: "journal fixture", timestamp: Date.now() });
  manager.appendModelChange("test", "restored-model");
  manager.appendThinkingLevelChange("low");
  const sessionPath = manager.getSessionFile();
  if (!sessionPath) throw new Error("journal fixture did not persist");
  setup.deps.sessions.list = async () => [{
    path: sessionPath,
    id: manager.getSessionId(),
    cwd: setup.cwd,
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: "journal fixture",
    allMessagesText: "journal fixture",
  }];
  setup.deps.sessions.open = () => manager;
  const models = new Map([
    ["restored-model", { provider: "test", id: "restored-model", contextWindow: 100, reasoning: true }],
    ["later-model", { provider: "test", id: "later-model", contextWindow: 200, reasoning: true }],
  ]);
  setup.deps.modelRuntime = {
    getModel(provider: string, id: string) { return provider === "test" ? models.get(id) : undefined; },
    async getAvailable() { return [...models.values()]; },
    hasConfiguredAuth() { return true; },
  } as never;
  setup.deps.createAgentSession = async (options: CreateAgentSessionOptions) => {
    setup.createOptions.push(options);
    const branch = options.sessionManager?.getBranch() ?? [];
    const restoredThinking = branch
      .filter((entry) => entry.type === "thinking_level_change")
      .at(-1)?.thinkingLevel ?? "medium";
    const restoredModelEntry = branch
      .filter((entry) => entry.type === "model_change")
      .at(-1);
    const restoredModel = restoredModelEntry
      ? setup.deps.modelRuntime.getModel(restoredModelEntry.provider, restoredModelEntry.modelId)
      : undefined;
    const control = fakeSession({
      ...options,
      thinkingLevel: restoredThinking as never,
      model: restoredModel,
    });
    setup.controls.push(control);
    const setThinkingLevel = control.session.setThinkingLevel.bind(control.session);
    control.session.setThinkingLevel = (level) => {
      setThinkingLevel(level);
      manager.appendThinkingLevelChange(level);
    };
    const setModel = control.session.setModel.bind(control.session);
    control.session.setModel = async (model) => {
      await setModel(model);
      manager.appendModelChange(model.provider, model.id);
    };
    return {
      session: control.session,
      extensionsResult: { extensions: [], errors: [], runtime: {} },
      modelFallbackMessage: undefined,
    } as never;
  };

  const agent = new PiAcpAgent(setup.deps);
  const firstLoad = await agent.loadSession(context({
    cwd: setup.cwd,
    sessionId: manager.getSessionId(),
    mcpServers: [],
  }));
  assert.equal(firstLoad.configOptions[0]?.currentValue, "low");
  assert.equal(setup.controls[0]?.session.model?.id, "restored-model");
  assert.equal((await agent.setConfigOption(context({
    sessionId: manager.getSessionId(),
    configId: "thinkingLevel",
    value: "high",
  }))).configOptions[0]?.currentValue, "high");
  await agent.setConfigOption(context({
    sessionId: manager.getSessionId(),
    configId: "model",
    value: "test/later-model",
  }));
  assert.equal(setup.controls[0]?.session.model?.id, "later-model");
  await agent.closeSession(context({ sessionId: manager.getSessionId() }));

  const secondLoad = await agent.loadSession(context({
    cwd: setup.cwd,
    sessionId: manager.getSessionId(),
    mcpServers: [],
  }));
  assert.equal(secondLoad.configOptions[0]?.currentValue, "high");
  assert.equal(setup.controls[1]?.session.model?.id, "later-model");
  await agent.dispose();
});

test("S3 private outputSchema metadata is ignored and never arms a server-side tool", async () => {
  const setup = fakeDeps();
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  await agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "plain" }],
  }));
  await agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "structured" }],
    _meta: { outputSchema: { type: "object" } },
  }));
  assert.equal(setup.controls[0]?.activeToolsAtPrompt[0]?.includes(RETIRED_STRUCTURED_TOOL) ?? false, false);
  assert.equal(setup.controls[0]?.activeToolsAtPrompt[1]?.includes(RETIRED_STRUCTURED_TOOL), false);
  assert.equal(setup.controls[0]?.session.getActiveToolNames().includes(RETIRED_STRUCTURED_TOOL), false);
  await agent.dispose();
});

test("S3 private metadata cannot fabricate a final agent message", async () => {
  const setup = fakeDeps();
  const pair = streamPair();
  const updates: SessionUpdate[] = [];
  const clientApp = client({ name: "pi-acp-structured-capture" })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }));
  const server = await runAcp({ deps: setup.deps, stream: pair.agent });
  const connection = clientApp.connect(pair.client);
  try {
    await connection.agent.request(methods.agent.initialize, { protocolVersion: 1 });
    const opened = await connection.agent.request(methods.agent.session.new, {
      cwd: setup.cwd,
      mcpServers: [],
    });
    assert.equal((await connection.agent.request(methods.agent.session.prompt, {
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "return data" }],
      _meta: { outputSchema: { type: "object", properties: { answer: { type: "number" } } } },
    })).stopReason, "end_turn");
    const chunks = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
    assert.deepEqual(chunks.map((update) => update.sessionUpdate === "agent_message_chunk"
      ? update.content.text
      : undefined), ["hello"]);
    assert.deepEqual(updates.map(({ sessionUpdate }) => sessionUpdate), [
      "agent_message_chunk",
      "usage_update",
    ]);
  } finally {
    connection.close();
    server.connection.close();
    await server.agent.dispose();
  }
});

test("S3 auth preflight never creates private structured state", async () => {
  const setup = fakeDeps("auth-preflight");
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  await assert.rejects(agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "structured auth failure" }],
    _meta: { outputSchema: { type: "object" } },
  })), (error) => {
    assert.equal((error as RequestError).code, -32000);
    return errorKind(error) === "auth_error";
  });
  assert.equal(setup.controls[0]?.activeToolsAtPrompt[0]?.includes(RETIRED_STRUCTURED_TOOL) ?? false, false);
  assert.equal(setup.controls[0]?.session.getActiveToolNames().includes(RETIRED_STRUCTURED_TOOL), false);
  await agent.dispose();
});

test("S3 cancellation never creates private structured state", async () => {
  const setup = fakeDeps("wedged");
  setup.deps.sleep = (_ms, signal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const cancellation = new AbortController();
  const pending = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "cancel structured" }],
    _meta: { outputSchema: { type: "object" } },
  }, undefined, cancellation.signal));
  await Promise.resolve();
  assert.equal(setup.controls[0]?.activeToolsAtPrompt[0]?.includes(RETIRED_STRUCTURED_TOOL) ?? false, false);
  cancellation.abort();
  setup.controls[0]?.resolvePrompt?.();
  assert.equal((await pending).stopReason, "cancelled");
  assert.equal(setup.controls[0]?.session.getActiveToolNames().includes(RETIRED_STRUCTURED_TOOL), false);
  await agent.dispose();
});

test("S3 notification failure never creates private structured state", async () => {
  const setup = fakeDeps();
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async () => { throw new Error("broken notification transport"); } },
  ));
  await assert.rejects(agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "notify structured" }],
    _meta: { outputSchema: { type: "object" } },
  })), (error) => errorKind(error) === "notification_error");
  assert.equal(setup.controls[0]?.activeToolsAtPrompt[0]?.includes(RETIRED_STRUCTURED_TOOL), false);
  assert.equal(setup.controls[0]?.session.getActiveToolNames().includes(RETIRED_STRUCTURED_TOOL), false);
  await agent.dispose();
});

test("S3 private metadata remains inert across a mixed session sequence", async () => {
  const setup = fakeDeps();
  const pair = streamPair();
  const updates: SessionUpdate[] = [];
  const clientApp = client({ name: "pi-acp-structured-sequence" })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }));
  const server = await runAcp({ deps: setup.deps, stream: pair.agent });
  const connection = clientApp.connect(pair.client);
  try {
    await connection.agent.request(methods.agent.initialize, { protocolVersion: 1 });
    const opened = await connection.agent.request(methods.agent.session.new, {
      cwd: setup.cwd,
      mcpServers: [],
    });
    await connection.agent.request(methods.agent.session.prompt, {
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "plain one" }],
    });
    await connection.agent.request(methods.agent.session.prompt, {
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "structured two" }],
      _meta: { outputSchema: { type: "object" } },
    });
    await connection.agent.request(methods.agent.session.prompt, {
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "plain three" }],
    });
    assert.deepEqual(setup.controls[0]?.activeToolsAtPrompt.map((names) => names.includes(RETIRED_STRUCTURED_TOOL)), [
      false,
      false,
      false,
    ]);
    assert.doesNotMatch(setup.controls[0]?.promptCalls[0]?.text ?? "", /__acp_structured_output/);
    assert.doesNotMatch(setup.controls[0]?.promptCalls[1]?.text ?? "", /__acp_structured_output/);
    assert.doesNotMatch(setup.controls[0]?.promptCalls[2]?.text ?? "", /__acp_structured_output/);
    const structuredChunks = updates.filter((update) =>
      update.sessionUpdate === "agent_message_chunk" && update.content.text.startsWith("{"));
    assert.deepEqual(structuredChunks.map((update) => update.sessionUpdate === "agent_message_chunk"
      ? update.content.text
      : undefined), []);
    assert.equal(setup.controls[0]?.session.getActiveToolNames().includes(RETIRED_STRUCTURED_TOOL), false);
  } finally {
    connection.close();
    server.connection.close();
    await server.agent.dispose();
  }
});

test("T20 non-timeout tools/call transport failure uses a fixed non-timeout label", async () => {
  const setup = fakeDeps();
  const server = { name: "server", command: "server", args: [], env: [] } as const;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() {
      return { tools: [{ name: "broken", inputSchema: { type: "object" } }] };
    },
    async callTool() {
      throw new Error("SECRET transport failure");
    },
  });
  const bridge = await bridgeMcpServers([server], new AbortController().signal, setup.deps);
  await assert.rejects(
    bridge.tools[0]?.execute("call", {}, new AbortController().signal),
    (error) => {
      assert.equal(String(error), "Error: MCP tool mcp__server__broken failed");
      assert.doesNotMatch(String(error), /timed out|SECRET/);
      return true;
    },
  );
  await bridge.clients[0]?.close();
});

interface ShutdownResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  marker: string;
}

async function waitForReady(markerPath: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(markerPath) && readFileSync(markerPath, "utf8").includes("ready\n")) return;
    await delay(5);
  }
  throw new Error("shutdown fixture did not become ready");
}

async function runShutdownFixture(
  mode: "close-resolve" | "close-reject" | "idle" | "slow-dispose" | "hung-dispose" | "startup-throw",
  signals: NodeJS.Signals[] = [],
): Promise<ShutdownResult> {
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-acp-shutdown-"));
  const markerPath = join(fixtureDir, "marker.log");
  const sourceIndex = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  const builtIndex = mode === "hung-dispose" ? sourceIndex.replace("66_000", "50") : sourceIndex;
  writeFileSync(join(fixtureDir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(fixtureDir, "index.js"), builtIndex);
  writeFileSync(join(fixtureDir, "server.js"), `
import { appendFileSync } from "node:fs";
const mode = process.env.PI_ACP_SHUTDOWN_MODE;
const marker = process.env.PI_ACP_SHUTDOWN_MARKER;
const never = new Promise(() => {});
export function runAcp() {
  appendFileSync(marker, "ready\\n");
  if (mode === "startup-throw") throw new Error("fixture startup failure");
  const closed = mode === "close-resolve"
    ? Promise.resolve()
    : mode === "close-reject"
      ? Promise.reject(new Error("fixture transport failure"))
      : never;
  return {
    connection: { closed },
    agent: {
      async dispose() {
        appendFileSync(marker, "dispose\\n");
        if (mode === "slow-dispose") await new Promise((resolve) => setTimeout(resolve, 250));
        if (mode === "hung-dispose") await never;
      },
    },
  };
}
`);
  const child = spawn(process.execPath, [join(fixtureDir, "index.js")], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PI_ACP_SHUTDOWN_MODE: mode,
      PI_ACP_SHUTDOWN_MARKER: markerPath,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitForReady(markerPath);
  if (signals.length > 0) {
    await delay(20);
    for (const signal of signals) child.kill(signal);
  }
  const result = await Promise.race([
    exited,
    delay(7_000).then(() => {
      child.kill("SIGKILL");
      throw new Error(`shutdown fixture ${mode} did not exit`);
    }),
  ]);
  return {
    ...result,
    stderr,
    marker: readFileSync(markerPath, "utf8"),
  };
}

test("T3 clean connection close exits 0 after one awaited disposal", async () => {
  const result = await runShutdownFixture("close-resolve");
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  assert.equal(result.marker.match(/^dispose$/gm)?.length, 1);
});

test("T3 rejected connection exits 1 after one awaited disposal", async () => {
  const result = await runShutdownFixture("close-reject");
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 1, signal: null });
  assert.equal(result.marker.match(/^dispose$/gm)?.length, 1);
});

test("T3 SIGINT/SIGTERM exit 0 and concurrent triggers still dispose once", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const result = await runShutdownFixture("idle", [signal]);
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, signal);
    assert.equal(result.marker.match(/^dispose$/gm)?.length, 1, signal);
  }
  const doubled = await runShutdownFixture("slow-dispose", ["SIGINT", "SIGTERM"]);
  assert.deepEqual({ code: doubled.code, signal: doubled.signal }, { code: 0, signal: null });
  assert.equal(doubled.marker.match(/^dispose$/gm)?.length, 1);
});

test("T3 runAcp startup throw exits 1 without entering disposal", async () => {
  const result = await runShutdownFixture("startup-throw");
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 1, signal: null });
  assert.equal(result.marker.match(/^dispose$/gm)?.length ?? 0, 0);
  assert.match(result.stderr, /startup error:.*fixture startup failure/s);
});

test("T3 teardown timeout is bounded and forces cleanup-failure exit", async () => {
  const result = await runShutdownFixture("hung-dispose", ["SIGTERM"]);
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 1, signal: null });
  assert.equal(result.marker.match(/^dispose$/gm)?.length, 1);
  assert.equal(result.stderr.trim(), "shutdown cleanup failed");
});
