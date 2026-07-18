import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

const SCRIPT = [
  'export const meta = { name: "crash-recovery", description: "crash recovery" };',
  'const first = await agent("first", { label: "first", resume: { filesystem: "read-only" } });',
  'const second = await agent("second", { label: "second", resume: { filesystem: "read-only" } });',
  "return { first, second };",
].join("\n");

async function waitForChildOutput(child: ChildProcess, needle: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`child did not emit ${needle}; stdout=${output}`));
    }, 10_000);
    const settled = (callback: () => void) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      callback();
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(needle)) settled(resolve);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settled(() => reject(new Error(`child exited before readiness: code=${code} signal=${signal}`)));
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

test("SIGKILL crash residue is lazily paused and reports environment drift without vetoing replay", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentprism-crash-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "agentprism-crash-runs-"));
  const sourceRunId = "sigkill-source";
  const livePrompts: string[] = [];
  const manager = new WorkflowManager({
    cwd,
    persistenceRoot,
    environmentKey: "crash-environment",
    agent: {
      async run(prompt: string) {
        livePrompts.push(prompt);
        return `parent:${prompt}`;
      },
    },
  });
  const fixture = join(import.meta.dirname, "fixtures", "stale-lock-child.ts");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fixture,
      cwd,
      persistenceRoot,
      sourceRunId,
      Buffer.from(SCRIPT, "utf8").toString("base64url"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForChildOutput(child, "SECOND_AGENT_STARTED");
    const persistence = createRunPersistence(cwd, undefined, { persistenceRoot });
    const crashed = persistence.load(sourceRunId);
    assert.equal(crashed?.status, "running");
    assert.equal(crashed?.journal?.length, 1);
    assert.equal(crashed?.resume?.format, "identity-v1");
    assert.equal(crashed?.resume?.terminalEnvironment, undefined);
    const lockPath = join(workflowProjectPaths(cwd, { persistenceRoot }).runsDir, `${sourceRunId}.lock`);
    assert.equal(existsSync(lockPath), true);

    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    await exited;

    const resumed = await manager.runSync(SCRIPT, undefined, {
      runId: "sigkill-resumed",
      resumeFromRunId: sourceRunId,
    });
    assert.equal(resumed.status, "completed");
    const result = resumed.result as Record<string, unknown>;
    assert.equal(result.first, "child:first");
    assert.equal(result.second, "parent:second");
    assert.equal(resumed.resumeReport?.strategy, "positional-v1");
    if (resumed.resumeReport?.strategy === "positional-v1") {
      assert.equal(resumed.resumeReport.fallbackReason, "crash-residue");
      assert.equal(resumed.resumeReport.eligibility, "legacy");
    }
    assert.equal(resumed.resumeReport?.replayed, 1);
    assert.equal(resumed.resumeReport?.live, 1);
    assert.deepEqual(livePrompts, ["second"]);
    const reconciled = persistence.load(sourceRunId);
    assert.equal(reconciled?.status, "paused");
    assert.equal(reconciled?.pauseReason, "interrupted");
    assert.match(reconciled?.reason ?? "", new RegExp(`PID ${child.pid} exited`));
    assert.equal(existsSync(lockPath), false);

    const drifted = await manager.runSync(SCRIPT, undefined, {
      runId: "sigkill-drifted",
      resumeFromRunId: sourceRunId,
      environmentKey: "drifted-environment",
    });
    assert.equal(drifted.status, "completed");
    assert.equal(drifted.resumeReport?.strategy, "positional-v1");
    if (drifted.resumeReport?.strategy === "positional-v1") {
      assert.equal(drifted.resumeReport.fallbackReason, "crash-residue");
      assert.equal(drifted.resumeReport.eligibility, "legacy");
    }
    assert.equal(drifted.resumeReport?.replayed, 1);
    assert.equal(drifted.resumeReport?.live, 1);
    assert.equal(drifted.replayEligibility?.firstNonReplay?.reason, "positional-miss");
    assert.deepEqual(drifted.replayEligibility?.provenanceChanges, [{
      field: "environment.key",
      source: "crash-environment",
      current: "drifted-environment",
      detail: "source recorded environment key=crash-environment; this run: drifted-environment",
    }]);
    assert.deepEqual(livePrompts, ["second", "second"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
