---
"@automatalabs/codex-acp": minor
---

Sync upstream `agentclientprotocol/codex-acp` through `4823131`, adding AI-generated session titles and the `/rename` command. Preserve workflow cost and lifecycle semantics by suppressing the upstream fire-and-forget title-generation turn for AgentPrism engine sessions carrying the `runId` metadata stamp; interactive Codex sessions remain eligible.
