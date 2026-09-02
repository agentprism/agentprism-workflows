---
"@automatalabs/acp-agents": patch
---

Refresh `@agentclientprotocol/claude-agent-acp` to 0.73.0 and its wrapped Claude Agent SDK runtime to 0.3.258. Engine-owned Claude sessions now receive a stable label-derived title so the updated adapter does not launch an unobserved background title-generation model call; interactive sessions retain generated titles.
