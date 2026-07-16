import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "../src/agent.js";
import { AUTH_METHODS, authenticateMethod } from "../src/auth.js";
import { applyConfig, THINKING_LEVELS, thinkingLevelOption } from "../src/config.js";
import {
  adapterError,
  classifyTerminal,
  redactedDiagnostics,
  type ErrorKind,
} from "../src/errors.js";
import { allocateAlias, convertMcpResult } from "../src/mcp-bridge.js";
import { installPermissionWrapper } from "../src/permissions.js";
import { convertPromptContent } from "../src/prompt-content.js";
import { replayEntry } from "../src/replay.js";
import { stopReasonFor } from "../src/stop-reason.js";
import { StructuredOutputState } from "../src/structured-output.js";
import { contentItems, mapKind, toContent, translateEvent } from "../src/translate.js";
import { promptUsage, usageUpdate } from "../src/usage.js";
import { context, fakeDeps, fakeSession } from "./helpers/fakes.js";

function wire(error: RequestError) {
  return { code: error.code, message: error.message, data: error.data as Record<string, unknown> };
}

test("T1 bin reserves stdout and --version is exact", async () => {
  const result = spawnSync(process.execPath, ["dist/index.js", "--version"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "0.0.0\n");
  assert.equal(result.stderr, "");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(source.indexOf("console.log = console.error") < source.indexOf('import("./server.js")'));
  assert.doesNotMatch(source.split("console.log = console.error")[0] ?? "", /^import .*pi|^import .*agentclientprotocol/m);
});

test("T2/T2b library entry has only the intended runtime values and no side effects", async () => {
  const before = { log: console.log, info: console.info, warn: console.warn, debug: console.debug };
  const library = await import("../dist/lib.js");
  assert.equal(typeof library.runAcp, "function");
  assert.equal(typeof library.PiAcpAgent, "function");
  assert.equal(typeof library.resolveDeps, "function");
  assert.equal("PiAcpDeps" in library, false);
  assert.deepEqual(
    { log: console.log, info: console.info, warn: console.warn, debug: console.debug },
    before,
  );
});

test("T3 shutdown source is idempotent, awaited, bounded, and covers every exit trigger", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /shuttingDown \?\?=/);
  assert.match(source, /withTimeout\(agent\.dispose\(\), 5_000\)/);
  assert.match(source, /connection\.closed\.then\(\(\) => shutdown\(0\), \(\) => shutdown\(1\)\)/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /SIGINT/);
  assert.match(source, /startup error/);
});

test("T4 prompt content fold is total, ordered, and accepts image-only", () => {
  assert.deepEqual(convertPromptContent([
    { type: "text", text: "a" },
    { type: "image", data: "AA==", mimeType: "image/png" },
    { type: "resource_link", uri: "file:///x", title: "x" },
    { type: "resource", resource: { uri: "file:///r", text: "inside" } },
    { type: "resource", resource: { uri: "file:///b", blob: "AA==" } },
    { type: "audio", data: "AA==", mimeType: "audio/wav" },
  ]), {
    text: "a\n\n[x](file:///x)\n\ninside\n\n[embedded resource: file:///b]\n\n[unsupported audio content omitted]",
    images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
  });
  assert.equal(convertPromptContent([{ type: "image", data: "raw", mimeType: "image/png" }]).text, "");
  for (const prompt of [
    [],
    [{ type: "text", text: "" }],
    [{ type: "text", text: "" }, { type: "text", text: "" }],
    [{ type: "text", text: " \t" }, { type: "text", text: "\n" }],
    [{ type: "resource", resource: { uri: "file:///empty", text: "" } }],
    [
      { type: "resource", resource: { uri: "file:///empty-1", text: "" } },
      { type: "resource", resource: { uri: "file:///empty-2", text: "" } },
    ],
  ] as const) {
    assert.throws(
      () => convertPromptContent(prompt),
      (error) => wire(error as RequestError).data.errorKind === "empty_prompt",
    );
  }
});

test("T5 live translation and result projection cover the pinned rows", () => {
  const delta = translateEvent({
    type: "message_update",
    message: {} as never,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: {} as never },
  });
  assert.equal(delta[0]?.sessionUpdate, "agent_thought_chunk");
  const start = translateEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "/x" } });
  assert.deepEqual(start[0], {
    sessionUpdate: "tool_call", toolCallId: "1", title: "read", kind: "read", status: "pending",
    rawInput: { path: "/x" }, locations: [{ path: "/x" }], _meta: { toolName: "read" },
  });
  assert.deepEqual(contentItems({ content: [{ type: "text", text: "x" }, { type: "image", data: "y", mimeType: "image/png" }] }), [
    { type: "text", text: "x" }, { type: "image", data: "y", mimeType: "image/png" },
  ]);
  assert.deepEqual(toContent({ content: [] }), []);
  assert.equal(mapKind("bash"), "execute");
  assert.equal(mapKind("custom"), "other");
  for (const marker of ["agent_start", "agent_end", "turn_start", "message_start", "agent_settled"] as const) {
    assert.deepEqual(translateEvent({ type: marker } as never), []);
  }
  for (const marker of ["done", "error"] as const) {
    assert.deepEqual(translateEvent({ type: "message_update", message: {} as never, assistantMessageEvent: { type: marker } } as never), []);
  }
});

test("T6 usage maps per-turn tokens separately from context and cumulative cost", () => {
  const messages = [
    { role: "assistant", stopReason: "stop", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, reasoning: 1 } },
    { role: "assistant", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
  ];
  assert.deepEqual(promptUsage(messages), {
    inputTokens: 3, outputTokens: 4, cachedReadTokens: 4, cachedWriteTokens: 5, totalTokens: 16, thoughtTokens: 1,
  });
  const fake = fakeSession({});
  assert.deepEqual(usageUpdate(fake.session), {
    sessionUpdate: "usage_update", used: 6, size: 100, cost: { amount: 0.001, currency: "USD" },
  });
});

test("T7 stop taxonomy rejects errors and maps every successful terminal reason", () => {
  const terminal = (stopReason: string) => ({ role: "assistant" as const, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason });
  assert.equal(stopReasonFor(terminal("stop"), false), "end_turn");
  assert.equal(stopReasonFor(terminal("length"), false), "max_tokens");
  assert.equal(stopReasonFor(terminal("toolUse"), false), "end_turn");
  assert.equal(stopReasonFor(terminal("aborted"), false), "cancelled");
  assert.throws(() => stopReasonFor(terminal("error"), false), RequestError);
});

test("T8 all 26 error rows retain reserved codes, fixed labels, precedence, and redaction", () => {
  const invalid: ErrorKind[] = [
    "invalid_model", "empty_prompt", "session_busy", "invalid_config_value", "invalid_config_type",
    "unknown_config_option", "invalid_cwd", "unknown_session", "session_already_open", "session_terminated",
    "session_not_forkable", "unsupported_mcp_transport", "invalid_output_schema", "invalid_cursor", "unknown_auth_method",
  ];
  const internal: ErrorKind[] = [
    "rate_limit", "billing_error", "provider_error", "session_corrupt", "mcp_init_error",
    "structured_tool_collision", "notification_error", "internal_error",
  ];
  assert.equal(adapterError("auth_error").code, -32000);
  for (const kind of invalid) assert.equal(adapterError(kind).code, -32602, kind);
  for (const kind of internal) assert.equal(adapterError(kind).code, -32603, kind);
  const server = wire(adapterError("mcp_init_error", { server: "s" }));
  assert.deepEqual(server.data, { errorKind: "mcp_init_error", message: "mcp server initialization failed", server: "s" });
  const diagnostics = [{ type: "provider", timestamp: 7, error: { message: "SECRET", stack: "SECRET stack" }, details: { SECRET: true } }];
  assert.deepEqual(redactedDiagnostics(diagnostics), [{ type: "provider", timestamp: 7 }]);
  const classified = wire(classifyTerminal({ stopReason: "error", errorMessage: "429 quota unauthorized", diagnostics }));
  assert.equal(classified.code, -32000);
  assert.equal(JSON.stringify(classified).includes("SECRET"), false);
  assert.equal(RequestError.methodNotFound().code, -32601);
  assert.equal(RequestError.requestCancelled().code, -32800);
  assert.equal(RequestError.invalidParams().code, -32602);
});

test("T9 thinking/model config is exact, auth-aware, and clamp-reflecting", async () => {
  const fake = fakeSession({});
  const model = { provider: "test", id: "model" };
  const registry = { find: () => model, hasConfiguredAuth: () => true } as never;
  assert.deepEqual((thinkingLevelOption(fake.session).options as Array<{ value: string }>).map(({ value }) => value), THINKING_LEVELS);
  assert.equal((await applyConfig(fake.session, registry, "thinkingLevel", "high"))[0]?.currentValue, "high");
  await assert.rejects(applyConfig(fake.session, registry, "thinkingLevel", "bogus"), (error) => wire(error as RequestError).data.errorKind === "invalid_config_value");
  await assert.rejects(applyConfig(fake.session, registry, "model", true), (error) => wire(error as RequestError).data.errorKind === "invalid_config_type");
  await assert.rejects(applyConfig(fake.session, { find: () => undefined } as never, "model", "x/y"), (error) => wire(error as RequestError).data.errorKind === "invalid_model");
  await assert.rejects(applyConfig(fake.session, { find: () => model, hasConfiguredAuth: () => false } as never, "model", "x/y"), (error) => (error as RequestError).code === -32000);
});

test("T10 initialize advertises only the exact implemented capabilities", () => {
  const setup = fakeDeps();
  const initialized = new PiAcpAgent(setup.deps).initialize(context({ protocolVersion: 1 }));
  assert.deepEqual(initialized.agentCapabilities, {
    loadSession: true,
    promptCapabilities: { image: true },
    mcpCapabilities: {},
    sessionCapabilities: { resume: {}, fork: {}, list: {}, close: {} },
    _meta: { "@automatalabs/pi-acp": { outputSchema: true } },
  });
  assert.equal("additionalDirectories" in initialized.agentCapabilities, false);
});

test("T11 permission wrapper drains first, delegates fresh/cached allows, and denies malformed selections", async () => {
  const fake = fakeSession({});
  const order: string[] = [];
  fake.session.agent.beforeToolCall = async () => { order.push("inner"); return undefined; };
  let requests = 0;
  installPermissionWrapper(fake.session, {
    sessionId: "s",
    client: { request: async () => { requests += 1; order.push("request"); return { outcome: { outcome: "selected", optionId: "allow_always" } }; } } as never,
    async drain() { order.push("drain"); },
    turnSignal: () => new AbortController().signal,
  });
  const call = { toolCall: { name: "read", id: "1" } } as never;
  await fake.session.agent.beforeToolCall?.(call, new AbortController().signal);
  await fake.session.agent.beforeToolCall?.(call, new AbortController().signal);
  assert.deepEqual(order, ["drain", "request", "inner", "inner"]);
  assert.equal(requests, 1);
  const denied = fakeSession({});
  installPermissionWrapper(denied.session, {
    sessionId: "s",
    client: { request: async () => ({ outcome: { outcome: "selected", optionId: "hostile" } }) } as never,
    async drain() {},
    turnSignal: () => new AbortController().signal,
  });
  assert.deepEqual(await denied.session.agent.beforeToolCall?.(call, new AbortController().signal), {
    block: true, reason: "unrecognized permission selection",
  });
});

test("T12 structured output arms, captures last value, disarms, validates, and detects absence", async () => {
  const structured = new StructuredOutputState();
  const fake = fakeSession({ customTools: [structured.tool] });
  structured.install(fake.session);
  assert.match(structured.arm(fake.session, { type: "object" }), /__acp_structured_output/);
  await structured.tool.execute("1", { answer: 1 }, undefined, undefined, {} as never);
  await structured.tool.execute("2", { answer: 2 }, undefined, undefined, {} as never);
  assert.equal(structured.takeJson(), '{"answer":2}');
  structured.disarm(fake.session);
  assert.throws(() => structured.arm(fake.session, null), (error) => wire(error as RequestError).data.errorKind === "invalid_output_schema");
  assert.throws(() => new StructuredOutputState().install(fakeSession({}).session), (error) => wire(error as RequestError).data.errorKind === "structured_tool_collision");
});

test("T13 auth methods are unconditional and exact; authenticate is ambient/no-op", () => {
  assert.deepEqual(AUTH_METHODS.map(({ id, name }) => ({ id, name })), [
    { id: "anthropic-api-key", name: "Anthropic API key" },
    { id: "openai-api-key", name: "OpenAI API key" },
    { id: "gemini-api-key", name: "Google Gemini API key" },
    { id: "xai-api-key", name: "xAI API key" },
    { id: "openrouter-api-key", name: "OpenRouter API key" },
    { id: "pi-stored-credentials", name: "pi stored credentials" },
  ]);
  assert.deepEqual(authenticateMethod("pi-stored-credentials"), {});
  assert.throws(() => authenticateMethod("missing"), (error) => wire(error as RequestError).data.errorKind === "unknown_auth_method");
});

test("T16 replay projection is total across transcript and bookkeeping entries", () => {
  assert.equal(replayEntry({ type: "message", message: { role: "user", content: "hello" } } as never)[0]?.sessionUpdate, "user_message_chunk");
  assert.deepEqual(replayEntry({ type: "custom_message", content: "hidden", display: false } as never), []);
  for (const type of ["thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "label", "session_info"] as const) {
    assert.deepEqual(replayEntry({ type } as never), []);
  }
});

test("T20 MCP result union and deterministic bounded aliases are total", () => {
  const result = convertMcpResult({ content: [
    { type: "text", text: "t" },
    { type: "image", data: "i", mimeType: "image/png" },
    { type: "audio", data: "a", mimeType: "audio/wav" },
    { type: "resource_link", uri: "u", name: "n" },
    { type: "resource", resource: { uri: "r", text: "body" } },
    { type: "resource", resource: { uri: "b", blob: "AA==" } },
  ], structuredContent: { x: 1 } });
  assert.deepEqual(result.details, { x: 1 });
  assert.equal(result.content.length, 6);
  const used = new Set<string>();
  const first = allocateAlias("server", "x".repeat(200), used);
  const second = allocateAlias("server", "x".repeat(200), used);
  assert.equal(first.length, 128);
  assert.equal(second.length, 128);
  assert.match(second, /_2$/);
});
