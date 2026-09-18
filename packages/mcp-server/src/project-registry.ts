/**
 * Per-project engine state and cross-project run routing.
 *
 * A WorkflowManager's cwd keys its whole persistence store (workflowProjectKey), so a server
 * that serves more than one project holds one manager per project directory — all sharing a
 * single AgentRunner, whose agent sessions carry their own cwd. `run` calls select their
 * project explicitly (the tool's `projectDir` argument); `status`/`stop`/`resume`
 * route by locating the runId: first across live contexts, then by scanning the on-disk
 * project stores, whose `project.json` manifests (written by the engine) map the one-way
 * store key back to its project directory.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { AgentRunner, RunEventLogRecord } from "@automatalabs/shared-types";
import {
  WORKFLOW_PROJECTS_SUBDIR,
  WorkflowManager,
  workflowHomeDir,
  type WorkflowRunResult,
} from "@automatalabs/workflows";
import { deleteRunControlSidecars } from "./daemon/run-control-store.js";
import { WorkflowNotificationClaims } from "./workflow-notifications.js";

export const MAX_ACTIVE_RUNS = 4;

/**
 * Tracks preparing and executing runs against the MAX_ACTIVE_RUNS admission cap. One
 * registry per project: every session/server sharing a project shares its cap, and a
 * cross-session `action:"status"` can find the live promise instead of falling back to polling.
 */
export class ActiveRunRegistry {
  private starting = 0;
  private readonly active = new Map<string, Promise<WorkflowRunResult> | undefined>();

  reserve(): boolean {
    if (this.starting + this.active.size >= MAX_ACTIVE_RUNS) return false;
    this.starting++;
    return true;
  }

  activeCount(): number {
    return this.starting + this.active.size;
  }

  releaseReservation(): void {
    if (this.starting > 0) this.starting--;
  }

  has(runId: string): boolean { return this.active.has(runId); }

  hold(runId: string): void {
    this.releaseReservation();
    this.active.set(runId, undefined);
  }

  track(runId: string, promise: Promise<WorkflowRunResult>): void {
    if (!this.active.has(runId)) this.releaseReservation();
    this.active.set(runId, promise);
    const release = () => {
      if (this.active.get(runId) === promise) this.active.delete(runId);
    };
    void promise.then(
      release,
      release,
    );
  }

  get(runId: string): Promise<WorkflowRunResult> | undefined {
    return this.active.get(runId);
  }

  evict(runId: string): void {
    this.active.delete(runId);
  }
}

export interface ProjectContext {
  projectDir: string;
  manager: WorkflowManager;
  activeRuns: ActiveRunRegistry;
}

/** The routing surface WorkflowScriptResources needs — a registry, or a single pinned store. */
export interface RunStoreRouter {
  /** The context whose store contains runId, if any. */
  storeFor(runId: string): ProjectContext | undefined;
  /** Every currently-live context (for bounded list merging). */
  stores(): ProjectContext[];
  /** Aggregated runDeleted events across all current and future contexts; returns detach. */
  onRunDeleted(listener: (event: { runId: string }) => void): () => void;
  /** Durable event appends across all current and future contexts; returns detach. */
  onRunEventPersisted(listener: (record: RunEventLogRecord) => void): () => void;
  /** Whole-run stop events across all current and future contexts; returns detach. */
  onRunStopped(listener: (event: { runId: string }) => void): () => void;
}

export type ProjectDirResolution = { ok: true; projectDir: string } | { ok: false; message: string };

/**
 * Validate a caller-supplied project directory before any engine state is created for it.
 * Realpathing keeps symlinked paths from splitting one project into several stores.
 */
export function resolveProjectDir(raw: unknown): ProjectDirResolution {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, message: "projectDir must be a non-empty string" };
  }
  if (!isAbsolute(raw)) {
    return { ok: false, message: `projectDir must be an absolute path, got "${raw}"` };
  }
  try {
    const real = realpathSync(raw);
    if (!statSync(real).isDirectory()) {
      return { ok: false, message: `projectDir is not a directory: "${raw}"` };
    }
    return { ok: true, projectDir: real };
  } catch {
    return { ok: false, message: `projectDir does not exist: "${raw}"` };
  }
}

export class WorkflowProjectRegistry implements RunStoreRouter {
  readonly notificationClaims = new WorkflowNotificationClaims();
  private readonly contexts = new Map<string, ProjectContext>();
  private readonly deletionListeners = new Set<(event: { runId: string }) => void>();
  private readonly persistedEventListeners = new Set<(record: RunEventLogRecord) => void>();
  private readonly stoppedListeners = new Set<(event: { runId: string }) => void>();

  constructor(
    private readonly runner: AgentRunner,
    private readonly options: { leaseOwnerId?: string } = {},
  ) {}

  /** Adopt an externally built manager as its project's context (composition back-compat). */
  adopt(manager: WorkflowManager, activeRuns?: ActiveRunRegistry): ProjectContext {
    const existing = this.contexts.get(manager.cwd);
    if (existing !== undefined) return existing;
    return this.register({
      projectDir: manager.cwd,
      manager,
      activeRuns: activeRuns ?? new ActiveRunRegistry(),
    });
  }

  /** Context for a validated project directory, creating its manager on first use. */
  getOrCreate(projectDir: string): ProjectContext {
    const existing = this.contexts.get(projectDir);
    if (existing !== undefined) return existing;
    return this.register({
      projectDir,
      manager: new WorkflowManager({
        agent: this.runner,
        cwd: projectDir,
        leaseOwnerId: this.options.leaseOwnerId,
      }),
      activeRuns: new ActiveRunRegistry(),
    });
  }

  private register(context: ProjectContext): ProjectContext {
    this.contexts.set(context.projectDir, context);
    context.manager.on("runDeleted", (event: { runId: string }) => {
      this.notificationClaims.deleteRun(event.runId);
      deleteRunControlSidecars(context.manager, event.runId);
      for (const listener of this.deletionListeners) listener(event);
    });
    context.manager.on("runEventPersisted", (record: RunEventLogRecord) => {
      for (const listener of this.persistedEventListeners) listener(record);
    });
    context.manager.on("stopped", (event: { runId: string }) => {
      context.activeRuns.evict(event.runId);
      for (const listener of this.stoppedListeners) listener(event);
    });
    return context;
  }

  storeFor(runId: string): ProjectContext | undefined {
    for (const context of this.contexts.values()) {
      if (context.manager.getRun(runId) !== undefined) return context;
      if (context.manager.getPersistence().load(runId)) return context;
    }
    return this.locateOnDisk(runId);
  }

  /**
   * Find runId among project stores this process has never opened, via each store's
   * `project.json` manifest. Stores predating the manifest are skipped (they heal on their
   * project's next engine construction).
   */
  private locateOnDisk(runId: string): ProjectContext | undefined {
    const projectsDir = join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR);
    let keys: string[];
    try {
      keys = readdirSync(projectsDir);
    } catch {
      return undefined;
    }
    for (const key of keys) {
      const rootDir = join(projectsDir, key);
      try {
        if (!existsSync(join(rootDir, "runs", `${runId}.json`))) continue;
        const manifest = JSON.parse(readFileSync(join(rootDir, "project.json"), "utf-8")) as {
          projectDir?: unknown;
        };
        // The manifest path was resolve()'d by the engine when the store was written; use it
        // verbatim so the store key round-trips even if the directory no longer exists
        // (status reads of a deleted project's runs still work; execution would fail later).
        if (typeof manifest.projectDir !== "string" || !isAbsolute(manifest.projectDir)) continue;
        return this.getOrCreate(manifest.projectDir);
      } catch {
        continue;
      }
    }
    return undefined;
  }

  stores(): ProjectContext[] {
    return [...this.contexts.values()];
  }

  onRunDeleted(listener: (event: { runId: string }) => void): () => void {
    this.deletionListeners.add(listener);
    return () => this.deletionListeners.delete(listener);
  }

  onRunEventPersisted(listener: (record: RunEventLogRecord) => void): () => void {
    this.persistedEventListeners.add(listener);
    return () => this.persistedEventListeners.delete(listener);
  }

  onRunStopped(listener: (event: { runId: string }) => void): () => void {
    this.stoppedListeners.add(listener);
    return () => this.stoppedListeners.delete(listener);
  }

  activeRunCount(): number {
    let total = 0;
    for (const context of this.contexts.values()) total += context.manager.activeExecutionCount();
    return total;
  }

  snapshot(): Array<{ projectDir: string; activeRuns: number }> {
    return [...this.contexts.values()].map((context) => ({
      projectDir: context.projectDir,
      activeRuns: context.manager.activeExecutionCount(),
    }));
  }
}

/** A fixed single-store router for hosts that construct WorkflowScriptResources directly. */
export function singleStoreRouter(manager: WorkflowManager): RunStoreRouter {
  const context: ProjectContext = { projectDir: manager.cwd, manager, activeRuns: new ActiveRunRegistry() };
  const hasRun = (runId: string) => manager.getRun(runId) !== undefined || Boolean(manager.getPersistence().load(runId));
  return {
    storeFor: (runId) => (hasRun(runId) ? context : undefined),
    stores: () => [context],
    onRunDeleted: (listener) => {
      manager.on("runDeleted", listener);
      return () => manager.off("runDeleted", listener);
    },
    onRunEventPersisted: (listener) => {
      manager.on("runEventPersisted", listener);
      return () => manager.off("runEventPersisted", listener);
    },
    onRunStopped: (listener) => {
      manager.on("stopped", listener);
      return () => manager.off("stopped", listener);
    },
  };
}
