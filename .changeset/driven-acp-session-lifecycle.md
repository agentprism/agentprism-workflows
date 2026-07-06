---
"@automatalabs/acp-agents": minor
"@automatalabs/workflows": minor
---

Add driven ACP session lifecycle wrappers for listing, deleting, loading, and resuming sessions. Reattached sessions return live `InteractiveSession`s, accumulate replayed load history, adopt response modes/config options, and route permissions through the normal session router.

Guard raw passthrough for session-stateful methods that would create or reopen unregistered sessions (`session/new`, `session/load`, `session/resume`, `session/fork`) and add the protocol coverage tier `guarded`.
