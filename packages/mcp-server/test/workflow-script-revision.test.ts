import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RunOptions } from "@automatalabs/shared-types";
import { WorkflowManager } from "@automatalabs/workflows";

import { createWorkflowServer } from "../src/index.js";

import { makeRunner, persistedRunFile, scriptFileUri, structured, textOf, type ToolCallResult } from "./_harness.js";

const script = (second: string, extra = "") => [
  `export const meta = { model: "claude", name: "revise", description: "revise a script"${extra} };`,
  'const first = await agent("first", { label: "first" });',
  `const second = await agent(${JSON.stringify(second)}, { label: "second" });`,
  "return { first, second };",
].join("\n");

class ControlledRunner {
  readonly calls: Array<{ prompt: string; options: RunOptions; resolve: (value: unknown) => void }> = [];
  readonly runner = makeRunner(
    (prompt, options) =>
      new Promise((resolve, reject) => {
        this.calls.push({ prompt, options, resolve });
        options.signal?.addEventListener("abort", () => reject(new Error("agent cancelled")), { once: true });
      }),
  );
}

async function connectWithManager(
  runner: ReturnType<typeof makeRunner>,
  manager: WorkflowManager,
): Promise<{ client: Client; dispose: () => Promise<void> }> {
  const server = createWorkflowServer(runner, { manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "revision-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    dispose: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
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

function runIdOf(result: ToolCallResult): string {
  const runId = structured(result)?.runId;
  assert.equal(typeof runId, "string");
  return runId;
}

function resourceText(result: Awaited<ReturnType<Client["readResource"]>>): string | undefined {
  const block = result.contents[0];
  return block && "text" in block ? block.text : undefined;
}

test("editing an inline run's store copy and resuming replays the unchanged call and runs the edited one live", async () => {
  const controlled = new ControlledRunner();
  const manager = new WorkflowManager({ agent: controlled.runner });
  const { client, dispose } = await connectWithManager(controlled.runner, manager);
  try {
    const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", script: script("second") } });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 1, "the first agent should start");
    const pausing = client.callTool({ name: "workflow", arguments: { action: "pause", runId } });
    await waitUntil(() => manager.pausePending(runId), "the pause request should reach the run");
    controlled.calls[0].resolve("first result");
    assert.equal(structured(await pausing)?.status, "paused");

    // The run's script resource is the editable working copy.
    const scriptUri = scriptFileUri(runId);
    assert.equal(structured(accepted)?.scriptUri, scriptUri);
    const copyPath = fileURLToPath(scriptUri);
    assert.equal(readFileSync(copyPath, "utf8"), script("second"));
    writeFileSync(copyPath, script("second, revised"), "utf8");
    assert.equal(resourceText(await client.readResource({ uri: scriptUri })), script("second, revised"));

    const resumed = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(resumed.isError, false, textOf(resumed));
    assert.equal(structured(resumed)?.accepted, true);
    assert.equal(structured(resumed)?.continuation?.scriptRevised, true);
    assert.equal(structured(resumed)?.continuation?.generation, 1);
    assert.match(textOf(resumed), /with the revised script/);

    await waitUntil(() => controlled.calls.length === 2, "the edited call runs live");
    assert.equal(controlled.calls[1].prompt, "second, revised");
    controlled.calls[1].resolve("second result");
    await waitUntil(() => manager.getRun(runId)?.status === "completed", "the continuation completes");
    const status = await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(status)?.status, "completed");
    assert.equal(JSON.stringify(structured(status)?.outcome?.result), JSON.stringify({ first: "first result", second: "second result" }));

    const persisted = JSON.parse(readFileSync(persistedRunFile(runId)!, "utf8")) as {
      script: string; scriptRevisions?: Array<{ generation: number; scriptHash: string }>; continuation?: { scriptRevised?: true };
    };
    assert.equal(persisted.script, script("second, revised"), "the revision is the text that executed");
    assert.equal(persisted.scriptRevisions?.length, 1);
    assert.equal(persisted.scriptRevisions?.[0]?.generation, 1);
    assert.equal(persisted.continuation?.scriptRevised, true);
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("a revision that fails validation or widens backend approval is refused and the run stays resumable", async () => {
  const controlled = new ControlledRunner();
  const manager = new WorkflowManager({ agent: controlled.runner });
  const { client, dispose } = await connectWithManager(controlled.runner, manager);
  try {
    const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", script: script("second") } });
    const runId = runIdOf(accepted);
    await waitUntil(() => controlled.calls.length === 1, "the first agent should start");
    const stopped = await client.callTool({ name: "workflow", arguments: { action: "stop", runId } });
    assert.equal(structured(stopped)?.status, "aborted");
    const copyPath = fileURLToPath(scriptFileUri(runId));

    writeFileSync(copyPath, "const broken = ;", "utf8");
    const broken = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(broken.isError, true);
    assert.match(textOf(broken), /was not continued: The revised script .* does not parse/);

    writeFileSync(copyPath, script("second", ', backends: { extra: { command: "extra-acp" } }'), "utf8");
    const widened = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(widened.isError, true);
    assert.match(textOf(widened), /declares backend "extra", which this run's setup never approved/);

    writeFileSync(copyPath, script("second").replace('label: "second"', 'label: "second", model: "nope/*"'), "utf8");
    const invalidRoute = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(invalidRoute.isError, true);
    assert.match(textOf(invalidRoute), /failed validation/);

    const untouched = await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(untouched)?.status, "aborted", "refused revisions leave the run as it was");

    writeFileSync(copyPath, script("second, fixed"), "utf8");
    const resumed = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(resumed.isError, false, textOf(resumed));
    assert.equal(structured(resumed)?.continuation?.scriptRevised, true);
    await waitUntil(() => controlled.calls.length === 2, "the interrupted first call runs again");
    controlled.calls[1].resolve("first result");
    await waitUntil(() => controlled.calls.length === 3, "the edited call runs");
    assert.equal(controlled.calls[2].prompt, "second, fixed");
    controlled.calls[2].resolve("second result");
    await waitUntil(() => manager.getRun(runId)?.status === "completed", "the continuation completes");
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("a scriptPath run re-reads the caller's file on resume, and an unchanged file continues the persisted script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentprism-mcp-revision-path-"));
  const scriptPath = join(dir, "revise.workflow.js");
  writeFileSync(scriptPath, script("second"), "utf8");
  const controlled = new ControlledRunner();
  const manager = new WorkflowManager({ agent: controlled.runner });
  const { client, dispose } = await connectWithManager(controlled.runner, manager);
  try {
    const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", scriptPath } });
    const runId = runIdOf(accepted);
    assert.equal(structured(accepted)?.scriptUri, pathToFileURL(scriptPath).href);
    await waitUntil(() => controlled.calls.length === 1, "the first agent should start");
    controlled.calls[0].resolve("first result");
    await waitUntil(() => controlled.calls.length === 2, "the second agent should start");
    await client.callTool({ name: "workflow", arguments: { action: "stop", runId } });

    const unchanged = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(unchanged.isError, false, textOf(unchanged));
    assert.equal(structured(unchanged)?.continuation?.scriptRevised, undefined);
    assert.doesNotMatch(textOf(unchanged), /revised script/);
    await waitUntil(() => controlled.calls.length === 3, "the interrupted call runs again");
    await client.callTool({ name: "workflow", arguments: { action: "stop", runId } });

    writeFileSync(scriptPath, script("second, from the caller's file"), "utf8");
    const revised = await client.callTool({ name: "workflow", arguments: { action: "resume", runId } });
    assert.equal(revised.isError, false, textOf(revised));
    assert.equal(structured(revised)?.continuation?.scriptRevised, true);
    await waitUntil(() => controlled.calls.length === 4, "the edited call runs live");
    assert.equal(controlled.calls[3].prompt, "second, from the caller's file");
    controlled.calls[3].resolve("second result");
    await waitUntil(() => manager.getRun(runId)?.status === "completed", "the continuation completes");
    const status = await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(JSON.stringify(structured(status)?.outcome?.result), JSON.stringify({ first: "first result", second: "second result" }));
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
