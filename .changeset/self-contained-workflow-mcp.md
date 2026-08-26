---
"@automatalabs/acp-agents": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
"@automatalabs/mcp-server": minor
---

Make the workflow MCP surface self-contained: add protocol-native live backend/config discovery, automatically run zero-token static and mocked validation before admission, return bounded structured rejection diagnostics without creating a run, and publish compact DSL guidance directly in the tool description and bundled authoring prompt. Reuse the server's live ACP runner for probes, including approved run-scoped backend definitions, without disposing host-owned runners.
