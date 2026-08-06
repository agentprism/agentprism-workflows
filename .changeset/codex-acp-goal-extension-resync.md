---
"@automatalabs/codex-acp": minor
---

Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
(61de42d): a provider-neutral ACP goal extension (#371) and the Codex 0.146.1 bump (#370).

The goal extension is a real feature touching `CodexAcpServer`, `CodexEventHandler`, and the
goal-snapshot plumbing, plus new test fixtures. Conflicts resolved in the fork's favor:
`package.json` keeps fork version/description (upstream's `@openai/codex` `^0.146.1` bump is
taken), and the package-level lockfile stays deleted. Merged with a true merge commit to keep
the upstream-ancestry invariant.
