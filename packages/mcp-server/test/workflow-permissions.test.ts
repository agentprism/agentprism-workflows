import test from "node:test";
import assert from "node:assert/strict";

import type { RequestPermissionRequest } from "@automatalabs/workflows";
import { WorkflowPermissionBroker } from "../src/workflow-permissions.js";

function request(options = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" as const },
  { optionId: "allow_for_session", name: "Allow for session", kind: "allow_always" as const },
  { optionId: "cancel", name: "Cancel", kind: "reject_once" as const },
]): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      title: "Run pnpm test",
      kind: "execute",
      rawInput: { command: "pnpm test" },
    },
    options,
  };
}

const context = {
  sessionId: "session-1",
  backendId: "codex",
  runId: "mte00000-abcd12",
  callIndex: 3,
  label: "test-runner",
};

test("workflow permission broker parks and resolves an exact advertised option", async () => {
  const broker = new WorkflowPermissionBroker();
  const response = Promise.resolve(broker.resolver(request(), context));

  const pending = broker.list(context.runId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.callIndex, 3);
  assert.equal(pending[0]?.backendId, "codex");
  assert.deepEqual(pending[0]?.request.options.map((option) => option.optionId), [
    "allow_once",
    "allow_for_session",
    "cancel",
  ]);

  const acknowledgement = broker.respond(context.runId, pending[0]!.permissionId, {
    outcome: { outcome: "selected", optionId: "allow_for_session" },
  });
  assert.deepEqual(await response, {
    outcome: { outcome: "selected", optionId: "allow_for_session" },
  });
  assert.equal(acknowledgement.callIndex, 3);
  assert.equal(broker.list(context.runId).length, 0);
});

test("an unadvertised option fails closed without settling the live request", async () => {
  const broker = new WorkflowPermissionBroker();
  const response = Promise.resolve(broker.resolver(request(), context));
  const pending = broker.list(context.runId)[0]!;

  assert.throws(
    () => broker.respond(context.runId, pending.permissionId, {
      outcome: { outcome: "selected", optionId: "invented" },
    }),
    /was not advertised/,
  );
  assert.equal(broker.has(context.runId, pending.permissionId), true);

  broker.respond(context.runId, pending.permissionId, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(await response, { outcome: { outcome: "cancelled" } });
});

test("non-workflow runner calls retain autonomous auto-response behavior", async () => {
  const broker = new WorkflowPermissionBroker();
  assert.deepEqual(
    await broker.resolver(request(), { sessionId: "session-1", backendId: "codex", runId: "c1" }),
    { outcome: { outcome: "selected", optionId: "allow_once" } },
  );
  assert.deepEqual(broker.list(context.runId), []);
});
