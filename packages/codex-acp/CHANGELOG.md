# @automatalabs/codex-acp

## 1.8.0

### Minor Changes

- 2e4bb60: The `_session/loaded_turn` extension's load-time watch is now the loaded turn's LIVE window, not just its terminal marker (phase-D review round 5):

  - **Live post-load text is forwarded**: the load-time watcher forwards the loaded active turn's `item/agentMessage/delta` output to the ACP client as `agent_message_chunk` session updates (serialized per session, wire order preserved), exactly like the prompt handler forwards a running turn's deltas — the client's transcript accumulates the turn's REAL post-load text and the seam settles with that accumulated text at the ended notification, never the replay-time partial.
  - **The load window never drops a completion**: a per-load notification buffer is installed before any `session/load` work (the subscription becomes live at `thread/resume`, but the watcher installs only after the load/auth/state work). A `turn/completed` (or a live delta) arriving in that window is buffered and replayed through the watcher AFTER the thread history streams — a completion discarded in that window previously left a `running` query permanently un-terminated.
  - **Authoritative active-turn detection for `active` threads with an ended last turn**: a thread whose runtime status is `active` but whose loaded last turn reads `completed` answers `running`, and the watcher now recognizes the ACTUAL active turn's completion by ANY `turn/completed` on the session (its id is not in the stale turns list) — the old id filter watched the already-completed last turn's id and the running answer never terminated. The in-process handler's ended push applies the same match.

- 142a23e: The `_session/loaded_turn/ended` push is ORDERED behind the session's pending delta updates (phase-D review round 6): the load-time watcher pushed the terminal marker synchronously while `forwardLoadedTurnDelta` delivered the turn's final chunks asynchronously through the per-session update chain — a `turn/completed` arriving back-to-back with the final live delta reached the ACP client first, and the re-attach seam durably settled PARTIAL text. The push now rides the same per-session chain (the load-time watcher, the recorded-ended push after a query, and the in-process event handler's push when a prompt subscription replaced the watcher), so every delta enqueued before the turn's completion reaches the client before the terminal marker.
- bd28cd9: The `_session/loaded_turn` vendor extension (the `_session/steering` precedent): turn-TERMINAL state for loaded sessions — the re-attach arm's authoritative completion evidence. Advertised at initialize as `_meta: { steering: { supported: true }, loadedTurn: { supported: true } }`. `_session/loaded_turn/query { sessionId }` answers whether the loaded session's founding turn is still running right now: `running` while a turn executes in-process (`currentTurnId` set — the query arms a one-shot watch that pushes `_session/loaded_turn/ended { sessionId, stopReason? | error? }` when that turn completes, with the ACP stop reason for completed/interrupted turns or the turn's error for failed ones), `completed` when the loaded thread's last turn status is `completed` (the replayed final message is the founding turn's FINAL message — authoritative), and `interrupted` for `inProgress`/`interrupted`/`failed` last turns (nothing is running — re-issue is safe). The thread's last turn status is captured on the session state at `session/load`; the ended push is emitted from the codex event handler's `turn/completed` path.
- bcede5b: REPL orchestrator phase F, review round 3 — the full-repo verification's carried defects, all closed:

  - **ACP freshness gate green**: the `packages/codex-acp` subtree is re-synced with upstream `agentclientprotocol/codex-acp@main` (ea57892 — the goal-extension `resume` action and the v1.1.11–1.1.13 releases) via a true non-squashed merge commit; the fork's `package.json` version line wins, the package lockfile stays deleted, and the imported upstream head is recorded in the attribution allowlist.
  - **The observation path's replay classification is restricted to the verified built-ins** (acp-agents): a CUSTOM backend's quiet observation window is not terminal evidence — its connection-death behavior is not live-verified — so its loaded session stays attached and the seam waits for the authoritative terminal state (the re-armable still-running rejection) instead of settling stale/partial replay or re-issuing a possibly-running call.
  - **Non-re-armable seam rejections are never re-invoked** (repl-engine): the broker kept recursing into a seam that rejects with `LoadedTurnStillRunningError` and `rearmable: false`, spinning in an unbounded microtask/warning loop that starved cancellation, drain, and every other task. The broker now keeps the loaded session attached and waits for the terminal state from the session-level `_session/loaded_turn/ended` surface, the call's cancel (settled as the recoverable `AGENT_CANCELLED`), the session's release (the safe-re-issue class), or the drain's forced stop.
  - **The interrupt is implemented in the in-process/library mode too** (mcp-server): the single-project server now owns an eval-break channel by default and exposes its relay (`replBreakUrl()`); the stdio transport's stdin reader lives on a worker thread that fires the relay for no-id `repl` interrupts, so a synchronous `while(true)` eval is breakable mid-run exactly like in daemon mode. The relay keys are realpath'd on every fire side (shim and in-process reader), so symlinked or non-normalized projectDirs interrupt correctly.
  - **Break targeting has no clock-resolution window** (repl-engine): the eval-break channel now orders arms against execution starts on a shared monotonic arm-sequence counter instead of millisecond `Date.now()` stamps — a break arriving in the same millisecond as the execution start is delivered, never consumed as stale and lost. The channel's slots also GROW on demand (no fixed workspace ceiling) and are released on broker teardown for reuse.
  - **The structured-output cap's continuation refs are cumulative, namespaced, and never evicted** (mcp-server): repeated halving of one field chains every dropped chunk into the advertised ref (earlier tails stay addressable); ref ids carry the workspace's project key so a ref from one project can never resolve in another's store; the store retains every ref until `reset` (which now clears it); and the `wait` result variant accepts `referenced` (the handler attached it, the validator forbade it).
  - Documentation and the phase-F changeset re-worded: the `repl-engine` dependency line and the shipped-tool status are stated as they are, and the changeset no longer carries the banned marker strings.

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
