import type {
  EngineRunEvent,
  RunAgentProgressPayload,
  RunEventLogRecord,
} from "@automatalabs/shared-types";
import {
  MAX_OBSERVABILITY_SCALAR_BYTES,
  projectRunEventForPersistence,
  truncateUtf8,
} from "./run-observability.js";

export const AGENT_PROGRESS_MIN_INTERVAL_MS = 1_000 as const;
export const AGENT_PROGRESS_HEARTBEAT_MS = 15_000 as const;

export interface WorkflowAgentActivityBase {
  scope: string;
  callIndex: number;
  label?: string;
  sessionId: string;
}

export type WorkflowAgentActivity = WorkflowAgentActivityBase & (
  | { kind: "session-open" }
  | { kind: "session-close" }
  | { kind: "assistant-text"; text: string; messageId?: string }
  | { kind: "tool-call"; title: string; toolName: string }
  | { kind: "tool-result"; text: string; toolName?: string; isError?: boolean }
  | { kind: "content-boundary" }
  | { kind: "usage"; tokensObserved?: number }
);

interface AssistantSegment {
  anchor: string | null;
  rawWindow: string;
  timestamp: number;
  entryIndex?: number;
  revision?: number;
  lastPersistedText?: string;
}

interface LiveOwner<Run extends object> {
  run: Run;
  rootRunId: string;
  scope: string;
  callIndex: number;
  label: string;
  phase?: string;
  executionStartSeq: number;
  sessions: Set<string>;
  observedEvents: number;
  observationsSinceActivity: number;
  turnCount: number;
  tokensObserved?: number;
  latestText?: string;
  lastToolName?: string;
  dirty: boolean;
  nextEntryIndex: number;
  segment?: AssistantSegment;
  lastActivityAt?: number;
  lastActivity?: RunAgentProgressPayload;
  lastProgress?: RunAgentProgressPayload;
  sampleTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  closed: boolean;
}

export interface LiveAgentObservabilityCallbacks<Run extends object> {
  eligible(run: Run): boolean;
  publish(run: Run, event: EngineRunEvent, afterAppend: (record: RunEventLogRecord) => void): void;
  progress(run: Run, record: RunEventLogRecord): void;
}

function ownerKey(scope: string, callIndex: number): string {
  return JSON.stringify([scope, callIndex]);
}

function utf8Suffix(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_OBSERVABILITY_SCALAR_BYTES) return value;
  let start = bytes.length - MAX_OBSERVABILITY_SCALAR_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function timerUnref(timer: NodeJS.Timeout): void {
  timer.unref?.();
}

function contentChanged(left: RunAgentProgressPayload | undefined, right: RunAgentProgressPayload): boolean {
  return left === undefined || left.latestText !== right.latestText || left.lastToolName !== right.lastToolName ||
    left.turnCount !== right.turnCount || left.observedEvents !== right.observedEvents ||
    left.tokensObserved !== right.tokensObserved;
}

/** Constant-space reducer from normalized runner activity into durable progress/transcript events. */
export class LiveAgentObservability<Run extends object> {
  private readonly owners = new Map<string, Set<LiveOwner<Run>>>();

  constructor(private readonly callbacks: LiveAgentObservabilityCallbacks<Run>) {}

  register(
    run: Run,
    context: {
      rootRunId: string;
      scope: string;
      callIndex: number;
      label: string;
      phase?: string;
      executionStartSeq: number;
    },
  ): void {
    if (!this.callbacks.eligible(run)) return;
    const owner: LiveOwner<Run> = {
      run,
      ...context,
      sessions: new Set(),
      observedEvents: 0,
      observationsSinceActivity: 0,
      turnCount: 0,
      dirty: false,
      nextEntryIndex: 0,
      closed: false,
    };
    const key = ownerKey(owner.scope, owner.callIndex);
    const bucket = this.owners.get(key) ?? new Set<LiveOwner<Run>>();
    bucket.add(owner);
    this.owners.set(key, bucket);
  }

  observe(activity: WorkflowAgentActivity): void {
    try {
      const owner = this.resolveOwner(activity);
      if (owner === undefined) return;
      if (activity.kind === "session-open") {
        owner.sessions.add(activity.sessionId);
        return;
      }
      if (activity.kind === "session-close") {
        owner.sessions.delete(activity.sessionId);
        return;
      }
      if (!owner.sessions.has(activity.sessionId) || owner.closed || !this.callbacks.eligible(owner.run)) return;
      if (owner.observedEvents === Number.MAX_SAFE_INTEGER || owner.observationsSinceActivity === Number.MAX_SAFE_INTEGER) {
        this.clearRun(owner.run);
        return;
      }
      owner.observedEvents += 1;
      owner.observationsSinceActivity += 1;

      if (activity.kind === "assistant-text") this.observeText(owner, activity.text, activity.messageId);
      else if (activity.kind === "tool-call") this.observeTool(owner, activity.title, activity.toolName);
      else if (activity.kind === "tool-result") this.observeToolResult(owner, activity.text, activity.toolName, activity.isError);
      else if (activity.kind === "content-boundary") this.closeSegment(owner);
      else if (activity.tokensObserved !== undefined) owner.tokensObserved = activity.tokensObserved;

      if (owner.latestText !== undefined || owner.lastToolName !== undefined) {
        const candidate = this.projectedProgress(owner, "activity");
        owner.dirty = candidate !== undefined && contentChanged(owner.lastActivity, candidate);
        if (owner.dirty) this.scheduleActivity(owner);
      }
    } catch {
      // The observer must never control the agent call.
    }
  }

  finish(scope: string, callIndex: number, run?: Run): void {
    const key = ownerKey(scope, callIndex);
    const bucket = this.owners.get(key);
    if (!bucket) return;
    for (const owner of [...bucket]) {
      if (run !== undefined && owner.run !== run) continue;
      this.finalizeOwner(owner);
      bucket.delete(owner);
    }
    if (bucket.size === 0) this.owners.delete(key);
  }

  finishRun(run: Run): void {
    for (const [key, bucket] of this.owners) {
      for (const owner of [...bucket]) {
        if (owner.run !== run) continue;
        this.finalizeOwner(owner);
        bucket.delete(owner);
      }
      if (bucket.size === 0) this.owners.delete(key);
    }
  }

  clearRun(run: Run): void {
    for (const [key, bucket] of this.owners) {
      for (const owner of [...bucket]) {
        if (owner.run !== run) continue;
        this.closeOwner(owner);
        bucket.delete(owner);
      }
      if (bucket.size === 0) this.owners.delete(key);
    }
  }

  private resolveOwner(activity: WorkflowAgentActivity): LiveOwner<Run> | undefined {
    const matches = [...(this.owners.get(ownerKey(activity.scope, activity.callIndex)) ?? [])]
      .filter((owner) => activity.label === undefined || owner.label === activity.label);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private observeText(owner: LiveOwner<Run>, text: string, messageId: string | undefined): void {
    const presentId = messageId === undefined || messageId.length === 0 ? undefined : messageId;
    const segment = owner.segment;
    const boundary = segment !== undefined && (
      (segment.anchor === null && presentId !== undefined) ||
      (segment.anchor !== null && presentId !== undefined && segment.anchor !== presentId)
    );
    if (boundary) this.closeSegment(owner);
    if (owner.segment === undefined) {
      owner.turnCount += 1;
      owner.segment = {
        anchor: presentId ?? null,
        rawWindow: "",
        timestamp: Date.now(),
      };
    }
    owner.segment.rawWindow = utf8Suffix(owner.segment.rawWindow + text);
    owner.latestText = owner.segment.rawWindow;
    owner.lastToolName = undefined;
    if (owner.segment.entryIndex === undefined) this.publishAssistantRevision(owner);
  }

  private observeTool(owner: LiveOwner<Run>, title: string, toolName: string): void {
    this.closeSegment(owner);
    this.publishToolEntry(owner, title, toolName);
    owner.lastToolName = truncateUtf8(toolName, MAX_OBSERVABILITY_SCALAR_BYTES);
    owner.latestText = undefined;
  }

  /** A terminal tool result is a content boundary AND a durable transcript entry of its own. */
  private observeToolResult(
    owner: LiveOwner<Run>,
    text: string,
    toolName: string | undefined,
    isError: boolean | undefined,
  ): void {
    this.closeSegment(owner);
    this.publishToolResultEntry(owner, text, toolName, isError);
  }

  private closeSegment(owner: LiveOwner<Run>): void {
    if (owner.segment === undefined) return;
    this.publishAssistantRevision(owner);
    owner.segment = undefined;
  }

  private base(owner: LiveOwner<Run>) {
    return {
      runId: owner.rootRunId,
      scope: owner.scope,
      label: owner.label,
      ...(owner.phase === undefined ? {} : { phase: owner.phase }),
      callIndex: owner.callIndex,
      executionStartSeq: owner.executionStartSeq,
    };
  }

  private rawProgress(
    owner: LiveOwner<Run>,
    cause: "activity" | "heartbeat",
  ): Extract<EngineRunEvent, { type: "agentProgress" }> {
    return {
      type: "agentProgress",
      ...this.base(owner),
      turnCount: owner.turnCount,
      observedEvents: owner.observedEvents,
      coalescedEvents: cause === "activity" ? Math.max(0, owner.observationsSinceActivity - 1) : 0,
      cause,
      ...(owner.latestText === undefined ? {} : { latestText: owner.latestText }),
      ...(owner.lastToolName === undefined ? {} : { lastToolName: owner.lastToolName }),
      ...(owner.tokensObserved === undefined ? {} : { tokensObserved: owner.tokensObserved }),
    };
  }

  private projectedProgress(owner: LiveOwner<Run>, cause: "activity" | "heartbeat"): RunAgentProgressPayload | undefined {
    const raw = this.rawProgress(owner, cause);
    const projected = projectRunEventForPersistence(raw).event;
    if (projected.type !== "agentProgress") return undefined;
    const content = projected.latestText ?? projected.lastToolName;
    return content !== undefined && content.trim().length > 0 ? projected : undefined;
  }

  private publishAssistantRevision(owner: LiveOwner<Run>): void {
    const segment = owner.segment;
    if (!segment) return;
    const entryIndex = segment.entryIndex ?? owner.nextEntryIndex;
    const revision = segment.revision === undefined ? 0 : segment.revision + 1;
    const event: Extract<EngineRunEvent, { type: "agentTranscript" }> = {
      type: "agentTranscript",
      ...this.base(owner),
      entryIndex,
      revision,
      operation: "upsert",
      entry: {
        role: "assistant",
        kind: "text",
        text: segment.rawWindow,
        timestamp: segment.timestamp,
      },
    };
    const projected = projectRunEventForPersistence(event).event;
    if (projected.type !== "agentTranscript" || projected.entry.text.trim().length === 0 ||
        projected.entry.text === segment.lastPersistedText) return;
    this.publish(owner, event, (record) => {
      if (segment.entryIndex === undefined) {
        segment.entryIndex = entryIndex;
        owner.nextEntryIndex += 1;
      }
      segment.revision = revision;
      segment.lastPersistedText = projected.entry.text;
      void record;
    });
  }

  private publishToolEntry(owner: LiveOwner<Run>, title: string, toolName: string): void {
    const entryIndex = owner.nextEntryIndex;
    const event: Extract<EngineRunEvent, { type: "agentTranscript" }> = {
      type: "agentTranscript",
      ...this.base(owner),
      entryIndex,
      revision: 0,
      operation: "upsert",
      entry: { role: "tool", kind: "toolCall", text: title, toolName, timestamp: Date.now() },
    };
    const projected = projectRunEventForPersistence(event).event;
    if (projected.type !== "agentTranscript" || projected.entry.text.trim().length === 0 ||
        !projected.entry.toolName?.trim()) return;
    this.publish(owner, event, () => { owner.nextEntryIndex += 1; });
  }

  private publishToolResultEntry(
    owner: LiveOwner<Run>,
    text: string,
    toolName: string | undefined,
    isError: boolean | undefined,
  ): void {
    const entryIndex = owner.nextEntryIndex;
    const event: Extract<EngineRunEvent, { type: "agentTranscript" }> = {
      type: "agentTranscript",
      ...this.base(owner),
      entryIndex,
      revision: 0,
      operation: "upsert",
      entry: {
        role: "tool",
        kind: "toolResult",
        text,
        ...(toolName === undefined ? {} : { toolName }),
        ...(isError === true ? { isError: true } : {}),
        timestamp: Date.now(),
      },
    };
    const projected = projectRunEventForPersistence(event).event;
    if (projected.type !== "agentTranscript" || projected.entry.text.trim().length === 0) return;
    this.publish(owner, event, () => { owner.nextEntryIndex += 1; });
  }

  private scheduleActivity(owner: LiveOwner<Run>): void {
    const now = Date.now();
    if (owner.lastActivityAt === undefined || now - owner.lastActivityAt >= AGENT_PROGRESS_MIN_INTERVAL_MS) {
      this.publishActivity(owner);
      return;
    }
    if (owner.sampleTimer !== undefined) return;
    owner.sampleTimer = setTimeout(() => {
      owner.sampleTimer = undefined;
      try {
        if (!owner.closed && owner.dirty) this.publishActivity(owner);
      } catch {
        // Timer observers are isolated from execution.
      }
    }, AGENT_PROGRESS_MIN_INTERVAL_MS - (now - owner.lastActivityAt));
    timerUnref(owner.sampleTimer);
  }

  private publishActivity(owner: LiveOwner<Run>): void {
    const projected = this.projectedProgress(owner, "activity");
    if (projected === undefined) return;
    if (owner.segment !== undefined && projected.latestText !== undefined) this.publishAssistantRevision(owner);
    const raw = this.rawProgress(owner, "activity");
    this.publish(owner, raw, (record) => {
      owner.lastActivityAt = Date.now();
      owner.lastActivity = projected;
      owner.lastProgress = projected;
      owner.observationsSinceActivity = 0;
      owner.dirty = false;
      this.armHeartbeat(owner);
      this.callbacks.progress(owner.run, record);
    });
  }

  private armHeartbeat(owner: LiveOwner<Run>): void {
    if (owner.heartbeatTimer !== undefined) clearTimeout(owner.heartbeatTimer);
    owner.heartbeatTimer = setTimeout(() => {
      owner.heartbeatTimer = undefined;
      try {
        if (owner.closed || owner.lastProgress === undefined) return;
        const heartbeat: RunAgentProgressPayload = {
          ...owner.lastProgress,
          cause: "heartbeat",
          coalescedEvents: 0,
        };
        this.publish(owner, { type: "agentProgress", ...heartbeat }, (record) => {
          owner.lastProgress = heartbeat;
          this.armHeartbeat(owner);
          this.callbacks.progress(owner.run, record);
        });
      } catch {
        // Timer observers are isolated from execution.
      }
    }, AGENT_PROGRESS_HEARTBEAT_MS);
    timerUnref(owner.heartbeatTimer);
  }

  private publish(owner: LiveOwner<Run>, event: EngineRunEvent, appended: (record: RunEventLogRecord) => void): void {
    if (owner.closed) return;
    if (!this.callbacks.eligible(owner.run)) {
      this.clearRun(owner.run);
      return;
    }
    let succeeded = false;
    this.callbacks.publish(owner.run, event, (record) => {
      succeeded = true;
      appended(record);
    });
    if (!succeeded && !this.callbacks.eligible(owner.run)) this.clearRun(owner.run);
  }

  private finalizeOwner(owner: LiveOwner<Run>): void {
    if (owner.closed) return;
    this.closeSegment(owner);
    if (owner.dirty) this.publishActivity(owner);
    this.closeOwner(owner);
  }

  private closeOwner(owner: LiveOwner<Run>): void {
    owner.closed = true;
    owner.sessions.clear();
    if (owner.sampleTimer !== undefined) clearTimeout(owner.sampleTimer);
    if (owner.heartbeatTimer !== undefined) clearTimeout(owner.heartbeatTimer);
    owner.sampleTimer = undefined;
    owner.heartbeatTimer = undefined;
  }
}
