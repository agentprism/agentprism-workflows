# Run Events: Typed Contract and Durable Per-Run Log

**Date:** 2026-07-15

> **Current MCP action name:** references below to the historical `await` action describe the
> event-tail behavior now used by `action:"status"` when `waitMs` is positive. See
> [`workflow-status-action.md`](workflow-status-action.md).

**References:** `packages/shared-types/src/workflow-result.ts`,
`packages/workflow-engine/src/workflow.ts`,
`packages/workflow-engine/src/workflow-manager.ts`,
`packages/workflow-engine/src/run-persistence.ts`,
`packages/workflow-engine/src/logger.ts`,
`packages/workflow-engine/src/recorded-error.ts`,
`packages/workflow-engine/src/isolation.ts`,
`packages/workflow-engine/src/run-observability.ts`,
`packages/acp-agents/src/events.ts`,
`packages/acp-agents/src/acp-client.ts`,
`packages/acp-agents/src/runner.ts`,
`packages/workflows/src/index.ts`,
`packages/agentprism-otel/src/attach.ts`,
`packages/agentprism-otel/src/types.ts`,
`packages/mcp-server/src/server.ts`,
`packages/mcp-server/src/progress.ts`, and `docs/roadmap/run-events.md`

## 1. Problem

`WorkflowManager` in `packages/workflow-engine/src/workflow-manager.ts` extends Node's
`EventEmitter`. It emits `log`, `phase`, `agentStart`, `agentEnd`, `agentHistory`, `tokenUsage`,
`complete`, `journal`, `callRecord`, `paused`, `error`, `stopped`, and `resumed`, but its public
`emit()` override is `(eventName: string | symbol, ...args: unknown[])`. There is no exported map
from those names to their payloads and no exported discriminated union. Consumers therefore either
accept `unknown`/`any` or recreate the payloads. `packages/agentprism-otel/src/types.ts` does the
latter and `attach.ts` casts every event before using it.

The engine callbacks that feed the manager are declared on `WorkflowRunOptions` in
`packages/workflow-engine/src/workflow.ts`: `onLog`, `onPhase`, `onAgentStart`, `onAgentEnd`,
`onAgentHistory`, `onTokenUsage`, `onAgentJournal`, `onFallback`, `onCheckpointTaken`,
`onCallRecord`, `onNestedWorkflow`, and `confirm`. The current manager does **not** emit a distinct
EventEmitter event for every one of those callbacks: fallback and checkpoint observations are
accumulated into the run result/persisted state, and `onNestedWorkflow` sets a run marker. The
contract below freezes the manager event names that actually exist; it does not invent
`fallback`, `checkpointTaken`, or `nestedWorkflow` event names.

The engine already supplies deterministic per-call identity on agent lifecycle events:
`callIndex` and `scope` are present on `onAgentStart`, `onAgentEnd`, and `onAgentHistory`, and the
runner receives `RunOptions.callIndex` plus `RunOptions.runId`. The SDK manager subclass in
`packages/workflows/src/index.ts` also bridges the live `AcpAgentRunner` event bus as
`agentEvent`. Those ACP payloads are typed by `AcpRunnerEventMap` and `AcpEventContext` in
`packages/acp-agents/src/events.ts`, but `AcpEventContext` currently carries only
`sessionId`, `backendId`, `label?`, and `runId?`. Joining a streaming message/thought/tool/usage
update to a particular `agent()` call therefore requires an indirect `sessionId` lookup through
`agentSessions`; the engine's already-known `callIndex` is dropped while the session is prepared.

Manager events exist only in the process that emitted them. The durable run state is a wholesale
atomic rewrite of `<runId>.json` (`PersistedRunState`, temporary file plus rename, with a `.bak`
fallback). The logger writes an unstructured `<runId>.log` (appends during execution and rewrites
its buffered contents in `persist()`). There is no structured, append-only stream that another
process can read, or that a consumer can attach to after a run has started.

That absence is visible at the MCP composition root. Foreground calls optionally translate the
manager's live `onProgress(WorkflowSnapshot)` callback into coarse MCP
`notifications/progress`, and only when the request supplied a `progressToken`. Background starts
return before any request-scoped progress channel can remain active. `action: "await"` uses a
process-local settlement promise when available and otherwise polls `inspectRun()` every 250 ms.

The safety primitives needed for a persisted projection already exist in
`packages/workflow-engine/src/run-observability.ts`: credential-shaped text redaction, sensitive-key
handling, UTF-8 scalar caps, bounded structural compaction, and bounded outward-facing run status.
The missing work is one shared type contract, direct call correlation on ACP events, and a durable
read/tail seam that applies those safety rules before bytes reach disk.

## 2. The contract

### 2.1 Terminology and ownership

- A **live event** is one observation delivered by a manager's existing named EventEmitter
  surface. Live payloads retain their current full-fidelity values.
- A **persisted event** is the bounded, redacted projection of a live event that the persistence
  policy in §2.6 admits to the JSONL log. Persisted and live payload types are deliberately
  distinct where the live payload contains a runtime `WorkflowError` or an unbounded result.
- On every `EngineRunEvent`, `runId` is the ID of the managed root run and therefore the owner of
  the snapshot and event-log file. `scope` is the engine run that originated the event. For a root
  event, `scope === runId`; for an inline `workflow()` child, `scope` is the child's
  `` `${runId}-nested<ordinal>` `` ID. The relay-only ACP bridge is the explicit compatibility
  exception: its optional `runId` remains `RunOptions.runId` (the originating engine scope), and
  its additive `scope` repeats that value. A context-less `backend_error` has neither field.
- An **event stream ID** is a writer-generated 32-character lowercase hexadecimal generation ID.
  A new journaling run mints one with `randomBytes(16).toString("hex")`; every resume of that run
  retains it. Deleting and later reusing the same `runId` creates a different stream ID, so a
  lock-free reader cannot combine the old snapshot with the new sidecar.
- A **cursor** is the pair `(streamId, seq)`, where `seq` is the greatest persisted event sequence
  a reader has completely consumed. Sequence `0` means "before the first event". Cursors are
  scoped to one event-stream generation and have no meaning for another run or for a later reuse
  of the same `runId`. The APIs carry the pair as separate `streamId` and `after`/`cursor` fields.
- `@automatalabs/shared-types` owns the live and persisted event data shapes. It remains free of
  ACP dependencies. `@automatalabs/workflow-engine` owns sequence assignment, projection, file
  persistence, snapshot watermarks, and the read/watch API. `@automatalabs/workflows` specializes
  the generic `agentEvent` branch with `AcpRunnerEventMap`.

### 2.2 The shared live `RunEvent` union

Add `packages/shared-types/src/run-events.ts` and export it from the package root. Every named
payload is public; consumers never need to infer a callback parameter from a concrete manager
class.

```ts
import type { AgentHistoryEntry } from "./agent-history.js";
import type { AgentResultProvenance, AgentUsage } from "./agent-run.js";
import type {
  AuthErrorContext,
  CheckpointContext,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowRecordedError,
} from "./errors.js";
import type {
  AgentSessionRecord,
  JournalEntry,
  TokenUsage,
  WorkflowCallRecord,
  WorkflowRunResult,
} from "./workflow-result.js";

/** Root run that owns the event stream, plus the engine run that originated the event. */
export interface RunEventOrigin {
  runId: string;
  scope: string;
}

export interface RunLogPayload extends RunEventOrigin {
  message: string;
}

export interface RunPhasePayload extends RunEventOrigin {
  title: string;
}

export interface RunAgentStartPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  prompt: string;
  model?: string;
  configOptions?: Record<string, string | boolean>;
  callIndex: number;
}

export interface RunAgentEndPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  result: unknown;
  tokens?: number;
  worktree?: string;
  model?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  session?: AgentSessionRecord;
  callIndex: number;
  usage?: AgentUsage;
  modelResolved?: string;
  modelFallbacks?: string[];
  backendId?: string;
  provenance?: AgentResultProvenance;
  errorRecord?: WorkflowRecordedError;
}

export interface RunAgentHistoryPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  history: AgentHistoryEntry[];
  callIndex: number;
}

export interface RunTokenUsagePayload extends RunEventOrigin {
  usage: TokenUsage;
}

export interface RunCompletePayload extends RunEventOrigin {
  result: WorkflowRunResult;
}

export interface RunJournalPayload extends RunEventOrigin {
  entry: JournalEntry;
}

export interface RunCallRecordPayload extends RunEventOrigin {
  record: WorkflowCallRecord;
}

/** `pause(runId)` keeps today's minimal payload: absence of `reason` means manual pause. */
export interface RunManualPausedPayload extends RunEventOrigin {
  reason?: never;
  error?: never;
  errorRecord?: never;
  resetHint?: never;
  authContext?: never;
  checkpointContext?: never;
}

export interface RunUsageLimitPausedPayload extends RunEventOrigin {
  reason: "usage_limit";
  error: WorkflowError;
  /** Strict-JSON projection of `error`; added to the live payload for durable consumers. */
  errorRecord: WorkflowRecordedError;
  resetHint?: string;
  authContext?: never;
  checkpointContext?: never;
}

export interface RunAuthPausedPayload extends RunEventOrigin {
  reason: "auth_required";
  error: WorkflowError;
  errorRecord: WorkflowRecordedError;
  authContext?: AuthErrorContext;
  resetHint?: never;
  checkpointContext?: never;
}

export interface RunCheckpointPausedPayload extends RunEventOrigin {
  reason: "checkpoint_required";
  error: WorkflowError;
  errorRecord: WorkflowRecordedError;
  checkpointContext?: CheckpointContext;
  resetHint?: never;
  authContext?: never;
}

export type RunPausedPayload =
  | RunManualPausedPayload
  | RunUsageLimitPausedPayload
  | RunAuthPausedPayload
  | RunCheckpointPausedPayload;

export interface RunErrorPayload extends RunEventOrigin {
  error: WorkflowError;
  /** Strict-JSON projection of `error`; added to the live payload for durable consumers. */
  errorRecord: WorkflowRecordedError;
}

export interface RunStoppedPayload extends RunEventOrigin {}
export interface RunResumedPayload extends RunEventOrigin {}

/**
 * Dependency-neutral shape of the SDK-only ACP bridge. The shared package types the stable
 * context envelope; @automatalabs/workflows binds Name/Event to AcpRunnerEventMap (§2.4).
 * `runId` is optional because backend_error and runner activity outside a workflow have no run.
 */
export interface RunAgentEventPayload<Name extends string = string, Event = unknown> {
  name: Name;
  event: Event;
  backendId: string;
  sessionId?: string;
  label?: string;
  runId?: string;
  scope?: string;
  callIndex?: number;
}

export type RunLogEvent = { type: "log" } & RunLogPayload;
export type RunPhaseEvent = { type: "phase" } & RunPhasePayload;
export type RunAgentStartEvent = { type: "agentStart" } & RunAgentStartPayload;
export type RunAgentEndEvent = { type: "agentEnd" } & RunAgentEndPayload;
export type RunAgentHistoryEvent = { type: "agentHistory" } & RunAgentHistoryPayload;
export type RunTokenUsageEvent = { type: "tokenUsage" } & RunTokenUsagePayload;
export type RunCompleteEvent = { type: "complete" } & RunCompletePayload;
export type RunJournalEvent = { type: "journal" } & RunJournalPayload;
export type RunCallRecordEvent = { type: "callRecord" } & RunCallRecordPayload;
export type RunPausedEvent = { type: "paused" } & RunPausedPayload;
export type RunErrorEvent = { type: "error" } & RunErrorPayload;
export type RunStoppedEvent = { type: "stopped" } & RunStoppedPayload;
export type RunResumedEvent = { type: "resumed" } & RunResumedPayload;
export type RunAgentEventEvent<Name extends string = string, Event = unknown> =
  { type: "agentEvent" } & RunAgentEventPayload<Name, Event>;

/** Engine-manager events only; the SDK adds the specialized agentEvent branch below. */
export type EngineRunEvent =
  | RunLogEvent
  | RunPhaseEvent
  | RunAgentStartEvent
  | RunAgentEndEvent
  | RunAgentHistoryEvent
  | RunTokenUsageEvent
  | RunCompleteEvent
  | RunJournalEvent
  | RunCallRecordEvent
  | RunPausedEvent
  | RunErrorEvent
  | RunStoppedEvent
  | RunResumedEvent;

/** Engine events admitted by the frozen persistence policy (§2.6). */
export type PersistableEngineRunEvent = Exclude<EngineRunEvent, RunAgentHistoryEvent>;

/** Full stable union. The type parameter lets the SDK bind the ACP event map without a cycle. */
export type RunEvent<AgentEvent extends RunAgentEventEvent = RunAgentEventEvent> =
  | EngineRunEvent
  | AgentEvent;

export type RunEventName = RunEvent["type"];

export type RunEventPayload<Event extends { type: string }> =
  Event extends unknown ? Omit<Event, "type"> : never;

export type EngineRunEventName = EngineRunEvent["type"];
export type EngineRunEventPayloadMap = {
  [Name in EngineRunEventName]: RunEventPayload<Extract<EngineRunEvent, { type: Name }>>;
};
```

Named payloads intentionally mirror the manager's current literals, with three additive
corrections:

1. every engine-manager payload carries `scope` (root payloads use `runId`);
2. automatic `paused` and `error` payloads carry the same `WorkflowRecordedError` projection the
   engine already knows how to create; the manager calls the existing
   `projectRecordedError(workflowError)` once per automatic settlement/resume-gate pause and reuses
   that value as `errorRecord`; and
3. `agentEvent` gains the optional direct `callIndex` correlation in §2.4.

`RunEvent` itself does not contain `seq` or `timestamp`. Those facts belong to a successful
persisted append, not to relay-only delivery. Consumers switch exhaustively on `event.type`; event
names and all discriminants are case-sensitive frozen strings.

### 2.3 Typed EventEmitter compatibility

`WorkflowManager` remains an `EventEmitter`, keeps every current event name, keeps its
listener-exception isolation, and keeps the public string/symbol fallback. There is no deprecation
in this release. Add declaration overloads for `on`, `once`, `addListener`, `off`,
`removeListener`, and `emit`; the representative pair is:

```ts
export interface WorkflowManager {
  addListener<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  on<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  once<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  removeListener<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  off<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  emit<Name extends EngineRunEventName>(
    eventName: Name,
    payload: EngineRunEventPayloadMap[Name],
  ): boolean;

  // Node compatibility and host-defined events remain accepted.
  addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  once(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  emit(eventName: string | symbol, ...args: any[]): boolean;
}
```

The overloads are declaration-only; the existing `rawListeners()` dispatch implementation remains
the single runtime path. `error` retains the manager's existing listener-gated live behavior: the
manager invokes the named EventEmitter event only when at least one `error` listener exists. The
durable `error` record is written regardless of listener count (§2.8), so persistence never depends
on observation.

The manager constructs one `EngineRunEvent` internally, derives the legacy payload by removing
`type`, and uses that same event value for persistence projection. It must not build a second event
with independently copied fields; this is the drift guard between the union and the named emitter
surface. This contract does not newly freeze legacy EventEmitter payloads.

Calling the public `manager.emit(...)` from host code remains a raw EventEmitter operation. It is
typed for compatibility but does not mutate managed state, allocate a sequence, or write a
sidecar; only manager-owned workflow/host-action publication sites may enter the durable log while
holding the run lease.

### 2.4 `agentEvent` specialization and the `callIndex` echo

`AcpEventContext` gains one optional field:

```ts
export interface AcpEventContext {
  sessionId: string;
  backendId: BackendId;
  label?: string;
  runId?: string;
  /** RunOptions.callIndex for the agent() call that opened this session, when supplied. */
  callIndex?: number;
}
```

Population is mechanical and lossless:

1. `AcpAgentRunner.run()` already receives `RunOptions.callIndex`; `SessionPreparationOptions`,
   `AcpSessionOptions`, `SessionState`, and `SessionTombstone` each gain `callIndex?: number`.
2. `prepareSession()` copies `opts.callIndex` into `sessionOptions`. Every session creation,
   load, resume, and fork constructor copies it into `SessionState`; ordinary interactive APIs do
   not invent a value.
3. `MultiplexClient.contextFor()` resolves the live `SessionState` first and its existing bounded
   tombstone second, then copies the resolved `callIndex` (plus label/run ID). Every session update,
   permission, elicitation, raw-message, session-open, and session-close event therefore carries
   the same value for that session, including a late update still covered by the tombstone window.
   URL-elicitation context capture preserves the same context value.
4. `backend_error` remains connection-scoped and has no `sessionId`, `runId`, or `callIndex`.

The field is not sent on the ACP wire, not placed in `_meta`, not a journal-hash input, and not a
session identity. Retries of one engine call carry the same `callIndex`; sessions opened by direct
runner callers or interactive APIs may omit it. Those omissions are the backward-compatibility
contract, not an error.

The SDK binds the shared generic branch exactly:

```ts
type ContextProperty<T, Key extends PropertyKey> = Key extends keyof T ? T[Key] : never;
type OptionalContextProperty<T, Key extends PropertyKey> =
  Key extends keyof T ? T[Key] : undefined;

/** The manager unwraps the runner catch-all into its concrete sessionUpdate discriminant. */
export type WorkflowAgentEventName = Exclude<AcpEventName, "session_update">;

/**
 * Envelope map over the runner's whole public event-name type. The manager-emitted map below
 * picks only names the bridge actually publishes; retaining the full map preserves the existing
 * AgentEventPayload<"session_update"> type argument for source compatibility.
 */
type WorkflowAgentEventEnvelopeMap = {
  [Name in AcpEventName]: {
    name: Name;
    event: AcpRunnerEventMap[Name];
    backendId: ContextProperty<AcpRunnerEventMap[Name], "backendId">;
  } & ("sessionId" extends keyof AcpRunnerEventMap[Name]
    ? { sessionId: ContextProperty<AcpRunnerEventMap[Name], "sessionId"> }
    : { sessionId?: undefined }) & {
      label?: OptionalContextProperty<AcpRunnerEventMap[Name], "label">;
      runId?: OptionalContextProperty<AcpRunnerEventMap[Name], "runId">;
      scope?: OptionalContextProperty<AcpRunnerEventMap[Name], "runId">;
      callIndex?: OptionalContextProperty<AcpRunnerEventMap[Name], "callIndex">;
    };
};

export type WorkflowAgentEventPayloadMap = Pick<
  WorkflowAgentEventEnvelopeMap,
  WorkflowAgentEventName
>;

export type WorkflowAgentEventPayload<
  Name extends WorkflowAgentEventName = WorkflowAgentEventName,
> = WorkflowAgentEventPayloadMap[Name];

export type WorkflowAgentEvent = {
  [Name in WorkflowAgentEventName]:
    { type: "agentEvent" } & WorkflowAgentEventPayload<Name>;
}[WorkflowAgentEventName];

export type WorkflowRunEvent = RunEvent<WorkflowAgentEvent>;

/**
 * Compatibility alias retained with its pre-contract generic constraint and default. The
 * "session_update" member is type-only: the manager did not emit it before this contract and
 * still does not. New exact consumers use WorkflowAgentEventPayload/WorkflowAgentEvent.
 */
export type AgentEventPayload<
  Name extends AcpEventName = AcpEventName,
> = WorkflowAgentEventEnvelopeMap[Name];

export interface WorkflowManager {
  addListener(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  on(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  once(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  removeListener(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  off(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  emit(eventName: "agentEvent", payload: WorkflowAgentEventPayload): boolean;
}
```

`toSessionUpdateAgentEventPayload()` and `toAgentEventPayload()` repeat `callIndex` at the top
level exactly as they already repeat `sessionId`, `backendId`, `label`, and `runId`; when `runId`
is present, `scope` is set to that same engine run ID. The SDK manager adds the same six typed
EventEmitter method overloads for `"agentEvent"`. It does not invent run/session context for a
context-less `backend_error`. The runner's `session_update` catch-all is an internal bridge
subscription: the manager emits exactly one `agentEvent` for it, whose `name`/`event` are the
concrete `sessionUpdate` discriminant/variant. It does not emit a duplicate
`name: "session_update"` payload.

The already-exported `AgentEventPayload<Name extends AcpEventName = AcpEventName>` alias keeps its
pre-contract constraint and default, including the `"session_update"` type branch. That branch is
a source-compatibility artifact only: it is excluded from `WorkflowAgentEventName`,
`WorkflowAgentEventPayload`, `WorkflowAgentEvent`, `WorkflowRunEvent`, and the manager overloads,
because the manager never emitted it. It is not deprecated in this release. This separation makes
the new union exact without turning an additive minor release into a type-level breaking change.

All `agentEvent` variants are live relay only in v1 (§2.6). That includes ACP message/thought
chunks, tool-call updates, usage updates, permissions, elicitations, raw vendor messages, and
session lifecycle. The type is public so a host may subscribe and own a transcript store, but this
library never writes those verbatim ACP payloads into the run event log.

### 2.5 The persisted event shapes and write-time projection

Persisted events are intentionally bounded observability records, not a second copy of the raw
workflow result or ACP transcript. Add these shared types:

```ts
/** Bounded JSON text for an otherwise-unbounded strict-JSON value. */
export interface RunEventValueProjection {
  preview: string;
  redacted: boolean;
  truncated: boolean;
}

export interface RunEventCheckpointProjection
  extends Omit<CheckpointContext, "prompt" | "choices" | "default"> {
  prompt: string;
  choices?: string[];
  default?: RunEventValueProjection;
}

export interface RunEventErrorProjection
  extends Omit<
    WorkflowRecordedError,
    "name" | "message" | "agentLabel" | "details" | "resetHint" |
    "authContext" | "checkpointContext" | "props" | "value"
  > {
  name?: string;
  message?: string;
  agentLabel?: string;
  details?: RunEventValueProjection;
  resetHint?: string;
  authContext?: AuthErrorContext;
  checkpointContext?: RunEventCheckpointProjection;
  props?: RunEventValueProjection;
  value?: RunEventValueProjection;
}

export interface PersistedRunAgentEndPayload
  extends Omit<RunAgentEndPayload, "result" | "errorRecord" | "session"> {
  result: RunEventValueProjection;
  errorRecord?: RunEventErrorProjection;
}

export interface PersistedRunJournalEntry extends Omit<JournalEntry, "result" | "session"> {
  result: RunEventValueProjection;
}

export interface PersistedRunJournalPayload extends RunEventOrigin {
  entry: PersistedRunJournalEntry;
}

export interface PersistedRunCallRecord
  extends Omit<WorkflowCallRecord, "error"> {
  error?: RunEventErrorProjection;
}

export interface PersistedRunCallRecordPayload extends RunEventOrigin {
  record: PersistedRunCallRecord;
}

export interface PersistedRunCompleteSummary {
  status: "completed";
  workflowName: string;
  agentCount: number;
  durationMs: number;
  phaseCount: number;
  callCount: number;
  tokenUsage?: TokenUsage;
  result: RunEventValueProjection;
}

export interface PersistedRunCompletePayload extends RunEventOrigin {
  summary: PersistedRunCompleteSummary;
}

export interface PersistedRunUsageLimitPausedPayload extends RunEventOrigin {
  reason: "usage_limit";
  errorRecord: RunEventErrorProjection;
  resetHint?: string;
}

export interface PersistedRunAuthPausedPayload extends RunEventOrigin {
  reason: "auth_required";
  errorRecord: RunEventErrorProjection;
  authContext?: AuthErrorContext;
}

export interface PersistedRunCheckpointPausedPayload extends RunEventOrigin {
  reason: "checkpoint_required";
  errorRecord: RunEventErrorProjection;
  checkpointContext?: RunEventCheckpointProjection;
}

export type PersistedRunPausedPayload =
  | RunManualPausedPayload
  | PersistedRunUsageLimitPausedPayload
  | PersistedRunAuthPausedPayload
  | PersistedRunCheckpointPausedPayload;

export interface PersistedRunErrorPayload extends RunEventOrigin {
  errorRecord: RunEventErrorProjection;
}

export type PersistedRunEvent =
  | RunLogEvent
  | RunPhaseEvent
  | RunAgentStartEvent
  | ({ type: "agentEnd" } & PersistedRunAgentEndPayload)
  | RunTokenUsageEvent
  | ({ type: "complete" } & PersistedRunCompletePayload)
  | ({ type: "journal" } & PersistedRunJournalPayload)
  | ({ type: "callRecord" } & PersistedRunCallRecordPayload)
  | ({ type: "paused" } & PersistedRunPausedPayload)
  | ({ type: "error" } & PersistedRunErrorPayload)
  | RunStoppedEvent
  | RunResumedEvent;

export const RUN_EVENT_LOG_VERSION = 1 as const;

export interface RunEventLogRecord {
  version: typeof RUN_EVENT_LOG_VERSION;
  /** Writer-generated generation ID; stable across resume, different after delete/recreate. */
  streamId: string;
  runId: string;
  seq: number;
  timestamp: string;
  event: PersistedRunEvent;
  projection: {
    redacted: boolean;
    truncated: boolean;
  };
}
```

The projector lives in `run-observability.ts` and is exported for host tests:

```ts
export function projectRunEventForPersistence(
  event: PersistableEngineRunEvent,
): Omit<RunEventLogRecord, "streamId" | "seq" | "timestamp">;
```

It reuses the existing redaction/compaction code with these exact rules:

1. Call indexes, engine-computed hashes, discriminants, error codes, the writer-generated stream
   ID and canonical timestamp, and numeric/boolean telemetry are non-secret structural fields and
   are copied verbatim. An engine-computed hash or stream ID is exempt from opaque-token matching
   only at the typed field that produced it; an identical string in authored data is not exempt.
2. Every other typed string is passed through `redactText()` and then `truncateUtf8(...,
   MAX_OBSERVABILITY_SCALAR_BYTES)`. This includes `runId`, `scope`, `backendId`, `message`,
   `title`, `label`, `phase`, `prompt`, model strings, worktree/cwd/path strings, error text, reset
   hints, checkpoint text/choices, auth method IDs/names, config-option IDs/values, and model
   fallback strings. `MAX_OBSERVABILITY_SCALAR_BYTES` remains 512. Consequently the top-level
   `record.runId` and `record.event.runId` are both `sanitizeText(requestedRunId).value`; readers
   compare them with that same projection of the requested ID. Generated run IDs normally remain
   unchanged, while a caller-supplied credential-shaped ID cannot leak into a record body. The
   projector recurses into every retained nested object — specifically the persisted `agentEnd`
   and `callRecord` `provenance` objects and the persisted journal entry's `call` metadata: their
   discriminants (`provenance.source`, `call.kind`) and numeric/boolean fields are copied verbatim
   by rule 1, while every other nested string (`provenance.overrideModel`,
   `provenance.recordedRunId`, `call.label`, `call.phase`, `call.model`, `call.backendId`) passes
   through `redactText()` + `truncateUtf8()` exactly as a top-level string. No retained nested
   string escapes this pass.
3. `configOptions` entries are sorted by their original key, limited to the first 20, and string
   keys/values use rule 2. When an option ID matches the existing `sensitiveKey()` predicate, its
   value becomes the string `"[REDACTED]"` (a boolean value also becomes that string in the
   persisted projection; live payload typing/value is unchanged). The persisted
   `RunAgentStartEvent` branch remains type-correct because its value union already admits both
   strings and booleans. If two option IDs become equal after redaction/truncation, the first in
   original-key sort order wins, the later entry is omitted, and `projection.truncated` is true.
4. `RunEventValueProjection` is the current `compactJson()` algorithm: maximum depth 4, first 10
   array items, first 20 object keys, sensitive-key replacement, credential-shaped redaction in
   strings, then `JSON.stringify` and a 512-byte UTF-8 cap. `redacted` and `truncated` report any
   replacement, structural omission, depth marker, or final byte cap. The algorithm is applied to
   `agentEnd.result`, `journal.entry.result`, the top-level workflow result in `complete`,
   checkpoint defaults, and the `details`/`props`/`value` fields of recorded errors.
5. Auth methods are limited to the first 20 in source order; their `type` discriminants are copied
   and their IDs/names use rule 2. Checkpoint choices and agent-end `modelFallbacks` are each
   limited to the first 20 in source order. Every omitted entry sets `projection.truncated`.
   `complete` stores only `PersistedRunCompleteSummary`, with `workflowName = result.meta.name`,
   `agentCount = result.agentCount`, `durationMs = result.durationMs`,
   `phaseCount = result.phases.length`, `callCount = result.calls?.length ?? 0`, `tokenUsage` copied
   when present, and `result` projected from `result.result`. It does not duplicate logs, sessions,
   fallbacks, checkpoints, or call-manifest arrays already available in the snapshot and their own
   events. Agent-end and journal projections also omit `session`; session re-attach IDs remain in
   the protected snapshot/result and never enter the event sidecar.
6. The raw runtime `WorkflowError`, its stack, and ACP `agentEvent.event` values never enter the
   projector. Automatic pause/error events persist only `RunEventErrorProjection`.
7. `projection.redacted`/`projection.truncated` are the OR of all field-level outcomes. Projection
   happens synchronously before append. Readers have no raw mode and perform no second redaction
   pass. A field excluded by the persisted schema itself (for example `session`, the raw
   `WorkflowError`, or the complete result's logs/call arrays) does not set `truncated`; list caps,
   scalar caps, compact-value omissions, and sanitized-key collisions do.

`RUN_EVENT_MAX_RECORD_BYTES = 65_536` is exported by workflow-engine. The UTF-8 byte count includes
the trailing LF. A projected record exceeding the cap is an event-log write failure (§2.9), never a
silently dropped or structurally different line.

### 2.6 Persistence policy (frozen per event type)

| Event type | Live named emitter | Persisted by default | Rationale |
| --- | --- | --- | --- |
| `log` | yes | yes | Run narrative and warnings |
| `phase` | yes | yes | Lifecycle/progress boundary |
| `agentStart` | yes | yes | Lifecycle/progress boundary |
| `agentEnd` | yes | yes | Lifecycle/progress boundary and terminal call summary |
| `agentHistory` | yes | **no** | Transcript-like, content-heavy diagnostic duplicate |
| `tokenUsage` | yes | yes | Bounded cumulative progress/cost snapshot |
| `complete` | yes | yes | Root terminal lifecycle |
| `journal` | listener-gated | yes | Deterministic call-result lifecycle (bounded projection) |
| `callRecord` | listener-gated | yes | Terminal call structure, including non-journal exits |
| `paused` | yes | yes | Root terminal/resumable lifecycle |
| `error` | listener-gated | yes, regardless of listeners, while lease-owned | Root failure lifecycle |
| `stopped` | yes | yes | Host-requested lifecycle transition |
| `resumed` | yes | yes | Lifecycle transition on the same run ID |
| `agentEvent` | yes (SDK manager) | **no** | Verbatim high-frequency ACP stream; host-owned transcript concern |

There is no opt-in persistence knob for `agentHistory` or `agentEvent` in v1. A fixed policy keeps
the on-disk security and volume contract invariant across hosts. A host that needs a transcript
subscribes to the typed live bridge and writes its own store under its own retention and consent
policy. `journaling: false` disables the event sidecar and watermark entirely while leaving every
live named event unchanged; because that run has no persisted snapshot either, a persistence read
for it returns `RUN_NOT_FOUND`.

"Persisted" in the table also requires the manager to hold that run's writer lease. Every normal
publication, including manual pause/stop, appends before releasing the lease. A callback that
arrives only after terminal save/release is never appended and consumes no sequence. Its live
delivery remains exactly event-specific as today: the existing post-terminal guard still drops
late `agentStart`, `agentEnd`, `agentHistory`, `journal`, and `callRecord` callbacks, while the
callbacks without that guard and the listener-gated execution-settlement `error` remain eligible
for live delivery. This preserves both compatibility and exactly-one-writer safety when another
process may already have resumed the same run. In particular, the later execution-settlement
`error` that can follow a programmatic `pause()`/`stop()` stays live-only; automatic pause/error
settlement, which still owns the lease, is durable.

`stop()` on a still-running managed run uses its existing lease. `stop()` on a warm paused managed
run must first reacquire the lease. For a journaling run it then re-loads the snapshot; if
acquisition fails or the lease-protected snapshot is no longer paused, it releases any acquired
lease, returns `false`, and emits/writes nothing. On success it initializes the publication
watermark from the validated tail and uses the re-loaded snapshot—not the stale warm object—as the
source of the stopped save, then follows the manual `stopped` ordering in §2.8. For
`journaling: false`, no snapshot is expected: successful reacquisition permits the existing
live-only stopped transition and then releases the lease. This prevents a stale paused manager
from racing a resume in another process without inventing persistence for non-journaling runs.

That post-release settlement also performs no snapshot save. The manual pause/stop path has already
saved its authoritative status and watermark before releasing; allowing the old execution catch to
rewrite afterward could clobber a newer process's resumed state/event watermark. It may still
compose the old promise's in-memory result and deliver the existing listener-gated live `error`.
More generally, every manager-owned snapshot save and event append is conditional on its
publication state still owning the run lease. For a `ManagedRun`, this also covers a running
execution detached by `deleteRun()`: later callbacks remain eligible for legacy live delivery but
cannot recreate the deleted snapshot or sidecar.

### 2.7 File layout, line format, size, rotation, and retention

For a journaling run, the default filesystem persistence uses the existing primary `runsDir` and
adds exactly one sidecar:

```text
<runsDir>/<runId>.json          # existing atomic run snapshot
<runsDir>/<runId>.json.bak      # existing best-effort snapshot backup
<runsDir>/<runId>.log           # existing unstructured engine log
<runsDir>/<runId>.events.jsonl  # new structured event log
```

The event file is UTF-8. Every committed line is `JSON.stringify(record) + "\n"`, with no pretty
printing, BOM, header line, or blank lines. Every line repeats `version: 1`; readers reject an
unknown version rather than guessing. Every line also repeats the snapshot's `streamId`; all lines
in one sidecar carry the same value. `seq` is a positive safe integer, dense from 1. `timestamp` is
`new Date().toISOString()` captured when that sequence candidate is assigned. Sequence within one
stream ID, never timestamp, defines order; wall-clock timestamps may repeat or move backward.

On read, a line must recursively conform to `RunEventLogRecord`/`PersistedRunEvent`: required
fields and their primitive/array/object types are checked. `seq` and `settlementOrdinal` are
positive safe integers; every call/index/count/token field is a non-negative safe integer;
`attempts` is a positive safe integer; and duration, cost, and other numeric telemetry are finite
and non-negative. `streamId` must be 32 lowercase hexadecimal characters and equal the loaded
snapshot's `eventStreamId`; `timestamp` must be a canonical `Date#toISOString()` string, the
top-level/event `runId` values must equal the §2.5 sanitized projection of the requested run ID,
and `event.type` must be one of the persisted branches. Unknown extra object keys are retained and
ignored by v1 readers so additive fields do not require a version bump; a removed, renamed, or
reinterpreted field does require `RUN_EVENT_LOG_VERSION` to change. A failed known-field check is
`CORRUPT_LOG`, except an otherwise valid record/snapshot generation disagreement is the more
specific `STREAM_MISMATCH` (§2.10).

There is no total file-size cap, segment rotation, compression, or automatic TTL in v1. Volume is
bounded per record and the two transcript-like sources are relay-only. The complete history is
retained for as long as the run record is retained. Deletion is one lease-protected operation:
`WorkflowManager.deleteRun(runId)` uses the local managed lease when it still owns one, otherwise
it first acquires the run lease and returns `false` without deleting anything if acquisition fails.
While holding it, the event wrapper attempts sidecar deletion first, then delegates existing run
record deletion; the default filesystem persistence removes its lock file last. The manager then
calls `releaseRunLease()` in a `finally` (safe when the default delete already removed the lock),
clears any managed lease, and removes the warm entry. It preserves the existing return value—the
underlying `RunPersistence.delete(runId)` boolean—even when best-effort sidecar cleanup had a
different outcome. Thus deletion of a locally running run keeps today's synchronous success and
untracking behavior, but any later execution callbacks are durable no-ops by §2.6; deletion cannot
race another process that still owns the run. Direct callers of `RunPersistence.delete()` must
likewise hold and finally release the run lease or otherwise prove no writer exists. Deleting or
pruning an individual prefix is unsupported. Existing `.log` behavior is unchanged.

`runIsolation()`'s post-terminal `replayReport` attachment is the one production snapshot save
outside `WorkflowManager`. It must reacquire the artifact's run lease, reload the artifact under
that lease, verify `executionMode` is exactly
`{ kind: "isolation", baselineRunId: options.baselineRunId }`, save the report onto that fresh copy,
and release in `finally`. Lease acquisition failure, a missing/replaced artifact, or a save failure
follows its existing report-persistence-failure path: the isolation result status is unchanged,
the in-process report gains `report-persistence-failed: <reason>`, and no missing/replaced snapshot
is created or overwritten. Thus report attachment either precedes deletion under the lease or
observes that deletion already won; it cannot resurrect a deleted run.

### 2.8 Sequence assignment, ordering, and the snapshot watermark

`PersistedRunState` gains three additive fields:

```ts
export interface PersistedRunState {
  // ...existing fields...

  /** Event-log generation discriminator: 32 lowercase hex characters. New-format journaling
   *  runs mint it with eventSeq: 0. */
  eventStreamId?: string;

  /** Highest successfully appended event seq whose state effects this snapshot reflects.
   *  New-format journaling runs write 0 before their first event. */
  eventSeq?: number;

  /** At least one persistable live event could not be appended. When set, the log is not a
   *  gap-free projection and read/watch fail with EVENT_LOG_INCOMPLETE. */
  eventLogIncomplete?: true;
}
```

The manager mints `managed.eventStreamId` plus `managed.eventSeq = 0` before the initial save of a
new journaling run. A resume retains the lease-protected snapshot's stream ID and initializes the
managed sequence to the valid event-log tail. That resumed seed is the tail established by the
writer's startup/resume tail validation (§2.9) — equivalently `readEvents()`'s `endCursor` read
under the held lease — and never `snapshot.eventSeq`: a crash, or an unsaved child-scope append
(§2.11), between an append and its watermark save can leave the log ahead of the watermark (§2.9
permits a log-ahead snapshot), so seeding from `snapshot.eventSeq` would make the first `candidate`
smaller than `appendEvent`'s `cachedTail + 1` and raise a spurious `SEQUENCE_MISMATCH` on a
legitimate resume. The writer's tail validation is the single authority both the seed and the
first `appendEvent()` of the epoch derive the next sequence from; it also requires every line's
stream ID to equal the snapshot. Under the exclusive lease they read one frozen generation and
cannot disagree. A resume gate that re-publishes the existing auth/checkpoint pause before a
new `ManagedRun` exists uses the loaded snapshot plus the held lease as an ephemeral publication
state and takes its candidate from the validated log tail. Resume must re-load the snapshot after
acquiring the lease and use that lease-protected copy for all gates/state construction; if it has
disappeared or become non-resumable, resume releases the lease and returns `accepted: false`
without an event. This closes the existing load-before-lease race. Event-log validation never
overrides snapshot-based workflow recovery: if a resumable snapshot has an
incomplete/corrupt/inconsistent event sidecar, resume marks `eventLogIncomplete`, disables further
appends, reports the diagnostic, and continues from the snapshot/journal. The read/watch seam still
fails closed. Publication of a persistable event is one synchronous critical section:

1. Apply the event's state mutation to its publication state—normally `managed`, or the
   lease-protected loaded snapshot for a resume gate (for example, append the log line, start/end
   the agent snapshot row, or settle the terminal status).
2. Construct the live `EngineRunEvent`.
3. Let `candidate = publicationState.eventSeq + 1`, capture its timestamp, and call
   `appendEvent()` with the live event. The persistence layer performs the mandatory write-time
   projection and byte cap and stamps the publication state's `eventStreamId` onto the record.
4. Append and close the complete projected JSONL line. Only after append succeeds set
   the publication state's `eventSeq = candidate` from the returned record.
5. Perform the snapshot save, live delivery, and lease release in the exact order below. Every save
   includes the current publication watermark, and the new event-log append precedes every listed
   action.

| Publication | Actions after successful append |
| --- | --- |
| `log`, `phase`, `agentStart`, `agentEnd`, `tokenUsage` | live delivery; no save forced by this hook |
| root `journal`, root `callRecord` | snapshot save, then listener-gated live delivery |
| child-scope `journal`, child-scope `callRecord` | listener-gated live delivery; no root snapshot save |
| `complete` | live delivery, snapshot save, lease release |
| automatic `paused` or `error` settlement | snapshot save, lease release, then live delivery (`error` remains listener-gated) |
| manual `paused` or `stopped` | live delivery, snapshot save, lease release |
| `resumed` | live delivery, then start execution; no additional save solely for this event |
| auth/checkpoint resume-gate `paused` | live delivery, snapshot watermark save, lease release |

The existing pre-`resumed` save of an injected checkpoint journal entry remains before the append.
A legacy snapshot is first re-loaded under the lease and atomically upgraded with a freshly minted
`eventStreamId` and `eventSeq: 0` before its first persistable resume publication, whether that
publication is `resumed` or a resume-gate `paused` (§4). Because the gate re-loaded after acquiring
the lease, its post-delivery watermark save preserves the latest journal rather than writing the
stale pre-lease copy. The append-failure marker path in §2.9 is the exceptional ordering: its
best-effort marker save happens before live delivery.

Existing `onProgress(WorkflowSnapshot)` callbacks remain after the named delivery for the six
hooks that currently call them (`log`, `phase`, `agentStart`, `agentEnd`, `agentHistory`, and
`tokenUsage`). A durable append therefore precedes both the named delivery and progress callback;
relay-only `agentHistory` keeps its existing named-delivery-then-progress order and has no sequence.

Sequence is therefore assigned at persisted write publication, not at generic `emit()`. Relay-only
`agentHistory` and `agentEvent` observations consume no sequence and create no holes.

Thus a successfully persisted record always exists before its corresponding in-process listener
runs. Listener throws remain isolated and cannot undo the append or sequence.

The following are named invariants:

- **Dense-sequence invariant:** committed records for one run are exactly `1..N`, with no duplicate
  or skipped sequence within one event stream ID.
- **Generation invariant:** a snapshot and every record consumed with it carry one equal stream
  ID. A delete/recreate of the same `runId` cannot be mistaken for resume or cursor continuation.
- **Mutation-before-event invariant:** a snapshot that claims `eventSeq = N` includes every
  root-snapshot mutation represented by persisted events through N. Pure observations have no
  required snapshot row; in particular, child journal/call-record events remain intentionally
  absent from the root resume journal/manifest (§2.11).
- **Append-before-watermark invariant:** record N is committed before any snapshot can claim
  `eventSeq >= N`.
- **Catch-up invariant:** after atomically loading a snapshot with stream ID S and watermark N,
  consuming records from S with `seq > N` yields every later persisted observation once—no gap,
  no double count, and no observation from a same-`runId` replacement.
- **Observation-order invariant:** sequence follows the manager's actual callback/host-action order
  on the JavaScript event loop. It is not lexical call order or completion-independent order;
  consumers use `(scope, callIndex)` for call identity.

The log is authoritative for event order and the greatest valid sequence within the snapshot's
stream ID. The snapshot is authoritative for resumable workflow state and full, unredacted journal
data. If the log is ahead of `snapshot.eventSeq`, the snapshot is stale and the reader returns
events after the watermark. If the snapshot watermark is ahead of the valid log tail, the pair is
inconsistent and reading fails with `SNAPSHOT_AHEAD`; a reader never fabricates missing events or
rewinds the snapshot.

Resume replay intentionally republishes execution observations but not cached journal entries. In
every execution supplied a resume journal, a cached `agent()` hit invokes `onAgentStart`, settles a
fresh `WorkflowCallRecord` with `origin: "journal-replay"`, and invokes `onAgentEnd`, in that order.
The manager therefore appends fresh `agentStart`, `callRecord`, and `agentEnd` records. When an
in-place `resumeInBackground(runId)` continues the same run ID, those new sequences are duplicate
observations of the prior logical call key `(scope, callIndex)`; this is expected, and consumers
that count calls deduplicate on that key. A cached agent hit does **not** invoke `onAgentJournal`:
the manager seeds the retained root journal prefix into the resumed snapshot, so it appends no
fresh `journal` record for the cached result. A cached `checkpoint()` hit likewise appends a fresh
`callRecord` only—there are no manager `agentStart`, `agentEnd`, or `journal` publications for a
checkpoint replay. A host-injected checkpoint reply is saved into the root journal before
`resumed` and follows that same no-`journal`-publication rule. These asymmetries preserve the
engine's existing replay callbacks and journal bytes; they are not a persistence-policy option.

`complete`, automatic `paused`, automatic `error`, manual `paused`, and `stopped` are lifecycle
observations, not a mutually exclusive terminal algebra. Existing live behavior is preserved: for
example, `stop()` may emit `stopped` before the aborted execution settles and emits a later
listener-gated live `error`. The `stopped` event is appended before lease release; the later
post-release error is live-only by §2.6. Consumers determine current status from the snapshot/result,
not by assuming the first terminal-looking event is the only one.

### 2.9 Durability, crash recovery, and multi-process safety

The default writer opens the event file in append mode, attempts one synchronous write of the
complete line, verifies that the returned byte count equals the buffer length, and closes the
descriptor before returning. A short write is a failed append and leaves a recoverable partial
suffix. There is no user-space buffer and no explicit `fsync`/`fdatasync` per event. The guarantee
matches the existing synchronous snapshot writes: committed bytes survive ordinary process
failure; power-loss durability remains the filesystem's responsibility.

A crash can leave a final unterminated line. Readers ignore bytes after the last LF, even when
those bytes happen to parse as JSON. They never ignore an invalid **terminated** line: malformed
JSON, an unsupported version, a run-ID mismatch, a non-dense sequence, or a structurally invalid
record before the last LF is `CORRUPT_LOG`/`UNSUPPORTED_VERSION`; a valid record from a different
stream generation is `STREAM_MISMATCH`.

Before the exactly-one writer appends after startup/resume, it validates every terminated line,
truncates only the unterminated suffix, and takes the last valid sequence as the next-sequence
base. It also pins the epoch to the lease-protected snapshot's `eventStreamId`; a sidecar carrying
another generation is never repaired or appended. A half-written candidate N is therefore
discarded and N is reused; the dense-sequence invariant survives a crash. A read never performs
this repair because readers must be non-mutating.

Exactly one writer per run is required. `WorkflowManager` satisfies that requirement with the
existing cross-process run lease; a conforming custom host that calls `appendEvent()` directly
must hold the same lease or equivalent exclusivity. Concurrent readers need no lock. They consume
only LF-terminated records and may safely read while the writer is appending. Snapshot/record
stream-ID equality makes a read that races lease-protected deletion plus immediate same-ID reuse
fail closed instead of joining generations; a watcher additionally pins its construction-time
stream ID (§2.10). The file format does not support two appenders, deletion without writer
exclusion, NFS lock inference, or cross-host conflict resolution. The same writer exclusion
applies to production calls of `RunPersistence.save()` and `delete()`; the persistence object does
not infer lease ownership from the process ID or make an unleased mutation safe.

`WorkflowManager` startup stale-run recovery is included in that rule. For each snapshot listed as
`running`, the fresh manager attempts the run lease, skips the row when a live process owns it,
then re-loads under an acquired lease and changes the snapshot to `paused` only if that fresh copy
is still `running`. It preserves `eventStreamId`, `eventSeq`, and `eventLogIncomplete`, saves once,
and releases in `finally`. Recovery emits/appends no `paused` event—the current manager has no
corresponding live publication site, and this contract does not invent one. The defect this
closes is the save of a stale pre-lease listing copy: today's recovery acquires the lease but
persists `{ ...p, status: "paused" }` where `p` was read by `listAllRuns()` before acquisition, so
a run resumed by another process between listing and locking could be clobbered with stale state.
The re-load-under-lease mandate removes that TOCTOU without changing the named event surface.

An append/projection/record-size failure does **not** change the workflow's computational outcome:
live observers are best-effort today, and an observability disk failure must not turn a successful
agent call into a retry. Instead the manager:

1. leaves `managed.eventSeq` at the last successful append;
2. sets `managed.eventLogIncomplete = true`;
3. disables all further event-log appends for that managed run;
4. reports one best-effort diagnostic through the existing manager persistence warning path; and
5. immediately attempts a snapshot save with the marker (even for a hook that would not normally
   save), includes it in every later save it can complete, then still delivers the live
   EventEmitter payload for the failed append.

`readEvents()` and `watchEvents()` fail closed on that marker. A resumed incomplete run remains
resumable from its snapshot for backward compatibility, but its event log stays disabled and
incomplete; resume never starts a misleading second gap-free suffix. As with any disk-full event,
if both the event append and every later snapshot write fail, no file API can publish the marker;
the library makes no impossible durability claim for failed I/O.

### 2.10 Read and tail API

Keep the existing `RunPersistence` interface source-compatible. Add a subtype and make both
`createRunPersistence()` and `WorkflowManager.getPersistence()` return it. A custom
`RunPersistence` passed to the manager is wrapped by `withRunEvents()`; its declared
`getRunsDir()` is the sidecar location, and all existing methods delegate unchanged.

```ts
export const RUN_EVENT_READ_LIMIT_DEFAULT = 100 as const;
export const RUN_EVENT_READ_LIMIT_MAX = 1_000 as const;

export interface ReadRunEventsOptions {
  /** Greatest seq already consumed. Default 0. */
  after?: number;
  /** Maximum records returned. Default 100; valid range 1..1000. */
  limit?: number;
  /** Expected generation from a snapshot or prior read. Omit only for an initial current-stream
   *  read. Continuations MUST pass the previously returned value. */
  streamId?: string;
}

export interface ReadRunEventsResult {
  events: RunEventLogRecord[];
  /** Generation that owns cursor/endCursor and every returned record. */
  streamId: string;
  /** Last returned seq, or `after` when no record was returned. */
  cursor: number;
  /** Greatest complete valid seq in the LF-terminated prefix captured by this read. */
  endCursor: number;
  /** True iff at least one record after `cursor` existed at that read point. */
  hasMore: boolean;
}

export interface WatchRunEventsOptions {
  /** Backlog begins strictly after this seq. Default 0. */
  after?: number;
  /** Expected generation from a snapshot or prior read. Omitted means pin the generation that
   *  exists when watchEvents() validates synchronously. */
  streamId?: string;
  /** Abort ends iteration normally (`done: true`); it does not reject `next()`. */
  signal?: AbortSignal;
}

export interface RunEventStream extends AsyncIterableIterator<RunEventLogRecord> {
  /** Generation pinned for this iterator's entire lifetime. */
  readonly streamId: string;
  readonly closed: boolean;
  /** Async-iterator cancellation; equivalent to close(). */
  return(value?: unknown): Promise<IteratorResult<RunEventLogRecord>>;
  /** Idempotent. Resolves any pending next() with done:true and releases watchers/timers. */
  close(): void;
}

export type RunEventLogErrorCode =
  | "RUN_NOT_FOUND"
  | "EVENT_LOG_UNAVAILABLE"
  | "INVALID_CURSOR"
  | "INVALID_LIMIT"
  | "INVALID_STREAM_ID"
  | "CURSOR_AHEAD"
  | "ORPHANED_LOG"
  | "WATERMARK_MISSING"
  | "STREAM_ID_MISSING"
  | "STREAM_MISMATCH"
  | "CORRUPT_LOG"
  | "UNSUPPORTED_VERSION"
  | "SNAPSHOT_AHEAD"
  | "EVENT_LOG_INCOMPLETE"
  | "SEQUENCE_MISMATCH"
  | "PROJECTION_ERROR"
  | "RECORD_TOO_LARGE"
  | "IO_ERROR";

export class RunEventLogError extends Error {
  readonly name: "RunEventLogError";
  readonly code: RunEventLogErrorCode;
  readonly runId: string;
  readonly seq?: number;
  readonly path?: string;
  constructor(
    message: string,
    code: RunEventLogErrorCode,
    options: { runId: string; seq?: number; path?: string; cause?: unknown },
  );
}

export interface AppendRunEventInput {
  seq: number;
  timestamp: string;
  /** Full-fidelity live event; appendEvent always applies the §2.5 projection internally. */
  event: PersistableEngineRunEvent;
}

export interface RunEventPersistence extends RunPersistence {
  /** Writer seam. There is no pre-projected/raw bypass; returns the exact committed record. */
  appendEvent(runId: string, input: AppendRunEventInput): RunEventLogRecord;
  /** Point-in-time cursor read. */
  readEvents(runId: string, options?: ReadRunEventsOptions): ReadRunEventsResult;
  /** Backlog followed by append notifications until close/abort. */
  watchEvents(runId: string, options?: WatchRunEventsOptions): RunEventStream;
}

export function withRunEvents(persistence: RunPersistence): RunEventPersistence;

export function createRunPersistence(
  cwd: string,
  fsOverride?: Partial<FsLayer>,
  options?: RunPersistenceOptions,
): RunEventPersistence;
```

Every thrown persistence error above is a `RunEventLogError`. `runId` is the raw API argument;
`path` is the absolute sidecar path for file-specific failures; and `seq` is the offending parsed
sequence or append candidate when one is known. Messages name the failed invariant but never echo
raw line/event content. `cause` is retained only for wrapped projection/filesystem failures.

`createRunPersistence()` returns an already event-capable object. `withRunEvents()` marks its own
wrappers with a package-private symbol and is idempotent for an object produced by either API; the
manager applies it unconditionally in its constructor. An unmarked structural `RunPersistence` is
wrapped once, even if it happens to declare similarly named extra methods. Under the caller-owned
run lease required by §2.7, the wrapper attempts sidecar deletion first and then calls the
underlying `delete()` regardless of the sidecar outcome; it returns the underlying boolean so
existing delete-result semantics do not change. The default underlying implementation removes the
snapshot and its backup/temporary files before removing the lock last. A custom persistence
implementation must provide the equivalent delete-under-lease ordering.

`FsLayer` gains optional override members `openSync?`, `writeSync?`, `closeSync?`, `truncateSync?`,
`statSync?`, and `watch?` (each `typeof` its `node:fs` function) for verified append, suffix repair,
and tail notification. The factory resolves every omitted member to the corresponding `node:fs`
function before constructing the event wrapper. The members are optional so both existing
`Partial<FsLayer>` overrides and a complete legacy value annotated as `FsLayer` remain
source-compatible; making them required would be a type-level breaking change despite the
factory's `Partial<FsLayer>` parameter.

`packages/workflow-engine/src/index.ts` exports the constants, error class/codes, options/results,
`RunEventStream`, `AppendRunEventInput`, `RunEventPersistence`, and `withRunEvents`; it also
re-exports the shared event unions/projections. `@automatalabs/workflows` re-exports that complete
host seam plus its ACP-specialized `WorkflowAgentEventName`, `WorkflowAgentEventPayloadMap`,
`WorkflowAgentEventPayload`, `WorkflowAgentEvent`, `WorkflowRunEvent`, and compatibility
`AgentEventPayload`, so SDK consumers do not reach into package internals.

Exact behavior:

- `after` must be a non-negative safe integer (`INVALID_CURSOR`); `limit` must be an integer from
  1 through 1000 (`INVALID_LIMIT`). A supplied `streamId` must match `/^[0-9a-f]{32}$/`
  (`INVALID_STREAM_ID`). The message names the invalid field and value.
- Error precedence is deterministic. Validate `after`, then `limit` when applicable, then
  `streamId`; load/stat the snapshot and sidecar; classify missing/orphan/legacy/watermark/stream-ID
  cases; compare a supplied stream ID with the snapshot; reject `eventLogIncomplete`; parse and
  validate the complete JSONL prefix; compare each line's stream ID and the snapshot watermark
  with the valid tail; then compare `after` with that tail. Within one line, an over-size
  terminated line is `RECORD_TOO_LARGE`; otherwise malformed JSON is `CORRUPT_LOG`; after JSON
  parses, an unknown `version` is `UNSUPPORTED_VERSION` before stream-ID and remaining
  shape/sequence checks. A non-ENOENT filesystem failure at any applicable step is `IO_ERROR` and
  preserves its cause.
- Each read loads the snapshot first through the wrapped `RunPersistence.load()`, then reads the
  event file. Append-before-watermark ordering therefore prevents a writer race from creating a
  transient `SNAPSHOT_AHEAD`. `endCursor` and `hasMore` describe the greatest LF-terminated valid
  prefix parsed by that call (including a complete append that raced after the snapshot load).
- Neither snapshot nor event file present is `RUN_NOT_FOUND`. An event file with no loadable
  snapshot is `ORPHANED_LOG`. An existing legacy snapshot with no `eventSeq` and no event file is
  `EVENT_LOG_UNAVAILABLE`, not an empty new-format stream. A file paired with a snapshot that lacks
  `eventSeq` is `WATERMARK_MISSING`. A snapshot with `eventSeq` but no valid `eventStreamId` is
  `STREAM_ID_MISSING`. A new-format snapshot with a valid stream ID, `eventSeq: 0`, and no event
  file is a valid empty stream.
- `after > endCursor` is `CURSOR_AHEAD`. `snapshot.eventSeq > endCursor` is
  `SNAPSHOT_AHEAD`. `eventLogIncomplete` is `EVENT_LOG_INCOMPLETE`. Corrupt records and versions
  use the codes above. A supplied or watcher-pinned stream ID unequal to the snapshot, or a valid
  record stream ID unequal to that snapshot, is `STREAM_MISMATCH`. An LF-terminated line above
  `RUN_EVENT_MAX_RECORD_BYTES` is `RECORD_TOO_LARGE`. Other filesystem failures are wrapped as
  `IO_ERROR` with `cause`.
- On its first append in each acquired-lease epoch, `appendEvent()` validates/repairs the tail
  under the caller-held writer lease and caches its `{ streamId, tail }`. Before repair it loads the
  snapshot: missing snapshot plus missing sidecar is `RUN_NOT_FOUND`, sidecar without snapshot is
  `ORPHANED_LOG`, `eventLogIncomplete` is `EVENT_LOG_INCOMPLETE`, a snapshot without `eventSeq` is
  `EVENT_LOG_UNAVAILABLE` when no sidecar exists or `WATERMARK_MISSING` when one does, and a
  snapshot with `eventSeq` but no valid `eventStreamId` is `STREAM_ID_MISSING`. After
  partial-suffix repair, every complete line must carry that same stream ID; disagreement is
  `STREAM_MISMATCH`. A snapshot watermark ahead of the valid tail is `SNAPSHOT_AHEAD`; a log-ahead
  snapshot is allowed. The manager therefore must write the new/legacy-upgrade stream ID and
  watermark before its first append. The wrapper clears both cached values on `releaseRunLease()`
  and deletion, so another process may own the next epoch. Every append requires
  `input.seq === cachedTail + 1` (`SEQUENCE_MISMATCH`) and exact equality between the method raw
  `runId` and `input.event.runId` (`CORRUPT_LOG`). Before projection it runtime-validates the input as the
  matching `PersistableEngineRunEvent`; `agentHistory`, `agentEvent`, an unknown discriminant, or
  an invalid required known field is `CORRUPT_LOG`. It then projects internally, stamps the cached
  stream ID, validates the resulting record (including equality to the sanitized requested run
  ID), enforces the byte cap, writes it, and returns that same record. The exactly-one-writer
  precondition makes the per-writer cache authoritative until release/restart. A throw while
  traversing/projecting an otherwise admitted live event is wrapped as `PROJECTION_ERROR` with the
  original cause; invalid projected known fields are `CORRUPT_LOG`, oversize output is
  `RECORD_TOO_LARGE`, and append/close failures are `IO_ERROR`.
- `readEvents()` returns records in ascending sequence and the matched `streamId`. `hasMore` is
  computed against the complete parsed prefix represented by `endCursor`; appends that complete
  after that file read belong to the next read/watch wake. Passing the returned stream ID on every
  continuation is mandatory; omitting it deliberately means "read whichever generation currently
  owns this run ID" and starts a new cursor lineage.
- `watchEvents()` validates synchronously, pins the matched stream ID (supplied or current), then
  yields all backlog after `after` before waiting.
  It watches the containing directory (so delete/recreate is observable) and also performs an
  unref'd 250 ms stat/read recovery check because filesystem notifications may be coalesced. It
  calls `unref()` on both the `FSWatcher` and recovery timer, so an otherwise idle process can
  exit. Every wake reads from the last yielded cursor, so notification coalescing cannot drop
  records. An already-aborted signal is applied after synchronous validation and returns an
  initially closed stream.
- The async iterator is pull-based and holds no unbounded event queue. While one `next()` is
  pending, a subsequent `next()` rejects with `TypeError` and does not cancel the first.
  `return()`, `close()`, or signal abort are equivalent and end normally: they resolve the pending
  and every future `next()` as `{ done: true, value: undefined }`; `return(value)` deliberately
  ignores `value`. A parse/I/O/consistency failure after construction rejects the pending `next()`
  with `RunEventLogError`, marks `closed`, and makes later `next()` calls return done.
- Deletion is not interpreted as normal end-of-stream. A read that begins after both files are gone
  fails `RUN_NOT_FOUND`. A watcher/read racing the mandated sidecar-before-snapshot unlink may
  instead observe `SNAPSHOT_AHEAD`; if the same run ID is recreated before its file read, stream-ID
  pinning produces `STREAM_MISMATCH`. Either error rejects the pending `next()` and closes the
  watcher, so it never follows the recreated run as if it were a resumed suffix.
- A watcher does not auto-close at `complete`, `paused`, `error`, or `stopped`: the same run ID may
  later append `resumed` and another execution suffix. Hosts own the lifetime.

### 2.11 Nested workflows

All engine-origin live/persisted payloads carry `scope`. The three callbacks that currently lose
that fact gain an optional context argument:

```ts
export interface WorkflowCallbackContext {
  /** The runWorkflow invocation that produced this callback. */
  scope: string;
}

export interface WorkflowRunOptions {
  // ...existing fields...
  onLog?: (message: string, context?: WorkflowCallbackContext) => void;
  onPhase?: (title: string, context?: WorkflowCallbackContext) => void;
  onTokenUsage?: (usage: TokenUsage, context?: WorkflowCallbackContext) => void;
}
```

The engine always supplies `{ scope: runId }`; `context` is optional in the function type so
existing custom callback invocations remain source-compatible. The manager falls back to its root
run ID only when an old/custom engine omits the context. Agent lifecycle already carries required
`scope`; journal and call records use their existing `entry.scope`/`record.scope`, falling back to
the root only for legacy values.

An inline child does **not** get a second snapshot or `<childRunId>.events.jsonl`: it has no child
`WorkflowManager`. Events forwarded through the parent manager are appended to the parent's file
with `{ runId: parentRunId, scope: childRunId }`. This includes child log/phase/agent/usage/journal/
call-record observations. The parent manager's existing root-only journal/call-manifest snapshot
filter remains unchanged; the event log is the observation history and may contain child rows the
root resume snapshot deliberately excludes. The root `complete`/pause/error event keeps root
scope. No synthetic child `complete` event is added.

ACP sessions opened by a child already receive the child's `RunOptions.runId`; their relay-only
`agentEvent` payload therefore has `runId === scope === childRunId` plus the child-local
`callIndex`.

### 2.12 Host consumption and MCP background progress

The engine and SDK ship no HTTP, SSE, WebSocket, MCP notification, or other wire protocol. A host
loads a snapshot, requires its `eventStreamId`, reads `readEvents(runId, { streamId:
snapshot.eventStreamId, after: snapshot.eventSeq ?? 0 })`, then continues with `watchEvents()` from
the returned `{ streamId, cursor }`. A host must fall back to its legacy inspection mechanism when
it receives `EVENT_LOG_UNAVAILABLE`; it must surface/fall back explicitly on a missing/mismatched
stream ID or an incomplete/corrupt log rather than pretending the tail is gap-free. Snapshot
strings are protected raw persistence data while event strings are outward projections; a host
that joins a snapshot string (such as `scope`) to an event field must first apply the §2.5 rule-2
projection to the snapshot value.

The MCP server is one such host and changes without altering its tool input/output schemas:

- Foreground execution keeps the existing live `onProgress` projection and request cancellation.
- A background start still returns immediately and emits no progress notification on that
  initiating request, even if it supplied a progress token; in particular it sends nothing after
  the request has completed. A completed MCP request is not a durable progress channel.
- `action: "await"` tails new-format event logs instead of polling. When that **await request**
  carries a progress token, it emits the existing coarse notification shape after `phase`,
  `agentStart`, and first terminal `agentEnd` for each `(scope, callIndex)`: `progress` is the
  number of distinct ended calls, `total` is the number of distinct started calls (omitted while
  zero), and `message` is the latest phase title. The persisted snapshot initializes those sets
  from `agents[]` and `currentPhase`: every row with a non-negative `callIndex` contributes
  `(projectedScope, callIndex)` to started, where `projectedScope` applies §2.5 rule 2 to
  `scope ?? runId`; status `done`, `error`, or `skipped` also contributes it to ended. The initial
  latest title is the same projection of `currentPhase` when present. Await then reads strictly
  after `snapshot.eventSeq` while pinning `snapshot.eventStreamId`. A new `agentStart` not already
  in started emits once; a new `agentEnd` first inserts its key into started if necessary, then
  emits only when it newly enters ended; every `phase` record emits and replaces the latest title.
  `message` is omitted until a phase title exists. An await attached late therefore avoids an
  unbounded prefix scan and catches the suffix without double-counting. The scan avoided here is
  progress-set reconstruction — the started/ended sets and latest phase title seed from the
  snapshot's `agents[]` and `currentPhase`, and the tail is consumed strictly after
  `snapshot.eventSeq`. File-level §2.10 validation still parses the complete LF-terminated prefix
  on a cursor read; a watcher, having pinned its stream ID, may cache incremental validation state
  across wakes within that generation so each 250 ms recovery wake is not O(file size).
- The local settlement promise may still win the terminal race, but it does not disable tail-based
  progress while the await is pending. Await cancellation closes the stream and does not cancel
  the workflow, preserving current behavior.
- Await falls back to the current 250 ms `inspectRun()` terminal poll for
  `EVENT_LOG_UNAVAILABLE`, `WATERMARK_MISSING`, `STREAM_ID_MISSING`, `STREAM_MISMATCH`,
  `EVENT_LOG_INCOMPLETE`, `CORRUPT_LOG`, `UNSUPPORTED_VERSION`, `SNAPSHOT_AHEAD`, `CURSOR_AHEAD`,
  `RECORD_TOO_LARGE`, and `IO_ERROR`. `RUN_NOT_FOUND`/`ORPHANED_LOG` retain the existing unknown-run
  tool error. The remaining codes can arise only from an invalid internal call or writer operation
  and fail the await request as an internal error rather than being hidden. The polling fallback
  emits no progress notifications, even when that await request supplied a progress token; the
  safe inspection surface cannot reconstruct a gap-free distinct-call stream. It only preserves
  bounded terminal waiting.

`inspect`, foreground `onProgress`, the background acceptance result, and the bounded await result
remain byte-compatible. The event log is the new progress source, not a new MCP action.

## 3. What this deliberately does not do

- No wire transport, endpoint, daemon, broker, or cross-host replication. Hosts and embedders own
  transport, authentication, backpressure, and client authorization.
- No persisted ACP transcript in v1. `agentEvent` and `agentHistory` are typed relay-only events;
  message/thought chunks, raw vendor messages, permission inputs, and tool payloads never enter the
  library's event sidecar.
- No event-log replay into workflow execution. Resume continues to use the full snapshot/journal;
  redacted event projections are not valid agent results.
- No new workflow-script DSL primitive or option. Scripts cannot read, seek, or tail their own
  event stream.
- No new manager event names for `onFallback`, `onCheckpointTaken`, or `onNestedWorkflow`.
  Existing result/persistence behavior remains the contract for those callbacks.
- No total-size quota, rotation, compression, prefix deletion, or TTL. Those require a retention
  policy that a library cannot choose for every host; per-record bounds and run-owned deletion are
  the v1 controls.
- No timestamp monotonicity guarantee and no ordering across different run IDs.
- No multi-writer reconciliation. Exactly one writer per run is a precondition enforced by the
  manager lease.
- No guarantee after failed filesystem I/O or sudden power loss beyond the explicit §2.9 contract.

## 4. Compatibility & semver

Existing EventEmitter names, listener isolation, arbitrary string/symbol events, `onProgress`,
`inspectRun`, `await` results, snapshot JSON fields, journal replay, and unstructured `.log` files
remain readable/usable. New live fields (`scope`, `errorRecord`, ACP `callIndex`) are additive.
There is no EventEmitter deprecation. The exact SDK event union excludes the runner's internal
`session_update` catch-all, while the existing `AgentEventPayload` alias retains that type argument
and its original `AcpEventName` default as the compatibility-only branch specified in §2.4.
Likewise, the new `FsLayer` override hooks are optional, so existing full-shape annotations as well
as `Partial<FsLayer>` call sites still compile. `deleteRun()` retains its signature, synchronous
return, and underlying-delete boolean, but now holds or reacquires the run lease through sidecar
and snapshot removal; detached callbacks can no longer recreate durable state after deletion.
This is an observable concurrency/data-integrity fix and must be named in the workflow-engine
changeset.

Old snapshots have no `eventSeq` and remain listable, inspectable, resumable, and deletable. A
read/watch attempt reports `EVENT_LOG_UNAVAILABLE`. When an old run is resumed under the new
manager, its lease-protected snapshot is first stamped with a fresh `eventStreamId` and
`eventSeq: 0`, and its first persistable resume publication starts that stream at sequence 1; that
first event is normally `resumed` but may be a resume-gate `paused`. The log makes no claim about
pre-upgrade history.

Unknown JSONL schema versions fail closed. New sidecars do not affect old package versions because
their run listing scans only `.json` files.

Downgrade **writes** are outside compatibility: a pre-contract engine can load a new snapshot's
unknown keys, but its wholesale rewrite does not preserve `eventStreamId`, `eventSeq`, or
`eventLogIncomplete`, and its delete path does not know the sidecar. If such an older engine
resumes/mutates a new-format run, a later new reader fails closed with `WATERMARK_MISSING` or
`STREAM_ID_MISSING`; if it deletes the snapshot, the sidecar is `ORPHANED_LOG`. Workflow recovery
still uses the snapshot/journal. Running the new lease-protected delete path removes any leftover
sidecar. No additive format can make an already-published older writer preserve fields or files it
does not know, so hosts must not mix pre-contract writers with new-format runs.

`RunPersistence` itself gains no required method, so structural custom implementations still
compile. The manager wraps them through `getRunsDir()`; `createRunPersistence()` and
`getPersistence()` return the additive `RunEventPersistence` subtype. The default delete path
removes the sidecar; custom persistence authors may replace `withRunEvents()` later without
changing manager callers.

One coordinated release:

| Package | Change | Bump |
| --- | --- | --- |
| `@automatalabs/shared-types` | `RunEvent`/payload maps, persisted projections, JSONL record shapes | minor |
| `@automatalabs/workflow-engine` | typed manager overloads, scoped callbacks, projection, stream-ID/sequence/watermark integration, lease-safe deletion, `RunEventPersistence` read/watch seam | minor |
| `@automatalabs/acp-agents` | optional `AcpEventContext.callIndex` threaded through session state and every contextual event | minor |
| `@automatalabs/workflows` | exact ACP specialization, `AgentEventPayload.callIndex`, typed SDK manager overloads/re-exports | minor |
| `@automatalabs/agentprism-otel` | migrate local casts to shared payload types; use `(scope, callIndex)` correlation when present | patch |
| `@automatalabs/mcp-server` | await tail consumption, progress-token reporting for awaited background runs, docs/prompt refresh; no schema change | patch |

Internal dependency ranges receive the repository's normal patch updates. The workflow-engine
changeset must name the observable additions (new sidecar, write-time redaction, listener delivery
after durable append, scope fields, stream-generation cursor pinning, incomplete-log fail-closed
behavior, and lease-protected deletion with no post-delete durable resurrection) and the two other
observable behavior changes this contract introduces: `stop()` on a warm paused run now
reacquires/revalidates the lease and can return `false` to a competing resume, and the
post-release execution settlement no longer rewrites the snapshot. The acp-agents
changeset must state that `callIndex` is optional and never sent on the wire. The agentprism-otel
migration consumes the shared event/payload types through type-only imports (`import type`), so its
published runtime dependency stays `@opentelemetry/api` alone and its structural `WorkflowManagerLike`
is unchanged; a value/runtime import of any AgentPrism package is out of contract for that package.
Every type name currently exported from `packages/agentprism-otel/src/index.ts` (`LogPayload`,
`AgentEndPayload`, `PausedPayload`, `ToolCallEventLike`, and the rest of the hand-rolled payload
set) remains exported: the migration re-points them as aliases of (or structurally compatible
selections from) the shared `EngineRunEventPayloadMap` and changes only internal casts. Deleting
any exported name would be semver-major; the declared patch bump is valid only under this reading.

## 5. Test plan

- **shared-types**: compile-time exhaustiveness over all 13 engine event names and the full
  14-branch `RunEvent` including `agentEvent`; payload-map equality fixtures; paused subtype
  narrowing and forbidden-context fields;
  generic `RunEvent` default plus the ACP-specialized form; persisted union proves
  `agentHistory`/`agentEvent` are absent; `RunEventLogRecord.streamId` is required and
  generation-shaped; public-root export fixture.
- **workflow-engine — manager surface**: one runtime fixture per existing event name with exact
  payload keys; root `scope === runId`; automatic pause variants carry the matching context and
  `errorRecord`; manual pause stays minimal apart from additive `scope`; `error` remains live
  listener-gated but is durably recorded with zero listeners; custom string events and throwing
  listeners retain current behavior; compile fixtures cover all six typed EventEmitter methods and
  their arbitrary-event fallbacks.
- **workflow-engine — persistence**: fresh snapshot has a valid stream ID and watermark 0; dense
  sequences across concurrent agent completion, pause/resume, stop followed by a live-only
  post-release error, and cold manager restart retain that stream ID; a post-release settlement
  performs neither an append nor a stale snapshot rewrite;
  cached agent replay appends fresh `agentStart` → `callRecord(origin: "journal-replay")` →
  `agentEnd` records for the same `(scope, callIndex)` but no `journal`; cached and injected
  checkpoint replay appends only its fresh `callRecord` on the manager event surface;
  stopping a warm paused run reacquires/revalidates the lease and loses cleanly to a competing
  resume; startup stale recovery skips a live leased writer and, after acquiring a stale run's
  lease, re-loads before its snapshot-only pause save; record append precedes listener delivery;
  snapshot `(streamId: S, eventSeq: N)` plus read-after-N pinned to S has neither gaps nor
  duplicates; log-ahead snapshot succeeds;
  snapshot-ahead log fails; sequence mismatch,
  missing/malformed/mismatched stream IDs, unknown version, corrupt terminated line,
  orphan/unknown run, legacy unavailable, invalid cursor/limit/stream ID, cursor ahead, and I/O
  errors produce the exact `RunEventLogError.code`.
- **workflow-engine — crash/tail**: inject a half-written last line, prove reads ignore it and the
  leased next writer truncates/reuses its sequence; an invalid LF-terminated line is never ignored;
  concurrent readers see only complete lines; a watcher drains backlog, survives coalesced
  notifications via the recovery poll, follows resume appends, supports `close()`/`return()`/abort,
  rejects concurrent `next()`, and releases every watcher/timer. A watcher pins its stream ID: an
  injected sidecar-before-snapshot deletion window fails `SNAPSHOT_AHEAD`, and delete plus immediate
  same-`runId` recreation fails `STREAM_MISMATCH` rather than yielding the new stream. No test
  sleeps on timing alone; file-change and fake-clock seams drive it deterministically.
- **workflow-engine — redaction/volume**: credential assignments, bearer/basic auth, URL userinfo,
  JWTs, known key prefixes, PEM keys, opaque tokens, sensitive object keys, config-option secrets,
  checkpoint defaults, results, recorded-error details, and both agent-end/call-record provenance
  strings are absent from raw event-file bytes;
  live emitter payloads retain their originals. UTF-8 caps do not split code points; depth/array/key
  limits and projection flags are exact; maximum-cardinality ordinary-text fixtures for every
  event variant fit the cap. A fixture whose JSON escaping pushes the projected line over the cap,
  and an injected projector failure, mark the snapshot incomplete, stop later appends, keep the
  workflow outcome, and make reads fail closed.
- **workflow-engine — nested scope**: child log/phase/token callbacks receive child scope; child
  agent/journal/call-record rows enter only the parent event file with parent `runId` and child
  `scope`; no child sidecar is created; root-only snapshot journal/manifest filtering is unchanged;
  two sequential children remain distinct.
- **acp-agents**: `RunOptions.callIndex` reaches `session_open`, every real ACP session-update
  discriminant, permission pending/final, elicitation pending/final/complete, raw message, late
  tombstone-routed event, and `session_close`; it is identical across events for one session and
  across retries of one engine call. Direct runner calls and interactive sessions without a value
  omit it; `backend_error` remains context-less. Assert it is absent from ACP request `_meta` and
  session IDs.
- **workflows**: `WorkflowAgentEvent` maps every runtime-emitted name—every `AcpUpdateKind` plus
  every ACP cross-cutting name—exactly, and a compile guard proves `session_update` is excluded;
  the existing completeness guard grows to cover `callIndex`. Both per-update and cross-cutting
  bridge paths repeat `callIndex`/`scope`; backend errors omit them; SDK manager EventEmitter
  overloads infer the exact nested ACP update type; a compatibility compile fixture proves the
  already-public `AgentEventPayload<"session_update">` and default `AgentEventPayload` still
  resolve even though neither is used by the exact manager union; no `agentEvent` line appears in
  the default durable log.
- **agentprism-otel**: replace hand-rolled run payload casts with `EngineRunEventPayloadMap` type
  selections; keep the public structural `WorkflowManagerLike` and every currently exported
  payload-type name (compile fixture imports each by name); duplicate labels in flight pair by
  `(scope, callIndex)` when present with the legacy label queue only as a compatibility fallback;
  tool spans consume direct ACP `callIndex`; all existing no-content/capture-content and detach
  tests stay green.
- **mcp-server**: an awaited background run with a progress token emits monotonic distinct-ended /
  distinct-started counts from the snapshot plus post-watermark tail; late attach, duplicate
  terminal callbacks, nested scopes, and pause/resume do not double-count. No token sends no
  notification. The initial
  background-start request never sends after returning. Await cancellation closes the watcher but
  not the run. A local promise still settles promptly while tail progress remains active. Legacy,
  missing/mismatched-stream, corrupt, and incomplete logs fall back to the 250 ms inspection poll
  without notifications even when a token is present. Foreground progress and all inspect/await
  structured results remain pinned.
- **retention/compatibility**: old run fixture lists/inspects/resumes unchanged; event reads report
  unavailable until a new execution suffix; `.events.jsonl` never appears in `list()`; direct and
  manager deletion remove it; running local deletion cannot be resurrected by a late callback;
  deletion loses cleanly to a writer in another process; an instrumented deletion proves
  sidecar-before-snapshot and lock-last ordering so immediate run-ID reuse cannot lose the new
  run's files or let an old cursor/watch enter its stream; isolation report attachment reacquires
  the lease and either saves onto the freshly reloaded artifact or records
  `report-persistence-failed` after a concurrent deletion, never recreating the file; no
  rotation/TTL occurs; a custom structural `RunPersistence` fixture
  compiles unchanged, receives a sidecar through its `getRunsDir()`, and exercises the documented
  save/delete-under-lease precondition. A complete legacy object annotated as `FsLayer` and
  omitting all six new optional hooks also compiles and falls back to the real `node:fs` hooks.

## 6. Docs & skill updates

- `docs/api.md`: public `RunEvent`/payload-map imports, the event policy table, snapshot-plus-tail
  example, all `RunEventLogErrorCode` values with remedies, redaction/size/retention rules, nested
  `scope`, the exactly-one-writer precondition, and delete-under-lease ordering.
- `docs/design-notes.md`: append-before-watermark rationale, event-stream generation pinning across
  delete/recreate, separate snapshot/log authority, why ACP transcript traffic is relay-only, and a
  note that the writer's one open/write/verify/close syscall sequence per persisted event is a
  deliberate simplicity-over-throughput choice sized for the lifecycle-only default policy — a
  future high-frequency opt-in must revisit it rather than inherit it unexamined.
- `docs/roadmap/run-events.md` (and its `ROADMAP.md` index row): mark the contract frozen and, as
  implementation lands, track the staged rollout against this spec.
- `packages/workflow-engine/README.md`: default file layout and read/watch API.
- `packages/acp-agents/README.md`: `AcpEventContext.callIndex`, its optionality, and the no-wire rule.
- `packages/workflows/README.md`: typed SDK manager example for engine events and ACP
  `agentEvent`, including direct `(scope, callIndex)` filtering.
- `packages/agentprism-otel/README.md`: note direct event-contract consumption and retained
  structural attachment API.
- `skills/agentprism-workflow-authoring/SKILL.md` and `reference.md`: change only the host-call
  guidance—background starts still have no enduring request channel, while a later bounded await
  can stream coarse progress when it carries a progress token. There is no new workflow DSL.
- Regenerate `packages/mcp-server/src/generated/authoring-prompt-content.ts` with
  `scripts/generate-authoring-prompt.mjs` and extend its drift/sentinel test for the corrected
  background/await progress wording.

## 7. Implementation breakdown

Five sequential, independently green PRs:

1. **PR1 — shared event types + ACP correlation (M).** Add
   `packages/shared-types/src/run-events.ts` and its root export; thread optional `callIndex` through
   acp-agents `events.ts`, `runner.ts`, `acp-client.ts`, and session/tombstone tests; specialize and
   re-export the SDK branch in `packages/workflows/src/index.ts`. No persistence behavior yet.
2. **PR2 — event persistence substrate (L).** In workflow-engine `run-observability.ts` and
   `run-persistence.ts`, add the projector, JSONL reader/writer, partial-line repair, error
   class/codes, stream-generation pinning, pull-based watcher, `RunEventPersistence`/
   `withRunEvents`, default deletion, and isolated persistence/redaction/watch tests. The
   substrate is complete and usable directly before manager integration; no stub APIs.
3. **PR3 — manager publication + watermarks (L).** In `workflow.ts` and `workflow-manager.ts`,
   centralize live event construction, add typed overloads and callback `scope`, integrate policy/
   stream-ID/sequence/watermark/incomplete markers at every manager hook, handle resume tail
   validation, and make every managed save lease-conditional and `deleteRun()` lease-protected;
   pin nested/crash/ordering/deletion behavior. Update `isolation.ts`'s post-terminal report attachment to
   reacquire/reload/save/release under the same lease. Existing manager tests run unchanged plus
   the new matrix.
4. **PR4 — consumers (M).** Migrate agentprism-otel `types.ts`/`attach.ts` to the shared contract
   and direct call correlation; replace MCP `server.ts`/`progress.ts` await polling with tail-first
   settlement/progress plus the explicit legacy/error fallback; add package tests. No library wire
   is introduced.
5. **PR5 — docs, skill, generated prompt, and release (S).** Complete the §6 sweep, update the
   roadmap item, regenerate the MCP prompt, add drift sentinels, and land coordinated Changesets
   with the semver table in §4.
