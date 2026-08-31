---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/acp-agents": minor
"@automatalabs/workflows": minor
"@automatalabs/mcp-server": minor
---

Add live workflow permission brokering and explicit first-class mode defaults. MCP inspect/await now expose pending ACP permission requests through a credential-redacted 64 KiB projection that omits private session ids while preserving the complete ordered exact option set or failing closed. Elicitation-capable clients can answer those options, and other clients can use the new `permissions-response` action; public responses forbid caller metadata and route to the daemon generation that owns execution. Permission waits suspend idle detection without stopping the total-wall clock. Config output now preserves harness mode names, descriptions, metadata, and reports the AgentPrism defaults (`auto`, `agent`, `build`, or none). Replace the inaccurate permission-persistence helpers with exact advertised-option selection while retaining deprecated source-compatible shims.
