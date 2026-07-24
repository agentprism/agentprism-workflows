// daemon-info: daemon.json read/write/clear with pid guard, the wx spawn lock with
// stale-holder recovery, and the env fingerprint the shim uses to detect config divergence.
// Importing _harness isolates $HOME so daemon.json lands in a throwaway workflow home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import "../_harness.js";
import {
  claimSpawnLock,
  clearDaemonInfo,
  daemonInfoPath,
  daemonLockPath,
  envFingerprint,
  pidIsAlive,
  readDaemonInfo,
  releaseSpawnLock,
  writeDaemonInfo,
  type DaemonInfo,
} from "../../src/daemon/daemon-info.js";

/** A pid that existed a moment ago and is now certainly dead. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 0);
  return pid;
}

function info(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    name: "agentprism-daemon",
    version: "0.0.0-test",
    pid: process.pid,
    port: 29888,
    url: "http://127.0.0.1:29888/mcp",
    startedAt: new Date().toISOString(),
    envFingerprint: envFingerprint({}),
    ...overrides,
  };
}

test("daemon.json roundtrips, is 0600, and unparseable/foreign content reads as undefined", () => {
  writeDaemonInfo(info());
  const read = readDaemonInfo();
  assert.ok(read);
  assert.equal(read.pid, process.pid);
  assert.equal(read.url, "http://127.0.0.1:29888/mcp");
  assert.equal(statSync(daemonInfoPath()).mode & 0o777, 0o600);

  writeFileSync(daemonInfoPath(), "{not json");
  assert.equal(readDaemonInfo(), undefined);
  writeFileSync(daemonInfoPath(), JSON.stringify({ name: "something-else", pid: 1, port: 1, url: "x", version: "1" }));
  assert.equal(readDaemonInfo(), undefined);
});

test("clearDaemonInfo removes only its own pid's file", () => {
  writeDaemonInfo(info({ pid: process.pid }));
  clearDaemonInfo(process.pid + 1); // a successor must not clobber
  assert.ok(readDaemonInfo());
  clearDaemonInfo(process.pid);
  assert.equal(readDaemonInfo(), undefined);
});

test("pidIsAlive: own pid alive, freshly exited pid dead", () => {
  assert.equal(pidIsAlive(process.pid), true);
  assert.equal(pidIsAlive(deadPid()), false);
  assert.equal(pidIsAlive(0), false);
  assert.equal(pidIsAlive(-1), false);
});

test("spawn lock: single claim wins, live holder blocks, release is token-checked", () => {
  const lock = claimSpawnLock();
  assert.ok(lock, "first claim should win");
  // A concurrent claimant (same process pid counts as alive) is refused.
  assert.equal(claimSpawnLock(), null);
  // Wrong-token release is a no-op.
  releaseSpawnLock({ pid: lock.pid, startedAt: lock.startedAt, token: "someone-else" });
  assert.ok(existsSync(daemonLockPath()));
  releaseSpawnLock(lock);
  assert.equal(existsSync(daemonLockPath()), false);
});

test("spawn lock held by a dead pid is recovered", () => {
  writeFileSync(daemonLockPath(), JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), token: "stale" }));
  const lock = claimSpawnLock();
  assert.ok(lock, "stale lock should be recovered");
  releaseSpawnLock(lock);
});

test("envFingerprint tracks runner-relevant vars and ignores unrelated or TTL-only vars", () => {
  const base = envFingerprint({ AGENTPRISM_BACKENDS: '{"a":1}', PATH: "/usr/bin" });
  assert.equal(base, envFingerprint({ AGENTPRISM_BACKENDS: '{"a":1}', PATH: "/somewhere/else", EDITOR: "vi" }));
  assert.notEqual(base, envFingerprint({ AGENTPRISM_BACKENDS: '{"a":2}' }));
  assert.notEqual(base, envFingerprint({}));
  assert.equal(
    envFingerprint({ AGENTPRISM_DAEMON_IDLE_TTL_MS: "1", AGENTPRISM_SESSION_TTL_MS: "2" }),
    envFingerprint({}),
  );
});
