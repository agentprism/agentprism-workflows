// SESSION RECORDS through the engine — the workflow-level half of the run() session hand-off.
//
// The runner surfaces each call's ACP session identity out-of-band (RunOptions.onSessionOpen);
// the engine's job is to make that identity durable and addressable for HOSTS:
//   - one AgentSessionRecord per live agent() call on result.agentSessions (callIndex/label/
//     phase context + keptOpen), even with journaling disabled — it rides the result;
//   - keepSession flows from agent() options to the runner opts bag (additive, not hashed);
//   - journal entries carry the record, and resume REPLAYS it verbatim (the session lives in
//     the agent's store, so the ref stays valid across process restarts exactly like results);
//   - a failed call still surfaces its record (loading the session is a debugging path);
//   - a retry's record is the SUCCEEDING attempt's session, never a failed attempt's.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode, type AgentSessionRef } from "@automatalabs/shared-types";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

interface SeenCall {
  prompt: string;
  keepSession?: boolean;
}

/** Fake runner: fires onSessionOpen with a unique ref per call, echoes the prompt. */
function sessionRunner() {
  const seen: SeenCall[] = [];
  let n = 0;
  const refs: AgentSessionRef[] = [];
  return {
    seen,
    refs,
    async run(prompt: string, opts: Record<string, any> = {}): Promise<string> {
      n += 1;
      seen.push({ prompt, keepSession: opts.keepSession });
      const ref: AgentSessionRef = {
        sessionId: `sess-${n}`,
        backendId: "claude",
        cwd: "/work",
        reopen: { load: true, resume: true, list: true },
      };
      refs.push(ref);
      opts.onSessionOpen?.(ref);
      return `ran:${prompt}`;
    },
  };
}

const twoCalls = `export const meta = { name: 's', description: 'sessions', phases: [{ title: 'Plan' }] }
const a = await agent('first', { label: 'planner', keepSession: true })
const b = await agent('second', { label: 'helper' })
return [a, b]`;

describe("agent session records (result.agentSessions)", () => {
  it("lands one record per live agent() call, with call context and keptOpen", async () => {
    const runner = sessionRunner();
    const run = await runWorkflow(twoCalls, { agent: runner, persistLogs: false });

    assert.equal(run.agentSessions?.length, 2);
    const [first, second] = run.agentSessions!;
    assert.deepEqual(first, {
      sessionId: "sess-1",
      backendId: "claude",
      cwd: "/work",
      reopen: { load: true, resume: true, list: true },
      callIndex: 0,
      label: "planner",
      phase: "Plan",
      keptOpen: true,
    });
    assert.equal(second.sessionId, "sess-2");
    assert.equal(second.callIndex, 1);
    assert.equal(second.label, "helper");
    assert.equal(second.keptOpen, false);
    // keepSession reached the runner opts bag on exactly the call that set it.
    assert.deepEqual(
      runner.seen.map((c) => c.keepSession),
      [true, undefined],
    );
  });

  it("rides the result even with journaling disabled (hosts that own persistence)", async () => {
    const runner = sessionRunner();
    let journaled = 0;
    const run = await runWorkflow(twoCalls, {
      agent: runner,
      persistLogs: false,
      journaling: false,
      onAgentJournal: () => {
        journaled += 1;
      },
    });
    assert.equal(journaled, 0, "journaling off: no journal writes");
    assert.equal(run.agentSessions?.length, 2, "records still surface on the result");
  });

  it("journals the record and resume replays it verbatim without re-running the agent", async () => {
    const journal: JournalEntry[] = [];
    const first = await runWorkflow(twoCalls, {
      agent: sessionRunner(),
      persistLogs: false,
      onAgentJournal: (e) => journal.push(e),
    });
    assert.equal(journal.length, 2);
    assert.equal(journal[0]!.session?.sessionId, "sess-1");
    assert.equal(journal[0]!.session?.keptOpen, true);

    const untouched = {
      async run(): Promise<string> {
        throw new Error("resume must not re-run replayed calls");
      },
    };
    const sessions: Array<string | undefined> = [];
    const resumed = await runWorkflow(twoCalls, {
      agent: untouched,
      persistLogs: false,
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
      onAgentEnd: (event) => sessions.push(event.session?.sessionId),
    });
    // vm-realm arrays have realm-local prototypes; compare by JSON like the journal does.
    assert.equal(JSON.stringify(resumed.result), JSON.stringify(first.result));
    assert.deepEqual(
      resumed.agentSessions,
      first.agentSessions,
      "replayed records match the original run's exactly",
    );
    assert.deepEqual(sessions, ["sess-1", "sess-2"], "agentEnd events carry the replayed records");
  });

  it("a failed call still surfaces its session record (debugging path)", async () => {
    const failing = {
      async run(_prompt: string, opts: Record<string, any> = {}): Promise<string> {
        opts.onSessionOpen?.({
          sessionId: "sess-failed",
          backendId: "claude",
          cwd: "/work",
          reopen: { load: true, resume: true, list: true },
        });
        throw new WorkflowError("agent exploded mid-run", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
          recoverable: true,
        });
      },
    };
    const script = `export const meta = { name: 'f', description: 'fail' }
const a = await agent('doomed', { label: 'doomed' })
return a`;
    const run = await runWorkflow(script, { agent: failing, persistLogs: false });
    assert.equal(run.result, null);
    assert.equal(run.agentSessions?.length, 1);
    assert.equal(run.agentSessions![0]!.sessionId, "sess-failed");
    assert.equal(run.agentSessions![0]!.label, "doomed");
  });

  it("a retried call records the SUCCEEDING attempt's session, never the failed attempt's", async () => {
    let attempt = 0;
    const flaky = {
      async run(_prompt: string, opts: Record<string, any> = {}): Promise<string> {
        attempt += 1;
        opts.onSessionOpen?.({
          sessionId: `attempt-${attempt}`,
          backendId: "claude",
          cwd: "/work",
          reopen: { load: true, resume: true, list: true },
        });
        if (attempt === 1) {
          throw new WorkflowError("transient", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
        }
        return "ok";
      },
    };
    const script = `export const meta = { name: 'r', description: 'retry' }
const a = await agent('flaky', { label: 'flaky', retries: 1 })
return a`;
    const run = await runWorkflow(script, { agent: flaky, persistLogs: false });
    assert.equal(run.result, "ok");
    assert.equal(run.agentSessions?.length, 1, "one record for the call, not one per attempt");
    assert.equal(run.agentSessions![0]!.sessionId, "attempt-2");
  });
});
