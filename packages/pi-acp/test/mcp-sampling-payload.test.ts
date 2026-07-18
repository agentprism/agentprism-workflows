import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { mapMcpSamplingResult } from "../src/mcp-bridge.js";
import { createMcpSamplingPayload } from "../src/mcp-sampling-payload.js";

const APIS = [
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "pi-messages",
] as const;

type KnownApi = (typeof APIS)[number];
type Role = "user" | "assistant";
type Kind = "image" | "audio";

function model(api: KnownApi) {
  return {
    id: "fixture-model",
    name: "Fixture",
    api,
    provider: "fixture-provider",
    baseUrl: "https://fixture.invalid",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  } as never;
}

function oneMedia(api: KnownApi, role: Role, kind: Kind, mimeType: string, data: string) {
  return createMcpSamplingPayload({
    messages: [{ role, content: { type: kind, mimeType, data } }],
    maxTokens: 32,
  } as never, model(api));
}

function markerFrom(prepared: ReturnType<typeof oneMedia>): string {
  const message = prepared.context.messages[0];
  assert.ok(message && Array.isArray(message.content));
  const block = message.content[0];
  assert.equal(block?.type, "text");
  return (block as { text: string }).text;
}

function providerPayload(api: KnownApi, role: Role, marker: string): Record<string, unknown> {
  if (api === "google-generative-ai" || api === "google-vertex") {
    return { contents: [{ role: role === "assistant" ? "model" : "user", parts: [{ text: marker }] }] };
  }
  if (api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") {
    return { input: [{ role, content: [{ type: "input_text", text: marker }] }] };
  }
  if (api === "pi-messages") {
    return { context: { messages: [{ role, content: [{ type: "text", text: marker }] }] } };
  }
  if (api === "bedrock-converse-stream") {
    return { messages: [{ role, content: [{ text: marker }] }] };
  }
  return { messages: [{ role, content: [{ type: "text", text: marker }] }] };
}

function supported(api: KnownApi, role: Role, kind: Kind): boolean {
  if (api === "google-generative-ai" || api === "google-vertex") return true;
  if (api === "anthropic-messages") return kind === "image";
  if (kind !== "image" || role !== "user") return false;
  return api === "openai-completions" ||
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    api === "openai-codex-responses" ||
    api === "mistral-conversations" ||
    api === "pi-messages";
}

function expectedNative(api: KnownApi, kind: Kind, mimeType: string, data: string): unknown {
  if (api === "google-generative-ai" || api === "google-vertex") {
    return { inlineData: { mimeType, data } };
  }
  if (api === "anthropic-messages") {
    return { type: "image", source: { type: "base64", media_type: mimeType, data } };
  }
  if (api === "openai-completions") {
    return { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } };
  }
  if (api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") {
    return { type: "input_image", image_url: `data:${mimeType};base64,${data}`, detail: "auto" };
  }
  if (api === "mistral-conversations") {
    return { type: "image_url", imageUrl: `data:${mimeType};base64,${data}` };
  }
  if (api === "pi-messages") return { type: kind, data, mimeType };
  assert.fail(`no native fixture for ${api}`);
}

function outboundPart(api: KnownApi, payload: Record<string, unknown>): unknown {
  if (api === "google-generative-ai" || api === "google-vertex") {
    return ((payload.contents as Array<{ parts: unknown[] }>)[0]?.parts)[0];
  }
  if (api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") {
    return ((payload.input as Array<{ content: unknown[] }>)[0]?.content)[0];
  }
  if (api === "pi-messages") {
    const context = payload.context as { messages: Array<{ content: unknown[] }> };
    return context.messages[0]?.content[0];
  }
  return ((payload.messages as Array<{ content: unknown[] }>)[0]?.content)[0];
}

for (const api of APIS) {
  for (const role of ["user", "assistant"] as const) {
    for (const kind of ["image", "audio"] as const) {
      test(`sampling payload ${api} preserves or rejects ${role} ${kind}`, () => {
        const mimeType = kind === "image" ? "image/png" : "audio/wav";
        const data = kind === "image" ? "iVBORw0KGgo=" : "UklGRg==";
        const prepared = oneMedia(api, role, kind, mimeType, data);
        const marker = markerFrom(prepared);
        const payload = providerPayload(api, role, marker);
        if (!supported(api, role, kind)) {
          assert.throws(
            () => prepared.onPayload(payload),
            (error) => error instanceof McpError &&
              error.code === ErrorCode.InternalError &&
              error.message === "Active pi model cannot represent MCP sampling media",
          );
          return;
        }
        const rewritten = prepared.onPayload(payload) as Record<string, unknown>;
        assert.deepEqual(outboundPart(api, rewritten), expectedNative(api, kind, mimeType, data));
        assert.equal(JSON.stringify(rewritten).includes(marker), false);
      });
    }
  }
}

test("sampling payload preserves mixed block and message order for Google", () => {
  const prepared = createMcpSamplingPayload({
    systemPrompt: "system\u0000bytes",
    messages: [
      {
        role: "user",
        _meta: { ignored: true },
        content: [
          { type: "text", text: "before", annotations: { audience: ["user"] }, _meta: { ignored: true } },
          { type: "image", mimeType: "image/webp", data: "V0VCUA==", _meta: { ignored: true } },
          { type: "text", text: "after" },
        ],
      },
      { role: "assistant", content: { type: "audio", mimeType: "audio/flac", data: "ZkxhQw==" } },
    ],
    maxTokens: 64,
  } as never, model("google-generative-ai"));
  assert.equal(prepared.context.systemPrompt, "system\u0000bytes");
  assert.equal("_meta" in prepared.context.messages[0]!, false);
  const first = prepared.context.messages[0]!.content as Array<{ type: string; text: string }>;
  const second = prepared.context.messages[1]!.content as Array<{ type: string; text: string }>;
  const payload = {
    contents: [
      { role: "user", parts: first.map(({ text }) => ({ text })) },
      { role: "model", parts: second.map(({ text }) => ({ text })) },
    ],
  };
  const rewritten = prepared.onPayload(payload) as typeof payload;
  assert.deepEqual(rewritten.contents, [
    { role: "user", parts: [
      { text: "before" },
      { inlineData: { mimeType: "image/webp", data: "V0VCUA==" } },
      { text: "after" },
    ] },
    { role: "model", parts: [{ inlineData: { mimeType: "audio/flac", data: "ZkxhQw==" } }] },
  ]);
  assert.doesNotMatch(JSON.stringify(rewritten), /PI_ACP_MCP_MEDIA/);
});

test("sampling context preserves absent and empty system prompts and exact assistant fields", () => {
  const absent = createMcpSamplingPayload({
    messages: [{ role: "assistant", content: { type: "text", text: "prior" } }],
    maxTokens: 1,
  } as never, model("google-vertex"));
  assert.equal(Object.hasOwn(absent.context, "systemPrompt"), false);
  assert.deepEqual(absent.context.messages[0], {
    role: "assistant",
    content: [{ type: "text", text: "prior" }],
    api: "google-vertex",
    provider: "fixture-provider",
    model: "fixture-model",
    stopReason: "stop",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  });
  const empty = createMcpSamplingPayload({
    systemPrompt: "",
    messages: [{ role: "user", content: { type: "text", text: "now" } }],
    maxTokens: 1,
  } as never, model("google-vertex"));
  assert.equal(Object.hasOwn(empty.context, "systemPrompt"), true);
  assert.equal(empty.context.systemPrompt, "");
});

test("sampling payload rejects wrong shape, moved markers, duplicates, echoes, and restricted Anthropic MIME", () => {
  const prepared = oneMedia("openai-completions", "user", "image", "image/png", "AA==");
  const marker = markerFrom(prepared);
  for (const payload of [
    { messages: [{ role: "user", content: marker }] },
    { messages: [{ role: "assistant", content: [{ type: "text", text: marker }] }] },
    { messages: [{ role: "user", content: [{ type: "text", text: marker }, { type: "text", text: marker }] }] },
    { messages: [{ role: "user", content: [{ type: "text", text: marker }], echo: marker }] },
    { messages: [{ role: "user", content: [{ type: "other", text: marker }] }] },
  ]) {
    assert.throws(() => prepared.onPayload(payload), /Active pi model cannot represent MCP sampling media/);
  }
  const anthropic = oneMedia("anthropic-messages", "user", "image", "image/svg+xml", "PHN2Zz4=");
  assert.throws(
    () => anthropic.onPayload(providerPayload("anthropic-messages", "user", markerFrom(anthropic))),
    /Active pi model cannot represent MCP sampling media/,
  );
});

function assistant(stopReason: string, content: unknown[], responseModel?: string) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "provider",
    model: "requested",
    responseModel,
    content,
    stopReason,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  } as never;
}

test("sampling response mapper covers ordered text, thinking, stops, model identity, and terminal errors", () => {
  assert.deepEqual(mapMcpSamplingResult(assistant("stop", [
    { type: "text", text: "alpha" },
    { type: "thinking", thinking: "secret" },
    { type: "text", text: "beta STOP tail" },
  ], "actual"), ["later", "STOP"]), {
    role: "assistant",
    model: "provider/actual",
    content: { type: "text", text: "alphabeta " },
    stopReason: "stopSequence",
  });
  assert.equal(mapMcpSamplingResult(assistant("length", [{ type: "text", text: "x" }])).stopReason, "maxTokens");
  assert.equal(mapMcpSamplingResult(assistant("stop", [{ type: "thinking", thinking: "hidden" }])).content.text, "");
  assert.throws(() => mapMcpSamplingResult(assistant("error", [])), /MCP sampling failed/);
  assert.throws(() => mapMcpSamplingResult(assistant("aborted", [])), /MCP sampling cancelled/);
  assert.throws(
    () => mapMcpSamplingResult(assistant("toolUse", [{ type: "toolCall", id: "1", name: "x", arguments: {} }])),
    /MCP sampling returned unsupported tool output/,
  );
});
