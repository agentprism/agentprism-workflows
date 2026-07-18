// ACP connection POOLING — end-to-end against the MOCK ACP agent (test/fixtures/fake-acp-agent.mjs).
//
// The runner pools long-lived ACP server PROCESSES and reuses their held connections across
// agent() calls, opening a fresh SESSION per call. These tests prove that contract over real ACP
// stdio (only the agent on the far end is faked):
//   - N sequential calls REUSE one process: ONE spawn + ONE initialize, N session/new + N
//     session/close, and the process is NOT killed between calls.
//   - one pinned process serves MANY concurrent sessions (multiplexed routing, no cross-talk).
//   - a crashed pooled process is evicted and the next call runs on a fresh process (the engine's
//     retry of a RECOVERABLE failure).
//   - dispose() closes every pooled process.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import {
  AcpAgentPool,
  AcpAgentRunner,
  PI_DISPOSE_SIGKILL_GRACE_MS,
  PI_PROCESS_EXIT_MARGIN_MS,
  PI_PROCESS_SHUTDOWN_ENVELOPE_MS,
  PiBackend,
  PooledConnection,
} from "../src/index.js";
import { createFakeAgentHarness, waitFor } from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  pid?: number;
  reason?: string;
  params?: { sessionId?: string };
}

const harness = createFakeAgentHarness({ prefix: "acp-pool-", backends: ["claude"], crashSentinel: true });

/** Point the default (claude) backend's spawn override at the fake and script its behavior. */
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

const count = (entries: LogEntry[], method: string): number =>
  entries.filter((e) => e.method === method).length;

// Track every runner so a failed assertion never leaks a pooled process.
function makeRunner(size?: number): AcpAgentRunner {
  return harness.makeRunner(size === undefined ? {} : { size });
}

afterEach(async () => {
  await harness.cleanup();
});

// ---- N calls REUSE one pooled process -----------------------------------------------

test("N sequential calls REUSE one pooled process: ONE spawn+initialize, N session/new+close", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner(); // default pool size 1

  const N = 4;
  for (let i = 0; i < N; i++) {
    const out = await runner.run("hi", { cwd });
    assert.equal(out, "ok");
  }

  const log = readLog();
  // ONE long-lived process, initialized exactly once, reused across all N calls.
  assert.equal(count(log, "__start"), 1, "process spawned exactly once");
  assert.equal(count(log, "initialize"), 1, "initialize sent exactly once (reused connection)");
  // The SESSION lifecycle is per-call: a fresh session opened and closed for each run.
  assert.equal(count(log, "newSession"), N, "one session/new per agent() call");
  assert.equal(count(log, "closeSession"), N, "one session/close per agent() call");
  assert.equal(count(log, "prompt"), N, "one prompt per agent() call");
  // Each session got a UNIQUE id from the reused process — genuine session churn, not a restart.
  const closedIds = log.filter((e) => e.method === "closeSession").map((e) => e.params?.sessionId);
  assert.equal(new Set(closedIds).size, N, "each closed session id is distinct");
  // The process was NOT killed between calls — no exit observed until we dispose.
  assert.equal(count(log, "__exit"), 0, "pooled process stayed alive across all calls");

  await runner.dispose();
  const afterDispose = readLog();
  assert.equal(count(afterDispose, "__start"), 1, "still only one process ever spawned");
  assert.equal(count(afterDispose, "__exit"), 1, "dispose() closed the pooled process");
});

// ---- one pinned process serves MANY concurrent sessions -----------------------------

test("one pinned process serves MANY concurrent sessions with no cross-session bleed", async () => {
  const { cwd, readLog } = configure({ turns: [{ echoPrompt: true }] });
  const runner = makeRunner(1); // pool size 1: all sessions multiplex onto ONE process

  const prompts = ["alpha", "bravo", "charlie", "delta", "echo"];
  const outputs = await Promise.all(prompts.map((p) => runner.run(p, { cwd })));

  // Each concurrent session got back ITS OWN prompt — proving notifications routed by sessionId.
  assert.deepEqual(outputs, prompts);

  const log = readLog();
  assert.equal(count(log, "__start"), 1, "a single pinned process served every concurrent session");
  assert.equal(count(log, "initialize"), 1, "initialized once for all concurrent sessions");
  assert.equal(count(log, "newSession"), prompts.length, "one session/new per concurrent call");
  assert.equal(count(log, "prompt"), prompts.length, "one prompt per concurrent call");
  assert.equal(count(log, "closeSession"), prompts.length, "each concurrent session was closed");
});

// ---- crash -> evict -> restart on the next (retry) call ------------------------------

test("a crashed pooled process is evicted; a RECOVERABLE error surfaces and the retry runs fresh", async () => {
  // turn 0 crashes the process EXACTLY ONCE (sentinel); a restarted process serves it normally.
  const { cwd, readLog } = configure({ turns: [{ crash: true, text: "recovered" }] });
  const runner = makeRunner(); // pool size 1

  // First call: the pooled process dies mid-prompt -> RECOVERABLE AGENT_EXECUTION_ERROR
  // (so the engine retries, rather than a non-recoverable wall that would halt the run).
  await assert.rejects(
    () => runner.run("hi", { cwd, label: "crasher" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(err.recoverable, true);
      return true;
    },
  );

  // The engine's retry: the dead connection was evicted, so this runs on a FRESH process.
  const out = await runner.run("hi", { cwd });
  assert.equal(out, "recovered");

  const log = readLog();
  assert.equal(count(log, "__start"), 2, "the crashed process was replaced by a fresh one");
  assert.equal(count(log, "initialize"), 2, "the restarted process initialized independently");
});

// ---- per-session cancellation keeps the pooled process alive ------------------------

test("opts.signal cancels the session via session/cancel WITHOUT killing the pooled process", async () => {
  // Turn 0 parks until cancelled; turn 1 (the reuse run on the SAME process) answers normally.
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }, { text: "ok" }] });
  const runner = makeRunner(); // pool size 1

  const controller = new AbortController();
  const running = runner.run("do something long", { cwd, signal: controller.signal });
  // Wait until the prompt is actually in-flight at the agent (the turn is parked), THEN cancel —
  // so the abort exercises session/cancel rather than racing the process spawn.
  await waitFor(() => readLog().some((e) => e.method === "prompt"));
  controller.abort();

  // The aborted run rejects (the engine owns abort: the runner re-throws it raw).
  await assert.rejects(() => running);

  const log = readLog();
  // The cancel reached the agent as ACP session/cancel for the opened session.
  const cancel = log.find((e) => e.method === "cancel");
  assert.ok(cancel, "session/cancel was sent to the agent");
  assert.equal(typeof cancel.params?.sessionId, "string");
  // The PROCESS was NOT killed by the cancellation — it is still pooled.
  assert.equal(count(log, "__start"), 1, "one process spawned");
  assert.equal(count(log, "__exit"), 0, "the pooled process survived the cancellation");

  // Proof it is reusable: a fresh call lands on the SAME pooled process (no new spawn).
  const out = await runner.run("hi", { cwd });
  assert.equal(out, "ok");
  const after = readLog();
  assert.equal(count(after, "__start"), 1, "the follow-up run REUSED the surviving process");
  assert.equal(count(after, "initialize"), 1, "no re-initialize — same connection");
});

// ---- dispose() closes EVERY pooled process ------------------------------------------

test("dispose() closes every pooled process (multi-process pool)", async () => {
  const { cwd, readLog } = configure({ turns: [{ echoPrompt: true }] });
  const runner = makeRunner(2); // pool size 2: concurrent load spreads across 2 processes

  // Enough concurrency to force the pool to grow to its 2-process ceiling.
  const outputs = await Promise.all(
    ["one", "two", "three", "four"].map((p) => runner.run(p, { cwd })),
  );
  assert.deepEqual(outputs, ["one", "two", "three", "four"]);

  const beforeDispose = readLog();
  const spawned = count(beforeDispose, "__start");
  assert.equal(spawned, 2, "the pool grew to exactly its 2-process ceiling");
  assert.equal(count(beforeDispose, "__exit"), 0, "no process closed while pooled");

  await runner.dispose();

  const afterDispose = readLog();
  assert.equal(count(afterDispose, "__exit"), spawned, "dispose() closed every pooled process");
});

test("Pi child cleanup quarantine prevents reuse and disposes only after the last active close", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    turns: [
      {
        text: "first",
        close: {
          throw: "child process cleanup failed",
          throwData: { errorKind: "child_cleanup_error", details: { remainingChildren: 1 } },
        },
      },
      { text: "second" },
    ],
  }, { backends: ["pi"] });
  const pool = harness.track(new AcpAgentPool({ size: 1 }));
  const backend = new PiBackend();
  const options = { cwd, schema: undefined, policy: {} };
  const first = await pool.acquire(backend, options);
  const second = await pool.acquire(backend, options);
  await first.prompt("first");
  await second.prompt("second");
  const originalPid = readLog().find((entry) => entry.method === "newSession")?.pid;

  await assert.rejects(
    first.release(),
    (error: { code?: unknown; data?: { errorKind?: unknown } }) =>
      error.code === -32603 && error.data?.errorKind === "child_cleanup_error",
  );
  assert.equal(count(readLog(), "__exit"), 0, "quarantined process remains until its active session closes");

  const replacement = await pool.acquire(backend, options);
  await replacement.prompt("replacement");
  const replacementEntry = readLog().filter((entry) => entry.method === "newSession").at(-1);
  assert.notEqual(replacementEntry?.pid, originalPid, "new work never reuses the quarantined process");

  await second.release();
  await waitFor(() => readLog().some((entry) => entry.method === "__exit" && entry.pid === originalPid));
  const oldWire = readLog().filter((entry) => entry.pid === originalPid).map((entry) => entry.method);
  assert.ok(oldWire.lastIndexOf("closeSession") < oldWire.indexOf("__exit"));

  await replacement.release({ keepOpen: true });
  await pool.dispose();
});

test("Pi process disposal memoizes one promise and schedules SIGKILL at exactly 67,000 ms", async () => {
  assert.equal(PI_PROCESS_SHUTDOWN_ENVELOPE_MS, 66_000);
  assert.equal(PI_PROCESS_EXIT_MARGIN_MS, 1_000);
  assert.equal(PI_DISPOSE_SIGKILL_GRACE_MS, 67_000);
  harness.configure({ ignoreShutdown: true }, { backends: ["pi"] });
  let scheduled: { callback: () => void; ms: number; unrefCalls: number } | undefined;
  let clears = 0;
  const connection = harness.track(PooledConnection.create(new PiBackend(), {
    onDead: () => undefined,
    disposeTimer: {
      set(callback, ms) {
        scheduled = { callback, ms, unrefCalls: 0 };
        return { unref: () => { if (scheduled) scheduled.unrefCalls += 1; } };
      },
      clear() { clears += 1; },
    },
  }));
  await connection.authMethods();
  const first = connection.dispose();
  const joined = connection.dispose();
  assert.equal(joined, first);
  await waitFor(() => scheduled !== undefined);
  assert.equal(scheduled?.ms, 67_000);
  assert.equal(scheduled?.unrefCalls, 1);
  let settled = false;
  void first.finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, "SIGKILL is not sent before the scheduled boundary");
  scheduled?.callback();
  await first;
  assert.equal(clears, 1);
});
