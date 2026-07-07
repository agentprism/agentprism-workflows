/**
 * Public API for attaching OpenTelemetry tracing and metrics to AgentPrism
 * WorkflowManager-compatible event emitters.
 */

export { attachOtel } from "./attach.js";
export type {
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
  ToolCallEventLike,
  ToolCallUpdateEventLike,
  WorkflowManagerLike,
  WorkflowRunResultLike,
} from "./types.js";
