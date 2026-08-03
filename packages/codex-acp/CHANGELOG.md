# @automatalabs/codex-acp

## 1.6.14

### Patch Changes

- ec21260: Update `@openai/codex` to ^0.146.0, regenerate the app-server protocol types, and resync the fork with upstream `agentclientprotocol/codex-acp@efa3789` (v1.1.9 tip) via non-squashed subtree merge.

  Upstream changes folded in: ACP plan review confirmation flow gated on the client `plan` capability (#351), throttled plan update snapshots with a pre-completion flush, structured permission-change metadata on approval requests (#342), the flaky file-approval e2e fix (#352), and removal of the synthetic "Conversation interrupted" message (#358). Merge resolution keeps the canonical `CodexEventHandler(connection, sessionState, supportsPlanUpdates)` signature and threads the fork-owned client file reader as a trailing optional parameter.

  The 0.146.0 App Server surface is additive for this fork: `turn/start` (including the `outputSchema` patch channel) and `thread/start` are unchanged; new surface includes thread pinning (`Thread.isPinned`, list/metadata params), `commandExecution` plugin-script attribution (`pluginId`/`scriptPath`), `externalAgentConfig/import/recordHistory`, expanded `ConfigRequirements`, and remote skill icon URLs. Test fixtures updated for the new required fields.

## 1.6.13

### Patch Changes

- cf8ad1b: `@automatalabs/codex-acp` now lives in this monorepo at `packages/codex-acp` (#282) — imported from `VikashLoomba/codex-acp` with its full history as a non-squashed subtree, released through the ordinary Changesets train, with upstream containment (`agentclientprotocol/codex-acp`) enforced by the dependency gate as git ancestry against HEAD. `acp-agents` consumes it as a workspace dependency (published as an exact version); runtime behavior is unchanged.
