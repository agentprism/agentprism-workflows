---
"@automatalabs/workflows": patch
---

Ensure the run-monitor panel is generated before the MCP entry bundle is built.

`@automatalabs/workflows` `build` bundles `../mcp-server/src/entry.ts` with esbuild, whose import
graph reaches the mcp-server run-monitor panel module. That module is now generated at build time
(no longer committed), so the `build` script first runs the shared, idempotent generator
(`scripts/ensure-run-monitor-html.mjs`) — the same one mcp-server's build invokes. This guarantees
the artifact exists when esbuild bundles it, in any package build order and in a fresh clone,
without introducing a package dependency edge (mcp-server already depends on workflows; the reverse
would be a cycle).

No user-facing behavior change: the emitted `dist/mcp-server.js` bundle and the served panel are
unchanged.
