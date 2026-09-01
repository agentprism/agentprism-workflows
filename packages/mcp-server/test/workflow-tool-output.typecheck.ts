import type { WorkflowReplayEligibility, WorkflowRunStatus } from "@automatalabs/workflows";

import type {
  WorkflowBackgroundAccepted,
  WorkflowExecutionToolResult,
  WorkflowResultRetrieval,
  WorkflowScriptLineageEntry,
  WorkflowScriptResourceFields,
  WorkflowStatusToolResult,
  WorkflowStopPendingResult,
  WorkflowStopResult,
} from "../src/workflow-tool-output.js";

declare const status: WorkflowRunStatus;
const lineage: WorkflowScriptLineageEntry[] = [];
const limits = {
  maxAgents: 1_000,
  tokenBudget: null,
  concurrency: 6,
  agentRetries: 0,
  agentTimeoutMs: null,
  agentIdleTimeoutMs: null,
};
const replayEligibility: WorkflowReplayEligibility = {
  strategy: "identity-v1",
  sourceRunId: "source-run",
  predictedReplayablePrefix: 1,
  replayedPrefix: 0,
  replayed: 0,
  live: 0,
  failed: 0,
  currentEngineVersion: "0.27.0",
  engineVersionComparison: "source-unknown",
  currentInputsFormat: 2,
  provenanceChanges: [],
  operationalChanges: [],
};

const execution: WorkflowExecutionToolResult = {
  runId: "aa-bb",
  status: "completed",
  scriptSource: "inline",
  scriptUri: "workflow://runs/aa-bb/script",
  resultUri: "workflow://runs/aa-bb/result",
  eventsUri: "workflow://runs/aa-bb/events",
  limits,
  replayEligibility,
};
const resultRetrieval: WorkflowResultRetrieval = {
  action: "result",
  runId: "aa-bb",
  status: "completed",
  resultUri: "workflow://runs/aa-bb/result",
  mimeType: "application/json",
  encoding: "utf-8",
  totalBytes: 2,
  offset: 0,
  endOffset: 2,
  hasMore: false,
  chunk: "42",
};
const background: WorkflowBackgroundAccepted = {
  runId: "aa-bb",
  status: "running",
  scriptSource: "path",
  scriptUri: "workflow://runs/aa-bb/script",
  eventsUri: "workflow://runs/aa-bb/events",
  limits,
  replayEligibility,
};
const statusFields = {
  ...status,
  scriptUri: "workflow://runs/aa-bb/script",
  eventsUri: "workflow://runs/aa-bb/events",
  lineage,
};
const observed: WorkflowStatusToolResult = {
  ...statusFields,
  wait: { requestedMs: 0, elapsedMs: 0, returnedBecause: "immediate" },
};
const stopped: WorkflowStopResult = {
  ...statusFields,
  status: "aborted",
  stopped: true,
  alreadyTerminal: false,
};
const pendingStop: WorkflowStopPendingResult = {
  ...statusFields,
  status: "running",
  stopped: false,
  alreadyTerminal: false,
  control: {
    state: "pending",
    operationId: "00000000-0000-4000-8000-000000000000",
    requestedAt: "2026-08-28T00:00:00.000Z",
    owner: { pid: 42, controlProtocol: 1 },
  },
};
const resourceFields: WorkflowScriptResourceFields = {
  scriptUri: "workflow://runs/aa-bb/script",
  resultUri: "workflow://runs/aa-bb/result",
  lineage,
};

// @ts-expect-error result retrieval requires the exact chunk
const resultRetrievalWithoutChunk: WorkflowResultRetrieval = {
  action: "result",
  runId: "aa-bb",
  status: "completed",
  resultUri: "workflow://runs/aa-bb/result",
  mimeType: "application/json",
  encoding: "utf-8",
  totalBytes: 2,
  offset: 0,
  endOffset: 2,
  hasMore: false,
};
// @ts-expect-error execution results require scriptSource
const executionWithoutSource: WorkflowExecutionToolResult = {
  runId: "aa-bb",
  status: "completed",
  scriptUri: "workflow://runs/aa-bb/script",
  eventsUri: "workflow://runs/aa-bb/events",
};
// @ts-expect-error execution results require resolved limits
const executionWithoutLimits: WorkflowExecutionToolResult = {
  runId: "aa-bb",
  status: "completed",
  scriptSource: "inline",
  scriptUri: "workflow://runs/aa-bb/script",
  eventsUri: "workflow://runs/aa-bb/events",
};
// @ts-expect-error background acknowledgements require scriptUri
const backgroundWithoutUri: WorkflowBackgroundAccepted = {
  runId: "aa-bb",
  status: "running",
  scriptSource: "inline",
  eventsUri: "workflow://runs/aa-bb/events",
  limits,
};
// @ts-expect-error current execution results require durable events discovery
const executionWithoutEvents: WorkflowExecutionToolResult = {
  runId: "aa-bb",
  status: "completed",
  scriptSource: "inline",
  scriptUri: "workflow://runs/aa-bb/script",
  limits,
};
// @ts-expect-error status results require the complete lineage
const statusWithoutLineage: WorkflowStatusToolResult = {
  ...status,
  scriptUri: "workflow://runs/aa-bb/script",
  wait: { requestedMs: 0, elapsedMs: 0, returnedBecause: "immediate" },
};
// @ts-expect-error status results require scriptUri
const statusWithoutUri: WorkflowStatusToolResult = {
  ...status,
  lineage,
  wait: { requestedMs: 0, elapsedMs: 0, returnedBecause: "immediate" },
};
// @ts-expect-error stop acknowledgements require alreadyTerminal
const stopWithoutTerminalAck: WorkflowStopResult = {
  ...status,
  status: "aborted",
  scriptUri: "workflow://runs/aa-bb/script",
  lineage,
  stopped: true,
};
// @ts-expect-error common inspection resource fields require lineage
const fieldsWithoutLineage: WorkflowScriptResourceFields = {
  scriptUri: "workflow://runs/aa-bb/script",
};

void [
  execution,
  resultRetrieval,
  resultRetrievalWithoutChunk,
  background,
  observed,
  stopped,
  pendingStop,
  resourceFields,
  executionWithoutSource,
  executionWithoutLimits,
  executionWithoutEvents,
  backgroundWithoutUri,
  statusWithoutLineage,
  statusWithoutUri,
  stopWithoutTerminalAck,
  fieldsWithoutLineage,
];
