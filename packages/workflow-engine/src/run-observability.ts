import type {
  JournalEntry,
  WorkflowLogTail,
  WorkflowRunCallStatus,
  WorkflowRunInspectionOptions,
  WorkflowRunStatus,
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
    if (sensitiveKey(key)) {
      output[outwardKey.value] = "[REDACTED]";
      state.redacted = true;
    } else {
      output[outwardKey.value] = compactJson(child, depth + 1, state);
    }
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    const marker = `[+${entries.length - MAX_OBJECT_KEYS} items omitted]`;
    output[marker] = marker;
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

function callStatus(entry: JournalEntry): WorkflowRunCallStatus {
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
    ...resultPreview(entry.result),
  };
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
  const matchedEntries = source.journal
    .filter((entry) => {
      if (filter.labelGlob === undefined) return true;
      const label = entry.call?.kind === "agent" ? entry.call.label : !entry.call && entry.session ? entry.session.label : undefined;
      return label !== undefined && matchesLabelGlob(label, filter.labelGlob);
    })
    .sort((left, right) => left.index - right.index);
  const selectedEntries = matchedEntries.slice(-filter.lastN);
  const phaseSource = source.phases.slice(-MAX_PHASES).map(sanitizeText);
  let phases = phaseSource.map((phase) => phase.value);
  const logSource = (filter.logLines === 0 ? [] : source.logs.slice(-filter.logLines)).map(sanitizeText);
  let logs = logSource.map((line) => line.value);
  let calls = selectedEntries.map(callStatus);

  const status: WorkflowRunStatus = {
    runId: sanitizeText(source.runId).value,
    status: source.status,
    workflowName: sanitizeText(source.workflowName).value,
    phases,
    ...(source.currentPhase === undefined ? {} : { currentPhase: sanitizeText(source.currentPhase).value }),
    ...(source.reason === undefined ? {} : { reason: sanitizeText(source.reason).value }),
    ...(source.errorCode === undefined ? {} : { errorCode: source.errorCode }),
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
        total: source.journal.length,
        matched: matchedEntries.length,
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
