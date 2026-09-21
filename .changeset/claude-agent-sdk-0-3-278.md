---
"@automatalabs/acp-agents": patch
---

Carry the wrapped Claude Code runtime to `@anthropic-ai/claude-agent-sdk@0.3.278` through the workspace override, ahead of `@agentclientprotocol/claude-agent-acp@0.79.0`'s own 0.3.274 pin. The SDK's type surface is byte-identical to 0.3.277. Claude Code 2.1.278 changes auto mode — the Claude backend's default mode — to run its permission classifier on the server for Claude API and Enterprise accounts and on Bedrock, Vertex, Foundry, and gateways, where it adds no classifier token overhead; `CLAUDE_CODE_AUTO_MODE_SERVER=0` opts out on the third-party platforms, and the runtime warns when it falls back to the billed client-side classifier.
