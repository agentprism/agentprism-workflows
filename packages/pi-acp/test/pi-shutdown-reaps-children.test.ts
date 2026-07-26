import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { context, fakeDeps } from "./helpers/fakes.js";

// THE ACTUAL LEAK, end to end: does a process an extension spawned get REAPED when pi-acp closes
// the session?
//
// pi-shutdown-real-session.test.ts proves the `session_shutdown` handler runs. That is a weaker
// claim — a handler firing is not a process dying, and the leak was always about surviving
// processes. This test spawns a real long-lived child from a real extension, then asserts the PID
// is gone after closeSession. Without the fix the handler never runs, so the child survives the
// session; embedded in-process that is precisely the ChildProcess handle that kept the host's
// event loop alive and stopped pi-acp from ever exiting.

const ALIVE_SECONDS = 300;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 probes existence without delivering anything
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

/**
 * An agent dir whose one extension spawns a child and kills it on `session_shutdown`.
 *
 * `handlerDelayMs` makes that handler asynchronous. Real extensions do async teardown (closing
 * sockets, flushing, awaiting a graceful child exit), and `emit()` returning a promise is only
 * useful if the caller awaits it — a fire-and-forget emit would let disposal race ahead and the
 * process would survive anyway. Each session appends its child's pid, so a run that opens several
 * sessions can assert every one of them was reaped rather than just the last.
 */
function agentDirSpawningAChild(handlerDelayMs = 0): { agentDir: string; pidFile: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-reap-agentdir-"));
  const extensionDir = join(agentDir, "extensions");
  mkdirSync(extensionDir, { recursive: true });
  const pidFile = join(agentDir, "child.pid");
  writeFileSync(
    join(extensionDir, "01-spawns-a-child.ts"),
    `export default function (pi) {
       const { spawn } = require("node:child_process");
       const fs = require("node:fs");
       const child = spawn("sleep", ["${ALIVE_SECONDS}"], { stdio: "ignore" });
       child.unref();
       fs.appendFileSync(${JSON.stringify(pidFile)}, String(child.pid) + "\\n");
       // The ONLY cleanup contract pi gives an extension. If pi-acp never emits it, this never
       // runs and the child outlives the session.
       pi.on("session_shutdown", async () => {
         ${handlerDelayMs > 0 ? `await new Promise((r) => setTimeout(r, ${handlerDelayMs}));` : ""}
         try { child.kill("SIGKILL"); } catch {}
       });
     }
    `,
  );
  return { agentDir, pidFile };
}

function pidsFrom(pidFile: string): number[] {
  return readFileSync(pidFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line.trim()));
}

test("closing a session reaps a process an extension spawned", async (t) => {
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const setup = fakeDeps();
  const { agentDir, pidFile } = agentDirSpawningAChild();
  setup.deps.agentDir = agentDir;
  setup.deps.createAgentSession = createAgentSession; // the real thing

  const { PiAcpAgent } = await import("../src/agent.js");
  const agent = new PiAcpAgent(setup.deps);
  let pid: number | undefined;

  try {
    let opened;
    try {
      opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
    } catch (error) {
      t.skip(`real pi session unavailable in this environment: ${(error as Error).message}`);
      return;
    }

    pid = pidsFrom(pidFile)[0];
    assert.ok(pid !== undefined && Number.isInteger(pid) && pid > 0, "the extension must have spawned a child");
    assert.equal(isAlive(pid!), true, "the child must be running while the session is open");

    await agent.closeSession(context({ sessionId: opened.sessionId }));

    assert.equal(
      await waitForExit(pid!),
      true,
      "the extension's child must be gone once the session is closed — a surviving process is the leak",
    );
  } finally {
    if (pid !== undefined && isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await agent.dispose().catch(() => undefined);
  }
});

// `emit()` returns a promise; shutdownPiSession awaits it. If it did not, an extension doing async
// teardown would still be mid-cleanup when dispose() ran and its child would survive — the leak,
// just with an extra step. This pins the await.
test("an asynchronous session_shutdown handler still gets its child reaped", async (t) => {
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const setup = fakeDeps();
  const { agentDir, pidFile } = agentDirSpawningAChild(250);
  setup.deps.agentDir = agentDir;
  setup.deps.createAgentSession = createAgentSession;

  const { PiAcpAgent } = await import("../src/agent.js");
  const agent = new PiAcpAgent(setup.deps);
  let pid: number | undefined;
  try {
    let opened;
    try {
      opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
    } catch (error) {
      t.skip(`real pi session unavailable: ${(error as Error).message}`);
      return;
    }
    pid = pidsFrom(pidFile)[0];
    assert.equal(isAlive(pid!), true);
    await agent.closeSession(context({ sessionId: opened.sessionId }));
    assert.equal(await waitForExit(pid!), true,
      "disposal must await the handler, not race past it");
  } finally {
    if (pid !== undefined && isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await agent.dispose().catch(() => undefined);
  }
});

// The production shape this bug actually threatened: one long-lived pi-acp process serving many
// sessions (pooling, parallel pi agents). Each session loads the extensions afresh and spawns its
// own child, so a per-session leak accumulates for the lifetime of the process. Reaping one
// session's child proves nothing about the fifth.
test("many sessions in one process leave no children behind", async (t) => {
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const setup = fakeDeps();
  const { agentDir, pidFile } = agentDirSpawningAChild();
  setup.deps.agentDir = agentDir;
  setup.deps.createAgentSession = createAgentSession;

  const { PiAcpAgent } = await import("../src/agent.js");
  const agent = new PiAcpAgent(setup.deps);
  const SESSIONS = 5;
  let pids: number[] = [];
  try {
    for (let index = 0; index < SESSIONS; index += 1) {
      let opened;
      try {
        opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
      } catch (error) {
        if (index === 0) { t.skip(`real pi session unavailable: ${(error as Error).message}`); return; }
        throw error;
      }
      await agent.closeSession(context({ sessionId: opened.sessionId }));
    }
    pids = pidsFrom(pidFile);
    assert.equal(pids.length, SESSIONS, "each session should have spawned its own child");
    const survivors: number[] = [];
    for (const pid of pids) {
      if (!(await waitForExit(pid))) survivors.push(pid);
    }
    assert.deepEqual(survivors, [], `children accumulated across sessions: ${survivors.join(", ")}`);
  } finally {
    for (const pid of pids) {
      if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
    await agent.dispose().catch(() => undefined);
  }
});
