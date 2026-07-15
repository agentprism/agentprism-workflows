import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type SessionModeState } from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import { isWorkflowError, WorkflowErrorCode, type AgentUsage, type McpServerConfig } from "@automatalabs/shared-types";
import { AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object(
  {
    city: Type.String({ minLength: 2 }),
    hot: Type.Boolean(),
  },
  { additionalProperties: false },
);

const MODES: SessionModeState = {
  currentModeId: "build",
  availableModes: [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ],
};

const OPENCODE_CONFIG_OPTIONS = [
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "zai/default",
    options: [
      { value: "zai/default", name: "Default" },
      { value: "zai/glm-5.2", name: "GLM 5.2" },
      { value: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2" },
    ],
  },
  {
    id: "effort",
    type: "select",
    name: "Effort",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "mode",
    type: "select",
    name: "Mode",
    category: "mode",
    currentValue: "build",
    options: [
      { value: "build", name: "Build" },
      { value: "plan", name: "Plan" },
    ],
  },
];

interface LogEntry {
  method: string;
  label?: string;
  params?: {
    configId?: string;
    value?: string | boolean;
    modeId?: string;
    mcpServers?: McpServerConfig[];
    _meta?: Record<string, unknown>;
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-opencode-it-", backends: ["opencode"] });
const configure = (extra: Record<string, unknown> = {}) =>
  harness.configure<LogEntry>({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
      },
      authMethods: [{ id: "opencode-login", name: "OpenCode Login" }],
    },
    configOptions: OPENCODE_CONFIG_OPTIONS,
    ...extra,
  });

function makeRunner(): AcpAgentRunner {
  return harness.makeRunner();
}

function configCalls(log: LogEntry[], configId: string): LogEntry[] {
  return log.filter((entry) => entry.method === "setSessionConfigOption" && entry.params?.configId === configId);
}

afterEach(async () => {
  await harness.cleanup();
});

test("OpenCode model spec strips the routing prefix and selects provider/model through config options", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });

  assert.equal(await makeRunner().run("hi", { model: "opencode/zai/glm-5.2", cwd }), "ok");

  const modelSet = configCalls(readLog(), "model")[0];
  assert.equal(modelSet?.params?.value, "zai/glm-5.2");
});

test("bare opencode routes to OpenCode without selecting an inner model", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });

  assert.equal(await makeRunner().run("hi", { model: "opencode", cwd }), "ok");

  assert.equal(configCalls(readLog(), "model").length, 0);
});

test("OpenCode sends a bracketed inner model verbatim without touching effort", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });

  assert.equal(await makeRunner().run("hi", { model: "opencode/zai/glm-5.2[high]", cwd }), "ok");

  assert.equal(configCalls(readLog(), "model")[0]?.params?.value, "zai/glm-5.2[high]");
  assert.equal(configCalls(readLog(), "effort").length, 0);
});

test("OpenCode catalog order cannot alter a bracketed provider-prefixed value", async () => {
  const { cwd, readLog } = configure({
    turns: [{ text: "ok" }],
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "opencode/big-pickle",
        options: [
          // Cross-provider lookalikes intentionally precede the authored provider.
          { value: "huggingface/zai-org/GLM-5.2", name: "Hugging Face/GLM-5.2" },
          { value: "openrouter/z-ai/glm-5.2", name: "OpenRouter/GLM-5.2" },
          { value: "opencode/big-pickle", name: "Big Pickle" },
          { value: "zai/glm-5.2", name: "Z.AI/GLM-5.2" },
        ],
      },
      OPENCODE_CONFIG_OPTIONS[1],
      OPENCODE_CONFIG_OPTIONS[2],
    ],
  });

  assert.equal(await makeRunner().run("hi", { model: "opencode/zai/glm-5.2[high]", cwd }), "ok");

  assert.equal(configCalls(readLog(), "model")[0]?.params?.value, "zai/glm-5.2[high]");
  assert.equal(configCalls(readLog(), "effort").length, 0);
});

test("OpenCode config-option mode catalog applies mode via session/set_config_option", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "planned" }] });

  assert.equal(await makeRunner().run("hi", { model: "opencode", cwd, mode: "plan" }), "planned");

  assert.equal(configCalls(readLog(), "mode")[0]?.params?.value, "plan");
  assert.equal(readLog().some((entry) => entry.method === "setSessionMode"), false);
});

test("OpenCode unknown config-option mode fails before prompting", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "opencode", cwd, mode: "yolo" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /opencode/);
      assert.match(error.message, /yolo/);
      assert.match(error.message, /build, plan/);
      return true;
    },
  );
  assert.equal(readLog().some((entry) => entry.method === "prompt"), false);
});

test("when response.modes is present, mode still uses session/set_mode over config options", async () => {
  const { cwd, readLog } = configure({ modes: MODES, turns: [{ text: "planned" }] });

  assert.equal(await makeRunner().run("hi", { model: "opencode", cwd, mode: "plan" }), "planned");

  assert.equal(readLog().find((entry) => entry.method === "setSessionMode")?.params?.modeId, "plan");
  assert.equal(configCalls(readLog(), "mode").length, 0);
});

test("OpenCode schema run injects StructuredOutput MCP and resolves captured tool args", async () => {
  const { cwd, readLog } = configure({
    turns: [
      {
        structuredToolCall: { label: "valid", arguments: { city: "Oslo", hot: false } },
        text: "plain text ignored",
      },
    ],
  });

  const out = await makeRunner().run("classify", {
    model: "opencode/zai/glm-5.2",
    cwd,
    schema: SCHEMA,
  });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  const servers = readLog().find((entry) => entry.method === "newSession")?.params?.mcpServers ?? [];
  const injected = servers.find((server) => server.name?.startsWith("structured_output"));
  assert.ok(injected && "type" in injected && injected.type === "http");
  assert.match(injected.url, /^http:\/\/127\.0\.0\.1:\d+\//);
});

test("OpenCode usage combines PromptResponse tokens with latest cumulative usage_update cost", async () => {
  const { cwd } = configure({
    turns: [
      {
        text: "ok",
        usageUpdate: { used: 80, size: 200000, cost: { amount: 0.12, currency: "USD" } },
        usage: {
          totalTokens: 80,
          inputTokens: 50,
          outputTokens: 30,
          cachedReadTokens: 7,
          cachedWriteTokens: 2,
        },
      },
    ],
  });
  const seen: AgentUsage[] = [];

  await makeRunner().run("hi", { model: "opencode", cwd, onUsage: (usage) => seen.push(usage) });

  assert.deepEqual(seen, [{ input: 50, output: 30, cacheRead: 7, cacheWrite: 2, total: 80, cost: 0.12 }]);
});

test("Claude and Codex routing prefixes are stripped before verbatim model selection", async () => {
  const claude = harness.configure<LogEntry>(
    {
      configOptions: [
        {
          id: "model",
          type: "select",
          name: "Model",
          category: "model",
          currentValue: "default",
          options: [{ value: "claude/claude-opus-4-1", name: "Claude Opus" }],
        },
      ],
      turns: [{ text: "ok" }],
    },
    { backends: ["claude"] },
  );
  assert.equal(await makeRunner().run("hi", { model: "claude/claude-opus-4-1", cwd: claude.cwd }), "ok");
  assert.equal(configCalls(claude.readLog(), "model")[0]?.params?.value, "claude-opus-4-1");

  await harness.cleanup();

  const codex = harness.configure<LogEntry>(
    {
      configOptions: [
        {
          id: "model",
          type: "select",
          name: "Model",
          category: "model",
          currentValue: "default",
          options: [{ value: "codex/gpt-5.6-luna", name: "GPT-5.6 Luna" }],
        },
      ],
      turns: [{ text: "ok" }],
    },
    { backends: ["codex"] },
  );
  assert.equal(await makeRunner().run("hi", { model: "codex/gpt-5.6-luna", cwd: codex.cwd }), "ok");
  assert.equal(configCalls(codex.readLog(), "model")[0]?.params?.value, "gpt-5.6-luna");
});
