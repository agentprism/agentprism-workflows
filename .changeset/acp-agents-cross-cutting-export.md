---
"@automatalabs/acp-agents": patch
---

Publish the `ACP_CROSS_CUTTING_EVENT_NAMES` export (added alongside the milestone-3 event forwarding, but the package was not republished with it). `@automatalabs/workflows` 0.8.0 imports it at runtime, so this release repairs the pairing; `workflows` picks up a dependency-cascade patch pointing at the fixed version.
