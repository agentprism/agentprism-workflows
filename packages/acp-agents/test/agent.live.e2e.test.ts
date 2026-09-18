// Real `AcpAgent` fork/resume smoke. The fake-agent suite (test/agent/*) pins the wire order of
// every choreography; this leg proves the SDK's BEHAVIOR on the installed agents — a fork sees
// what the parent committed before it, two parallel forks are independent, a later fork sees the
// parent's later turns, and `close({ keep: true })` + `AcpAgent.resume(ref)` reattaches the same
// session with its memory intact — against real Claude, Codex, OpenCode, and pi.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpAgent, costGaugeInheritance, type AcpAgentTurn } from "../src/index.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const SKIP: string | false = LIVE
  ? false
  : "gated live AcpAgent e2e — set AGENTPRISM_LIVE_E2E=1 with agent credentials";
// The Codex leg is opt-in on top of the live gate: Codex plan or API credits are not guaranteed
// on developer machines, so the pre-push hook does not depend on it.
const CODEX_LIVE = LIVE && process.env.AGENTPRISM_LIVE_E2E_CODEX === "1";
const SKIP_CODEX: string | false = CODEX_LIVE
  ? false
  : LIVE
    ? "Codex live leg is opt-in — set AGENTPRISM_LIVE_E2E_CODEX=1 with Codex credits to run"
    : SKIP;

type LiveBackend = "claude" | "codex" | "opencode" | "pi";

// The Claude adapter validates `model` against the SESSION's selectable option list — the CLI's
// model picker for the working directory. Each leg runs in a fresh temp cwd, so the picker is
// whatever the environment says: ANTHROPIC_DEFAULT_OPUS_MODEL (exported by .githooks/pre-push) is
// what makes this model selectable there. Naming it explicitly keeps the gate honest — if it ever
// stops being selectable the leg fails with "Invalid value for config option model" instead of
// quietly forking a different model than the one we intend to gate on. The OpenCode and pi
// defaults mirror packages/mcp-server/test/live-backend.e2e.test.ts.
const BACKEND_MODEL: Record<LiveBackend, string> = {
  claude: process.env.AGENTPRISM_CLAUDE_E2E_MODEL ?? "claude/claude-opus-4-8",
  codex: "codex",
  opencode: process.env.AGENTPRISM_OPENCODE_E2E_MODEL ?? "opencode/openrouter/deepseek/deepseek-v4-flash",
  pi: `pi/${process.env.AGENTPRISM_PI_E2E_MODEL ?? "openrouter/google/gemini-2.5-flash"}`,
};

const CODEWORD_QUESTION = "What is the codeword you were asked to remember? Reply with only the codeword.";

function diag(backend: LiveBackend, turn: AcpAgentTurn): string {
  return `${backend}: ${JSON.stringify({ stopReason: turn.stopReason, text: turn.text.slice(0, 200) })}`;
}

/**
 * Grounds `COST_GAUGE_INHERITANCE` on the installed agent. `sourceGauge` is the source session's
 * cumulative cost gauge when it was forked/closed; `agent` just ran its FIRST turn, a cached
 * one-line reply that costs less than everything the source spent. So a gauge that carried the
 * total over reads ABOVE `sourceGauge` and the turn's cost is only the growth; a gauge that
 * restarted reads BELOW it and IS the turn's cost. An agent that reports no dollar cost (Codex)
 * has no gauge and is skipped.
 */
function assertCostBaselined(
  backend: LiveBackend,
  kind: "reopen" | "fork",
  agent: AcpAgent,
  turn: AcpAgentTurn,
  sourceGauge: number | undefined,
): void {
  const gauge = agent.sessionRef?.costGauge;
  if (gauge === undefined || sourceGauge === undefined) return;
  const expected = costGaugeInheritance(backend)[kind];
  const detail = `${backend} ${kind}: source gauge ${sourceGauge}, gauge after the first turn ${gauge}, turn cost ${turn.usage.turn.cost}`;
  if (expected === "inherits") {
    assert.ok(gauge > sourceGauge, `the gauge must carry the source's total over — ${detail}`);
    assert.ok(Math.abs(turn.usage.turn.cost - (gauge - sourceGauge)) < 1e-9, `the turn's cost must exclude the inherited total — ${detail}`);
  } else {
    assert.ok(gauge < sourceGauge, `the gauge must restart — ${detail}`);
    assert.ok(Math.abs(turn.usage.turn.cost - gauge) < 1e-9, `a restarted gauge's reading is the turn's cost — ${detail}`);
  }
}

async function closeAll(agents: Iterable<AcpAgent>): Promise<void> {
  const results = await Promise.allSettled([...agents].map((agent) => agent.close()));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function forkAndResumeLiveBackend(backend: LiveBackend): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `agentprism-${backend}-agent-live-`));
  const word1 = `ZEPHYR-${randomBytes(3).toString("hex")}`;
  const word2 = `LANTERN-${randomBytes(3).toString("hex")}`;
  const model = BACKEND_MODEL[backend];
  const agents = new Set<AcpAgent>();
  try {
    // 1. Open.
    const primary = await AcpAgent.open({ cwd, model, label: `${backend}-primary` });
    agents.add(primary);
    assert.equal(primary.state, "ready", `${backend}: primary must be ready after open`);
    assert.equal(typeof primary.sessionId, "string", `${backend}: open must yield a session id`);
    const primaryRef = primary.sessionRef;
    assert.ok(primaryRef, `${backend}: open must yield a session ref`);
    assert.equal(primaryRef.backendId, backend);
    assert.equal(primaryRef.reopen.fork, true, `${backend}: every built-in advertises session/fork`);

    // 2. Commit the first codeword.
    const t1 = await primary.prompt(
      `Remember the codeword ${word1}. Reply with exactly ACK and nothing else. Do not call tools.`,
    );
    assert.equal(t1.stopReason, "end_turn", diag(backend, t1));
    assert.equal(typeof t1.response, "object", diag(backend, t1));
    assert.ok(t1.updates.length > 0, `${backend}: the turn must carry session/update records — ${diag(backend, t1)}`);
    assert.ok(t1.usage.session.total >= 0, diag(backend, t1));

    const gaugeAtFork = primary.sessionRef?.costGauge;

    // 3. Two parallel forks: distinct sessions, each seeded with the parent's transcript.
    const [f1, f2] = await Promise.all([primary.fork(), primary.fork()]);
    agents.add(f1);
    agents.add(f2);
    const ids = new Set([primary.sessionId, f1.sessionId, f2.sessionId]);
    assert.equal(ids.size, 3, `${backend}: primary and both forks must be distinct sessions (${[...ids].join(", ")})`);
    assert.ok(f1.history.length >= 1, `${backend}: fork 1 must carry the parent's transcript (history ${f1.history.length})`);
    assert.ok(f2.history.length >= 1, `${backend}: fork 2 must carry the parent's transcript (history ${f2.history.length})`);

    // 4. Both forks answer from the parent's memory, concurrently.
    const [a1, a2] = await Promise.all([f1.prompt(CODEWORD_QUESTION), f2.prompt(CODEWORD_QUESTION)]);
    assert.ok(a1.text.includes(word1), `${backend}: fork 1 must recall ${word1} — ${diag(backend, a1)}`);
    assert.ok(a2.text.includes(word1), `${backend}: fork 2 must recall ${word1} — ${diag(backend, a2)}`);
    assertCostBaselined(backend, "fork", f1, a1, gaugeAtFork);
    assertCostBaselined(backend, "fork", f2, a2, gaugeAtFork);

    // 5. The parent keeps going after its forks.
    const t2 = await primary.prompt(`The second codeword is ${word2}. Reply with exactly ACK.`);
    assert.equal(t2.stopReason, "end_turn", diag(backend, t2));

    // 6. A later fork sees both turns.
    const f3 = await primary.fork();
    agents.add(f3);
    const t3 = await f3.prompt("List both codewords you were asked to remember, comma separated, nothing else.");
    assert.ok(
      t3.text.includes(word1) && t3.text.includes(word2),
      `${backend}: the later fork must recall ${word1} and ${word2} — ${diag(backend, t3)}`,
    );

    // 7. Keep the session on close, then reattach it cold from the ref.
    const ref = primary.sessionRef;
    assert.ok(ref, `${backend}: the ref must survive until close`);
    await primary.close({ keep: true });
    agents.delete(primary);
    const resumed = await AcpAgent.resume(ref, { label: `${backend}-resumed` });
    agents.add(resumed);
    assert.equal(resumed.sessionId, ref.sessionId, `${backend}: resume must reattach the same session id`);
    const t4 = await resumed.prompt("What was the first codeword? Reply with only the codeword.");
    assert.ok(t4.text.includes(word1), `${backend}: the resumed session must recall ${word1} — ${diag(backend, t4)}`);
    assertCostBaselined(backend, "reopen", resumed, t4, ref.costGauge);
  } finally {
    try {
      await closeAll(agents);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

test("live AcpAgent e2e: Claude fork/resume", { skip: SKIP, timeout: 240_000 }, () =>
  forkAndResumeLiveBackend("claude"));

test("live AcpAgent e2e: Codex fork/resume", { skip: SKIP_CODEX, timeout: 240_000 }, () =>
  forkAndResumeLiveBackend("codex"));

test("live AcpAgent e2e: OpenCode fork/resume", { skip: SKIP, timeout: 240_000 }, () =>
  forkAndResumeLiveBackend("opencode"));

test("live AcpAgent e2e: pi fork/resume", { skip: SKIP, timeout: 240_000 }, () =>
  forkAndResumeLiveBackend("pi"));
