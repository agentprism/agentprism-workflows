---
"@automatalabs/workflows": minor
---

SDK facade auth exports (§4.2). `@automatalabs/workflows` now re-exports the
`isAuthRequired(error)` VALUE guard next to `isProviderUsageLimit`, resolving through the
`@automatalabs/workflow-engine` chain threaded in the error-taxonomy work, so an embedder can
classify an `AUTH_REQUIRED` fault (and read the non-secret `WorkflowError.authContext`) with the
same one-liner it already uses for usage limits. The runner-facing auth TYPE surface
(`AuthResolver`, `AuthContext`, `AuthResolution`, `AuthMethodDescriptor`, `CompleteAuthOptions`,
`AuthOutcome`, `AuthController`, `AuthStatusSnapshot`, `AuthCapableRunner`, `AuthErrorContext`)
is already surfaced through the facade. No new behavior and no runtime change: `createAcpRunner`
and `runDynamicWorkflow` already spread `authCapabilities`/`onAuth` through, so this PR is a
pure export-surface addition.
