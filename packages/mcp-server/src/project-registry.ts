/**
 * Per-project engine state and cross-project run routing.
 *
 * A WorkflowManager's cwd keys its whole persistence store (workflowProjectKey), so a server
 * that serves more than one project holds one manager per project directory — all sharing a
 * single AgentRunner, whose agent sessions carry their own cwd. `run` calls select their
 * project explicitly (the tool's `projectDir` argument); `inspect`/`await`/`stop`/`resume`
 * route by locating the runId: first across live contexts, then by scanning the on-disk
 * project stores, whose `project.json` manifests (written by the engine) map the one-way
 * store key back to its project directory.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { AgentRunner } from "@automatalabs/shared-types";
import {
  WORKFLOW_PROJECTS_SUBDIR,
  WorkflowManager,
  workflowHomeDir,
  type WorkflowRunResult,
} from "@automatalabs/workflows";
import type { ReplProjectState } from "./repl-project.js";
import { disposeReplProjectState } from "./repl-project.js";
import { SHUTDOWN_DEADLINE_MS } from "./lifecycle.js";

export const MAX_BACKGROUND_RUNS = 4;

/**
 * Tracks live background-run promises against the MAX_BACKGROUND_RUNS admission cap. One
 * registry per project: every session/server sharing a project shares its cap, and a
 * cross-session `action:"await"` finds the live promise instead of falling back to polling.
 */
export class BackgroundRunRegistry {
  private starting = 0;
  private readonly active = new Map<string, Promise<WorkflowRunResult>>();

  reserve(): boolean {
    if (this.starting + this.active.size >= MAX_BACKGROUND_RUNS) return false;
    this.starting++;
    return true;
  }

  activeCount(): number {
    return this.starting + this.active.size;
  }

  releaseReservation(): void {
    if (this.starting > 0) this.starting--;
  }

  track(runId: string, promise: Promise<WorkflowRunResult>): void {
    this.releaseReservation();
    this.active.set(runId, promise);
    void promise.then(
      () => this.active.delete(runId),
      () => this.active.delete(runId),
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
  backgroundRuns: BackgroundRunRegistry;
  /** The REPL workspace's daemon state (phase D): created on first touch
   *  of the `repl` tool, null until then — a pure-workflow project never
   *  opens a repl store. See `src/repl-project.ts`. */
  repl?: ReplProjectState;
}

/** The routing surface WorkflowScriptResources needs — a registry, or a single pinned store. */
export interface RunStoreRouter {
  /** The context whose store contains runId, if any. */
  storeFor(runId: string): ProjectContext | undefined;
  /** Every currently-live context (for bounded list merging). */
  stores(): ProjectContext[];
  /** Aggregated runDeleted events across all current and future contexts; returns detach. */
  onRunDeleted(listener: (event: { runId: string }) => void): () => void;
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
  private readonly contexts = new Map<string, ProjectContext>();
  private readonly deletionListeners = new Set<(event: { runId: string }) => void>();

  constructor(private readonly runner: AgentRunner) {}

  /** Adopt an externally built manager as its project's context (composition back-compat). */
  adopt(manager: WorkflowManager, backgroundRuns?: BackgroundRunRegistry): ProjectContext {
    const existing = this.contexts.get(manager.cwd);
    if (existing !== undefined) return existing;
    return this.register({
      projectDir: manager.cwd,
      manager,
      backgroundRuns: backgroundRuns ?? new BackgroundRunRegistry(),
    });
  }

  /** Context for a validated project directory, creating its manager on first use. */
  getOrCreate(projectDir: string): ProjectContext {
    const existing = this.contexts.get(projectDir);
    if (existing !== undefined) return existing;
    return this.register({
      projectDir,
      manager: new WorkflowManager({ agent: this.runner, cwd: projectDir }),
      backgroundRuns: new BackgroundRunRegistry(),
    });
  }

  private register(context: ProjectContext): ProjectContext {
    this.contexts.set(context.projectDir, context);
    context.manager.on("runDeleted", (event: { runId: string }) => {
      for (const listener of this.deletionListeners) listener(event);
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
        // (inspect/await of a deleted project's runs still work; execution would fail later).
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

  activeRunCount(): number {
    let total = 0;
    for (const context of this.contexts.values()) total += context.backgroundRuns.activeCount();
    return total;
  }

  /** Dispose every context's REPL workspace: each one DRAINS with the
   *  shutdown bound first (in-flight subagent turns settle into the VM
   *  and snapshot; the reviewer-mandated drain-then-close posture — the
   *  old path cancelled busy sessions on disposal) — then the broker
   *  teardown (releasing every held ACP session) and the store close.
   *  Called by the daemon at shutdown; the workflow managers' own
   *  lifecycle is untouched.
   *
   *  ONE deadline spans the drain AND the teardown (phase-D review
   *  round 7: the disposal used to run unbounded — a drain that failed
   *  or consumed the whole bound then entered a teardown that awaited
   *  hung cancel/release forever, so daemon shutdown could hang on the
   *  exact hung backend the drain had already caught). A drain that
   *  fails or times out leaves the teardown only the remaining bound;
   *  an expired deadline skips straight to the disposal's bookkeeping
   *  clear. `boundMs` defaults to the daemon's shutdown deadline (the
   *  engine's own dispose default mirrors it). */
  async disposeReplStates(boundMs: number = SHUTDOWN_DEADLINE_MS): Promise<void> {
    const deadline = Date.now() + Math.max(0, boundMs);
    for (const context of this.contexts.values()) {
      const state = context.repl;
      if (state === undefined) continue;
      const broker = state.broker;
      if (broker !== null) {
        await broker
          .drainForDisconnect(Math.max(0, deadline - Date.now()))
          .catch(() => undefined);
      }
      // The teardown's own failures are contained here too: its op-end
      // flush retries a boundary the drain's failed flush retained, and
      // a second failure (the disk is still broken) must not abort the
      // shutdown — the VM release and the store close already ran in
      // `disposeReplProjectState`'s FINALLY path (phase-D review round
      // 8: a disposal rejection used to skip them entirely), the
      // persistence failure was already loud (the drain's failure), and
      // the process is exiting anyway. The state on disk keeps the last
      // good snapshot.
      await disposeReplProjectState(state, Math.max(0, deadline - Date.now())).catch(() => undefined);
    }
  }

  snapshot(): Array<{ projectDir: string; activeRuns: number }> {
    return [...this.contexts.values()].map((context) => ({
      projectDir: context.projectDir,
      activeRuns: context.backgroundRuns.activeCount(),
    }));
  }
}

/** A fixed single-store router for hosts that construct WorkflowScriptResources directly. */
export function singleStoreRouter(manager: WorkflowManager): RunStoreRouter {
  const context: ProjectContext = { projectDir: manager.cwd, manager, backgroundRuns: new BackgroundRunRegistry() };
  const hasRun = (runId: string) => manager.getRun(runId) !== undefined || Boolean(manager.getPersistence().load(runId));
  return {
    storeFor: (runId) => (hasRun(runId) ? context : undefined),
    stores: () => [context],
    onRunDeleted: (listener) => {
      manager.on("runDeleted", listener);
      return () => manager.off("runDeleted", listener);
    },
  };
}
