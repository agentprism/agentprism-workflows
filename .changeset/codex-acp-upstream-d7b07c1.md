---
"@automatalabs/codex-acp": patch
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `d7b07c1`).

- Update the wrapped `@openai/codex` runtime to 0.155.0 and regenerate the app-server protocol types. The protocol gains the `thread/attachment/*` requests and a `thread/attachment/updated` notification; the adapter explicitly ignores that notification because persisted attachment metadata has no ACP session-update counterpart, and it does not call the new requests. `FeedbackUploadResponse` and the server-notification unions change only in generated types.
- Codex 0.155.0 itself changes no surface the fork owns (turn-level `outputSchema` forwarding, the goal extension, `_session/loaded_turn`): accepted prompts now persist when compaction fails before a turn starts, automatic approval reviews retry transient failures, and account switches invalidate the previous identity's cached model catalog. The merge was conflict-free and the fork's suite passes unchanged.
