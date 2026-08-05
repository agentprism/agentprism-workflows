/**
 * @automatalabs/repl-engine — the REPL orchestrator's engine package.
 *
 * A persistent JavaScript REPL in a capability-free QuickJS-in-WASM VM.
 * One VM per workspace; the workspace object owns the VM lifecycle
 * (create, eval, drain, dispose). This package is the engine tier of the
 * REPL orchestrator roadmap doc (docs/roadmap/repl-orchestrator.md); the
 * `repl` MCP tool that registers in `mcp-server` (a later phase) is a thin
 * entry over `WorkspaceRegistry`.
 *
 * Engine posture (all quickjs-wasi built-ins, used as-is):
 * `memoryLimit` per VM, `interruptHandler` per eval.
 */

export {
  ReplVm,
  DrainJobError,
  loadShippedWasm,
  type ReplVmOptions,
  type ReplEvalOptions,
  type ReplDrainOptions,
  type ReplEvalOutcome,
} from './vm.js';
export { Workspace, WorkspaceRegistry, type WorkspaceOptions, type WorkspaceRegistryOptions } from './workspace.js';
export type { EvalErrorInfo } from './errors.js';
export type { WasmInput, WasmModule } from './types.js';
