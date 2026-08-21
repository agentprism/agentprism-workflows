#!/usr/bin/env node
/**
 * Bundle the MCP server entry (../mcp-server/src/entry.ts) into dist/mcp-server.js.
 *
 * The bundle embeds mcp-server's SOURCE, so its `require("../package.json")` would resolve THIS
 * package's manifest and report the workflows version as the server's identity — and the daemon
 * succession logic compares that identity across clients. Two distributions of the same server
 * code (this bundle and @automatalabs/mcp-server) must agree, so the mcp-server package version is
 * baked in at build time via `__AGENTPRISM_MCP_SERVER_VERSION__`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const workflowsRoot = resolve(here, "..");
const mcpServerRoot = resolve(workflowsRoot, "../mcp-server");
const mcpServerPkg = JSON.parse(readFileSync(resolve(mcpServerRoot, "package.json"), "utf-8"));
if (typeof mcpServerPkg.version !== "string" || mcpServerPkg.version.length === 0) {
  throw new Error(`cannot read the mcp-server package version from ${mcpServerRoot}/package.json`);
}

await build({
  entryPoints: [resolve(mcpServerRoot, "src/entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@automatalabs/*"],
  outfile: resolve(workflowsRoot, "dist/mcp-server.js"),
  define: { __AGENTPRISM_MCP_SERVER_VERSION__: JSON.stringify(mcpServerPkg.version) },
  logLevel: "warning",
});
