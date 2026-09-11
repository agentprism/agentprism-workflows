import type {
  WorkflowCallRecord,
  WorkflowRunLimits,
  WorkflowRunStatus,
} from "@automatalabs/workflows";

import type {
  WorkflowOperationAccepted,
  WorkflowExecutionOutcome,
  WorkflowResultRetrieval,
  WorkflowScriptResourceFields,
  WorkflowStatusToolResult,
  WorkflowStopPendingResult,
  WorkflowStopResult,
} from "../src/workflow-tool-output.js";

declare const status: WorkflowRunStatus;
const limits = {
  maxAgents: 1_000,
  concurrency: 6,
  agentRetries: 0,
};
const execution: WorkflowExecutionOutcome = {
  runId: "aa-bb",
  status: "completed",
  scriptUri: "workflow://runs/aa-bb/script",
  resultUri: "workflow://runs/aa-bb/result",
  eventsUri: "workflow://runs/aa-bb/events",
  limits,
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
const acceptance: WorkflowOperationAccepted = {
  action: "run",
  accepted: true,
  runId: "aa-bb",
  status: "running",
  scriptSource: "stored",
  scriptUri: "workflow://runs/aa-bb/script",
  eventsUri: "workflow://runs/aa-bb/events",
  limits,
};
const statusFields = {
  ...status,
  scriptUri: "workflow://runs/aa-bb/script",
  eventsUri: "workflow://runs/aa-bb/events",
};
const observed: WorkflowStatusToolResult = {
  ...statusFields,
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
};
const removedBudgetLimit: WorkflowRunLimits = {
  maxAgents: 1,
  concurrency: 1,
  agentRetries: 0,
  // @ts-expect-error token budgets are not part of current run limits
  tokenBudget: null,
};
const removedCallDebit: WorkflowCallRecord = {
  index: 0,
  kind: "agent",
  hash: "hash",
  outcome: "result",
  origin: "runner",
  // @ts-expect-error debit metadata is not part of current call records
  budgetDebit: 0,
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
const acceptanceFields = {
  action: "run" as const, accepted: true as const, runId: "aa-bb", status: "pending" as const, scriptSource: "inline" as const,
  scriptUri: "workflow://runs/aa-bb/script", eventsUri: "workflow://runs/aa-bb/events", limits,
};
// @ts-expect-error acceptance carries no retry identity any more
const acceptanceWithIdentity: WorkflowOperationAccepted = { ...acceptanceFields, requestId: "retry-1" };
const { scriptSource: _scriptSource, ...noSource } = acceptanceFields;
// @ts-expect-error acceptance requires accepted source classification
const acceptanceWithoutSource: WorkflowOperationAccepted = noSource;
const { limits: _limits, ...noLimits } = acceptanceFields;
// @ts-expect-error acceptance requires resolved limits
const acceptanceWithoutLimits: WorkflowOperationAccepted = noLimits;
const { scriptUri: _scriptUri, ...noUri } = acceptanceFields;
// @ts-expect-error acceptance requires durable source discovery
const acceptanceWithoutUri: WorkflowOperationAccepted = noUri;
const { eventsUri: _eventsUri, ...noEvents } = acceptanceFields;
// @ts-expect-error acceptance requires durable events discovery
const acceptanceWithoutEvents: WorkflowOperationAccepted = noEvents;
// @ts-expect-error resume acceptance requires the continuation generation
const resumeWithoutGeneration: WorkflowOperationAccepted = { ...acceptanceFields, action: "resume" };
const acceptanceWithResult: WorkflowOperationAccepted = {
  ...acceptanceFields,
  // @ts-expect-error completion is observed through status/result, never returned by acceptance
  result: 42,
};
const acceptanceWithResultUri: WorkflowOperationAccepted = {
  ...acceptanceFields,
  // @ts-expect-error acceptance exposes source and events; exact results have their own retrieval path
  resultUri: "workflow://runs/aa-bb/result",
};
// @ts-expect-error status results require scriptUri
const statusWithoutUri: WorkflowStatusToolResult = {
  ...status,
};
// @ts-expect-error stop acknowledgements require alreadyTerminal
const stopWithoutTerminalAck: WorkflowStopResult = {
  ...status,
  status: "aborted",
  scriptUri: "workflow://runs/aa-bb/script",
  stopped: true,
};

void [
  execution,
  resultRetrieval,
  resultRetrievalWithoutChunk,
  acceptance,
  observed,
  stopped,
  pendingStop,
  resourceFields,
  removedBudgetLimit,
  removedCallDebit,
  acceptanceWithIdentity,
  acceptanceWithoutSource,
  acceptanceWithoutLimits,
  acceptanceWithoutEvents,
  acceptanceWithoutUri,
  resumeWithoutGeneration,
  acceptanceWithResult,
  acceptanceWithResultUri,
  statusWithoutUri,
  stopWithoutTerminalAck,
];
