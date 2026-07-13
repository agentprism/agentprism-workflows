---
"@automatalabs/mcp-server": patch
---

Fix the `agentprism-workflow` executable exiting before the MCP initialize response when launched through an npm/pnpm bin shim (`npx @automatalabs/mcp-server` from Codex CLI or any MCP host reported "connection closed: initialize response"). The package bin now points at a dedicated `dist/cli.js` that starts the stdio server unconditionally, matching the MCP reference-server layout; `dist/index.js` remains runnable for documented direct-path registrations, with its entry-point guard made symlink-safe via realpath.
