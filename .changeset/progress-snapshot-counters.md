---
"@automatalabs/workflow-engine": patch
---

Fix: `onProgress` snapshots now carry live derived counters. The manager's mutation sites only push/patch `snapshot.agents`, so `agentCount`/`runningCount`/`doneCount`/`errorCount` stayed frozen at their initial 0s and every consumer rendered "0/0 agents" for the whole run (the MCP shell was silently working around it by re-deriving counts from `agents[]`). The manager now recomputes the counters (via `recomputeWorkflowSnapshot`) before every emission.
