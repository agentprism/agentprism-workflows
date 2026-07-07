---
"@automatalabs/agentprism-otel": minor
---
New package: OpenTelemetry exporter for AgentPrism workflow runs — attach to any WorkflowManager
to map runs to traces (run → root span, agent() → invoke_agent span, tool calls → execute_tool
spans) and token/cost/duration metrics via @opentelemetry/api. No-ops without a registered SDK.
