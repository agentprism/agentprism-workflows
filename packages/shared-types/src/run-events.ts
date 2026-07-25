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
  /** Resolved total-wall-clock deadline for each attempt; null means uncapped. */
  timeoutMs?: number | null;
  callIndex: number;
  /** The structural call-path key (WorkflowCallRecord.path), when captured. */
  path?: string;
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

/** Coarse, content-bearing activity observed while an agent call is still running. */
export interface RunAgentProgressPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  callIndex: number;
  /** Sequence of the agentStart record that opened this execution. */
  executionStartSeq: number;
  turnCount: number;
  observedEvents: number;
  coalescedEvents: number;
  cause: "activity" | "heartbeat";
  latestText?: string;
  lastToolName?: string;
  tokensObserved?: number;
}

/** A durable, execution-partitioned in-flight transcript upsert. */
export interface RunAgentTranscriptPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  callIndex: number;
  /** Sequence of the agentStart record that opened this execution. */
  executionStartSeq: number;
  entryIndex: number;
  revision: number;
  operation: "upsert";
  entry: AgentHistoryEntry;
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
 * context envelope; @automatalabs/workflows binds Name/Event to AcpRunnerEventMap.
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
export type RunAgentProgressEvent = { type: "agentProgress" } & RunAgentProgressPayload;
export type RunAgentTranscriptEvent = { type: "agentTranscript" } & RunAgentTranscriptPayload;
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

/** Engine-manager events only; the SDK adds the specialized agentEvent branch. */
export type EngineRunEvent =
  | RunLogEvent
  | RunPhaseEvent
  | RunAgentStartEvent
  | RunAgentEndEvent
  | RunAgentHistoryEvent
  | RunAgentProgressEvent
  | RunAgentTranscriptEvent
  | RunTokenUsageEvent
  | RunCompleteEvent
  | RunJournalEvent
  | RunCallRecordEvent
  | RunPausedEvent
  | RunErrorEvent
  | RunStoppedEvent
  | RunResumedEvent;

/** Engine events admitted by the frozen persistence policy. */
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

export interface PersistedRunCallRecord extends Omit<WorkflowCallRecord, "error"> {
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
  | RunAgentProgressEvent
  | RunAgentTranscriptEvent
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
