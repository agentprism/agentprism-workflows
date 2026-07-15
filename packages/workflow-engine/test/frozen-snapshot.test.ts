import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner, JournalEntry, WorkflowCallRecord } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createRunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";

const script = (body: string) =>
  `export const meta = { name: 'frozen', description: 'frozen snapshots' }\n${body}`;

describe("record-time frozen snapshots", () => {
  it("uses one frozen result snapshot for journal and terminal event while returning the runner original", async () => {
    const original = { nested: { value: 1 } };
    let journal: JournalEntry | undefined;
    let eventResult: unknown;
    const result = await runWorkflow(
      script(`const value = await agent('value', { label: 'value', schema: { type: 'object' } })
value.nested.value = 2
return value.nested.value`),
      {
        agent: { async run() { return original as never; } },
        persistLogs: false,
        onAgentJournal: (entry) => { journal = entry; },
        onAgentEnd: (event) => { eventResult = event.result; },
      },
    );

    assert.equal(result.result, 2);
    assert.equal(original.nested.value, 2, "the script receives the runner's original object");
    assert.equal(journal?.result, eventResult, "journal and terminal event share one snapshot");
    assert.deepEqual(journal?.result, { nested: { value: 1 } });
    assert.equal(Object.isFrozen(journal?.result), true);
    assert.equal(Object.isFrozen((journal?.result as { nested: object }).nested), true);
  });

  it("prevents a manager journal listener from changing the persisted result", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "frozen-manager-"));
    const persistenceRoot = mkdtempSync(join(tmpdir(), "frozen-manager-root-"));
    try {
      const manager = new WorkflowManager({
        cwd,
        persistenceRoot,
        agent: { async run() { return { stable: true }; } },
      });
      let mutationThrew = false;
      manager.on("journal", ({ entry }: { entry: JournalEntry }) => {
        try {
          (entry.result as { stable: boolean }).stable = false;
        } catch {
          mutationThrew = true;
        }
      });
      const result = await manager.runSync(
        script(`return await agent('value', { label: 'value', schema: { type: 'object' } })`),
      );
      const persisted = createRunPersistence(cwd, undefined, { persistenceRoot }).load(result.runId);
      assert.equal(mutationThrew, true);
      assert.deepEqual(persisted?.journal?.[0].result, { stable: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  });

  it("rejects every non-strict-JSON result shape with a typed path-bearing error", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "bad", { enumerable: true, get: () => 1 });
    class Custom { value = 1; }
    const cases: Array<[string, unknown]> = [
      ["cycle", cyclic],
      ["bigint", 1n],
      ["date", new Date(0)],
      ["map", new Map([["a", 1]])],
      ["nan", Number.NaN],
      ["undefined-member", { flag: undefined }],
      ["accessor", accessor],
      ["custom-prototype", new Custom()],
    ];

    for (const [name, value] of cases) {
      const rows: WorkflowCallRecord[] = [];
      await assert.rejects(
        runWorkflow(script(`return await agent('bad', { label: ${JSON.stringify(name)} })`), {
          agent: { async run() { return value as never; } },
          persistLogs: false,
          onCallRecord: (row) => rows.push(row),
        }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError, name);
          assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR, name);
          assert.match(error.message, /agent .* result is not strict JSON at \$/, name);
          return true;
        },
      );
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].outcome, "error", name);
      assert.equal(rows[0].error?.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR, name);
    }
  });

  it("accepts real vm-realm plain records and preserves JSON-observable members", async () => {
    const runner: AgentRunner = {
      async run(_prompt, options) {
        return options?.meta as never;
      },
    };
    const result = await runWorkflow(
      script(`const fromAgent = await agent('echo', {
  label: 'echo',
  schema: { type: 'object' },
  meta: { flag: null, nested: { order: ['a', 'b'] } }
})
const fromCheckpoint = await checkpoint('default', { default: { flag: null } })
return {
  fromAgent,
  agentHasFlag: 'flag' in fromAgent,
  fromCheckpoint,
  checkpointHasFlag: 'flag' in fromCheckpoint
}`),
      { agent: runner, persistLogs: false },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      fromAgent: { flag: null, nested: { order: ["a", "b"] } },
      agentHasFlag: true,
      fromCheckpoint: { flag: null },
      checkpointHasFlag: true,
    });
  });

  it("records confirm/headless reply validation failures with their proper origins", async () => {
    const confirmed = await runWorkflow(
      script(`try { await checkpoint('undefined reply') } catch (error) { return error.code }`),
      {
        agent: { async run() { return "unused"; } },
        confirm: async () => undefined,
        persistLogs: false,
      },
    );
    assert.equal(confirmed.result, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(confirmed.calls?.[0].origin, "confirm");
    assert.equal(confirmed.calls?.[0].outcome, "error");
    assert.match(confirmed.calls?.[0].error?.message ?? "", /undefined reply.*\$/);

    const headless = await runWorkflow(
      script(`try { await checkpoint('map reply', { default: new Map([['a', 1]]) }) } catch (error) { return error.code }`),
      { agent: { async run() { return "unused"; } }, persistLogs: false },
    );
    assert.equal(headless.result, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(headless.calls?.[0].origin, "headless");
  });

  it("projects workflow errors, plain errors, thrown values, and lossy guarded reads", async () => {
    const plain = new TypeError("bad route") as TypeError & { route: string; causeData: unknown };
    plain.route = "west";
    plain.causeData = { retry: false };
    const plainRun = await runWorkflow(
      script(`try { await checkpoint('plain') } catch {}\nreturn 'caught'`),
      {
        agent: { async run() { return "unused"; } },
        confirm: async () => { throw plain; },
        persistLogs: false,
      },
    );
    assert.deepEqual(plainRun.calls?.[0].error, {
      form: "error",
      name: "TypeError",
      message: "bad route",
      props: { route: "west", causeData: { retry: false } },
    });

    const valueRun = await runWorkflow(
      script(`try { await checkpoint('value') } catch {}\nreturn 'caught'`),
      {
        agent: { async run() { return "unused"; } },
        confirm: async () => { throw { reason: "no" }; },
        persistLogs: false,
      },
    );
    assert.deepEqual(valueRun.calls?.[0].error, { form: "value", value: { reason: "no" } });

    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "name", { get: () => { throw new Error("getter"); } });
    const lossyRun = await runWorkflow(
      script(`try { await checkpoint('hostile') } catch {}\nreturn 'caught'`),
      {
        agent: { async run() { return "unused"; } },
        confirm: async () => { throw hostile; },
        persistLogs: false,
      },
    );
    assert.equal(lossyRun.calls?.[0].error?.form, "error");
    assert.equal(lossyRun.calls?.[0].error?.message, "hostile");
    assert.equal(lossyRun.calls?.[0].error?.lossy, true);
  });
});
