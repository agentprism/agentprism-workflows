import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowError,
  WorkflowErrorCode,
  type PersistableEngineRunEvent,
  type WorkflowRecordedError,
  type WorkflowRunResult,
} from "@automatalabs/shared-types";
import {
  MAX_OBSERVABILITY_SCALAR_BYTES,
  projectRunEventForPersistence,
} from "../src/run-observability.js";
import { RUN_EVENT_MAX_RECORD_BYTES } from "../src/run-event-persistence.js";

const secretForms = {
  assignment: "password=hunter2",
  bearer: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  basic: "Basic dXNlcjpwYXNz",
  userInfo: "https://admin:secret@example.com/private",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
  known: "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
  opaque: "opaqueTokenValue0123456789abcdefghijklmno",
  pem: "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
};
const allSecrets = Object.values(secretForms).join(" ");

test("live progress and transcript content reuse the shared redaction and scalar bounds", () => {
  const progress = projectRunEventForPersistence({
    type: "agentProgress",
    runId: "observe-run",
    scope: "observe-run",
    label: "observer",
    callIndex: 0,
    executionStartSeq: 1,
    turnCount: 1,
    observedEvents: 1,
    coalescedEvents: 0,
    cause: "activity",
    latestText: `${"🙂".repeat(200)} password=hunter2`,
  });
  assert.equal(progress.event.type, "agentProgress");
  assert.equal(JSON.stringify(progress).includes("hunter2"), false);
  assert.deepEqual(progress.projection, { redacted: true, truncated: true });
  if (progress.event.type === "agentProgress") {
    assert.ok(Buffer.byteLength(progress.event.latestText ?? "", "utf8") <= MAX_OBSERVABILITY_SCALAR_BYTES);
  }

  const transcript = projectRunEventForPersistence({
    type: "agentTranscript",
    runId: "observe-run",
    scope: "observe-run",
    label: "observer",
    callIndex: 0,
    executionStartSeq: 1,
    entryIndex: 0,
    revision: 0,
    operation: "upsert",
    entry: {
      role: "tool",
      kind: "toolCall",
      text: "password=hunter2",
      toolName: "api_token=secret-value",
      timestamp: 1,
    },
  });
  assert.equal(transcript.event.type, "agentTranscript");
  assert.equal(JSON.stringify(transcript).includes("hunter2"), false);
  assert.equal(JSON.stringify(transcript).includes("secret-value"), false);
  assert.equal(transcript.projection.redacted, true);
});

function recordedError(): WorkflowRecordedError {
  return {
    form: "workflow-error",
    message: allSecrets,
    code: WorkflowErrorCode.AUTH_REQUIRED,
    recoverable: false,
    agentLabel: allSecrets,
    details: { password: "detail-secret", nested: { text: allSecrets } },
    resetHint: allSecrets,
    providerUsageLimitContext: {
      backendId: allSecrets,
      source: "provider",
      providerCode: allSecrets,
      resetAt: allSecrets,
    },
    authContext: {
      backendId: allSecrets,
      methods: Array.from({ length: 22 }, (_, index) => ({
        id: `${allSecrets}-${index}`,
        type: "agent" as const,
        name: allSecrets,
      })),
    },
    checkpointContext: {
      callIndex: 3,
      hash: "engine-hash",
      prompt: allSecrets,
      kind: "select",
      choices: Array.from({ length: 22 }, (_, index) => `${allSecrets}-${index}`),
      default: { api_token: "checkpoint-secret", text: allSecrets },
    },
    props: { authorization: "prop-secret", text: allSecrets },
    value: { cookie: "value-secret", text: allSecrets },
  };
}

test("projectRunEventForPersistence redacts every retained string surface without mutating live payloads", () => {
  const event: PersistableEngineRunEvent = {
    type: "agentEnd",
    runId: allSecrets,
    scope: allSecrets,
    label: allSecrets,
    phase: allSecrets,
    result: { password: "result-secret", text: allSecrets },
    tokens: 12,
    worktree: allSecrets,
    model: allSecrets,
    error: allSecrets,
    errorCode: WorkflowErrorCode.AUTH_REQUIRED,
    recoverable: false,
    session: {
      sessionId: "session-secret-must-not-be-copied",
      backendId: "session-backend-secret",
      cwd: "/session/private",
      reopen: { load: true, resume: true, list: true },
      callIndex: 4,
      label: "session-label-secret",
      keptOpen: true,
    },
    callIndex: 4,
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, cost: 0.25 },
    modelResolved: allSecrets,
    modelFallbacks: Array.from({ length: 22 }, (_, index) => `${allSecrets}-${index}`),
    backendId: allSecrets,
    provenance: {
      source: "live",
      overrideModel: allSecrets,
      continuation: { reattached: false, reason: "reattach-failed" },
    },
    errorRecord: recordedError(),
  };
  const original = structuredClone(event);

  const projected = projectRunEventForPersistence(event);
  const bytes = JSON.stringify(projected);

  for (const secret of Object.values(secretForms)) assert.equal(bytes.includes(secret), false, secret);
  assert.equal(bytes.includes("result-secret"), false);
  assert.equal(bytes.includes("detail-secret"), false);
  assert.equal(bytes.includes("checkpoint-secret"), false);
  assert.equal(bytes.includes("session-secret-must-not-be-copied"), false);
  assert.equal(bytes.includes("[REDACTED]"), true);
  assert.deepEqual(event, original);
  assert.deepEqual(projected.projection, { redacted: true, truncated: true });
  assert.equal(projected.runId, projected.event.runId);
  assert.equal(projected.event.type, "agentEnd");
  if (projected.event.type === "agentEnd") {
    assert.equal("session" in projected.event, false);
    assert.equal(projected.event.modelFallbacks?.length, 20);
    assert.equal(projected.event.provenance?.source, "live");
    assert.deepEqual(
      projected.event.provenance?.source === "live"
        ? projected.event.provenance.continuation
        : undefined,
      { reattached: false, reason: "reattach-failed" },
    );
  }
});

test("config, journal metadata, and call-record provenance follow the nested projection rules", () => {
  const collidingPrefix = "x".repeat(MAX_OBSERVABILITY_SCALAR_BYTES);
  const start = projectRunEventForPersistence({
    type: "agentStart",
    runId: "run-projection",
    scope: "scope-projection",
    label: "label",
    prompt: "prompt",
    callIndex: 0,
    configOptions: {
      [`${collidingPrefix}a`]: "first",
      [`${collidingPrefix}b`]: "second",
      api_token: true,
      ordinary: allSecrets,
    },
  });
  assert.equal(start.event.type, "agentStart");
  if (start.event.type === "agentStart") {
    assert.equal(start.event.configOptions?.api_token, "[REDACTED]");
    assert.equal(Object.keys(start.event.configOptions ?? {}).length, 3);
  }
  assert.deepEqual(start.projection, { redacted: true, truncated: true });

  const journal = projectRunEventForPersistence({
    type: "journal",
    runId: "run-projection",
    scope: "scope-projection",
    entry: {
      index: 5,
      hash: "hash-copied-verbatim",
      result: allSecrets,
      session: {
        sessionId: "never-persist",
        backendId: "never-persist",
        cwd: "/never-persist",
        reopen: { load: true, resume: false, list: false },
        callIndex: 5,
        label: "never-persist",
        keptOpen: false,
      },
      call: {
        kind: "agent",
        label: allSecrets,
        phase: allSecrets,
        model: allSecrets,
        backendId: allSecrets,
        continuation: { method: "load" },
      },
      kind: "agent",
      scope: allSecrets,
    },
  });
  assert.equal(journal.event.type, "journal");
  if (journal.event.type === "journal") {
    assert.equal(journal.event.entry.hash, "hash-copied-verbatim");
    assert.equal("session" in journal.event.entry, false);
    assert.deepEqual(
      journal.event.entry.call?.kind === "agent"
        ? journal.event.entry.call.continuation
        : undefined,
      { method: "load" },
    );
  }

  const callRecord = projectRunEventForPersistence({
    type: "callRecord",
    runId: "run-projection",
    scope: "scope-projection",
    record: {
      index: 6,
      kind: "agent",
      hash: "hash-copied-verbatim",
      inputsHash: "inputs-hash-copied-verbatim",
      path: allSecrets,
      label: allSecrets,
      outcome: "error",
      origin: "runner",
      error: recordedError(),
      attempts: 1,
      provenance: {
        source: "replay",
        recordedRunId: allSecrets,
        recordedIndex: 2,
        hashMatched: true,
      },
      modelRequested: allSecrets,
      modelResolved: allSecrets,
      backendId: allSecrets,
      resolvedCwd: allSecrets,
      settlementOrdinal: 1,
      scope: allSecrets,
    },
  });
  const serialized = JSON.stringify(callRecord);
  assert.equal(serialized.includes(allSecrets), false);
  assert.equal(callRecord.event.type, "callRecord");
  if (callRecord.event.type === "callRecord") {
    assert.equal(callRecord.event.record.hash, "hash-copied-verbatim");
    assert.equal(callRecord.event.record.inputsHash, "inputs-hash-copied-verbatim");
    assert.equal(callRecord.event.record.provenance?.source, "replay");
  }
});

test("compact values enforce exact depth, array, key, and UTF-8 limits", () => {
  const deep = { level: { level: { level: { level: { secret: "too-deep" } } } } };
  const result = {
    password: "hidden",
    deep,
    array: Array.from({ length: 12 }, (_, index) => index),
    ...Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`key-${index}`, index])),
    multibyte: "🙂".repeat(400),
  };
  const projected = projectRunEventForPersistence({
    type: "agentEnd",
    runId: "run-compact",
    scope: "run-compact",
    label: "compact",
    result,
    callIndex: 1,
  });
  assert.equal(projected.event.type, "agentEnd");
  if (projected.event.type !== "agentEnd") return;
  const value = projected.event.result;
  assert.ok(Buffer.byteLength(value.preview, "utf8") <= MAX_OBSERVABILITY_SCALAR_BYTES);
  assert.equal(Buffer.from(value.preview, "utf8").toString("utf8"), value.preview);
  assert.equal(value.preview.includes("hidden"), false);
  assert.equal(value.redacted, true);
  assert.equal(value.truncated, true);
  assert.deepEqual(projected.projection, { redacted: true, truncated: true });
});

test("automatic pause and error projections exclude the runtime error and bound checkpoint defaults", () => {
  const runtimeError = new WorkflowError(
    "raw-runtime-error-only-secret",
    WorkflowErrorCode.CHECKPOINT_REQUIRED,
  );
  runtimeError.stack = "raw-stack-only-secret";
  const errorRecord: WorkflowRecordedError = {
    form: "workflow-error",
    message: "safe recorded message",
    code: WorkflowErrorCode.CHECKPOINT_REQUIRED,
    recoverable: false,
  };
  const checkpointContext = {
    callIndex: 2,
    hash: "checkpoint-hash",
    prompt: allSecrets,
    kind: "select" as const,
    choices: Array.from({ length: 22 }, (_, index) => `${allSecrets}-${index}`),
    default: { password: "default-secret", text: allSecrets },
  };
  const paused = projectRunEventForPersistence({
    type: "paused",
    runId: "run-paused",
    scope: "run-paused",
    reason: "checkpoint_required",
    error: runtimeError,
    errorRecord,
    checkpointContext,
  });
  const failed = projectRunEventForPersistence({
    type: "error",
    runId: "run-paused",
    scope: "run-paused",
    error: runtimeError,
    errorRecord,
  });
  for (const projection of [paused, failed]) {
    const bytes = JSON.stringify(projection);
    assert.equal(bytes.includes("raw-runtime-error-only-secret"), false);
    assert.equal(bytes.includes("raw-stack-only-secret"), false);
  }
  assert.equal(paused.event.type, "paused");
  if (paused.event.type === "paused" && paused.event.reason === "checkpoint_required") {
    assert.equal(paused.event.checkpointContext?.choices?.length, 20);
    assert.equal(paused.event.checkpointContext?.default?.preview.includes("default-secret"), false);
  }
  assert.deepEqual(paused.projection, { redacted: true, truncated: true });
});

function completedResult(text: string): WorkflowRunResult {
  return {
    runId: "run-volume",
    status: "completed",
    meta: { name: text, description: text },
    result: { text },
    phases: Array.from({ length: 30 }, () => text),
    agentCount: 20,
    durationMs: 10,
    tokenUsage: { input: 1, output: 1, total: 2, cost: 0 },
    logs: Array.from({ length: 30 }, () => text),
    calls: [],
  };
}

test("ordinary maximum-cardinality projections for every persisted variant fit one record", () => {
  const text = "ordinary-observability-text-".repeat(40);
  const error = new WorkflowError("ordinary error", WorkflowErrorCode.UNKNOWN);
  const errorRecord: WorkflowRecordedError = {
    form: "workflow-error",
    message: text,
    code: WorkflowErrorCode.UNKNOWN,
    recoverable: false,
  };
  const origin = { runId: "run-volume", scope: "run-volume" };
  const events: PersistableEngineRunEvent[] = [
    { type: "log", ...origin, message: text },
    { type: "phase", ...origin, title: text },
    {
      type: "agentStart",
      ...origin,
      label: text,
      prompt: text,
      model: text,
      configOptions: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`option-${index}-${text}`, text])),
      callIndex: 0,
    },
    {
      type: "agentEnd",
      ...origin,
      label: text,
      result: { text },
      callIndex: 0,
      modelFallbacks: Array.from({ length: 20 }, () => text),
      errorRecord,
    },
    { type: "tokenUsage", ...origin, usage: { input: 1, output: 1, total: 2, cost: 0 } },
    { type: "complete", ...origin, result: completedResult(text) },
    { type: "journal", ...origin, entry: { index: 0, hash: "hash", result: { text } } },
    {
      type: "callRecord",
      ...origin,
      record: { index: 0, kind: "agent", hash: "hash", label: text, outcome: "error", origin: "runner", error: errorRecord },
    },
    { type: "paused", ...origin },
    { type: "paused", ...origin, reason: "usage_limit", error, errorRecord, resetHint: text },
    { type: "error", ...origin, error, errorRecord },
    { type: "stopped", ...origin },
    { type: "resumed", ...origin },
  ];

  for (const [index, event] of events.entries()) {
    const projected = projectRunEventForPersistence(event);
    const record = {
      version: 1,
      streamId: "a".repeat(32),
      runId: projected.runId,
      seq: index + 1,
      timestamp: "2026-01-02T03:04:05.000Z",
      event: projected.event,
      projection: projected.projection,
    };
    assert.ok(Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8") <= RUN_EVENT_MAX_RECORD_BYTES, event.type);
  }
});
