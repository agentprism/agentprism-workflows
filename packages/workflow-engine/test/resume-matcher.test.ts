import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  JournalEntry,
  WorkflowCallRecord,
  WorkflowResumeCallDecision,
} from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  admitResumeSource,
  buildResumeCandidateIndexes,
  buildResumeReport,
  cloneResumeCandidate,
  indexedSourceOccurrence,
  initialPositionalFirstMiss,
  normalizeResumeSeed,
  parseCheckpointReplies,
  selectResumeCandidate,
  selectPositionalResume,
  type ResumeAdmissionInput,
  type ResumeMatchInput,
} from "../src/resume-matcher.js";
import {
  buildResumeExactIndex,
  resumeContentKey,
  resumeExactKey,
} from "../src/resume-identity.js";
import type {
  PersistedCheckpointInjection,
  PersistedResumeCandidate,
  PersistedResumeCallBlocker,
  PersistedResumeSeed,
  PersistedRunState,
} from "../src/run-persistence.js";
import { CALL_INPUTS_FORMAT, CALL_PATH_FORMAT, CHECKPOINT_INPUTS_FORMAT } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const INPUT_A = "1".repeat(64);
const INPUT_B = "2".repeat(64);
const INPUT_C = "3".repeat(64);
const SOURCE_RUN_ID = "source-run";
const CWD = "/workspace/project";
const ENVIRONMENT = { key: "workspace-v1" } as const;
const RUNTIME = {
  node: process.version,
  v8: process.versions.v8,
  pathFormat: CALL_PATH_FORMAT,
  inputsFormat: CALL_INPUTS_FORMAT,
  checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
};

function agentRow(index = 0, overrides: Partial<WorkflowCallRecord> = {}): WorkflowCallRecord {
  return {
    index,
    kind: "agent",
    hash: HASH_A,
    path: `workflow.js:${index + 1}:1`,
    inputsHash: INPUT_A,
    outcome: "result",
    origin: "runner",
    resumeSafety: "declared-read-only",
    scope: SOURCE_RUN_ID,
    ...overrides,
  };
}

function checkpointRow(index = 0, overrides: Partial<WorkflowCallRecord> = {}): WorkflowCallRecord {
  return {
    index,
    kind: "checkpoint",
    hash: HASH_B,
    path: `workflow.js:${index + 1}:1`,
    inputsHash: INPUT_B,
    outcome: "result",
    origin: "confirm",
    scope: SOURCE_RUN_ID,
    ...overrides,
  };
}

function entryFor(call: WorkflowCallRecord, result: unknown = `result-${call.index}`): JournalEntry {
  return {
    index: call.index,
    hash: call.hash,
    result,
    kind: call.kind,
    scope: call.scope,
  };
}

function sourceState(
  calls: WorkflowCallRecord[] = [agentRow()],
  overrides: Partial<PersistedRunState> = {},
): PersistedRunState {
  return {
    runId: SOURCE_RUN_ID,
    workflowName: "resume-source",
    script: "export const meta = { name: 'resume-source', description: 'test' }\nreturn null",
    effectiveCwd: CWD,
    runtime: { ...RUNTIME },
    environment: { ...ENVIRONMENT },
    resume: { format: "identity-v1", terminalEnvironment: { ...ENVIRONMENT } },
    status: "completed",
    phases: [],
    agents: [],
    logs: [],
    journal: calls.filter((call) => call.outcome === "result").map((call) => entryFor(call)),
    calls,
    callsAllocated: calls.length,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function admission(
  source: PersistedRunState,
  overrides: Partial<Omit<ResumeAdmissionInput, "source">> = {},
) {
  return admitResumeSource({
    source,
    requestedPolicy: "auto",
    current: {
      effectiveCwd: CWD,
      runtime: { ...RUNTIME },
    },
    ...overrides,
  });
}

function candidate(
  index = 0,
  overrides: {
    call?: Partial<WorkflowCallRecord>;
    entry?: Partial<JournalEntry>;
    sourceRunId?: string;
  } = {},
): PersistedResumeCandidate {
  const sourceRunId = overrides.sourceRunId ?? SOURCE_RUN_ID;
  const call = agentRow(index, { scope: sourceRunId, ...overrides.call });
  const entry = { ...entryFor(call), scope: sourceRunId, ...overrides.entry };
  return {
    sourceRunId,
    recordedIndex: index,
    entry,
    call,
  };
}

function injection(index = 0, overrides: Partial<PersistedCheckpointInjection> = {}): PersistedCheckpointInjection {
  return {
    sourceRunId: SOURCE_RUN_ID,
    recordedIndex: index,
    hash: HASH_B,
    path: `workflow.js:${index + 1}:1`,
    inputsHash: INPUT_B,
    decision: true,
    ...overrides,
  };
}

function blocker(index = 0, overrides: Partial<WorkflowCallRecord> = {}): PersistedResumeCallBlocker {
  return {
    sourceRunId: SOURCE_RUN_ID,
    recordedIndex: index,
    call: agentRow(index, {
      outcome: "error",
      origin: "engine",
      error: {
        form: "workflow-error",
        message: "interrupted",
        code: WorkflowErrorCode.WORKFLOW_ABORTED,
        recoverable: true,
      },
      aborted: true,
      ...overrides,
    }),
  };
}

function seed(
  candidates: PersistedResumeCandidate[] = [candidate()],
  checkpointInjections: PersistedCheckpointInjection[] = [],
): PersistedResumeSeed {
  return {
    format: "identity-v1",
    sourceRunId: SOURCE_RUN_ID,
    candidates,
    ...(checkpointInjections.length === 0 ? {} : { checkpointInjections }),
  };
}

function matchInput(overrides: Partial<ResumeMatchInput> = {}): ResumeMatchInput {
  return {
    kind: "agent",
    hash: HASH_A,
    path: "workflow.js:1:1",
    inputsHash: INPUT_A,
    consumed: new Set(),
    ...overrides,
  };
}

describe("incremental resume admission", () => {
  it("selects legacy positional and world-neutral identity admission", () => {
    const legacy = sourceState();
    delete legacy.resume;
    assert.deepEqual(admission(legacy), {
      strategy: "positional-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      fallbackReason: "legacy-recording",
      eligibility: "legacy",
    });

    const safe = admission(sourceState());
    assert.equal(safe.strategy, "identity-v1");
    assert.equal(safe.strategy === "identity-v1" && safe.seed.candidates.length, 1);
    assert.deepEqual(safe.facts, {
      pendingRepresented: false,
      allCallsRepresented: true,
    });

    const unsafeRow = agentRow();
    delete unsafeRow.resumeSafety;
    const unsafe = admission(sourceState([unsafeRow]));
    assert.equal(unsafe.strategy, "identity-v1");
    assert.equal(unsafe.strategy === "identity-v1" && unsafe.seed.candidates.length, 1);

    const inconsistentLegacyMarker = agentRow(0, {
      isolation: "worktree",
      resumeSafety: "declared-read-only",
    });
    const inconsistent = admission(sourceState([inconsistentLegacyMarker]));
    assert.equal(inconsistent.strategy, "identity-v1");
    assert.equal(inconsistent.strategy === "identity-v1" && inconsistent.seed.candidates.length, 1);

    const headless = admission(sourceState([checkpointRow(0, { origin: "headless" })]));
    assert.equal(headless.strategy, "identity-v1");
    assert.equal(headless.strategy === "identity-v1" && headless.seed.candidates.length, 1);

    const failedCall = checkpointRow(0, {
      outcome: "error",
      origin: "headless",
      error: { form: "workflow-error", message: "stopped", code: WorkflowErrorCode.UNKNOWN },
    });
    const failed = admission(sourceState([failedCall]));
    assert.equal(failed.strategy, "identity-v1");
    assert.equal(failed.strategy === "identity-v1" && failed.seed.candidates.length, 0);
    assert.equal(failed.strategy === "identity-v1" && failed.seed.callBlockers?.length, 1);

    const interrupted = blocker().call;
    const interruptedDecision = admission(sourceState([interrupted]));
    assert.equal(interruptedDecision.strategy, "identity-v1");
    assert.equal(interruptedDecision.strategy === "identity-v1" && interruptedDecision.seed.candidates.length, 0);
    assert.equal(interruptedDecision.strategy === "identity-v1" && interruptedDecision.seed.callBlockers?.length, 1);

    const usageLimited = agentRow(1, {
      path: "workflow.js:2:1",
      outcome: "error",
      origin: "runner",
      error: {
        form: "workflow-error",
        message: "quota exhausted",
        code: WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
        recoverable: false,
      },
      backendId: "test-backend",
    });
    delete usageLimited.resumeSafety;
    const ordinaryCompleted = agentRow(0);
    delete ordinaryCompleted.resumeSafety;
    const usageDecision = admission(sourceState([ordinaryCompleted, usageLimited], {
      status: "paused",
      pauseReason: "usage_limit",
      resume: { format: "identity-v1" },
    }));
    assert.equal(usageDecision.strategy, "identity-v1");
    assert.equal(usageDecision.strategy === "identity-v1" && usageDecision.seed.candidates.length, 1);
    assert.equal(usageDecision.strategy === "identity-v1" && usageDecision.seed.callBlockers?.length, 1);

    const nested = admission(sourceState(undefined, { nestedWorkflows: true }));
    assert.equal(nested.strategy, "identity-v1");
    assert.equal(nested.strategy === "identity-v1" && nested.seed.candidates.length, 1);

    const legacyResume = admission(sourceState(undefined, { legacyResume: true }));
    assert.equal(legacyResume.strategy, "positional-v1");
    assert.equal(legacyResume.strategy === "positional-v1" && legacyResume.fallbackReason, "legacy-resume");

    const forced = admission(sourceState(), { requestedPolicy: "positional" });
    assert.equal(forced.strategy, "positional-v1");
    assert.equal(forced.strategy === "positional-v1" && forced.fallbackReason, "forced-positional");
    assert.equal(forced.strategy === "positional-v1" && forced.eligibility, "safe-prefix");
  });

  it("bridges older call-input formats through legacy positional matching", () => {
    const bridged = admission(sourceState(undefined, {
      runtime: { ...RUNTIME, inputsFormat: 1 },
    }));
    assert.deepEqual(bridged, {
      strategy: "positional-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      fallbackReason: "inputs-format-legacy",
      eligibility: "legacy",
    });

    const replay = selectPositionalResume({
      index: 0,
      kind: "agent",
      hash: HASH_A,
      inputsHash: INPUT_B,
      eligibility: "legacy",
      firstMiss: initialPositionalFirstMiss("legacy"),
      cached: entryFor(agentRow()),
    });
    assert.equal(replay.action, "replay", "format-1 input bytes are not reinterpreted");

    const future = admission(sourceState(undefined, {
      runtime: { ...RUNTIME, inputsFormat: 3 },
    }));
    assert.equal(future.strategy, "live");
    assert.equal(future.strategy === "live" && future.disabledReason, "runtime-mismatch");
  });

  it("uses manifest identity for crash residue without consulting world state", () => {
    const legacyCrashed = sourceState(undefined, {
      status: "paused",
      pauseReason: "interrupted",
      runtime: { ...RUNTIME, inputsFormat: 1 },
      resume: { format: "identity-v1" },
    });
    assert.deepEqual(admission(legacyCrashed), {
      strategy: "positional-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      fallbackReason: "inputs-format-legacy",
      eligibility: "legacy",
    });

    const currentCrashed = sourceState(undefined, {
      status: "paused",
      pauseReason: "interrupted",
      resume: { format: "identity-v1" },
    });
    const currentDecision = admission(currentCrashed);
    assert.equal(currentDecision.strategy, "identity-v1");

    const drifted = sourceState(undefined, {
      status: "paused",
      pauseReason: "interrupted",
      resume: { format: "identity-v1" },
    });
    const driftDecision = admission(drifted);
    assert.equal(driftDecision.strategy, "identity-v1");

    const markerless = structuredClone(drifted);
    delete markerless.resume;
    const markerlessDecision = admission(markerless);
    assert.equal(markerlessDecision.strategy, "positional-v1");
    if (markerlessDecision.strategy === "positional-v1") {
      assert.equal(markerlessDecision.fallbackReason, "legacy-recording");
    }

    const malformedTerminal = sourceState(undefined, {
      resume: { format: "identity-v1", terminalEnvironment: {} },
    });
    const malformed = admission(malformedTerminal);
    assert.equal(malformed.strategy, "identity-v1");
  });

  it("replays across retry/concurrency changes and migrates format 1 positionally", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "resume-knobs-cwd-"));
    const persistenceRoot = mkdtempSync(join(tmpdir(), "resume-knobs-runs-"));
    const script = `export const meta = { name: "resume-knobs", description: "resume knobs" };
const first = await agent("first", { label: "first", resume: { filesystem: "read-only" } });
const second = await agent("second", { label: "second", resume: { filesystem: "read-only" } });
return { first, second };`;
    let liveCalls = 0;
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot,
      environmentKey: "resume-knobs-v1",
      agent: {
        async run(prompt) {
          liveCalls++;
          return `recorded:${prompt}`;
        },
      },
    });
    try {
      const source = await manager.runSync(script, undefined, {
        agentRetries: 1,
        concurrency: 2,
      });
      assert.equal(liveCalls, 2);
      const sourceState = manager.getPersistence().load(source.runId);
      assert.ok(sourceState?.runtime);
      sourceState.runtime.engineVersion = "0.25.0";
      manager.getPersistence().save(sourceState);
      const variants = [
        { runId: "retries-changed", agentRetries: 0 },
        { runId: "concurrency-changed", concurrency: 7 },
      ] as const;
      for (const variant of variants) {
        const resumed = await manager.runSync(script, undefined, {
          ...variant,
          resumeFromRunId: source.runId,
        });
        assert.equal(resumed.resumeReport?.strategy, "identity-v1", variant.runId);
        assert.equal(resumed.resumeReport?.replayed, 2, variant.runId);
        assert.equal(resumed.resumeReport?.live, 0, variant.runId);
        assert.equal(resumed.replayEligibility?.engineVersionComparison, "different", variant.runId);
      }
      assert.equal(liveCalls, 2, "operational changes never invoke the runner for completed calls");

      const persisted = manager.getPersistence().load(source.runId);
      assert.ok(persisted?.runtime);
      persisted.runtime.inputsFormat = 1;
      manager.getPersistence().save(persisted);
      const bridged = await manager.runSync(script, undefined, {
        runId: "format-one-bridge",
        resumeFromRunId: source.runId,
        agentRetries: 0,
        concurrency: 9,
      });
      assert.equal(bridged.resumeReport?.strategy, "positional-v1");
      if (bridged.resumeReport?.strategy === "positional-v1") {
        assert.equal(bridged.resumeReport.fallbackReason, "inputs-format-legacy");
        assert.equal(bridged.resumeReport.eligibility, "legacy");
      }
      assert.equal(bridged.resumeReport?.replayed, 2);
      assert.equal(liveCalls, 2);
      const bridgedState = manager.getPersistence().load("format-one-bridge");
      assert.equal(bridgedState?.runtime?.inputsFormat, 2);

      const upgraded = await manager.runSync(script, undefined, {
        runId: "format-two-upgraded",
        resumeFromRunId: "format-one-bridge",
      });
      assert.equal(
        upgraded.resumeReport?.strategy,
        "identity-v1",
        "the format-2 target admits identity replay on its next hop",
      );
      assert.equal(upgraded.resumeReport?.replayed, 2);
      assert.equal(upgraded.resumeReport?.live, 0);
      assert.equal(liveCalls, 2, "format-2 re-journaling enables identity replay on the next hop");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  });

  it("pins the remaining structural, status, metadata, and runtime-format outcomes", () => {
    const cases: Array<[string, PersistedRunState, Partial<Omit<ResumeAdmissionInput, "source">>, string]> = [
      ["unsupported", sourceState(undefined, { resume: { format: "future" } as never }), {}, "unsupported-format"],
      ["running", sourceState(undefined, { status: "running" }), {}, "source-not-terminal"],
      ["isolation", sourceState(undefined, { executionMode: { kind: "isolation", baselineRunId: "base" } }), {}, "isolation-recording"],
      ["cwd metadata", sourceState(undefined, { effectiveCwd: undefined }), {}, "resume-metadata-missing"],
      ["runtime metadata", sourceState(undefined, { runtime: undefined }), {}, "resume-metadata-missing"],
      ["journal metadata", sourceState(undefined, { journal: undefined }), {}, "resume-metadata-missing"],
      ["manifest metadata", sourceState(undefined, { calls: undefined }), {}, "resume-metadata-missing"],
      ["allocation metadata", sourceState(undefined, { callsAllocated: undefined }), {}, "resume-metadata-missing"],
      ["cwd", sourceState(), { current: { effectiveCwd: "/other", runtime: RUNTIME } }, "cwd-mismatch"],
      ["path format", sourceState(undefined, { runtime: { ...RUNTIME, pathFormat: 0 } }), {}, "runtime-mismatch"],
      ["input format", sourceState(undefined, { runtime: { ...RUNTIME, inputsFormat: 3 } }), {}, "runtime-mismatch"],
      ["checkpoint format", sourceState(undefined, { runtime: { ...RUNTIME, checkpointInputsFormat: 0 } }), {}, "runtime-mismatch"],
    ];
    for (const [name, source, overrides, reason] of cases) {
      const decision = admission(source, overrides);
      assert.equal(decision.strategy, "live", name);
      assert.equal(decision.strategy === "live" && decision.disabledReason, reason, name);
    }

    assert.equal(
      admission(sourceState(undefined, { status: "aborted" })).strategy,
      "identity-v1",
      "a terminal aborted source keeps its completed correspondence candidates",
    );
    assert.equal(
      admission(sourceState(undefined, { abortSignaled: true })).strategy,
      "identity-v1",
      "an abort marker is diagnostic once the source has terminal persisted call facts",
    );

    const missingTerminal = admission(sourceState(undefined, {
      resume: { format: "identity-v1" },
    }));
    assert.equal(missingTerminal.strategy, "identity-v1");

    const missingSource = admission(sourceState(undefined, { environment: undefined }));
    assert.equal(missingSource.strategy, "identity-v1");
  });

  it("admits missing or changed Node and V8 provenance because only formats gate", () => {
    const cases: Array<[string, PersistedRunState, Partial<Omit<ResumeAdmissionInput, "source">>]> = [
      ["node", sourceState(undefined, { runtime: { ...RUNTIME, node: "v0" } }), {}],
      ["v8", sourceState(undefined, { runtime: { ...RUNTIME, v8: "v0" } }), {}],
      ["node missing", sourceState(undefined, { runtime: { ...RUNTIME, node: undefined } as never }), {}],
      ["v8 missing", sourceState(undefined, { runtime: { ...RUNTIME, v8: undefined } as never }), {}],
    ];
    for (const [name, source, overrides] of cases) {
      assert.equal(admission(source, overrides).strategy, "identity-v1", name);
    }
  });

  it("ignores source drift when choosing identity or positional correspondence", () => {
    const drifted = sourceState(undefined, {
      environment: { key: "source-start" },
      resume: { format: "identity-v1", terminalEnvironment: { key: "source-terminal" } },
    });
    const automatic = admission(drifted);
    assert.equal(automatic.strategy, "identity-v1");

    const positional = admission(drifted, { requestedPolicy: "positional" });
    assert.equal(positional.strategy, "positional-v1");
    assert.equal(positional.strategy === "positional-v1" && positional.eligibility, "safe-prefix");

    const unsafeRow = agentRow();
    delete unsafeRow.resumeSafety;
    const unsafe = sourceState([unsafeRow], {
      environment: { key: "source-start" },
      resume: { format: "identity-v1", terminalEnvironment: { key: "source-terminal" } },
    });
    const unsafeDecision = admission(unsafe);
    assert.equal(unsafeDecision.strategy, "identity-v1");
  });

  it("requires a dense bijective manifest and every result identity fact", () => {
    const missingPath = admission(sourceState([agentRow(0, { path: undefined })]));
    assert.equal(missingPath.strategy === "live" && missingPath.disabledReason, "manifest-invalid");
    const missingInputs = admission(sourceState([agentRow(0, { inputsHash: undefined })]));
    assert.equal(missingInputs.strategy === "live" && missingInputs.disabledReason, "manifest-invalid");
    const withoutHistoricalDebit = admission(sourceState([agentRow()]));
    assert.equal(withoutHistoricalDebit.strategy, "identity-v1");

    const missingPair = sourceState();
    missingPair.journal = [];
    assert.equal(admission(missingPair).strategy === "live" && admission(missingPair).disabledReason, "manifest-invalid");
    const stalePair = sourceState();
    stalePair.journal?.push({ index: 1, hash: HASH_B, result: true, kind: "checkpoint", scope: SOURCE_RUN_ID });
    assert.equal(admission(stalePair).strategy === "live" && admission(stalePair).disabledReason, "manifest-invalid");

    const missingHighest = sourceState([agentRow(0)]);
    missingHighest.callsAllocated = 2;
    assert.equal(admission(missingHighest).strategy === "live" && admission(missingHighest).disabledReason, "manifest-invalid");
    const duplicate = sourceState([agentRow(0), agentRow(0, { hash: HASH_B, inputsHash: INPUT_B })]);
    assert.equal(admission(duplicate).strategy === "live" && admission(duplicate).disabledReason, "manifest-invalid");

    const replayed = agentRow(0, {
      origin: "journal-replay",
      replay: {
        sourceRunId: "older",
        recordedIndex: 4,
        match: "path-hash",
        sourceResumeSafety: "declared-read-only",
      },
    });
    assert.equal(admission(sourceState([replayed])).strategy, "identity-v1");

    const unknownSafety = agentRow(0) as WorkflowCallRecord & { resumeSafety: string };
    unknownSafety.resumeSafety = "future-safety";
    assert.equal(
      admission(sourceState([unknownSafety])).strategy === "live" &&
        admission(sourceState([unknownSafety])).disabledReason,
      "manifest-invalid",
    );
  });

  it("assigns the exact first failure without replacement", () => {
    const unknownAborted = sourceState(undefined, {
      resume: { format: "future" } as never,
      status: "aborted",
    });
    assert.equal(admission(unknownAborted).strategy === "live" && admission(unknownAborted).disabledReason, "unsupported-format");
    const abortedRunning = sourceState(undefined, { status: "running", abortSignaled: true });
    assert.equal(admission(abortedRunning).strategy === "live" && admission(abortedRunning).disabledReason, "source-not-terminal");
    const runningIsolation = sourceState(undefined, {
      status: "running",
      executionMode: { kind: "isolation", baselineRunId: "base" },
    });
    assert.equal(admission(runningIsolation).strategy === "live" && admission(runningIsolation).disabledReason, "source-not-terminal");
    const isolationMissing = sourceState(undefined, {
      executionMode: { kind: "isolation", baselineRunId: "base" },
      resume: { format: "identity-v1" },
    });
    assert.equal(admission(isolationMissing).strategy === "live" && admission(isolationMissing).disabledReason, "isolation-recording");
    const missingEnvironmentAndCwd = sourceState(undefined, {
      effectiveCwd: undefined,
      resume: { format: "identity-v1" },
    });
    assert.equal(admission(missingEnvironmentAndCwd).strategy === "live" && admission(missingEnvironmentAndCwd).disabledReason, "resume-metadata-missing");
    const cwdAndRuntime = sourceState(undefined, { runtime: { ...RUNTIME, node: "bad" } });
    const current = { effectiveCwd: "/other", runtime: RUNTIME, environment: ENVIRONMENT };
    assert.equal(admission(cwdAndRuntime, { current }).strategy === "live" && admission(cwdAndRuntime, { current }).disabledReason, "cwd-mismatch");
  });

  it("validates retained seeds while stripping legacy debit metadata", () => {
    const replayCall = agentRow(0, {
      origin: "journal-replay",
      replay: {
        sourceRunId: "older-run",
        recordedIndex: 7,
        match: "unique-hash",
        sourceResumeSafety: "declared-read-only",
      },
    });
    const legacyReplayCall = replayCall as WorkflowCallRecord & {
      budgetDebit: number;
      replay: NonNullable<WorkflowCallRecord["replay"]> & { logicalBudgetDebit: number };
    };
    legacyReplayCall.budgetDebit = 0;
    legacyReplayCall.replay.logicalBudgetDebit = 13;
    const cloned = cloneResumeCandidate(SOURCE_RUN_ID, entryFor(legacyReplayCall), legacyReplayCall);
    assert.notEqual(cloned?.call, replayCall);
    assert.equal(Object.hasOwn(cloned ?? {}, "logicalBudgetDebit"), false);
    assert.equal(Object.hasOwn(cloned?.call ?? {}, "budgetDebit"), false);
    assert.equal(Object.hasOwn(cloned?.call.replay ?? {}, "logicalBudgetDebit"), false);

    const validRetained = candidate(2, { sourceRunId: "older-run", call: { hash: HASH_C, inputsHash: INPUT_C } });
    const withSeed = sourceState(undefined, {
      resumeSeed: {
        format: "identity-v1",
        sourceRunId: SOURCE_RUN_ID,
        candidates: [validRetained],
      },
    });
    const admitted = admission(withSeed);
    assert.equal(admitted.strategy, "identity-v1");
    assert.equal(admitted.strategy === "identity-v1" && admitted.seed.candidates.length, 2);

    const invalidImmediate = sourceState(undefined, {
      resumeSeed: { format: "identity-v1", sourceRunId: "wrong", candidates: [] },
    });
    assert.equal(admission(invalidImmediate).strategy === "live" && admission(invalidImmediate).disabledReason, "resume-seed-invalid");

    const invalidBlocker = blocker();
    invalidBlocker.recordedIndex = 1;
    const withInvalidBlocker = sourceState(undefined, {
      resumeSeed: {
        format: "identity-v1",
        sourceRunId: SOURCE_RUN_ID,
        candidates: [],
        callBlockers: [invalidBlocker],
      },
    });
    assert.equal(
      admission(withInvalidBlocker).strategy === "live" && admission(withInvalidBlocker).disabledReason,
      "resume-seed-invalid",
    );

    const collision = normalizeResumeSeed({
      sourceRunId: SOURCE_RUN_ID,
      promoted: [candidate()],
      retained: [candidate()],
    });
    assert.equal(collision, undefined);
    const crossKindCollision = normalizeResumeSeed({
      sourceRunId: SOURCE_RUN_ID,
      promoted: [candidate()],
      retainedInjections: [injection()],
    });
    assert.equal(crossKindCollision, undefined);
  });

  it("parses canonical source-index checkpoint replies and prepares only unique injections", () => {
    const context = { callIndex: 1, hash: HASH_B, prompt: "approve?", kind: "confirm" as const };
    assert.deepEqual(parseCheckpointReplies({ 1: { approved: true } }, context), {
      recordedIndex: 1,
      decision: { approved: true },
    });
    for (const replies of [{ "01": true }, { "-0": true }, { 0: true }, { 1: true, 2: false }]) {
      assert.throws(() => parseCheckpointReplies(replies, context), (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      );
    }
    assert.throws(() => parseCheckpointReplies({ 1: true }, undefined), (error: unknown) =>
      error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assert.throws(() => parseCheckpointReplies({ 1: cyclic }, context), (error: unknown) =>
      error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    );

    const pending = checkpointRow(1, {
      outcome: "error",
      origin: "headless",
      error: {
        form: "workflow-error",
        message: "awaits reply",
        code: WorkflowErrorCode.CHECKPOINT_REQUIRED,
      },
    });
    const prior = agentRow(0);
    const paused = sourceState([prior, pending], {
      status: "paused",
      pauseReason: "checkpoint_required",
      checkpointContext: context,
    });
    const injected = admission(paused, { checkpointReplies: { 1: { approved: true } } });
    assert.equal(injected.strategy, "identity-v1");
    assert.equal(injected.facts?.pendingRepresented, true);
    assert.deepEqual(
      injected.strategy === "identity-v1" && injected.seed.checkpointInjections,
      [{
        sourceRunId: SOURCE_RUN_ID,
        recordedIndex: 1,
        hash: HASH_B,
        path: "workflow.js:2:1",
        inputsHash: INPUT_B,
        decision: { approved: true },
      }],
    );

    const withoutReply = admission(paused);
    assert.equal(withoutReply.strategy, "identity-v1");
    assert.equal(withoutReply.facts?.pendingRepresented, false);
    assert.equal(withoutReply.strategy === "identity-v1" && withoutReply.seed.callBlockers?.length, 1);

    const duplicateRow = checkpointRow(2, { hash: HASH_B, inputsHash: INPUT_B });
    const duplicateSource = sourceState([prior, pending, duplicateRow], {
      status: "paused",
      pauseReason: "checkpoint_required",
      checkpointContext: context,
    });
    const duplicateDecision = admission(duplicateSource, { checkpointReplies: { 1: true } });
    assert.equal(duplicateDecision.strategy, "identity-v1");
    assert.equal(duplicateDecision.facts?.pendingRepresented, false);

    const retainedCheckpoint = candidate(4, {
      sourceRunId: "older-run",
      call: {
        kind: "checkpoint",
        hash: HASH_B,
        path: "older-checkpoint",
        inputsHash: INPUT_B,
        origin: "confirm",
        resumeSafety: undefined,
      },
      entry: { kind: "checkpoint", hash: HASH_B, result: false },
    });
    delete retainedCheckpoint.call.resumeSafety;
    const retainedBlocker = sourceState([prior, pending], {
      status: "paused",
      pauseReason: "checkpoint_required",
      checkpointContext: context,
      resumeSeed: {
        format: "identity-v1",
        sourceRunId: SOURCE_RUN_ID,
        candidates: [retainedCheckpoint],
      },
    });
    const retainedBlocked = admission(retainedBlocker, { checkpointReplies: { 1: true } });
    assert.equal(retainedBlocked.strategy, "identity-v1");
    assert.equal(retainedBlocked.facts?.pendingRepresented, false);

    const corrupt = sourceState([prior, { ...pending, hash: HASH_C }], {
      status: "paused",
      pauseReason: "checkpoint_required",
      checkpointContext: context,
    });
    const corruptDecision = admission(corrupt, { checkpointReplies: { 1: true } });
    assert.equal(corruptDecision.strategy === "live" && corruptDecision.disabledReason, "manifest-invalid");
  });
});

describe("identity candidate indexes and selection", () => {
  it("constructs the frozen exact/content keys shared with isolation", () => {
    assert.equal(resumeExactKey("agent", "path", HASH_A), `agent\u0000path\u0000${HASH_A}`);
    assert.equal(resumeContentKey(HASH_A, INPUT_A), `${HASH_A}\u0000${INPUT_A}`);
    const indexes = buildResumeCandidateIndexes(seed());
    assert.equal(indexes.exact.get(resumeExactKey("agent", "workflow.js:1:1", HASH_A))?.length, 1);
    assert.equal(indexes.content.agent.get(resumeContentKey(HASH_A, INPUT_A))?.length, 1);
    assert.equal(indexes.content.checkpoint.get(resumeContentKey(HASH_A, INPUT_A)), undefined);
    assert.equal("set" in indexes.exact, false);
    assert.equal(Object.isFrozen(indexes.exact), true);
  });

  it("keeps isolation's shared index exact-only while mainline permits unique content movement", () => {
    const row = agentRow();
    const isolationIndex = buildResumeExactIndex([row], (value) => ({
      kind: value.kind,
      path: value.path as string,
      hash: value.hash,
    }));
    assert.equal(isolationIndex.get(resumeExactKey("agent", "moved-path", HASH_A)), undefined);
    const mainline = selectResumeCandidate(
      buildResumeCandidateIndexes(seed()),
      matchInput({ path: "moved-path" }),
    );
    assert.equal(mainline.action, "replay");
    assert.equal(mainline.action === "replay" && mainline.match, "unique-hash");
  });

  it("selects exact identities before unique moved content", () => {
    const indexes = buildResumeCandidateIndexes(seed());
    const exact = selectResumeCandidate(indexes, matchInput());
    assert.equal(exact.action, "replay");
    assert.equal(exact.action === "replay" && exact.match, "path-hash");

    const moved = selectResumeCandidate(indexes, matchInput({ path: "workflow.js:99:1" }));
    assert.equal(moved.action, "replay");
    assert.equal(moved.action === "replay" && moved.match, "unique-hash");

    const changedAtSamePath = selectResumeCandidate(indexes, matchInput({ hash: HASH_B }));
    assert.deepEqual(changedAtSamePath, { action: "live", reason: "not-recorded" });
  });

  it("runs call blockers live and keeps them in identity multiplicity", () => {
    const blockedSeed: PersistedResumeSeed = {
      format: "identity-v1",
      sourceRunId: SOURCE_RUN_ID,
      candidates: [],
      callBlockers: [blocker()],
    };
    const indexes = buildResumeCandidateIndexes(blockedSeed);
    const blocked = selectResumeCandidate(indexes, matchInput());
    assert.equal(blocked.action, "live");
    assert.equal(blocked.action === "live" && blocked.reason, "not-recorded");
    assert.equal(blocked.action === "live" && blocked.remove?.type, "blocker");

    const ambiguous = buildResumeCandidateIndexes({
      ...blockedSeed,
      candidates: [candidate()],
    });
    assert.deepEqual(selectResumeCandidate(ambiguous, matchInput()), {
      action: "live",
      reason: "ambiguous-identity",
    });
  });

  it("orders correspondence and consumption decisions from journal identity alone", () => {
    const indexes = buildResumeCandidateIndexes(seed());
    assert.deepEqual(selectResumeCandidate(indexes, matchInput({ path: undefined })), {
      action: "live",
      reason: "path-missing",
    });
    assert.deepEqual(selectResumeCandidate(indexes, matchInput({ inputsHash: undefined })), {
      action: "live",
      reason: "inputs-missing",
    });
    assert.deepEqual(selectResumeCandidate(indexes, matchInput({ inputsHash: INPUT_B })), {
      action: "live",
      reason: "inputs-changed",
    });
    assert.deepEqual(selectResumeCandidate(indexes, matchInput({ path: "moved", inputsHash: INPUT_B })), {
      action: "live",
      reason: "inputs-changed",
    });
    const occurrence = indexedSourceOccurrence(
      indexes.exact.get(resumeExactKey("agent", "workflow.js:1:1", HASH_A))?.[0] as never,
    );
    assert.deepEqual(selectResumeCandidate(indexes, matchInput({ consumed: new Set([occurrence]) })), {
      action: "live",
      reason: "candidate-consumed",
    });
  });

  it("keeps original exact and content multiplicity after consumption", () => {
    const sameExact = candidate(1, {
      call: { path: "workflow.js:1:1", inputsHash: INPUT_B },
    });
    const exactIndexes = buildResumeCandidateIndexes(seed([candidate(), sameExact]));
    const consumed = new Set([indexedSourceOccurrence(exactIndexes.exact.get(
      resumeExactKey("agent", "workflow.js:1:1", HASH_A),
    )?.[0] as never)]);
    assert.deepEqual(selectResumeCandidate(exactIndexes, matchInput({ consumed })), {
      action: "live",
      reason: "ambiguous-identity",
    });

    const movedDuplicate = candidate(1, {
      call: { path: "workflow.js:2:1" },
    });
    const contentIndexes = buildResumeCandidateIndexes(seed([candidate(), movedDuplicate]));
    assert.deepEqual(selectResumeCandidate(contentIndexes, matchInput({ path: "new-path" })), {
      action: "live",
      reason: "ambiguous-content",
    });
  });

  it("applies the empty-output guard while ignoring source-world classifications", () => {
    const empty = candidate(0, { entry: { result: "  \n" } });
    const emptyIndexes = buildResumeCandidateIndexes(seed([empty]));
    const emptyDecision = selectResumeCandidate(emptyIndexes, matchInput());
    assert.equal(emptyDecision.action, "live");
    assert.equal(emptyDecision.action === "live" && emptyDecision.reason, "empty-output");
    assert.equal(emptyDecision.action === "live" && emptyDecision.remove?.type, "candidate");
    assert.equal(selectResumeCandidate(emptyIndexes, matchInput({ hasSchema: true })).action, "replay");

    const unannotated = candidate();
    delete unannotated.call.resumeSafety;
    const ordinary = buildResumeCandidateIndexes(seed([unannotated]));
    assert.equal(selectResumeCandidate(ordinary, matchInput()).action, "replay");

    const worktree = candidate(0, {
      call: {
        isolation: "worktree",
        worktree: true,
        resumeSafety: "isolated-worktree",
      },
    });
    const worktreeIndexes = buildResumeCandidateIndexes(seed([worktree]));
    assert.equal(selectResumeCandidate(worktreeIndexes, matchInput()).action, "replay");
  });

  it("partitions primitive kinds and includes checkpoint injections in multiplicity", () => {
    const checkpointCandidate = candidate(0, {
      call: {
        kind: "checkpoint",
        hash: HASH_B,
        path: "checkpoint-path",
        inputsHash: INPUT_B,
        origin: "confirm",
        resumeSafety: undefined,
      },
      entry: { kind: "checkpoint", hash: HASH_B, result: true },
    });
    const injected = injection(3, { path: "injected-path" });
    const indexes = buildResumeCandidateIndexes(seed([checkpointCandidate], [injected]));
    assert.deepEqual(selectResumeCandidate(indexes, matchInput({
      kind: "checkpoint",
      hash: HASH_B,
      path: "checkpoint-path",
      inputsHash: INPUT_C,
    })), {
      action: "live",
      reason: "inputs-changed",
    });
    const checkpointInput = matchInput({
      kind: "checkpoint",
      hash: HASH_B,
      path: "new-path",
      inputsHash: INPUT_B,
    });
    assert.deepEqual(selectResumeCandidate(indexes, checkpointInput), {
      action: "live",
      reason: "ambiguous-content",
    });
    assert.deepEqual(selectResumeCandidate(indexes, matchInput({
      hash: HASH_B,
      path: "new-path",
      inputsHash: INPUT_B,
    })), {
      action: "live",
      reason: "not-recorded",
    });
  });
});

describe("positional resume selection", () => {
  it("keeps legacy hash-only matching and reports the first miss and suffix", () => {
    const call = agentRow();
    const cached = entryFor(call, "cached");
    assert.equal(initialPositionalFirstMiss("legacy"), Number.POSITIVE_INFINITY);
    assert.equal(initialPositionalFirstMiss("all-live"), 0);
    assert.deepEqual(selectPositionalResume({
      index: 0,
      kind: "agent",
      hash: HASH_A,
      eligibility: "legacy",
      firstMiss: Number.POSITIVE_INFINITY,
      cached,
    }), {
      action: "replay",
      entry: cached,
      match: "index-hash",
      nextFirstMiss: Number.POSITIVE_INFINITY,
    });
    assert.deepEqual(selectPositionalResume({
      index: 0,
      kind: "checkpoint",
      hash: HASH_A,
      eligibility: "legacy",
      firstMiss: Number.POSITIVE_INFINITY,
      cached,
    }), {
      action: "replay",
      entry: cached,
      match: "index-hash",
      nextFirstMiss: Number.POSITIVE_INFINITY,
    });
    assert.deepEqual(selectPositionalResume({
      index: 1,
      kind: "agent",
      hash: HASH_A,
      eligibility: "legacy",
      firstMiss: 0,
      cached,
    }), {
      action: "live",
      reason: "positional-suffix",
      nextFirstMiss: 0,
    });
    assert.deepEqual(selectPositionalResume({
      index: 0,
      kind: "agent",
      hash: HASH_A,
      eligibility: "all-live",
      firstMiss: Number.POSITIVE_INFINITY,
      cached,
    }), {
      action: "live",
      reason: "positional-suffix",
      nextFirstMiss: 0,
    });
  });

  it("requires new-format input agreement while ignoring world classifications", () => {
    const first = agentRow(0);
    const second = agentRow(1, { path: first.path });
    for (const call of [first, second]) {
      const decision = selectPositionalResume({
        index: call.index,
        kind: "agent",
        hash: call.hash,
        inputsHash: call.inputsHash,
        eligibility: "safe-prefix",
        firstMiss: Number.POSITIVE_INFINITY,
        cached: entryFor(call),
        sourceCall: call,
      });
      assert.equal(decision.action, "replay");
      assert.equal(Object.hasOwn(decision, "logicalBudgetDebit"), false);
    }

    const changedInputs = selectPositionalResume({
      index: 0,
      kind: "agent",
      hash: HASH_A,
      inputsHash: INPUT_B,
      eligibility: "safe-prefix",
      firstMiss: Number.POSITIVE_INFINITY,
      cached: entryFor(first),
      sourceCall: first,
    });
    assert.equal(changedInputs.action === "live" && changedInputs.reason, "positional-miss");

    const unsafe = { ...first };
    delete unsafe.resumeSafety;
    const unsafeDecision = selectPositionalResume({
      index: 0,
      kind: "agent",
      hash: HASH_A,
      inputsHash: INPUT_A,
      eligibility: "safe-prefix",
      firstMiss: Number.POSITIVE_INFINITY,
      cached: entryFor(unsafe),
      sourceCall: unsafe,
    });
    assert.equal(unsafeDecision.action, "replay");
  });

  it("rejects changed checkpoint inputs and replays completed headless results", () => {
    const confirmed = checkpointRow();
    const cached = entryFor(confirmed, true);
    assert.equal(selectPositionalResume({
      index: 0,
      kind: "checkpoint",
      hash: HASH_B,
      inputsHash: INPUT_B,
      eligibility: "safe-prefix",
      firstMiss: Number.POSITIVE_INFINITY,
      cached,
      sourceCall: confirmed,
    }).action, "replay");
    const changed = selectPositionalResume({
      index: 0,
      kind: "checkpoint",
      hash: HASH_B,
      inputsHash: INPUT_C,
      eligibility: "safe-prefix",
      firstMiss: Number.POSITIVE_INFINITY,
      cached,
      sourceCall: confirmed,
    });
    assert.equal(changed.action === "live" && changed.reason, "positional-miss");
    const headless = checkpointRow(0, { origin: "headless" });
    const unproved = selectPositionalResume({
      index: 0,
      kind: "checkpoint",
      hash: HASH_B,
      inputsHash: INPUT_B,
      eligibility: "safe-prefix",
      firstMiss: Number.POSITIVE_INFINITY,
      cached: entryFor(headless),
      sourceCall: headless,
    });
    assert.equal(unproved.action, "replay");
  });
});

describe("incremental resume report construction", () => {
  it("sorts cloned decisions, computes counters, and emits only strategy fields", () => {
    const decisions: WorkflowResumeCallDecision[] = [
      { index: 2, kind: "agent", action: "failed", reason: "resume-fatal-latch" },
      { index: 0, kind: "agent", action: "replayed", sourceRunId: SOURCE_RUN_ID, recordedIndex: 7, match: "unique-hash" },
      { index: 1, kind: "checkpoint", action: "live", reason: "not-recorded" },
    ];
    const report = buildResumeReport({
      strategy: "positional-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "positional",
      fallbackReason: "forced-positional",
      eligibility: "safe-prefix",
    }, decisions);
    assert.deepEqual(report, {
      strategy: "positional-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "positional",
      replayed: 1,
      live: 1,
      failed: 1,
      calls: [decisions[1], decisions[2], decisions[0]],
      fallbackReason: "forced-positional",
      eligibility: "safe-prefix",
    });
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.calls), true);
    assert.notEqual(report.calls, decisions);
    assert.throws(() => buildResumeReport({
      strategy: "identity-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
    }, [decisions[0], { ...decisions[0] }]));

    const live = buildResumeReport({
      strategy: "live",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      disabledReason: "runtime-mismatch",
    }, []);
    assert.deepEqual(live, {
      strategy: "live",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      replayed: 0,
      live: 0,
      failed: 0,
      calls: [],
      disabledReason: "runtime-mismatch",
    });
  });
});
