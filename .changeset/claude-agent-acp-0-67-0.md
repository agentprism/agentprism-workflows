---
"@automatalabs/acp-agents": patch
---

Mechanical ACP dependency maintenance: bump `@agentclientprotocol/claude-agent-acp` to
0.67.0 (exact), which wraps the current `@anthropic-ai/claude-agent-sdk` 0.3.232, and
remove the root `@anthropic-ai/claude-agent-sdk` pnpm override — the override existed only
because prior adapter releases pinned the SDK below npm latest, and 0.67.0 pins it at
latest, so the override is obsolete. No integrated surface changed; verified by the live
backend e2e suite at push time.
