---
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---
Run-monitor panel rebuilt on the MCP Apps negotiation model: UI-enabled registration
(the panel resource, the workflow tool's UI metadata, and the app-only workflow-events
tool) now requires the client to advertise the io.modelcontextprotocol/ui extension
capability; all other clients get the identical text-only workflow tool. The panel
updates itself by polling the app-only workflow-events tool (the spec's Interactive
Updates pattern) and informs the model via ui/message for exactly three event families:
phase changes, pauses (permission/attention needed), and terminal states.
