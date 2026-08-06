---
"@automatalabs/codex-acp": minor
---

Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
(5d40f74), which adds ChatGPT device-code authentication via URL elicitation (#347).

This is a real upstream feature touching `CodexAcpClient` / `CodexAcpServer` / auth-method
selection, not a mechanical lockfile bump — read the diff before merging. The new
`chat-gpt-device-code` method is advertised only when the client supports URL elicitation, and
the fork's no-fork-history test fixtures and package identity are preserved. Merged with a true
merge commit (not squash) to keep the upstream-ancestry invariant the dependency gate checks.
