---
"@automatalabs/mcp-server": major
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
---

Record where each run's script lives and expose it as a `file://` MCP resource. An inline script is copied into the run store as `<runId>.script.js` beside the run record; a `scriptPath` run records the caller's path and exposes that file. The `workflow://runs/{runId}/script` resource is removed; run, resume, status, and outcome responses carry `scriptUri` (a `file://` URI) and `scriptPath`. Resource reads are confined to files some persisted run recorded, and deleting a run removes its store copy without touching a caller's file. The engine persists `scriptOrigin` on run state and `RunPersistence` gains optional `scriptLocation`, `writeInlineScript`, `discardInlineScript`, and `readScript` seams.
