// The full MCP feature surface over real Streamable HTTP against the daemon: prompts,
// resources (list/read), resource subscriptions with server-initiated updated notifications
// (the standalone GET/SSE stream), and checkpoint elicitation (server→client requests riding
// the tool call's POST stream). These are the features a stdio host used to get from the
// in-process server; the daemon must serve them identically.
import assert from "node:assert/strict";
import { test } from "node:test";

import { okRunner, structured, textOf, NO_AGENT_SCRIPT, ONE_AGENT_SCRIPT } from "../_harness.js";
import { connectHttp, gatedRunner, makeProjectDir, startDaemon, waitUntil } from "../_http-harness.js";

const CHECKPOINT_SCRIPT = [
  'export const meta = { name: "gate", description: "checkpoint gate" };',
  'return await checkpoint("Pick one", { kind: "select", choices: ["alpha", "beta"], default: "beta" });',
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
    assert.match(text, /docs.*workflow\/quickstart/);
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("selective docs tool embeds the same static resource served over HTTP", async () => {
  const daemon = await startDaemon(okRunner());
  try {
    const session = await connectHttp(daemon.url);
    const result = await session.client.callTool({
      name: "docs",
      arguments: { topic: "repl/agent-handles" },
    });
    assert.equal(result.isError, false);
    const embedded = result.content.find((block) => block.type === "resource");
    assert.ok(embedded && embedded.type === "resource" && "text" in embedded.resource);
    assert.equal(embedded.resource.uri, "agentprism://docs/repl/agent-handles");

    const listed = await session.client.listResources();
    assert.ok(listed.resources.some((resource) => resource.uri === embedded.resource.uri));
    const read = await session.client.readResource({ uri: embedded.resource.uri });
    assert.ok("text" in read.contents[0]!);
    assert.equal(read.contents[0]!.text, embedded.resource.text);
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
      arguments: { script: NO_AGENT_SCRIPT, projectDir },
    });
    const runId = structured(result)?.runId as string;
    assert.ok(runId);

    const uri = `workflow://runs/${runId}/script`;
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
      arguments: { script: ONE_AGENT_SCRIPT, background: true, projectDir },
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
      arguments: { action: "await", runId, waitMs: 15_000 },
    });
    assert.equal(structured(awaited)?.status, "completed", textOf(awaited));
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("checkpoint elicitation rides the HTTP POST stream and returns the answered value", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("elicit-project");
  try {
    const session = await connectHttp(daemon.url, {
      elicit: () => ({ action: "accept", content: { choice: "alpha" } }),
    });
    const result = await session.client.callTool({
      name: "workflow",
      arguments: { script: CHECKPOINT_SCRIPT, projectDir },
    });
    assert.equal(result.isError ?? false, false, textOf(result));
    assert.equal(structured(result)?.result, "alpha", "the elicited choice should be the run result");
    assert.equal(session.elicitations.length, 1, "exactly one elicitation should have been requested");
    const params = session.elicitations[0].params as { requestedSchema?: { required?: string[] } };
    assert.deepEqual(params.requestedSchema?.required, ["choice"]);
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("a non-eliciting client's checkpoint degrades to the declared default over HTTP", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("headless-project");
  try {
    const session = await connectHttp(daemon.url); // no elicitation capability
    const result = await session.client.callTool({
      name: "workflow",
      arguments: { script: CHECKPOINT_SCRIPT, projectDir },
    });
    assert.equal(result.isError ?? false, false, textOf(result));
    assert.equal(structured(result)?.result, "beta", "headless checkpoint should take the default");
    await session.dispose();
  } finally {
    await daemon.close();
  }
});
