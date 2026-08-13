/**
 * @automatalabs/repl-engine — the REPL orchestrator's engine package.
 *
 * A persistent JavaScript REPL in a capability-free QuickJS-in-WASM VM.
 * One VM per workspace; the workspace object owns the VM lifecycle
 * (create, eval, drain, dispose). This package is the engine tier of the
 * REPL orchestrator roadmap doc (docs/roadmap/repl-orchestrator.md); the
 * `repl` MCP tool in `mcp-server` registers over it (the roadmap's
 * phase E — shipped), and the broker drives subagents as ACP sessions
 * through `@automatalabs/acp-agents` (the same backends the SDK's
 * workflow engine drives).
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
export {
  Workspace,
  WorkspaceRegistry,
  type WorkspaceOptions,
  type WorkspaceRegistryOptions,
  type WorkspaceManifest,
  type WorkspaceBinding,
} from './workspace.js';
export {
  baselineGlobalKeys,
  baselineLexicalKeys,
  provenanceBootstrap,
  provenanceRecord,
  provenanceView,
  isValidOriginLabel,
  type ProvenanceOrigin,
  type ProvenanceView,
  type OriginRecord,
  type BaselineKeys,
} from './provenance.js';
export { LexicalEnumerationError } from './errors.js';
export type { EvalErrorInfo } from './errors.js';
export type { WasmInput, WasmModule, ReplSnapshot, ReplSnapshotExtension } from './types.js';

// Phase B: the guest-side library bridge, the previewer, and the output
// caps. See the package README's "Guest library ⇄ host contract".
export {
  GUEST_LIBRARY_VERSION,
  GUEST_SURFACE_KEY,
  GUEST_VERSION_GLOBAL,
  GUEST_PROVENANCE_KEY,
  HOST_AGENT,
  HOST_CHECKPOINT,
  HOST_CONSOLE,
  HOST_STEER,
  HOST_SLEEP,
  HOST_WORKSPACE,
  HOST_AGENTS,
  HOST_RESET,
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
  manifestBinding,
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
  REPR_MAX_DEPTH,
  REPR_MAX_ENTRIES,
  REPR_NESTED_STRING_CHARS,
  type PreviewType,
  type PreviewSubtype,
  type PropertyPreviewKind,
  type PropertyPreview,
  type ObjectPreview,
} from './preview.js';
export { applyOutputCaps, capFinalText, OUTPUT_MAX_LINES, OUTPUT_MAX_BYTES, type OutputCapResult } from './caps.js';

// Phase F review round 2: the out-of-band eval-break channel (the
// interrupt tool's no-id path deliverable to a synchronously running
// eval — see the module docs).
export {
  EvalBreakChannelImpl,
  createEvalBreakChannel,
  EVAL_BREAK_CHANNEL_INITIAL_SLOTS,
  EVAL_BREAK_CHANNEL_MAX_BYTES,
  type EvalBreakChannel,
} from './eval-break-channel.js';

// Phase C: the broker, the append-only call store, and the eval
// tool-result semantics. See the package README's "The broker" section.
export {
  Broker,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_DISPOSE_BOUND_MS,
  type BrokerOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
  type BrokerOpenSessionOptions,
  type BrokerPromptOptions,
  type BrokerLoadSessionOptions,
  type SteeringOutcomeValue,
  type ReplEvalResult,
  type CheckpointSummary,
  type CheckpointInfo,
  type LiveAgentInfo,
  type ReconcileReport,
  type SnapshotSink,
  type SnapshotBoundaryKind,
  type WorkspaceManifestReport,
  type WorkspaceManifestBinding,
} from './broker.js';
export {
  InMemoryCallStore,
  JsonlCallStore,
  type CallStore,
  type CallRecord,
  type CallOutcome,
  type CallKind,
  type CallOutcomeKind,
} from './store.js';

// Phase D: enveloped snapshots, the per-project store, and the restore
// path. See the package README's "Snapshots and durability" section.
export {
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_VERSION,
  serializeSnapshot,
  deserializeSnapshot,
  wasmSha256Of,
  SnapshotEnvelopeError,
  SnapshotRestoreError,
  type SnapshotEnvelopeMeta,
  type SnapshotEnvelope,
  type SnapshotEnvelopeErrorCode,
} from './snapshot-envelope.js';
export {
  ReplWorkspaceStore,
  REPL_STORE_SUBDIR,
  SNAPSHOT_FILENAME,
  CALL_STORE_FILENAME,
  type ReplStoreOptions,
  type SnapshotWriteOptions,
  type RestoredReplSnapshot,
  type ReplStoreStats,
} from './repl-store.js';
