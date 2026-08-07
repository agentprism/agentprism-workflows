---
"@automatalabs/codex-acp": minor
---

Resync the fork with upstream `agentclientprotocol/codex-acp@145ebba` (v1.1.14 tip) via a
non-squashed subtree merge (4 commits), preserving upstream ancestry for the dependency gate.

Upstream changes folded in:

- **Codex runtime 0.146.1 → 0.147.0** (#375): regenerated the app-server protocol types. The
  0.147.0 surface is additive for this fork — `turn/start` (including the `outputSchema` patch
  channel) and `thread/start` are unchanged. Notable type churn: `Thread.isPinned` was replaced by
  `section: ThreadSection | null` + `sectionEnteredAt: number | null`, new `threadSection/*`
  methods and `ThreadSection*` params landed, and `McpStartupCompleteEvent` is no longer re-exported
  from the `app-server` barrel (import it directly).
- **Provider-neutral ACP goal replacement** (#376): `thread/goal/*` control can now replace an
  active goal through ACP, with per-session goal-control generations that suppress stale or
  duplicate continuations and start a turn when the app-server accepts a goal without routing one.
- **`fix: normalize cwd filters for Windows sessions`** (#377): a new `PathUtils` normalizer for
  `list-sessions` cwd filtering on Windows.
- Upstream release commit **v1.1.14**.

Merge resolution keeps the fork in its own favor where the two histories diverge: the fork version
line (`1.8.0`), description, and packaging metadata are retained (upstream's `1.1.14`/empty
description dropped); the npm `package-lock.json` stays removed (the fork is a workspace pnpm
package); and the fork-owned loaded-turn machinery (`pendingLoadNotifications`,
`loadedTurnUpdateChains`, the `ServerNotification` import) is preserved alongside upstream's new
`goalControlGenerations`. Upstream's corrected `McpStartupCompleteEvent` direct import is taken, and
the fork-owned `loaded-turn.test.ts` `Thread` fixture is migrated from `isPinned` to
`section`/`sectionEnteredAt` to match the 0.147.0 shape (mirroring upstream's own fixture fix). The
turn-level `outputSchema` forward — the reason this fork exists — is untouched.

Scored **minor**: the published package gains a backward-compatible ACP capability (goal
replacement control) plus the codex 0.147.0 runtime feature bump, consistent with how the goal
extension's introduction was versioned.
