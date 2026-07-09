---
"@automatalabs/shared-types": minor
"@automatalabs/acp-agents": minor
"@automatalabs/workflow-engine": minor
---

Error taxonomy for ACP auth: classify `AUTH_REQUIRED` code-first on `-32000` (reserved
exclusively for `authRequired`) so localized/rephrased auth messages no longer misroute
into the retry ladder, plus a guarded prose fallback for non-conformant agents (a different
reserved code that merely mentions the phrase never mis-routes). Adds a structured,
non-secret `AuthErrorContext` (`backendId` + advertised method `{id,type,name}[]`) carried on
`WorkflowError.authContext`, and an `isAuthRequired` type guard re-exported through
`@automatalabs/workflow-engine`. Behavior-preserving for the three first-class agents.
