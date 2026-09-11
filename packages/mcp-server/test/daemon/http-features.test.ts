// The full MCP feature surface over real Streamable HTTP against the daemon: prompts,
// resources (list/read), resource subscriptions with server-initiated updated notifications
// (the standalone GET/SSE stream), and durable checkpoint questions answered through a later
// bounded resume request. These are the features a stdio host gets from the
// in-process server; the daemon must serve them identically.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  SKILLS_LIST_METHOD,
  skillsListResultSchema,
} from "../../src/authoring-skills.js";
import { okRunner, structured, textOf, waitForRun, NO_AGENT_SCRIPT, ONE_AGENT_SCRIPT } from "../_harness.js";
import { connectHttp, gatedRunner, makeProjectDir, startDaemon, waitUntil } from "../_http-harness.js";
import { clearDaemonInfo, envFingerprint, writeDaemonInfo } from "../../src/daemon/daemon-info.js";
import { DAEMON_NAME } from "../../src/daemon/constants.js";

const CHECKPOINT_SCRIPT = [
  'export const meta = { name: "gate", description: "checkpoint gate" };',
  'return await checkpoint("Pick one", { kind: "select", choices: ["alpha", "beta"] });',
].join("\n");

test("author-workflow prompt is listed and served over HTTP", async () => {
  const daemon = await startDaemon(okRunner());
  try {
    const session = await connectHttp(daemon.url);
    const prompts = await session.client.listPrompts();
    assert.ok(
      prompts.prompts.some((prompt) => prompt.name === "author-workflow"),
      "author-workflow should be advertised",
    );
    const prompt = await session.client.getPrompt({ name: "author-workflow", arguments: {} });
    const text = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("");
    assert.ok(text.length < 2_000, "the prompt should frame the task without injecting every topic");
    assert.match(text, /skill:\/\/agentprism-workflow-authoring\/SKILL\.md/);
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("Skills Extension manifests and resources are served over HTTP", async () => {
  const daemon = await startDaemon(okRunner());
  try {
    const session = await connectHttp(daemon.url);
    const listed = await session.client.request(
      { method: SKILLS_LIST_METHOD, params: {} },
      skillsListResultSchema,
    );
    const repl = listed.skills.find(
      (skill) => skill.uri === "skill://agentprism-repl-orchestration/SKILL.md",
    );
    assert.ok(repl && Array.isArray(repl.resources));
    const manifestResource = repl.resources.find((resource) => resource.uri === repl.uri);
    assert.ok(manifestResource);

    const read = await session.client.readResource({ uri: repl.uri });
    assert.equal(read.contents.length, 1);
    assert.ok("text" in read.contents[0]!);
    const bytes = Buffer.from(String(read.contents[0]!.text), "utf8");
    assert.equal(bytes.length, manifestResource.size);
    assert.equal(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      manifestResource.digest,
    );
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("run scripts are listed and readable as resources over HTTP", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("resources-project");
  try {
    const session = await connectHttp(daemon.url);
    const result = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: NO_AGENT_SCRIPT, projectDir },
    });
    const runId = structured(result)?.runId as string;
    assert.ok(runId);

    const uri = String(structured(result)?.scriptUri);
    assert.ok(uri.startsWith("file://"), "the script resource is the run's file");
    const listed = await session.client.listResources();
    assert.ok(
      listed.resources.some((resource) => resource.uri === uri),
      `resources/list should include ${uri}`,
    );
    const read = await session.client.readResource({ uri });
    const contents = read.contents[0] as { text?: string };
    assert.equal(contents.text, NO_AGENT_SCRIPT, "script resource should round-trip verbatim");
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("events subscription delivers resources/updated over the standalone GET stream", async () => {
  const { runner, release } = gatedRunner();
  const daemon = await startDaemon(runner);
  const projectDir = makeProjectDir("subscribe-project");
  try {
    const session = await connectHttp(daemon.url);
    const started = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT, projectDir },
    });
    const runId = structured(started)?.runId as string;
    assert.ok(runId, textOf(started));

    const eventsUri = `workflow://runs/${runId}/events`;
    await session.client.subscribeResource({ uri: eventsUri });

    // Completing the gated agent appends run events; the daemon's watcher must push a
    // notifications/resources/updated to this session's GET stream.
    release();
    await waitUntil(() => session.resourceUpdates.includes(eventsUri), "resources/updated notification");

    const awaited = await session.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    });
    assert.equal(structured(awaited)?.status, "completed", textOf(awaited));
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("checkpoint questions pause and accept an explicit later response over HTTP", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("elicit-project");
  try {
    const session = await connectHttp(daemon.url, {
      elicit: () => ({ action: "accept", content: { choice: "alpha" } }),
    });
    const result = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: CHECKPOINT_SCRIPT, projectDir },
    });
    assert.equal(result.isError ?? false, false, textOf(result));
    const runId = String(structured(result)?.runId);
    const paused = structured(await waitForRun(session.client, runId));
    assert.equal(paused?.status, "paused");
    assert.deepEqual((paused?.outcome as { checkpointContext?: { choices?: string[] } })?.checkpointContext?.choices, ["alpha", "beta"]);
    assert.equal(session.elicitations.length, 0, "the original request never opens an elicitation");
    const resumed = await session.client.callTool({ name: "workflow", arguments: {
      action: "resume", runId, checkpointReplies: { 0: "alpha" },
    } });
    assert.equal(structured(resumed)?.accepted, true);
    await waitForRun(session.client, runId, (run) => run.status === "completed");
    const exact = structured(await session.client.callTool({ name: "workflow", arguments: { action: "result", runId } }));
    assert.equal(exact?.chunk, '"alpha"');
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("a client without elicitation receives the same persistent unanswered checkpoint over HTTP", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("checkpoint-without-forms");
  try {
    const session = await connectHttp(daemon.url); // no elicitation capability
    const result = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: CHECKPOINT_SCRIPT, projectDir },
    });
    assert.equal(result.isError ?? false, false, textOf(result));
    const runId = String(structured(result)?.runId);
    const paused = structured(await waitForRun(session.client, runId));
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.reason, "checkpoint_required");
    assert.deepEqual((paused?.outcome as { checkpointContext?: { choices?: string[] } })?.checkpointContext?.choices, ["alpha", "beta"]);
    assert.equal(session.elicitations.length, 0);
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("a successor session answers setup still owned by its live predecessor", async () => {
  const predecessor = await startDaemon(okRunner());
  const successor = await startDaemon(okRunner());
  const projectDir = makeProjectDir("setup-succession");
  // These two real HTTP daemons share the test PID. Publish the predecessor's generation
  // record so signed control discovery resolves the actual lease owner, as entry.ts does.
  writeDaemonInfo({
    name: DAEMON_NAME, version: "4.1.0", pid: process.pid, port: predecessor.port,
    url: predecessor.url, startedAt: predecessor.startedAt, envFingerprint: envFingerprint(),
    instanceId: predecessor.instanceId, controlUrl: predecessor.controlUrl, controlProtocol: 1,
  });
  const first = await connectHttp(predecessor.url);
  const migrated = await connectHttp(successor.url);
  let runId: string | undefined;
  try {
    const accepted = await first.client.callTool({ name: "workflow", arguments: {
      action: "run", projectDir,
      script: 'export const meta = { name: "setup-succession", description: "live setup owner", backends: { custom: { command: "never-invoked-fixture" } } }; return 42;',
    } });
    runId = String(structured(accepted)?.runId);
    const waiting = structured(await waitForRun(first.client, runId, (state) =>
      (state.setup as { state?: string })?.state === "input-required"));
    const setup = waiting?.setup as { request: { id: string } };
    assert.equal(predecessor.activeRunCount(), 1, "predecessor retains setup ownership during succession");
    const observed = await migrated.client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(observed.isError, false, textOf(observed));
    assert.deepEqual(structured(observed)?.setup, waiting?.setup);
    const answer = {
      action: "setup-response", runId, setupId: setup.request.id,
      response: { action: "accept", content: { approve: true } },
    };
    const response = await migrated.client.callTool({ name: "workflow", arguments: answer });
    assert.equal(response.isError, false, textOf(response));
    const completed = await waitForRun(migrated.client, runId, (state) => state.status === "completed");
    assert.equal(structured(completed)?.runId, runId);
    assert.equal(predecessor.activeRunCount(), 0, "answered setup lets the predecessor drain");
    const repeated = await migrated.client.callTool({ name: "workflow", arguments: answer });
    assert.equal(repeated.isError, false, textOf(repeated));
    const conflict = await migrated.client.callTool({ name: "workflow", arguments: {
      ...answer, response: { action: "decline" },
    } });
    assert.equal(conflict.isError, true);
    assert.match(textOf(conflict), /Conflicting response/);
  } finally {
    if (runId) await first.client.callTool({ name: "workflow", arguments: { action: "stop", runId } });
    await first.dispose();
    await migrated.dispose();
    await predecessor.close();
    await successor.close();
    clearDaemonInfo(process.pid);
  }
});
