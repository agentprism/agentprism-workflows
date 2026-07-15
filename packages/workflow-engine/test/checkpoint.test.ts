import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CheckpointContext } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

const DURABLE_PROMPT = "Choose release action";
const DURABLE_CHOICES = ["ship", "hold"];
const DURABLE_SCRIPT = `export const meta = { name: 'durable-checkpoint', description: 'durable checkpoint' }
const prefix = await agent('before', { label: 'before' })
const decision = await checkpoint('${DURABLE_PROMPT}', {
  headless: 'pause',
  kind: 'select',
  choices: ['ship', 'hold'],
  default: 'hold'
})
const after = await agent('after:' + decision, { label: 'after' })
return { prefix, decision, after }`;

function memoryPersistence(): { persistence: RunPersistence; saves: PersistedRunState[] } {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const clone = (state: PersistedRunState): PersistedRunState => structuredClone(state);
  return {
    saves,
    persistence: {
      save(state) {
        const copy = clone(state);
        saves.push(copy);
        states.set(copy.runId, copy);
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
        return { runId, token: `${runId}-lease` };
      },
      releaseRunLease() {},
      getRunsDir() {
        return "/memory/runs";
      },
    },
  };
}

function recordingAgent() {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      async run(prompt: string) {
        prompts.push(prompt);
        return `agent:${prompt}`;
      },
    },
  };
}

function withTempPersistenceRoot(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "agentprism-durable-checkpoint-"));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function withTempPersistenceDirs(fn: (root: string, cwd: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "agentprism-durable-checkpoint-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentprism-durable-checkpoint-cwd-"));
    try {
      await fn(root, cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

test("checkpoint(): headless takes the declared default and journals it", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const ok = await checkpoint('Approve plan?', { default: true })
const name = await checkpoint('Pick a name', { default: 'fallback' })
return { ok, name }`;
  const res = await runWorkflow<{ ok: boolean; name: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.name, "fallback");
  assert.equal(journal.length, 2, "both checkpoints journaled");
  assert.deepEqual(res.checkpointsTaken, [
    { callIndex: 0, kind: "confirm", decision: true, source: "headless-default" },
    { callIndex: 1, kind: "confirm", decision: "fallback", source: "headless-default" },
  ]);
});

test("checkpoint(): headless 'abort' throws when no UI is threaded in", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('Approve?', { headless: 'abort' })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /human input|headless/i);
});

test("checkpoint(): uses the threaded confirm when present", async () => {
  let asked = "";
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?', { kind: 'confirm' })`;
  const res = await runWorkflow<string>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async (p) => {
      asked = p;
      return "yes";
    },
  });
  assert.equal(res.result, "yes");
  assert.equal(asked, "Proceed?");
  assert.deepEqual(res.checkpointsTaken, [
    { callIndex: 0, kind: "confirm", decision: "yes", source: "live" },
  ]);
});

test("checkpoint(): headless 'pause' still uses a live confirm when one is threaded", async () => {
  let calls = 0;
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?', { headless: 'pause', default: false })`;
  const result = await runWorkflow<string>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => {
      calls++;
      return "live-approved";
    },
  });

  assert.equal(result.result, "live-approved");
  assert.equal(calls, 1, "the live channel wins over headless:'pause'");
});

test("checkpoint(): replays the journaled reply on resume (no re-prompt)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const r = await checkpoint('Approve?', {})
return { r }`;
  const journal = new Map<number, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => "approved",
    onAgentJournal: (e) => journal.set(e.index, e),
  });
  assert.equal(first.result.r, "approved");

  let calledAgain = false;
  const second = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    resumeJournal: journal,
    confirm: async () => {
      calledAgain = true;
      return "DIFFERENT";
    },
  });
  assert.equal(second.result.r, "approved", "reply replays from the journal");
  assert.equal(calledAgain, false, "confirm is not called again on resume");
  assert.deepEqual(second.checkpointsTaken, [
    { callIndex: 0, kind: "confirm", decision: "approved", source: "journal-replay" },
  ]);
});

test("checkpoint(): counts against maxAgents (no tokens, but bounded)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('a', { default: 1 })
await checkpoint('b', { default: 1 })
await checkpoint('c', { default: 1 })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false, maxAgents: 2 }), /limit/i);
});

test(
  "durable checkpoint: pause context and prefix persist; cold reply resume journals the answer permanently",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let pausedEvent:
      | { reason?: string; checkpointContext?: CheckpointContext; authContext?: unknown; resetHint?: unknown }
      | undefined;
    manager1.on("paused", (event: typeof pausedEvent) => {
      pausedEvent = event;
    });

    const paused = await manager1.runSync(DURABLE_SCRIPT);
    const context = paused.checkpointContext;
    const expectedHash = createHash("sha256")
      .update(JSON.stringify({ promptText: DURABLE_PROMPT, kind: "select", choices: DURABLE_CHOICES }))
      .digest("hex");

    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "checkpoint_required");
    assert.ok(context, "the terminal result carries checkpointContext");
    assert.equal(context.callIndex, 1);
    assert.equal(context.hash, expectedHash);
    assert.equal(context.prompt, DURABLE_PROMPT);
    assert.equal(context.kind, "select");
    assert.deepEqual(Array.from(context.choices ?? []), DURABLE_CHOICES);
    assert.equal(context.default, "hold");
    assert.equal(paused.authContext, undefined);
    assert.equal(paused.resetHint, undefined);
    assert.equal(paused.checkpointsTaken, undefined, "a checkpoint that pauses has not resolved");
    assert.equal(pausedEvent?.reason, "checkpoint_required");
    assert.deepEqual(pausedEvent?.checkpointContext, context);
    assert.equal(pausedEvent?.authContext, undefined);
    assert.equal(pausedEvent?.resetHint, undefined);
    assert.deepEqual(firstAgent.prompts, ["before"]);

    const persistedPause = store.persistence.load(paused.runId);
    assert.equal(persistedPause?.status, "paused");
    assert.equal(persistedPause?.pauseReason, "checkpoint_required");
    assert.deepEqual(persistedPause?.checkpointContext, structuredClone(context));
    assert.equal(persistedPause?.journal?.length, 1, "the completed agent prefix remains journaled");
    assert.equal(persistedPause?.journal?.[0]?.index, 0);
    assert.equal(persistedPause?.journal?.[0]?.result, "agent:before");

    // Fresh manager instance: the reply is supplied out-of-band and no live confirm is asked.
    const resumedAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: resumedAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let liveAsks = 0;
    const resumed = await manager2.resumeInBackground(paused.runId, {
      checkpointReplies: { [context.callIndex]: "ship" },
      confirm: async () => {
        liveAsks++;
        return "wrong-live-answer";
      },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the cold resume should be accepted");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.checkpointsTaken, [
      { callIndex: context.callIndex, kind: "select", decision: "ship", source: "injected" },
    ]);
    assert.equal(field(completed.result, "prefix"), "agent:before");
    assert.equal(field(completed.result, "decision"), "ship");
    assert.equal(field(completed.result, "after"), "agent:after:ship");
    assert.equal(liveAsks, 0, "the injected journal reply prevents a live re-ask");
    assert.deepEqual(resumedAgent.prompts, ["after:ship"], "the prefix replayed and only new work ran live");

    const finalState = store.persistence.load(paused.runId);
    assert.equal(finalState?.status, "completed");
    const replyEntry = finalState?.journal?.find((entry) => entry.index === context.callIndex);
    assert.deepEqual(
      { index: replyEntry?.index, hash: replyEntry?.hash, result: replyEntry?.result, kind: replyEntry?.kind, scope: replyEntry?.scope },
      { index: context.callIndex, hash: context.hash, result: "ship", kind: "checkpoint", scope: paused.runId },
      "the synthetic decision is in the final persisted journal",
    );
    assert.deepEqual(replyEntry?.call, { kind: "checkpoint", label: "checkpoint", phase: undefined });
    assert.deepEqual(finalState?.checkpointsTaken, completed.checkpointsTaken);

    // A third, cold manager can hydrate that final journal and complete with no reply or
    // confirm channel at all. Every call replays, proving the synthetic answer is durable.
    const replayAgent = recordingAgent();
    const manager3 = new WorkflowManager({
      agent: replayAgent.runner,
      persistence: memoryPersistence().persistence,
      persistenceRoot,
    });
    const replayJournal = new Map((finalState?.journal ?? []).map((entry) => [entry.index, entry] as const));
    const replayed = await manager3.runSync(DURABLE_SCRIPT, undefined, { resumeJournal: replayJournal });
    assert.equal(replayed.status, "completed");
    assert.equal(field(replayed.result, "decision"), "ship");
    assert.deepEqual(replayAgent.prompts, [], "the third cold replay asks nothing and executes no agent");
    assert.deepEqual(replayed.checkpointsTaken, [
      { callIndex: context.callIndex, kind: "select", decision: "ship", source: "journal-replay" },
    ]);
  }),
);

test(
  "durable checkpoint: real filesystem persistence survives a fresh-manager reply resume",
  withTempPersistenceDirs(async (persistenceRoot, cwd) => {
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      cwd,
      persistenceRoot,
    });

    const paused = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "checkpoint_required");
    const context = paused.checkpointContext;
    assert.ok(context, "the filesystem-persisted pause exposes its checkpoint context");
    assert.deepEqual(firstAgent.prompts, ["before"]);
    assert.equal(manager1.getPersistence().load(paused.runId)?.status, "paused");

    const resumedAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: resumedAgent.runner,
      cwd,
      persistenceRoot,
    });
    const resumed = await manager2.resumeInBackground(paused.runId, {
      checkpointReplies: { [context.callIndex]: "ship" },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the fresh manager should load and resume the on-disk pause");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.equal(field(completed.result, "decision"), "ship");
    assert.equal(field(completed.result, "after"), "agent:after:ship");
    assert.deepEqual(resumedAgent.prompts, ["after:ship"]);

    const listed = manager2.listRuns().find((run) => run.runId === paused.runId);
    const loaded = manager2.getPersistence().load(paused.runId);
    assert.equal(listed?.status, "completed", "the filesystem listing exposes the terminal state");
    assert.equal(loaded?.status, "completed", "a direct filesystem load exposes the terminal state");
    const replyEntry = loaded?.journal?.find((entry) => entry.index === context.callIndex);
    assert.deepEqual(
      { index: replyEntry?.index, hash: replyEntry?.hash, result: replyEntry?.result, kind: replyEntry?.kind, scope: replyEntry?.scope },
      { index: context.callIndex, hash: context.hash, result: "ship", kind: "checkpoint", scope: paused.runId },
      "the synthetic checkpoint reply is durably journaled on disk",
    );
    assert.deepEqual(replyEntry?.call, { kind: "checkpoint", label: "checkpoint" });
  }),
);

test(
  "durable checkpoint: cold resume without a reply or live confirm re-pauses without executing",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    const first = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(first.status, "paused");
    assert.ok(first.checkpointContext);
    const before = store.persistence.load(first.runId);
    const saveCount = store.saves.length;

    const coldAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: coldAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let resumedEvent = false;
    manager2.on("resumed", () => {
      resumedEvent = true;
    });
    let rePaused: { reason?: string; checkpointContext?: CheckpointContext; error?: WorkflowError } | undefined;
    manager2.on("paused", (event: typeof rePaused) => {
      rePaused = event;
    });

    const resumed = await manager2.resumeInBackground(first.runId);
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the re-pause should use the accepted settlement shape");
    await assert.rejects(
      resumed.promise,
      (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED,
    );

    assert.equal(resumedEvent, false, "an immediate re-pause does not emit resumed");
    assert.deepEqual(coldAgent.prompts, [], "no agent calls are made");
    assert.equal(store.saves.length, saveCount, "the script was not executed and persisted state was not rewritten");
    assert.equal(rePaused?.reason, "checkpoint_required");
    assert.equal(rePaused?.error?.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.deepEqual(rePaused?.checkpointContext, structuredClone(first.checkpointContext));
    assert.deepEqual(store.persistence.load(first.runId), before, "the exact paused state and context are preserved");
  }),
);

test(
  "durable checkpoint: cold resume can answer through a live confirm channel",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const manager1 = new WorkflowManager({
      agent: recordingAgent().runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    const first = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(first.status, "paused");

    const liveAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: liveAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let asks = 0;
    const resumed = await manager2.resumeInBackground(first.runId, {
      confirm: async (prompt) => {
        asks++;
        assert.equal(prompt, DURABLE_PROMPT);
        return "hold";
      },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the live-confirm resume should be accepted");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.equal(field(completed.result, "decision"), "hold");
    assert.equal(asks, 1);
    assert.deepEqual(completed.checkpointsTaken, [
      { callIndex: first.checkpointContext?.callIndex, kind: "select", decision: "hold", source: "live" },
    ]);
    assert.deepEqual(liveAgent.prompts, ["after:hold"]);
    const context = first.checkpointContext;
    assert.ok(context);
    assert.equal(
      store.persistence.load(first.runId)?.journal?.find((entry) => entry.index === context.callIndex)?.result,
      "hold",
    );
  }),
);
