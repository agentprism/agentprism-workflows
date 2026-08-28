---
"@automatalabs/codex-acp": minor
"@automatalabs/acp-agents": patch
---

Sync the Codex ACP fork with upstream `main` through `69ca755` using a non-squashed subtree merge. The upstream change adds standard ACP `session/fork`: Codex forks the source thread, returns and installs the independent session, advertises `sessionCapabilities.fork`, and supports optional AIR message-specific fork points. The conflict resolution preserves AgentPrism's loaded-turn terminal-state fields alongside upstream's new/fork/resume operation split.

Refresh the wrapped Claude Agent SDK runtime override from 0.3.250 to 0.3.251. The new release adds model-switch hooks and resume cache-cost metadata plus Claude Code runtime/security fixes; claude-agent-acp does not configure the new hooks, and the turn-result, stop-reason, usage, and structured-output surfaces used by acp-agents remain compatible.
