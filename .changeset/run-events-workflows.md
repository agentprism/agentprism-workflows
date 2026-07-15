---
"@automatalabs/workflows": minor
---

Export the exact ACP-specialized `WorkflowRunEvent` union, payload maps, and durable event
read/watch seam through the SDK facade. Typed manager events now expose nested `scope`, and
`agentEvent` repeats optional `callIndex` so hosts can correlate live ACP updates directly by
`(scope, callIndex)` while the existing `AgentEventPayload` compatibility alias remains available.
