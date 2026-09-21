---
"@automatalabs/acp-agents": minor
"@automatalabs/workflows": patch
"@automatalabs/acp-server": patch
---

Move to `@agentclientprotocol/sdk@^1.5.0` (ACP schema 1.23.0).

The schema adds one UNSTABLE session update, `notice` — a fire-and-forget advisory (`severity`, `title`, optional `description`) an agent may send only to a client that advertises `clientCapabilities.session.notices`. AgentPrism does not advertise it, so no built-in agent sends one. Because event names are the ACP `sessionUpdate` discriminants verbatim, `notice` is now a typed event name on the runner and `AcpAgent` event buses and reaches the `session_update` catch-all like every other kind; the workflow activity projection counts it as backend activity, the same as the other non-content updates.

The schema also stabilizes the tool-call `name` field (`ToolCall.name` / `ToolCallUpdate.name`), which AgentPrism already prefers for tool-policy matching. No request, response, or capability shape AgentPrism sends or reads changed.
