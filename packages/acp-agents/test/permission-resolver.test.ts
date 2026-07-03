// Deferred ACP permission resolution: exercise the internal multiplexer through the public pool
// seam and the fake ACP agent. These tests pin resolver precedence, final-outcome events, and
// teardown settlement without exporting MultiplexClient.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  AcpAgentPool,
  ClaudeBackend,
  type AcpEventSink,
  type AcpPermissionPendingEvent,
  type AcpPermissionEvent,
  type AcpPoolDeps,
  type PermissionResolver,
  type ToolPolicy,
} from "../src/index.js";
import { createFakeAgentHarness, waitFor, withTimeout } from "./helpers/fake-agent.js";

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const REJECT: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "reject-1" } };
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

interface LogEntry {
  method: string;
  outcome?: RequestPermissionResponse["outcome"];
}

interface RecordedEvent {
  name: string;
  event: unknown;
}

const harness = createFakeAgentHarness({ prefix: "acp-perm-resolver-", backends: ["claude"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

function makePool(deps: AcpPoolDeps): AcpAgentPool {
  return harness.track(new AcpAgentPool({}, deps));
}

function eventSink(events: RecordedEvent[]): AcpEventSink {
  return (name, event) => {
    events.push({ name, event });
  };
}

function permissionEvents(events: RecordedEvent[]): AcpPermissionEvent[] {
  return events
    .filter((entry) => entry.name === "permission_request")
    .map((entry) => entry.event as AcpPermissionEvent);
}

function pendingEvents(events: RecordedEvent[]): AcpPermissionPendingEvent[] {
  return events
    .filter((entry) => entry.name === "permission_pending")
    .map((entry) => entry.event as AcpPermissionPendingEvent);
}

function permissionOutcome(log: LogEntry[]): RequestPermissionResponse["outcome"] | undefined {
  return log.find((entry) => entry.method === "permissionOutcome")?.outcome;
}

async function runOnePermissionTurn(options: {
  poolResolver?: PermissionResolver;
  sessionResolver?: PermissionResolver;
  policy?: ToolPolicy;
  events?: RecordedEvent[];
}): Promise<{ readLog: () => LogEntry[] }> {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Run Bash", kind: "execute" }, text: "done" }],
  });
  const pool = makePool({
    permissionResolver: options.poolResolver,
    onEvent: options.events ? eventSink(options.events) : undefined,
  });
  const session = await pool.acquire(new ClaudeBackend(), {
    cwd,
    schema: undefined,
    policy: options.policy ?? {},
    permissionResolver: options.sessionResolver,
  });
  try {
    await session.prompt("hi");
  } finally {
    await session.release();
  }
  return { readLog };
}

afterEach(async () => {
  await harness.cleanup();
});

test("session permissionResolver wins over runner resolver and ToolPolicy", async () => {
  const events: RecordedEvent[] = [];
  const { readLog } = await runOnePermissionTurn({
    poolResolver: () => REJECT,
    sessionResolver: () => ALLOW,
    policy: { deny: ["bash"] },
    events,
  });

  assert.deepEqual(permissionOutcome(readLog()), ALLOW.outcome);
  assert.deepEqual(permissionEvents(events).map((event) => event.outcome), [ALLOW]);
});

test("runner permissionResolver wins over ToolPolicy when no session resolver is set", async () => {
  const { readLog } = await runOnePermissionTurn({
    poolResolver: () => ALLOW,
    policy: { deny: ["bash"] },
  });

  assert.deepEqual(permissionOutcome(readLog()), ALLOW.outcome);
});

test("resolver path emits permission_pending before the final permission_request", async () => {
  const events: RecordedEvent[] = [];
  const { readLog } = await runOnePermissionTurn({
    poolResolver: () => ALLOW,
    policy: { deny: ["bash"] },
    events,
  });

  assert.deepEqual(permissionOutcome(readLog()), ALLOW.outcome);
  assert.deepEqual(
    events
      .filter((entry) => entry.name === "permission_pending" || entry.name === "permission_request")
      .map((entry) => entry.name),
    ["permission_pending", "permission_request"],
  );
  assert.equal(pendingEvents(events).length, 1);
  assert.equal("outcome" in (pendingEvents(events)[0] as unknown as Record<string, unknown>), false);
  assert.deepEqual(permissionEvents(events).map((event) => event.outcome), [ALLOW]);
});

test("without a resolver the synchronous ToolPolicy path still decides immediately", async () => {
  const events: RecordedEvent[] = [];
  const { readLog } = await runOnePermissionTurn({ policy: { deny: ["bash"] }, events });

  assert.deepEqual(permissionOutcome(readLog()), REJECT.outcome);
  assert.deepEqual(pendingEvents(events), []);
  assert.deepEqual(permissionEvents(events).map((event) => event.outcome), [REJECT]);
});

test("retainSessionLog:false keeps only the current turn text and history", async () => {
  const { cwd } = configure({ turns: [{ text: "one" }, { text: "two" }] });
  const pool = makePool({});
  const session = await pool.acquire(new ClaudeBackend(), {
    cwd,
    schema: undefined,
    policy: {},
    retainSessionLog: false,
  });

  try {
    await session.prompt("first");
    assert.equal(session.currentTurnText(), "one");
    assert.deepEqual(
      session.history.map((entry) => entry.text),
      ["one"],
    );

    await session.prompt("second");
    assert.equal(session.currentTurnText(), "two");
    assert.deepEqual(
      session.history.map((entry) => entry.text),
      ["two"],
    );
  } finally {
    await session.release();
  }
});

test("resolver-selected reject outcomes are honored and emitted once", async () => {
  const events: RecordedEvent[] = [];
  const { readLog } = await runOnePermissionTurn({ poolResolver: () => REJECT, events });

  assert.deepEqual(permissionOutcome(readLog()), REJECT.outcome);
  assert.deepEqual(permissionEvents(events).map((event) => event.outcome), [REJECT]);
});

test("resolver rejection settles the permission as cancelled", async () => {
  const events: RecordedEvent[] = [];
  const { readLog } = await runOnePermissionTurn({
    poolResolver: async () => {
      throw new Error("resolver failed");
    },
    events,
  });

  assert.deepEqual(permissionOutcome(readLog()), CANCELLED.outcome);
  assert.deepEqual(permissionEvents(events).map((event) => event.outcome), [CANCELLED]);
});

test("release settles a parked permission as cancelled; late resolver rejection is ignored", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const { cwd, readLog } = configure({
      turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "done" }],
    });
    const events: RecordedEvent[] = [];
    let rejectResolver!: (reason: unknown) => void;
    let markResolverCalled!: () => void;
    const resolverCalled = new Promise<void>((resolve) => {
      markResolverCalled = resolve;
    });
    const pool = makePool({
      onEvent: eventSink(events),
      permissionResolver: () => {
        markResolverCalled();
        return new Promise<RequestPermissionResponse>((_resolve, reject) => {
          rejectResolver = reject;
        });
      },
    });
    const session = await pool.acquire(new ClaudeBackend(), {
      cwd,
      schema: undefined,
      policy: {},
    });
    const prompt = session.prompt("hi");
    prompt.catch(() => {});

    await resolverCalled;
    await session.release();
    await waitFor(() => permissionOutcome(readLog())?.outcome === "cancelled");
    rejectResolver(new Error("late resolver rejection"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(permissionOutcome(readLog()), CANCELLED.outcome);
    assert.deepEqual(permissionEvents(events).map((event) => event.outcome), [CANCELLED]);
    assert.deepEqual(unhandled, []);
    await withTimeout(prompt);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
