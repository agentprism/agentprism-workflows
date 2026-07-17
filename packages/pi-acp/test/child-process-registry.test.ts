import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiAcpAgent } from "../src/agent.js";
import {
  ChildProcessRegistrySlot,
  createTrackedBashOperations,
} from "../src/child-process-registry.js";
import { realSleep } from "../src/deps.js";
import { context, fakeDeps } from "./helpers/fakes.js";

async function eventually<T>(operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function readPid(path: string): Promise<number> {
  return eventually(async () => {
    const pid = Number((await readFile(path, "utf8")).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    return pid;
  });
}

async function assertGone(pid: number): Promise<void> {
  await eventually(async () => {
    assert.throws(
      () => process.kill(pid, 0),
      (error: NodeJS.ErrnoException) => error.code === "ESRCH",
    );
  });
}

test("A1 tracked bash abort waits for the leader and descendant process tree", async () => {
  if (process.platform === "win32") {
    assert.equal(process.platform, "win32");
    return;
  }
  const cwd = await mkdtemp(join(tmpdir(), "pi-acp-bash-tree-"));
  const leaderPath = join(cwd, "leader.pid");
  const descendantPath = join(cwd, "descendant.pid");
  const slot = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  let cleanupFailed = false;
  const operations = createTrackedBashOperations(slot, "/bin/bash", { graceMs: 5_000, sleep: realSleep }, () => {
    cleanupFailed = true;
  });
  const controller = new AbortController();
  const running = operations.exec(
    `echo $$ > ${leaderPath}; sleep 180 & echo $! > ${descendantPath}; wait`,
    cwd,
    { onData() {}, signal: controller.signal, timeout: 60, env: { ...process.env } },
  );
  const leader = await readPid(leaderPath);
  const descendant = await readPid(descendantPath);
  controller.abort();
  await assert.rejects(running, /aborted/);
  assert.equal(cleanupFailed, false);
  assert.equal(slot.remainingChildren, 0);
  await assertGone(leader);
  await assertGone(descendant);
});

test("A1 tracked bash timeout retains the ordinary Pi timeout only after disappearance proof", async () => {
  if (process.platform === "win32") {
    assert.equal(process.platform, "win32");
    return;
  }
  const cwd = await mkdtemp(join(tmpdir(), "pi-acp-bash-timeout-"));
  const pidPath = join(cwd, "leader.pid");
  const slot = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const operations = createTrackedBashOperations(slot, "/bin/bash", { graceMs: 5_000, sleep: realSleep }, () => {
    assert.fail("successful timeout cleanup must not latch a session failure");
  });
  const running = operations.exec(
    `echo $$ > ${pidPath}; sleep 180`,
    cwd,
    { onData() {}, signal: new AbortController().signal, timeout: 0.05, env: { ...process.env } },
  );
  const pid = await readPid(pidPath);
  await assert.rejects(running, /timeout:0\.05/);
  assert.equal(slot.remainingChildren, 0);
  await assertGone(pid);
});

test("A2 concurrent session registries never kill across ownership boundaries", async () => {
  if (process.platform === "win32") {
    assert.equal(process.platform, "win32");
    return;
  }
  const cwd = await mkdtemp(join(tmpdir(), "pi-acp-bash-isolation-"));
  const paths = {
    aLeader: join(cwd, "a-leader.pid"),
    aDescendant: join(cwd, "a-descendant.pid"),
    bLeader: join(cwd, "b-leader.pid"),
    bDescendant: join(cwd, "b-descendant.pid"),
  };
  const slotA = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const slotB = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const operationsA = createTrackedBashOperations(slotA, "/bin/bash", { graceMs: 5_000, sleep: realSleep }, () => assert.fail("A cleanup failed"));
  const operationsB = createTrackedBashOperations(slotB, "/bin/bash", { graceMs: 5_000, sleep: realSleep }, () => assert.fail("B cleanup failed"));
  const abortA = new AbortController();
  const abortB = new AbortController();
  const runningA = operationsA.exec(
    `echo $$ > ${paths.aLeader}; sleep 180 & echo $! > ${paths.aDescendant}; wait`,
    cwd,
    { onData() {}, signal: abortA.signal, timeout: 60, env: { ...process.env } },
  );
  const runningB = operationsB.exec(
    `echo $$ > ${paths.bLeader}; sleep 180 & echo $! > ${paths.bDescendant}; wait`,
    cwd,
    { onData() {}, signal: abortB.signal, timeout: 60, env: { ...process.env } },
  );
  const [aLeader, aDescendant, bLeader, bDescendant] = await Promise.all([
    readPid(paths.aLeader), readPid(paths.aDescendant), readPid(paths.bLeader), readPid(paths.bDescendant),
  ]);

  abortA.abort();
  await assert.rejects(runningA, /aborted/);
  await Promise.all([assertGone(aLeader), assertGone(aDescendant)]);
  assert.doesNotThrow(() => process.kill(bLeader, 0));
  assert.doesNotThrow(() => process.kill(bDescendant, 0));
  assert.equal(slotA.remainingChildren, 0);
  assert.equal(slotB.remainingChildren, 1);

  abortB.abort();
  await assert.rejects(runningB, /aborted/);
  await Promise.all([assertGone(bLeader), assertGone(bDescendant)]);
  assert.equal(slotB.remainingChildren, 0);
});

test("A1 spawn admission covers closing-before-spawn and registration-after-close races", async () => {
  const slot = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const held = slot.beginSpawn();
  const deadline = new AbortController();
  const cleanup = slot.terminateAll(() => true, deadline.signal);
  assert.throws(() => slot.beginSpawn(), /aborted/);
  held.failed();
  await cleanup;
  const fresh = slot.beginSpawn();
  fresh.failed();

  if (process.platform === "win32") return;
  const raced = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const lease = raced.beginSpawn();
  const child = spawn("/bin/bash", ["-c", "sleep 180"], {
    detached: true,
    stdio: "ignore",
  });
  const racedDeadline = new AbortController();
  const draining = raced.terminateAll(() => false, racedDeadline.signal);
  assert.throws(() => raced.beginSpawn(), /aborted/);
  const pid = child.pid;
  assert.ok(pid);
  lease.register(child);
  await draining;
  assert.equal(raced.remainingChildren, 0);
  await assertGone(pid);
});

test("A3 expired generations retain admission state and a fresh close generation retries", async () => {
  const slot = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const lease = slot.beginSpawn();
  const firstDeadline = new AbortController();
  const first = slot.terminateAll(() => false, firstDeadline.signal);
  firstDeadline.abort(new Error("deadline"));
  await assert.rejects(first, /child process cleanup failed/);
  assert.throws(() => slot.beginSpawn(), /aborted/);
  lease.failed();
  const retryDeadline = new AbortController();
  await slot.terminateAll(() => false, retryDeadline.signal);
  assert.equal(slot.remainingChildren, 0);
  assert.throws(() => slot.beginSpawn(), /aborted/);
});

test("A3 retained close cleanup failure retries abort work but memoizes resource disposal", async () => {
  const setup = fakeDeps();
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const control = setup.controls[0];
  assert.ok(control);
  let abortCalls = 0;
  control.session.abort = async () => {
    abortCalls += 1;
    if (abortCalls === 1) throw new Error("abort proof failed");
  };
  await assert.rejects(
    agent.closeSession(context({ sessionId: opened.sessionId })),
    (error: { code?: unknown; data?: { errorKind?: unknown; details?: unknown } }) => {
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        errorKind: "child_cleanup_error",
        message: "child process cleanup failed",
        details: { remainingChildren: 0 },
      });
      return true;
    },
  );
  assert.equal(control.disposeCalls, 1);
  assert.throws(
    () => agent.prompt(context({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "closed" }] })),
    (error: { data?: { errorKind?: unknown } }) => error.data?.errorKind === "session_terminated",
  );
  assert.deepEqual(await agent.closeSession(context({ sessionId: opened.sessionId })), {});
  assert.equal(abortCalls, 2);
  assert.equal(control.disposeCalls, 1);
  assert.deepEqual(await agent.closeSession(context({ sessionId: opened.sessionId })), {});
  assert.equal(abortCalls, 2);
});

test("A3 top-level disposal joins concurrent callers and permits fail-to-success retry", async () => {
  const setup = fakeDeps();
  const agent = new PiAcpAgent(setup.deps);
  await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const control = setup.controls[0];
  assert.ok(control);
  let abortCalls = 0;
  control.session.abort = async () => {
    abortCalls += 1;
    if (abortCalls === 1) throw new Error("first generation failure");
  };
  const first = agent.dispose();
  const joined = agent.dispose();
  assert.equal(first, joined);
  await assert.rejects(first, (error: { data?: { errorKind?: unknown } }) =>
    error.data?.errorKind === "child_cleanup_error");
  assert.equal(abortCalls, 1);
  assert.equal(control.disposeCalls, 1);
  await agent.dispose();
  assert.equal(abortCalls, 2);
  assert.equal(control.disposeCalls, 1);
  await agent.dispose();
  assert.equal(abortCalls, 2);
});

test("A3 top-level disposal retains ownership through repeated failed generations", async () => {
  const setup = fakeDeps();
  const agent = new PiAcpAgent(setup.deps);
  await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const control = setup.controls[0];
  assert.ok(control);
  let abortCalls = 0;
  control.session.abort = async () => {
    abortCalls += 1;
    if (abortCalls <= 2) throw new Error(`generation ${abortCalls} failure`);
  };
  await assert.rejects(agent.dispose(), (error: { data?: { errorKind?: unknown } }) =>
    error.data?.errorKind === "child_cleanup_error");
  await assert.rejects(agent.dispose(), (error: { data?: { errorKind?: unknown } }) =>
    error.data?.errorKind === "child_cleanup_error");
  assert.equal(control.disposeCalls, 1);
  await agent.dispose();
  assert.equal(abortCalls, 3);
  assert.equal(control.disposeCalls, 1);
  await agent.dispose();
  assert.equal(abortCalls, 3);
});
