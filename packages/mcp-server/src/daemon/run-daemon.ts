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
import { createEvalBreakChannel } from "@automatalabs/repl-engine";

export interface RunDaemonOptions {
  port?: number;
  /**
   * Replace a divergent daemon that still holds discovery. The predecessor is deliberately
   * left running to drain its in-flight sessions and runs, so a successor never fights for
   * the port — it binds an ephemeral one and repoints `daemon.json` at itself, demoting the
   * predecessor to a lame duck (whose pid no longer matches `daemon.json`). Set by the shim
   * (`--supersede`) when its version/env fingerprint diverges from the live daemon.
   */
  supersede?: boolean;
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
  const runner = createAcpRunner();
  const supersede = options.supersede ?? false;

  let daemon;
  const sessionTtlMs = envInt(SESSION_IDLE_TTL_ENV, SESSION_IDLE_TTL_MS);
  // The eval-break relay (phase-F review round 2): a worker-thread
  // channel whose loopback endpoint stays reachable while the daemon's
  // main thread is blocked in a synchronous eval — the `interrupt`
  // tool's no-id break. Its address travels in daemon.json so the shim
  // can fire it out of band.
  const evalBreakChannel = createEvalBreakChannel();
  if (supersede) {
    // Succession: the divergent predecessor may still hold the default port and is left
    // running to drain, so never contend for it — bind an ephemeral port. daemon.json
    // (repointed below) is the sole discovery channel, so an ephemeral port is fully
    // functional; the predecessor becomes a lame duck the moment we repoint.
    log(`[${DAEMON_NAME}] starting as a successor to a superseded daemon (ephemeral port)`);
    daemon = await createDaemon({ runner, port: 0, log, sessionTtlMs, evalBreakChannel });
  } else {
    const port = resolveDaemonPort(options.port);
    try {
      daemon = await createDaemon({ runner, port, log, sessionTtlMs, evalBreakChannel });
    } catch (error) {
      if (!(error instanceof DaemonPortInUseError)) throw error;
      if (await ownDaemonAlreadyRunning()) {
        log(`[${DAEMON_NAME}] already running (port ${port}); nothing to do`);
        return "already-running";
      }
      // A foreign process owns the default port. Discovery goes through daemon.json, never a
      // blind dial of the default port, so an ephemeral port is fully functional.
      log(`[${DAEMON_NAME}] port ${port} is taken by another process; falling back to an ephemeral port`);
      daemon = await createDaemon({ runner, port: 0, log, sessionTtlMs, evalBreakChannel });
    }
  }

  // Atomically (tmp+rename) repoint daemon.json at THIS process. For a succession this is the
  // step that demotes the predecessor to a lame duck (its pid no longer matches daemon.json);
  // the pid-guarded clearDaemonInfo means the predecessor's own shutdown never clobbers it.
  writeDaemonInfo({
    name: DAEMON_NAME,
    version: SERVER_VERSION,
    pid: process.pid,
    port: daemon.port,
    url: daemon.url,
    startedAt: daemon.startedAt,
    envFingerprint: envFingerprint(),
    ...(await evalBreakChannel
      .breakUrl()
      .then((url) => ({ replBreakUrl: url }))
      .catch(() => ({}))),
  });

  installDaemonLifecycle({
    daemon,
    runner,
    ownPid: process.pid,
    idleTtlMs: envInt(DAEMON_IDLE_TTL_ENV, DAEMON_IDLE_TTL_MS),
    sessionTtlMs: envInt(SESSION_IDLE_TTL_ENV, SESSION_IDLE_TTL_MS),
    log,
  });

  log(
    `[${DAEMON_NAME}] v${SERVER_VERSION} listening on ${daemon.url} (pid ${process.pid})` +
      (supersede ? " — superseding a previous daemon; discovery repointed here" : ""),
  );
  return "started";
}
