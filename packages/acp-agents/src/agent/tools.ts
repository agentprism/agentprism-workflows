// Function-tool plumbing for the AcpAgent SDK: the constructor's definition validation (names,
// uniqueness, shape — INVALID_ARGUMENT before any process spawns), the `defineTool` inference
// helper, and the per-session injection decision: the agent's `agent_tools` HTTP MCP entry is
// appended to `mcpServers` only when the initialized agent strictly advertises HTTP MCP, and an
// agent that does not fails the open with INVALID_ARGUMENT — function tools are never dropped.
import type { McpServerConfig } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import type { PooledConnection } from "../acp-client.js";
import { agentValidationError } from "./errors.js";
import { availableMcpServerName } from "./structured.js";
import { AGENT_TOOLS_SERVER_NAME, type AgentToolHost } from "./tool-host.js";
import type { AcpAgentToolDefinition } from "./types.js";

/** The tool-name grammar: MCP-safe, 1–64 characters of `[A-Za-z0-9_-]`. */
export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Identity helper that infers `Static<typeof inputSchema>` for `execute`'s input. */
export function defineTool<TInput extends TSchema>(tool: AcpAgentToolDefinition<TInput>): AcpAgentToolDefinition<TInput> {
  return tool;
}

/** Constructor-time validation (INVALID_ARGUMENT): an array of well-formed definitions with
 *  MCP-safe, unique names and an object-typed `inputSchema`. `undefined` and `[]` are both "no
 *  tools". */
export function validateToolDefinitions(tools: unknown, label: string | undefined): AcpAgentToolDefinition[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw agentValidationError("AcpAgent `tools` must be an array of tool definitions", label);
  const seen = new Set<string>();
  tools.forEach((tool: unknown, index) => {
    const at = `tools[${index}]`;
    if (tool === null || typeof tool !== "object") throw agentValidationError(`${at} must be a tool definition object`, label);
    const { name, description, inputSchema, execute } = tool as Record<string, unknown>;
    if (typeof name !== "string" || !AGENT_TOOL_NAME_PATTERN.test(name)) {
      throw agentValidationError(
        `${at}.name must match ${AGENT_TOOL_NAME_PATTERN.source} (got ${JSON.stringify(name)})`,
        label,
      );
    }
    if (seen.has(name)) throw agentValidationError(`duplicate tool name "${name}" (tool names must be unique)`, label);
    seen.add(name);
    if (typeof description !== "string") throw agentValidationError(`tool "${name}" needs a string description`, label);
    if (inputSchema === null || typeof inputSchema !== "object") {
      throw agentValidationError(`tool "${name}" needs an inputSchema (a typebox schema object)`, label);
    }
    // MCP `tools/call` arguments are an object and `tools/list` advertises `inputSchema` as
    // `type: "object"`: a schema of any other top-level type could never be satisfied by a call,
    // so it is refused here rather than advertised.
    const schemaType = (inputSchema as { type?: unknown }).type;
    if (schemaType !== "object") {
      throw agentValidationError(
        `tool "${name}" inputSchema must be an object schema (typebox Type.Object(...), type: "object"); got type ${JSON.stringify(schemaType) ?? "undefined"}`,
        label,
      );
    }
    if (typeof execute !== "function") throw agentValidationError(`tool "${name}" needs an execute function`, label);
  });
  return tools as AcpAgentToolDefinition[];
}

export interface ToolPlanInputs {
  readonly tools: readonly AcpAgentToolDefinition[];
  readonly backendId: string;
  readonly label: string | undefined;
  /** The servers decided so far (the caller's, plus an injected `structured_output`). */
  readonly mcpServers: McpServerConfig[] | undefined;
  /** The agent's lazily created host (one per agent, disposed on close). */
  readonly host: () => AgentToolHost;
}

/** After initialize: append the `agent_tools` entry when the agent advertises HTTP MCP, or refuse
 *  the open. No tools → the servers pass through untouched and no host is created. */
export async function planTools(inputs: ToolPlanInputs, connection: PooledConnection): Promise<McpServerConfig[] | undefined> {
  const { tools, mcpServers } = inputs;
  if (tools.length === 0) return mcpServers;
  if (connection.capabilities?.agent.mcpCapabilities?.http !== true) {
    throw agentValidationError(
      `function tools need HTTP MCP, but backend "${inputs.backendId}" does not advertise mcpCapabilities.http ` +
        `(${tools.length} tool${tools.length === 1 ? "" : "s"} configured: ${tools.map((tool) => tool.name).join(", ")})`,
      inputs.label,
    );
  }
  const url = await inputs.host().listen();
  return [
    ...(mcpServers ?? []),
    { type: "http", name: availableMcpServerName(AGENT_TOOLS_SERVER_NAME, mcpServers), url, headers: [] },
  ];
}
