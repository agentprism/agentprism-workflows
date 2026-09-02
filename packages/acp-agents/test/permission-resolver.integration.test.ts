// End-to-end deferred permission resolution against the fake ACP agent. The fake requests
// permission mid-turn; the runner parks that client handler until the configured resolver settles
// or until abort teardown answers the request as ACP "cancelled".
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { AcpAgentRunner, type AcpPermissionEvent, type AcpRunnerOptions } from "../src/index.js";
import { createFakeAgentHarness, delay, waitFor, withTimeout } from "./helpers/fake-agent.js";

const MODEL = "claude";
const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

interface LogEntry {
  method: string;
  outcome?: RequestPermissionResponse["outcome"];
  params?: { sessionId?: string };
}

const harness = createFakeAgentHarness({ prefix: "acp-perm-resolver-it-", backends: ["claude"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

function makeRunner(options: AcpRunnerOptions): AcpAgentRunner {
  return harness.makeRunner(options);
}

afterEach(async () => {
  await harness.cleanup();
});

function permissionOutcome(log: LogEntry[]): RequestPermissionResponse["outcome"] | undefined {
  return log.find((entry) => entry.method === "permissionOutcome")?.outcome;
}

test("runner-level resolver can approve after a delay and the turn proceeds", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "done" }],
  });
  const permissionEvents: AcpPermissionEvent[] = [];
  const resolverContexts: Array<{ label?: string; runId?: string; sessionId: string }> = [];
  const runner = makeRunner({
    onPermissionRequest: async (_params, ctx) => {
      resolverContexts.push({ sessionId: ctx.sessionId, label: ctx.label, runId: ctx.runId });
      await delay(30);
      return ALLOW;
    },
  });
  runner.on("permission_request", (event) => permissionEvents.push(event));

  const out = await runner.run("do it", {
    model: MODEL,
    cwd,
    label: "interactive",
    runId: "run-perm-1",
  });

  assert.equal(out, "done");
  assert.deepEqual(permissionOutcome(readLog()), ALLOW.outcome);
  assert.equal(resolverContexts.length, 1);
  assert.equal(resolverContexts[0].label, "interactive");
  assert.equal(resolverContexts[0].runId, "run-perm-1");
  assert.deepEqual(permissionEvents.map((event) => event.outcome), [ALLOW]);
});

test("an explicit tool deny settles before the live resolver", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "denied" }],
  });
  let resolverCalls = 0;
  const runner = makeRunner({
    onPermissionRequest: () => {
      resolverCalls += 1;
      return ALLOW;
    },
    enforceToolPolicyBeforePermissionResolver: true,
  });
  assert.equal(await runner.run("do it", {
    model: MODEL,
    cwd,
    disallowedToolNames: ["read"],
  }), "denied");
  assert.equal(resolverCalls, 0);
  assert.deepEqual(permissionOutcome(readLog()), { outcome: "selected", optionId: "reject-1" });
});

test("pending runner-level resolver is answered cancelled when the run is aborted", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "after cancel" }],
  });
  let markResolverCalled!: () => void;
  const resolverCalled = new Promise<void>((resolve) => {
    markResolverCalled = resolve;
  });
  const permissionEvents: AcpPermissionEvent[] = [];
  const runner = makeRunner({
    onPermissionRequest: () => {
      markResolverCalled();
      return new Promise<RequestPermissionResponse>(() => {});
    },
  });
  runner.on("permission_request", (event) => permissionEvents.push(event));

  const controller = new AbortController();
  const running = withTimeout(
    runner.run("do it", { model: MODEL, cwd, signal: controller.signal }),
    2500,
  );
  await resolverCalled;
  controller.abort();

  await assert.rejects(() => running);
  await waitFor(() => permissionOutcome(readLog())?.outcome === "cancelled");

  assert.deepEqual(permissionOutcome(readLog()), CANCELLED.outcome);
  assert.deepEqual(permissionEvents.map((event) => event.outcome), [CANCELLED]);
  assert.ok(readLog().some((entry) => entry.method === "cancel"), "session/cancel reached the agent");
});
