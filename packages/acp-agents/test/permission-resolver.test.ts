// Deferred ACP permission resolution: exercise the internal multiplexer through the public pool
// seam and the fake ACP agent. These tests pin resolver precedence, final-outcome events, and
// teardown settlement without exporting MultiplexClient.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  AcpAgentPool,
  ClaudeBackend,
  type AcpEventSink,
  type AcpPermissionEvent,
  type AcpPoolDeps,
  type PermissionResolver,
  type ToolPolicy,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const REJECT: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "reject-1" } };
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

const TEST_ENV_VARS = [
  "AGENTPRISM_CLAUDE_ACP_CMD",
  "AGENTPRISM_CLAUDE_ACP_ARGS",
  "AGENTPRISM_FAKE_LOG",
  "AGENTPRISM_FAKE_SCENARIO",
];

interface LogEntry {
  method: string;
  outcome?: RequestPermissionResponse["outcome"];
}

interface RecordedEvent {
  name: string;
  event: unknown;
}

const pools: AcpAgentPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
  for (const key of TEST_ENV_VARS) delete process.env[key];
});

function configure(scenario: unknown): { cwd: string; readLog: () => LogEntry[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-perm-resolver-"));
  const log = path.join(dir, "log.jsonl");
  process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FIXTURE;
  process.env.AGENTPRISM_FAKE_LOG = log;
  process.env.AGENTPRISM_FAKE_SCENARIO = JSON.stringify(scenario);
  return {
    cwd: dir,
    readLog: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LogEntry)
        : [],
  };
}

function makePool(deps: AcpPoolDeps): AcpAgentPool {
  const pool = new AcpAgentPool({}, deps);
  pools.push(pool);
  return pool;
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function withTimeout<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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

test("without a resolver the synchronous ToolPolicy path still decides immediately", async () => {
  const { readLog } = await runOnePermissionTurn({ policy: { deny: ["bash"] } });

  assert.deepEqual(permissionOutcome(readLog()), REJECT.outcome);
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
