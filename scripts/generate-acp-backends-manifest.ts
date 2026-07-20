#!/usr/bin/env tsx
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_BACKENDS,
  BUILTIN_BACKEND_IDS,
} from "../packages/acp-agents/src/backends/builtins.js";

const nodeFloorPattern = /^>=(0|[1-9]\d*)(?:\.(0|[1-9]\d*)\.(0|[1-9]\d*))?$/;

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scriptRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = argumentValue("--repo-root")
  ? resolve(argumentValue("--repo-root")!)
  : scriptRepoRoot;
const defaultManifestPath = join(repoRoot, "scripts", "acp-backends.manifest.json");
const manifestPath = argumentValue("--manifest")
  ? resolve(argumentValue("--manifest")!)
  : defaultManifestPath;
const checkOnly = process.argv.includes("--check");

const backends = BUILTIN_BACKEND_IDS.map((id) => {
  const definition = BUILTIN_BACKENDS[id];
  validateDefinition(id, definition.release);
  return {
    id,
    engine: definition.release.engine,
    server: definition.release.server,
    freshness: definition.release.freshness,
  };
});

const canonical = `${JSON.stringify({ schemaVersion: 1, backends }, null, 2)}\n`;

if (checkOnly) {
  let committed: string;
  try {
    committed = readFileSync(manifestPath, "utf8");
  } catch (error) {
    fail(`${manifestPath}: cannot read manifest (${errorMessage(error)})`);
  }
  if (committed! !== canonical) {
    fail(
      `${manifestPath}: generated backend manifest is stale; run pnpm generate:acp-backends-manifest`,
    );
  }
} else {
  writeFileSync(manifestPath, canonical, "utf8");
}

function validateDefinition(
  id: string,
  release: (typeof BUILTIN_BACKENDS)[keyof typeof BUILTIN_BACKENDS]["release"],
): void {
  if (!nodeFloorPattern.test(release.engine.node)) {
    fail(`backend ${id} engine.node is not a canonical minimum Node floor`);
  }
  const npm = new Set(release.freshness.npm);
  if (release.server.kind === "npm-package" && !npm.has(release.server.package)) {
    fail(`backend ${id} server.package must appear in freshness.npm`);
  }
  for (const fork of release.freshness.forks) {
    if (!npm.has(fork.package)) {
      fail(`backend ${id} freshness.forks package ${fork.package} must appear in freshness.npm`);
    }
  }
  for (const wrapped of release.freshness.wrappedRuntimes) {
    if (!npm.has(wrapped.adapterPackage)) {
      fail(
        `backend ${id} freshness.wrappedRuntimes adapter ${wrapped.adapterPackage} must appear in freshness.npm`,
      );
    }
  }

  const source = engineSource(release.server);
  if (source.floor !== release.engine.node) {
    fail(
      `backend ${id} engine.node ${release.engine.node} differs from ${source.path} engines.node ${source.floor}`,
    );
  }

  if (release.server.kind === "npm-package") {
    const installed = installedPackageJson(release.server.package);
    const installedFloor = installed.engines?.node;
    if (installedFloor !== undefined && installedFloor !== release.engine.node) {
      fail(
        `backend ${id} engine.node ${release.engine.node} differs from installed ${release.server.package} engines.node ${installedFloor}`,
      );
    }
  }
}

function engineSource(
  server: (typeof BUILTIN_BACKENDS)[keyof typeof BUILTIN_BACKENDS]["release"]["server"],
): { path: string; floor: string } {
  const relative = server.kind === "workspace-package"
    ? join(server.path, "package.json")
    : join("packages", "acp-agents", "package.json");
  const manifest = readJson(join(repoRoot, relative));
  const floor = manifest.engines?.node;
  if (typeof floor !== "string" || floor.length === 0) {
    fail(`${relative}: engines.node is required for backend engine provenance`);
  }
  if (server.kind === "workspace-package" && manifest.name !== server.package) {
    fail(
      `${relative}: package name ${String(manifest.name)} differs from workspace server ${server.package}`,
    );
  }
  return { path: relative, floor: floor! };
}

function installedPackageJson(packageName: string): Record<string, any> {
  const requireFromPackage = createRequire(
    join(repoRoot, "packages", "acp-agents", "package.json"),
  );
  let path: string;
  try {
    path = requireFromPackage.resolve(`${packageName}/package.json`);
  } catch (error) {
    fail(`installed ${packageName} package.json cannot be resolved (${errorMessage(error)})`);
  }
  return readJson(path!);
}

function readJson(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path}: cannot parse JSON (${errorMessage(error)})`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  console.error(`acp-backends-manifest: ${message}`);
  process.exit(1);
}
