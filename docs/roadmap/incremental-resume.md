# Content-addressed incremental resume

**Status:** implemented · **Updated:** 2026-07-21

Mainline `resumeFromRunId` uses content-addressed identity-v1 correspondence. Completed calls match
by exact path/hash or a unique hash+input fingerprint. An inserted, deleted, or changed sibling can
run live while unchanged independent calls replay; ambiguity, missing identity facts, incompatible
formats, and invalid journal structure fail to live execution.

Filesystem state, environment drift, safety annotations, nested workflows, live writers, and
worktree outcomes do not gate replay or clear later candidates. They are either ordinary runtime
behavior or diagnostics. The legacy `resume: { filesystem: "read-only" }` field remains readable
but is replay-neutral and should be omitted from new scripts.

Identity hits apply their preserved logical budget debit to script-visible budget gates while
adding zero current provider usage. Replayed sessions rebind to current call context. Completed
checkpoint results replay regardless of host/headless origin when their
`default`/`headless`/`timeoutMs` fingerprint agrees; durable replies remain keyed by source index
and may follow a shifted checkpoint only while prior correspondence is intact.

## Implemented contract

The frozen contract resolves the original design questions:

- [Current journal replay contract](../specs/journal-replay-contract.md)
- [Historical incremental-resume specification](../specs/incremental-resume-spec.md)
- [Public API and reports](../api.md#content-addressed-incremental-resume)
- [Workflow authoring guidance](../../skills/agentprism-workflow-authoring/SKILL.md#determinism-and-resume)

The lasting invariant is fail-to-live on correspondence uncertainty. World-state uncertainty is
not correspondence uncertainty and never forces token re-spend.
