// Real-backend pause-recovery continuation e2e. This is deliberately environment-gated because a
// provider usage wall and its later recovery cannot be manufactured without turning the test
// into another mock ACP suite. Prepare a genuinely paused run in the same persistence root/cwd,
// restore provider access, then run with the source ID below. The test uses the same-ID recovery API
// and fails loudly unless the source contains a completed root prefix followed by a usage-paused,
// reopenable agent occurrence.
import assert from "node:assert/strict";
import test from "node:test";
import { createAcpRunner, WorkflowManager } from "../src/index.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const cwd = process.env.AGENTPRISM_CONTINUATION_E2E_CWD;
const persistenceRoot = process.env.AGENTPRISM_CONTINUATION_E2E_PERSISTENCE_ROOT;

function gate(runId: string | undefined, label: string): string | false {
  if (!LIVE) return "gated live continuation e2e — set AGENTPRISM_LIVE_E2E=1 with a paused source";
  if (!runId) return `set ${label} to a real usage/auth-paused run ID`;
  return false;
}

async function resumePausedRun(runId: string, expectedMethod: "resume" | "load"): Promise<void> {
  assert.ok(cwd, "set AGENTPRISM_CONTINUATION_E2E_CWD to the paused run's original cwd");
  const runner = createAcpRunner();
  const manager = new WorkflowManager({
    cwd,
    persistenceRoot,
    agent: runner,
  });
  try {
    const source = manager.listAllRuns().find((run) => run.runId === runId);
    assert.ok(source, `paused source ${runId} was not found`);
    assert.equal(source.status, "paused");
    assert.equal(source.pauseReason, "usage_limit", "same-ID cold live fixture must be usage-paused");
    const interrupted = source.agents?.find((entry) =>
      entry.status === "error" &&
      entry.errorCode === "PROVIDER_USAGE_LIMIT" &&
      entry.session !== undefined &&
      (entry.session.reopen.resume || entry.session.reopen.load));
    const recorded = interrupted?.session;
    assert.ok(recorded, "the real interrupted turn must have a reopenable recorded session");
    const completedPrefix = source.calls?.filter((call) =>
      call.index < recorded.callIndex && call.kind === "agent" && call.outcome === "result");
    assert.ok(
      completedPrefix && completedPrefix.length > 0,
      "the live fixture must contain completed root prefix work before the interrupted turn",
    );

    const resumed = await manager.resumeInBackground(runId);
    assert.equal(resumed.accepted, true);
    const result = await resumed.promise;
    assert.equal(result.status, "completed");
    const notice = result.fallbacks?.find((entry) => entry.kind === "continuation");
    assert.deepEqual(notice?.continuation, { outcome: "reattached", method: expectedMethod });
    assert.ok(result.result !== null && result.result !== undefined, "continuation must finish the original task");
    assert.ok((result.tokenUsage?.total ?? 0) > 0, "the continuation turn carries a positive current-run debit");
    const resumedSession = result.agentSessions?.find((entry) => entry.callIndex === recorded.callIndex);
    assert.equal(resumedSession?.sessionId, recorded.sessionId, "the resumed turn reused the recorded history");
    const continuedCall = result.calls?.find((call) => call.index === recorded.callIndex);
    assert.deepEqual(
      continuedCall?.provenance,
      { source: "live", continuation: { reattached: true, method: expectedMethod } },
      "the real runner reports the successful reopen",
    );
    for (const prefix of completedPrefix) {
      const replayed = result.calls?.find((call) => call.index === prefix.index);
      assert.equal(replayed?.hash, prefix.hash);
      assert.equal(replayed?.outcome, "result");
      assert.equal(replayed?.origin, "journal-replay", "completed prefix work must not run again");
    }
  } finally {
    await runner.dispose();
  }
}

const resumeRunId = process.env.AGENTPRISM_CONTINUATION_E2E_RUN_ID;
test(
  "real resume-capable backend continues a usage-interrupted turn",
  { skip: gate(resumeRunId, "AGENTPRISM_CONTINUATION_E2E_RUN_ID") },
  async () => resumePausedRun(resumeRunId as string, "resume"),
);

const loadRunId = process.env.AGENTPRISM_CONTINUATION_E2E_LOAD_RUN_ID;
test(
  "real load-only backend continues a usage-interrupted turn when available",
  { skip: gate(loadRunId, "AGENTPRISM_CONTINUATION_E2E_LOAD_RUN_ID") },
  async () => resumePausedRun(loadRunId as string, "load"),
);
