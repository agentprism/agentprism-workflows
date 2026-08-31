/**
 * Daemon composition root: the real ACP runner + the HTTP daemon + discovery file +
 * lifecycle. Invoked as `--daemon-run` by the shim's detached spawn, or in the foreground
 * via `daemon run`. All diagnostics go to stderr (the detached spawn redirects it to
 * daemon.log).
 */

import { randomUUID } from "node:crypto";
import { createAcpRunner } from "@automatalabs/workflows";

import { SERVER_VERSION } from "../server.js";
import {
  DAEMON_IDLE_TTL_ENV,
  DAEMON_IDLE_TTL_MS,
  DAEMON_NAME,
  DAEMON_PORT_ENV,
  DEFAULT_DAEMON_PORT,
  REPL_DRAIN_BOUND_ENV,
  REPL_DRAIN_BOUND_MS,
  SESSION_IDLE_TTL_ENV,
  SESSION_IDLE_TTL_MS,
} from "./constants.js";
import {
  envFingerprint,
  findDaemonInstanceOnPort,
  pidIsAlive,
  probeHealthz,
  readDaemonInfo,
  writeDaemonInfo,
} from "./daemon-info.js";
import { installDaemonLifecycle } from "./daemon-lifecycle.js";
import { createDaemon, DaemonPortInUseError } from "./http-daemon.js";
import { createEvalBreakChannel } from "@automatalabs/repl-engine";
import { WorkflowPermissionBroker } from "../workflow-permissions.js";

export interface RunDaemonOptions {
  port?: number;
  /**
   * Replace a stale daemon that still holds the family's discovery pointer. The predecessor is
   * deliberately left running to finish its in-flight work, so a successor never fights for
   * the port — it binds the explicitly requested port if one was given (falling back to an
   * ephemeral one when that is taken), otherwise an ephemeral one, and repoints the pointer at
   * itself, demoting the predecessor to a lame duck (whose pid no longer matches the pointer).
   * Set by the shim (`--supersede`) when the live daemon is older than the shim.
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
  const permissionBroker = new WorkflowPermissionBroker();
  const runner = createAcpRunner({
    onPermissionRequest: permissionBroker.resolver,
    enforceToolPolicyBeforePermissionResolver: true,
  });
  permissionBroker.attach(runner);
  const supersede = options.supersede ?? false;
  const instanceId = randomUUID();

  let daemon;
  const sessionTtlMs = envInt(SESSION_IDLE_TTL_ENV, SESSION_IDLE_TTL_MS);
  const replDrainBoundMs = envInt(REPL_DRAIN_BOUND_ENV, REPL_DRAIN_BOUND_MS);
  const describePortHolder = (port: number): string => {
    const holder = findDaemonInstanceOnPort(port);
    if (holder === undefined) return `port ${port} is taken by another process`;
    return (
      `port ${port} is still held by ${holder.legacy ? "a legacy " : ""}daemon pid ${holder.info.pid} ` +
      `(v${holder.info.version}, started ${holder.info.startedAt})`
    );
  };
  // The eval-break relay (phase-F review round 2): a worker-thread
  // channel whose loopback endpoint stays reachable while the daemon's
  // main thread is blocked in a synchronous eval — the `interrupt`
  // tool's no-id break. Its address travels in daemon.json so the shim
  // can fire it out of band.
  const evalBreakChannel = createEvalBreakChannel();
  const daemonOptions = { runner, permissionBroker, log, replDrainBoundMs, evalBreakChannel, ownInstanceId: instanceId };
  if (supersede) {
    // Succession: the stale predecessor may still hold the default port and is left running
    // to finish its in-flight work, so never contend for it — bind the explicitly requested
    // port if there is one (it is the caller's, not the predecessor's), else an ephemeral
    // port. The family pointer (repointed below) is the sole discovery channel, so an
    // ephemeral port is fully functional; the predecessor becomes a lame duck the moment we
    // repoint.
    let port = options.port ?? 0;
    try {
      daemon = await createDaemon({ ...daemonOptions, port });
    } catch (error) {
      if (!(error instanceof DaemonPortInUseError) || port === 0) throw error;
      log(`[${DAEMON_NAME}] ${describePortHolder(port)}; successor falling back to an ephemeral port`);
      port = 0;
      daemon = await createDaemon({ ...daemonOptions, port });
    }
    log(`[${DAEMON_NAME}] starting as a successor to a superseded daemon (port ${daemon.port})`);
  } else {
    const port = resolveDaemonPort(options.port);
    try {
      daemon = await createDaemon({ ...daemonOptions, port });
    } catch (error) {
      if (!(error instanceof DaemonPortInUseError)) throw error;
      if (await ownDaemonAlreadyRunning()) {
        log(`[${DAEMON_NAME}] already running (port ${port}); nothing to do`);
        return "already-running";
      }
      // Something else owns the default port — a draining daemon of ours (its pointer no
      // longer names it) or a foreign process. Discovery goes through the family pointer,
      // never a blind dial of the default port, so an ephemeral port is fully functional.
      log(`[${DAEMON_NAME}] ${describePortHolder(port)}; falling back to an ephemeral port`);
      daemon = await createDaemon({ ...daemonOptions, port: 0 });
    }
  }

  // Atomically (tmp+rename) repoint the family pointer at THIS process (and record the
  // instance). For a succession this is the step that demotes the predecessor to a lame duck
  // (its pid no longer matches the pointer); the pid-guarded clearDaemonInfo means the
  // predecessor's own shutdown never clobbers it.
  writeDaemonInfo({
    name: DAEMON_NAME,
    version: SERVER_VERSION,
    pid: process.pid,
    port: daemon.port,
    url: daemon.url,
    startedAt: daemon.startedAt,
    envFingerprint: envFingerprint(),
    instanceId: daemon.instanceId,
    controlUrl: daemon.controlUrl,
    controlProtocol: 1,
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
    sessionTtlMs,
    log,
  });

  log(
    `[${DAEMON_NAME}] v${SERVER_VERSION} listening on ${daemon.url} (pid ${process.pid})` +
      (supersede ? " — superseding a previous daemon; discovery repointed here" : ""),
  );
  return "started";
}
