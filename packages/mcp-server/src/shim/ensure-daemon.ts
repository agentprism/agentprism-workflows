/**
 * Discover-or-spawn: the shim's guarantee that a healthy, CURRENT-version daemon exists
 * before it proxies. Discovery always goes through daemon.json + a pid check + /healthz —
 * never a blind dial of the default port — so a foreign process squatting the port can never
 * be mistaken for the daemon. The spawn lock makes N concurrently starting shims produce
 * exactly one daemon; losers poll until a current-version daemon reports healthy.
 *
 * Succession: a live daemon whose version/env fingerprint DIVERGES from this shim is never
 * adopted (busy or idle) — the shim spawns a current-version successor on an ephemeral port,
 * which atomically repoints daemon.json at itself, and the shim connects there. The
 * superseded daemon (its pid no longer matches daemon.json) becomes a lame duck: it finishes
 * its existing sessions and runs, admits no new sessions, and exits once idle. This is what
 * stops a stale daemon from being kept alive forever by the very clients it would serve with
 * out-of-date code.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

import { SERVER_VERSION } from "../server.js";
import { DAEMON_NAME, SPAWN_HEALTH_TIMEOUT_MS } from "./../daemon/constants.js";
import {
  claimSpawnLock,
  daemonLogPath,
  envFingerprint,
  pidIsAlive,
  probeHealthz,
  readDaemonInfo,
  releaseSpawnLock,
  type DaemonInfo,
} from "../daemon/daemon-info.js";

export interface EnsureDaemonOptions {
  /** The entry file to spawn with --daemon-run: the same bundle the shim itself runs from. */
  bundlePath: string;
  port?: number;
  log: (line: string) => void;
  /**
   * Test seam: how to launch a daemon process. Defaults to a detached OS spawn of the shim's
   * own bundle with `--daemon-run` (plus `--supersede` when replacing a divergent daemon).
   * Injected in unit tests to start an in-process successor.
   */
  spawn?: (args: { bundlePath: string; port?: number; supersede: boolean }) => void;
}

function isDivergent(live: { version: string; envFingerprint: string }, fingerprint: string): boolean {
  return live.version !== SERVER_VERSION || live.envFingerprint !== fingerprint;
}

async function probeLiveDaemon(): Promise<{ info: DaemonInfo; sessions: number; activeRuns: number; version: string; envFingerprint: string } | undefined> {
  const info = readDaemonInfo();
  if (info === undefined || !pidIsAlive(info.pid)) return undefined;
  const health = await probeHealthz(info.port);
  if (health === undefined || health.pid !== info.pid) return undefined;
  return {
    info,
    sessions: health.sessions,
    activeRuns: health.activeRuns,
    version: health.version,
    envFingerprint: health.envFingerprint,
  };
}

/**
 * Wait for the CURRENT-version daemon to own discovery. During a succession, daemon.json
 * still points at the divergent predecessor until the successor repoints it, so a plain
 * "any healthy daemon" wait would reconnect to the daemon we are trying to replace. This
 * returns only once daemon.json names a daemon matching this shim's version and env
 * fingerprint (the successor, or a daemon another racing shim already installed).
 */
async function waitForCurrentDaemon(fingerprint: string, timeoutMs: number): Promise<DaemonInfo | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const live = await probeLiveDaemon();
    if (live !== undefined && !isDivergent(live, fingerprint)) return live.info;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function stopDaemon(pid: number, timeoutMs = 5_000): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !pidIsAlive(pid);
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function spawnDetachedDaemon(args: { bundlePath: string; port?: number; supersede: boolean }): void {
  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const argv = [args.bundlePath, "--daemon-run"];
  if (args.port !== undefined) argv.push("--port", String(args.port));
  if (args.supersede) argv.push("--supersede");
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: homedir(),
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
}

export async function ensureDaemonRunning(options: EnsureDaemonOptions): Promise<DaemonInfo> {
  const fingerprint = envFingerprint();
  const spawnDaemon =
    options.spawn ??
    ((args: { bundlePath: string; port?: number; supersede: boolean }) => spawnDetachedDaemon(args));

  const live = await probeLiveDaemon();
  // A live daemon that matches this shim's version and env: adopt it.
  if (live !== undefined && !isDivergent(live, fingerprint)) return live.info;

  // Divergent (stale) daemon: NEVER adopt it, busy or idle. Spawn a current-version
  // successor, repoint discovery to it, and connect there. The old daemon drains and exits.
  if (live !== undefined) {
    const reasons: string[] = [];
    if (live.version !== SERVER_VERSION) reasons.push(`version v${live.version} → v${SERVER_VERSION}`);
    if (live.envFingerprint !== fingerprint) {
      reasons.push(`env fingerprint ${live.envFingerprint} → ${fingerprint}`);
    }
    options.log(
      `[${DAEMON_NAME}] superseding stale daemon (pid ${live.info.pid}, ${live.sessions} session(s), ` +
        `${live.activeRuns} run(s)): ${reasons.join(", ")} — spawning a v${SERVER_VERSION} successor and repointing discovery`,
    );
  }

  const lock = claimSpawnLock();
  if (lock === null) {
    // Another shim is installing the daemon right now; wait for the current-version daemon
    // (not the divergent one we are replacing) instead of racing it.
    const info = await waitForCurrentDaemon(fingerprint, SPAWN_HEALTH_TIMEOUT_MS);
    if (info !== undefined) return info;
    throw new Error(
      `[${DAEMON_NAME}] another process is starting the daemon but no current-version daemon became healthy; see ${daemonLogPath()}`,
    );
  }
  try {
    // Re-probe under the lock: another shim may already have installed a current daemon.
    const raced = await probeLiveDaemon();
    if (raced !== undefined && !isDivergent(raced, fingerprint)) return raced.info;
    // Supersede only when a divergent daemon still holds discovery; a cold start takes the
    // default port so `daemon status`/`url` show the canonical endpoint.
    const superseding = raced !== undefined;
    spawnDaemon({ bundlePath: options.bundlePath, port: options.port, supersede: superseding });
    const info = await waitForCurrentDaemon(fingerprint, SPAWN_HEALTH_TIMEOUT_MS);
    if (info === undefined) {
      throw new Error(
        `[${DAEMON_NAME}] spawned daemon did not become the current healthy daemon within ${SPAWN_HEALTH_TIMEOUT_MS}ms; see ${daemonLogPath()}`,
      );
    }
    if (superseding) {
      options.log(
        `[${DAEMON_NAME}] succession complete: connected to v${info.version} daemon (pid ${info.pid}) at ${info.url}; ` +
          `the superseded daemon will finish its work and exit`,
      );
    }
    return info;
  } finally {
    releaseSpawnLock(lock);
  }
}

export { stopDaemon };
