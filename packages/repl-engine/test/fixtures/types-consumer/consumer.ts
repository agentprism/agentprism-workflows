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
  renderRefLine,
  renderGlobalLine,
  inspectGlobal,
  renderPreviewLine,
  renderCollapsed,
  formatByteSize,
  formatNumber,
  escapeString,
  stringDescription,
  shortString,
  headTailDescription,
  isCanonicalIndex,
  applyOutputCaps,
  OUTPUT_MAX_LINES,
  OUTPUT_MAX_BYTES,
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
      event.refs satisfies string[];
      event.args satisfies unknown[];
    },
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
  const slot: RealmSlot = readRealmSlot(bridgeVm, '$1');
  slot satisfies RealmSlot;
  const line: string = renderRefLine(bridgeVm, '$1', { fallback: true });
  line satisfies string;
  renderGlobalLine(bridgeVm, 'anything') satisfies string;
  const meta = inspectGlobal(bridgeVm, '$1');
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
  renderPreviewLine(7, 48000, preview) satisfies string;
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
  const capped = applyOutputCaps(['line 1', 'line 2']);
  capped.lines satisfies string[];
  capped.truncated satisfies boolean;
  OUTPUT_MAX_LINES satisfies number;
  OUTPUT_MAX_BYTES satisfies number;
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
    dispatchedAtMs: 1,
    reissues: 0,
    completion: null,
    sessionId: null,
    deliveredAtMs: null,
    droppedAtMs: null,
  });
  store.recordReissued('c1', 2);
  store.recordCompleted('c1', { outcome: 'resolve', value: { ok: true }, completedAtMs: 3 }) satisfies boolean;
  store.recordDelivery('c1', 'delivered', 4);
  store.lookup('c1') satisfies CallRecord | undefined;
  store.all() satisfies CallRecord[];
}

function brokerSurfaceTyping(ws: Workspace): void {
  const options: BrokerOptions = {
    runner: {
      async openSession(_opts: BrokerOpenSessionOptions): Promise<BrokerSession> {
        return {
          sessionId: 's1',
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
        };
      },
      async dispose(): Promise<void> {},
    },
    store: new InMemoryCallStore(),
    maxConcurrentAgents: 6,
  } satisfies BrokerOptions;
  void brokerTyping(ws, options);
  DEFAULT_MAX_CONCURRENT_AGENTS satisfies number;
  const outcome: SteeringOutcomeValue = 'queued';
  outcome satisfies string;
  const recordKind: CallKind = 'steer';
  recordKind satisfies string;
  const outcomeKind: CallOutcomeKind = 'reject';
  outcomeKind satisfies string;
  const summary: CheckpointSummary = { id: 'c1', question: '"What color?"' };
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
  const report: ReconcileReport = { settledFromStore: ['c1'], leftPending: [], reQueuedUndelivered: [] };
  info satisfies CheckpointInfo;
  live satisfies LiveAgentInfo;
  report satisfies ReconcileReport;
  const fileStore = JsonlCallStore.open('/tmp/consumer-calls.jsonl');
  fileStore.path() satisfies string;
  fileStore.close();
  const evalResult: ReplEvalResult = {
    output: ['[$1 · number · 8B] 42'],
    outputTruncated: false,
    result: '42',
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
