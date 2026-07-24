#!/usr/bin/env node
// Dedicated executable entry — the package `bin` target. Routes through the argv
// dispatcher unconditionally (no entry-point heuristics that can fail under npm/pnpm bin
// shims): default is the daemon shim, `--in-process` restores the single-process stdio
// server, `daemon <cmd>` manages the daemon. Library consumers import ./index.js instead.
import { dispatch } from "./entry.js";

dispatch(process.argv.slice(2)).catch((error: unknown) => {
  console.error("[agentprism-workflow] fatal error during startup:", error);
  process.exitCode = 1;
});
