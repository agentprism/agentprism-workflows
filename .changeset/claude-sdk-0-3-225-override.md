---
"@automatalabs/acp-agents": patch
---

Runtime override: force wrapped `@anthropic-ai/claude-agent-sdk` to 0.3.225 (upstream released; `@agentclientprotocol/claude-agent-acp` still pins older — per the dependency-gate runbook, drop the override when the adapter catches up).
