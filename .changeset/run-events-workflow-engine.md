---
"@automatalabs/workflow-engine": minor
---

Add typed manager event overloads and the lease-owned durable run-event stream: a new per-run
`.events.jsonl` sidecar, mandatory write-time redaction and record bounds, listener delivery after
durable append, nested `scope` fields, stream-generation-pinned read/watch cursors, fail-closed
incomplete-log handling, and lease-protected deletion with no post-delete durable resurrection.

`stop()` on a warm paused run now reacquires and revalidates the lease-protected snapshot, so it can
return `false` when a competing process already resumed the run. Post-release execution settlement
also no longer rewrites the snapshot, preventing stale settlement from clobbering a newer owner.
