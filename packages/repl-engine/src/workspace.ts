/**
 * The workspace layer of the REPL engine.
 *
 * One VM per workspace. The workspace object owns the VM lifecycle:
 * `create` (instantiate the VM), `evalCode` (eval + job drain), `drainJobs`
 * (a settlement drain), and `dispose`. Workspaces are keyed by project
 * directory, mirroring the daemon's project model that the `repl` tool
 * (a later phase) addresses them by; the `WorkspaceRegistry` enforces the
 * one-VM-per-workspace invariant.
 */

import { ReplVm, type ReplEvalOptions, type ReplEvalOutcome } from './vm.js';

export type { ReplEvalOptions, ReplEvalOutcome } from './vm.js';

/** Options for creating a workspace (per-VM configuration). */
export interface WorkspaceOptions {
  /**
   * WASM bytes or a pre-compiled `WebAssembly.Module`. Defaults to the
   * `quickjs-wasi` package's shipped `quickjs.wasm` binary.
   */
  wasm?: BufferSource | WebAssembly.Module;
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
   * report. See `ReplVm.evalCode` for the outcome shapes.
   */
  eval(code: string, options?: ReplEvalOptions): Promise<ReplEvalOutcome> {
    this.assertAlive();
    return this.vm.evalCode(code, options);
  }

  /**
   * Run the job drain loop (settle what can be settled). Used after an
   * eval that suspended, when host-side settlement (subagent calls in a
   * later phase) has made progress.
   */
  drainJobs(): number {
    this.assertAlive();
    return this.vm.drainJobs();
  }

  /**
   * Teardown: dispose the VM and drop all stored state. In-flight work is
   * cancelled by the caller (the tool layer); the VM itself is gone after
   * this.
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
   * registry creates. Defaults to the shipped `quickjs.wasm` binary.
   */
  wasm?: BufferSource | WebAssembly.Module;
  /**
   * Default per-VM malloc limit in bytes for workspaces created without
   * their own `memoryLimit` (per-workspace limits override this).
   */
  memoryLimit?: number;
}

/**
 * Project-keyed registry of workspaces, enforcing one VM per workspace.
 * This is the engine boundary the `repl` MCP tool (a later phase) calls:
 * the tool resolves its `projectDir` argument through here, exactly like
 * the daemon's project registry resolves project contexts for `workflow`.
 */
export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly options: WorkspaceRegistryOptions;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.options = options;
  }

  /**
   * Get the workspace for a project directory, creating it on first touch.
   * The same project directory always yields the same workspace (and thus
   * the same VM) for the lifetime of the registry.
   */
  async get(projectDir: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const existing = this.workspaces.get(projectDir);
    if (existing) return existing;
    const created = await Workspace.create(projectDir, {
      wasm: options.wasm ?? this.options.wasm,
      memoryLimit: options.memoryLimit ?? this.options.memoryLimit,
    });
    // Two concurrent first-touches of the same key would each create a VM;
    // keep the first, dispose the loser. The registry enforces the
    // one-VM-per-workspace invariant even under races.
    const winner = this.workspaces.get(projectDir) ?? created;
    if (winner !== created) created.dispose();
    else this.workspaces.set(projectDir, created);
    return winner;
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

  /** Dispose and drop the workspace for a project directory. */
  dispose(projectDir: string): boolean {
    const workspace = this.workspaces.get(projectDir);
    if (!workspace) return false;
    this.workspaces.delete(projectDir);
    workspace.dispose();
    return true;
  }

  /** Dispose and drop every workspace. */
  disposeAll(): void {
    for (const workspace of this.workspaces.values()) {
      workspace.dispose();
    }
    this.workspaces.clear();
  }
}
