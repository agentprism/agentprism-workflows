import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function saveFaultPersistence(
  root: string,
  failSave: (attempt: number) => boolean,
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
      if (failSave(saveAttempts)) throw new Error(`injected save failure ${saveAttempts}`);
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
    assert.deepEqual(resourceLinks(result).map((link) => link.uri), [uri]);

    writeFileSync(scriptPath, `${NO_AGENT_SCRIPT}\n// later edit`, "utf8");
    assert.equal(resourceText(await client.readResource({ uri })), NO_AGENT_SCRIPT);
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the admission guard preserves authored args while persistence retains the original script and args", async () => {
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

test("a transient initial save failure rejects admission before execution or a later cleanup save", async () => {
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
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
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
          'log("authored body executed");',
          'return await agent("must not start");',
        ].join("\n"),
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(resourceLinks(result).length, 0);
    assert.match(
      String((result.content as Array<{ text?: string }>)[0]?.text),
      /script resource could not be persisted; no run was admitted/i,
    );

    const runId = fault.acquiredRunIds[0];
    assert.ok(runId);
    const uri = `workflow://runs/${runId}/script`;
    assert.ok(fault.attempts() > 1);
    assert.equal(runnerCalls, 0, "a later successful cleanup save must not release execution");
    assert.equal(manager.getRun(runId), undefined);
    assert.equal(fault.durable.load(runId), null);
    await assert.rejects(client.readResource({ uri }), /resource not found/i);
    assert.equal(listChanged, 0, "cleanup saves for a rejected admission are not resource admissions");
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
  let workflowLogs = 0;
  manager.on("log", () => {
    workflowLogs++;
  });
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
          'log("authored body executed");',
          'return await agent("must not start");',
        ].join("\n"),
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(resourceLinks(result).length, 0);
    assert.equal(runnerCalls, 0, "durable admission must be established before the runner starts");
    assert.equal(workflowLogs, 0, "a failed durable admission must not execute authored statements");

    const runId = fault.acquiredRunIds[0];
    assert.ok(runId);
    const uri = `workflow://runs/${runId}/script`;
    assert.equal(manager.getRun(runId), undefined);
    assert.equal(fault.durable.load(runId), null);
    assert.deepEqual((await client.listResources()).resources, []);
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
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
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
      /script resource could not be persisted; no run was admitted/i,
    );

    const runId = fault.acquiredRunIds[0];
    assert.ok(runId);
    const uri = `workflow://runs/${runId}/script`;
    assert.equal(manager.getRun(runId), undefined);
    assert.equal(fault.durable.load(runId), null);
    assert.deepEqual((await client.listResources()).resources, []);
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

    const changed = TWO_AGENT_SCRIPT.replace('agent("beta")', 'agent("beta changed")');
    writeFileSync(scriptPath, changed, "utf8");
    const changedResume = await client.callTool({
      name: "workflow",
      arguments: { scriptPath, resumeFromRunId: secondRunId },
    });
    const thirdRunId = String(structured(changedResume)?.runId);
    assert.equal(calls(), 3, "the unchanged first call replays and the changed second call runs live");
    assert.equal(
      resourceText(await client.readResource({ uri: `workflow://runs/${thirdRunId}/script` })),
      changed,
    );

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: thirdRunId },
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
      [firstRunId, secondRunId, thirdRunId].map((runId) => `workflow://runs/${runId}/script`),
    );
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent identical inline and path admissions retain their own persisted script source", async () => {
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
    const inlineRunId = String(structured(inlineResult)?.runId);
    const pathRunId = String(structured(pathResult)?.runId);
    const inlineAwait = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: inlineRunId, waitMs: 0 },
    });
    const pathAwait = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: pathRunId, waitMs: 0 },
    });
    assert.equal((structured(inlineAwait)?.outcome as Record<string, unknown>).scriptSource, "inline");
    assert.equal((structured(pathAwait)?.outcome as Record<string, unknown>).scriptSource, "path");
  } finally {
    pending.splice(0).forEach((resolve) => resolve());
    await dispose();
    rmSync(dir, { recursive: true, force: true });
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
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    listChanged++;
  });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
    updated++;
  });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

  const runIds: string[] = [];
  try {
    for (let index = 0; index < 55; index++) {
      const script = NO_AGENT_SCRIPT.replace("no-agent", `resource-${index}`);
      const admission = resources.beginAdmission({ script, scriptSource: "inline" });
      try {
        const run = await resources.runAdmission(admission, () => manager.runSync(script));
        runIds.push(run.runId);
        const state = manager.getPersistence().load(run.runId);
        assert.ok(state);
        state.startedAt = new Date(Date.UTC(2100, 0, index + 1)).toISOString();
        manager.getPersistence().save(state);
      } finally {
        resources.finishAdmission(admission);
      }
    }
    await waitUntil(() => listChanged >= 55, "every admission should emit resources/list_changed");

    const listed = await client.listResources();
    assert.equal(listed.resources.length, 50);
    const expectedNewest = runIds.slice(5).reverse();
    assert.deepEqual(
      listed.resources.map((resource) => resource.uri),
      expectedNewest.map((runId) => `workflow://runs/${runId}/script`),
    );
    assert.match(String(listed.resources[0]?.description), /^completed · started /);
    assert.equal(
      resourceText(await client.readResource({ uri: `workflow://runs/${runIds[0]}/script` })),
      NO_AGENT_SCRIPT.replace("no-agent", "resource-0"),
      "direct reads remain available outside the bounded discovery list",
    );

    const newest = expectedNewest[0];
    const completed = await client.complete({
      ref: { type: "ref/resource", uri: "workflow://runs/{runId}/script" },
      argument: { name: "runId", value: newest.slice(0, 8) },
    });
    assert.deepEqual(completed.completion.values, [newest]);

    const uri = `workflow://runs/${newest}/script`;
    await client.subscribeResource({ uri });
    await client.unsubscribeResource({ uri });
    await assert.rejects(
      client.subscribeResource({ uri: "workflow://runs/no-such/script" }),
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

    const beforeDeleteNotifications = listChanged;
    await client.subscribeResource({ uri });
    assert.equal(manager.deleteRun(newest), true);
    await waitUntil(
      () => listChanged === beforeDeleteNotifications + 1,
      "deletion should emit exactly one resources/list_changed notification",
    );
    await assert.rejects(client.readResource({ uri }), /resource not found/i);
    await assert.rejects(client.unsubscribeResource({ uri }), /resource not found/i);
    assert.equal(updated, 0, "immutable script resources never emit resources/updated");
  } finally {
    await client.close();
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lineage retains a deleted middle revision as unavailable and omits only its resource link", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentprism-mcp-lineage-store-"));
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: okRunner() });
  const mcp = new McpServer({ name: "lineage-test", version: "0.0.0" }, { capabilities: {} });
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const resources = new WorkflowScriptResources(mcp, manager);
  const ids: string[] = [];
  try {
    for (let index = 0; index < 3; index++) {
      const script = NO_AGENT_SCRIPT.replace("no-agent", `lineage-${index}`);
      const admission = resources.beginAdmission({
        script,
        scriptSource: "inline",
        resumeSourceRunId: ids.at(-1),
      });
      try {
        ids.push((await resources.runAdmission(admission, () => manager.runSync(script))).runId);
      } finally {
        resources.finishAdmission(admission);
      }
    }
    assert.equal(manager.deleteRun(ids[1]), true);
    assert.deepEqual(
      resources.lineage(ids[2]),
      ids.map((runId, index) => ({
        runId,
        uri: `workflow://runs/${runId}/script`,
        available: index !== 1,
      })),
    );
    assert.deepEqual(
      resources.links(resources.lineage(ids[2])).map((link) => link.uri),
      [ids[0], ids[2]].map((runId) => `workflow://runs/${runId}/script`),
    );
  } finally {
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lineage normalizes pointer cycles, flattened duplicates, current IDs, and missing ancestors", async () => {
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
    resumeSeed: { sourceRunId: second.runId },
  } as PersistedRunState & { resumeSeed: { sourceRunId: string; ancestorRunIds?: string[] } });
  persistence.save({
    ...secondState,
    resumeSeed: { sourceRunId: first.runId },
  } as PersistedRunState & { resumeSeed: { sourceRunId: string; ancestorRunIds?: string[] } });
  const missingRunId = "missing-ancestor";
  persistence.save({
    ...flattenedState,
    resumeSeed: {
      sourceRunId: missingRunId,
      ancestorRunIds: [
        first.runId,
        second.runId,
        first.runId,
        flattened.runId,
        second.runId,
        missingRunId,
        missingRunId,
      ],
    },
  } as PersistedRunState & { resumeSeed: { sourceRunId: string; ancestorRunIds: string[] } });

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
      { runId: first.runId, uri: `workflow://runs/${first.runId}/script`, available: true },
      { runId: second.runId, uri: `workflow://runs/${second.runId}/script`, available: true },
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

test("lineage merges a cached prefix with every pointer-only descendant above it", async () => {
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
    resumeSeed: { sourceRunId: ids[0]!, ancestorRunIds: [ids[0]!] },
  } as PersistedRunState & { resumeSeed: { sourceRunId: string; ancestorRunIds: string[] } });
  persistence.save({
    ...states[2]!,
    resumeSeed: { sourceRunId: ids[1]! },
  } as PersistedRunState & { resumeSeed: { sourceRunId: string } });
  persistence.save({
    ...states[3]!,
    resumeSeed: { sourceRunId: ids[2]! },
  } as PersistedRunState & { resumeSeed: { sourceRunId: string } });

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

test("public inspect lineage compaction retains newest diagnostics and recomputes every counter", async () => {
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
  persistence.save({
    ...state,
    phases,
    logs,
    journal,
    resumeSeed: {
      sourceRunId: ancestors.at(-1)!,
      ancestorRunIds: ancestors.slice(0, -1),
    },
  } as PersistedRunState & { resumeSeed: { sourceRunId: string; ancestorRunIds: string[] } });

  const inspectionManager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: runner });
  assert.equal(inspectionManager.getPersistence().load(run.runId)?.phases?.[0], phases[0]);
  const server = createWorkflowServer(runner, { manager: inspectionManager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lineage-compaction-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: run.runId, lastN: 50, logLines: 50 },
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
    assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= truncation.maxStructuredBytes);
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
      arguments: { action: "inspect", runId: runIds.at(-1) },
    });
    const payload = structured(inspected);
    const lineage = payload?.lineage as Array<Record<string, unknown>>;
    const truncation = payload?.truncation as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    assert.deepEqual(lineage.map((entry) => entry.runId), runIds);
    assert.equal(new Set(lineage.map((entry) => entry.runId)).size, 300);
    assert.deepEqual(
      resourceLinks(inspected).map((link) => link.uri),
      runIds.map((runId) => `workflow://runs/${runId}/script`),
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
      arguments: { action: "await", runId, waitMs: 1_000 },
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
      arguments: { action: "await", runId: resumedRunId, waitMs: 0 },
    });
    assert.equal((structured(coldAwait)?.outcome as Record<string, unknown>).scriptSource, "inline");
    assert.equal(
      (structured(coldAwait)?.outcome as Record<string, unknown>).scriptUri,
      `workflow://runs/${resumedRunId}/script`,
    );
  } finally {
    await second.dispose();
  }
});

test("cold await treats an origin-main-shaped persisted record as inline", async () => {
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
      arguments: { action: "await", runId: runId!, waitMs: 0 },
    });
    assert.equal(awaited.isError, false);
    assert.equal((structured(awaited)?.outcome as Record<string, unknown>).scriptSource, "inline");
  } finally {
    await second.dispose();
  }
});
