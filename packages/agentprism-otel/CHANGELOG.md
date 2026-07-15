# @automatalabs/agentprism-otel

## 0.1.1

### Patch Changes

- f93fcf3: Consume the shared run-event payload contract through type-only imports and correlate agent/tool
  spans by `(scope, callIndex)` when present, with label-based compatibility retained. The structural
  `WorkflowManagerLike` attachment API and every existing exported payload type name remain
  unchanged, and `@opentelemetry/api` remains the package's only published runtime dependency.

## 0.1.0

### Minor Changes

- 68c0cff: New package: OpenTelemetry exporter for AgentPrism workflow runs — attach to any WorkflowManager
  to map runs to traces (run → root span, agent() → invoke_agent span, tool calls → execute_tool
  spans) and token/cost/duration metrics via @opentelemetry/api. No-ops without a registered SDK.
