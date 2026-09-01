import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner, AgentUsage, JournalEntry, RunOptions, WorkflowCallRecord } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow } from "../src/workflow.js";

const meta = (name: string, body: string) =>
  `export const meta = { name: ${JSON.stringify(name)}, description: 'manifest test' }\n${body}`;

function usage(total: number): AgentUsage {
  return { input: total - 1, output: 1, cacheRead: 0, cacheWrite: 0, total, cost: 0 };
}

describe("engine call manifest", () => {
  it("records success, exhausted-null, nonrecoverable, and checkpoint terminal exits", async () => {
    let invocation = 0;
    const runner: AgentRunner = {
      async run(_prompt, options) {
        invocation++;
        if (invocation === 1) {
          options?.onUsage?.(usage(7));
          options?.onModelResolved?.("provider/concrete");
          options?.onSessionOpen?.({
            sessionId: "s1",
            backendId: "backend",
            cwd: options.cwd ?? "/",
            reopen: { load: true, resume: false, list: false },
          });
          return { ok: true } as never;
        }
        if (invocation <= 3) return "" as never;
        throw new WorkflowError("hard failure", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
          recoverable: false,
        });
      },
    };
    const result = await runWorkflow(
      meta(
        "terminal-exits",
        `const success = await agent('success', { label: 'success', schema: { type: 'object' } })
const exhausted = await agent('empty', { label: 'empty', retries: 1 })
try { await agent('hard', { label: 'hard' }) } catch {}
const confirmed = await checkpoint('confirm?', { default: { accepted: true } })
try { await checkpoint('bad?', { kind: 'input' }) } catch {}
return { success, exhausted, confirmed }`,
      ),
      {
        runId: "manifest-run",
        agent: runner,
        persistLogs: false,
        confirm: async (prompt) => (prompt === "bad?" ? undefined : true),
      },
    );

    assert.equal(result.callsAllocated, 5);
    assert.deepEqual(result.calls?.map((row) => row.index), [0, 1, 2, 3, 4]);
    assert.deepEqual(result.calls?.map((row) => row.settlementOrdinal), [1, 2, 3, 4, 5]);
    const [success, exhausted, hard, confirmed, bad] = result.calls ?? [];
    assert.deepEqual(
      {
        outcome: success.outcome,
        origin: success.origin,
        attempts: success.attempts,
        usage: success.usage,
        modelResolved: success.modelResolved,
        backendId: success.backendId,
        scope: success.scope,
      },
      {
        outcome: "result",
        origin: "runner",
        attempts: 1,
        usage: usage(7),
        modelResolved: "provider/concrete",
        backendId: "backend",
        scope: "manifest-run",
      },
    );
    assert.equal(exhausted.outcome, "null");
    assert.equal(exhausted.origin, "runner");
    assert.equal(exhausted.attempts, 2);
    assert.equal(exhausted.error?.form, "workflow-error");
    assert.equal(hard.outcome, "error");
    assert.equal(hard.error?.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
    assert.equal(confirmed.origin, "confirm");
    assert.equal(confirmed.outcome, "result");
    assert.equal(bad.origin, "confirm");
    assert.equal(bad.outcome, "error");
    assert.equal(bad.error?.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(Object.isFrozen(success), true);
  });

  it("carries journal-replay usage for agents and records checkpoint replay", async () => {
    const journal: JournalEntry[] = [];
    const script = meta(
      "replay-rows",
      `const a = await agent('a', { label: 'a' })
const c = await checkpoint('c?', { default: 'yes' })
return { a, c }`,
    );
    const first = await runWorkflow(script, {
      runId: "recording",
      agent: {
        async run(_prompt, options) {
          options?.onUsage?.(usage(9));
          return "live";
        },
      },
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    });
    assert.equal(first.calls?.length, 2);

    const replay = await runWorkflow(script, {
      runId: "replay",
      agent: { async run() { throw new Error("must not run"); } },
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      persistLogs: false,
    });
    assert.deepEqual(replay.calls?.map((row) => row.origin), ["journal-replay", "journal-replay"]);
    assert.deepEqual(replay.calls?.[0].usage, usage(9));
    assert.equal(Object.hasOwn(replay.calls?.[0] ?? {}, "budgetDebit"), false);
  });

  it("puts the same recorded-error projection on the manifest row and terminal event", async () => {
    let row: WorkflowCallRecord | undefined;
    let eventError: unknown;
    const result = await runWorkflow(
      meta("error-event", `try { await agent('hard', { label: 'hard' }) } catch {}\nreturn 'caught'`),
      {
        agent: {
          async run() {
            throw new WorkflowError("typed", WorkflowErrorCode.AUTH_REQUIRED, {
              recoverable: false,
              agentLabel: "hard",
              details: { public: true },
              resetHint: "later",
              providerUsageLimitContext: {
                backendId: "claude",
                source: "provider",
                providerCode: "rate_limit",
                resetAt: "2026-07-15T09:00:00.000Z",
              },
              authContext: { backendId: "backend", methods: [] },
            });
          },
        },
        persistLogs: false,
        onCallRecord: (record) => { row = record; },
        onAgentEnd: (event) => { eventError = event.errorRecord; },
      },
    );
    assert.equal(result.result, "caught");
    assert.equal(eventError, row?.error);
    assert.deepEqual(row?.error, {
      form: "workflow-error",
      message: "typed",
      code: WorkflowErrorCode.AUTH_REQUIRED,
      recoverable: false,
      agentLabel: "hard",
      details: { public: true },
      resetHint: "later",
      providerUsageLimitContext: {
        backendId: "claude",
        source: "provider",
        providerCode: "rate_limit",
        resetAt: "2026-07-15T09:00:00.000Z",
      },
      authContext: { backendId: "backend", methods: [] },
    });
  });

  it("records engine-side cwd death and signal abort after allocation", async () => {
    const engineRows: WorkflowCallRecord[] = [];
    const cwdFailure = await runWorkflow(
      meta("cwd-death", `try { await agent('bad', { label: 'bad', cwd: 42 }) } catch {}\nreturn 'caught'`),
      {
        runId: "cwd-death",
        agent: { async run() { return "unused"; } },
        persistLogs: false,
      },
    );
    assert.equal(cwdFailure.calls?.[0].origin, "engine");
    assert.equal(cwdFailure.calls?.[0].outcome, "error");

    const controller = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const run = runWorkflow(meta("abort-row", `return await agent('wait', { label: 'wait' })`), {
      runId: "abort-row",
      signal: controller.signal,
      agent: {
        async run(_prompt, options) {
          started();
          return await new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new WorkflowError("cancelled", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })),
              { once: true },
            );
          });
        },
      },
      persistLogs: false,
      onCallRecord: (row) => engineRows.push(row),
    });
    await didStart;
    controller.abort();
    await assert.rejects(run, (error: unknown) => error instanceof WorkflowError);
    assert.equal(engineRows.length, 1);
    assert.equal(engineRows[0].origin, "engine");
    assert.equal(engineRows[0].aborted, true);
  });

  it("returns current effective limits and observational provider/estimate token usage without budget fields", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "manifest-cwd-"));
    try {
      let call = 0;
      const result = await runWorkflow(
        meta(
          "limits-debits",
          `const a = await agent('a', { label: 'a' })
const b = await agent('long prompt', { label: 'b' })
return [a, b]`,
        ),
        {
          cwd,
          agent: {
            async run(_prompt, options) {
              call++;
              if (call === 1) options?.onUsage?.(usage(11));
              return call === 1 ? "x" : "four";
            },
          },
          maxAgents: 7,
          concurrency: 3,
          agentRetries: 99,
          persistLogs: false,
        },
      );
      assert.deepEqual(result.effectiveLimits, {
        maxAgents: 7,
        concurrency: 3,
        agentRetries: 3,
      });
      const estimated = Math.ceil(JSON.stringify("four").length / 4) +
        Math.ceil(JSON.stringify("long prompt").length / 4);
      assert.equal(result.tokenUsage?.total, 11 + estimated);
      assert.equal(result.calls?.some((row) => Object.hasOwn(row, "budgetDebit")), false);
      assert.equal(Object.hasOwn(result.effectiveLimits ?? {}, "tokenBudget"), false);
      assert.equal(result.calls?.every((row) => row.resolvedCwd === cwd), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("assigns settlement ordinals by terminal transition rather than call index", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const result = await runWorkflow(
      meta(
        "parallel-settlement",
        `const pending = parallel([
  () => agent('slow', { label: 'same' }),
  () => agent('fast', { label: 'same' })
])
return await pending`,
      ),
      {
        concurrency: 2,
        agent: {
          async run(prompt) {
            if (prompt === "slow") await firstBlocked;
            else setTimeout(releaseFirst, 5);
            return prompt;
          },
        },
        persistLogs: false,
      },
    );
    assert.deepEqual(result.calls?.map((row) => row.index), [1, 0]);
    assert.deepEqual(result.calls?.map((row) => row.settlementOrdinal), [1, 2]);
  });

  it("leaves pre-allocation gate failures invisible and settles floated allocations", async () => {
    const gated = await runWorkflow(
      meta(
        "pre-gate",
        `await agent('one', { label: 'one' })
try { await agent('two', { label: 'two' }) } catch {}
return 'done'`,
      ),
      { agent: { async run() { return "ok"; } }, maxAgents: 1, persistLogs: false },
    );
    assert.equal(gated.callsAllocated, 1);
    assert.deepEqual(gated.calls?.map((row) => row.index), [0]);

    let finish!: (value: string) => void;
    const floated = await runWorkflow(
      meta("floated", `void agent('later', { label: 'later' })\nreturn 'early'`),
      {
        agent: { async run() { return await new Promise<string>((resolve) => { finish = resolve; }); } },
        persistLogs: false,
      },
    );
    assert.equal(floated.callsAllocated, 1);
    assert.equal(floated.calls?.length, 1);
    assert.equal(floated.calls?.[0].origin, "engine");
    assert.equal(floated.calls?.[0].error?.code, WorkflowErrorCode.WORKFLOW_ABORTED);
    finish("late");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(floated.calls?.length, 1, "the returned authoritative snapshot is not mutated by the late settlement");
  });
});
