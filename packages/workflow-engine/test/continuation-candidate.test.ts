import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSessionRecord, WorkflowCallRecord } from "@automatalabs/shared-types";
import { WorkflowErrorCode } from "../src/errors.js";
import type { PreparedContinuation } from "../src/resume.js";
import type { PersistedAgentState, PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const runId = "paused-source";

function session(index = 0): AgentSessionRecord {
  return {
    sessionId: `session-${index}`,
    backendId: "test-backend",
    poolKey: "test-backend",
    cwd: "/workspace",
    reopen: { load: true, resume: true, list: true },
    callIndex: index,
    label: `agent-${index}`,
    keptOpen: true,
  };
}

function agent(index = 0): PersistedAgentState {
  return {
    id: index,
    label: `agent-${index}`,
    prompt: "task",
    status: "error",
    errorCode: WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    session: session(index),
    callIndex: index,
    scope: runId,
  };
}

function call(index = 0): WorkflowCallRecord {
  return {
    index,
    kind: "agent",
    hash: `hash-${index}`,
    inputsHash: `inputs-${index}`,
    outcome: "error",
    origin: "runner",
    error: {
      form: "workflow-error",
      message: "pause",
      code: WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    },
    attempts: 1,
    label: `agent-${index}`,
    backendId: "test-backend",
    resolvedCwd: "/workspace",
    budgetDebit: 0,
    settlementOrdinal: index + 1,
    scope: runId,
  };
}

function state(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId,
    workflowName: "candidate",
    script: "return null",
    status: "paused",
    pauseReason: "usage_limit",
    phases: [],
    agents: [agent()],
    logs: [],
    calls: [call()],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function build(persisted: PersistedRunState): PreparedContinuation | undefined {
  const prototype = WorkflowManager.prototype as unknown as {
    buildPreparedContinuation(value: PersistedRunState): PreparedContinuation | undefined;
  };
  return prototype.buildPreparedContinuation.call({}, persisted);
}

function candidate(persisted: PersistedRunState, index = 0) {
  return build(persisted)?.candidatesByIndex.get(index);
}

describe("PreparedContinuation snapshot projection", () => {
  it("requires a pause-class source, an error outcome, an authoritative pause-class agent error, and reopen support", () => {
    assert.ok(candidate(state()));
    assert.ok(candidate(state({ pauseReason: "auth_required", agents: [{
      ...agent(),
      errorCode: WorkflowErrorCode.AUTH_REQUIRED,
    }] })));

    for (const pauseReason of ["checkpoint_required", undefined]) {
      assert.equal(build(state({ pauseReason })), undefined);
    }
    for (const status of ["completed", "failed", "aborted"] as const) {
      assert.equal(build(state({ status })), undefined);
    }
    for (const outcome of ["result", "null"] as const) {
      assert.equal(candidate(state({ calls: [{ ...call(), outcome } as WorkflowCallRecord] })), undefined);
    }
    assert.equal(candidate(state({ agents: [{
      ...agent(),
      errorCode: WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    }] })), undefined);
    assert.equal(candidate(state({ agents: [{
      ...agent(),
      session: { ...session(), reopen: { load: false, resume: false, list: true } },
    }] })), undefined);

    const disagreeingCall = {
      ...call(),
      error: { ...call().error, code: WorkflowErrorCode.AGENT_EXECUTION_ERROR },
    } as WorkflowCallRecord;
    assert.ok(candidate(state({ calls: [disagreeingCall] })), "agent-row errorCode admits the candidate");
    assert.equal(candidate(state({
      agents: [{ ...agent(), errorCode: WorkflowErrorCode.AGENT_EXECUTION_ERROR }],
      calls: [{
        ...call(),
        error: { ...call().error, code: WorkflowErrorCode.PROVIDER_USAGE_LIMIT },
      } as WorkflowCallRecord],
    })), undefined, "call-record error code cannot override the agent row");
  });

  it("is a total fail-to-fresh projection for malformed persistence while retaining well-formed siblings", () => {
    const malformed: Array<PersistedRunState> = [
      state({ agents: undefined as unknown as PersistedAgentState[] }),
      state({ calls: undefined }),
      state({ agents: {} as unknown as PersistedAgentState[] }),
      state({ calls: {} as unknown as WorkflowCallRecord[] }),
      state({ agents: [{ ...agent(), callIndex: 1 }] }),
      state({ agents: [{ ...agent(), callIndex: -1 }] }),
      state({ agents: [{ ...agent(), callIndex: 0.5 }] }),
      state({ agents: [{ ...agent(), session: null as unknown as AgentSessionRecord }] }),
      state({ calls: [{ ...call(), index: -1 }] }),
      state({ calls: [{ ...call(), index: 0.5 }] }),
    ];
    for (const persisted of malformed) {
      assert.doesNotThrow(() => build(persisted));
      assert.equal(build(persisted), undefined);
    }

    const goodAgent = agent(1);
    const goodCall = call(1);
    const mixed = state({
      agents: [{ ...agent(), callIndex: 9 }, goodAgent],
      calls: [call(), goodCall],
    });
    assert.deepEqual([...build(mixed)!.candidatesByIndex.keys()], [1]);
  });

  it("enforces row status and record/session backend and cwd coherence, tolerating a missing cwd side", () => {
    assert.equal(candidate(state({ agents: [{ ...agent(), status: "done" }] })), undefined);
    assert.equal(candidate(state({ calls: [{ ...call(), backendId: "other" }] })), undefined);
    assert.equal(candidate(state({ calls: [{ ...call(), resolvedCwd: "/different" }] })), undefined);

    const noRecordCwd = call();
    delete noRecordCwd.resolvedCwd;
    assert.equal(candidate(state({ calls: [noRecordCwd] }))?.recordedCwd, "/workspace");

    const noSessionCwd = session() as AgentSessionRecord & { cwd?: string };
    delete noSessionCwd.cwd;
    assert.equal(candidate(state({ agents: [{ ...agent(), session: noSessionCwd }] }))?.recordedCwd, "/workspace");
  });

  it("joins only coherent root rows, uses later root rows, and never reads the journal or nested event-derived rows", () => {
    const nested = {
      ...agent(),
      scope: "nested-run",
      session: { ...session(), sessionId: "nested-session" },
    };
    const root = {
      ...agent(),
      session: { ...session(), sessionId: "root-session" },
    };
    assert.equal(candidate(state({ agents: [nested, root] }))?.sessionRef.sessionId, "root-session");
    assert.equal(candidate(state({ agents: [root, nested] }))?.sessionRef.sessionId, "root-session");
    assert.equal(candidate(state({ agents: [nested] })), undefined);

    const earlier = { ...root, session: { ...session(), sessionId: "earlier" } };
    const later = { ...root, session: { ...session(), sessionId: "later" } };
    assert.equal(candidate(state({ agents: [earlier, later] }))?.sessionRef.sessionId, "later");

    assert.ok(candidate(state({ journal: [] })), "the interrupted call needs no journal row");
    assert.equal(candidate(state({
      agents: [],
      journal: [{
        index: 0,
        hash: "hash-0",
        result: "event-derived",
        session: session(),
      }],
    })), undefined, "journal/event state never supplies the session join");
  });

  it("keeps duplicate hashes as distinct index-keyed candidates", () => {
    const firstCall = call(0);
    const secondCall = { ...call(1), hash: firstCall.hash };
    const projected = build(state({
      agents: [agent(0), agent(1)],
      calls: [firstCall, secondCall],
    }));
    assert.deepEqual([...projected!.candidatesByIndex.keys()], [0, 1]);
    assert.equal(projected!.candidatesByIndex.get(0)?.callIndex, 0);
    assert.equal(projected!.candidatesByIndex.get(1)?.callIndex, 1);
  });
});
