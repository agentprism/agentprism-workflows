---
"@automatalabs/codex-acp": minor
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `6ec22f3`).

- Implement the agent side of the experimental ACP session-compaction RFD (#515), gated on the client advertising `clientCapabilities.session.compaction`: for those clients, automatic compaction and `/compact` emit `session/update` notifications with `sessionUpdate: "compaction_update"` keyed by Codex's `contextCompaction` item id (`in_progress` → `completed`, or `failed`/`cancelled` when the turn ends first), duplicate completion signals including the legacy `thread/compacted` notification are suppressed, loaded sessions replay persisted compactions in history position, and `/compact` now reports the compaction turn's start and completion. Clients that do not opt in keep the existing synthetic tool-call and text fallback unchanged; AgentPrism does not advertise the capability, so its update stream is unaffected.
- Native subagent bookkeeping now records the closing state of child sessions and closes every child when the root turn ends non-completed, and a timed-out subagent wait finishes outstanding subagents as failed.
- The fork-owned client-backed file reader and `_session/loaded_turn` ended-push scheduler were re-merged behind upstream's new `supportsCompaction` constructor parameter, keeping upstream call sites positionally compatible, and re-verified against the fork's 724-test suite.
