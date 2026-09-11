## Worked example — cross-vendor build with every major primitive

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

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
  { kind: "confirm" },
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

## Worked example — audit with one shared backend route

All agent calls and quality helpers inherit `meta.model`. Change that one backend-only route to
use another configured backend; the backend selects its own default model.

```js
export const meta = {
  name: "edge-case-audit",
  model: "codex",
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

## Automatic preparation before live execution

The MCP `workflow` tool checks source structure, then prepares the script inside the Run request with a mocked dry run and routed no-prompt config checks before admitting execution. Every actual agent call must have an effective model; no configuration form fills missing routing. Malformed source/meta and validation failure are tool execution errors: no run exists and no live agent is dispatched. A script declaring custom backends is validated, then parked with a backend-approval `setup.request` that `setup-response` answers. When pinning model, mode, or `configOptions`, use `action:"config"` first.

The mocked pass executes reachable script control flow with schema-conforming fabricated agent results. It simulates explicit checkpoint replies, including `true` for confirm, with journaling disabled; simulated answers cannot approve live work. It can prove that syntax, metadata, helper calls, and reachable branches are structurally executable, but it cannot prove prompt quality, real-world judgment, or convergence through every branch. Keep loops bounded in script code and inspect validation warnings for declared phases that the fabricated path did not reach.

The routed config pass probes each distinct backend/model pair without prompting. Unknown option ids, invalid select values, wrong value types, and the reserved `"model"` config key reject the script with direct alternatives. A backend that cannot be probed produces an explicit warning and leaves only that backend's option domain unverified.

For model/config details, read [`models-and-config.md`](models-and-config.md). For exact-run recovery semantics, read [`determinism-and-resume.md`](determinism-and-resume.md).
