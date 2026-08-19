---
"@automatalabs/acp-agents": patch
---

Mechanical ACP dependency maintenance: bump `@agentclientprotocol/claude-agent-acp` 0.69.0 -> 0.70.0
(exact) and lift the wrapped `@anthropic-ai/claude-agent-sdk` override 0.3.234 -> 0.3.235.

0.70.0's only change is "switch providers for loaded Claude sessions" (#1002) — the Claude-side
analog of the codex-acp #404 we already integrated. It touches the adapter's own
`acp-agent.ts`/`index.ts` (applying stored provider selection when a session loads); the
`providers/list`/`set`/`disable` wire we consume is defined by `@agentclientprotocol/sdk` (unchanged
at 1.3.0), and our client already re-issues `providers/set` on every reconstructed connection, so no
integration code changes. 0.70.0 still exact-pins claude-agent-sdk 0.3.232 (< npm latest 0.3.235),
so the root `pnpm.overrides` pin is bumped to keep the wrapped-runtime freshness leg green (drop it
once the adapter catches up). SDK 0.3.235 is a "parity with Claude Code v2.1.235" release with no API
surface change; the runtime is wrapped behind the adapter and never imported directly.
