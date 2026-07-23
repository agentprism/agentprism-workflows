---
"@automatalabs/mcp-server": minor
---

Add an MCP Apps run-monitor panel to the `workflow` tool. The tool now declares
`_meta.ui.resourceUri` (with the legacy `ui/resourceUri` mirror) and the server advertises
the `io.modelcontextprotocol/ui` extension in its capabilities, so MCP Apps-capable hosts
render a live panel for workflow calls: a phase/agent graph with per-node log drill-in,
live token/cost totals, and a Stop control. The panel (React,
`@modelcontextprotocol/ext-apps/react`) derives the runId from the call arguments
(inspect/await/stop) or the execute result (immediately for background admissions) and keeps
itself current by polling the new app-only `workflow-events` cursor tool
(`visibility: ["app"]`), which shares its page builder with the
`workflow://runs/{runId}/events` resource; that document now also carries `workflowName`.
Hosts without MCP Apps support ignore the UI metadata and keep the exact text/structured
output as before.
