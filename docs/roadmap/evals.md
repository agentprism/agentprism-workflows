# Evals (`agentprism-evals`)

**Status:** next · **Updated:** 2026-07-14

A package for evaluating workflows the way the rest of the stack already thinks: at the
**workflow level**, not the single-agent level. The orchestrator's existing surfaces make two
kinds of evals unusually cheap, and this item turns them into a supported package the way
`agentprism-otel` did for tracing.

## The motivating question: substitution

Mixing harnesses and models in one script is the point of the orchestrator — but it creates a
question only evals can answer: *"can I run this workflow (or one step of it) on a cheaper
model or a different harness and still get a comparable outcome?"* Without evals the only way
to know is a blind end-to-end re-run and an eyeball diff.

Users who run a workflow regularly already own the baseline: every run persists its script, a
journal of schema-validated typed outputs keyed by deterministic call index, and token
usage/cost. **Substitution testing** treats those recorded successful runs as the eval
dataset: swap the candidate model/harness in, score the new outputs against the recorded
ones, and report a per-step and whole-workflow comparability verdict with the cost delta.
This is the flagship use case the package is designed around; generic output and process
evals fall out of the same machinery.

## Why workflow-level

A workflow's contract is its `meta`, its typed structured outputs, and its journal. Evaluating
"did the review workflow find the seeded bugs" or "did the migration touch every call site" is
a statement about the *run*, not about any one `agent()` call — and it is robust to swapping
backends (Claude/Codex/OpenCode/custom) underneath, which is precisely the comparison users
want to make.

## Two eval surfaces the stack already provides

1. **Output evals via typed results.** `agent({ schema })` and workflow return values are
   validated objects. An output eval is a plain assertion (or LLM-judged rubric) over a typed
   value — no transcript scraping.
2. **Process evals via journal replay.** Every run journals each `agent()` call and its
   result. Replaying a journal reconstructs the full trajectory deterministically, so process
   evals ("did the verifier stage actually run per finding", "how many rounds until dry")
   are post-hoc queries over recorded structure — they do not require re-running agents.

## Substitution mechanics the engine already fixes

- The journal's call-identity hash includes the **resolved model**, so a swapped call can
  never replay a stale cached result — cross-model comparisons are structurally safe.
- Journal resume replays the **longest unchanged prefix**: change the model on step N and
  resume, and steps before N replay free from the journal while N *and everything
  downstream* run live. That is **propagation mode** — "what does this swap do to the final
  outcome?" — and it works today with no new machinery.
- The `AgentRunner` seam is a first-class injection point. A record/replay runner that
  serves recorded results for every call except the target — which runs live on the
  candidate — gives **isolation mode**: upstream *and* downstream held fixed, a per-step
  verdict at per-step cost. This is leaf-package work; the engine doesn't change.

## Scoring "comparable"

Reliability ordering, exploiting that our outputs are typed:

1. **Deterministic field assertions** on schema-validated outputs first — outcome-defining
   fields get exact/structural checks with zero judge variance (guarding against
   over-strict assertions that would wrongly fail a valid different answer).
2. **Reference-guided LLM judge** only for residual free-text fields, with the recorded
   output as reference — judged in both presentation orders, length-aware, and never from
   the same model family as the candidate.
3. **Repetition, not single shots**: N samples per condition with an all-N-pass consistency
   metric — a cheaper model can look comparable once and fail on reliability.
4. Embedding similarity at most as a cheap drift tripwire, never a verdict.

## Planned shape

- Investigate **vitest-evals** as the harness: its harness-first API takes typed
  JSON-serializable outputs verbatim into judges, and its normalized session/transcript
  model maps closely onto our journal. Known gaps to bridge in our package: N-trial
  sampling/aggregation and model-matrix parameterization are userland; it requires
  Vitest 4 and is pre-1.0 (pin exactly). First spike: `runDynamicWorkflow` wrapped as a
  harness, one recorded run as fixture, one typed scorer, CI-runnable.
- A **trajectory sink**: a stable, documented projection of the journal (stages, agents,
  backends, checkpoint decisions) that scorers consume, so process evals don't couple to
  journal internals. Now also carries **per-call token usage/cost** — today only the
  run-level aggregate persists, and the per-step cost-vs-quality report needs the split.
- **Substitution reports**: the same recorded workflow scored across candidate
  models/backends, reusing the existing registry — per-step comparability verdicts plus
  cost deltas, rolled up to a whole-workflow answer.

## Open questions

- Isolation-mode keying: the runner isn't handed the deterministic call index, so a
  record/replay runner must key on prompt/label (or pin concurrency) — decide whether to
  thread the call index through `RunOptions` as a small engine addition.
- External substitution ergonomics: model is script-authored per call today; decide between
  script rewriting, a per-label model-override option on run options, or letting the
  injected runner reinterpret the model spec.
- Scorer authoring ergonomics: plain functions first; LLM-as-judge scorers only where rubrics
  genuinely need them (and then pinned + versioned).
- Where fixtures live (repo-local `evals/` convention vs. package-level).
- Whether journal replay needs a compatibility guarantee across engine versions to keep old
  recorded trajectories scoreable.
