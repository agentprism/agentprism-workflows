import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthErrorContext } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

// PR4 (§2.12/§2.13): the engine generalizes the PROVIDER_USAGE_LIMIT pause branch so an
// AUTH_REQUIRED fault CHECKPOINTS the run as paused (reason "auth_required") carrying the
// structured, non-secret authContext — never the intent's secret payload. These tests drive the
// engine seam with stub runners; the acp-agents halves (real pool, real -32000) live in
// packages/acp-agents/test (§4.6.2).

const ONE_AGENT = `export const meta = { name: 'auth_pause_demo', description: 'auth pause demo' }
const a = await agent('first', { label: 'first' })
return { a }`;

const AUTH_CONTEXT: AuthErrorContext = {
  backendId: "claude",
  methods: [
    { id: "gateway", type: "agent", name: "Gateway" },
    { id: "claude-login", type: "terminal", name: "Terminal Login" },
  ],
};

/** An in-memory RunPersistence with capture hooks — no fs, deterministic, shareable across
 *  "cold" managers so a fresh manager re-loads a paused run exactly as a new process would. */
function memoryPersistence(): {
  persistence: RunPersistence;
  saves: PersistedRunState[];
  acquired: string[];
  released: string[];
  seed: (state: PersistedRunState) => void;
} {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const clone = (state: PersistedRunState): PersistedRunState => structuredClone(state);
  return {
    saves,
    acquired,
    released,
    seed(state) {
      states.set(state.runId, clone(state));
    },
    persistence: {
      save(state) {
        const copy = clone(state);
        saves.push(copy);
        states.set(state.runId, copy);
      },
      load(runId) {
        const state = states.get(runId);
        return state ? clone(state) : null;
      },
      list() {
        return [...states.values()].map(clone);
      },
      delete(runId) {
        return states.delete(runId);
      },
      acquireRunLease(runId) {
        acquired.push(runId);
        return { runId, token: `${runId}-lease` };
      },
      releaseRunLease(lease) {
        released.push(lease.runId);
      },
      getRunsDir() {
        return "/memory/runs";
      },
    },
  };
}

/** A runner stub that fails EVERY agent() call with AUTH_REQUIRED carrying the given authContext.
 *  A secret may be attached to the error's `details` — the closest analog to the intent's secret
 *  payload — so we can prove the engine persists ONLY the non-secret authContext, never `details`.
 *  (Upstream PR1 guarantees the MESSAGE itself is secret-free; the engine passes it through.) */
function authRequiredAgent(opts: { authContext: AuthErrorContext; secret?: string } = { authContext: AUTH_CONTEXT }) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    runner: {
      async run() {
        calls++;
        throw new WorkflowError("Authentication required for claude", WorkflowErrorCode.AUTH_REQUIRED, {
          recoverable: false,
          authContext: opts.authContext,
          details: opts.secret ? { apiKey: opts.secret } : undefined,
        });
      },
    },
  };
}

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-auth-pause-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

test(
  "executeRun pause branch fires for AUTH_REQUIRED → status paused, not failed (§2.12)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const agent = authRequiredAgent();
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    const result = await manager.runSync(ONE_AGENT);

    assert.equal(result.status, "paused", "AUTH_REQUIRED checkpoints the run as paused");
    assert.equal(result.reason, "auth_required", "composeResult reports reason 'auth_required'");
    assert.equal(result.resetHint, undefined, "resetHint stays usage-limit-only");
    assert.deepEqual(result.authContext, AUTH_CONTEXT, "the structured non-secret authContext rides the result");
  }),
);

test(
  "'paused' event carries reason 'auth_required' + non-secret authContext, resetHint undefined (§2.12)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const agent = authRequiredAgent();
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    let paused:
      | { runId: string; reason?: string; error?: WorkflowError; resetHint?: unknown; authContext?: AuthErrorContext }
      | undefined;
    manager.on("paused", (ev: typeof paused) => {
      paused = ev;
    });

    const result = await manager.runSync(ONE_AGENT);

    assert.ok(paused, "the paused event fired");
    assert.equal(paused?.runId, result.runId);
    assert.equal(paused?.reason, "auth_required");
    assert.equal(paused?.resetHint, undefined, "resetHint is undefined for an auth pause");
    assert.equal(paused?.error?.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.deepEqual(paused?.authContext, AUTH_CONTEXT);
  }),
);

test(
  "persistRun writes pauseReason 'auth_required' + non-secret authContext, and NEVER the secret payload (§2.12/§2.14)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const secret = "sk-SECRET-abc123";
    const agent = authRequiredAgent({ authContext: AUTH_CONTEXT, secret });
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    const result = await manager.runSync(ONE_AGENT);
    const persisted = store.persistence.load(result.runId);

    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.pauseReason, "auth_required", "pauseReason switches on the paused error code");
    assert.equal(persisted?.resetHint, undefined, "resetHint stays usage-limit-only");
    assert.deepEqual(persisted?.authContext, AUTH_CONTEXT, "the non-secret authContext is persisted");

    // The engine persists the non-secret authContext ONLY — never the error's secret `details`.
    const serialized = JSON.stringify(store.saves);
    assert.ok(!serialized.includes(secret), "the error's secret details never reach ANY persisted run state");
    assert.equal(
      // authContext carries exactly backendId + method ids/types/names — no secret-shaped keys.
      Object.keys(persisted?.authContext ?? {}).sort().join(","),
      "backendId,methods",
    );
  }),
);

test(
  "usage-limit pause is UNCHANGED by the generalization — reason 'usage_limit' + resetHint, no authContext (regression)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const manager = new WorkflowManager({
      cwd,
      persistence: store.persistence,
      agent: {
        async run() {
          throw new WorkflowError("Codex usage limit reached. Resets in ~3h.", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets in ~3h",
          });
        },
      },
    });

    let paused: { reason?: string; resetHint?: unknown; authContext?: unknown } | undefined;
    manager.on("paused", (ev: typeof paused) => {
      paused = ev;
    });

    const result = await manager.runSync(ONE_AGENT);
    const persisted = store.persistence.load(result.runId);

    assert.equal(result.status, "paused");
    assert.equal(result.reason, "usage_limit");
    assert.equal(result.resetHint, "Resets in ~3h");
    assert.equal(result.authContext, undefined, "a usage-limit pause carries no authContext");
    assert.equal(paused?.reason, "usage_limit");
    assert.equal(paused?.resetHint, "Resets in ~3h");
    assert.equal(paused?.authContext, undefined);
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.equal(persisted?.authContext, undefined);
  }),
);

// ─── Cold-resume re-arm (§2.13) — the engine consults the DUCK-TYPED runner.auth.canResume ───

/** Seed a paused "auth_required" run directly, as a fresh (cold) process would re-load it. */
function seedAuthPausedRun(store: ReturnType<typeof memoryPersistence>, runId: string): void {
  const now = new Date().toISOString();
  store.seed({
    runId,
    workflowName: "auth_pause_demo",
    script: ONE_AGENT,
    status: "paused",
    pauseReason: "auth_required",
    authContext: AUTH_CONTEXT,
    phases: [],
    agents: [],
    logs: [],
    journal: [],
    startedAt: now,
    updatedAt: now,
  });
}

/** A runner whose auth controller answers canResume deterministically, and whose run() succeeds —
 *  so "resume proceeds" is observable as the run driving to completion. */
function resumableAgent(canResume: boolean) {
  let runCalls = 0;
  const canResumeCalls: string[] = [];
  return {
    get runCalls() {
      return runCalls;
    },
    canResumeCalls,
    runner: {
      auth: {
        canResume(backendId: string): boolean {
          canResumeCalls.push(backendId);
          return canResume;
        },
      },
      async run(prompt: string) {
        runCalls++;
        return `ok:${prompt}`;
      },
    },
  };
}

test(
  "cold resume of a disk-backed auth pause PROCEEDS — canResume(true) → run re-executes to completion (§2.13)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const runId = "cold-disk-backed";
    seedAuthPausedRun(store, runId);
    const agent = resumableAgent(true);
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    let resumedEvent = false;
    manager.on("resumed", () => {
      resumedEvent = true;
    });

    const ok = await manager.resume(runId);
    assert.equal(ok, true, "resume was accepted");
    assert.deepEqual(agent.canResumeCalls, ["claude"], "the runner's auth.canResume was consulted with backendId");
    assert.equal(resumedEvent, true, "a proceeding resume emits 'resumed'");

    const deadline = Date.now() + 5_000;
    while (manager.getRun(runId)?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(manager.getRun(runId)?.status, "completed", "the disk-backed run resumed and completed");
    assert.ok(agent.runCalls >= 1, "the agent re-executed live (resume proceeded, did not re-pause)");
  }),
);

test(
  "cold resume of an in-process auth pause RE-PAUSES — canResume(false) → re-supply message, agent never runs (§2.13)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const runId = "cold-in-process";
    seedAuthPausedRun(store, runId);
    const agent = resumableAgent(false);
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    let resumedEvent = false;
    manager.on("resumed", () => {
      resumedEvent = true;
    });
    let paused: { reason?: string; error?: WorkflowError; authContext?: AuthErrorContext } | undefined;
    manager.on("paused", (ev: typeof paused) => {
      paused = ev;
    });

    const ok = await manager.resume(runId);
    assert.equal(ok, true, "resume handled the run (by re-pausing)");
    assert.deepEqual(agent.canResumeCalls, ["claude"], "the runner's auth.canResume was consulted");
    assert.equal(resumedEvent, false, "a re-paused resume does NOT emit 'resumed'");
    assert.equal(agent.runCalls, 0, "the agent is NEVER re-executed when the intent was lost to the cold process");

    assert.ok(paused, "re-pause emitted the paused event");
    assert.equal(paused?.reason, "auth_required");
    assert.equal(paused?.error?.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.match(paused?.error?.message ?? "", /re-supply credentials for claude via runner auth before resuming/);
    assert.deepEqual(paused?.authContext, AUTH_CONTEXT, "the non-secret authContext rides the re-pause");
    // The lease taken for the resume attempt is released again.
    assert.deepEqual(store.released, [runId], "the resume lease is released on re-pause");
  }),
);

test(
  "cold resume with a runner that has NO auth controller RE-PAUSES (default-off host cannot confirm resumability) (§2.13)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const runId = "cold-no-controller";
    seedAuthPausedRun(store, runId);
    let runCalls = 0;
    const manager = new WorkflowManager({
      cwd,
      persistence: store.persistence,
      // A plain AgentRunner — no `auth` controller (the DEFAULT-OFF surface).
      agent: {
        async run(prompt: string) {
          runCalls++;
          return `ok:${prompt}`;
        },
      },
    });

    let paused: { reason?: string; error?: WorkflowError } | undefined;
    manager.on("paused", (ev: typeof paused) => {
      paused = ev;
    });

    const ok = await manager.resume(runId);
    assert.equal(ok, true);
    assert.equal(runCalls, 0, "no auth controller ⇒ cannot confirm resumability ⇒ never re-executes");
    assert.equal(paused?.reason, "auth_required");
    assert.match(paused?.error?.message ?? "", /re-supply credentials for claude via runner auth before resuming/);
  }),
);

test(
  "a usage-limit cold resume is NOT gated by the auth re-arm — proceeds without consulting canResume (§2.13)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const runId = "cold-usage-limit";
    const now = new Date().toISOString();
    store.seed({
      runId,
      workflowName: "auth_pause_demo",
      script: ONE_AGENT,
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "Resets in ~3h",
      phases: [],
      agents: [],
      logs: [],
      journal: [],
      startedAt: now,
      updatedAt: now,
    });
    // canResume(false) would re-pause IF the auth branch were wrongly applied to a usage-limit run.
    const agent = resumableAgent(false);
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    const ok = await manager.resume(runId);
    assert.equal(ok, true);
    assert.deepEqual(agent.canResumeCalls, [], "canResume is only consulted for an 'auth_required' pause");

    const deadline = Date.now() + 5_000;
    while (manager.getRun(runId)?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(manager.getRun(runId)?.status, "completed", "the usage-limit run resumed normally");
  }),
);
