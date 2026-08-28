/**
 * Process lifetime for the daemon — deliberately the inverse of installMcpServerLifecycle:
 * no stdin coupling and no transport coupling. Only signals, an explicit stop, sustained
 * idleness (zero sessions AND zero active runs for the TTL), or supersession end the process.
 * The unref'd reaper also evicts dead-client sessions so they cannot hold the daemon alive
 * forever.
 *
 * Supersession (a newer daemon owns this family's discovery pointer) turns the daemon into a
 * lame duck, and the reaper then actively drains it instead of waiting for idleness:
 *   - every session with no request in flight and no REPL workspace mid-turn is closed so its
 *     client transparently re-initializes on the successor; workflow execution remains on the
 *     predecessor and is reached through the internal run-control plane;
 *   - durable whole-stop intents are scanned on every reaper cadence;
 *   - the moment nothing is busy — no sessions, runs, requests, or REPL drains — the daemon exits,
 *     regardless of the idle TTL (even a disabled one: a superseded daemon with nothing to do is
 *     garbage, not a long-lived service).
 */

import type { AgentRunner } from "@automatalabs/shared-types";

import { disposeRunnerWithDeadline } from "../lifecycle.js";
import { REAPER_INTERVAL_MS } from "./constants.js";
import { clearDaemonInfo } from "./daemon-info.js";
import type { DaemonHandle } from "./http-daemon.js";

export type DaemonShutdownReason = "SIGTERM" | "SIGINT" | "idle" | "superseded";

interface DaemonProcessHandle {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): unknown;
}

export interface DaemonLifecycleOptions {
  daemon: DaemonHandle;
  runner: AgentRunner;
  ownPid: number;
  /** 0 disables idle shutdown (supersession still exits the daemon once nothing is in flight). */
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
  let supersessionAnnounced = false;

  const onSigint = () => void lifecycle.shutdown("SIGINT");
  const onSigterm = () => void lifecycle.shutdown("SIGTERM");

  const reaper = setInterval(() => {
    const daemon = options.daemon;
    const superseded = daemon.isSuperseded();
    void daemon.processPendingControlIntents?.();

    if (superseded) {
      if (!supersessionAnnounced) {
        supersessionAnnounced = true;
        log(
          `[agentprism-daemon] superseded by a newer daemon; draining — ` +
            `${daemon.sessions.size} session(s), ${daemon.activeRunCount()} run(s), ` +
            `${daemon.inflightRequestCount()} request(s) in flight`,
        );
      }
      // MCP sessions are front-door state, not workflow ownership. Migrate every drainable
      // session independently; in-flight requests and busy REPL workspaces remain protected by
      // SessionRegistry's eviction predicate.
      const migrated = daemon.evictDrainableSessions();
      if (migrated.length > 0) {
        log(`[agentprism-daemon] migrated ${migrated.length} idle session(s) to the successor: ${migrated.join(", ")}`);
      }
    } else {
      supersessionAnnounced = false;
      const evicted = daemon.sessions.evictIdle(options.sessionTtlMs);
      if (evicted.length > 0) {
        log(`[agentprism-daemon] evicted ${evicted.length} idle session(s): ${evicted.join(", ")}`);
      }
    }

    // Idleness means NO sessions, NO active workflow runs, AND NO active
    // REPL client-presence drain (phase-E review rejection round 2: the
    // drain used to be invisible to the accounting, so with the final
    // session deleted the default 15-minute idle shutdown could fire
    // while a last-client-disconnect drain was legitimately running
    // toward its full bound — and the shutdown path then replaced the
    // drain's bound with the five-second shutdown deadline, so in-flight
    // turns were not guaranteed to drain to completion under the
    // documented bound).
    const busy = daemon.sessions.size > 0 ||
      daemon.activeRunCount() > 0 ||
      daemon.inflightRequestCount() > 0 ||
      daemon.activeReplDrainCount() > 0;
    if (busy) {
      idleSince = undefined;
      return;
    }
    if (superseded) {
      log("[agentprism-daemon] superseded and nothing in flight; exiting");
      void lifecycle.shutdown("superseded");
      return;
    }
    if (options.idleTtlMs <= 0) return;
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= options.idleTtlMs) {
      log(`[agentprism-daemon] idle for ${options.idleTtlMs}ms with no sessions, runs, or repl drains; shutting down`);
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
