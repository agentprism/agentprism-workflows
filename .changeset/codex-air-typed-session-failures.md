---
"@automatalabs/acp-agents": minor
"@automatalabs/shared-types": minor
---

Adopt codex-acp's negotiated typed-session-failures extension (AIR) in the codex backend. The
backend now advertises the capability in `initialize.clientCapabilities._meta`, and the session
accumulator consumes both delivery channels the server opens in response: the terminal failure on
`PromptResponse._meta` and the asynchronous one on a `session_info_update`. Category + `retryable`
drive the seam classification — `auth_required` becomes `AUTH_REQUIRED` with the advertised-method
auth context, `rate_limited`/`quota_exhausted` become the resumable `PROVIDER_USAGE_LIMIT`, and
every other category becomes an `AGENT_EXECUTION_ERROR` whose recoverability is the server's own
`retryable` flag, so a `context_exhausted`/`policy_denied`/`bad_request` wall fails fast instead of
burning the engine's retry budget. Suggested actions ride the error's `details` and message. The
`cleared` phase retires a latched failure and a stale revision can never override newer state.

This closes a real gap the extension opens: with the capability negotiated the server stops
rejecting the request and stops streaming provider prose as assistant output, so a walled turn
would otherwise have looked like a successful empty one. An asynchronous failure is only applied to
a turn that produced no assistant text, so a late unattributed error never retroactively fails a
turn that answered.

`@automatalabs/shared-types` gains `CODEX_AIR_META_KEYS` / `CODEX_AIR_EXTENSION_VERSION`, the
mirrored wire names for the extension (source of truth: `packages/codex-acp/src/AirExtension.ts`).
Older codex-acp servers ignore the advertisement and keep their exact legacy error behavior, and
no other backend advertises or is affected.
