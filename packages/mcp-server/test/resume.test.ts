import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import {
  connect,
  countingRunner,
  makeRunner,
  persistedRunFile,
  structured,
  textOf,
  TWO_AGENT_SCRIPT,
} from "./_harness.js";

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
  rounds.push(await agent(\`Review round \${i + 1}: inspect the repository and report unresolved release blockers.\`, { label: \`review:\${i + 1}\`, phase: 'Review', resume: { filesystem: 'read-only' } }));
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
    const report = sc2?.resumeReport as Record<string, unknown> | undefined;
    assert.equal(report?.strategy, "identity-v1");
    assert.equal(report?.sourceRunId, runId1);
    assert.equal(report?.requestedPolicy, "auto");
    assert.equal(report?.replayed, 2);
    assert.equal(report?.live, 0);
    assert.equal(report?.failed, 0);
    assert.equal((report?.calls as unknown[])?.length, 2);
    const eligibility = sc2?.replayEligibility as Record<string, unknown> | undefined;
    assert.equal(eligibility?.strategy, "identity-v1");
    assert.equal(eligibility?.predictedReplayablePrefix, 2);
    assert.equal(eligibility?.replayedPrefix, 2);
    assert.equal(eligibility?.engineVersionComparison, "same");
    assert.equal(eligibility?.sourceInputsFormat, 2);
    assert.equal(eligibility?.currentInputsFormat, 2);
    assert.match(
      textOf(r2),
      /^resume: identity-v1; predicted replayable prefix 2; replayed prefix 2; 2 replayed, 0 live, 0 failed$/m,
    );
    assert.doesNotMatch(textOf(r2), /path-hash|unique-hash|recordedIndex/);

    const positional = await client.callTool({
      name: "workflow",
      arguments: {
        script: TWO_AGENT_SCRIPT,
        resumeFromRunId: runId1,
        resumePolicy: "positional",
      },
    });
    const positionalReport = structured(positional)?.resumeReport as Record<string, unknown> | undefined;
    assert.equal(calls(), 2, "the forced positional policy reaches the manager and replays the safe prefix");
    assert.equal(positionalReport?.strategy, "positional-v1");
    assert.equal(positionalReport?.fallbackReason, "forced-positional");
    assert.equal(positionalReport?.eligibility, "safe-prefix");
    assert.equal(positionalReport?.replayed, 2);
    assert.match(
      textOf(positional),
      /^resume: positional-v1\/safe-prefix \(forced-positional\); predicted replayable prefix 2; replayed prefix 2; 2 replayed, 0 live, 0 failed$/m,
    );
  } finally {
    await dispose();
  }
});

test("run, await, inspect, and foreground expose the same replay eligibility diagnostics", async () => {
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const source = await client.callTool({
      name: "workflow",
      arguments: {
        script: TWO_AGENT_SCRIPT,
        agentTimeoutMs: 900_000,
        agentRetries: 1,
        concurrency: 2,
      },
    });
    const sourceRunId = String(structured(source)?.runId);
    const resumeArgs = {
      script: TWO_AGENT_SCRIPT,
      resumeFromRunId: sourceRunId,
      concurrency: 7,
    } as const;

    const accepted = await client.callTool({
      name: "workflow",
      arguments: { ...resumeArgs, background: true },
    });
    const acceptedContent = structured(accepted);
    const acceptedEligibility = acceptedContent?.replayEligibility as Record<string, unknown>;
    assert.equal(acceptedEligibility.strategy, "identity-v1");
    assert.equal(acceptedEligibility.predictedReplayablePrefix, 2);
    assert.equal(acceptedEligibility.replayedPrefix, 0);
    assert.equal(acceptedEligibility.replayed, 0);
    assert.deepEqual(
      (acceptedEligibility.operationalChanges as Array<Record<string, unknown>>).map((change) => change.detail),
      [
        "source recorded agentTimeoutMs=900000; this run: none",
        "source recorded agentRetries=1; this run: 0",
        "source recorded concurrency=2; this run: 7",
      ],
    );
    assert.match(textOf(accepted), /predicted replayable prefix 2/);

    const resumedRunId = String(acceptedContent?.runId);
    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: resumedRunId, waitMs: 1_000 },
    });
    const awaitedContent = structured(awaited);
    const terminalEligibility = awaitedContent?.replayEligibility;
    assert.equal(field(terminalEligibility, "replayedPrefix"), 2);
    assert.deepEqual(field(awaitedContent?.outcome, "replayEligibility"), terminalEligibility);

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: resumedRunId },
    });
    assert.deepEqual(structured(inspected)?.replayEligibility, terminalEligibility);
    assert.match(textOf(inspected), /replayed prefix 2/);

    const foreground = await client.callTool({ name: "workflow", arguments: resumeArgs });
    assert.deepEqual(structured(foreground)?.replayEligibility, terminalEligibility);
    assert.equal(calls(), 2, "operational changes preserve both completed calls across every resume shape");
  } finally {
    await dispose();
  }
});

test("a zero-prefix background acknowledgement warns with a named first miss", async () => {
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const source = await client.callTool({
      name: "workflow",
      arguments: {
        script: "export const meta = { name: 'empty-source', description: 'empty source' }; return null;",
      },
    });
    const accepted = await client.callTool({
      name: "workflow",
      arguments: {
        script: TWO_AGENT_SCRIPT,
        resumeFromRunId: String(structured(source)?.runId),
        background: true,
      },
    });
    const eligibility = structured(accepted)?.replayEligibility;
    assert.equal(field(eligibility, "predictedReplayablePrefix"), 0);
    assert.equal(field(field(eligibility, "firstNonReplay"), "reason"), "not-recorded");
    assert.match(textOf(accepted), /WARNING: resume: identity-v1/);
    assert.match(textOf(accepted), /first non-replay: call 0 not-recorded/);

    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: String(structured(accepted)?.runId), waitMs: 1_000 },
    });
    assert.equal(calls(), 2);
    assert.match(textOf(awaited), /WARNING: resume: identity-v1/);
    assert.match(textOf(awaited), /first non-replay: call 0 not-recorded/);
  } finally {
    await dispose();
  }
});

test("format-1 sources replay through the named positional bridge", async () => {
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const source = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, agentTimeoutMs: 900_000 },
    });
    const sourceRunId = String(structured(source)?.runId);
    const file = persistedRunFile(sourceRunId);
    assert.ok(file);
    const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const runtime = field(persisted, "runtime") as Record<string, unknown>;
    runtime.inputsFormat = 1;
    writeFileSync(file, JSON.stringify(persisted), "utf8");

    const resumed = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, resumeFromRunId: sourceRunId },
    });
    const report = structured(resumed)?.resumeReport;
    const eligibility = structured(resumed)?.replayEligibility;
    assert.equal(field(report, "strategy"), "positional-v1");
    assert.equal(field(report, "fallbackReason"), "inputs-format-legacy");
    assert.equal(field(report, "replayed"), 2);
    assert.equal(field(eligibility, "sourceInputsFormat"), 1);
    assert.equal(field(eligibility, "currentInputsFormat"), 2);
    assert.equal(calls(), 2);
    assert.match(textOf(resumed), /inputs-format-legacy/);
    assert.match(textOf(resumed), /source recorded agentTimeoutMs=900000; this run: none/);

    const missed = await client.callTool({
      name: "workflow",
      arguments: {
        script: TWO_AGENT_SCRIPT.replace('agent("alpha"', 'agent("alpha changed"'),
        resumeFromRunId: sourceRunId,
      },
    });
    const firstNonReplay = field(structured(missed)?.replayEligibility, "firstNonReplay");
    assert.equal(field(firstNonReplay, "reason"), "positional-miss");
    assert.equal(
      field(firstNonReplay, "detail"),
      "source recorded agentTimeoutMs=900000; this run: none",
    );
    assert.match(
      textOf(missed),
      /first non-replay: call 0 positional-miss — source recorded agentTimeoutMs=900000; this run: none/,
    );
    assert.equal(calls(), 4);
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

test("an args-caused middle prompt miss still permits an independent safe suffix replay", async () => {
  const script = `export const meta = { name: 'args-prefix', description: 'args-driven prefix resume' }
const a = await agent('A', { label: 'a', resume: { filesystem: 'read-only' } })
const b = await agent(String(args.middle), { label: 'b', resume: { filesystem: 'read-only' } })
const c = await agent('C', { label: 'c', resume: { filesystem: 'read-only' } })
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
    assert.equal(calls(), 4, "the changed middle call runs live while the independent safe suffix replays");
    assert.deepEqual(
      { a: field(result, "a"), b: field(result, "b"), c: field(result, "c") },
      { a: "r:A:1", b: "r:B-edited:4", c: "r:C:3" },
    );
  } finally {
    await dispose();
  }
});

test("background resume durably saves the manager seed before returning accepted", async () => {
  let releaseInserted: ((value: string) => void) | undefined;
  let markInsertedStarted: (() => void) | undefined;
  const insertedStarted = new Promise<void>((resolve) => {
    markInsertedStarted = resolve;
  });
  const runner = makeRunner((prompt) => {
    if (prompt === "inserted") {
      markInsertedStarted?.();
      return new Promise<string>((resolve) => {
        releaseInserted = resolve;
      });
    }
    return `recorded:${prompt}`;
  });
  const sourceScript = `export const meta = { name: 'durable-seed', description: 'durable source' }
return await agent('cached', { resume: { filesystem: 'read-only' } })`;
  const resumedScript = `export const meta = { name: 'durable-seed', description: 'durable target' }
await agent('inserted', { resume: { filesystem: 'read-only' } })
return await agent('cached', { resume: { filesystem: 'read-only' } })`;
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const source = await client.callTool({ name: "workflow", arguments: { script: sourceScript } });
    const sourceRunId = String(structured(source)?.runId);
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { script: resumedScript, resumeFromRunId: sourceRunId, background: true },
    });
    const targetRunId = String(structured(accepted)?.runId);
    assert.equal(field(structured(accepted)?.replayEligibility, "predictedReplayablePrefix"), 1);
    await insertedStarted;
    const targetFile = persistedRunFile(targetRunId);
    assert.ok(targetFile, "accepted target already has a durable snapshot");
    const target = JSON.parse(readFileSync(targetFile, "utf8")) as Record<string, unknown>;
    assert.equal(field(target.resumeReport, "sourceRunId"), sourceRunId);
    assert.equal(field(target.resumeReport, "strategy"), "identity-v1");
    assert.equal((field(target.resumeSeed, "candidates") as unknown[])?.length, 1);

    const runningAwait = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: targetRunId, waitMs: 0 },
    });
    const runningInspect = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: targetRunId },
    });
    assert.equal(structured(runningAwait)?.status, "running");
    assert.equal(structured(runningAwait)?.outcome, undefined);
    assert.deepEqual(
      structured(runningAwait)?.replayEligibility,
      structured(runningInspect)?.replayEligibility,
    );
    assert.equal(
      field(field(structured(runningAwait)?.replayEligibility, "firstNonReplay"), "reason"),
      "not-recorded",
    );

    assert.ok(releaseInserted);
    releaseInserted("recorded:inserted");
    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: targetRunId, waitMs: 1_000 },
    });
    assert.equal(structured(awaited)?.status, "completed");
    assert.equal(field(structured(awaited)?.outcome, "result"), "recorded:cached");
  } finally {
    releaseInserted?.("cleanup");
    await dispose();
  }
});

test("resumeFromRunId for an unknown run is a tool error and never starts live", async () => {
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner);
  try {
    for (const background of [false, true]) {
      const res = await client.callTool({
        name: "workflow",
        arguments: { script: TWO_AGENT_SCRIPT, resumeFromRunId: "no-such-run-id", background },
      });
      assert.equal(res.isError, true);
      assert.equal(structured(res), undefined);
      assert.match(textOf(res), /resume source does not exist: no-such-run-id/);
    }
    assert.equal(calls(), 0, "a missing source never degrades to a fresh run");
  } finally {
    await dispose();
  }
});
