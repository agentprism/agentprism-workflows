# Content-addressed incremental resume

**Status:** next · **Updated:** 2026-07-15

Resume today replays the **longest unchanged prefix**: journal entries are matched positionally
by call index with the call-identity hash as a guard, and a single global cursor marks the first
miss — the first changed call and *every* call after it run live, including calls in independent
parallel branches whose own identities are unchanged. That rule is simple and safe, but it makes
iterated re-runs expensive in exactly the workflows the engine is built for: change 2 inputs out
of 40 in a fan-out stage and the 38 untouched siblings re-run anyway, purely because their index
sits after the first miss.

The substrate for something better already exists. Every call persists an identity hash (prompt,
resolved model, mode, tier, phase, agentType, resolved agent definition, schema), a structural
call-path key, and an input fingerprint — and the evals isolation runner already performs
**identity-keyed** replay (`kind`/`path`/`hash`), serving recorded results for every call except
selected live targets. Because inter-call data flow travels through prompt interpolation, the
dependency graph is implicitly content-addressed: a downstream call whose upstream inputs changed
sees a changed prompt and misses naturally, while untouched subgraphs keep their hashes and
replay.

## Direction

Generalize identity-keyed replay from the isolation runner into mainline `resumeFromRunId`:
cache hits by call identity rather than position, so unchanged calls replay regardless of where
the first edit landed, and changes propagate through the hashes themselves.

## Hard questions the contract must settle

- **Filesystem-mediated dependencies.** Agents write files that later agents read; that flow is
  not visible in prompts, so pure content-addressing is unsound without additional rules.
  Candidate mitigations to weigh: environment/working-tree fingerprints as replay gates,
  conservative invalidation for calls downstream of any live call, per-call purity/eligibility
  annotations, and interaction with worktree isolation.
- **Ambiguous call paths** — loops that issue identical calls from the same call site (the
  isolation runner currently refuses to serve ambiguous paths).
- **Checkpoints** — identity-keyed replay of journaled human decisions and `checkpointReplies`.
- **Budget accounting** — what budget replay means when replay is no longer a contiguous prefix.
- **Nested workflows**, which the isolation runner does not currently serve.
- **Back-compat** — positional journals from earlier engine versions must keep resuming; whether
  the new matching is opt-in, default-with-fallback, or a journal-format version gate.
- **Session records** — re-attach records for replayed vs. live calls.

The existing prefix rule stays the correctness baseline: wherever an eligibility rule is in
doubt, the resolution is "run live", never "serve a stale result".
