export const meta = {
  name: "implementation-train",
  description:
    "Ship an implementation against a frozen contract: lens-gated implement rounds with STOP-and-report, a terminal adjudicator, and a panel-free closed-list fix round",
  phases: [{ title: "Implement" }, { title: "Gate" }, { title: "Adjudicate" }, { title: "Fix" }],
};

// The battle pattern behind real multi-hour trains, distilled. What it teaches:
//   1. The user's request and the frozen contract are the ONLY scope authorities — the
//      producer refuses (STOP-and-report, an explicit status enum) rather than improvise
//      around a discrepancy.
//   2. Script code validates report shape BEFORE any reviewer spends tokens.
//   3. Four falsifiable-question lenses generate EVIDENCE (commands + exit codes), write
//      full detail to design-dir files, and keep structured fields small.
//   4. Feedback handed back to the producer is SELF-CONTAINED (memoryless sessions).
//   5. The gate is bounded; a terminal adjudicator ends it either way; its findings are a
//      CLOSED list resolved by one panel-free fix round judged by the same adjudicator.
//   6. A checkpoint gates the first repository mutation (default: true keeps detached runs moving).
//   7. Values, not attestations: producers report headSha, reviewers report the
//      reviewedHeadSha they actually inspected, and SCRIPT CODE compares them.
//   8. Read-only lenses fan out; run-things lenses are serialized (two builds in one
//      checkout collide), and base-freshness uses git ls-remote — never fetch — in the
//      shared worktree.
//   9. This trusted implementation/review train uses the backends' real autonomous modes:
//      Codex "agent" and Claude "bypassPermissions" (Claude "auto" may still ask).

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

const SHA = /^[0-9a-f]{40}$/;

const IMPL_REPORT = {
  type: "object",
  additionalProperties: false,
  required: ["status", "commitShas", "headSha", "summary", "verification", "deviations"],
  properties: {
    status: {
      type: "string",
      enum: ["implemented", "stopped"],
      description:
        "'implemented' iff the round is committed and verified; 'stopped' ONLY for a STOP-and-report refusal (a cited surface missing as cited, base drift) — never improvise around one",
    },
    commitShas: {
      type: "array",
      items: { type: "string", description: "A real full 40-character git SHA from `git log` on the branch — never a placeholder" },
      description: "Commits created this round, oldest first. Empty ONLY when status is 'stopped'.",
    },
    headSha: {
      type: "string",
      description:
        "Full 40-character SHA of the branch tip AFTER the final commit — must equal `git rev-parse HEAD` and the last entry of commitShas. Empty ONLY when status is 'stopped'.",
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
  required: ["ok", "reviewedHeadSha", "feedback", "evidence"],
  properties: {
    ok: { type: "boolean", description: "true ONLY if this lens found zero blocking problems" },
    reviewedHeadSha: {
      type: "string",
      description:
        "Full 40-character `git rev-parse HEAD` of the tree you ACTUALLY reviewed — a value script code compares to the report, not an attestation",
    },
    feedback: { type: "string", description: "When false: every blocking problem, concrete and self-contained. Empty when true." },
    evidence: { type: "string", description: "Commands + exit codes and files actually read, max ~40 lines — detail goes to your review file" },
  },
};

const ADJUDICATION = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "reviewedHeadSha", "summary", "findings"],
  properties: {
    approved: { type: "boolean", description: "true only if shippable as-is: contract delivered end-to-end, no bugs, zero deferred work" },
    reviewedHeadSha: {
      type: "string",
      description: "Full 40-character `git rev-parse HEAD` you independently adjudicated — script code compares it to the report",
    },
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
// runs:true marks the lenses that build/test; they execute serially in the shared worktree.
const LENSES = [
  {
    key: "contract-compliance",
    runs: false,
    charge:
      `Walk the contract section by section: delivered / missing / deviated, with file:line evidence for each. ` +
      `The user's verbatim sentences in ${D}/focus.md are hop zero — flag any narrowing of them that survived into code, ` +
      `even if the contract itself permits it. ok=true only if everything is delivered.`,
  },
  {
    key: "correctness",
    runs: true,
    charge:
      `Adversarial bug hunt — assume it is wrong and prove it by RUNNING things: drive the tests yourself, reproduce ` +
      `suspicious paths against the real dependencies, probe the failure modes the contract pins. Reading alone produces ` +
      `opinions; you produce observed behavior. ok=true only if you failed to find a real bug.`,
  },
  {
    key: "deferred-work",
    runs: false,
    charge:
      `Hunt deferred work across the diff and every touched doc: TODO/FIXME/stubs/skipped tests/placeholder strings/` +
      `"follow-up"/"until X lands" language, half-updated surfaces, missing changesets. ok=true only if zero deferred work.`,
  },
  {
    key: "green-verify",
    runs: true,
    charge:
      `Independently verify greenness from the COMMITTED state, trusting nothing in the report: full build, full test ` +
      `suite, repo gates. Record literal commands + exit codes. Tree clean, nothing from ${D} committed. ok=true only if ` +
      `every command exited 0.`,
  },
];

const lensPrompt = (lens, report, round) =>
  CONTEXT +
  `Implementer's report for round ${round}: ${JSON.stringify(report)}\n` +
  `Review the branch diff ONLY through this lens:\n${lens.charge}\n\n` +
  `Hard rules:\n` +
  `- FIRST: record \`git rev-parse HEAD\` as reviewedHeadSha — the exact tree you review. Then base-freshness: compare ` +
  `\`git ls-remote origin refs/heads/main\` to ${D}/base-sha.txt (ls-remote only — never fetch in this shared worktree); ` +
  `an advance touching contract-relevant paths is a blocking finding, never silently absorbed.\n` +
  `- Ground every claim in files read or commands run. Never edit source files, commit, or mutate git state; build and ` +
  `test outputs the checkout generates are expected for a run-things lens. Write full findings to ` +
  `${D}/review-${lens.key}-r${round}.md.\n` +
  `- Keep structured fields small (evidence/feedback ≤ ~40 lines); your review file carries the detail.\n` +
  `Return the structured verdict.`;

phase("Implement");
// The first repository mutation sits behind a human gate; default:true keeps detached runs moving.
const proceed = await checkpoint(
  `Begin implementing the frozen contract ${CONTRACT} on branch ${BRANCH} in ${W}? Commits will be created there (never pushed).`,
  { kind: "confirm", default: true },
);
if (!proceed) return { branch: BRANCH, started: false };

let round = 0;
let stopReport = null;

const outcome = await gate(
  (feedback, attempt) =>
    agent(
      CONTEXT +
        `You are the sole implementer, attempt ${attempt + 1}. PREFLIGHT before any edit: confirm ${W} is checked out on ` +
        `${BRANCH} with the SHA in ${D}/base-sha.txt an ancestor of HEAD — a mismatch is a STOP, not something to repair. ` +
        `Deliver the ENTIRE contract end-to-end — zero deferred work, no follow-up language anywhere. Verify cited surfaces ` +
        `against the real code, never from memory. If a cited surface does not exist as cited, STOP: return status ` +
        `"stopped" with commitShas [] and the discrepancy verbatim in deviations — the overwhelmingly likely cause is a ` +
        `stale base, not a wrong contract; never improvise around it. Run the full verification bar from ${D}/focus.md ` +
        `before reporting; commit on ${BRANCH}; never push; report headSha equal to the branch tip and make NO commits ` +
        `after reporting.\n` +
        (feedback
          ? `\nA review board rejected attempt ${attempt}. Their combined feedback (self-contained — do not assume any file exists unless named here):\n${feedback}\nAddress every point, re-verify, and commit before reporting.\n`
          : ""),
      { label: `implement:r${attempt + 1}`, phase: "Implement", model: "codex/gpt-5.6-sol", mode: "agent", configOptions: { reasoning_effort: "xhigh" }, cwd: W, retries: 1, schema: IMPL_REPORT },
    ),
  async (report) => {
    round += 1;
    phase("Gate");
    // Script-side checks run BEFORE any reviewer spends tokens.
    if (!report) return { ok: false, feedback: "No structured result was produced (no review ran; no review files exist). Redo the round from the contract and report real commit SHAs." };
    if (report.status === "stopped") {
      stopReport = report; // a correct refusal — halt the train, don't burn rounds
      return { ok: true };
    }
    if (
      !report.commitShas.length ||
      !report.commitShas.every((sha) => SHA.test(sha)) ||
      !SHA.test(report.headSha) ||
      report.commitShas[report.commitShas.length - 1] !== report.headSha
    ) {
      return { ok: false, feedback: `Report invalid before any review ran (no review files exist): commitShas must be full 40-char SHAs from git log on ${BRANCH}, and headSha must equal the last of them (got ${JSON.stringify(report.commitShas)} / ${JSON.stringify(report.headSha)}). Commit and report accurately.` };
    }
    // Read-only lenses fan out; run-things lenses execute one at a time — two builds in
    // one checkout collide on outputs and caches.
    const lensOpts = (lens) => ({ label: `review:${lens.key}:r${round}`, phase: "Gate", model: "claude/opus[1m]", mode: "bypassPermissions", cwd: W, retries: 1, schema: VERDICT });
    const readOnly = LENSES.filter((l) => !l.runs);
    const runsThings = LENSES.filter((l) => l.runs);
    const readVerdicts = await parallel(readOnly.map((lens) => () => agent(lensPrompt(lens, report, round), lensOpts(lens))));
    const runVerdicts = [];
    for (const lens of runsThings) runVerdicts.push(await agent(lensPrompt(lens, report, round), lensOpts(lens)));
    const paired = [
      ...readOnly.map((lens, i) => ({ lens: lens.key, verdict: readVerdicts[i] })),
      ...runsThings.map((lens, i) => ({ lens: lens.key, verdict: runVerdicts[i] })),
    ];
    // Values, not attestations: a verdict for the wrong commit is void, whatever it says.
    const missing = paired.filter((v) => !v.verdict);
    const wrongHead = paired.filter((v) => v.verdict && v.verdict.reviewedHeadSha !== report.headSha);
    const rejections = paired.filter((v) => v.verdict && v.verdict.reviewedHeadSha === report.headSha && !v.verdict.ok);
    log(`gate round ${round}: ${rejections.length} rejection(s), ${wrongHead.length} wrong-commit review(s), ${missing.length} missing verdict(s)`);
    if (!rejections.length && !wrongHead.length && !missing.length) return { ok: true };
    // Feedback is assembled to be SELF-CONTAINED: only files that provably exist are named.
    const parts = [`A review board reviewed round ${round}; full reports exist at ${D}/review-<lens>-r${round}.md for lenses that returned verdicts.`];
    for (const r of rejections) parts.push(`[${r.lens}]\n${r.verdict.feedback}`);
    for (const w of wrongHead) parts.push(`[${w.lens}] reviewed commit ${w.verdict.reviewedHeadSha}, not your reported tip ${report.headSha} — its verdict is void; treat the dimension as unreviewed and re-verify it yourself.`);
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
    `Record \`git rev-parse HEAD\` as reviewedHeadSha. Independently verify: re-run greenness yourself, walk the contract ` +
    `against the code, spot-check surprising lens verdicts in BOTH directions (lens verdicts are inputs, not votes). ` +
    `Write your full report to ${D}/final-adjudication.md. ` +
    `Your findings are a CLOSED list — the fix round applies exactly this list and nothing else.`,
  { label: "adjudicate", phase: "Adjudicate", model: "claude/opus[1m]", mode: "bypassPermissions", cwd: W, retries: 1, schema: ADJUDICATION },
);
if (!adjudication) throw new Error("terminal adjudication produced no result — inspect the run before delivery");
if (adjudication.reviewedHeadSha !== outcome.value.headSha) {
  log(`adjudicator reviewed ${adjudication.reviewedHeadSha}, expected ${outcome.value.headSha} — verdict void`);
  return { branch: BRANCH, approved: false, adjudication, processViolation: "terminal adjudication inspected the wrong commit — rerun it before trusting any verdict" };
}

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
        `touch, run the full verification bar, commit on ${BRANCH}, and report status "implemented" with headSha equal ` +
        `to the branch tip.` +
        (feedback ? `\nThe adjudicator rejected your previous fix attempt:\n${feedback}\nAddress every residual.` : ""),
      { label: `fix:r${attempt + 1}`, phase: "Fix", model: "codex/gpt-5.6-sol", mode: "agent", configOptions: { reasoning_effort: "xhigh" }, cwd: W, retries: 1, schema: IMPL_REPORT },
    ),
  async (fixReport) => {
    if (!fixReport || fixReport.status !== "implemented" || !fixReport.commitShas.length || !SHA.test(fixReport.headSha)) {
      return { ok: false, feedback: "No valid fix commits reported — apply the closed list, commit, and report status 'implemented' with real full-length SHAs." };
    }
    const verdict = await agent(
      CONTEXT +
        `You are the SAME terminal adjudicator. Record \`git rev-parse HEAD\` as reviewedHeadSha, then re-verify EVERY ` +
        `finding from your ${D}/final-adjudication.md against the committed branch (fix report: ` +
        `${JSON.stringify(fixReport)}), hunt regressions the fixes introduced, and write ${D}/final-adjudication-fix.md. ` +
        `approved=true means shippable as-is.`,
      { label: "adjudicate:fix", phase: "Fix", model: "claude/opus[1m]", mode: "bypassPermissions", cwd: W, retries: 1, schema: ADJUDICATION },
    );
    if (!verdict) return { ok: false, feedback: "Adjudicator returned no verdict — re-verify your own fixes against the closed list and recommit." };
    if (verdict.reviewedHeadSha !== fixReport.headSha) {
      return { ok: false, feedback: `The adjudicator inspected ${verdict.reviewedHeadSha}, not your reported tip ${fixReport.headSha} — re-run your verification bar and re-report the true branch tip.`, verdict };
    }
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
