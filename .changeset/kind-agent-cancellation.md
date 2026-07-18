---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---

Cancel one in-flight agent by call index without aborting its workflow run, settle ignored aborts
through an engine-owned latch, persist `AGENT_CANCELLED` visibility, and bypass retries while
completed siblings and resume replay continue normally.
