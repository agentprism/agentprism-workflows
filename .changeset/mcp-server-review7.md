---
"@automatalabs/mcp-server": minor
---

REPL orchestrator phase D, review round 7: daemon shutdown is bounded end to end — the teardown after a failed or deadline-expired client-presence drain races the remaining shutdown bound instead of hanging on the hung backend the drain already caught.

- `WorkflowProjectRegistry.disposeReplStates(boundMs?)` now spans ONE deadline across each workspace's drain AND its broker teardown: a drain that fails or consumes the whole bound leaves the teardown only the remaining time, and an expired deadline skips straight to the disposal's bookkeeping clear. A failed teardown is contained (the persistence failure was already loud from the drain; the disk keeps the last good snapshot).
- `disposeReplProjectState` and `resetReplProjectState` pass a bound through to the broker's bounded disposal (default: the daemon's shutdown deadline), so the `reset` tool cannot hang on a hung backend either.
