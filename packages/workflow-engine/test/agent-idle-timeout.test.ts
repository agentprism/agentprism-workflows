import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import { WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";

const script = (options = "") => [
  'export const meta = { name: "idle-watchdog", description: "idle watchdog coverage" };',
  `return await agent("work", { label: "worker"${options ? `, ${options}` : ""} });`,
].join("\n");

function silentAbortIgnoringRunner(): {
  runner: AgentRunner;
  starts: number[];
  aborts: number[];
} {
  const starts: number[] = [];
  const aborts: number[] = [];
  return {
    starts,
    aborts,
    runner: {
      run(_prompt: string, options?: RunOptions) {
        starts.push(Date.now());
        options?.signal?.addEventListener("abort", () => aborts.push(Date.now()), { once: true });
        return new Promise<string>(() => {});
      },
    },
  };
}

function activeRunner(activityEveryMs: number, settleAfterMs: number): AgentRunner {
  return {
    run(_prompt: string, options?: RunOptions) {
      return new Promise<string>((resolve, reject) => {
        const activity = setInterval(() => options?.onActivity?.(), activityEveryMs);
        const done = setTimeout(() => {
          clearInterval(activity);
          resolve("ok");
        }, settleAfterMs);
        options?.signal?.addEventListener("abort", () => {
          clearInterval(activity);
          clearTimeout(done);
          reject(options.signal?.reason);
        }, { once: true });
      });
    },
  };
}

test("a silent abort-ignoring attempt idles out, retries with a fresh clock, and settles null", async () => {
  const silent = silentAbortIgnoringRunner();
  const startedAt = Date.now();
  const result = await runWorkflow(script(), {
    agent: silent.runner,
    agentIdleTimeoutMs: 35,
    agentRetries: 1,
    persistLogs: false,
  });

  assert.equal(result.result, null);
  assert.equal(silent.starts.length, 2);
  assert.equal(silent.aborts.length, 2, "each idle deadline cancels its runner attempt");
  assert.ok(silent.starts[1]! - silent.starts[0]! >= 20, "retry gets a newly armed idle clock");
  assert.ok(Date.now() - startedAt < 1_000, "an abort-ignoring runner cannot strand settlement");
  assert.equal(result.calls?.[0]?.attempts, 2);
  assert.equal(result.calls?.[0]?.error?.code, WorkflowErrorCode.AGENT_IDLE_TIMEOUT);
  assert.equal(result.calls?.[0]?.error?.recoverable, true);
  assert.ok(
    result.logs.some((line) => line.includes("AGENT_IDLE_TIMEOUT") && line.includes("35ms")),
    "the durable run log names the idle code and duration",
  );
});

test("idle classification wins even when abort makes the runner reject synchronously", async () => {
  const result = await runWorkflow(script(), {
    agent: {
      run(_prompt, options) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("runner aborted", "AbortError")),
            { once: true },
          );
        });
      },
    },
    agentIdleTimeoutMs: 35,
    persistLogs: false,
  });
  assert.equal(result.calls?.[0]?.error?.code, WorkflowErrorCode.AGENT_IDLE_TIMEOUT);
});

test("real backend activity re-arms the watchdog while synthetic wall time keeps passing", async () => {
  const result = await runWorkflow(script(), {
    agent: activeRunner(20, 220),
    agentIdleTimeoutMs: 80,
    agentTimeoutMs: 1_000,
    persistLogs: false,
  });

  assert.equal(result.result, "ok");
  assert.equal(result.calls?.[0]?.outcome, "result");
});

test("a live permission wait suspends only the idle watchdog", async () => {
  const result = await runWorkflow(script(), {
    agent: {
      run(_prompt, options) {
        return new Promise<string>((resolve) => {
          options?.onInteractionStateChange?.({ kind: "permission", state: "waiting" });
          setTimeout(() => {
            options?.onInteractionStateChange?.({ kind: "permission", state: "running" });
            setTimeout(() => resolve("approved"), 15);
          }, 100);
        });
      },
    },
    agentIdleTimeoutMs: 35,
    agentTimeoutMs: 500,
    persistLogs: false,
  });

  assert.equal(result.result, "approved");
  assert.equal(result.calls?.[0]?.outcome, "result");
});

test("total wall-clock timeout continues while permission waits suspend idle time", async () => {
  const result = await runWorkflow(script(), {
    agent: {
      run(_prompt, options) {
        options?.onInteractionStateChange?.({ kind: "permission", state: "waiting" });
        return new Promise<string>(() => {});
      },
    },
    agentIdleTimeoutMs: 20,
    agentTimeoutMs: 60,
    persistLogs: false,
  });
  assert.equal(result.calls?.[0]?.error?.code, WorkflowErrorCode.AGENT_TIMEOUT);
});

test("the tighter of total-wall and idle deadlines wins with a distinct error code", async () => {
  const wallFirst = await runWorkflow(script(), {
    agent: silentAbortIgnoringRunner().runner,
    agentTimeoutMs: 35,
    agentIdleTimeoutMs: 250,
    persistLogs: false,
  });
  assert.equal(wallFirst.calls?.[0]?.error?.code, WorkflowErrorCode.AGENT_TIMEOUT);

  const idleStartedAt = Date.now();
  const idleFirst = await runWorkflow(script(), {
    agent: silentAbortIgnoringRunner().runner,
    agentTimeoutMs: 5_000,
    agentIdleTimeoutMs: 35,
    persistLogs: false,
  });
  assert.equal(idleFirst.calls?.[0]?.error?.code, WorkflowErrorCode.AGENT_IDLE_TIMEOUT);
  assert.ok(Date.now() - idleStartedAt < 1_000, "idle expiry clears the losing long wall timer");
});

test("the host idle timeout is a ceiling and per-call idleTimeoutMs can only tighten it", async () => {
  const cases = [
    { name: "finite host and omitted call", host: 40, call: "", expected: 40 },
    { name: "finite host and null call", host: 40, call: "idleTimeoutMs: null", expected: 40 },
    { name: "finite host and shorter call", host: 40, call: "idleTimeoutMs: 7", expected: 7 },
    { name: "finite host and longer call", host: 40, call: "idleTimeoutMs: 90", expected: 40 },
    { name: "null host and omitted call", host: null, call: "", expected: null },
    { name: "null host and null call", host: null, call: "idleTimeoutMs: null", expected: null },
    { name: "null host and finite call", host: null, call: "idleTimeoutMs: 7", expected: 7 },
  ] as const;

  for (const fixture of cases) {
    const observed: Array<number | null | undefined> = [];
    const result = await runWorkflow(script(fixture.call), {
      agentIdleTimeoutMs: fixture.host,
      agent: { async run() { return "ok"; } },
      persistLogs: false,
      onAgentStart: (event) => observed.push(event.idleTimeoutMs),
    });
    assert.equal(result.result, "ok", fixture.name);
    assert.deepEqual(observed, [fixture.expected], fixture.name);
  }
});

test("WorkflowManager persists and inspects the resolved idle bound and terminal code", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-idle-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "agent-idle-root-"));
  const silent = silentAbortIgnoringRunner();
  const manager = new WorkflowManager({
    cwd,
    persistenceRoot: root,
    agent: silent.runner,
    defaultAgentIdleTimeoutMs: 35,
  });
  try {
    const started = manager.startInBackground(script(), undefined, {
      agentRetries: 0,
      concurrency: 2,
    });
    const result = await started.promise;
    assert.equal(result.status, "completed");
    assert.equal(result.result, null);
    assert.deepEqual(result.effectiveLimits, {
      maxAgents: 1000,
      concurrency: 2,
      agentRetries: 0,
      agentTimeoutMs: null,
      agentIdleTimeoutMs: 35,
    });

    const status = manager.inspectRun(started.runId, { lastN: 10, logLines: 10 });
    assert.deepEqual(status?.limits, result.effectiveLimits);
    assert.equal(status?.calls[0]?.idleTimeoutMs, 35);
    assert.equal(status?.calls[0]?.errorCode, WorkflowErrorCode.AGENT_IDLE_TIMEOUT);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
