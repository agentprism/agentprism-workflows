import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { PiAcpDeps } from "./deps.js";

interface ChildRecord {
  pid: number;
  pgid?: number;
  child: ChildProcess;
  leaderClosed: Promise<void>;
  termination?: Promise<void>;
  terminationSettled?: boolean;
}

export interface SpawnLease {
  register(child: ChildProcess): ChildRecord;
  failed(): void;
}

export class ChildCleanupFailure extends Error {
  constructor(readonly remainingChildren: number) {
    super("child process cleanup failed");
    this.name = "ChildCleanupFailure";
  }
}

/** One monotonic ownership epoch. A failed drain remains closing and is retryable. */
export class ChildProcessRegistry {
  private state: "open" | "closing" | "closed" = "open";
  private readonly children = new Map<number, ChildRecord>();
  private pendingSpawns = 0;
  private drain: Promise<void> | undefined;
  private generationSignal: AbortSignal | undefined;
  private changeWaiters = new Set<() => void>();

  constructor(private readonly deps: Pick<PiAcpDeps, "graceMs" | "sleep">) {}

  get remainingChildren(): number { return this.children.size; }
  get leaderPids(): readonly number[] { return [...this.children.keys()]; }

  beginSpawn(): SpawnLease {
    if (this.state !== "open") throw new Error("aborted");
    this.pendingSpawns += 1;
    let settled = false;
    return {
      failed: () => {
        if (settled) return;
        settled = true;
        this.pendingSpawns -= 1;
        this.changed();
      },
      register: (child) => {
        if (settled) throw new Error("spawn lease already settled");
        settled = true;
        this.pendingSpawns -= 1;
        const record = this.registerChild(child);
        if (this.state !== "open") {
          const signal = this.generationSignal;
          if (signal) this.startTermination(record, signal);
        }
        this.changed();
        return record;
      },
    };
  }

  private registerChild(child: ChildProcess): ChildRecord {
    if (!child.pid) throw new Error("bash child spawned without pid");
    let closeError: unknown;
    const leaderClosed = new Promise<void>((resolve, reject) => {
      child.once("error", (error) => {
        closeError = error;
        reject(error);
      });
      child.once("close", () => closeError === undefined ? resolve() : reject(closeError));
    });
    // A rejected leader promise is always observed by normal execution or cleanup.
    leaderClosed.catch(() => undefined);
    const record: ChildRecord = {
      pid: child.pid,
      pgid: process.platform === "win32" ? undefined : child.pid,
      child,
      leaderClosed,
    };
    this.children.set(record.pid, record);
    return record;
  }

  /** Natural operation completion never proves away a surviving Unix process group. */
  complete(record: ChildRecord): void {
    if (this.children.get(record.pid) !== record) return;
    if (process.platform === "win32" || this.groupState(record.pgid ?? record.pid) === "gone") {
      this.children.delete(record.pid);
      this.changed();
    }
  }

  /** Terminate one timed-out/aborted tool tree without closing admission for unrelated tools. */
  async terminateOne(record: ChildRecord): Promise<void> {
    if (this.children.get(record.pid) !== record) return;
    const deadline = new AbortController();
    const timer = new AbortController();
    const expiry = this.deps.sleep(this.deps.graceMs, timer.signal).then(() => {
      deadline.abort(new ChildCleanupFailure(this.children.size));
      throw new ChildCleanupFailure(this.children.size);
    });
    expiry.catch(() => undefined);
    try {
      await Promise.race([this.startTermination(record, deadline.signal), expiry]);
    } finally {
      timer.abort();
      if (record.termination) {
        await record.termination.catch(() => undefined);
        record.termination = undefined;
        record.terminationSettled = false;
      }
    }
  }

  terminateAll(deadlineSignal: AbortSignal): Promise<void> {
    if (this.drain) return this.drain;
    if (this.state === "closed" && this.children.size === 0 && this.pendingSpawns === 0) {
      return Promise.resolve();
    }
    this.state = "closing";
    this.generationSignal = deadlineSignal;
    for (const record of this.children.values()) {
      record.termination = undefined;
      record.terminationSettled = false;
      this.startTermination(record, deadlineSignal);
    }
    this.drain = this.drainGeneration(deadlineSignal)
      .then(() => { this.generationSignal = undefined; })
      .finally(() => { this.drain = undefined; });
    return this.drain;
  }

  private async drainGeneration(deadlineSignal: AbortSignal): Promise<void> {
    while (true) {
      for (const record of this.children.values()) this.startTermination(record, deadlineSignal);
      if (this.pendingSpawns === 0 && this.children.size === 0) {
        this.state = "closed";
        return;
      }
      if (deadlineSignal.aborted) throw new ChildCleanupFailure(this.children.size);
      const terminations = [...this.children.values()]
        .flatMap((record) => record.termination ? [record.termination] : []);
      if (this.pendingSpawns === 0 && terminations.length > 0) {
        await Promise.allSettled(terminations);
        if (this.children.size > 0) {
          if (deadlineSignal.aborted) throw new ChildCleanupFailure(this.children.size);
          // Every admitted record was attempted and at least one proof failed.
          const allSettled = [...this.children.values()].every((record) => record.terminationSettled);
          if (allSettled) throw new ChildCleanupFailure(this.children.size);
        }
        continue;
      }
      try {
        await Promise.race([this.waitForChange(), abortPromise(deadlineSignal)]);
      } catch {
        throw new ChildCleanupFailure(this.children.size);
      }
    }
  }

  private groupState(pgid: number): "alive" | "gone" | "error" {
    try {
      process.kill(-pgid, 0);
      return "alive";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "gone";
      if (code === "EPERM") return "alive";
      return "error";
    }
  }

  private startTermination(record: ChildRecord, deadlineSignal: AbortSignal): Promise<void> {
    if (record.termination) return record.termination;
    record.terminationSettled = false;
    record.termination = this.terminateRecord(record, deadlineSignal)
      .finally(() => { record.terminationSettled = true; });
    record.termination.catch(() => undefined);
    return record.termination;
  }

  private async terminateRecord(record: ChildRecord, deadlineSignal: AbortSignal): Promise<void> {
    if (process.platform === "win32") {
      await raceAbort(new Promise<void>((resolve, reject) => {
        const killer = spawn("taskkill", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true });
        killer.once("error", reject);
        killer.once("close", (code) => code === 0
          ? resolve()
          : reject(new Error(`taskkill exited ${code}`)));
      }), deadlineSignal);
    } else {
      try {
        process.kill(-(record.pgid ?? record.pid), "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await raceAbort(record.leaderClosed, deadlineSignal);
    if (process.platform !== "win32") {
      while (true) {
        const state = this.groupState(record.pgid ?? record.pid);
        if (state === "gone") break;
        if (state === "error") throw new Error("child process-group probe failed");
        await raceAbort(this.deps.sleep(10, deadlineSignal), deadlineSignal);
      }
    }
    this.children.delete(record.pid);
    this.changed();
  }

  private changed(): void {
    const waiters = this.changeWaiters;
    this.changeWaiters = new Set();
    for (const resolve of waiters) resolve();
  }

  private waitForChange(): Promise<void> {
    return new Promise((resolve) => {
      this.changeWaiters.add(resolve);
    });
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  return Promise.race([promise, abortPromise(signal)]);
}

export class ChildProcessRegistrySlot {
  private epoch: ChildProcessRegistry;
  private cleanupFailed = false;

  constructor(private readonly deps: Pick<PiAcpDeps, "graceMs" | "sleep">) {
    this.epoch = new ChildProcessRegistry(deps);
  }

  get registry(): ChildProcessRegistry { return this.epoch; }
  get childCleanupFailed(): boolean { return this.cleanupFailed; }
  get remainingChildren(): number { return this.epoch.remainingChildren; }
  beginSpawn(): SpawnLease { return this.epoch.beginSpawn(); }
  latchFailure(): void { this.cleanupFailed = true; }
  clearFailure(): void { this.cleanupFailed = false; }

  async terminateAll(shouldRotate: () => boolean, deadlineSignal: AbortSignal): Promise<void> {
    const captured = this.epoch;
    await captured.terminateAll(deadlineSignal);
    if (shouldRotate() && this.epoch === captured) {
      this.epoch = new ChildProcessRegistry(this.deps);
      this.cleanupFailed = false;
    }
  }
}

class BashCleanupSentinel extends Error {}

export function createTrackedBashOperations(
  slot: ChildProcessRegistrySlot,
  shellPath: string | undefined,
  deps: Pick<PiAcpDeps, "graceMs" | "sleep">,
  onCleanupFailure: () => void,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
      if (timeoutMs !== undefined && timeoutMs > 2_147_483_647) {
        throw new Error(`Invalid timeout: maximum is ${2_147_483_647 / 1000} seconds`);
      }
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      const shell = getShellConfig(shellPath);
      const stdin = shell.commandTransport === "stdin";
      const lease = slot.beginSpawn();
      let child: ChildProcess;
      try {
        child = spawn(shell.shell, stdin ? shell.args : [...shell.args, command], {
          cwd,
          detached: process.platform !== "win32",
          env,
          stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        lease.failed();
        throw error;
      }
      let record: ChildRecord;
      try {
        record = lease.register(child);
      } catch (error) {
        lease.failed();
        try { child.kill("SIGKILL"); } catch { /* no PID/tree was admitted */ }
        throw error;
      }
      if (stdin) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(command);
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const timerController = new AbortController();
      const timeoutResult = timeoutMs === undefined
        ? new Promise<never>(() => undefined)
        : deps.sleep(timeoutMs, timerController.signal).then(() => ({ type: "timeout" as const }));
      timeoutResult.catch(() => undefined);
      const abortResult = signal
        ? new Promise<{ type: "abort" }>((resolve) => {
          if (signal.aborted) resolve({ type: "abort" });
          else signal.addEventListener("abort", () => resolve({ type: "abort" }), { once: true });
        })
        : new Promise<never>(() => undefined);
      const exitResult = new Promise<{ type: "exit"; exitCode: number | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ type: "exit", exitCode }));
      });
      try {
        const outcome = await Promise.race([exitResult, abortResult, timeoutResult]);
        if (outcome.type === "exit") {
          slot.registry.complete(record);
          return { exitCode: outcome.exitCode };
        }
        try {
          await slot.registry.terminateOne(record);
        } catch {
          slot.latchFailure();
          onCleanupFailure();
          throw new BashCleanupSentinel();
        }
        if (outcome.type === "abort") throw new Error("aborted");
        throw new Error(`timeout:${timeout}`);
      } finally {
        timerController.abort();
      }
    },
  };
}
