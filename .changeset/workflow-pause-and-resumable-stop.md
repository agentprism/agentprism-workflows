---
"@automatalabs/mcp-server": major
"@automatalabs/workflow-engine": major
"@automatalabs/shared-types": minor
"@automatalabs/workflows": minor
---

Stopped runs resume, and a `pause` action drains executing work before pausing. A stopped (`aborted`) run is no longer terminal for continuation: `resume` replays its journal and re-runs the interrupted calls. `WorkflowManager.pause(runId)` now requests a pause instead of interrupting: agent calls already executing finish and journal, nothing new is admitted, queued calls settle as interrupted rows, and the run pauses with `reason: "requested"` (new `WorkflowErrorCode.PAUSE_REQUESTED` and `paused` event reason). The MCP `workflow` tool gains `action: "pause"`, routed to the live execution owner like agent cancellation, answering `pauseRequested`/`paused` after a bounded wait for executing agents.
