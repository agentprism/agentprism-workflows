/**
 * Discover-or-spawn: the shim's guarantee that a healthy daemon of this client's env FAMILY,
 * at least as new as this client, exists before it proxies. Discovery always goes through
 * the family pointer + a pid check + /healthz — never a blind dial of the default port — so a
 * foreign process squatting the port can never be mistaken for the daemon. The spawn lock
 * makes N concurrently starting shims produce exactly one daemon; losers poll until a
 * qualifying daemon reports healthy.
 *
 * Families: clients are keyed by their env fingerprint (the env the daemon bakes into its ACP
 * runner at construction). Different env → different family → different daemon; families never
 * contend, so a host with a custom backend env never flips another host's daemon.
 *
 * Succession inside a family is a TOTAL ORDER on version: a live daemon OLDER than this shim
 * is never adopted (busy or idle) — the shim spawns a successor, which atomically repoints the
 * family pointer at itself, and the shim connects there. The superseded daemon (its pid no
 * longer matches the pointer) becomes a lame duck: it admits no new sessions, migrates its idle
 * sessions to the successor, finishes in-flight work, and exits. A daemon EQUAL to or NEWER than
 * this shim is adopted — an older client migrating off a lame duck must never resurrect its old
 * code, or two clients of different versions would supersede each other forever.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

import { SERVER_VERSION } from "../server.js";
import { DAEMON_NAME, SPAWN_HEALTH_TIMEOUT_MS } from "./../daemon/constants.js";
import {
  claimSpawnLock,
  compareVersions,
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
   * own bundle with `--daemon-run` (plus `--supersede` when replacing a stale daemon).
   * Injected in unit tests to start an in-process successor.
   */
  spawn?: (args: { bundlePath: string; port?: number; supersede: boolean }) => void;
}

/** A live daemon strictly older than this client: the only thing a shim supersedes. */
function isStale(live: { version: string }): boolean {
  return compareVersions(live.version, SERVER_VERSION) < 0;
}

interface LiveDaemon {
  info: DaemonInfo;
  sessions: number;
  activeRuns: number;
  version: string;
}

/** The family pointer's daemon, if it is alive and answers /healthz as itself. */
async function probeLiveDaemon(fingerprint: string): Promise<LiveDaemon | undefined> {
  const info = readDaemonInfo(fingerprint);
  if (info === undefined || !pidIsAlive(info.pid)) return undefined;
  const health = await probeHealthz(info.port);
  if (health === undefined || health.pid !== info.pid) return undefined;
  return { info, sessions: health.sessions, activeRuns: health.activeRuns, version: health.version };
}

/**
 * Wait for a qualifying daemon to own the family pointer. During a succession the pointer
 * still names the stale predecessor until the successor repoints it, so a plain "any healthy
 * daemon" wait would reconnect to the daemon being replaced. This returns only once the
 * pointer names a daemon at least as new as this shim (the successor, or one another racing
 * shim already installed).
 */
async function waitForCurrentDaemon(fingerprint: string, timeoutMs: number): Promise<DaemonInfo | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const live = await probeLiveDaemon(fingerprint);
    if (live !== undefined && !isStale(live)) return live.info;
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

  const adopt = (live: LiveDaemon): DaemonInfo => {
    if (compareVersions(live.version, SERVER_VERSION) > 0) {
      options.log(
        `[${DAEMON_NAME}] adopting daemon v${live.version} (pid ${live.info.pid}), newer than this client v${SERVER_VERSION}`,
      );
    }
    return live.info;
  };

  const live = await probeLiveDaemon(fingerprint);
  // A live daemon at least as new as this shim: adopt it.
  if (live !== undefined && !isStale(live)) return adopt(live);

  // Stale (older) daemon: NEVER adopt it, busy or idle. Spawn a successor, repoint the family
  // pointer to it, and connect there. The old daemon drains and exits.
  if (live !== undefined) {
    options.log(
      `[${DAEMON_NAME}] superseding stale daemon (pid ${live.info.pid}, ${live.sessions} session(s), ` +
        `${live.activeRuns} run(s)): version v${live.version} → v${SERVER_VERSION} — spawning a successor and repointing discovery`,
    );
  }

  const lock = claimSpawnLock(fingerprint);
  if (lock === null) {
    // Another shim is installing the daemon right now; wait for a qualifying daemon (not the
    // stale one being replaced) instead of racing it.
    const info = await waitForCurrentDaemon(fingerprint, SPAWN_HEALTH_TIMEOUT_MS);
    if (info !== undefined) return info;
    throw new Error(
      `[${DAEMON_NAME}] another process is starting the daemon but no current daemon became healthy; see ${daemonLogPath()}`,
    );
  }
  try {
    // Re-probe under the lock: another shim may already have installed a current daemon.
    const raced = await probeLiveDaemon(fingerprint);
    if (raced !== undefined && !isStale(raced)) return adopt(raced);
    // Supersede only when a stale daemon still holds the pointer; a cold start takes the
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
          `the superseded daemon will migrate its sessions, finish its work, and exit`,
      );
    }
    return info;
  } finally {
    releaseSpawnLock(lock, fingerprint);
  }
}

export { stopDaemon };
