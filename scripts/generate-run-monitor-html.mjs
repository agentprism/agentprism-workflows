#!/usr/bin/env node
// Embeds the Vite single-file build of the run-monitor MCP App
// (packages/mcp-server/ui -> ui/dist/run-monitor.html) into
// packages/mcp-server/src/generated/run-monitor-html.ts, so the published server ships the
// panel as a plain TS constant (no runtime fs reads, works identically from src via tsx and
// from dist). Run the Vite build first: pnpm --filter @automatalabs/mcp-server build:ui
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlFile = join(repoRoot, "packages", "mcp-server", "ui", "dist", "run-monitor.html");
const outFile = join(repoRoot, "packages", "mcp-server", "src", "generated", "run-monitor-html.ts");

const html = readFileSync(htmlFile, "utf8");
if (!html.includes("<script")) {
  throw new Error("generate-run-monitor-html: built HTML has no inline script — single-file build failed?");
}

const content =
  `// GENERATED FILE — do not edit by hand.\n` +
  `// Source of truth: packages/mcp-server/ui/ (Vite single-file build).\n` +
  `// Regenerate: pnpm --filter @automatalabs/mcp-server build:ui\n` +
  `export const RUN_MONITOR_HTML: string = ${JSON.stringify(html)};\n`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, content);
console.log(`generate-run-monitor-html: wrote ${outFile} (${content.length} bytes)`);
