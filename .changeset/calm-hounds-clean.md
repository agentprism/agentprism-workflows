---
"@automatalabs/acp-agents": patch
"@automatalabs/mcp-server": patch
---

Dispose pooled ACP backend process trees when the stdio MCP server receives a signal or client disconnect, including stale connections already removed from pool admission.
