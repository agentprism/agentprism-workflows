import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunOptions } from "@automatalabs/shared-types";
import { WorkflowManager } from "../src/workflow-manager.js";

/** Every run() call gets its own deferred result, resolved by call order. */
function perCallRunner() {
  const calls: Array<{ prompt: string; resolve: (value: unknown) => void }> = [];
  return {
    calls,
    runner: {
      async run(prompt: string, _options?: RunOptions) {
        return new Promise((resolve) => {
          calls.push({ prompt, resolve });
        });
      },
    },
  };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function withDirs(fn: (dirs: { cwd: string; root: string }) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-revision-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-revision-store-"));
    try {
      await fn({ cwd, root });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const threeCalls = (second: string) => `export const meta = { name: 'revise', description: 'three calls', model: 'claude' }
const a = await agent('first', { label: 'a' })
const b = await agent('${second}', { label: 'b' })
const c = await agent('third', { label: 'c' })
return { a, b, c }`;

test(
  "a paused run continues with a revised script: unchanged calls replay, the edited call and later work run live",
  withDirs(async ({ cwd, root }) => {
    const agent = perCallRunner();
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: agent.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(threeCalls("second"), undefined, { requireAgentConfiguration: true });
    await waitUntil(() => agent.calls.length === 1, "a starts");
    agent.calls[0].resolve("a-done");
    await waitUntil(() => agent.calls.length === 2, "b starts");
    // Pause while b executes: b finishes and journals under its old prompt, c is refused.
    assert.equal(manager.pause(runId), true);
    agent.calls[1].resolve("b-old");
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    const revised = threeCalls("second, revised");
    const started = await manager.continueRun(runId, { script: revised });
    assert.equal(started.accepted, true);
    if (!started.accepted) return;
    assert.equal(started.continuation.scriptRevised, true);
    assert.equal(started.continuation.generation, 1);
    const persistedAfterAdmission = manager.getPersistence().load(runId);
    assert.equal(persistedAfterAdmission?.script, revised, "the revision is the text that executes");
    assert.equal(persistedAfterAdmission?.scriptRevisions?.length, 1);
    assert.equal(persistedAfterAdmission?.scriptRevisions?.[0]?.generation, 1);

    await waitUntil(() => agent.calls.length === 3, "the edited call runs live");
    assert.equal(agent.calls[2].prompt, "second, revised");
    agent.calls[2].resolve("b-new");
    await waitUntil(() => agent.calls.length === 4, "the refused call runs live");
    assert.equal(agent.calls[3].prompt, "third");
    agent.calls[3].resolve("c-done");
    const result = await started.promise;
    assert.equal(result.status, "completed");
    assert.equal(JSON.stringify(result.result), JSON.stringify({ a: "a-done", b: "b-new", c: "c-done" }));
    assert.deepEqual(
      result.resumeReport?.calls.map((decision) => [decision.index, decision.action]),
      [[0, "replayed"], [1, "live"], [2, "live"]],
      "a replayed by identity; the edited b and the never-started c ran live",
    );
    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.status, "completed");
    assert.equal(persisted?.continuation?.scriptRevised, true);
    assert.deepEqual(persisted?.journal?.map((entry) => entry.index).sort(), [0, 1, 2]);
  }),
);

test(
  "a stopped run continues with an inserted call: earlier calls replay by identity, the interrupted one runs again",
  withDirs(async ({ cwd, root }) => {
    const agent = perCallRunner();
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: agent.runner });
    manager.on("error", () => {});
    const original = `export const meta = { name: 'insert', description: 'insert a call', model: 'claude' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(original, undefined, { requireAgentConfiguration: true });
    await waitUntil(() => agent.calls.length === 1, "a starts");
    agent.calls[0].resolve("a-done");
    await waitUntil(() => agent.calls.length === 2, "b starts");
    assert.equal(manager.stop(runId), true);
    agent.calls[1].resolve("lost");
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "aborted");

    const revised = `export const meta = { name: 'insert', description: 'insert a call', model: 'claude' }
const a = await agent('first', { label: 'a' })
const x = await agent('extra', { label: 'x' })
const b = await agent('second', { label: 'b' })
return { a, x, b }`;
    const started = await manager.continueRun(runId, { script: revised });
    assert.equal(started.accepted, true);
    if (!started.accepted) return;
    await waitUntil(() => agent.calls.length === 3, "the inserted call runs live");
    assert.equal(agent.calls[2].prompt, "extra");
    agent.calls[2].resolve("x-done");
    await waitUntil(() => agent.calls.length === 4, "the interrupted call runs again");
    assert.equal(agent.calls[3].prompt, "second");
    agent.calls[3].resolve("b-done");
    const result = await started.promise;
    assert.equal(result.status, "completed");
    assert.equal(JSON.stringify(result.result), JSON.stringify({ a: "a-done", x: "x-done", b: "b-done" }));
    assert.deepEqual(
      result.resumeReport?.calls.map((decision) => [decision.index, decision.action]),
      [[0, "replayed"], [1, "live"], [2, "live"]],
    );
    assert.equal(manager.getPersistence().load(runId)?.abortSignaled, undefined);
  }),
);

test(
  "a revision that does not parse is refused without touching the run, and the same text is not a revision",
  withDirs(async ({ cwd, root }) => {
    const agent = perCallRunner();
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: agent.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(threeCalls("second"), undefined, { requireAgentConfiguration: true });
    await waitUntil(() => agent.calls.length === 1, "a starts");
    agent.calls[0].resolve("a-done");
    await waitUntil(() => agent.calls.length === 2, "b starts");
    assert.equal(manager.stop(runId), true);
    agent.calls[1].resolve("lost");
    await promise.catch(() => {});
    const before = manager.getPersistence().load(runId);

    const invalid = await manager.continueRun(runId, { script: "not a workflow script" });
    assert.deepEqual(invalid, { accepted: false, reason: "script-invalid" });
    assert.deepEqual(manager.getPersistence().load(runId), before, "a refused revision changes nothing");
    assert.equal(manager.getPersistence().inspectRunLease?.(runId), null, "the lease is released");

    const same = await manager.continueRun(runId, { script: before!.script });
    assert.equal(same.accepted, true);
    if (!same.accepted) return;
    assert.equal(same.continuation.scriptRevised, undefined, "identical text continues the persisted script");
    assert.equal(same.continuation.replayedPrefix, 1, "the journaled prefix replays in place");
    assert.equal(manager.getPersistence().load(runId)?.scriptRevisions, undefined);
    await waitUntil(() => agent.calls.length === 3, "b runs again");
    agent.calls[2].resolve("b-done");
    await waitUntil(() => agent.calls.length === 4, "c runs");
    agent.calls[3].resolve("c-done");
    const result = await same.promise;
    assert.equal(result.status, "completed");
  }),
);

test(
  "a revision may keep approved backends but cannot introduce or alter one",
  withDirs(async ({ cwd, root }) => {
    const agent = perCallRunner();
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: agent.runner });
    manager.on("error", () => {});
    const withBackends = (declaration: string, second: string) => `export const meta = { name: 'backends', description: 'backends', model: 'claude', backends: { ${declaration} } }
const a = await agent('first', { label: 'a' })
const b = await agent('${second}', { label: 'b' })
return { a, b }`;
    const approved = { browser: { command: "browser-acp", args: ["--headless"] } };
    const { runId, promise } = manager.startInBackground(
      withBackends('browser: { command: "browser-acp", args: ["--headless"] }', "second"),
      undefined,
      { requireAgentConfiguration: true, scriptBackends: approved },
    );
    await waitUntil(() => agent.calls.length === 1, "a starts");
    assert.equal(manager.stop(runId), true);
    agent.calls[0].resolve("lost");
    await promise.catch(() => {});

    const added = await manager.continueRun(runId, {
      script: withBackends('browser: { command: "browser-acp", args: ["--headless"] }, other: { command: "other-acp" }', "second"),
    });
    assert.deepEqual(added, { accepted: false, reason: "backends-changed" });
    const altered = await manager.continueRun(runId, {
      script: withBackends('browser: { command: "browser-acp", args: ["--visible"] }', "second"),
    });
    assert.deepEqual(altered, { accepted: false, reason: "backends-changed" });

    const kept = await manager.continueRun(runId, {
      script: withBackends('browser: { command: "browser-acp", args: ["--headless"] }', "second, revised"),
    });
    assert.equal(kept.accepted, true);
    if (!kept.accepted) return;
    await waitUntil(() => agent.calls.length === 2, "a runs again");
    agent.calls[1].resolve("a-done");
    await waitUntil(() => agent.calls.length === 3, "b runs");
    assert.equal(agent.calls[2].prompt, "second, revised");
    agent.calls[2].resolve("b-done");
    assert.equal((await kept.promise).status, "completed");
  }),
);

test(
  "the SDK resume() path continues a revision positionally when the run has no routing admission",
  withDirs(async ({ cwd, root }) => {
    const agent = perCallRunner();
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: agent.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(threeCalls("second"));
    await waitUntil(() => agent.calls.length === 1, "a starts");
    agent.calls[0].resolve("a-done");
    await waitUntil(() => agent.calls.length === 2, "b starts");
    assert.equal(manager.stop(runId), true);
    agent.calls[1].resolve("lost");
    await promise.catch(() => {});

    const revised = threeCalls("second, revised");
    const resumed = await manager.resumeInBackground(runId, { script: revised });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) return;
    assert.equal(manager.getPersistence().load(runId)?.script, revised);
    await waitUntil(() => agent.calls.length === 3, "the edited call runs live");
    assert.equal(agent.calls[2].prompt, "second, revised");
    agent.calls[2].resolve("b-new");
    await waitUntil(() => agent.calls.length === 4, "c runs live");
    agent.calls[3].resolve("c-done");
    const result = await resumed.promise;
    assert.equal(result.status, "completed");
    assert.equal(JSON.stringify(result.result), JSON.stringify({ a: "a-done", b: "b-new", c: "c-done" }));
    assert.equal(result.resumeReport?.calls[0]?.action, "replayed", "the unchanged first call replayed");
  }),
);
