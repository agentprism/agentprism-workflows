import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { adapterError } from "./errors.js";
import type { PiAcpDeps } from "./deps.js";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpListResult {
  tools: McpToolInfo[];
  nextCursor?: string;
}

export interface McpClientHandle {
  listTools(cursor: string | undefined, signal: AbortSignal, timeoutMs: number): Promise<McpListResult>;
  callTool(name: string, args: unknown, signal: AbortSignal, timeoutMs: number): Promise<CallToolResult>;
  close(): Promise<void>;
}

export class McpTimeoutError extends Error {
  constructor() {
    super("MCP operation timed out");
    this.name = "McpTimeoutError";
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export async function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  sleep: PiAcpDeps["sleep"],
): Promise<T> {
  const timeoutController = new AbortController();
  const timeout = sleep(timeoutMs, timeoutController.signal).then(() => {
    throw new McpTimeoutError();
  });
  operation.then(() => undefined, () => undefined);
  try {
    return await Promise.race([operation, abortPromise(signal), timeout]);
  } finally {
    timeoutController.abort();
    timeout.catch(() => undefined);
  }
}

export async function connectDefaultMcpClient(
  server: McpServerStdio,
  signal: AbortSignal,
  timeoutMs: number,
  sleep: PiAcpDeps["sleep"],
): Promise<McpClientHandle> {
  const client = new Client({ name: "@automatalabs/pi-acp", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
  });
  try {
    await bounded(client.connect(transport), signal, timeoutMs, sleep);
  } catch (error) {
    await bounded(
      transport.close().catch(() => undefined),
      new AbortController().signal,
      timeoutMs,
      sleep,
    ).catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    async listTools(cursor, requestSignal, requestTimeout) {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        signal: requestSignal,
        timeout: requestTimeout,
      });
      return {
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })),
        nextCursor: result.nextCursor,
      };
    },
    callTool(name, args, requestSignal, requestTimeout) {
      return client.callTool(
        { name, arguments: typeof args === "object" && args !== null ? args as Record<string, unknown> : {} },
        undefined,
        { signal: requestSignal, timeout: requestTimeout },
      ).then((result) => {
        if (!("content" in result)) throw new Error("MCP task result did not contain tool content");
        return result as CallToolResult;
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
}

function slug(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_");
  return sanitized || "_";
}

export function allocateAlias(server: string, tool: string, used: Set<string>): string {
  const base = `mcp__${slug(server)}__${slug(tool)}`;
  let candidate = base.slice(0, 128);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, 128 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

type McpContent = CallToolResult["content"][number];

export function convertMcpContent(content: McpContent):
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string } {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return { type: "image", data: content.data, mimeType: content.mimeType };
    case "audio":
      return { type: "text", text: "[unsupported audio tool-result omitted]" };
    case "resource_link":
      return { type: "text", text: `[${content.title ?? content.name ?? content.uri}](${content.uri})` };
    case "resource":
      return {
        type: "text",
        text: "text" in content.resource
          ? content.resource.text
          : `[embedded resource: ${content.resource.uri}]`,
      };
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

export function convertMcpResult(result: CallToolResult) {
  return {
    content: result.content.map(convertMcpContent),
    ...(result.structuredContent === undefined ? {} : { details: result.structuredContent }),
  };
}

export interface McpBridge {
  clients: McpClientHandle[];
  tools: ToolDefinition[];
  aliases: string[];
}

async function closeClients(clients: readonly McpClientHandle[], deps: PiAcpDeps): Promise<void> {
  await Promise.allSettled(
    clients.map((client) =>
      bounded(client.close(), new AbortController().signal, deps.mcpTimeoutMs, deps.sleep).catch((error) => {
        console.error("pi-acp MCP close error:", error);
      }),
    ),
  );
}

export async function bridgeMcpServers(
  servers: readonly McpServer[],
  openSignal: AbortSignal,
  deps: PiAcpDeps,
): Promise<McpBridge> {
  const seenNames = new Set<string>();
  for (const server of servers) {
    if (seenNames.has(server.name)) throw adapterError("mcp_init_error", { server: server.name });
    seenNames.add(server.name);
    if ("type" in server) {
      throw adapterError("unsupported_mcp_transport", { server: server.name });
    }
  }
  const clients: McpClientHandle[] = [];
  const tools: ToolDefinition[] = [];
  const aliases: string[] = [];
  const usedAliases = new Set<string>();
  try {
    for (const server of servers as readonly McpServerStdio[]) {
      let handle: McpClientHandle;
      try {
        handle = await bounded(
          deps.connectMcpClient(server, openSignal),
          openSignal,
          deps.mcpTimeoutMs,
          deps.sleep,
        );
      } catch (error) {
        if (openSignal.aborted) throw error;
        throw adapterError("mcp_init_error", { server: server.name });
      }
      clients.push(handle);
      const serverTools: McpToolInfo[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        do {
          if (cursor !== undefined) {
            if (cursors.has(cursor)) throw new Error("cycling tools/list cursor");
            cursors.add(cursor);
          }
          const page = await bounded(
            handle.listTools(cursor, openSignal, deps.mcpTimeoutMs),
            openSignal,
            deps.mcpTimeoutMs,
            deps.sleep,
          );
          serverTools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      } catch (error) {
        if (openSignal.aborted) throw error;
        throw adapterError("mcp_init_error", { server: server.name });
      }
      for (const remoteTool of serverTools) {
        const alias = allocateAlias(server.name, remoteTool.name, usedAliases);
        aliases.push(alias);
        const tool = {
          name: alias,
          label: remoteTool.name,
          description: remoteTool.description ?? `MCP tool ${remoteTool.name}`,
          parameters: remoteTool.inputSchema,
          execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
            const turnSignal = signal ?? new AbortController().signal;
            let result: CallToolResult;
            try {
              result = await bounded(
                handle.callTool(remoteTool.name, params, turnSignal, deps.mcpTimeoutMs),
                turnSignal,
                deps.mcpTimeoutMs,
                deps.sleep,
              );
            } catch {
              throw new Error(`MCP tool ${alias} timed out`);
            }
            if (result.isError) throw new Error(`MCP tool ${alias} returned an error result`);
            return convertMcpResult(result);
          },
        };
        tools.push(tool as ToolDefinition);
      }
    }
    return { clients, tools, aliases };
  } catch (error) {
    await closeClients(clients, deps);
    throw error;
  }
}

export async function disposeMcpBridge(clients: readonly McpClientHandle[], deps: PiAcpDeps): Promise<void> {
  await closeClients(clients, deps);
}
