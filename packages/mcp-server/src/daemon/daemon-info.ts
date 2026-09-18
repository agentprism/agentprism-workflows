/**
 * Discovery and single-instance coordination for the workflow daemon.
 *
 * Layout under the workflow home (`~/.agentprism/workflows` or AGENTPRISM_PERSISTENCE_ROOT):
 *
 *   daemons/<envFingerprint>.json       the FAMILY POINTER — "the current daemon for this env"
 *   daemons/<envFingerprint>.lock       the family's spawn lock (wx + stale-pid recovery)
 *   daemons/instances/<pid>.json        one record per live daemon, for `daemon status`/`stop --all`
 *
 * These files are hints, not truth: the CLI reconciles them against the OS process table
 * (`listDaemonProcesses`), so a daemon that lost or never wrote its record is still listed and
 * stoppable. Supersession is a one-way door: once the pointer names another daemon (or is gone),
 * the daemon it left behind stays superseded for life (the latch lives in createDaemon).
 *
 * A daemon serves every client with the env it was started with (the ACP backend registry is
 * resolved once at construction), so clients are keyed by their env fingerprint: every distinct
 * env gets its own daemon family and no two families ever contend. Inside a family, version is
 * a TOTAL ORDER: a shim supersedes a daemon that is strictly OLDER than itself and adopts one
 * that is equal or newer. That asymmetry is what makes succession converge — an old client
 * migrating off a superseded daemon can never resurrect its old code and flip discovery back.
 *
 * The pointer is written 0600 via tmp+rename after the port is bound and cleared (pid-guarded)
 * on graceful shutdown; readers always pid-check because a crash leaves files behind.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { workflowHomeDir } from "@automatalabs/workflows";

import { DAEMON_NAME, DAEMON_IDLE_TTL_ENV, SESSION_IDLE_TTL_ENV } from "./constants.js";

export interface DaemonInfo {
  name: typeof DAEMON_NAME;
  version: string;
  pid: number;
  /** The actually bound port — may differ from the default on bind-conflict fallback. */
  port: number;
  url: string;
  startedAt: string;
  envFingerprint: string;
  /** Opaque process-generation identity. Absent on daemons predating run control. */
  instanceId?: string;
  /** Signed loopback run-control endpoint. Absent on daemons predating run control. */
  controlUrl?: string;
  /** Internal run-control protocol version. */
  controlProtocol?: 1;
}

export interface SpawnLock {
  pid: number;
  startedAt: string;
  token: string;
}

/** The /healthz response body — the daemon's live identity and load, beyond daemon.json. */
export interface DaemonHealth {
  name: string;
  version: string;
  pid: number;
  port: number;
  startedAt: string;
  sessions: number;
  activeRuns: number;
  envFingerprint: string;
  projects: Array<{ projectDir: string; activeRuns: number }>;
  instanceId?: string;
  controlProtocol?: 1;
  /**
   * True when this daemon has been superseded — a newer daemon owns its family's discovery
   * pointer (it names a different pid) so this one is a lame duck: it admits no new sessions,
   * migrates its idle sessions to the successor, and exits as soon as nothing is in flight.
   * Absent on daemons predating the succession model; readers treat a missing field as
   * "not a lame duck".
   */
  lameDuck?: boolean;
  /** Requests currently being processed (in-flight POSTs) across all sessions. */
  inflightRequests?: number;
}

/**
 * Probe a daemon's /healthz. Returns undefined on any failure — callers treat that as "no
 * live daemon at this port" (a foreign process answering is filtered by the name check).
 */
export async function probeHealthz(port: number, timeoutMs = 2_000): Promise<DaemonHealth | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<DaemonHealth>;
    if (body.name !== DAEMON_NAME || typeof body.pid !== "number") return undefined;
    return body as DaemonHealth;
  } catch {
    return undefined;
  }
}

function daemonsDir(): string {
  return join(workflowHomeDir(), "daemons");
}

/** The family pointer for `fingerprint` (default: this process's env). */
export function daemonInfoPath(fingerprint: string = envFingerprint()): string {
  return join(daemonsDir(), `${fingerprint}.json`);
}

/** The family spawn lock for `fingerprint` (default: this process's env). */
export function daemonLockPath(fingerprint: string = envFingerprint()): string {
  return join(daemonsDir(), `${fingerprint}.lock`);
}

/** One record per live daemon process, whatever its family. */
export function daemonInstancePath(pid: number): string {
  return join(daemonsDir(), "instances", `${pid}.json`);
}

export function daemonLogPath(): string {
  return join(workflowHomeDir(), "logs", "daemon.log");
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "EPERM") return true;
    return false;
  }
}

function readInfoFile(path: string): DaemonInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<DaemonInfo>;
    if (
      parsed.name !== DAEMON_NAME ||
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.version !== "string"
    ) {
      return undefined;
    }
    return parsed as DaemonInfo;
  } catch {
    return undefined;
  }
}

/** The family pointer's record (default: this process's env family). */
export function readDaemonInfo(fingerprint: string = envFingerprint()): DaemonInfo | undefined {
  return readInfoFile(daemonInfoPath(fingerprint));
}

/** One PID-guarded daemon generation record, if readable. */
export function readDaemonInstance(pid: number): DaemonInfo | undefined {
  return readInfoFile(daemonInstancePath(pid));
}

function writeInfoFile(path: string, info: DaemonInfo): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${info.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Atomically (tmp+rename) repoint the family pointer of `info.envFingerprint` at `info`, and
 * record the instance. For a succession this is the step that demotes the predecessor to a
 * lame duck (its pid no longer matches the pointer).
 */
export function writeDaemonInfo(info: DaemonInfo): void {
  writeInfoFile(daemonInfoPath(info.envFingerprint), info);
  writeInfoFile(daemonInstancePath(info.pid), info);
}

/**
 * Remove the instance record for `pid`, and the family pointer only when it still names `pid`
 * — never clobber a successor's pointer. The pointer checked is the one the instance record
 * names (falling back to this process's env family).
 */
export function clearDaemonInfo(pid: number): void {
  const instance = readInfoFile(daemonInstancePath(pid));
  const fingerprint = instance?.envFingerprint ?? envFingerprint();
  const current = readDaemonInfo(fingerprint);
  try {
    if (current !== undefined && current.pid === pid) rmSync(daemonInfoPath(fingerprint), { force: true });
  } catch {
    // Best-effort: a stale file is recoverable (readers pid-check), a crash here is not worth it.
  }
  try {
    rmSync(daemonInstancePath(pid), { force: true });
  } catch {
    // Same.
  }
}

/**
 * True when this daemon no longer owns its family's discovery: the pointer names a pid other
 * than `ownPid`, or is gone. Such a daemon is a "lame duck" — it keeps serving in-flight work,
 * admits no new sessions, migrates its idle sessions to the successor, and exits as soon as
 * nothing is in flight.
 *
 * A missing pointer counts: a daemon that published its pointer and later finds it gone has
 * been superseded and its successor has since exited (a successor clears only a pointer naming
 * itself). createDaemon applies this only once the pointer has been seen naming the daemon, and
 * latches the first true — nothing ever repoints discovery at an older daemon, and treating a
 * vanished pointer as "back in service" is how zombie daemons used to accumulate.
 */
export function isSupersededBy(ownPid: number, fingerprint: string = envFingerprint()): boolean {
  const info = readDaemonInfo(fingerprint);
  return info === undefined || info.pid !== ownPid;
}

export interface DaemonInstance {
  info: DaemonInfo;
}

/**
 * Every daemon with a live instance record (dead ones are pruned as a side effect). Liveness is
 * a pid check only; callers probe /healthz for identity and load, and reconcile against
 * `listDaemonProcesses` for daemons that have no record.
 */
export function listDaemonInstances(): DaemonInstance[] {
  const instances: DaemonInstance[] = [];
  const seen = new Set<number>();
  const dir = join(daemonsDir(), "instances");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const info = readInfoFile(path);
    if (info === undefined || !pidIsAlive(info.pid)) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best-effort pruning.
      }
      continue;
    }
    if (seen.has(info.pid)) continue;
    seen.add(info.pid);
    instances.push({ info });
  }
  return instances;
}

/** A live daemon of ours (any family) bound to `port`, if any. */
export function findDaemonInstanceOnPort(port: number): DaemonInstance | undefined {
  return listDaemonInstances().find((instance) => instance.info.port === port);
}

export interface DaemonProcess {
  pid: number;
  /** The process's command line as the OS reports it. */
  args: string;
}

/** The argv shape every daemon of ours is launched with (see entry.ts). */
const DAEMON_ARGS_PATTERN = /(^|\s)--daemon-run(\s|$)/;
const DAEMON_BUNDLE_PATTERN = /agentprism|mcp-server/;

function readProcessTable(args: string[]): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    return execFileSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/**
 * Every live daemon process of ours the OS knows about, whatever it recorded (or failed to
 * record) on disk — the ground truth `daemon status` and `daemon stop --all` reconcile the
 * instance records against, so a daemon can never hide from the CLI. Only this user's
 * processes; never this process itself. POSIX only (`ps`); on Windows the records are all
 * there is.
 */
export function listDaemonProcesses(): DaemonProcess[] {
  const table = readProcessTable(["-ww", "-eo", "pid=,uid=,args="]);
  if (table === undefined) return [];
  const uid = process.getuid?.();
  const found: DaemonProcess[] = [];
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    if (uid !== undefined && Number(match[2]) !== uid) continue;
    const args = match[3]!.trim();
    if (!DAEMON_ARGS_PATTERN.test(args) || !DAEMON_BUNDLE_PATTERN.test(args)) continue;
    found.push({ pid, args });
  }
  return found;
}

/**
 * True when `pid` is alive AND is a daemon process of ours — the identity check that keeps a
 * stale record whose pid the OS has since reused from ever being signalled. On POSIX a `ps`
 * that fails or knows no such process means "not verified", never "assume it is ours"; on
 * Windows (no process table here) this degrades to the pid liveness check.
 */
export function isDaemonProcess(pid: number): boolean {
  if (!pidIsAlive(pid)) return false;
  if (process.platform === "win32") return true;
  const table = readProcessTable(["-ww", "-o", "args=", "-p", String(pid)]);
  if (table === undefined) return false;
  const args = table.trim();
  return DAEMON_ARGS_PATTERN.test(args) && DAEMON_BUNDLE_PATTERN.test(args);
}

/**
 * The runner resolves its backend registry and spawn behavior from these once at construction,
 * so a daemon serves every client with the env it was started with. The fingerprint keys the
 * daemon FAMILY a client belongs to: clients with different relevant env never share a daemon.
 * The lifetime knobs are excluded — they do not change what the daemon serves.
 */
const ENV_FINGERPRINT_PREFIXES = ["AGENTPRISM_", "OPENCODE_ACP_", "PI_ACP_", "CODEX_ACP_"];
const ENV_FINGERPRINT_EXCLUDED = new Set([DAEMON_IDLE_TTL_ENV, SESSION_IDLE_TTL_ENV]);

export function envFingerprint(env: Record<string, string | undefined> = process.env): string {
  const relevant = Object.entries(env)
    .filter(([key, value]) => value !== undefined && ENV_FINGERPRINT_PREFIXES.some((p) => key.startsWith(p)))
    .filter(([key]) => !ENV_FINGERPRINT_EXCLUDED.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return createHash("sha256").update(relevant).digest("hex").slice(0, 16);
}

/**
 * Semver-style ordering (`major.minor.patch[-prerelease]`): negative when `a` is older than
 * `b`, zero when equal, positive when newer. A prerelease sorts below its release; anything
 * unparseable falls back to a plain string comparison so the order stays total.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { nums: number[]; pre: string | undefined } | undefined => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
    if (match === null) return undefined;
    return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined || pb === undefined) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! - pb.nums[i]!;
  }
  if (pa.pre === undefined && pb.pre === undefined) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

/**
 * Claim the right to spawn the family's daemon. Returns null when another live process holds
 * the claim (the caller should poll the pointer/health instead of spawning). A lock owned by a
 * dead pid is recovered once.
 */
export function claimSpawnLock(fingerprint: string = envFingerprint()): SpawnLock | null {
  const path = daemonLockPath(fingerprint);
  mkdirSync(dirname(path), { recursive: true });
  const lock: SpawnLock = { pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
      return lock;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") return null;
      let holder: SpawnLock | null = null;
      try {
        holder = JSON.parse(readFileSync(path, "utf-8")) as SpawnLock;
      } catch {
        holder = null;
      }
      if (holder !== null && pidIsAlive(holder.pid)) return null;
      // Stale (dead holder or unreadable): remove and retry exactly once.
      try {
        rmSync(path, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function releaseSpawnLock(lock: SpawnLock, fingerprint: string = envFingerprint()): void {
  const path = daemonLockPath(fingerprint);
  try {
    const holder = JSON.parse(readFileSync(path, "utf-8")) as SpawnLock;
    if (holder.token !== lock.token) return;
    rmSync(path, { force: true });
  } catch {
    // Already gone or unreadable — nothing to release.
  }
}
