#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "pi-acp-fatal-stdio-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: "exit_peer", inputSchema: { type: "object", additionalProperties: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, () => {
  setTimeout(() => process.exit(0), 10);
  return { content: [{ type: "text", text: "exiting" }] };
});

await server.connect(new StdioServerTransport());
