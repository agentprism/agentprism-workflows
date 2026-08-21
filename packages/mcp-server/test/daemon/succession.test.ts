// Daemon succession: how a superseded daemon is supposed to die.
//
// The defect this suite pins: a stale daemon (whose version/env fingerprint diverges from a
// freshly installed shim) used to be ADOPTED whenever it was busy — every new client added a
// session and reset its idle clock, so a superseded daemon never died and served out-of-date
// code forever. The fix: a divergent shim never adopts. It spawns a current-version successor
// on an ephemeral port, atomically repoints daemon.json at it, and connects there; the old
// daemon becomes a lame duck that admits no new sessions, migrates its idle sessions to the
// successor (closing them so their shims re-initialize there), finishes in-flight work, and
// exits as soon as nothing is busy — without waiting for the idle TTL.
//
// Version is a TOTAL ORDER inside a family: only a daemon strictly OLDER than the shim is
// superseded; an equal or newer one is adopted (otherwise two client versions would flip
// discovery back and forth forever, spawning a daemon per flip).
//
// These tests drive the REAL seams — createDaemon() over real loopback HTTP, the real
// ensureDaemonRunning() orchestration (only the OS process spawn is injected, so an in-process
// successor can stand in for the detached daemon), the real installDaemonLifecycle() reaper,
// and the real pid-guarded daemon.json — all under _harness's isolated $HOME.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import "../_harness.js"; // TEST_HOME isolation for daemon.json reads/writes
import { NO_AGENT_SCRIPT, okRunner, structured, textOf } from "../_harness.js";
import { connectHttp, makeProjectDir } from "../_http-harness.js";
import { DAEMON_NAME } from "../../src/daemon/constants.js";
import {
  daemonInfoPath,
  daemonLockPath,
  envFingerprint,
  isSupersededBy,
  readDaemonInfo,
  writeDaemonInfo,
  type DaemonInfo,
} from "../../src/daemon/daemon-info.js";
import { createDaemon, type DaemonHandle } from "../../src/daemon/http-daemon.js";
import { installDaemonLifecycle } from "../../src/daemon/daemon-lifecycle.js";
import { ensureDaemonRunning } from "../../src/shim/ensure-daemon.js";
import { SERVER_VERSION } from "../../src/server.js";

/** Wipe the shared discovery files so each test starts from a clean slate. */
function resetDiscovery(): void {
  for (const path of [daemonInfoPath(), daemonLockPath(), join(dirname(daemonInfoPath()), "instances")]) {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * A daemon.json entry for a live in-process daemon handle. probeLiveDaemon() requires the
 * recorded pid to be alive and to match /healthz, so real in-process daemons record
 * process.pid; supersession is simulated by recording a DIFFERENT pid (the successor's).
 */
function infoForHandle(handle: DaemonHandle, pid: number, version = SERVER_VERSION): DaemonInfo {
  return {
    name: DAEMON_NAME,
    version,
    pid,
    port: handle.port,
    url: handle.url,
    startedAt: handle.startedAt,
    envFingerprint: envFingerprint(),
  };
}

/** A process test double capturing exit codes, with no real signal handlers. */
function fakeProcess(): { handle: Parameters<typeof installDaemonLifecycle>[0]["process"]; exits: number[] } {
  const exits: number[] = [];
  const handle = {
    once() {
      return undefined;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("succession: a divergent shim never adopts the old daemon (even busy) — it spawns a successor, repoints daemon.json, and connects there; the old daemon keeps serving its existing session", async () => {
  resetDiscovery();
  // A live OLD daemon whose /healthz reports a divergent version.
  const oldDaemon = await createDaemon({ runner: okRunner(), port: 0, log: () => undefined, version: "0.0.0-old" });
  const successors: DaemonHandle[] = [];
  try {
    // Discovery points at the old daemon, and it has an ACTIVE session (it is "busy").
    writeDaemonInfo(infoForHandle(oldDaemon, process.pid, "0.0.0-old"));
    const projectDir = makeProjectDir("succession-old");
    const oldSession = await connectHttp(oldDaemon.url, { listTools: true });
    const firstCall = await oldSession.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, projectDir },
    });
    assert.equal(structured(firstCall)?.status, "completed", textOf(firstCall));
    assert.ok(oldDaemon.sessions.size >= 1, "the old daemon has an active session (busy)");

    // A current-version shim arrives. The injected spawn stands in for the detached
    // `--daemon-run --supersede` process: it starts a current-version successor and
    // atomically repoints daemon.json at it.
    let sawSupersedeFlag: boolean | undefined;
    const logs: string[] = [];
    const info = await ensureDaemonRunning({
      bundlePath: "unused-in-test",
      log: (line) => logs.push(line),
      spawn: (args) => {
        sawSupersedeFlag = args.supersede;
        void (async () => {
          const successor = await createDaemon({ runner: okRunner(), port: 0, log: () => undefined });
          successors.push(successor);
          writeDaemonInfo(infoForHandle(successor, process.pid, SERVER_VERSION));
        })();
      },
    });

    assert.equal(sawSupersedeFlag, true, "the divergent daemon must be superseded, not adopted");
    assert.equal(successors.length, 1, "exactly one successor was spawned");
    const successor = successors[0]!;
    assert.equal(info.url, successor.url, "the shim is pointed at the SUCCESSOR");
    assert.notEqual(info.url, oldDaemon.url, "the shim did NOT adopt the old daemon");
    assert.equal(readDaemonInfo()?.port, successor.port, "daemon.json was repointed at the successor");
    assert.ok(
      logs.some((line) => line.includes("superseding stale daemon")),
      `succession must be logged loudly; got: ${logs.join(" | ")}`,
    );
    assert.ok(logs.some((line) => line.includes("succession complete")), "the completed succession is logged");

    // A NEW session lands on the successor and works.
    const newSession = await connectHttp(info.url, { listTools: true });
    const newCall = await newSession.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, projectDir },
    });
    assert.equal(structured(newCall)?.status, "completed", textOf(newCall));

    // The old daemon KEEPS SERVING its pre-existing session (drain-to-completion, not killed).
    const oldStillWorks = await oldSession.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, projectDir },
    });
    assert.equal(structured(oldStillWorks)?.status, "completed", textOf(oldStillWorks));

    await oldSession.dispose();
    await newSession.dispose();
  } finally {
    await oldDaemon.close();
    for (const successor of successors) await successor.close();
    resetDiscovery();
  }
});

test("lame-duck admission: a superseded daemon (daemon.json names a different pid) rejects new sessions with a clear error, keeps serving existing ones, and resumes normal service when discovery points back at it", async () => {
  resetDiscovery();
  const daemon = await createDaemon({ runner: okRunner(), port: 0, log: () => undefined });
  try {
    const projectDir = makeProjectDir("lame-duck");
    // Before supersession: a session admits and works.
    const existing = await connectHttp(daemon.url, { listTools: true });
    const before = await existing.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, projectDir },
    });
    assert.equal(structured(before)?.status, "completed", textOf(before));

    // A successor takes over discovery: daemon.json now names a DIFFERENT pid.
    writeDaemonInfo(infoForHandle(daemon, process.pid + 1, SERVER_VERSION));
    assert.equal(isSupersededBy(process.pid), true, "the daemon is now a lame duck");

    // /healthz reports the lame-duck status and the version.
    const health = (await (await fetch(`http://127.0.0.1:${daemon.port}/healthz`)).json()) as {
      lameDuck?: boolean;
      version: string;
    };
    assert.equal(health.lameDuck, true, "healthz surfaces lame-duck status");
    assert.equal(health.version, SERVER_VERSION);

    // The EXISTING session keeps working.
    const during = await existing.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, projectDir },
    });
    assert.equal(structured(during)?.status, "completed", textOf(during));

    // A NEW session is rejected at admission.
    await assert.rejects(connectHttp(daemon.url), "a new session must not land on a lame duck");
    // The rejection is a clear, explicit error at the HTTP layer.
    const raw = await fetch(daemon.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } },
      }),
    });
    assert.equal(raw.status, 503);
    const body = (await raw.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /superseded/i);

    // Discovery points BACK at this daemon → it resumes normal service.
    writeDaemonInfo(infoForHandle(daemon, process.pid, SERVER_VERSION));
    assert.equal(isSupersededBy(process.pid), false);
    const resumed = await connectHttp(daemon.url, { listTools: true });
    const after = await resumed.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, projectDir },
    });
    assert.equal(structured(after)?.status, "completed", textOf(after));

    await existing.dispose();
    await resumed.dispose();
  } finally {
    await daemon.close();
    resetDiscovery();
  }
});

test("lame-duck exit: a superseded daemon with zero sessions and zero runs exits on the next reaper tick — it does NOT wait for the idle TTL", async () => {
  resetDiscovery();
  const daemon = await createDaemon({ runner: okRunner(), port: 0, log: () => undefined });
  // Superseded from the outset: discovery names a different pid.
  writeDaemonInfo(infoForHandle(daemon, process.pid + 1, SERVER_VERSION));
  assert.equal(isSupersededBy(process.pid), true);

  const { handle, exits } = fakeProcess();
  const lifecycle = installDaemonLifecycle({
    daemon,
    runner: { dispose: async () => undefined } as never,
    ownPid: process.pid,
    idleTtlMs: 60_000, // a long idle TTL must not delay a superseded daemon's exit
    sessionTtlMs: 1_000,
    reaperIntervalMs: 20,
    process: handle,
    log: () => undefined,
  });
  try {
    await sleep(150);
    assert.deepEqual(exits, [0], "the superseded, idle daemon exits within a reaper tick, not the idle TTL");
  } finally {
    if (exits.length === 0) await lifecycle.shutdown("SIGTERM");
    resetDiscovery();
  }
});

test("lame-duck migration: a superseded daemon closes its idle sessions (their clients re-initialize on the successor) and then exits; nothing is cut mid-request", async () => {
  resetDiscovery();
  const daemon = await createDaemon({ runner: okRunner(), port: 0, log: () => undefined });
  const { handle, exits } = fakeProcess();
  const logs: string[] = [];
  let lifecycle: ReturnType<typeof installDaemonLifecycle> | undefined;
  try {
    const projectDir = makeProjectDir("lame-duck-migration");
    // A live session (standalone GET stream open, nothing in flight) on the daemon.
    const session = await connectHttp(daemon.url, { listTools: true });
    const before = await session.client.callTool({ name: "workflow", arguments: { script: NO_AGENT_SCRIPT, projectDir } });
    assert.equal(structured(before)?.status, "completed", textOf(before));
    assert.equal(daemon.sessions.size, 1);
    assert.equal(daemon.inflightRequestCount(), 0, "no request in flight between calls");

    // The daemon is NOT superseded: the reaper leaves the live session alone.
    lifecycle = installDaemonLifecycle({
      daemon,
      runner: { dispose: async () => undefined } as never,
      ownPid: process.pid,
      idleTtlMs: 60_000,
      sessionTtlMs: 60_000,
      reaperIntervalMs: 20,
      process: handle,
      log: (line) => logs.push(line),
    });
    await sleep(80);
    assert.equal(daemon.sessions.size, 1, "a live session on a current daemon is never evicted");
    assert.deepEqual(exits, []);

    // A successor takes over discovery → lame duck → the idle session is migrated (closed) and
    // the daemon exits on its own.
    writeDaemonInfo(infoForHandle(daemon, process.pid + 1, SERVER_VERSION));
    await sleep(200);
    assert.ok(logs.some((line) => line.includes("migrated 1 idle session(s)")), logs.join(" | "));
    assert.equal(daemon.sessions.size, 0, "the idle session was closed");
    assert.deepEqual(exits, [0], "with nothing left the lame duck exited");
    // The client's session is gone — its next request gets the spec's 404 (the shim's cue to
    // re-initialize on the successor). Here the raw HTTP client sees the rejection.
    await assert.rejects(
      session.client.callTool({ name: "workflow", arguments: { script: NO_AGENT_SCRIPT, projectDir } }),
      "the migrated session no longer exists on the lame duck",
    );
    await session.dispose().catch(() => undefined);
  } finally {
    if (exits.length === 0 && lifecycle !== undefined) await lifecycle.shutdown("SIGTERM");
    else await daemon.close().catch(() => undefined);
    resetDiscovery();
  }
});

test("version order: a daemon NEWER than the shim is adopted, never superseded (an old client migrating off a lame duck must not resurrect its old code)", async () => {
  resetDiscovery();
  const newer = await createDaemon({ runner: okRunner(), port: 0, log: () => undefined, version: "999.0.0" });
  try {
    writeDaemonInfo(infoForHandle(newer, process.pid, "999.0.0"));
    let spawned = false;
    const logs: string[] = [];
    const info = await ensureDaemonRunning({
      bundlePath: "unused-in-test",
      log: (line) => logs.push(line),
      spawn: () => {
        spawned = true;
      },
    });
    assert.equal(spawned, false, "no successor is spawned for a newer daemon");
    assert.equal(info.url, newer.url, "the newer daemon is adopted");
    assert.ok(logs.some((line) => line.includes("adopting daemon v999.0.0")), logs.join(" | "));
    assert.equal(isSupersededBy(process.pid), false, "discovery still names the newer daemon");
  } finally {
    await newer.close();
    resetDiscovery();
  }
});

test("pid-guard: a superseded (old) daemon's shutdown does NOT delete the successor's daemon.json", async () => {
  resetDiscovery();
  const oldDaemon = await createDaemon({ runner: okRunner(), port: 0, log: () => undefined });
  const successorPid = process.pid + 1;
  // The successor owns discovery (a different pid than the old daemon's).
  writeDaemonInfo(infoForHandle(oldDaemon, successorPid, SERVER_VERSION));

  const { handle, exits } = fakeProcess();
  const lifecycle = installDaemonLifecycle({
    daemon: oldDaemon,
    runner: { dispose: async () => undefined } as never,
    ownPid: process.pid, // the OLD daemon's pid, which no longer matches daemon.json
    idleTtlMs: 0, // no idle shutdown; we drive shutdown explicitly
    sessionTtlMs: 1_000,
    reaperIntervalMs: 10_000,
    process: handle,
    log: () => undefined,
  });
  try {
    // The old daemon shuts down. clearDaemonInfo(ownPid) must be a no-op because daemon.json
    // names the successor — the predecessor never clobbers its successor's discovery file.
    await lifecycle.shutdown("SIGTERM");
    assert.deepEqual(exits, [143]);
    const survived = readDaemonInfo();
    assert.ok(survived, "the successor's daemon.json must survive the old daemon's shutdown");
    assert.equal(survived.pid, successorPid, "daemon.json still names the successor");
  } finally {
    resetDiscovery();
  }
});
