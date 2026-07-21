// Transparent ACP stdio proxy used only by the live continuation e2e. It removes the
// initialize-time session/resume advertisement while preserving session/load and every real Pi
// request/response. That forces the production runner's load fallback without mocking the agent.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [target, ...targetArgs] = process.argv.slice(2);
if (!target) throw new Error("usage: load-only-acp-proxy.mjs <ACP entry> [...args]");

const child = spawn(process.execPath, [target, ...targetArgs], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
const initializeIds = new Set();
const key = (id) => JSON.stringify(id);

const incoming = createInterface({ input: process.stdin, crlfDelay: Infinity });
incoming.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message?.method === "initialize" && message.id !== undefined) {
      initializeIds.add(key(message.id));
    }
  } catch {
    // Let the real server diagnose malformed input.
  }
  child.stdin.write(`${line}\n`);
});
incoming.on("close", () => child.stdin.end());

const outgoing = createInterface({ input: child.stdout, crlfDelay: Infinity });
outgoing.on("line", (line) => {
  let forwarded = line;
  try {
    const message = JSON.parse(line);
    const id = key(message?.id);
    if (initializeIds.delete(id) && message?.result?.agentCapabilities) {
      const sessions = message.result.agentCapabilities.sessionCapabilities;
      if (sessions && typeof sessions === "object") delete sessions.resume;
      message.result.agentCapabilities.loadSession = true;
      forwarded = JSON.stringify(message);
    }
  } catch {
    // Preserve non-JSON output byte-for-byte; the caller will surface a protocol failure.
  }
  process.stdout.write(`${forwarded}\n`);
});

child.once("error", (error) => {
  process.stderr.write(`load-only ACP proxy failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
