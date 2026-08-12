---
"@automatalabs/acp-agents": patch
---

Track the wrapped Claude agent runtime forward: root pnpm override pins
@anthropic-ai/claude-agent-sdk to 0.3.229 (npm latest) until
@agentclientprotocol/claude-agent-acp catches up, per the ACP dependency
freshness runbook. Upstream changes reviewed: additive (`terminal_slash_commands`
init field, `output_tokens_details` passthrough) plus an oversized-request
terminal_reason reclassification (`image_error` → `api_error`) — no agentprism
code matches on those surfaces.
