#!/usr/bin/env node
/**
 * Argv dispatch for every packaged entry (the published bundle and the bin):
 *
 *   (default)                  stdio shim — auto-starts the daemon, proxies stdio↔HTTP
 *   --in-process               the pre-daemon behavior: serve MCP over stdio in-process
 *   --daemon-run [--port n] [--supersede]   the daemon itself (what the shim spawns, detached)
 *   daemon <start|stop|status|url|run|logs>   daemon management commands
 *
 * The shim spawns the daemon from this same file (realpath of argv[1]), so one artifact is
 * simultaneously the client-facing command and the daemon executable.
 */
import "./entry-mode.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runDaemonCommand } from "./daemon/commands.js";
import { runDaemon } from "./daemon/run-daemon.js";
import { runShim } from "./shim/shim.js";
import { main } from "./index.js";

export * from "./index.js";
export { createDaemon, DaemonPortInUseError } from "./daemon/http-daemon.js";
export type { CreateDaemonOptions, DaemonHandle } from "./daemon/http-daemon.js";
export { runDaemon } from "./daemon/run-daemon.js";
export { runShim } from "./shim/shim.js";
export { ensureDaemonRunning } from "./shim/ensure-daemon.js";
export { BoundedEventStore } from "./daemon/event-store.js";
export { validateRequest } from "./daemon/middleware.js";
export { readDaemonInfo, probeHealthz, envFingerprint } from "./daemon/daemon-info.js";
export type { DaemonInfo, DaemonHealth } from "./daemon/daemon-info.js";
export { DAEMON_NAME, DEFAULT_DAEMON_PORT, MCP_ENDPOINT_PATH } from "./daemon/constants.js";
export { WorkflowProjectRegistry, resolveProjectDir, singleStoreRouter } from "./project-registry.js";
export type { ProjectContext, RunStoreRouter } from "./project-registry.js";

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function portFlag(argv: string[]): number | undefined {
  const raw = flagValue(argv, "--port");
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`--port expects a number in [0, 65535], got "${raw}"`);
  }
  return parsed;
}

function entryPath(): string {
  const invoked = process.argv[1];
  if (invoked === undefined) throw new Error("cannot determine the entry path (no argv[1])");
  return realpathSync(invoked);
}

export async function dispatch(argv: string[]): Promise<void> {
  if (argv[0] === "daemon") {
    process.exitCode = await runDaemonCommand(argv.slice(1), { bundlePath: entryPath() });
    return;
  }
  if (argv.includes("--in-process")) {
    await main();
    return;
  }
  if (argv.includes("--daemon-run")) {
    const outcome = await runDaemon({ port: portFlag(argv), supersede: argv.includes("--supersede") });
    if (outcome === "started") {
      // The listening HTTP server holds the event loop; the daemon lifecycle exits.
      await new Promise(() => undefined);
    }
    return;
  }
  await runShim({
    bundlePath: entryPath(),
    port: portFlag(argv),
  });
}

// Same realpath rationale as index.ts: bin shims are symlinks and Node realpath-resolves
// the ESM entry module, so argv[1] must be realpath'd before comparing.
function isProcessEntryPoint(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invokedPath)).href;
  } catch {
    return false;
  }
}

if (isProcessEntryPoint()) {
  dispatch(process.argv.slice(2)).catch((error: unknown) => {
    console.error("[agentprism-workflow] fatal error during startup:", error);
    process.exitCode = 1;
  });
}
