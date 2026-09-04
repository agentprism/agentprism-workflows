// End-to-end over the BUILT dist: real MCP clients spawn the real shim (dist/entry.js),
// which spawns the real daemon, all inside an isolated $HOME. Proves the migration's
// user-visible contract: stdio clients keep working unchanged, exactly one daemon serves
// concurrent shims, the daemon outlives its clients, and daemon death is invisible to a
// connected client beyond latency.
//
// Requires `pnpm build` first (spawns dist/entry.js). Uses AGENTPRISM_DAEMON_PORT=0 so the
// daemon binds an ephemeral port — daemon.json is the discovery channel, so nothing here
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import type { ElicitResult } from "@modelcontextprotocol/client";

// can collide with a developer's real daemon.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { envFingerprint } from "../../src/daemon/daemon-info.js";
import { SKILLS_LIST_METHOD, skillsListResultSchema } from "../../src/authoring-skills.js";
const distEntry = resolve(fileURLToPath(import.meta.url), "../../../dist/entry.js");
const e2eHome = mkdtempSync(join(tmpdir(), "agentprism-shim-e2e-home-"));
const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: e2eHome,
  AGENTPRISM_DAEMON_PORT: "0",
};
process.on("exit", () => {
  const info = readInfo();
  if (info !== undefined && pidAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      /* best-effort */
    }
  }
  rmSync(e2eHome, { recursive: true, force: true });
});

const NO_AGENT_SCRIPT = [
  'export const meta = { name: "no-agent", description: "no subagents" };',
  "return 42;",
].join("\n");

interface E2eDaemonInfo {
  pid: number;
  port: number;
  url: string;
}

function readInfo(): E2eDaemonInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(e2eHome, ".agentprism", "workflows", "daemons", `${envFingerprint(childEnv)}.json`), "utf-8")) as E2eDaemonInfo;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

async function connectShim(opts: { elicit?: () => ElicitResult; protocolMode?: "legacy" | "modern" } = {}): Promise<{
  client: Client;
  resourceUpdates: string[];
  resourceListChanges: () => number;
  shimStderr: () => string;
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: childEnv,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "shim-e2e", version: "0.0.0" },
    {
      capabilities: opts.elicit ? { elicitation: { form: {} } } : {},
      ...(opts.protocolMode === "modern"
        ? { versionNegotiation: { mode: "auto" as const } }
        : {}),
    },
  );
  if (opts.elicit) {
    const respond = opts.elicit;
    client.setRequestHandler('elicitation/create', async () => respond());
  }
  const resourceUpdates: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', (notification) => {
    resourceUpdates.push(notification.params.uri);
  });
  let resourceListChanges = 0;
  client.setNotificationHandler('notifications/resources/list_changed', () => {
    resourceListChanges += 1;
  });
  let stderrBuffer = "";
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
  });
  return {
    client,
    resourceUpdates,
    resourceListChanges: () => resourceListChanges,
    shimStderr: () => stderrBuffer,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

async function callWorkflow(client: Client): Promise<Record<string, unknown> | undefined> {
  const result = await client.callTool(
    { name: "workflow", arguments: { action: "run", script: NO_AGENT_SCRIPT, projectDir: e2eHome } },
    { timeout: 60_000 },
  );
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  return result.structuredContent as Record<string, unknown> | undefined;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

test("two cold-started shims race to exactly one daemon, which outlives them both", async () => {
  assert.equal(readInfo(), undefined, "expected a cold start");
  const [a, b] = await Promise.all([connectShim(), connectShim()]);

  assert.equal((await callWorkflow(a.client))?.status, "completed");
  assert.equal((await callWorkflow(b.client))?.status, "completed");

  const info = readInfo();
  assert.ok(info, "daemon.json should exist after auto-spawn");
  assert.ok(pidAlive(info.pid));
  const health = (await (await fetch(`http://127.0.0.1:${info.port}/healthz`)).json()) as {
    pid: number;
    sessions: number;
  };
  assert.equal(health.pid, info.pid, "healthz pid should match daemon.json — one daemon, not two");
  assert.ok(health.sessions >= 2, `expected both shim sessions, saw ${health.sessions}`);

  await a.close();
  await b.close();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  assert.ok(pidAlive(info.pid), "daemon must survive its clients exiting");
  const stillUp = await fetch(`http://127.0.0.1:${info.port}/healthz`);
  assert.equal(stillUp.status, 200);
});

test("a modern stdio client negotiates through the shim and survives daemon replacement without a legacy session", async () => {
  const session = await connectShim({ protocolMode: "modern" });
  const subscription = await session.client.listen({ resourcesListChanged: true });
  try {
    assert.equal(session.client.getProtocolEra(), "modern");
    assert.equal((await callWorkflow(session.client))?.status, "completed");

    const before = readInfo();
    assert.ok(before);
    process.kill(before.pid, "SIGTERM");
    await waitFor(() => !pidAlive(before.pid), "old modern daemon to exit");
    await waitFor(
      () => session.shimStderr().includes("modern stateless path ready; reopened 1 subscription(s)"),
      "modern shim recovery and listen reopening",
    );

    const changesBeforeRecovery = session.resourceListChanges();
    assert.equal((await callWorkflow(session.client))?.status, "completed");
    await waitFor(
      () => session.resourceListChanges() > changesBeforeRecovery,
      "reopened modern subscriptions/listen to deliver resources/list_changed",
    );
    const after = readInfo();
    assert.ok(after);
    assert.notEqual(after.pid, before.pid);
  } finally {
    await subscription.close();
    await session.close();
  }
});

test("a connected shim transparently recovers when the daemon is killed mid-session", async () => {
  const session = await connectShim();
  assert.equal((await callWorkflow(session.client))?.status, "completed");

  const before = readInfo();
  assert.ok(before);
  process.kill(before.pid, "SIGTERM");
  await waitFor(() => !pidAlive(before.pid), "old daemon to exit");

  // Same stdio client, no re-registration: the shim re-ensures + re-initializes under the hood.
  assert.equal((await callWorkflow(session.client))?.status, "completed");
  const after = readInfo();
  assert.ok(after);
  assert.notEqual(after.pid, before.pid, "a fresh daemon should have been spawned");
  await session.close();
});

test("the full MCP feature surface works through the shim: prompts, resources, elicitation, subscriptions", async () => {
  const session = await connectShim({ elicit: () => ({ action: "accept", content: { choice: "alpha" } }) });
  try {
  // Prompts.
  const prompts = await session.client.listPrompts();
  assert.ok(prompts.prompts.some((prompt) => prompt.name === "author-workflow"));
  const prompt = await session.client.getPrompt({ name: "author-workflow", arguments: {} });
  const promptText = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("");
  assert.ok(promptText.length < 2_000, "the prompt should point to the authoring skill through the shim");
  assert.match(promptText, /skill:\/\/agentprism-workflow-authoring\/SKILL\.md/);

  const skills = await session.client.request(
    { method: SKILLS_LIST_METHOD, params: {} },
    skillsListResultSchema,
  );
  const workflowSkill = skills.skills.find(
    (skill) => skill.uri === "skill://agentprism-workflow-authoring/SKILL.md",
  );
  assert.ok(workflowSkill);
  const directSkill = await session.client.readResource({ uri: workflowSkill.uri });
  assert.ok("text" in directSkill.contents[0]!);
  assert.match(String(directSkill.contents[0]!.text), /Workflow scripts: quickstart/);

  // Elicitation: a foreground checkpoint answered by THIS client through the pump.
  const checkpointScript = [
    'export const meta = { name: "gate", description: "checkpoint gate" };',
    'return await checkpoint("Pick one", { kind: "select", choices: ["alpha", "beta"], default: "beta" });',
  ].join("\n");
  const answered = await session.client.callTool(
    { name: "workflow", arguments: { action: "run", script: checkpointScript, projectDir: e2eHome } },
    { timeout: 60_000 },
  );
  assert.equal(answered.isError ?? false, false, JSON.stringify(answered.content));
  assert.equal(
    (answered.structuredContent as { result?: unknown }).result,
    "alpha",
    "the elicited choice should round-trip through the shim",
  );

  // Resources: the admitted script is listed and readable verbatim.
  const runId = (answered.structuredContent as { runId: string }).runId;
  const scriptUri = `workflow://runs/${runId}/script`;
  const listed = await session.client.listResources();
  assert.ok(listed.resources.some((resource) => resource.uri === scriptUri));
  const read = await session.client.readResource({ uri: scriptUri });
  assert.equal((read.contents[0] as { text?: string }).text, checkpointScript);

  // Subscriptions: a background run pausing at a durable checkpoint gives a live run whose
  // stop appends events — the updated notification must arrive on the shim's GET stream.
  const pausingScript = [
    'export const meta = { name: "pause-gate", description: "durable checkpoint pause" };',
    'return await checkpoint("gate", { headless: "pause" });',
  ].join("\n");
  const startedBg = await session.client.callTool(
    { name: "workflow", arguments: { action: "run", script: pausingScript, background: true, projectDir: e2eHome } },
    { timeout: 60_000 },
  );
  assert.equal(startedBg.isError ?? false, false, JSON.stringify(startedBg.content));
  const bgRunId = (startedBg.structuredContent as { runId: string }).runId;
  const eventsUri = `workflow://runs/${bgRunId}/events`;
  await session.client.subscribeResource({ uri: eventsUri });
  await session.client.callTool(
    { name: "workflow", arguments: { action: "stop", runId: bgRunId } },
    { timeout: 60_000 },
  );
  await waitFor(() => session.resourceUpdates.includes(eventsUri), "resources/updated through the shim");
  } finally {
    await session.close();
  }
});

test("subscriptions survive daemon death: the shim re-subscribes on session recovery", async () => {
  const session = await connectShim();
  try {
    // A paused background run gives a durable, subscribable events resource.
    const pausingScript = [
      'export const meta = { name: "pause-gate-2", description: "durable checkpoint pause" };',
      'return await checkpoint("gate", { headless: "pause" });',
    ].join("\n");
    const started = await session.client.callTool(
      { name: "workflow", arguments: { action: "run", script: pausingScript, background: true, projectDir: e2eHome } },
      { timeout: 60_000 },
    );
    const runId = (started.structuredContent as { runId: string }).runId;
    const eventsUri = `workflow://runs/${runId}/events`;
    await session.client.subscribeResource({ uri: eventsUri });

    // Kill the daemon out from under the session.
    const before = readInfo();
    assert.ok(before);
    process.kill(before.pid, "SIGTERM");
    await waitFor(() => !pidAlive(before.pid), "old daemon to exit");

    // Any call recovers the session (fresh daemon locates the run via the store manifest)
    // and the shim replays the tracked subscription onto the new session.
    const inspected = await session.client.callTool(
      { name: "workflow", arguments: { action: "status", runId } },
      { timeout: 60_000 },
    );
    assert.equal(inspected.isError ?? false, false, JSON.stringify(inspected.content));
    await waitFor(() => session.shimStderr().includes("re-subscribed 1 resource"), "subscription replay log");
    assert.ok(!session.shimStderr().includes("could not re-subscribe"), session.shimStderr());
    void eventsUri; // Cold-stopping the old run writes durable state but appends no event
    // record (no live run to publish through), so it cannot serve as a notification trigger.

    // The recovered session's notification path end-to-end: a run that is LIVE on the new
    // daemon, subscribed there, then stopped — the updated notification must arrive on the
    // recovered session's GET stream.
    const secondScript = [
      'export const meta = { name: "pause-gate-3", description: "durable checkpoint pause" };',
      'return await checkpoint("gate", { headless: "pause" });',
    ].join("\n");
    const second = await session.client.callTool(
      { name: "workflow", arguments: { action: "run", script: secondScript, background: true, projectDir: e2eHome } },
      { timeout: 60_000 },
    );
    const secondRunId = (second.structuredContent as { runId: string }).runId;
    const secondEventsUri = `workflow://runs/${secondRunId}/events`;
    await session.client.subscribeResource({ uri: secondEventsUri });
    await session.client.callTool(
      { name: "workflow", arguments: { action: "stop", runId: secondRunId } },
      { timeout: 60_000 },
    );
    await waitFor(() => session.resourceUpdates.includes(secondEventsUri), "resources/updated on recovered session", 20_000);
  } finally {
    await session.close();
  }
});

test("a request in flight when the daemon dies is answered with an error (never left hanging), and the same client keeps working on the fresh daemon", { timeout: 60_000 }, async () => {
  const session = await connectShim();
  assert.equal((await callWorkflow(session.client))?.status, "completed");
  const before = readInfo();
  assert.ok(before);

  // A request that will never complete on this daemon: a synchronous never-yielding eval
  // blocks the daemon's main thread (the repl-break e2e's fixture). It is in flight when the
  // daemon is killed outright.
  const inflight = session.client.callTool(
    { name: "repl", arguments: { action: "eval", projectDir: e2eHome, code: "while (true) {}" } },
    { timeout: 50_000 },
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  process.kill(before.pid, "SIGKILL");
  await waitFor(() => !pidAlive(before.pid), "old daemon to die");

  // A second request from the same client: the shim detects the dead daemon, recovers, and
  // the orphaned first request is failed explicitly rather than hanging forever.
  const second = callWorkflow(session.client);
  await assert.rejects(inflight, (error: unknown) => {
    assert.match(String((error as Error).message), /session lost|daemon unreachable/i, String((error as Error).message));
    return true;
  });
  assert.equal((await second)?.status, "completed", "the client keeps working on the fresh daemon");
  const after = readInfo();
  assert.ok(after);
  assert.notEqual(after.pid, before.pid);
  await session.close();
});

test("a modern in-flight request is failed as ambiguous and never replayed after daemon death", { timeout: 60_000 }, async () => {
  const session = await connectShim({ protocolMode: "modern" });
  try {
    assert.equal((await callWorkflow(session.client))?.status, "completed");
    const before = readInfo();
    assert.ok(before);

    const inflight = session.client.callTool(
      { name: "repl", arguments: { action: "eval", projectDir: e2eHome, code: "while (true) {}" } },
      { timeout: 50_000 },
    );
    const inflightFailure = inflight.then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    process.kill(before.pid, "SIGKILL");
    await waitFor(() => !pidAlive(before.pid), "old modern daemon to die");

    const error = await inflightFailure;
    assert.match(String((error as Error | undefined)?.message), /session lost|daemon unreachable/i);
    await waitFor(
      () => session.shimStderr().includes("modern stateless path ready"),
      "modern stateless recovery",
    );
    const second = callWorkflow(session.client);
    assert.equal(
      (await second)?.status,
      "completed",
      "the ambiguous eval was not replayed onto the successor and did not block it",
    );
  } finally {
    await session.close();
  }
});

test("daemon stop terminates the daemon and clears discovery state", async () => {
  // Ensure one is running first (the previous test left one).
  const info = readInfo();
  assert.ok(info && pidAlive(info.pid), "expected a running daemon from the prior test");

  const stop = spawnSync(process.execPath, [distEntry, "daemon", "stop"], { env: childEnv, encoding: "utf-8" });
  assert.equal(stop.status, 0, stop.stderr);
  assert.ok(!pidAlive(info.pid), "daemon should be dead after stop");
  assert.equal(readInfo(), undefined, "daemon.json should be cleared");

  const again = spawnSync(process.execPath, [distEntry, "daemon", "stop"], { env: childEnv, encoding: "utf-8" });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /not running/);
});
