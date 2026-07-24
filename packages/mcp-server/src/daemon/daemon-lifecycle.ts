/**
 * Process lifetime for the daemon — deliberately the inverse of installMcpServerLifecycle:
 * no stdin coupling and no transport coupling. Only signals, an explicit stop, or sustained
 * idleness (zero sessions AND zero active runs for the TTL) end the process. The unref'd
 * reaper also evicts dead-client sessions so they cannot hold the daemon alive forever.
 */

import type { AgentRunner } from "@automatalabs/shared-types";

import { disposeRunnerWithDeadline } from "../lifecycle.js";
import { REAPER_INTERVAL_MS } from "./constants.js";
import { clearDaemonInfo } from "./daemon-info.js";
import type { DaemonHandle } from "./http-daemon.js";

export type DaemonShutdownReason = "SIGTERM" | "SIGINT" | "idle";

interface DaemonProcessHandle {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): unknown;
}

export interface DaemonLifecycleOptions {
  daemon: DaemonHandle;
  runner: AgentRunner;
  ownPid: number;
  /** 0 disables idle shutdown. */
  idleTtlMs: number;
  sessionTtlMs: number;
  reaperIntervalMs?: number;
  process?: DaemonProcessHandle;
  log?: (line: string) => void;
}

export interface DaemonLifecycle {
  shutdown(reason: DaemonShutdownReason): Promise<void>;
}

function exitCodeFor(reason: DaemonShutdownReason): number {
  if (reason === "SIGINT") return 130;
  if (reason === "SIGTERM") return 143;
  return 0;
}

export function installDaemonLifecycle(options: DaemonLifecycleOptions): DaemonLifecycle {
  const processHandle = options.process ?? process;
  const log = options.log ?? ((line: string) => console.error(line));
  let shutdownPromise: Promise<void> | undefined;
  let idleSince: number | undefined;

  const onSigint = () => void lifecycle.shutdown("SIGINT");
  const onSigterm = () => void lifecycle.shutdown("SIGTERM");

  const reaper = setInterval(() => {
    const evicted = options.daemon.sessions.evictIdle(options.sessionTtlMs);
    if (evicted.length > 0) {
      log(`[agentprism-daemon] evicted ${evicted.length} idle session(s): ${evicted.join(", ")}`);
    }
    if (options.idleTtlMs <= 0) return;
    const busy = options.daemon.sessions.size > 0 || options.daemon.activeRunCount() > 0;
    if (busy) {
      idleSince = undefined;
      return;
    }
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= options.idleTtlMs) {
      log(`[agentprism-daemon] idle for ${options.idleTtlMs}ms with no sessions or runs; shutting down`);
      void lifecycle.shutdown("idle");
    }
  }, options.reaperIntervalMs ?? REAPER_INTERVAL_MS);
  reaper.unref();

  const lifecycle: DaemonLifecycle = {
    shutdown(reason) {
      if (shutdownPromise) return shutdownPromise;
      clearInterval(reaper);
      processHandle.removeListener("SIGINT", onSigint);
      processHandle.removeListener("SIGTERM", onSigterm);
      shutdownPromise = (async () => {
        try {
          await options.daemon.close();
        } catch {
          // Exit is still guaranteed if the HTTP teardown misbehaves.
        }
        await disposeRunnerWithDeadline(options.runner);
        clearDaemonInfo(options.ownPid);
        processHandle.exit(exitCodeFor(reason));
      })();
      return shutdownPromise;
    },
  };

  processHandle.once("SIGINT", onSigint);
  processHandle.once("SIGTERM", onSigterm);
  return lifecycle;
}
