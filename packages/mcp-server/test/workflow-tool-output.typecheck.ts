import type { WorkflowRunStatus } from "@automatalabs/workflows";

import type {
  WorkflowBackgroundAccepted,
  WorkflowExecutionToolResult,
  WorkflowInspectionToolResult,
  WorkflowRunAwaitResult,
  WorkflowScriptLineageEntry,
  WorkflowScriptResourceFields,
  WorkflowStopResult,
} from "../src/workflow-tool-output.js";

declare const status: WorkflowRunStatus;
const lineage: WorkflowScriptLineageEntry[] = [];

const execution: WorkflowExecutionToolResult = {
  runId: "aa-bb",
  status: "completed",
  scriptSource: "inline",
  scriptUri: "workflow://runs/aa-bb/script",
};
const background: WorkflowBackgroundAccepted = {
  runId: "aa-bb",
  status: "running",
  scriptSource: "path",
  scriptUri: "workflow://runs/aa-bb/script",
};
const inspection: WorkflowInspectionToolResult = {
  ...status,
  scriptUri: "workflow://runs/aa-bb/script",
  lineage,
};
const awaited: WorkflowRunAwaitResult = {
  ...inspection,
  wait: { requestedMs: 0, elapsedMs: 0, returnedBecause: "immediate" },
};
const stopped: WorkflowStopResult = {
  ...inspection,
  status: "aborted",
  stopped: true,
  alreadyTerminal: false,
};
const resourceFields: WorkflowScriptResourceFields = {
  scriptUri: "workflow://runs/aa-bb/script",
  lineage,
};

// @ts-expect-error execution results require scriptSource
const executionWithoutSource: WorkflowExecutionToolResult = {
  runId: "aa-bb",
  status: "completed",
  scriptUri: "workflow://runs/aa-bb/script",
};
// @ts-expect-error background acknowledgements require scriptUri
const backgroundWithoutUri: WorkflowBackgroundAccepted = {
  runId: "aa-bb",
  status: "running",
  scriptSource: "inline",
};
// @ts-expect-error inspections require the complete lineage
const inspectionWithoutLineage: WorkflowInspectionToolResult = {
  ...status,
  scriptUri: "workflow://runs/aa-bb/script",
};
// @ts-expect-error await results require scriptUri
const awaitWithoutUri: WorkflowRunAwaitResult = {
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
  background,
  inspection,
  awaited,
  stopped,
  resourceFields,
  executionWithoutSource,
  backgroundWithoutUri,
  inspectionWithoutLineage,
  awaitWithoutUri,
  stopWithoutTerminalAck,
  fieldsWithoutLineage,
];
