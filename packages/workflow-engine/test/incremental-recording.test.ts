import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner, JournalEntry, WorkflowCallRecord } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { validateResumeSafetyMarker, type PreparedResume } from "../src/resume.js";
import type { PersistedRunState, RunLease, RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import {
  CALL_INPUTS_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  hashCheckpointInputs,
  runWorkflow,
} from "../src/workflow.js";

const script = (body: string, name = "incremental-recording") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: 'incremental recording' }\n${body}`;

function tempDirs(): { cwd: string; root: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "incremental-recording-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "incremental-recording-root-"));
  return {
    cwd,
    root,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function initGitRepo(cwd: string): void {
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Tests"]);
  writeFileSync(join(cwd, "tracked.txt"), "clean\n");
  execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function resultRow(overrides: Partial<WorkflowCallRecord> = {}): WorkflowCallRecord {
  return {
    index: 0,
    kind: "agent",
    hash: "a".repeat(64),
    outcome: "result",
    origin: "runner",
    budgetDebit: 1,
    scope: "source",
    ...overrides,
  };
}

describe("resume authoring declaration and safety recording", () => {
  it("accepts only the exact realm-local or null-prototype declaration before allocation", async () => {
    let runnerCalls = 0;
    const runner: AgentRunner = { async run() { runnerCalls++; return "ok"; } };
    const valid = await runWorkflow(
      script(`
const nullProto = Object.create(null)
nullProto.filesystem = "read-only"
await agent("literal", { resume: { filesystem: "read-only" } })
return await agent("null", { resume: nullProto })`),
      { agent: runner, persistLogs: false },
    );
    assert.deepEqual(valid.calls?.map((row) => row.resumeSafety), ["declared-read-only", "declared-read-only"]);

    const invalidDeclarations = [
      "null",
      "undefined",
      "[]",
      "{ filesystem: 'write' }",
      "{ filesystem: 'read-only', extra: true }",
      "Object.create({ filesystem: 'read-only' })",
      "Object.defineProperty({}, 'filesystem', { enumerable: true, get() { return 'read-only' } })",
      "({ filesystem: 'read-only', [Symbol('extra')]: true })",
      "args.foreign",
    ];
    for (const declaration of invalidDeclarations) {
      const allocations: number[] = [];
      const before = runnerCalls;
      await assert.rejects(
        runWorkflow(
          script(`return await agent("invalid", { resume: ${declaration} })`, "invalid-resume"),
          {
            args: { foreign: { filesystem: "read-only" } },
            agent: runner,
            persistLogs: false,
            onResumeCallAllocated: (allocated) => allocations.push(allocated),
          },
        ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
          error.recoverable === false,
      );
      assert.deepEqual(allocations, []);
      assert.equal(runnerCalls, before);
    }
  });

  it("records result-only safety and propagates only validated positional source markers", async () => {
    const rows: WorkflowCallRecord[] = [];
    const live = await runWorkflow(
      script(`
const safe = await agent("safe", { resume: { filesystem: "read-only" } })
const unsafe = await agent("unsafe")
const empty = await agent("empty", { resume: { filesystem: "read-only" } })
return { safe, unsafe, empty }`),
      {
        agent: { async run(prompt) { return prompt === "empty" ? "" : prompt; } },
        persistLogs: false,
        onCallRecord: (row) => rows.push(row),
      },
    );
    assert.equal(live.result && typeof live.result, "object");
    assert.deepEqual(rows.map((row) => row.resumeSafety), ["declared-read-only", undefined, undefined]);
    assert.deepEqual(rows.map((row) => row.outcome), ["result", "result", "null"]);

    const journal: JournalEntry = {
      index: 0,
      hash: rows[0].hash,
      result: "cached",
      kind: "agent",
      scope: "source",
    };
    const source = resultRow({
      hash: rows[0].hash,
      path: rows[0].path,
      inputsHash: rows[0].inputsHash,
      resumeSafety: "declared-read-only",
    });
    const prepared: PreparedResume = {
      strategy: "positional-v1",
      sourceRunId: "source",
      requestedPolicy: "positional",
      fallbackReason: "forced-positional",
      eligibility: "safe-prefix",
      sourceCalls: new Map([[0, source]]),
    };
    const replayed = await runWorkflow(
      script(`return await agent("safe", { resume: { filesystem: "read-only" } })`),
      {
        runId: "target",
        agent: { async run() { throw new Error("must replay"); } },
        resumeJournal: new Map([[0, journal]]),
        preparedResume: prepared,
        persistLogs: false,
      },
    );
    assert.deepEqual(
      {
        safety: replayed.calls?.[0].resumeSafety,
        sourceSafety: replayed.calls?.[0].replay?.sourceResumeSafety,
        sourceRunId: replayed.calls?.[0].replay?.sourceRunId,
      },
      {
        safety: "declared-read-only",
        sourceSafety: "declared-read-only",
        sourceRunId: "source",
      },
    );

    source.resumeSafety = "isolated-worktree";
    source.isolation = "worktree";
    source.worktree = false;
    const malformed = await runWorkflow(
      script(`return await agent("safe", { isolation: "worktree", resume: { filesystem: "read-only" } })`),
      {
        runId: "malformed-target",
        cwd: mkdtempSync(join(tmpdir(), "malformed-source-")),
        agent: { async run() { throw new Error("must replay"); } },
        resumeJournal: new Map([[0, journal]]),
        preparedResume: prepared,
        persistLogs: false,
      },
    );
    assert.equal(malformed.calls?.[0].resumeSafety, undefined);
    assert.equal(malformed.calls?.[0].replay?.sourceResumeSafety, undefined);
  });

  it("pins every persisted safety-marker combination", () => {
    assert.equal(validateResumeSafetyMarker(resultRow(), false), true);
    assert.equal(validateResumeSafetyMarker(resultRow({ resumeSafety: "declared-read-only" }), false), true);
    assert.equal(
      validateResumeSafetyMarker(resultRow({ isolation: "worktree", resumeSafety: "declared-read-only" }), false),
      false,
    );
    assert.equal(
      validateResumeSafetyMarker(
        resultRow({ isolation: "worktree", worktree: true, resumeSafety: "isolated-worktree" }),
        false,
      ),
      true,
    );
    assert.equal(
      validateResumeSafetyMarker(
        resultRow({ isolation: "worktree", worktree: false, resumeSafety: "isolated-worktree" }),
        false,
      ),
      false,
    );
    assert.equal(
      validateResumeSafetyMarker(
        resultRow({
          origin: "journal-replay",
          resumeSafety: "declared-read-only",
          replay: {
            sourceRunId: "source",
            recordedIndex: 0,
            match: "index-hash",
            sourceResumeSafety: "declared-read-only",
          },
        }),
        false,
      ),
      true,
    );
    assert.equal(
      validateResumeSafetyMarker(resultRow({ origin: "journal-replay" }), false),
      false,
    );
    assert.equal(
      validateResumeSafetyMarker(
        resultRow({ origin: "journal-replay", resumeSafety: "declared-read-only" }),
        true,
      ),
      false,
    );
    assert.equal(
      validateResumeSafetyMarker(
        resultRow({ kind: "checkpoint", origin: "confirm", resumeSafety: "declared-read-only", budgetDebit: undefined }),
        false,
      ),
      false,
    );
    assert.equal(
      validateResumeSafetyMarker(resultRow({ outcome: "error", resumeSafety: "declared-read-only" }), false),
      false,
    );
  });

  it("records isolated-worktree only for an annotated checkout derived from the run cwd", async () => {
    const dirs = tempDirs();
    try {
      initGitRepo(dirs.cwd);
      const taints: string[] = [];
      const isolated = await runWorkflow(
        script(`return await agent("isolated", { isolation: "worktree", resume: { filesystem: "read-only" } })`),
        {
          runId: "isolated-safe",
          cwd: dirs.cwd,
          agent: { async run(_prompt, options) { return options?.cwd ?? "missing"; } },
          persistLogs: false,
          onResumeFilesystemTainted: () => taints.push("tainted"),
        },
      );
      assert.equal(isolated.calls?.[0].resumeSafety, "isolated-worktree");
      assert.equal(isolated.calls?.[0].worktree, true);
      assert.deepEqual(taints, []);
      assert.equal(existsSync(String(isolated.result)), false, "activity settles only after worktree cleanup");

      const unsafeIsolated = await runWorkflow(
        script(`return await agent("isolated", { isolation: "worktree" })`),
        {
          runId: "isolated-unsafe",
          cwd: dirs.cwd,
          agent: { async run() { return "live"; } },
          persistLogs: false,
          onResumeFilesystemTainted: () => taints.push("unsafe-isolated"),
        },
      );
      assert.equal(unsafeIsolated.calls?.[0].worktree, true);
      assert.equal(unsafeIsolated.calls?.[0].resumeSafety, undefined);

      const externalBase = await runWorkflow(
        script(`return await agent("isolated", { cwd: ".", isolation: "worktree", resume: { filesystem: "read-only" } })`),
        {
          runId: "isolated-external",
          cwd: dirs.cwd,
          agent: { async run() { return "live"; } },
          persistLogs: false,
          onResumeFilesystemTainted: () => taints.push("external-base"),
        },
      );
      assert.equal(externalBase.calls?.[0].worktree, true);
      assert.equal(externalBase.calls?.[0].resumeSafety, undefined);

      const degraded = await runWorkflow(
        script(`return await agent("degraded", { isolation: "worktree", resume: { filesystem: "read-only" } })`),
        {
          cwd: mkdtempSync(join(tmpdir(), "degraded-worktree-")),
          agent: { async run() { return "live"; } },
          persistLogs: false,
          onResumeFilesystemTainted: () => taints.push("degraded"),
        },
      );
      assert.equal(degraded.calls?.[0].resumeSafety, undefined);
      assert.equal(degraded.calls?.[0].worktree, undefined);
      assert.deepEqual(taints, ["unsafe-isolated", "external-base", "degraded"]);
    } finally {
      dirs.cleanup();
    }
  });
});

describe("checkpoint input recording and byte compatibility", () => {
  it("pins checkpoint fingerprints for omission, values, key ordering, and failures", () => {
    const digest = (canonical: string) => createHash("sha256").update(canonical).digest("hex");
    assert.equal(CHECKPOINT_INPUTS_FORMAT, 1);
    assert.equal(CALL_INPUTS_FORMAT, 1);
    assert.equal(hashCheckpointInputs({}), digest("{}"));
    assert.equal(
      hashCheckpointInputs({ default: { z: 1, a: 2 } }),
      digest('{"default":{"a":2,"z":1}}'),
    );
    assert.equal(hashCheckpointInputs({ headless: "pause" }), digest('{"headless":"pause"}'));
    assert.equal(hashCheckpointInputs({ timeoutMs: 125 }), digest('{"timeoutMs":125}'));
    assert.equal(
      hashCheckpointInputs({ timeoutMs: 125, default: "yes", headless: "default" }),
      digest('{"default":"yes","headless":"default","timeoutMs":125}'),
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assert.equal(hashCheckpointInputs({ default: cyclic }), undefined);
  });

  it("writes one captured fingerprint on every terminal checkpoint row", async () => {
    let seenOptions: unknown;
    const result = await runWorkflow(
      script(`
let reads = 0
const options = {
  get default() { reads++; return { accepted: true } },
  get headless() { reads++; return "pause" },
  get timeoutMs() { reads++; return 50 },
}
await checkpoint("confirmed", options)
return reads`),
      {
        agent: { async run() { return "unused"; } },
        persistLogs: false,
        confirm: async (_prompt, options) => {
          seenOptions = options;
          return options.default;
        },
      },
    );
    assert.equal(result.result, 3);
    assert.deepEqual(
      JSON.parse(JSON.stringify(seenOptions)),
      { default: { accepted: true }, headless: "pause", timeoutMs: 50 },
    );
    assert.equal(result.calls?.[0].inputsHash, hashCheckpointInputs({
      default: { accepted: true },
      headless: "pause",
      timeoutMs: 50,
    }));
    const paused = await runWorkflow(
      script(`try { await checkpoint("paused", { default: "later", headless: "pause", timeoutMs: 75 }) } catch {}\nreturn "caught"`),
      { agent: { async run() { return "unused"; } }, persistLogs: false },
    );
    assert.equal(paused.calls?.[0].inputsHash, hashCheckpointInputs({
      default: "later",
      headless: "pause",
      timeoutMs: 75,
    }));
    assert.equal(paused.calls?.[0].error?.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
  });

  it("keeps agent hash and input bytes unchanged when the declaration is added", async () => {
    const rows: WorkflowCallRecord[] = [];
    const journal: JournalEntry[] = [];
    for (const options of ["{ label: 'fixed' }", "{ label: 'fixed', resume: { filesystem: 'read-only' } }"]) {
      await runWorkflow(script(`return await agent("same", ${options})`, "byte-compatible"), {
        agent: { async run() { return "ok"; } },
        persistLogs: false,
        onCallRecord: (row) => rows.push(row),
        onAgentJournal: (entry) => journal.push(entry),
      });
    }
    assert.equal(journal[0].hash, journal[1].hash);
    assert.equal(rows[0].inputsHash, rows[1].inputsHash);
  });
});

describe("filesystem taint and quiescence accounting", () => {
  it("fires every recording-side taint trigger and leaves proven engine-only paths clean", async () => {
    const tainted: string[] = [];
    const run = async (
      name: string,
      body: string,
      options: Partial<Parameters<typeof runWorkflow>[1]> = {},
    ) => {
      let calls = 0;
      await runWorkflow(script(body, name), {
        agent: { async run() { return "live"; } },
        persistLogs: false,
        ...options,
        onResumeFilesystemTainted: () => { calls++; },
      });
      if (calls > 0) tainted.push(name);
      return calls;
    };
    assert.equal(await run("unannotated", `return await agent("write")`), 1);
    assert.equal(
      await run("declared", `return await agent("read", { resume: { filesystem: "read-only" } })`),
      0,
    );
    assert.equal(
      await run("confirm", `return await checkpoint("host")`, { confirm: async () => true }),
      1,
    );
    assert.equal(await run("headless", `return await checkpoint("engine", { default: true })`), 0);
    const child = script(`return "child"`, "child");
    assert.equal(await run("nested", `return await workflow(${JSON.stringify(child)})`), 1);
    assert.equal(
      await run(
        "degraded",
        `return await agent("worktree", { isolation: "worktree", resume: { filesystem: "read-only" } })`,
        { cwd: mkdtempSync(join(tmpdir(), "taint-degraded-")) },
      ),
      1,
    );
    assert.deepEqual(tainted, ["unannotated", "confirm", "nested", "degraded"]);
  });

  it("reports logical, raw-runner, nested, and root-allocation transitions in exact order", async () => {
    const activities: number[] = [];
    const allocations: number[] = [];
    await runWorkflow(
      script(`
await agent("settled", { resume: { filesystem: "read-only" } })
await checkpoint("engine", { default: true })
return "done"`),
      {
        agent: { async run() { return "ok"; } },
        persistLogs: false,
        onResumeActivity: (active) => activities.push(active),
        onResumeCallAllocated: (allocated) => allocations.push(allocated),
      },
    );
    assert.deepEqual(activities, [1, 2, 1, 0, 1, 0]);
    assert.deepEqual(allocations, [1, 2]);

    const blocked = deferred<string>();
    const nestedActivities: number[] = [];
    const child = script(`await args\nreturn "child"`, "blocked-child");
    await runWorkflow(script(`void workflow(${JSON.stringify(child)}, args)\nreturn "root"`, "floated-child"), {
      args: blocked.promise,
      agent: { async run() { return "unused"; } },
      persistLogs: false,
      onResumeActivity: (active) => nestedActivities.push(active),
    });
    assert.deepEqual(nestedActivities, [1]);
    blocked.resolve("ready");
    for (let attempt = 0; attempt < 50 && nestedActivities.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.deepEqual(nestedActivities, [1, 0]);
  });

  it("decrements a synchronously throwing runner unit and retains a timeout loser", async () => {
    const syncActivities: number[] = [];
    await runWorkflow(script(`try { await agent("sync") } catch {}\nreturn "caught"`), {
      agent: { run() { throw new Error("sync"); } } as AgentRunner,
      persistLogs: false,
      onResumeActivity: (active) => syncActivities.push(active),
    });
    assert.deepEqual(syncActivities, [1, 2, 1, 0]);

    const loser = deferred<string>();
    const timeoutActivities: number[] = [];
    const timed = await runWorkflow(script(`return await agent("timeout", { timeoutMs: 1 })`), {
      agent: { async run() { return await loser.promise; } },
      persistLogs: false,
      onResumeActivity: (active) => timeoutActivities.push(active),
    });
    assert.equal(timed.result, null);
    assert.deepEqual(timeoutActivities, [1, 2, 1]);
    loser.resolve("late");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(timeoutActivities, [1, 2, 1, 0]);
  });
});

describe("managed identity-v1 persistence", () => {
  it("pins initial and terminal marker, format, allocation, and key-arm JSON", async () => {
    const dirs = tempDirs();
    const pending = deferred<string>();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "workspace-v1",
        agent: { async run() { return await pending.promise; } },
      });
      const started = manager.startInBackground(
        script(`return await agent("safe", { resume: { filesystem: "read-only" } })`, "json-fixture"),
      );
      const runFile = join(manager.getPersistence().getRunsDir(), `${started.runId}.json`);
      const initial = JSON.parse(readFileSync(runFile, "utf8")) as PersistedRunState;
      const initialFixture = JSON.parse(
        readFileSync(join(import.meta.dirname, "fixtures", "identity-v1-initial.json"), "utf8"),
      );
      assert.deepEqual(
        {
          resume: initial.resume,
          runtime: { checkpointInputsFormat: initial.runtime?.checkpointInputsFormat },
          callsAllocated: initial.callsAllocated,
        },
        initialFixture,
      );
      assert.equal(Object.hasOwn(initial.resume ?? {}, "terminalEnvironment"), false);

      pending.resolve("done");
      await started.promise;
      const terminal = JSON.parse(readFileSync(runFile, "utf8")) as PersistedRunState;
      const terminalFixture = JSON.parse(
        readFileSync(join(import.meta.dirname, "fixtures", "identity-v1-terminal.json"), "utf8"),
      );
      assert.deepEqual(
        {
          resume: terminal.resume,
          runtime: { checkpointInputsFormat: terminal.runtime?.checkpointInputsFormat },
          callsAllocated: terminal.callsAllocated,
        },
        terminalFixture,
      );
    } finally {
      dirs.cleanup();
    }
  });

  it("omits unsafe key arms, captures tainted git terminal state, and preserves zero-call keys", async () => {
    const dirs = tempDirs();
    try {
      const keyManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
        agent: { async run() { return "ok"; } },
      });
      const unsafe = await keyManager.runSync(script(`return await agent("writer")`, "unsafe-key"));
      assert.deepEqual(keyManager.getPersistence().load(unsafe.runId)?.resume, { format: "identity-v1" });
      const confirmed = await keyManager.runSync(
        script(`return await checkpoint("host")`, "confirm-key"),
        undefined,
        { confirm: async () => true },
      );
      const child = script(`return "child"`, "key-child");
      const nested = await keyManager.runSync(
        script(`return await workflow(${JSON.stringify(child)})`, "nested-key"),
      );
      const degraded = await keyManager.runSync(
        script(`return await agent("worktree", { isolation: "worktree", resume: { filesystem: "read-only" } })`, "degraded-key"),
      );
      for (const run of [confirmed, nested, degraded]) {
        assert.deepEqual(keyManager.getPersistence().load(run.runId)?.resume, { format: "identity-v1" });
      }
      const zero = await keyManager.runSync(script(`return "zero"`, "zero-call"));
      assert.deepEqual(keyManager.getPersistence().load(zero.runId)?.resume?.terminalEnvironment, {
        key: "static-key",
      });
      const headless = await keyManager.runSync(
        script(`return await checkpoint("engine", { default: true })`, "headless-key"),
      );
      assert.deepEqual(keyManager.getPersistence().load(headless.runId)?.resume?.terminalEnvironment, {
        key: "static-key",
      });

      initGitRepo(dirs.cwd);
      const gitManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: {
          async run() {
            writeFileSync(join(dirs.cwd, "tracked.txt"), "changed\n");
            return "changed";
          },
        },
      });
      const gitRun = await gitManager.runSync(script(`return await agent("writer")`, "git-writer"));
      const persisted = gitManager.getPersistence().load(gitRun.runId);
      assert.ok(persisted?.resume?.terminalEnvironment?.git);
      assert.notEqual(
        persisted.resume.terminalEnvironment.git.dirtyDigest,
        persisted.environment?.git?.dirtyDigest,
      );
    } finally {
      dirs.cleanup();
    }
  });

  it("omits terminal identity for floated effects and never retrofits after late settlement", async () => {
    const dirs = tempDirs();
    const floatedAgent = deferred<string>();
    const floatedCheckpoint = deferred<unknown>();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
        agent: { async run() { return await floatedAgent.promise; } },
      });
      const agentRun = await manager.runSync(
        script(`void agent("floated", { resume: { filesystem: "read-only" } })\nreturn "early"`, "floated-agent"),
      );
      assert.equal(manager.getPersistence().load(agentRun.runId)?.resume?.terminalEnvironment, undefined);
      floatedAgent.resolve("late");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(manager.getPersistence().load(agentRun.runId)?.resume?.terminalEnvironment, undefined);

      const checkpointRun = await manager.runSync(
        script(`void checkpoint("floated")\nreturn "early"`, "floated-checkpoint"),
        undefined,
        { confirm: async () => await floatedCheckpoint.promise },
      );
      assert.equal(manager.getPersistence().load(checkpointRun.runId)?.resume?.terminalEnvironment, undefined);
      floatedCheckpoint.resolve(true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(manager.getPersistence().load(checkpointRun.runId)?.resume?.terminalEnvironment, undefined);
    } finally {
      dirs.cleanup();
    }
  });

  it("omits a timeout-losing raw promise, records dense failures, and fails closed on invalid activity", async () => {
    const dirs = tempDirs();
    const loser = deferred<string>();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
        agent: { async run() { return await loser.promise; } },
      });
      const timed = await manager.runSync(script(`return await agent("timeout", { timeoutMs: 1 })`, "timeout-loser"));
      assert.equal(timed.status, "completed");
      assert.equal(manager.getPersistence().load(timed.runId)?.resume?.terminalEnvironment, undefined);
      loser.resolve("late");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(manager.getPersistence().load(timed.runId)?.resume?.terminalEnvironment, undefined);

      const failedManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
        agent: { async run() { return "ok"; } },
      });
      const failed = await failedManager.runSync(
        script(`await agent("safe", { resume: { filesystem: "read-only" } })\nthrow new Error("script")`, "dense-failure"),
      );
      const failedState = failedManager.getPersistence().load(failed.runId);
      assert.equal(failed.status, "failed");
      assert.equal(failedState?.callsAllocated, 1);
      assert.deepEqual(failedState?.calls?.map((row) => row.index), [0]);
      assert.deepEqual(failedState?.resume?.terminalEnvironment, { key: "static-key" });

      const invalidPending = deferred<string>();
      const invalidManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
        agent: { async run() { return await invalidPending.promise; } },
      });
      const invalid = invalidManager.startInBackground(
        script(`return await agent("safe", { resume: { filesystem: "read-only" } })`, "invalid-counter"),
      );
      const managed = invalidManager.getRun(invalid.runId);
      assert.ok(managed);
      managed.resumeActivityInvalid = true;
      invalidPending.resolve("done");
      await invalid.promise;
      assert.equal(invalidManager.getPersistence().load(invalid.runId)?.resume?.terminalEnvironment, undefined);
    } finally {
      dirs.cleanup();
    }
  });

  it("compacts fresh positional runs to current-scope result bijections and drops inherited suffixes", async () => {
    const dirs = tempDirs();
    try {
      const sourceJournal: JournalEntry[] = [];
      const source = await runWorkflow(
        script(`await agent("first")\nreturn await agent("second")`, "compaction-source"),
        {
          runId: "source",
          agent: { async run(prompt) { return prompt; } },
          persistLogs: false,
          onAgentJournal: (entry) => sourceJournal.push(entry),
        },
      );
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { throw new Error("must replay"); } },
      });
      const resumed = await manager.runSync(
        script(`return await agent("first")`, "compaction-target"),
        undefined,
        {
          resumeJournal: new Map(sourceJournal.map((entry) => [entry.index, entry] as const)),
          resumeCalls: source.calls,
        },
      );
      const persisted = manager.getPersistence().load(resumed.runId);
      assert.equal(persisted?.legacyResume, true);
      assert.deepEqual(persisted?.calls?.map((row) => [row.index, row.scope]), [[0, resumed.runId]]);
      assert.deepEqual(persisted?.journal?.map((entry) => [entry.index, entry.scope]), [[0, resumed.runId]]);
      assert.equal(persisted?.journal?.[0].kind, "agent");
      assert.equal(persisted?.calls?.[0].outcome, "result");
    } finally {
      dirs.cleanup();
    }
  });
});

describe("critical legacy marking", () => {
  function failingPersistence(root: string): {
    persistence: RunPersistence;
    states: Map<string, PersistedRunState>;
    failSave: (value: boolean) => void;
  } {
    mkdirSync(root, { recursive: true });
    const states = new Map<string, PersistedRunState>();
    const leases = new Set<string>();
    let failing = false;
    const persistence: RunPersistence = {
      save(state) {
        if (failing) throw new Error("save failed");
        states.set(state.runId, structuredClone(state));
      },
      load(runId) { return states.get(runId) ? structuredClone(states.get(runId)!) : null; },
      list() { return [...states.values()].map((state) => structuredClone(state)); },
      delete(runId) { return states.delete(runId); },
      acquireRunLease(runId) {
        if (leases.has(runId)) return null;
        leases.add(runId);
        return { runId, token: runId };
      },
      releaseRunLease(lease: RunLease) { leases.delete(lease.runId); },
      getRunsDir() { return root; },
    };
    return { persistence, states, failSave: (value) => { failing = value; } };
  }

  it("exposes neither manual-journal nor same-ID execution when the permanent write fails", async () => {
    const dirs = tempDirs();
    try {
      const manualStore = failingPersistence(join(dirs.root, "manual"));
      manualStore.failSave(true);
      let manualCalls = 0;
      const manualManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: manualStore.persistence,
        agent: { async run() { manualCalls++; return "live"; } },
      });
      assert.throws(
        () => manualManager.startInBackground(script(`return await agent("x")`), undefined, {
          runId: "manual-target",
          resumeJournal: new Map(),
        }),
        (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(manualCalls, 0);
      const manualLease = manualStore.persistence.acquireRunLease("manual-target");
      assert.ok(manualLease, "failed initial save releases the target lease");
      manualStore.persistence.releaseRunLease(manualLease);

      const sameStore = failingPersistence(join(dirs.root, "same-id"));
      const now = new Date().toISOString();
      sameStore.persistence.save({
        runId: "same-id",
        workflowName: "same-id",
        script: script(`return await agent("x")`, "same-id"),
        status: "paused",
        phases: [],
        agents: [],
        logs: [],
        journal: [],
        startedAt: now,
        updatedAt: now,
      });
      sameStore.failSave(true);
      let sameCalls = 0;
      const sameManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: sameStore.persistence,
        agent: { async run() { sameCalls++; return "live"; } },
      });
      await assert.rejects(
        sameManager.resumeInBackground("same-id"),
        (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(sameCalls, 0);
      sameStore.failSave(false);
      const sameLease = sameStore.persistence.acquireRunLease("same-id");
      assert.ok(sameLease, "failed same-ID marker save releases the run lease");
      sameStore.persistence.releaseRunLease(sameLease);
    } finally {
      dirs.cleanup();
    }
  });
});
