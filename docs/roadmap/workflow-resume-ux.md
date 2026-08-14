# Workflow resume UX — the world-blind contract

**Status: DRAFT — awaiting owner blessing of the [C] ledger (§6). Design doc only; no build
is authorized by this document.**

Provenance markers, per the established convention: **[D]** owner-decided in conversation
(2026-08-14), **[F]** verified fact (code, wire, or live-run evidence), **[C]**
drafter-closed specifics awaiting owner veto/bless.

---

## 1. The principle

[D] Owner, verbatim: *"our tool shouldn't care about the surface of the world changing
ever. We need to make our tool world blind. We're trying to solve problems we shouldn't
care about."*

[D] Owner, verbatim: *"The agents that are using the tool are intelligent - they will know
if something should be replayed or not."*

[D] Owner, verbatim: *"Agents get way too confused with the current behavior in terms of
resuming, its too complicated and there are way too many scenarios where replays dont work
when agents expect them to."*

The derived design stance: the journal is a faithful, world-blind record with honest
mechanics. **Deciding what re-runs is the agent's judgment; the tool's job is to make
expressing that judgment trivial and to never lie about its own bookkeeping.** The
content-addressed replay core (identity + input fingerprint, fail-to-live on
non-correspondence, filesystem never gates replay) is a feature and stands unchanged.

## 2. The evidence (repl-v2 build, 2026-08-13/14) [F]

An expert operator (this repo's orchestrating session, reference docs loaded) hit three
distinct resume traps in one workstream:

1. **Failed-gate verbatim replay** (run `mss4906m-f3tt3p`): after out-of-band fix commits
   landed on the branch, a resume replayed all 8 recorded calls in ~20 ms to the identical
   `review-failed` terminus. Correct per the world-blind spec — but the operator had no way
   to say "re-run the reviews." The workaround was editing the reviewer prompt to change
   its identity hash (a "REVISION marker"), i.e. smuggling a one-integer decision through
   prompt bytes. It then had to be refined to a *phase-conditional* marker so other phases'
   recordings kept replaying — arcana stacked on arcana.
2. **Abort-residue all-live** (run `msshqbdt-95hhd9`): resuming from a deliberately stopped
   run silently disabled replay wholesale (`strategy: "live", disabledReason:
   "abort-residue"`). The run would have re-executed a ~100-minute recorded implementation
   live onto an already-built worktree. The only warning was a diagnostic field readable
   *after* admission. Recovery required knowing to stop it and resume from the newest
   *completed* ancestor instead.
3. **Misleading prediction**: `predictedReplayablePrefix` reported 8 (later 12) at
   admission when the actual replayed prefix was 1 (later 5) — the estimate ignores the
   very script edits the caller just made, misleading in exactly the moment it exists for.

[F] The asymmetry that frames item 2: **paused** runs (`AUTH_REQUIRED`, observed
`msr33814 → msrrqadf`) and **interrupted** runs (dead-owner reconcile) resume with full
prefix replay. Only the *deliberate, orderly* stop — the termination where the engine
itself cancels the in-flight call, knows exactly which calls settled, and durably appends
`stopped` — is punished with all-live. The best-informed termination is treated as the
least trustworthy.

## 3. Design changes

### R1 — Replayable aborts

The orderly-stop path seals what it already knows: settled journal rows stand; the
in-flight call(s) it cancelled are recorded as cancelled-with-no-result. Resume from an
aborted run then behaves exactly like the paused case — the prefix replays, and the
cancelled call runs live under the **existing** per-call fail-to-live rule. No blanket
`abort-residue` disable; nothing world-aware is added.

- [F] Basis: settled rows are durably journaled at settlement (the crash-recovery design);
  doubt is already handled per-call everywhere else; the stop path has strictly more
  information than the crash path that *does* get replay.
- [C]1 Verification gate: a focused read of the stop/seal path in `workflow-engine` must
  confirm no invariant (event store, checkpoint injection mid-abort) genuinely blocks
  this. If one does, the fallback is a **loud refusal naming the newest completed ancestor
  in the lineage** — never a silent all-live downgrade.

### R2 — The agent states the replay boundary: `liveFrom`

A new resume parameter (`liveFrom: <callIndex>`, name [C]2): replay the journal prefix
through call `liveFrom − 1`, run live from `liveFrom` onward — regardless of identity
match. This is the agent expressing "the work before N stands; N and after must re-run,"
which is precisely the judgment the world-blind principle assigns to the agent. It
replaces prompt-identity surgery (the REVISION-marker workaround) with one integer.

- [C]3 Shape: valid only with `resumeFromRunId`; integer within the source journal's call
  range; `liveFrom: 0` = everything live; omitted = today's pure identity matching.
  Calls after `liveFrom` never replay even on identity match (the boundary is authored,
  not advisory).

### R3 — Honest prediction

`predictedReplayablePrefix` is computed against the **submitted** script and args (both in
hand at admission), not the source journal's shape alone. Where exact computation is
possible, it is exact; where not, the field name/docs say "upper bound" explicitly.
[C]4 The tool description documents in one sentence what invalidates identity (prompt,
model, mode, configOptions, tier, phase, agentType, agentDef, schema) so authors stop
discovering it empirically.

### R4 — World-blindness sweep

[D] The explicitly rejected direction, on record: any world-change surfacing or warnings
(e.g. "recorded results predate the current tree — they will replay anyway") is out —
*"We're trying to solve problems we shouldn't care about."*

- [C]5 Deletion: the `environment.git.head` row in `provenanceChanges` — the one place the
  tool inspects the world today — is removed.
- [C]6 Retention boundary: engine-version and inputs-format provenance stay (the tool's
  OWN mechanics, not the world's surface).

### R5 — Contract documentation

[C]7 The workflow tool description states the model plainly: replay is content-addressed
on call identity; world state never gates nor influences replay; the agent owns re-run
decisions (via `liveFrom`); aborted runs resume like paused ones (post-R1).

## 4. Non-goals

[D] No world-awareness, ever — no filesystem/git/HEAD inspection, no staleness heuristics,
no "should this replay?" inference. [D] No silent degradations: every admission-time
decision the engine makes about replay is visible in the acknowledgment, and refusals name
their remedy. [C]8 No auto-ancestor *resolution* (superseded by R1; and choosing a
different journal than the one the agent named is the tool making an agent decision).

## 5. Relationship to repl-v2

Same diagnosis family as `docs/roadmap/repl-eval-redesign.md`: engine-internal correctness
vocabulary (identity hashes, quiescence proofs, lineage) leaking into the agent-facing
contract. Separate workstream; sequenced after repl-v2 ships. The repl-v2 build itself is
unaffected — its monitor crons already carry the operational workarounds.

## 6. The [C] ledger (one-pass veto/bless)

1. R1 verification gate + loud-refusal fallback if a real invariant blocks replayable aborts.
2. Parameter name `liveFrom` (alternative: `rerunFrom`).
3. `liveFrom` shape/validation semantics as specified.
4. Identity-field documentation sentence in the tool description.
5. Delete `environment.git.head` from `provenanceChanges`.
6. Retain engine-version / inputs-format provenance.
7. Contract-documentation wording scope (R5).
8. No auto-ancestor resolution (loud refusal only, and only under the R1 fallback).
