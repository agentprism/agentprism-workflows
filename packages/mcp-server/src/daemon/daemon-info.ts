/**
 * Discovery and single-instance coordination for the workflow daemon.
 *
 * `daemon.json` is the source of truth for "is a daemon running and where": the daemon writes
 * it (0600, tmp+rename) after its port is bound and clears it on graceful shutdown; readers
 * must always pid-check because a crash leaves the file behind. The spawn lock is the same
 * `wx` + stale-pid-recovery pattern as the run leases in workflow-engine's run-persistence,
 * scoped to the check→spawn→healthy window so concurrent shims start exactly one daemon.
 *
 * Everything lives under the workflow home (`~/.agentprism/workflows` or
 * AGENTPRISM_PERSISTENCE_ROOT), so tests inherit the same isolation as run persistence.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { workflowHomeDir } from "@automatalabs/workflows";

import { DAEMON_NAME } from "./constants.js";

export interface DaemonInfo {
  name: typeof DAEMON_NAME;
  version: string;
  pid: number;
  /** The actually bound port — may differ from the default on bind-conflict fallback. */
  port: number;
  url: string;
  startedAt: string;
  envFingerprint: string;
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

export function daemonInfoPath(): string {
  return join(workflowHomeDir(), "daemon.json");
}

export function daemonLockPath(): string {
  return join(workflowHomeDir(), "daemon.lock");
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

export function readDaemonInfo(): DaemonInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(daemonInfoPath(), "utf-8")) as Partial<DaemonInfo>;
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

export function writeDaemonInfo(info: DaemonInfo): void {
  const path = daemonInfoPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${info.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Delete daemon.json only when it still names `pid` — never clobber a successor's file. */
export function clearDaemonInfo(pid: number): void {
  const current = readDaemonInfo();
  if (current === undefined || current.pid !== pid) return;
  try {
    rmSync(daemonInfoPath(), { force: true });
  } catch {
    // Best-effort: a stale file is recoverable (readers pid-check), a crash here is not worth it.
  }
}

/**
 * The runner resolves its backend registry and spawn behavior from these once at construction,
 * so a daemon serves every client with the env it was started with. The fingerprint lets the
 * shim detect a divergent client env and restart an idle daemon instead of silently serving
 * with stale configuration.
 */
const ENV_FINGERPRINT_PREFIXES = ["AGENTPRISM_", "OPENCODE_ACP_", "PI_ACP_", "CODEX_ACP_"];

export function envFingerprint(env: Record<string, string | undefined> = process.env): string {
  const relevant = Object.entries(env)
    .filter(([key, value]) => value !== undefined && ENV_FINGERPRINT_PREFIXES.some((p) => key.startsWith(p)))
    .filter(([key]) => key !== "AGENTPRISM_DAEMON_IDLE_TTL_MS" && key !== "AGENTPRISM_SESSION_TTL_MS")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return createHash("sha256").update(relevant).digest("hex").slice(0, 16);
}

/**
 * Claim the right to spawn the daemon. Returns null when another live process holds the claim
 * (the caller should poll daemon.json/health instead of spawning). A lock owned by a dead pid
 * is recovered once.
 */
export function claimSpawnLock(): SpawnLock | null {
  const path = daemonLockPath();
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

export function releaseSpawnLock(lock: SpawnLock): void {
  const path = daemonLockPath();
  try {
    const holder = JSON.parse(readFileSync(path, "utf-8")) as SpawnLock;
    if (holder.token !== lock.token) return;
    rmSync(path, { force: true });
  } catch {
    // Already gone or unreadable — nothing to release.
  }
}
