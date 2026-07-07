/**
 * Local structural types for the WorkflowManager event surface. Runtime code
 * intentionally avoids importing AgentPrism packages so the published bridge
 * only depends on @opentelemetry/api.
 */

import type { MeterProvider, TracerProvider } from "@opentelemetry/api";

export interface WorkflowManagerLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface AgentPrismOtelOptions {
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
  captureContent?: boolean;
  contentLimit?: number;
}

export interface OtelAttachment {
  detach(): void;
}

export interface RunPayload {
  runId?: unknown;
}

export interface LogPayload extends RunPayload {
  message?: unknown;
}

export interface PhasePayload extends RunPayload {
  title?: unknown;
}

export interface AgentStartPayload extends RunPayload {
  label?: unknown;
  phase?: unknown;
  prompt?: unknown;
  model?: unknown;
}

export interface AgentEndPayload extends RunPayload {
  label?: unknown;
  phase?: unknown;
  result?: unknown;
  tokens?: unknown;
  worktree?: unknown;
  model?: unknown;
  error?: unknown;
  errorCode?: unknown;
  recoverable?: unknown;
}

export interface TokenUsageSnapshot {
  input?: unknown;
  output?: unknown;
  total?: unknown;
  cost?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

export interface TokenUsagePayload extends RunPayload {
  usage?: TokenUsageSnapshot;
}

export interface WorkflowRunResultLike {
  meta?: {
    name?: unknown;
  };
  status?: unknown;
  agentCount?: unknown;
}

export interface CompletePayload extends RunPayload {
  result?: WorkflowRunResultLike;
}

export interface PausedPayload extends RunPayload {
  reason?: unknown;
  error?: unknown;
  resetHint?: unknown;
}

export interface ErrorPayload extends RunPayload {
  error?: unknown;
}

export interface StoppedPayload extends RunPayload {}

export interface ResumedPayload extends RunPayload {}

export interface ToolCallEventLike {
  toolCallId?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  rawInput?: unknown;
  locations?: unknown;
  sessionId?: unknown;
  backendId?: unknown;
  label?: unknown;
  runId?: unknown;
}

export interface ToolCallUpdateEventLike {
  toolCallId?: unknown;
  status?: unknown;
  title?: unknown;
  content?: unknown;
  sessionId?: unknown;
  backendId?: unknown;
  label?: unknown;
  runId?: unknown;
}

export interface AgentEventPayloadLike<Name extends string = string> {
  name?: Name;
  event?: unknown;
  backendId?: unknown;
  sessionId?: unknown;
  label?: unknown;
  runId?: unknown;
}
