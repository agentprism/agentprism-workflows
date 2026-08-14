/**
 * Type-check fixture simulating a published-package consumer.
 *
 * Imports the engine's PUBLIC declarations (`dist`) under the
 * repository's non-DOM lib (the tsconfig.base lib `ES2022` +
 * `ESNext.Disposable` — the latter is required by the public
 * `[Symbol.dispose]` methods, same as quickjs-wasi's own) with
 * `skipLibCheck: false` and no ambient `@types`. The public type graph
 * must be fully self-contained: every type the API references must be
 * declared inside the package itself.
 *
 * Regression (review): `ReplVmOptions.wasm`, `WorkspaceOptions.wasm` and
 * `WorkspaceRegistryOptions.wasm` referenced `BufferSource` /
 * `WebAssembly.Module`, whose only declarations lived in an unpublished
 * source ambient (`src/wasm-ambient.d.ts`, never emitted — the published
 * package ships `dist` only). This configuration failed with seven
 * missing-type errors across `dist/vm.d.ts` and `dist/workspace.d.ts`.
 *
 * Note: this file is intentionally NOT part of the package's own
 * typecheck (the package tsconfig covers src only); it is compiled by
 * `test/public-types.test.ts` against the built `dist` declarations.
 */
import {
  ReplVm,
  Workspace,
  WorkspaceRegistry,
  loadShippedWasm,
  DrainJobError,
  GuestCall,
  GuestLibraryInstallError,
  installGuestBridge,
  registerGuestHostCallbacks,
  readGuestSurface,
  readRealmSlot,
  inspectGlobal,
  renderCollapsed,
  formatByteSize,
  formatNumber,
  escapeString,
  stringDescription,
  shortString,
  headTailDescription,
  isCanonicalIndex,
  GUEST_LIBRARY_VERSION,
  GUEST_SURFACE_KEY,
  GUEST_VERSION_GLOBAL,
  HOST_AGENT,
  HOST_CHECKPOINT,
  HOST_CONSOLE,
  HOST_STEER,
  MAX_PREVIEW_PROPERTIES,
  MAX_COLLAPSED_CHARS,
  type ReplVmOptions,
  type ReplEvalOptions,
  type ReplEvalOutcome,
  type WorkspaceOptions,
  type WorkspaceRegistryOptions,
  type EvalErrorInfo,
  type WasmInput,
  type WasmModule,
  type ReplSnapshot,
  type GuestBridgeHandlers,
  type GuestSurface,
  type GuestSurfaceEntry,
  type ConsoleEvent,
  type ConsoleLevel,
  type RealmSlot,
  type ObjectPreview,
  type PropertyPreview,
  type PreviewType,
  type PreviewSubtype,
} from '../../../dist/index.js';

async function exercise(): Promise<void> {
  // The shipped binary compiles to the self-contained `WasmModule` type
  // and round-trips into every option position that used to name the
  // (undeclared) `WebAssembly.Module` / `BufferSource` globals.
  const module: WasmModule = await loadShippedWasm();
  const vmOptions: ReplVmOptions = { wasm: module, memoryLimit: 1024 };
  const vm = await ReplVm.create(vmOptions);
  const evalOptions: ReplEvalOptions = {
    filename: 'consumer.js',
    interruptHandler: () => false,
  };
  const outcome: ReplEvalOutcome = await vm.evalCode('1 + 1', evalOptions);
  if (outcome.kind === 'error') {
    const info: EvalErrorInfo = outcome.error;
    info.interrupted satisfies boolean;
    info.outOfMemory satisfies boolean;
  }
  const wsOptions: WorkspaceOptions = { wasm: module };
  const ws = await Workspace.create('/tmp/project', wsOptions);
  const registryOptions: WorkspaceRegistryOptions = { wasm: module, memoryLimit: 4096 };
  const registry = new WorkspaceRegistry(registryOptions);
  const got: Workspace = await registry.get('/tmp/project', wsOptions);
  const bytes = new Uint8Array([0, 97, 115, 109]);
  const asBytes: WasmInput = bytes;
  const asArrayBuffer: WasmInput = new ArrayBuffer(4);
  let maybeDrainError: DrainJobError | undefined;
  if (maybeDrainError) {
    maybeDrainError.info satisfies EvalErrorInfo;
  }
  ws.dispose();
  got.dispose();
  registry.disposeAll();
  vm.dispose();
}

async function exercisePhaseB(): Promise<void> {
  // Phase B public surface: the guest-library bridge, the previewer, the
  // caps — every exported declaration must be checkable by a consumer with
  // a non-DOM lib and skipLibCheck: false (no quickjs-wasi types leak).
  const bridgeVm = await ReplVm.create();
  const handlers: GuestBridgeHandlers = {
    agent: (call: GuestCall, callId: string, modelSpec: string, task: string, optionsJson: string | null) => {
      callId satisfies string;
      modelSpec satisfies string;
      task satisfies string;
      optionsJson satisfies string | null;
      call.resolve({ ok: true });
    },
    checkpoint: (call, callId, question, optionsJson, answerJson) => {
      callId satisfies string;
      question satisfies string | null;
      optionsJson satisfies string | null;
      answerJson satisfies string | null;
      if (answerJson !== null) return true;
      call?.resolve('answered');
      return undefined;
    },
    steer: (call, callId, sessionId, action, payloadJson) => {
      callId satisfies string;
      sessionId satisfies string;
      action satisfies string;
      payloadJson satisfies string | null;
      call.resolve('injected');
    },
    console: (event: ConsoleEvent) => {
      event.level satisfies ConsoleLevel;
      event.line satisfies string;
    },
    sleep: (call: GuestCall, ms: number) => {
      ms satisfies number;
      call.resolve(undefined);
    },
    workspace: () => '{}',
    agents: () => '[]',
    reset: () => undefined,
    defaultBackend: () => undefined,
  };
  await installGuestBridge(bridgeVm, handlers);
  registerGuestHostCallbacks(bridgeVm, handlers);
  const surface: GuestSurface | undefined = readGuestSurface(bridgeVm);
  if (surface) {
    surface.version satisfies string;
    const pending: GuestSurfaceEntry[] = surface.pending();
    pending satisfies GuestSurfaceEntry[];
    const settled: boolean = surface.settle('c1', 'resolve', 42);
    settled satisfies boolean;
    const stats = surface.stats();
    stats.pendingCalls satisfies number;
  }
  const slot: RealmSlot = readRealmSlot(bridgeVm, 'agent');
  slot satisfies RealmSlot;
  const meta = inspectGlobal(bridgeVm, 'agent');
  meta.kind satisfies 'data' | 'accessor' | 'absent';
  meta.label satisfies string;
  meta.sizeBytes satisfies number;
  const preview: ObjectPreview = {
    type: 'object',
    subtype: 'array',
    description: 'Array(3)',
    overflow: false,
    properties: [{ name: '0', type: 'number', value: '1' } satisfies PropertyPreview],
  };
  const t: PreviewType = preview.type;
  const st: PreviewSubtype | undefined = preview.subtype;
  renderCollapsed(preview) satisfies string;
  formatByteSize(48000) satisfies string;
  formatNumber(-0) satisfies string;
  escapeString('a"b') satisfies string;
  stringDescription('x'.repeat(300)) satisfies string;
  shortString('y') satisfies string;
  headTailDescription('z', 120) satisfies string;
  isCanonicalIndex('0') satisfies boolean;
  MAX_PREVIEW_PROPERTIES satisfies number;
  MAX_COLLAPSED_CHARS satisfies number;
  GUEST_LIBRARY_VERSION satisfies string;
  GUEST_SURFACE_KEY satisfies string;
  GUEST_VERSION_GLOBAL satisfies string;
  HOST_AGENT satisfies string;
  HOST_CHECKPOINT satisfies string;
  HOST_CONSOLE satisfies string;
  HOST_STEER satisfies string;
  bridgeVm.dispose();
}

// Phase C: the broker, the call store, and the eval tool-result shape —
// all self-contained (no acp-agents / quickjs-wasi / shared-types types
// in the published declaration graph; the fixture's non-DOM lib and
// `skipLibCheck: false` compile the whole surface).
import {
  Broker,
  JsonlCallStore,
  InMemoryCallStore,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  type BrokerOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
  type BrokerOpenSessionOptions,
  type BrokerLoadSessionOptions,
  type BrokerPromptOptions,
  type SteeringOutcomeValue,
  type ReplEvalResult,
  type CheckpointSummary,
  type CheckpointInfo,
  type LiveAgentInfo,
  type ReconcileReport,
  type CallStore,
  type CallRecord,
  type CallOutcome,
  type CallKind,
  type CallOutcomeKind,
} from '../../../dist/index.js';

function brokerTyping(ws: Workspace, opts: BrokerOptions): Promise<Broker> {
  return Broker.attach(ws, opts);
}

function storeTyping(store: CallStore): void {
  store.recordDispatched({
    callId: 'c1',
    kind: 'agent',
    detail: 'task',
    optionsJson: null,
    modelSpec: 'pi/x',
    backendId: 'pi',
    dispatchedAtMs: 1,
    reissues: 0,
    completion: null,
    sessionId: null,
    deliveredAtMs: null,
    droppedAtMs: null,
    queuedAtMs: null,
  });
  store.recordReissued('c1', 2);
  store.recordQueued('c1', 4);
  store.recordAttached('c1', 'backend-session-1', 5, 'pi');
  store.recordCompleted('c1', { outcome: 'resolve', value: { ok: true }, completedAtMs: 3 }) satisfies boolean;
  store.recordDelivery('c1', 'delivered', 4);
  store.lookup('c1') satisfies CallRecord | undefined;
  store.all() satisfies CallRecord[];
}

function brokerSurfaceTyping(ws: Workspace): void {
  const options: BrokerOptions = {
    runner: {
      listBackends() {
        return ['claude', 'pi'];
      },
      defaultBackendId() {
        return 'claude';
      },
      async openSession(_opts: BrokerOpenSessionOptions): Promise<BrokerSession> {
        return {
          sessionId: 's1',
          backendId: 'pi',
          capabilities: { supportsSteering: true },
          async prompt(_content: string, _opts?: BrokerPromptOptions): Promise<BrokerTurn> {
            return { stopReason: 'end_turn', text: 'ok' };
          },
          async steer(_content: string, _opts?: BrokerPromptOptions): Promise<string> {
            return 'injected';
          },
          async cancel(): Promise<void> {},
          async release(): Promise<void> {},
          currentTurnText(): string {
            return '';
          },
          finalMessageText(): string {
            return '';
          },
          rawStructuredOutput(): unknown {
            return undefined;
          },
          async awaitCurrentTurn(): Promise<BrokerTurn> {
            return { stopReason: 'end_turn', text: 'loaded' };
          },
        };
      },
      async loadSession(_opts: BrokerLoadSessionOptions): Promise<BrokerSession> {
        return {
          sessionId: 's1',
          async prompt(): Promise<BrokerTurn> {
            return { stopReason: 'end_turn', text: 'ok' };
          },
          async steer(): Promise<string> {
            return 'injected';
          },
          async cancel(): Promise<void> {},
          async release(): Promise<void> {},
          currentTurnText(): string {
            return '';
          },
          finalMessageText(): string {
            return '';
          },
          rawStructuredOutput(): unknown {
            return undefined;
          },
        };
      },
      async dispose(): Promise<void> {},
    },
    store: new InMemoryCallStore(),
    maxConcurrentAgents: 6,
    evalTimeoutMs: 30_000,
    interruptHandler: () => false,
    snapshotSink: {
      boundary: (_kind: SnapshotBoundaryKind) => {},
      flush: () => {},
    },
  } satisfies BrokerOptions;
  void brokerTyping(ws, options);
  DEFAULT_MAX_CONCURRENT_AGENTS satisfies number;
  const outcome: SteeringOutcomeValue = 'queued';
  outcome satisfies string;
  const recordKind: CallKind = 'steer';
  recordKind satisfies string;
  const outcomeKind: CallOutcomeKind = 'reject';
  outcomeKind satisfies string;
  const summary: CheckpointSummary = { id: 'c1', question: 'What color?' };
  summary satisfies { id: string; question: string };
  const info: CheckpointInfo = { id: 'c1', question: 'x', optionsJson: null, raisedAtMs: 1 };
  const live: LiveAgentInfo = {
    callId: 'c1',
    modelSpec: 'pi/x',
    task: 't',
    state: 'running',
    supportsSteering: true,
    queuedSteers: 0,
  };
  const report: ReconcileReport = {
    settledFromStore: ['c1'],
    reattached: [],
    reissued: [],
    failedLost: [],
    requeuedCheckpoints: [],
    leftPending: [],
    reQueuedUndelivered: [],
  };
  info satisfies CheckpointInfo;
  live satisfies LiveAgentInfo;
  report satisfies ReconcileReport;
  const fileStore = JsonlCallStore.open('/tmp/consumer-calls.jsonl');
  fileStore.path() satisfies string;
  fileStore.close();
  const evalResult: ReplEvalResult = {
    output: ['42'],
    kind: 'value',
    result: '42',
    evalToken: 'e1',
    pending: [],
    checkpoints: [],
    completed: [],
  };
  evalResult satisfies ReplEvalResult;
  const callOutcome: CallOutcome = { outcome: 'resolve', value: 'x', completedAtMs: 1 };
  callOutcome satisfies CallOutcome;
  void storeTyping;
  void options;
  void brokerSurfaceTyping;
}

// Phase D: enveloped snapshots, the per-project store, and the restore
// path — all self-contained (no node types, no quickjs-wasi / workflows
// types in the published declaration graph; the fixture's non-DOM lib,
// `types: []` and `skipLibCheck: false` compile the whole surface).
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_VERSION,
  serializeSnapshot,
  deserializeSnapshot,
  wasmSha256Of,
  SnapshotEnvelopeError,
  ReplWorkspaceStore,
  REPL_STORE_SUBDIR,
  SNAPSHOT_FILENAME,
  CALL_STORE_FILENAME,
  GUEST_PROVENANCE_KEY,
  manifestBinding,
  baselineGlobalKeys,
  provenanceBootstrap,
  provenanceRecord,
  provenanceView,
  isValidOriginLabel,
  DEFAULT_EVAL_TIMEOUT_MS,
  type SnapshotEnvelopeMeta,
  type SnapshotEnvelope,
  type SnapshotEnvelopeErrorCode,
  type ReplStoreOptions,
  type SnapshotWriteOptions,
  type RestoredReplSnapshot,
  type ReplStoreStats,
  type SnapshotSink,
  type SnapshotBoundaryKind,
  type WorkspaceManifest,
  type WorkspaceBinding,
  type WorkspaceManifestReport,
  type WorkspaceManifestBinding,
  type ProvenanceOrigin,
  type ProvenanceView,
  type OriginRecord,
  type BaselineKeys,
} from '../../../dist/index.js';

async function phaseDSurfaceTyping(): Promise<void> {
  SNAPSHOT_FORMAT satisfies string;
  SNAPSHOT_FORMAT_VERSION satisfies number;
  REPL_STORE_SUBDIR satisfies string;
  SNAPSHOT_FILENAME satisfies string;
  CALL_STORE_FILENAME satisfies string;
  GUEST_PROVENANCE_KEY satisfies string;
  DEFAULT_EVAL_TIMEOUT_MS satisfies number;

  const storeOptions: ReplStoreOptions = {
    persistenceRoot: '/tmp/persist',
    env: { AGENTPRISM_PERSISTENCE_ROOT: '/tmp/persist' },
    snapshotWrite: { debounceBursts: true, fsync: true },
  };
  const writeOptions: SnapshotWriteOptions = {};
  writeOptions.debounceBursts satisfies boolean | undefined;
  writeOptions.fsync satisfies boolean | undefined;
  const store = ReplWorkspaceStore.open('/tmp/project', storeOptions);
  store.projectDir satisfies string;
  store.replDir satisfies string;
  store.snapshotPath satisfies string;
  store.callStorePath satisfies string;
  store.hasSnapshot() satisfies boolean;
  const sink: SnapshotSink = {
    boundary: (kind: SnapshotBoundaryKind) => {
      kind satisfies 'eval' | 'settlement';
    },
    flush: () => {},
  };
  void sink;
  // The snapshot writer is wired to a REAL workspace and wasm input — the
  // phase-D review round-2 fixture rule: the writer's type surface must be
  // exercised against real engine objects, never fake substitutes.
  const realWorkspace = await Workspace.create('/tmp/project');
  const realWasm: WasmInput = new Uint8Array([0, 97, 115, 109]);
  const fromWriter: SnapshotSink = store.snapshotWriter(realWorkspace, realWasm);
  fromWriter.boundary('eval');
  store.stats() satisfies ReplStoreStats;
  store.close();
  store.reset();

  const snapshot: ReplSnapshot = {
    memory: new Uint8Array(4),
    stackPointer: 0,
    runtimePtr: 0,
    contextPtr: 0,
    extensions: [],
  };
  const envelope: Uint8Array = serializeSnapshot(snapshot, 'a'.repeat(64), { createdAtMs: 1 });
  envelope satisfies Uint8Array;
  const parsed: SnapshotEnvelope = deserializeSnapshot(envelope, { path: '/tmp/snapshot.bin' });
  parsed.snapshot.runtimePtr satisfies number;
  parsed.meta satisfies SnapshotEnvelopeMeta;
  parsed.meta.wasmSha256 satisfies string;
  parsed.meta.formatVersion satisfies number;
  const hash: string = wasmSha256Of(new Uint8Array([1, 2, 3]));
  hash satisfies string;
  const restored: RestoredReplSnapshot = store.loadSnapshot(new Uint8Array([0, 97, 115, 109]));
  restored.snapshot satisfies ReplSnapshot;
  restored.wasmSha256 satisfies string;
  restored.formatVersion satisfies number;
  restored.createdAtMs satisfies number;
  const errorCode: SnapshotEnvelopeErrorCode = 'WASM_HASH_MISMATCH';
  errorCode satisfies string;
  const err = new SnapshotEnvelopeError('VERSION_MISMATCH', 'boom', {
    path: '/tmp/snapshot.bin',
    recorded: '2',
    expected: '1',
  });
  err.code satisfies SnapshotEnvelopeErrorCode;
  err.path satisfies string | undefined;

  // The manifest + provenance + drain surface (phase-D review round 2).
  const manifest: WorkspaceManifest = realWorkspace.manifest();
  manifest.evalSeq satisfies number;
  manifest.logs satisfies { first: number | null; last: number | null; count: number };
  const binding: WorkspaceBinding = manifest.bindings[0];
  binding.name satisfies string;
  binding.token satisfies string;
  binding.handleCallId satisfies string | null;
  binding.provenance satisfies string | null;
  binding.provenanceAtMs satisfies number | null;
  realWorkspace.provenanceRecord({ kind: 'eval' });
  realWorkspace.provenanceRecord({ kind: 'settlement', callIds: ['c1'] });
  realWorkspace.provenanceRecord({ kind: 'restore' });
  const provView: ProvenanceView = realWorkspace.provenanceView();
  provView.evalSeq satisfies number;
  provView.origins satisfies Map<string, OriginRecord>;
  const origin: ProvenanceOrigin = { kind: 'settlement', callIds: ['c1'] };
  origin satisfies ProvenanceOrigin;
  const baseline: Promise<BaselineKeys> = baselineGlobalKeys(realWasm);
  baseline satisfies Promise<string[]>;
  const freshVm = await ReplVm.create();
  const bootstrapped: Promise<{ created: boolean; baseline: BaselineKeys }> = provenanceBootstrap(freshVm, realWasm);
  void bootstrapped;
  freshVm.dispose();
  isValidOriginLabel('eval 1') satisfies boolean;
  const bindingToken = manifestBinding(freshVm, 'x');
  bindingToken?.token satisfies string | undefined;
  bindingToken?.handleCallId satisfies string | null | undefined;
  realWorkspace.dispose();

  void writeOptions;
  void fromWriter;
  void restored;
}

// The broker's phase-D round-2 additions: the enriched manifest, the
// client-presence drain, the eval deadline, and the cancel outcomes.
async function brokerManifestAndDrainTyping(): Promise<void> {
  const broker = await Broker.attach(await Workspace.create('/tmp/project'));
  broker.isDrained satisfies boolean;
  broker.busySessionCount() satisfies number;
  broker.inFlightIds() satisfies string[];
  const drained: Promise<boolean> = broker.drainForDisconnect(60_000);
  drained satisfies Promise<boolean>;
  const cancelOutcome: Promise<'cancelled' | 'idle' | 'failed' | 'none'> = broker.cancelCall('c1');
  cancelOutcome satisfies Promise<string>;
  const report: WorkspaceManifestReport = broker.workspaceManifest();
  report.evalSeq satisfies number;
  report.inFlight satisfies string[];
  report.checkpoints satisfies CheckpointInfo[];
  report.logs satisfies { first: number | null; last: number | null; count: number };
  const manifestBindingEntry: WorkspaceManifestBinding = report.bindings[0];
  manifestBindingEntry.name satisfies string;
  manifestBindingEntry.token satisfies string;
  manifestBindingEntry.provenance satisfies string | null;
  manifestBindingEntry.provenanceAtMs satisfies number | null;
  await broker.dispose();
}

// The self-contained snapshot stand-in round-trips as a type.
function snapshotTyping(snapshot: ReplSnapshot): ReplSnapshot {
  return snapshot;
}

// Negative cases — the public boundary must reject accidental values.
// Review regression: `WasmModule` was an empty interface, so `{ wasm: 42 }`
// type-checked (every non-null value satisfies an empty interface) and
// failed only at runtime. The branded opaque module type must make all of
// these compile-time errors; the `@ts-expect-error` directives fail the
// fixture build if any line stops erroring.

// @ts-expect-error a bare number is not a wasm input
const badNumber: WasmInput = 42;

// @ts-expect-error a bare object is not a compiled module (opaque brand)
const badModule: WasmModule = {};

// @ts-expect-error a string is not a wasm input
const badString: WasmInput = 'quickjs.wasm';

// @ts-expect-error `{ wasm: 42 }` must not type-check as VM options
const badVmOptions: ReplVmOptions = { wasm: 42 };

// @ts-expect-error `{ wasm: 42 }` must not type-check as workspace options
const badWsOptions: WorkspaceOptions = { wasm: 42 };

// @ts-expect-error a boolean is not a wasm input
const badBoolean: WasmInput = true;
