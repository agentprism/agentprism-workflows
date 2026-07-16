import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/hooks/workflow-source-gate.mjs — the PreToolUse hook that blocks any workflow `run`
// whose args.sourceRequest is not the user's VERBATIM words. Authenticity is checked against
// role-tagged transcript records, so the tests build fixture transcripts covering every
// provenance trap: agent-authored text, tool results, meta records, the compaction summary
// (which QUOTES user sentences but is agent-authored), and sidechain (subagent) prompts.

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/workflow-source-gate.mjs");

const USER_REQUEST =
  "I want the fork gate to clone the repository to a temp directory and verify both remotes before diffing";
const QUEUED_REQUEST = "Also please add a stop capability probe to the workflow server while the turn is still running";
const OLD_SESSION_REQUEST = "Please archive all of the workflow scripts we used to plan and ship the repository work";
const MULTILINE_REQUEST_RAW = "Ship the entire train end to end\nand publish every package when it is done";
const SUMMARY_DECOY = "The user asked us to redesign the entire persistence layer from scratch this quarter";
const ASSISTANT_DECOY = "I will now proceed to rewrite the runner architecture around a registry table";
const SIDECHAIN_DECOY = "Explore the repository and report every hardcoded backend identifier you can find";

function rec(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}
function userTurn(text: string, extra: Record<string, unknown> = {}): string {
  return rec({ type: "user", timestamp: "2026-07-16T12:00:00Z", message: { role: "user", content: text }, ...extra });
}

function makeFixture(): { dir: string; current: string; older: string } {
  const dir = mkdtempSync(join(tmpdir(), "source-gate-"));
  const current = join(dir, "current-session.jsonl");
  const older = join(dir, "older-session.jsonl");
  writeFileSync(
    current,
    [
      userTurn(USER_REQUEST),
      userTurn(MULTILINE_REQUEST_RAW),
      userTurn(`Reference material below.\n<system-reminder>${SUMMARY_DECOY} injected as reminder</system-reminder>\nThanks.`),
      userTurn(`This session is being continued from a previous conversation. ${SUMMARY_DECOY}. Summary ends.`, {
        isCompactSummary: true,
      }),
      userTurn("caveat text preamble", { isMeta: true }),
      userTurn(SIDECHAIN_DECOY, { isSidechain: true }),
      rec({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: ASSISTANT_DECOY }] },
      }),
      rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: ASSISTANT_DECOY }] } }),
      "not json at all",
      userTurn("short reply ok"),
      // A mid-turn message: persists ONLY as a queue-operation until the turn boundary commits it.
      rec({ type: "queue-operation", operation: "enqueue", content: QUEUED_REQUEST }),
      rec({ type: "queue-operation", operation: "remove", content: "queued text that was recalled by the user" }),
    ].join("\n"),
  );
  writeFileSync(older, [userTurn(OLD_SESSION_REQUEST)].join("\n"));
  // Keep the sibling search deterministic: the older file is older.
  utimesSync(older, new Date("2026-07-10T00:00:00Z"), new Date("2026-07-10T00:00:00Z"));
  return { dir, current, older };
}

function runGate(transcriptPath: string, toolInput: unknown): { status: number; out: string } {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "test",
      transcript_path: transcriptPath,
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agentprism-workflows__workflow",
      tool_input: toolInput,
    }),
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
}

test("verbatim user quote passes; whitespace differences are normalized", () => {
  const { dir, current } = makeFixture();
  try {
    const exact = runGate(current, { scriptPath: "/w.js", args: { sourceRequest: USER_REQUEST } });
    assert.equal(exact.status, 0, exact.out);
    // The transcript stores a newline; the quote uses a single space — normalized containment.
    const collapsed = runGate(current, {
      scriptPath: "/w.js",
      args: { sourceRequest: "Ship the entire train end to end and publish every package when it is done" },
    });
    assert.equal(collapsed.status, 0, collapsed.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("string-form args and string[] sourceRequest are accepted", () => {
  const { dir, current } = makeFixture();
  try {
    const res = runGate(current, {
      scriptPath: "/w.js",
      args: JSON.stringify({ sourceRequest: [USER_REQUEST, OLD_SESSION_REQUEST] }),
    });
    assert.equal(res.status, 0, res.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued mid-turn message verifies; a remove-only queue record does not", () => {
  const { dir, current } = makeFixture();
  try {
    const queued = runGate(current, { scriptPath: "/w.js", args: { sourceRequest: QUEUED_REQUEST } });
    assert.equal(queued.status, 0, queued.out);
    const removed = runGate(current, {
      scriptPath: "/w.js",
      args: { sourceRequest: "queued text that was recalled by the user" },
    });
    assert.equal(removed.status, 2, removed.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a quote found only in an older session passes via the cross-session search", () => {
  const { dir, current } = makeFixture();
  try {
    const res = runGate(current, { scriptPath: "/w.js", args: { sourceRequest: OLD_SESSION_REQUEST } });
    assert.equal(res.status, 0, res.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing sourceRequest blocks with guidance and recent genuine user turns", () => {
  const { dir, current } = makeFixture();
  try {
    const res = runGate(current, { scriptPath: "/w.js", args: { other: 1 } });
    assert.equal(res.status, 2, res.out);
    assert.ok(res.out.includes("carries no args.sourceRequest"), res.out);
    assert.ok(res.out.includes("VERBATIM"), res.out);
    // Candidate list quotes genuine turns only — never meta/sidechain/summary/assistant text.
    assert.ok(res.out.includes(USER_REQUEST), res.out);
    assert.ok(!res.out.includes(SIDECHAIN_DECOY), res.out);
    assert.ok(!res.out.includes(ASSISTANT_DECOY), res.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a paraphrase blocks and the feedback names the paraphrase failure mode", () => {
  const { dir, current } = makeFixture();
  try {
    const res = runGate(current, {
      scriptPath: "/w.js",
      args: { sourceRequest: "The user wants the fork gate to use a temporary clone with remote verification" },
    });
    assert.equal(res.status, 2, res.out);
    assert.ok(res.out.includes("NOT found in any genuine user-authored"), res.out);
    assert.ok(res.out.includes("PARAPHRASE"), res.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provenance traps: summary, sidechain, assistant, tool_result, and reminder-injected text all block", () => {
  const { dir, current } = makeFixture();
  try {
    for (const decoy of [SUMMARY_DECOY, SIDECHAIN_DECOY, ASSISTANT_DECOY]) {
      const res = runGate(current, { scriptPath: "/w.js", args: { sourceRequest: decoy } });
      assert.equal(res.status, 2, `decoy passed the gate: ${decoy}\n${res.out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quotes below the minimum normalized length block", () => {
  const { dir, current } = makeFixture();
  try {
    const res = runGate(current, { scriptPath: "/w.js", args: { sourceRequest: "short reply ok" } });
    assert.equal(res.status, 2, res.out);
    assert.ok(res.out.includes("too short"), res.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect/await/stop actions pass through ungated; missing transcript fails closed", () => {
  const { dir, current } = makeFixture();
  try {
    for (const action of ["inspect", "await", "stop"]) {
      const res = runGate(current, { action, runId: "ab-cd" });
      assert.equal(res.status, 0, `${action} was gated:\n${res.out}`);
    }
    const res = runGate(join(dir, "missing.jsonl"), { scriptPath: "/w.js", args: { sourceRequest: USER_REQUEST } });
    assert.equal(res.status, 2, res.out);
    assert.ok(res.out.includes("fails closed"), res.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
