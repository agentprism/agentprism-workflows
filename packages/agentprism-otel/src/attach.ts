/**
 * Attach OpenTelemetry spans and metrics to a WorkflowManager without touching
 * the workflow engine. Every event handler is isolated so observability can
 * never perturb a workflow run.
 */

import {
  context,
  diag,
  metrics,
  SpanStatusCode,
  trace,
  type Counter,
  type Histogram,
  type Span,
} from "@opentelemetry/api";
import {
  ATTR_AGENT_COUNT,
  ATTR_BACKEND_ID,
  ATTR_DANGLING,
  ATTR_DETACHED,
  ATTR_ERROR_CODE,
  ATTR_LABEL,
  ATTR_LAST_PHASE,
  ATTR_LOG_MESSAGE,
  ATTR_PAUSED,
  ATTR_PAUSE_REASON,
  ATTR_PHASE,
  ATTR_PROMPT,
  ATTR_RECOVERABLE,
  ATTR_RESUMED,
  ATTR_RESULT,
  ATTR_RUN_ID,
  ATTR_SESSION_ID,
  ATTR_STATUS,
  ATTR_STOPPED,
  ATTR_TOKEN_TYPE,
  ATTR_TOKENS,
  ATTR_TOOL_INPUT,
  ATTR_TOOL_KIND,
  ATTR_TOOL_OUTPUT,
  ATTR_TOOL_STATUS,
  ATTR_WORKTREE,
  DEFAULT_CAPTURE_CONTENT,
  DEFAULT_CONTENT_LIMIT,
  EVENT_LOG,
  EVENT_PHASE,
  EVENT_TOOL_STATUS,
  GEN_AI_AGENT_NAME,
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
  INSTRUMENTATION_NAME,
  METRIC_AGENT_DURATION,
  METRIC_AGENTS,
  METRIC_COST,
  METRIC_TOKENS,
  OPERATION_EXECUTE_TOOL,
  OPERATION_INVOKE_AGENT,
  SPAN_EXECUTE_TOOL_PREFIX,
  SPAN_INVOKE_AGENT_PREFIX,
  SPAN_WORKFLOW,
  UNIT_AGENT,
  UNIT_SECONDS,
  UNIT_TOKENS,
  UNIT_USD,
  VERSION,
} from "./constants.js";
import type {
  AgentEndPayload,
  AgentEventPayloadLike,
  AgentPrismOtelOptions,
  AgentStartPayload,
  CompletePayload,
  ErrorPayload,
  LogPayload,
  OtelAttachment,
  PausedPayload,
  PhasePayload,
  ResumedPayload,
  StoppedPayload,
  TokenUsagePayload,
  TokenUsageSnapshot,
  ToolCallEventLike,
  ToolCallUpdateEventLike,
  WorkflowManagerLike,
} from "./types.js";

type Listener = (...args: any[]) => void;

interface AgentEntry {
  span: Span;
  startHrMs: number;
  toolSpans: Map<string, Span>;
}

interface ToolEntry {
  span: Span;
  agentEntry?: AgentEntry;
}

interface NormalizedUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
}

interface RunState {
  rootSpan: Span;
  rootContext: ReturnType<typeof trace.setSpan>;
  openAgents: Map<string, AgentEntry[]>;
  openToolsBySessionTool: Map<string, ToolEntry>;
  lastUsage?: NormalizedUsage;
}

interface AttachmentMetrics {
  tokenCounter: Counter;
  costCounter: Counter;
  agentsCounter: Counter;
  agentDuration: Histogram;
}

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed"]);

export function attachOtel(manager: WorkflowManagerLike, options: AgentPrismOtelOptions = {}): OtelAttachment {
  const tracerProvider = options.tracerProvider ?? trace.getTracerProvider();
  const meterProvider = options.meterProvider ?? metrics.getMeterProvider();
  const tracer = tracerProvider.getTracer(INSTRUMENTATION_NAME, VERSION);
  const meter = meterProvider.getMeter(INSTRUMENTATION_NAME, VERSION);
  const captureContent = options.captureContent ?? DEFAULT_CAPTURE_CONTENT;
  const contentLimit = normalizeContentLimit(options.contentLimit);
  const runs = new Map<string, RunState>();
  const subscriptions: Array<{ event: string; listener: Listener }> = [];
  let detached = false;

  const instruments: AttachmentMetrics = {
    tokenCounter: meter.createCounter(METRIC_TOKENS, {
      unit: UNIT_TOKENS,
      description: "Token deltas reported by AgentPrism workflow runs.",
    }),
    costCounter: meter.createCounter(METRIC_COST, {
      unit: UNIT_USD,
      description: "Cost deltas reported by AgentPrism workflow runs.",
    }),
    agentsCounter: meter.createCounter(METRIC_AGENTS, {
      unit: UNIT_AGENT,
      description: "Agent invocations completed by AgentPrism workflow runs.",
    }),
    agentDuration: meter.createHistogram(METRIC_AGENT_DURATION, {
      unit: UNIT_SECONDS,
      description: "Agent invocation duration.",
    }),
  };

  const getRun = (runId: string, creatingEvent?: string): RunState => {
    const existing = runs.get(runId);
    if (existing) return existing;
    const rootSpan = tracer.startSpan(SPAN_WORKFLOW, {
      attributes: {
        [ATTR_RUN_ID]: runId,
        ...(creatingEvent === "resumed" ? { [ATTR_RESUMED]: true } : {}),
      },
    });
    const rootContext = trace.setSpan(context.active(), rootSpan);
    const state: RunState = {
      rootSpan,
      rootContext,
      openAgents: new Map(),
      openToolsBySessionTool: new Map(),
    };
    runs.set(runId, state);
    return state;
  };

  const subscribe = (event: string, handler: (payload: unknown) => void): void => {
    const listener: Listener = (payload) => {
      if (detached) return;
      try {
        handler(payload);
      } catch (error) {
        diag.error("agentprism-otel event handler failed", error);
      }
    };
    manager.on(event, listener);
    subscriptions.push({ event, listener });
  };

  subscribe("log", (payload) => {
    const event = asRecord(payload) as LogPayload | undefined;
    const runId = stringValue(event?.runId);
    if (!runId) return;
    const message = stringValue(event?.message);
    if (message === undefined) return;
    getRun(runId, "log").rootSpan.addEvent(EVENT_LOG, { [ATTR_LOG_MESSAGE]: message });
  });

  subscribe("phase", (payload) => {
    const event = asRecord(payload) as PhasePayload | undefined;
    const runId = stringValue(event?.runId);
    if (!runId) return;
    const title = stringValue(event?.title);
    if (title === undefined) return;
    const rootSpan = getRun(runId, "phase").rootSpan;
    rootSpan.addEvent(EVENT_PHASE, { [ATTR_PHASE]: title });
    rootSpan.setAttribute(ATTR_LAST_PHASE, title);
  });

  subscribe("agentStart", (payload) => {
    const event = asRecord(payload) as AgentStartPayload | undefined;
    const runId = stringValue(event?.runId);
    const label = stringValue(event?.label);
    if (!runId || !label) return;

    const run = getRun(runId, "agentStart");
    const attributes: Record<string, string | boolean | number> = {
      [GEN_AI_OPERATION_NAME]: OPERATION_INVOKE_AGENT,
      [GEN_AI_AGENT_NAME]: label,
      [ATTR_RUN_ID]: runId,
    };
    const phase = stringValue(event?.phase);
    const model = stringValue(event?.model);
    if (phase !== undefined) attributes[ATTR_PHASE] = phase;
    if (model !== undefined) attributes[GEN_AI_REQUEST_MODEL] = model;
    if (captureContent) attributes[ATTR_PROMPT] = truncate(String(event?.prompt), contentLimit);

    const span = tracer.startSpan(`${SPAN_INVOKE_AGENT_PREFIX} ${label}`, { attributes }, run.rootContext);
    const entry: AgentEntry = { span, startHrMs: nowMs(), toolSpans: new Map() };
    const entries = run.openAgents.get(label) ?? [];
    entries.push(entry);
    run.openAgents.set(label, entries);
  });

  subscribe("agentEnd", (payload) => {
    const event = asRecord(payload) as AgentEndPayload | undefined;
    const runId = stringValue(event?.runId);
    const label = stringValue(event?.label);
    if (!runId || !label) return;

    const run = getRun(runId, "agentEnd");
    const hadError = event?.error !== undefined && event.error !== null && event.error !== "";
    const status = hadError ? "error" : "ok";
    instruments.agentsCounter.add(1, { [ATTR_STATUS]: status });

    const entries = run.openAgents.get(label);
    const entry = entries?.shift();
    if (entries && entries.length === 0) run.openAgents.delete(label);
    if (!entry) {
      diag.debug("agentprism-otel ignored unmatched agentEnd", { runId, label });
      return;
    }

    const tokens = numberValue(event?.tokens);
    const model = stringValue(event?.model);
    const worktree = stringValue(event?.worktree);
    if (tokens !== undefined) entry.span.setAttribute(ATTR_TOKENS, tokens);
    if (model !== undefined) entry.span.setAttribute(GEN_AI_RESPONSE_MODEL, model);
    if (worktree !== undefined) entry.span.setAttribute(ATTR_WORKTREE, worktree);

    if (hadError) {
      entry.span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(event?.error) });
      const errorCode = stringValue(event?.errorCode);
      if (errorCode !== undefined) entry.span.setAttribute(ATTR_ERROR_CODE, errorCode);
      if (typeof event?.recoverable === "boolean") entry.span.setAttribute(ATTR_RECOVERABLE, event.recoverable);
      entry.span.recordException(exceptionFromUnknown(event?.error));
    } else {
      entry.span.setStatus({ code: SpanStatusCode.OK });
    }

    if (captureContent) entry.span.setAttribute(ATTR_RESULT, truncate(safeJson(event?.result), contentLimit));
    forceEndAgentTools(run, entry, { [ATTR_DANGLING]: true });
    entry.span.end();
    instruments.agentDuration.record(Math.max(0, nowMs() - entry.startHrMs) / 1000, { [ATTR_STATUS]: status });
  });

  subscribe("tokenUsage", (payload) => {
    const event = asRecord(payload) as TokenUsagePayload | undefined;
    const runId = stringValue(event?.runId);
    if (!runId) return;
    const run = getRun(runId, "tokenUsage");
    const usage = normalizeUsage(event?.usage);
    const previous = run.lastUsage ?? { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
    addPositiveDelta(instruments.tokenCounter, "input", usage.input - previous.input);
    addPositiveDelta(instruments.tokenCounter, "output", usage.output - previous.output);
    addPositiveDelta(instruments.tokenCounter, "total", usage.total - previous.total);
    addPositiveDelta(instruments.tokenCounter, "cache_read", usage.cacheRead - previous.cacheRead);
    addPositiveDelta(instruments.tokenCounter, "cache_write", usage.cacheWrite - previous.cacheWrite);
    const costDelta = usage.cost - previous.cost;
    if (costDelta > 0) instruments.costCounter.add(costDelta);
    run.lastUsage = usage;
  });

  subscribe("complete", (payload) => {
    const event = asRecord(payload) as CompletePayload | undefined;
    const runId = stringValue(event?.runId);
    if (!runId) return;
    const run = getRun(runId, "complete");
    const name = stringValue(event?.result?.meta?.name);
    if (name?.trim()) run.rootSpan.updateName(`${SPAN_WORKFLOW} ${name}`);
    const status = stringValue(event?.result?.status);
    const agentCount = numberValue(event?.result?.agentCount);
    if (status !== undefined) run.rootSpan.setAttribute(ATTR_STATUS, status);
    if (agentCount !== undefined) run.rootSpan.setAttribute(ATTR_AGENT_COUNT, agentCount);
    run.rootSpan.setStatus({ code: SpanStatusCode.OK });
    finishRun(runId, { [ATTR_DANGLING]: true });
  });

  subscribe("paused", (payload) => {
    const event = asRecord(payload) as PausedPayload | undefined;
    const runId = stringValue(event?.runId);
    if (!runId) return;
    const run = getRun(runId, "paused");
    run.rootSpan.setAttribute(ATTR_PAUSED, true);
    const reason = stringValue(event?.reason);
    if (reason !== undefined) run.rootSpan.setAttribute(ATTR_PAUSE_REASON, reason);
    run.rootSpan.setStatus({ code: SpanStatusCode.OK });
    finishRun(runId, { [ATTR_DANGLING]: true });
  });

  subscribe("error", (payload) => {
    const event = asRecord(payload) as ErrorPayload | undefined;
    const runId = stringValue(event?.runId);
    if (!runId) return;
    const run = getRun(runId, "error");
    run.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(event?.error) });
    run.rootSpan.recordException(exceptionFromUnknown(event?.error));
    finishRun(runId, { [ATTR_DANGLING]: true });
  });

  subscribe("stopped", (payload) => {
    const event = asRecord(payload) as StoppedPayload | undefined;
    const runId = stringValue(event?.runId);
    if (!runId) return;
    const run = getRun(runId, "stopped");
    run.rootSpan.setAttribute(ATTR_STOPPED, true);
    run.rootSpan.setStatus({ code: SpanStatusCode.UNSET });
    finishRun(runId, { [ATTR_DANGLING]: true });
  });

  subscribe("resumed", (payload) => {
    const event = asRecord(payload) as ResumedPayload | undefined;
    const runId = stringValue(event?.runId);
    if (!runId) return;
    getRun(runId, "resumed").rootSpan.setAttribute(ATTR_RESUMED, true);
  });

  subscribe("agentEvent", (payload) => {
    const event = asRecord(payload) as AgentEventPayloadLike | undefined;
    if (event?.name === "tool_call") {
      onToolCall(event as AgentEventPayloadLike<"tool_call">);
    } else if (event?.name === "tool_call_update") {
      onToolCallUpdate(event as AgentEventPayloadLike<"tool_call_update">);
    }
  });

  const finishRun = (runId: string, childAttributes: Record<string, boolean>): void => {
    const run = runs.get(runId);
    if (!run) return;
    forceEndRunChildren(run, childAttributes);
    run.rootSpan.end();
    runs.delete(runId);
  };

  function onToolCall(payload: AgentEventPayloadLike<"tool_call">): void {
    const runId = stringValue(payload.runId);
    if (!runId) return;
    const run = runs.get(runId);
    if (!run) return;
    const event = asRecord(payload.event) as ToolCallEventLike | undefined;
    const toolCallId = stringValue(event?.toolCallId);
    const sessionId = stringValue(payload.sessionId ?? event?.sessionId);
    if (!toolCallId || !sessionId) return;

    const label = stringValue(payload.label ?? event?.label);
    const parentEntry = label ? peek(run.openAgents.get(label)) : undefined;
    const parentContext = parentEntry ? trace.setSpan(context.active(), parentEntry.span) : run.rootContext;
    const title = stringValue(event?.title);
    const kind = stringValue(event?.kind);
    const backendId = stringValue(payload.backendId ?? event?.backendId);
    const spanName = `${SPAN_EXECUTE_TOOL_PREFIX} ${title ?? kind ?? "tool"}`;
    const attributes: Record<string, string | boolean | number> = {
      [GEN_AI_OPERATION_NAME]: OPERATION_EXECUTE_TOOL,
      [GEN_AI_TOOL_CALL_ID]: toolCallId,
      [ATTR_SESSION_ID]: sessionId,
      [ATTR_RUN_ID]: runId,
    };
    if (title !== undefined) attributes[GEN_AI_TOOL_NAME] = title;
    if (kind !== undefined) attributes[ATTR_TOOL_KIND] = kind;
    if (backendId !== undefined) attributes[ATTR_BACKEND_ID] = backendId;
    if (label !== undefined) attributes[ATTR_LABEL] = label;
    if (captureContent) attributes[ATTR_TOOL_INPUT] = truncate(safeJson(event?.rawInput), contentLimit);

    const key = toolKey(sessionId, toolCallId);
    const existing = run.openToolsBySessionTool.get(key);
    if (existing) forceEndTool(run, key, existing, { [ATTR_DANGLING]: true });

    const span = tracer.startSpan(spanName, { attributes }, parentContext);
    const toolEntry: ToolEntry = { span, agentEntry: parentEntry };
    run.openToolsBySessionTool.set(key, toolEntry);
    parentEntry?.toolSpans.set(key, span);
  }

  function onToolCallUpdate(payload: AgentEventPayloadLike<"tool_call_update">): void {
    const event = asRecord(payload.event) as ToolCallUpdateEventLike | undefined;
    const toolCallId = stringValue(event?.toolCallId);
    const sessionId = stringValue(payload.sessionId ?? event?.sessionId);
    if (!toolCallId || !sessionId) return;

    const runId = stringValue(payload.runId ?? event?.runId);
    const run = runId ? runs.get(runId) : findRunByToolKey(toolKey(sessionId, toolCallId));
    if (!run) return;
    const key = toolKey(sessionId, toolCallId);
    const tool = run.openToolsBySessionTool.get(key);
    if (!tool) return;

    const title = stringValue(event?.title);
    if (title !== undefined) {
      tool.span.updateName(`${SPAN_EXECUTE_TOOL_PREFIX} ${title}`);
      tool.span.setAttribute(GEN_AI_TOOL_NAME, title);
    }

    const status = stringValue(event?.status);
    if (captureContent && status !== undefined && TERMINAL_TOOL_STATUSES.has(status)) {
      tool.span.setAttribute(ATTR_TOOL_OUTPUT, truncate(safeJson(event?.content), contentLimit));
    }
    if (status === "completed") {
      tool.span.setStatus({ code: SpanStatusCode.OK });
      tool.span.end();
      unregisterTool(run, key, tool);
    } else if (status === "failed") {
      tool.span.setStatus({ code: SpanStatusCode.ERROR });
      tool.span.end();
      unregisterTool(run, key, tool);
    } else if (status !== undefined) {
      tool.span.addEvent(EVENT_TOOL_STATUS, { [ATTR_TOOL_STATUS]: status });
    }
  }

  function findRunByToolKey(key: string): RunState | undefined {
    for (const run of runs.values()) {
      if (run.openToolsBySessionTool.has(key)) return run;
    }
    return undefined;
  }

  const attachment: OtelAttachment = {
    detach() {
      if (detached) return;
      detached = true;
      for (const { event, listener } of subscriptions) {
        manager.removeListener(event, listener);
      }
      subscriptions.length = 0;
      for (const [runId, run] of runs) {
        forceEndRunChildren(run, { [ATTR_DETACHED]: true });
        run.rootSpan.setAttribute(ATTR_DETACHED, true);
        run.rootSpan.setStatus({ code: SpanStatusCode.UNSET });
        run.rootSpan.end();
        runs.delete(runId);
      }
    },
  };

  return attachment;

  function forceEndRunChildren(run: RunState, attributes: Record<string, boolean>): void {
    for (const [key, tool] of [...run.openToolsBySessionTool]) {
      forceEndTool(run, key, tool, attributes);
    }
    for (const [label, entries] of [...run.openAgents]) {
      for (const entry of entries) {
        entry.span.setAttributes(attributes);
        entry.span.setStatus({ code: SpanStatusCode.UNSET });
        entry.span.end();
      }
      run.openAgents.delete(label);
    }
  }

  function forceEndAgentTools(run: RunState, entry: AgentEntry, attributes: Record<string, boolean>): void {
    for (const key of [...entry.toolSpans.keys()]) {
      const tool = run.openToolsBySessionTool.get(key);
      if (tool) forceEndTool(run, key, tool, attributes);
    }
  }

  function forceEndTool(run: RunState, key: string, tool: ToolEntry, attributes: Record<string, boolean>): void {
    tool.span.setAttributes(attributes);
    tool.span.setStatus({ code: SpanStatusCode.UNSET });
    tool.span.end();
    unregisterTool(run, key, tool);
  }

  function unregisterTool(run: RunState, key: string, tool: ToolEntry): void {
    run.openToolsBySessionTool.delete(key);
    tool.agentEntry?.toolSpans.delete(key);
  }
}

export function truncate(value: string, limit = DEFAULT_CONTENT_LIMIT): string {
  const normalizedLimit = normalizeContentLimit(limit);
  if (value.length <= normalizedLimit) return value;
  return `${value.slice(0, normalizedLimit)}…[truncated]`;
}

export function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return "[unserializable]";
  }
}

function normalizeContentLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_CONTENT_LIMIT;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(usage: TokenUsageSnapshot | undefined): NormalizedUsage {
  return {
    input: numberValue(usage?.input) ?? 0,
    output: numberValue(usage?.output) ?? 0,
    total: numberValue(usage?.total) ?? 0,
    cost: numberValue(usage?.cost) ?? 0,
    cacheRead: numberValue(usage?.cacheRead) ?? 0,
    cacheWrite: numberValue(usage?.cacheWrite) ?? 0,
  };
}

function addPositiveDelta(counter: Counter, tokenType: string, delta: number): void {
  if (delta > 0) counter.add(delta, { [ATTR_TOKEN_TYPE]: tokenType });
}

function toolKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

function peek<T>(items: T[] | undefined): T | undefined {
  return items && items.length > 0 ? items[items.length - 1] : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (asRecord(error) && typeof asRecord(error)?.message === "string") return asRecord(error)?.message as string;
  return String(error);
}

function exceptionFromUnknown(error: unknown): Error | string {
  if (error instanceof Error || typeof error === "string") return error;
  return errorMessage(error);
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
