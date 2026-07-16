import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentResultProvenance,
  AgentSessionRef,
  ContinuationAttempt,
  ContinuationSkipReason,
  JournalCallMetadata,
  RunOptions,
  WorkflowRunFallback,
} from "../src/index.js";

const SKIP_REASONS = [
  "hash-mismatch",
  "inputs-mismatch",
  "worktree-isolated",
  "cwd-mismatch",
  "cwd-missing",
  "backend-mismatch",
  "capability-missing",
  "reattach-failed",
  "runner-declined",
] as const satisfies readonly ContinuationSkipReason[];

type AssertNever<T extends never> = T;
type _SkipReasonsComplete = AssertNever<Exclude<ContinuationSkipReason, (typeof SKIP_REASONS)[number]>>;

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const sessionRef: AgentSessionRef = {
  sessionId: "session-183",
  backendId: "custom",
  poolKey: "custom#spawn-config-hash",
  cwd: "/workspace/project",
  reopen: { load: true, resume: true, list: false, fork: false },
};

test("continuation shared types JSON-round-trip every additive branch", () => {
  const options: RunOptions = { continueFromSession: sessionRef };
  const attempts: ContinuationAttempt[] = [
    { reattached: true, method: "resume" },
    { reattached: true, method: "load" },
    ...SKIP_REASONS.map((reason): ContinuationAttempt => ({ reattached: false, reason })),
  ];
  const provenances: AgentResultProvenance[] = attempts.map((continuation) => ({
    source: "live",
    continuation,
  }));
  const journalCalls: JournalCallMetadata[] = [
    { kind: "agent", label: "resume", continuation: { method: "resume" } },
    { kind: "agent", label: "load", continuation: { method: "load" } },
  ];

  assert.deepEqual(jsonRoundTrip(options.continueFromSession), sessionRef);
  assert.deepEqual(jsonRoundTrip(sessionRef), sessionRef);
  assert.deepEqual(jsonRoundTrip(attempts), attempts);
  assert.deepEqual(jsonRoundTrip(provenances), provenances);
  assert.deepEqual(jsonRoundTrip(journalCalls), journalCalls);
  assert.deepEqual(SKIP_REASONS, [
    "hash-mismatch",
    "inputs-mismatch",
    "worktree-isolated",
    "cwd-mismatch",
    "cwd-missing",
    "backend-mismatch",
    "capability-missing",
    "reattach-failed",
    "runner-declined",
  ]);
});

test("WorkflowRunFallback stays flat and permissive while producer fixtures obey the emission invariant", () => {
  const legacyModel: WorkflowRunFallback = {
    callIndex: 0,
    label: "legacy",
    requestedSpec: "codex/default",
    kind: "model",
    message: "using the session default",
  };
  const emittedContinuation: WorkflowRunFallback = {
    callIndex: 1,
    label: "continued",
    requestedSpec: "codex/gpt",
    backendId: "codex",
    kind: "continuation",
    continuation: { outcome: "reattached", method: "resume" },
    message: "continuation: reattached via session/resume",
  };
  const permissiveNoDetail: WorkflowRunFallback = {
    callIndex: 2,
    label: "future-producer",
    requestedSpec: "codex/gpt",
    kind: "continuation",
    message: "accepted without detail",
  };
  const permissiveWrongKind: WorkflowRunFallback = {
    callIndex: 3,
    label: "future-detail",
    requestedSpec: "codex/gpt",
    kind: "model",
    continuation: { outcome: "skipped", reason: "runner-declined" },
    message: "accepted on a non-continuation kind",
  };
  const values = [legacyModel, emittedContinuation, permissiveNoDetail, permissiveWrongKind];

  assert.deepEqual(jsonRoundTrip(values), values);
  assert.equal(Object.hasOwn(legacyModel, "continuation"), false);
  assert.equal(emittedContinuation.kind, "continuation");
  assert.ok(emittedContinuation.continuation, "a producer-emitted continuation notice carries detail");
  assert.equal(permissiveNoDetail.continuation, undefined);
  assert.equal(permissiveWrongKind.continuation?.outcome, "skipped");
});
