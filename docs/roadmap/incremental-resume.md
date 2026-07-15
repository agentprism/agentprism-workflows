# Content-addressed incremental resume

**Status:** implemented by [`incremental-resume-spec.md`](../specs/incremental-resume-spec.md) · **Updated:** 2026-07-15

Mainline `resumeFromRunId` now uses the content-addressed identity-v1 contract. After exact
runtime/cwd/terminal-environment admission, safety-marked agent results and proven host checkpoint
decisions match by exact path/hash or a unique hash+input fingerprint. An inserted, deleted, or
changed fan-out sibling can run live while unchanged independent siblings replay; ambiguity,
missing proof, environment drift, and every other uncertainty run live.

Authors opt eligible agents in with `resume: { filesystem: "read-only" }`. Successfully created
throwaway worktrees may contain ordinary checkout edits, but worktree isolation alone is not a
safety proof and every effect outside the checkout remains forbidden. Unsafe but stable
new-format sources can use a safety-checked positional prefix; nested or source-drifted fallback
is all-live. Marker-less/manual/same-ID legacy journals retain historical positional behavior.

Identity hits apply their preserved logical budget debit to script-visible budget gates while
adding zero current provider usage. Replayed sessions rebind to current call context. Checkpoint
replay is host-decision-only, requires an equal `default`/`headless`/`timeoutMs` fingerprint, and
accepts durable replies keyed by source index even when the matched current checkpoint shifted.

## Implemented contract

The frozen contract resolves the original design questions:

- [Frozen incremental-resume specification](../specs/incremental-resume-spec.md)
- [Public API, reports, reasons, and filesystem boundary](../api.md#content-addressed-incremental-resume)
- [Workflow authoring guidance](../../skills/agentprism-workflow-authoring/SKILL.md#determinism-and-resume)

The lasting invariant is fail-to-live: no path serves a possibly stale cached result.
