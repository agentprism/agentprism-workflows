// End-to-end over the BUILT dist: the OUT-OF-BAND eval-break in the
// SINGLE-PROJECT (in-process) stdio mode (phase-F review round 3 — the
// reviewer: the public in-process/library server omitted the channel,
// so its event loop could not process a no-id interrupt during a
// synchronous `while(true)`; the documented interrupt behavior must be
// implemented in every supported mode, and it is not a v1 exclusion).
//
// The in-process server has no shim process, so its stdio transport's
// stdin reader lives on a WORKER THREAD (`repl-stdio-transport.ts`):
// the reader stays live while the main thread is wedged in the VM,
// recognizes `repl` interrupt calls, and fires the server's own
// eval-break relay (a second worker thread) — the running eval's
// quickjs interrupt handler consumes the shared-memory flag mid-run.
// The relay key is realpath'd exactly like the daemon's project
// validation (a symlinked projectDir must still interrupt).
//
// Requires `pnpm build` first (spawns dist/entry.js --in-process).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const distEntry = resolve(fileURLToPath(import.meta.url), "../../dist/entry.js");

const TEST_TMP = mkdtempSync(join(tmpdir(), "agentprism-repl-inprocess-"));
let server: ChildProcess | undefined;

function startServer(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry, "--in-process"],
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      // The failure bound: a broken relay path must fail the fast
      // asserts below, not hang the suite for the default 30 s.
      AGENTPRISM_REPL_EVAL_TIMEOUT_MS: "20000",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "repl-inprocess-e2e", version: "0.0.0" }, { capabilities: {} });
  server = (transport as unknown as { _process: ChildProcess })._process;
  return client.connect(transport).then(() => client);
}

function replEvalCode(client: Client, projectDir: string, code: string): Promise<CallToolResult> {
  return client.callTool(
    { name: "repl", arguments: { action: "eval", projectDir, code } },
    undefined,
    { timeout: 60_000 },
  );
}

function replEvalNoDir(client: Client, code: string): Promise<CallToolResult> {
  return client.callTool({ name: "repl", arguments: { action: "eval", code } }, undefined, {
    timeout: 60_000,
  });
}

function replInterruptNoDir(client: Client): Promise<CallToolResult> {
  return client.callTool({ name: "repl", arguments: { action: "interrupt" } }, undefined, {
    timeout: 60_000,
  });
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

test("the in-process stdio server's worker-reader fires the relay: a no-id interrupt breaks a synchronous while(true) eval out of band and the workspace stays usable", async () => {
  const home = mkdtempSync(join(TEST_TMP, "home-"));
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  const client = await startServer(home);
  try {
    const warm = await replEvalCode(client, projectDir, "6 * 7");
    assert.ok(textOf(warm).includes("result: 42"), textOf(warm));
    const startedAt = Date.now();
    const runaway = replEvalCode(client, projectDir, "while (true) {}");
    // Give the server a moment to enter the eval, then send the
    // interrupt: the transport's worker-reader — the only stdin reader,
    // live while the main thread is wedged in the VM — fires the
    // server's eval-break relay before forwarding the frame, and the
    // running eval's quickjs interrupt handler breaks mid-run.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    const interrupt = await replInterrupt(client, projectDir);
    const interruptText = textOf(interrupt);
    assert.ok(
      interruptText.includes("out of band") ||
        interruptText.includes("out-of-band") ||
        interruptText.includes("broken OUT OF BAND"),
      `the interrupt reports the out-of-band break: ${interruptText}`,
    );
    const structured = (interrupt.structuredContent ?? {}) as { interrupt?: { outcome?: string } };
    assert.equal(structured.interrupt?.outcome, "targeted", JSON.stringify(structured));
    const result = await runaway;
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 8000, `the eval broke out of band, not at the 20 s deadline: ${elapsed} ms`);
    const text = textOf(result);
    assert.ok(text.includes("interrupted") || text.includes("error"), `the eval reports the break: ${text}`);
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

test("the OMITTED-projectDir interrupt fires the relay with the server's own project key: the documented optional projectDir works for a synchronous runaway (phase-F review round 4: the relay used to skip the omitted-projectDir interrupt, so the eval ran to the per-eval deadline and the interrupt reported refused-idle)", async () => {
  const home = mkdtempSync(join(TEST_TMP, "home-nodir-"));
  const client = await startServer(home);
  try {
    // No projectDir anywhere: the repl tool resolves the server's own
    // adopted project (its cwd), and the reader worker's relay fires
    // under the SAME key (the transport's default project key).
    const warm = await replEvalNoDir(client, "6 * 7");
    assert.ok(textOf(warm).includes("result: 42"), textOf(warm));
    const startedAt = Date.now();
    const runaway = replEvalNoDir(client, "while (true) {}");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    const interrupt = await replInterruptNoDir(client);
    const interruptText = textOf(interrupt);
    assert.ok(
      interruptText.includes("out of band") ||
        interruptText.includes("out-of-band") ||
        interruptText.includes("broken OUT OF BAND"),
      `the interrupt reports the out-of-band break: ${interruptText}`,
    );
    const structured = (interrupt.structuredContent ?? {}) as { interrupt?: { outcome?: string } };
    assert.equal(structured.interrupt?.outcome, "targeted", JSON.stringify(structured));
    const result = await runaway;
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 8000, `the eval broke out of band, not at the 20 s deadline: ${elapsed} ms`);
    const text = textOf(result);
    assert.ok(text.includes("interrupted") || text.includes("error"), `the eval reports the break: ${text}`);
    // The default workspace stays usable, and an idle no-dir interrupt
    // refuses (no stale break ever reaches a later eval).
    const after = await replEvalNoDir(client, "40 + 2");
    assert.ok(textOf(after).includes("result: 42"), textOf(after));
    const idle = await replInterruptNoDir(client);
    const idleStructured = (idle.structuredContent ?? {}) as { interrupt?: { outcome?: string } };
    assert.equal(idleStructured.interrupt?.outcome, "refused-idle", JSON.stringify(idleStructured));
    await client.close().catch(() => undefined);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("the relay key is the CANONICAL projectDir: an interrupt through a symlink breaks the running eval (phase-F review round 3: the raw path used to get a relay 404)", async () => {  const home = mkdtempSync(join(TEST_TMP, "home-sym-"));
  const realDir = join(home, "real-project");
  const symDir = join(home, "linked-project");
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, symDir, "dir");
  const client = await startServer(home);
  try {
    const warm = await replEvalCode(client, symDir, "6 * 7");
    assert.ok(textOf(warm).includes("result: 42"), textOf(warm));
    const startedAt = Date.now();
    const runaway = replEvalCode(client, symDir, "while (true) {}");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    // The interrupt is addressed through the SYMLINK; the reader
    // worker realpaths it before arming the relay, exactly like the
    // daemon's project validation — the eval must break out of band.
    const interrupt = await replInterrupt(client, symDir);
    const structured = (interrupt.structuredContent ?? {}) as { interrupt?: { outcome?: string } };
    assert.equal(structured.interrupt?.outcome, "targeted", JSON.stringify(structured));
    const result = await runaway;
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 8000, `the symlink-addressed eval broke out of band: ${elapsed} ms`);
    assert.ok(
      textOf(result).includes("interrupted") || textOf(result).includes("error"),
      `the eval reports the break: ${textOf(result)}`,
    );
    await client.close().catch(() => undefined);
  } finally {
    await client.close().catch(() => undefined);
  }
});

process.on("exit", () => {
  if (server !== undefined && server.pid !== undefined) {
    try {
      process.kill(server.pid, "SIGKILL");
    } catch {
      /* best-effort */
    }
  }
  try {
    rmSync(TEST_TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
