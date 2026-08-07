---
"@automatalabs/codex-acp": minor
---

The `_session/loaded_turn/ended` push is ORDERED behind the session's pending delta updates (phase-D review round 6): the load-time watcher pushed the terminal marker synchronously while `forwardLoadedTurnDelta` delivered the turn's final chunks asynchronously through the per-session update chain — a `turn/completed` arriving back-to-back with the final live delta reached the ACP client first, and the re-attach seam durably settled PARTIAL text. The push now rides the same per-session chain (the load-time watcher, the recorded-ended push after a query, and the in-process event handler's push when a prompt subscription replaced the watcher), so every delta enqueued before the turn's completion reaches the client before the terminal marker.
