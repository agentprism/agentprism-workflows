import type {
  AgentResultProvenance,
  AgentUsage,
  AuthErrorContext,
  CheckpointContext,
  JournalEntry,
  PersistableEngineRunEvent,
  PersistedRunEvent,
  RunEventCheckpointProjection,
  RunEventErrorProjection,
  RunEventLogRecord,
  RunEventValueProjection,
  TokenUsage,
  WorkflowCallRecord,
  WorkflowLogTail,
  WorkflowRecordedError,
  WorkflowRunCallStatus,
  WorkflowRunInspectionOptions,
  WorkflowRunLimits,
  WorkflowRunStatus,
  WorkflowReplayEligibility,
} from "@automatalabs/shared-types";
import type { WorkflowErrorCode } from "./errors.js";
import type { RunStatus } from "./run-persistence.js";

export const MAX_STRUCTURED_STATUS_BYTES = 24_576;
export const MAX_OBSERVABILITY_SCALAR_BYTES = 512;
const MAX_PHASES = 64;
const MAX_RESULT_DEPTH = 4;
const MAX_ARRAY_ITEMS = 10;
const MAX_OBJECT_KEYS = 20;
const TRUNCATED_SUFFIX = "…[truncated]";

export interface RunObservabilitySource {
  runId: string;
  status: RunStatus;
  workflowName: string;
  phases: string[];
  currentPhase?: string;
  reason?: string;
  errorCode?: WorkflowErrorCode;
  logs: string[];
  journal: JournalEntry[];
  agents?: RunObservabilityAgent[];
  limits?: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
}

export interface RunObservabilityAgent {
  label: string;
  phase?: string;
  model?: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  callIndex?: number;
  scope?: string;
  timeoutMs?: number | null;
  idleTimeoutMs?: number | null;
  errorCode?: WorkflowErrorCode;
}

interface SanitizedText {
  value: string;
  redacted: boolean;
  truncated: boolean;
}

interface CompactState {
  redacted: boolean;
  truncated: boolean;
}

const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "credential",
  "authorization",
  "cookie",
  "privatekey",
] as const;

const SENSITIVE_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|credential|authorization|cookie|private[_-]?key)[A-Za-z0-9_.-]*)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const PEM_PRIVATE_KEY = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const AUTH_CREDENTIAL = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const URL_USER_INFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const JWT = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
const KNOWN_CREDENTIAL =
  /(?<![A-Za-z0-9_-])(?:github_pat_|sk-proj-|ghp_|gho_|ghu_|ghs_|xoxb-|xoxp-|sk-|AKIA|ASIA)[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
const OPAQUE_TOKEN =
  /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-]))(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;

function replaceAndTrack(value: string, pattern: RegExp, replacement: string | ((...args: string[]) => string)) {
  let changed = false;
  const output = value.replace(pattern, (...args: string[]) => {
    changed = true;
    return typeof replacement === "string" ? replacement : replacement(...args);
  });
  return { output, changed };
}

/** Redact credential-shaped text without offering a raw escape hatch. */
export function redactText(value: string): { value: string; redacted: boolean } {
  let output = value;
  let redacted = false;
  const apply = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    const result = replaceAndTrack(output, pattern, replacement);
    output = result.output;
    redacted ||= result.changed;
  };

  apply(PEM_PRIVATE_KEY, "[REDACTED]");
  apply(AUTH_CREDENTIAL, "[REDACTED]");
  apply(URL_USER_INFO, (_match, scheme) => `${scheme}[REDACTED]@`);
  apply(JWT, "[REDACTED]");
  apply(SENSITIVE_ASSIGNMENT, (_match, key, separator) => `${key}${separator}[REDACTED]`);
  apply(KNOWN_CREDENTIAL, "[REDACTED]");
  apply(OPAQUE_TOKEN, "[REDACTED]");
  return { value: output, redacted };
}

/** Shorten UTF-8 text without splitting a Unicode code point. */
export function truncateUtf8(value: string, maxBytes: number, suffix = TRUNCATED_SUFFIX): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes >= maxBytes) {
    let shortSuffix = "";
    for (const point of suffix) {
      if (Buffer.byteLength(shortSuffix + point, "utf8") > maxBytes) break;
      shortSuffix += point;
    }
    return shortSuffix;
  }
  let kept = "";
  for (const point of value) {
    if (Buffer.byteLength(kept + point, "utf8") + suffixBytes > maxBytes) break;
    kept += point;
  }
  return kept + suffix;
}

function sanitizeText(value: string): SanitizedText {
  const redacted = redactText(value);
  const shortened = truncateUtf8(redacted.value, MAX_OBSERVABILITY_SCALAR_BYTES);
  return {
    value: shortened,
    redacted: redacted.redacted,
    truncated: shortened !== redacted.value,
  };
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function compactJson(value: unknown, depth: number, state: CompactState): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const redacted = redactText(value);
    state.redacted ||= redacted.redacted;
    return redacted.value;
  }
  if (typeof value !== "object") return null;
  if (depth >= MAX_RESULT_DEPTH) {
    state.truncated = true;
    return "[max depth]";
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactJson(item, depth + 1, state));
    if (value.length > MAX_ARRAY_ITEMS) {
      state.truncated = true;
      kept.push(`[+${value.length - MAX_ARRAY_ITEMS} items omitted]`);
    }
    return kept;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
    const outwardKey = sanitizeText(key);
    state.redacted ||= outwardKey.redacted;
    state.truncated ||= outwardKey.truncated;
    if (Object.hasOwn(output, outwardKey.value)) {
      state.truncated = true;
      continue;
    }
    if (sensitiveKey(key)) {
      output[outwardKey.value] = "[REDACTED]";
      state.redacted = true;
    } else {
      output[outwardKey.value] = compactJson(child, depth + 1, state);
    }
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    const marker = `[+${entries.length - MAX_OBJECT_KEYS} items omitted]`;
    if (!Object.hasOwn(output, marker)) output[marker] = marker;
    state.truncated = true;
  }
  return output;
}

function resultPreview(value: unknown): Pick<WorkflowRunCallStatus, "resultPreview" | "resultRedacted" | "resultTruncated"> {
  const state: CompactState = { redacted: false, truncated: false };
  const compact = compactJson(value, 0, state);
  const serialized = JSON.stringify(compact) ?? "null";
  const preview = truncateUtf8(serialized, MAX_OBSERVABILITY_SCALAR_BYTES);
  return {
    resultPreview: preview,
    resultRedacted: state.redacted,
    resultTruncated: state.truncated || preview !== serialized,
  };
}

export function normalizeInspectionOptions(options: WorkflowRunInspectionOptions = {}): Required<
  Pick<WorkflowRunInspectionOptions, "lastN" | "logLines">
> &
  Pick<WorkflowRunInspectionOptions, "labelGlob"> {
  const lastN = options.lastN ?? 20;
  const logLines = options.logLines ?? 20;
  if (!Number.isInteger(lastN) || lastN < 1 || lastN > 50) {
    throw new RangeError("lastN must be an integer from 1 through 50");
  }
  if (!Number.isInteger(logLines) || logLines < 0 || logLines > 50) {
    throw new RangeError("logLines must be an integer from 0 through 50");
  }
  if (options.labelGlob !== undefined) {
    const length = [...options.labelGlob].length;
    if (length === 0 || length > 128) {
      throw new RangeError("labelGlob must contain from 1 through 128 Unicode code points");
    }
  }
  return { lastN, logLines, labelGlob: options.labelGlob };
}

type GlobToken = { kind: "star" } | { kind: "one" } | { kind: "literal"; value: string };

function globTokens(pattern: string): GlobToken[] {
  const points = [...pattern];
  const tokens: GlobToken[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    if (point === "*") tokens.push({ kind: "star" });
    else if (point === "?") tokens.push({ kind: "one" });
    else if (point === "\\") {
      const escaped = points[index + 1];
      if (escaped === undefined) tokens.push({ kind: "literal", value: "\\" });
      else {
        tokens.push({ kind: "literal", value: escaped });
        index++;
      }
    } else tokens.push({ kind: "literal", value: point });
  }
  return tokens;
}

/** Case-sensitive whole-label glob matching implemented with dynamic programming. */
export function matchesLabelGlob(label: string, pattern: string): boolean {
  const labelPoints = [...label];
  const tokens = globTokens(pattern);
  let previous = new Array<boolean>(labelPoints.length + 1).fill(false);
  previous[0] = true;
  for (const token of tokens) {
    const current = new Array<boolean>(labelPoints.length + 1).fill(false);
    if (token.kind === "star") {
      current[0] = previous[0]!;
      for (let index = 1; index <= labelPoints.length; index++) {
        current[index] = previous[index]! || current[index - 1]!;
      }
    } else {
      for (let index = 1; index <= labelPoints.length; index++) {
        current[index] =
          previous[index - 1]! && (token.kind === "one" || token.value === labelPoints[index - 1]);
      }
    }
    previous = current;
  }
  return previous[labelPoints.length]!;
}

function callStatus(entry: JournalEntry, agent?: RunObservabilityAgent): WorkflowRunCallStatus {
  const metadata = entry.call;
  let kind: WorkflowRunCallStatus["kind"] = "unknown";
  let label: string | undefined;
  let phase: string | undefined;
  let model: string | undefined;
  let backendId: string | undefined;
  if (metadata?.kind === "agent") {
    kind = "agent";
    label = metadata.label;
    phase = metadata.phase;
    model = metadata.model;
    backendId = metadata.backendId;
  } else if (metadata?.kind === "checkpoint") {
    kind = "checkpoint";
    label = metadata.label;
    phase = metadata.phase;
  } else if (entry.session) {
    kind = "agent";
    label = entry.session.label;
    phase = entry.session.phase;
    backendId = entry.session.backendId;
  }

  const scalar = (value: string | undefined) => (value === undefined ? undefined : sanitizeText(value).value);
  return {
    index: entry.index,
    kind,
    ...(label === undefined ? {} : { label: scalar(label) }),
    ...(phase === undefined ? {} : { phase: scalar(phase) }),
    ...(model === undefined ? {} : { model: scalar(model) }),
    ...(backendId === undefined ? {} : { backendId: scalar(backendId) }),
    ...(agent?.timeoutMs === undefined ? {} : { timeoutMs: agent.timeoutMs }),
    ...(agent?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: agent.idleTimeoutMs }),
    ...(agent?.errorCode === undefined ? {} : { errorCode: agent.errorCode }),
    ...resultPreview(entry.result),
  };
}

function agentCallStatus(agent: RunObservabilityAgent): WorkflowRunCallStatus {
  const scalar = (value: string | undefined) => (value === undefined ? undefined : sanitizeText(value).value);
  return {
    index: agent.callIndex!,
    kind: "agent",
    label: sanitizeText(agent.label).value,
    ...(agent.phase === undefined ? {} : { phase: scalar(agent.phase) }),
    ...(agent.model === undefined ? {} : { model: scalar(agent.model) }),
    ...(agent.timeoutMs === undefined ? {} : { timeoutMs: agent.timeoutMs }),
    ...(agent.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: agent.idleTimeoutMs }),
    ...(agent.errorCode === undefined ? {} : { errorCode: agent.errorCode }),
    ...(agent.status === "queued" || agent.status === "running" ? { status: agent.status } : {}),
    ...resultPreview(null),
  };
}

function filterLabel(entry: JournalEntry): string | undefined {
  if (entry.call?.kind === "agent") return entry.call.label;
  return entry.call === undefined ? entry.session?.label : undefined;
}

function scopedCallKey(scope: string, index: number): string {
  return `${scope}\u0000${index}`;
}

export function createWorkflowLogTail(logs: string[], logLines = 20): WorkflowLogTail {
  const selected = logLines === 0 ? [] : logs.slice(-logLines);
  const sanitized = selected.map(sanitizeText);
  return {
    lines: sanitized.map((line) => line.value),
    totalLines: logs.length,
    omittedLines: logs.length - sanitized.length,
    truncatedLines: sanitized.filter((line) => line.truncated).length,
    redactedLines: sanitized.filter((line) => line.redacted).length,
  };
}

function structuredBytes(status: WorkflowRunStatus): number {
  return Buffer.byteLength(JSON.stringify(status), "utf8");
}

/** Build the safe allowlisted, bounded point-in-time run projection. */
export function projectWorkflowRunStatus(
  source: RunObservabilitySource,
  options: WorkflowRunInspectionOptions = {},
): WorkflowRunStatus {
  const filter = normalizeInspectionOptions(options);
  const agentsByCall = new Map<string, RunObservabilityAgent>();
  for (const agent of source.agents ?? []) {
    if (!Number.isSafeInteger(agent.callIndex) || (agent.callIndex ?? -1) < 0) {
      continue;
    }
    agentsByCall.set(scopedCallKey(agent.scope ?? source.runId, agent.callIndex!), agent);
  }
  const journalCalls = new Set(
    source.journal.map((entry) => scopedCallKey(entry.scope ?? source.runId, entry.index)),
  );
  const callRows = source.journal.map((entry) => ({
    label: filterLabel(entry),
    status: callStatus(
      entry,
      agentsByCall.get(scopedCallKey(entry.scope ?? source.runId, entry.index)),
    ),
  }));
  // In-flight rows are only projected while the run itself is live: a persisted "running"
  // agent row on a dead/failed/paused run is stale, not an active call.
  const runIsLive = source.status === "pending" || source.status === "running";
  for (const [key, agent] of agentsByCall) {
    // Successful calls already have journal rows. Failed calls intentionally do not, so project
    // their terminal agent row to keep recoverable failures such as AGENT_TIMEOUT inspectable.
    // Queued/running calls have no journal row yet either — project them on live runs so
    // inspection reflects the agents actually in flight instead of reporting zero calls.
    if (journalCalls.has(key)) continue;
    if (agent.status === "error" || (runIsLive && (agent.status === "queued" || agent.status === "running"))) {
      callRows.push({ label: agent.label, status: agentCallStatus(agent) });
    }
  }
  const allCalls = callRows.sort((left, right) => left.status.index - right.status.index);
  const matchedCalls = allCalls.filter((call) =>
    filter.labelGlob === undefined ||
    (call.label !== undefined && matchesLabelGlob(call.label, filter.labelGlob))
  );
  const selectedCalls = matchedCalls.slice(-filter.lastN);
  const phaseSource = source.phases.slice(-MAX_PHASES).map(sanitizeText);
  let phases = phaseSource.map((phase) => phase.value);
  const logSource = (filter.logLines === 0 ? [] : source.logs.slice(-filter.logLines)).map(sanitizeText);
  let logs = logSource.map((line) => line.value);
  let calls = selectedCalls.map((call) => call.status);

  const status: WorkflowRunStatus = {
    runId: sanitizeText(source.runId).value,
    status: source.status,
    workflowName: sanitizeText(source.workflowName).value,
    phases,
    ...(source.currentPhase === undefined ? {} : { currentPhase: sanitizeText(source.currentPhase).value }),
    ...(source.reason === undefined ? {} : { reason: sanitizeText(source.reason).value }),
    ...(source.errorCode === undefined ? {} : { errorCode: source.errorCode }),
    ...(source.limits === undefined
      ? {}
      : { limits: { ...source.limits, agentIdleTimeoutMs: source.limits.agentIdleTimeoutMs ?? null } }),
    ...(source.replayEligibility === undefined
      ? {}
      : { replayEligibility: source.replayEligibility }),
    logTail: {
      lines: logs,
      totalLines: source.logs.length,
      omittedLines: source.logs.length - logs.length,
      truncatedLines: logSource.filter((line) => line.truncated).length,
      redactedLines: logSource.filter((line) => line.redacted).length,
    },
    calls,
    filter: {
      lastN: filter.lastN,
      logLines: filter.logLines,
      ...(filter.labelGlob === undefined ? {} : { labelGlob: sanitizeText(filter.labelGlob).value }),
    },
    truncation: {
      maxStructuredBytes: MAX_STRUCTURED_STATUS_BYTES,
      byteCapApplied: false,
      phases: {
        total: source.phases.length,
        returned: phases.length,
        shortened: phaseSource.filter((phase) => phase.truncated).length,
      },
      logs: {
        total: source.logs.length,
        returned: logs.length,
        shortened: logSource.filter((line) => line.truncated).length,
        redacted: logSource.filter((line) => line.redacted).length,
      },
      calls: {
        total: allCalls.length,
        matched: matchedCalls.length,
        returned: calls.length,
        shortenedResults: calls.filter((call) => call.resultTruncated).length,
        redactedResults: calls.filter((call) => call.resultRedacted).length,
      },
    },
  };

  const refreshCounters = () => {
    status.phases = phases;
    status.logTail.lines = logs;
    status.logTail.omittedLines = source.logs.length - logs.length;
    status.logTail.truncatedLines = logSource.slice(logSource.length - logs.length).filter((line) => line.truncated).length;
    status.logTail.redactedLines = logSource.slice(logSource.length - logs.length).filter((line) => line.redacted).length;
    status.calls = calls;
    status.truncation.phases.returned = phases.length;
    status.truncation.phases.shortened = phaseSource
      .slice(phaseSource.length - phases.length)
      .filter((phase) => phase.truncated).length;
    status.truncation.logs.returned = logs.length;
    status.truncation.logs.shortened = status.logTail.truncatedLines;
    status.truncation.logs.redacted = status.logTail.redactedLines;
    status.truncation.calls.returned = calls.length;
    status.truncation.calls.shortenedResults = calls.filter((call) => call.resultTruncated).length;
    status.truncation.calls.redactedResults = calls.filter((call) => call.resultRedacted).length;
  };

  if (structuredBytes(status) > MAX_STRUCTURED_STATUS_BYTES) {
    status.truncation.byteCapApplied = true;
    while (calls.length > 0 && structuredBytes(status) > MAX_STRUCTURED_STATUS_BYTES) {
      calls = calls.slice(1);
      refreshCounters();
    }
    while (logs.length > 0 && structuredBytes(status) > MAX_STRUCTURED_STATUS_BYTES) {
      logs = logs.slice(1);
      refreshCounters();
    }
    while (phases.length > 0 && structuredBytes(status) > MAX_STRUCTURED_STATUS_BYTES) {
      phases = phases.slice(1);
      refreshCounters();
    }
    if (structuredBytes(status) > MAX_STRUCTURED_STATUS_BYTES) {
      delete status.reason;
      delete status.errorCode;
      delete status.currentPhase;
    }
  }
  return status;
}

interface RunEventProjectionState {
  redacted: boolean;
  truncated: boolean;
}

function projectText(value: string, state: RunEventProjectionState): string {
  const projected = sanitizeText(value);
  state.redacted ||= projected.redacted;
  state.truncated ||= projected.truncated;
  return projected.value;
}

function projectValue(value: unknown, state: RunEventProjectionState): RunEventValueProjection {
  const compactState: CompactState = { redacted: false, truncated: false };
  const compact = compactJson(value, 0, compactState);
  const serialized = JSON.stringify(compact) ?? "null";
  const preview = truncateUtf8(serialized, MAX_OBSERVABILITY_SCALAR_BYTES);
  const projection = {
    preview,
    redacted: compactState.redacted,
    truncated: compactState.truncated || preview !== serialized,
  };
  state.redacted ||= projection.redacted;
  state.truncated ||= projection.truncated;
  return projection;
}

function projectAgentUsage(usage: AgentUsage): AgentUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.total,
    cost: usage.cost,
  };
}

function projectTokenUsage(usage: TokenUsage): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cost: usage.cost,
    ...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
  };
}

function projectProvenance(
  provenance: AgentResultProvenance,
  state: RunEventProjectionState,
): AgentResultProvenance {
  if (provenance.source === "live") {
    return {
      source: "live",
      ...(provenance.overrideModel === undefined
        ? {}
        : { overrideModel: projectText(provenance.overrideModel, state) }),
      ...(provenance.continuation === undefined
        ? {}
        : { continuation: provenance.continuation }),
    };
  }
  return {
    source: "replay",
    ...(provenance.recordedRunId === undefined
      ? {}
      : { recordedRunId: projectText(provenance.recordedRunId, state) }),
    ...(provenance.recordedIndex === undefined ? {} : { recordedIndex: provenance.recordedIndex }),
    ...(provenance.hashMatched === undefined ? {} : { hashMatched: provenance.hashMatched }),
  };
}

function projectAuthContext(
  context: AuthErrorContext,
  state: RunEventProjectionState,
): AuthErrorContext {
  const methods = context.methods.slice(0, MAX_OBJECT_KEYS).map((method) => ({
    id: projectText(method.id, state),
    type: method.type,
    ...(method.name === undefined ? {} : { name: projectText(method.name, state) }),
  }));
  state.truncated ||= context.methods.length > MAX_OBJECT_KEYS;
  return {
    ...(context.backendId === undefined ? {} : { backendId: projectText(context.backendId, state) }),
    methods,
  };
}

function projectCheckpointContext(
  context: CheckpointContext,
  state: RunEventProjectionState,
): RunEventCheckpointProjection {
  const choices = context.choices?.slice(0, MAX_OBJECT_KEYS).map((choice) => projectText(choice, state));
  state.truncated ||= (context.choices?.length ?? 0) > MAX_OBJECT_KEYS;
  return {
    callIndex: context.callIndex,
    hash: context.hash,
    prompt: projectText(context.prompt, state),
    kind: context.kind,
    ...(choices === undefined ? {} : { choices }),
    ...(context.default === undefined ? {} : { default: projectValue(context.default, state) }),
    ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
  };
}

function projectRecordedError(
  error: WorkflowRecordedError,
  state: RunEventProjectionState,
): RunEventErrorProjection {
  return {
    form: error.form,
    ...(error.name === undefined ? {} : { name: projectText(error.name, state) }),
    ...(error.message === undefined ? {} : { message: projectText(error.message, state) }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.recoverable === undefined ? {} : { recoverable: error.recoverable }),
    ...(error.agentLabel === undefined ? {} : { agentLabel: projectText(error.agentLabel, state) }),
    ...(error.details === undefined ? {} : { details: projectValue(error.details, state) }),
    ...(error.resetHint === undefined ? {} : { resetHint: projectText(error.resetHint, state) }),
    ...(error.providerUsageLimitContext === undefined
      ? {}
      : {
          providerUsageLimitContext: {
            backendId: projectText(error.providerUsageLimitContext.backendId, state),
            source: error.providerUsageLimitContext.source,
            ...(error.providerUsageLimitContext.providerCode === undefined
              ? {}
              : { providerCode: projectText(error.providerUsageLimitContext.providerCode, state) }),
            ...(error.providerUsageLimitContext.resetAt === undefined
              ? {}
              : { resetAt: projectText(error.providerUsageLimitContext.resetAt, state) }),
          },
        }),
    ...(error.authContext === undefined ? {} : { authContext: projectAuthContext(error.authContext, state) }),
    ...(error.checkpointContext === undefined
      ? {}
      : { checkpointContext: projectCheckpointContext(error.checkpointContext, state) }),
    ...(error.props === undefined ? {} : { props: projectValue(error.props, state) }),
    ...(error.value === undefined ? {} : { value: projectValue(error.value, state) }),
    ...(error.lossy === undefined ? {} : { lossy: error.lossy }),
  };
}

function projectConfigOptions(
  options: Record<string, string | boolean>,
  state: RunEventProjectionState,
): Record<string, string | boolean> {
  const entries = Object.entries(options).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  state.truncated ||= entries.length > MAX_OBJECT_KEYS;
  const projected: Record<string, string | boolean> = {};
  for (const [key, value] of entries.slice(0, MAX_OBJECT_KEYS)) {
    const projectedKey = projectText(key, state);
    if (Object.hasOwn(projected, projectedKey)) {
      state.truncated = true;
      continue;
    }
    if (sensitiveKey(key)) {
      projected[projectedKey] = "[REDACTED]";
      state.redacted = true;
    } else {
      projected[projectedKey] = typeof value === "string" ? projectText(value, state) : value;
    }
  }
  return projected;
}

function projectCallRecord(
  record: WorkflowCallRecord,
  state: RunEventProjectionState,
): Extract<PersistedRunEvent, { type: "callRecord" }>["record"] {
  return {
    index: record.index,
    kind: record.kind,
    hash: record.hash,
    ...(record.path === undefined ? {} : { path: projectText(record.path, state) }),
    ...(record.inputsHash === undefined ? {} : { inputsHash: record.inputsHash }),
    ...(record.label === undefined ? {} : { label: projectText(record.label, state) }),
    outcome: record.outcome,
    origin: record.origin,
    ...(record.error === undefined ? {} : { error: projectRecordedError(record.error, state) }),
    ...(record.aborted === undefined ? {} : { aborted: record.aborted }),
    ...(record.attempts === undefined ? {} : { attempts: record.attempts }),
    ...(record.usage === undefined ? {} : { usage: projectAgentUsage(record.usage) }),
    ...(record.modelRequested === undefined
      ? {}
      : { modelRequested: projectText(record.modelRequested, state) }),
    ...(record.modelResolved === undefined
      ? {}
      : { modelResolved: projectText(record.modelResolved, state) }),
    ...(record.backendId === undefined ? {} : { backendId: projectText(record.backendId, state) }),
    ...(record.modelFallback === undefined ? {} : { modelFallback: record.modelFallback }),
    ...(record.worktree === undefined ? {} : { worktree: record.worktree }),
    ...(record.isolation === undefined ? {} : { isolation: record.isolation }),
    ...(record.resolvedCwd === undefined ? {} : { resolvedCwd: projectText(record.resolvedCwd, state) }),
    ...(record.budgetDebit === undefined ? {} : { budgetDebit: record.budgetDebit }),
    ...(record.settlementOrdinal === undefined ? {} : { settlementOrdinal: record.settlementOrdinal }),
    ...(record.provenance === undefined ? {} : { provenance: projectProvenance(record.provenance, state) }),
    ...(record.scope === undefined ? {} : { scope: projectText(record.scope, state) }),
  };
}

function projectOrigin(event: PersistableEngineRunEvent, state: RunEventProjectionState) {
  return {
    runId: projectText(event.runId, state),
    scope: projectText(event.scope, state),
  };
}

/** Build the bounded, redacted record body written to a structured run-event log. */
export function projectRunEventForPersistence(
  event: PersistableEngineRunEvent,
): Omit<RunEventLogRecord, "streamId" | "seq" | "timestamp"> {
  const state: RunEventProjectionState = { redacted: false, truncated: false };
  const runId = projectText(event.runId, state);
  const origin = () => projectOrigin(event, state);
  let projected: PersistedRunEvent;

  switch (event.type) {
    case "log":
      projected = { type: "log", ...origin(), message: projectText(event.message, state) };
      break;
    case "phase":
      projected = { type: "phase", ...origin(), title: projectText(event.title, state) };
      break;
    case "agentStart":
      projected = {
        type: "agentStart",
        ...origin(),
        label: projectText(event.label, state),
        ...(event.phase === undefined ? {} : { phase: projectText(event.phase, state) }),
        prompt: projectText(event.prompt, state),
        ...(event.model === undefined ? {} : { model: projectText(event.model, state) }),
        ...(event.configOptions === undefined
          ? {}
          : { configOptions: projectConfigOptions(event.configOptions, state) }),
        ...(event.timeoutMs === undefined ? {} : { timeoutMs: event.timeoutMs }),
        ...(event.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: event.idleTimeoutMs }),
        callIndex: event.callIndex,
        // Never truncated: a partial call-path key is worse than none for consumers that
        // join on it, so an oversized capture is dropped instead of projected.
        ...(event.path === undefined || Buffer.byteLength(event.path, "utf8") > MAX_OBSERVABILITY_SCALAR_BYTES
          ? {}
          : { path: event.path }),
      };
      break;
    case "agentProgress":
      projected = {
        type: "agentProgress",
        ...origin(),
        label: projectText(event.label, state),
        ...(event.phase === undefined ? {} : { phase: projectText(event.phase, state) }),
        callIndex: event.callIndex,
        executionStartSeq: event.executionStartSeq,
        turnCount: event.turnCount,
        observedEvents: event.observedEvents,
        coalescedEvents: event.coalescedEvents,
        cause: event.cause,
        ...(event.latestText === undefined ? {} : { latestText: projectText(event.latestText, state) }),
        ...(event.lastToolName === undefined ? {} : { lastToolName: projectText(event.lastToolName, state) }),
        ...(event.tokensObserved === undefined ? {} : { tokensObserved: event.tokensObserved }),
      };
      break;
    case "agentTranscript":
      projected = {
        type: "agentTranscript",
        ...origin(),
        label: projectText(event.label, state),
        ...(event.phase === undefined ? {} : { phase: projectText(event.phase, state) }),
        callIndex: event.callIndex,
        executionStartSeq: event.executionStartSeq,
        entryIndex: event.entryIndex,
        revision: event.revision,
        operation: "upsert",
        entry: event.entry.role === "assistant"
          ? {
              role: "assistant",
              kind: "text",
              text: projectText(event.entry.text, state),
              timestamp: event.entry.timestamp,
            }
          : event.entry.kind === "toolResult"
            ? {
                role: "tool",
                kind: "toolResult",
                text: projectText(event.entry.text, state),
                ...(event.entry.toolName === undefined
                  ? {}
                  : { toolName: projectText(event.entry.toolName, state) }),
                ...(event.entry.isError === true ? { isError: true } : {}),
                timestamp: event.entry.timestamp,
              }
            : {
                role: "tool",
                kind: "toolCall",
                text: projectText(event.entry.text, state),
                toolName: projectText(event.entry.toolName!, state),
                timestamp: event.entry.timestamp,
              },
      };
      break;
    case "agentEnd": {
      const modelFallbacks = event.modelFallbacks
        ?.slice(0, MAX_OBJECT_KEYS)
        .map((fallback) => projectText(fallback, state));
      state.truncated ||= (event.modelFallbacks?.length ?? 0) > MAX_OBJECT_KEYS;
      projected = {
        type: "agentEnd",
        ...origin(),
        label: projectText(event.label, state),
        ...(event.phase === undefined ? {} : { phase: projectText(event.phase, state) }),
        result: projectValue(event.result, state),
        ...(event.tokens === undefined ? {} : { tokens: event.tokens }),
        ...(event.worktree === undefined ? {} : { worktree: projectText(event.worktree, state) }),
        ...(event.model === undefined ? {} : { model: projectText(event.model, state) }),
        ...(event.error === undefined ? {} : { error: projectText(event.error, state) }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        ...(event.recoverable === undefined ? {} : { recoverable: event.recoverable }),
        callIndex: event.callIndex,
        ...(event.usage === undefined ? {} : { usage: projectAgentUsage(event.usage) }),
        ...(event.modelResolved === undefined
          ? {}
          : { modelResolved: projectText(event.modelResolved, state) }),
        ...(modelFallbacks === undefined ? {} : { modelFallbacks }),
        ...(event.backendId === undefined ? {} : { backendId: projectText(event.backendId, state) }),
        ...(event.provenance === undefined ? {} : { provenance: projectProvenance(event.provenance, state) }),
        ...(event.errorRecord === undefined
          ? {}
          : { errorRecord: projectRecordedError(event.errorRecord, state) }),
      };
      break;
    }
    case "tokenUsage":
      projected = { type: "tokenUsage", ...origin(), usage: projectTokenUsage(event.usage) };
      break;
    case "complete":
      projected = {
        type: "complete",
        ...origin(),
        summary: {
          status: "completed",
          workflowName: projectText(event.result.meta.name, state),
          agentCount: event.result.agentCount,
          durationMs: event.result.durationMs,
          phaseCount: event.result.phases.length,
          callCount: event.result.calls?.length ?? 0,
          ...(event.result.tokenUsage === undefined ? {} : { tokenUsage: projectTokenUsage(event.result.tokenUsage) }),
          result: projectValue(event.result.result, state),
        },
      };
      break;
    case "journal":
      projected = {
        type: "journal",
        ...origin(),
        entry: {
          index: event.entry.index,
          hash: event.entry.hash,
          result: projectValue(event.entry.result, state),
          ...(event.entry.call === undefined
            ? {}
            : event.entry.call.kind === "agent"
              ? {
                  call: {
                    kind: "agent" as const,
                    label: projectText(event.entry.call.label, state),
                    ...(event.entry.call.phase === undefined
                      ? {}
                      : { phase: projectText(event.entry.call.phase, state) }),
                    ...(event.entry.call.model === undefined
                      ? {}
                      : { model: projectText(event.entry.call.model, state) }),
                    ...(event.entry.call.backendId === undefined
                      ? {}
                      : { backendId: projectText(event.entry.call.backendId, state) }),
                    ...(event.entry.call.continuation === undefined
                      ? {}
                      : { continuation: event.entry.call.continuation }),
                  },
                }
              : {
                  call: {
                    kind: "checkpoint" as const,
                    label: projectText(event.entry.call.label, state) as "checkpoint",
                    ...(event.entry.call.phase === undefined
                      ? {}
                      : { phase: projectText(event.entry.call.phase, state) }),
                  },
                }),
          ...(event.entry.kind === undefined ? {} : { kind: event.entry.kind }),
          ...(event.entry.usage === undefined ? {} : { usage: projectAgentUsage(event.entry.usage) }),
          ...(event.entry.scope === undefined ? {} : { scope: projectText(event.entry.scope, state) }),
        },
      };
      break;
    case "callRecord":
      projected = { type: "callRecord", ...origin(), record: projectCallRecord(event.record, state) };
      break;
    case "paused":
      if (event.reason === undefined) {
        projected = { type: "paused", ...origin() };
      } else if (event.reason === "usage_limit") {
        projected = {
          type: "paused",
          ...origin(),
          reason: "usage_limit",
          errorRecord: projectRecordedError(event.errorRecord, state),
          ...(event.resetHint === undefined ? {} : { resetHint: projectText(event.resetHint, state) }),
        };
      } else if (event.reason === "auth_required") {
        projected = {
          type: "paused",
          ...origin(),
          reason: "auth_required",
          errorRecord: projectRecordedError(event.errorRecord, state),
          ...(event.authContext === undefined ? {} : { authContext: projectAuthContext(event.authContext, state) }),
        };
      } else {
        projected = {
          type: "paused",
          ...origin(),
          reason: "checkpoint_required",
          errorRecord: projectRecordedError(event.errorRecord, state),
          ...(event.checkpointContext === undefined
            ? {}
            : { checkpointContext: projectCheckpointContext(event.checkpointContext, state) }),
        };
      }
      break;
    case "error":
      projected = {
        type: "error",
        ...origin(),
        errorRecord: projectRecordedError(event.errorRecord, state),
      };
      break;
    case "stopped":
      projected = { type: "stopped", ...origin() };
      break;
    case "resumed":
      projected = { type: "resumed", ...origin() };
      break;
    default: {
      const exhaustive: never = event;
      throw new TypeError(`Unsupported run event ${(exhaustive as { type?: unknown }).type as string}`);
    }
  }

  return {
    version: 1,
    runId,
    event: projected,
    projection: { redacted: state.redacted, truncated: state.truncated },
  };
}
