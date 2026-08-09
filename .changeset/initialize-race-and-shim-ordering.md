---
"@automatalabs/mcp-server": patch
"@automatalabs/workflows": patch
---

Fix a race that could leave a freshly connected client with no `workflow` tool.

Registration was gated on `notifications/initialized`, but a notification carries no
ordering guarantee against the requests that follow it — and over the stdio shim each
frame becomes its own HTTP POST to the daemon. A client that pipelined `initialized` with
its first `tools/list` or `tools/call` could reach a server with nothing registered,
surfacing as an empty tool list or a tool-not-found result on the first call.

The `workflow` tool is now registered at server construction, so it exists for the whole
life of the session. Capability negotiation is unchanged for the MCP Apps surface: the
panel resource, the app-only `workflow-events` tool, and the tool's UI metadata are still
added only for a client that advertised `io.modelcontextprotocol/ui`, and the resulting
`tools/list_changed` prompts a capable client to re-list.

The shim now also forwards client frames in the order they were sent; previously each
frame was dispatched without sequencing, so consecutive frames could race as concurrent
POSTs and arrive out of order.
