---
"@automatalabs/acp-agents": patch
---

ACP maintenance: bump `@agentclientprotocol/claude-agent-acp` to 0.65.0 and lift the
wrapped Claude runtime to `@anthropic-ai/claude-agent-sdk@0.3.223` via the root
`pnpm.overrides` pin (the adapter still exact-pins 0.3.220).

Upstream 0.65.0 fixes premature `session/prompt` resolution during steering: the turn no
longer settles with `end_turn` while steered work is still running. The `SteeringOutcome`
values are unchanged, so this is a strict improvement to the `prompt()` await path — we
pass the outcome through untouched and never treated `end_turn` as "steered work done".

Version citations in `docs/design-notes.md`, `docs/api.md`, and the `ClaudeBackend` header
comment move with the bump.
