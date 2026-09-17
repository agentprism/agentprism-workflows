---
"@automatalabs/acp-agents": patch
---

Refresh the wrapped Claude Agent SDK runtime override to 0.3.274 (`@agentclientprotocol/claude-agent-acp` stays at 0.78.0, which pins 0.3.270). Mechanical: 0.3.274 / Claude Code 2.1.274 add only fields the adapter and AgentPrism do not read (`startup_failure_reason` on the stream-json error result, `mcpServer` / `source` on `canUseTool` options and MCP server status rows, the `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` and `CLAUDE_CODE_EMIT_STARTUP_TIMING` env opt-ins). The faster first turn still awaits `options.mcpServers`, where ACP-provided servers and AgentPrism's injected StructuredOutput / function-tool hosts ride, so structured output and function tools are unaffected; the `getSessionMessages()` fix means a `session/load` replay or a fork now includes a user message sent while a tool was running.
