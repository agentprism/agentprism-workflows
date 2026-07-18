// Test for the @automatalabs/workflows SDK facade.
//
// Drives a TINY workflow through the public barrel using a STUB AgentRunner (the
// engine's frozen seam — run() returns the RAW value: text when no schema), so the
// suite exercises the facade + the runDynamicWorkflow helper with NO live ACP backend.
// Modeled on the mcp-server test harness (packages/mcp-server/test/_harness.ts): the
// stub double + the disposable-HOME isolation so WorkflowManager run persistence
// (~/.agentprism/workflows/projects/<key>/runs) writes into a throwaway temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Redirect run-state persistence into a disposable home BEFORE any WorkflowManager is
// constructed (runDynamicWorkflow builds one per call, deriving the runs dir from $HOME
// at construction time). Setting it at module load fully isolates the suite's on-disk runs.
const TEST_HOME = mkdtempSync(join(tmpdir(), "automatalabs-workflows-test-home-"));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the throwaway home */
  }
});

// Import EXCLUSIVELY from the SDK barrel — this is the facade under test.
import {
  AcpAgentRunner,
  createAcpRunner,
  WorkflowManager,
  runWorkflow,
  runDynamicWorkflow,
  runIsolation,
  createReplayRunner,
  WorkflowError,
  WorkflowErrorCode,
  isAuthRequired,
  isProviderUsageLimit,
  TypedEventEmitter,
  toJsonSchema,
  AGENTPRISM_PERSISTENCE_ROOT_ENV,
  // §2.10 host-seam re-exports — the durable event read/tail API and shared event contract the
  // facade surfaces so SDK consumers never reach into package internals. Value exports below;
  // the types they pair with are compile-gated in the `import type` block.
  withRunEvents,
  RunEventLogError,
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RUN_EVENT_MAX_RECORD_BYTES,
  RUN_EVENT_LOG_VERSION,
  CALL_PATH_FORMAT,
  CALL_INPUTS_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  RESUME_FALLBACK_REASONS,
  RESUME_DISABLED_REASONS,
  RESUME_CALL_LIVE_REASONS,
  RESUME_CALL_FAILED_REASONS,
} from "../src/index.js";
import type {
  AcpEventContext,
  AcpEventListener,
  AcpEventName,
  AcpRunnerEventMap,
  AcpSessionUpdate,
  AcpUpdateKind,
  AgentEventPayload,
  AgentUsage,
  AgentRunner,
  RunOptions,
  PersistedAgentState,
  PersistedRunState,
  PersistedResumeFormat,
  PersistedResumeCandidate,
  PersistedCheckpointInjection,
  PersistedResumeSeed,
  PreparedResume,
  RunPersistenceOptions,
  WorkflowPathOptions,
  // §4.2 type re-exports — the runner-facing auth surface the SDK facade re-exports.
  // Imported here as a compile-gate: PR6's value export must resolve alongside these
  // (which landed with PR5), and a broken facade re-export chain would fail to type-check.
  AuthResolver,
  AuthContext,
  AuthResolution,
  AuthMethodDescriptor,
  CompleteAuthOptions,
  AuthOutcome,
  AuthController,
  AuthStatusSnapshot,
  AuthCapableRunner,
  AuthErrorContext,
  CheckpointContext,
  JournalCallMetadata,
  WorkflowLogTail,
  WorkflowRunCallStatus,
  WorkflowRunInspectionOptions,
  WorkflowRunStatus,
  WorkflowRunStatusTruncation,
  WorkflowRunResult,
  WorkflowRunFallback,
  WorkflowCheckpointSource,
  WorkflowCheckpointTaken,
  WorkflowAgentEvent,
  WorkflowAgentEventName,
  WorkflowAgentEventPayload,
  WorkflowAgentEventPayloadMap,
  WorkflowRunEvent,
  // §2.10 host-seam type re-exports — the shared live/persisted event unions + projections and the
  // durable read/watch seam types. Compile-gated below so a dropped/renamed facade re-export fails tsc.
  RunEvent,
  EngineRunEvent,
  EngineRunEventName,
  EngineRunEventPayloadMap,
  PersistableEngineRunEvent,
  PersistedRunEvent,
  RunEventLogRecord,
  RunEventValueProjection,
  RunEventErrorProjection,
  RunEventCheckpointProjection,
  PersistedRunAgentEndPayload,
  RunEventPersistence,
  RunEventStream,
  AppendRunEventInput,
  ReadRunEventsOptions,
  ReadRunEventsResult,
  WatchRunEventsOptions,
  RunEventLogErrorCode,
  MockAnswers,
  MockAnswerSequence,
  ValidatedMockAnswerUse,
  ValidatedMockAnswers,
  CheckpointCallContext,
  IsolationRunResult,
  IsolationTarget,
  ReplayCallReport,
  ReplayDivergenceEvent,
  ReplayObservation,
  ReplayReport,
  ReplayRunner,
  ReplayRunnerOptions,
  ResolvedIsolationTarget,
  RunIsolationOptions,
  RunIsolationSdkOptions,
  WorkflowCallRecord,
  WorkflowAgentAttemptControl,
  WorkflowAgentCallCancellation,
  ResumePolicy,
  WorkflowResumeStrategy,
  WorkflowResumeMatch,
  WorkflowResumeFallbackReason,
  WorkflowResumeDisabledReason,
  WorkflowResumeCallLiveReason,
  WorkflowResumeCallFailedReason,
  WorkflowResumeSafety,
  WorkflowCallReplayProvenance,
  WorkflowResumeCallDecision,
  WorkflowResumeReport,
  WorkflowReplayEligibility,
  WorkflowReplayProvenanceField,
  WorkflowReplayProvenanceChange,
  WorkflowRecordedError,
} from "../src/index.js";
import { __setDefaultRunnerFactoryForTests } from "../src/isolation.js";

type IsolationTypeSurface = [
  CheckpointCallContext,
  IsolationRunResult,
  IsolationTarget,
  ReplayCallReport,
  ReplayDivergenceEvent,
  ReplayObservation,
  ReplayReport,
  ReplayRunner,
  ReplayRunnerOptions,
  ResolvedIsolationTarget,
  RunIsolationOptions,
  RunIsolationSdkOptions,
  WorkflowCallRecord,
  WorkflowRecordedError,
];

type AgentCancellationTypeSurface = [
  WorkflowAgentAttemptControl,
  WorkflowAgentCallCancellation,
];
void (undefined as unknown as AgentCancellationTypeSurface);

// §2.10 host-seam TYPE surface: each name must resolve through the facade barrel or `tsc -p
// tsconfig.test.json` (spawned below) fails. Covers the shared live/persisted event unions +
// projections and the durable read/watch seam types.
type RunEventSeamSurface = [
  RunEvent,
  EngineRunEvent,
  EngineRunEventName,
  EngineRunEventPayloadMap,
  PersistableEngineRunEvent,
  PersistedRunEvent,
  RunEventLogRecord,
  RunEventValueProjection,
  RunEventErrorProjection,
  RunEventCheckpointProjection,
  PersistedRunAgentEndPayload,
  RunEventPersistence,
  RunEventStream,
  AppendRunEventInput,
  ReadRunEventsOptions,
  ReadRunEventsResult,
  WatchRunEventsOptions,
  RunEventLogErrorCode,
];
void (undefined as unknown as RunEventSeamSurface);

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;

type _SessionUpdateExcluded = Assert<IsNever<Extract<WorkflowAgentEventName, "session_update">>>;
type _AgentEventNamesComplete = Assert<IsNever<Exclude<Exclude<AcpEventName, "session_update">, WorkflowAgentEventName>>>;
type _AgentEventNamesExact = Assert<IsNever<Exclude<WorkflowAgentEventName, Exclude<AcpEventName, "session_update">>>>;
type _SpecializedRunEvent = Assert<WorkflowAgentEvent extends Extract<WorkflowRunEvent, { type: "agentEvent" }> ? true : false>;
type _PayloadMapKeys = Assert<IsNever<Exclude<WorkflowAgentEventName, keyof WorkflowAgentEventPayloadMap>>>;
type _CompatibilityCatchAll = Assert<AgentEventPayload<"session_update"> extends { name: "session_update" } ? true : false>;
type _CompatibilityDefault = Assert<AgentEventPayload extends AgentEventPayload<AcpEventName> ? true : false>;
type _CompatibilityCallIndex = Assert<"callIndex" extends keyof AgentEventPayload<"session_update"> ? true : false>;
type AgentMessageEnvelopeKeys = Exclude<
  keyof WorkflowAgentEventPayload<"agent_message_chunk">,
  "name" | "event"
>;
type _AgentMessageEnvelopeComplete = Assert<
  IsNever<
    Exclude<
      "backendId" | "sessionId" | "label" | "runId" | "scope" | "callIndex",
      AgentMessageEnvelopeKeys
    >
  >
>;

function managerAgentEventOverloadFixture(
  manager: WorkflowManager,
  payload: WorkflowAgentEventPayload,
): void {
  const listener = (event: WorkflowAgentEventPayload) => {
    if (event.name === "agent_message_chunk") {
      const update: AcpRunnerEventMap["agent_message_chunk"] = event.event;
      void update.content;
    }
  };
  manager.addListener("agentEvent", listener);
  manager.on("agentEvent", listener);
  manager.once("agentEvent", listener);
  manager.removeListener("agentEvent", listener);
  manager.off("agentEvent", listener);
  manager.emit("agentEvent", payload);
  manager.on("host-defined-event", () => {});
}
void managerAgentEventOverloadFixture;
void (undefined as unknown as IsolationTypeSurface);

type IncrementalResumeSurface = [
  PersistedResumeFormat,
  PersistedResumeCandidate,
  PersistedCheckpointInjection,
  PersistedResumeSeed,
  PreparedResume,
  ResumePolicy,
  WorkflowResumeStrategy,
  WorkflowResumeMatch,
  WorkflowResumeFallbackReason,
  WorkflowResumeDisabledReason,
  WorkflowResumeCallLiveReason,
  WorkflowResumeCallFailedReason,
  WorkflowResumeSafety,
  WorkflowCallReplayProvenance,
  WorkflowResumeCallDecision,
  WorkflowResumeReport,
  WorkflowReplayEligibility,
  WorkflowReplayProvenanceField,
  WorkflowReplayProvenanceChange,
];
void (undefined as unknown as IncrementalResumeSurface);

test("incremental resume constants are re-exported by the SDK facade", () => {
  assert.equal(CALL_PATH_FORMAT, 1);
  assert.equal(CALL_INPUTS_FORMAT, 2);
  assert.equal(CHECKPOINT_INPUTS_FORMAT, 1);
  assert.deepEqual(RESUME_FALLBACK_REASONS, [
    "legacy-recording",
    "crash-residue",
    "inputs-format-legacy",
    "forced-positional",
    "unsafe-recording",
    "nested-workflows",
    "legacy-resume",
  ]);
  assert.equal(RESUME_DISABLED_REASONS.length, 12);
  assert.equal(RESUME_CALL_LIVE_REASONS.length, 14);
  assert.deepEqual(RESUME_CALL_FAILED_REASONS, [
    "seed-persistence-error",
    "resume-fatal-latch",
  ]);
});

const mockAnswerSequence: MockAnswerSequence = { $sequence: [{ ok: false }, { ok: true }] };
const mockAnswers: MockAnswers = { "quality:*": mockAnswerSequence };
const validatedMockAnswerUse: ValidatedMockAnswerUse = {
  glob: "quality:*",
  sequenceIndex: 0,
  sequenceLength: 2,
};
const validatedMockAnswers: ValidatedMockAnswers = {
  rules: [{ glob: "quality:*", kind: "sequence", matchingCalls: 1, consumedCalls: 1, sequenceLength: 2 }],
  unused: [{ glob: "quality:*", sequenceIndex: 1, reason: "not-reached" }],
};
void mockAnswers;
void validatedMockAnswerUse;
void validatedMockAnswers;

type EqualTypes<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type AssertType<T extends true> = T;

async function gateInferenceProbe(): Promise<void> {
  const outcome = await gate(
    () => ({ branch: "issue-131", tests: 148 }),
    (value) => ({ ok: true, commitSha: `${value.branch}-${value.tests}` }),
  );
  const commitSha: string | undefined = outcome.verdict?.commitSha;
  const producer: { branch: string; tests: number } = outcome.value;

  const booleanValidator = (_value: number): boolean => true;
  const booleanOutcome = await gate(() => 1, booleanValidator);
  type BooleanVerdictInference = AssertType<EqualTypes<typeof booleanOutcome.verdict, boolean | null>>;
  const booleanVerdictInference: BooleanVerdictInference = true;

  void commitSha;
  void producer;
  void booleanVerdictInference;
}
void gateInferenceProbe;

/**
 * Build an AgentRunner test double from a plain implementation. The seam's run() is
 * generic over the optional typebox schema; this stub is schema-less and returns raw
 * text, bridged to the generic interface with a single `as AgentRunner` (never `as any`),
 * exactly as the mcp-server harness does.
 */
function makeRunner(impl: (prompt: string, options: RunOptions) => unknown | Promise<unknown>): AgentRunner {
  const run = async (prompt: string, options?: RunOptions): Promise<unknown> => impl(prompt, options ?? {});
  return { run } as AgentRunner;
}

/** A runner that echoes a deterministic, non-empty text reply for every agent() call. */
function okRunner(reply: (prompt: string) => string = (p) => `stub:${p}`): AgentRunner {
  return makeRunner((prompt) => reply(prompt));
}

const ISOLATION_ENVIRONMENT_KEY = "workflows-sdk-isolation-test";

function telemetryRunner(reply: string): AgentRunner {
  return makeRunner((_prompt, options) => {
    options.onModelResolved?.(`${reply}/resolved`);
    options.onUsage?.({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 });
    return reply;
  });
}

async function recordIsolationBaseline(options: {
  backends?: Record<string, { command: string }>;
} = {}): Promise<{ root: string; cwd: string; runId: string }> {
  const root = mkdtempSync(join(tmpdir(), "automatalabs-workflows-isolation-root-"));
  const cwd = mkdtempSync(join(tmpdir(), "automatalabs-workflows-isolation-cwd-"));
  const meta = {
    name: "sdk-isolation-baseline",
    description: "SDK isolation wrapper fixture",
    ...(options.backends === undefined ? {} : { backends: options.backends }),
  };
  const script = [
    `export const meta = ${JSON.stringify(meta)};`,
    'return await agent("baseline prompt", { label: "target", model: "baseline/requested" });',
  ].join("\n");
  const manager = new WorkflowManager({
    cwd,
    persistenceRoot: root,
    environmentKey: ISOLATION_ENVIRONMENT_KEY,
    agent: telemetryRunner("baseline"),
  });
  const run = await manager.runSync(script, undefined, {
    runId: "sdk-isolation-baseline",
    maxAgents: 10,
    tokenBudget: null,
    concurrency: 1,
    agentRetries: 0,
    agentTimeoutMs: null,
    environmentKey: ISOLATION_ENVIRONMENT_KEY,
    scriptBackends: options.backends,
  });
  manager.dispose();
  assert.equal(run.status, "completed");
  return { root, cwd, runId: run.runId };
}

/**
 * AgentRunner test double with the ACP event-bus extension. The manager bridge is intentionally
 * attached to the REAL public seam (`new WorkflowManager({ agent })`), so this fake emits the same
 * bus events an AcpAgentRunner would emit while keeping the workflow fully local and deterministic.
 */
class EventedRunner {
  private readonly events = new TypedEventEmitter<AcpRunnerEventMap>();
  readonly sessionId = "session-1";
  readonly backendId = "claude";
  private readonly waitForRun: (() => Promise<void>) | undefined;
  private readonly failWith: Error | undefined;
  private readonly usage: AgentUsage | undefined;

  constructor(options: { waitForRun?: () => Promise<void>; failWith?: Error; usage?: AgentUsage } = {}) {
    this.waitForRun = options.waitForRun;
    this.failWith = options.failWith;
    this.usage = options.usage;
  }

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.events.on(name, listener);
  }

  listenerCount(name: AcpEventName): number {
    return this.events.listenerCount(name);
  }

  emit<K extends AcpEventName>(name: K, event: AcpRunnerEventMap[K]): void {
    this.events.emit(name, event);
  }

  async run(prompt: string, options?: RunOptions): Promise<unknown> {
    const ctx = this.context(options);
    this.emit("session_open", ctx);

    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live" },
    } as AcpRunnerEventMap["session_update"]["update"];
    this.emit("session_update", { ...ctx, update });
    this.emit("agent_message_chunk", { ...ctx, ...update } as AcpRunnerEventMap["agent_message_chunk"]);
    if (this.usage) options?.onUsage?.(this.usage);

    await this.waitForRun?.();
    if (this.failWith) throw this.failWith;
    this.emit("session_close", ctx);
    return `evented:${prompt}`;
  }

  private context(options?: RunOptions): AcpEventContext {
    return {
      sessionId: this.sessionId,
      backendId: this.backendId,
      label: options?.label,
      runId: options?.runId,
      callIndex: options?.callIndex,
    };
  }
}

function eventedAgent(runner: EventedRunner): AgentRunner {
  return runner as unknown as AgentRunner;
}

const ALL_ACP_UPDATE_KINDS = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
] as const satisfies readonly AcpUpdateKind[];
type _AllAcpUpdateKindsComplete = Assert<
  IsNever<Exclude<AcpUpdateKind, (typeof ALL_ACP_UPDATE_KINDS)[number]>>
>;
type ManagerCrossCuttingEventName = Exclude<AcpEventName, AcpUpdateKind | "session_update">;
const ALL_MANAGER_CROSS_CUTTING_NAMES = [
  "permission_pending",
  "permission_request",
  "elicitation_pending",
  "elicitation_request",
  "elicitation_complete",
  "raw_message",
  "session_open",
  "session_close",
  "backend_error",
] as const satisfies readonly ManagerCrossCuttingEventName[];
type _AllManagerCrossCuttingNamesComplete = Assert<
  IsNever<Exclude<ManagerCrossCuttingEventName, (typeof ALL_MANAGER_CROSS_CUTTING_NAMES)[number]>>
>;

const ALL_ACP_SESSION_UPDATES: AcpSessionUpdate[] = [
  { sessionUpdate: "user_message_chunk", content: { type: "text", text: "question" } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
  { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } },
  { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read" },
  { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
  { sessionUpdate: "plan", entries: [] },
  { sessionUpdate: "plan_update", plan: { type: "items", planId: "plan-1", entries: [] } },
  { sessionUpdate: "plan_removed", planId: "plan-1" },
  { sessionUpdate: "available_commands_update", availableCommands: [] },
  { sessionUpdate: "current_mode_update", currentModeId: "default" },
  { sessionUpdate: "config_option_update", configOptions: [] },
  { sessionUpdate: "session_info_update", title: "Session" },
  { sessionUpdate: "usage_update", used: 10, size: 100 },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

/** Valid one-agent script: meta first, exactly one agent() call, returns its result. */
const ONE_AGENT_SCRIPT = [
  'export const meta = { name: "one-agent", description: "a single subagent" };',
  'const r = await agent("hello");',
  "return r;",
].join("\n");

const NO_AGENT_SCRIPT = [
  'export const meta = { name: "no-agent", description: "no subagents" };',
  "return 42;",
].join("\n");

const CHECKPOINT_THEN_AGENT_SCRIPT = [
  'export const meta = { name: "checkpoint-then-agent", description: "pause before one subagent" };',
  'const decision = await checkpoint("q", { headless: "pause" });',
  'const result = await agent("after:" + decision);',
  "return { decision, result };",
].join("\n");

async function createResumableRun(manager: WorkflowManager): Promise<string> {
  const result = await manager.runSync(ONE_AGENT_SCRIPT, undefined, {
    agent: makeRunner(() => {
      throw new WorkflowError("provider usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
      });
    }),
  });
  assert.equal(result.status, "paused", "fixture run should persist a resumable pause");
  return result.runId;
}

async function createCheckpointPausedRun(
  manager: WorkflowManager,
  runner: EventedRunner,
): Promise<{ runId: string; context: CheckpointContext }> {
  const result = await manager.runSync(CHECKPOINT_THEN_AGENT_SCRIPT, undefined, {
    agent: eventedAgent(runner),
  });
  assert.equal(result.status, "paused", "fixture run should pause at the durable checkpoint");
  const context = result.checkpointContext;
  assert.ok(context, "fixture pause should expose checkpoint context");
  return { runId: result.runId, context };
}

test("facade re-exports the public surface", () => {
  assert.equal(typeof createAcpRunner, "function");
  assert.equal(typeof WorkflowManager, "function");
  assert.equal(typeof WorkflowManager.prototype.cancelAgentCall, "function");
  assert.equal(typeof runWorkflow, "function");
  assert.equal(typeof runDynamicWorkflow, "function");
  assert.equal(typeof runIsolation, "function");
  assert.equal(typeof createReplayRunner, "function");
  assert.equal(typeof WorkflowError, "function");
  assert.equal(WorkflowErrorCode.AGENT_CANCELLED, "AGENT_CANCELLED");
  assert.equal(typeof toJsonSchema, "function");
  assert.equal(AGENTPRISM_PERSISTENCE_ROOT_ENV, "AGENTPRISM_PERSISTENCE_ROOT");
  const pathOptions: WorkflowPathOptions = { persistenceRoot: "/tmp/agentprism-workflows-test" };
  const runPersistenceOptions: RunPersistenceOptions = pathOptions;
  const persistedAgent: PersistedAgentState = {
    id: 1,
    label: "persisted-agent",
    prompt: "hello",
    status: "done",
  };
  const persistedRun: PersistedRunState = {
    runId: "persisted-run",
    workflowName: "persisted-workflow",
    script: NO_AGENT_SCRIPT,
    status: "completed",
    phases: [],
    agents: [persistedAgent],
    logs: [],
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  assert.equal(runPersistenceOptions.persistenceRoot, pathOptions.persistenceRoot);
  assert.equal(persistedRun.agents[0], persistedAgent);
  const checkpointContext: CheckpointContext = {
    callIndex: 1,
    hash: "hash",
    prompt: "Continue?",
    kind: "confirm",
  };
  assert.equal(checkpointContext.callIndex, 1);
  const callMetadata: JournalCallMetadata = { kind: "agent", label: "review" };
  const inspectionOptions: WorkflowRunInspectionOptions = { lastN: 1, logLines: 0 };
  const tail: WorkflowLogTail = {
    lines: [],
    totalLines: 0,
    omittedLines: 0,
    truncatedLines: 0,
    redactedLines: 0,
  };
  const callStatus: WorkflowRunCallStatus = {
    index: 0,
    kind: "agent",
    label: "review",
    resultPreview: "true",
    resultRedacted: false,
    resultTruncated: false,
  };
  const truncation: WorkflowRunStatusTruncation = {
    maxStructuredBytes: 24_576,
    byteCapApplied: false,
    phases: { total: 0, returned: 0, shortened: 0 },
    logs: { total: 0, returned: 0, shortened: 0, redacted: 0 },
    calls: { total: 1, matched: 1, returned: 1, shortenedResults: 0, redactedResults: 0 },
  };
  const status: WorkflowRunStatus = {
    runId: "a-b",
    status: "completed",
    workflowName: "review",
    phases: [],
    logTail: tail,
    calls: [callStatus],
    filter: { lastN: inspectionOptions.lastN ?? 20, logLines: inspectionOptions.logLines ?? 20 },
    truncation,
  };
  const checkpointSource: WorkflowCheckpointSource = "injected";
  const fallback: WorkflowRunFallback = {
    callIndex: 0,
    label: "review",
    requestedSpec: "gpt-example[high]",
    kind: "modifier",
    message: "modifier unavailable",
  };
  const checkpointTaken: WorkflowCheckpointTaken = {
    callIndex: 1,
    kind: "confirm",
    decision: true,
    source: checkpointSource,
  };
  assert.equal(callMetadata.label, status.calls[0]?.label);
  assert.equal(fallback.kind, "modifier");
  assert.equal(checkpointTaken.source, "injected");
});

test("facade re-exports the §2.10 durable event read/tail host seam", () => {
  assert.equal(typeof withRunEvents, "function");
  assert.equal(typeof RunEventLogError, "function");
  assert.equal(RUN_EVENT_READ_LIMIT_DEFAULT, 100);
  assert.equal(RUN_EVENT_READ_LIMIT_MAX, 1_000);
  assert.equal(RUN_EVENT_MAX_RECORD_BYTES, 65_536);
  assert.equal(RUN_EVENT_LOG_VERSION, 1);
  // The frozen error taxonomy is carried by the re-exported class; construct one through the facade.
  const code: RunEventLogErrorCode = "CORRUPT_LOG";
  const error = new RunEventLogError("boom", code, { runId: "r" });
  assert.equal(error.name, "RunEventLogError");
  assert.equal(error.code, code);
  // EngineRunEventPayloadMap is the exact type the README typed-manager example imports from
  // "@automatalabs/workflows": a facade consumer selects a payload by event name with no
  // @automatalabs/workflow-engine import. Proving it resolves here compiles that example.
  const logPayload: EngineRunEventPayloadMap["log"] = { runId: "r", scope: "r", message: "hi" };
  assert.equal(logPayload.message, "hi");
});

test("facade WorkflowManager exposes inspectRun and shared status without engine imports", async () => {
  const manager = new WorkflowManager({ agent: okRunner() });
  const result = await manager.runSync(ONE_AGENT_SCRIPT);
  const status: WorkflowRunStatus | undefined = manager.inspectRun(result.runId, { lastN: 1, logLines: 0 });
  assert.equal(status?.status, "completed");
  assert.equal(status?.workflowName, "one-agent");
  assert.equal(status?.calls.length, 1);
  assert.equal(status?.filter.lastN, 1);
  assert.equal(status?.filter.logLines, 0);
});

test("runIsolation defaults to an owned ACP runner and disposes it through the named test seam", async (t) => {
  const fixture = await recordIsolationBaseline();
  let factoryCalls = 0;
  let disposeCalls = 0;
  const fakeDefault = Object.assign(telemetryRunner("candidate"), {
    async dispose() {
      disposeCalls++;
    },
  });
  __setDefaultRunnerFactoryForTests(() => {
    factoryCalls++;
    return fakeDefault;
  });
  t.after(() => {
    __setDefaultRunnerFactoryForTests(undefined);
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.cwd, { recursive: true, force: true });
  });

  const result = await runIsolation({
    baselineRunId: fixture.runId,
    live: [{ label: "target", model: "candidate/requested" }],
    cwd: fixture.cwd,
    persistenceRoot: fixture.root,
    environmentKey: ISOLATION_ENVIRONMENT_KEY,
  });

  assert.equal(result.status, "completed");
  assert.equal(factoryCalls, 1);
  assert.equal(disposeCalls, 1, "the SDK owns and disposes its default runner");
  assert.equal(result.report.calls[0]?.mode, "live-target");
  assert.equal(result.report.calls[0]?.resolvedModel, "candidate/resolved");
});

test("runIsolation applies allowScriptBackends before delegating the recorded script", async (t) => {
  const backends = { browser: { command: "browser-acp" } };
  const fixture = await recordIsolationBaseline({ backends });
  t.after(() => {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.cwd, { recursive: true, force: true });
  });
  let liveCalls = 0;
  let capturedBackends: RunOptions["backends"];
  const runner = makeRunner((_prompt, options) => {
    liveCalls++;
    capturedBackends = options.backends;
    options.onModelResolved?.("candidate/resolved");
    options.onUsage?.({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 });
    return "candidate";
  });

  await assert.rejects(
    runIsolation({
      baselineRunId: fixture.runId,
      live: [{ label: "target", model: "candidate/requested" }],
      runner,
      cwd: fixture.cwd,
      persistenceRoot: fixture.root,
      environmentKey: ISOLATION_ENVIRONMENT_KEY,
    }),
    /allowScriptBackends/,
  );
  assert.equal(liveCalls, 0);

  const approved: string[] = [];
  const result = await runIsolation({
    baselineRunId: fixture.runId,
    live: [{ label: "target", model: "candidate/requested" }],
    runner,
    cwd: fixture.cwd,
    persistenceRoot: fixture.root,
    environmentKey: ISOLATION_ENVIRONMENT_KEY,
    allowScriptBackends: (backend) => {
      approved.push(`${backend.name}:${backend.command}`);
      return true;
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(approved, ["browser:browser-acp"]);
  assert.deepEqual(capturedBackends, backends);
});

// §4.2 SDK exports (PR6). The facade re-exports the `isAuthRequired` VALUE through the
// @automatalabs/workflow-engine chain (threaded in PR1) so a host can classify an
// AUTH_REQUIRED fault with the same one-liner it uses for isProviderUsageLimit — no new
// behavior, just surface. The §4.2 TYPE re-exports (AuthResolver, AuthContext, …) landed
// with PR5; they are compile-gated below so a broken facade chain fails type-checking.
test("facade re-exports isAuthRequired as a value alongside isProviderUsageLimit (§4.2)", () => {
  assert.equal(typeof isAuthRequired, "function");
  assert.equal(typeof isProviderUsageLimit, "function");

  // True ONLY for an AUTH_REQUIRED WorkflowError, and it narrows to WorkflowError so the
  // caller can read `.authContext` (the non-secret structured surface) after the guard.
  const authErr: unknown = new WorkflowError("authentication required", WorkflowErrorCode.AUTH_REQUIRED, {
    authContext: { backendId: "claude", methods: [{ id: "gateway", type: "agent", name: "Gateway" }] },
  });
  assert.equal(isAuthRequired(authErr), true);
  if (isAuthRequired(authErr)) {
    assert.equal(authErr.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.equal(authErr.authContext?.backendId, "claude");
  } else {
    assert.fail("isAuthRequired should narrow the AUTH_REQUIRED WorkflowError");
  }

  // A different WorkflowErrorCode must NOT classify as auth (and must not collide with the
  // sibling usage-limit guard) — the two helpers partition disjoint faults.
  const usageErr = new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  assert.equal(isAuthRequired(usageErr), false);
  assert.equal(isProviderUsageLimit(usageErr), true);
  assert.equal(isProviderUsageLimit(authErr), false);

  // Non-WorkflowError values never classify.
  assert.equal(isAuthRequired(new Error("authentication required")), false);
  assert.equal(isAuthRequired({ code: WorkflowErrorCode.AUTH_REQUIRED }), false);
  assert.equal(isAuthRequired(undefined), false);
  assert.equal(isAuthRequired(null), false);
});

// Compile-gate for the §4.2 runner-facing auth TYPE re-exports (surfaced through the facade
// with PR5). If any re-export were dropped or renamed, referencing it here fails `tsc` — and
// the spawned "tsc type-checks this suite" test below is what makes that bite: the build
// tsconfig is src-only and tsx strips types, so without it a broken re-export would still
// pass the suite. The runtime assertions here are trivially true — the value is the type
// wiring compiling at all.
test("facade re-exports the §4.2 runner-facing auth types", () => {
  const descriptor: AuthMethodDescriptor = {
    type: "env_var",
    id: "openai",
    name: "OpenAI",
    vars: [{ name: "OPENAI_API_KEY", secret: true, optional: false }],
  };
  const resolution: AuthResolution = { outcome: "env", values: { OPENAI_API_KEY: "sk-x" }, methodId: "openai" };
  const context: AuthContext = { backendId: "claude", methods: [descriptor], cause: "proactive" };
  const completeOpts: CompleteAuthOptions = { methodId: "openai", resolution };
  const outcome: AuthOutcome = { status: "authenticated", methodId: "openai", recycled: false };
  const errorContext: AuthErrorContext = { methods: [{ id: "openai", type: "env_var" }] };
  const snapshot: AuthStatusSnapshot = {
    backendId: "claude",
    poolKey: "claude",
    state: "unauthenticated",
    authenticated: false,
    canResume: false,
    methods: [{ id: "openai", type: "env_var", name: "OpenAI" }],
  };
  // Function/interface typedefs referenced purely as compile-gates through the facade barrel.
  const resolver: AuthResolver = async () => resolution;
  const controller: AuthController | undefined = undefined;
  const capable: AuthCapableRunner | undefined = undefined;

  assert.equal(descriptor.type, "env_var");
  assert.equal(resolution.outcome, "env");
  assert.equal(context.cause, "proactive");
  assert.equal(completeOpts.methodId, "openai");
  assert.equal(outcome.status, "authenticated");
  assert.equal(errorContext.methods[0]?.type, "env_var");
  assert.equal(snapshot.state, "unauthenticated");
  assert.equal(typeof resolver, "function");
  assert.equal(controller, undefined);
  assert.equal(capable, undefined);
});

test("createAcpRunner exposes a typed ACP event bus (on/once/off/listenerCount) via the barrel", async () => {
  const runner = createAcpRunner();
  try {
    const seen: string[] = [];
    // Typed listener: `e` is the agent_message_chunk variant + context — compile-gated through
    // the SDK barrel. The payload is assignable to AcpEventContext, proving the envelope is carried.
    const off = runner.on("agent_message_chunk", (e: AcpRunnerEventMap["agent_message_chunk"]) => {
      if (e.content.type === "text") seen.push(e.content.text);
      const ctx: AcpEventContext = e;
      void ctx;
    });
    assert.equal(typeof off, "function", "on() returns an unsubscribe thunk");
    assert.equal(runner.listenerCount("agent_message_chunk"), 1);

    const toolListener = (e: AcpRunnerEventMap["tool_call"]) => void e.title;
    runner.on("tool_call", toolListener);
    assert.equal(runner.listenerCount("tool_call"), 1);

    off();
    assert.equal(runner.listenerCount("agent_message_chunk"), 0, "disposer unsubscribed");
    runner.off("tool_call", toolListener);
    assert.equal(runner.listenerCount("tool_call"), 0);

    runner.once("session_update", () => {});
    assert.equal(runner.listenerCount("session_update"), 1);
    runner.removeAllListeners();
    assert.equal(runner.listenerCount("session_update"), 0);
  } finally {
    await runner.dispose();
  }
});

test("RunOptions exposes Codex baseInstructions/developerInstructions through the SDK barrel", () => {
  // Compile-gate: the two additive Codex-only seam fields are typed on RunOptions as re-exported
  // by @automatalabs/workflows, so SDK users get createAcpRunner().run(p, { baseInstructions }).
  const opts: RunOptions = {
    baseInstructions: "You only write Rust.",
    developerInstructions: "Prefer iterators.",
  };
  assert.equal(opts.baseInstructions, "You only write Rust.");
  assert.equal(opts.developerInstructions, "Prefer iterators.");
});

test("runDynamicWorkflow runs a 1-agent script through a stub runner", async () => {
  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner: okRunner() });

  assert.equal(result.status, "completed");
  assert.equal(result.meta.name, "one-agent");
  assert.equal(result.agentCount, 1);
  // The stub echoes `stub:<prompt>`; the script returns the single agent() result verbatim.
  assert.equal(result.result, "stub:hello");
});

test("runDynamicWorkflow disposes the ACP runner it creates internally", async (t) => {
  const originalDispose = AcpAgentRunner.prototype.dispose;
  const dispose = t.mock.method(AcpAgentRunner.prototype, "dispose", function (this: AcpAgentRunner) {
    return originalDispose.call(this);
  });

  const result = await runDynamicWorkflow(NO_AGENT_SCRIPT);

  assert.equal(result.status, "completed");
  assert.equal(result.result, 42);
  assert.equal(dispose.mock.callCount(), 1, "owned default runner should be disposed after the run");
});

test("runDynamicWorkflow does not dispose a caller-supplied runner", async () => {
  let disposeCalls = 0;
  const runner = Object.assign(okRunner(), {
    async dispose() {
      disposeCalls++;
    },
  });

  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner });

  assert.equal(result.status, "completed");
  assert.equal(disposeCalls, 0, "caller retains ownership of an injected runner");
});

test("runDynamicWorkflow threads opts.cwd through to every agent session", async () => {
  const runCwd = tmpdir();
  let captured: string | undefined;
  const capturing = makeRunner((_prompt, options) => {
    captured = options.cwd;
    return "ok";
  });

  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner: capturing, cwd: runCwd });

  assert.equal(result.status, "completed");
  assert.equal(captured, runCwd);
});

test("runDynamicWorkflow detaches its one-off manager agentEvent bridge", async () => {
  const runner = new EventedRunner();
  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner: eventedAgent(runner) });

  assert.equal(result.status, "completed");
  assert.equal(runner.listenerCount("session_update"), 0);
  assert.equal(runner.listenerCount("session_open"), 0);
});

test("WorkflowManager.runSync runs the same script with an injected stub runner", async () => {
  const manager = new WorkflowManager({ agent: okRunner((p) => `mgr:${p}`) });
  const result = await manager.runSync(ONE_AGENT_SCRIPT);

  assert.equal(result.status, "completed");
  assert.equal(result.result, "mgr:hello");
});

test("WorkflowManager forwards injected runner live ACP events as agentEvent", async () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager({ agent: eventedAgent(runner) });
  const order: string[] = [];
  const events: AgentEventPayload[] = [];

  manager.on("agentStart", () => order.push("agentStart"));
  manager.on("agentEvent", (event: AgentEventPayload) => {
    order.push(`agentEvent:${event.name}`);
    events.push(event);
  });
  manager.on("agentEnd", () => order.push("agentEnd"));

  const script = [
    'export const meta = { name: "live-agent", description: "live stream" };',
    'const r = await agent("hello", { label: "live-label" });',
    "return r;",
  ].join("\n");
  const result = await manager.runSync(script);

  assert.equal(result.status, "completed");
  assert.equal(result.result, "evented:hello");
  assert.deepEqual(order, [
    "agentStart",
    "agentEvent:session_open",
    "agentEvent:agent_message_chunk",
    "agentEvent:session_close",
    "agentEnd",
  ]);

  const chunk = events.find((event): event is AgentEventPayload<"agent_message_chunk"> => {
    return event.name === "agent_message_chunk";
  });
  assert.ok(chunk, "session_update catch-all should forward once as the inner discriminant");
  assert.equal(chunk.runId, result.runId);
  assert.equal(chunk.scope, result.runId);
  assert.equal(chunk.callIndex, 0);
  assert.equal(chunk.label, "live-label");
  assert.equal(chunk.sessionId, runner.sessionId);
  assert.equal(chunk.backendId, runner.backendId);
  assert.equal(chunk.event.content.type, "text");
  assert.equal(chunk.event.callIndex, 0);
  assert.equal(chunk.event.content.type === "text" ? chunk.event.content.text : "", "live");
  assert.equal(runner.listenerCount("session_update"), 1, "constructor bridge survives run settlement");
  manager.dispose();
  assert.equal(runner.listenerCount("session_update"), 0, "dispose removes constructor bridge");
});

/**
 * A runner that BOTH streams live ACP traffic (bridged to `agentEvent`) and reports agent
 * history (bridged to `agentHistory`). §2.6 fixes both as relay-only: neither may enter the
 * durable `<runId>.events.jsonl` sidecar regardless of any host subscription.
 */
class LiveStreamAndHistoryRunner {
  private readonly bus = new TypedEventEmitter<AcpRunnerEventMap>();
  readonly sessionId = "history-session";
  readonly backendId = "claude";

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.bus.on(name, listener);
  }

  async run(prompt: string, options?: RunOptions): Promise<unknown> {
    const ctx: AcpEventContext = {
      sessionId: this.sessionId,
      backendId: this.backendId,
      label: options?.label,
      runId: options?.runId,
      callIndex: options?.callIndex,
    };
    this.bus.emit("session_open", ctx);
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "streamed" },
    } as AcpRunnerEventMap["session_update"]["update"];
    this.bus.emit("session_update", { ...ctx, update });
    options?.onHistory?.([{ role: "assistant", kind: "text", text: "captured turn" }]);
    this.bus.emit("session_close", ctx);
    return `streamed:${prompt}`;
  }
}

test("the durable event log never persists agentEvent or agentHistory traffic (§2.6)", async () => {
  const runner = new LiveStreamAndHistoryRunner();
  const manager = new WorkflowManager({ agent: runner as unknown as AgentRunner });
  const liveAgentEvents: string[] = [];
  let liveHistory = 0;
  manager.on("agentEvent", (event: AgentEventPayload) => liveAgentEvents.push(event.name));
  manager.on("agentHistory", () => {
    liveHistory++;
  });

  const result = await manager.runSync(ONE_AGENT_SCRIPT);
  manager.dispose();

  assert.equal(result.status, "completed");
  assert.equal(result.result, "streamed:hello");
  // The live bridges must actually have fired, or the persistence assertion is vacuous.
  assert.ok(liveAgentEvents.length > 0, "runner must emit live agentEvent traffic");
  assert.ok(liveHistory > 0, "runner must emit live agentHistory traffic");

  // Scan the run's structured sidecar directly (not via readEvents) per the §5 test plan.
  const sidecar = join(manager.getPersistence().getRunsDir(), `${result.runId}.events.jsonl`);
  assert.equal(existsSync(sidecar), true, "a journaling run writes the event sidecar");
  const lines = readFileSync(sidecar, "utf8").split("\n").filter((line) => line.length > 0);
  assert.ok(lines.length > 0, "the sidecar holds the persisted lifecycle events");
  // `.type` is the persisted-only union (agentEvent/agentHistory are absent from it by
  // construction — the type system already forbids them); widen to string so the runtime scan
  // can still search for the forbidden relay names.
  const types: string[] = lines.map((line) => (JSON.parse(line) as RunEventLogRecord).event.type);
  assert.equal(types.includes("agentEvent"), false, "agentEvent is relay-only, never persisted");
  assert.equal(types.includes("agentHistory"), false, "agentHistory is relay-only, never persisted");
  // Positive control: the durable lifecycle events ARE present, so the scan is meaningful.
  assert.ok(
    types.includes("agentStart") && types.includes("agentEnd") && types.includes("complete"),
    "the durable lifecycle events are persisted",
  );
});

test("WorkflowManager agentEvent union exactly covers every bridged ACP event", () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager({ agent: eventedAgent(runner) });
  const events: WorkflowAgentEventPayload[] = [];
  const context: AcpEventContext = {
    sessionId: "session-exact",
    backendId: "claude",
    label: "exact",
    runId: "run-exact",
    callIndex: 41,
  };
  manager.on("agentEvent", (event) => events.push(event));

  for (const update of ALL_ACP_SESSION_UPDATES) {
    runner.emit("session_update", { ...context, update });
  }
  const crossCuttingEvents: Array<[ManagerCrossCuttingEventName, unknown]> = [
    ["permission_pending", { ...context, request: {} }],
    ["permission_request", { ...context, request: {}, outcome: {} }],
    ["elicitation_pending", { ...context, request: {} }],
    ["elicitation_request", { ...context, request: {}, outcome: {} }],
    ["elicitation_complete", { ...context, notification: {} }],
    ["raw_message", { ...context, method: "vendor/message", message: {} }],
    ["session_open", context],
    ["session_close", context],
    ["backend_error", { backendId: "claude", error: new Error("backend failed") }],
  ];
  for (const [name, event] of crossCuttingEvents) runner.emit(name, event as never);

  const expectedNames = [...ALL_ACP_UPDATE_KINDS, ...ALL_MANAGER_CROSS_CUTTING_NAMES];
  assert.deepEqual(events.map((event) => event.name), expectedNames);
  assert.equal(events.some((event) => event.name === ("session_update" as WorkflowAgentEventName)), false);
  for (const event of events) {
    if (event.name === "backend_error") {
      assert.equal("sessionId" in event, false);
      assert.equal("runId" in event, false);
      assert.equal("scope" in event, false);
      assert.equal("callIndex" in event, false);
      continue;
    }
    assert.equal(event.sessionId, context.sessionId);
    assert.equal(event.runId, context.runId);
    assert.equal(event.scope, context.runId);
    assert.equal(event.callIndex, context.callIndex);
    assert.equal(event.event.callIndex, context.callIndex);
  }
  manager.dispose();
});

test("WorkflowManager removes exec runner bridge after runSync settles", async () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager();

  const result = await manager.runSync(ONE_AGENT_SCRIPT, undefined, { agent: eventedAgent(runner) });

  assert.equal(result.status, "completed");
  assert.equal(runner.listenerCount("session_update"), 0);
  assert.equal(runner.listenerCount("session_open"), 0);
});

test("WorkflowManager.startInBackground preserves its public handle, live usage, ACP bridge, and replay prefix", async () => {
  const script = [
    'export const meta = { name: "facade-background", description: "facade background" };',
    'const values = [];',
    'for (let i = 0; i < args.count; i++) values.push(await agent(`call-${i}`, { label: `call-${i}` }));',
    'if (args.pause) await checkpoint("continue?", { headless: "pause" });',
    "return values;",
  ].join("\n");
  const manager = new WorkflowManager({ agent: okRunner() });
  const source = await manager.runSync(script, { count: 1, pause: false });
  const prefix = manager.getPersistence().load(source.runId)?.journal ?? [];
  assert.deepEqual(prefix.map((entry) => entry.index), [0]);

  const gates: Array<ReturnType<typeof deferred>> = [];
  const runner = new EventedRunner({
    waitForRun: () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
    usage: { input: 5, output: 4, total: 9, cost: 0.09, cacheRead: 1, cacheWrite: 0 },
  });
  const usageEvents: number[] = [];
  manager.on("tokenUsage", (event: { usage: { total: number } }) => usageEvents.push(event.usage.total));
  const started: { runId: string; promise: Promise<WorkflowRunResult> } = manager.startInBackground(
    script,
    { count: 3, pause: true },
    {
      agent: eventedAgent(runner),
      resumeJournal: new Map(prefix.map((entry) => [entry.index, entry] as const)),
    },
  );
  assert.deepEqual(manager.getPersistence().load(started.runId)?.journal?.map((entry) => entry.index), [0]);
  await waitUntil(() => gates.length === 1, "the first live suffix call should reach the ACP runner");
  assert.equal(runner.listenerCount("session_update"), 1, "the facade bridge stays installed while background work runs");

  gates[0]?.resolve();
  await waitUntil(() => gates.length === 2, "the second live suffix call should remain blocked");
  assert.deepEqual(usageEvents, [9]);
  assert.equal(manager.getSnapshot(started.runId)?.tokenUsage?.total, 9);
  assert.deepEqual(manager.getPersistence().load(started.runId)?.journal?.map((entry) => entry.index), [0, 1]);
  assert.equal(runner.listenerCount("session_update"), 1);

  gates[1]?.resolve();
  await assert.rejects(started.promise, (error: unknown) => {
    return error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED;
  });
  assert.deepEqual(usageEvents, [9, 18]);
  assert.equal(manager.getSnapshot(started.runId)?.tokenUsage?.total, 18);
  assert.deepEqual(manager.getPersistence().load(started.runId)?.journal?.map((entry) => entry.index), [0, 1, 2]);
  assert.equal(runner.listenerCount("session_update"), 0, "the facade releases its bridge when the promise rejects");
});

test("WorkflowManager keeps a shared exec runner bridge until concurrent runs settle", async () => {
  const gates: Array<ReturnType<typeof deferred>> = [];
  const runner = new EventedRunner({
    waitForRun: () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  const agent = eventedAgent(runner);
  const manager = new WorkflowManager();

  const first = manager.runSync(ONE_AGENT_SCRIPT, undefined, { agent });
  const second = manager.runSync(ONE_AGENT_SCRIPT, undefined, { agent });
  await waitUntil(() => gates.length === 2, "both concurrent runs should reach the runner");

  assert.equal(runner.listenerCount("session_update"), 1, "shared runner is subscribed once");
  assert.equal(runner.listenerCount("session_open"), 1);

  gates[0]?.resolve();
  assert.equal((await first).status, "completed");
  assert.equal(runner.listenerCount("session_update"), 1, "bridge remains until the second run settles");

  gates[1]?.resolve();
  assert.equal((await second).status, "completed");
  assert.equal(runner.listenerCount("session_update"), 0, "bridge is removed after the final release");
  assert.equal(runner.listenerCount("session_open"), 0);
});

test("WorkflowManager.resume keeps the exec runner bridge until the resumed run settles", async () => {
  const manager = new WorkflowManager();
  const runId = await createResumableRun(manager);
  const gate = deferred();
  const runner = new EventedRunner({ waitForRun: () => gate.promise });
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const accepted = await manager.resume(runId, { agent: eventedAgent(runner) });
  assert.equal(accepted, true);
  assert.equal(runner.listenerCount("session_update"), 1, "bridge remains after resume is accepted");
  assert.equal(runner.listenerCount("session_open"), 1);

  runner.emit("session_open", {
    sessionId: "after-resume-return",
    backendId: runner.backendId,
    runId,
  });
  assert.equal(
    seen.filter((event) => event.name === "session_open" && event.sessionId === "after-resume-return").length,
    1,
    "events emitted after resume returns are still forwarded",
  );

  gate.resolve();
  await waitUntil(() => manager.getRun(runId)?.status === "completed", "resumed run should complete");
  await waitUntil(
    () => runner.listenerCount("session_update") === 0 && runner.listenerCount("session_open") === 0,
    "bridge should release after the resumed run settles",
  );

  const forwardedBeforePostSettlementEvent = seen.length;
  runner.emit("session_open", {
    sessionId: "after-resume-settlement",
    backendId: runner.backendId,
    runId,
  });
  assert.equal(seen.length, forwardedBeforePostSettlementEvent, "settled resume no longer forwards runner events");
});

test("WorkflowManager.resume releases the exec runner bridge when a durable checkpoint re-pauses", async () => {
  const manager = new WorkflowManager();
  const runner = new EventedRunner();
  const { runId } = await createCheckpointPausedRun(manager, runner);
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));
  assert.equal(runner.listenerCount("session_update"), 0, "the fixture run released its exec bridge");
  assert.equal(runner.listenerCount("session_open"), 0);

  const accepted = await manager.resume(runId, { agent: eventedAgent(runner) });

  assert.equal(accepted, true, "the reply-less checkpoint resume is accepted and re-pauses");
  await waitUntil(
    () => runner.listenerCount("session_update") === 0 && runner.listenerCount("session_open") === 0,
    "the bridge should release after the re-pause rejection settles",
  );
  assert.equal(manager.getRun(runId)?.status, "paused");

  const forwardedBeforePostSettlementEvent = seen.length;
  runner.emit("session_open", { sessionId: "after-re-pause", backendId: runner.backendId, runId });
  assert.equal(
    seen.length,
    forwardedBeforePostSettlementEvent,
    "runner events are not forwarded after the re-pause settles",
  );
});

test("WorkflowManager.resume releases the exec runner bridge when the resumed run fails", async () => {
  const manager = new WorkflowManager();
  manager.on("error", () => {});
  const runner = new EventedRunner({
    failWith: new WorkflowError("resumed runner failed", WorkflowErrorCode.SCRIPT_ERROR, {
      recoverable: false,
    }),
  });
  const { runId, context } = await createCheckpointPausedRun(manager, runner);
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const accepted = await manager.resume(runId, {
    agent: eventedAgent(runner),
    checkpointReplies: { [context.callIndex]: "continue" },
  });

  assert.equal(accepted, true);
  await waitUntil(() => manager.getRun(runId)?.status === "failed", "resumed run should fail");
  await waitUntil(
    () => runner.listenerCount("session_update") === 0 && runner.listenerCount("session_open") === 0,
    "the bridge should release after the failed resume settles",
  );
  assert.equal(manager.getRun(runId)?.error?.code, WorkflowErrorCode.SCRIPT_ERROR);

  const forwardedBeforePostSettlementEvent = seen.length;
  runner.emit("session_open", { sessionId: "after-failed-resume", backendId: runner.backendId, runId });
  assert.equal(
    seen.length,
    forwardedBeforePostSettlementEvent,
    "runner events are not forwarded after the failed resume settles",
  );
});

test("WorkflowManager.resume releases the exec runner bridge when the resumed run is stopped", async () => {
  const manager = new WorkflowManager();
  manager.on("error", () => {});
  const gate = deferred();
  let gateEntered = false;
  const runner = new EventedRunner({
    waitForRun: () => {
      gateEntered = true;
      return gate.promise;
    },
  });
  const { runId, context } = await createCheckpointPausedRun(manager, runner);
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const accepted = await manager.resume(runId, {
    agent: eventedAgent(runner),
    checkpointReplies: { [context.callIndex]: "continue" },
  });
  assert.equal(accepted, true);
  await waitUntil(() => gateEntered, "the resumed agent should block on its gate");
  assert.equal(runner.listenerCount("session_update"), 1, "the live resume retains its bridge");
  assert.equal(runner.listenerCount("session_open"), 1);

  assert.equal(manager.stop(runId), true);
  assert.equal(manager.getRun(runId)?.status, "aborted");
  assert.equal(runner.listenerCount("session_update"), 1, "the in-flight runner still owns the bridge");
  gate.resolve();

  await waitUntil(
    () => manager.getRun(runId)?.error?.code === WorkflowErrorCode.WORKFLOW_ABORTED,
    "the stopped resumed execution should settle as aborted",
  );
  await waitUntil(
    () => runner.listenerCount("session_update") === 0 && runner.listenerCount("session_open") === 0,
    "the bridge should release after the stopped resume settles",
  );

  const forwardedBeforePostSettlementEvent = seen.length;
  runner.emit("session_open", { sessionId: "after-stopped-resume", backendId: runner.backendId, runId });
  assert.equal(
    seen.length,
    forwardedBeforePostSettlementEvent,
    "runner events are not forwarded after the stopped resume settles",
  );
});

test("WorkflowManager.resume releases an exec runner bridge immediately when resume is rejected", async () => {
  const manager = new WorkflowManager();
  const runner = new EventedRunner();
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const accepted = await manager.resume("unknown-run-id", { agent: eventedAgent(runner) });

  assert.equal(accepted, false);
  assert.equal(runner.listenerCount("session_update"), 0);
  assert.equal(runner.listenerCount("session_open"), 0);
  runner.emit("session_open", { sessionId: "rejected", backendId: runner.backendId });
  assert.deepEqual(seen, [], "a rejected resume leaves no forwarding subscription behind");
});

test("WorkflowManager.resumeInBackground shares one bridge across overlapping resumes and releases every ref", async () => {
  const manager = new WorkflowManager();
  const firstRunId = await createResumableRun(manager);
  const secondRunId = await createResumableRun(manager);
  const gates: Array<ReturnType<typeof deferred>> = [];
  const runner = new EventedRunner({
    waitForRun: () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  const agent = eventedAgent(runner);
  const seen: AgentEventPayload[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event));

  const first = await manager.resumeInBackground(firstRunId, { agent });
  if (!first.accepted) assert.fail("first paused run should resume");
  await waitUntil(() => gates.length === 1, "first resume should reach the runner");

  const duplicate = await manager.resumeInBackground(firstRunId, { agent });
  assert.deepEqual(duplicate, { accepted: false }, "an already-running resume is rejected");
  assert.equal(runner.listenerCount("session_update"), 1, "rejected overlap releases only its own ref");

  const second = await manager.resumeInBackground(secondRunId, { agent });
  if (!second.accepted) assert.fail("second paused run should resume");
  await waitUntil(() => gates.length === 2, "second resume should reach the runner");

  assert.equal(runner.listenerCount("session_update"), 1, "shared runner is subscribed once");
  assert.equal(runner.listenerCount("session_open"), 1);
  runner.emit("session_open", {
    sessionId: "overlapping-resumes",
    backendId: runner.backendId,
  });
  assert.equal(
    seen.filter((event) => event.name === "session_open" && event.sessionId === "overlapping-resumes").length,
    1,
    "one runner emission is forwarded exactly once during overlap",
  );

  gates[0]?.resolve();
  assert.equal((await first.promise).status, "completed");
  assert.equal(runner.listenerCount("session_update"), 1, "second accepted resume retains the shared bridge");

  gates[1]?.resolve();
  assert.equal((await second.promise).status, "completed");
  assert.equal(runner.listenerCount("session_update"), 0, "final settlement returns to the listener baseline");
  assert.equal(runner.listenerCount("session_open"), 0);
});

test("WorkflowManager agentEvent bridge unsubscribes on dispose", () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager({ agent: eventedAgent(runner) });
  const seen: string[] = [];
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event.name));

  assert.equal(runner.listenerCount("session_update"), 1);
  assert.equal(runner.listenerCount("session_open"), 1);

  manager.dispose();
  assert.equal(runner.listenerCount("session_update"), 0);
  assert.equal(runner.listenerCount("session_open"), 0);

  runner.emit("session_open", { sessionId: "after", backendId: "claude" });
  assert.deepEqual(seen, []);
});

test("WorkflowManager isolates throwing agentEvent listeners from sibling observers", () => {
  const runner = new EventedRunner();
  const manager = new WorkflowManager({ agent: eventedAgent(runner) });
  const seen: string[] = [];

  manager.on("agentEvent", () => {
    throw new Error("host listener failed");
  });
  manager.on("agentEvent", (event: AgentEventPayload) => seen.push(event.name));

  assert.doesNotThrow(() => {
    runner.emit("session_open", { sessionId: "session-throw", backendId: "claude", label: "l", runId: "r" });
  });
  assert.deepEqual(seen, ["session_open"]);
});

// The gate behind every compile-gate above: actually type-check this suite. The build
// tsconfig.json is src-only and tsx never type-checks, so this spawned `tsc -p
// tsconfig.test.json` is the ONLY thing that makes a dropped/renamed facade re-export fail
// `pnpm test` (locally and in CI's `pnpm -r test`).
test("tsc type-checks the test suite (tsconfig.test.json) so the facade compile-gates are real", () => {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/lib/tsc.js");
  const pkgDir = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, [tsc, "-p", join(pkgDir, "tsconfig.test.json"), "--noEmit"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `tsc found type errors:\n${result.stdout}${result.stderr}`);
});
