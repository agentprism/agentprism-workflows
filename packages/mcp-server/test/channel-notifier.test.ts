// Claude Code channel notifications: the run monitor's automatic messages, sent by the server to
// the session whose tool call named the run. Same wording, same ids, no polling.
import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import type { PersistedRunEvent } from "@automatalabs/shared-types";

import {
  CLAUDE_CHANNEL_CAPABILITY,
  CLAUDE_CHANNEL_NOTIFICATION,
  type ClaudeChannelNotificationParams,
} from "../src/channel-notifier.js";
import { pausedNotice, permissionNotice, setupNotice, terminalNotice } from "../src/run-notices.js";
import { WorkflowPermissionBroker } from "../src/workflow-permissions.js";
import { modelMessageText } from "../ui/src/model-messages.js";
import {
  NO_AGENT_SCRIPT,
  connect,
  makeRunner,
  okRunner,
  throwingRunner,
  structured,
  textOf,
  waitForRun,
} from "./_harness.js";

const CHECKPOINT_SCRIPT = [
  'export const meta = { name: "gate", description: "checkpoint gate" };',
  'return await checkpoint("Pick one", { kind: "select", choices: ["alpha", "beta"] });',
].join("\n");
const BACKEND_SCRIPT = [
  'export const meta = { name: "sb", description: "d", backends: { browser: { command: "browser-acp" } } };',
  'return await agent("p", { model: "browser" });',
].join("\n");
const PERMISSION_SCRIPT = [
  'export const meta = { name: "perm", description: "d" };',
  'return await agent("work", { label: "worker", model: "codex" });',
].join("\n");
// An agent failure resolves to a null result; only a script-level throw fails the run. The throw
// is conditional on a live null so the validating dry run (mocked, non-null output) admits it.
const FAILING_SCRIPT = [
  'export const meta = { name: "boom", description: "fails", model: "claude" };',
  'const reply = await agent("work");',
  'if (reply === null) throw new Error("script exploded at line one");',
  'return reply;',
].join("\n");

function capture(client: Client): ClaudeChannelNotificationParams[] {
  const received: ClaudeChannelNotificationParams[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === CLAUDE_CHANNEL_NOTIFICATION) {
      received.push(notification.params as unknown as ClaudeChannelNotificationParams);
    }
  };
  return received;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function runScript(client: Client, script: string): Promise<string> {
  const res = await client.callTool({ name: "workflow", arguments: { action: "run", script } });
  assert.equal(res.isError, false, textOf(res));
  return structured(res)?.runId as string;
}

/** Claude Code drops meta keys that are not identifiers, so every key must be one. */
function assertChannelShape(params: ClaudeChannelNotificationParams, runId: string): void {
  assert.equal(typeof params.content, "string");
  for (const key of Object.keys(params.meta)) assert.match(key, /^[A-Za-z0-9_]+$/);
  assert.equal(params.meta.run_id, runId);
  assert.equal(params.meta.event_id.length > 0, true);
}

test("legacy initialize advertises the Claude Code channel capability", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    assert.deepEqual(client.getServerCapabilities()?.experimental?.[CLAUDE_CHANNEL_CAPABILITY], {});
  } finally {
    await dispose();
  }
});

test("a run admitted by this session announces its completion once, in the App's words", async () => {
  const { client, dispose } = await connect(okRunner());
  const received = capture(client);
  try {
    const runId = await runScript(client, NO_AGENT_SCRIPT);
    await waitForRun(client, runId);
    await until(() => received.length === 1, "the terminal channel notification");
    const [notice] = received;
    assertChannelShape(notice!, runId);
    assert.equal(notice!.meta.kind, "terminal");
    assert.equal(notice!.meta.status, "completed");
    assert.match(notice!.content, /Run completed\. Its exact result is available\./);
    assert.equal(notice!.content, modelMessageText(runId, { type: "complete" } as PersistedRunEvent));

    // Re-inspecting a finished run neither replays nor duplicates.
    await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    await client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    await settle();
    assert.equal(received.length, 1);
  } finally {
    await dispose();
  }
});

test("a failed run announces the failure with the run's own error message, unaltered", async () => {
  const { client, dispose } = await connect(throwingRunner(() => new Error("agent offline")));
  const received = capture(client);
  try {
    const runId = await runScript(client, FAILING_SCRIPT);
    await waitForRun(client, runId, (status) => status.status === "failed");
    await until(() => received.length === 1, "the failure channel notification");
    assertChannelShape(received[0]!, runId);
    assert.equal(received[0]!.meta.kind, "terminal");
    assert.equal(received[0]!.meta.status, "failed");
    // The engine's recorded message is passed through whole.
    assert.match(received[0]!.content, /Run failed: .*script exploded at line one/);
  } finally {
    await dispose();
  }
});

test("a checkpoint pause is announced as required input", async () => {
  const { client, dispose } = await connect(okRunner());
  const received = capture(client);
  try {
    const runId = await runScript(client, CHECKPOINT_SCRIPT);
    await waitForRun(client, runId, (status) => status.status === "paused");
    await until(() => received.length === 1, "the checkpoint channel notification");
    assertChannelShape(received[0]!, runId);
    assert.equal(received[0]!.meta.kind, "checkpoint");
    assert.equal(received[0]!.meta.status, "paused");
    assert.match(received[0]!.content, /Checkpoint 0 needs an explicit select answer/);
  } finally {
    await dispose();
  }
});

test("a parked permission request is announced, then the completion follows the answer", async () => {
  const broker = new WorkflowPermissionBroker();
  const runner = makeRunner(async (_prompt, options) => {
    await broker.resolver(
      {
        sessionId: "codex-session",
        toolCall: { toolCallId: "command-1", title: "Run tests", kind: "execute" },
        options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
      },
      { sessionId: "codex-session", backendId: "codex", runId: options.runId, callIndex: options.callIndex },
    );
    return "done";
  });
  const { client, dispose } = await connect(runner, { permissionBroker: broker });
  const received = capture(client);
  try {
    const runId = await runScript(client, PERMISSION_SCRIPT);
    await until(() => received.length === 1, "the permission channel notification");
    assertChannelShape(received[0]!, runId);
    assert.equal(received[0]!.meta.kind, "permission");
    assert.match(received[0]!.content, /Permission is required for agent call 0/);
    const pending = broker.list(runId)[0]!;
    broker.respond(runId, pending.permissionId, { outcome: { outcome: "selected", optionId: "allow_once" } });
    await waitForRun(client, runId);
    await until(() => received.length === 2, "the completion after the permission answer");
    assert.equal(received[1]!.meta.kind, "terminal");
  } finally {
    await dispose();
    broker.dispose();
  }
});

test("a pending setup request is announced", async () => {
  const { client, dispose } = await connect(okRunner());
  const received = capture(client);
  try {
    const runId = await runScript(client, BACKEND_SCRIPT);
    await waitForRun(client, runId, (status) => (status.setup as { state?: string } | undefined)?.state === "input-required");
    await until(() => received.length === 1, "the setup channel notification");
    assertChannelShape(received[0]!, runId);
    assert.equal(received[0]!.meta.kind, "setup");
    assert.equal(received[0]!.meta.status, "pending");
    assert.match(received[0]!.content, /Setup needs backend-approval/);
  } finally {
    await dispose();
  }
});

test("a fresh session inspecting a finished run receives nothing: the status response already said it", async () => {
  const first = await connect(okRunner());
  const second = await connect(okRunner());
  const received = capture(second.client);
  try {
    const runId = await runScript(first.client, NO_AGENT_SCRIPT);
    await waitForRun(first.client, runId);
    const status = await second.client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(status)?.status, "completed", textOf(status));
    await settle();
    assert.equal(received.length, 0);
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

test("notice ids and wording are shared between the App and the channel", () => {
  const record = { streamId: "s", seq: 7, event: { type: "error", errorRecord: { message: "token=abc failure" } } };
  const failure = terminalNotice("run-a", record)!;
  assert.equal(failure.id, "terminal:s:7");
  assert.equal(failure.text, "[workflow run run-a] Run failed: token=abc failure.");
  assert.equal(pausedNotice("run-a", { reason: "checkpoint_required", checkpoint: { callIndex: 2, hash: "h", kind: "confirm" } }).id, "checkpoint:2:h");
  assert.equal(pausedNotice("run-a", { reason: "auth_required", backendId: "claude" }).id, "paused:auth_required:claude");
  assert.equal(permissionNotice("run-a", { permissionId: "p1", callIndex: 0 }).id, "permission:p1");
  assert.equal(setupNotice("run-a", { id: "s1", kind: "backend-approval" }).id, "setup:s1");
  assert.equal(terminalNotice("run-a", { streamId: "s", seq: 1, event: { type: "phase" } }), undefined);
});
