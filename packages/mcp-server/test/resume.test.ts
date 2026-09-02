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

function overwritePersistedRun(file: string, state: Record<string, unknown>): void {
  const json = JSON.stringify(state);
  writeFileSync(file, json, "utf8");
  writeFileSync(`${file}.bak`, json, "utf8");
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
if (maxRounds < 8) await checkpoint(\`review cap \${maxRounds} reached before 8 rounds\`, { headless: 'abort' });
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

test("action resume creates linked runs from stored script/args and applies only new operational overrides", async () => {
  let calls = 0;
  const runner = makeRunner((prompt) => {
    calls += 1;
    return `reply:${prompt}:${calls}`;
  });
  const script = `export const meta = { name: 'stored-resume', description: 'stored resume' };
return await agent(String(args.value), { label: 'value' });`;
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const source = await client.callTool({
      name: "workflow",
      arguments: {
        script,
        args: { value: "original" },
        maxAgents: 3,
        concurrency: 2,
        agentRetries: 1,
      },
    });
    const sourceRunId = String(structured(source)?.runId);
    assert.equal(calls, 1);

    const defaulted = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: sourceRunId },
    });
    const defaultedContent = structured(defaulted);
    assert.equal(defaulted.isError, false);
    assert.equal(defaultedContent?.status, "completed");
    assert.equal(defaultedContent?.scriptSource, "stored");
    assert.equal(defaultedContent?.result, "reply:original:1");
    assert.equal(calls, 1, "stored args preserve the completed call as a zero-provider-use replay");
    assert.notEqual(defaultedContent?.runId, sourceRunId);
    const defaultLimits = defaultedContent?.limits as Record<string, unknown>;
    assert.equal(defaultLimits.maxAgents, 1_000);
    assert.equal(defaultLimits.concurrency, 8);
    assert.equal(defaultLimits.agentRetries, 0);
    const defaultedFile = persistedRunFile(String(defaultedContent?.runId));
    assert.ok(defaultedFile);
    const defaultedState = JSON.parse(readFileSync(defaultedFile, "utf8")) as Record<string, unknown>;
    assert.equal(defaultedState.resumeSourceRunId, sourceRunId);

    const background = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: sourceRunId, background: true },
    });
    const backgroundContent = structured(background);
    assert.equal(backgroundContent?.status, "running");
    assert.equal(backgroundContent?.scriptSource, "stored");
    assert.notEqual(backgroundContent?.runId, sourceRunId);
    const backgroundStatus = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: String(backgroundContent?.runId), waitMs: 1_000 },
    });
    assert.equal(structured(backgroundStatus)?.status, "completed");
    assert.equal(calls, 1, "background stored-content replay also avoids provider use");

    const overridden = await client.callTool({
      name: "workflow",
      arguments: {
        action: "resume",
        runId: sourceRunId,
        args: { value: "edited" },
        maxAgents: 9,
        concurrency: 7,
        agentRetries: 2,
      },
    });
    const overriddenContent = structured(overridden);
    assert.equal(overriddenContent?.status, "completed");
    assert.equal(overriddenContent?.scriptSource, "stored");
    assert.equal(overriddenContent?.result, "reply:edited:2");
    const overriddenLimits = overriddenContent?.limits as Record<string, unknown>;
    assert.equal(overriddenLimits.maxAgents, 9);
    assert.equal(overriddenLimits.concurrency, 7);
    assert.equal(overriddenLimits.agentRetries, 2);
  } finally {
    await dispose();
  }
});

test("action resume reuses completed calls from failed and aborted terminal sources", async () => {
  let calls = 0;
  let abortSecond = true;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  const runner = makeRunner((prompt, options) => {
    calls += 1;
    if (prompt === "failed-live") throw new Error("expected agent failure");
    if (prompt === "abort-second" && abortSecond) {
      markSecondStarted();
      return new Promise<string>((_resolve, reject) => {
        const rejectCancelled = () => reject(new Error("cancelled by test"));
        options.signal?.addEventListener("abort", rejectCancelled, { once: true });
        if (options.signal?.aborted) rejectCancelled();
      });
    }
    return `terminal:${prompt}:${calls}`;
  });
  const failedScript = `export const meta = { name: 'failed-source', description: 'failed source' };
await agent('failed-prefix', { label: 'failed-prefix' });
const failed = await agent('failed-live', { label: 'failed-live' });
if (failed === null) throw new Error('expected terminal failure');
return failed;`;
  const abortedScript = `export const meta = { name: 'aborted-source', description: 'aborted source' };
const first = await agent('abort-prefix', { label: 'abort-prefix' });
const second = await agent('abort-second', { label: 'abort-second' });
return { first, second };`;
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const failed = await client.callTool({ name: "workflow", arguments: { script: failedScript } });
    assert.equal(structured(failed)?.status, "failed");
    assert.equal(calls, 2);
    const failedResume = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: String(structured(failed)?.runId) },
    });
    assert.equal(structured(failedResume)?.status, "failed");
    assert.equal(calls, 3, "the failed source's completed prefix replays while only its failed call runs live");

    const admitted = await client.callTool({
      name: "workflow",
      arguments: { script: abortedScript, background: true },
    });
    const abortedRunId = String(structured(admitted)?.runId);
    await secondStarted;
    const stopped = await client.callTool({
      name: "workflow",
      arguments: { action: "stop", runId: abortedRunId },
    });
    assert.equal(structured(stopped)?.status, "aborted");
    assert.equal(calls, 5, "the source reached one completed and one interrupted call");

    abortSecond = false;
    const resumed = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: abortedRunId },
    });
    const resumedContent = structured(resumed);
    assert.equal(resumedContent?.status, "completed");
    assert.equal(
      field(resumedContent?.resumeReport, "replayed"),
      1,
      JSON.stringify(resumedContent?.resumeReport),
    );
    assert.equal(field(resumedContent?.resumeReport, "live"), 1);
    assert.equal(calls, 6, "the aborted source's completed prefix replays and only its interrupted call runs live");
  } finally {
    await dispose();
  }
});

test("action resume answers a persisted checkpoint using the source script and args", async () => {
  const { runner, calls } = countingRunner();
  const script = `export const meta = { name: 'checkpoint-source', description: 'checkpoint source' };
const before = await agent(String(args.before), { label: 'before' });
const approved = await checkpoint('Continue?', { headless: 'pause', default: false });
const after = approved ? await agent('after', { label: 'after' }) : null;
return { before, approved, after };`;
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const paused = await client.callTool({
      name: "workflow",
      arguments: { script, args: { before: "before" } },
    });
    const pausedContent = structured(paused);
    assert.equal(pausedContent?.status, "paused");
    assert.equal(calls(), 1);
    const checkpoint = pausedContent?.checkpointContext as Record<string, unknown>;
    const callIndex = Number(checkpoint.callIndex);

    const resumed = await client.callTool({
      name: "workflow",
      arguments: {
        action: "resume",
        runId: String(pausedContent?.runId),
        checkpointReplies: { [String(callIndex)]: true },
      },
    });
    const resumedContent = structured(resumed);
    assert.equal(resumedContent?.status, "completed");
    assert.equal(resumedContent?.scriptSource, "stored");
    assert.equal(field(resumedContent?.result, "before"), "r:before:1");
    assert.equal(field(resumedContent?.result, "approved"), true);
    assert.equal(field(resumedContent?.result, "after"), "r:after:2");
    assert.equal(calls(), 2, "the completed prefix replays before the injected checkpoint reply");
  } finally {
    await dispose();
  }
});

test("action resume rejects missing, unreadable, and unreplayable stored source data before admission", async () => {
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const missing = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: "nosuch-run" },
    });
    assert.equal(missing.isError, true);
    assert.equal(structured(missing), undefined);
    assert.match(textOf(missing), /source run is missing or its persisted content is unreadable/);

    const corruptSource = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT },
    });
    const corruptFile = persistedRunFile(String(structured(corruptSource)?.runId));
    assert.ok(corruptFile);
    writeFileSync(corruptFile, "{", "utf8");
    writeFileSync(`${corruptFile}.bak`, "{", "utf8");
    const corrupt = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: String(structured(corruptSource)?.runId) },
    });
    assert.equal(corrupt.isError, true);
    assert.match(textOf(corrupt), /source run is missing or its persisted content is unreadable/);

    const scriptSource = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT },
    });
    const scriptFile = persistedRunFile(String(structured(scriptSource)?.runId));
    assert.ok(scriptFile);
    const missingScriptState = JSON.parse(readFileSync(scriptFile, "utf8")) as Record<string, unknown>;
    delete missingScriptState.script;
    overwritePersistedRun(scriptFile, missingScriptState);
    const missingScript = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: String(structured(scriptSource)?.runId) },
    });
    assert.equal(missingScript.isError, true);
    assert.match(textOf(missingScript), /persisted source script is missing or unreadable/);

    const argsSource = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, args: { valid: true } },
    });
    const argsFile = persistedRunFile(String(structured(argsSource)?.runId));
    assert.ok(argsFile);
    const badArgsState = JSON.parse(readFileSync(argsFile, "utf8")) as Record<string, unknown>;
    badArgsState.argsUnreplayable = true;
    overwritePersistedRun(argsFile, badArgsState);
    const badArgs = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: String(structured(argsSource)?.runId) },
    });
    assert.equal(badArgs.isError, true);
    assert.match(textOf(badArgs), /stored args are not replayable strict JSON/);

    const replacedArgs = await client.callTool({
      name: "workflow",
      arguments: {
        action: "resume",
        runId: String(structured(argsSource)?.runId),
        args: { replacement: true },
      },
    });
    assert.equal(replacedArgs.isError, false, "an explicit strict-JSON value replaces unreadable stored args");
    assert.notEqual(structured(replacedArgs)?.runId, structured(argsSource)?.runId);
    assert.equal(calls(), 6, "rejections create no target and the explicit replacement replays without provider use");
  } finally {
    await dispose();
  }
});

test("action resume reloads stored content after an MCP server restart", async () => {
  const { runner, calls } = countingRunner();
  const firstConnection = await connect(runner, { listTools: true });
  let sourceRunId: string;
  try {
    const source = await firstConnection.client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, args: { persisted: true } },
    });
    sourceRunId = String(structured(source)?.runId);
    assert.equal(calls(), 2);
  } finally {
    await firstConnection.dispose();
  }

  const secondConnection = await connect(runner, { listTools: true });
  try {
    const resumed = await secondConnection.client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId: sourceRunId! },
    });
    assert.equal(resumed.isError, false);
    assert.equal(structured(resumed)?.status, "completed");
    assert.equal(structured(resumed)?.scriptSource, "stored");
    assert.equal(calls(), 2, "cold stored-content replay spends no current provider calls");
  } finally {
    await secondConnection.dispose();
  }
});

test("background admission, status, and foreground expose the same replay eligibility diagnostics", async () => {
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const source = await client.callTool({
      name: "workflow",
      arguments: {
        script: TWO_AGENT_SCRIPT,
        agentRetries: 1,
        concurrency: 2,
      },
    });
    const sourceRunId = String(structured(source)?.runId);
    const sourceFile = persistedRunFile(sourceRunId);
    assert.ok(sourceFile);
    const persisted = JSON.parse(readFileSync(sourceFile, "utf8")) as Record<string, unknown>;
    const runtime = field(persisted, "runtime") as Record<string, unknown>;
    runtime.node = "v0.0.0-recorded";
    writeFileSync(sourceFile, JSON.stringify(persisted), "utf8");
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
    assert.deepEqual(acceptedEligibility.provenanceChanges, [{
      field: "runtime.node",
      source: "v0.0.0-recorded",
      current: process.version,
      detail: `source recorded runtime.node=v0.0.0-recorded; this run: ${process.version}`,
    }]);
    assert.deepEqual(
      (acceptedEligibility.operationalChanges as Array<Record<string, unknown>>).map((change) => change.detail),
      [
        "source recorded agentRetries=1; this run: 0",
        "source recorded concurrency=2; this run: 7",
      ],
    );
    assert.match(textOf(accepted), /predicted replayable prefix 2/);
    assert.match(textOf(accepted), /provenance changes: source recorded runtime\.node=v0\.0\.0-recorded/);

    const resumedRunId = String(acceptedContent?.runId);
    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: resumedRunId, waitMs: 1_000 },
    });
    const awaitedContent = structured(awaited);
    const terminalEligibility = awaitedContent?.replayEligibility;
    assert.equal(field(terminalEligibility, "replayedPrefix"), 2);
    assert.deepEqual(field(awaitedContent?.outcome, "replayEligibility"), terminalEligibility);
    assert.match(textOf(awaited), /provenance changes: source recorded runtime\.node=v0\.0\.0-recorded/);

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: resumedRunId },
    });
    assert.deepEqual(structured(inspected)?.replayEligibility, terminalEligibility);
    assert.match(textOf(inspected), /replayed prefix 2/);
    assert.match(textOf(inspected), /provenance changes: source recorded runtime\.node=v0\.0\.0-recorded/);

    const foreground = await client.callTool({ name: "workflow", arguments: resumeArgs });
    assert.deepEqual(structured(foreground)?.replayEligibility, terminalEligibility);
    assert.match(textOf(foreground), /provenance changes: source recorded runtime\.node=v0\.0\.0-recorded/);
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
      arguments: { action: "status", runId: String(structured(accepted)?.runId), waitMs: 1_000 },
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
      arguments: { script: TWO_AGENT_SCRIPT, agentRetries: 1 },
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
    assert.match(textOf(resumed), /source recorded agentRetries=1; this run: 0/);

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
      "source recorded agentRetries=1; this run: 0",
    );
    assert.match(
      textOf(missed),
      /first non-replay: call 0 positional-miss — source recorded agentRetries=1; this run: 0/,
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
      arguments: { action: "status", runId: targetRunId, waitMs: 0 },
    });
    const runningInspect = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId: targetRunId },
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
      arguments: { action: "status", runId: targetRunId, waitMs: 1_000 },
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
