---
"@automatalabs/codex-acp": patch
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `47b57da`,
upstream releases v1.3.0 + v1.4.0). Upstream changes:

- **align typed session failures with AIR protocol (#393)** — reshapes the negotiated
  `jetbrains.air.sessionFailure` record: the category vocabulary collapses to
  `connection`/`access`/`limit`/`request`/`service`/`unknown`, actions to
  `retry`/`login`/`new_session`, and the record now carries `severity`/`title`/`details` instead of
  `phase`/`source`/`safeMessage`/`retryable`/`turnId`. Retry warnings and deprecation notices ride
  the same slot as advisory `severity: "warning"` records. The AIR extension version is unchanged
  (`1`). Our consuming client (`@automatalabs/acp-agents`) is adapted in the same branch.
- **report changed files to AIR (#403)** — a new additive `agentFileChangeReport` AIR capability,
  gated behind a client advertisement our stack does not send; inert for us.
- **restore native provider state after overrides (#400)** and **switch providers for loaded Codex
  sessions (#404)** — internal codex app-server restart/resume lifecycle; the ACP
  `providers/list`/`set`/`disable` wire shapes are unchanged. Adds a `CodexProcessState` constructor
  parameter (kept LAST behind the fork-owned params; fork test helper and call sites reconciled).

Fork-owned surfaces (turn-level `outputSchema` forwarding, goal extension, `_session/loaded_turn`,
`ClientFileSystem`) preserved through the merge; fork vitest suite green.
