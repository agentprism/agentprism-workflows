import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowManager } from "@automatalabs/workflows";
import { DAEMON_NAME } from "../../src/daemon/constants.js";
import { clearDaemonInfo, envFingerprint, writeDaemonInfo } from "../../src/daemon/daemon-info.js";
import { WorkflowPermissionBroker } from "../../src/workflow-permissions.js";
import { connectHttp, makeProjectDir, startDaemon } from "../_http-harness.js";
import { makeRunner, okRunner, structured, textOf, waitForRun } from "../_harness.js";

test("an earlier daemon observes and answers permissions after another daemon continues its paused run", async () => {
  const permissions = new WorkflowPermissionBroker();
  const runner = makeRunner(async (_prompt, options) => {
    const response = await permissions.resolver({
      sessionId: "continued-session",
      toolCall: { toolCallId: "continued-tool", title: "Run tests", kind: "execute" },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    }, { sessionId: "continued-session", backendId: "codex", runId: options.runId, callIndex: options.callIndex });
    assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "allow_once" } });
    options.onUsage?.({ input: 3, output: 5, total: 8, cost: 0.01, cacheRead: 0, cacheWrite: 0 });
    return "completed by current owner";
  });
  const earlier = await startDaemon(okRunner());
  const current = await startDaemon(runner, permissions);
  const projectDir = makeProjectDir("owner-inspection");
  const first = await connectHttp(earlier.url, { listTools: true });
  const second = await connectHttp(current.url, { listTools: true });
  let runId: string | undefined;
  try {
    const accepted = await first.client.callTool({ name: "workflow", arguments: {
      action: "run", projectDir,
      script: 'export const meta = { model: "claude", name: "owner-inspection", description: "follow current ownership" }; await checkpoint("Continue?"); return await agent("work");',
    } });
    assert.equal(accepted.isError, false, textOf(accepted));
    runId = String(structured(accepted)?.runId);
    assert.equal(structured(await waitForRun(first.client, runId))?.status, "paused");
    assert.equal(earlier.projects.getOrCreate(projectDir).manager.getRun(runId)?.status, "paused");

    writeDaemonInfo({
      name: DAEMON_NAME, version: "4.1.0", pid: process.pid, port: current.port,
      url: current.url, startedAt: current.startedAt, envFingerprint: envFingerprint(),
      instanceId: current.instanceId, controlUrl: current.controlUrl, controlProtocol: 1,
    });
    const resumed = await second.client.callTool({ name: "workflow", arguments: {
      action: "resume", runId, checkpointReplies: { 0: true },
    } });
    assert.equal(resumed.isError, false, textOf(resumed));
    const waiting = await waitForRun(first.client, runId, (state) =>
      (state.pendingPermissions as unknown[] | undefined)?.length === 1);
    assert.equal(waiting.isError, false, textOf(waiting));
    assert.equal(structured(waiting)?.status, "running", "the old daemon must not keep projecting its cached checkpoint pause");
    const pending = structured(waiting)?.pendingPermissions as { permissionId: string }[];
    const answer = await first.client.callTool({ name: "workflow", arguments: {
      action: "permissions-response", runId, permissionId: pending[0]!.permissionId,
      response: { outcome: { outcome: "selected", optionId: "allow_once" } },
    } });
    assert.equal(answer.isError, false, textOf(answer));
    const completed = await waitForRun(first.client, runId);
    assert.equal(completed.isError, false, textOf(completed));
    assert.equal(structured(completed)?.status, "completed");
    const outcome = structured(completed)?.outcome as { status: string; result: unknown; checkpointContext?: unknown };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.result, "completed by current owner");
    assert.equal(outcome.checkpointContext, undefined);
    assert.equal((structured(completed)?.tokenUsage as { total: number })?.total, 8);
    assert.equal(earlier.projects.getOrCreate(projectDir).manager.getRun(runId), undefined);
  } finally {
    if (runId) await second.client.callTool({ name: "workflow", arguments: { action: "stop", runId } }).catch(() => undefined);
    permissions.dispose();
    await first.dispose();
    await second.dispose();
    await earlier.close();
    await current.close();
    clearDaemonInfo(process.pid);
  }
});

test("a remote completion between inspection reads cannot attach completed fields to a paused snapshot", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("observation-race");
  const connection = await connectHttp(daemon.url, { listTools: true });
  let restore: (() => void) | undefined;
  try {
    const accepted = await connection.client.callTool({ name: "workflow", arguments: {
      action: "run", projectDir,
      script: 'export const meta = { model: "claude", name: "observation-race", description: "coherent status" }; await checkpoint("Continue?"); return "remote completion";',
    } });
    const runId = String(structured(accepted)?.runId);
    assert.equal(structured(await waitForRun(connection.client, runId))?.status, "paused");
    const manager = daemon.projects.getOrCreate(projectDir).manager;
    const paused = manager.getPersistence().load(runId)!;
    const remote = new WorkflowManager({ cwd: projectDir, agent: okRunner() });
    const continued = await remote.continueRun(runId, { checkpointReplies: { 0: true } });
    assert.ok(continued.accepted);
    await continued.promise;
    const completed = manager.getPersistence().load(runId)!;
    manager.getPersistence().save(paused);
    const inspect = manager.inspectRun.bind(manager);
    let raced = false;
    manager.inspectRun = (...args) => {
      const snapshot = inspect(...args);
      if (!raced && args[0] === runId) {
        raced = true;
        // Deterministically place the remote owner's atomic terminal save after the
        // inspected snapshot and before outcome/resource reads in this response.
        manager.getPersistence().save(completed);
      }
      return snapshot;
    };
    restore = () => { manager.inspectRun = inspect; };
    const observed = await connection.client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(observed.isError, false, textOf(observed));
    assert.equal(structured(observed)?.status, "paused");
    assert.equal(structured(observed)?.resultUri, undefined);
    const outcome = structured(observed)?.outcome as { status: string; result?: unknown; resultUri?: string };
    assert.equal(outcome.status, "paused");
    assert.equal(outcome.result, undefined);
    assert.equal(outcome.resultUri, undefined);
    assert.doesNotMatch(textOf(observed), /Workflow result \(exact JSON\)/);
    const next = await connection.client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(next.isError, false, textOf(next));
    assert.equal(structured(next)?.status, "completed");
    assert.equal((structured(next)?.outcome as { result: unknown }).result, "remote completion");
  } finally {
    restore?.();
    await connection.dispose();
    await daemon.close();
  }
});
