import assert from "node:assert/strict";
import test from "node:test";

import type {
  HarnessConfigReport,
  PersistedRunState,
  ValidateWorkflowReport,
} from "@automatalabs/workflows";

import {
  NoAutoDefaultBackendError,
  classifyAutoDefaultCandidates,
  recordedDefaultModel,
  selectAutoDefaultBackend,
  workflowNeedsPinnedDefault,
} from "../src/default-backend.js";

function harness(
  backendId: string,
  options: {
    probed?: boolean;
    error?: string;
    models?: { current?: string; choices?: string[] };
  } = {},
): HarnessConfigReport["harnessOptions"][number] {
  const probed = options.probed ?? true;
  return {
    backendId,
    probed,
    ...(options.error ? { error: options.error } : {}),
    ...(options.models
      ? {
          options: [{
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue: options.models.current ?? "",
            options: (options.models.choices ?? []).map((value) => ({ value, name: value })),
          }],
        }
      : { options: [] }),
  };
}

function report(...harnessOptions: HarnessConfigReport["harnessOptions"]): HarnessConfigReport {
  return {
    ok: harnessOptions.every((entry) => entry.probed),
    exitCode: harnessOptions.every((entry) => entry.probed) ? 0 : 1,
    harnessOptions,
  };
}

test("automatic default classification distinguishes definite failure, ready evidence, and unknown readiness", () => {
  const candidates = classifyAutoDefaultCandidates(report(
    harness("claude", { models: { current: "opus" } }),
    harness("codex", { models: { current: "gpt" } }),
    harness("opencode", { probed: false, error: "not installed" }),
    harness("pi", { models: {} }),
  ));

  assert.deepEqual(candidates.map(({ backendId, status }) => ({ backendId, status })), [
    { backendId: "claude", status: "unknown" },
    { backendId: "codex", status: "ready" },
    { backendId: "opencode", status: "unavailable" },
    { backendId: "pi", status: "unavailable" },
  ]);
  assert.match(candidates[2]!.reason, /not installed/);
  assert.match(candidates[3]!.reason, /no usable default or selectable model/);
});

test("selection prefers positive readiness evidence, then the first session-ready unknown", () => {
  const withCodex = selectAutoDefaultBackend(report(
    harness("claude", { models: { current: "opus" } }),
    harness("codex", { models: { current: "gpt" } }),
  ));
  assert.equal(withCodex.backendId, "codex");
  assert.equal(withCodex.readiness, "ready");

  const unknownOnly = selectAutoDefaultBackend(report(
    harness("claude", { models: { current: "opus" } }),
    harness("team"),
  ));
  assert.equal(unknownOnly.backendId, "claude");
  assert.equal(unknownOnly.readiness, "unknown");
});

test("Pi's credential-filtered usable catalog is ready while custom shadows stay unknown", () => {
  const pi = selectAutoDefaultBackend(report(
    harness("pi", { models: { choices: ["openai/gpt"] } }),
  ));
  assert.equal(pi.readiness, "ready");

  const shadow = selectAutoDefaultBackend(
    report(harness("codex", { models: { current: "custom-model" } })),
    ["codex"],
  );
  assert.equal(shadow.readiness, "unknown");
});

test("selection fails clearly when every backend is definitely unavailable", () => {
  assert.throws(
    () => selectAutoDefaultBackend(report(
      harness("claude", { probed: false, error: "login required" }),
      harness("pi", { models: {} }),
    )),
    (error: unknown) => {
      assert.ok(error instanceof NoAutoDefaultBackendError);
      assert.match(error.message, /claude: probe failed — login required/);
      assert.match(error.message, /pi: session opened but/);
      assert.match(error.message, /AGENTPRISM_DEFAULT_BACKEND/);
      return true;
    },
  );
});

test("resume default recovery prefers the persisted pin and migrates one legacy model-less backend", () => {
  assert.equal(recordedDefaultModel({ defaultModel: "codex" } as PersistedRunState), "codex");
  assert.equal(recordedDefaultModel({
    calls: [
      { index: 0, kind: "agent", hash: "a", outcome: "result", origin: "runner", backendId: "pi" },
      { index: 1, kind: "agent", hash: "b", outcome: "result", origin: "runner", backendId: "pi" },
      { index: 2, kind: "agent", hash: "c", outcome: "result", origin: "runner", modelRequested: "codex", backendId: "codex" },
    ],
  } as PersistedRunState), "pi");
  assert.equal(recordedDefaultModel({
    calls: [
      { index: 0, kind: "agent", hash: "a", outcome: "result", origin: "runner", backendId: "pi" },
      { index: 1, kind: "agent", hash: "b", outcome: "result", origin: "runner", backendId: "claude" },
    ],
  } as PersistedRunState), undefined);
});

test("routing discovery requests a default only for calls with neither resolved model nor tier", () => {
  const base = {
    parse: { ok: true },
    ok: true,
    exitCode: 0,
    warnings: [],
  } as ValidateWorkflowReport;
  assert.equal(workflowNeedsPinnedDefault({
    ...base,
    dryRun: {
      ok: true,
      status: "completed",
      timedOut: false,
      agentCalls: [{ label: "a", backend: "claude", schema: false }],
      checkpoints: [],
      phasesVisited: [],
      logs: [],
      durationMs: 0,
    },
  }), true);
  assert.equal(workflowNeedsPinnedDefault({
    ...base,
    dryRun: {
      ok: true,
      status: "completed",
      timedOut: false,
      agentCalls: [
        { label: "a", model: "codex", backend: "codex", schema: false },
        { label: "b", tier: "small", backend: "claude", schema: false },
      ],
      checkpoints: [],
      phasesVisited: [],
      logs: [],
      durationMs: 0,
    },
  }), false);
});
