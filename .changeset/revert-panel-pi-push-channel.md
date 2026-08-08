---
"@automatalabs/mcp-server": patch
"@automatalabs/workflows": patch
---

Revert the run-monitor panel pi push-channel change that shipped in
mcp-server@0.26.6 / workflows@0.46.9 (owner decision: wrong implementation;
a spec-compliant approach to app-resource-less hosts will follow). Restores
the prior panel read path.
