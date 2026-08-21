import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const WORKFLOWS_ROOT = resolve(import.meta.dirname, "..");
const WORKFLOWS_DIST_ENTRY = resolve(WORKFLOWS_ROOT, "dist/index.js");
const MCP_SOURCE_ENTRY = resolve(REPOSITORY_ROOT, "packages/mcp-server/src/index.ts");
// The bundle lives under the MCP server's OWN tree so the externalized
// `@automatalabs/*` imports resolve exactly like the published package's
// (the mcp-server node_modules links repl-engine, shared-types, and
// workflows — the workflows link is what keeps WORKFLOWS_DIST_ENTRY
// load-bearing).
const MCP_BUNDLE = resolve(REPOSITORY_ROOT, "packages/mcp-server/dist/mcp-server-bundle-smoke.js");
const MCP_PACKAGE = (await import("../../mcp-server/package.json", { with: { type: "json" } })).default;
// The PUBLISHED bundle: built by scripts/bundle-mcp-server.mjs into this package's dist, where a
// naive `require("../package.json")` would resolve THIS package's manifest.
const PUBLISHED_BUNDLE = resolve(WORKFLOWS_ROOT, "dist/mcp-server.js");
const WORKFLOWS_PACKAGE = (await import("../package.json", { with: { type: "json" } })).default;

interface JsonRpcFrame {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
}

before(async () => {
  assert.ok(
    existsSync(WORKFLOWS_DIST_ENTRY),
    "workflows dist/index.js must be built before the MCP bundle smoke test",
  );
  await build({
    entryPoints: [MCP_SOURCE_ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@automatalabs/*"],
    outfile: MCP_BUNDLE,
    logLevel: "silent",
  });
});

function request(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`;
}

test("the bundled stdio server initializes once and advertises the workflow tool", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "automatalabs-workflows-mcp-bundle-"));
  const child = spawn(process.execPath, [MCP_BUNDLE], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childDone = new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise());
    child.once("error", () => resolvePromise());
  });

  const frames: JsonRpcFrame[] = [];
  const waiters = new Set<() => void>();
  let stdoutBuffer = "";
  let stderr = "";
  let failure: Error | undefined;

  const notifyWaiters = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const setFailure = (error: Error) => {
    if (failure !== undefined) return;
    failure = error;
    notifyWaiters();
  };
  const waitForResponse = (id: number): Promise<JsonRpcFrame> =>
    new Promise((resolvePromise, rejectPromise) => {
      const inspect = () => {
        if (failure !== undefined) {
          waiters.delete(inspect);
          rejectPromise(failure);
          return;
        }
        const frame = frames.find((candidate) => candidate.id === id);
        if (frame !== undefined) {
          waiters.delete(inspect);
          resolvePromise(frame);
        }
      };
      waiters.add(inspect);
      inspect();
    });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length === 0) {
        setFailure(new Error("the MCP server wrote a blank stdout frame"));
        continue;
      }
      try {
        const parsed = JSON.parse(line) as JsonRpcFrame;
        if (parsed === null || typeof parsed !== "object") {
          throw new Error("frame is not a JSON object");
        }
        frames.push(parsed);
      } catch (error) {
        setFailure(
          new Error(
            `the MCP server wrote a non-JSON stdout frame: ${error instanceof Error ? error.message : String(error)}; line=${JSON.stringify(line)}`,
          ),
        );
      }
      notifyWaiters();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.once("error", (error) => setFailure(error));
  child.once("exit", (code, signal) => {
    if (failure === undefined) {
      setFailure(new Error(`the MCP server exited early (code=${code}, signal=${signal ?? "none"})`));
    }
  });

  const watchdog = setTimeout(() => {
    setFailure(new Error("timed out waiting for the MCP stdio handshake"));
  }, 20_000);

  try {
    child.stdin.write(
      request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "workflows-bundle-smoke", version: "0.0.0" },
      }),
    );
    const initialize = await waitForResponse(1);

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(request(2, "tools/list", {}));
    const toolsList = await waitForResponse(2);

    // Keep collecting briefly: a cli.ts bundle starts the server twice and can otherwise
    // pass if the test stops at the first matching response.
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 300));
    if (failure !== undefined) throw failure;

    const initializeResult = initialize.result as {
      serverInfo?: { name?: unknown; version?: unknown };
    };
    assert.equal(initializeResult.serverInfo?.name, "agentprism-workflow");
    assert.equal(initializeResult.serverInfo?.version, MCP_PACKAGE.version);

    const toolsResult = toolsList.result as { tools?: Array<{ name?: unknown }> };
    assert.ok(toolsResult.tools?.some((tool) => tool.name === "workflow"), "workflow tool was not advertised");
    // The workflow tool registers per-session in oninitialized (capability negotiation), so the
    // SDK legitimately emits notifications/tools/list_changed after initialize. Responses must
    // still be exactly one initialize and one tools/list — a double-started server would answer
    // each request twice — and every id-less frame must be that one notification kind.
    assert.deepEqual(
      frames.filter((frame) => frame.id !== undefined).map((frame) => frame.id),
      [1, 2],
      `expected exactly one initialize and one tools/list response; frames=${JSON.stringify(frames)}`,
    );
    for (const frame of frames.filter((candidate) => candidate.id === undefined)) {
      assert.equal(
        frame.method,
        "notifications/tools/list_changed",
        `unexpected server-initiated frame: ${JSON.stringify(frame)}`,
      );
    }
    assert.equal(stdoutBuffer, "", `incomplete stdout frame: ${JSON.stringify(stdoutBuffer)}`);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nMCP stderr:\n${stderr || "(empty)"}`,
      { cause: error },
    );
  } finally {
    clearTimeout(watchdog);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
    await childDone;
    clearTimeout(forceKill);
    rmSync(home, { recursive: true, force: true });
  }
});

test("the published dist/mcp-server.js reports the mcp-server package version as its identity, not the workflows version", { timeout: 30_000 }, () => {
  assert.ok(existsSync(PUBLISHED_BUNDLE), "workflows dist/mcp-server.js must be built (pnpm build) before this test");
  assert.notEqual(MCP_PACKAGE.version, WORKFLOWS_PACKAGE.version, "the two packages carry different versions — that is the point");
  // `daemon status` prints the CLIENT version (= SERVER_VERSION, the identity the daemon
  // succession compares) without starting anything; an isolated HOME sees no daemon.
  const home = mkdtempSync(join(tmpdir(), "agentprism-workflows-bundle-version-"));
  try {
    const result = spawnSync(process.execPath, [PUBLISHED_BUNDLE, "daemon", "status"], {
      env: { ...process.env, HOME: home },
      encoding: "utf-8",
      timeout: 20_000,
    });
    assert.match(result.stdout, new RegExp(`client v${MCP_PACKAGE.version.replace(/\./g, "\\.")}\\b`), result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(`client v${WORKFLOWS_PACKAGE.version.replace(/\./g, "\\.")}\\b`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
