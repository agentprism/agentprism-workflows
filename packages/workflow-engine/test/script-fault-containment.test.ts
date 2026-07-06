import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { AGENTPRISM_PERSISTENCE_ROOT_ENV, workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const noopAgent = {
  async run() {
    return "unused";
  },
};

const faultScripts = [
  {
    name: "sync Error throw",
    script: scriptBody("sync_error_throw", "throw new Error('sync boom')"),
    message: /sync boom/,
  },
  {
    name: "sync non-Error string throw",
    script: scriptBody("sync_string_throw", "throw 'string boom'"),
    message: /string boom/,
  },
  {
    name: "sync non-Error object throw",
    script: scriptBody("sync_object_throw", "throw { message: 'object boom', code: 'OBJECT_BOOM' }"),
    message: /object boom/,
  },
  {
    name: "sync throwing message getter object throw",
    script: scriptBody(
      "sync_throwing_getter_throw",
      [
        "const throwable = {",
        "  get message() { throw new Error('message getter boom') },",
        "  toString() { return 'throwable with unreadable message' }",
        "}",
        "throw throwable",
      ].join("\n"),
    ),
    message: /throwable with unreadable message/,
  },
  {
    name: "sync circular object throw",
    script: scriptBody(
      "sync_circular_throw",
      [
        "const throwable = { message: '', toString() { return 'circular throwable' } }",
        "throwable.self = throwable",
        "throw throwable",
      ].join("\n"),
    ),
    message: /circular throwable/,
  },
  {
    name: "async rejection after await",
    script: scriptBody("async_rejection", "await Promise.resolve()\nthrow new Error('async boom')"),
    message: /async boom/,
  },
] as const;

function scriptBody(name: string, body: string): string {
  return `export const meta = { name: '${name}', description: '${name}' }
${body}`;
}

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-dw-fault-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-dw-home-"));
    const priorRoot = process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
    try {
      delete process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      if (priorRoot === undefined) delete process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV];
      else process.env[AGENTPRISM_PERSISTENCE_ROOT_ENV] = priorRoot;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

async function withUnhandledRejectionTripwire(fn: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", handler);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled.map((reason) => String(reason)), [], "workflow faults must not escape as unhandled rejections");
  } finally {
    process.off("unhandledRejection", handler);
  }
}

function assertLeaseReleased(cwd: string, runId: string): void {
  assert.equal(
    existsSync(join(workflowProjectPaths(cwd).runsDir, `${runId}.lock`)),
    false,
    "failed workflow must release its run lease",
  );
}

for (const fault of faultScripts) {
  test(
    `runSync contains ${fault.name} as a failed workflow result`,
    withTempCwd(async (cwd) => {
      await withUnhandledRejectionTripwire(async () => {
        const manager = new WorkflowManager({ cwd, agent: noopAgent });
        const result = await manager.runSync(fault.script);

        assert.equal(result.status, "failed");
        assert.match(result.reason ?? "", fault.message);
        assert.equal(manager.getRun(result.runId)?.status, "failed");
        // A script crash is labeled SCRIPT_ERROR — never WORKFLOW_ABORTED (nobody cancelled).
        assert.equal(
          (manager.getRun(result.runId)?.error as WorkflowError | undefined)?.code,
          WorkflowErrorCode.SCRIPT_ERROR,
        );
        assertLeaseReleased(cwd, result.runId);
      });
    }),
  );
}

for (const fault of faultScripts) {
  test(
    `startInBackground contains ${fault.name} without unhandledRejection`,
    withTempCwd(async (cwd) => {
      await withUnhandledRejectionTripwire(async () => {
        const manager = new WorkflowManager({ cwd, agent: noopAgent });
        const { runId, promise } = manager.startInBackground(fault.script);

        // The returned promise is intentionally still the caller-visible failure
        // channel; the manager's side-channel catch prevents host-level leakage.
        await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(
          promise,
          (error: unknown) =>
            error instanceof WorkflowError &&
            fault.message.test(error.message) &&
            error.code === WorkflowErrorCode.SCRIPT_ERROR,
        );
        assert.equal(manager.getRun(runId)?.status, "failed");
        assert.match(manager.getRun(runId)?.error?.message ?? "", fault.message);
        assertLeaseReleased(cwd, runId);
      });
    }),
  );
}
