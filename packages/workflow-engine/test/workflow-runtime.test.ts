import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// Adapted import: AgentUsage is part of the frozen seam contract, which now lives in
// @automatalabs/shared-types (pi imported it from "../src/agent.js"). The engine re-exports
// it, but importing from its canonical home keeps the seam explicit.
import type { AgentUsage } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("runWorkflow concurrency caps parallel agents", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const started: Array<string> = [];
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(prompt);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'concurrency_cap', description: 'cap parallelism' }
const xs = await parallel(['a','b','c','d'].map((p) => () => agent(p, { label: p })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 2, "only the first two agents should start before the gate opens");
  release.resolve();
  const result = await run;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.result, ["ok:a", "ok:b", "ok:c", "ok:d"]);
  assert.equal(result.agentCount, 4);
});

test("agent() forwards mode to the runner options bag", async () => {
  const seen: Array<string | undefined> = [];
  await runWorkflow(
    `export const meta = { name: 'mode_threading', description: 'mode threading' }
const r = await agent('x', { label: 'mode-agent', mode: 'read-only' })
return r`,
    {
      agent: {
        async run(_prompt: string, options: { mode?: string }) {
          seen.push(options.mode);
          return "ok";
        },
      },
      persistLogs: false,
    },
  );

  assert.deepEqual(seen, ["read-only"]);
});

test("agent() forwards configOptions to the runner without coercion", async () => {
  const seen: Array<Record<string, string | boolean> | undefined> = [];
  await runWorkflow(
    `export const meta = { name: 'config_threading', description: 'config threading' }
return agent('x', { label: 'config-agent', configOptions: { reasoning_effort: 'high', fast_mode: true } })`,
    {
      agent: {
        async run(_prompt: string, options: { configOptions?: Record<string, string | boolean> }) {
          seen.push(options.configOptions);
          return "ok";
        },
      },
      persistLogs: false,
    },
  );

  assert.equal(seen.length, 1);
  assert.deepEqual(Object.entries(seen[0] ?? {}), [
    ["reasoning_effort", "high"],
    ["fast_mode", true],
  ]);
});

test('configOptions "model" is rejected before the runner can open a session', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'config_model', description: 'reserved config' }
return agent('x', { label: 'reserved-call', configOptions: { model: 'shadow-model' } })`,
        {
          agent: {
            async run() {
              calls++;
              return "must not run";
            },
          },
          persistLogs: false,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.equal(error.agentLabel, "reserved-call");
      assert.match(error.message, /reserved-call/);
      assert.match(error.message, /shadow-model/);
      assert.match(error.message, /model field/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("agent() rejects unknown option keys before allocation or runner invocation", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'foreign_options', description: 'reject foreign option dialects' }
return agent('x', { label: 'pi-call', backend: 'pi', model: 'openai/model', config: { thinkingLevel: 'high' } })`,
        {
          agent: {
            async run() {
              calls++;
              return "must not run";
            },
          },
          persistLogs: false,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.equal(error.agentLabel, "pi-call");
      assert.match(error.message, /agent "pi-call" options contain unknown keys "backend", "config"/);
      assert.match(error.message, /valid keys: label, phase, schema, model, mode, configOptions/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("runWorkflow retries recoverable empty output then succeeds", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_success', description: 'retry success' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1, "retries should not allocate extra logical agent slots");
  assert.equal(journal.length, 1, "only the final success is journaled");
});

test("runWorkflow returns null when recoverable retries are exhausted", async () => {
  let calls = 0;
  const logs: string[] = [];
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_exhausted', description: 'retry exhausted' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return "";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, null);
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1);
  assert.equal(journal.length, 0, "failed/null recoverable results are not journaled");
  assert.ok(
    logs.some((message) => /retrying/i.test(message)),
    "logs should mention retrying",
  );
  assert.ok(
    logs.some((message) => /exhausted/i.test(message)),
    "logs should mention exhaustion",
  );
});

test("runWorkflow journaling:false skips journal callbacks and rejects resume inputs", async () => {
  const agent = countingAgent();
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'no_journal', description: 'no journal' }
const a = await agent('work', { label: 'a' })
return a`;

  const result = await runWorkflow(script, {
    agent: agent.runner,
    journaling: false,
    onAgentJournal: (entry) => journal.push(entry),
  });

  assert.equal(result.result, "ran:work");
  assert.equal(agent.state.calls, 1);
  assert.deepEqual(journal, [], "journaling:false should suppress onAgentJournal writes");
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: agent.runner,
        journaling: false,
        resumeJournal: new Map(),
      }),
    /journaling disabled for this run/,
  );
});

test("runWorkflow does not retry nonrecoverable errors", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'no_retry_nonrecoverable', description: 'nonrecoverable' }
const a = await agent('work', { label: 'a' })
return a`,
      {
        agent: {
          async run() {
            calls++;
            throw new WorkflowError("hard stop", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
        agentRetries: 2,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(calls, 1);
});

test("per-agent retries override run-level retries", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'agent_retry_override', description: 'override' }
const a = await agent('work', { label: 'a', retries: 1 })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 0,
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
});

test("runWorkflow accumulates real per-agent usage (incl. cost + cache tokens)", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002, cacheRead: 50, cacheWrite: 10 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9, "should be within tolerance");
  assert.equal(result.tokenUsage?.cacheRead, 100, "cacheRead accumulates across agents");
  assert.equal(result.tokenUsage?.cacheWrite, 20, "cacheWrite accumulates across agents");
});

test("meta.model is parsed and routes as the default model for agents", async () => {
  let seenModel: string | undefined;
  const recorder = {
    async run(_p: string, o: { model?: string }) {
      seenModel = o.model;
      return "ok";
    },
  };
  const script = `export const meta = { name: 'm', description: 'd', model: 'meta/default-model' }
await agent('x', { label: 'x' })
return 1`;
  await runWorkflow(script, { agent: recorder, persistLogs: false });
  assert.equal(seenModel, "meta/default-model", "an agent with no model/tier/phase route uses meta.model");
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("agents default to the first declared phase when the script omits phase()", async () => {
  // Regression for the "(no phase) has agents, declared phase 0/0" bug: a script
  // that declares meta.phases but never calls phase() should still group its
  // agents under the first declared phase, not an orphan "(no phase)" bucket.
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Research' }, { title: 'Synthesize' }] }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["Research"]);
});

test("explicit phase() overrides the default first phase", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
     phase('B')
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["B"]);
});

test("no declared phases => agent phase stays undefined (no synthetic phase)", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd' }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, [undefined]);
});

test("runWorkflow routes models: explicit opts.model > phase model > host-pinned default", async () => {
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; onUsage?: (u: AgentUsage) => void }) {
      seen.push(options.model);
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'routing', description: 'model routing',
    phases: [{ title: 'A', model: 'phase-a-model' }, { title: 'B' }]
  }
  phase('A')
  await agent('explicit wins', { label: 'e', model: 'explicit-model' })
  await agent('phase routed', { label: 'p' })
  phase('B')
  await agent('no model -> default', { label: 'n' })
  return {}`;

  await runWorkflow(script, {
    agent: capturingAgent,
    defaultModel: "host/default-backend",
    persistLogs: false,
  });

  assert.deepEqual(seen, ["explicit-model", "phase-a-model", "host/default-backend"]);
});

test("runWorkflow plumbs opts.tier through to the agent with correct precedence", async () => {
  // Regression guard: tier must reach WorkflowAgent.run() (it was previously
  // dropped). Precedence: explicit model > tier > phase model.
  const previousHome = process.env.HOME;
  const emptyHome = mkdtempSync(join(tmpdir(), "agentprism-empty-tier-home-"));
  const seen: Array<{ model?: string; tier?: string }> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; tier?: string }) {
      seen.push({ model: options.model, tier: options.tier });
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'tier_routing', description: 'tier routing',
    phases: [{ title: 'A', model: 'phase-a-model' }]
  }
  phase('A')
  await agent('tier beats phase', { label: 't', tier: 'small' })
  await agent('explicit beats tier', { label: 'e', tier: 'small', model: 'explicit-model' })
  return {}`;

  try {
    process.env.HOME = emptyHome;
    await runWorkflow(script, {
      agent: capturingAgent,
      defaultModel: "host/default-backend",
      persistLogs: false,
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(emptyHome, { recursive: true, force: true });
  }

  // 1) tier set, no explicit model: model is left undefined so the tier (resolved
  //    inside run()) wins over both the phase model and host-pinned default; tier is forwarded.
  assert.deepEqual(seen[0], { model: undefined, tier: "small" });
  // 2) explicit model + tier: explicit model is forwarded and still wins.
  assert.deepEqual(seen[1], { model: "explicit-model", tier: "small" });
});

test("runWorkflow threads the engine runId into the agent run options (correlation id)", async () => {
  // The engine stamps its runId onto every subagent run so the runner can ride it onto the ACP
  // session/new _meta as an end-to-end correlation id. It is additive telemetry — never part of
  // the resume identity hash — so the same script run twice does not change its journal hash.
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { runId?: string }) {
      seen.push(options.runId);
      return "ok";
    },
  };
  const script = `export const meta = { name: 'corr', description: 'correlation' }
  await agent('one', { label: 'a' })
  await agent('two', { label: 'b' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false, runId: "run-CORR-1" });

  // Every subagent in the run sees the same engine runId.
  assert.deepEqual(seen, ["run-CORR-1", "run-CORR-1"]);
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

const threeCallScript = `export const meta = { name: 'prefix', description: 'prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent('B', { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;

test("resume re-runs the changed call AND everything after it (longest-unchanged-prefix)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  // Edit the MIDDLE call (index 1). Index 0 is an unchanged prefix → cache hit.
  // Index 1 changed → re-run; index 2 is unchanged but AFTER the first miss, so
  // it must re-run too (the bug was serving it stale from the journal).
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run; only the prefix (0) is cached");
});

const resumeLoopCapScript = `export const meta = { name: 'resume-loop-cap', description: 'Run expensive review rounds up to an args-controlled cap', phases: [{ title: 'Review' }] };
const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
const numericCap = Number(input.maxRounds);
const maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;
phase('Review');
const rounds = [];
for (let i = 0; i < maxRounds; i += 1) {
  rounds.push(await agent(\`Review round \${i + 1}: inspect the repository and report unresolved release blockers.\`, { label: \`review:\${i + 1}\`, phase: 'Review' }));
}
if (maxRounds < 8) throw new Error(\`review cap \${maxRounds} reached before 8 rounds\`);
return { rounds };`;

test("resume with a raised args-controlled cap replays the unchanged prefix", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await assert.rejects(
    runWorkflow(resumeLoopCapScript, {
      agent: first.runner,
      args: { maxRounds: 6 },
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    }),
    /review cap 6 reached before 8 rounds/,
  );
  assert.equal(first.state.calls, 6);
  assert.equal(journal.length, 6);

  const second = countingAgent();
  const resumed = await runWorkflow(resumeLoopCapScript, {
    agent: second.runner,
    args: { maxRounds: 8 },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  const rounds = (resumed.result as { rounds: string[] }).rounds;
  assert.equal(second.state.calls, 2, "only the two newly reachable rounds run live");
  assert.equal(rounds.length, 8);
  assert.deepEqual(
    JSON.parse(JSON.stringify(rounds.slice(0, 6))),
    journal.map((entry) => entry.result),
    "the first six values come from the original journal",
  );
});

test("an args-caused middle prompt change invalidates that call and the complete suffix", async () => {
  const script = `export const meta = { name: 'args-prefix', description: 'args-driven prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent(String(args.middle), { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: first.runner,
    args: { middle: "B" },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });

  const second = countingAgent();
  const resumed = await runWorkflow(script, {
    agent: second.runner,
    args: { middle: "B-edited" },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(second.state.calls, 2, "the changed middle call and unchanged-looking final call run live");
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), {
    a: journal[0].result,
    b: "ran:B-edited",
    c: "ran:C",
  });
});

test("resume in parallel(): editing one thunk re-runs that index and every later one", async () => {
  // Three identical-prompt thunks; editing the middle one must invalidate it and
  // the same-or-later index, not just the single changed call.
  const script = (mid: string) => `export const meta = { name: 'par_prefix', description: 'parallel prefix' }
  const xs = await parallel([
    () => agent('x', { label: 'p0' }),
    () => agent('${mid}', { label: 'p1' }),
    () => agent('x', { label: 'p2' }),
  ])
  return xs`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script("x"), {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  const second = countingAgent();
  await runWorkflow(script("x-edited"), {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "changed thunk (index 1) + later index (2) re-run; index 0 cached");
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("workflow() runs a nested saved workflow and shares the global agent counter", async () => {
  const child = `export const meta = { name: 'child', description: 'c' }
const r = await agent('child task', { label: 'c' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await agent('parent task', { label: 'p' })
const nested = await workflow('child', { foo: 1 })
return { a, nested }`;

  const result = await runWorkflow<{ a: string; nested: { child: string } }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.result.nested.child, "ran:child task");
});

test("workflow() nesting is one level deep (second level throws)", async () => {
  const map: Record<string, string> = {
    gc: `export const meta = { name: 'gc', description: 'g' }
await agent('gc', { label: 'g' })
return 1`,
    child: `export const meta = { name: 'child', description: 'c' }
await workflow('gc')
return 2`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
let err = null
try { await workflow('child') } catch (e) { err = String(e && e.message || e) }
return { err }`;

  const result = await runWorkflow<{ err: string }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => map[name],
  });
  assert.match(result.result.err, /one level deep/);
});

test("non-recoverable agent-limit propagates out of pipeline() too", async () => {
  const script = `export const meta = { name: 'mp', description: 'agent limit pipeline' }
const xs = await pipeline([0, 1, 2, 3], (n) => agent('x' + n, { label: 'p' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("maxAgents is enforced under a parallel() fan-out (atomic slot reservation)", async () => {
  // Four agents fan out with maxAgents=2. With the synchronous slot reservation,
  // the 3rd agent() throws AGENT_LIMIT instead of all four passing the gate.
  const script = `export const meta = { name: 'ma', description: 'agent limit' }
const xs = await parallel([0, 1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

// ─── Additional edge case tests ─────────────────────────────────────────────────

test("runWorkflow returns meta, logs, phases, and duration", async () => {
  const ONE_AGENT = `export const meta = { name: 'meta_test', description: 'check metadata' }
const a = await agent('test', { label: 'a' })
return a`;

  const result = await runWorkflow(ONE_AGENT, {
    agent: fakeAgent({ total: 50 }),
    persistLogs: false,
  });

  assert.equal(result.meta.name, "meta_test");
  assert.equal(result.meta.description, "check metadata");
  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
  assert.ok(Array.isArray(result.phases), "result.phases should be an array");
  assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId should be a non-empty string");
});

test("runWorkflow handles empty script without phases gracefully", async () => {
  const SIMPLE = `export const meta = { name: 'simple', description: 'simple' }
const a = await agent('hello', { label: 'greeter' })
return a`;

  const result = await runWorkflow(SIMPLE, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.equal(result.result, "done");
  assert.equal(result.agentCount, 1);
});

test("runWorkflow parallel returns results in input order", async () => {
  const script = `export const meta = { name: 'parallel_order', description: 'check order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n, { label: 't' + n })))
return results`;

  let callIndex = 0;
  const agent = {
    async run(prompt: string) {
      return `result-${++callIndex}:${prompt}`;
    },
  };

  const result = await runWorkflow<unknown[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 3);
});

test("runWorkflow pipeline stages in order", async () => {
  const script = `export const meta = { name: 'pipeline_test', description: 'test pipeline' }
const results = await pipeline(['a','b'], item => agent('stage1 ' + item), result => agent('stage2 ' + result))
return results`;

  const log: string[] = [];
  const agent = {
    async run(prompt: string) {
      log.push(prompt);
      return prompt.replace("stage1", "stage1-done").replace("stage2", "stage2-done");
    },
  };

  const result = await runWorkflow<string[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 2);
});

test("runWorkflow agent with different labels", async () => {
  const script = `export const meta = { name: 'label_test', description: 'labels' }
const a = await agent('task1', { label: 'worker-1' })
const b = await agent('task2', { label: 'worker-2' })
return { a, b }`;

  const seenLabels: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentStart: (e) => seenLabels.push(e.label),
  });

  assert.deepEqual(seenLabels, ["worker-1", "worker-2"]);
});

test("runWorkflow with phases assignment to agents", async () => {
  const script = `export const meta = { name: 'phase_test', description: 'phases', phases: [{ title: 'Phase1' }, { title: 'Phase2' }] }
phase('Phase1')
const a = await agent('phase1 work', { label: 'p1' })
phase('Phase2')
const b = await agent('phase2 work', { label: 'p2' })
return { a, b }`;

  const phases: string[] = [];
  const agentPhases: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onAgentStart: (e) => {
      if (e.phase) agentPhases.push(e.phase);
    },
  });

  assert.ok(phases.includes("Phase1"), "should contain Phase1");
  assert.ok(phases.includes("Phase2"), "should contain Phase2");
});

test("runWorkflow can send args to the script", async () => {
  const script = `export const meta = { name: 'args_test', description: 'test args' }
return { received: args && args.value }`;

  const result = await runWorkflow<{ received: unknown }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    args: { value: 42 },
  });

  // No agent calls means 0 agents
  assert.equal(result.result.received, 42);
});

test("runWorkflow log function works inside script", async () => {
  const script = `export const meta = { name: 'log_test', description: 'logging' }
log('hello from script')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("hello from script")),
    "should contain hello from script",
  );
});

test("runWorkflow console.log works inside script", async () => {
  const script = `export const meta = { name: 'console_test', description: 'console' }
console.log('console log')
console.warn('console warn')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("console log")),
    "should contain console log",
  );
  assert.ok(
    result.logs.some((l) => l.includes("console warn")),
    "should contain console warn",
  );
});

test("runWorkflow process.cwd() works inside script", async () => {
  const script = `export const meta = { name: 'cwd_test', description: 'cwd' }
return { cwd: process.cwd() }`;

  const result = await runWorkflow<{ cwd: string }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.equal(typeof result.result.cwd, "string");
  assert.ok(result.result.cwd.length > 0, "result.cwd should not be empty");
});

test("§7: the budget surface is deleted — `budget` is undefined in the script realm and phase(title, { budget }) is a script error", async () => {
  const script = `export const meta = { name: 'no_budget', description: 'the deleted budget surface' }
const seen = typeof budget
phase('noisy')
await agent('x', { label: 'a' })
return { seen }`;

  const result = await runWorkflow<{ seen: string }>(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.equal(result.result.seen, "undefined", "the budget global is deleted from the script realm");

  // The per-phase budget option is deleted too: phase takes NO options
  // anymore, so a second argument is a SCRIPT_ERROR naming the deleted
  // surface (not a silently ignored options bag).
  const budgetPhase = `export const meta = { name: 'no_phase_budget', description: 'the deleted per-phase budget' }
phase('p', { budget: 0 })
return 1`;
  await assert.rejects(
    runWorkflow(budgetPhase, { agent: fakeAgent({ total: 10 }), persistLogs: false }),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_ERROR &&
      /phase\(\) takes no options/.test(error.message),
    "phase(title, { budget }) fails the script with the deleted-option error",
  );
});

test("runWorkflow returns empty logs array when nothing logged", async () => {
  const script = `export const meta = { name: 'no_log', description: 'no logs' }
await agent('silent', { label: 's' })
return 1`;

  const result = await runWorkflow(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
});

test("gate returns the structured first-pass verdict with extra fields intact", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'gate_structured', description: 'structured verdict' }
const expected = { ok: true, commitSha: '9f4c2e17d8a6', scores: { correctness: 1, coverage: 0.96 } }
const outcome = await gate(
  () => ({ branch: 'issue-131', tests: 148 }),
  () => expected,
)
return { outcome, sameVerdict: outcome.verdict === expected }`,
    { agent: noopAgent, persistLogs: false },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    outcome: {
      ok: true,
      value: { branch: "issue-131", tests: 148 },
      verdict: {
        ok: true,
        commitSha: "9f4c2e17d8a6",
        scores: { correctness: 1, coverage: 0.96 },
      },
      attempts: 1,
    },
    sameVerdict: true,
  });
});

test("gate threads rejection feedback and returns the third passing attempt", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'gate_feedback', description: 'feedback threading' }
const feedbackSeen = []
const outcome = await gate(
  (feedback, attempt) => {
    feedbackSeen.push(feedback === undefined ? null : feedback)
    return { revision: attempt + 1, appliedFeedback: feedback ?? null }
  },
  (value) => value.revision < 3
    ? { ok: false, feedback: 'fix revision ' + value.revision, rejectedRevision: value.revision }
    : { ok: true, commitSha: 'third-pass', reviewedRevision: value.revision },
  { attempts: 5 },
)
return { outcome, feedbackSeen }`,
    { agent: noopAgent, persistLogs: false },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    outcome: {
      ok: true,
      value: { revision: 3, appliedFeedback: "fix revision 2" },
      verdict: { ok: true, commitSha: "third-pass", reviewedRevision: 3 },
      attempts: 3,
    },
    feedbackSeen: [null, "fix revision 1", "fix revision 2"],
  });
});

test("gate exhaustion returns only the final producer value and rejection verdict", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'gate_exhaustion', description: 'final rejection' }
return await gate(
  (_feedback, attempt) => ({ revision: attempt + 1 }),
  (value) => ({ ok: false, feedback: 'reject ' + value.revision, rejectionCode: 'R' + value.revision }),
  { attempts: 2 },
)`,
    { agent: noopAgent, persistLogs: false },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    ok: false,
    value: { revision: 2 },
    verdict: { ok: false, feedback: "reject 2", rejectionCode: "R2" },
    attempts: 2,
  });
});

test("gate accepts bare true and exhausts bare false without feedback", async () => {
  const passing = await runWorkflow(
    `export const meta = { name: 'gate_true', description: 'boolean pass' }
return await gate(() => 'accepted', () => true)`,
    { agent: noopAgent, persistLogs: false },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(passing.result)), {
    ok: true,
    value: "accepted",
    verdict: true,
    attempts: 1,
  });

  const rejecting = await runWorkflow(
    `export const meta = { name: 'gate_false', description: 'boolean rejection' }
const feedbackSeen = []
const outcome = await gate((feedback, attempt) => {
  feedbackSeen.push(feedback === undefined)
  return attempt
}, () => false)
return { outcome, feedbackSeen }`,
    { agent: noopAgent, persistLogs: false },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(rejecting.result)), {
    outcome: { ok: false, value: 2, verdict: false, attempts: 3 },
    feedbackSeen: [true, true, true],
  });
});

test("gate validates a null producer and preserves its structured rejection", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'gate_null_value', description: 'null producer' }
let validatorSawNull = false
const outcome = await gate(
  () => null,
  (value) => {
    validatorSawNull = value === null
    return { ok: false, feedback: 'The producer returned no result.' }
  },
  { attempts: 0 },
)
return { outcome, validatorSawNull }`,
    { agent: noopAgent, persistLogs: false },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    outcome: {
      ok: false,
      value: null,
      verdict: { ok: false, feedback: "The producer returned no result." },
      attempts: 1,
    },
    validatorSawNull: true,
  });
});

test("gate returns null when the validator returns null or undefined", async () => {
  const nullResult = await runWorkflow(
    `export const meta = { name: 'gate_null_verdict', description: 'null verdict' }
return await gate((_feedback, attempt) => attempt, () => null, { attempts: 2 })`,
    { agent: noopAgent, persistLogs: false },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(nullResult.result)), {
    ok: false,
    value: 1,
    verdict: null,
    attempts: 2,
  });

  const undefinedResult = await runWorkflow(
    `export const meta = { name: 'gate_undefined_verdict', description: 'undefined verdict' }
return await gate(() => 'value', () => undefined, { attempts: 1 })`,
    { agent: noopAgent, persistLogs: false },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(undefinedResult.result)), {
    ok: false,
    value: "value",
    verdict: null,
    attempts: 1,
  });
});

test("gate propagates producer and validator failures without running later callbacks", async () => {
  let validatorAgentCalls = 0;
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'gate_producer_throw', description: 'producer throw' }
return await gate(
  () => { throw new Error('producer boom') },
  () => agent('validator should not run'),
)`,
        {
          agent: {
            async run() {
              validatorAgentCalls++;
              return true;
            },
          },
          persistLogs: false,
        },
      ),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_ERROR &&
      error.message === "producer boom",
  );
  assert.equal(validatorAgentCalls, 0);

  const validatorError = new WorkflowError("validator stopped", WorkflowErrorCode.AUTH_REQUIRED, {
    recoverable: false,
  });
  let runnerCalls = 0;
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'gate_validator_throw', description: 'validator throw' }
return await gate(
  (feedback, attempt) => agent('producer:' + attempt + ':' + String(feedback)),
  () => agent('validator'),
  { attempts: 3 },
)`,
        {
          agent: {
            async run(prompt: string) {
              runnerCalls++;
              if (prompt === "validator") throw validatorError;
              return { attempt: runnerCalls };
            },
          },
          persistLogs: false,
        },
      ),
    (error: unknown) => error === validatorError,
  );
  assert.equal(runnerCalls, 2, "the producer and validator run once before the original error escapes");
});

test("gate retains unsupported legacy object verdicts with truthy ok fields", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'gate_legacy', description: 'legacy object behavior' }
return await gate(
  () => ({ artifact: 'kept' }),
  () => ({ ok: 'legacy-truthy', evidence: { source: 'existing-script' } }),
)`,
    { agent: noopAgent, persistLogs: false },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    ok: true,
    value: { artifact: "kept" },
    verdict: { ok: "legacy-truthy", evidence: { source: "existing-script" } },
    attempts: 1,
  });
});

test("gate replay journals only producer and validator agents and recomputes the verdict", async () => {
  const script = `export const meta = { name: 'gate_replay', description: 'gate replay' }
return await gate(
  () => agent('produce', { label: 'producer' }),
  (value) => agent('validate:' + value.branch, { label: 'validator' }),
)`;
  const journal: JournalEntry[] = [];
  const first = await runWorkflow(script, {
    agent: {
      async run(prompt: string) {
        if (prompt === "produce") return { branch: "issue-131", tests: 148 };
        return { ok: true, commitSha: "9f4c2e17d8a6", scores: { correctness: 1 } };
      },
    },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });

  assert.equal(journal.length, 2, "gate itself must not allocate a journal entry");
  assert.deepEqual(
    journal.map((entry) => entry.index),
    [0, 1],
  );
  assert.ok(journal.every((entry) => /^[a-f0-9]{64}$/.test(entry.hash)));
  assert.deepEqual(JSON.parse(JSON.stringify(first.result)), {
    ok: true,
    value: { branch: "issue-131", tests: 148 },
    verdict: { ok: true, commitSha: "9f4c2e17d8a6", scores: { correctness: 1 } },
    attempts: 1,
  });

  let liveCalls = 0;
  const replayed = await runWorkflow(script, {
    agent: {
      async run() {
        liveCalls++;
        throw new Error("replay called the live runner");
      },
    },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.equal(liveCalls, 0);
  assert.equal(JSON.stringify(replayed.result), JSON.stringify(first.result));
});

// ─── Runtime determinism hardening (P0-5) ───────────────────────────────────────

const noopAgent = {
  async run() {
    return "ok";
  },
};

function probe(expr: string): Promise<{ result: { err: string | null; val: unknown } }> {
  const script = `export const meta = { name: 'det', description: 'determinism' }
let err = null, val = null
try { val = ${expr} } catch (e) { err = String((e && e.message) || e) }
await agent('noop', { label: 'x' })
return { err, val }`;
  return runWorkflow(script, { agent: noopAgent, persistLogs: false });
}

test("parse-time guard rejects direct Date.now / Math.random / new Date() / Date() calls", async () => {
  for (const expr of ["Math.random()", "Date.now()", "new Date()", "Date()"]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'lit', description: 'd' }\nconst v = ${expr}\nawait agent('x', { label: 'x' })\nreturn v`,
          { agent: noopAgent, persistLogs: false },
        ),
      /deterministic|unavailable/i,
      `${expr} should be rejected at parse time`,
    );
  }
});

test("runtime guard catches computed access and aliases outside the direct AST check", async () => {
  const r1 = await probe('Math["random"]()');
  assert.match(r1.result.err ?? "", /unavailable|resume/i, 'Math["random"]() should throw at runtime');
  const r2 = await probe('Date["now"]()');
  assert.match(r2.result.err ?? "", /unavailable|resume/i, 'Date["now"]() should throw at runtime');
  const r3 = await probe("(() => { const D = Date; return new D(); })()");
  assert.match(r3.result.err ?? "", /unavailable|resume/i, "aliased no-arg Date should throw at runtime");
});

test("runtime determinism: new Date(arg) and Math.max still work", async () => {
  const d = await probe("new Date(0).getTime()");
  assert.equal(d.result.err, null, "new Date(0) should construct");
  assert.equal(d.result.val, 0, "new Date(0).getTime() === 0");
  const m = await probe("Math.max(1, 2, 3)");
  assert.equal(m.result.err, null);
  assert.equal(m.result.val, 3);
});

test("vm-realm builtins work and the constructor escape hits the neutered Date.now", async () => {
  // Dynamically compiled source is not a call node in the parsed workflow AST; the vm
  // Function still runs in the vm realm where Date.now is neutered.
  const script = `export const meta = { name: 'vm', description: 'vm realm' }
let escaped = null
try { escaped = ({}).constructor.constructor('return Date.now()')() } catch (e) { escaped = 'blocked:' + String((e && e.message) || e) }
const arr = [1, 2, 3].map((x) => x * 2)
const j = JSON.stringify({ a: 1 })
const s = [...new Set([1, 1, 2])]
await agent('noop', { label: 'x' })
return { escaped, arr, j, s }`;
  const r = await runWorkflow<{ escaped: string; arr: number[]; j: string; s: number[] }>(script, {
    agent: noopAgent,
    persistLogs: false,
  });
  // Spread to a host array: vm-realm arrays don't deepStrictEqual host literals.
  assert.deepEqual([...r.result.arr], [2, 4, 6], "vm Array.map works");
  assert.equal(r.result.j, '{"a":1}', "vm JSON works");
  assert.deepEqual([...r.result.s], [1, 2], "vm Set works");
  // ({}).constructor.constructor is the vm Function; its code runs in the vm realm
  // where Date.now is neutered -> blocked (the old host-object escape is closed).
  assert.match(r.result.escaped, /blocked/, "constructor escape via vm objects is closed");
});
