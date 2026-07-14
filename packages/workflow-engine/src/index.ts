// @automatalabs/workflow-engine — the lifted Pi engine, de-coupled from any agent
// backend. It NEVER imports @automatalabs/acp-agents; it references the backend ONLY
// through the injected AgentRunner seam from @automatalabs/shared-types.

// ── Engine entry ──
export {
  runWorkflow,
  parseWorkflowScript,
  type EngineRunResult,
  type WorkflowRunOptions,
  type WorkflowAgentOptions,
  type AgentOptions,
  type CheckpointOptions,
  type SharedRuntime,
} from "./workflow.js";

// ── Run manager + persistence ──
export {
  WorkflowManager,
  type WorkflowManagerOptions,
  type ExecOptions,
  type ManagedRun,
} from "./workflow-manager.js";
export {
  createRunPersistence,
  generateRunId,
  type RunPersistence,
  type RunLease,
  type RunStatus,
  type PersistedRunState,
  type PersistedAgentState,
  type FsLayer,
  type RunPersistenceOptions,
} from "./run-persistence.js";

// ── Errors: the shared seam contract (re-exported) + engine-local helpers ──
export {
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
  isAuthRequired,
  classifyProviderLimit,
  wrapError,
  isAbortError,
  isTimeoutError,
  type WorkflowErrorOptions,
  type AuthErrorContext,
  type CheckpointContext,
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
  projectWorkflowRunStatus,
  redactText,
  truncateUtf8,
  type RunObservabilitySource,
} from "./run-observability.js";

// ── Convenience re-exports of the shared seam + host-facing result types ──
export type {
  AgentRunner,
  RunOptions,
  AgentResult,
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  AgentHistoryEntry,
  WorkflowMeta,
  WorkflowMetaPhase,
  JournalEntry,
  JournalCallMetadata,
  WorkflowLogTail,
  WorkflowRunCallStatus,
  WorkflowRunInspectionOptions,
  WorkflowRunStatus,
  WorkflowRunStatusTruncation,
  WorkflowRunResult,
  TokenUsage,
} from "@automatalabs/shared-types";
