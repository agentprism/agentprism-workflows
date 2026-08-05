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
export type { WasmInput, WasmModule, ReplSnapshot, ReplSnapshotExtension } from './types.js';

// Phase B: the guest-side library bridge, the previewer, and the output
// caps. See the package README's "Guest library ⇄ host contract".
export {
  GUEST_LIBRARY_VERSION,
  GUEST_SURFACE_KEY,
  GUEST_VERSION_GLOBAL,
  HOST_AGENT,
  HOST_CHECKPOINT,
  HOST_CONSOLE,
  HOST_STEER,
} from './guest/guest-library.js';
export {
  installGuestBridge,
  registerGuestHostCallbacks,
  GuestLibraryInstallError,
  GuestCall,
  readGuestSurface,
  readRealmSlot,
  type GuestBridgeHandlers,
  type GuestSurface,
  type GuestSurfaceEntry,
  type ConsoleEvent,
  type ConsoleLevel,
  type RealmSlot,
} from './bridge.js';
export {
  renderPreviewLine,
  renderCollapsed,
  renderRefLine,
  renderGlobalLine,
  previewGlobal,
  inspectGlobal,
  formatByteSize,
  formatNumber,
  escapeString,
  stringDescription,
  shortString,
  headTailDescription,
  isCanonicalIndex,
  MAX_PREVIEW_PROPERTIES,
  MAX_PREVIEW_ARRAY_ITEMS,
  MAX_PROPERTY_VALUE_CHARS,
  PROPERTY_STRING_HEAD_CHARS,
  PROPERTY_STRING_TAIL_CHARS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_STRING_PREVIEW_CHARS,
  STRING_HEAD_CHARS,
  STRING_TAIL_CHARS,
  MAX_COLLAPSED_CHARS,
  type PreviewType,
  type PreviewSubtype,
  type PropertyPreviewKind,
  type PropertyPreview,
  type ObjectPreview,
} from './preview.js';
export { applyOutputCaps, OUTPUT_MAX_LINES, OUTPUT_MAX_BYTES, type OutputCapResult } from './caps.js';
