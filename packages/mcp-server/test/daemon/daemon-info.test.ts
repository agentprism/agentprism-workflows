// daemon-info: daemon.json read/write/clear with pid guard, the wx spawn lock with
// stale-holder recovery, and the env fingerprint the shim uses to detect config divergence.
// Importing _harness isolates $HOME so daemon.json lands in a throwaway workflow home.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import "../_harness.js";
import {
  claimSpawnLock,
  clearDaemonInfo,
  compareVersions,
  daemonInfoPath,
  daemonInstancePath,
  daemonLockPath,
  envFingerprint,
  findDaemonInstanceOnPort,
  isDaemonProcess,
  isSupersededBy,
  listDaemonInstances,
  listDaemonProcesses,
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

test("family pointers: writeDaemonInfo records the instance and repoints ONLY its own env family", () => {
  const familyA = envFingerprint({ AGENTPRISM_BACKENDS: "a" });
  const familyB = envFingerprint({ AGENTPRISM_BACKENDS: "b" });
  writeDaemonInfo(info({ pid: process.pid, envFingerprint: familyA, port: 41001 }));
  assert.equal(readDaemonInfo(familyA)?.port, 41001);
  assert.equal(readDaemonInfo(familyB), undefined, "another env family is untouched");
  assert.equal(existsSync(daemonInstancePath(process.pid)), true, "the instance record exists");
  assert.equal(findDaemonInstanceOnPort(41001)?.info.pid, process.pid);
  // Clearing the instance removes its pointer (pid-guarded) and its record.
  clearDaemonInfo(process.pid);
  assert.equal(readDaemonInfo(familyA), undefined);
  assert.equal(existsSync(daemonInstancePath(process.pid)), false);
});

test("listDaemonInstances lists live instances and prunes dead instance records", () => {
  const dead = deadPid();
  writeFileSync(daemonInstancePath(dead), JSON.stringify(info({ pid: dead })));
  writeDaemonInfo(info({ pid: process.pid, port: 41002 }));
  try {
    assert.deepEqual(listDaemonInstances().map((i) => i.info.port), [41002], "the live instance is listed; the dead one is pruned");
    assert.equal(existsSync(daemonInstancePath(dead)), false, "dead instance records are pruned");
  } finally {
    clearDaemonInfo(process.pid);
  }
});

test("isSupersededBy: a pointer naming another pid OR no pointer at all means superseded; only a pointer naming ownPid does not", () => {
  const family = envFingerprint({ AGENTPRISM_BACKENDS: "supersede-test" });
  try {
    assert.equal(isSupersededBy(process.pid, family), true, "no pointer: a successor came and went");
    writeDaemonInfo(info({ pid: process.pid, envFingerprint: family, port: 41004 }));
    assert.equal(isSupersededBy(process.pid, family), false, "the pointer names this daemon");
    writeDaemonInfo(info({ pid: process.pid + 1, envFingerprint: family, port: 41005 }));
    assert.equal(isSupersededBy(process.pid, family), true, "the pointer names a successor");
  } finally {
    clearDaemonInfo(process.pid);
    clearDaemonInfo(process.pid + 1);
  }
});

test("listDaemonProcesses/isDaemonProcess find a --daemon-run process of ours by its command line, and nothing else", { skip: process.platform === "win32" }, async () => {
  // A stand-in daemon: any process whose argv carries --daemon-run and our bundle marker.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--daemon-run", "agentprism-test-marker"], { stdio: "ignore" });
  const pid = child.pid!;
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const listed = listDaemonProcesses().find((proc) => proc.pid === pid);
    assert.ok(listed, "the stand-in daemon is listed from the process table");
    assert.match(listed.args, /--daemon-run/);
    assert.equal(isDaemonProcess(pid), true);
    assert.equal(isDaemonProcess(process.pid), false, "this test process is not a daemon");
    assert.equal(listDaemonProcesses().some((proc) => proc.pid === process.pid), false, "never lists itself");
  } finally {
    child.kill("SIGKILL");
  }
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(isDaemonProcess(pid), false, "a dead pid is not a daemon process");
  assert.equal(listDaemonProcesses().some((proc) => proc.pid === pid), false);
});

test("compareVersions is a total order: numeric fields, prerelease below release, unparseable falls back to string order", () => {
  assert.ok(compareVersions("0.29.0", "0.29.2") < 0);
  assert.ok(compareVersions("0.49.0", "0.29.2") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("1.2.3-beta.1", "1.2.3") < 0);
  assert.ok(compareVersions("1.2.3", "1.2.3-beta.1") > 0);
  assert.ok(compareVersions("1.2.3-alpha", "1.2.3-beta") < 0);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0, "numeric, not lexicographic");
  assert.ok(compareVersions("0.0.0-old", "0.0.0-test") < 0);
  assert.ok(compareVersions("garbage", "0.1.0") > 0, "string fallback keeps the order total");
});
