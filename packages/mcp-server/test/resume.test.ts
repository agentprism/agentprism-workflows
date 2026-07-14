import test from "node:test";
import assert from "node:assert/strict";

import { connect, countingRunner, structured, TWO_AGENT_SCRIPT } from "./_harness.js";

/** Read a nested field off an unknown (JSON-deserialized, possibly null-prototype) object. */
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** Assert a deserialized `{ a, b }` result regardless of its prototype. */
function assertAlphaBeta(result: unknown): void {
  assert.equal(field(result, "a"), "r:alpha:1", "agent[0] result carries the run-1 invocation counter");
  assert.equal(field(result, "b"), "r:beta:2", "agent[1] result carries the run-1 invocation counter");
}

const RESUME_LOOP_CAP_SCRIPT = `export const meta = { name: 'resume-loop-cap', description: 'Run expensive review rounds up to an args-controlled cap', phases: [{ title: 'Review' }] };
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

test("resumeFromRunId loads the persisted journal and REPLAYS it (runner is not re-invoked)", async () => {
  // The same server == one WorkflowManager == one shared persistence, so a journal
  // written by the first call is loadable by the second. The counting runner is the
  // proof: on resume the engine replays cached results without calling run() again.
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    // ---- First run: two live agents, journaled under runId R1. ----
    const r1 = await client.callTool({ name: "workflow", arguments: { script: TWO_AGENT_SCRIPT } });
    const sc1 = structured(r1);
    assert.equal(r1.isError, false);
    assert.equal(sc1?.status, "completed");
    assert.equal(calls(), 2, "first run invokes the runner once per agent()");
    assertAlphaBeta(sc1?.result);
    const runId1 = String(sc1?.runId);
    assert.ok(runId1.length > 0);

    // ---- Resume from R1's journal: same script, so the whole prefix is cache-valid. ----
    const r2 = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, resumeFromRunId: runId1 },
    });
    const sc2 = structured(r2);
    assert.equal(r2.isError, false);
    assert.equal(sc2?.status, "completed");
    assert.equal(calls(), 2, "resume REPLAYS the journal — the runner is NOT invoked again");
    // The replayed values are the journaled run-1 results (counter :1/:2), proving the
    // engine served the cache rather than re-executing (which would yield :3/:4).
    assertAlphaBeta(sc2?.result);
    assert.notEqual(String(sc2?.runId), runId1, "resume runs under a fresh engine run id");
  } finally {
    await dispose();
  }
});

test("changed args can raise a loop cap while the unchanged call prefix replays", async () => {
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { script: RESUME_LOOP_CAP_SCRIPT, args: { maxRounds: 6 } },
    });
    const firstContent = structured(first);
    assert.equal(firstContent?.status, "failed");
    assert.equal(calls(), 6);
    const firstRunId = String(firstContent?.runId);
    assert.ok(firstRunId.length > 0);

    const second = await client.callTool({
      name: "workflow",
      arguments: {
        script: RESUME_LOOP_CAP_SCRIPT,
        args: { maxRounds: 8 },
        resumeFromRunId: firstRunId,
      },
    });
    const secondContent = structured(second);
    assert.equal(secondContent?.status, "completed");
    assert.equal(calls(), 8, "six replay hits plus two live calls produce eight total runner invocations");
    const rounds = field(secondContent?.result, "rounds") as string[];
    assert.deepEqual(Array.from(rounds.slice(0, 6)), [1, 2, 3, 4, 5, 6].map(
      (round) => `r:Review round ${round}: inspect the repository and report unresolved release blockers.:${round}`,
    ));
    assert.deepEqual(Array.from(rounds.slice(6)), [
      "r:Review round 7: inspect the repository and report unresolved release blockers.:7",
      "r:Review round 8: inspect the repository and report unresolved release blockers.:8",
    ]);
    assert.notEqual(String(secondContent?.runId), firstRunId);
  } finally {
    await dispose();
  }
});

test("an args-caused middle prompt miss reruns the unchanged-looking suffix", async () => {
  const script = `export const meta = { name: 'args-prefix', description: 'args-driven prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent(String(args.middle), { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner);
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { script, args: { middle: "B" } },
    });
    const firstRunId = String(structured(first)?.runId);
    assert.equal(calls(), 3);

    const second = await client.callTool({
      name: "workflow",
      arguments: { script, args: { middle: "B-edited" }, resumeFromRunId: firstRunId },
    });
    const result = structured(second)?.result;
    assert.equal(calls(), 5, "only the middle call and complete suffix run live");
    assert.deepEqual(
      { a: field(result, "a"), b: field(result, "b"), c: field(result, "c") },
      { a: "r:A:1", b: "r:B-edited:4", c: "r:C:5" },
    );
  } finally {
    await dispose();
  }
});

test("resumeFromRunId for an unknown run finds no journal and runs fresh (no replay)", async () => {
  // Confirms the replay above came from the loaded journal: with no persisted journal to
  // load, the engine runs every agent() live, so the runner IS invoked.
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner);
  try {
    const res = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, resumeFromRunId: "no-such-run-id" },
    });
    const sc = structured(res);
    assert.equal(res.isError, false);
    assert.equal(sc?.status, "completed");
    assert.equal(calls(), 2, "an unknown resume id loads nothing — both agents run live");
    assertAlphaBeta(sc?.result);
  } finally {
    await dispose();
  }
});
