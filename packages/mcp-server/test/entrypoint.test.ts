import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = resolve(fileURLToPath(import.meta.url), "../../dist");

const initializeRequest =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "entrypoint-test", version: "0.0.0" },
    },
  }) + "\n";

// The in-process server touches ~/.agentprism at run time; keep spawned children away from
// the developer's real home.
const isolatedHome = mkdtempSync(join(tmpdir(), "agentprism-entrypoint-home-"));

/** Spawn `node <entryPath> [...args]`, send an initialize request over stdio, and return the
 *  first JSON-RPC response line (or reject if the process exits without answering). */
function initializeViaStdio(entryPath: string, args: string[] = []): Promise<{ id: number; result?: unknown }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: isolatedHome },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("timed out waiting for the initialize response"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      child.kill();
      resolvePromise(JSON.parse(stdout.slice(0, newline)) as { id: number; result?: unknown });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (stdout.includes("\n")) return;
      clearTimeout(timer);
      rejectPromise(
        new Error(`server exited (code ${code}) before the initialize response; stderr: ${stderr}`),
      );
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.stdin.write(initializeRequest);
  });
}

// The `bin` entry (dist/cli.js) dispatches unconditionally — exercised here with
// --in-process (the daemon shim path has its own e2e suite); dist/index.js stays runnable
// for the documented direct-path registration. Both must also answer when invoked THROUGH A
// SYMLINK: npm/pnpm expose bins as node_modules/.bin symlinks, and Node realpath-resolves
// the ESM entry module while argv[1] stays the shim path — an entry guard comparing raw
// paths skips main() and MCP clients report "connection closed: initialize response".
for (const { entry, args } of [
  { entry: "cli.js", args: ["--in-process"] },
  { entry: "index.js", args: [] as string[] },
]) {
  const entryPath = join(distDir, entry);

  test(`dist/${entry} answers initialize when invoked directly`, async () => {
    const response = await initializeViaStdio(entryPath, args);
    assert.equal(response.id, 1);
    assert.ok(response.result, "expected an initialize result");
  });

  test(`dist/${entry} answers initialize when invoked through a bin-shim symlink`, async () => {
    const shimDir = mkdtempSync(join(tmpdir(), "agentprism-bin-shim-"));
    const shimPath = join(shimDir, "agentprism-workflow");
    symlinkSync(entryPath, shimPath);
    try {
      const response = await initializeViaStdio(shimPath, args);
      assert.equal(response.id, 1);
      assert.ok(response.result, "expected an initialize result");
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
}
