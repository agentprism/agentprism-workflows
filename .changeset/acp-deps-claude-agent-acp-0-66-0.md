---
"@automatalabs/acp-agents": patch
---

ACP maintenance: bump `@agentclientprotocol/claude-agent-acp` to the exact pin `0.66.0` (from
`0.65.0`).

Mechanical relative to our integration surface. 0.66.0 ships one dev-dependency bump (`globals`
17.8.0 → 17.9.0), a feature — a provider-neutral ACP **goal** extension (#964) — and a bug fix
(publish/replace Claude goals reliably, #967). None of these touch the surfaces the Claude backend
integrates against: the session-scoped `_meta.claudeCode` structured-output channel
(`outputFormat` + `emitRawSDKMessages`), the auth/provider methods, session lifecycle, and native
`_session/steering` are all unchanged. The new goal extension is additive ACP surface that
`@automatalabs/acp-agents` does not advertise, request, or observe (no `goal` reference exists in
the runner), so it requires no adaptation. It is a currently-unconsumed capability the adapter now
exposes (mirroring the codex-acp `thread/goal/*` control landed in the same-day upstream sync) —
worth a tracking issue if we later want to drive goals through the runner, but not required to
unblock the gate.

Override decision — **retained, not dropped.** `@agentclientprotocol/claude-agent-acp@0.66.0`
still exact-pins `@anthropic-ai/claude-agent-sdk@0.3.220` (verified against the registry), which is
behind npm `latest` `0.3.224`, so the root `pnpm.overrides` entry pinning the wrapped runtime to
`0.3.224` continues to carry it forward to latest and stays in place. Dropping it (as commit
`4b306e1` did once the adapter had genuinely caught up) would revert the resolved runtime to
`0.3.220` and re-fail the gate's wrapped-runtime check. Drop it only once a future adapter release
pins `>= latest`; the gate warns automatically when the override becomes redundant.
