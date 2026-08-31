import test from "node:test";
import assert from "node:assert/strict";

import type { AcpPermissionEvent, RequestPermissionRequest } from "@automatalabs/workflows";
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

test("unadvertised options and response metadata fail closed without settling the live request", async () => {
  const broker = new WorkflowPermissionBroker();
  const response = Promise.resolve(broker.resolver(request(), context));
  const pending = broker.list(context.runId)[0]!;

  assert.throws(
    () => broker.respond(context.runId, pending.permissionId, {
      outcome: { outcome: "selected", optionId: "invented" },
    }),
    /was not advertised/,
  );
  assert.throws(
    () => broker.respond(context.runId, pending.permissionId, {
      outcome: { outcome: "selected", optionId: "allow_once" },
      _meta: { persist: "always" },
    }),
    /Invalid workflow permission response/,
  );
  assert.equal(broker.has(context.runId, pending.permissionId), true);

  broker.respond(context.runId, pending.permissionId, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(await response, { outcome: { outcome: "cancelled" } });
});

test("the public request stays redacted and below 64 KiB without losing ordered exact options", async () => {
  const broker = new WorkflowPermissionBroker();
  const noisyMeta = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`diagnostic${index}`, `value-${index}-${"x".repeat(2_000)}`]),
  );
  const options = Array.from({ length: 16 }, (_, index) => ({
    optionId: `choice_${index}`,
    name: `Choice ${index} ${"n".repeat(2_000)}`,
    kind: (index % 2 === 0 ? "allow_once" : "reject_once") as "allow_once" | "reject_once",
    _meta: noisyMeta,
  }));
  const sensitive = request(options);
  sensitive.toolCall.title = "Deploy with Bearer sk-proj-abcdefgh12345678";
  sensitive.toolCall.rawInput = {
    command: "deploy --authorization=Bearer sk-proj-abcdefgh12345678",
    apiKey: "sk-proj-abcdefgh12345678",
  };
  options[0]!.name = "Use sk-proj-abcdefgh12345678";
  sensitive._meta = { ...noisyMeta, password: "do-not-expose" };

  const response = Promise.resolve(broker.resolver(sensitive, context));
  const pending = broker.list(context.runId)[0]!;
  const serialized = JSON.stringify(pending.request);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 64 * 1024);
  assert.equal(pending.requestTruncated, true);
  assert.equal(pending.requestRedacted, true);
  assert.equal("sessionId" in pending.request, false);
  assert.doesNotMatch(serialized, /do-not-expose|sk-proj-abcdefgh12345678/);
  assert.deepEqual(
    pending.request.options.map((option) => option.optionId),
    options.map((option) => option.optionId),
  );

  broker.respond(context.runId, pending.permissionId, {
    outcome: { outcome: "selected", optionId: "choice_15" },
  });
  assert.deepEqual(await response, { outcome: { outcome: "selected", optionId: "choice_15" } });
});

test("requests that cannot preserve a safe complete option set are cancelled instead of parked", async () => {
  const broker = new WorkflowPermissionBroker();
  const tooMany = Array.from({ length: 17 }, (_, index) => ({
    optionId: `choice_${index}`,
    name: `Choice ${index}`,
    kind: "allow_once" as const,
  }));
  assert.deepEqual(await broker.resolver(request(tooMany), context), {
    outcome: { outcome: "cancelled" },
  });
  assert.deepEqual(broker.list(context.runId), []);
});

test("final ACP cancellation observed through attach clears and settles the parked request", async () => {
  const broker = new WorkflowPermissionBroker();
  let listener: ((event: AcpPermissionEvent) => void) | undefined;
  broker.attach({
    on(_name, next) {
      listener = next;
      return () => { listener = undefined; };
    },
  });
  const permissionRequest = request();
  const response = Promise.resolve(broker.resolver(permissionRequest, context));
  assert.equal(broker.list(context.runId).length, 1);

  listener?.({
    ...context,
    request: permissionRequest,
    outcome: { outcome: { outcome: "cancelled" } },
  });
  assert.deepEqual(await response, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(broker.list(context.runId), []);
});

test("attach replaces the prior event subscription and dispose detaches the current one", () => {
  const broker = new WorkflowPermissionBroker();
  const detached: string[] = [];
  broker.attach({
    on() {
      return () => { detached.push("first"); };
    },
  });
  broker.attach({
    on() {
      return () => { detached.push("second"); };
    },
  });
  assert.deepEqual(detached, ["first"]);
  broker.dispose();
  assert.deepEqual(detached, ["first", "second"]);
});

test("non-workflow runner calls retain autonomous auto-response behavior", async () => {
  const broker = new WorkflowPermissionBroker();
  assert.deepEqual(
    await broker.resolver(request(), { sessionId: "session-1", backendId: "codex", runId: "c1" }),
    { outcome: { outcome: "selected", optionId: "allow_once" } },
  );
  assert.deepEqual(broker.list(context.runId), []);
});
