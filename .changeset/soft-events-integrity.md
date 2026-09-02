---
"@automatalabs/mcp-server": patch
---

Stop advertising the events resource for integrity-unsafe runs. A run whose journal append faulted mid-run persists `eventLogIncomplete` and its event read/watch seam fails closed, so `eventsUri`, the labelled events resource link, `latestActivity`, and the events resource listing now omit it — matching the existing legacy/stream-less and durable-stop handling — while status, result, and the immutable snapshot stay available.
