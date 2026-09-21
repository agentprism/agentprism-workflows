---
"@automatalabs/codex-acp": patch
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `acc035a`).

Upstream moves the wrapped Codex runtime to `@openai/codex@^0.155.1` and isolates its symlinked-workspace test fixtures from ancestor Git markers. No `CodexAcpServer` / `CodexEventHandler` surface changed, the generated app-server types are unchanged, and no fork-owned code needed adapting. The package also moves to `@agentclientprotocol/sdk@^1.5.0` with the rest of the workspace.
