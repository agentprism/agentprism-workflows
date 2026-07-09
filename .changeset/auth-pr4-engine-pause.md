---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
---

Engine pause-for-auth + cold-resume re-arm. `WorkflowManager` generalizes the
`PROVIDER_USAGE_LIMIT` pause branch so an `AUTH_REQUIRED` fault **checkpoints the run as
paused** (`reason: "auth_required"`) instead of failing it — the journal is preserved and
`resume()` can finish once the host completes auth. The pause persists the structured,
non-secret `authContext` (`backendId` + advertised method `{id,type,name}[]`) and carries it
on the `paused` event and the composed `WorkflowRunResult`; the intent's secret payload
(`authenticateMeta`/`envValues`) is never journaled, logged, or emitted (Principle 9).
`resume()` re-arms cold: for an `"auth_required"` pause it consults the injected runner's
`runner.auth.canResume(backendId)` (duck-typed — no package import) and immediately re-pauses
with `re-supply credentials for <backend> via runner auth before resuming` when an in-process
(gateway) / spawn-env intent was lost to a fresh process, while disk-backed intents (and warm
same-process resume) proceed. `WorkflowRunResult.authContext` and
`PersistedRunState.authContext` are added (both non-secret); `pauseReason` is already
free-form so no migration. Default-off is preserved: a run that never hits `AUTH_REQUIRED`
sees byte-identical behavior, and a runner with no `auth` controller re-pauses rather than
re-running into the same wall.
