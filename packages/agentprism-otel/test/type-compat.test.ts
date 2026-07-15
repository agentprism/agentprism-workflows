// Compile-time compatibility checks for the local structural types against the
// real AgentPrism managers and facade agentEvent payload.
import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowManager as EngineWorkflowManager } from "@automatalabs/workflow-engine";
import { WorkflowManager as FacadeWorkflowManager, type AgentEventPayload } from "@automatalabs/workflows";
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
  ToolCallEventLike,
  ToolCallUpdateEventLike,
  WorkflowManagerLike,
  WorkflowRunResultLike,
} from "../src/index.js";

type AssertAssignable<T extends U, U> = true;

const facadeManager: WorkflowManagerLike = new FacadeWorkflowManager({ journaling: false });
const engineManager: WorkflowManagerLike = new EngineWorkflowManager({ journaling: false });
const toolPayloadAssignable: AssertAssignable<AgentEventPayload<"tool_call">, AgentEventPayloadLike<"tool_call">> = true;
const toolEventAssignable: AssertAssignable<AgentEventPayload<"tool_call">["event"], ToolCallEventLike> = true;
type PublicTypeExports = [
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
];
const publicTypeExportCount: PublicTypeExports["length"] = 17;

test("real WorkflowManager types satisfy the local OTel structural surface", () => {
  assert.equal(typeof facadeManager.on, "function");
  assert.equal(typeof facadeManager.removeListener, "function");
  assert.equal(typeof engineManager.on, "function");
  assert.equal(typeof engineManager.removeListener, "function");
  assert.equal(toolPayloadAssignable, true);
  assert.equal(toolEventAssignable, true);
  assert.equal(publicTypeExportCount, 17);
});
