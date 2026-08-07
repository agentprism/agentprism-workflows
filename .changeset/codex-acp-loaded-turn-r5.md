---
"@automatalabs/codex-acp": minor
---

The `_session/loaded_turn` extension's load-time watch is now the loaded turn's LIVE window, not just its terminal marker (phase-D review round 5):

- **Live post-load text is forwarded**: the load-time watcher forwards the loaded active turn's `item/agentMessage/delta` output to the ACP client as `agent_message_chunk` session updates (serialized per session, wire order preserved), exactly like the prompt handler forwards a running turn's deltas — the client's transcript accumulates the turn's REAL post-load text and the seam settles with that accumulated text at the ended notification, never the replay-time partial.
- **The load window never drops a completion**: a per-load notification buffer is installed before any `session/load` work (the subscription becomes live at `thread/resume`, but the watcher installs only after the load/auth/state work). A `turn/completed` (or a live delta) arriving in that window is buffered and replayed through the watcher AFTER the thread history streams — a completion discarded in that window previously left a `running` query permanently un-terminated.
- **Authoritative active-turn detection for `active` threads with an ended last turn**: a thread whose runtime status is `active` but whose loaded last turn reads `completed` answers `running`, and the watcher now recognizes the ACTUAL active turn's completion by ANY `turn/completed` on the session (its id is not in the stale turns list) — the old id filter watched the already-completed last turn's id and the running answer never terminated. The in-process handler's ended push applies the same match.
