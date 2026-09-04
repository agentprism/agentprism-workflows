#!/usr/bin/env node
// Keep the checked-in authoring-skill bundle synchronized whenever either published package that
// consumes the MCP server source is built. @automatalabs/workflows bundles that source directly,
// so both its build and @automatalabs/mcp-server's build invoke this cheap ensure step before tsc or
// esbuild. The explicit `pnpm generate:authoring-skills` command remains useful for intentional
// regeneration, but a normal `pnpm build` cannot silently ship stale skill bytes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAuthoringSkillsBundle,
  renderAuthoringSkillsModule,
} from "./generate-authoring-skills.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(
  repoRoot,
  "packages",
  "mcp-server",
  "src",
  "generated",
  "authoring-skills-content.ts",
);
const rendered = renderAuthoringSkillsModule(buildAuthoringSkillsBundle());
const current = existsSync(outFile) ? readFileSync(outFile, "utf8") : undefined;

if (current === rendered) {
  console.log("ensure-authoring-skills: generated bundle is up to date — nothing to build.");
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, rendered);
  console.log(`ensure-authoring-skills: wrote ${outFile} (${Buffer.byteLength(rendered, "utf8")} bytes)`);
}
