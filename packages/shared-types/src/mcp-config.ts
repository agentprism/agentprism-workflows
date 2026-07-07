// ===== packages/shared-types/src/mcp-config.ts =====
// Client-provided MCP server configs the engine can thread into a subagent run.
//
// This MIRRORS the ACP SDK's `McpServer` union (types.gen.d.ts) structurally so the
// acp-agents runner can hand it straight to `session/new { mcpServers }` with no
// transform — but it lives HERE, in @automatalabs/shared-types, because shared-types has
// ZERO ACP/MCP deps (it is the only module BOTH the engine and acp-agents import, and
// neither may pull the ACP SDK through it). The three transports below are the ones a
// client may provide over ACP: stdio (command/args/env), http (url/headers), sse
// (url/headers), and acp (client-proxied MCP over the ACP connection).
//
// IDENTITY NOTE: mcpServers is an ADDITIVE run input. It is NOT part of the resume
// identity hash (hashAgentCall) — it changes which tools an agent can reach, not the
// logical call, and tying it to the hash would needlessly bust every cached result when
// tool wiring changes. The engine threads it past the hash, straight to the runner.

/** A name/value pair (HTTP header or environment variable), matching ACP's HttpHeader/EnvVariable. */
export interface McpNameValue {
  name: string;
  value: string;
}

/** Stdio transport: launch an MCP server subprocess. Matches ACP `McpServerStdio` (the
 *  bare, `type`-less variant of the `McpServer` union). */
export interface McpStdioServerConfig {
  /** Human-readable name identifying this MCP server. */
  name: string;
  /** Path to the MCP server executable. */
  command: string;
  /** Command-line arguments to pass to the MCP server. */
  args: string[];
  /** Environment variables to set when launching the MCP server. */
  env: McpNameValue[];
}

/** HTTP transport. Matches ACP `McpServerHttp & { type: "http" }`. */
export interface McpHttpServerConfig {
  type: "http";
  name: string;
  url: string;
  headers: McpNameValue[];
}

/** SSE transport. Matches ACP `McpServerSse & { type: "sse" }`. */
export interface McpSseServerConfig {
  type: "sse";
  name: string;
  url: string;
  headers: McpNameValue[];
}

/** ACP transport. Matches ACP `McpServerAcp & { type: "acp" }`: the client hosts the MCP
 *  server and the agent tunnels MCP JSON-RPC back with mcp/connect, mcp/message, mcp/disconnect. */
export interface McpAcpServerConfig {
  type: "acp";
  name: string;
  serverId: string;
  _meta?: Record<string, unknown> | null;
}

/** A client-providable MCP server config — structurally assignable to the ACP SDK's
 *  `McpServer` union. */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSseServerConfig
  | McpAcpServerConfig;
