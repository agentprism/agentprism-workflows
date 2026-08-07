# @automatalabs/codex-acp

## 1.7.0

### Minor Changes

- dcd2ae4: Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
  (5d40f74), which adds ChatGPT device-code authentication via URL elicitation (#347).

  This is a real upstream feature touching `CodexAcpClient` / `CodexAcpServer` / auth-method
  selection, not a mechanical lockfile bump — read the diff before merging. The new
  `chat-gpt-device-code` method is advertised only when the client supports URL elicitation, and
  the fork's no-fork-history test fixtures and package identity are preserved. Merged with a true
  merge commit (not squash) to keep the upstream-ancestry invariant the dependency gate checks.

- f9936cc: Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
  (61de42d): a provider-neutral ACP goal extension (#371) and the Codex 0.146.1 bump (#370).

  The goal extension is a real feature touching `CodexAcpServer`, `CodexEventHandler`, and the
  goal-snapshot plumbing, plus new test fixtures. Conflicts resolved in the fork's favor:
  `package.json` keeps fork version/description (upstream's `@openai/codex` `^0.146.1` bump is
  taken), and the package-level lockfile stays deleted. Merged with a true merge commit to keep
  the upstream-ancestry invariant.

### Patch Changes

- 0e4727e: Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
  (4bb290f): fix to resume paused goals through ACP control (#374). Small, focused fix touching
  `CodexAcpServer`, `GoalExtension`, and their tests. True merge commit preserves upstream
  ancestry.

## 1.6.15

### Patch Changes

- 193714b: Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
  (0ff2d55), which carries a transitive npm security bump and the Codex 0.146.0 update.

  No runtime source changed on our side: the merge only lands upstream's canonical key
  ordering in four `CodexACPAgent` test fixtures. The fork had already back-ported the
  `pluginId`/`scriptPath`/`id` keys at a different position, so git's line-based merge
  duplicated them inside the same object literals; resolved by taking upstream's file
  content for those fixtures. Key counts now match upstream and the merge base exactly.
  The fork's deliberate deletion of the package-level lockfile is preserved (the monorepo
  uses the root `pnpm-lock.yaml`), as are the fork's package identity and version.

## 1.6.14

### Patch Changes

- ec21260: Update `@openai/codex` to ^0.146.0, regenerate the app-server protocol types, and resync the fork with upstream `agentclientprotocol/codex-acp@efa3789` (v1.1.9 tip) via non-squashed subtree merge.

  Upstream changes folded in: ACP plan review confirmation flow gated on the client `plan` capability (#351), throttled plan update snapshots with a pre-completion flush, structured permission-change metadata on approval requests (#342), the flaky file-approval e2e fix (#352), and removal of the synthetic "Conversation interrupted" message (#358). Merge resolution keeps the canonical `CodexEventHandler(connection, sessionState, supportsPlanUpdates)` signature and threads the fork-owned client file reader as a trailing optional parameter.

  The 0.146.0 App Server surface is additive for this fork: `turn/start` (including the `outputSchema` patch channel) and `thread/start` are unchanged; new surface includes thread pinning (`Thread.isPinned`, list/metadata params), `commandExecution` plugin-script attribution (`pluginId`/`scriptPath`), `externalAgentConfig/import/recordHistory`, expanded `ConfigRequirements`, and remote skill icon URLs. Test fixtures updated for the new required fields.

## 1.6.13

### Patch Changes

- cf8ad1b: `@automatalabs/codex-acp` now lives in this monorepo at `packages/codex-acp` (#282) — imported from `VikashLoomba/codex-acp` with its full history as a non-squashed subtree, released through the ordinary Changesets train, with upstream containment (`agentclientprotocol/codex-acp`) enforced by the dependency gate as git ancestry against HEAD. `acp-agents` consumes it as a workspace dependency (published as an exact version); runtime behavior is unchanged.
