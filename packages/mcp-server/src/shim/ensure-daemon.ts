/**
 * Discover-or-spawn: the shim's guarantee that a healthy daemon exists before it proxies.
 * Discovery always goes through daemon.json + a pid check + /healthz — never a blind dial
 * of the default port — so a foreign process squatting the port can never be mistaken for
 * the daemon. The spawn lock makes N concurrently starting shims produce exactly one
 * daemon; losers poll until the winner's daemon reports healthy.
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

async function waitForHealthyDaemon(timeoutMs: number): Promise<DaemonInfo | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const live = await probeLiveDaemon();
    if (live !== undefined) return live.info;
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

function spawnDetachedDaemon(options: EnsureDaemonOptions): void {
  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const args = [options.bundlePath, "--daemon-run"];
  if (options.port !== undefined) args.push("--port", String(options.port));
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: homedir(),
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
}

export async function ensureDaemonRunning(options: EnsureDaemonOptions): Promise<DaemonInfo> {
  const live = await probeLiveDaemon();
  if (live !== undefined) {
    const fingerprint = envFingerprint();
    const divergent = live.version !== SERVER_VERSION || live.envFingerprint !== fingerprint;
    if (!divergent) return live.info;
    if (live.sessions === 0 && live.activeRuns === 0) {
      options.log(
        `[${DAEMON_NAME}] restarting idle daemon (v${live.version} → v${SERVER_VERSION}, env fingerprint ${live.envFingerprint} → ${fingerprint})`,
      );
      await stopDaemon(live.info.pid);
    } else {
      options.log(
        `[${DAEMON_NAME}] daemon v${live.version} has a different version/env than this client but is busy ` +
          `(${live.sessions} session(s), ${live.activeRuns} run(s)); connecting anyway — restart it when idle with 'agentprism-workflows daemon stop'`,
      );
      return live.info;
    }
  }

  const lock = claimSpawnLock();
  if (lock === null) {
    // Another shim is spawning right now; wait for its daemon instead of racing it.
    const info = await waitForHealthyDaemon(SPAWN_HEALTH_TIMEOUT_MS);
    if (info !== undefined) return info;
    throw new Error(`[${DAEMON_NAME}] another process is starting the daemon but it never became healthy; see ${daemonLogPath()}`);
  }
  try {
    // The daemon may have appeared between the first probe and winning the lock.
    const raced = await probeLiveDaemon();
    if (raced !== undefined) return raced.info;
    spawnDetachedDaemon(options);
    const info = await waitForHealthyDaemon(SPAWN_HEALTH_TIMEOUT_MS);
    if (info === undefined) {
      throw new Error(`[${DAEMON_NAME}] spawned daemon did not become healthy within ${SPAWN_HEALTH_TIMEOUT_MS}ms; see ${daemonLogPath()}`);
    }
    return info;
  } finally {
    releaseSpawnLock(lock);
  }
}

export { stopDaemon };
