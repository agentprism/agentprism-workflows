import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import { AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object(
  { city: Type.String({ minLength: 2 }), hot: Type.Boolean() },
  { additionalProperties: false },
);

// pi-acp's frozen advertisement: a single ambient `agent` method (the five provider API-key methods
// were `env_var`-typed and left when ACP schema 1.21.0 removed that variant).
const PI_AUTH_METHODS = [{ id: "pi-stored-credentials", name: "pi stored credentials" }] as const;

interface LogEntry {
  method: string;
  pid?: number;
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
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
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
      {
        id: "model",
        type: "select",
        category: "model",
        name: "Model",
        currentValue: "",
        options: [],
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

test("Pi auth descriptors preserve the single advertised method and add remediation naming the ambient provider keys", async () => {
  configure([{ text: "unused" }]);
  const descriptors = await harness.makeRunner().describeAuthMethods({ model: "pi" });
  assert.deepEqual(descriptors.map(({ id, type }) => [id, type]), [["pi-stored-credentials", "agent"]]);
  const [stored] = descriptors;
  assert.ok(stored?.description?.includes("retry or resume"), "pi-stored-credentials has remediation");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"]) {
    assert.ok(stored?.description?.includes(key), `remediation names ${key}`);
  }
});

test("Pi schema path injects HTTP MCP, embeds the common fallback, and sends no private metadata", async () => {
  const { cwd, readLog } = configure([{ text: '{"city":"Oslo","hot":false}' }]);
  const result = await harness.makeRunner().run("classify", { model: "pi", cwd, schema: SCHEMA });
  assert.deepEqual(result, { city: "Oslo", hot: false });

  const log = readLog();
  const opened = log.find((entry) => entry.method === "newSession");
  assert.equal(opened?.params?.mcpServers?.length, 1);
  assert.equal((opened?.params?.mcpServers?.[0] as { type?: string }).type, "http");
  const prompted = log.find((entry) => entry.method === "prompt");
  assert.equal(prompted?.params?._meta, undefined);
  const text = prompted?.params?.prompt?.map((block) => block.text ?? "").join("") ?? "";
  assert.match(text, /The required output schema \(JSON Schema\)/);
  assert.match(text, /single JSON object/);
});

test("Pi parallel schema runs overlap on distinct processes and return their own captures", async () => {
  const { cwd, readLog } = configure([
    {
      delayMs: 200,
      structuredToolCall: { label: "pi-capture", argumentsFromPromptJson: true },
    },
  ]);
  const runner = harness.makeRunner();
  const payloads = [
    { city: "Oslo", hot: false },
    { city: "Lima", hot: true },
    { city: "Kyiv", hot: false },
  ];

  const outputs = await Promise.all(payloads.map((payload, index) =>
    runner.run(`classify ${index}\nSTRUCTURED_OUTPUT_PAYLOAD:${JSON.stringify(payload)}`, {
      model: "pi",
      cwd,
      schema: SCHEMA,
    }),
  ));

  assert.deepEqual(outputs, payloads);
  const log = readLog();
  const promptPids = log.filter((entry) => entry.method === "prompt").map((entry) => entry.pid);
  assert.equal(new Set(promptPids).size, 3, "each Pi schema run uses a distinct process");
  const firstCapture = log.findIndex((entry) => entry.method === "structuredToolCall");
  const overlapping = new Set(
    log.slice(0, firstCapture).filter((entry) => entry.method === "prompt").map((entry) => entry.pid),
  );
  assert.ok(overlapping.size >= 2, "at least two Pi prompts were in flight before the first capture");
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
