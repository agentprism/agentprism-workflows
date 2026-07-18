// @automatalabs/workflow-engine — the lifted Pi engine, de-coupled from any agent
// backend. It NEVER imports @automatalabs/acp-agents; it references the backend ONLY
// through the injected AgentRunner seam from @automatalabs/shared-types.

// ── Engine entry ──
export {
  runWorkflow,
  parseWorkflowScript,
  hashCheckpointInputs,
  resolveAgentTimeoutMs,
  resolveWorkflowRunLimits,
  CALL_PATH_FORMAT,
  CALL_INPUTS_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  type EngineRunResult,
  type WorkflowRunLimitOptions,
  type WorkflowRunOptions,
  type WorkflowCallbackContext,
  type WorkflowAgentAttemptControl,
  type WorkflowAgentOptions,
  type AgentOptions,
  type CheckpointOptions,
  type CheckpointCallContext,
  type SharedRuntime,
} from "./workflow.js";

// ── Run manager + persistence ──
export {
  WorkflowManager,
  type WorkflowManagerOptions,
  type ExecOptions,
  type ManagedRun,
  type WorkflowAgentCallCancellation,
} from "./workflow-manager.js";
export {
  createRunPersistence,
  generateRunId,
  type RunPersistence,
  type RunLease,
  type RunStatus,
  type PersistedRunState,
  type PersistedAgentState,
  type PersistedResumeFormat,
  type PersistedResumeCandidate,
  type PersistedCheckpointInjection,
  type PersistedResumeSeed,
  type PersistedRunLineageTombstone,
  type FsLayer,
  type RunPersistenceOptions,
} from "./run-persistence.js";
export {
  RESUME_FALLBACK_REASONS,
  RESUME_DISABLED_REASONS,
  RESUME_CALL_LIVE_REASONS,
  RESUME_CALL_FAILED_REASONS,
  type PreparedResume,
  type PreparedContinuation,
  type ContinuationCandidate,
} from "./resume.js";
export {
  RUN_EVENT_MAX_RECORD_BYTES,
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RunEventLogError,
  withRunEvents,
  type AppendRunEventInput,
  type ReadRunEventsOptions,
  type ReadRunEventsResult,
  type RunEventLogErrorCode,
  type RunEventPersistence,
  type RunEventStream,
  type WatchRunEventsOptions,
} from "./run-event-persistence.js";

// ── Isolation mode ──
export {
  runIsolation,
  createReplayRunner,
  RECORDING_UNUSABLE_REASONS,
  REPLAY_DIVERGENCE_KINDS,
  type RunIsolationOptions,
  type IsolationRunResult,
  type ReplayRunnerOptions,
  type ResolvedIsolationTarget,
  type IsolationTarget,
  type ReplayRunner,
  type ReplayObservation,
  type ReplayReport,
  type ReplayCallReport,
  type ReplayDivergenceEvent,
} from "./isolation.js";

// ── Errors: the shared seam contract (re-exported) + engine-local helpers ──
export {
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
  isAuthRequired,
  wrapError,
  isAbortError,
  isTimeoutError,
  type WorkflowErrorOptions,
  type AuthErrorContext,
  type CheckpointContext,
  type ProviderUsageLimitContext,
} from "./errors.js";

// ── Config caps ──
export {
  MAX_AGENTS_PER_RUN,
  MAX_CONCURRENCY,
  MAX_AGENT_RETRIES,
  DEFAULT_AGENT_TIMEOUT_MS,
  AGENTS_DIR,
} from "./config.js";

// ── Model routing / tiers ──
export {
  parseModelRoutingFromMeta,
  resolveModelForPhase,
  type ModelRoute,
  type ModelRoutingConfig,
} from "./model-routing.js";
export {
  buildDefaultTierConfig,
  loadModelTierConfig,
  saveModelTierConfig,
  resolveTierModel,
  sortedTierNames,
  getModelTierConfigPath,
  type ModelTierConfig,
} from "./model-tier-config.js";

// ── Agent registry (parameterized agents dir) ──
export {
  loadAgentRegistry,
  resolveAgentType,
  parseAgentDefinition,
  applyToolPolicy,
  agentDefinitionKey,
  listAgentTypes,
  type AgentDefinition,
  type AgentRegistry,
} from "./agent-registry.js";

// ── Workflow directory view (folders of versioned workflow scripts) ──
export {
  openWorkflowDir,
  type WorkflowDir,
  type WorkflowDirEntry,
  type OpenWorkflowDirOptions,
} from "./workflow-dir.js";

// ── Frontmatter parser (engine-local; replaces Pi's parseFrontmatter) ──
export { parseFrontmatter } from "./frontmatter.js";

// ── Git worktree isolation ──
export { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

// ── Snapshot model + headless text rendering ──
export {
  preview,
  renderWorkflowText,
  renderWorkflowLines,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  statusIcon,
  shorten,
  type WorkflowSnapshot,
  type WorkflowAgentSnapshot,
  type WorkflowAgentStatus,
  type WorkflowDisplay,
  type WorkflowDisplayOptions,
  type ThemeLike,
} from "./display.js";

// ── Paths / logger ──
export {
  workflowProjectPaths,
  workflowHomeDir,
  workflowUserSavedDir,
  workflowProjectKey,
  AGENTPRISM_PERSISTENCE_ROOT_ENV,
  type WorkflowProjectPaths,
  type WorkflowPathOptions,
} from "./workflow-paths.js";
export { createWorkflowLogger, type WorkflowLogger, type WorkflowLoggerOptions } from "./logger.js";
export {
  MAX_OBSERVABILITY_SCALAR_BYTES,
  MAX_STRUCTURED_STATUS_BYTES,
  createWorkflowLogTail,
  matchesLabelGlob,
  normalizeInspectionOptions,
  projectRunEventForPersistence,
  projectWorkflowRunStatus,
  redactText,
  truncateUtf8,
  type RunObservabilitySource,
} from "./run-observability.js";

// ── Structured run-event contract ──
export {
  RUN_EVENT_LOG_VERSION,
  type EngineRunEvent,
  type EngineRunEventName,
  type EngineRunEventPayloadMap,
  type PersistableEngineRunEvent,
  type PersistedRunAgentEndPayload,
  type PersistedRunAuthPausedPayload,
  type PersistedRunCallRecord,
  type PersistedRunCallRecordPayload,
  type PersistedRunCheckpointPausedPayload,
  type PersistedRunCompletePayload,
  type PersistedRunCompleteSummary,
  type PersistedRunErrorPayload,
  type PersistedRunEvent,
  type PersistedRunJournalEntry,
  type PersistedRunJournalPayload,
  type PersistedRunPausedPayload,
  type PersistedRunUsageLimitPausedPayload,
  type RunAgentEndEvent,
  type RunAgentEndPayload,
  type RunAgentEventEvent,
  type RunAgentEventPayload,
  type RunAgentHistoryEvent,
  type RunAgentHistoryPayload,
  type RunAgentStartEvent,
  type RunAgentStartPayload,
  type RunAuthPausedPayload,
  type RunCallRecordEvent,
  type RunCallRecordPayload,
  type RunCheckpointPausedPayload,
  type RunCompleteEvent,
  type RunCompletePayload,
  type RunErrorEvent,
  type RunErrorPayload,
  type RunEvent,
  type RunEventCheckpointProjection,
  type RunEventErrorProjection,
  type RunEventLogRecord,
  type RunEventName,
  type RunEventOrigin,
  type RunEventPayload,
  type RunEventValueProjection,
  type RunJournalEvent,
  type RunJournalPayload,
  type RunLogEvent,
  type RunLogPayload,
  type RunManualPausedPayload,
  type RunPausedEvent,
  type RunPausedPayload,
  type RunPhaseEvent,
  type RunPhasePayload,
  type RunResumedEvent,
  type RunResumedPayload,
  type RunStoppedEvent,
  type RunStoppedPayload,
  type RunTokenUsageEvent,
  type RunTokenUsagePayload,
  type RunUsageLimitPausedPayload,
} from "@automatalabs/shared-types";

// ── Convenience re-exports of the shared seam + host-facing result types ──
export type {
  AgentRunner,
  RunOptions,
  AgentResult,
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  AgentResultProvenance,
  AgentHistoryEntry,
  WorkflowMeta,
  WorkflowMetaPhase,
  JournalEntry,
  JournalCallMetadata,
  WorkflowCallRecord,
  WorkflowLogTail,
  WorkflowRecordedError,
  WorkflowRunCallStatus,
  WorkflowRunInspectionOptions,
  WorkflowRunLimits,
  WorkflowRunStatus,
  WorkflowRunStatusTruncation,
  WorkflowRunResult,
  WorkflowRunFallback,
  WorkflowCheckpointSource,
  WorkflowCheckpointTaken,
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
  WorkflowReplayOperationalOption,
  WorkflowReplayOperationalChange,
  WorkflowReplayFirstNonReplay,
  WorkflowReplayEligibility,
  TokenUsage,
} from "@automatalabs/shared-types";
