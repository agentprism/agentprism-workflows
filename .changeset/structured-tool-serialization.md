---
"@automatalabs/acp-agents": patch
"@automatalabs/workflows": patch
---

Fix cross-session structured-output leakage on agents with instance-global MCP registries (OpenCode): concurrent schema runs on one pooled connection could capture another session's StructuredOutput tool call because every registered tool is visible to every live session on the process. Injected-tool schema runs are now serialized per pooled connection (the constant server name makes each registration replace the previous, so the single live registration always belongs to the active run). Scale schema-run parallelism with AGENTPRISM_ACP_POOL_SIZE — one registry per process — rather than concurrent sessions.
