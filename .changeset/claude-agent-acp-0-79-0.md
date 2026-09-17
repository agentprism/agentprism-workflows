---
"@automatalabs/acp-agents": patch
---

Bump `@agentclientprotocol/claude-agent-acp` to 0.79.0. The adapter now pins `@anthropic-ai/claude-agent-sdk@0.3.274` itself, so the wrapped Claude Code runtime is unchanged and the workspace override that carried 0.3.274 ahead of the adapter is removed as redundant. Its one behavioral change is to shell-tool permission prompts (Bash and PowerShell): the permission `title` is the raw command rather than the tool's description, no longer whitespace-compacted or length-limited, and PowerShell gets the same `terminal_info` metadata as Bash. AgentPrism matches tool policy on the standard ACP `name` and uses `title` only as display decoration, so no adaptation is needed.
