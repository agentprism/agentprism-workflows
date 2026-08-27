---
"@automatalabs/acp-agents": minor
"@automatalabs/workflow-engine": patch
"@automatalabs/workflows": minor
"@automatalabs/repl-engine": patch
"@automatalabs/mcp-server": patch
---

Make agent configuration fail closed and fully discoverable. Config probes now return effective ACP session modes, including config-option fallback normalization and explicit `null` for unsupported modes; workflow preflight rejects guessed or unadvertised modes before admission. Workflow `agent()` rejects unknown option keys before allocation, while REPL rejects reserved `configOptions.model` with modelSpec-native guidance and preserves independent mode failures instead of falsely blaming carried config keys. Static external MCP resources now accept subscribe/unsubscribe as no-ops.
