import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import { AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object(
  { city: Type.String({ minLength: 2 }), hot: Type.Boolean() },
  { additionalProperties: false },
);

const PI_AUTH_METHODS = [
  { id: "anthropic-api-key", name: "Anthropic API key", type: "env_var", vars: [{ name: "ANTHROPIC_API_KEY", secret: true }] },
  { id: "openai-api-key", name: "OpenAI API key", type: "env_var", vars: [{ name: "OPENAI_API_KEY", secret: true }] },
  { id: "gemini-api-key", name: "Google Gemini API key", type: "env_var", vars: [{ name: "GEMINI_API_KEY", secret: true }] },
  { id: "xai-api-key", name: "xAI API key", type: "env_var", vars: [{ name: "XAI_API_KEY", secret: true }] },
  { id: "openrouter-api-key", name: "OpenRouter API key", type: "env_var", vars: [{ name: "OPENROUTER_API_KEY", secret: true }] },
  { id: "pi-stored-credentials", name: "pi stored credentials" },
] as const;

interface LogEntry {
  method: string;
  params?: {
    configId?: string;
    value?: string | boolean;
    prompt?: Array<{ type: string; text?: string }>;
    mcpServers?: unknown[];
    _meta?: Record<string, unknown>;
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-pi-it-", backends: ["pi"] });

function configure(turns: unknown[]) {
  return harness.configure<LogEntry>({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "@automatalabs/pi-acp", version: "0.1.1" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        mcpCapabilities: {},
        sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
        _meta: { "@automatalabs/pi-acp": { outputSchema: true } },
      },
      authMethods: PI_AUTH_METHODS,
    },
    configOptions: [
      {
        id: "thinkingLevel",
        type: "select",
        name: "Thinking level",
        currentValue: "medium",
        options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, name: value })),
      },
    ],
    turns,
  });
}

function configCalls(log: LogEntry[], configId: string): LogEntry[] {
  return log.filter((entry) => entry.method === "setSessionConfigOption" && entry.params?.configId === configId);
}

afterEach(async () => {
  await harness.cleanup();
});

test("pi/<provider>/<model-id> strips one routing segment and sends the remainder verbatim", async () => {
  const { cwd, readLog } = configure([{ text: "ok" }]);
  const runner = harness.makeRunner();
  assert.equal(await runner.run("hi", { model: "pi/openrouter/vendor/model/v1", cwd }), "ok");
  assert.equal(configCalls(readLog(), "model")[0]?.params?.value, "openrouter/vendor/model/v1");
});

test("bare pi routes to Pi without selecting an inner model", async () => {
  const { cwd, readLog } = configure([{ text: "ok" }]);
  assert.equal(await harness.makeRunner().run("hi", { model: "pi", cwd }), "ok");
  assert.equal(configCalls(readLog(), "model").length, 0);
});

test("Pi auth descriptors preserve all six advertised methods and add per-method remediation", async () => {
  configure([{ text: "unused" }]);
  const descriptors = await harness.makeRunner().describeAuthMethods({ model: "pi" });
  assert.deepEqual(descriptors.map(({ id, type }) => [id, type]), [
    ["anthropic-api-key", "env_var"],
    ["openai-api-key", "env_var"],
    ["gemini-api-key", "env_var"],
    ["xai-api-key", "env_var"],
    ["openrouter-api-key", "env_var"],
    ["pi-stored-credentials", "agent"],
  ]);
  for (const descriptor of descriptors) {
    assert.ok(descriptor.description?.includes("retry or resume"), `${descriptor.id} has remediation`);
  }
  const envDescriptors = descriptors.filter((descriptor) => descriptor.type === "env_var");
  assert.deepEqual(envDescriptors.map((descriptor) => descriptor.vars[0]?.name), [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
});

test("Pi native schema path sends outputSchema, injects no MCP tool, and parses the final chunk", async () => {
  const { cwd, readLog } = configure([{ text: '{"city":"Oslo","hot":false}' }]);
  const result = await harness.makeRunner().run("classify", { model: "pi", cwd, schema: SCHEMA });
  assert.deepEqual(result, { city: "Oslo", hot: false });

  const log = readLog();
  const opened = log.find((entry) => entry.method === "newSession");
  assert.deepEqual(opened?.params?.mcpServers, []);
  const prompted = log.find((entry) => entry.method === "prompt");
  assert.ok(prompted?.params?._meta?.[META_KEYS.outputSchema]);
  const text = prompted?.params?.prompt?.map((block) => block.text ?? "").join("") ?? "";
  assert.doesNotMatch(text, /The required output schema \(JSON Schema\)/);
  assert.match(text, /single JSON object/);
});

test("Pi categorical provider errors map through the built-in backend", async () => {
  for (const errorKind of ["rate_limit", "billing_error"] as const) {
    const { cwd } = configure([{
      throw: "Internal error",
      throwCode: -32603,
      throwData: { errorKind, message: errorKind === "rate_limit" ? "provider rate limit" : "provider billing or quota wall" },
    }]);
    await assert.rejects(
      () => harness.makeRunner().run("hi", { model: "pi", cwd }),
      (error: unknown) => (error as { code?: string }).code === "PROVIDER_USAGE_LIMIT",
    );
    await harness.cleanup();
  }
});
