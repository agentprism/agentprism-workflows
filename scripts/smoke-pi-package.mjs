#!/usr/bin/env node
// Exercise the actual published dependency list without workspace links or consumer overrides.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { packageManager } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const installRoot = mkdtempSync(join(tmpdir(), "agentprism-pi-package-"));
const env = { ...process.env };
delete env.NODE_PATH;
const command = (name) => process.platform === "win32" ? `${name}.cmd` : name;
const run = (name, args, cwd) => execFileSync(command(name), args, {
  cwd, env, stdio: "inherit", timeout: 180_000,
});

try {
  run("pnpm", ["--filter", "@automatalabs/pi-acp", "build"], repoRoot);
  run("pnpm", ["pack", "--pack-destination", installRoot], join(repoRoot, "packages/pi-acp"));
  const tarballs = readdirSync(installRoot).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = join(installRoot, tarballs[0]);

  for (const manager of ["npm", "pnpm"]) {
    const cwd = join(installRoot, manager);
    mkdirSync(cwd);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: `pi-package-smoke-${manager}`,
      private: true,
      type: "module",
      packageManager,
      dependencies: { "@automatalabs/pi-acp": `file:${tarball}` },
    }));
    run(manager, manager === "npm"
      ? ["install", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["install", "--ignore-scripts"], cwd);
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { PiAcpAgent, resolveDeps, runAcp } from "@automatalabs/pi-acp";
      for (const value of [PiAcpAgent, resolveDeps, runAcp]) {
        assert.equal(typeof value, "function");
      }
      console.log("Packed Pi SDK import passed (${manager})");
    `], { cwd, env, stdio: "inherit", timeout: 30_000 });
  }
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
