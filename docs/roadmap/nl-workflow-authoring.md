# Natural-language workflow authoring

**Status:** designed · **Updated:** 2026-07-10

Let users describe a workflow in conversation and get a correct, runnable script — without
letting "an LLM wrote some JavaScript" anywhere near production runs unchecked. The design has
two halves: a grounded authoring session and a four-layer validation gauntlet.

## Authoring

An **InteractiveSession** (the existing multi-turn runner surface) drives an agent whose
context is a **versioned DSL spec pack**: the authoring guide, the type definitions, and a
curated set of exemplar scripts. The pack is versioned alongside the engine so generated
scripts target the DSL that will actually execute them — the generator never free-recalls the
API from training data.

## The four validation layers

Every generated (or edited) script passes, in order:

1. **`parseWorkflowScript`** — the real parser: syntax, the mandatory `meta` literal,
   determinism constraints (no `Date.now()`/`Math.random()`), banned APIs.
2. **Lint** — DSL-specific rules that parsing can't see: barrier-vs-pipeline misuse,
   unvalidated structured-output fields, unbounded loops without budget guards,
   string-form `args` handling.
3. **MockRunner dry run** — execute the script with agents mocked **at the AgentRunner
   seam**, returning schema-fabricated values. Proves control flow, schema plumbing, and
   stage wiring end-to-end with zero token spend.
4. **Capped trial run** — a real execution under a small token budget and reduced fan-out,
   surfacing the failures only live agents produce, before the user trusts the script at
   full scale.

Layer 3 is the linchpin: because every backend already sits behind the same `AgentRunner`
interface, mocking that one seam makes the entire engine — `parallel`, `pipeline`,
checkpoints, budgets — run for real while the agents are fake.

## Open questions

- Whether authoring output is a script alone or a script + eval fixture pair (tying into
  [evals](evals.md)).
- How edit-loops work after a failed layer: auto-repair with the diagnostic fed back vs.
  surfacing to the user.
