---
"@automatalabs/acp-agents": minor
---

Bump `@agentclientprotocol/claude-agent-acp` to 0.60.0 (configurable LLM providers) and
`@automatalabs/codex-acp` to 1.6.8 (upstream codex 0.144.6 fork sync). Record and replay the
durable Vertex routing config (`_meta.claudeCode.vertex.{projectId,region}`) so a `providers/set`
for the Claude agent's `vertex` apiType survives pooled-connection replay; generic request-scoped
`_meta` stays request-scoped as before.
