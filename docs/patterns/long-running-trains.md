## Long-running implementation workflows

Hard-won rules for workflows whose implement/review rounds span hours against a repository that
keeps moving. Each of these prevented — or would have prevented — a real terminal-verdict blocker:

- **Fix where the train lives before round one.** Verify an args-supplied workroot in a preflight
  step (expected branch, recorded base, clean tree — refuse on mismatch) or have a setup call create
  a persistent sibling worktree idempotently; never commit onto whatever the run cwd happens to have
  checked out. The execution-environment section spells out both patterns.
- **Pin a base and check it every round.** A brief that says "based on origin/main" names a moving
  target. Have the implementer record the exact base SHA it built against (e.g. into a gitignored
  `base-sha.txt`), and make every reviewer compare `git ls-remote origin refs/heads/<default>`
  against it as a structured verdict field (`ls-remote` reads the remote without mutating the shared
  checkout; reserve `git fetch` for throwaway worktrees). Reviewers grounded in a stale worktree will confidently
  "verify" claims against the wrong tree — in one run, fourteen of fifteen agents (including the
  final adjudicator's first pass) validated against a base nine commits behind, and the decisive
  blocker was visible only to the single reviewer that fetched. At least one gate lens should
  build/test against the LIVE default branch, where upstream drift surfaces as a compile failure
  instead of an opinion.
- **A missing cited mechanism means stop, never re-implement.** If the spec cites an engine field or
  API that does not exist on the implementer's tree, the correct move is to halt and report the
  discrepancy — the overwhelmingly likely cause is a stale base, not a wrong spec. The plausible
  fallback ("build the equivalent at my own layer") produces a parallel implementation that collides
  with the real mechanism on rebase. Put that instruction in the implementer's prompt verbatim.
- **Reconcile contradictory reviewer directives before obeying either.** With multiple independent
  lenses across rounds, one reviewer can demand a subsystem that another later demands removed. The
  implementer will obey whichever spoke last; the conflict then lands unresolved on the terminal
  adjudicator. When a round's feedback contradicts an earlier round's, the workflow owner (or an
  explicit adjudication step) decides — not the implementer.
- **Never hand the adjudicator unaddressed final-round blockers.** A gate capped at N rounds ends
  with round N's findings unfixed by construction. Budget one bounded post-gate fix pass (judged by
  the terminal adjudicator directly, no re-review) or run the adjudicator before the final round.
- **The report and HEAD must be the same commit.** An implementer that keeps committing after filing
  its structured report makes the review target a moving object — reviewers certify a branch state
  that no longer exists. Require the report's SHAs to be the branch tip, and treat post-report
  commits as a blocking process violation. Enforce it with values, not prose: the producer schema
  carries a full 40-character `headSha` that script code checks equals the last reported commit,
  each reviewer schema carries the `reviewedHeadSha` it actually inspected, and script code compares
  the two — an attested boolean ("I reviewed the right commit") is worthless next to an SHA equality
  check that costs nothing.
- **Verify the brief's own premises against the live tree.** A brief assertion about engine behavior
  ("seeds persist on every resumed run") that is false at HEAD forces the implementer into
  ungrounded redesigns mid-flight. Cited behaviors deserve the same file:line grounding the spec
  gets.
- **Design artifacts live OUTSIDE the worktree and survive it.** Briefs, review files, base pins, and adjudication reports go in a design directory beside (never inside) the worktree — a mid-run reset or worktree removal must not destroy the record the adjudicator needs. The persisted run state, not your scratchpad copy, is the replay-identity ground truth for the script itself.
- **Re-verify external pins with fresh clones, every round.** A dependency pinned at authoring time can be superseded mid-train (fast-moving upstreams release daily). Reviewers fetch a FRESH temp clone and confirm the pin still equals the upstream's current release; the spec carries an implementation-time re-verification clause obligating the implementer to repeat the check and STOP on drift. A pinned checkout that was fresh yesterday is a stale checkout today.
- **No uninvited resource caps.** A structurally bounded workflow (fixed rounds × fixed fan-out +
  one adjudication) cannot run away; a token budget adds no protection but adds a new failure mode —
  the mid-flight kill that wastes live work. Add caps only when the structure itself is unbounded,
  sized from per-role estimates (one xhigh implement + one four-reviewer verify round with full test
  suites ≈ 3M tokens).
- **Cancel live outliers explicitly.** At the concurrency cap, one slow `parallel()` branch occupies
  one slot while other finished branches release theirs. For a live outlier that
  should stop without tearing down completed siblings, inspect its deterministic index and send
  `{ action: "stop", runId, callIndex }`; host cancellation also settles `null`, frees the slot, and
  deliberately skips retries.
