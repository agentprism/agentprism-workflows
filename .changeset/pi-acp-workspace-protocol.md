---
"@automatalabs/acp-agents": patch
---

Declare the built-in `@automatalabs/pi-acp` dependency via the `workspace:*` protocol (exact version stamped at publish) so joint release PRs resolve before the new pi-acp version is published; the ACP dep gate no longer tracks the workspace sibling and docs cite it unversioned.
