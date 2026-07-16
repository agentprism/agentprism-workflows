import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
  AgentContext,
  AgentRequestContext,
  AnyMessage,
  Stream,
} from "@agentclientprotocol/sdk";
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
/*
 * The fakes intentionally implement only the public AgentSession surface used by
 * the adapter. They are cast at the boundary so tests exercise the real adapter.
 */
import type { PiAcpDeps } from "../../src/deps.js";
import { realSleep } from "../../src/deps.js";
import type { McpClientHandle } from "../../src/mcp-bridge.js";

export interface FakeSessionControl {
  session: AgentSession;
  emit(event: AgentSessionEvent): void;
  promptCalls: Array<{ text: string; options: unknown }>;
  disposeCalls: number;
  abortCalls: number;
  listenerCount: number;
  tools: ToolDefinition[];
  resolvePrompt?: () => void;
  rejectPrompt?: (error: unknown) => void;
}

export function fakeSession(
  options: CreateAgentSessionOptions,
  behavior: "normal" | "wedged" | "preflight" | "tool" = "normal",
): FakeSessionControl {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: unknown[] = [];
  const promptCalls: Array<{ text: string; options: unknown }> = [];
  const tools = [...(options.customTools ?? [])];
  let active = tools.map(({ name }) => name);
  let thinkingLevel = options.thinkingLevel ?? "medium";
  let model = options.model;
  let disposeCalls = 0;
  let abortCalls = 0;
  let resolvePrompt: (() => void) | undefined;
  let rejectPrompt: ((error: unknown) => void) | undefined;
  const agent = {
    state: { messages },
    beforeToolCall: undefined as unknown,
    afterToolCall: undefined as unknown,
    abort() { abortCalls += 1; },
  };
  const object = {
    agent,
    sessionManager: options.sessionManager,
    get thinkingLevel() { return thinkingLevel; },
    get model() { return model; },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string, promptOptions: unknown) {
      promptCalls.push({ text, options: promptOptions });
      if (behavior === "preflight") throw new Error("No model selected");
      if (behavior === "wedged") {
        await new Promise<void>((resolve, reject) => {
          resolvePrompt = resolve;
          rejectPrompt = reject;
        });
        return;
      }
      if (behavior === "tool") {
        const tool = tools.find(({ name }) => name.startsWith("mcp__"));
        if (!tool) throw new Error("MCP tool missing from fake pi session");
        const toolCallId = "mcp-call-1";
        const args = { value: 1 };
        const start = {
          type: "tool_execution_start",
          toolCallId,
          toolName: tool.name,
          args,
        } as AgentSessionEvent;
        for (const listener of listeners) listener(start);
        let result: { content: Array<{ type: "text"; text: string }>; details?: unknown };
        let isError = false;
        try {
          const decision = await (agent.beforeToolCall as
            | ((context: unknown, signal: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>)
            | undefined)?.(
            { toolCall: { id: toolCallId, name: tool.name }, args },
            new AbortController().signal,
          );
          if (decision?.block) throw new Error(decision.reason ?? "tool blocked");
          result = await tool.execute(toolCallId, args, new AbortController().signal) as typeof result;
        } catch (error) {
          isError = true;
          result = {
            content: [{ type: "text", text: error instanceof Error ? error.message : "tool failed" }],
          };
        }
        const afterResult = await (agent.afterToolCall as
          | ((context: unknown, signal: AbortSignal) => Promise<{
            content?: typeof result.content;
            details?: unknown;
            isError?: boolean;
          } | undefined>)
          | undefined)?.(
          { toolCall: { id: toolCallId, name: tool.name }, args, result, isError },
          new AbortController().signal,
        );
        if (afterResult) {
          result = {
            ...result,
            content: afterResult.content ?? result.content,
            details: afterResult.details ?? result.details,
          };
          isError = afterResult.isError ?? isError;
        }
        const end = {
          type: "tool_execution_end",
          toolCallId,
          toolName: tool.name,
          result,
          isError,
        } as AgentSessionEvent;
        for (const listener of listeners) listener(end);
      }
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: {
          input: 3,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 6,
          cost: { total: 0.001 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      messages.push(assistant);
      for (const listener of listeners) {
        listener({
          type: "message_update",
          message: assistant,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: assistant },
        } as AgentSessionEvent);
      }
    },
    getContextUsage() { return { tokens: 6, contextWindow: 100, percent: 6 }; },
    getSessionStats() { return { cost: 0.001 }; },
    getAllTools() { return tools.map(({ name }) => ({ name, description: name, parameters: {}, sourceInfo: { source: "sdk" } })); },
    getToolDefinition(name: string) { return tools.find((tool) => tool.name === name); },
    getActiveToolNames() { return [...active]; },
    setActiveToolsByName(names: string[]) { active = [...names]; },
    setThinkingLevel(level: string) { thinkingLevel = level; },
    async setModel(next: unknown) { model = next as typeof model; },
    dispose() { disposeCalls += 1; },
  };
  const control: FakeSessionControl = {
    session: object as unknown as AgentSession,
    emit(event) { for (const listener of listeners) listener(event); },
    promptCalls,
    get disposeCalls() { return disposeCalls; },
    get abortCalls() { return abortCalls; },
    get listenerCount() { return listeners.size; },
    tools,
    get resolvePrompt() { return resolvePrompt; },
    get rejectPrompt() { return rejectPrompt; },
  };
  return control;
}

export interface FakeDepsResult {
  deps: PiAcpDeps;
  controls: FakeSessionControl[];
  createOptions: CreateAgentSessionOptions[];
  cwd: string;
  sessionDir: string;
}

export function fakeDeps(behavior: "normal" | "wedged" | "preflight" | "tool" = "normal"): FakeDepsResult {
  const cwd = mkdtempSync(`${tmpdir()}/pi-acp-cwd-`);
  const sessionDir = mkdtempSync(`${tmpdir()}/pi-acp-sessions-`);
  const controls: FakeSessionControl[] = [];
  const createOptions: CreateAgentSessionOptions[] = [];
  const model = { provider: "test", id: "model", contextWindow: 100 };
  const registry = {
    find(provider: string, id: string) { return provider === "test" && id === "model" ? model : undefined; },
    hasConfiguredAuth() { return true; },
  } as unknown as ModelRegistry;
  const deps: PiAcpDeps = {
    async createAgentSession(options) {
      createOptions.push(options);
      const control = fakeSession(options, behavior);
      controls.push(control);
      return {
        session: control.session,
        extensionsResult: { extensions: [], errors: [], runtime: {} },
        modelFallbackMessage: undefined,
      } as never;
    },
    sessions: {
      create: (target, dir, options) => SessionManager.create(target, dir, options),
      open: (path, dir, override) => SessionManager.open(path, dir, override),
      forkFrom: (path, target, dir, options) => SessionManager.forkFrom(path, target, dir, options),
      list: (target, dir) => SessionManager.list(target, dir),
      listAll: (dir) => SessionManager.listAll(dir),
    },
    modelRegistry: registry,
    sessionDir,
    async connectMcpClient() { throw new Error("unexpected MCP connect"); },
    sleep: realSleep,
    graceMs: 20,
    mcpTimeoutMs: 20,
  };
  return { deps, controls, createOptions, cwd, sessionDir };
}

export function context<T>(params: T, client?: Partial<AgentContext>, signal = new AbortController().signal): AgentRequestContext<T> {
  return {
    params,
    signal,
    requestId: 1,
    client: {
      notify: async () => undefined,
      request: async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
      ...client,
    } as AgentContext,
  };
}

export function streamPair(): { agent: Stream; client: Stream } {
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>();
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>();
  return {
    agent: { readable: clientToAgent.readable, writable: agentToClient.writable },
    client: { readable: agentToClient.readable, writable: clientToAgent.writable },
  };
}

export function fakeMcpHandle(overrides: Partial<McpClientHandle> = {}): McpClientHandle {
  return {
    async listTools() { return { tools: [] }; },
    async callTool() { return { content: [] }; },
    async close() {},
    ...overrides,
  };
}
