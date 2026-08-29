---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/acp-agents": minor
"@automatalabs/workflows": minor
"@automatalabs/mcp-server": minor
---

Add an opt-in per-attempt idle watchdog that resets on real backend activity, cancels wedged turns through the existing wind-down path, retries with a fresh clock, and reports `AGENT_IDLE_TIMEOUT` distinctly across SDK, persistence, inspection, and MCP surfaces.
