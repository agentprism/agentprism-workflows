---
"@automatalabs/pi-acp": minor
---

The `_session/loaded_turn/ended` push is ORDERED behind the session's update pump (phase-D review round 6): a turn's final deltas are only enqueued (the pump delivers them asynchronously), and the ended notification was sent synchronously at turn finish — the terminal marker could reach the ACP client before the last chunk, and the re-attach seam settles with the accumulated text at the marker, durably recording PARTIAL output. The push now awaits the update pump (best-effort) before notifying, so the turn's final text always precedes its terminal marker on the wire.
