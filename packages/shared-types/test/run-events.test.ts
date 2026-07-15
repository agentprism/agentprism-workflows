import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_EVENT_LOG_VERSION } from "../src/index.js";
import type {
  EngineRunEvent,
  EngineRunEventName,
  EngineRunEventPayloadMap,
  PersistedRunEvent,
  RunAgentEndPayload,
  RunAgentEventEvent,
  RunAgentEventPayload,
  RunAgentHistoryPayload,
  RunAgentStartPayload,
  RunCallRecordPayload,
  RunCompletePayload,
  RunErrorPayload,
  RunEvent,
  RunEventLogRecord,
  RunEventName,
  RunJournalPayload,
  RunLogPayload,
  RunPausedPayload,
  RunPhasePayload,
  RunResumedPayload,
  RunStoppedPayload,
  RunTokenUsagePayload,
  WorkflowError,
  WorkflowRecordedError,
} from "../src/index.js";

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;

type ExpectedEngineEventName =
  | "log"
  | "phase"
  | "agentStart"
  | "agentEnd"
  | "agentHistory"
  | "tokenUsage"
  | "complete"
  | "journal"
  | "callRecord"
  | "paused"
  | "error"
  | "stopped"
  | "resumed";
type _EngineNamesExact = Assert<Equal<EngineRunEventName, ExpectedEngineEventName>>;
type _FullRunEventNamesExact = Assert<Equal<RunEventName, ExpectedEngineEventName | "agentEvent">>;

type ExpectedPayloadMap = {
  log: RunLogPayload;
  phase: RunPhasePayload;
  agentStart: RunAgentStartPayload;
  agentEnd: RunAgentEndPayload;
  agentHistory: RunAgentHistoryPayload;
  tokenUsage: RunTokenUsagePayload;
  complete: RunCompletePayload;
  journal: RunJournalPayload;
  callRecord: RunCallRecordPayload;
  paused: RunPausedPayload;
  error: RunErrorPayload;
  stopped: RunStoppedPayload;
  resumed: RunResumedPayload;
};
type _PayloadMapForward = Assert<EngineRunEventPayloadMap extends ExpectedPayloadMap ? true : false>;
type _PayloadMapBackward = Assert<ExpectedPayloadMap extends EngineRunEventPayloadMap ? true : false>;

type DefaultAgentBranch = Extract<RunEvent, { type: "agentEvent" }>;
type _DefaultAgentBranch = Assert<DefaultAgentBranch extends RunAgentEventEvent<string, unknown> ? true : false>;
type ExampleAgentEvent = { type: "agentEvent" } & RunAgentEventPayload<"message", { text: string }>;
type SpecializedRunEvent = RunEvent<ExampleAgentEvent>;
type _SpecializedAgentBranch = Assert<Equal<Extract<SpecializedRunEvent, { type: "agentEvent" }>, ExampleAgentEvent>>;

type _PersistedHistoryExcluded = Assert<IsNever<Extract<PersistedRunEvent, { type: "agentHistory" }>>>;
type _PersistedAgentEventExcluded = Assert<IsNever<Extract<PersistedRunEvent, { type: "agentEvent" }>>>;
type _StreamIdRequired = Assert<Equal<Pick<RunEventLogRecord, "streamId">, { streamId: string }>>;

function exhaustiveEngineName(event: EngineRunEvent): EngineRunEventName {
  switch (event.type) {
    case "log":
    case "phase":
    case "agentStart":
    case "agentEnd":
    case "agentHistory":
    case "tokenUsage":
    case "complete":
    case "journal":
    case "callRecord":
    case "paused":
    case "error":
    case "stopped":
    case "resumed":
      return event.type;
    default:
      return assertNever(event);
  }
}

function exhaustiveRunEventName(event: RunEvent): RunEventName {
  switch (event.type) {
    case "log":
    case "phase":
    case "agentStart":
    case "agentEnd":
    case "agentHistory":
    case "tokenUsage":
    case "complete":
    case "journal":
    case "callRecord":
    case "paused":
    case "error":
    case "stopped":
    case "resumed":
    case "agentEvent":
      return event.type;
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected event: ${String(value)}`);
}

function pausedSubtypeFixtures(error: WorkflowError, errorRecord: WorkflowRecordedError): void {
  const usage: RunPausedPayload = {
    runId: "run",
    scope: "run",
    reason: "usage_limit",
    error,
    errorRecord,
    resetHint: "later",
  };
  if (usage.reason === "usage_limit") {
    const resetHint: string | undefined = usage.resetHint;
    void resetHint;
  }
  const auth: RunPausedPayload = {
    runId: "run",
    scope: "run",
    reason: "auth_required",
    error,
    errorRecord,
    authContext: { methods: [] },
  };
  const checkpoint: RunPausedPayload = {
    runId: "run",
    scope: "run",
    reason: "checkpoint_required",
    error,
    errorRecord,
    checkpointContext: {
      callIndex: 1,
      hash: "hash",
      prompt: "Continue?",
      kind: "confirm",
    },
  };

  // @ts-expect-error usage-limit pauses cannot carry auth context
  const invalidUsage: RunPausedPayload = { ...usage, authContext: { methods: [] } };
  // @ts-expect-error auth pauses cannot carry usage-limit reset hints
  const invalidAuth: RunPausedPayload = { ...auth, resetHint: "later" };
  // @ts-expect-error checkpoint pauses cannot carry auth context
  const invalidCheckpoint: RunPausedPayload = { ...checkpoint, authContext: { methods: [] } };
  // @ts-expect-error manual pauses cannot carry an automatic-pause error
  const invalidManual: RunPausedPayload = { runId: "run", scope: "run", error };
  void invalidUsage;
  void invalidAuth;
  void invalidCheckpoint;
  void invalidManual;
}
void pausedSubtypeFixtures;

function requiredStreamIdFixture(record: Omit<RunEventLogRecord, "streamId">): void {
  // @ts-expect-error persisted records require their event-stream generation id
  const missingStreamId: RunEventLogRecord = record;
  void missingStreamId;
}
void requiredStreamIdFixture;

test("run-event public contract exposes all engine and relay branches", () => {
  const event: EngineRunEvent = { type: "log", runId: "run-1", scope: "run-1", message: "hello" };
  assert.equal(exhaustiveEngineName(event), "log");
  assert.equal(exhaustiveRunEventName(event), "log");
  assert.equal(RUN_EVENT_LOG_VERSION, 1);
});

test("RunEventLogRecord carries a generation-shaped stream id", () => {
  const record: RunEventLogRecord = {
    version: RUN_EVENT_LOG_VERSION,
    streamId: "0123456789abcdef0123456789abcdef",
    runId: "run-1",
    seq: 1,
    timestamp: "2026-07-15T00:00:00.000Z",
    event: { type: "stopped", runId: "run-1", scope: "run-1" },
    projection: { redacted: false, truncated: false },
  };
  assert.match(record.streamId, /^[0-9a-f]{32}$/);
});

test("tsc type-checks the run-event compile fixtures", () => {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/lib/tsc.js");
  const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = spawnSync(process.execPath, [tsc, "-p", join(pkgDir, "tsconfig.test.json"), "--noEmit"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `tsc found type errors:\n${result.stdout}${result.stderr}`);
});
