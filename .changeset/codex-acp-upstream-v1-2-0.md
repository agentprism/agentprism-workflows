---
"@automatalabs/codex-acp": minor
---

Sync with upstream agentclientprotocol/codex-acp v1.2.0 (non-squashed subtree merge of `b51bedf`). Upstream adds a negotiated typed-session-failures extension (AIR): terminal turn failures ride PromptResponse metadata and asynchronous failures ride session updates, with restart-safe identities and deterministic recovery revisions — active only for clients that advertise the AIR extension capability in initialize `_meta`; clients that do not advertise it (including this monorepo's own acp-agents backend) keep the exact legacy error behavior. Also carries upstream's release-please CI scaffolding (inert in the fork) and a hono dev-dependency bump. Fork-owned surfaces (turn-level outputSchema forwarding, goal extension, `_session/loaded_turn`) are unchanged; the CodexEventHandler constructor keeps fork-owned parameters last, after upstream's new canonical parameters.
