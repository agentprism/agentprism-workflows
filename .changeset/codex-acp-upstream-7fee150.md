---
"@automatalabs/codex-acp": minor
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `7fee150`), bringing codex 0.156.1 and upstream 1.13.0–1.13.1.

- **Session modes.** `read-only` is now a true read-only sandbox (approval required to edit files or reach the network). The previous behavior of that id — edit workspace files, ask before writing outside it or using the network — moves to a new `workspace-write` mode. `agent` (the default AgentPrism selects) keeps its behavior under the label "Auto review". A workflow that pinned codex `read-only` to allow workspace edits must switch to `workspace-write`; the example triage workflows only review, so the stricter mode fits them unchanged.
- **ACP v1 conformance.** Resume, load, and delete work on a session that was created but never prompted; `session/load` waits for an in-flight title generation so a late `session_info_update` cannot follow the load response; a `session/cancel` that lands before Codex registers the turn is retried instead of dropped, so the turn answers `cancelled` rather than `end_turn`.
- **Terminal output** prefers `terminal_output_delta` when the client supports it.
- **Session notices.** Codex advisories are sent as experimental `notice` updates only to clients that advertise `session.notices`; AgentPrism does not, so its update stream is unchanged.
- **Fork fix.** Loading a session again after it had already run a prompt replaced the session's notification handler with the load-time watcher, and the next prompt's subscription never re-registered — that prompt's events (and later session-scoped notices) reached only the watcher, so the prompt could not observe its own completion. The load-time watcher now drops the stale prompt subscription so the next prompt re-registers. Upstream's new session-notices replay test covers the path.
