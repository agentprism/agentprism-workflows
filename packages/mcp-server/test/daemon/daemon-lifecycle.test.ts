/**
 * The daemon process-lifetime accounting (phase-E review rejection round
 * 2): idleness means no sessions, no active workflow runs, AND no active
 * REPL client-presence drain. A last-client-disconnect drain may
 * legitimately run for the full session-eviction TTL after the final
 * session is gone; the default idle shutdown must never replace that
 * drain's bound with the five-second shutdown deadline — so the reaper's
 * busy check counts `activeReplDrainCount()` exactly like sessions and
 * runs, and the idle clock only starts once every drain completed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRunner } from "@automatalabs/shared-types";

import { installDaemonLifecycle } from "../../src/daemon/daemon-lifecycle.js";
import type { DaemonHandle } from "../../src/daemon/http-daemon.js";
import "../_harness.js"; // TEST_HOME isolation for daemon-info writes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fake daemon handle whose busy signals are scripted. */
function fakeHandle(state: {
  sessions: number;
  activeRuns: number;
  activeDrains: number;
}): DaemonHandle {
  return {
    port: 0,
    url: "http://127.0.0.1:0/mcp",
    startedAt: new Date().toISOString(),
    sessions: { get size() { return state.sessions; }, evictIdle: () => [] } as never,
    projects: { disposeReplStates: async () => undefined } as never,
    activeRunCount: () => state.activeRuns,
    activeReplDrainCount: () => state.activeDrains,
    close: async () => undefined,
  };
}

function fakeProcess(): {
  handle: {
    once(event: string, listener: () => void): unknown;
    removeListener(): unknown;
    exit(code: number): unknown;
  };
  exits: number[];
} {
  const exits: number[] = [];
  const listeners = new Map<string, () => void>();
  const handle = {
    once(event: string, listener: () => void) {
      listeners.set(event, listener);
    },
    removeListener() {
      return undefined;
    },
    exit(code: number) {
      exits.push(code);
    },
  };
  return { handle, exits };
}

test("idle shutdown never fires while a REPL client-presence drain is in flight — the drain is counted like sessions and runs; shutdown fires only after the drain completed", async () => {
  const state = { sessions: 0, activeRuns: 0, activeDrains: 1 };
  const process = fakeProcess();
  // The drain runs with no sessions and no workflow runs: the OLD
  // accounting (sessions + runs only) would have idled the daemon out —
  // and the shutdown path would have replaced the drain's
  // session-eviction-TTL bound with the five-second shutdown deadline.
  installDaemonLifecycle({
    daemon: fakeHandle(state),
    runner: { dispose: async () => undefined } as unknown as AgentRunner,
    ownPid: 424242,
    idleTtlMs: 80,
    sessionTtlMs: 1_000,
    reaperIntervalMs: 20,
    process: process.handle,
    log: () => undefined,
  });
  await sleep(160);
  assert.deepEqual(process.exits, [], "idle shutdown must not fire while the drain is in flight");
  // The drain completes: the idle clock starts, and the daemon idles out.
  state.activeDrains = 0;
  await sleep(220);
  assert.deepEqual(process.exits, [0], "idle shutdown fires after the drain completed");
});

test("sessions and runs still count as busy alongside drains (the pre-existing accounting is unchanged); a drain that starts later restarts the idle clock", async () => {
  const state = { sessions: 1, activeRuns: 0, activeDrains: 0 };
  const process = fakeProcess();
  installDaemonLifecycle({
    daemon: fakeHandle(state),
    runner: { dispose: async () => undefined } as unknown as AgentRunner,
    ownPid: 424243,
    idleTtlMs: 80,
    sessionTtlMs: 1_000,
    reaperIntervalMs: 20,
    process: process.handle,
    log: () => undefined,
  });
  await sleep(160);
  assert.deepEqual(process.exits, [], "a live session holds the daemon open");
  // The last session closes and a drain starts: the idle clock must not
  // accumulate across the transition (the drain counts as busy from the
  // moment it is scheduled).
  state.sessions = 0;
  state.activeDrains = 1;
  await sleep(160);
  assert.deepEqual(process.exits, [], "the drain restarted the idle clock");
  state.activeDrains = 0;
  await sleep(220);
  assert.deepEqual(process.exits, [0], "idle shutdown fires once the drain completed");
});
