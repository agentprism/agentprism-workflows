/**
 * The daemon process-lifetime accounting: idleness means no sessions, no active workflow runs,
 * and no request in flight; the idle clock only starts once all three are quiet. A superseded
 * daemon migrates its drainable sessions and exits as soon as nothing is busy.
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
  superseded?: boolean;
  /** Sessions closed by the lame-duck migration; `evictDrainable` empties `sessions`. */
  migrated?: number;
}): DaemonHandle {
  return {
    port: 0,
    url: "http://127.0.0.1:0/mcp",
    startedAt: new Date().toISOString(),
    instanceId: "test-instance",
    controlUrl: "http://127.0.0.1:0/_agentprism/control/v1/run",
    sessions: { get size() { return state.sessions; }, evictIdle: () => [], inflightCount: () => 0 } as never,
    projects: {} as never,
    activeRunCount: () => state.activeRuns,
    inflightRequestCount: () => 0,
    isSuperseded: () => state.superseded ?? false,
    evictDrainableSessions: () => {
      const ids = Array.from({ length: state.sessions }, (_, i) => `s${i}`);
      state.migrated = (state.migrated ?? 0) + ids.length;
      state.sessions = 0;
      return ids;
    },
    processPendingControlIntents: async () => undefined,
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

test("sessions and runs count as busy; a run that starts as the last session closes restarts the idle clock", async () => {
  const state = { sessions: 1, activeRuns: 0 };
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
  // The last session closes while a run is active: the idle clock must not accumulate across
  // the transition.
  state.sessions = 0;
  state.activeRuns = 1;
  await sleep(160);
  assert.deepEqual(process.exits, [], "the active run restarted the idle clock");
  state.activeRuns = 0;
  await sleep(220);
  assert.deepEqual(process.exits, [0], "idle shutdown fires once the run finished");
});

test("a superseded daemon does not wait for the idle TTL: it migrates idle sessions and exits as soon as nothing is busy, even with idle shutdown disabled", async () => {
  const state = { sessions: 3, activeRuns: 0, superseded: true, migrated: 0 };
  const { handle, exits } = fakeProcess();
  const logs: string[] = [];
  const lifecycle = installDaemonLifecycle({
    daemon: fakeHandle(state),
    runner: { dispose: async () => undefined } as unknown as AgentRunner,
    ownPid: process.pid,
    idleTtlMs: 0, // disabled — supersession must still exit the daemon
    sessionTtlMs: 60_000,
    reaperIntervalMs: 15,
    process: handle,
    log: (line) => logs.push(line),
  });
  try {
    await sleep(120);
    assert.equal(state.migrated, 3, "every idle session was closed so its client re-initializes on the successor");
    assert.deepEqual(exits, [0], "the superseded daemon exited without waiting for any idle TTL");
    assert.ok(logs.some((line) => line.includes("superseded by a newer daemon; draining")), logs.join(" | "));
    assert.ok(logs.some((line) => line.includes("migrated 3 idle session(s)")), logs.join(" | "));
    assert.ok(logs.some((line) => line.includes("superseded and nothing in flight; exiting")), logs.join(" | "));
  } finally {
    if (exits.length === 0) await lifecycle.shutdown("SIGTERM");
  }
});

test("a superseded daemon migrates drainable MCP sessions while retaining execution ownership, then exits once runs finish", async () => {
  const state = { sessions: 2, activeRuns: 1, superseded: true, migrated: 0 };
  const { handle, exits } = fakeProcess();
  const lifecycle = installDaemonLifecycle({
    daemon: fakeHandle(state),
    runner: { dispose: async () => undefined } as unknown as AgentRunner,
    ownPid: process.pid,
    idleTtlMs: 0,
    sessionTtlMs: 60_000,
    reaperIntervalMs: 15,
    process: handle,
    log: () => undefined,
  });
  try {
    await sleep(80);
    assert.equal(state.migrated, 2, "front-door sessions migrate independently of predecessor-owned executions");
    assert.deepEqual(exits, [], "the predecessor remains alive while it owns execution");
    state.activeRuns = 0;
    await sleep(80);
    assert.deepEqual(exits, [0], "the predecessor exits after its execution responsibility settles");
  } finally {
    if (exits.length === 0) await lifecycle.shutdown("SIGTERM");
  }
});
