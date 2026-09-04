---
"@automatalabs/mcp-server": major
"@automatalabs/workflows": major
---

Only elicit workflow agent configuration for calls whose effective model is unresolved. This replaces the previous MCP policy of asking users to reselect every call, including explicitly configured calls. The standalone MCP server and the SDK's bundled MCP entry now preserve explicit and inherited models, backend-only specs, and their authored mode/config values. Omitted optional mode/config fields do not trigger a form.

Mixed workflows ask only about unresolved calls, then validate and persist a complete configuration snapshot for strict admission and same-ID continuation. Existing admitted runs retain their recorded configuration. Standalone SDK routing is unchanged. To request a provider/model choice for a new MCP run, leave that call's effective model unresolved instead of supplying an initial selection for the user to override.
