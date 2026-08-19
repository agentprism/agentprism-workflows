---
"@automatalabs/codex-acp": patch
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `3d56827`,
upstream release `chore(main): release 1.5.0` (#409)). Mechanical: the single upstream commit is a
release-please version/CHANGELOG bump only — it packages the AIR/provider changes already synced at
`47b57da` and changes no source under `packages/codex-acp/src`. Conflicts resolved by the standard
policy (fork `package.json` version/description kept; fork's deleted `package-lock.json` stays
deleted; the changesets-owned `CHANGELOG.md` kept ours; upstream's `.release-please-manifest.json`
version taken). No integration surface changed.
