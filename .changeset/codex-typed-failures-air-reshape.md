---
"@automatalabs/acp-agents": patch
---

Adapt the codex-acp negotiated typed-session-failures ("AIR") client to the reshaped wire the
`codex-acp` upstream sync (`47b57da`, PR #393 "align typed session failures with AIR protocol")
brings in. codex-acp collapsed its `jetbrains.air.sessionFailure` record to the coarser AIR
vocabulary: the 11 `SessionFailureCategory` values became six (`connection`, `access`, `limit`,
`request`, `service`, `unknown`), the actions became `retry` / `login` / `new_session`, and the
record dropped `phase` / `source` / `safeMessage` / `retryable` / `turnId` in favor of `severity`
(`error` | `warning`, absent ⇒ `error`), `title`, and optional `details`. The extension version is
unchanged (`1`), so our advertising CodexBackend still negotiates it and would otherwise silently
fail to parse the new record — a walled turn would look like an empty successful one.

`readTypedSessionFailure` now parses the new shape; `mapTypedSessionFailure` maps `access` →
AUTH_REQUIRED, `limit` → the resumable PROVIDER_USAGE_LIMIT unless the server flags a context/budget
ceiling with a `new_session` action (then fail-fast, preserving the previous split), `request` →
non-recoverable, and everything else → AGENT_EXECUTION_ERROR with `recoverable = actions.includes("retry")`
(the stand-in for the removed `retryable`). Advisory `severity: "warning"` records never enter the
failure latch. No public seam behavior changed for the conditions the two channels share.
