/**
 * Daemon composition root: the real ACP runner + the HTTP daemon + discovery file +
 * lifecycle. Invoked as `--daemon-run` by the shim's detached spawn, or in the foreground
 * via `daemon run`. All diagnostics go to stderr (the detached spawn redirects it to
 * daemon.log).
 */

import { createAcpRunner } from "@automatalabs/workflows";

import { SERVER_VERSION } from "../server.js";
import {
  DAEMON_IDLE_TTL_ENV,
  DAEMON_IDLE_TTL_MS,
  DAEMON_NAME,
  DAEMON_PORT_ENV,
  DEFAULT_DAEMON_PORT,
  SESSION_IDLE_TTL_ENV,
  SESSION_IDLE_TTL_MS,
} from "./constants.js";
import { envFingerprint, pidIsAlive, probeHealthz, readDaemonInfo, writeDaemonInfo } from "./daemon-info.js";
import { installDaemonLifecycle } from "./daemon-lifecycle.js";
import { createDaemon, DaemonPortInUseError } from "./http-daemon.js";

export interface RunDaemonOptions {
  port?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveDaemonPort(explicit?: number): number {
  return explicit ?? envInt(DAEMON_PORT_ENV, DEFAULT_DAEMON_PORT);
}

/** True when a live daemon of ours already answers on its recorded port. */
async function ownDaemonAlreadyRunning(): Promise<boolean> {
  const info = readDaemonInfo();
  if (info === undefined || !pidIsAlive(info.pid)) return false;
  const health = await probeHealthz(info.port);
  return health !== undefined && health.pid === info.pid;
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<"started" | "already-running"> {
  const log = (line: string) => console.error(line);
  const port = resolveDaemonPort(options.port);
  const runner = createAcpRunner();

  let daemon;
  const sessionTtlMs = envInt(SESSION_IDLE_TTL_ENV, SESSION_IDLE_TTL_MS);
  try {
    daemon = await createDaemon({ runner, port, log, sessionTtlMs });
  } catch (error) {
    if (!(error instanceof DaemonPortInUseError)) throw error;
    if (await ownDaemonAlreadyRunning()) {
      log(`[${DAEMON_NAME}] already running (port ${port}); nothing to do`);
      return "already-running";
    }
    // A foreign process owns the default port. Discovery goes through daemon.json, never a
    // blind dial of the default port, so an ephemeral port is fully functional.
    log(`[${DAEMON_NAME}] port ${port} is taken by another process; falling back to an ephemeral port`);
    daemon = await createDaemon({ runner, port: 0, log, sessionTtlMs });
  }

  writeDaemonInfo({
    name: DAEMON_NAME,
    version: SERVER_VERSION,
    pid: process.pid,
    port: daemon.port,
    url: daemon.url,
    startedAt: daemon.startedAt,
    envFingerprint: envFingerprint(),
  });

  installDaemonLifecycle({
    daemon,
    runner,
    ownPid: process.pid,
    idleTtlMs: envInt(DAEMON_IDLE_TTL_ENV, DAEMON_IDLE_TTL_MS),
    sessionTtlMs: envInt(SESSION_IDLE_TTL_ENV, SESSION_IDLE_TTL_MS),
    log,
  });

  log(`[${DAEMON_NAME}] v${SERVER_VERSION} listening on ${daemon.url} (pid ${process.pid})`);
  return "started";
}
