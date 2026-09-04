---
"@automatalabs/mcp-server": major
"@automatalabs/workflows": major
---

Replace the MCP `docs` tool and `agentprism://docs/*` resources with the accepted SEP-2640 Skills Extension. The server now publishes separate workflow-authoring and REPL-orchestration Agent Skills through `skills/list`, `skills/get`, standard resource reads, and capability-gated directory reads.
