/**
 * The workspace layer of the REPL engine.
 *
 * One VM per workspace. The workspace object owns the VM lifecycle:
 * `create` (instantiate the VM), `evalCode` (eval + job drain), `drainJobs`
 * (a settlement drain), and `dispose`. Workspaces are keyed by project
 * directory, mirroring the daemon's project model that the `repl` tool
 * (a later phase) addresses them by; the `WorkspaceRegistry` enforces the
 * one-VM-per-workspace invariant — including under concurrent first
 * touches, by deduplicating the in-flight creation promise rather than
 * creating duplicate VMs and disposing losers (review regression: two
 * concurrent `get('/same')` calls instantiated two VMs before one was torn
 * down, violating the invariant and multiplying memory use).
 */

import { ReplVm, type ReplDrainOptions, type ReplEvalOptions, type ReplEvalOutcome } from './vm.js';
import type { WasmInput } from './types.js';

export type { ReplDrainOptions, ReplEvalOptions, ReplEvalOutcome } from './vm.js';
export type { WasmInput, WasmModule } from './types.js';

/** Options for creating a workspace (per-VM configuration). */
export interface WorkspaceOptions {
  /**
   * WASM bytes or a pre-compiled module (`WasmInput` — a self-contained
   * stand-in for `WebAssembly.Module | BufferSource`; the published type
   * graph must not depend on the consumer's lib, see `types.ts`).
   * Defaults to the `quickjs-wasi` package's shipped `quickjs.wasm`
   * binary.
   */
  wasm?: WasmInput;
  /**
   * Per-VM malloc limit in bytes. Resource limits are server
   * configuration, invisible to the guest; the default is
   * `ReplVm.DEFAULT_MEMORY_LIMIT` (64 MiB).
   */
  memoryLimit?: number;
}

/**
 * A persistent JavaScript REPL workspace: one QuickJS-in-WASM VM plus the
 * per-workspace policy around it. State persists between evals because it
 * lives in the VM, not in a transcript.
 */
export class Workspace {
  /** The project directory this workspace belongs to. */
  readonly projectDir: string;
  /** The configured per-VM malloc limit in bytes. */
  readonly memoryLimit: number;

  private readonly vm: ReplVm;
  private disposed = false;

  private constructor(projectDir: string, vm: ReplVm) {
    this.projectDir = projectDir;
    this.vm = vm;
    this.memoryLimit = vm.memoryLimit;
  }

  /**
   * Create a workspace: instantiate its VM (defaulting to the shipped
   * `quickjs.wasm` binary and the default memory limit).
   */
  static async create(projectDir: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const vm = await ReplVm.create(options);
    return new Workspace(projectDir, vm);
  }

  /**
   * Evaluate a script in the workspace's VM: eval + job drain + completion
   * report. See `ReplVm.evalCode` for the outcome shapes. The returned
   * promise is fulfilled synchronously (the VM layer performs no `await`),
   * so an eval cannot race `dispose()`.
   */
  eval(code: string, options?: ReplEvalOptions): Promise<ReplEvalOutcome> {
    this.assertAlive();
    return this.vm.evalCode(code, options);
  }

  /**
   * Run the job drain loop (settle what can be settled). Used after an
   * eval that suspended, when host-side settlement (subagent calls in a
   * later phase) has made progress. Because a suspended eval's interrupt
   * handler is no longer armed, the drain accepts its own per-drain
   * `interruptHandler` so a resumed runaway continuation stays bounded.
   */
  drainJobs(options?: ReplDrainOptions): number {
    this.assertAlive();
    return this.vm.drainJobs(options);
  }

  /**
   * Teardown: dispose the VM and drop all stored state. In-flight work is
   * cancelled by the caller (the tool layer); the VM itself is gone after
   * this. Because every VM operation is synchronous, no operation can be
   * in flight when this runs.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vm.dispose();
  }

  /** Support for `using` declarations (Explicit Resource Management). */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /** True once `dispose()` has been called. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error(`Workspace ${this.projectDir}: operation on a disposed workspace`);
    }
  }
}

/** Options for a `WorkspaceRegistry`. */
export interface WorkspaceRegistryOptions {
  /**
   * WASM bytes or module shared as the default by every workspace the
   * registry creates (see `WasmInput` in `types.ts`). Defaults to the
   * shipped `quickjs.wasm` binary.
   */
  wasm?: WasmInput;
  /**
   * Default per-VM malloc limit in bytes for workspaces created without
   * their own `memoryLimit` (per-workspace limits override this).
   */
  memoryLimit?: number;
}

/** An in-flight workspace creation, tracked so concurrent `get`s dedupe. */
interface PendingCreate {
  /** The creation promise every concurrent `get` for this key awaits. */
  promise: Promise<Workspace>;
  /**
   * Set by `dispose`/`disposeAll` to veto materialization: the created
   * workspace is torn down without being registered, and the waiting
   * caller's promise rejects.
   */
  cancelled: boolean;
}

/**
 * Project-keyed registry of workspaces, enforcing one VM per workspace.
 * This is the engine boundary the `repl` MCP tool (a later phase) calls:
 * the tool resolves its `projectDir` argument through here, exactly like
 * the daemon's project registry resolves project contexts for `workflow`.
 */
export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pending = new Map<string, PendingCreate>();
  private readonly options: WorkspaceRegistryOptions;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.options = options;
  }

  /**
   * Get the workspace for a project directory, creating it on first touch.
   * The same project directory always yields the same workspace (and thus
   * the same VM) for the lifetime of the registry.
   *
   * Concurrent first-touches of one key share a single in-flight creation
   * promise: exactly one VM is instantiated, and both callers receive the
   * same workspace. When concurrent callers pass different options, the
   * first caller's options win (first-touch-wins is the registry's
   * documented policy — the workspace exists once, so its configuration
   * is decided once).
   */
  async get(projectDir: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const existing = this.workspaces.get(projectDir);
    if (existing) return existing;

    // Deduplicate the in-flight creation itself — not just the completed
    // result (review regression: two concurrent first-touches each ran a
    // full `Workspace.create`, instantiating two VMs for one project).
    const flight = this.pending.get(projectDir);
    if (flight) return flight.promise;

    const pending: PendingCreate = { cancelled: false, promise: undefined! };
    const merged: WorkspaceOptions = {
      wasm: options.wasm ?? this.options.wasm,
      memoryLimit: options.memoryLimit ?? this.options.memoryLimit,
    };
    pending.promise = Workspace.create(projectDir, merged).then(
      (created) => {
        // Only remove our own entry: `dispose` may have removed it already
        // and a later `get` may have installed a fresh one.
        if (this.pending.get(projectDir) === pending) this.pending.delete(projectDir);
        if (pending.cancelled) {
          // `dispose`/`disposeAll` won the race: never materialize the
          // workspace. Tear the fresh VM down immediately — no VM is left
          // behind either way.
          created.dispose();
          throw new Error(`Workspace ${projectDir}: creation cancelled by dispose`);
        }
        this.workspaces.set(projectDir, created);
        return created;
      },
      (error) => {
        if (this.pending.get(projectDir) === pending) this.pending.delete(projectDir);
        throw error;
      },
    );
    this.pending.set(projectDir, pending);
    return pending.promise;
  }

  /** True when a workspace exists for this project directory. */
  has(projectDir: string): boolean {
    return this.workspaces.has(projectDir);
  }

  /** The number of live workspaces. */
  get size(): number {
    return this.workspaces.size;
  }

  /** The project directories with live workspaces. */
  keys(): string[] {
    return [...this.workspaces.keys()];
  }

  /**
   * Dispose and drop the workspace for a project directory. Returns true
   * when a live workspace was disposed. When only a creation is in flight
   * (no live workspace yet), it is cancelled: the created workspace is
   * torn down without materializing and the waiting `get` caller's promise
   * rejects — the invariant "dispose means the workspace is gone" holds
   * even under the race, and a later `get` creates a fresh workspace.
   */
  dispose(projectDir: string): boolean {
    const workspace = this.workspaces.get(projectDir);
    if (workspace) {
      this.workspaces.delete(projectDir);
      workspace.dispose();
      return true;
    }
    const flight = this.pending.get(projectDir);
    if (flight) {
      this.pending.delete(projectDir);
      flight.cancelled = true;
    }
    return false;
  }

  /** Dispose and drop every workspace; cancel every in-flight creation. */
  disposeAll(): void {
    for (const workspace of this.workspaces.values()) {
      workspace.dispose();
    }
    this.workspaces.clear();
    for (const flight of this.pending.values()) {
      flight.cancelled = true;
    }
    this.pending.clear();
  }
}
