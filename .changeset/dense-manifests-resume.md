---
"@automatalabs/workflow-engine": patch
"@automatalabs/shared-types": patch
"@automatalabs/mcp-server": patch
"@automatalabs/workflows": patch
---

Persist terminal-shaped interruption rows for every allocated call when a run halts, and retain non-result identity blockers so completed calls remain safely replayable across usage, auth, checkpoint, and host interruptions.
