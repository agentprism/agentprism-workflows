export const meta = {
  name: "implementation-train",
  description:
    "Ship an implementation against a frozen contract: lens-gated implement rounds with STOP-and-report, a terminal adjudicator, and a panel-free closed-list fix round",
  phases: [{ title: "Implement" }, { title: "Gate" }, { title: "Adjudicate" }, { title: "Fix" }],
};

// The battle pattern behind real multi-hour trains, distilled. What it teaches:
//   1. The user's request and the frozen contract are the ONLY scope authorities — the
//      producer refuses (STOP-and-report) rather than improvise around a discrepancy.
//   2. Script code validates report shape BEFORE any reviewer spends tokens.
//   3. Four falsifiable-question lenses generate EVIDENCE (commands + exit codes), write
//      full detail to design-dir files, and keep structured fields small.
//   4. Feedback handed back to the producer is SELF-CONTAINED (memoryless sessions).
//   5. The gate is bounded; a terminal adjudicator ends it either way; its findings are a
//      CLOSED list resolved by one panel-free fix round judged by the same adjudicator.

// ---- args hardening (hosts may hand args through as a JSON string) ----
const input =
  typeof args === "string" ? JSON.parse(args) : args && typeof args === "object" && !Array.isArray(args) ? args : {};
const CONTRACT = typeof input.contractPath === "string" ? input.contractPath : null; // repo-relative frozen spec
const W = typeof input.workroot === "string" && input.workroot.startsWith("/") ? input.workroot : null;
const D = typeof input.designDir === "string" && input.designDir.startsWith("/") ? input.designDir : null;
const BRANCH = typeof input.branch === "string" ? input.branch : null;
if (!CONTRACT || !W || !D || !BRANCH) {
  throw new Error("args must include contractPath (repo-relative), workroot, designDir (absolute), branch");
}
// input.sourceRequest (the user's verbatim request sentences) rides along for host-side
// verification and for the source-fidelity dimension of review; thread it into prompts
// via the design-dir focus file rather than interpolating it here (prompts are
// replay-identity-hashed; focus files are not).

const IMPL_REPORT = {
  type: "object",
  additionalProperties: false,
  required: ["commitShas", "summary", "verification", "deviations"],
  properties: {
    commitShas: {
      type: "array",
      items: { type: "string", description: "A real git SHA from `git log` on the branch — never a placeholder" },
      description: "Commits created this round, oldest first. Empty ONLY for a STOP-and-report.",
    },
    summary: { type: "string", description: "What was implemented, grounded in the actual diff" },
    verification: {
      type: "string",
      description: "Literal commands + exit codes, command-per-line, max ~40 lines — full transcripts go to design-dir files",
    },
    deviations: {
      type: "string",
      description: "Forced interpretations with justification; a STOP-and-report discrepancy goes here verbatim. Empty when none.",
    },
  },
};

const VERDICT = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "feedback", "evidence"],
  properties: {
    ok: { type: "boolean", description: "true ONLY if this lens found zero blocking problems" },
    feedback: { type: "string", description: "When false: every blocking problem, concrete and self-contained. Empty when true." },
    evidence: { type: "string", description: "Commands + exit codes and files actually read, max ~40 lines — detail goes to your review file" },
  },
};

const ADJUDICATION = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "summary", "findings"],
  properties: {
    approved: { type: "boolean", description: "true only if shippable as-is: contract delivered end-to-end, no bugs, zero deferred work" },
    summary: { type: "string", description: "Verdict in 3-6 sentences, grounded in what you verified yourself" },
    findings: {
      type: "array",
      description: "The CLOSED fix list — everything wrong or missing; empty when approved",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "summary"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          summary: { type: "string", description: "The defect with its file anchor, grounded in code actually read" },
        },
      },
    },
  },
};

const CONTEXT =
  `Worktree: ${W} (branch ${BRANCH}). Design dir (OUTSIDE the worktree; review artifacts live here and are never committed): ${D}.\n` +
  `Scope authorities, in order: (1) the FROZEN contract ${CONTRACT} — build exactly what it says; (2) ${D}/focus.md IN FULL ` +
  `(the user's verbatim request, verification bar, base policy). Frozen means frozen: no design or scope changes at this layer.\n`;

// Lenses are falsifiable questions with disjoint jurisdictions — not four generic reviewers.
const LENSES = [
  {
    key: "contract-compliance",
    charge:
      `Walk the contract section by section: delivered / missing / deviated, with file:line evidence for each. ` +
      `The user's verbatim sentences in ${D}/focus.md are hop zero — flag any narrowing of them that survived into code, ` +
      `even if the contract itself permits it. ok=true only if everything is delivered.`,
  },
  {
    key: "correctness",
    charge:
      `Adversarial bug hunt — assume it is wrong and prove it by RUNNING things: drive the tests yourself, reproduce ` +
      `suspicious paths against the real dependencies, probe the failure modes the contract pins. Reading alone produces ` +
      `opinions; you produce observed behavior. ok=true only if you failed to find a real bug.`,
  },
  {
    key: "deferred-work",
    charge:
      `Hunt deferred work across the diff and every touched doc: TODO/FIXME/stubs/skipped tests/placeholder strings/` +
      `"follow-up"/"until X lands" language, half-updated surfaces, missing changesets. ok=true only if zero deferred work.`,
  },
  {
    key: "green-verify",
    charge:
      `Independently verify greenness from the COMMITTED state, trusting nothing in the report: full build, full test ` +
      `suite, repo gates. Record literal commands + exit codes. Tree clean, nothing from ${D} committed. ok=true only if ` +
      `every command exited 0.`,
  },
];

const lensPrompt = (lens, report, round) =>
  CONTEXT +
  `Implementer's report for round ${round}: ${JSON.stringify(report)}\n` +
  `Review the branch diff (git diff origin/main...HEAD) ONLY through this lens:\n${lens.charge}\n\n` +
  `Hard rules:\n` +
  `- FIRST: base-freshness — git fetch origin and compare origin/main to ${D}/base-sha.txt; an advance touching contract-relevant paths is a blocking finding, never silently absorbed.\n` +
  `- Ground every claim in files read or commands run. Do NOT modify any repository file; write full findings to ${D}/review-${lens.key}-r${round}.md.\n` +
  `- Keep structured fields small (evidence/feedback ≤ ~40 lines); your review file carries the detail.\n` +
  `Return the structured verdict.`;

phase("Implement");
let round = 0;
let stopReport = null;

const outcome = await gate(
  (feedback, attempt) =>
    agent(
      CONTEXT +
        `You are the sole implementer, attempt ${attempt + 1}. Deliver the ENTIRE contract end-to-end — zero deferred ` +
        `work, no follow-up language anywhere. Verify cited surfaces against the real code, never from memory. ` +
        `If a cited surface does not exist as cited, STOP: return commitShas [] with the discrepancy verbatim in ` +
        `deviations — the overwhelmingly likely cause is a stale base, not a wrong contract; never improvise around it. ` +
        `Run the full verification bar from ${D}/focus.md before reporting; commit on ${BRANCH}; never push.\n` +
        (feedback
          ? `\nA review board rejected attempt ${attempt}. Their combined feedback (self-contained — do not assume any file exists unless named here):\n${feedback}\nAddress every point, re-verify, and commit before reporting.\n`
          : ""),
      { label: `implement:r${attempt + 1}`, phase: "Implement", model: "codex/gpt-5.6-sol", configOptions: { reasoning_effort: "xhigh" }, cwd: W, retries: 1, timeoutMs: null, schema: IMPL_REPORT },
    ),
  async (report) => {
    round += 1;
    phase("Gate");
    // Script-side checks run BEFORE any reviewer spends tokens.
    if (!report) return { ok: false, feedback: "No structured result was produced (no review ran; no review files exist). Redo the round from the contract and report real commit SHAs." };
    if (report.commitShas.length === 0 && report.deviations.trim().length > 0) {
      stopReport = report; // a correct refusal — halt the train, don't burn rounds
      return { ok: true };
    }
    if (!report.commitShas.length || !report.commitShas.every((sha) => /^[0-9a-f]{7,40}$/.test(sha))) {
      return { ok: false, feedback: `Report invalid before any review ran (no review files exist): commitShas must be real SHAs from git log on ${BRANCH} (got ${JSON.stringify(report.commitShas)}). Commit and report accurately.` };
    }
    const verdicts = await parallel(LENSES.map((lens) => () =>
      agent(lensPrompt(lens, report, round), { label: `review:${lens.key}:r${round}`, phase: "Gate", model: "claude/opus[1m]", cwd: W, retries: 1, timeoutMs: null, schema: VERDICT }),
    ));
    const paired = LENSES.map((lens, i) => ({ lens: lens.key, verdict: verdicts[i] }));
    const rejections = paired.filter((v) => v.verdict && !v.verdict.ok);
    const missing = paired.filter((v) => !v.verdict);
    log(`gate round ${round}: ${rejections.length} rejection(s), ${missing.length} missing verdict(s)`);
    if (!rejections.length && !missing.length) return { ok: true };
    // Feedback is assembled to be SELF-CONTAINED: only files that provably exist are named.
    const parts = [`A review board reviewed round ${round}; full reports exist at ${D}/review-<lens>-r${round}.md for lenses that returned verdicts.`];
    for (const r of rejections) parts.push(`[${r.lens}]\n${r.verdict.feedback}`);
    for (const m of missing) parts.push(`[${m.lens}] returned no verdict (its file may not exist) — treat the lens as rejected and re-verify that entire dimension yourself.`);
    return { ok: false, feedback: parts.join("\n\n") };
  },
  { attempts: 3 },
);

if (stopReport) {
  log("halted on STOP-and-report — owner resolution required; no adjudication");
  return { branch: BRANCH, stopped: true, stopReport };
}
if (!outcome.ok) log(`gate did not converge after ${outcome.attempts} round(s) — terminal adjudication decides`);

phase("Adjudicate");
const adjudication = await agent(
  CONTEXT +
    `You are the TERMINAL adjudicator — nothing loops back to the gate. Final report: ${JSON.stringify(outcome.value)}; ` +
    `gate converged=${outcome.ok} after ${outcome.attempts} round(s); read every ${D}/review-*.md. ` +
    `Independently verify: re-run greenness yourself, walk the contract against the code, spot-check surprising lens ` +
    `verdicts in BOTH directions (lens verdicts are inputs, not votes). Write your full report to ${D}/final-adjudication.md. ` +
    `Your findings are a CLOSED list — the fix round applies exactly this list and nothing else.`,
  { label: "adjudicate", phase: "Adjudicate", model: "claude/opus[1m]", cwd: W, retries: 1, timeoutMs: null, schema: ADJUDICATION },
);
if (!adjudication) throw new Error("terminal adjudication produced no result — inspect the run before delivery");

if (adjudication.approved) return { branch: BRANCH, approved: true, adjudication };

// ---- Panel-free fix round: closed list in, same adjudicator judges. Re-opening the
// four-lens panel here would generate NOVEL findings forever; the question is no longer
// open, so the reviewer is the author of the list. ----
phase("Fix");
const fixOutcome = await gate(
  (feedback, attempt) =>
    agent(
      CONTEXT +
        `Apply the terminal adjudication's CLOSED fix list exactly — nothing more, nothing less (full report: ` +
        `${D}/final-adjudication.md; findings: ${JSON.stringify(adjudication.findings)}). Re-verify everything the fixes ` +
        `touch, run the full verification bar, and commit on ${BRANCH}.` +
        (feedback ? `\nThe adjudicator rejected your previous fix attempt:\n${feedback}\nAddress every residual.` : ""),
      { label: `fix:r${attempt + 1}`, phase: "Fix", model: "codex/gpt-5.6-sol", configOptions: { reasoning_effort: "xhigh" }, cwd: W, retries: 1, timeoutMs: null, schema: IMPL_REPORT },
    ),
  async (fixReport) => {
    if (!fixReport || !fixReport.commitShas.length) return { ok: false, feedback: "No fix commits reported — apply the closed list and report real SHAs." };
    const verdict = await agent(
      CONTEXT +
        `You are the SAME terminal adjudicator. Re-verify EVERY finding from your ${D}/final-adjudication.md against the ` +
        `committed branch (fix report: ${JSON.stringify(fixReport)}), hunt regressions the fixes introduced, and write ` +
        `${D}/final-adjudication-fix.md. approved=true means shippable as-is.`,
      { label: "adjudicate:fix", phase: "Fix", model: "claude/opus[1m]", cwd: W, retries: 1, timeoutMs: null, schema: ADJUDICATION },
    );
    if (!verdict) return { ok: false, feedback: "Adjudicator returned no verdict — re-verify your own fixes against the closed list and recommit." };
    return verdict.approved ? { ok: true, verdict } : { ok: false, feedback: verdict.findings.map((f) => `[${f.severity}] ${f.summary}`).join("\n"), verdict };
  },
  { attempts: 2 },
);

return {
  branch: BRANCH,
  approved: fixOutcome.ok,
  fixAttempts: fixOutcome.attempts,
  adjudication,
  fixVerdict: fixOutcome.verdict?.verdict ?? null,
};
