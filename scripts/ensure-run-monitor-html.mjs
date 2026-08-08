#!/usr/bin/env node
// Single, shared, idempotent generator for the run-monitor MCP App panel.
//
// WHAT IT PRODUCES. packages/mcp-server/src/generated/run-monitor-html.ts — a plain TS module
// exporting `RUN_MONITOR_HTML` (the Vite single-file build of packages/mcp-server/ui/, inlined as
// one self-contained HTML document). app-ui.ts imports it and serves it as the
// ui://agentprism-workflow/run-monitor.html resource. The file is NOT committed (it is gitignored):
// it is a build product, regenerated from the UI sources so it can never go stale behind a human's
// memory.
//
// WHY IT IS SHARED. Two packages need this artifact present in the mcp-server SOURCE tree before
// they can build, and either may build first in a fresh clone:
//   - @automatalabs/mcp-server `build` (tsc -b) type-checks app-ui.ts, which imports the module.
//   - @automatalabs/workflows `build` BUNDLES ../mcp-server/src/entry.ts with esbuild, whose import
//     graph reaches app-ui.ts -> this module. A dependency edge that would force an order cannot be
//     added (mcp-server already depends on workflows; the reverse would be a cycle). So instead BOTH
//     package build scripts (and the test/typecheck/prepublish paths, and the root postinstall) call
//     THIS script first. Whichever runs first generates the artifact; the rest see a fresh file and
//     no-op. Order-independent, cycle-free.
//
// STALENESS. Cheap when nothing changed: it hashes every UI source input (packages/mcp-server/ui/**,
// minus dist/ and node_modules/) plus the UI toolchain versions and this generator's FORMAT_VERSION,
// and stores that hash in a `// source-hash:` header line of the generated file. A run whose recomputed
// hash matches the header (and the file exists) is a no-op. A missing file or changed inputs trigger a
// Vite rebuild + re-embed. Pass `--force` to always rebuild (used by the `build:ui` convenience script).
//
// SOFT MODE (`--soft`, used by the root postinstall). Best-effort: if the UI toolchain is not installed
// (e.g. a --prod install with no devDependencies) or the UI sources are absent, it warns and exits 0
// rather than failing `pnpm install`. In the default STRICT mode (every build/test/typecheck/prepublish
// path) it must produce the artifact or exit 1 with an actionable message — never leave a cryptic
// module-not-found for a consuming tsc/esbuild/test to hit.
//
// Node built-ins + Vite only.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Bump when the embedding/header format changes so every checkout regenerates on next build.
const FORMAT_VERSION = "2";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mcpServerDir = join(repoRoot, "packages", "mcp-server");
const uiDir = join(mcpServerDir, "ui");
const builtHtmlFile = join(uiDir, "dist", "run-monitor.html");
const outFile = join(mcpServerDir, "src", "generated", "run-monitor-html.ts");
const mcpServerPkgFile = join(mcpServerDir, "package.json");

const argv = new Set(process.argv.slice(2));
const FORCE = argv.has("--force");
const SOFT = argv.has("--soft");

const TAG = "ensure-run-monitor-html";
function log(message) {
  console.error(`${TAG}: ${message}`);
}
function fail(message) {
  if (SOFT) {
    log(`SKIP (soft mode): ${message}`);
    process.exit(0);
  }
  console.error(`${TAG}: ${message}`);
  process.exit(1);
}

// ---- collect UI source inputs (recursive; skip build output + installed deps) --------------------
function collectInputs(dir) {
  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  return files;
}

// ---- toolchain versions (a Vite/plugin/React bump can change output without touching UI src) -----
function toolchainVersions() {
  const keys = ["vite", "@vitejs/plugin-react", "vite-plugin-singlefile", "react", "react-dom"];
  let dev = {};
  try {
    const pkg = JSON.parse(readFileSync(mcpServerPkgFile, "utf8"));
    dev = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    // If the manifest can't be read the source walk still fails below in strict mode.
  }
  const out = {};
  for (const key of keys) out[key] = dev[key] ?? null;
  return out;
}

// ---- compute the expected source hash ------------------------------------------------------------
function computeSourceHash() {
  const inputs = collectInputs(uiDir);
  if (inputs.length === 0) {
    fail(`no UI sources found under ${uiDir} — is this a full checkout?`);
  }
  const manifest = createHash("sha256");
  manifest.update(`format:${FORMAT_VERSION}\n`);
  manifest.update(`toolchain:${JSON.stringify(toolchainVersions())}\n`);
  for (const file of inputs) {
    const rel = relative(uiDir, file).split(sep).join("/");
    const bytes = readFileSync(file);
    manifest.update(`${rel}:${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return manifest.digest("hex");
}

// ---- read the stored hash from the generated file header -----------------------------------------
function storedHash() {
  if (!existsSync(outFile)) return null;
  try {
    const head = readFileSync(outFile, "utf8").slice(0, 2048);
    const match = head.match(/\/\/ source-hash: ([0-9a-f]{64})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ---- resolve the Vite CLI robustly across pnpm hoisting layouts ----------------------------------
function resolveViteBin() {
  const req = createRequire(import.meta.url);
  const paths = [mcpServerDir, uiDir, repoRoot];
  try {
    const pkgPath = req.resolve("vite/package.json", { paths });
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vite;
    if (binRel) return join(dirname(pkgPath), binRel);
  } catch {
    // fall through to the direct-bin probe
  }
  try {
    return req.resolve("vite/bin/vite.js", { paths });
  } catch {
    return null;
  }
}

// ---- regenerate: Vite single-file build, then embed ----------------------------------------------
function regenerate(hash) {
  const viteBin = resolveViteBin();
  if (!viteBin) {
    fail(
      `cannot resolve the Vite CLI from ${mcpServerDir} — install workspace dependencies first ` +
        `(\`pnpm install\`), then re-run. The run-monitor panel is built from ` +
        `packages/mcp-server/ui/ and cannot be produced without Vite.`,
    );
  }
  log("UI sources changed or artifact missing — building the run-monitor panel with Vite...");
  // Mirror the historical `vite build ui` run from the mcp-server package dir (root = ./ui).
  const result = spawnSync(process.execPath, [viteBin, "build", "ui"], {
    cwd: mcpServerDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(
      `Vite build failed (exit ${result.status ?? "signal " + result.signal}) — the run-monitor panel ` +
        `could not be generated from packages/mcp-server/ui/.`,
    );
  }
  let html;
  try {
    html = readFileSync(builtHtmlFile, "utf8");
  } catch {
    fail(`Vite reported success but ${builtHtmlFile} is missing — single-file build layout changed?`);
  }
  if (!html.includes("<script")) {
    fail("built HTML has no inline script — the Vite single-file build did not inline the app.");
  }
  const content =
    `// GENERATED FILE — DO NOT EDIT BY HAND, and DO NOT COMMIT (this path is gitignored).\n` +
    `// Source of truth: packages/mcp-server/ui/ (Vite single-file build).\n` +
    `// Produced automatically by scripts/ensure-run-monitor-html.mjs, which every build, test,\n` +
    `// typecheck, and prepublish path — plus the root \`postinstall\` — invokes; it rebuilds only\n` +
    `// when the UI sources change. To force a rebuild: pnpm --filter @automatalabs/mcp-server build:ui\n` +
    `// source-hash: ${hash}\n` +
    `export const RUN_MONITOR_HTML: string = ${JSON.stringify(html)};\n`;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, content);
  log(`wrote ${relative(repoRoot, outFile)} (${content.length} bytes)`);
}

// ---- main ----------------------------------------------------------------------------------------
const expected = computeSourceHash();
if (!FORCE && existsSync(outFile) && storedHash() === expected) {
  log("run-monitor panel is up to date — nothing to build.");
  process.exit(0);
}
regenerate(expected);
