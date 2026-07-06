// Child-process fixture for rejection-tripwire.test.ts. Each scenario runs a workflow
// whose script floats a promise (or triggers a host-side rejection) and prints ONE JSON
// line with the observed outcome. It runs in a CHILD process because Node's
// `unhandledRejection` event is process-visible even when the engine contains it — the
// parent's node:test runner would otherwise fail the test on the very emission the
// tripwire exists to contain. The parent asserts on this JSON plus the exit code (a
// non-crashing child IS the containment guarantee).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorkflowManager } from "../../src/workflow-manager.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { workflowProjectPaths } from "../../src/workflow-paths.js";

const scenario = process.argv[2];
const cwd = process.env.AP_TEST_CWD;
if (!scenario || !cwd) {
  console.error("usage: tripwire-child.ts <scenario> (with AP_TEST_CWD set)");
  process.exit(2);
}

function script(name: string, body: string): string {
  return `export const meta = { name: '${name}', description: '${name}' }\n${body}`;
}

function slowAgent(onSignal?: (signal: AbortSignal | undefined) => void) {
  return {
    async run(_prompt: string, opts: { signal?: AbortSignal } = {}) {
      onSignal?.(opts.signal);
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "slow done";
    },
  };
}

function failFastAgent(badPrompt: string, message: string) {
  return {
    async run(prompt: string, opts: { signal?: AbortSignal } = {}) {
      if (prompt === badPrompt) {
        throw new WorkflowError(message, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "slow done";
    },
  };
}

interface Report {
  status: string;
  reason?: string;
  code?: string;
  result?: unknown;
  signalAborted?: boolean;
  leaseReleased?: boolean;
  hostSeen?: number;
}

async function runScenario(): Promise<Report> {
  switch (scenario) {
    case "realm_float": {
      let captured: AbortSignal | undefined;
      const manager = new WorkflowManager({ cwd, agent: slowAgent((s) => (captured = s)) });
      const result = await manager.runSync(
        script("realm_float", "Promise.reject(new Error('float boom'))\nreturn await agent('slow', { label: 'slow' })"),
      );
      return report(manager, result, { signalAborted: captured?.aborted === true });
    }
    case "engine_float": {
      const manager = new WorkflowManager({ cwd, agent: failFastAgent("bad", "schema never complied") });
      const result = await manager.runSync(
        script("engine_float", "agent('bad', { label: 'bad' })\nreturn await agent('slow', { label: 'slow' })"),
      );
      return report(manager, result);
    }
    case "chained_float": {
      const manager = new WorkflowManager({ cwd, agent: failFastAgent("bad", "chained boom") });
      const result = await manager.runSync(
        script(
          "chained_float",
          "agent('bad', { label: 'bad' }).then((r) => r)\nreturn await agent('slow', { label: 'slow' })",
        ),
      );
      return report(manager, result);
    }
    case "tail_float": {
      const manager = new WorkflowManager({ cwd, agent: { async run() { return "unused"; } } });
      const result = await manager.runSync(script("tail_float", "Promise.reject(new Error('tail boom'))\nreturn 1"));
      return report(manager, result);
    }
    case "host_listener_coexists": {
      // A host listener exists: the engine must neither rethrow nor claim the host's own
      // rejection, and the run must complete untouched.
      const seen: unknown[] = [];
      process.on("unhandledRejection", (reason) => seen.push(reason));
      const manager = new WorkflowManager({ cwd, agent: slowAgent() });
      const inFlight = manager.runSync(script("innocent_run", "return await agent('x', { label: 'x' })"));
      void Promise.reject(new Error("host boom"));
      const result = await inFlight;
      return { ...report(manager, result), hostSeen: seen.length };
    }
    case "unattributable_crash": {
      // NO host listener: an unattributable host-side rejection during an active run must
      // preserve the platform default — the engine rethrows and this child CRASHES. The
      // parent asserts a non-zero exit.
      const manager = new WorkflowManager({ cwd, agent: slowAgent() });
      void manager.runSync(script("innocent_run", "return await agent('x', { label: 'x' })"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      void Promise.reject(new Error("host boom"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { status: "unexpectedly-survived" };
    }
    default:
      console.error(`unknown scenario: ${scenario}`);
      process.exit(2);
  }
}

function report(
  manager: WorkflowManager,
  result: { status: string; reason?: string; runId: string; result?: unknown },
  extra: Partial<Report> = {},
): Report {
  const error = manager.getRun(result.runId)?.error as { code?: string } | undefined;
  return {
    status: result.status,
    reason: result.reason,
    code: error?.code,
    result: result.result,
    leaseReleased: !existsSync(join(workflowProjectPaths(cwd!).runsDir, `${result.runId}.lock`)),
    ...extra,
  };
}

const out = await runScenario();
console.log(JSON.stringify(out));
process.exit(0);
