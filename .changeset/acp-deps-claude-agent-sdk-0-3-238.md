---
"@automatalabs/acp-agents": patch
---

Mechanical ACP dependency maintenance: lift the wrapped `@anthropic-ai/claude-agent-sdk` root
`pnpm.overrides` pin 0.3.235 -> 0.3.238 (`@agentclientprotocol/claude-agent-acp` 0.70.0 is still npm
latest and still exact-pins 0.3.232, so the override stays; drop it once the adapter catches up).
0.3.236–0.3.238 are additive: `PostToolUse` `classifierContext`, `is_backgrounded`/`spawn_depth` on
`task_started`, `suppressOriginalPrompt` on `UserPromptExpansion`, a `command_lifecycle` `refused`
state, a fix for hook callbacks after a re-sent `initialize`, and per-branch `vcs_state_changed` events
— none of which touch turn results, stop reasons, or usage accounting, the only runtime surfaces we
observe through the adapter.
