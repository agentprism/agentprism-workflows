import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { context, fakeDeps } from "./helpers/fakes.js";

// Does a REAL pi session actually deliver `session_shutdown` to extensions when pi-acp closes it?
//
// Every other suite stubs `createAgentSession`, so the object pi-acp disposes has no
// ExtensionRunner and this question is unanswerable there — which is exactly how the leak stayed
// invisible. Here the real pi `createAgentSession` runs against an ISOLATED agent dir holding one
// fixture extension. That extension registers a `session_shutdown` handler that writes a file;
// the file existing after closeSession is proof that a real extension's cleanup hook ran.
//
// This is the regression test for the leak: an extension that spawns a process cleans it up in
// that handler. Before pi-acp emitted `session_shutdown`, the handler never fired, the process
// outlived the session, and — since pi is embedded IN-PROCESS — its ChildProcess handle kept the
// host's event loop alive forever.

function isolatedAgentDirWithShutdownProbe(): { agentDir: string; witness: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-shutdown-agentdir-"));
  const extensionDir = join(agentDir, "extensions");
  mkdirSync(extensionDir, { recursive: true });
  const witness = join(agentDir, "shutdown-witness.txt");
  // `on("session_shutdown")` is the only cleanup contract pi gives an extension: the Extension
  // interface has no dispose hook, just a handler map.
  writeFileSync(
    join(extensionDir, "01-shutdown-probe.ts"),
    `export default function (pi) {
       pi.on("session_shutdown", (event) => {
         require("node:fs").writeFileSync(${JSON.stringify(witness)}, event.reason ?? "no-reason");
       });
     }
    `,
  );
  return { agentDir, witness };
}

test("a real pi session delivers session_shutdown to extensions on close", async (t) => {
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const setup = fakeDeps();
  const { agentDir, witness } = isolatedAgentDirWithShutdownProbe();
  setup.deps.agentDir = agentDir;
  // The real factory — this is the whole point of the test.
  setup.deps.createAgentSession = createAgentSession;

  const { PiAcpAgent } = await import("../src/agent.js");
  const agent = new PiAcpAgent(setup.deps);

  let opened;
  try {
    opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  } catch (error) {
    // A real session needs a resolvable model. Where the environment cannot provide one, skip
    // rather than assert a false green — the leak this guards is real either way.
    await agent.dispose().catch(() => undefined);
    t.skip(`real pi session unavailable in this environment: ${(error as Error).message}`);
    return;
  }

  try {
    await agent.closeSession(context({ sessionId: opened.sessionId }));
    assert.equal(
      readFileSync(witness, "utf8"),
      "quit",
      "the extension's session_shutdown handler must have run, with the terminal reason",
    );
  } finally {
    await agent.dispose().catch(() => undefined);
  }
});
