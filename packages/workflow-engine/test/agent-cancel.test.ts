import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RunOptions, WorkflowCallRecord } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import {
  runWorkflow,
  type WorkflowAgentAttemptControl,
} from "../src/workflow.js";

const parallelScript = `export const meta = { name: "agent-cancel", description: "per-agent cancellation" }
const values = await parallel([
  () => agent("peer", { label: "peer", retries: 3, resume: { filesystem: "read-only" } }),
  () => agent("cancel", { label: "cancel", retries: 3, resume: { filesystem: "read-only" } }),
])
return { values }`;

function cancelledByHost(): WorkflowError {
  return new WorkflowError(
    "agent call cancelled by host",
    WorkflowErrorCode.AGENT_CANCELLED,
    { recoverable: true },
  );
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function tempDirs(prefix: string): { cwd: string; root: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}-cwd-`));
  const root = mkdtempSync(join(tmpdir(), `${prefix}-root-`));
  return {
    cwd,
    root,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("engine host cancellation settles one call null, bypasses retries, and leaves siblings running", async () => {
  const dirs = tempDirs("agent-cancel-engine");
  try {
    const invocations: string[] = [];
    const attempts = new Map<number, WorkflowAgentAttemptControl>();
    const journals: number[] = [];
    const ended: Array<{ callIndex: number; errorCode?: WorkflowErrorCode }> = [];
    const runner = {
      async run(prompt: string, options: RunOptions): Promise<unknown> {
        invocations.push(prompt);
        if (prompt === "peer") return "peer-ok";
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      },
    };

    const running = runWorkflow(parallelScript, {
      cwd: dirs.cwd,
      persistenceRoot: dirs.root,
      persistLogs: false,
      runId: "engine-cancel",
      agent: runner,
      agentRetries: 3,
      onAgentAttempt: (attempt) => {
        attempts.set(attempt.callIndex, attempt);
        return () => attempts.delete(attempt.callIndex);
      },
      onAgentJournal: (entry) => journals.push(entry.index),
      onAgentEnd: (event) => ended.push({ callIndex: event.callIndex, errorCode: event.errorCode }),
    });
    await waitUntil(() => attempts.has(1), "the selected attempt should be registered");

    attempts.get(1)!.controller.abort(cancelledByHost());
    const result = await running;

    assert.equal(JSON.stringify(result.result), JSON.stringify({ values: ["peer-ok", null] }));
    assert.equal(invocations.filter((prompt) => prompt === "cancel").length, 1, "host cancel must not retry");
    assert.equal(invocations.filter((prompt) => prompt === "peer").length, 1);
    assert.deepEqual(journals, [0], "a cancelled null is not a journal result");
    assert.equal(attempts.size, 0, "attempt registrations are cleared on settlement");
    assert.deepEqual(ended.find((event) => event.callIndex === 1), {
      callIndex: 1,
      errorCode: WorkflowErrorCode.AGENT_CANCELLED,
    });
    const cancelled = result.calls?.find((record) => record.index === 1);
    assert.equal(cancelled?.outcome, "null");
    assert.equal(cancelled?.origin, "engine");
    assert.equal(cancelled?.error?.code, WorkflowErrorCode.AGENT_CANCELLED);
    assert.equal(cancelled?.error?.recoverable, true);
    assert.equal(cancelled?.aborted, undefined);
    assert.equal(result.abortSignaled, undefined);
  } finally {
    dirs.cleanup();
  }
});

test("engine cancellation latch settles an abort-ignoring runner", async () => {
  const dirs = tempDirs("agent-cancel-latch");
  try {
    let control: WorkflowAgentAttemptControl | undefined;
    let cleaned = false;
    let invocations = 0;
    const running = runWorkflow(
      `export const meta = { name: "cancel-latch", description: "ignore abort" }
return await agent("ignore", { label: "ignore", retries: 3 })`,
      {
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        persistLogs: false,
        runId: "cancel-latch",
        agent: {
          async run() {
            invocations++;
            return new Promise<never>(() => {});
          },
        },
        agentRetries: 3,
        onAgentAttempt: (attempt) => {
          control = attempt;
          return () => { cleaned = true; };
        },
      },
    );
    await waitUntil(() => control !== undefined, "the abort-ignoring attempt should be registered");
    control!.controller.abort(cancelledByHost());

    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("cancellation latch did not settle")), 500);
      }),
    ]);
    assert.equal(result.result, null);
    assert.equal(result.calls?.[0]?.error?.code, WorkflowErrorCode.AGENT_CANCELLED);
    assert.equal(invocations, 1);
    assert.equal(cleaned, true);
  } finally {
    dirs.cleanup();
  }
});

test("manager cancels a selected attempt and acknowledges only after its durable agentEnd", async () => {
  const dirs = tempDirs("agent-cancel-manager");
  try {
    let resolvePeer!: (value: unknown) => void;
    const invocations: string[] = [];
    const runner = {
      async run(prompt: string, options: RunOptions): Promise<unknown> {
        invocations.push(prompt);
        if (prompt === "peer") {
          return new Promise((resolve) => { resolvePeer = resolve; });
        }
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      },
    };
    const manager = new WorkflowManager({
      cwd: dirs.cwd,
      persistenceRoot: dirs.root,
      environmentKey: "agent-cancel-manager",
      agent: runner,
    });
    const started = manager.startInBackground(parallelScript);
    await waitUntil(() => invocations.length === 2, "both parallel attempts should start");

    await assert.rejects(
      manager.cancelAgentCall("missing-run", 0),
      (error: unknown) => error instanceof WorkflowError && /not live and owned/.test(error.message),
    );
    await assert.rejects(
      manager.cancelAgentCall(started.runId, -1),
      (error: unknown) => error instanceof WorkflowError && /non-negative safe integer/.test(error.message),
    );

    const acknowledgement = await manager.cancelAgentCall(started.runId, 1);
    assert.deepEqual(acknowledgement, {
      runId: started.runId,
      callIndex: 1,
      label: "cancel",
      scope: started.runId,
      errorCode: WorkflowErrorCode.AGENT_CANCELLED,
    });

    const persisted = manager.getPersistence().load(started.runId);
    assert.equal(persisted?.status, "running", "the owning run remains live");
    assert.equal(persisted?.abortSignaled, undefined, "per-call cancellation never stamps abort residue");
    assert.equal(
      persisted?.calls?.find((record) => record.index === 1)?.error?.code,
      WorkflowErrorCode.AGENT_CANCELLED,
      "the acknowledgement follows the durable failed call record",
    );
    assert.equal(
      persisted?.agents?.find((agent) => agent.callIndex === 1)?.errorCode,
      WorkflowErrorCode.AGENT_CANCELLED,
      "the acknowledgement follows the durable agentEnd projection",
    );
    assert.equal(manager.getRun(started.runId)?.controller.signal.aborted, false);
    assert.equal(manager.getRun(started.runId)?.abortSignaled, undefined);
    assert.equal(
      manager.inspectRun(started.runId)?.calls.find((call) => call.index === 1)?.errorCode,
      WorkflowErrorCode.AGENT_CANCELLED,
    );
    assert.equal(invocations.filter((prompt) => prompt === "cancel").length, 1);

    await assert.rejects(
      manager.cancelAgentCall(started.runId, 1),
      (error: unknown) =>
        error instanceof WorkflowError &&
        /not currently in flight/.test(error.message) &&
        /0 \("peer"/.test(error.message),
    );
    await assert.rejects(
      manager.cancelAgentCall(started.runId, 99),
      (error: unknown) => error instanceof WorkflowError && /not yet allocated/.test(error.message),
    );

    resolvePeer("peer-ok");
    const completed = await started.promise;
    assert.equal(completed.status, "completed");
    assert.equal(JSON.stringify(completed.result), JSON.stringify({ values: ["peer-ok", null] }));
    await assert.rejects(
      manager.cancelAgentCall(started.runId, 0),
      (error: unknown) => error instanceof WorkflowError && /already terminal \(completed\)/.test(error.message),
    );
  } finally {
    dirs.cleanup();
  }
});

test("manager reports an ambiguous call index without cancelling either in-flight scope", async () => {
  const dirs = tempDirs("agent-cancel-ambiguous");
  try {
    const prompts: string[] = [];
    const manager = new WorkflowManager({
      cwd: dirs.cwd,
      persistenceRoot: dirs.root,
      agent: {
        async run(prompt: string, options: RunOptions): Promise<unknown> {
          prompts.push(prompt);
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        },
      },
      loadSavedWorkflow: (name) => name === "child"
        ? `export const meta = { name: "child", description: "nested child" }
return await agent("nested", { label: "nested" })`
        : undefined,
    });
    const started = manager.startInBackground(
      `export const meta = { name: "ambiguous", description: "duplicate scoped indexes" }
return await parallel([
  () => agent("root", { label: "root" }),
  () => workflow("child"),
])`,
    );
    await waitUntil(() => prompts.length === 2, "root and nested index zero should both start");

    await assert.rejects(
      manager.cancelAgentCall(started.runId, 0),
      (error: unknown) =>
        error instanceof WorkflowError &&
        /ambiguous/.test(error.message) &&
        /"root"/.test(error.message) &&
        /"nested"/.test(error.message),
    );
    assert.equal(manager.getRun(started.runId)?.controller.signal.aborted, false);
    assert.equal(manager.stop(started.runId), true);
    await started.promise.catch(() => {});
  } finally {
    dirs.cleanup();
  }
});

test("manager refuses a cancellation acknowledgement when the failed row cannot be persisted", async () => {
  const dirs = tempDirs("agent-cancel-durability");
  try {
    let resolvePeer!: (value: unknown) => void;
    let calls = 0;
    const manager = new WorkflowManager({
      cwd: dirs.cwd,
      persistenceRoot: dirs.root,
      agent: {
        async run(prompt: string, options: RunOptions): Promise<unknown> {
          calls++;
          if (prompt === "peer") return new Promise((resolve) => { resolvePeer = resolve; });
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        },
      },
    });
    const started = manager.startInBackground(parallelScript);
    await waitUntil(() => calls === 2, "both attempts should start before the persistence fault");

    const persistence = manager.getPersistence();
    const originalSave = persistence.save.bind(persistence);
    try {
      persistence.save = () => { throw new Error("injected cancellation save failure"); };
      await assert.rejects(
        manager.cancelAgentCall(started.runId, 1),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === WorkflowErrorCode.PERSISTENCE_ERROR &&
          /failed to persist resume state/.test(error.message),
      );
    } finally {
      persistence.save = originalSave;
    }
    resolvePeer("peer-ok");
    const completed = await started.promise;
    assert.equal(completed.status, "completed");
    assert.equal(
      manager.getPersistence().load(started.runId)?.calls?.find((record) => record.index === 1)?.error?.code,
      WorkflowErrorCode.AGENT_CANCELLED,
    );
  } finally {
    dirs.cleanup();
  }
});

test("resume replays a completed sibling and reruns the cancelled occurrence", async () => {
  const dirs = tempDirs("agent-cancel-resume");
  try {
    const sourcePrompts: string[] = [];
    const source = new WorkflowManager({
      cwd: dirs.cwd,
      persistenceRoot: dirs.root,
      environmentKey: "agent-cancel-resume",
      agent: {
        async run(prompt: string, options: RunOptions): Promise<unknown> {
          sourcePrompts.push(prompt);
          if (prompt === "peer") return "source-peer";
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        },
      },
    });
    const first = source.startInBackground(parallelScript);
    await waitUntil(
      () => (source.getPersistence().load(first.runId)?.journal ?? []).some((entry) => entry.index === 0),
      "the completed sibling should be journaled before cancellation",
    );
    await source.cancelAgentCall(first.runId, 1);
    const sourceResult = await first.promise;
    assert.equal(sourceResult.status, "completed");
    assert.equal(JSON.stringify(sourceResult.result), JSON.stringify({ values: ["source-peer", null] }));
    assert.equal(source.getPersistence().load(first.runId)?.abortSignaled, undefined);

    const livePrompts: string[] = [];
    const resumed = await new WorkflowManager({
      cwd: dirs.cwd,
      persistenceRoot: dirs.root,
      environmentKey: "agent-cancel-resume",
      agent: {
        async run(prompt: string): Promise<unknown> {
          livePrompts.push(prompt);
          return `live:${prompt}`;
        },
      },
    }).runSync(parallelScript, undefined, { resumeFromRunId: first.runId });

    assert.equal(resumed.status, "completed");
    assert.equal(
      JSON.stringify(resumed.result),
      JSON.stringify({ values: ["source-peer", "live:cancel"] }),
    );
    assert.deepEqual(livePrompts, ["cancel"]);
    assert.equal(resumed.resumeReport?.replayed, 1);
    assert.equal(resumed.resumeReport?.live, 1);
    assert.equal(resumed.resumeReport?.calls.find((call) => call.index === 0)?.action, "replayed");
    assert.equal(resumed.resumeReport?.calls.find((call) => call.index === 1)?.action, "live");
    const sourceCalls = source.getPersistence().load(first.runId)?.calls as WorkflowCallRecord[];
    assert.equal(sourceCalls.find((record) => record.index === 1)?.error?.code, WorkflowErrorCode.AGENT_CANCELLED);
  } finally {
    dirs.cleanup();
  }
});
