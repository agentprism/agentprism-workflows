---
"@automatalabs/acp-agents": patch
---

Drive the Claude backend with `@agentclientprotocol/claude-agent-acp@0.81.2` (from 0.79.0) and carry its wrapped runtime to `@anthropic-ai/claude-agent-sdk@0.3.281` through the workspace override, ahead of the adapter's own 0.3.280 pin.

The adapter now honors `permissions.disableBypassPermissionsMode`, recreates a resumed session when any session option changes, publishes the effective mode after plan approval, settles a steered turn on the result that answers the steer, and announces resumed subagent generations when they start. It adds `model` to `usage_update` and tags informational chunks with `_meta.claudeCode.kind = "informational"` without changing their text; AgentPrism reads neither. Its experimental `notice` updates are sent only to clients that advertise `session.notices`, which AgentPrism does not. SDK 0.3.279–0.3.281 (Claude Code 2.1.279–2.1.281) stop permission callbacks and control requests after `close()`, cancel an MCP server's pending form question when its tool call ends, and add message fields and options the adapter does not read.
