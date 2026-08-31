import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { WorkflowManager } from "@automatalabs/workflows";

import { createWorkflowServer } from "../src/server.js";
import {
  connect,
  makeRunner,
  okRunner,
  ONE_AGENT_SCRIPT,
  persistedRunFile,
  structured,
  throwingRunner,
} from "./_harness.js";

function resourceText(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const content = result.contents[0];
  assert.ok(content && "text" in content);
  return String(content.text);
}

function contentBlocks(result: Awaited<ReturnType<Client["callTool"]>>): Array<Record<string, unknown>> {
  return result.content as Array<Record<string, unknown>>;
}

function allText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return contentBlocks(result)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
}

function links(result: Awaited<ReturnType<Client["callTool"]>>): Array<Record<string, unknown>> {
  return contentBlocks(result).filter((block) => block.type === "resource_link");
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("completed foreground, inspect, and await expose a distinct durable result resource to content-first clients", async () => {
  const authored = { marker: "EXACT-WORKFLOW-RESULT", nested: { answer: 42 } };
  const serialized = JSON.stringify(authored);
  const script = [
    'export const meta = { name: "result-discovery", description: "exact result" };',
    `return ${serialized};`,
  ].join("\n");
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const completed = await client.callTool({ name: "workflow", arguments: { script } });
    const runId = String(structured(completed)?.runId);
    const scriptUri = `workflow://runs/${runId}/script`;
    const resultUri = `workflow://runs/${runId}/result`;

    assert.equal(structured(completed)?.resultUri, resultUri);
    assert.match(allText(completed), /Workflow result \(exact JSON\):/);
    assert.ok(allText(completed).includes(serialized), "content-only clients receive the small exact JSON result");
    assert.deepEqual(links(completed).map((link) => link.uri), [resultUri, scriptUri]);
    assert.match(String(links(completed)[0]?.name), /result/);
    assert.match(String(links(completed)[1]?.name), /script/);
    assert.equal(resourceText(await client.readResource({ uri: resultUri })), serialized);

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId },
    });
    assert.equal(structured(inspected)?.resultUri, resultUri);
    assert.deepEqual(links(inspected).map((link) => link.uri), [resultUri, scriptUri]);

    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 0 },
    });
    assert.equal(structured(awaited)?.resultUri, resultUri);
    assert.equal(
      (structured(awaited)?.outcome as Record<string, unknown> | undefined)?.resultUri,
      resultUri,
    );
    assert.ok(allText(awaited).includes(serialized));
    assert.deepEqual(links(awaited).map((link) => link.uri), [resultUri, scriptUri]);

    const events = resourceText(
      await client.readResource({ uri: `workflow://runs/${runId}/events` }),
    );
    assert.notEqual(events, serialized, "the bounded event document is not the exact result representation");
    assert.equal((JSON.parse(events) as Record<string, unknown>).schemaVersion, 1);
  } finally {
    await dispose();
  }
});

test("JSON null remains exact while completed undefined results fail closed", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const nullResult = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "null-result", description: "null is JSON" };',
          "return null;",
        ].join("\n"),
      },
    });
    const nullRunId = String(structured(nullResult)?.runId);
    const nullUri = `workflow://runs/${nullRunId}/result`;
    assert.equal(structured(nullResult)?.resultUri, nullUri);
    assert.equal(resourceText(await client.readResource({ uri: nullUri })), "null");
    const nullPage = await client.callTool({
      name: "workflow",
      arguments: { action: "result", runId: nullRunId },
    });
    assert.equal(structured(nullPage)?.chunk, "null");

    const noValue = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "undefined-result", description: "no JSON value" };',
          "return undefined;",
        ].join("\n"),
      },
    });
    const noValueRunId = String(structured(noValue)?.runId);
    const noValueUri = `workflow://runs/${noValueRunId}/result`;
    assert.equal(structured(noValue)?.status, "completed");
    assert.equal(structured(noValue)?.resultUri, undefined);
    assert.equal(links(noValue).some((link) => link.uri === noValueUri), false);
    const unavailable = await client.callTool({
      name: "workflow",
      arguments: { action: "result", runId: noValueRunId },
    });
    assert.equal(unavailable.isError, true);
    assert.match(allText(unavailable), /completed without a JSON result/);
    await assert.rejects(
      client.readResource({ uri: noValueUri }),
      /completed without a JSON result|resource not found/i,
    );
  } finally {
    await dispose();
  }
});

test("large exact results stay out of summary text and page losslessly on UTF-8 boundaries", async () => {
  const authored = {
    marker: "LARGE-EXACT-WORKFLOW-RESULT",
    payload: `prefix-${"😀".repeat(30_000)}-suffix`,
  };
  const serialized = JSON.stringify(authored);
  const script = [
    'export const meta = { name: "large-result", description: "bounded retrieval" };',
    "return args;",
  ].join("\n");
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const completed = await client.callTool({
      name: "workflow",
      arguments: { script, args: authored },
    });
    const runId = String(structured(completed)?.runId);
    const resultUri = `workflow://runs/${runId}/result`;
    const visible = allText(completed);
    assert.equal(visible.includes(serialized.slice(0, 1_000)), false);
    assert.match(visible, /Exact workflow result: \d+ UTF-8 bytes/);
    assert.match(visible, /action="result"/);
    assert.equal(resourceText(await client.readResource({ uri: resultUri })), serialized);

    let offset = 0;
    let reconstructed = "";
    let pages = 0;
    while (true) {
      const response = await client.callTool({
        name: "workflow",
        arguments: { action: "result", runId, offset, maxBytes: 16_384 },
      });
      assert.equal(response.isError, false);
      const page = structured(response)!;
      assert.equal(page.action, "result");
      assert.equal(page.resultUri, resultUri);
      assert.equal(page.offset, offset);
      assert.ok(Buffer.byteLength(String(page.chunk), "utf8") <= 16_384);
      assert.deepEqual(JSON.parse(allText(response)), page, "content mirrors the bounded structured page");
      reconstructed += String(page.chunk);
      pages++;
      if (page.hasMore !== true) {
        assert.equal(page.endOffset, page.totalBytes);
        break;
      }
      assert.ok(Number(page.endOffset) > offset);
      offset = Number(page.endOffset);
    }
    assert.ok(pages > 1);
    assert.equal(reconstructed, serialized);
    assert.deepEqual(JSON.parse(reconstructed), authored);

    const emojiStart = Buffer.byteLength('{"marker":"LARGE-EXACT-WORKFLOW-RESULT","payload":"prefix-', "utf8");
    const invalidBoundary = await client.callTool({
      name: "workflow",
      arguments: { action: "result", runId, offset: emojiStart + 1, maxBytes: 16 },
    });
    assert.equal(invalidBoundary.isError, true);
    assert.match(allText(invalidBoundary), /not a UTF-8 boundary.*previous endOffset/);

    const pastEnd = await client.callTool({
      name: "workflow",
      arguments: {
        action: "result",
        runId,
        offset: Buffer.byteLength(serialized, "utf8") + 1,
      },
    });
    assert.equal(pastEnd.isError, true);
    assert.match(allText(pastEnd), /exceeds totalBytes/);
  } finally {
    await dispose();
  }
});

test("exact result retrieval survives restart and fails closed for every unavailable, corrupt, and deleted run", async () => {
  const restartScript = [
    'export const meta = { name: "restart-result", description: "cold retrieval" };',
    'return { persisted: true, value: "cold" };',
  ].join("\n");
  const first = await connect(okRunner());
  let completedRunId: string;
  try {
    const completed = await first.client.callTool({ name: "workflow", arguments: { script: restartScript } });
    completedRunId = String(structured(completed)?.runId);
  } finally {
    await first.dispose();
  }

  const cold = await connect(okRunner(), { listTools: true });
  try {
    const page = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "result", runId: completedRunId!, maxBytes: 64 },
    });
    assert.equal(page.isError, false);
    assert.deepEqual(JSON.parse(String(structured(page)?.chunk)), { persisted: true, value: "cold" });
    assert.deepEqual(
      JSON.parse(resourceText(await cold.client.readResource({ uri: `workflow://runs/${completedRunId!}/result` }))),
      { persisted: true, value: "cold" },
    );
    const unknown = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "result", runId: "unknown-run" },
    });
    assert.equal(unknown.isError, true);
    assert.match(allText(unknown), /No workflow run found/);
  } finally {
    await cold.dispose();
  }

  let releaseRunning: (() => void) | undefined;
  const running = await connect(makeRunner(() => new Promise<string>((resolve) => {
    releaseRunning = () => resolve("done");
  })));
  try {
    const accepted = await running.client.callTool({
      name: "workflow",
      arguments: { script: ONE_AGENT_SCRIPT, background: true },
    });
    const runId = String(structured(accepted)?.runId);
    await waitUntil(() => releaseRunning !== undefined, "background agent should start");
    const unavailable = await running.client.callTool({
      name: "workflow",
      arguments: { action: "result", runId },
    });
    assert.equal(unavailable.isError, true);
    assert.match(allText(unavailable), /unavailable while the run is running/);
    await assert.rejects(
      running.client.readResource({ uri: `workflow://runs/${runId}/result` }),
      /unavailable|resource not found/i,
    );
  } finally {
    releaseRunning?.();
    await running.dispose();
  }

  const paused = await connect(okRunner());
  try {
    const accepted = await paused.client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "paused-result", description: "no result yet" };',
          'return await checkpoint("continue?", { headless: "pause" });',
        ].join("\n"),
        background: true,
      },
    });
    const runId = String(structured(accepted)?.runId);
    const terminal = await paused.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 1_000 },
    });
    assert.equal(structured(terminal)?.status, "paused");
    const unavailable = await paused.client.callTool({
      name: "workflow",
      arguments: { action: "result", runId },
    });
    assert.equal(unavailable.isError, true);
    assert.match(allText(unavailable), /unavailable while the run is paused/);

    const stopped = await paused.client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId },
    });
    assert.equal(structured(stopped)?.status, "aborted");
    const aborted = await paused.client.callTool({
      name: "workflow",
      arguments: { action: "result", runId },
    });
    assert.equal(aborted.isError, true);
    assert.match(allText(aborted), /unavailable while the run is aborted/);
  } finally {
    await paused.dispose();
  }

  const failed = await connect(throwingRunner(() => new WorkflowError(
    "terminal failure",
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: false },
  )));
  try {
    const terminal = await failed.client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    const runId = String(structured(terminal)?.runId);
    assert.equal(structured(terminal)?.status, "failed");
    const unavailable = await failed.client.callTool({
      name: "workflow",
      arguments: { action: "result", runId },
    });
    assert.equal(unavailable.isError, true);
    assert.match(allText(unavailable), /unavailable while the run is failed/);
  } finally {
    await failed.dispose();
  }

  const corruptSource = await connect(okRunner());
  let corruptRunId: string;
  try {
    const completed = await corruptSource.client.callTool({
      name: "workflow",
      arguments: { script: restartScript },
    });
    corruptRunId = String(structured(completed)?.runId);
  } finally {
    await corruptSource.dispose();
  }
  const corruptFile = persistedRunFile(corruptRunId!);
  assert.ok(corruptFile);
  writeFileSync(corruptFile, "{broken", "utf8");
  if (existsSync(`${corruptFile}.bak`)) writeFileSync(`${corruptFile}.bak`, "{broken", "utf8");
  const corruptCold = await connect(okRunner());
  try {
    const corrupt = await corruptCold.client.callTool({
      name: "workflow",
      arguments: { action: "result", runId: corruptRunId! },
    });
    assert.equal(corrupt.isError, true);
    assert.match(allText(corrupt), /No workflow run found/);
    await assert.rejects(
      corruptCold.client.readResource({ uri: `workflow://runs/${corruptRunId!}/result` }),
      /No workflow run found|resource not found/i,
    );
  } finally {
    await corruptCold.dispose();
  }

  const root = mkdtempSync(join(tmpdir(), "agentprism-result-delete-"));
  const runner = okRunner();
  const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: runner });
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "result-delete", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const completed = await client.callTool({ name: "workflow", arguments: { script: restartScript } });
    const runId = String(structured(completed)?.runId);
    assert.equal(manager.deleteRun(runId), true);
    const deleted = await client.callTool({
      name: "workflow",
      arguments: { action: "result", runId },
    });
    assert.equal(deleted.isError, true);
    assert.match(allText(deleted), /No workflow run found/);
    await assert.rejects(
      client.readResource({ uri: `workflow://runs/${runId}/result` }),
      /No workflow run found|resource not found/i,
    );
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
