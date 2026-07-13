#!/usr/bin/env node
// Dedicated executable entry — the package `bin` target. Starts the stdio server
// unconditionally, like the MCP reference servers: no entry-point heuristics that can
// fail under npm/pnpm bin shims. Library consumers import ./index.js instead.
import { main } from "./index.js";

main().catch((error: unknown) => {
  console.error("[agentprism-workflow] fatal error during startup:", error);
  process.exitCode = 1;
});
