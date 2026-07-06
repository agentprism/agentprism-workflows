---
"@automatalabs/shared-types": patch
"@automatalabs/workflow-engine": patch
"@automatalabs/acp-agents": patch
"@automatalabs/mcp-server": patch
"@automatalabs/workflows": patch
---

Integrator hygiene: `recoverStaleRuns()` is now gated on the manager's `journaling` default — a `journaling: false` WorkflowManager (host keeps its own transcript/audit store) never rewrites persisted run state that belongs to journaling processes. All five published manifests now declare `engines.node >= 22` (previously only the private workspace root did).
