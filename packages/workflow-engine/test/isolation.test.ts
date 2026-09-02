import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import type {
  AgentRunner,
  AgentUsage,
  RunOptions,
  WorkflowCallRecord,
  WorkflowRecordedError,
} from "@automatalabs/shared-types";
import {
  createReplayRunner,
  RECORDING_UNUSABLE_REASONS,
  REPLAY_DIVERGENCE_KINDS,
  runIsolation,
  type IsolationTarget,
} from "../src/isolation.js";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { CALL_INPUTS_FORMAT, CALL_PATH_FORMAT, runWorkflow } from "../src/workflow.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";

const ENVIRONMENT_KEY = "isolation-test-environment";
const EXECUTION_CWD = join(tmpdir(), "agentprism-isolation-fixture");
const usage = (total: number): AgentUsage => ({
  input: Math.max(0, total - 1),
  output: Math.min(1, total),
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost: 0,
});

function resultRow(overrides: Partial<WorkflowCallRecord> = {}): WorkflowCallRecord {
  return {
    index: 0,
    kind: "agent",
    hash: "hash-0",
    path: "1:1",
    inputsHash: "inputs-0",
    label: "target",
    outcome: "result",
    origin: "runner",
    attempts: 1,
    usage: usage(4),
    modelRequested: "baseline/requested",
    modelResolved: "baseline/resolved",
    resolvedCwd: EXECUTION_CWD,
    settlementOrdinal: 1,
    scope: "baseline-run",
    ...overrides,
  };
}

function recording(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  const row = resultRow();
  return {
    runId: "baseline-run",
    workflowName: "baseline",
    script:
      "export const meta = { name: 'baseline', description: 'isolation test' }\nreturn await agent('target', { label: 'target', model: 'baseline/requested' })",
    effectiveCwd: EXECUTION_CWD,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      pathFormat: CALL_PATH_FORMAT,
      inputsFormat: CALL_INPUTS_FORMAT,
    },
    environment: { key: ENVIRONMENT_KEY },
    status: "completed",
    phases: [],
    agents: [
      {
        id: 1,
        label: "target",
        prompt: "target",
        status: "done",
        callIndex: 0,
        scope: "baseline-run",
      },
    ],
    logs: [],
    journal: [{ index: 0, hash: row.hash, result: { held: true }, kind: "agent", scope: "baseline-run" }],
    calls: [row],
    callsAllocated: 1,
    limits: {
      maxAgents: 10,
      concurrency: 2,
      agentRetries: 0,
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function replay(
  value = recording(),
  options: {
    inner?: AgentRunner;
    live?: IsolationTarget[];
    executionCwd?: string;
    environmentKey?: string;
    rootRunId?: string;
  } = {},
) {
  return createReplayRunner({
    recording: value,
    inner: options.inner ?? { async run() { return "live"; } },
    live: options.live ?? [{ callIndex: 0, model: "candidate/model" }],
    rootRunId: options.rootRunId ?? "isolation-run",
    executionCwd: options.executionCwd ?? EXECUTION_CWD,
    environmentKey: options.environmentKey ?? ENVIRONMENT_KEY,
  });
}

function expectWorkflowError(
  action: () => unknown,
  code: WorkflowErrorCode,
  reason?: string,
): WorkflowError {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, code);
    if (reason !== undefined) assert.equal((error.details as { reason?: string }).reason, reason);
    return true;
  });
  try {
    action();
  } catch (error) {
    return error as WorkflowError;
  }
  throw new Error("expected action to throw");
}

describe("isolation preflight", () => {
  it("exports the complete frozen reason and divergence vocabularies", () => {
    assert.equal(RECORDING_UNUSABLE_REASONS.length, 22);
    assert.equal(REPLAY_DIVERGENCE_KINDS.length, 11);
    assert.equal(new Set(RECORDING_UNUSABLE_REASONS).size, RECORDING_UNUSABLE_REASONS.length);
    assert.equal(new Set(REPLAY_DIVERGENCE_KINDS).size, REPLAY_DIVERGENCE_KINDS.length);
  });

  it("rejects every recording-level reason with typed details", async () => {
    const hardError: WorkflowRecordedError = {
      form: "workflow-error",
      message: "hard",
      code: WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
      recoverable: false,
    };
    const cases: Array<[string, () => PersistedRunState]> = [
      ["corrupt-structure", () => recording({ runId: "" })],
      ["not-completed", () => recording({ status: "failed" })],
      ["script-invalid", () => recording({ script: "return (" })],
      ["incomplete-manifest", () => recording({ callsAllocated: 2 })],
      ["nested-workflow-recording", () => recording({ nestedWorkflows: true })],
      ["isolation-artifact", () => recording({ executionMode: { kind: "isolation", baselineRunId: "other" } })],
      ["legacy-resume", () => recording({ legacyResume: true })],
      ["abort-residue", () => recording({ abortSignaled: true })],
      [
        "engine-origin-row",
        () =>
          recording({
            calls: [
              resultRow({
                outcome: "error",
                origin: "engine",
                attempts: undefined,
                usage: undefined,
                error: hardError,
              }),
            ],
            journal: [],
          }),
      ],
      ["replayed-row", () => recording({ calls: [resultRow({ provenance: { source: "replay" } })] })],
      [
        "unreplayable-error",
        () =>
          recording({
            calls: [resultRow({ outcome: "error", error: { ...hardError, lossy: true } })],
            journal: [],
          }),
      ],
      ["args-unreplayable", () => recording({ argsUnreplayable: true })],
      [
        "ambiguous-identity",
        () => {
          const first = resultRow();
          const second = resultRow({ index: 1, settlementOrdinal: 2 });
          return recording({
            calls: [first, second],
            callsAllocated: 2,
            agents: [],
            journal: [
              { index: 0, hash: first.hash, result: "a", kind: "agent", scope: "baseline-run" },
              { index: 1, hash: second.hash, result: "b", kind: "agent", scope: "baseline-run" },
            ],
          });
        },
      ],
      ["path-missing", () => recording({ calls: [resultRow({ path: undefined })] })],
      [
        "runtime-mismatch",
        () => recording({ runtime: { ...recording().runtime!, v8: `${process.versions.v8}-drift` } }),
      ],
      ["no-limits", () => recording({ limits: undefined })],
      ["agent-limit-boundary", () => recording({ limits: { ...recording().limits!, maxAgents: 1 } })],
      ["no-execution-cwd", () => recording({ effectiveCwd: undefined, cwd: undefined })],
      ["no-environment-identity", () => recording({ environment: undefined })],
      ["environment-mismatch", () => recording({ environment: { key: "different" } })],
      ["journal-manifest-mismatch", () => recording({ journal: [] })],
    ];

    for (const [reason, make] of cases) {
      const executionCwd = reason === "no-execution-cwd" ? undefined : EXECUTION_CWD;
      assert.throws(
        () =>
          createReplayRunner({
            recording: make(),
            inner: { async run() { return "never"; } },
            live: [{ callIndex: 0, model: "candidate" }],
            rootRunId: "matrix",
            executionCwd,
            environmentKey: ENVIRONMENT_KEY,
          }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError, reason);
          assert.equal(error.code, WorkflowErrorCode.RECORDING_UNUSABLE, reason);
          assert.equal((error.details as { reason?: string }).reason, reason);
          return true;
        },
      );
    }

    const root = mkdtempSync(join(tmpdir(), "isolation-not-found-"));
    try {
      await assert.rejects(
        runIsolation({
          baselineRunId: "missing",
          runner: { async run() { return "never"; } },
          live: [{ callIndex: 0, model: "candidate" }],
          cwd: EXECUTION_CWD,
          persistenceRoot: root,
          environmentKey: ENVIRONMENT_KEY,
        }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.RECORDING_UNUSABLE);
          assert.equal((error.details as { reason?: string }).reason, "not-found");
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gates every runtime field and exact environment keys", () => {
    const fields = ["node", "v8", "pathFormat", "inputsFormat"] as const;
    for (const field of fields) {
      const runtime = { ...recording().runtime!, [field]: field.endsWith("Format") ? 999 : "drift" };
      expectWorkflowError(() => replay(recording({ runtime })), WorkflowErrorCode.RECORDING_UNUSABLE, "runtime-mismatch");
    }
    replay();
    expectWorkflowError(
      () => replay(recording(), { environmentKey: "other" }),
      WorkflowErrorCode.RECORDING_UNUSABLE,
      "environment-mismatch",
    );
  });

  it("rejects worktree, journal-replay, missing-fingerprint, and unproven targets", () => {
    expectWorkflowError(
      () => replay(recording({ calls: [resultRow({ worktree: true, isolation: "worktree" })] })),
      WorkflowErrorCode.REPLAY_TARGET_INVALID,
      "worktree-target",
    );
    expectWorkflowError(
      () =>
        replay(
          recording({ calls: [resultRow({ origin: "journal-replay", attempts: undefined, resolvedCwd: undefined })] }),
        ),
      WorkflowErrorCode.REPLAY_TARGET_INVALID,
      "journal-replay-target",
    );
    expectWorkflowError(
      () => replay(recording({ calls: [resultRow({ inputsHash: undefined })] })),
      WorkflowErrorCode.REPLAY_TARGET_INVALID,
      "no-input-fingerprint",
    );
    expectWorkflowError(
      () =>
        replay(recording({ calls: [resultRow({ modelResolved: undefined })] }), {
          live: [{ callIndex: 0 }],
        }),
      WorkflowErrorCode.REPLAY_TARGET_INVALID,
      "unproven-baseline-model",
    );
  });
});

describe("replay runner", () => {
  it("serves exact and unique-path outcomes clone-fresh with provenance", async () => {
    const source = recording();
    source.calls = [resultRow({ label: "held" }), resultRow({ index: 1, hash: "target-hash", path: "2:1", label: "target", settlementOrdinal: 2 })];
    source.callsAllocated = 2;
    source.agents = [{ id: 1, label: "target", prompt: "target", status: "done", callIndex: 1, scope: source.runId }];
    source.journal = [
      { index: 0, hash: "hash-0", result: { nested: { value: 1 } }, kind: "agent", scope: source.runId },
      { index: 1, hash: "target-hash", result: "baseline", kind: "agent", scope: source.runId },
    ];
    const runner = replay(source, { live: [{ callIndex: 1, model: "candidate" }] });
    const provenances: unknown[] = [];
    const options = {
      callIndex: 0,
      callHash: "different-live-hash",
      callPath: "1:1",
      callInputsHash: "anything",
      runId: "isolation-run",
      onResultProvenance: (value: unknown) => provenances.push(value),
    } as RunOptions;
    const first = (await runner.run("changed", options)) as unknown as { nested: { value: number } };
    first.nested.value = 99;
    const second = (await runner.run("changed", options)) as unknown as { nested: { value: number } };
    assert.equal(second.nested.value, 1);
    assert.deepEqual(provenances, [
      { source: "replay", recordedRunId: "baseline-run", recordedIndex: 0, hashMatched: false },
      { source: "replay", recordedRunId: "baseline-run", recordedIndex: 0, hashMatched: false },
    ]);
    assert.equal(runner.report().calls[0].hashMatched, false);
  });

  it("binds targets only under fingerprint and cwd equality and rewrites only model", async () => {
    let calls = 0;
    let received: RunOptions | undefined;
    const inner: AgentRunner = {
      async run(_prompt, options) {
        calls++;
        received = options;
        return { candidate: true } as never;
      },
    };
    const drifted = replay(recording(), { inner });
    await assert.rejects(
      drifted.run("target", {
        callIndex: 0,
        callHash: "hash-0",
        callPath: "1:1",
        callInputsHash: "dynamic-label-retry-or-backend-drift",
        runId: "isolation-run",
        cwd: EXECUTION_CWD,
      }),
      (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.REPLAY_DIVERGENCE,
    );
    assert.equal(calls, 0);
    assert.equal(drifted.report().divergence?.kind, "target-inputs-drift");

    const valid = replay(recording(), { inner });
    await valid.run("target", {
      callIndex: 0,
      callHash: "hash-0",
      callPath: "1:1",
      callInputsHash: "inputs-0",
      runId: "isolation-run",
      cwd: EXECUTION_CWD,
      model: "baseline/requested",
      retries: 2,
      meta: { preserved: true },
    } as RunOptions & { retries: number });
    assert.equal(calls, 1);
    assert.equal(received?.model, "candidate/model");
    assert.deepEqual(received?.meta, { preserved: true });
  });

  it("resolves target rows by recorded index when the manifest is in settlement order", async () => {
    const laterIndex = resultRow({
      index: 1,
      hash: "settled-first",
      path: "2:1",
      inputsHash: "inputs-1",
      label: "held",
      settlementOrdinal: 1,
    });
    const targetRow = resultRow({ settlementOrdinal: 2 });
    const source = recording({
      calls: [laterIndex, targetRow],
      callsAllocated: 2,
      journal: [
        { index: 0, hash: targetRow.hash, result: "target baseline", kind: "agent", scope: "baseline-run" },
        { index: 1, hash: laterIndex.hash, result: "held baseline", kind: "agent", scope: "baseline-run" },
      ],
    });
    let delegated = 0;
    const runner = replay(source, {
      inner: { async run() { delegated++; return "candidate"; } },
    });
    await runner.run("target", {
      callIndex: 0,
      callHash: targetRow.hash,
      callPath: targetRow.path,
      callInputsHash: targetRow.inputsHash,
      runId: "isolation-run",
      cwd: EXECUTION_CWD,
    });
    assert.equal(delegated, 1);
    assert.equal(runner.report().calls[0].recordedIndex, 0);
  });

  it("uses sealed candidate evidence and fails closed on a reported fallback", async () => {
    for (const evidence of ["verified", "unverified", "fallback"] as const) {
      const runner = replay();
      await runner.run("target", {
        callIndex: 0,
        callHash: "hash-0",
        callPath: "1:1",
        callInputsHash: "inputs-0",
        runId: "isolation-run",
        cwd: EXECUTION_CWD,
      });
      const observation = runner.observeAgentEnd({
        callIndex: 0,
        scope: "isolation-run",
        result: { live: true },
        usage: usage(3),
        ...(evidence === "verified" ? { modelResolved: "candidate/concrete" } : {}),
        ...(evidence === "fallback" ? { modelFallbacks: ["candidate/model"] } : {}),
      });
      assert.equal(observation.target, true);
      if (observation.target) {
        assert.equal(observation.outcome, evidence === "fallback" ? "diverged" : "settled");
      }
      const report = runner.finalize({ scriptCompleted: true });
      if (evidence === "fallback") {
        assert.equal(report.divergence?.kind, "candidate-fallback");
      } else {
        assert.equal(report.calls[0].candidateEvidence, evidence);
        assert.deepEqual(report.unverifiedTargets, evidence === "unverified" ? [0] : []);
      }
    }
  });

  it("latches foreign scopes, prevents post-divergence spend, and treats post-finalize use as misuse", async () => {
    let innerCalls = 0;
    const runner = replay(recording(), { inner: { async run() { innerCalls++; return "live"; } } });
    const foreign = {
      callIndex: 0,
      callHash: "hash-0",
      callPath: "1:1",
      callInputsHash: "inputs-0",
      runId: "isolation-run-nested1",
      cwd: EXECUTION_CWD,
    };
    await assert.rejects(runner.run("nested", foreign), { code: WorkflowErrorCode.REPLAY_DIVERGENCE });
    await assert.rejects(
      runner.run("caught-then-continued", { ...foreign, runId: "isolation-run", callIndex: 1 }),
      { code: WorkflowErrorCode.REPLAY_DIVERGENCE },
    );
    assert.equal(innerCalls, 0);
    assert.equal(runner.report().divergence?.kind, "nested-workflow-call");
    assert.deepEqual(runner.report().calls, []);
    runner.finalize();
    await assert.rejects(runner.run("late"), /after finalize/);
  });

  it("serves checkpoints and reconstructs strict-JSON recorded throws across realms", async () => {
    const realmError = vm.runInNewContext(`({ form: "error", name: "RealmFailure", message: "boom", props: { code: 7 } })`);
    const row = resultRow({
      kind: "checkpoint",
      origin: "confirm",
      outcome: "error",
      attempts: undefined,
      inputsHash: undefined,
      label: undefined,
      usage: undefined,
      modelRequested: undefined,
      modelResolved: undefined,
      resolvedCwd: undefined,
      error: realmError,
    });
    const targetRow = resultRow({
      index: 1,
      hash: "target-hash",
      path: "2:1",
      settlementOrdinal: 2,
    });
    const source = recording({
      calls: [row, targetRow],
      callsAllocated: 2,
      agents: [
        { id: 1, label: "target", prompt: "target", status: "done", callIndex: 1, scope: "baseline-run" },
      ],
      journal: [
        { index: 1, hash: targetRow.hash, result: "baseline", kind: "agent", scope: "baseline-run" },
      ],
    });
    const runner = replay(source, { live: [{ callIndex: 1, model: "candidate" }] });
    await assert.rejects(
      runner.confirm("question", {}, { callIndex: 0, hash: row.hash, path: row.path, scope: "isolation-run" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "RealmFailure");
        assert.equal((error as Error & { code: number }).code, 7);
        return true;
      },
    );
    const missingContext = replay(recording(), { live: [{ callIndex: 0, model: "candidate" }] });
    await assert.rejects(missingContext.confirm("question", {}), { code: WorkflowErrorCode.REPLAY_DIVERGENCE });
    assert.equal(missingContext.report().divergence?.kind, "checkpoint-context-unavailable");
  });

  it("reports unvisited, unreached, and bound-but-unsettled targets", async () => {
    const runner = replay();
    await runner.run("target", {
      callIndex: 0,
      callHash: "hash-0",
      callPath: "1:1",
      callInputsHash: "inputs-0",
      runId: "isolation-run",
      cwd: EXECUTION_CWD,
    });
    const report = runner.finalize({ scriptCompleted: true });
    assert.deepEqual(report.targetUnsettled, [0]);
    assert.equal(report.divergence?.kind, "target-unsettled");
    assert.throws(() => (report.notes as string[]).push("mutation"));

    const unreached = replay();
    const unreachedReport = unreached.finalize({ scriptCompleted: true });
    assert.deepEqual(unreachedReport.unvisitedRecordedIndexes, [0]);
    assert.deepEqual(unreachedReport.unreachedTargets, [0]);
  });
});

describe("runIsolation harness", () => {
  it("records, isolates, and persists quarantine, provenance, reports, and usage telemetry", async () => {
    const root = mkdtempSync(join(tmpdir(), "isolation-harness-"));
    const cwd = mkdtempSync(join(tmpdir(), "isolation-cwd-"));
    const script = `export const meta = { name: 'harness', description: 'integration' }
const first = await agent('first', { label: 'first', model: 'baseline/model' })
const target = await agent('target:' + first, { label: 'target', model: 'baseline/model' })
return { first, target }`;
    const baselineRunner: AgentRunner = {
      async run(prompt, options) {
        options?.onModelResolved?.("baseline/concrete");
        options?.onUsage?.(usage(prompt === "first" ? 5 : 7));
        return prompt === "first" ? "held" : "baseline-target";
      },
    };
    try {
      const manager = new WorkflowManager({
        cwd,
        persistenceRoot: root,
        agent: baselineRunner,
        environmentKey: ENVIRONMENT_KEY,
      });
      const baseline = await manager.runSync(script, undefined, {
        runId: "baseline-harness",
        maxAgents: 10,
        concurrency: 1,
        agentRetries: 0,
        environmentKey: ENVIRONMENT_KEY,
      });
      assert.equal(baseline.status, "completed");
      const target = baseline.calls?.find((row) => row.label === "target");
      assert.ok(target);
      let liveCalls = 0;
      const isolated = await runIsolation<{ first: unknown; target: unknown }>({
        baselineRunId: "baseline-harness",
        cwd,
        persistenceRoot: root,
        environmentKey: ENVIRONMENT_KEY,
        live: [{ callIndex: target.index, model: "candidate/model" }],
        runner: {
          async run(_prompt, options) {
            liveCalls++;
            options?.onModelResolved?.("candidate/concrete");
            options?.onUsage?.(usage(99));
            return "candidate-target";
          },
        },
      });
      assert.equal(isolated.status, "completed");
      assert.equal(liveCalls, 1);
      assert.equal(isolated.run?.result.first, "held");
      assert.equal(isolated.run?.result.target, "candidate-target");
      assert.equal(isolated.report.calls.find((row) => row.mode === "live-target")?.liveUsage?.total, 99);
      const artifact = createRunPersistence(cwd, undefined, { persistenceRoot: root }).load(
        isolated.report.isolationRunId,
      );
      assert.equal(artifact?.executionMode?.kind, "isolation");
      assert.deepEqual(artifact?.replayReport, isolated.report);
      assert.equal(artifact?.calls?.[0].provenance?.source, "replay");
      assert.equal(artifact?.calls?.[1].provenance?.source, "live");
      const resume = await new WorkflowManager({ cwd, persistenceRoot: root, agent: baselineRunner }).resumeInBackground(
        isolated.report.isolationRunId,
      );
      assert.equal(resume.accepted, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("classifies candidate fallback, target failure, and zero-call nested workflow", async () => {
    const scenarios = ["fallback", "failure", "nested"] as const;
    for (const scenario of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `isolation-${scenario}-`));
      const cwd = mkdtempSync(join(tmpdir(), `isolation-${scenario}-cwd-`));
      const body =
        scenario === "nested"
          ? `const value = await agent('target', { label: 'target', model: 'baseline/model' })
if (value === 'candidate') await workflow("export const meta = { name: 'child', description: 'zero call' }\\nreturn 'child'")
return value`
          : `return await agent('target', { label: 'target', model: 'baseline/model' })`;
      const script = `export const meta = { name: '${scenario}', description: 'scenario' }\n${body}`;
      try {
        const manager = new WorkflowManager({ cwd, persistenceRoot: root, environmentKey: ENVIRONMENT_KEY });
        await manager.runSync(script, undefined, {
          runId: `baseline-${scenario}`,
          agent: {
            async run(_prompt, options) {
              options?.onModelResolved?.("baseline/concrete");
              return "baseline";
            },
          },
          maxAgents: 10,
          concurrency: 1,
          agentRetries: 0,
          environmentKey: ENVIRONMENT_KEY,
        });
        const result = await runIsolation({
          baselineRunId: `baseline-${scenario}`,
          cwd,
          persistenceRoot: root,
          environmentKey: ENVIRONMENT_KEY,
          live: [{ callIndex: 0, model: "candidate/model" }],
          runner: {
            async run(_prompt, options) {
              if (scenario === "fallback") {
                options?.onModelFallback?.("candidate/model");
                return "candidate";
              }
              if (scenario === "failure") {
                throw new WorkflowError("candidate failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
                  recoverable: false,
                  agentLabel: "target",
                  details: { exact: true },
                });
              }
              options?.onModelResolved?.("candidate/concrete");
              return "candidate";
            },
          },
        });
        assert.equal(
          result.status,
          scenario === "failure" ? "target-failed" : "diverged",
          scenario,
        );
        if (scenario === "fallback") assert.equal(result.report.divergence?.kind, "candidate-fallback");
        if (scenario === "nested") assert.equal(result.report.divergence?.kind, "nested-workflow-call");
        if (scenario === "failure") {
          assert.equal(result.error?.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
          assert.deepEqual(result.error?.details, { exact: true });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it("returns failed for a caller abort caught by the script", async () => {
    const root = mkdtempSync(join(tmpdir(), "isolation-caller-abort-"));
    const cwd = mkdtempSync(join(tmpdir(), "isolation-caller-abort-cwd-"));
    const script = `export const meta = { name: 'caller-abort', description: 'caught' }
try { await agent('target', { label: 'target', model: 'baseline/model' }) } catch {}
return 'caught'`;
    try {
      const baselineManager = new WorkflowManager({ cwd, persistenceRoot: root, environmentKey: ENVIRONMENT_KEY });
      await baselineManager.runSync(script, undefined, {
        runId: "baseline-caller-abort",
        agent: {
          async run(_prompt, options) {
            options?.onModelResolved?.("baseline/concrete");
            return "baseline";
          },
        },
        maxAgents: 10,
        concurrency: 1,
        agentRetries: 0,
        environmentKey: ENVIRONMENT_KEY,
      });
      const controller = new AbortController();
      controller.abort();
      const result = await runIsolation({
        baselineRunId: "baseline-caller-abort",
        cwd,
        persistenceRoot: root,
        environmentKey: ENVIRONMENT_KEY,
        live: [{ callIndex: 0, model: "candidate" }],
        signal: controller.signal,
        runner: {
          async run() {
            throw new Error("runner must not be reached after a pre-call caller abort");
          },
        },
      });
      assert.equal(result.status, "failed");
      assert.equal(result.error?.code, WorkflowErrorCode.WORKFLOW_ABORTED);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
