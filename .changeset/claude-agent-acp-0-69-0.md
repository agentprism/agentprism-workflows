---
"@automatalabs/acp-agents": patch
---

Mechanical ACP dependency maintenance: bump `@agentclientprotocol/claude-agent-acp` 0.67.0 -> 0.69.0
(exact) and lift the wrapped `@anthropic-ai/claude-agent-sdk` to 0.3.234 via a root `pnpm.overrides`
pin.

The two adapter minors add only the JetBrains "AIR" extension features — align typed session
failures (0.68.0, #992) and report changed files (0.69.0, #1001) — both gated behind an AIR client
capability our Claude backend does not advertise (only `CodexBackend` does), so they are inert for
the claude backend; no session-config, permission-mode, steering, or stop-reason surface changed.
All three adapter releases (0.67–0.69) exact-pin the same `@anthropic-ai/claude-agent-sdk` 0.3.232,
which is below npm latest 0.3.234, so the wrapped-runtime freshness leg needs the root override
(re-added — it was dropped in 216bc1c when the adapter briefly matched latest; drop it again once the
adapter catches up). 0.3.233/0.3.234 are additive (notification hooks, `ApiKeySource` values, an
optional `effort` on `SDKSystemMessage`) plus a TS-only removal of the never-emitted
`bypass_permissions_disabled` `ExitReason` we do not import; the runtime is wrapped behind the
adapter and never imported directly, so no ACP surface the Claude backend integrates against changed.

Verified: the protocol-coverage dist probes (steering advertisement, `AUTH_META_MATRIX`) still match
the installed 0.69.0 dist, and the docs-drift citations moved 0.67.0 -> 0.69.0.
