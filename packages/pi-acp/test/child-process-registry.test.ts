import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PiAcpAgent } from "../src/agent.js";
import {
  ChildProcessRegistrySlot,
  createTrackedBashOperations,
  isTaskkillAlreadyGone,
} from "../src/child-process-registry.js";
import { realSleep } from "../src/deps.js";
import { context, fakeDeps } from "./helpers/fakes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function gatedRealSleep(gatedMs: number, gate: Promise<void>): typeof realSleep {
  return async (ms, signal) => {
    if (ms === gatedMs) {
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      await Promise.race([gate, aborted]);
    }
    return realSleep(ms, signal);
  };
}

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

function fakeChild(pid: number): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperty(child, "pid", { value: pid });
  return child;
}

const processTreeFixture = fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url));
const quote = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;
const treeCommand = (leaderPath: string, descendantPath: string): string =>
  `${quote(process.execPath)} ${quote(processTreeFixture)} ${quote(leaderPath)} ${quote(descendantPath)}`;

test("A1 tracked bash abort waits for the leader and descendant process tree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-acp-bash-tree-"));
  const leaderPath = join(cwd, "leader.pid");
  const descendantPath = join(cwd, "descendant.pid");
  const slot = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  let cleanupFailed = false;
  const operations = createTrackedBashOperations(slot, undefined, { graceMs: 5_000, sleep: realSleep }, () => {
    cleanupFailed = true;
  });
  const controller = new AbortController();
  const running = operations.exec(
    treeCommand(leaderPath, descendantPath),
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
  const cwd = await mkdtemp(join(tmpdir(), "pi-acp-bash-timeout-"));
  const pidPath = join(cwd, "leader.pid");
  const descendantPath = join(cwd, "descendant.pid");
  const timeoutClock = deferred<void>();
  const slot = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const operations = createTrackedBashOperations(slot, undefined, {
    graceMs: 5_000,
    sleep: gatedRealSleep(50, timeoutClock.promise),
  }, () => {
    assert.fail("successful timeout cleanup must not latch a session failure");
  });
  const running = operations.exec(
    treeCommand(pidPath, descendantPath),
    cwd,
    { onData() {}, signal: new AbortController().signal, timeout: 0.05, env: { ...process.env } },
  );
  const pid = await readPid(pidPath);
  const descendant = await readPid(descendantPath);
  const rejection = assert.rejects(running, /timeout:0\.05/);
  timeoutClock.resolve();
  await rejection;
  assert.equal(slot.remainingChildren, 0);
  await assertGone(pid);
  await assertGone(descendant);
});

test("A2 concurrent session registries never kill across ownership boundaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-acp-bash-isolation-"));
  const paths = {
    aLeader: join(cwd, "a-leader.pid"),
    aDescendant: join(cwd, "a-descendant.pid"),
    bLeader: join(cwd, "b-leader.pid"),
    bDescendant: join(cwd, "b-descendant.pid"),
  };
  const slotA = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const slotB = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const operationsA = createTrackedBashOperations(slotA, undefined, { graceMs: 5_000, sleep: realSleep }, () => assert.fail("A cleanup failed"));
  const operationsB = createTrackedBashOperations(slotB, undefined, { graceMs: 5_000, sleep: realSleep }, () => assert.fail("B cleanup failed"));
  const abortA = new AbortController();
  const abortB = new AbortController();
  const runningA = operationsA.exec(
    treeCommand(paths.aLeader, paths.aDescendant),
    cwd,
    { onData() {}, signal: abortA.signal, timeout: 60, env: { ...process.env } },
  );
  const runningB = operationsB.exec(
    treeCommand(paths.bLeader, paths.bDescendant),
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

test("A1 real leader and descendant drain through cancel, close, failed-open rollback, and shutdown", { timeout: 30_000 }, async () => {
  for (const lifecycle of ["cancel", "close", "failed-open", "shutdown"] as const) {
    const setup = fakeDeps();
    setup.deps.graceMs = 5_000;
    const leaderPath = join(setup.cwd, `${lifecycle}-leader.pid`);
    const descendantPath = join(setup.cwd, `${lifecycle}-descendant.pid`);
    const realCreate = setup.deps.createAgentSession;
    let running: Promise<unknown> | undefined;
    let toolController: AbortController | undefined;
    setup.deps.createAgentSession = async (options) => {
      const result = await realCreate(options);
      const control = setup.controls.at(-1)!;
      const bash = control.tools.find(({ name }) => name === "bash");
      assert.ok(bash, "tracked control bash must be installed");
      const startTree = () => {
        toolController = new AbortController();
        running = bash.execute("tree-call", {
          command: treeCommand(leaderPath, descendantPath),
          timeout: 60,
        }, toolController.signal);
        running.catch(() => undefined);
        return running;
      };
      control.session.abort = async () => {
        toolController?.abort(new Error(`${lifecycle} cleanup`));
        await running?.catch(() => undefined);
      };
      control.session.prompt = async () => { await startTree(); };
      if (lifecycle === "failed-open") {
        void startTree();
        control.session.bindExtensions = async () => {
          await Promise.all([readPid(leaderPath), readPid(descendantPath)]);
          throw new Error("failed after tracked child admission");
        };
      }
      return result;
    };
    const agent = new PiAcpAgent(setup.deps);
    if (lifecycle === "failed-open") {
      await assert.rejects(agent.newSession(context({ cwd: setup.cwd, mcpServers: [] })));
    } else {
      const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
      const prompt = agent.prompt(context({
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: "launch tree" }],
      }));
      await Promise.all([readPid(leaderPath), readPid(descendantPath)]);
      if (lifecycle === "cancel") {
        agent.cancel(context({ sessionId: opened.sessionId }) as never);
        await Promise.allSettled([prompt]);
        await agent.closeSession(context({ sessionId: opened.sessionId }));
      } else if (lifecycle === "close") {
        await Promise.allSettled([prompt, agent.closeSession(context({ sessionId: opened.sessionId }))]);
      } else {
        await Promise.allSettled([prompt, agent.dispose()]);
      }
    }
    const leader = await readPid(leaderPath);
    const descendant = await readPid(descendantPath);
    await Promise.all([assertGone(leader), assertGone(descendant)]);
    await agent.dispose();
  }
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

  const raced = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const lease = raced.beginSpawn();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 180_000)"], {
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

test("A1 Windows ownership requires successful taskkill /T /F and leader close", async () => {
  const taskkills: number[] = [];
  const taskkillResolvers: Array<() => void> = [];
  const slot = new ChildProcessRegistrySlot({
    platform: "win32",
    graceMs: 5_000,
    sleep: realSleep,
    taskkillTree(pid) {
      taskkills.push(pid);
      return new Promise<void>((resolve) => taskkillResolvers.push(resolve));
    },
  });
  const child = fakeChild(41_001);
  const record = slot.beginSpawn().register(child);
  child.emit("close", 0);
  slot.registry.complete(record);
  assert.equal(slot.remainingChildren, 1, "natural leader close cannot discard Windows tree ownership");
  const deadline = new AbortController();
  const draining = slot.terminateAll(() => false, deadline.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(taskkills, [41_001]);
  assert.equal(slot.remainingChildren, 1);
  taskkillResolvers[0]?.();
  await draining;
  assert.equal(slot.remainingChildren, 0);

  const held = new ChildProcessRegistrySlot({
    platform: "win32",
    graceMs: 5_000,
    sleep: realSleep,
    async taskkillTree() {},
  });
  const heldChild = fakeChild(41_002);
  held.beginSpawn().register(heldChild);
  let settled = false;
  const heldDrain = held.terminateAll(() => false, new AbortController().signal)
    .then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "taskkill success alone cannot remove a live leader record");
  heldChild.emit("close", 0);
  await heldDrain;
  assert.equal(held.remainingChildren, 0);
});

test("A1 Windows already-exited taskkill output is success without accepting other failures", () => {
  assert.equal(isTaskkillAlreadyGone('ERROR: The process "41001" not found.\r\n'), true);
  assert.equal(isTaskkillAlreadyGone("ERROR: The process with PID 41001 could not be terminated.\r\nReason: There is no running instance of the task.\r\n"), true);
  assert.equal(isTaskkillAlreadyGone("ERROR: Access is denied.\r\n"), false);
  assert.equal(isTaskkillAlreadyGone("ERROR: Invalid argument/option.\r\n"), false);
});

test("A1 Unix ownership retains a naturally closed leader until process-group ESRCH proof", async () => {
  let probe: "alive" | "gone" = "alive";
  const killed: number[] = [];
  const slot = new ChildProcessRegistrySlot({
    platform: "linux",
    graceMs: 5_000,
    sleep: async () => { probe = "gone"; },
    processGroupState: () => probe,
    killProcessGroup: (pgid) => { killed.push(pgid); },
  });
  const child = fakeChild(42_001);
  const record = slot.beginSpawn().register(child);
  child.emit("close", 0);
  slot.registry.complete(record);
  assert.equal(slot.remainingChildren, 1);
  await slot.terminateAll(() => false, new AbortController().signal);
  assert.deepEqual(killed, [42_001]);
  assert.equal(slot.remainingChildren, 0);
});

test("A1 timeout-owned kill failure latches the record and a later generation reaps it", async () => {
  if (process.platform === "win32") return;
  const cwd = await mkdtemp(join(tmpdir(), "pi-acp-bash-kill-failure-"));
  const pidPath = join(cwd, "leader.pid");
  const timeoutClock = deferred<void>();
  let failKill = true;
  let cleanupFailures = 0;
  const groupState = (pgid: number): "alive" | "gone" | "error" => {
    try {
      process.kill(-pgid, 0);
      return "alive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "error";
    }
  };
  const slot = new ChildProcessRegistrySlot({
    graceMs: 5_000,
    sleep: realSleep,
    platform: "linux",
    processGroupState: groupState,
    killProcessGroup(pgid) {
      if (failKill) throw new Error("injected process-group kill failure");
      process.kill(-pgid, "SIGKILL");
    },
  });
  const operations = createTrackedBashOperations(slot, "/bin/bash", {
    graceMs: 5_000,
    sleep: gatedRealSleep(30, timeoutClock.promise),
  }, () => {
    cleanupFailures += 1;
  });
  const running = operations.exec(
    `echo $$ > ${pidPath}; sleep 180`,
    cwd,
    { onData() {}, signal: new AbortController().signal, timeout: 0.03, env: { ...process.env } },
  );
  const pid = await readPid(pidPath);
  const rejection = assert.rejects(running);
  timeoutClock.resolve();
  await rejection;
  assert.equal(cleanupFailures, 1);
  assert.equal(slot.childCleanupFailed, true);
  assert.equal(slot.remainingChildren, 1);
  assert.doesNotThrow(() => process.kill(pid, 0));
  failKill = false;
  await slot.terminateAll(() => false, new AbortController().signal);
  await assertGone(pid);
  assert.equal(slot.remainingChildren, 0);
});

test("A1 exact proof deadline retains ownership until a successful retry", async () => {
  const expiry = deferred<void>();
  let deadlineCount = 0;
  let state: "alive" | "gone" = "alive";
  const slot = new ChildProcessRegistrySlot({
    platform: "linux",
    graceMs: 5_000,
    sleep(ms) {
      if (ms === 5_000 && ++deadlineCount === 1) return expiry.promise;
      return new Promise<void>(() => undefined);
    },
    processGroupState: () => state,
    killProcessGroup() {},
  });
  const child = fakeChild(43_001);
  const record = slot.beginSpawn().register(child);
  const terminating = slot.registry.terminateOne(record);
  expiry.resolve();
  await assert.rejects(terminating, (error) => error instanceof Error && error.name === "ChildCleanupFailure");
  assert.equal(slot.remainingChildren, 1);
  state = "gone";
  child.emit("close", 0);
  await slot.terminateAll(() => false, new AbortController().signal);
  assert.equal(slot.remainingChildren, 0);
});

test("A1 Windows taskkill failure retains the closed leader record for retry", async () => {
  let attempts = 0;
  const slot = new ChildProcessRegistrySlot({
    platform: "win32",
    graceMs: 5_000,
    sleep: realSleep,
    async taskkillTree() {
      attempts += 1;
      if (attempts === 1) throw new Error("taskkill failed");
    },
  });
  const child = fakeChild(43_002);
  slot.beginSpawn().register(child);
  child.emit("close", 0);
  await assert.rejects(slot.terminateAll(() => false, new AbortController().signal));
  assert.equal(slot.remainingChildren, 1);
  await slot.terminateAll(() => false, new AbortController().signal);
  assert.equal(attempts, 2);
  assert.equal(slot.remainingChildren, 0);
});

test("A1 cancel-only epoch rotation is a separate whole-generation commit", async () => {
  const slot = new ChildProcessRegistrySlot({ graceMs: 5_000, sleep: realSleep });
  const closed = slot.closeEpoch(new AbortController().signal);
  await closed.drain;
  assert.throws(() => slot.beginSpawn(), /aborted/, "registry drain alone must not publish fresh admission");
  slot.commitRotation(closed.epoch);
  const fresh = slot.beginSpawn();
  fresh.failed();
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
