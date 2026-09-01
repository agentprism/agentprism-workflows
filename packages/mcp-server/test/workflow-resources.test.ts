import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { ElicitResult } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import {
  WorkflowManager,
  type PersistedRunState,
  type RunPersistence,
} from "@automatalabs/workflows";

import { createWorkflowServer } from "../src/server.js";
import { WorkflowScriptResources } from "../src/workflow-resources.js";
import {
  connect,
  countingRunner,
  makeRunner,
  NO_AGENT_SCRIPT,
  okRunner,
  persistedRunFile,
  structured,
  TWO_AGENT_SCRIPT,
} from "./_harness.js";

function resourceLinks(result: Awaited<ReturnType<Client["callTool"]>>): Array<Record<string, unknown>> {
  return (result.content as Array<Record<string, unknown>>).filter((block) => block.type === "resource_link");
}

function resourceText(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const content = result.contents[0];
  assert.ok(content && "text" in content);
  return String(content.text);
}

interface EventDocument {
  streamId: string;
  cursor: number;
  endCursor: number;
  hasMore: boolean;
  events: Array<{ seq: number; event: { type: string; message?: string } }>;
}

function eventDocument(result: Awaited<ReturnType<Client["readResource"]>>): EventDocument {
  return JSON.parse(resourceText(result)) as EventDocument;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function saveFaultPersistence(
  root: string,
  failSave: (attempt: number, state: PersistedRunState) => boolean,
): {
  persistence: RunPersistence;
  durable: RunPersistence;
  attempts: () => number;
  acquiredRunIds: string[];
} {
  const records = new Map<string, PersistedRunState>();
  const leases = new Map<string, string>();
  const durable: RunPersistence = {
    save(state) {
      records.set(state.runId, structuredClone(state));
    },
    load(runId) {
      const state = records.get(runId);
      return state ? structuredClone(state) : null;
    },
    list: () => [...records.values()].map((state) => structuredClone(state)),
    delete(runId) {
      return records.delete(runId);
    },
    acquireRunLease(runId) {
      if (leases.has(runId)) return null;
      const token = `${runId}-${leases.size}`;
      leases.set(runId, token);
      return { runId, token };
    },
    releaseRunLease(lease) {
      if (leases.get(lease.runId) === lease.token) leases.delete(lease.runId);
    },
    getRunsDir: () => root,
  };
  let saveAttempts = 0;
  const acquiredRunIds: string[] = [];
  const persistence: RunPersistence = {
    save(state) {
      saveAttempts++;
      if (failSave(saveAttempts, state)) throw new Error(`injected save failure ${saveAttempts}`);
      durable.save(state);
    },
    load: (runId) => durable.load(runId),
    list: () => durable.list(),
    delete: (runId) => durable.delete(runId),
    acquireRunLease(runId) {
      acquiredRunIds.push(runId);
      return durable.acquireRunLease(runId);
    },
    releaseRunLease: (lease) => durable.releaseRunLease(lease),
    getRunsDir: () => durable.getRunsDir(),
  };
  return { persistence, durable, attempts: () => saveAttempts, acquiredRunIds };
}

test("initialize advertises full resources capabilities and scriptPath snapshots content into a linked resource", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentprism-mcp-script-path-"));
  const scriptPath = join(dir, "flow.workflow.js");
  writeFileSync(scriptPath, NO_AGENT_SCRIPT, "utf8");
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    assert.deepEqual(client.getServerCapabilities()?.resources, { subscribe: true, listChanged: true });
    const beforeUnreadable = (await client.listResources()).resources.length;
    const unreadablePath = join(dir, "missing.workflow.js");
    const unreadable = await client.callTool({
      name: "workflow",
      arguments: { scriptPath: unreadablePath },
    });
    assert.equal(unreadable.isError, true);
    assert.match(
      String((unreadable.content as Array<{ text?: string }>)[0]?.text),
      new RegExp(`unable to read scriptPath .*missing\\.workflow\\.js.*ENOENT`),
    );
    assert.equal(
      (await client.listResources()).resources.length,
      beforeUnreadable,
      "a read failure must create neither a persisted run nor a script resource",
    );
    const result = await client.callTool({
      name: "workflow",
      arguments: { scriptPath },
    });
    const runId = String(structured(result)?.runId);
    const uri = `workflow://runs/${runId}/script`;
    assert.equal(result.isError, false);
    assert.equal(structured(result)?.scriptSource, "path");
    assert.equal(structured(result)?.scriptUri, uri);
    assert.equal(structured(result)?.eventsUri, `workflow://runs/${runId}/events`);
    assert.deepEqual(resourceLinks(result).map((link) => link.uri), [
      `workflow://runs/${runId}/result`,
      uri,
      `workflow://runs/${runId}/events`,
    ]);

    writeFileSync(scriptPath, `${NO_AGENT_SCRIPT}\n// later edit`, "utf8");
    assert.equal(resourceText(await client.readResource({ uri })), NO_AGENT_SCRIPT);
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admission readback preserves authored args and the original persisted script", async () => {
  const script = [
    "// leading author note",
    "/* another leading note */",
    'export const meta = { name: "admission-args", description: "args snapshot" };',
    "return args;",
  ].join("\n");
  const args = { topic: "durability", nested: { count: 3 } };
  const { client, dispose } = await connect(okRunner());
  try {
    const result = await client.callTool({
      name: "workflow",
      arguments: { script, args },
    });
    assert.deepEqual(structured(result)?.result, args);
    const runId = String(structured(result)?.runId);
    const file = persistedRunFile(runId);
    assert.ok(file);
    const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.script, script);
    assert.deepEqual(persisted.args, args);
  } finally {
    await dispose();
  }
});

test("readback rejects a transient initial save failure before execution can rescue it", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-transient-admission-"));
  const fault = saveFaultPersistence(root, (attempt) => attempt === 1);
  let runnerCalls = 0;
  const runner = makeRunner(() => {
    runnerCalls++;
    return "unexpected";
  });
  const manager = new WorkflowManager({ cwd: root, agent: runner, persistence: fault.persistence });
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "transient-admission-client", version: "0.0.0" }, { capabilities: {} });
  let listChanged = 0;
  client.setNotificationHandler('notifications/resources/list_changed', () => {
    listChanged++;
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await client.listTools();
    const result = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "failed-admission", description: "must not execute" };',
          'return await agent("must not start");',
        ].join("\n"),
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(resourceLinks(result).length, 0);

    const runId = fault.acquiredRunIds[0];
    assert.ok(runId);
    const uri = `workflow://runs/${runId}/script`;
    assert.ok(fault.attempts() > 1);
    assert.equal(runnerCalls, 0);
    assert.equal(manager.getRun(runId), undefined);
    assert.equal(fault.durable.load(runId), null);
    await assert.rejects(client.readResource({ uri }), /resource not found/i);
    assert.equal(listChanged, 0);
    const lease = fault.durable.acquireRunLease(runId);
    assert.ok(lease);
    fault.durable.releaseRunLease(lease);
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed terminal snapshot save never advertises exact-result availability", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-result-save-failure-"));
  const fault = saveFaultPersistence(root, (_attempt, state) => state.status === "completed");
  const runner = okRunner();
  const manager = new WorkflowManager({ cwd: root, agent: runner, persistence: fault.persistence });
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "result-save-failure-client", version: "0.0.0" }, { capabilities: {} });
  let listChanged = 0;
  client.setNotificationHandler('notifications/resources/list_changed', () => {
    listChanged++;
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const completed = await client.callTool({ name: "workflow", arguments: { script: NO_AGENT_SCRIPT } });
    const runId = String(structured(completed)?.runId);
    assert.equal(structured(completed)?.status, "completed");
    assert.equal(structured(completed)?.resultUri, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(listChanged, 1, "only durable admission changes the list; the unsaved result does not");

    const unavailable = await client.callTool({
      name: "workflow",
      arguments: { action: "result", runId },
    });
    assert.equal(unavailable.isError, true);
    assert.match(
      String((unavailable.content as Array<{ text?: string }>)[0]?.text),
      /unavailable while the run is running/,
    );
    await assert.rejects(
      client.readResource({ uri: `workflow://runs/${runId}/result` }),
      /unavailable|resource not found/i,
    );
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed foreground admission cannot enter the VM or abandon a checkpoint elicitation", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-checkpoint-admission-"));
  let failSaves = false;
  const fault = saveFaultPersistence(root, () => failSaves);
  const runner = okRunner();
  const manager = new WorkflowManager({ cwd: root, agent: runner, persistence: fault.persistence });
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "checkpoint-admission-client", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  let priming = true;
  let elicitationRequests = 0;
  let activeElicitations = 0;
  let cancelledElicitations = 0;
  client.setRequestHandler('elicitation/create', (_request, ctx): ElicitResult | Promise<ElicitResult> => {
    elicitationRequests++;
    if (priming) return { action: "accept", content: { approve: true } };
    activeElicitations++;
    return new Promise<ElicitResult>((resolve) => {
      ctx.mcpReq.signal.addEventListener("abort", () => {
        activeElicitations--;
        cancelledElicitations++;
        resolve({ action: "cancel" });
      }, { once: true });
    });
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const checkpointScript = [
    'export const meta = { name: "admission-checkpoint", description: "pre-VM admission" };',
    'return await checkpoint("Ship?", { kind: "confirm" });',
  ].join("\n");
  try {
    const primed = await client.callTool({ name: "workflow", arguments: { script: checkpointScript } });
    assert.equal(primed.isError, false);
    assert.equal(elicitationRequests, 1);

    priming = false;
    failSaves = true;
    const failed = await client.callTool({ name: "workflow", arguments: { script: checkpointScript } });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent, undefined);
    assert.equal(resourceLinks(failed).length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elicitationRequests, 1, "authored checkpoint code must not run before durable readback");
    assert.equal(activeElicitations, 0, "the failed tool call must leave no elicitation unsettled");
    assert.equal(cancelledElicitations, 0, "the pre-VM latch should prevent a request from needing cancellation");

    const failedRunId = fault.acquiredRunIds.at(-1);
    assert.ok(failedRunId);
    assert.equal(manager.getRun(failedRunId), undefined);
    assert.equal(fault.durable.load(failedRunId), null);
    const lease = fault.durable.acquireRunLease(failedRunId);
    assert.ok(lease, "failed checkpoint admission must release its lease");
    fault.durable.releaseRunLease(lease);
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent foreground admission failure never starts the runner and leaves no run, resource, or lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-persistent-foreground-admission-"));
  const fault = saveFaultPersistence(root, () => true);
  let runnerCalls = 0;
  const runner = makeRunner(() => {
    runnerCalls++;
    return "unexpected";
  });
  const manager = new WorkflowManager({ cwd: root, agent: runner, persistence: fault.persistence });
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "persistent-foreground-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await client.listTools();
    const result = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "failed-admission", description: "must not execute" };',
          'return await agent("must not start");',
        ].join("\n"),
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(resourceLinks(result).length, 0);
    assert.equal(runnerCalls, 0, "durable admission must be established before the runner starts");

    const runId = fault.acquiredRunIds[0];
    assert.ok(runId);
    const uri = `workflow://runs/${runId}/script`;
    assert.equal(manager.getRun(runId), undefined);
    assert.equal(fault.durable.load(runId), null);
    assert.deepEqual(
      (await client.listResources()).resources.filter((resource) => resource.uri.startsWith("workflow://")),
      [],
      "no run resources are listed (the static ui:// panel resource is always present)",
    );
    await assert.rejects(client.readResource({ uri }), /resource not found/i);

    const lease = fault.durable.acquireRunLease(runId);
    assert.ok(lease, "the failed foreground admission must release its run lease");
    fault.durable.releaseRunLease(lease);
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent admission save failure returns no URI and cleans the run, resource, and lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-persistent-admission-"));
  const fault = saveFaultPersistence(root, () => true);
  const runner = okRunner();
  const manager = new WorkflowManager({ cwd: root, agent: runner, persistence: fault.persistence });
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "persistent-admission-client", version: "0.0.0" }, { capabilities: {} });
  let listChanged = 0;
  client.setNotificationHandler('notifications/resources/list_changed', () => {
    listChanged++;
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await client.listTools();
    const result = await client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, background: true },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(resourceLinks(result).length, 0);
    assert.match(
      String((result.content as Array<{ text?: string }>)[0]?.text),
      /persisted run record was unreadable; the run was not acknowledged/i,
    );

    const runId = fault.acquiredRunIds[0];
    assert.ok(runId);
    const uri = `workflow://runs/${runId}/script`;
    assert.equal(manager.getRun(runId), undefined);
    assert.equal(fault.durable.load(runId), null);
    assert.deepEqual(
      (await client.listResources()).resources.filter((resource) => resource.uri.startsWith("workflow://")),
      [],
      "no run resources are listed (the static ui:// panel resource is always present)",
    );
    await assert.rejects(client.readResource({ uri }), /resource not found/i);
    assert.equal(listChanged, 0);

    const lease = fault.durable.acquireRunLease(runId);
    assert.ok(lease, "the failed admission must release its run lease");
    fault.durable.releaseRunLease(lease);
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("path and inline delivery share journal identity and changed path content resumes at the first changed call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentprism-mcp-path-resume-"));
  const scriptPath = join(dir, "resume.workflow.js");
  writeFileSync(scriptPath, TWO_AGENT_SCRIPT, "utf8");
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner);
  try {
    const first = await client.callTool({ name: "workflow", arguments: { scriptPath } });
    const firstRunId = String(structured(first)?.runId);
    assert.equal(calls(), 2);

    const inlineResume = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, resumeFromRunId: firstRunId },
    });
    const secondRunId = String(structured(inlineResume)?.runId);
    assert.equal(calls(), 2, "identical inline content replays a path-delivered journal byte-for-byte");

    const changed = TWO_AGENT_SCRIPT.replace('agent("beta",', 'agent("beta changed",');
    writeFileSync(scriptPath, changed, "utf8");
    const changedResume = await client.callTool({
      name: "workflow",
      arguments: { scriptPath, resumeFromRunId: secondRunId },
    });
    assert.equal(changedResume.isError, false, JSON.stringify(structured(changedResume)));
    assert.equal(structured(changedResume)?.status, "completed", JSON.stringify(structured(changedResume)));
    const thirdRunId = String(structured(changedResume)?.runId);
    assert.equal(calls(), 3, "the unchanged first call replays and the changed second call runs live");
    assert.equal(
      resourceText(await client.readResource({ uri: `workflow://runs/${thirdRunId}/script` })),
      changed,
    );

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: thirdRunId },
    });
    assert.deepEqual(
      (structured(inspected)?.lineage as Array<Record<string, unknown>>).map((entry) => ({
        runId: entry.runId,
        available: entry.available,
      })),
      [firstRunId, secondRunId, thirdRunId].map((runId) => ({ runId, available: true })),
    );
    assert.deepEqual(
      resourceLinks(inspected).map((link) => link.uri),
      [
        `workflow://runs/${thirdRunId}/result`,
        ...[firstRunId, secondRunId, thirdRunId].map((runId) => `workflow://runs/${runId}/script`),
        `workflow://runs/${thirdRunId}/events`,
      ],
    );
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent inline and path results report source without persisting it into status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentprism-mcp-concurrent-source-"));
  const scriptPath = join(dir, "same.workflow.js");
  writeFileSync(scriptPath, TWO_AGENT_SCRIPT, "utf8");
  const pending: Array<() => void> = [];
  const runner = makeRunner(
    () =>
      new Promise<string>((resolve) => {
        pending.push(() => resolve("ok"));
      }),
  );
  const { client, dispose } = await connect(runner);
  try {
    const inlinePromise = client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT },
    });
    const pathPromise = client.callTool({
      name: "workflow",
      arguments: { scriptPath },
    });
    await waitUntil(() => pending.length === 2, "both identical admissions should execute concurrently");
    pending.splice(0).forEach((resolve) => resolve());
    await waitUntil(() => pending.length === 2, "both second calls should execute concurrently");
    pending.splice(0).forEach((resolve) => resolve());

    const [inlineResult, pathResult] = await Promise.all([inlinePromise, pathPromise]);
    assert.equal(structured(inlineResult)?.scriptSource, "inline");
    assert.equal(structured(pathResult)?.scriptSource, "path");
    const inlineRunId = String(structured(inlineResult)?.runId);
    const pathRunId = String(structured(pathResult)?.runId);
    const inlineAwait = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: inlineRunId, waitMs: 0 },
    });
    const pathAwait = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: pathRunId, waitMs: 0 },
    });
    assert.equal((structured(inlineAwait)?.outcome as Record<string, unknown>).scriptSource, undefined);
    assert.equal((structured(pathAwait)?.outcome as Record<string, unknown>).scriptSource, undefined);
  } finally {
    pending.splice(0).forEach((resolve) => resolve());
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resource composition neither patches persistence nor retains scripts or args", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-resource-memory-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const persistence = manager.getPersistence();
  const originalSave = persistence.save;
  const originalDelete = persistence.delete;
  const mcp = new McpServer({ name: "resource-memory", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, manager);
  try {
    assert.equal(persistence.save, originalSave);
    assert.equal(persistence.delete, originalDelete);
    const fields = Object.keys(resources as unknown as Record<string, unknown>);
    assert.equal(fields.includes("metadataByRunId"), false);
    assert.equal(fields.includes("pendingAdmissions"), false);

    const run = await manager.runSync(NO_AGENT_SCRIPT, { secret: "must stay in persistence only" });
    resources.notifyRunAdmitted(run.runId);
    assert.equal(Object.hasOwn(manager.getPersistence().load(run.runId) ?? {}, "scriptSource"), false);
  } finally {
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource listing/completion are bounded to 50 newest; subscribe, deletion, and notifications are honest", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-resource-store-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const mcp = new McpServer({ name: "resource-test", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "resource-client", version: "0.0.0" }, { capabilities: {} });
  let listChanged = 0;
  let updated = 0;
  client.setNotificationHandler('notifications/resources/list_changed', () => {
    listChanged++;
  });
  client.setNotificationHandler('notifications/resources/updated', () => {
    updated++;
  });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

  const runIds: string[] = [];
  try {
    for (let index = 0; index < 55; index++) {
      const script = NO_AGENT_SCRIPT.replace("no-agent", `resource-${index}`);
      const run = await manager.runSync(script);
      runIds.push(run.runId);
      const state = manager.getPersistence().load(run.runId);
      assert.ok(state);
      state.startedAt = new Date(Date.UTC(2100, 0, index + 1)).toISOString();
      manager.getPersistence().save(state);
      resources.notifyRunAdmitted(run.runId);
    }
    await waitUntil(() => listChanged >= 55, "every admission should emit resources/list_changed");

    const listed = await client.listResources();
    assert.equal(listed.resources.length, 150);
    const expectedNewest = runIds.slice(5).reverse();
    const listedScripts = listed.resources.filter((resource) => resource.uri.endsWith("/script"));
    const listedResults = listed.resources.filter((resource) => resource.uri.endsWith("/result"));
    const listedEvents = listed.resources.filter((resource) => resource.uri.endsWith("/events"));
    assert.deepEqual(
      listedScripts.map((resource) => resource.uri),
      expectedNewest.map((runId) => `workflow://runs/${runId}/script`),
    );
    assert.deepEqual(
      listedResults.map((resource) => resource.uri),
      expectedNewest.map((runId) => `workflow://runs/${runId}/result`),
    );
    assert.deepEqual(
      listedEvents.map((resource) => resource.uri),
      expectedNewest.map((runId) => `workflow://runs/${runId}/events`),
    );
    assert.match(String(listedScripts[0]?.description), /^workflow script · completed · started /);
    assert.match(String(listedResults[0]?.description), /^exact workflow result · completed /);
    assert.equal(
      resourceText(await client.readResource({ uri: `workflow://runs/${runIds[0]}/script` })),
      NO_AGENT_SCRIPT.replace("no-agent", "resource-0"),
      "direct script reads remain available outside the bounded discovery list",
    );
    assert.equal(
      resourceText(await client.readResource({ uri: `workflow://runs/${runIds[0]}/result` })),
      "42",
      "direct result reads remain available outside the bounded discovery list",
    );

    const newest = expectedNewest[0];
    const completed = await client.complete({
      ref: { type: "ref/resource", uri: "workflow://runs/{runId}/script" },
      argument: { name: "runId", value: newest.slice(0, 8) },
    });
    assert.deepEqual(completed.completion.values, [newest]);
    const completedResult = await client.complete({
      ref: { type: "ref/resource", uri: "workflow://runs/{runId}/result" },
      argument: { name: "runId", value: newest.slice(0, 8) },
    });
    assert.deepEqual(completedResult.completion.values, [newest]);

    const uri = `workflow://runs/${newest}/script`;
    const resultUri = `workflow://runs/${newest}/result`;
    await client.subscribeResource({ uri });
    await client.unsubscribeResource({ uri });
    await client.subscribeResource({ uri: resultUri });
    await client.unsubscribeResource({ uri: resultUri });
    await assert.rejects(
      client.subscribeResource({ uri: "workflow://runs/no-such/script" }),
      /resource not found/i,
    );
    await assert.rejects(
      client.subscribeResource({ uri: "workflow://runs/no-such/result" }),
      /resource not found/i,
    );
    await assert.rejects(
      client.unsubscribeResource({ uri: "workflow://runs/no-such/script" }),
      /resource not found/i,
    );
    await assert.rejects(
      client.unsubscribeResource({ uri: "workflow://runs/no-such/not-script" }),
      /resource not found/i,
    );
    await assert.rejects(
      client.readResource({ uri: "workflow://runs/no-such/script" }),
      /resource not found/i,
    );
    await assert.rejects(
      client.readResource({ uri: "not a uri" }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, -32602);
        assert.match(String((error as Error).message), /resource not found/i);
        return true;
      },
    );

    const beforeDeleteNotifications = listChanged;
    await client.subscribeResource({ uri });
    await client.subscribeResource({ uri: resultUri });
    assert.equal(resources.deleteRun(newest), true);
    await waitUntil(
      () => listChanged === beforeDeleteNotifications + 1,
      "deletion should emit exactly one resources/list_changed notification",
    );
    await assert.rejects(client.readResource({ uri }), /resource not found/i);
    await assert.rejects(client.readResource({ uri: resultUri }), /No workflow run found|resource not found/i);
    assert.deepEqual(await client.unsubscribeResource({ uri }), {});
    assert.deepEqual(await client.unsubscribeResource({ uri: resultUri }), {});

    const racedUri = `workflow://runs/${runIds[0]}/script`;
    await client.subscribeResource({ uri: racedUri });
    assert.equal(manager.deleteRun(runIds[0]!), true);
    assert.deepEqual(await client.unsubscribeResource({ uri: racedUri }), {});
    assert.equal(updated, 0, "immutable script resources never emit resources/updated");
  } finally {
    await client.close();
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual manager-owned resume lineage retains its root after the middle record is deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-lineage-store-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  try {
    const first = await manager.runSync(TWO_AGENT_SCRIPT);
    const second = await manager.runSync(TWO_AGENT_SCRIPT, undefined, { resumeFromRunId: first.runId });
    const third = await manager.runSync(TWO_AGENT_SCRIPT, undefined, { resumeFromRunId: second.runId });
    const ids = [first.runId, second.runId, third.runId];
    assert.equal(second.resumeReport?.sourceRunId, first.runId);
    assert.equal(third.resumeReport?.sourceRunId, second.runId);
    assert.equal(manager.getPersistence().load(second.runId)?.resumeSourceRunId, first.runId);
    assert.equal(manager.getPersistence().load(third.runId)?.resumeSourceRunId, second.runId);
    assert.equal(manager.deleteRun(second.runId), true);
    assert.equal(manager.getPersistence().load(second.runId), null);

    const tombstone = manager.getPersistence().loadLineageTombstone?.(second.runId);
    assert.equal(tombstone?.sourceRunId, first.runId);
    assert.deepEqual(Object.keys(tombstone ?? {}).sort(), ["deletedAt", "runId", "sourceRunId"]);

    const coldManager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
    const mcp = new McpServer({ name: "lineage-test", version: "0.0.0" }, { capabilities: {} });
    mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
    const resources = new WorkflowScriptResources(mcp, coldManager);
    try {
      assert.deepEqual(
        resources.lineage(third.runId),
        ids.map((runId, index) => ({
          runId,
          uri: `workflow://runs/${runId}/script`,
          available: index !== 1,
        })),
      );
      assert.deepEqual(
        resources.links(resources.lineage(third.runId)).map((link) => link.uri),
        [first.runId, third.runId].map((runId) => `workflow://runs/${runId}/script`),
      );
    } finally {
      await mcp.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createWorkflowServer observes injected-manager deletion exactly once and keeps unsubscribe idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-manager-delete-"));
  const runner = okRunner();
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: runner });
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "manager-delete-client", version: "0.0.0" }, { capabilities: {} });
  let listChanged = 0;
  client.setNotificationHandler('notifications/resources/list_changed', () => {
    listChanged++;
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const admitted = await client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT },
    });
    const runId = String(structured(admitted)?.runId);
    const uri = `workflow://runs/${runId}/script`;
    await waitUntil(() => listChanged >= 2, "admission and completed-result availability should notify the resource list");
    await client.subscribeResource({ uri });

    const beforeDeleteNotifications = listChanged;
    assert.equal(manager.deleteRun(runId), true);
    await waitUntil(
      () => listChanged === beforeDeleteNotifications + 1,
      "manager deletion should emit one resources/list_changed notification",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(listChanged, beforeDeleteNotifications + 1, "manager deletion must not emit duplicate list changes");
    await assert.rejects(client.readResource({ uri }), /resource not found/i);
    assert.deepEqual(await client.unsubscribeResource({ uri }), {});
    assert.deepEqual(await client.unsubscribeResource({ uri }), {});
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lineage normalizes engine ancestry pointer cycles and missing ancestors", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-lineage-normalization-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const first = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "cycle-first"));
  const second = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "cycle-second"));
  const flattened = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "flattened"));
  const persistence = manager.getPersistence();
  const firstState = persistence.load(first.runId);
  const secondState = persistence.load(second.runId);
  const flattenedState = persistence.load(flattened.runId);
  assert.ok(firstState && secondState && flattenedState);
  persistence.save({
    ...firstState,
    resumeSourceRunId: second.runId,
  });
  persistence.save({
    ...secondState,
    resumeSourceRunId: first.runId,
  });
  const missingRunId = "missing-ancestor";
  persistence.save({
    ...flattenedState,
    resumeSourceRunId: missingRunId,
  });

  const mcp = new McpServer({ name: "lineage-normalization", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, manager);
  try {
    assert.deepEqual(
      resources.lineage(first.runId).map((entry) => entry.runId),
      [second.runId, first.runId],
      "a pointer cycle terminates with the requested run exactly once",
    );
    assert.deepEqual(resources.lineage(flattened.runId), [
      { runId: missingRunId, uri: `workflow://runs/${missingRunId}/script`, available: false },
      {
        runId: flattened.runId,
        uri: `workflow://runs/${flattened.runId}/script`,
        available: true,
      },
    ]);
  } finally {
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume reports, matcher seeds, and replay provenance never override engine ancestry", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-lineage-precedence-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const authoritativeParent = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "authoritative-parent"));
  const seedParent = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "seed-parent"));
  const reportParent = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "report-parent"));
  const provenanceParent = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "provenance-parent"));
  const child = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "lineage-child"));
  const persistence = manager.getPersistence();
  const childState = persistence.load(child.runId);
  assert.ok(childState);
  persistence.save({
    ...childState,
    resumeSourceRunId: authoritativeParent.runId,
    resumeSeed: {
      format: "identity-v1",
      sourceRunId: seedParent.runId,
      candidates: [],
      checkpointInjections: [{
        sourceRunId: provenanceParent.runId,
        recordedIndex: 0,
        hash: "provenance-hash",
        path: "checkpoint:0",
        inputsHash: "provenance-inputs",
        decision: true,
      }],
    },
    resumeReport: {
      strategy: "identity-v1",
      sourceRunId: reportParent.runId,
      requestedPolicy: "auto",
      replayed: 0,
      live: 0,
      failed: 0,
      calls: [],
    },
  });

  const mcp = new McpServer({ name: "lineage-precedence", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, manager);
  try {
    assert.deepEqual(
      resources.lineage(child.runId).map((entry) => entry.runId),
      [authoritativeParent.runId, child.runId],
    );
    assert.equal(manager.deleteRun(child.runId), true);
    assert.equal(persistence.loadLineageTombstone?.(child.runId)?.sourceRunId, authoritativeParent.runId);
    assert.deepEqual(
      resources.lineage(child.runId).map((entry) => entry.runId),
      [authoritativeParent.runId, child.runId],
    );
  } finally {
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lineage walks every engine ancestry pointer oldest to newest", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-lineage-mixed-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const runs = await Promise.all(
    ["root", "cached", "pointer-one", "pointer-two"].map((name) =>
      manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", `mixed-${name}`)),
    ),
  );
  const ids = runs.map((run) => run.runId);
  const persistence = manager.getPersistence();
  const states = ids.map((runId) => persistence.load(runId));
  assert.ok(states.every((state) => state !== null));
  persistence.save({
    ...states[1]!,
    resumeSourceRunId: ids[0]!,
  });
  persistence.save({
    ...states[2]!,
    resumeSourceRunId: ids[1]!,
  });
  persistence.save({
    ...states[3]!,
    resumeSourceRunId: ids[2]!,
  });

  const mcp = new McpServer({ name: "lineage-mixed", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, manager);
  try {
    assert.deepEqual(
      resources.lineage(ids[3]!).map((entry) => entry.runId),
      ids,
    );
  } finally {
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("public status lineage compaction retains newest diagnostics and recomputes every counter", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-lineage-compaction-"));
  const runner = okRunner();
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: runner });
  const run = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "lineage-compaction"));
  const persistence = manager.getPersistence();
  const state = persistence.load(run.runId);
  assert.ok(state);

  const phases = Array.from({ length: 50 }, (_, index) =>
    `phase-${String(index).padStart(2, "0")} ${"phase detail ".repeat(70)}`,
  );
  const logs = Array.from({ length: 50 }, (_, index) =>
    `log-${String(index).padStart(2, "0")} token=sk-1234567890abcdef ${"l".repeat(700)}`,
  );
  const journal = Array.from({ length: 50 }, (_, index) => ({
    index,
    hash: `hash-${index}`,
    result: { token: `secret-${index}`, payload: "r".repeat(1_000) },
    kind: "agent" as const,
    call: {
      kind: "agent" as const,
      label: `call-${String(index).padStart(2, "0")}`,
      phase: `phase-${String(index).padStart(2, "0")}`,
    },
  }));
  const ancestors = Array.from(
    { length: 100 },
    (_, index) => `ancestor${String(index).padStart(3, "0")}-revision${"x".repeat(20)}`,
  );
  for (let index = 0; index < ancestors.length; index++) {
    persistence.save({
      ...state,
      runId: ancestors[index]!,
      workflowName: `lineage-ancestor-${index}`,
      ...(index === 0
        ? { resumeSourceRunId: undefined }
        : {
            resumeSourceRunId: ancestors[index - 1]!,
          }),
    });
  }
  persistence.save({
    ...state,
    phases,
    logs,
    journal,
    resumeSourceRunId: ancestors.at(-1)!,
  });

  const inspectionManager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: runner });
  assert.equal(inspectionManager.getPersistence().load(run.runId)?.phases?.[0], phases[0]);
  const server = createWorkflowServer(runner, { manager: inspectionManager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lineage-compaction-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: run.runId, lastN: 50, logLines: 50 },
    });
    const payload = structured(inspected)!;
    const returnedPhases = payload.phases as string[];
    const returnedLogs = (payload.logTail as Record<string, unknown>).lines as string[];
    const returnedCalls = payload.calls as Array<Record<string, unknown>>;
    const truncation = payload.truncation as {
      maxStructuredBytes: number;
      byteCapApplied: boolean;
      phases: { total: number; returned: number; shortened: number };
      logs: { total: number; returned: number; shortened: number; redacted: number };
      calls: { total: number; matched: number; returned: number; shortenedResults: number; redactedResults: number };
    };
    const logTail = payload.logTail as {
      totalLines: number;
      omittedLines: number;
      truncatedLines: number;
      redactedLines: number;
    };

    assert.equal(truncation.maxStructuredBytes, 24_576);
    const { outcome: _outcome, ...boundedObservation } = payload;
    assert.ok(Buffer.byteLength(JSON.stringify(boundedObservation), "utf8") <= truncation.maxStructuredBytes);
    assert.equal(truncation.byteCapApplied, true);
    assert.ok(
      returnedPhases.length > 0 && returnedPhases.length < phases.length,
      `expected a retained phase suffix, received ${returnedPhases.length} phases ` +
        `(phaseBytes=${Buffer.byteLength(returnedPhases[0] ?? "", "utf8")}, ` +
        `logs=${returnedLogs.length}, calls=${returnedCalls.length}, lineage=${(payload.lineage as unknown[]).length})`,
    );
    assert.match(returnedPhases[0]!, /^phase-(?!00)/);
    assert.match(returnedPhases.at(-1)!, /^phase-49 /);
    assert.deepEqual(
      returnedPhases.map((phase) => Number(/^phase-(\d+)/.exec(phase)?.[1])),
      Array.from(
        { length: returnedPhases.length },
        (_, offset) => phases.length - returnedPhases.length + offset,
      ),
      "second-stage compaction must drop oldest phases and retain one newest suffix",
    );

    assert.deepEqual(truncation.phases, {
      total: phases.length,
      returned: returnedPhases.length,
      shortened: returnedPhases.length,
    });
    assert.equal(truncation.logs.total, logs.length);
    assert.equal(truncation.logs.returned, returnedLogs.length);
    assert.equal(truncation.logs.shortened, returnedLogs.length);
    assert.equal(truncation.logs.redacted, returnedLogs.length);
    assert.equal(logTail.totalLines, logs.length);
    assert.equal(logTail.omittedLines, logs.length - returnedLogs.length);
    assert.equal(logTail.truncatedLines, returnedLogs.length);
    assert.equal(logTail.redactedLines, returnedLogs.length);
    assert.equal(truncation.calls.total, journal.length);
    assert.equal(truncation.calls.matched, journal.length);
    assert.equal(truncation.calls.returned, returnedCalls.length);
    assert.equal(
      truncation.calls.shortenedResults,
      returnedCalls.filter((call) => call.resultTruncated === true).length,
    );
    assert.equal(
      truncation.calls.redactedResults,
      returnedCalls.filter((call) => call.resultRedacted === true).length,
    );
    if (returnedLogs.length > 0) assert.match(returnedLogs.at(-1)!, /^log-49 /);
    if (returnedCalls.length > 0) assert.equal(returnedCalls.at(-1)?.index, 49);
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 300-hop public resume lineage remains complete and reports a truthful structured limit", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const runIds: string[] = [];
    for (let index = 0; index < 300; index++) {
      const result = await client.callTool({
        name: "workflow",
        arguments: {
          script: NO_AGENT_SCRIPT,
          ...(runIds.length === 0 ? {} : { resumeFromRunId: runIds.at(-1) }),
        },
      });
      assert.equal(result.isError, false);
      runIds.push(String(structured(result)?.runId));
    }

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: runIds.at(-1) },
    });
    const payload = structured(inspected);
    const lineage = payload?.lineage as Array<Record<string, unknown>>;
    const truncation = payload?.truncation as Record<string, unknown>;
    const { outcome: _outcome, ...boundedObservation } = payload ?? {};
    const bytes = Buffer.byteLength(JSON.stringify(boundedObservation), "utf8");
    assert.deepEqual(lineage.map((entry) => entry.runId), runIds);
    assert.equal(new Set(lineage.map((entry) => entry.runId)).size, 300);
    assert.deepEqual(
      resourceLinks(inspected).map((link) => link.uri),
      [
        `workflow://runs/${runIds.at(-1)}/result`,
        ...runIds.map((runId) => `workflow://runs/${runId}/script`),
        `workflow://runs/${runIds.at(-1)}/events`,
      ],
    );
    assert.ok(Number(truncation.maxStructuredBytes) > 24_576);
    assert.ok(bytes <= Number(truncation.maxStructuredBytes));
  } finally {
    await dispose();
  }
});

test("a fresh MCP session can retrieve an inline checkpoint script resource and resume with it", async () => {
  const script = [
    'export const meta = { name: "resource-checkpoint", description: "cross-session recovery" };',
    'const decision = await checkpoint("ship?", { headless: "pause" });',
    "return { decision };",
  ].join("\n");
  const first = await connect(okRunner());
  let runId: string;
  let retrieved: string;
  try {
    const accepted = await first.client.callTool({
      name: "workflow",
      arguments: { script, background: true },
    });
    runId = String(structured(accepted)?.runId);
    const paused = await first.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 1_000 },
    });
    assert.equal(structured(paused)?.status, "paused");
    retrieved = resourceText(
      await first.client.readResource({ uri: `workflow://runs/${runId}/script` }),
    );
    assert.equal(retrieved, script);
  } finally {
    await first.dispose();
  }

  const second = await connect(okRunner());
  try {
    const resumed = await second.client.callTool({
      name: "workflow",
      arguments: {
        script: retrieved!,
        resumeFromRunId: runId!,
        checkpointReplies: { 0: true },
      },
    });
    assert.equal(structured(resumed)?.status, "completed");
    assert.equal(JSON.stringify(structured(resumed)?.result), JSON.stringify({ decision: true }));
    assert.equal(structured(resumed)?.scriptSource, "inline");
    const resumedRunId = String(structured(resumed)?.runId);
    const coldAwait = await second.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: resumedRunId, waitMs: 0 },
    });
    assert.equal((structured(coldAwait)?.outcome as Record<string, unknown>).scriptSource, undefined);
    assert.equal(
      (structured(coldAwait)?.outcome as Record<string, unknown>).scriptUri,
      `workflow://runs/${resumedRunId}/script`,
    );
  } finally {
    await second.dispose();
  }
});

test("cold status does not infer an admission-only script source", async () => {
  const first = await connect(okRunner());
  let runId: string;
  try {
    const result = await first.client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT },
    });
    runId = String(structured(result)?.runId);
  } finally {
    await first.dispose();
  }

  const recordPath = persistedRunFile(runId!);
  assert.ok(recordPath);
  const legacy = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  delete legacy.scriptSource;
  delete legacy.resumeSeed;
  writeFileSync(recordPath, JSON.stringify(legacy), "utf8");

  const second = await connect(okRunner(), { listTools: true });
  try {
    const awaited = await second.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: runId!, waitMs: 0 },
    });
    assert.equal(awaited.isError, false);
    assert.equal((structured(awaited)?.outcome as Record<string, unknown>).scriptSource, undefined);
  } finally {
    await second.dispose();
  }
});

test("events resources push append hints and page exact durable catch-up", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-events-resource-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const mcp = new McpServer({ name: "events-test", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "events-client", version: "0.0.0" }, { capabilities: {} });
  let updated = 0;
  client.setNotificationHandler('notifications/resources/updated', () => { updated += 1; });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const run = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "events-resource"));
    resources.notifyRunAdmitted(run.runId);
    const uri = `workflow://runs/${run.runId}/events`;
    const initial = eventDocument(await client.readResource({ uri }));
    assert.ok(initial.streamId);
    assert.equal(initial.hasMore, false);
    await client.subscribeResource({ uri });

    const persistence = manager.getPersistence();
    const state = persistence.load(run.runId);
    assert.ok(state?.eventSeq !== undefined);
    const record = persistence.appendEvent(run.runId, {
      seq: state.eventSeq + 1,
      timestamp: new Date().toISOString(),
      event: { type: "log", runId: run.runId, scope: run.runId, message: "external append" },
    });
    state.eventSeq = record.seq;
    persistence.save(state);
    await waitUntil(() => updated >= 1, "subscribed event append should push resources/updated");

    const page = eventDocument(await client.readResource({
      uri: `${uri}?limit=100&streamId=${initial.streamId}&after=${initial.cursor}`,
    }));
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.event.message, "external append");
    assert.equal(page.cursor, record.seq);
    assert.equal(page.hasMore, false);
    await client.unsubscribeResource({ uri });

    const updatesBeforeUnsubscribedAppend = updated;
    const afterUnsubscribe = persistence.appendEvent(run.runId, {
      seq: record.seq + 1,
      timestamp: new Date().toISOString(),
      event: { type: "log", runId: run.runId, scope: run.runId, message: "after unsubscribe" },
    });
    state.eventSeq = afterUnsubscribe.seq;
    persistence.save(state);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(updated, updatesBeforeUnsubscribedAppend, "unsubscribe must close the event watcher");
  } finally {
    await client.close();
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an events read reconciles an externally-dead run so finalized flips for the panel", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-events-reconcile-"));
  // managerA produces the run and then "exits"; a fresh cold managerB (never owned the run) serves
  // the panel's reads, exactly as a restarted/other server process would after a daemon died.
  const managerA = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const run = await managerA.runSync(NO_AGENT_SCRIPT.replace("no-agent", "orphaned-run"));
  const managerB = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const persistence = managerB.getPersistence();
  const completed = persistence.load(run.runId);
  assert.ok(completed);
  assert.ok(completed.eventStreamId && completed.eventSeq !== undefined);
  assert.equal(completed.status, "completed");
  assert.equal(managerB.getRun(run.runId), undefined);

  const mcp = new McpServer({ name: "events-reconcile", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, managerB);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "events-reconcile-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

  try {
    // A dead daemon leaves the run persisted as "running" with a frozen journal, and nothing live
    // in this process owns it. Without reconciliation on the read path buildEventsDocument reports
    // finalized:false forever and the panel polls it without end.
    persistence.save({ ...completed, status: "running" });
    assert.equal(persistence.load(run.runId)?.status, "running");

    // The shared page seam (used by both the workflow-events tool and the resource read) reconciles
    // the orphan, so `finalized` flips and the panel can stop polling.
    const page = resources.readEventsPage({
      runId: run.runId,
      after: 0,
      streamId: completed.eventStreamId,
    });
    assert.equal(page.finalized, true, "orphaned run is finalized once the read reconciles it");
    assert.notEqual(page.status, "running");
    assert.equal(persistence.load(run.runId)?.status, "paused");
    assert.equal(persistence.load(run.runId)?.pauseReason, "interrupted");

    // Re-orphan, then read through the exact resource path the panel uses (the query form) to prove
    // the read path itself reconciles — not merely the direct readEventsPage call above.
    persistence.save({ ...persistence.load(run.runId)!, status: "running" });
    const uri = `workflow://runs/${run.runId}/events?after=0&limit=500&streamId=${completed.eventStreamId}`;
    const doc = JSON.parse(resourceText(await client.readResource({ uri }))) as {
      status: string;
      finalized: boolean;
    };
    assert.equal(doc.finalized, true);
    assert.notEqual(doc.status, "running");
    assert.equal(persistence.load(run.runId)?.status, "paused");
  } finally {
    await client.close();
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a slow events subscriber holds one promise plus one dirty bit while durable pages keep every record", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-events-backpressure-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const mcp = new McpServer({ name: "events-backpressure", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, manager);
  let notificationCalls = 0;
  let releaseFirst!: () => void;
  const sender = mcp.server as unknown as { sendResourceUpdated(params: { uri: string }): Promise<void> };
  sender.sendResourceUpdated = () => {
    notificationCalls += 1;
    if (notificationCalls !== 1) return Promise.resolve();
    return new Promise<void>((resolve) => { releaseFirst = resolve; });
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "slow-events-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const run = await manager.runSync(NO_AGENT_SCRIPT.replace("no-agent", "events-backpressure"));
    const uri = `workflow://runs/${run.runId}/events`;
    const initial = eventDocument(await client.readResource({ uri }));
    await client.subscribeResource({ uri });
    const persistence = manager.getPersistence();
    const state = persistence.load(run.runId);
    assert.ok(state?.eventSeq !== undefined);
    for (let index = 0; index < 1_005; index++) {
      const record = persistence.appendEvent(run.runId, {
        seq: state.eventSeq + 1,
        timestamp: new Date().toISOString(),
        event: { type: "log", runId: run.runId, scope: run.runId, message: `burst-${index}` },
      });
      state.eventSeq = record.seq;
    }
    persistence.save(state);
    const internals = resources as unknown as {
      eventSubscriptions: Map<string, { dirty: boolean; inFlight: boolean }>;
    };
    await waitUntil(() => notificationCalls === 1 && internals.eventSubscriptions.get(uri)?.dirty === true,
      "the slow subscriber should coalesce its backlog into one dirty bit");
    assert.equal(internals.eventSubscriptions.get(uri)?.inFlight, true);
    releaseFirst();
    await waitUntil(() => notificationCalls >= 2, "one coalesced follow-up hint should be sent");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notificationCalls, 2);

    const first = eventDocument(await client.readResource({
      uri: `${uri}?after=${initial.cursor}&limit=1000&streamId=${initial.streamId}`,
    }));
    const second = eventDocument(await client.readResource({
      uri: `${uri}?after=${first.cursor}&limit=1000&streamId=${initial.streamId}`,
    }));
    const recovered = [...first.events, ...second.events];
    assert.equal(recovered.length, 1_005);
    assert.deepEqual(recovered.map((record) => record.seq),
      Array.from({ length: 1_005 }, (_, index) => initial.cursor + index + 1));
    await client.unsubscribeResource({ uri });
  } finally {
    await client.close();
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});
