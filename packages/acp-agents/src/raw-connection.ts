import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { Backend } from "./backend.js";

const GRACEFUL_CLOSE_MS = 1_000;
const SIGTERM_CLOSE_MS = 1_000;

export interface RawBackendConnection {
  readonly backendId: string;
  readonly stream: Stream;
  readonly closed: Promise<void>;
  readonly stderrTail: string;
  close(): Promise<void>;
  killNow(): void;
}

/**
 * Spawn one configured ACP backend and expose its uninitialized stdio stream.
 *
 * Unlike {@link PooledConnection}, this primitive does not send `initialize`, register client
 * handlers, open sessions, or interpret protocol traffic. The caller owns the complete ACP
 * exchange and must close the returned process connection.
 */
export async function openRawBackendConnection(backend: Backend): Promise<RawBackendConnection> {
  const { command, args, env } = backend.spawnConfig();
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });

  if (!child.stdin || !child.stdout) {
    killProcessTree(child, "SIGKILL");
    throw new Error(`Failed to spawn ACP agent (${backend.id}): missing stdio pipes`);
  }

  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4_000);
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  child.once("exit", resolveClosed);
  child.once("error", resolveClosed);

  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(new Error(`Failed to spawn ACP agent (${backend.id}): ${error.message}`));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  const onHostExit = () => killProcessTree(child, "SIGKILL");
  process.once("exit", onHostExit);
  void closed.then(() => process.removeListener("exit", onHostExit));

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin?.end();
      if (await settlesWithin(closed, GRACEFUL_CLOSE_MS)) return;
      killProcessTree(child, "SIGTERM");
      if (await settlesWithin(closed, SIGTERM_CLOSE_MS)) return;
      killProcessTree(child, "SIGKILL");
      await closed;
    })().finally(() => process.removeListener("exit", onHostExit));
    return closePromise;
  };

  return {
    backendId: backend.id,
    stream,
    closed,
    get stderrTail() {
      return stderrTail;
    },
    close,
    killNow: () => killProcessTree(child, "SIGKILL"),
  };
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process exited between the liveness check and the signal.
    }
  }
}
