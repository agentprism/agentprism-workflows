---
"@automatalabs/shared-types": major
"@automatalabs/workflow-engine": major
"@automatalabs/acp-agents": major
"@automatalabs/workflows": major
"@automatalabs/mcp-server": major
---

Remove model-facing agent execution timeout fields, idle-watchdog callbacks, and timeout error codes from the shared runtime contract.

Remove total-wall and idle agent timers from workflow execution while preserving explicit call and run cancellation and compatibility reads for historical timeout records.

Remove the ACP runner activity/interaction callbacks that existed only to drive the engine idle watchdog.

Remove agent execution limits and configurable config-probe timing from the workflow SDK surface.

Remove agent and probe timeout inputs and timeout projections from the MCP workflow tool schema and status output.
