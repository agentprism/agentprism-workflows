import { waitForRun, runAndObserve } from "./_harness.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { ElicitRequest, ElicitResult, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { AgentUsage, RunOptions } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode, WorkflowManager } from "@automatalabs/workflows";
import { createWorkflowServer, MAX_ACTIVE_RUNS } from "../src/index.js";
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

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
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

const TWO_AGENT_ASYNC = [
  'export const meta = { model: "claude", name: "detached-review", description: "detached", phases: [{ title: "Explore" }, { title: "Review" }] };',
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
  concurrency: 3,
  agentRetries: 1,
} as const;

test("run acknowledges an admitted run and status is an immediate cumulative snapshot", async () => {
  const controlled = new ControlledRunner();
  const { client, dispose } = await connect(controlled.runner, { listTools: true });
  try {
    const initiating = new AbortController();
    const accepted = await client.callTool(
      {
        name: "workflow",
        arguments: {
          action: "run", script: TWO_AGENT_ASYNC,
          concurrency: 3,
          agentRetries: 1,
        },
      },
      { signal: initiating.signal },
    );
    const acceptedRunId = runIdOf(accepted);
    const ack = structured(accepted)!;
    assert.equal(ack.action, "run");
    assert.equal(ack.accepted, true);
    assert.equal(ack.status, "running");
    assert.equal(ack.result, undefined);
    assert.equal(ack.scriptSource, "inline");
    assert.equal(ack.scriptUri, `workflow://runs/${acceptedRunId}/script`);
    assert.equal(ack.eventsUri, `workflow://runs/${acceptedRunId}/events`);
    assert.deepEqual(ack.limits, EXPECTED_LIMITS);
    await waitUntil(() => controlled.calls.length === 1, "the first agent starts in the background");
    initiating.abort();
    assert.equal(controlled.calls[0].options.signal?.aborted, false, "cancellation after admission never reaches the run");

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: acceptedRunId },
    });
    assert.deepEqual(structured(inspected)?.limits, EXPECTED_LIMITS);

    const immediate = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: acceptedRunId },
    });
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
      arguments: { action: "status", runId: acceptedRunId, labelGlob: "expl*", lastN: 1, logLines: 2 },
    });
    const partialStatus = structured(partial);
    assert.equal(field(partialStatus?.tokenUsage, "total"), 15);
    assert.equal((partialStatus?.calls as Array<Record<string, unknown>>)[0]?.label, "explore");
    assert.equal(partialStatus?.currentPhase, "Review");
    assert.ok((field(partialStatus?.logTail, "lines") as string[]).includes("review started"));
    assert.equal(partialStatus?.outcome, undefined);
    assert.deepEqual(partialStatus?.limits, EXPECTED_LIMITS);

    controlled.resolve(1, { approved: true }, {
      input: 20,
      output: 7,
      total: 27,
      cost: 0.2,
      cacheRead: 3,
      cacheWrite: 1,
    });
    await waitUntil(async () => structured(await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: acceptedRunId },
    }))?.status === "completed", "the background run should complete");
    const completed = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: acceptedRunId },
    });
    const completedStatus = structured(completed);
    assert.equal(completed.isError, false);
    assert.equal(completedStatus?.status, "completed");
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
      arguments: { action: "status", runId: acceptedRunId },
    });
    assert.deepEqual(field(structured(repeated)?.outcome, "result"), field(completedStatus?.outcome, "result"));
    assert.deepEqual(structured(repeated)?.limits, EXPECTED_LIMITS);
  } finally {
    for (let index = 0; index < controlled.calls.length; index++) {
      controlled.calls[index]?.resolve("cleanup");
    }
    await dispose();
  }
});

test("the four-run registry counts admitted runs, rejects a fifth, and releases settled runs", async () => {
  assert.equal(MAX_ACTIVE_RUNS, 4);
  const controlled = new ControlledRunner();
  const { client, dispose } = await connect(controlled.runner, { listTools: true });
  const acceptedIds: string[] = [];
  try {
    const malformed = await client.callTool({ name: "workflow", arguments: { action: "run", script: 'export const meta = { model: "claude", name: "invalid", description: "invalid call" }; return agent("work", { unknownOption: true });' } });
    assert.equal(malformed.isError, true, "validation failure is a tool execution error");
    assert.equal(structured(malformed)?.runId, undefined, "a rejected preparation creates no run");
    const inputs = Array.from({ length: MAX_ACTIVE_RUNS }, (_, index) => ({ action: "run", script: `export const meta = { model: "claude", name: "blocked-${index}", description: "blocked" }; return await agent("${index}");` }));
    for (const input of inputs) {
      const accepted = await client.callTool({ name: "workflow", arguments: input });
      acceptedIds.push(runIdOf(accepted));
    }
    const fifth = await client.callTool({ name: "workflow", arguments: { action: "run", script: NO_AGENT_SCRIPT } });
    assert.equal(fifth.isError, true);
    assert.match(textOf(fifth), /Workflow limit reached/);
    await waitUntil(() => controlled.calls.length === 4, "all admitted agents should start");
    const observed = await client.callTool({ name: "workflow", arguments: { action: "status", runId: acceptedIds[0] } });
    assert.equal(observed.isError, false, "read calls do not reserve capacity");
    controlled.resolve(0, "settled");
    await waitForRun(client, acceptedIds[0]);
    const after = await runAndObserve(client, { script: NO_AGENT_SCRIPT });
    assert.equal(structured(after)?.status, "completed");
  } finally {
    controlled.calls.forEach((call) => call.resolve("cleanup"));
    for (const runId of acceptedIds) await waitForRun(client, runId);
    await dispose();
  }
});

test("terminal outcomes survive repeated status and server restart, then missing/corrupt records use the exact error", async () => {
  const rawResult = { approved: false, findings: ["rollback", "race"] };
  const script = [
    'export const meta = { model: "claude", name: "retained", description: "retained" };',
    'log("retained log");',
    'return await agent("result");',
  ].join("\n");
  const first = await connect(makeRunner((_prompt, options) => {
    options.onUsage?.({ input: 1, output: 2, total: 3, cost: 0.4, cacheRead: 0, cacheWrite: 0 });
    return rawResult;
  }), { listTools: true });
  const accepted = await first.client.callTool({
    name: "workflow",
    arguments: { action: "run", script },
  });
  const runId = runIdOf(accepted);
  const terminal = await waitForRun(first.client, runId);
  const expectedOutcome = field(structured(terminal)?.outcome, "result");
  const expectedUsage = field(structured(terminal)?.outcome, "tokenUsage");
  const expectedLogs = field(structured(terminal)?.outcome, "logs");
  await first.dispose();

  const cold = await connect(makeRunner(() => "unused"), { listTools: true });
  try {
    const restored = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
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
      arguments: { action: "status", runId },
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
    arguments: { action: "run", script },
  });
  const corruptId = runIdOf(corruptAccepted);
  await waitForRun(corruptSource.client, corruptId);
  await corruptSource.dispose();
  const corruptFile = persistedRunFile(corruptId);
  assert.ok(corruptFile);
  writeFileSync(corruptFile, "{broken", "utf8");
  if (existsSync(`${corruptFile}.bak`)) writeFileSync(`${corruptFile}.bak`, "{broken", "utf8");
  const corruptCold = await connect(makeRunner(() => "unused"));
  try {
    const corrupt = await corruptCold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: corruptId },
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

test("checkpoints pause independently of elicitation capability and auth pauses remain non-secret", async () => {
  const eliciting = await connectEliciting(makeRunner(() => "unused"));
  try {
    const paused = await runAndObserve(eliciting.client, { script: 'export const meta = { model: "claude", name: "checkpoint", description: "checkpoint" }; return await checkpoint("ship?");' });
    assert.equal(structured(paused)?.status, "paused");
    assert.equal(structured(paused)?.reason, "checkpoint_required");
    assert.equal(field(field(structured(paused)?.outcome, "checkpointContext"), "prompt"), "ship?");
    assert.equal(eliciting.requests.length, 0, "checkpoint is durable state, not a held MCP form");
  } finally { await eliciting.dispose(); }

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
        action: "run", script: 'export const meta = { model: "claude", name: "auth", description: "auth" }; return await agent("auth");',
      },
    });
    const awaited = await waitForRun(auth.client, runIdOf(accepted));
    assert.equal(awaited.isError, false);
    assert.equal(structured(awaited)?.status, "paused");
    assert.equal(structured(awaited)?.reason, "auth_required");
    assert.equal(structured(awaited)?.errorCode, WorkflowErrorCode.AUTH_REQUIRED);
    assert.deepEqual(field(structured(awaited)?.outcome, "authContext"), authContext);
    assert.doesNotMatch(JSON.stringify(field(structured(awaited)?.outcome, "authContext")), /credential|secret/i);
    assert.match(textOf(awaited), /codex login/);
    assert.match(textOf(awaited), /action="resume"/);
    assert.match(textOf(awaited), new RegExp(`runId="${runIdOf(accepted)}"`));
  } finally {
    await auth.dispose();
  }
});

test("a long-lived server lazily reconciles crash residue for status and resume", async () => {
  let sourceCalls = 0;
  const first = await connect(makeRunner(() => {
    sourceCalls++;
    return "cached";
  }));
  const script = 'export const meta = { model: "claude", name: "stale", description: "stale" }; return await agent("cached");';
  const source = await runAndObserve(first.client, { script });
  const sourceId = runIdOf(source);
  await first.dispose();
  assert.equal(sourceCalls, 1);
  const sourceFile = persistedRunFile(sourceId);
  assert.ok(sourceFile);
  const state = JSON.parse(readFileSync(sourceFile, "utf8")) as Record<string, unknown>;
  const staleId = sourceId;
  state.status = "running";
  delete state.result;
  delete state.completedAt;
  const resume = state.resume as Record<string, unknown> | undefined;
  if (resume) delete resume.terminalEnvironment;

  let resumedCalls = 0;
  const cold = await connect(makeRunner(() => {
    resumedCalls++;
    return "unexpected";
  }), { listTools: true });
  try {
    writeFileSync(sourceFile, JSON.stringify(state, null, 2), "utf8");
    const recovered = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: staleId },
    });
    assert.equal(structured(recovered)?.status, "paused");
    assert.equal(structured(recovered)?.reason, "Interrupted: the owning process exited before completion (PID unavailable); recovered to a resumable pause.");
    const inspected = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: staleId },
    });
    assert.equal(structured(inspected)?.status, "paused");
    assert.equal(structured(inspected)?.reason, structured(recovered)?.reason);
    const resumed = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: staleId },
    });
    assert.equal(runIdOf(resumed), staleId);
    await waitUntil(async () => structured(await cold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: staleId },
    }))?.status === "completed", "the recovered run should complete under its original id");
    const completed = await cold.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: staleId },
    });
    assert.equal(structured(completed)?.status, "completed");
    assert.equal(resumedCalls, 0, "the recovered journal remains resumable");
  } finally {
    await cold.dispose();
  }
});

test("status preserves byte caps while returning a large authored outcome exactly and never duplicating it into text", async () => {
  const authored = `AUTHORED-${"R".repeat(100_000)}`;
  const { client, dispose } = await connect(makeRunner(() => authored), { listTools: true });
  try {
    const script = [
      'export const meta = { model: "claude", name: "large-status", description: "large" };',
      'for (let i = 0; i < 50; i++) log(`line-${i}-${"😀".repeat(1000)}`);',
      'return await agent("large", { label: "large-call" });',
    ].join("\n");
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script },
    });
    await waitUntil(async () => structured(await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: runIdOf(accepted) },
    }))?.status === "completed", "the large-result run should complete");
    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: runIdOf(accepted), lastN: 50, logLines: 50 },
    });
    const result = structured(awaited);
    assert.ok(result);
    const { outcome: _outcome, tokenUsage: _tokenUsage, ...statusOnly } = result;
    assert.ok(Buffer.byteLength(JSON.stringify(statusOnly), "utf8") <= 24_576);
    assert.ok(Buffer.byteLength(textOf(awaited), "utf8") <= 8_192);
    assert.equal(field(result.outcome, "result"), authored);
    assert.equal(textOf(awaited).includes(authored.slice(0, 1_000)), false, "raw outcomes are not duplicated into text");
  } finally {
    await dispose();
  }
});
