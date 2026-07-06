// Run-scoped unhandled-rejection tripwire (WE-3 embedding safety): a promise the SCRIPT
// floated must fail THAT run with SCRIPT_ERROR — never crash the host process, and never
// be misattributed to the host's own promises.
//
// Every scenario runs in a CHILD process (test/fixtures/tripwire-child.ts). Node's
// `unhandledRejection` event is process-visible even when the engine contains it, and
// node:test fails the active test on the emission itself — so in-process assertions
// would test the harness, not the contract. The contract IS the child's exit code
// (0 = the host survived) plus the JSON outcome it prints.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENTPRISM_PERSISTENCE_ROOT_ENV } from "../src/workflow-paths.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(packageDir, "test", "fixtures", "tripwire-child.ts");

interface ChildOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  report?: {
    status: string;
    reason?: string;
    code?: string;
    result?: unknown;
    signalAborted?: boolean;
    leaseReleased?: boolean;
    hostSeen?: number;
  };
}

async function runScenario(scenario: string): Promise<ChildOutcome> {
  const workCwd = mkdtempSync(join(tmpdir(), "ap-dw-trip-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "ap-dw-trip-root-"));
  try {
    return await new Promise<ChildOutcome>((resolve, reject) => {
      // cwd stays at the package dir so `--import tsx` resolves; the workflow's own cwd
      // and persistence root are threaded via env so nothing touches the real home.
      const child = spawn(process.execPath, ["--import", "tsx", fixture, scenario], {
        cwd: packageDir,
        env: {
          ...process.env,
          AP_TEST_CWD: workCwd,
          [AGENTPRISM_PERSISTENCE_ROOT_ENV]: persistenceRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`tripwire child (${scenario}) timed out\nstderr: ${stderr}`));
      }, 30_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        const lastLine = stdout.trim().split("\n").at(-1);
        let report: ChildOutcome["report"];
        try {
          report = lastLine ? JSON.parse(lastLine) : undefined;
        } catch {
          report = undefined;
        }
        resolve({ exitCode, stdout, stderr, report });
      });
    });
  } finally {
    rmSync(workCwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
}

function assertTripped(outcome: ChildOutcome, message: RegExp) {
  assert.equal(outcome.exitCode, 0, `host process must survive a script float\nstderr: ${outcome.stderr}`);
  assert.ok(outcome.report, `child must report an outcome\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`);
  assert.equal(outcome.report?.status, "failed");
  assert.match(outcome.report?.reason ?? "", /Unhandled promise rejection in workflow script/);
  assert.match(outcome.report?.reason ?? "", message);
  assert.equal(outcome.report?.code, "SCRIPT_ERROR", "a script float is labeled SCRIPT_ERROR, not WORKFLOW_ABORTED");
  assert.equal(outcome.report?.leaseReleased, true, "tripped workflow must release its run lease");
}

test("a floating realm-created rejection mid-run trips the run and cancels in-flight agents", async () => {
  const outcome = await runScenario("realm_float");
  assertTripped(outcome, /float boom/);
  assert.equal(outcome.report?.signalAborted, true, "in-flight agent signal must abort on trip");
});

test("a floating (un-awaited) engine agent() rejection is realm-attributed and trips the run", async () => {
  const outcome = await runScenario("engine_float");
  assertTripped(outcome, /schema never complied/);
});

test("a floating .then() chain derived from an engine promise is still realm-attributed", async () => {
  const outcome = await runScenario("chained_float");
  assertTripped(outcome, /chained boom/);
});

test("a trailing float left behind by an otherwise-successful script is caught by the drain hop", async () => {
  const outcome = await runScenario("tail_float");
  assertTripped(outcome, /tail boom/);
});

test("a HOST-side rejection during a run is not attributed; the host's listener stays in charge", async () => {
  const outcome = await runScenario("host_listener_coexists");
  assert.equal(outcome.exitCode, 0, `stderr: ${outcome.stderr}`);
  assert.equal(outcome.report?.status, "completed", "host rejection must not fail the workflow run");
  assert.equal(outcome.report?.result, "slow done");
  assert.equal(outcome.report?.hostSeen, 1, "the host's own listener still observes its rejection");
});

test("an unattributable rejection with NO host listener preserves the platform crash default", async () => {
  const outcome = await runScenario("unattributable_crash");
  assert.notEqual(outcome.exitCode, 0, "the child must crash exactly as it would without the tripwire");
  assert.match(outcome.stderr, /host boom/);
});
