/**
 * Workflow run state persistence for pause/resume support.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  watch,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  AgentHistoryEntry,
  AgentResultProvenance,
  AgentSessionRecord,
  AgentUsage,
  AuthErrorContext,
  CheckpointContext,
  JournalEntry,
  WorkflowCallRecord,
  WorkflowCheckpointTaken,
  WorkflowReplayEligibility,
  WorkflowResumeReport,
  WorkflowRunFallback,
  WorkflowRunLimits,
} from "@automatalabs/shared-types";
import type { WorkflowErrorCode } from "./errors.js";
import type { ReplayReport } from "./isolation.js";
import type { RunEnvironmentIdentity } from "./run-environment.js";
import { withRunEventsUsingFs, type RunEventPersistence } from "./run-event-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  /** Persisted display projection of the result. */
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** The ACP re-attach record captured when this agent's call opened a session; absent
   *  on pre-session-record persisted runs and agents that opened no session. */
  session?: AgentSessionRecord;
  startedAt?: string;
  endedAt?: string;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /** Resolved total-wall-clock deadline for each attempt; null means uncapped. */
  timeoutMs?: number | null;
  /** Resolved no-backend-activity deadline for each attempt; null means disabled. */
  idleTimeoutMs?: number | null;
  /** This logical call's aggregate token debit (provider total or estimate). */
  tokens?: number;
  callIndex?: number;
  scope?: string;
  usage?: AgentUsage;
  provenance?: AgentResultProvenance;
}

export interface PersistedResumeFormat {
  format: "identity-v1";
  /** Captured only after the script has settled AND resume activity is zero, immediately
   *  before the terminal save. It may be absent from a crash snapshot, a non-quiescent
   *  terminal run, or a non-git run without meaningful terminal provenance. Presence,
   *  absence, and value are diagnostic only and never affect journal replay. */
  terminalEnvironment?: RunEnvironmentIdentity;
}

export interface PersistedResumeCandidate {
  sourceRunId: string;
  recordedIndex: number;
  /** Frozen source values; entry.index/call.index remain the source index. */
  entry: JournalEntry;
  call: WorkflowCallRecord;
  /** Logical debit preserved across resume hops. Agent candidates only. */
  logicalBudgetDebit?: number;
}

/** A settled non-result occurrence retained in the identity matcher. It can never
 *  replay, but it prevents a result sibling with the same identity from becoming
 *  spuriously unique and is consumed when the current execution reaches it. */
export interface PersistedResumeCallBlocker {
  sourceRunId: string;
  recordedIndex: number;
  call: WorkflowCallRecord;
}

export interface PersistedCheckpointInjection {
  sourceRunId: string;
  recordedIndex: number;
  hash: string;
  path: string;
  /** hashCheckpointInputs() for the source pending checkpoint. */
  inputsHash: string;
  decision: unknown;
}

export interface PersistedResumeSeed {
  format: "identity-v1";
  /** Immediate run named by resumeFromRunId; individual candidates may originate in an
   *  older hop and retain that run ID themselves. */
  sourceRunId: string;
  candidates: PersistedResumeCandidate[];
  callBlockers?: PersistedResumeCallBlocker[];
  checkpointInjections?: PersistedCheckpointInjection[];
}

/**
 * Content-free ancestry retained after a run record is deleted. The engine owns this
 * tombstone so read-only projections can walk an admitted resume chain without keeping
 * scripts, arguments, or synthetic lineage in process memory.
 */
export interface PersistedRunLineageTombstone {
  runId: string;
  sourceRunId?: string;
  deletedAt: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** The persisted args value was not a faithful pre-execution strict-JSON snapshot. */
  argsUnreplayable?: true;
  /** The run's working directory (ExecOptions.cwd) when it overrode the manager cwd —
   *  kept so resume() re-runs in the same directory (e.g. the same worktree). */
  cwd?: string;
  /** The directory the run actually executed in. */
  effectiveCwd?: string;
  runtime?: {
    /** Producing workflow-engine package version. Diagnostic only; never an admission gate. */
    engineVersion?: string;
    node: string;
    v8: string;
    pathFormat: number;
    inputsFormat: number;
    checkpointInputsFormat?: number;
  };
  environment?: RunEnvironmentIdentity;
  resume?: PersistedResumeFormat;
  /** Immediate run named by resumeFromRunId, written once by the engine at admission. */
  readonly resumeSourceRunId?: string;
  resumeSeed?: PersistedResumeSeed;
  resumeReport?: WorkflowResumeReport;
  replayEligibility?: WorkflowReplayEligibility;
  /** The session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  status: RunStatus;
  /** Safe run-level terminal explanation retained for cold inspection. */
  reason?: string;
  /** Machine-readable terminal error retained for cold inspection. */
  errorCode?: WorkflowErrorCode;
  /** Why a paused run is paused (e.g. "usage_limit", "auth_required",
   *  "checkpoint_required", or "interrupted"). Free-form string — no migration. */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  /** For an "auth_required" pause (§2.12/§2.13): the structured, NON-SECRET auth surface
   *  (backendId + advertised method ids/types/names). NEVER the intent's secret payload —
   *  no `authenticateMeta`, no `envValues` (Principle 9). Read by resume()'s cold re-arm. */
  authContext?: AuthErrorContext;
  /** For a "checkpoint_required" pause: the structured, NON-SECRET pending checkpoint
   *  surface. Its call index and hash let resume journal the host-supplied decision. */
  checkpointContext?: CheckpointContext;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Cached agent results for resume, keyed by deterministic call index. */
  journal?: JournalEntry[];
  /** Additive terminal observability; absent on legacy runs and when no event occurred. */
  fallbacks?: WorkflowRunFallback[];
  checkpointsTaken?: WorkflowCheckpointTaken[];
  /** Root-scope terminal-call manifest for this execution. */
  calls?: WorkflowCallRecord[];
  callsAllocated?: number;
  limits?: WorkflowRunLimits;
  abortSignaled?: true;
  mainModel?: string;
  /** Host-pinned fallback used by otherwise unmodelled agent calls in this run. */
  defaultModel?: string;
  agentsDir?: string;
  nestedWorkflows?: true;
  legacyResume?: true;
  executionMode?: { kind: "isolation"; baselineRunId: string };
  /** Aggregate isolation report, attached after the terminal manager save. */
  replayReport?: ReplayReport;
  /** Event-log generation discriminator: 32 lowercase hex characters. New-format journaling
   *  runs mint it with eventSeq: 0. */
  eventStreamId?: string;
  /** Highest successfully appended event seq whose state effects this snapshot reflects.
   *  New-format journaling runs write 0 before their first event. */
  eventSeq?: number;
  /** At least one persistable live event could not be appended. When set, the log is not a
   *  gap-free projection and read/watch fail with EVENT_LOG_INCOMPLETE. */
  eventLogIncomplete?: true;
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /** Load content-free ancestry for a deleted run, when the persistence supports it. */
  loadLineageTombstone?(runId: string): PersistedRunLineageTombstone | null;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; stale/corrupt lock files are removed and retried.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Read the current cross-process owner without acquiring or mutating the lease. */
  inspectRunLease?(runId: string): RunLeaseOwner | null;
  /** Confirm that a previously acquired lease token still owns the on-disk lock. */
  validateRunLease?(lease: RunLease): boolean;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
  /** Opaque host/process generation identity written into the lock, when configured. */
  ownerId?: string;
  /** PID recorded by a dead lock owner replaced while acquiring this lease. */
  recoveredOwnerPid?: number;
}

export interface RunLeaseOwner {
  runId: string;
  pid: number;
  startedAt: string;
  /** Opaque owner identity; daemon managers use their daemon instance ID. */
  ownerId?: string;
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
  ownerId?: string;
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 */
export type FsLayer = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
  openSync?: typeof openSync;
  writeSync?: typeof writeSync;
  closeSync?: typeof closeSync;
  truncateSync?: typeof truncateSync;
  statSync?: typeof statSync;
  watch?: typeof watch;
};

export interface RunPersistenceOptions {
  /** Absolute workflow persistence root; explicit value wins over AGENTPRISM_PERSISTENCE_ROOT. */
  persistenceRoot?: string;
  /** Opaque host/process generation identity attached to newly acquired run leases. */
  leaseOwnerId?: string;
}

export function createRunPersistence(
  cwd: string,
  fsOverride?: Partial<FsLayer>,
  options: RunPersistenceOptions = {},
): RunEventPersistence {
  const _existsSync = fsOverride?.existsSync ?? existsSync;
  const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
  const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
  const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
  const _renameSync = fsOverride?.renameSync ?? renameSync;
  const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
  const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;

  const paths = workflowProjectPaths(cwd, { persistenceRoot: options.persistenceRoot });
  const runsDir = paths.runsDir;
  const legacyRunsDir = paths.legacyRunsDir;

  // Self-describing store: the project key is a one-way hash of the project directory, so a
  // manifest records the directory itself. Cross-project hosts (the workflow daemon) locate a
  // bare runId by scanning project stores and re-opening the manifest's directory. Best-effort
  // and idempotent; legacy stores heal on their next construction here.
  try {
    const manifestPath = join(paths.rootDir, "project.json");
    if (!_existsSync(manifestPath)) {
      _mkdirSync(paths.rootDir, { recursive: true });
      const tmpPath = `${manifestPath}.${process.pid}.tmp`;
      _writeFileSync(tmpPath, `${JSON.stringify({ projectDir: resolve(cwd) })}\n`);
      _renameSync(tmpPath, manifestPath);
    }
  } catch {
    // A store without a manifest is still fully functional for its own project.
  }

  const ensureDir = () => {
    if (!_existsSync(runsDir)) {
      _mkdirSync(runsDir, { recursive: true });
    }
  };

  const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
  const primaryRunPath = (runId: string) => runPath(runsDir, runId);
  const legacyRunPath = (runId: string) => runPath(legacyRunsDir, runId);
  const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
  const lineagePath = (dir: string, runId: string) => join(dir, `${runId}.lineage`);
  const primaryLockPath = (runId: string) => lockPath(runsDir, runId);
  const legacyLockPath = (runId: string) => lockPath(legacyRunsDir, runId);
  const primaryLineagePath = (runId: string) => lineagePath(runsDir, runId);
  const candidateRunPaths = (runId: string) => [primaryRunPath(runId), legacyRunPath(runId)];
  const candidateLineagePaths = (runId: string) => [
    primaryLineagePath(runId),
    lineagePath(legacyRunsDir, runId),
  ];

  const loadState = (runId: string): PersistedRunState | null => {
    // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
    for (const path of candidateRunPaths(runId)) {
      for (const candidate of [path, `${path}.bak`]) {
        try {
          if (!_existsSync(candidate)) continue;
          return JSON.parse(_readFileSync(candidate, "utf-8")) as PersistedRunState;
        } catch {
          // corrupt candidate -> fall through to the next candidate
        }
      }
    }
    return null;
  };

  const lineageSourceRunId = (state: PersistedRunState): string | undefined => {
    const sourceRunId = state.resumeSourceRunId;
    return sourceRunId === state.runId ? undefined : sourceRunId;
  };

  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return true;
      return false;
    }
  };

  const readLockAt = (path: string): LockFile | null => {
    try {
      return JSON.parse(_readFileSync(path, "utf-8")) as LockFile;
    } catch {
      return null;
    }
  };

  const readLock = (runId: string): LockFile | null => readLockAt(primaryLockPath(runId));

  const validLockOwner = (
    value: LockFile | null,
    runId: string,
    expectedRunPath: string,
  ): value is LockFile =>
    value !== null &&
    value.runId === runId &&
    value.runPath === expectedRunPath &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.token === "string" &&
    (value.ownerId === undefined || typeof value.ownerId === "string");

  const removeStaleLegacyLock = (
    runId: string,
  ): { available: boolean; recoveredOwnerPid?: number } => {
    const lock = legacyLockPath(runId);
    const existing = readLockAt(lock);
    const valid = validLockOwner(existing, runId, legacyRunPath(runId));
    if (valid && pidIsAlive(existing.pid)) return { available: false };
    try {
      if (_existsSync(lock)) _unlinkSync(lock);
    } catch {
      return { available: false };
    }
    return {
      available: true,
      ...(valid ? { recoveredOwnerPid: existing.pid } : {}),
    };
  };

  const persistence: RunPersistence = {
    save(state: PersistedRunState) {
      ensureDir();
      state.updatedAt = new Date().toISOString();
      const path = primaryRunPath(state.runId);
      const json = JSON.stringify(state, null, 2);
      // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
      // atomic on the same filesystem). A .bak from the previous good save is the
      // recovery fallback if the primary is somehow truncated.
      _writeFileSync(`${path}.tmp`, json);
      _renameSync(`${path}.tmp`, path);
      try {
        _writeFileSync(`${path}.bak`, json);
      } catch {
        // backup is best-effort; the primary write already succeeded
      }
      try {
        const tombstonePath = primaryLineagePath(state.runId);
        if (_existsSync(tombstonePath)) _unlinkSync(tombstonePath);
      } catch {
        // The live record wins over a stale tombstone; cleanup is best-effort.
      }
    },

    load(runId: string): PersistedRunState | null {
      return loadState(runId);
    },

    list(): PersistedRunState[] {
      const byRunId = new Map<string, PersistedRunState>();
      for (const dir of [runsDir, legacyRunsDir]) {
        try {
          if (!_existsSync(dir)) continue;
          const files = _readdirSync(dir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            try {
              const state = JSON.parse(_readFileSync(join(dir, file), "utf-8")) as PersistedRunState;
              if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
            } catch {
              // Skip corrupted files
            }
          }
        } catch {
          // Skip unreadable directories; another storage location may still work.
        }
      }
      return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    delete(runId: string): boolean {
      let deleted = false;
      let wroteTombstone = false;
      try {
        const state = loadState(runId);
        if (state) {
          ensureDir();
          const sourceRunId = lineageSourceRunId(state);
          const tombstone: PersistedRunLineageTombstone = {
            runId,
            ...(sourceRunId ? { sourceRunId } : {}),
            deletedAt: new Date().toISOString(),
          };
          const path = primaryLineagePath(runId);
          _writeFileSync(`${path}.tmp`, JSON.stringify(tombstone, null, 2));
          _renameSync(`${path}.tmp`, path);
          wroteTombstone = true;
        }
        for (const path of candidateRunPaths(runId)) {
          try {
            if (_existsSync(path)) {
              _unlinkSync(path);
              deleted = true;
            }
          } catch {
            // ignore per-file cleanup failures
          }
          // Snapshot recovery artifacts follow the primary; the writer lock is always last.
          for (const sidecar of [`${path}.bak`, `${path}.tmp`]) {
            try {
              if (_existsSync(sidecar)) _unlinkSync(sidecar);
            } catch {
              // ignore sidecar cleanup failures
            }
          }
        }
        // Both storage locations are settled before either writer-exclusion file is removed.
        for (const dir of [legacyRunsDir, runsDir]) {
          try {
            const lock = lockPath(dir, runId);
            if (_existsSync(lock)) _unlinkSync(lock);
          } catch {
            // ignore lock cleanup failures
          }
        }
        if (!deleted && wroteTombstone) {
          try {
            _unlinkSync(primaryLineagePath(runId));
          } catch {
            // A failed delete must not manufacture a deleted-run tombstone.
          }
        }
        return deleted;
      } catch {
        if (!deleted && wroteTombstone) {
          try {
            _unlinkSync(primaryLineagePath(runId));
          } catch {
            // Best-effort rollback; the still-live record remains authoritative.
          }
        }
        return deleted;
      }
    },

    loadLineageTombstone(runId: string): PersistedRunLineageTombstone | null {
      for (const path of candidateLineagePaths(runId)) {
        try {
          if (!_existsSync(path)) continue;
          const value = JSON.parse(_readFileSync(path, "utf-8")) as Partial<PersistedRunLineageTombstone>;
          if (
            value.runId !== runId ||
            typeof value.deletedAt !== "string" ||
            (value.sourceRunId !== undefined &&
              (typeof value.sourceRunId !== "string" || value.sourceRunId.length === 0))
          ) {
            continue;
          }
          return {
            runId,
            ...(value.sourceRunId === undefined ? {} : { sourceRunId: value.sourceRunId }),
            deletedAt: value.deletedAt,
          };
        } catch {
          // corrupt candidate -> fall through to the next candidate
        }
      }
      return null;
    },

    acquireRunLease(runId: string): RunLease | null {
      ensureDir();
      const path = primaryRunPath(runId);
      const lock = primaryLockPath(runId);
      const legacy = removeStaleLegacyLock(runId);
      if (!legacy.available) return null;
      let recoveredOwnerPid = legacy.recoveredOwnerPid;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const payload: LockFile = {
          runId,
          runPath: path,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
          ...(options.leaseOwnerId === undefined ? {} : { ownerId: options.leaseOwnerId }),
        };
        try {
          _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
          return {
            runId,
            token,
            ...(options.leaseOwnerId === undefined ? {} : { ownerId: options.leaseOwnerId }),
            ...(recoveredOwnerPid === undefined ? {} : { recoveredOwnerPid }),
          };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "EEXIST") throw err;
          const existing = readLock(runId);
          const valid = validLockOwner(existing, runId, path);
          if (valid && pidIsAlive(existing.pid)) {
            return null;
          }
          if (valid) recoveredOwnerPid = existing.pid;
          try {
            _unlinkSync(lock);
          } catch {
            return null;
          }
        }
      }
      return null;
    },

    releaseRunLease(lease: RunLease): void {
      try {
        const existing = readLock(lease.runId);
        if (existing?.token === lease.token) _unlinkSync(primaryLockPath(lease.runId));
      } catch {
        // Best-effort cleanup only.
      }
    },

    inspectRunLease(runId: string): RunLeaseOwner | null {
      const existing = readLock(runId);
      if (!validLockOwner(existing, runId, primaryRunPath(runId))) return null;
      return {
        runId,
        pid: existing.pid,
        startedAt: existing.startedAt,
        ...(existing.ownerId === undefined ? {} : { ownerId: existing.ownerId }),
      };
    },

    validateRunLease(lease: RunLease): boolean {
      const existing = readLock(lease.runId);
      return validLockOwner(existing, lease.runId, primaryRunPath(lease.runId)) &&
        existing.token === lease.token &&
        (lease.ownerId === undefined || existing.ownerId === lease.ownerId);
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
  return withRunEventsUsingFs(persistence, fsOverride);
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

export {
  RUN_EVENT_MAX_RECORD_BYTES,
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RunEventLogError,
  withRunEvents,
  type AppendRunEventInput,
  type ReadRunEventsOptions,
  type ReadRunEventsResult,
  type RunEventLogErrorCode,
  type RunEventPersistence,
  type RunEventStream,
  type WatchRunEventsOptions,
} from "./run-event-persistence.js";
