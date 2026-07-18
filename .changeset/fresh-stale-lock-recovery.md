---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/acp-agents": minor
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---

Recover persisted pending and running workflows whose owning process has exited into an
interrupted, resumable pause during construction and cold lookups. Crash snapshots with a
journaled prefix use the `crash-residue` positional bridge when the admission environment is
stable, while environment drift keeps the run all-live.
