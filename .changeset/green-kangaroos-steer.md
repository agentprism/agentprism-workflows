---
"@automatalabs/acp-agents": minor
"@automatalabs/pi-acp": minor
"@automatalabs/workflows": minor
---

Add first-class, capability-negotiated steering for held-open ACP sessions. Claude, Codex, and Pi
support native `_session/steering`; OpenCode rejects it with a typed validation error. Expose the
privacy-safe steering event through the workflows facade. Pi steering is codex-shaped: a live turn
gets the content injected natively; an idle session (or a steer that races the end of a turn) runs
it as a fire-and-forget `startedNewTurn` turn instead of erroring or leaking it into the next
prompt; a steer racing a cancel resolves `failed` and never restarts cancelled generation.
