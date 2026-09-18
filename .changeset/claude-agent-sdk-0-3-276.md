---
"@automatalabs/acp-agents": patch
---

Carry the wrapped Claude Code runtime to `@anthropic-ai/claude-agent-sdk@0.3.276` through a workspace override, ahead of `@agentclientprotocol/claude-agent-acp@0.79.0`'s own 0.3.274 pin. 0.3.275 fixes session history the adapter reads on `session/load` and fork: `getSessionMessages()` / `forkSession()` no longer miss a turn's assistant message when called right after its `result`, a queued message or task notification Claude read while running a tool now comes back where it was read, `forkSession` accepts the id `getSessionMessages` returns for a message sent mid-turn, and a deferred tool call re-run at the start of a resumed turn emits `tool_use_result` rather than internal keys. 0.3.276 / Claude Code 2.1.276 fixes a 2.1.275 regression that failed every request with HTTP 400 when `ANTHROPIC_BASE_URL` points at a proxy or gateway, so 0.3.275 is skipped. Neither release changes an API shape AgentPrism or the adapter consumes.
