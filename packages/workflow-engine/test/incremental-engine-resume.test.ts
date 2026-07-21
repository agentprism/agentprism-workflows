import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  AgentRunner,
  JournalEntry,
  RunOptions,
  WorkflowCallRecord,
  WorkflowResumeCallDecision,
} from "@automatalabs/shared-types";
import { WorkflowErrorCode } from "../src/errors.js";
import {
  cloneResumeCandidate,
  normalizeResumeSeed,
} from "../src/resume-matcher.js";
import type { PreparedResume } from "../src/resume.js";
import type {
  PersistedCheckpointInjection,
  PersistedResumeSeed,
} from "../src/run-persistence.js";
import { runWorkflow } from "../src/workflow.js";

const source = (body: string, name = "incremental-engine-resume") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "engine resume integration" }\n${body}`;

const usage = (total: number) => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost: 0,
});

interface Recording {
  runId: string;
  calls: WorkflowCallRecord[];
  journal: JournalEntry[];
}

function seedFor(recording: Recording): PersistedResumeSeed {
  const journal = new Map(recording.journal.map((entry) => [entry.index, entry]));
  const promoted = recording.calls.flatMap((call) => {
    const entry = journal.get(call.index);
    if (!entry) return [];
    const candidate = cloneResumeCandidate(recording.runId, entry, call);
    return candidate ? [candidate] : [];
  });
  const seed = normalizeResumeSeed({ sourceRunId: recording.runId, promoted });
  assert.ok(seed);
  return seed;
}

async function record(
  script: string,
  options: {
    runId?: string;
    runner?: AgentRunner;
    confirm?: NonNullable<Parameters<typeof runWorkflow>[1]["confirm"]>;
    cwd?: string;
    concurrency?: number;
  } = {},
): Promise<Recording> {
  const calls: WorkflowCallRecord[] = [];
  const journal: JournalEntry[] = [];
  const runId = options.runId ?? "resume-source";
  await runWorkflow(script, {
    runId,
    agent: options.runner ?? { async run(prompt) { return prompt; } },
    confirm: options.confirm,
    cwd: options.cwd,
    concurrency: options.concurrency,
    persistLogs: false,
    onCallRecord: (call) => calls.push(call),
    onAgentJournal: (entry) => journal.push(entry),
  });
  return JSON.parse(JSON.stringify({ runId, calls, journal })) as Recording;
}

function initGitRepo(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "resume-engine-git-"));
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Tests"]);
  writeFileSync(join(cwd, "tracked.txt"), "clean\n");
  execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function fanout(items: readonly string[], worktree: boolean, declared = true): string {
  return source(`
const items = ${JSON.stringify(items)}
return await parallel(items.map((item, index) => () => agent(item, {
  label: "item-" + index,
  ${worktree ? 'isolation: "worktree",' : ""}
  ${declared ? 'resume: { filesystem: "read-only" },' : ""}
})))`, worktree ? "worktree-fanout" : "reader-fanout");
}

function identityPrepared(
  seed: PersistedResumeSeed,
  commits: PersistedResumeSeed[],
  commitSeed: ((remaining: PersistedResumeSeed) => void) | undefined = undefined,
): PreparedResume {
  return {
    strategy: "identity-v1",
    sourceRunId: seed.sourceRunId,
    requestedPolicy: "auto",
    seed,
    commitSeed: commitSeed ?? ((remaining) => commits.push(remaining)),
  };
}

describe("PreparedResume identity engine integration", () => {
  it("replays moved calls, re-journals current indexes, rebinds sessions, and applies logical budget debit", async () => {
    const sourceRunner: AgentRunner = {
      async run(prompt: string, options: RunOptions) {
        options.onUsage?.(usage(5));
        options.onSessionOpen?.({
          sessionId: `session-${prompt}`,
          backendId: "test-backend",
          cwd: "/recorded/cwd",
          reopen: { load: true, resume: true, list: true },
        });
        return `recorded:${prompt}`;
      },
    };
    const recording = await record(source(`
const values = await parallel([
  () => agent("alpha", { label: "alpha", phase: "read", resume: { filesystem: "read-only" } }),
  () => agent("beta", { label: "beta", phase: "read", resume: { filesystem: "read-only" } }),
])
return values`), { runner: sourceRunner });
    const originalSessions = recording.journal.map((entry) => entry.session);
    const commits: PersistedResumeSeed[] = [];
    const decisions: WorkflowResumeCallDecision[] = [];
    const currentJournal: JournalEntry[] = [];
    const runnerPrompts: string[] = [];
    const result = await runWorkflow(source(`
const values = await parallel([
  () => agent("inserted", { label: "inserted", phase: "read", resume: { filesystem: "read-only" } }),
  () => agent("alpha", { label: "alpha", phase: "read", resume: { filesystem: "read-only" } }),
  () => agent("beta", { label: "beta", phase: "read", resume: { filesystem: "read-only" } }),
])
return { values, spent: budget.spent() }`), {
      runId: "resume-target",
      agent: {
        async run(prompt: string, options: RunOptions) {
          runnerPrompts.push(prompt);
          options.onUsage?.(usage(7));
          return `live:${prompt}`;
        },
      },
      preparedResume: identityPrepared(seedFor(recording), commits),
      persistLogs: false,
      onAgentJournal: (entry) => currentJournal.push(entry),
      onResumeDecision: (decision) => decisions.push(decision),
    });

    assert.deepEqual(runnerPrompts, ["inserted"]);
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      values: ["live:inserted", "recorded:alpha", "recorded:beta"],
      spent: 17,
    });
    assert.equal(result.tokenUsage.total, 7);
    assert.deepEqual(result.resumeReport, {
      strategy: "identity-v1",
      sourceRunId: "resume-source",
      requestedPolicy: "auto",
      replayed: 2,
      live: 1,
      failed: 0,
      calls: decisions,
    });
    assert.deepEqual(decisions.map((decision) => [decision.index, decision.action]), [
      [0, "live"],
      [1, "replayed"],
      [2, "replayed"],
    ]);
    assert.deepEqual(decisions.slice(1).map((decision) =>
      decision.action === "replayed" ? decision.match : undefined), ["unique-hash", "unique-hash"]);
    assert.deepEqual(commits.map((seed) => seed.candidates.length), [1, 0]);
    assert.deepEqual(currentJournal.map((entry) => [entry.index, entry.scope]), [
      [0, "resume-target"],
      [1, "resume-target"],
      [2, "resume-target"],
    ]);
    assert.deepEqual(result.calls?.map((call) => [call.index, call.origin, call.budgetDebit]), [
      [0, "runner", 7],
      [1, "journal-replay", 0],
      [2, "journal-replay", 0],
    ]);
    assert.deepEqual(result.agentSessions?.map((session) => [session.callIndex, session.label, session.phase]), [
      [1, "alpha", "read"],
      [2, "beta", "read"],
    ]);
    assert.deepEqual(recording.journal.map((entry) => entry.session), originalSessions);
  });

  it("keeps unrelated replay candidates after a changed live call", async () => {
    const recording = await record(source(`
const first = await agent("first", { label: "first", resume: { filesystem: "read-only" } })
const second = await agent("second", { label: "second", resume: { filesystem: "read-only" } })
return { first, second }`));
    const commits: PersistedResumeSeed[] = [];
    const runnerPrompts: string[] = [];
    const result = await runWorkflow(source(`
const first = await agent("changed", { label: "first" })
const second = await agent("second", { label: "second", resume: { filesystem: "read-only" } })
return { first, second }`), {
      runId: "unsafe-target",
      agent: {
        async run(prompt: string) {
          runnerPrompts.push(prompt);
          return `live:${prompt}`;
        },
      },
      preparedResume: identityPrepared(seedFor(recording), commits),
      persistLogs: false,
    });

    assert.deepEqual(runnerPrompts, ["changed"]);
    assert.deepEqual(result.resumeReport?.calls.map((decision) =>
      decision.action === "live" ? decision.reason : decision.action), [
      "not-recorded",
      "replayed",
    ]);
    assert.deepEqual(commits.map((seed) => seed.candidates.length), [1]);
  });

  it("latches critical seed persistence failures across errors caught by workflow code", async () => {
    const recording = await record(source(`
return await agent("cached", { label: "cached", resume: { filesystem: "read-only" } })`));
    let runnerCalls = 0;
    let commitCalls = 0;
    const result = await runWorkflow(source(`
const codes = []
try { await agent("cached", { label: "cached", resume: { filesystem: "read-only" } }) } catch (error) { codes.push(error.code) }
try { await agent("later", { label: "later", resume: { filesystem: "read-only" } }) } catch (error) { codes.push(error.code) }
return codes`), {
      runId: "fatal-target",
      agent: { async run() { runnerCalls += 1; return "live"; } },
      preparedResume: identityPrepared(seedFor(recording), [], () => {
        commitCalls += 1;
        throw new Error("disk full");
      }),
      persistLogs: false,
    });

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), [
      WorkflowErrorCode.PERSISTENCE_ERROR,
      WorkflowErrorCode.PERSISTENCE_ERROR,
    ]);
    assert.equal(commitCalls, 1);
    assert.equal(runnerCalls, 0);
    assert.deepEqual(result.resumeReport?.calls, [
      { index: 0, kind: "agent", action: "failed", reason: "seed-persistence-error" },
      { index: 1, kind: "agent", action: "failed", reason: "resume-fatal-latch" },
    ]);
    assert.deepEqual(result.calls?.map((call) => [call.index, call.outcome, call.origin]), [
      [0, "error", "engine"],
      [1, "error", "engine"],
    ]);
  });
});

describe("PreparedResume allocation-ordered barriers and fan-out", () => {
  it("replays 38 of 40 declared readers when two prompts change", async () => {
    const original = Array.from({ length: 40 }, (_value, index) => `reader-${index}`);
    const changed = [...original];
    changed[5] = "reader-5-changed";
    changed[20] = "reader-20-changed";
    const recording = await record(fanout(original, false));
    const commits: PersistedResumeSeed[] = [];
    const runnerPrompts: string[] = [];
    const result = await runWorkflow(fanout(changed, false), {
      runId: "reader-fanout-target",
      agent: { async run(prompt) { runnerPrompts.push(prompt); return `live:${prompt}`; } },
      preparedResume: identityPrepared(seedFor(recording), commits),
      persistLogs: false,
    });

    assert.deepEqual(runnerPrompts.sort(), ["reader-20-changed", "reader-5-changed"]);
    assert.equal(result.resumeReport?.replayed, 38);
    assert.equal(result.resumeReport?.live, 2);
    assert.equal(result.resumeReport?.failed, 0);
    assert.equal(commits.at(-1)?.candidates.length, 2);
  });

  it("replays an unannotated 40-reader recording under positional safe-prefix", async () => {
    const items = Array.from({ length: 40 }, (_value, index) => `unsafe-reader-${index}`);
    const recording = await record(fanout(items, false, false));
    assert.equal(recording.calls.every((call) => call.resumeSafety === undefined), true);
    const prepared: PreparedResume = {
      strategy: "positional-v1",
      sourceRunId: recording.runId,
      requestedPolicy: "auto",
      fallbackReason: "unsafe-recording",
      eligibility: "safe-prefix",
      sourceCalls: new Map(recording.calls.map((call) => [call.index, call])),
    };
    let runnerCalls = 0;
    const result = await runWorkflow(fanout(items, false, false), {
      runId: "unsafe-reader-target",
      agent: { async run(prompt) { runnerCalls += 1; return `live:${prompt}`; } },
      resumeJournal: new Map(recording.journal.map((entry) => [entry.index, entry])),
      preparedResume: prepared,
      persistLogs: false,
    });
    assert.equal(runnerCalls, 0);
    assert.equal(result.resumeReport?.replayed, 40);
    assert.equal(result.resumeReport?.live, 0);
    assert.equal(result.resumeReport?.calls.every((decision) => decision.action === "replayed"), true);
  });

  it("replays matching worktrees without making degradation a suffix barrier", async () => {
    const repository = initGitRepo();
    try {
      const original = Array.from({ length: 40 }, (_value, index) => `worktree-${index}`);
      const changed = [...original];
      changed[5] = "worktree-5-changed";
      changed[20] = "worktree-20-changed";
      const recording = await record(fanout(original, true), {
        runId: "worktree-source",
        cwd: repository.cwd,
        concurrency: 1,
      });
      assert.equal(recording.calls.every((call) => call.resumeSafety === "isolated-worktree"), true);

      const commits: PersistedResumeSeed[] = [];
      const runnerPrompts: string[] = [];
      const orderedDecisions: number[] = [];
      const result = await runWorkflow(fanout(changed, true), {
        runId: "worktree-success",
        cwd: repository.cwd,
        concurrency: 4,
        agent: {
          async run(prompt, options) {
            assert.notEqual(options.cwd, repository.cwd);
            runnerPrompts.push(prompt);
            return `live:${prompt}`;
          },
        },
        preparedResume: identityPrepared(seedFor(recording), commits),
        persistLogs: false,
        onResumeDecision: (decision) => orderedDecisions.push(decision.index),
      });
      assert.deepEqual(runnerPrompts.sort(), ["worktree-20-changed", "worktree-5-changed"]);
      assert.equal(result.resumeReport?.replayed, 38);
      assert.equal(result.resumeReport?.live, 2);
      assert.deepEqual(orderedDecisions, Array.from({ length: 40 }, (_value, index) => index));

      execFileSync("git", ["-C", repository.cwd, "branch", "agentprism/wf/degrade-0-item-0"]);
      const degraded = [...original];
      degraded[0] = "worktree-0-changed";
      const degradedCommits: PersistedResumeSeed[] = [];
      const degradedPrompts: string[] = [];
      const degradedResult = await runWorkflow(fanout(degraded, true), {
        runId: "degrade",
        cwd: repository.cwd,
        concurrency: 4,
        agent: { async run(prompt) { degradedPrompts.push(prompt); return `live:${prompt}`; } },
        preparedResume: identityPrepared(seedFor(recording), degradedCommits),
        persistLogs: false,
      });
      assert.deepEqual(degradedPrompts, ["worktree-0-changed"]);
      assert.equal(degradedResult.resumeReport?.replayed, 39);
      assert.equal(degradedResult.resumeReport?.live, 1);
      assert.deepEqual(degradedResult.resumeReport?.calls.slice(0, 2).map((decision) =>
        decision.action === "live" ? decision.reason : decision.action), [
        "worktree-degraded",
        "replayed",
      ]);
      assert.equal(degradedCommits.at(-1)?.candidates.length, 1);

      const unsafeRecording = await record(fanout(original, true, false), {
        runId: "unsafe-worktree-source",
        cwd: repository.cwd,
        concurrency: 1,
      });
      assert.equal(unsafeRecording.calls.every((call) => call.resumeSafety === undefined), true);
      const unsafePrepared: PreparedResume = {
        strategy: "positional-v1",
        sourceRunId: unsafeRecording.runId,
        requestedPolicy: "auto",
        fallbackReason: "unsafe-recording",
        eligibility: "safe-prefix",
        sourceCalls: new Map(unsafeRecording.calls.map((call) => [call.index, call])),
      };
      let unsafeRunnerCalls = 0;
      const unsafeResult = await runWorkflow(fanout(original, true, false), {
        runId: "unsafe-worktree-target",
        cwd: repository.cwd,
        concurrency: 4,
        agent: { async run() { unsafeRunnerCalls += 1; return "live"; } },
        resumeJournal: new Map(unsafeRecording.journal.map((entry) => [entry.index, entry])),
        preparedResume: unsafePrepared,
        persistLogs: false,
      });
      assert.equal(unsafeRunnerCalls, 0);
      assert.equal(unsafeResult.resumeReport?.replayed, 40);
      assert.equal(unsafeResult.resumeReport?.live, 0);
    } finally {
      repository.cleanup();
    }
  });

  it("keeps root replay correspondence across a live nested workflow", async () => {
    const child = source(`return await agent("child", { label: "child" })`, "nested-child");
    const identityRecording = await record(source(`
return await agent("parent", { label: "parent", resume: { filesystem: "read-only" } })`, "nested-parent"));
    const identityCommits: PersistedResumeSeed[] = [];
    const identityPrompts: string[] = [];
    const identityResult = await runWorkflow(source(`
await workflow(${JSON.stringify(child)})
return await agent("parent", { label: "parent", resume: { filesystem: "read-only" } })`, "nested-parent"), {
      runId: "identity-nested-target",
      agent: {
        async run(prompt) {
          identityPrompts.push(prompt);
          return `live:${prompt}`;
        },
      },
      preparedResume: identityPrepared(seedFor(identityRecording), identityCommits),
      persistLogs: false,
    });
    assert.deepEqual(identityPrompts, ["child"]);
    assert.equal(identityResult.resumeReport?.calls[0]?.action, "replayed");
    assert.equal(identityCommits.at(-1)?.candidates.length, 0);

    const positionalRecording = await record(source(`
const first = await agent("first", { label: "first", resume: { filesystem: "read-only" } })
const second = await agent("second", { label: "second", resume: { filesystem: "read-only" } })
return { first, second }`, "nested-positional"));
    const positionalPrepared: PreparedResume = {
      strategy: "positional-v1",
      sourceRunId: positionalRecording.runId,
      requestedPolicy: "positional",
      fallbackReason: "forced-positional",
      eligibility: "safe-prefix",
      sourceCalls: new Map(positionalRecording.calls.map((call) => [call.index, call])),
    };
    const positionalPrompts: string[] = [];
    const positionalResult = await runWorkflow(source(`
const first = await agent("first", { label: "first", resume: { filesystem: "read-only" } })
await workflow(${JSON.stringify(child)})
const second = await agent("second", { label: "second", resume: { filesystem: "read-only" } })
return { first, second }`, "nested-positional"), {
      runId: "positional-nested-target",
      agent: { async run(prompt) { positionalPrompts.push(prompt); return `live:${prompt}`; } },
      resumeJournal: new Map(positionalRecording.journal.map((entry) => [entry.index, entry])),
      preparedResume: positionalPrepared,
      persistLogs: false,
    });
    assert.deepEqual(positionalPrompts, ["child"]);
    assert.deepEqual(positionalResult.resumeReport?.calls.map((decision) => decision.action), [
      "replayed",
      "replayed",
    ]);
  });
});

describe("PreparedResume checkpoint integration", () => {
  it("replays a moved proven host decision and re-journals its current index", async () => {
    const recording = await record(source(`
return await checkpoint("approve", { kind: "confirm", default: false, timeoutMs: 0 })`), {
      confirm: async () => ({ approved: true }),
    });
    const commits: PersistedResumeSeed[] = [];
    const journal: JournalEntry[] = [];
    let confirms = 0;
    const result = await runWorkflow(source(`
await agent("inserted", { label: "inserted", resume: { filesystem: "read-only" } })
return await checkpoint("approve", { kind: "confirm", default: false, timeoutMs: 0 })`), {
      runId: "checkpoint-target",
      agent: { async run() { return "inserted"; } },
      confirm: async () => { confirms += 1; return false; },
      preparedResume: identityPrepared(seedFor(recording), commits),
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    });

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { approved: true });
    assert.equal(confirms, 0);
    assert.deepEqual(result.resumeReport?.calls, [
      { index: 0, kind: "agent", action: "live", reason: "not-recorded" },
      {
        index: 1,
        kind: "checkpoint",
        action: "replayed",
        sourceRunId: "resume-source",
        recordedIndex: 0,
        match: "unique-hash",
      },
    ]);
    assert.equal(result.calls?.[1].replay?.checkpointHostDecision, true);
    assert.deepEqual(journal.map((entry) => [entry.index, entry.kind, entry.scope]), [
      [0, "agent", "checkpoint-target"],
      [1, "checkpoint", "checkpoint-target"],
    ]);
    assert.equal(commits.at(-1)?.candidates.length, 0);
  });

  it("keeps later candidates after either a live host or headless checkpoint", async () => {
    const recording = await record(source(`
const decision = await checkpoint("source-decision", { default: false })
const later = await agent("later", { label: "later", resume: { filesystem: "read-only" } })
return { decision, later }`), { confirm: async () => true });

    const confirmCommits: PersistedResumeSeed[] = [];
    const confirmResult = await runWorkflow(source(`
const decision = await checkpoint("changed-decision", { default: false })
const later = await agent("later", { label: "later", resume: { filesystem: "read-only" } })
return { decision, later }`), {
      runId: "confirm-barrier-target",
      agent: { async run(prompt) { return `live:${prompt}`; } },
      confirm: async () => {
        return false;
      },
      preparedResume: identityPrepared(seedFor(recording), confirmCommits),
      persistLogs: false,
    });
    assert.deepEqual(confirmResult.resumeReport?.calls.map((decision) =>
      decision.action === "live" ? decision.reason : decision.action), ["not-recorded", "replayed"]);
    assert.equal(confirmCommits.at(-1)?.candidates.length, 1);

    const headlessCommits: PersistedResumeSeed[] = [];
    let headlessRunnerCalls = 0;
    const headlessResult = await runWorkflow(source(`
const decision = await checkpoint("changed-decision", { default: "fresh" })
const later = await agent("later", { label: "later", resume: { filesystem: "read-only" } })
return { decision, later }`), {
      runId: "headless-open-target",
      agent: { async run() { headlessRunnerCalls += 1; return "must-not-run"; } },
      preparedResume: identityPrepared(seedFor(recording), headlessCommits),
      persistLogs: false,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(headlessResult.result)), {
      decision: "fresh",
      later: "later",
    });
    assert.equal(headlessRunnerCalls, 0);
    assert.deepEqual(headlessResult.resumeReport?.calls.map((decision) => decision.action), ["live", "replayed"]);
    assert.equal(headlessCommits.at(-1)?.candidates.length, 1);
  });

  it("serves a shifted positional injection and closes the prefix immediately after it", async () => {
    const sourceCalls: WorkflowCallRecord[] = [];
    const sourceJournal: JournalEntry[] = [];
    await assert.rejects(
      runWorkflow(source(`
await agent("prefix", { label: "prefix", resume: { filesystem: "read-only" } })
return await checkpoint("pending", { headless: "pause", default: false })`), {
        runId: "paused-source",
        agent: { async run() { return "prefix"; } },
        persistLogs: false,
        onCallRecord: (call) => sourceCalls.push(call),
        onAgentJournal: (entry) => sourceJournal.push(entry),
      }),
      (error: unknown) =>
        typeof error === "object" && error !== null &&
        (error as { code?: string }).code === WorkflowErrorCode.CHECKPOINT_REQUIRED,
    );
    const pending = sourceCalls[1];
    assert.equal(pending.kind, "checkpoint");
    assert.ok(pending.path && pending.inputsHash);
    const injection: PersistedCheckpointInjection = {
      sourceRunId: "paused-source",
      recordedIndex: 1,
      hash: pending.hash,
      path: pending.path,
      inputsHash: pending.inputsHash,
      decision: true,
    };
    const injectionSeed: PersistedResumeSeed = {
      format: "identity-v1",
      sourceRunId: "paused-source",
      candidates: [],
      checkpointInjections: [injection],
    };
    const commits: PersistedResumeSeed[] = [];
    let runnerCalls = 0;
    const prepared: PreparedResume = {
      strategy: "positional-v1",
      sourceRunId: "paused-source",
      requestedPolicy: "positional",
      fallbackReason: "unsafe-recording",
      eligibility: "safe-prefix",
      sourceCalls: new Map(sourceCalls.map((call) => [call.index, call])),
      checkpoint: { seed: injectionSeed, commitSeed: (remaining) => commits.push(remaining) },
    };
    const result = await runWorkflow(source(`
const decision = await checkpoint("pending", { headless: "pause", default: false })
const suffix = await agent("suffix", { label: "suffix", resume: { filesystem: "read-only" } })
return { decision, suffix }`), {
      runId: "positional-injection-target",
      agent: { async run() { runnerCalls += 1; return "live-suffix"; } },
      resumeJournal: new Map(sourceJournal.map((entry) => [entry.index, entry])),
      preparedResume: prepared,
      persistLogs: false,
    });

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      decision: true,
      suffix: "live-suffix",
    });
    assert.equal(runnerCalls, 1);
    assert.deepEqual(result.resumeReport?.calls, [
      {
        index: 0,
        kind: "checkpoint",
        action: "replayed",
        sourceRunId: "paused-source",
        recordedIndex: 1,
        match: "unique-hash",
        checkpointInjected: true,
      },
      { index: 1, kind: "agent", action: "live", reason: "positional-suffix" },
    ]);
    assert.equal(result.calls?.[0].replay?.checkpointInjected, true);
    assert.equal(commits.at(-1)?.checkpointInjections, undefined);
  });
});

describe("PreparedResume positional eligibility", () => {
  it("initializes all-live at index zero and reports positional-suffix without a synthetic miss", async () => {
    const recording = await record(source(`
return await agent("same", { label: "same", resume: { filesystem: "read-only" } })`));
    let runnerCalls = 0;
    const prepared: PreparedResume = {
      strategy: "positional-v1",
      sourceRunId: recording.runId,
      requestedPolicy: "auto",
      fallbackReason: "nested-workflows",
      eligibility: "all-live",
      sourceCalls: new Map(recording.calls.map((call) => [call.index, call])),
    };
    const result = await runWorkflow(source(`
return await agent("same", { label: "same", resume: { filesystem: "read-only" } })`), {
      runId: "all-live-target",
      agent: { async run() { runnerCalls += 1; return "live"; } },
      resumeJournal: new Map(recording.journal.map((entry) => [entry.index, entry])),
      preparedResume: prepared,
      persistLogs: false,
    });
    assert.equal(result.result, "live");
    assert.equal(runnerCalls, 1);
    assert.deepEqual(result.resumeReport?.calls, [
      { index: 0, kind: "agent", action: "live", reason: "positional-suffix" },
    ]);
  });
});
