// repo-triage — an autonomous, unattended triage of one repository, spread across
// three complementary built-in backends (Claude Code, Codex, OpenCode) in a single run.
// Stages: Map → Sweep → Verify → Hunt → Report. There is deliberately no
// checkpoint(): every gate in this script is another agent, so the run needs no
// human in the loop from start to finish.
//
// Support-API tour — where each DSL global earns its keep here:
//   pipeline()          Sweep → guardrails → Verify per area, with NO barrier: a slow
//                       area never blocks verification of the others
//   parallel()          the per-finding cross-vendor verification panel
//   gate()              report writer ⇄ report reviewer feedback loop
//   workflow()          nests the saved "quick-wins" script by name
//   loopUntilDry()      inside quick-wins — hunt rounds until two come up dry
//   completenessCheck() the final "what did we not cover?" critic
//   phase() / log()     progress grouping + the run log

//   args / cwd          tuning knobs / the triage target
export const meta = {
  name: "repo-triage",
  description:
    "Autonomous cross-vendor repo triage: map the repo, sweep areas in parallel, adversarially cross-verify every finding, hunt quick wins, and gate the final report",
  phases: [{ title: "Map" }, { title: "Sweep" }, { title: "Verify" }, { title: "Hunt" }, { title: "Report" }],
};

// ── args — every knob optional, and hosts may hand args through as a JSON string ──
const raw = typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : args;
const opt = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
const int = (v, fallback, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Math.floor(Number(v)) : fallback);
const maxAreas = int(opt.maxAreas, 4, 1);
const perArea = int(opt.findingsPerArea, 3, 1);
const huntRounds = int(opt.huntRounds, 3, 0);
const focus =
  typeof opt.focus === "string" && opt.focus.trim().length > 0
    ? opt.focus.trim()
    : "correctness bugs, unhandled error paths, and docs or comments that contradict the code";

// Pause-class failures must PROPAGATE out of the script: a provider quota wall or a
// backend auth gap pauses the run resumably at the engine level, and swallowing one
// in a catch would convert that resumable pause into a fake, lossy completion.
const rethrowPause = (err) => {
  if (err && (err.code === "PROVIDER_USAGE_LIMIT" || err.code === "AUTH_REQUIRED")) throw err;
};

// ── the vendor pool — one entry per first-class backend, treated symmetrically ──
// Sweeps rotate through the pool; every finding is then judged by the two vendors
// that did NOT produce it, so no vendor family approves its own blind spots.
// This published snapshot pins mode ids that its selected catalogs explicitly advertised.
// Before reusing it, call action:"config" for each exact model and keep a mode only when
// modes.availableModes still lists it; modes:null means omit it. OpenCode stays unset here.
// Each registered first segment
// routes and is stripped once; the remaining live-catalog-verified id is sent byte-for-byte.
// Harness rejection follows the normal agent-error path, with no client-side fallback.
const POOL = [
  { name: "claude", model: "claude/opus[1m]", mode: "plan" },
  { name: "codex", model: "codex/gpt-5.6-sol", mode: "read-only" },
  { name: "opencode", model: "opencode/zai/glm-5.2" },
];
const vendor = (i) => POOL[i % POOL.length];

// ── schemas — object root, closed, everything required, a description per field ──
const AREAS = {
  type: "object",
  additionalProperties: false,
  required: ["areas"],
  properties: {
    areas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "role", "why"],
        properties: {
          path: {
            type: "string",
            description: "Directory or file path relative to the repo root, copied exactly from a listing you ran — never invented",
          },
          role: { type: "string", description: "What this area does, in one clause" },
          why: { type: "string", description: "Why this area deserves a triage sweep: risk, complexity, or visible churn" },
        },
      },
    },
  },
};
const FINDINGS = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "severity", "summary", "evidence"],
        properties: {
          file: {
            type: "string",
            description: "Repo-relative path of a file you actually opened — copy it exactly, never invent one",
          },
          line: { type: "number", description: "1-indexed line number the finding anchors to" },
          severity: { type: "string", enum: ["low", "medium", "high"], description: "Impact if left unfixed" },
          summary: { type: "string", description: "One sentence stating the defect, grounded in the code you read" },
          evidence: {
            type: "string",
            description: "The specific code or behavior that proves the finding — quote or closely paraphrase the offending lines",
          },
        },
      },
    },
  },
};
const VERDICT = {
  type: "object",
  additionalProperties: false,
  required: ["real", "reason"],
  properties: {
    real: {
      type: "boolean",
      description:
        "true only if you re-checked the cited code yourself and the problem is genuinely there as described; when uncertain, false",
    },
    reason: { type: "string", description: "One sentence: what you checked and why it confirms or refutes the finding" },
  },
};
const REVIEW = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "feedback"],
  properties: {
    ok: {
      type: "boolean",
      description: "true only if the report faithfully covers every confirmed finding and invents nothing",
    },
    feedback: { type: "string", description: "When ok=false: concretely what to change. When ok=true: an empty string" },
  },
};

// ── Map — pick the areas worth auditing. This call deliberately omits `model`:
// it runs on whatever backend the host defaults to, so the script stays portable. ──
phase("Map");
log(`triage target: ${cwd}`);
log(`focus: ${focus}`);
const map = await agent(
  "Survey the repository at the session working directory to plan a triage. " +
    "List the source tree (skip node_modules, dist, lockfiles, and other generated content), open the " +
    `manifests and entry points you need, and pick the ${maxAreas} areas most worth auditing for: ${focus}. ` +
    "Prefer areas with real logic over config or boilerplate.",
  { label: "map", schema: AREAS, retries: 1 },
);

// Null-safe degrade: if mapping failed outright (retries exhausted ⇒ null), sweep the
// repo root as a single area rather than dying — an unattended run should always
// produce SOMETHING. The path guard drops absolute/escaping/placeholder paths.
const proposed = map?.areas ?? [{ path: ".", role: "repository root", why: "map step failed; falling back to a whole-repo sweep" }];
const areas = proposed
  .filter((a) => typeof a.path === "string" && a.path.length > 0 && !a.path.startsWith("/") && !a.path.includes(".."))
  .slice(0, maxAreas);
if (areas.length === 0) areas.push({ path: ".", role: "repository root", why: "no proposed area survived the path guard" });
if (areas.length < proposed.length) log(`Map: kept ${areas.length}/${proposed.length} proposed areas (path guard + maxAreas cap)`);

// ── Sweep → Verify — ONE pipeline, three stages per area, no barrier in between:
// area A's findings are being cross-verified while area B is still being swept. ──
phase("Sweep");
const swept = await pipeline(
  areas,
  // Stage 1 — sweep the area on its rotation vendor.
  (area, _same, i) =>
    agent(
      `You are one sweeper in an automated repo triage. Audit ONLY \`${area.path}\` (${area.role}) — stay inside it. ` +
        `Hunt for: ${focus}. Open the files and actually read them; report at most ${perArea} findings, most severe first. ` +
        "Populate every schema field from evidence you saw — never emit a placeholder or an invented path.",
      { label: `sweep:${area.path}`, phase: "Sweep", schema: FINDINGS, model: vendor(i).model, mode: vendor(i).mode, retries: 1 },
    ),
  // Stage 2 — script-side guardrails: drop placeholder-ish findings, cap, attribute.
  (report, area, i) => {
    if (!report) {
      log(`Sweep: ${area.path} produced nothing (agent failed after retry) — skipping this area`);
      return [];
    }
    const kept = report.findings
      .filter((f) => typeof f.file === "string" && f.file.length > 0 && !f.file.startsWith("/") && Number(f.line) >= 1)
      .slice(0, perArea)
      .map((f) => ({ ...f, area: area.path, foundBy: vendor(i).name }));
    if (kept.length < report.findings.length)
      log(`Sweep: ${area.path}: kept ${kept.length}/${report.findings.length} findings (guardrails + per-area cap)`);
    return kept;
  },
  // Stage 3 — cross-vendor adversarial verification: the two vendors that did NOT
  // produce the finding each try to refute it, concurrently.
  async (findings, _area, i) => {
    const judged = await parallel(
      findings.map((f) => async () => {
        const jurors = [vendor(i + 1), vendor(i + 2)];
        const votes = (
          await parallel(
            jurors.map((j) => () =>
              agent(
                "You are an adversarial verifier in a repo triage: try to REFUTE this finding. " +
                  `Open \`${f.file}\` yourself, read line ${f.line} in context, and re-check the claim.\n` +
                  `Finding (from another agent): ${JSON.stringify({ file: f.file, line: f.line, severity: f.severity, summary: f.summary, evidence: f.evidence })}\n` +
                  "Set real=true only if the problem is genuinely there as described; when uncertain, refute.",
                { label: `verify:${j.name}:${f.file}#${f.line}`, phase: "Verify", schema: VERDICT, model: j.model, mode: j.mode },
              ),
            ),
          )
        ).filter(Boolean);
        // Unanimity among the jurors that answered. A finding whose jurors ALL failed
        // (e.g. their backends aren't installed here) is not silently dropped — it is
        // returned in the separate `unverified` bucket instead of `findings`.
        const real = votes.length > 0 && votes.every((v) => v.real);
        return { ...f, real, unverified: votes.length === 0, verifiedBy: jurors.map((j) => j.name), verdicts: votes.map((v) => v.reason) };
      }),
    );
    return judged.filter(Boolean);
  },
);

// The verify agents above carried phase:"Verify" per call (they overlap the Sweep
// phase in time); this top-level marker keeps the run's visited-phase list complete.
phase("Verify");
const allFindings = swept.filter(Boolean).flat();
const confirmed = allFindings.filter((f) => f.real);
const unverified = allFindings.filter((f) => f.unverified);
if (unverified.length > 0)
  log(`Verify: ${unverified.length} finding(s) had no responding juror — returned as unverified, not confirmed`);
log(`Verify: ${confirmed.length}/${allFindings.length} findings survived cross-vendor verification`);

// ── Hunt (optional) — nest the saved quick-wins workflow by NAME. It resolves
// because the host passed `workflows: <dir>`, and it shares this run's concurrency
// limiter. Skipped when disabled by args. ──
phase("Hunt");
let quickWins = [];
if (huntRounds === 0) {
  log("Hunt: disabled (huntRounds=0)");
} else {
  try {
    const nested = await workflow("quick-wins", {
      rounds: huntRounds,
      focus,
      avoid: confirmed.map((f) => `${f.file}:${f.line}`),
    });
    quickWins = Array.isArray(nested?.wins) ? nested.wins : [];
  } catch (err) {
    rethrowPause(err);
    log(`Hunt: quick-wins workflow failed (${err?.message ?? err}) — continuing without it`);
  }
}

// ── Report — a gate() loop: the writer and the reviewer are always DIFFERENT
// vendors, and every rewrite goes to the next vendor in the rotation. ──
phase("Report");
const reportData = { target: cwd, focus, areas, confirmed, rejectedCount: allFindings.length - confirmed.length, quickWins };
let writerIdx = 0;
// Best-effort: the findings are the run's real product, so a Report-stage failure
// (say, a provider quota wall mid-gate) is logged and degraded — the run still
// returns everything it confirmed.
let gated = { ok: false, value: null, verdict: null, attempts: 0 };
try {
  gated = await gate(
    (feedback, attempt) => {
      writerIdx = attempt;
      return agent(
        "Write a repo triage report as GitHub-flavored markdown. Use ONLY this JSON as your source of truth — " +
          "never invent findings, paths, or numbers:\n" +
          JSON.stringify(reportData, null, 2) +
          "\nStructure: a title; a three-sentence executive summary; a table of confirmed findings " +
          "(severity | file:line | summary | found by → verified by); a quick-wins list; a short suggested-next-steps section. " +
          "Return ONLY the markdown document." +
          (feedback ? `\n\nA reviewer rejected the previous draft:\n${feedback}\nAddress every point.` : ""),
        { label: `report:draft:${attempt + 1}`, phase: "Report", model: vendor(attempt).model, retries: 1 },
      );
    },
    (draft) => {
      if (!draft) return { ok: false, feedback: "the writer returned nothing — produce the markdown report from the JSON data" };
      return agent(
        "Review this triage report against its source data. ok=true only if every confirmed finding appears, " +
          "nothing was invented (no findings, paths, or numbers absent from the data), and the required structure is followed.\n" +
          `SOURCE DATA:\n${JSON.stringify(reportData, null, 2)}\n\nREPORT:\n${draft}`,
        { label: "report:review", phase: "Report", model: vendor(writerIdx + 1).model, mode: vendor(writerIdx + 1).mode, schema: REVIEW },
      );
    },
    { attempts: 3 },
  );
  if (!gated.ok) log(`Report: reviewer never approved after ${gated.attempts} attempts — returning the last draft unapproved`);
} catch (err) {
  rethrowPause(err);
  log(`Report: skipped (${err?.message ?? err}) — returning the confirmed findings without a report`);
}

// ── Completeness — one critic asks what the triage did NOT cover. Best-effort too. ──
let completeness = null;
try {
  completeness = await completenessCheck(
    { target: cwd, focus, maxAreas, findingsPerArea: perArea, huntRounds },
    { areas, confirmed, quickWins },
  );
  // completenessCheck is agent-backed, so it resolves to null when the critic fails.
  if (!completeness) log("Completeness critic: no verdict (the critic agent failed)");
  else if (!completeness.complete) log(`Completeness critic: missing — ${(completeness.missing ?? []).join("; ")}`);
} catch (err) {
  rethrowPause(err);
  log(`Completeness critic: skipped (${err?.message ?? err})`);
}

// The run's `result` — compact and structured, not a transcript.
return {
  target: cwd,
  focus,
  areas: areas.map((a) => `${a.path} — ${a.role}`),
  stats: {
    areasSwept: areas.length,
    findingsReported: allFindings.length,
    findingsConfirmed: confirmed.length,
    findingsUnverified: unverified.length,
    quickWins: quickWins.length,
    reportApproved: gated.ok,
    reportAttempts: gated.attempts,
  },
  findings: confirmed,
  unverified,
  quickWins,
  report: typeof gated.value === "string" ? gated.value : null,
  reportVerdict: gated.verdict,
  completeness,
};
