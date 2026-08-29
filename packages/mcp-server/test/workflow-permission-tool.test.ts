import test from "node:test";
import assert from "node:assert/strict";

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
  } finally {
    await connected.dispose();
    broker.dispose();
  }
});

test("inspect exposes a live permission and permissions-response resumes the workflow", async () => {
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
          { optionId: "allow_for_session", name: "Allow for session", kind: "allow_always" },
          { optionId: "cancel", name: "Cancel", kind: "reject_once" },
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
      arguments: { action: "inspect", runId },
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
        response: { outcome: { outcome: "selected", optionId: "allow_for_session" } },
      },
    }));
    assert.equal((responded.permissionResponse as Record<string, unknown>).permissionId, permissionId);

    const awaited = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 2_000 },
    }));
    assert.equal(awaited.status, "completed");
    assert.equal((awaited.outcome as Record<string, unknown>).result, "selected:allow_for_session");
  } finally {
    await connected.dispose();
    broker.dispose();
  }
});

test("an elicitation-capable inspect presents the exact options and resumes the agent", async () => {
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
    const schema = request.params.requestedSchema as { properties?: { optionId?: { enum?: string[] } } };
    assert.deepEqual(schema.properties?.optionId?.enum, ["allow_once", "allow_for_session"]);
    return { action: "accept", content: { optionId: "allow_for_session" } };
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
      arguments: { action: "inspect", runId },
    }));
    assert.equal((inspected.permissionResponse as Record<string, unknown>).runId, runId);
    assert.deepEqual(inspected.pendingPermissions, []);

    const awaited = structured(await connected.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 2_000 },
    }));
    assert.equal((awaited.outcome as Record<string, unknown>).result, "allow_for_session");
  } finally {
    await connected.dispose();
    broker.dispose();
  }
});

test("await returns early with action-required instead of waiting for its full bound", async () => {
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
      arguments: { action: "await", runId, waitMs: 2_000 },
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
