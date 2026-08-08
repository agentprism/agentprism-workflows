---
"@automatalabs/mcp-server": patch
---

Generate the run-monitor MCP App panel at build time instead of committing it.

`packages/mcp-server/src/generated/run-monitor-html.ts` (the Vite single-file build of the
`ui://` run-monitor panel, exported as `RUN_MONITOR_HTML`) is no longer checked in — it is a build
product, now gitignored and produced by a single shared, idempotent generator
(`scripts/ensure-run-monitor-html.mjs`). The package's `build`, `test`, `typecheck`, and
`prepublishOnly` scripts each run the generator first, and the root `postinstall` runs it too, so a
pristine checkout, a cold `test`/`typecheck`, and the publish path all get a correct artifact with
no manual `build:ui` step. The generator rebuilds only when the UI sources change (content-hash
staleness check) and no-ops otherwise. `build:ui` remains as a force-rebuild convenience.

No user-facing behavior change: the served resource content and its `ui://agentprism-workflow/run-monitor.html`
URI are unchanged. This removes a staleness footgun where the committed panel could drift from the
UI sources because nothing in the build, publish, or CI paths regenerated it.
