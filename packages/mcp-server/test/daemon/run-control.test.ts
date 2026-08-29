import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowProjectRegistry } from "../../src/project-registry.js";
import { clearDaemonInfo, envFingerprint, writeDaemonInfo } from "../../src/daemon/daemon-info.js";
import { createDaemon } from "../../src/daemon/http-daemon.js";
import {
  loadOrCreateRunControlKey,
  RUN_CONTROL_PATH,
  signRunControlRequest,
} from "../../src/daemon/run-control-auth.js";
import { DaemonRunControl } from "../../src/daemon/run-control.js";
import { createOrReuseWholeStopIntent } from "../../src/daemon/run-control-store.js";
import { DAEMON_NAME } from "../../src/daemon/constants.js";
import { WorkflowPermissionBroker } from "../../src/workflow-permissions.js";
import "../_harness.js";

const SCRIPT = [
  'export const meta = { name: "daemon-route-stop", description: "daemon route stop" };',
  'return await agent("block");',
].join("\n");

function controlledRunner() {
  let markStarted!: () => void;
  let resolve!: (value: string) => void;
  const ready = new Promise<void>((resolveReady) => {
    markStarted = resolveReady;
  });
  const result = new Promise<string>((resolveResult) => {
    resolve = resolveResult;
  });
  return {
    ready,
    resolve,
    runner: {
      async run() {
        markStarted();
        return result;
      },
    },
  };
}

async function postSigned(
  url: string,
  key: Uint8Array,
  request: { operationId: string; runId: string; action: "stop" },
  signatureOverride?: string,
): Promise<Response> {
  const body = JSON.stringify(request);
  const headers = signRunControlRequest(key, "POST", RUN_CONTROL_PATH, request.operationId, body);
  if (signatureOverride !== undefined) headers["x-agentprism-control-signature"] = signatureOverride;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

test("daemon execution accounting includes foreground and background manager-owned runs", async () => {
  const foregroundDir = mkdtempSync(join(tmpdir(), "agentprism-foreground-count-"));
  const backgroundDir = mkdtempSync(join(tmpdir(), "agentprism-background-count-"));
  const foregroundControl = controlledRunner();
  const backgroundControl = controlledRunner();
  const foregroundProjects = new WorkflowProjectRegistry(foregroundControl.runner, { leaseOwnerId: "foreground-owner" });
  const backgroundProjects = new WorkflowProjectRegistry(backgroundControl.runner, { leaseOwnerId: "background-owner" });
  try {
    const foregroundManager = foregroundProjects.getOrCreate(foregroundDir).manager;
    const foreground = foregroundManager.runSync(SCRIPT, undefined, { runId: "foreground-count" });
    await foregroundControl.ready;
    assert.equal(foregroundProjects.activeRunCount(), 1, "a request-bound execution is visible to daemon lifecycle accounting");
    assert.equal(foregroundManager.stop("foreground-count"), true);
    foregroundControl.resolve("cleanup");
    await foreground.catch(() => undefined);
    assert.equal(foregroundProjects.activeRunCount(), 0);

    const backgroundManager = backgroundProjects.getOrCreate(backgroundDir).manager;
    const background = backgroundManager.startInBackground(SCRIPT, undefined, { runId: "background-count" });
    await backgroundControl.ready;
    assert.equal(backgroundProjects.activeRunCount(), 1, "detached execution uses the same ownership count");
    assert.equal(backgroundManager.stop(background.runId), true);
    backgroundControl.resolve("cleanup");
    await background.promise.catch(() => undefined);
    assert.equal(backgroundProjects.activeRunCount(), 0);
  } finally {
    foregroundControl.resolve("cleanup");
    backgroundControl.resolve("cleanup");
    rmSync(foregroundDir, { recursive: true, force: true });
    rmSync(backgroundDir, { recursive: true, force: true });
  }
});

test("signed internal control rejects tampering and durably stops the owner run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-control-http-"));
  const controlled = controlledRunner();
  const instanceId = "control-http-owner";
  const daemon = await createDaemon({
    runner: controlled.runner,
    port: 0,
    ownInstanceId: instanceId,
    log: () => undefined,
  });
  try {
    const manager = daemon.projects.getOrCreate(cwd).manager;
    const started = manager.startInBackground(SCRIPT, undefined, { runId: "control-http" });
    await controlled.ready;
    const intent = createOrReuseWholeStopIntent(manager, started.runId, "requester-instance");
    const request = { operationId: intent.operationId, runId: started.runId, action: "stop" as const };
    const key = loadOrCreateRunControlKey();

    const rejected = await postSigned(daemon.controlUrl, key, request, "0".repeat(64));
    assert.equal(rejected.status, 401);
    assert.equal(manager.getPersistence().load(started.runId)?.status, "running");

    const accepted = await postSigned(daemon.controlUrl, key, request);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, outcome: "stopped" });
    const state = manager.getPersistence().load(started.runId);
    assert.equal(state?.status, "aborted");
    const events = manager.getPersistence().readEvents(started.runId, { streamId: state?.eventStreamId });
    assert.equal(events.events.filter((record) => record.event.type === "stopped").length, 1);
    controlled.resolve("cleanup");
    await started.promise.catch(() => undefined);
  } finally {
    controlled.resolve("cleanup");
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a stop intent remains pending and retry-stable when a live predecessor predates control v1", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-control-pending-"));
  const controlled = controlledRunner();
  const ownerInstanceId = "legacy-owner-instance";
  const owner = await createDaemon({
    runner: controlled.runner,
    port: 0,
    ownInstanceId: ownerInstanceId,
    log: () => undefined,
  });
  writeDaemonInfo({
    name: DAEMON_NAME,
    version: "0.1.0",
    pid: process.pid,
    port: owner.port,
    url: owner.url,
    startedAt: owner.startedAt,
    envFingerprint: envFingerprint(),
    instanceId: ownerInstanceId,
  });
  try {
    const ownerManager = owner.projects.getOrCreate(cwd).manager;
    const started = ownerManager.startInBackground(SCRIPT, undefined, { runId: "legacy-pending" });
    await controlled.ready;
    const successorProjects = new WorkflowProjectRegistry(controlled.runner, { leaseOwnerId: "successor-instance" });
    const successorManager = successorProjects.getOrCreate(cwd).manager;
    const successorControl = new DaemonRunControl({
      projects: successorProjects,
      ownPid: process.pid,
      ownInstanceId: "successor-instance",
      key: loadOrCreateRunControlKey(),
      log: () => undefined,
    });

    const first = await successorControl.control(successorManager, { runId: started.runId });
    assert.equal(first.kind, "whole");
    assert.equal(first.state, "pending");
    const retry = await successorControl.control(successorManager, { runId: started.runId });
    assert.equal(retry.kind, "whole");
    assert.equal(retry.state, "pending");
    if (first.kind !== "whole" || first.state !== "pending" || retry.kind !== "whole" || retry.state !== "pending") {
      assert.fail("expected pending whole-stop outcomes");
    }
    assert.equal(retry.operationId, first.operationId, "retry reuses the durable outstanding operation");
    assert.equal(successorManager.getPersistence().load(started.runId)?.status, "running");

    assert.equal(ownerManager.stop(started.runId), true);
    controlled.resolve("cleanup");
    await started.promise.catch(() => undefined);
  } finally {
    controlled.resolve("cleanup");
    clearDaemonInfo(process.pid);
    await owner.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("forceOwner terminates only the revalidated superseded owner, then cold-stops under the reclaimed lease", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-control-force-"));
  const controlled = controlledRunner();
  const ownerProjects = new WorkflowProjectRegistry(controlled.runner, { leaseOwnerId: "force-owner-instance" });
  const ownerManager = ownerProjects.getOrCreate(cwd).manager;
  const started = ownerManager.startInBackground(SCRIPT, undefined, { runId: "force-owner" });
  await controlled.ready;
  const successorProjects = new WorkflowProjectRegistry(controlled.runner, { leaseOwnerId: "force-successor-instance" });
  const successorManager = successorProjects.getOrCreate(cwd).manager;
  const ownerPid = 2_000_000_001;
  const successorPid = 2_000_000_002;
  const lockPath = join(ownerManager.getPersistence().getRunsDir(), `${started.runId}.lock`);
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  writeFileSync(lockPath, JSON.stringify({ ...lock, pid: ownerPid, ownerId: "force-owner-instance" }), "utf8");
  writeDaemonInfo({
    name: DAEMON_NAME,
    version: "0.9.0",
    pid: ownerPid,
    port: 9,
    url: "http://127.0.0.1:9/mcp",
    startedAt: new Date().toISOString(),
    envFingerprint: envFingerprint(),
    instanceId: "force-owner-instance",
    controlUrl: "http://127.0.0.1:9/_agentprism/control/v1/run",
    controlProtocol: 1,
  });
  writeDaemonInfo({
    name: DAEMON_NAME,
    version: "1.0.0",
    pid: successorPid,
    port: 10,
    url: "http://127.0.0.1:10/mcp",
    startedAt: new Date().toISOString(),
    envFingerprint: envFingerprint(),
    instanceId: "force-successor-instance",
    controlUrl: "http://127.0.0.1:10/_agentprism/control/v1/run",
    controlProtocol: 1,
  });
  let ownerAlive = true;
  const signals: NodeJS.Signals[] = [];
  const control = new DaemonRunControl({
    projects: successorProjects,
    ownPid: successorPid,
    ownInstanceId: "force-successor-instance",
    key: loadOrCreateRunControlKey(),
    isPidAlive: (pid) => pid === successorPid || (pid === ownerPid && ownerAlive),
    kill: (pid, signal) => {
      assert.equal(pid, ownerPid);
      signals.push(signal);
      ownerAlive = false;
    },
    log: () => undefined,
  });
  try {
    writeFileSync(lockPath, JSON.stringify({ ...lock, pid: ownerPid, ownerId: "mismatched-owner" }), "utf8");
    await assert.rejects(
      control.control(successorManager, { runId: started.runId, forceOwner: true }),
      /owner instance identity does not match the lease/,
    );
    assert.deepEqual(signals, [], "identity mismatch is rejected before signaling any process");
    writeFileSync(lockPath, JSON.stringify({ ...lock, pid: ownerPid, ownerId: "force-owner-instance" }), "utf8");

    const outcome = await control.control(successorManager, { runId: started.runId, forceOwner: true });
    assert.deepEqual(outcome, {
      kind: "whole",
      state: "settled",
      stopped: true,
      alreadyTerminal: false,
    });
    assert.deepEqual(signals, ["SIGTERM"], "a responsive force target exits during the graceful phase");
    assert.equal(successorManager.getPersistence().load(started.runId)?.status, "aborted");

    const warn = console.warn;
    console.warn = () => undefined;
    try {
      controlled.resolve("cleanup");
      await started.promise.catch(() => undefined);
    } finally {
      console.warn = warn;
    }
    assert.equal(successorManager.getPersistence().load(started.runId)?.status, "aborted", "the stale in-memory writer cannot overwrite the new lease holder");
  } finally {
    controlled.resolve("cleanup");
    clearDaemonInfo(successorPid);
    clearDaemonInfo(ownerPid);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("permission inspection and response route to the predecessor that owns the live ACP request", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-permission-route-"));
  const controlled = controlledRunner();
  const permissionBroker = new WorkflowPermissionBroker();
  const ownerInstanceId = "permission-owner-instance";
  const owner = await createDaemon({
    runner: controlled.runner,
    permissionBroker,
    port: 0,
    ownInstanceId: ownerInstanceId,
    log: () => undefined,
  });
  writeDaemonInfo({
    name: DAEMON_NAME,
    version: "0.99.0",
    pid: process.pid,
    port: owner.port,
    url: owner.url,
    startedAt: owner.startedAt,
    envFingerprint: envFingerprint(),
    instanceId: ownerInstanceId,
    controlUrl: owner.controlUrl,
    controlProtocol: 1,
  });
  try {
    const ownerManager = owner.projects.getOrCreate(cwd).manager;
    const started = ownerManager.startInBackground(SCRIPT, undefined, { runId: "permission-route" });
    await controlled.ready;
    const permissionResponse = Promise.resolve(permissionBroker.resolver(
      {
        sessionId: "owner-session",
        toolCall: { toolCallId: "owner-tool", title: "Run command", kind: "execute" },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "cancel", name: "Cancel", kind: "reject_once" },
        ],
      },
      { sessionId: "owner-session", backendId: "codex", runId: started.runId, callIndex: 0 },
    ));

    const successorProjects = new WorkflowProjectRegistry(controlled.runner, { leaseOwnerId: "permission-successor" });
    const successorManager = successorProjects.getOrCreate(cwd).manager;
    const successorControl = new DaemonRunControl({
      projects: successorProjects,
      ownPid: process.pid,
      ownInstanceId: "permission-successor",
      key: loadOrCreateRunControlKey(),
      log: () => undefined,
    });

    const pending = await successorControl.listPermissions(successorManager, started.runId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request.options[0]?.optionId, "allow_once");
    const acknowledgement = await successorControl.respondPermission(successorManager, {
      runId: started.runId,
      permissionId: pending[0]!.permissionId,
      response: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    assert.equal(acknowledgement.runId, started.runId);
    assert.deepEqual(await permissionResponse, {
      outcome: { outcome: "selected", optionId: "allow_once" },
    });

    assert.equal(ownerManager.stop(started.runId), true);
    controlled.resolve("cleanup");
    await started.promise.catch(() => undefined);
  } finally {
    controlled.resolve("cleanup");
    permissionBroker.dispose();
    clearDaemonInfo(process.pid);
    await owner.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a successor-side controller resolves the lease owner and forwards whole-run stop", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-control-route-"));
  const controlled = controlledRunner();
  const ownerInstanceId = "predecessor-owner-instance";
  const owner = await createDaemon({
    runner: controlled.runner,
    port: 0,
    ownInstanceId: ownerInstanceId,
    log: () => undefined,
  });
  writeDaemonInfo({
    name: DAEMON_NAME,
    version: "0.99.0",
    pid: process.pid,
    port: owner.port,
    url: owner.url,
    startedAt: owner.startedAt,
    envFingerprint: envFingerprint(),
    instanceId: ownerInstanceId,
    controlUrl: owner.controlUrl,
    controlProtocol: 1,
  });
  try {
    const ownerManager = owner.projects.getOrCreate(cwd).manager;
    const started = ownerManager.startInBackground(SCRIPT, undefined, { runId: "cross-generation" });
    await controlled.ready;

    const successorProjects = new WorkflowProjectRegistry(controlled.runner, { leaseOwnerId: "successor-instance" });
    const successorManager = successorProjects.getOrCreate(cwd).manager;
    const successorControl = new DaemonRunControl({
      projects: successorProjects,
      ownPid: process.pid,
      ownInstanceId: "successor-instance",
      key: loadOrCreateRunControlKey(),
      log: () => undefined,
    });
    const outcome = await successorControl.control(successorManager, { runId: started.runId });
    assert.deepEqual(outcome, {
      kind: "whole",
      state: "settled",
      stopped: true,
      alreadyTerminal: false,
    });
    assert.equal(successorManager.getPersistence().load(started.runId)?.status, "aborted");
    controlled.resolve("cleanup");
    await started.promise.catch(() => undefined);
  } finally {
    controlled.resolve("cleanup");
    clearDaemonInfo(process.pid);
    await owner.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
