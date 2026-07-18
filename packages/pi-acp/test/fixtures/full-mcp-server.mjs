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

export const LARGE_FIXTURE_ITEM_COUNT = 1_025;
const LARGE_FIXTURE_PAGE_SIZE = 257;
const wireProgressStates = new WeakMap();

function wireProgressState(server) {
  const state = wireProgressStates.get(server);
  if (!state) throw new Error("conformance server has no wire-progress state");
  return state;
}

/**
 * The SDK defers notification handlers but handles a following response
 * synchronously. Stdio may deliver progress and that response in one read
 * batch, causing the SDK to remove its progress callback before dispatch;
 * HTTP may deliver a fire-and-forget progress POST after the result POST.
 * Observe the fixture's progress at transport ingress for the connection
 * lifetime so its barriers test wire frames rather than callback scheduling.
 */
export function conformanceProgressOptions(server, onprogress) {
  wireProgressState(server).pending.push(onprogress);
  return { onprogress() {} };
}

export function connectConformanceServer(server, transport) {
  const state = wireProgressState(server);
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (message && typeof message === "object" && "id" in message && "method" in message && state.pending.length > 0) {
      state.active.set(message.id, state.pending.shift());
    }
    return send(message, options);
  };
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (message && typeof message === "object" && "method" in message && message.method === "notifications/progress") {
      const { progressToken, ...params } = message.params;
      state.active.get(progressToken)?.(params);
    }
    onmessage?.(message, extra);
  };
  return server.connect(transport);
}

function largePage(field, prefix, cursor, createItem) {
  const page = cursor === undefined ? 0 : Number(cursor.slice(prefix.length));
  if (!Number.isInteger(page) || page < 0) throw new Error(`invalid ${prefix} cursor`);
  const start = page * LARGE_FIXTURE_PAGE_SIZE;
  const end = Math.min(start + LARGE_FIXTURE_PAGE_SIZE, LARGE_FIXTURE_ITEM_COUNT);
  const items = Array.from({ length: end - start }, (_, offset) => createItem(start + offset));
  return {
    [field]: items,
    ...(end < LARGE_FIXTURE_ITEM_COUNT ? { nextCursor: `${prefix}${page + 1}` } : {}),
  };
}

export function createConformanceServer(options = {}) {
  let revision = 0;
  let raceId = 0;
  let transportClose;
  let incomingProgress = { sampling: [], roots: [], form: [], url: [] };
  let progressReady = Promise.resolve();
  let markProgressReady = () => {};
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
  wireProgressStates.set(server, { pending: [], active: new Map() });

  server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
    if (options.largeCatalog) {
      return largePage("tools", "large-tool-page-", params?.cursor, (index) => ({
        name: `large_tool_${index}`,
        description: `large tool ${index}`,
        inputSchema: { type: "object", additionalProperties: false },
      }));
    }
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
        { name: "progress_snapshot", description: "observe completed client progress", inputSchema: { type: "object", additionalProperties: false } },
        { name: "projection", description: "project every stable result block", inputSchema: { type: "object", additionalProperties: false } },
        { name: "remote_error", description: "return an MCP error result", inputSchema: { type: "object", additionalProperties: false } },
        { name: "hang", description: "wait for cancellation", inputSchema: { type: "object", additionalProperties: false } },
        {
          name: "race_feature",
          description: "exercise incoming client-feature terminal races",
          inputSchema: {
            type: "object",
            required: ["feature", "cause"],
            properties: {
              feature: { type: "string", enum: ["sampling", "roots", "form", "url"] },
              cause: { type: "string", enum: ["ordinary", "peer", "turn", "timeout", "session", "transport"] },
            },
            additionalProperties: false,
          },
        },
        { name: "isolate_url", description: "hold one equal remote elicitation id", inputSchema: { type: "object", additionalProperties: false } },
        {
          name: "form_case",
          description: "exercise exact form-schema validation",
          inputSchema: {
            type: "object",
            required: ["case"],
            properties: {
              case: { type: "string", enum: ["extra", "missing", "mistyped", "bounded", "default", "compilation"] },
            },
            additionalProperties: false,
          },
        },
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
    if (params.name === "progress_snapshot") {
      await progressReady;
      return { content: [{ type: "text", text: JSON.stringify(incomingProgress) }] };
    }
    if (params.name === "form_case") {
      const formCase = params.arguments?.case;
      const requestedSchema = formCase === "bounded"
        ? {
            type: "object",
            required: ["answer"],
            properties: { answer: { type: "string", minLength: 3, maxLength: 5 } },
          }
        : formCase === "default"
          ? {
              type: "object",
              properties: { answer: { type: "string", default: "adapter-must-not-apply" } },
            }
          : formCase === "compilation"
            ? {
                type: "object",
                properties: { answer: { type: "string", enum: [] } },
              }
          : {
              type: "object",
              required: ["answer"],
              properties: { answer: { type: "string" } },
            };
      try {
        const result = await server.elicitInput({
          mode: "form",
          message: `form-case:${formCase}`,
          requestedSchema,
        });
        return { content: [{ type: "text", text: JSON.stringify({ result }) }] };
      } catch (error) {
        const value = error instanceof Error ? error : new Error(String(error));
        const wireMessage = value.message.replace(/^MCP error -?\d+: /, "");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: { code: error?.code, wireMessage } }),
          }],
        };
      }
    }
    if (params.name === "hang") {
      await new Promise((resolve, reject) => {
        if (extra.signal.aborted) return reject(extra.signal.reason);
        extra.signal.addEventListener("abort", () => reject(extra.signal.reason), { once: true });
      });
    }
    if (params.name === "race_feature") {
      const { feature, cause } = params.arguments;
      let outerStartSent = false;
      if (cause === "session" && extra._meta?.progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: extra._meta.progressToken, progress: 1, total: 1, message: `race-started:${feature}:${cause}` },
        });
        outerStartSent = true;
        await new Promise((resolve) => setImmediate(resolve));
      }
      const peer = new AbortController();
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const options = {
        ...conformanceProgressOptions(server, () => markStarted()),
        ...(cause === "peer" ? { signal: peer.signal } : {}),
      };
      let incoming;
      if (feature === "sampling") {
        incoming = server.createMessage({
          messages: [{ role: "user", content: { type: "text", text: `race:${cause}` } }],
          maxTokens: 8,
          metadata: { raceFeature: feature, raceCause: cause },
        }, options);
      } else if (feature === "roots") {
        incoming = server.listRoots(undefined, options);
      } else if (feature === "form") {
        incoming = server.elicitInput({
          mode: "form",
          message: `race:${cause}`,
          requestedSchema: {
            type: "object",
            required: ["answer"],
            properties: { answer: { type: "string" } },
          },
        }, options);
      } else {
        incoming = server.elicitInput({
          mode: "url",
          message: `race:${cause}`,
          elicitationId: `race-${cause}-${++raceId}`,
          url: "https://example.invalid/race",
        }, options);
      }
      // A peer/session/turn/timeout can settle the protocol request while this
      // fixture is still awaiting its deterministic outer progress barrier.
      // Observe that rejection immediately, then assert it below.
      incoming.catch(() => undefined);
      // A deliberately immediate timeout may commit before its fire-and-forget
      // 0/1 progress frame is received. The host-operation barrier in the test
      // triggers that timeout, so it is the deterministic admission proof.
      if (cause === "timeout" || cause === "session") markStarted();
      await started;
      if (!outerStartSent && extra._meta?.progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: extra._meta.progressToken, progress: 1, total: 1, message: `race-started:${feature}:${cause}` },
        });
      }
      if (cause === "peer") peer.abort(new Error("fixture peer cancellation"));
      if (cause === "transport") {
        if (options.exitOnTransportRace) {
          setImmediate(() => process.exit(0));
          await new Promise(() => undefined);
        } else {
          transportClose ??= server.close();
          await transportClose;
        }
      }
      try {
        const value = await incoming;
        return { content: [{ type: "text", text: JSON.stringify({ status: "resolved", value }) }] };
      } catch {
        return { content: [{ type: "text", text: JSON.stringify({ status: "rejected" }) }] };
      }
    }
    if (params.name === "isolate_url") {
      const result = await server.elicitInput({
        mode: "url",
        message: "isolate-url",
        elicitationId: "equal-remote",
        url: "https://example.invalid/isolate",
      });
      if (result.action === "accept") await server.createElicitationCompletionNotifier("equal-remote")();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    if (params.name === "projection") {
      const data = Buffer.from([0, 1, 2, 3]).toString("base64");
      return {
        content: [
          { type: "text", text: "plain" },
          { type: "image", data, mimeType: "image/png" },
          { type: "audio", data, mimeType: "audio/wav" },
          { type: "resource_link", uri: "file:///linked", name: "linked", title: "Linked title" },
          { type: "resource", resource: { uri: "file:///embedded-text", mimeType: "text/plain", text: "embedded" } },
          { type: "resource", resource: { uri: "file:///embedded-blob", blob: data } },
        ],
        structuredContent: { exact: true },
        isError: false,
        _meta: { retained: true },
      };
    }
    if (params.name === "remote_error") {
      return {
        content: [{ type: "text", text: "peer-declared failure" }],
        isError: true,
        _meta: { retained: "error" },
      };
    }
    if (params.name !== "exercise") return { content: [{ type: "text", text: params.name }] };
    const progressToken = extra._meta?.progressToken;
    if (progressToken !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: 1, total: 2, message: "half" },
      });
    }
    incomingProgress = { sampling: [], roots: [], form: [], url: [] };
    progressReady = new Promise((resolve) => { markProgressReady = resolve; });
    const recordProgress = (feature) => (value) => {
      incomingProgress[feature].push(value);
      if (Object.values(incomingProgress).every((values) => values.length === 2)) markProgressReady();
    };
    const sampling = await server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: "sample me" } }],
      maxTokens: 32,
      systemPrompt: "fixture system",
    }, conformanceProgressOptions(server, recordProgress("sampling")));
    const roots = await server.listRoots(undefined, conformanceProgressOptions(server, recordProgress("roots")));
    const form = await server.elicitInput({
      mode: "form",
      message: "form",
      requestedSchema: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    }, conformanceProgressOptions(server, recordProgress("form")));
    const url = await server.elicitInput({
      mode: "url",
      message: "url",
      elicitationId: "fixture-url",
      url: "https://example.invalid/complete",
    }, conformanceProgressOptions(server, recordProgress("url")));
    // Progress is optional telemetry and therefore is not a barrier for the exercised result. The
    // separate progress_snapshot operation is the test-only wire-observation barrier.
    if (url.action === "accept") {
      const complete = server.createElicitationCompletionNotifier("fixture-url");
      await complete();
      await complete();
      await server.createElicitationCompletionNotifier("never-issued")();
    }
    const urlReuse = await server.elicitInput({
      mode: "url",
      message: "url-reuse",
      elicitationId: "fixture-url",
      url: "https://example.invalid/reused",
    });
    await server.sendLoggingMessage({ level: "info", data: { fixture: true } });
    await server.sendResourceListChanged();
    await server.sendResourceUpdated({ uri: "file:///one" });
    await server.sendPromptListChanged();
    const structuredContent = { sampling, roots, form, url, urlReuse };
    return { content: [{ type: "text", text: "exercised" }], structuredContent };
  });

  server.setRequestHandler(ListResourcesRequestSchema, ({ params }) => options.largeCatalog
    ? largePage("resources", "large-resource-page-", params?.cursor, (index) => ({
        uri: `file:///large/${index}`,
        name: `large-resource-${index}`,
      }))
    : params?.cursor === "resource-page-2"
      ? { resources: [{ uri: "file:///two", name: "two" }] }
      : { resources: [{ uri: "file:///one", name: "one" }], nextCursor: "resource-page-2" });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, ({ params }) => options.largeCatalog
    ? largePage("resourceTemplates", "large-template-page-", params?.cursor, (index) => ({
        uriTemplate: `file:///large/${index}/{name}`,
        name: `large-template-${index}`,
      }))
    : params?.cursor === "template-page-2"
      ? { resourceTemplates: [{ uriTemplate: "file:///two/{name}", name: "two" }] }
      : { resourceTemplates: [{ uriTemplate: "file:///one/{name}", name: "one" }], nextCursor: "template-page-2" });
  server.setRequestHandler(ReadResourceRequestSchema, ({ params }) => ({
    contents: [{ uri: params.uri, mimeType: "text/plain", text: `read:${params.uri}` }],
  }));
  server.setRequestHandler(SubscribeRequestSchema, () => ({}));
  server.setRequestHandler(UnsubscribeRequestSchema, () => ({}));
  server.setRequestHandler(ListPromptsRequestSchema, ({ params }) => options.largeCatalog
    ? largePage("prompts", "large-prompt-page-", params?.cursor, (index) => ({
        name: `large-prompt-${index}`,
        description: `large prompt ${index}`,
      }))
    : params?.cursor === "prompt-page-2"
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
  const server = createConformanceServer({ exitOnTransportRace: true });
  await connectConformanceServer(server, new StdioServerTransport());
}
