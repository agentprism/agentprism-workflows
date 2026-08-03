---
"@automatalabs/acp-agents": patch
---

Update `@agentclientprotocol/claude-agent-acp` to 0.64.2 (ACP dependency freshness gate). Upstream 0.64.x keeps the `@agentclientprotocol/sdk@1.3.0` + `@anthropic-ai/claude-agent-sdk@0.3.220` pins, restores the single-tool ExitPlanMode representation, and adds an opt-in request-level steering `idleBehavior` fallback — the default `startedNewTurn` contract the runner relies on is unchanged.
