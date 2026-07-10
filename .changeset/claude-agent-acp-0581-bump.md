---
"@automatalabs/acp-agents": patch
---

Bump the pinned `@agentclientprotocol/claude-agent-acp` to 0.58.1. The updated adapter now advertises `sessionCapabilities.fork`, so `runner.forkSession()` works live against Claude Code as well as OpenCode (verified: the forked session carries the source conversation's context).
