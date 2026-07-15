import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentResult, AgentRunner, JournalEntry, RunOptions } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import {
  type CheckpointCallContext,
  type WorkflowRunOptions,
  runWorkflow,
} from "../src/workflow.js";

type CapturedIdentity = Pick<RunOptions, "callIndex" | "callHash" | "callPath" | "callInputsHash" | "runId">;

function captureIdentity(target: CapturedIdentity[]): AgentRunner {
  return {
    async run<S extends TSchema | undefined = undefined>(
      _prompt: string,
      options?: RunOptions<S>,
    ): Promise<AgentResult<S>> {
      target.push({
        callIndex: options?.callIndex,
        callHash: options?.callHash,
        callPath: options?.callPath,
        callInputsHash: options?.callInputsHash,
        runId: options?.runId,
      });
      return "ok" as AgentResult<S>;
    },
  };
}

describe("engine call identity", () => {
  it("threads all four identity fields to the runner and matches the journal identity", async () => {
    const calls: CapturedIdentity[] = [];
    const journal: JournalEntry[] = [];
    await runWorkflow(
      `export const meta = { name: 'identity', description: 'identity fields' }
await Promise.resolve()
return await agent('inspect', { label: 'inspect' })`,
      {
        runId: "identity-run",
        agent: captureIdentity(calls),
        persistLogs: false,
        onAgentJournal: (entry) => journal.push(entry),
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].callIndex, 0);
    assert.equal(calls[0].callHash, journal[0].hash);
    assert.match(calls[0].callHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(calls[0].callPath ?? "", /^\d+:\d+(?:<\d+:\d+)*$/);
    assert.match(calls[0].callInputsHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(calls[0].runId, "identity-run");
  });

  it("keeps the complete identity byte-identical across retry attempts", async () => {
    const calls: CapturedIdentity[] = [];
    let attempts = 0;
    const runner: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        calls.push({
          callIndex: options?.callIndex,
          callHash: options?.callHash,
          callPath: options?.callPath,
          callInputsHash: options?.callInputsHash,
          runId: options?.runId,
        });
        attempts++;
        return (attempts === 1 ? "" : "ok") as AgentResult<S>;
      },
    };

    const result = await runWorkflow(
      `export const meta = { name: 'retry-identity', description: 'retry identity' }
await Promise.resolve()
return await agent('retry', { label: 'retry', retries: 1 })`,
      { runId: "retry-run", agent: runner, persistLogs: false },
    );

    assert.equal(result.result, "ok");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
  });

  it("shares indexes with checkpoints and passes the full checkpoint context", async () => {
    const calls: CapturedIdentity[] = [];
    const contexts: CheckpointCallContext[] = [];
    const journal: JournalEntry[] = [];
    await runWorkflow(
      `export const meta = { name: 'checkpoint-identity', description: 'checkpoint identity' }
await Promise.resolve()
const a = await agent('before', { label: 'before' })
const approved = await checkpoint('Proceed?', { kind: 'confirm' })
const b = await agent('after', { label: 'after' })
return { a, approved, b }`,
      {
        runId: "checkpoint-run",
        agent: captureIdentity(calls),
        persistLogs: false,
        confirm: async (_prompt, _options, context) => {
          assert.ok(context);
          contexts.push(context);
          return true;
        },
        onAgentJournal: (entry) => journal.push(entry),
      },
    );

    assert.deepEqual(
      calls.map((call) => call.callIndex),
      [0, 2],
    );
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].callIndex, 1);
    assert.equal(contexts[0].scope, "checkpoint-run");
    assert.match(contexts[0].hash, /^[a-f0-9]{64}$/);
    assert.match(contexts[0].path ?? "", /^\d+:\d+(?:<\d+:\d+)*$/);
    assert.equal(
      contexts[0].hash,
      journal.find((entry) => entry.index === 1)?.hash,
    );
  });

  it("keeps a legacy two-argument confirm callback assignable and runnable", async () => {
    let receivedPrompt = "";
    const legacyConfirm: NonNullable<WorkflowRunOptions["confirm"]> = async (promptText, options) => {
      receivedPrompt = `${promptText}:${options.kind}`;
      return "legacy-reply";
    };
    const result = await runWorkflow(
      `export const meta = { name: 'legacy-confirm', description: 'legacy confirm' }
return await checkpoint('Choose', { kind: 'input' })`,
      {
        agent: captureIdentity([]),
        confirm: legacyConfirm,
        persistLogs: false,
      },
    );

    assert.equal(receivedPrompt, "Choose:input");
    assert.equal(result.result, "legacy-reply");
  });

  it("computes throwing agent and checkpoint hashes before allocating an index", async () => {
    const calls: CapturedIdentity[] = [];
    const contexts: CheckpointCallContext[] = [];
    const result = await runWorkflow(
      `export const meta = { name: 'preallocation', description: 'preallocation identity' }
const cyclicSchema = {}
cyclicSchema.self = cyclicSchema
try { await agent('bad-agent', { schema: cyclicSchema }) } catch {}
const cyclicChoices = []
cyclicChoices.push(cyclicChoices)
try { await checkpoint('bad-checkpoint', { choices: cyclicChoices }) } catch {}
return await agent('good-agent', { label: 'good' })`,
      {
        agent: captureIdentity(calls),
        confirm: async (_prompt, _options, context) => {
          if (context) contexts.push(context);
          return true;
        },
        persistLogs: false,
      },
    );

    assert.equal(result.result, "ok");
    assert.deepEqual(calls.map((call) => call.callIndex), [0]);
    assert.deepEqual(contexts, [], "the checkpoint hash failure occurs before confirm");
    assert.equal(result.agentCount, 1, "failed identity computation reserves no agent slot");
  });

  it("uses a root-wide monotonic ordinal for sequential nested workflow invocations", async () => {
    const child = `export const meta = { name: 'child', description: 'nested child' }
await Promise.resolve()
return await agent('child-call', { label: 'child' })`;
    const calls: CapturedIdentity[] = [];
    const nested: Array<[number, string]> = [];
    const parent = `export const meta = { name: 'parent', description: 'nested parent' }
const child = ${JSON.stringify(child)}
for (let i = 0; i < 2; i++) await workflow(child)
await workflow(child)
await workflow(child)
return 'done'`;

    const result = await runWorkflow(parent, {
      runId: "root-scope",
      agent: captureIdentity(calls),
      persistLogs: false,
      onNestedWorkflow: (ordinal, childRunId) => nested.push([ordinal, childRunId]),
    });

    assert.equal(result.result, "done");
    assert.equal(result.nestedWorkflows, true);
    assert.deepEqual(
      calls.map((call) => call.callIndex),
      [0, 0, 0, 0],
      "each child has its own local index space",
    );
    assert.deepEqual(
      calls.map((call) => call.runId),
      ["root-scope-nested1", "root-scope-nested2", "root-scope-nested3", "root-scope-nested4"],
    );
    assert.deepEqual(nested, [
      [1, "root-scope-nested1"],
      [2, "root-scope-nested2"],
      [3, "root-scope-nested3"],
      [4, "root-scope-nested4"],
    ]);
  });

  it("marks and reports a zero-call nested workflow at invocation time", async () => {
    const child = `export const meta = { name: 'empty-child', description: 'empty child' }
return 'empty'`;
    const invocations: Array<[number, string]> = [];
    const result = await runWorkflow(
      `export const meta = { name: 'zero-call-parent', description: 'zero call parent' }
return await workflow(${JSON.stringify(child)})`,
      {
        runId: "zero-call",
        agent: captureIdentity([]),
        persistLogs: false,
        onNestedWorkflow: (ordinal, childRunId) => invocations.push([ordinal, childRunId]),
      },
    );

    assert.equal(result.result, "empty");
    assert.equal(result.nestedWorkflows, true);
    assert.deepEqual(invocations, [[1, "zero-call-nested1"]]);
  });
});
