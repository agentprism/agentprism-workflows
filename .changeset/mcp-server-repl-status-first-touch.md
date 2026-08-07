---
"@automatalabs/mcp-server": minor
---

The `repl` tool's `status {projectDir}` action is now a first touch exactly like the stateful actions (phase-D review round 5): it creates the project's REPL state, marks the client present, and runs the restore path before rendering — so on a fresh daemon whose project already has a stored snapshot, the FIRST repl call may be `status {projectDir}` and still restore the VM, run the three-way reconciliation (settle from the store / re-attach via `session/load` / re-issue), surface a hash-mismatch or version refusal loudly, and return the workspace manifest (bindings with provenance, task, and wall-clock, live agents, logs, pending calls). The projectDir-less list form stays lightweight (no first touch).
