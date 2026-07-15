import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { WorkflowManager } from "@automatalabs/workflows";

import { WorkflowScriptResources } from "../src/workflow-resources.js";
import {
  connect,
  countingRunner,
  NO_AGENT_SCRIPT,
  okRunner,
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
        const run = await manager.runSync(script);
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
        ids.push((await manager.runSync(script)).runId);
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
