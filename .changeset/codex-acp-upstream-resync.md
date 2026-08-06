---
"@automatalabs/codex-acp": patch
---

Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
(0ff2d55), which carries a transitive npm security bump and the Codex 0.146.0 update.

No runtime source changed on our side: the merge only lands upstream's canonical key
ordering in four `CodexACPAgent` test fixtures. The fork had already back-ported the
`pluginId`/`scriptPath`/`id` keys at a different position, so git's line-based merge
duplicated them inside the same object literals; resolved by taking upstream's file
content for those fixtures. Key counts now match upstream and the merge base exactly.
The fork's deliberate deletion of the package-level lockfile is preserved (the monorepo
uses the root `pnpm-lock.yaml`), as are the fork's package identity and version.
