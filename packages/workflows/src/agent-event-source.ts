import {
  ACP_CROSS_CUTTING_EVENT_NAMES,
  type AcpEventListener,
  type AcpEventName,
  type AcpRunnerEventMap,
  type AcpUpdateKind,
} from "@automatalabs/acp-agents";
import type { WorkflowAgentActivity } from "@automatalabs/workflow-engine";
import type { AgentRunner } from "@automatalabs/shared-types";
import type {
  WorkflowAgentEventName,
  WorkflowAgentEventPayload,
} from "./index.js";

type AcpEventBusRunner = AgentRunner & {
  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void;
};

export interface WorkflowAgentEventSink {
  observe(event: WorkflowAgentEventPayload): void;
}

export interface WorkflowAgentEventSource {
  attach(sink: WorkflowAgentEventSink): () => void;
}

class RunnerEventSource implements WorkflowAgentEventSource {
  private readonly sinks = new Map<WorkflowAgentEventSink, number>();
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly runner: AcpEventBusRunner) {}

  attach(sink: WorkflowAgentEventSink): () => void {
    const wasEmpty = this.sinks.size === 0;
    this.sinks.set(sink, (this.sinks.get(sink) ?? 0) + 1);
    if (wasEmpty) this.subscribe();
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      const refs = this.sinks.get(sink) ?? 0;
      if (refs <= 1) this.sinks.delete(sink);
      else this.sinks.set(sink, refs - 1);
      if (this.sinks.size !== 0) return;
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    };
  }

  private subscribe(): void {
    this.unsubscribers = [
      this.runner.on("session_update", (event) => this.dispatch(toSessionUpdatePayload(event))),
      ...ACP_CROSS_CUTTING_EVENT_NAMES.map((name) =>
        this.runner.on(name, (event) => this.dispatch(toAgentEventPayload(name, event))),
      ),
    ];
  }

  private dispatch(event: WorkflowAgentEventPayload): void {
    for (const sink of [...this.sinks.keys()]) {
      try {
        sink.observe(event);
      } catch {
        // Raw event observers are isolated from the runner and each other.
      }
    }
  }
}

const SOURCES = new WeakMap<AcpEventBusRunner, WorkflowAgentEventSource>();

export function workflowAgentEventSource(runner: AgentRunner): WorkflowAgentEventSource {
  if (!isAcpEventBusRunner(runner)) {
    return { attach: () => () => {} };
  }
  let source = SOURCES.get(runner);
  if (source === undefined) {
    source = new RunnerEventSource(runner);
    SOURCES.set(runner, source);
  }
  return source;
}

function isAcpEventBusRunner(runner: AgentRunner): runner is AcpEventBusRunner {
  return typeof (runner as Partial<Record<"on", unknown>>).on === "function";
}

function toSessionUpdatePayload(
  event: AcpRunnerEventMap["session_update"],
): WorkflowAgentEventPayload<AcpUpdateKind> {
  const name = event.update.sessionUpdate;
  return toAgentEventPayload(name, {
    ...event.update,
    sessionId: event.sessionId,
    backendId: event.backendId,
    label: event.label,
    runId: event.runId,
    callIndex: event.callIndex,
  } as AcpRunnerEventMap[typeof name]);
}

function toAgentEventPayload<Name extends WorkflowAgentEventName>(
  name: Name,
  event: AcpRunnerEventMap[Name],
): WorkflowAgentEventPayload<Name> {
  const context = event as Partial<{
    backendId: string;
    sessionId: string;
    label: string;
    runId: string;
    callIndex: number;
  }>;
  return {
    name,
    event,
    backendId: context.backendId,
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    ...(context.label === undefined ? {} : { label: context.label }),
    ...(context.runId === undefined ? {} : { runId: context.runId, scope: context.runId }),
    ...(context.callIndex === undefined ? {} : { callIndex: context.callIndex }),
  } as WorkflowAgentEventPayload<Name>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nestedToolName(meta: unknown): string | undefined {
  if (!isObject(meta)) return undefined;
  for (const value of Object.values(meta)) {
    if (!isObject(value) || typeof value.toolName !== "string" || value.toolName.trim().length === 0) continue;
    return value.toolName;
  }
  return undefined;
}

/** Pure ACP-to-engine adapter. Unknown or unsafe activity stays on the raw event bus only. */
export function projectWorkflowAgentActivity(
  event: WorkflowAgentEventPayload,
): WorkflowAgentActivity | undefined {
  const scope = event.scope ?? event.runId;
  if (typeof scope !== "string" || scope.length === 0 || typeof event.sessionId !== "string" ||
      event.sessionId.length === 0 || !Number.isSafeInteger(event.callIndex) || event.callIndex! < 0) return undefined;
  const base = {
    scope,
    callIndex: event.callIndex!,
    ...(event.label === undefined ? {} : { label: event.label }),
    sessionId: event.sessionId,
  };
  if (event.name === "session_open") return { ...base, kind: "session-open" };
  if (event.name === "session_close") return { ...base, kind: "session-close" };

  const update = event.event as unknown as Record<string, unknown>;
  if (event.name === "agent_message_chunk") {
    const content = update.content;
    if (!isObject(content) || content.type !== "text" || typeof content.text !== "string" || content.text.length === 0) {
      return undefined;
    }
    const messageId = typeof update.messageId === "string" && update.messageId.length > 0
      ? update.messageId
      : undefined;
    return { ...base, kind: "assistant-text", text: content.text, ...(messageId === undefined ? {} : { messageId }) };
  }
  if (event.name === "tool_call") {
    if (typeof update.title !== "string" || update.title.trim().length === 0) return undefined;
    const name = nestedToolName(update._meta) ??
      (typeof update.kind === "string" && update.kind.trim().length > 0 ? update.kind : update.title);
    return {
      ...base,
      kind: "tool-call",
      title: update.title,
      toolName: name,
    };
  }
  if (event.name === "usage_update") {
    const used = update.used;
    return {
      ...base,
      kind: "usage",
      ...(Number.isSafeInteger(used) && (used as number) >= 0 ? { tokensObserved: used as number } : {}),
    };
  }
  if (event.name === "user_message_chunk" || event.name === "agent_thought_chunk" ||
      event.name === "tool_call_update" || event.name === "plan" || event.name === "plan_update" ||
      event.name === "plan_removed") return { ...base, kind: "content-boundary" };
  return undefined;
}
