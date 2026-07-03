// End-to-end deferred permission resolution against the fake ACP agent. The fake requests
// permission mid-turn; the runner parks that client handler until the configured resolver settles
// or until abort teardown answers the request as ACP "cancelled".
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { AcpAgentRunner, type AcpPermissionEvent, type AcpRunnerOptions } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const MODEL = "claude";
const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

const TEST_ENV_VARS = [
  "AGENTPRISM_CLAUDE_ACP_CMD",
  "AGENTPRISM_CLAUDE_ACP_ARGS",
  "AGENTPRISM_FAKE_LOG",
  "AGENTPRISM_FAKE_SCENARIO",
  "AGENTPRISM_DEFAULT_BACKEND",
];

interface LogEntry {
  method: string;
  outcome?: RequestPermissionResponse["outcome"];
  params?: { sessionId?: string };
}

const runners: AcpAgentRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  for (const key of TEST_ENV_VARS) delete process.env[key];
});

function configure(scenario: unknown): { cwd: string; readLog: () => LogEntry[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-perm-resolver-it-"));
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

function makeRunner(options: AcpRunnerOptions): AcpAgentRunner {
  const runner = new AcpAgentRunner(options);
  runners.push(runner);
  return runner;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await delay(10);
  }
}

function withTimeout<T>(promise: Promise<T>, ms = 2500): Promise<T> {
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
    disallowedToolNames: ["read"],
  });

  assert.equal(out, "done");
  assert.deepEqual(permissionOutcome(readLog()), ALLOW.outcome);
  assert.equal(resolverContexts.length, 1);
  assert.equal(resolverContexts[0].label, "interactive");
  assert.equal(resolverContexts[0].runId, "run-perm-1");
  assert.deepEqual(permissionEvents.map((event) => event.outcome), [ALLOW]);
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
