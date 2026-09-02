# Evals (`agentprism-evals`)

**Status:** replay substrate implemented · scoring/report UX next · **Updated:** 2026-07-15

The isolation substrate contract (reviewed baseline) lives in
[`docs/specs/evals-isolation-spec.md`](../specs/evals-isolation-spec.md). Propagation mode is
available today through journal resume, and isolation mode is implemented through `runIsolation`,
`createReplayRunner`, the per-call manifest, and `ReplayReport`. The next roadmap stage is the evals
harness itself: scoring, repetition/model matrices, vitest-evals integration, and report UX that
consume `ReplayReport` plus the manifest.

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

## Implemented substitution mechanics

- The journal call hash covers the script-requested model and deterministic call inputs; the
  manifest separately records positive requested/resolved/fallback evidence for honest baseline
  model attribution.
- Journal resume replays the **longest unchanged prefix**: change the model on step N and
  resume, and steps before N replay free from the journal while N *and everything
  downstream* run live. That is **propagation mode** — "what does this swap do to the final
  outcome?" — and it works today with no new machinery.
- The engine's `createReplayRunner` serves recorded results for every call except the live target,
  with call paths, input fingerprints, environment identity, and strict
  fail-closed divergence checks. The SDK's `runIsolation` executes that composition end to end and
  persists a quarantined artifact plus `ReplayReport`: upstream *and* admissible downstream calls
  are held fixed for a per-step comparison. Scripts outside the proven correspondence envelope use
  propagation mode.

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

## Next stage

- Investigate **vitest-evals** as the harness: its harness-first API takes typed
  JSON-serializable outputs verbatim into judges, and its normalized session/transcript
  model maps closely onto our journal. Known gaps to bridge in our package: N-trial
  sampling/aggregation and model-matrix parameterization are userland; it requires
  Vitest 4 and is pre-1.0 (pin exactly). First spike: `runDynamicWorkflow` wrapped as a
  harness, one recorded run as fixture, one typed scorer, CI-runnable.
- Build scorer-facing trajectory helpers over the now-public `WorkflowCallRecord` manifest and
  `ReplayReport`, rather than coupling scorers to storage paths or raw journal internals. Per-call
  baseline and candidate usage already ride the report's `recordedUsage`/`liveUsage` cost surface.
- **Substitution reports**: the same recorded workflow scored across candidate
  models/backends, reusing the existing registry — per-step comparability verdicts plus
  cost deltas, rolled up to a whole-workflow answer.

## Open questions for the scoring package

- Scorer authoring ergonomics: plain functions first; LLM-as-judge scorers only where rubrics
  genuinely need them (and then pinned + versioned).
- Where fixtures live (repo-local `evals/` convention vs. package-level).
- Report presentation: terminal/JSON first, then decide whether richer artifact comparison belongs
  in the evals package or a separate UI consumer.
