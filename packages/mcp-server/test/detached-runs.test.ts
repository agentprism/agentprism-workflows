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
  concurrency: 3,
  agentRetries: 1,
} as const;

test("background acceptance is immediate and status is an immediate cumulative snapshot", async () => {
  const controlled = new ControlledRunner();
  const { client, dispose } = await connect(controlled.runner, { listTools: true });
  try {
    const initiating = new AbortController();
    const accepted = await client.callTool(
      {
        name: "workflow",
        arguments: {
          action: "run",
          script: TWO_AGENT_BACKGROUND,
          background: true,
          concurrency: 3,
          agentRetries: 1,
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
      eventsUri: `workflow://runs/${acceptedRunId}/events`,
      limits: EXPECTED_LIMITS,
      pendingPermissions: [],
      interaction: {
        permissionRequests: "may-block",
        collectWith: ["status"],
        respondWith: "permissions-response",
        elicitation: "unavailable",
      },
    });
    assert.match(textOf(accepted), new RegExp(`^Workflow "detached-review" started in the background\\.\\nrunId: ${acceptedRunId}\\n`));
    assert.match(textOf(accepted), /action="status" and this runId for an immediate snapshot/);
    assert.equal(controlled.calls.length, 1);
    initiating.abort();
    assert.equal(controlled.calls[0].options.signal?.aborted, false, "initiating-call cancellation is detached");

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

test("the four-run registry rejects a fifth, releases failures and settlements, and ignores foreground/read calls", async () => {
  assert.equal(MAX_BACKGROUND_RUNS, 4);
  const controlled = new ControlledRunner();
  const { client, dispose } = await connect(controlled.runner, { listTools: true });
  const acceptedIds: string[] = [];
  try {
    const malformed = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: 'await agent("missing meta")', background: true },
    });
    assert.equal(malformed.isError, true, "a failed start releases its reservation");
    const denied = await client.callTool({
      name: "workflow",
      arguments: {
        action: "run",
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
          action: "run",
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
        action: "run",
        script: 'export const meta = { name: "fifth", description: "fifth" }; return await agent("fifth");',
        background: true,
      },
    });
    assert.equal(fifth.isError, true);
    assert.equal(fifth.structuredContent, undefined);
    assert.equal(
      textOf(fifth),
      "Background workflow limit reached (4 active or starting runs). Check an existing run with status and retry.",
    );
    assert.equal(controlled.calls.length, 4, "the rejected run never invokes the runner");

    const foreground = await client.callTool({ name: "workflow", arguments: { action: "run", script: NO_AGENT_SCRIPT } });
    assert.equal(structured(foreground)?.status, "completed");
    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: acceptedIds[0] },
    });
    assert.equal(inspected.isError, false);
    const nonblocking = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: acceptedIds[0] },
    });
    assert.equal(structured(nonblocking)?.runId, acceptedIds[0]);

    controlled.resolve(0, "released");
    await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: acceptedIds[0] },
    });
    const replacement = await client.callTool({
      name: "workflow",
      arguments: {
        action: "run",
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

test("terminal outcomes survive repeated status and server restart, then missing/corrupt records use the exact error", async () => {
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
    arguments: { action: "run", script, background: true },
  });
  const runId = runIdOf(accepted);
  const terminal = await first.client.callTool({
    name: "workflow",
    arguments: { action: "status", runId },
  });
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
    arguments: { action: "run", script, background: true },
  });
  const corruptId = runIdOf(corruptAccepted);
  await corruptSource.client.callTool({
    name: "workflow",
    arguments: { action: "status", runId: corruptId },
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
        arguments: { action: "run", script, background: true },
      });
      const fixtureRunId = runIdOf(accepted);
      await waitUntil(async () => structured(await eliciting.client.callTool({
        name: "workflow",
        arguments: { action: "status", runId: fixtureRunId },
      }))?.status === fixture.expected, `checkpoint ${fixture.headless} should settle`);
      const awaited = await eliciting.client.callTool({
        name: "workflow",
        arguments: { action: "status", runId: fixtureRunId },
      });
      assert.equal(awaited.isError, false, "status is a successful read for every terminal lifecycle state");
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
        action: "run",
        script: 'export const meta = { name: "auth", description: "auth" }; return await agent("auth");',
        background: true,
      },
    });
    const awaited = await auth.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: runIdOf(accepted) },
    });
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
  const script = 'export const meta = { name: "stale", description: "stale" }; return await agent("cached");';
  const source = await first.client.callTool({ name: "workflow", arguments: { action: "run", script } });
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
      arguments: { action: "resume", runId: staleId, background: true },
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
      'export const meta = { name: "large-status", description: "large" };',
      'for (let i = 0; i < 50; i++) log(`line-${i}-${"😀".repeat(1000)}`);',
      'return await agent("large", { label: "large-call" });',
    ].join("\n");
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script, background: true },
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
