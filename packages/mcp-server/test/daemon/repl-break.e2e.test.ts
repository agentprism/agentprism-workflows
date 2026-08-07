// End-to-end over the BUILT dist: the out-of-band eval-break (phase-F
// review round 2) — the `repl` interrupt tool's no-id path delivered to
// a SYNCHRONOUSLY running eval. A never-yielding eval (`while (true) {}`)
// blocks the daemon's single thread, so the interrupt request itself
// cannot be processed; the daemon's eval-break relay (a worker thread,
// advertised in daemon.json) is the one path that can reach the running
// eval: the quickjs interrupt handler consumes the relay's shared-memory
// flag mid-execution and breaks the eval. Two delivery paths are pinned:
// the shim fires the relay automatically when it forwards a repl
// interrupt (the stdio path), and the relay endpoint works standalone
// (the direct-HTTP path — a host that fires it itself).
//
// Requires `pnpm build` first (spawns dist/entry.js --daemon-run).
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const distEntry = resolve(fileURLToPath(import.meta.url), "../../../dist/entry.js");
const e2eHome = mkdtempSync(join(tmpdir(), "agentprism-repl-break-e2e-"));
const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: e2eHome,
  AGENTPRISM_DAEMON_PORT: "0",
  // The deadline is the failure bound: a broken relay path must fail
  // the fast asserts below, not hang the suite for the default 30 s.
  AGENTPRISM_REPL_EVAL_TIMEOUT_MS: "20000",
  AGENTPRISM_SESSION_TTL_MS: "60000",
};

interface E2eDaemonInfo {
  pid: number;
  port: number;
  url: string;
  replBreakUrl?: string;
}

function readInfo(): E2eDaemonInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(e2eHome, ".agentprism", "workflows", "daemon.json"), "utf-8")) as E2eDaemonInfo;
  } catch {
    return undefined;
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

let daemon: ChildProcess | undefined;
let daemonInfo: E2eDaemonInfo | undefined;

async function startDaemon(): Promise<E2eDaemonInfo> {
  assert.equal(readInfo(), undefined, "expected a cold start");
  daemon = spawn(process.execPath, [distEntry, "--daemon-run"], {
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });
  daemon.unref();
  daemon.stderr?.on("data", () => undefined);
  await waitFor(() => readInfo() !== undefined && readInfo()!.replBreakUrl !== undefined, "daemon.json with replBreakUrl");
  daemonInfo = readInfo()!;
  return daemonInfo;
}

function replEvalCode(client: Client, projectDir: string, code: string): Promise<CallToolResult> {
  return client.callTool(
    { name: "repl", arguments: { action: "eval", projectDir, code } },
    undefined,
    { timeout: 60_000 },
  );
}

function replInterrupt(client: Client, projectDir: string): Promise<CallToolResult> {
  return client.callTool(
    { name: "repl", arguments: { action: "interrupt", projectDir } },
    undefined,
    { timeout: 60_000 },
  );
}

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("\n");
}

async function connectDirect(): Promise<Client> {
  const client = new Client({ name: "repl-break-e2e", version: "0.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(daemonInfo!.url));
  await client.connect(transport);
  return client;
}

async function connectShim(): Promise<Client> {
  const client = new Client({ name: "repl-break-e2e", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: childEnv,
    stderr: "ignore",
  });
  await client.connect(transport);
  return client;
}

test("the daemon advertises the eval-break relay and the direct relay path breaks a synchronous while(true) eval out of band", async () => {
  const info = await startDaemon();
  const projectDir = join(e2eHome, "direct-project");
  mkdirSync(projectDir, { recursive: true });
  const client = await connectDirect();
  try {
    // Warm the workspace (the relay's slot registers at first touch).
    const warm = await replEvalCode(client, projectDir, "6 * 7");
    assert.ok(textOf(warm).includes("result: 42"), textOf(warm));
    // The synchronous runaway: the eval request cannot be processed by
    // the daemon (its main thread is wedged in the VM).
    const startedAt = Date.now();
    const runaway = replEvalCode(client, projectDir, "while (true) {}");
    // Give the daemon a moment to enter the eval, then fire the relay —
    // the out-of-band delivery: the worker thread arms the shared flag,
    // and the running eval's quickjs interrupt handler consumes it
    // mid-execution (the arm-after-start rule: the eval was already
    // running when the break arrived).
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    const breakResponse = await fetch(`${info.replBreakUrl}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: projectDir }),
    });
    assert.equal(breakResponse.status, 204, "the relay armed the break");
    const result = await runaway;
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 8000, `the eval broke out of band, not at the 20 s deadline: ${elapsed} ms`);
    const text = textOf(result);
    assert.ok(text.includes("interrupted") || text.includes("error"), `the eval reports the break: ${text}`);
    // The workspace stays usable.
    const after = await replEvalCode(client, projectDir, "40 + 2");
    assert.ok(textOf(after).includes("result: 42"), textOf(after));
    await client.close().catch(() => undefined);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("the shim fires the relay automatically: a repl interrupt through stdio breaks the synchronous eval and reports the out-of-band outcome", async () => {
  const projectDir = join(e2eHome, "shim-project");
  mkdirSync(projectDir, { recursive: true });
  const client = await connectShim();
  try {
    const warm = await replEvalCode(client, projectDir, "6 * 7");
    assert.ok(textOf(warm).includes("result: 42"), textOf(warm));
    const startedAt = Date.now();
    const runaway = replEvalCode(client, projectDir, "while (true) {}");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    // The interrupt tool call: the shim fires the relay BEFORE
    // forwarding — while the daemon is blocked — so the eval breaks
    // mid-run, and the daemon's own processing (once unblocked) reports
    // the honest out-of-band outcome.
    const interrupt = await replInterrupt(client, projectDir);
    const text = textOf(interrupt);
    assert.ok(
      text.includes("out of band") || text.includes("out-of-band") || text.includes("broken OUT OF BAND"),
      `the interrupt reports the out-of-band break: ${text}`,
    );
    const structured = (interrupt.structuredContent ?? {}) as { interrupt?: { outcome?: string } };
    assert.equal(structured.interrupt?.outcome, "targeted", JSON.stringify(structured));
    const elapsed = Date.now() - startedAt;
    const result = await runaway;
    const evalText = textOf(result);
    assert.ok(evalText.includes("interrupted") || evalText.includes("error"), `the eval reports the break: ${evalText}`);
    // The workspace stays usable, and a later no-id interrupt with
    // nothing running REFUSES (no stale break ever reaches a later
    // eval).
    const after = await replEvalCode(client, projectDir, "40 + 2");
    assert.ok(textOf(after).includes("result: 42"), textOf(after));
    const idle = await replInterrupt(client, projectDir);
    const idleStructured = (idle.structuredContent ?? {}) as { interrupt?: { outcome?: string } };
    assert.equal(idleStructured.interrupt?.outcome, "refused-idle", JSON.stringify(idleStructured));
    await client.close().catch(() => undefined);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("a stale relay break never breaks a later eval (the arm-after-start rule end to end)", async () => {
  const projectDir = join(e2eHome, "stale-project");
  mkdirSync(projectDir, { recursive: true });
  const client = await connectShim();
  try {
    const warm = await replEvalCode(client, projectDir, "6 * 7");
    assert.ok(textOf(warm).includes("result: 42"), textOf(warm));
    // Arm the relay while the workspace is IDLE (nothing running), then
    // run a fresh eval: the stale flag must be consumed-and-dropped by
    // the first execution — the fresh eval runs to completion.
    const breakResponse = await fetch(`${daemonInfo!.replBreakUrl}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: projectDir }),
    });
    assert.equal(breakResponse.status, 204);
    const result = await replEvalCode(client, projectDir, "41 + 1");
    assert.ok(textOf(result).includes("result: 42"), `the stale break did not touch the fresh eval: ${textOf(result)}`);
    await client.close().catch(() => undefined);
  } finally {
    await client.close().catch(() => undefined);
  }
});

process.on("exit", () => {
  if (daemon !== undefined && daemon.pid !== undefined) {
    try {
      process.kill(daemon.pid, "SIGKILL");
    } catch {
      /* best-effort */
    }
  }
  spawnSync(process.execPath, [distEntry, "daemon", "stop"], { env: childEnv });
  rmSync(e2eHome, { recursive: true, force: true });
});

test.after(() => {
  // The test runner exits only when the loop drains: tear down the
  // daemon's stdio handles (an unref'd child still holds its pipes) and
  // any shim-spawned daemon before the runner finishes.
  daemon?.stderr?.destroy();
  daemon?.stdout?.destroy();
  if (daemon !== undefined && daemon.pid !== undefined) {
    try {
      process.kill(daemon.pid, "SIGKILL");
    } catch {
      /* best-effort */
    }
  }
  spawnSync(process.execPath, [distEntry, "daemon", "stop"], { env: childEnv });
});
