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

/** An agent dir whose one extension spawns a child and kills it on `session_shutdown`. */
function agentDirSpawningAChild(): { agentDir: string; pidFile: string } {
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
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       // The ONLY cleanup contract pi gives an extension. If pi-acp never emits it, this never
       // runs and the child outlives the session.
       pi.on("session_shutdown", () => { try { child.kill("SIGKILL"); } catch {} });
     }
    `,
  );
  return { agentDir, pidFile };
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

    pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0, "the extension must have spawned a child");
    assert.equal(isAlive(pid), true, "the child must be running while the session is open");

    await agent.closeSession(context({ sessionId: opened.sessionId }));

    assert.equal(
      await waitForExit(pid),
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
