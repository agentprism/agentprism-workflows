## Worked example — cross-vendor build with every major primitive

```js
export const meta = {
  name: "feature-build",
  description: "Plan, gate on approval, implement, cross-vendor review, fix until green",
  phases: [{ title: "Plan" }, { title: "Implement" }, { title: "Review" }],
};

const PLAN = { type: "object", additionalProperties: false, required: ["steps", "risks"],
  properties: {
    steps: { type: "array", items: { type: "string", description: "One concrete implementation step" } },
    risks: { type: "array", items: { type: "string" } } } };
const VERDICT = { type: "object", additionalProperties: false, required: ["ok"],
  properties: { ok: { type: "boolean" },
                feedback: { type: "string", description: "Required when ok=false: concretely what to change" } } };

phase("Plan");
const plan = await agent(
  `Study this repo, then write an implementation plan for: ${args.feature}. Keep steps concrete.`,
  { label: "plan", model: "opencode/zai/glm-5.2", schema: PLAN },
);

const approved = await checkpoint(
  `Implement "${args.feature}" with this plan?\n- ${plan.steps.join("\n- ")}\nRisks: ${plan.risks.join("; ")}`,
  { kind: "confirm", default: true },
);
if (!approved) return { implemented: false, plan };

phase("Implement");
const outcome = await gate(
  (feedback, attempt) => agent(
    `Implement: ${args.feature}\nPlan:\n- ${plan.steps.join("\n- ")}\n` +
    `Run the project's tests before finishing and report results.` +
    (feedback ? `\n\nReviewer feedback on attempt ${attempt}:\n${feedback}\nAddress every point.` : ""),
    { label: `implement:${attempt + 1}`, model: "codex/gpt-5.6-sol", mode: "agent", retries: 1 },
  ),
  async (report) => {
    if (!report) return { ok: false, feedback: "implementation agent produced no result" };
    phase("Review");
    const reviews = (await parallel([   // two reviewers on different vendors
      () => agent(`Review the working-tree diff for correctness. Implementer's report:\n${report}`,
                  { label: "review:correctness", model: "claude/opus[1m]", mode: "bypassPermissions", schema: VERDICT }),
      () => agent(`Review the working-tree diff for regressions and missing tests. Report:\n${report}`,
                  { label: "review:coverage", model: "opencode/zai/glm-5.2", schema: VERDICT }),
    ])).filter(Boolean);
    const rejections = reviews.filter((r) => !r.ok);
    return rejections.length
      ? { ok: false, feedback: rejections.map((r) => r.feedback).join("\n"), reviews }
      : { ok: true, reviews };
  },
  { attempts: 3 },
);

return { implemented: outcome.ok, attempts: outcome.attempts, reviewVerdict: outcome.verdict, plan };
```

These trusted implementation/review calls pin Codex `agent` and Claude `bypassPermissions` for
full tool autonomy. Confirm both ids in the live catalog first. Claude `auto` uses a model classifier
and may request permission; it is not the full-access mode. For a read-only planner, select the
exact advertised read-only/plan mode instead.

## Worked example — fully backend-agnostic audit

No `model` anywhere: this script runs unchanged on whatever backend the host defaults to.

```js
export const meta = {
  name: "edge-case-audit",
  description: "Exhaustively hunt edge-case bugs in a target dir, verify each, report gaps",
  phases: [{ title: "Hunt" }, { title: "Verify" }],
};

const BUGS = { type: "object", additionalProperties: false, required: ["bugs"],
  properties: { bugs: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["file", "scenario"], properties: {
      file: { type: "string", description: "Repo-relative path you actually opened" },
      scenario: { type: "string", description: "Concrete input/state → wrong behavior" } } } } } };

phase("Hunt");
const seen = [];   // what earlier rounds reported, threaded into each new prompt
const candidates = await loopUntilDry({
  round: async (i) => {
    const r = await agent(
      `Round ${i + 1}: find edge-case bugs in ${args.target} not already in this list:\n` +
      JSON.stringify(seen) + `\nOnly report what you can ground in code you read.`,
      { label: `hunt:${i + 1}`, schema: BUGS },
    );
    const bugs = r ? r.bugs : [];
    seen.push(...bugs);
    return bugs;      // loopUntilDry dedups these by `key` across rounds
  },
  key: (b) => `${b.file}:${b.scenario}`,
  consecutiveEmpty: 2,
  maxRounds: 8,
});

phase("Verify");
const confirmed = (await pipeline(
  candidates,
  (bug) => verify(bug, { reviewers: 3, threshold: 0.66, lens: ["correctness", "reproducibility"] }),
  (v, bug) => (v.real ? bug : null),
)).filter(Boolean);

const gaps = await completenessCheck(args, confirmed);
log(`${confirmed.length}/${candidates.length} confirmed; complete=${gaps.complete}`);
return { confirmed, missing: gaps.missing ?? [] };
```

## Full-scale example scripts

When the inline examples above aren't enough, study the complete, validated scripts in [`examples/`](examples/) (same directory as this file):

- [`examples/repo-triage.workflow.js`](examples/repo-triage.workflow.js) — an autonomous cross-vendor repo triage and the broadest support-API tour: `pipeline` with no inter-stage barrier, a cross-vendor verification panel, `gate()` where writer and reviewer are different vendors, nesting a saved workflow by name, `completenessCheck()`, stage gating on tracked counters, string-form `args` hardening, path guards on schema outputs, and pause-class error rethrow.
- [`examples/quick-wins.workflow.js`](examples/quick-wins.workflow.js) — a small hunter that runs standalone *or* nested: `loopUntilDry()` with per-round vendor rotation, dedup threading via a `seen` list, and a tracked round bound (nested runs share the parent's limiter).

[`examples/README.md`](examples/README.md) maps each script to what it teaches.

## Automatic MCP validation and the terminal validator

The MCP `workflow` tool validates every run automatically before admission: static parse, mocked dry run, then routed no-prompt config checks. Invalid scripts return `status:"rejected"` diagnostics without creating a run ID, reserving a background slot, or spending tokens. When pinning model, mode, or `configOptions`, use `action:"config"` first.

Terminal and CI users can run the same zero-token validator explicitly:

```bash
npx @automatalabs/workflows validate my-workflow.js --args '{"target":"src/"}'
```

It does three passes. First, a **static parse**: the `meta` literal, syntax, and direct
nondeterministic call expressions. Second, a **dry run**: the engine runs the script's control flow
in its realm, with every `agent()` call served by a mock backend that fabricates
schema-conforming results — no real agent runs, and validation is not an execution of the
workflow. Third, one no-prompt session for each distinct routed `{ backend, model
}` pair. The third pass spends no tokens, selects each authored call model, and echoes that pair's
model-specific config-options table in the report. Read that table before picking `configOptions`
values; unknown ids, bad select values, wrong value types, and the reserved `"model"` key fail
validation with the call label, authored value, and alternatives. If a routed pair cannot spawn,
authenticate, select its model, or open a session, validation emits one warning, marks it
`probed:false`, skips only that pair's checks, and stays valid — the offline degradation behavior. A
mock live confirm answers checkpoints with `default ?? true`, so `headless: "pause"` dry-runs
cleanly; `headless: "abort"` warns because a truly unattended run would abort. Script-declared
`meta.backends` are treated as approved. The report lists every call with its backend attribution,
plus warnings for undeclared phases, `headless: "abort"` checkpoints, and zero agent calls.
(Option-domain clamping rules are in Backends and structured output; the full flag table and
mock-answer grammar are in `reference.md`.)

The default fabricator returns `true` for every boolean. Do not accept that all-true path as proof that a convergence loop works: script its control labels with `--mock-answers` or a reusable `--mock-answers-file`. Use a finite `$sequence` such as reject-then-approve so validation executes the revision branch and proves the loop stops; the report identifies every consumed and unused fixture without printing answer bodies.

Save reusable mock answers beside the workflow file (`<name>.mock.json`). When a default-fabrication dry run leaves declared phases unexecuted, your guard branches fired — script the mocks that reach past them instead of shrugging at the warnings.

Exit codes: `0` valid · `1` parse failure · `2` dry-run or config-option failure. The full flag table, mock-answers grammar, and limits are in `reference.md`.

The third pass's table is also available standalone — before any script exists — as validate's sibling command: `npx @automatalabs/workflows config [harness ...]` (default: every routable harness; `--json`; exit `1` when a probe fails). Use `config` while authoring to pick values; validate's copy then confirms the script you wrote against the same live catalog.

If the script nests saved workflows by name (`workflow("review-pr")`), pass the folder so names resolve — and the positional itself may then be a name: `npx @automatalabs/workflows validate review-pr --workflows-dir ./workflows`. A green dry run proves structure, not judgment — prompts and schemas still deserve review.
