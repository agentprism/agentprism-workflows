---
"@automatalabs/acp-agents": patch
---

Bump the ACP protocol deps to current: `@agentclientprotocol/sdk` `1.0.0` → `1.1.0`, `@agentclientprotocol/claude-agent-acp` `0.53.0` → `0.55.0`, and `@automatalabs/codex-acp` `1.2.0` → `1.3.0` (the fork release that merges upstream v1.1.0 and advertises its custom capabilities).

No source changes were needed: the SDK's generated protocol type surface (`InitializeRequest`/`InitializeResponse`, `ClientCapabilities`, `AgentCapabilities`, `PromptCapabilities`, `McpCapabilities`, `SessionCapabilities`, `Implementation`) is byte-identical between `1.0.0` and `1.1.0` — the only `1.1.0` addition is a `requestId` (`JsonRpcId`) on the SDK's agent/client request-handler contexts, which the client seam does not touch. `claude-agent-acp@0.55.0`'s `initialize` response is identical to `0.53.0`'s (it just re-pins its own SDK to `1.1.0` and bumps the Claude Agent SDK). The `acp-agents` public API (including the SDK-derived `AcpSessionUpdate` / event payload types) is therefore unchanged.
