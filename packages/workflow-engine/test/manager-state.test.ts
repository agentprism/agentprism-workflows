import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import type { JournalEntry, WorkflowCallRecord } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createRunPersistence, type PersistedRunState, type RunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { CALL_INPUTS_FORMAT, CALL_PATH_FORMAT, CHECKPOINT_INPUTS_FORMAT } from "../src/workflow.js";

const script = (body: string, name = "manager-state") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: 'manager state' }\n${body}`;

function tempDirs(): { cwd: string; root: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "manager-state-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "manager-state-root-"));
  return {
    cwd,
    root,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("WorkflowManager PR3 state", () => {
  it("waits for an optional execution admission decision before evaluating authored code", async () => {
    const dirs = tempDirs();
    try {
      let runnerCalls = 0;
      let confirmCalls = 0;
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { runnerCalls++; return "ran"; } },
      });

      const ordinary = await manager.runSync(script(`return await agent('ordinary')`, "ordinary-admission"));
      assert.equal(ordinary.status, "completed");
      assert.equal(runnerCalls, 1, "omitting the option preserves immediate execution");

      let admit!: (decision: "admitted") => void;
      const admittedDecision = new Promise<"admitted">((resolve) => { admit = resolve; });
      const admitted = manager.startInBackground(
        script(`log('admitted-authored-log')\nreturn await agent('admitted')`, "admitted-latch"),
        undefined,
        { executionAdmission: admittedDecision },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runnerCalls, 1);
      assert.deepEqual(manager.getSnapshot(admitted.runId)?.logs, []);
      admit("admitted");
      assert.equal((await admitted.promise).status, "completed");
      assert.equal(runnerCalls, 2);
      assert.equal(manager.getSnapshot(admitted.runId)?.logs.includes("admitted-authored-log"), true);

      let deny!: (decision: "denied") => void;
      const deniedDecision = new Promise<"denied">((resolve) => { deny = resolve; });
      const denied = manager.startInBackground(
        script(
          `log('denied-authored-log')\nreturn await checkpoint('denied checkpoint')`,
          "denied-latch",
        ),
        undefined,
        {
          executionAdmission: deniedDecision,
          confirm: async () => { confirmCalls++; return true; },
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(manager.getSnapshot(denied.runId)?.logs, []);
      assert.equal(confirmCalls, 0);
      deny("denied");
      await assert.rejects(
        denied.promise,
        (error: unknown) =>
          error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(manager.getRun(denied.runId)?.status, "failed");
      assert.deepEqual(manager.getSnapshot(denied.runId)?.logs, []);
      assert.equal(confirmCalls, 0, "denial must not enter a checkpoint or any other authored code");
    } finally {
      dirs.cleanup();
    }
  });

  it("snapshots strict args before execution on runSync and startInBackground", async () => {
    const dirs = tempDirs();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const syncArgs = { value: 1, nested: { stable: true } };
      const sync = await manager.runSync(script(`args.value = 2\nargs.nested.stable = false\nreturn args.value`), syncArgs);
      assert.equal(sync.status, "completed");
      assert.deepEqual(syncArgs, { value: 1, nested: { stable: true } });
      assert.deepEqual(manager.getPersistence().load(sync.runId)?.args, syncArgs);

      const backgroundArgs = { value: 3 };
      const background = manager.startInBackground(
        script(`args.value = 4\nreturn args.value`, "background-args"),
        backgroundArgs,
        { executionMode: { kind: "isolation", baselineRunId: "baseline" } },
      );
      const initial = manager.getPersistence().load(background.runId);
      assert.deepEqual(initial?.args, { value: 3 }, "the initial save already has the snapshot");
      assert.deepEqual(initial?.executionMode, { kind: "isolation", baselineRunId: "baseline" });
      const completed = await background.promise;
      assert.equal(completed.result, 4);
      assert.deepEqual(backgroundArgs, { value: 3 });
      assert.deepEqual(manager.getPersistence().load(background.runId)?.args, { value: 3 });

      const noArgs = await manager.runSync(script(`return args === undefined`, "no-args"));
      assert.equal(noArgs.result, true);

      const crossRealmArgs = vm.runInNewContext(`({ value: 7, nested: { stable: true } })`) as {
        value: number;
        nested: { stable: boolean };
      };
      const crossRealm = await manager.runSync(
        script(`args.value = 8\nreturn args.value`, "cross-realm-args"),
        crossRealmArgs,
      );
      assert.equal(crossRealm.result, 8);
      assert.equal(crossRealmArgs.value, 7);
      assert.equal(manager.getPersistence().load(crossRealm.runId)?.argsUnreplayable, undefined);
    } finally {
      dirs.cleanup();
    }
  });

  it("snapshots args on resume and keeps the persisted pre-execution value", async () => {
    const dirs = tempDirs();
    try {
      const workflow = script(
        `args.count++
const answer = await checkpoint('continue', { headless: 'pause' })
return { count: args.count, answer }`,
        "resume-args",
      );
      const callerArgs = { count: 0 };
      const first = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const paused = await first.runSync(workflow, callerArgs);
      assert.equal(paused.status, "paused");
      assert.deepEqual(callerArgs, { count: 0 });
      assert.deepEqual(first.getPersistence().load(paused.runId)?.args, { count: 0 });
      assert.ok(paused.checkpointContext);

      const second = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const resumed = await second.resumeInBackground(paused.runId, {
        checkpointReplies: { [paused.checkpointContext.callIndex]: "yes" },
      });
      assert.equal(resumed.accepted, true);
      if (!resumed.accepted) assert.fail("resume should be accepted");
      const completed = await resumed.promise;
      assert.deepEqual(JSON.parse(JSON.stringify(completed.result)), { count: 1, answer: "yes" });
      assert.deepEqual(second.getPersistence().load(paused.runId)?.args, { count: 0 });
    } finally {
      dirs.cleanup();
    }
  });

  it("executes non-strict args unchanged and persists argsUnreplayable without rejecting", async () => {
    const dirs = tempDirs();
    try {
      class Counter {
        value = 4;
        read() { return this.value; }
      }
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const date = new Date("2020-01-02T00:00:00.000Z");
      const dateRun = await manager.runSync(script(`return args.getUTCFullYear()`, "date-args"), date);
      assert.equal(dateRun.status, "completed");
      assert.equal(dateRun.result, 2020);
      assert.equal(manager.getPersistence().load(dateRun.runId)?.argsUnreplayable, true);

      const custom = new Counter();
      const customRun = manager.startInBackground(script(`return args.read()`, "custom-args"), custom);
      assert.equal((await customRun.promise).result, 4);
      assert.equal(manager.getPersistence().load(customRun.runId)?.argsUnreplayable, true);
    } finally {
      dirs.cleanup();
    }
  });

  it("persists effective cwd, full runtime identity, and non-git environment keys", async () => {
    const dirs = tempDirs();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "host-environment",
        agent: { async run() { return "unused"; } },
      });
      const result = await manager.runSync(script(`return cwd`));
      const persisted = manager.getPersistence().load(result.runId);
      assert.equal(persisted?.effectiveCwd, dirs.cwd);
      assert.deepEqual(persisted?.runtime, {
        node: process.version,
        v8: process.versions.v8,
        pathFormat: CALL_PATH_FORMAT,
        inputsFormat: CALL_INPUTS_FORMAT,
        checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
      });
      assert.deepEqual(persisted?.environment, { key: "host-environment" });
      assert.equal(persisted?.callsAllocated, 0);
      assert.deepEqual(persisted?.limits, {
        maxAgents: 1000,
        tokenBudget: null,
        concurrency: 8,
        agentRetries: 0,
        agentTimeoutMs: null,
      });
    } finally {
      dirs.cleanup();
    }
  });

  it("captures git HEAD plus a content-sensitive dirty digest at run creation", async () => {
    const dirs = tempDirs();
    try {
      execFileSync("git", ["-C", dirs.cwd, "init", "-q"]);
      execFileSync("git", ["-C", dirs.cwd, "config", "user.email", "tests@example.com"]);
      execFileSync("git", ["-C", dirs.cwd, "config", "user.name", "Tests"]);
      writeFileSync(join(dirs.cwd, "tracked.txt"), "clean\n");
      execFileSync("git", ["-C", dirs.cwd, "add", "tracked.txt"]);
      execFileSync("git", ["-C", dirs.cwd, "commit", "-qm", "initial"]);

      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const clean = await manager.runSync(script(`return 'clean'`, "git-clean"));
      const cleanIdentity = manager.getPersistence().load(clean.runId)?.environment?.git;
      assert.equal(cleanIdentity?.head, execFileSync("git", ["-C", dirs.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());

      writeFileSync(join(dirs.cwd, "tracked.txt"), "dirty content\n");
      const dirty = await manager.runSync(script(`return 'dirty'`, "git-dirty"));
      const dirtyIdentity = manager.getPersistence().load(dirty.runId)?.environment?.git;
      assert.equal(dirtyIdentity?.head, cleanIdentity?.head);
      assert.notEqual(dirtyIdentity?.dirtyDigest, cleanIdentity?.dirtyDigest);
    } finally {
      dirs.cleanup();
    }
  });

  it("drops journal, manifest, and agent events that arrive after terminal save", async () => {
    const dirs = tempDirs();
    try {
      let finish!: (value: string) => void;
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return await new Promise<string>((resolve) => { finish = resolve; }); } },
      });
      let journalEvents = 0;
      let recordEvents = 0;
      let endEvents = 0;
      manager.on("journal", () => journalEvents++);
      manager.on("callRecord", () => recordEvents++);
      manager.on("agentEnd", () => endEvents++);
      const result = await manager.runSync(script(`void agent('late', { label: 'late' })\nreturn 'early'`, "late-drop"));
      assert.equal(result.status, "completed");
      const before = manager.getPersistence().load(result.runId);
      finish("late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const after = manager.getPersistence().load(result.runId);
      assert.deepEqual(after, before);
      assert.deepEqual({ journalEvents, recordEvents, endEvents }, { journalEvents: 0, recordEvents: 0, endEvents: 0 });
    } finally {
      dirs.cleanup();
    }
  });

  it("persists abortSignaled when a script catches the caller abort and completes", async () => {
    const dirs = tempDirs();
    try {
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      const controller = new AbortController();
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: {
          async run(_prompt, options) {
            started();
            return await new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(new WorkflowError("aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })),
                { once: true },
              );
            });
          },
        },
      });
      const pending = manager.runSync(
        script(`try { await agent('wait') } catch {}\nreturn 'caught'`, "caught-abort"),
        undefined,
        { externalSignal: controller.signal },
      );
      await didStart;
      controller.abort();
      const result = await pending;
      assert.equal(result.status, "completed");
      assert.equal(result.abortSignaled, true);
      assert.equal(manager.getPersistence().load(result.runId)?.abortSignaled, true);
    } finally {
      dirs.cleanup();
    }
  });

  it("guards caller run ids lease-first, including a second manager before the first save", async () => {
    const states = new Map<string, PersistedRunState>();
    const held = new Set<string>();
    let onFirstLoad: (() => void) | undefined;
    const persistence: RunPersistence = {
      save(state) { states.set(state.runId, structuredClone(state)); },
      load(runId) {
        const callback = onFirstLoad;
        onFirstLoad = undefined;
        callback?.();
        return states.get(runId) ?? null;
      },
      list() { return [...states.values()]; },
      delete(runId) { return states.delete(runId); },
      acquireRunLease(runId) {
        if (held.has(runId)) return null;
        held.add(runId);
        return { runId, token: runId };
      },
      releaseRunLease(lease) { held.delete(lease.runId); },
      getRunsDir() { return "/memory"; },
    };
    let finish!: (value: string) => void;
    const runner = { async run() { return await new Promise<string>((resolve) => { finish = resolve; }); } };
    const first = new WorkflowManager({ persistence, agent: runner });
    const second = new WorkflowManager({ persistence, agent: runner });
    let collision: unknown;
    onFirstLoad = () => {
      try {
        second.startInBackground(script(`return await agent('x')`), undefined, { runId: "shared-id" });
      } catch (error) {
        collision = error;
      }
    };
    const started = first.startInBackground(script(`return await agent('x')`), undefined, { runId: "shared-id" });
    assert.ok(collision instanceof WorkflowError);
    assert.equal(collision.code, WorkflowErrorCode.PERSISTENCE_ERROR);
    assert.match(collision.message, /run id already exists: shared-id/);
    finish("done");
    assert.equal((await started.promise).status, "completed");
  });

  it("rejects isolation artifacts on resume, marks legacy resumes, and persists root scope only", async () => {
    const dirs = tempDirs();
    try {
      const persistence = createRunPersistence(dirs.cwd, undefined, { persistenceRoot: dirs.root });
      const now = new Date().toISOString();
      persistence.save({
        runId: "isolation-artifact",
        workflowName: "artifact",
        script: script(`return 'x'`, "artifact"),
        status: "paused",
        phases: [],
        agents: [],
        logs: [],
        startedAt: now,
        updatedAt: now,
        executionMode: { kind: "isolation", baselineRunId: "baseline" },
      });
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "ok"; } },
      });
      assert.deepEqual(await manager.resumeInBackground("isolation-artifact"), { accepted: false });

      persistence.save({
        runId: "legacy",
        workflowName: "legacy",
        script: script(`return await agent('x')`, "legacy"),
        status: "paused",
        phases: [],
        agents: [],
        logs: [],
        journal: [],
        startedAt: now,
        updatedAt: now,
      });
      const legacy = await manager.resumeInBackground("legacy");
      assert.equal(legacy.accepted, true);
      if (!legacy.accepted) assert.fail("legacy resume should run");
      await legacy.promise;
      assert.equal(persistence.load("legacy")?.legacyResume, true);

      const child = script(`return await agent('child', { label: 'child' })`, "child");
      const root = await manager.runSync(
        script(`await workflow(${JSON.stringify(child)})\nreturn await agent('root', { label: 'root' })`, "root"),
      );
      const persisted = persistence.load(root.runId);
      assert.deepEqual(persisted?.journal?.map((entry: JournalEntry) => entry.scope), [root.runId]);
      assert.deepEqual(persisted?.calls?.map((row: WorkflowCallRecord) => row.scope), [root.runId]);
      assert.equal(persisted?.nestedWorkflows, true);
      assert.deepEqual(
        persisted?.agents.map((agent) => ({ scope: agent.scope, callIndex: agent.callIndex, status: agent.status })),
        [
          { scope: `${root.runId}-nested1`, callIndex: 0, status: "done" },
          { scope: root.runId, callIndex: 0, status: "done" },
        ],
      );
    } finally {
      dirs.cleanup();
    }
  });
});
