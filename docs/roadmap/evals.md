# Evals (`agentprism-evals`)

**Status:** next · **Updated:** 2026-07-10

A package for evaluating workflows the way the rest of the stack already thinks: at the
**workflow level**, not the single-agent level. The orchestrator's existing surfaces make two
kinds of evals unusually cheap, and this item turns them into a supported package the way
`agentprism-otel` did for tracing.

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

## Planned shape

- Investigate **vitest-evals** as the harness: `runDynamicWorkflow` as the task function,
  workflow fixtures as cases, scorers over typed outputs. First spike is exactly that — one
  workflow, one scorer, CI-runnable.
- A **trajectory sink**: a stable, documented projection of the journal (stages, agents,
  backends, token usage, checkpoint decisions) that scorers consume, so process evals don't
  couple to journal internals.
- Backend matrices: the same eval suite parameterized over backends, reusing the existing
  registry — the "same script, different agents" comparison as a first-class report.

## Open questions

- Scorer authoring ergonomics: plain functions first; LLM-as-judge scorers only where rubrics
  genuinely need them (and then pinned + versioned).
- Where fixtures live (repo-local `evals/` convention vs. package-level).
- Whether journal replay needs a compatibility guarantee across engine versions to keep old
  recorded trajectories scoreable.
