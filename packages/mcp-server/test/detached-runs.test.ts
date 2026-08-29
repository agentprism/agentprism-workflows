import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { ElicitRequest, ElicitResult, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { AgentUsage, RunOptions } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode, WorkflowManager } from "@automatalabs/workflows";
import { createWorkflowServer, MAX_BACKGROUND_RUNS } from "../src/index.js";
import {
  connect,
  makeRunner,
  NO_AGENT_SCRIPT,
  persistedRunFile,
  structured,
  textOf,
  type ToolCallResult,
} from "./_harness.js";

class ControlledRunner {
  readonly calls: Array<{
    prompt: string;
    options: RunOptions;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  readonly runner = makeRunner(
    (prompt, options) =>
      new Promise((resolve, reject) => {
        this.calls.push({ prompt, options, resolve, reject });
      }),
  );

  resolve(index: number, value: unknown, usage?: AgentUsage): void {
    const call = this.calls[index];
    assert.ok(call, `runner call ${index} should exist`);
    if (usage) call.options.onUsage?.(usage);
    call.resolve(value);
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function runIdOf(result: ToolCallResult): string {
  const runId = structured(result)?.runId;
  assert.equal(typeof runId, "string");
  return runId;
}

const TWO_AGENT_BACKGROUND = [
  'export const meta = { name: "detached-review", description: "detached", phases: [{ title: "Explore" }, { title: "Review" }] };',
  'phase("Explore");',
  'log("exploration started");',
  'const first = await agent("first", { label: "explore" });',
  'phase("Review");',
  'log("review started");',
  'const second = await agent("second", { label: "review" });',
  'return { first, second };',
].join("\n");

const EXPECTED_LIMITS = {
  maxAgents: 1_000,
  tokenBudget: null,
  concurrency: 3,
  agentRetries: 1,
  agentTimeoutMs: 50_000,
  agentIdleTimeoutMs: null,
} as const;

test("background acceptance is immediate and await reports immediate, timeout, cancellation, partial usage, and terminal outcome", async () => {
  const controlled = new ControlledRunner();
  const { client, server, dispose } = await connect(controlled.runner, { listTools: true });
  try {
    const initiating = new AbortController();
    const accepted = await client.callTool(
      {
        name: "workflow",
        arguments: {
          script: TWO_AGENT_BACKGROUND,
          background: true,
          concurrency: 3,
          agentRetries: 1,
          agentTimeoutMs: 50_000,
        },
      },
      { signal: initiating.signal },
    );
    const acceptedRunId = runIdOf(accepted);
    assert.deepEqual(structured(accepted), {
      runId: acceptedRunId,
      status: "running",
      scriptSource: "inline",
      scriptUri: `workflow://runs/${acceptedRunId}/script`,
      limits: EXPECTED_LIMITS,
    });
    assert.equal(
      textOf(accepted),
      `Workflow "detached-review" started in the background.\n` +
        `runId: ${acceptedRunId}\n` +
        `Call workflow with action="await" and this runId to wait for its result, or ` +
        `action="inspect" for an immediate status snapshot. If a live run-monitor panel ` +
        `is shown for this run, it self-updates and reports phase starts, pauses, and terminal outcomes — ` +
        `do not poll inspect for status.`,
    );
    assert.equal(controlled.calls.length, 1);
    initiating.abort();
    assert.equal(controlled.calls[0].options.signal?.aborted, false, "initiating-call cancellation is detached");

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: acceptedRunId },
    });
    assert.deepEqual(structured(inspected)?.limits, EXPECTED_LIMITS);

    const immediate = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: acceptedRunId, waitMs: 0 },
    });
    assert.equal(structured(immediate)?.wait && field(structured(immediate)?.wait, "returnedBecause"), "immediate");
    assert.equal(structured(immediate)?.outcome, undefined);
    assert.equal(structured(immediate)?.tokenUsage, undefined);
    assert.deepEqual(structured(immediate)?.limits, EXPECTED_LIMITS);

    controlled.resolve(0, { files: ["src/auth.ts"] }, {
      input: 10,
      output: 5,
      total: 15,
      cost: 0.1,
      cacheRead: 2,
      cacheWrite: 0,
    });
    await waitUntil(() => controlled.calls.length === 2, "the second agent should start");
    const partial = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: acceptedRunId, waitMs: 0, labelGlob: "expl*", lastN: 1, logLines: 2 },
    });
    const partialStatus = structured(partial);
    assert.equal(field(partialStatus?.wait, "returnedBecause"), "immediate");
    assert.equal(field(partialStatus?.tokenUsage, "total"), 15);
    assert.equal((partialStatus?.calls as Array<Record<string, unknown>>)[0]?.label, "explore");
    assert.equal(partialStatus?.currentPhase, "Review");
    assert.ok((field(partialStatus?.logTail, "lines") as string[]).includes("review started"));
    assert.equal(partialStatus?.outcome, undefined);
    assert.deepEqual(partialStatus?.limits, EXPECTED_LIMITS);

    const timed = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: acceptedRunId, waitMs: 15 },
    });
    assert.equal(field(structured(timed)?.wait, "requestedMs"), 15);
    assert.equal(field(structured(timed)?.wait, "returnedBecause"), "timeout");
    assert.ok(Number(field(structured(timed)?.wait, "elapsedMs")) >= 0);
    assert.deepEqual(structured(timed)?.limits, EXPECTED_LIMITS);

    type DirectHandler = (
      args: Record<string, unknown>,
      ctx: { mcpReq: { signal: AbortSignal } },
    ) => Promise<{ structuredContent?: unknown; content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    const registered = server as unknown as {
      _registeredTools: Record<string, { handler: DirectHandler }>;
    };
    const awaitController = new AbortController();
    const cancelledPromise = registered._registeredTools.workflow.handler(
      { action: "await", runId: acceptedRunId, waitMs: 25_000 },
      { mcpReq: { signal: awaitController.signal } },
    );
    awaitController.abort();
    const cancelled = await cancelledPromise;
    assert.equal(cancelled.isError, true);
    assert.equal(cancelled.structuredContent, undefined);
    assert.equal(
      cancelled.content[0]?.text,
      `Workflow await for runId "${acceptedRunId}" was cancelled; the workflow was not cancelled.`,
    );
    assert.equal(controlled.calls[1].options.signal?.aborted, false, "await cancellation does not abort the run");

    controlled.resolve(1, { approved: true }, {
      input: 20,
      output: 7,
      total: 27,
      cost: 0.2,
      cacheRead: 3,
      cacheWrite: 1,
    });
    const completed = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: acceptedRunId, waitMs: 1_000 },
    });
    const completedStatus = structured(completed);
    assert.equal(completed.isError, false);
    assert.equal(completedStatus?.status, "completed");
    assert.equal(field(completedStatus?.wait, "returnedBecause"), "terminal");
    assert.equal(
      JSON.stringify(field(completedStatus?.outcome, "result")),
      JSON.stringify({ first: { files: ["src/auth.ts"] }, second: { approved: true } }),
    );
    assert.deepEqual(completedStatus?.tokenUsage, field(completedStatus?.outcome, "tokenUsage"));
    assert.equal(field(completedStatus?.tokenUsage, "total"), 42);
    assert.deepEqual(completedStatus?.limits, EXPECTED_LIMITS);
    assert.deepEqual(field(completedStatus?.outcome, "limits"), EXPECTED_LIMITS);

    const repeated = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: acceptedRunId, waitMs: 25_000 },
    });
    assert.equal(field(structured(repeated)?.wait, "returnedBecause"), "terminal");
    assert.deepEqual(field(structured(repeated)?.outcome, "result"), field(completedStatus?.outcome, "result"));
    assert.deepEqual(structured(repeated)?.limits, EXPECTED_LIMITS);
  } finally {
    for (let index = 0; index < controlled.calls.length; index++) {
      controlled.calls[index]?.resolve("cleanup");
    }
    await dispose();
  }
});

test("MCP await and inspect expose the resolved timeout and AGENT_TIMEOUT call failure", async () => {
  let attempts = 0;
  const runner = makeRunner(
    () => {
      attempts += 1;
      return new Promise(() => {
        // Deliberately ignore the attempt signal and never settle.
      });
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  const expectedLimits = {
    maxAgents: 1_000,
    tokenBudget: null,
    concurrency: 2,
    agentRetries: 0,
    agentTimeoutMs: 25,
    agentIdleTimeoutMs: null,
  } as const;
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: {
        script:
          'export const meta = { name: "timed", description: "timed" };\n' +
          'return await agent("never", { label: "never" });',
        background: true,
        concurrency: 2,
        agentTimeoutMs: 25,
      },
    });
    const runId = runIdOf(accepted);
    assert.deepEqual(structured(accepted)?.limits, expectedLimits);

    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 1_000 },
    });
    assert.equal(structured(awaited)?.status, "completed");
    assert.deepEqual(structured(awaited)?.limits, expectedLimits);
    assert.deepEqual(field(structured(awaited)?.outcome, "limits"), expectedLimits);

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId },
    });
    const calls = structured(inspected)?.calls as Array<Record<string, unknown>>;
    assert.equal(attempts, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.label, "never");
    assert.equal(calls[0]?.timeoutMs, 25);
    assert.equal(calls[0]?.errorCode, WorkflowErrorCode.AGENT_TIMEOUT);
    assert.equal(calls[0]?.resultPreview, "null");
    assert.deepEqual(structured(inspected)?.limits, expectedLimits);
  } finally {
    await dispose();
  }
});

test("MCP idle watchdog cancels a silent attempt and exposes AGENT_IDLE_TIMEOUT", async () => {
  let attempts = 0;
  let aborts = 0;
  const runner = makeRunner(
    (_prompt, options) => {
      attempts += 1;
      options.signal?.addEventListener("abort", () => { aborts += 1; }, { once: true });
      return new Promise(() => {
        // Deliberately silent and abort-ignoring: the engine race must settle independently.
      });
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  const expectedLimits = {
    maxAgents: 1_000,
    tokenBudget: null,
    concurrency: 8,
    agentRetries: 0,
    agentTimeoutMs: null,
    agentIdleTimeoutMs: 35,
  } as const;
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: {
        script:
          'export const meta = { name: "idle", description: "idle" };\n' +
          'return await agent("silent", { label: "silent" });',
        background: true,
        agentIdleTimeoutMs: 35,
      },
    });
    const runId = runIdOf(accepted);
    assert.deepEqual(structured(accepted)?.limits, expectedLimits);

    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 1_000 },
    });
    assert.equal(structured(awaited)?.status, "completed");
    assert.deepEqual(structured(awaited)?.limits, expectedLimits);

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId },
    });
    const calls = structured(inspected)?.calls as Array<Record<string, unknown>>;
    assert.equal(attempts, 1);
    assert.equal(aborts, 1);
    assert.equal(calls[0]?.idleTimeoutMs, 35);
    assert.equal(calls[0]?.errorCode, WorkflowErrorCode.AGENT_IDLE_TIMEOUT);
  } finally {
    await dispose();
  }
});

test("await tails post-watermark progress while background admission stays silent", async () => {
  const controlled = new ControlledRunner();
  const { server, dispose } = await connect(controlled.runner, { listTools: true });
  type ProgressParams = { progressToken: string | number; progress: number; total?: number; message?: string };
  type DirectResult = {
    structuredContent?: Record<string, unknown>;
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  type DirectHandler = (
    args: Record<string, unknown>,
    ctx: {
      mcpReq: {
        signal: AbortSignal;
        _meta?: { progressToken?: string | number };
        notify: (notification: { params: ProgressParams }) => Promise<void>;
      };
    },
  ) => Promise<DirectResult>;
  const registered = server as unknown as {
    _registeredTools: Record<string, { handler: DirectHandler }>;
  };
  const handler = registered._registeredTools.workflow.handler;
  const admissionProgress: ProgressParams[] = [];

  try {
    const accepted = await handler(
      { script: TWO_AGENT_BACKGROUND, background: true },
      {
        mcpReq: {
          signal: new AbortController().signal,
          _meta: { progressToken: "admission" },
          notify: async (notification) => {
            admissionProgress.push(notification.params);
          },
        },
      },
    );
    const runId = accepted.structuredContent?.runId;
    assert.equal(typeof runId, "string");
    assert.deepEqual(admissionProgress, []);

    const awaitProgress: ProgressParams[] = [];
    const awaited = handler(
      { action: "await", runId, waitMs: 5_000 },
      {
        mcpReq: {
          signal: new AbortController().signal,
          _meta: { progressToken: "await" },
          notify: async (notification) => {
            awaitProgress.push(notification.params);
          },
        },
      },
    );

    controlled.resolve(0, "first result");
    await waitUntil(() => controlled.calls.length === 2, "the second agent should start");
    await waitUntil(() => awaitProgress.length >= 5, "the await request should consume the first call's event suffix");
    assert.deepEqual(awaitProgress.slice(0, 5), [
      { progressToken: "await", progress: 0, message: "Explore" },
      { progressToken: "await", progress: 0, total: 1, message: "Explore" },
      { progressToken: "await", progress: 1, total: 1, message: "Explore" },
      { progressToken: "await", progress: 1, total: 1, message: "Review" },
      { progressToken: "await", progress: 1, total: 2, message: "Review" },
    ]);

    controlled.resolve(1, "second result");
    const result = await awaited;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent?.status, "completed");
    assert.deepEqual(admissionProgress, [], "the completed admission request never becomes a progress channel");
    for (let index = 1; index < awaitProgress.length; index++) {
      assert.ok(awaitProgress[index].progress >= awaitProgress[index - 1].progress);
      assert.ok((awaitProgress[index].total ?? 0) >= (awaitProgress[index - 1].total ?? 0));
    }
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("await cancellation closes its event watcher without cancelling the workflow", async () => {
  const originalGetPersistence = WorkflowManager.prototype.getPersistence;
  let watcherCloseCalls = 0;
  WorkflowManager.prototype.getPersistence = function getPersistenceWithObservedWatch() {
    const persistence = originalGetPersistence.call(this);
    const originalWatchEvents = persistence.watchEvents.bind(persistence);
    persistence.watchEvents = (...args) => {
      const stream = originalWatchEvents(...args);
      const originalClose = stream.close.bind(stream);
      stream.close = () => {
        watcherCloseCalls++;
        originalClose();
      };
      return stream;
    };
    return persistence;
  };

  const controlled = new ControlledRunner();
  const { client, server, dispose } = await connect(controlled.runner);
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_BACKGROUND, background: true },
    });
    type DirectHandler = (
      args: Record<string, unknown>,
      ctx: { mcpReq: { signal: AbortSignal } },
    ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler: DirectHandler }>;
    })._registeredTools.workflow.handler;
    const controller = new AbortController();
    const awaited = handler(
      { action: "await", runId: runIdOf(accepted), waitMs: 5_000 },
      { mcpReq: { signal: controller.signal } },
    );
    controller.abort();

    const result = await awaited;
    assert.equal(result.isError, true);
    assert.equal(
      watcherCloseCalls,
      3,
      "admission readback, resource projection, and await each obtain the shared persistence instance",
    );
    assert.equal(controlled.calls[0].options.signal?.aborted, false);
  } finally {
    WorkflowManager.prototype.getPersistence = originalGetPersistence;
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("legacy and unsafe event logs fall back without await progress notifications", async () => {
  const fixtures = ["legacy", "missing-stream", "mismatched-stream", "corrupt", "incomplete"] as const;

  for (const fixture of fixtures) {
    const controlled = new ControlledRunner();
    const { client, server, dispose } = await connect(controlled.runner);
    try {
      const accepted = await client.callTool({
        name: "workflow",
        arguments: {
          script: 'export const meta = { name: "fallback", description: "fallback" }; return await agent("wait");',
          background: true,
        },
      });
      const runId = runIdOf(accepted);
      const snapshotFile = persistedRunFile(runId);
      assert.ok(snapshotFile);
      const eventFile = snapshotFile.replace(/\.json$/, ".events.jsonl");
      const persisted = JSON.parse(readFileSync(snapshotFile, "utf8")) as Record<string, unknown>;
      if (fixture === "legacy") {
        delete persisted.eventSeq;
        delete persisted.eventStreamId;
        unlinkSync(eventFile);
      } else if (fixture === "missing-stream") {
        delete persisted.eventStreamId;
      } else if (fixture === "mismatched-stream") {
        persisted.eventStreamId = "b".repeat(32);
      } else if (fixture === "corrupt") {
        writeFileSync(eventFile, `${readFileSync(eventFile, "utf8")}{invalid}\n`, "utf8");
      } else {
        persisted.eventLogIncomplete = true;
      }
      if (fixture !== "corrupt") writeFileSync(snapshotFile, JSON.stringify(persisted), "utf8");

      type ProgressParams = { progressToken: string | number; progress: number; total?: number; message?: string };
      type DirectHandler = (
        args: Record<string, unknown>,
        ctx: {
          mcpReq: {
            signal: AbortSignal;
            _meta: { progressToken: string | number };
            notify: (notification: { params: ProgressParams }) => Promise<void>;
          };
        },
      ) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
      const handler = (server as unknown as {
        _registeredTools: Record<string, { handler: DirectHandler }>;
      })._registeredTools.workflow.handler;
      const progress: ProgressParams[] = [];
      const awaited = handler(
        { action: "await", runId, waitMs: 5_000 },
        {
          mcpReq: {
            signal: new AbortController().signal,
            _meta: { progressToken: fixture },
            notify: async (notification) => {
              progress.push(notification.params);
            },
          },
        },
      );

      controlled.resolve(0, fixture);
      const result = await awaited;
      assert.equal(result.isError, false, fixture);
      assert.equal(result.structuredContent?.status, "completed", fixture);
      assert.deepEqual(progress, [], fixture);
    } finally {
      for (const call of controlled.calls) call.resolve("cleanup");
      await dispose();
    }
  }
});

test("the four-run registry rejects a fifth, releases failures and settlements, and ignores foreground/read calls", async () => {
  assert.equal(MAX_BACKGROUND_RUNS, 4);
  const controlled = new ControlledRunner();
  const { client, dispose } = await connect(controlled.runner, { listTools: true });
  const acceptedIds: string[] = [];
  try {
    const malformed = await client.callTool({
      name: "workflow",
      arguments: { script: 'await agent("missing meta")', background: true },
    });
    assert.equal(malformed.isError, true, "a failed start releases its reservation");
    const denied = await client.callTool({
      name: "workflow",
      arguments: {
        script:
          'export const meta = { name: "denied", description: "denied", backends: { custom: { command: "agent" } } }; return 1;',
        background: true,
      },
    });
    assert.equal(denied.isError, true, "a failed backend approval releases its reservation");

    for (let index = 0; index < MAX_BACKGROUND_RUNS; index++) {
      const accepted = await client.callTool({
        name: "workflow",
        arguments: {
          script: `export const meta = { name: "blocked-${index}", description: "blocked" }; return await agent("${index}");`,
          background: true,
        },
      });
      acceptedIds.push(runIdOf(accepted));
    }
    assert.equal(controlled.calls.length, 4);
    const fifth = await client.callTool({
      name: "workflow",
      arguments: {
        script: 'export const meta = { name: "fifth", description: "fifth" }; return await agent("fifth");',
        background: true,
      },
    });
    assert.equal(fifth.isError, true);
    assert.equal(fifth.structuredContent, undefined);
    assert.equal(
      textOf(fifth),
      "Background workflow limit reached (4 active or starting runs). Await an existing run and retry.",
    );
    assert.equal(controlled.calls.length, 4, "the rejected run never invokes the runner");

    const foreground = await client.callTool({ name: "workflow", arguments: { script: NO_AGENT_SCRIPT } });
    assert.equal(structured(foreground)?.status, "completed");
    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: acceptedIds[0] },
    });
    assert.equal(inspected.isError, false);
    const nonblocking = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: acceptedIds[0], waitMs: 0 },
    });
    assert.equal(field(structured(nonblocking)?.wait, "returnedBecause"), "immediate");

    controlled.resolve(0, "released");
    await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: acceptedIds[0], waitMs: 1_000 },
    });
    const replacement = await client.callTool({
      name: "workflow",
      arguments: {
        script: 'export const meta = { name: "replacement", description: "replacement" }; return await agent("replacement");',
        background: true,
      },
    });
    assert.equal(structured(replacement)?.status, "running");
    assert.equal(controlled.calls.length, 5);
  } finally {
    for (const call of controlled.calls) call.resolve("cleanup");
    await dispose();
  }
});

test("terminal outcomes survive repeated await and server restart, then missing/corrupt records use the exact error", async () => {
  const rawResult = { approved: false, findings: ["rollback", "race"] };
  const script = [
    'export const meta = { name: "retained", description: "retained" };',
    'log("retained log");',
    'return await agent("result");',
  ].join("\n");
  const first = await connect(makeRunner((_prompt, options) => {
    options.onUsage?.({ input: 1, output: 2, total: 3, cost: 0.4, cacheRead: 0, cacheWrite: 0 });
    return rawResult;
  }), { listTools: true });
  const accepted = await first.client.callTool({
    name: "workflow",
    arguments: { script, background: true },
  });
  const runId = runIdOf(accepted);
  const terminal = await first.client.callTool({
    name: "workflow",
    arguments: { action: "await", runId, waitMs: 1_000 },
  });
  const expectedOutcome = field(structured(terminal)?.outcome, "result");
  const expectedUsage = field(structured(terminal)?.outcome, "tokenUsage");
  const expectedLogs = field(structured(terminal)?.outcome, "logs");
  await first.dispose();

  const cold = await connect(makeRunner(() => "unused"), { listTools: true });
  try {
    const restored = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 0 },
    });
    assert.deepEqual(field(structured(restored)?.outcome, "result"), expectedOutcome);
    assert.deepEqual(field(structured(restored)?.outcome, "tokenUsage"), expectedUsage);
    assert.deepEqual(field(structured(restored)?.outcome, "logs"), expectedLogs);
    const file = persistedRunFile(runId);
    assert.ok(file);
    unlinkSync(file);
    if (existsSync(`${file}.bak`)) unlinkSync(`${file}.bak`);
    const missing = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 0 },
    });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent, undefined);
    assert.equal(textOf(missing), `No workflow run found for runId "${runId}" in this server's project-scoped run store.`);
  } finally {
    await cold.dispose();
  }

  const corruptSource = await connect(makeRunner(() => "corrupt-me"));
  const corruptAccepted = await corruptSource.client.callTool({
    name: "workflow",
    arguments: { script, background: true },
  });
  const corruptId = runIdOf(corruptAccepted);
  await corruptSource.client.callTool({
    name: "workflow",
    arguments: { action: "await", runId: corruptId, waitMs: 1_000 },
  });
  await corruptSource.dispose();
  const corruptFile = persistedRunFile(corruptId);
  assert.ok(corruptFile);
  writeFileSync(corruptFile, "{broken", "utf8");
  if (existsSync(`${corruptFile}.bak`)) writeFileSync(`${corruptFile}.bak`, "{broken", "utf8");
  const corruptCold = await connect(makeRunner(() => "unused"));
  try {
    const corrupt = await corruptCold.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: corruptId, waitMs: 0 },
    });
    assert.equal(corrupt.isError, true);
    assert.equal(corrupt.structuredContent, undefined);
    assert.equal(
      textOf(corrupt),
      `No workflow run found for runId "${corruptId}" in this server's project-scoped run store.`,
    );
  } finally {
    await corruptCold.dispose();
  }
});

async function connectEliciting(runner: ReturnType<typeof makeRunner>): Promise<{
  client: Client;
  requests: ElicitRequest[];
  dispose: () => Promise<void>;
}> {
  const server = createWorkflowServer(runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "detached-elicitation", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  const requests: ElicitRequest[] = [];
  client.setRequestHandler('elicitation/create', async (request): Promise<ElicitResult> => {
    requests.push(request);
    return { action: "accept", content: { approve: true } };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

test("background checkpoints stay headless despite elicitation capability and auth pauses remain non-secret", async () => {
  const eliciting = await connectEliciting(makeRunner(() => "unused"));
  try {
    for (const fixture of [
      { headless: "default", expected: "completed", code: undefined },
      { headless: "abort", expected: "failed", code: WorkflowErrorCode.WORKFLOW_ABORTED },
      { headless: "pause", expected: "paused", code: WorkflowErrorCode.CHECKPOINT_REQUIRED },
    ] as const) {
      const script = [
        `export const meta = { name: "checkpoint-${fixture.headless}", description: "checkpoint" };`,
        `return await checkpoint("ship?", { headless: "${fixture.headless}", kind: "confirm", default: "fallback" });`,
      ].join("\n");
      const accepted = await eliciting.client.callTool({
        name: "workflow",
        arguments: { script, background: true },
      });
      const awaited = await eliciting.client.callTool({
        name: "workflow",
        arguments: { action: "await", runId: runIdOf(accepted), waitMs: 1_000 },
      });
      assert.equal(awaited.isError, false, "await is a successful read for every terminal lifecycle status");
      assert.equal(structured(awaited)?.status, fixture.expected);
      assert.equal(structured(awaited)?.errorCode, fixture.code);
      assert.ok(structured(awaited)?.outcome);
      if (fixture.headless === "default") assert.equal(field(structured(awaited)?.outcome, "result"), "fallback");
      if (fixture.headless === "pause") {
        assert.equal(structured(awaited)?.reason, "checkpoint_required");
        assert.equal(field(field(structured(awaited)?.outcome, "checkpointContext"), "prompt"), "ship?");
      }
    }
    assert.equal(eliciting.requests.length, 0, "no checkpoint elicitation is retained after background acceptance");
  } finally {
    await eliciting.dispose();
  }

  const authContext = {
    backendId: "codex",
    methods: [{ id: "codex-login", type: "terminal" as const, name: "Codex login" }],
  };
  const auth = await connect(
    makeRunner(() => {
      throw new WorkflowError("credentials=do-not-expose", WorkflowErrorCode.AUTH_REQUIRED, {
        recoverable: false,
        authContext,
      });
    }),
    { listTools: true },
  );
  try {
    const accepted = await auth.client.callTool({
      name: "workflow",
      arguments: {
        script: 'export const meta = { name: "auth", description: "auth" }; return await agent("auth");',
        background: true,
      },
    });
    const awaited = await auth.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: runIdOf(accepted), waitMs: 1_000 },
    });
    assert.equal(awaited.isError, false);
    assert.equal(structured(awaited)?.status, "paused");
    assert.equal(structured(awaited)?.reason, "auth_required");
    assert.equal(structured(awaited)?.errorCode, WorkflowErrorCode.AUTH_REQUIRED);
    assert.deepEqual(field(structured(awaited)?.outcome, "authContext"), authContext);
    assert.doesNotMatch(JSON.stringify(field(structured(awaited)?.outcome, "authContext")), /credential|secret/i);
    assert.match(textOf(awaited), /codex login/);
    assert.match(textOf(awaited), /resumeFromRunId/);
  } finally {
    await auth.dispose();
  }
});

test("MCP multi-hop background resume preserves all eleven agents under each new run ID and await is read-only", async () => {
  let calls = 0;
  let terminalRunId = "";
  const runner = makeRunner((prompt) => {
    calls++;
    return `answer:${prompt}`;
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  const script = [
    'export const meta = { name: "mcp-multi-hop", description: "multi hop" };',
    'const values = [];',
    'for (let i = 0; i < args.count; i++) values.push(await agent(`call-${i}`, { label: `call-${i}`, resume: { filesystem: "read-only" } }));',
    'if (args.pause) values.push(await checkpoint("ship?", { headless: "pause" }));',
    "return values;",
  ].join("\n");
  try {
    const source = await client.callTool({
      name: "workflow",
      arguments: { script, args: { count: 10, pause: false } },
    });
    const sourceId = runIdOf(source);
    assert.equal(calls, 10);

    const secondAccepted = await client.callTool({
      name: "workflow",
      arguments: {
        script,
        args: { count: 11, pause: true },
        background: true,
        resumeFromRunId: sourceId,
      },
    });
    const secondId = runIdOf(secondAccepted);
    assert.notEqual(secondId, sourceId);
    assert.equal(field(structured(secondAccepted)?.replayEligibility, "predictedReplayablePrefix"), 10);
    const secondAwait = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: secondId, waitMs: 1_000 },
    });
    assert.equal(structured(secondAwait)?.status, "paused");
    assert.equal(calls, 11, "only call ten executes live in the background child");
    const secondReport = field(structured(secondAwait)?.outcome, "resumeReport");
    assert.equal(field(secondReport, "strategy"), "identity-v1");
    assert.equal(field(secondReport, "replayed"), 10);
    assert.equal(field(secondReport, "live"), 2);
    assert.equal(field(structured(secondAwait)?.replayEligibility, "replayedPrefix"), 10);
    assert.deepEqual(
      structured(secondAwait)?.replayEligibility,
      field(structured(secondAwait)?.outcome, "replayEligibility"),
    );
    assert.match(
      textOf(secondAwait),
      /^resume: identity-v1; predicted replayable prefix 10; replayed prefix 10; 10 replayed, 2 live, 0 failed$/m,
    );
    const repeated = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: secondId, waitMs: 0 },
    });
    assert.equal(structured(repeated)?.status, "paused");
    assert.equal(calls, 11, "await never replays or resumes the workflow");
    const secondFile = persistedRunFile(secondId);
    assert.ok(secondFile);
    const secondPersisted = JSON.parse(readFileSync(secondFile, "utf8")) as {
      journal: Array<{ index: number; call?: { kind: string } }>;
    };
    assert.deepEqual(secondPersisted.journal.map((entry) => entry.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(secondPersisted.journal.filter((entry) => entry.call?.kind === "agent").length, 11);
    const lock = join(dirname(secondFile), `${secondId}.lock`);
    assert.equal(existsSync(lock), false, "the paused child released its lease");

    const checkpoint = field(structured(secondAwait)?.outcome, "checkpointContext");
    const callIndex = Number(field(checkpoint, "callIndex"));
    const thirdAccepted = await client.callTool({
      name: "workflow",
      arguments: {
        script,
        args: { count: 11, pause: true },
        background: true,
        resumeFromRunId: secondId,
        checkpointReplies: { [callIndex]: true },
      },
    });
    const thirdId = runIdOf(thirdAccepted);
    terminalRunId = thirdId;
    assert.notEqual(thirdId, sourceId);
    assert.notEqual(thirdId, secondId);
    assert.equal(field(structured(thirdAccepted)?.replayEligibility, "predictedReplayablePrefix"), 12);
    const thirdAwait = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: thirdId, waitMs: 1_000 },
    });
    assert.equal(structured(thirdAwait)?.status, "completed");
    assert.equal(calls, 11, "the third run replays zero through ten and the synthetic checkpoint");
    const thirdReport = field(structured(thirdAwait)?.outcome, "resumeReport");
    assert.equal(field(thirdReport, "strategy"), "identity-v1");
    assert.equal(field(thirdReport, "replayed"), 12);
    assert.equal(field(thirdReport, "live"), 0);
    const thirdEligibility = structured(thirdAwait)?.replayEligibility;
    assert.equal(field(thirdEligibility, "replayedPrefix"), 12);
    assert.deepEqual(thirdEligibility, field(structured(thirdAwait)?.outcome, "replayEligibility"));
    assert.match(
      textOf(thirdAwait),
      /^resume: identity-v1; predicted replayable prefix 12; replayed prefix 12; 12 replayed, 0 live, 0 failed$/m,
    );
    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: thirdId },
    });
    assert.deepEqual(structured(inspected)?.replayEligibility, thirdEligibility);
    assert.match(textOf(inspected), /resume: identity-v1/);
    assert.equal(existsSync(lock), false, "await did not acquire the paused run's lease");
  } finally {
    await dispose();
  }

  const cold = await connect(makeRunner(() => assert.fail("a terminal await must not execute agents")), {
    listTools: true,
  });
  try {
    const persisted = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: terminalRunId, waitMs: 0 },
    });
    const persistedReport = field(structured(persisted)?.outcome, "resumeReport");
    assert.equal(field(persistedReport, "strategy"), "identity-v1");
    assert.equal(field(persistedReport, "replayed"), 12);
    assert.deepEqual(
      structured(persisted)?.replayEligibility,
      field(structured(persisted)?.outcome, "replayEligibility"),
    );
    assert.match(
      textOf(persisted),
      /^resume: identity-v1; predicted replayable prefix 12; replayed prefix 12; 12 replayed, 0 live, 0 failed$/m,
    );
  } finally {
    await cold.dispose();
  }
});

test("a long-lived server lazily reconciles crash residue for await, inspect, and resume", async () => {
  let sourceCalls = 0;
  const first = await connect(makeRunner(() => {
    sourceCalls++;
    return "cached";
  }));
  const script = 'export const meta = { name: "stale", description: "stale" }; return await agent("cached");';
  const source = await first.client.callTool({ name: "workflow", arguments: { script } });
  const sourceId = runIdOf(source);
  await first.dispose();
  assert.equal(sourceCalls, 1);
  const sourceFile = persistedRunFile(sourceId);
  assert.ok(sourceFile);
  const state = JSON.parse(readFileSync(sourceFile, "utf8")) as Record<string, unknown>;
  const staleId = `stale-${Date.now().toString(36)}`;
  state.runId = staleId;
  state.status = "running";
  state.journal = (state.journal as Array<Record<string, unknown>> | undefined)?.map((entry) => ({
    ...entry,
    scope: staleId,
  }));
  state.calls = (state.calls as Array<Record<string, unknown>> | undefined)?.map((call) => ({
    ...call,
    scope: staleId,
  }));
  delete state.result;
  delete state.completedAt;
  const resume = state.resume as Record<string, unknown> | undefined;
  if (resume) delete resume.terminalEnvironment;
  const staleFile = join(dirname(sourceFile), `${staleId}.json`);

  let resumedCalls = 0;
  const cold = await connect(makeRunner(() => {
    resumedCalls++;
    return "unexpected";
  }), { listTools: true });
  try {
    writeFileSync(staleFile, JSON.stringify(state, null, 2), "utf8");
    const recovered = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: staleId, waitMs: 0 },
    });
    assert.equal(structured(recovered)?.status, "paused");
    assert.equal(structured(recovered)?.reason, "Interrupted: the owning process exited before completion (PID unavailable); recovered to a resumable pause.");
    assert.equal(field(structured(recovered)?.wait, "returnedBecause"), "terminal");
    const inspected = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: staleId },
    });
    assert.equal(structured(inspected)?.status, "paused");
    assert.equal(structured(inspected)?.reason, structured(recovered)?.reason);
    const resumed = await cold.client.callTool({
      name: "workflow",
      arguments: { script, background: true, resumeFromRunId: staleId },
    });
    assert.equal(field(structured(resumed)?.replayEligibility, "strategy"), "identity-v1");
    assert.equal(field(structured(resumed)?.replayEligibility, "fallbackReason"), undefined);
    assert.equal(field(structured(resumed)?.replayEligibility, "predictedReplayablePrefix"), 1);
    const completed = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: runIdOf(resumed), waitMs: 1_000 },
    });
    assert.equal(structured(completed)?.status, "completed");
    assert.equal(resumedCalls, 0, "the recovered journal remains resumable");
    assert.equal(field(field(structured(completed)?.outcome, "resumeReport"), "strategy"), "identity-v1");
    assert.match(textOf(completed), /resume: identity-v1/);
  } finally {
    await cold.dispose();
  }
});

test("await inherits status byte caps while returning a large authored outcome exactly and never duplicating it into text", async () => {
  const authored = `AUTHORED-${"R".repeat(100_000)}`;
  const { client, dispose } = await connect(makeRunner(() => authored), { listTools: true });
  try {
    const script = [
      'export const meta = { name: "large-await", description: "large" };',
      'for (let i = 0; i < 50; i++) log(`line-${i}-${"😀".repeat(1000)}`);',
      'return await agent("large", { label: "large-call" });',
    ].join("\n");
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { script, background: true },
    });
    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: runIdOf(accepted), waitMs: 1_000, lastN: 50, logLines: 50 },
    });
    const result = structured(awaited);
    assert.ok(result);
    const { wait: _wait, outcome: _outcome, tokenUsage: _tokenUsage, ...statusOnly } = result;
    assert.ok(Buffer.byteLength(JSON.stringify(statusOnly), "utf8") <= 24_576);
    assert.ok(Buffer.byteLength(textOf(awaited), "utf8") <= 8_192);
    assert.equal(field(result.outcome, "result"), authored);
    assert.equal(textOf(awaited).includes(authored.slice(0, 1_000)), false, "raw outcomes are not duplicated into text");
  } finally {
    await dispose();
  }
});
