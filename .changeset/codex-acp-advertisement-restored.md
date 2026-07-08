---
"@automatalabs/acp-agents": patch
---

Bump `@automatalabs/codex-acp` to 1.4.1. The 1.4.0 release was cut from the fork's `main` branch, which was missing the `agentCapabilities._meta` custom-capability advertisement that shipped in 1.3.0; 1.4.1 re-lands it, so the client's declared-capability gating for `outputSchema`/`baseInstructions`/`developerInstructions` operates on a real advertisement again instead of legacy passthrough. Docs updated to cite 1.4.1.
