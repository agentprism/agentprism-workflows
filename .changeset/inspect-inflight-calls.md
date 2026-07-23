---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/mcp-server": minor
---

Inspection of a live run now surfaces its in-flight agent calls. `projectWorkflowRunStatus`
previously built `calls` from the resume journal (settled calls only) plus terminal failed
agents, so `workflow` `action:"inspect"` reported "recent calls (0 of 0 matching)" while
agents were actively running. Queued/running agents without a journal row are now projected
with a new optional `WorkflowRunCallStatus.status` field (`"queued" | "running"`, present
only while the call is in flight — settled rows are unchanged), gated on the run itself
being pending/running so stale persisted agent rows on dead runs cannot appear as phantom
in-flight calls. The MCP inspection text renders these as `(running)`/`(queued)` in place
of a result preview.
