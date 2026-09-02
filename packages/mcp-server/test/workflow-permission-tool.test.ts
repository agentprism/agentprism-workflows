import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAcpRunner } from "@automatalabs/workflows";
import { WorkflowPermissionBroker } from "../src/workflow-permissions.js";
import { connect, makeRunner, structured } from "./_harness.js";

const SCRIPT = [
  'export const meta = { name: "permission-tool", description: "permission tool coverage" };',
  'return await agent("work", { label: "worker", model: "codex" });',
].join("\n");

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}

test("a foreground call returns action-required without abandoning its live run", async () => {
  const broker = new WorkflowPermissionBroker();
  const runner = makeRunner(async (_prompt, options) => {
    await broker.resolver(
      {
        sessionId: "foreground-session",
        toolCall: { toolCallId: "foreground-tool", title: "Run tests", kind: "execute" },
        options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
      },
      {
        sessionId: "foreground-session",
        backendId: "codex",
        runId: options.runId,
        callIndex: options.callIndex,
      },
    );
    return "done";
  });
  const connected = await connect(runner, { listTools: true, permissionBroker: broker });
  try {
    const result = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { script: SCRIPT },
    }));
    assert.equal(result.status, "running");
    assert.equal((result.pendingPermissions as unknown[]).length, 1);
    const runId = result.runId as string;
    const pending = broker.list(runId)[0]!;
    broker.respond(runId, pending.permissionId, { outcome: { outcome: "cancelled" } });
    const completed = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 2_000 },
    }));
    assert.equal(completed.status, "completed");
    assert.equal((completed.outcome as Record<string, unknown>).result, "done");
  } finally {
    await connected.dispose();
    broker.dispose();
  }
});

test("status exposes a live permission and permissions-response resumes the workflow", async () => {
  const broker = new WorkflowPermissionBroker();
  const runner = makeRunner(async (_prompt, options) => {
    const outcome = await broker.resolver(
      {
        sessionId: "codex-session",
        toolCall: {
          toolCallId: "command-1",
          title: "Run tests",
          kind: "execute",
          rawInput: { command: "pnpm test" },
        },
        options: [
          { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
          { optionId: "decline", name: "Continue without running", kind: "reject_once" },
          { optionId: "cancel", name: "Stop and revise the action", kind: "reject_once" },
        ],
      },
      {
        sessionId: "codex-session",
        backendId: "codex",
        runId: options.runId,
        callIndex: options.callIndex,
        label: options.label,
      },
    );
    return outcome.outcome.outcome === "selected" ? `selected:${outcome.outcome.optionId}` : "cancelled";
  });
  const connected = await connect(runner, { listTools: true, permissionBroker: broker });
  try {
    const started = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { script: SCRIPT, background: true },
    }));
    const runId = started.runId as string;
    await eventually(() => broker.has(runId));

    const inspected = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    }));
    const permissions = inspected.pendingPermissions as Array<Record<string, unknown>>;
    assert.equal(permissions.length, 1);
    const permissionId = permissions[0]?.permissionId as string;
    assert.equal(inspected.status, "running");
    assert.equal((inspected.interaction as Record<string, unknown>).respondWith, "permissions-response");

    const responded = structured(await connected.client.callTool({
      name: "workflow",
      arguments: {
        action: "permissions-response",
        runId,
        permissionId,
        response: { outcome: { outcome: "selected", optionId: "cancel" } },
      },
    }));
    assert.equal((responded.permissionResponse as Record<string, unknown>).permissionId, permissionId);

    const awaited = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 2_000 },
    }));
    assert.equal(awaited.status, "completed");
    assert.equal((awaited.outcome as Record<string, unknown>).result, "selected:cancel");
  } finally {
    await connected.dispose();
    broker.dispose();
  }
});

test("elicitation-capable status presents the exact options and resumes the agent", async () => {
  const broker = new WorkflowPermissionBroker();
  const runner = makeRunner(async (_prompt, options) => {
    const outcome = await broker.resolver(
      {
        sessionId: "s-elicit",
        toolCall: { toolCallId: "t-elicit", title: "Run a command", kind: "execute" },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_for_session", name: "Allow for session", kind: "allow_always" },
        ],
      },
      { sessionId: "s-elicit", backendId: "codex", runId: options.runId, callIndex: options.callIndex },
    );
    return outcome.outcome.outcome === "selected" ? outcome.outcome.optionId : "cancelled";
  });
  const connected = await connect(runner, { permissionBroker: broker, elicitation: true });
  connected.client.setRequestHandler("elicitation/create", async (request) => {
    const schema = request.params.requestedSchema as {
      required?: string[];
      properties?: Record<string, { enum?: string[]; oneOf?: Array<{ const: string }> }>;
    };
    if (schema.properties?.optionId) {
      assert.deepEqual(schema.properties.optionId.enum, ["allow_once", "allow_for_session"]);
      return { action: "accept" as const, content: { optionId: "allow_for_session" } };
    }
    const content = Object.fromEntries((schema.required ?? []).map((field) => {
      const selected = schema.properties?.[field]?.oneOf?.[0]?.const;
      assert.ok(selected);
      return [field, selected];
    }));
    return { action: "accept" as const, content };
  });
  try {
    const started = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { script: SCRIPT, background: true },
    }));
    const runId = started.runId as string;
    await eventually(() => broker.has(runId));

    const inspected = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    }));
    assert.equal((inspected.permissionResponse as Record<string, unknown>).runId, runId);
    assert.deepEqual(inspected.pendingPermissions, []);

    const awaited = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 2_000 },
    }));
    assert.equal((awaited.outcome as Record<string, unknown>).result, "allow_for_session");
  } finally {
    await connected.dispose();
    broker.dispose();
  }
});

test("the real ACP client, broker, and MCP tool preserve a same-kind Codex choice end to end", async () => {
  const fakeAgent = resolve(import.meta.dirname, "../../acp-agents/test/fixtures/fake-acp-agent.mjs");
  const tempDir = await mkdtemp(join(tmpdir(), "agentprism-permission-choice-"));
  const logPath = join(tempDir, "fake-agent.jsonl");
  const previous = {
    command: process.env.AGENTPRISM_CODEX_ACP_CMD,
    args: process.env.AGENTPRISM_CODEX_ACP_ARGS,
    scenario: process.env.AGENTPRISM_FAKE_SCENARIO,
    log: process.env.AGENTPRISM_FAKE_LOG,
  };
  process.env.AGENTPRISM_CODEX_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CODEX_ACP_ARGS = fakeAgent;
  process.env.AGENTPRISM_FAKE_LOG = logPath;
  process.env.AGENTPRISM_FAKE_SCENARIO = JSON.stringify({
    configOptions: [],
    modes: {
      currentModeId: "read-only",
      availableModes: [{ id: "agent", name: "Approve for me" }],
    },
    turns: [{
      toolCall: {
        title: "Run command",
        kind: "execute",
        options: [
          { optionId: "allow_once", name: "Run", kind: "allow_once" },
          { optionId: "decline", name: "Continue without it", kind: "reject_once" },
          { optionId: "cancel", name: "Stop and revise", kind: "reject_once" },
        ],
      },
      text: "provider-finished",
    }],
  });

  const broker = new WorkflowPermissionBroker();
  const runner = createAcpRunner({
    onPermissionRequest: broker.resolver,
    enforceToolPolicyBeforePermissionResolver: true,
  });
  broker.attach(runner);
  const connected = await connect(runner, { permissionBroker: broker });
  try {
    const started = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { script: SCRIPT, background: true },
    }));
    const runId = started.runId as string;
    await eventually(() => broker.has(runId));

    const inspected = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    }));
    const [permission] = inspected.pendingPermissions as Array<{
      permissionId: string;
      request: { options: Array<{ optionId: string }> };
    }>;
    assert.ok(permission);
    assert.deepEqual(
      permission.request.options.map(({ optionId }) => optionId),
      ["allow_once", "decline", "cancel"],
    );
    await connected.client.callTool({
      name: "workflow",
      arguments: {
        action: "permissions-response",
        runId,
        permissionId: permission.permissionId,
        response: { outcome: { outcome: "selected", optionId: "cancel" } },
      },
    });
    const terminal = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 3_000 },
    }));
    assert.equal((terminal.outcome as Record<string, unknown>).result, "provider-finished");
    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; outcome?: unknown });
    assert.deepEqual(
      records.find(({ method }) => method === "permissionOutcome")?.outcome,
      { outcome: "selected", optionId: "cancel" },
    );
  } finally {
    await connected.dispose();
    broker.dispose();
    await runner.dispose();
    if (previous.command === undefined) delete process.env.AGENTPRISM_CODEX_ACP_CMD;
    else process.env.AGENTPRISM_CODEX_ACP_CMD = previous.command;
    if (previous.args === undefined) delete process.env.AGENTPRISM_CODEX_ACP_ARGS;
    else process.env.AGENTPRISM_CODEX_ACP_ARGS = previous.args;
    if (previous.scenario === undefined) delete process.env.AGENTPRISM_FAKE_SCENARIO;
    else process.env.AGENTPRISM_FAKE_SCENARIO = previous.scenario;
    if (previous.log === undefined) delete process.env.AGENTPRISM_FAKE_LOG;
    else process.env.AGENTPRISM_FAKE_LOG = previous.log;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("status returns early with action-required instead of waiting for its full bound", async () => {
  const broker = new WorkflowPermissionBroker();
  const runner = makeRunner(async (_prompt, options) => {
    await broker.resolver(
      {
        sessionId: "s",
        toolCall: { toolCallId: "t", title: "Needs approval", kind: "execute" },
        options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
      },
      { sessionId: "s", backendId: "codex", runId: options.runId, callIndex: options.callIndex },
    );
    return "done";
  });
  const connected = await connect(runner, { permissionBroker: broker });
  try {
    const started = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { script: SCRIPT, background: true },
    }));
    const runId = started.runId as string;
    const before = Date.now();
    const awaited = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId, waitMs: 2_000 },
    }));
    assert.equal((awaited.wait as Record<string, unknown>).returnedBecause, "action-required");
    assert.ok(Date.now() - before < 1_000);
    assert.equal((awaited.pendingPermissions as unknown[]).length, 1);
    const pending = broker.list(runId)[0]!;
    broker.respond(runId, pending.permissionId, { outcome: { outcome: "cancelled" } });
  } finally {
    await connected.dispose();
    broker.dispose();
  }
});
