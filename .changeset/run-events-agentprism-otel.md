---
"@automatalabs/agentprism-otel": patch
---

Consume the shared run-event payload contract through type-only imports and correlate agent/tool
spans by `(scope, callIndex)` when present, with label-based compatibility retained. The structural
`WorkflowManagerLike` attachment API and every existing exported payload type name remain
unchanged, and `@opentelemetry/api` remains the package's only published runtime dependency.
