---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/acp-agents": minor
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---

Enforce run-level agent timeouts as unbypassable total-wall-clock ceilings per attempt, with
per-call deadlines only able to tighten them and every retry receiving a fresh clock. Persist and
report resolved timeout limits and failures, and close/recycle ACP children that ignore
cancellation.
