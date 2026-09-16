// The per-agent local tool host: one in-process Streamable HTTP MCP server on 127.0.0.1 behind an
// unguessable token path (the `StructuredOutputToolHost` pattern), serving `tools/list` and
// `tools/call` for every `AcpAgentToolDefinition` the agent was given. Arguments are validated
// against the definition's typebox schema (Convert + Check) before `execute` runs; a validation
// failure or a thrown `execute` comes back as an MCP result with `isError: true` and the message —
// never a transport or protocol error, so the agent can read it and recover. Every in-flight
// `execute` gets an AbortSignal the agent wires to its own abort, turn cancellation, and close.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { LocalMcpHttpHost } from "../local-mcp-host.js";
import { validateValue } from "../structured-output.js";
import { describeSchemaErrors, structuredToolInputSchema } from "../structured-tool.js";
import type { AcpAgentToolContext, AcpAgentToolDefinition, AcpAgentToolResult } from "./types.js";

/** The injected `mcpServers` entry name (`agent_tools_2`, … when a caller's server holds it). */
export const AGENT_TOOLS_SERVER_NAME = "agent_tools";

/** What the agent hands the host at call time (the session id exists only once the session is
 *  open, and the host must be listening before `session/new` carries its URL). */
export interface AgentToolHostContext {
  readonly sessionId: string | undefined;
  readonly backendId: string;
  readonly label?: string;
  /** Best-effort ACP `tool_call` correlation for the call the agent is making right now. */
  readonly resolveToolCallId?: (toolName: string) => string | undefined;
}

interface InFlightCall {
  readonly controller: AbortController;
}

export class AgentToolHost extends LocalMcpHttpHost {
  protected readonly hostName = "agent_tools";
  readonly #token = randomBytes(16).toString("hex");
  readonly #tools: ReadonlyMap<string, AcpAgentToolDefinition>;
  readonly #advertised: Tool[];
  readonly #context: () => AgentToolHostContext;
  readonly #inFlight = new Set<InFlightCall>();
  #url: string | undefined;
  #disposed = false;

  constructor(tools: readonly AcpAgentToolDefinition[], context: () => AgentToolHostContext) {
    super();
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.#advertised = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: structuredToolInputSchema(tool.inputSchema),
    }));
    this.#context = context;
  }

  /** Bind (once) and return the token URL the `mcpServers` entry points at. */
  async listen(): Promise<string> {
    if (this.#disposed) throw new Error("agent_tools MCP host is disposed");
    const port = await this.ensureListening();
    this.#url ??= this.urlFor(this.#token, port);
    return this.#url;
  }

  /** The token URL once `listen()` resolved. */
  get url(): string | undefined {
    return this.#url;
  }

  /** The names served, in definition order. */
  get toolNames(): readonly string[] {
    return this.#advertised.map((tool) => tool.name);
  }

  /** `execute` calls currently running. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Abort every running `execute` with `reason` (turn cancellation, the agent's abort, close). */
  abortInFlight(reason?: unknown): void {
    for (const call of this.#inFlight) call.controller.abort(reason);
  }

  /** Abort what is running, stop listening. Idempotent. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.abortInFlight(new Error("AcpAgent closed while the tool call was running"));
    await this.closeServer();
  }

  protected mcpServerFor(token: string, _req: IncomingMessage, res: ServerResponse): Server | undefined {
    if (this.#disposed || token !== this.#token) return undefined;
    return this.#createMcpServer(res);
  }

  #createMcpServer(res: ServerResponse): Server {
    const server = new Server({ name: "agentprism-agent-tools", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({ tools: this.#advertised }));
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const tool = this.#tools.get(request.params.name);
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
      }
      return this.#call(tool, request.params.arguments ?? {}, res);
    });
    return server;
  }

  async #call(tool: AcpAgentToolDefinition, args: unknown, res: ServerResponse): Promise<CallToolResult> {
    const input = validateValue(args, tool.inputSchema);
    if (input === undefined) {
      return errorResult(
        `Invalid arguments for tool "${tool.name}": ${describeSchemaErrors(tool.inputSchema, args) || "arguments do not match the input schema"}`,
      );
    }
    const context = this.#context();
    if (context.sessionId === undefined) {
      return errorResult(`Tool "${tool.name}" was called before the agent's session was open`);
    }
    const controller = new AbortController();
    const call: InFlightCall = { controller };
    this.#inFlight.add(call);
    // The backend gave up on the request (process death, its own timeout): stop the work.
    const onResponseClosed = (): void => {
      if (!res.writableFinished) controller.abort(new Error("the agent dropped the tool call before it completed"));
    };
    res.once("close", onResponseClosed);
    const ctx: AcpAgentToolContext = {
      sessionId: context.sessionId,
      backendId: context.backendId,
      ...(context.label !== undefined ? { label: context.label } : {}),
      ...(() => {
        const toolCallId = context.resolveToolCallId?.(tool.name);
        return toolCallId !== undefined ? { toolCallId } : {};
      })(),
      signal: controller.signal,
    };
    try {
      const result = await tool.execute(input, ctx);
      return normalizeResult(tool.name, result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    } finally {
      res.off("close", onResponseClosed);
      this.#inFlight.delete(call);
    }
  }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Shape `execute`'s return into a `CallToolResult`; anything outside the contract is an
 *  `isError` result naming the tool (JavaScript callers can return `undefined` by mistake). */
function normalizeResult(name: string, result: AcpAgentToolResult | undefined): CallToolResult {
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  if (Array.isArray(result)) return { content: result };
  if (result !== null && typeof result === "object" && Array.isArray(result.content)) {
    return { content: result.content, ...(result.isError === true ? { isError: true } : {}) };
  }
  return errorResult(
    `Tool "${name}" returned ${result === null ? "null" : typeof result}; expected a string, an array of content blocks, or { content, isError? }`,
  );
}
