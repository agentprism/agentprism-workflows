---
"@automatalabs/codex-acp": patch
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `ba5bcc3`,
upstream releases v1.5.1 through v1.6.2 plus two post-release fixes). Upstream changes:
`@openai/codex` ^0.147.0 -> ^0.148.0 with regenerated app-server v2 types (#410); release-pipeline
hardening — e2e/apt timeouts, `vitest --no-file-parallelism --retry=2` (#413, 86e0772, 51e011f);
suppress late `available_commands_update` publishes after `session/close` via the
session-generation guard (#418); device-code login now emits `elicitation/complete` and resolves
when the login finishes before the elicitation response (#421); `@agentclientprotocol/sdk` ^1.3.0 ->
^1.4.0 and dev-dep bumps (#422). `misalignmentPolicyViolation` maps to the existing `policy_denied`
category and `thread/reverted` / `thread/queue/changed` join the ignored-notification list. Fork-owned
surfaces (turn-level `outputSchema` forwarding, goal extension, `_session/loaded_turn`) auto-merged
without conflict; conflicts resolved by the standard policy (fork `package.json` version/description
kept with upstream's dependency changes; fork's deleted `package-lock.json` and `.github/workflows`
stay deleted; the changesets-owned `CHANGELOG.md` kept ours).
