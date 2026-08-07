---
"@automatalabs/mcp-server": minor
---

REPL orchestrator phase-E review fixes (daemon/tool side):

- **Interrupt breaks the RUNNING eval**: `interrupt` without an id is now described and exercised as interrupting the in-flight eval — the armed signal is consumed by the running eval's execution (a suspended eval's continuation is broken by the quickjs interrupt handler when it runs; a later eval is unaffected), while a synchronous top-level runaway stays bounded by the per-eval deadline (the daemon is single-threaded; the deadline makes a currently-running runaway always breakable).
- **Connection-open presence**: the session registry now signals `onConnectionOpened` (and `onSessionDeleted`) alongside `onLastConnectionClosed`, and the daemon wires them to the REPL presence ledger. The ledger RETAINS a session's project affinity across a transient last-connection drop, so a reconnect of the SAME live session re-adds its presence without a new tool call — the already-scheduled drain aborts and children stay warm while the client is connected. A session deletion drops the affinity (a re-initialized client carries a new session id).
- **Reset keeps presence**: `reset` no longer clears the project's client set — presence is connection liveness, not workspace state, and clearing it desynced the state from the ledger (a resetting client's later disconnect could drain post-reset work while another project client was still connected). The drain decision reads the ledger's own per-project set.
- **Output caps on the FINAL result**: the doc's 256-line / 10 KB caps (whichever trips first) now apply to the assembled tool result — console lines, the result line, pending ids, checkpoints, completed ids, the wait timeout note, and status output — with a truncation marker that always ships (its budget reserved inside the caps). Metadata-heavy results are capped too.
