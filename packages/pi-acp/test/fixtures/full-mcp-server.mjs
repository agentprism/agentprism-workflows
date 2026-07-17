#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export function createConformanceServer() {
  let revision = 0;
  const server = new Server(
    { name: "pi-acp-full-mcp-fixture", version: "1.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
        completions: {},
      },
      instructions: "fixture instructions",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
    if (params?.cursor === "tool-page-2") {
      return {
        tools: [
          { name: "noop", description: "secondary page", inputSchema: { type: "object", additionalProperties: false } },
          ...(revision > 0
            ? [{ name: "dynamic", description: "dynamic tool", inputSchema: { type: "object", additionalProperties: false } }]
            : []),
        ],
      };
    }
    return {
      tools: [
        { name: "exercise", description: "exercise client features", inputSchema: { type: "object", additionalProperties: false } },
        { name: "hang", description: "wait for cancellation", inputSchema: { type: "object", additionalProperties: false } },
        { name: "trigger_dynamic", description: "trigger list change", inputSchema: { type: "object", additionalProperties: false } },
      ],
      nextCursor: "tool-page-2",
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    if (params.name === "trigger_dynamic") {
      revision = 1;
      await server.sendToolListChanged();
      return { content: [{ type: "text", text: "changed" }] };
    }
    if (params.name === "hang") {
      await new Promise((resolve, reject) => {
        if (extra.signal.aborted) return reject(extra.signal.reason);
        extra.signal.addEventListener("abort", () => reject(extra.signal.reason), { once: true });
      });
    }
    if (params.name !== "exercise") return { content: [{ type: "text", text: params.name }] };
    const progressToken = extra._meta?.progressToken;
    if (progressToken !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: 1, total: 2, message: "half" },
      });
    }
    const incomingProgress = { sampling: [], roots: [], form: [], url: [] };
    const sampling = await server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: "sample me" } }],
      maxTokens: 32,
      systemPrompt: "fixture system",
    }, { onprogress: (value) => incomingProgress.sampling.push(value) });
    const roots = await server.listRoots(undefined, { onprogress: (value) => incomingProgress.roots.push(value) });
    const form = await server.elicitInput({
      mode: "form",
      message: "form",
      requestedSchema: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    }, { onprogress: (value) => incomingProgress.form.push(value) });
    const url = await server.elicitInput({
      mode: "url",
      message: "url",
      elicitationId: "fixture-url",
      url: "https://example.invalid/complete",
    }, { onprogress: (value) => incomingProgress.url.push(value) });
    // Related progress is intentionally non-blocking. Drain the slowest real transport before
    // serializing the observed transcript so callback scheduling cannot make the fixture flaky.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (url.action === "accept") await server.createElicitationCompletionNotifier("fixture-url")();
    await server.sendLoggingMessage({ level: "info", data: { fixture: true } });
    await server.sendResourceListChanged();
    await server.sendResourceUpdated({ uri: "file:///one" });
    await server.sendPromptListChanged();
    const structuredContent = { sampling, roots, form, url, incomingProgress };
    return { content: [{ type: "text", text: "exercised" }], structuredContent };
  });

  server.setRequestHandler(ListResourcesRequestSchema, ({ params }) => params?.cursor === "resource-page-2"
    ? { resources: [{ uri: "file:///two", name: "two" }] }
    : { resources: [{ uri: "file:///one", name: "one" }], nextCursor: "resource-page-2" });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, ({ params }) => params?.cursor === "template-page-2"
    ? { resourceTemplates: [{ uriTemplate: "file:///two/{name}", name: "two" }] }
    : { resourceTemplates: [{ uriTemplate: "file:///one/{name}", name: "one" }], nextCursor: "template-page-2" });
  server.setRequestHandler(ReadResourceRequestSchema, ({ params }) => ({
    contents: [{ uri: params.uri, mimeType: "text/plain", text: `read:${params.uri}` }],
  }));
  server.setRequestHandler(SubscribeRequestSchema, () => ({}));
  server.setRequestHandler(UnsubscribeRequestSchema, () => ({}));
  server.setRequestHandler(ListPromptsRequestSchema, ({ params }) => params?.cursor === "prompt-page-2"
    ? { prompts: [{ name: "two", description: "two" }] }
    : { prompts: [{ name: "one", description: "one" }], nextCursor: "prompt-page-2" });
  server.setRequestHandler(GetPromptRequestSchema, ({ params }) => ({
    description: `prompt:${params.name}`,
    messages: [{ role: "user", content: { type: "text", text: "prompt body" } }],
  }));
  server.setRequestHandler(CompleteRequestSchema, () => ({
    completion: { values: ["alpha", "beta"], total: 2, hasMore: false },
  }));
  server.setRequestHandler(SetLevelRequestSchema, () => ({}));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createConformanceServer();
  await server.connect(new StdioServerTransport());
}
