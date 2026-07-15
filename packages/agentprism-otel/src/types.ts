/**
 * Local structural types for the WorkflowManager event surface. Runtime code
 * intentionally avoids importing AgentPrism packages so the published bridge
 * only depends on @opentelemetry/api.
 */

import type { MeterProvider, TracerProvider } from "@opentelemetry/api";
import type { EngineRunEventPayloadMap, RunAgentEventPayload } from "@automatalabs/shared-types";

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

export type RunPayload = Pick<EngineRunEventPayloadMap["log"], "runId" | "scope">;
export type LogPayload = EngineRunEventPayloadMap["log"];
export type PhasePayload = EngineRunEventPayloadMap["phase"];
export type AgentStartPayload = EngineRunEventPayloadMap["agentStart"];
export type AgentEndPayload = EngineRunEventPayloadMap["agentEnd"];
export type TokenUsageSnapshot = EngineRunEventPayloadMap["tokenUsage"]["usage"];
export type TokenUsagePayload = EngineRunEventPayloadMap["tokenUsage"];
export type WorkflowRunResultLike = EngineRunEventPayloadMap["complete"]["result"];
export type CompletePayload = EngineRunEventPayloadMap["complete"];
export type PausedPayload = EngineRunEventPayloadMap["paused"];
export type ErrorPayload = EngineRunEventPayloadMap["error"];
export type StoppedPayload = EngineRunEventPayloadMap["stopped"];
export type ResumedPayload = EngineRunEventPayloadMap["resumed"];

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
  scope?: unknown;
  callIndex?: unknown;
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
  scope?: unknown;
  callIndex?: unknown;
}

export type AgentEventPayloadLike<Name extends string = string> = RunAgentEventPayload<Name>;
