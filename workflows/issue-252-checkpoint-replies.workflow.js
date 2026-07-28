export const meta = {
  name: "issue-252-checkpoint-replies",
  description: "Implement the checkpointReplies positional-resume fix prescribed in GitHub issue #252 (relax the firstMiss injection gate to exact path-hash matches) on codex gpt-5.6-sol xhigh; review with kimi k3 high on pi in bounded rounds; terminal adjudication plus one bounded fix pass.",
  phases: [
    { title: "Implement" },  // codex implements issue #252 in the worktree
    { title: "Review" },     // bounded kimi lens rounds with codex fix rounds
    { title: "Adjudicate" }, // terminal kimi adjudicator + one panel-free fix pass
  ],
};

// ---------------------------------------------------------------------------
// Source contract (hop zero). The user's verbatim request sentences:
//   "design a workflow ... that uses gpt-5.6-sol xhigh with codex harness and
//    kimi k3 high with pi harness for implementation and review of implementation"
// targeting issue #252, whose body carries the owner-stated governing principle:
//   "The engine can NEVER guarantee — and must NEVER attempt to guarantee or
//    assume — that 'the world' ... is static between runs. The engine's entire
//    contract is journal/script replay integrity."
// The issue body is the spec. Agents fetch it themselves and pin a snapshot to
// the design dir; every review/adjudication prompt anchors to THAT snapshot.
// ---------------------------------------------------------------------------

const input = typeof args === "string"
  ? JSON.parse(args)
  : (args && typeof args === "object" && !Array.isArray(args) ? args : {});

const WORKTREE = typeof input.worktreePath === "string"
  ? input.worktreePath
  : "/home/vikash/agentprism-252-checkpoint";
const DESIGN_DIR = typeof input.designDir === "string"
  ? input.designDir
  : "/home/vikash/agentprism-252-design"; // OUTSIDE the worktree — survives a worktree reset
const ISSUE = Number.isInteger(input.issue) ? input.issue : 252;
const REPO = "agentprism/agentprism-workflows";
const MAX_ROUNDS = Number.isInteger(input.maxRounds) && input.maxRounds > 0
  ? Math.min(input.maxRounds, 5)
  : 3;

// Model routing (ids + effort values verified against the live advertised catalogs
// via `npx @automatalabs/workflows config codex|pi` at authoring time):
const IMPLEMENTER = {
  model: "codex/gpt-5.6-sol",
  mode: "agent", // advertised codex mode: read-and-edit within the workspace
  configOptions: { reasoning_effort: "xhigh" },
};
const REVIEWER = {
  model: "pi/openrouter/moonshotai/kimi-k3",
  configOptions: { thinkingLevel: "high" },
};

// ---------------------------------------------------------------------------
// Schemas (object root, additionalProperties:false, all required, described fields)
// ---------------------------------------------------------------------------

// Producer report. The refusal shape is first-class: status "stopped" + empty
// commitShas + the discrepancy verbatim in deviations. The checker below
// recognizes it and halts the train instead of routing a correct refusal
// into "round failed, try again".
const REPORT = {
  type: "object",
  additionalProperties: false,
  required: ["status", "baseSha", "headSha", "commitShas", "summary", "deviations", "testsRun"],
  properties: {
    status: {
      type: "string",
      enum: ["implemented", "stopped"],
      description: "'implemented' iff the fix is committed and suites green; 'stopped' iff you hit a STOP condition (e.g. a cited mechanism missing on your tree) — never improvise around one",
    },
    baseSha: { type: "string", description: "Full 40-char SHA of origin/main you fetched and based the work on, recorded BEFORE your first commit" },
    headSha: { type: "string", description: "Full 40-char SHA of the branch tip AFTER your final commit — must equal `git rev-parse HEAD` and the last entry of commitShas" },
    commitShas: { type: "array", items: { type: "string" }, description: "Every commit you made, oldest first; empty iff status is 'stopped'" },
    summary: { type: "string", description: "What changed and why, in <= 15 lines, grounded in the actual diff" },
    deviations: { type: "string", description: "Every deviation from the issue's prescription, verbatim; the STOP discrepancy if status is 'stopped'; empty string if none" },
    testsRun: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exitCode"],
        properties: {
          command: { type: "string", description: "The literal command you ran" },
          exitCode: { type: "number", description: "Its exit code (0 = pass)" },
        },
      },
      description: "Build + test commands actually executed, including the new regression tests and the full workflow-engine suite",
    },
  },
};

// Review lens verdict. Evidence fields stay small; overflow goes to design-dir files.
const VERDICT = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "baseDrifted", "headMatchesReport", "commandsRun", "findings", "feedback"],
  properties: {
    ok: { type: "boolean", description: "true ONLY if your one lens question passes with zero blocker/major findings and every command you ran to check it exited 0" },
    baseDrifted: { type: "boolean", description: "true iff `git ls-remote origin main` disagrees with the report's baseSha" },
    headMatchesReport: { type: "boolean", description: "true iff `git rev-parse HEAD` equals the report's headSha (report/HEAD discipline)" },
    commandsRun: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exitCode"],
        properties: {
          command: { type: "string", description: "Literal command run" },
          exitCode: { type: "number", description: "Exit code (0 = pass)" },
        },
      },
      description: "Every command you ran as evidence — builds, test suites, git queries",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "summary", "evidence"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"], description: "blocker = must not ship; major = should not ship; minor = note only" },
          file: { type: "string", description: "Repo-relative path — copy it exactly, never invent one" },
          line: { type: "number", description: "1-indexed line the finding anchors to" },
          summary: { type: "string", description: "One sentence stating the defect, grounded in code you actually read" },
          evidence: { type: "string", description: "<= 10 lines: the code, command output, or reasoning that proves it" },
        },
      },
      description: "Findings for YOUR lens question only; empty if none",
    },
    feedback: {
      type: "string",
      description: "<= 20 lines, fully self-contained: everything the implementer needs to address your findings on the next round, with no references to files that may not exist",
    },
  },
};

// Terminal adjudication: closed findings list + final verdict.
const ADJUDICATION = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "closedFindings", "spotChecks", "ownerDecisions", "rationale"],
  properties: {
    verdict: { type: "string", enum: ["ship", "fix"], description: "'ship' iff zero blocker/major findings survive YOUR OWN re-verification; else 'fix'" },
    closedFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "file", "line", "summary", "evidence"],
        properties: {
          id: { type: "string", description: "Short stable id, e.g. F1, F2 — the fix pass applies these by id" },
          severity: { type: "string", enum: ["blocker", "major"], description: "Only ship-relevant severities belong in the closed list" },
          file: { type: "string", description: "Repo-relative path, copied exactly" },
          line: { type: "number", description: "1-indexed anchor line" },
          summary: { type: "string", description: "One sentence stating the defect" },
          evidence: { type: "string", description: "<= 10 lines proving it, from your own commands or cited code" },
        },
      },
      description: "The CLOSED list the fix pass must apply exactly — nothing more, nothing less",
    },
    spotChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "command", "exitCode", "upheld"],
        properties: {
          claim: { type: "string", description: "The surprising verdict or report claim you re-checked" },
          command: { type: "string", description: "The literal command you ran to check it" },
          exitCode: { type: "number", description: "Its exit code" },
          upheld: { type: "boolean", description: "true iff the claim survived your check" },
        },
      },
      description: "Your independent re-verifications, in both directions (confirm AND refute)",
    },
    ownerDecisions: { type: "array", items: { type: "string" }, description: "Genuine scope/design questions only the owner can answer; empty if none" },
    rationale: { type: "string", description: "<= 10 lines explaining the verdict" },
  },
};

// The adjudicator's direct re-verification of the panel-free fix pass.
const FIX_VERIFY = {
  type: "object",
  additionalProperties: false,
  required: ["allAddressed", "perFinding", "commandsRun", "feedback"],
  properties: {
    allAddressed: { type: "boolean", description: "true iff every closed finding is verifiably addressed and the suites are green" },
    perFinding: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "addressed", "evidence"],
        properties: {
          id: { type: "string", description: "The closed-finding id" },
          addressed: { type: "boolean", description: "true iff verifiably fixed" },
          evidence: { type: "string", description: "<= 6 lines proving the disposition" },
        },
      },
      description: "One entry per closed finding id",
    },
    commandsRun: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exitCode"],
        properties: {
          command: { type: "string", description: "Literal command run" },
          exitCode: { type: "number", description: "Exit code" },
        },
      },
      description: "Verification commands, including the full workflow-engine suite",
    },
    feedback: { type: "string", description: "<= 15 lines: what remains unaddressed, self-contained; empty string if allAddressed" },
  },
};

// ---------------------------------------------------------------------------
// Shared prompt fragments
// ---------------------------------------------------------------------------

const ISSUE_FETCH =
  `The spec is GitHub issue #${ISSUE} in ${REPO}. Fetch it verbatim:\n` +
  `  mkdir -p ${DESIGN_DIR} && gh issue view ${ISSUE} --repo ${REPO} --json title,body > ${DESIGN_DIR}/issue-${ISSUE}.json\n` +
  `  gh issue view ${ISSUE} --repo ${REPO} > ${DESIGN_DIR}/issue-${ISSUE}.md\n` +
  `Treat that issue body as the settled spec: its §3.1-3.4 prescribe the fix, §4 the test plan, ` +
  `§5 the acceptance criteria, and its stated governing principle (the engine NEVER assumes the ` +
  `world stays static; its only contract is journal/script replay integrity) is owner law.\n`;

const STOP_RULES =
  "HARD RULES:\n" +
  "- If the issue cites a mechanism (file, symbol, line) that does not exist as cited on YOUR tree, " +
  "STOP: return status 'stopped' with empty commitShas and the discrepancy verbatim in deviations. " +
  "The likely cause is a stale base, not a wrong spec. NEVER build the 'equivalent' at your own layer.\n" +
  "- The report and HEAD must be the same commit: after filing your report you make NO further commits.\n" +
  "- Populate every field from evidence; never emit placeholder values like 'TODO' or 'unknown'.\n";

const SHA_RE = /^[0-9a-f]{40}$/;

function reportShapeProblems(report) {
  const problems = [];
  if (!report || typeof report !== "object") return ["producer returned no report"];
  if (report.status === "stopped") return [];
  if (!SHA_RE.test(report.baseSha)) problems.push("baseSha is not a 40-char hex SHA");
  if (!SHA_RE.test(report.headSha)) problems.push("headSha is not a 40-char hex SHA");
  if (!Array.isArray(report.commitShas) || report.commitShas.length === 0) {
    problems.push("commitShas is empty but status is 'implemented'");
  } else {
    if (report.commitShas.some((sha) => !SHA_RE.test(sha))) problems.push("a commitSha is not a 40-char hex SHA");
    if (report.commitShas[report.commitShas.length - 1] !== report.headSha) {
      problems.push("headSha is not the last commitSha (report/HEAD discipline)");
    }
  }
  if (!Array.isArray(report.testsRun) || report.testsRun.length === 0) problems.push("testsRun is empty");
  if (/TODO|unknown|placeholder/i.test(report.summary)) problems.push("summary smells like a placeholder");
  return problems;
}

function implementerPrompt(feedback, attempt) {
  return (
    `You are implementing a prescribed engine fix in the git worktree at ${WORKTREE} ` +
    `(branch fix/252-checkpoint-replies-injection-gate of ${REPO}).\n\n` +
    ISSUE_FETCH + "\n" +
    `Base discipline: run \`git fetch origin main\`, record \`git rev-parse origin/main\` as baseSha, ` +
    `and confirm the worktree is based on it BEFORE writing code.\n\n` +
    (attempt === 0
      ? `Implement the issue's §3.1 core change exactly (relax the positional checkpoint-injection ` +
        `gate to exact path-hash matches only; unique-hash stays gated), §3.2 loud reporting of a ` +
        `supplied-but-unapplied reply (including the mcp-server terminal-summary surface), §3.3 ` +
        `honest predictedReplayablePrefix, and §3.4 docs — plus the full §4 test plan. The engine ` +
        `must contain NO world-freshness machinery: call-identity (reply targeting) is the only ` +
        `thing the exact match decides.\n`
      : `A reviewer rejected round ${attempt}. Address EVERY finding below exactly — nothing more. ` +
        `Reviewer feedback (self-contained):\n${feedback}\n`) +
    `\nWorkflow: pnpm install if needed; make focused commits; run the new regression tests, then ` +
    `\`pnpm build\` and the full \`pnpm --filter @automatalabs/workflow-engine test\` suite (and the ` +
    `mcp-server suite if you touched it). Then file your report and stop.\n\n` +
    STOP_RULES
  );
}

function lensPrompt(lens, report, round) {
  const common =
    `You are review lens "${lens}" (round ${round}) on the fix committed in the worktree at ` +
    `${WORKTREE}. The spec snapshot is ${DESIGN_DIR}/issue-${ISSUE}.md — read it first; it is the ` +
    `settled WHAT. The producer's report:\n${JSON.stringify(report, null, 2)}\n\n` +
    `First, two mechanical checks: baseDrifted = (\`git ls-remote origin main\` output disagrees ` +
    `with the report's baseSha); headMatchesReport = (\`git rev-parse HEAD\` equals the report's ` +
    `headSha). Install deps (pnpm install) before running suites. You may run tests and any ` +
    `read-only git command, but you MUST NOT create/edit files, commit, or run git mutations ` +
    `(ls-remote/fetch-free queries only — ls-remote is allowed, fetch is not). Record every ` +
    `command in commandsRun with its real exit code. Populate findings from code you actually ` +
    `read — never placeholder values. Your jurisdiction is HOW the fix is implemented; the ` +
    `issue's scope and design decisions are settled — do not relitigate them.\n\n`;
  if (lens === "acceptance") {
    return common +
      `YOUR ONE QUESTION: does the committed fix verifiably satisfy every acceptance criterion in ` +
      `the issue's §5, including the §4 test plan and §3.2-3.4 surfaces? Walk each criterion one ` +
      `by one; for each, produce command-backed evidence (run the new regression tests; run the ` +
      `full workflow-engine suite from the committed state; confirm the mcp-server summary ` +
      `surface and docs changes exist). ok=true only if you FAILED to find an unmet criterion.\n`;
  }
  return common +
    `YOUR ONE QUESTION: can you REFUTE the fix's core safety claims? Attack the diff ` +
    `(\`git diff <baseSha>..HEAD\`) on exactly these fronts: (1) is there ANY path where a ` +
    `checkpointReply injects without an exact (kind, path, hash) + inputsHash match — e.g. a ` +
    `unique-hash match honored after the prefix went live; (2) does a targeting MISS always ` +
    `re-pause AND loudly report the unapplied reply; (3) did the change sneak in world-freshness ` +
    `assumptions (it must NOT — only call identity decides); (4) are the identity-v1 and legacy ` +
    `paths byte-identical in behavior to before. ok=true only if you FAILED to refute all four.\n`;
}

// ---------------------------------------------------------------------------
// The train
// ---------------------------------------------------------------------------

phase("Implement");
log(`issue #${ISSUE}: worktree=${WORKTREE} designDir=${DESIGN_DIR} maxRounds=${MAX_ROUNDS}`);

let report = await agent(implementerPrompt(null, 0), {
  label: "implement:1",
  ...IMPLEMENTER,
  cwd: WORKTREE,
  schema: REPORT,
  retries: 1,
});

if (!report) throw new Error("implementer returned no report (null after retries)");
if (report.status === "stopped") {
  log(`implementer STOPPED: ${report.deviations}`);
  return { status: "stopped", reason: report.deviations, report };
}
{
  const problems = reportShapeProblems(report);
  if (problems.length > 0) {
    log(`report shape problems: ${problems.join("; ")} — one repair round`);
    report = await agent(
      implementerPrompt(
        `Your report failed mechanical validation: ${problems.join("; ")}. ` +
        `Fix the underlying discipline problem (make the commits/tests real) and re-report.`,
        1,
      ),
      { label: "implement:repair", ...IMPLEMENTER, cwd: WORKTREE, schema: REPORT, retries: 1 },
    );
    if (!report || report.status === "stopped" || reportShapeProblems(report).length > 0) {
      return { status: "blocked", reason: "producer could not file a valid report", report };
    }
  }
}
log(`implementation reported at ${report.headSha} (${report.commitShas.length} commits)`);

phase("Review");
let gateOk = false;
let lastFeedback = "";
const rounds = [];

for (let round = 1; round <= MAX_ROUNDS; round += 1) {
  const acceptance = await agent(lensPrompt("acceptance", report, round), {
    label: `review:acceptance:${round}`,
    ...REVIEWER,
    cwd: WORKTREE,
    schema: VERDICT,
    retries: 1,
  });
  const adversarial = await agent(lensPrompt("adversarial", report, round), {
    label: `review:adversarial:${round}`,
    ...REVIEWER,
    cwd: WORKTREE,
    schema: VERDICT,
    retries: 1,
  });

  const lenses = [
    { name: "acceptance", verdict: acceptance },
    { name: "adversarial", verdict: adversarial },
  ];
  const material = lenses.filter(({ verdict }) => verdict !== null);
  const blockers = material.flatMap(({ name, verdict }) =>
    verdict.findings
      .filter((f) => f.severity !== "minor")
      .map((f) => ({ lens: name, ...f })),
  );
  const discipline = material.flatMap(({ name, verdict }) => {
    const d = [];
    if (verdict.baseDrifted) d.push(`${name}: base drifted from origin/main`);
    if (!verdict.headMatchesReport) d.push(`${name}: HEAD does not match the report (post-report commits?)`);
    return d;
  });
  rounds.push({
    round,
    degraded: material.length < lenses.length,
    blockers: blockers.length,
    discipline,
  });
  log(`round ${round}: ${blockers.length} blocker/major findings, discipline: ${discipline.join("; ") || "clean"}${material.length < lenses.length ? " (DEGRADED: a lens returned null)" : ""}`);

  if (blockers.length === 0 && discipline.length === 0 && material.every(({ verdict }) => verdict.ok)) {
    gateOk = true;
    break;
  }
  if (round === MAX_ROUNDS) break;

  lastFeedback =
    `Round ${round} review findings (self-contained; address every one):\n` +
    JSON.stringify({ blockers, discipline, lensFeedback: material.map(({ name, verdict }) => ({ lens: name, feedback: verdict.feedback })) }, null, 2);
  report = await agent(implementerPrompt(lastFeedback, round), {
    label: `fix:${round}`,
    ...IMPLEMENTER,
    cwd: WORKTREE,
    schema: REPORT,
    retries: 1,
  });
  if (!report) throw new Error(`fix round ${round} returned no report (null after retries)`);
  if (report.status === "stopped") {
    log(`fix round ${round} STOPPED: ${report.deviations}`);
    return { status: "stopped", reason: report.deviations, report, rounds };
  }
  const problems = reportShapeProblems(report);
  if (problems.length > 0) {
    log(`fix round ${round} report shape problems: ${problems.join("; ")}`);
    return { status: "blocked", reason: `fix round ${round} invalid report: ${problems.join("; ")}`, report, rounds };
  }
}

phase("Adjudicate");
// The terminal adjudicator reads the issue snapshot, the final report, and every
// round's verdicts; it spot-checks surprising claims in BOTH directions and emits
// a CLOSED findings list. Lens verdicts are inputs, not votes.
const adjudication = await agent(
  `You are the TERMINAL adjudicator for the fix in the worktree at ${WORKTREE}. Your verdict is ` +
  `final. Read the spec snapshot ${DESIGN_DIR}/issue-${ISSUE}.md first.\n\n` +
  `Final producer report:\n${JSON.stringify(report, null, 2)}\n\n` +
  `Review-round records:\n${JSON.stringify(rounds, null, 2)}\n` +
  `The gate ${gateOk ? "PASSED" : "did NOT pass"} within ${MAX_ROUNDS} rounds.\n\n` +
  `Rules: independently re-verify — run the new regression tests and the full workflow-engine ` +
  `suite from the committed state; spot-check the most surprising lens verdicts and report claims ` +
  `in BOTH directions (confirm at least one 'ok', refute at least one finding if any exist). ` +
  `Check \`git rev-parse HEAD\` against the report's headSha and \`git ls-remote origin main\` ` +
  `against its baseSha. Then emit a CLOSED findings list: only genuine blocker/major defects you ` +
  `verified yourself, each with a stable id. Lens verdicts are inputs, not votes — the repo ` +
  `answers, not the panel. The issue's scope and design decisions are settled; surface only ` +
  `genuine owner-level decisions in ownerDecisions. You MUST NOT edit or commit anything.\n`,
  { label: "adjudicate", ...REVIEWER, cwd: WORKTREE, schema: ADJUDICATION, retries: 1 },
);

if (!adjudication) throw new Error("adjudicator returned no verdict (null after retries)");
log(`adjudication: ${adjudication.verdict}, ${adjudication.closedFindings.length} closed findings`);

let fixPass = null;
if (adjudication.verdict === "fix" && adjudication.closedFindings.length > 0) {
  // Panel-free fix round: one producer pass applying the closed list exactly,
  // judged directly by the SAME adjudicator re-verifying its own findings.
  report = await agent(
    `You are applying a CLOSED fix list in the worktree at ${WORKTREE}. Apply exactly these ` +
    `findings — nothing more, no re-design, no new scope:\n` +
    JSON.stringify(adjudication.closedFindings, null, 2) +
    `\n\nRun the relevant tests, then the full workflow-engine suite, commit, and report.\n\n` +
    STOP_RULES,
    { label: "fix:final", ...IMPLEMENTER, cwd: WORKTREE, schema: REPORT, retries: 1 },
  );
  if (!report) throw new Error("final fix pass returned no report (null after retries)");
  if (report.status === "stopped") {
    return { status: "stopped", reason: report.deviations, report, rounds, adjudication };
  }
  const verify = await agent(
    `You are the terminal adjudicator re-verifying YOUR OWN closed findings against the new ` +
    `commits in the worktree at ${WORKTREE}. Closed findings:\n` +
    JSON.stringify(adjudication.closedFindings, null, 2) +
    `\n\nThe fix report:\n${JSON.stringify(report, null, 2)}\n\n` +
    `For each finding id, verify the disposition with commands (read the new diff, run the ` +
    `tests). Run the full workflow-engine suite. allAddressed=true only if every id is verifiably ` +
    `fixed and the suite is green. You MUST NOT edit or commit anything.\n`,
    { label: "adjudicate:verify", ...REVIEWER, cwd: WORKTREE, schema: FIX_VERIFY, retries: 1 },
  );
  fixPass = verify
    ? { allAddressed: verify.allAddressed, perFinding: verify.perFinding }
    : { allAddressed: false, perFinding: [], note: "verification returned null" };
  log(`fix pass: allAddressed=${fixPass.allAddressed}`);
}

return {
  status:
    adjudication.verdict === "ship"
      ? "ship"
      : fixPass && fixPass.allAddressed
        ? "ship-after-fix"
        : "blocked",
  headSha: report.headSha,
  baseSha: report.baseSha,
  gateOk,
  roundsUsed: rounds.length,
  closedFindings: adjudication.closedFindings.length,
  ownerDecisions: adjudication.ownerDecisions,
  fixPass,
  designDir: DESIGN_DIR,
};
