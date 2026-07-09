---
"@automatalabs/acp-agents": minor
---

Client auth capability advertisement (§1.2), default-OFF. `AcpRunnerOptions` gains
`authCapabilities?: { terminal?; gateway? }`, threaded through the pool and every dedicated
connection into the one-time `initialize` handshake. When set, the client advertises
`clientCapabilities.auth.terminal` + the top-level `_meta["terminal-auth"]` channel (terminal
logins) and/or `auth._meta.gateway` (Claude/Codex gateway methods). When unset, the `auth`
capability is **omitted entirely** — spec-"unsupported" — so runtime behavior is byte-identical
to today until a host opts in. Adds a symmetric `describeClientAuthAdvertisement` diagnostic and a
build-time drift tripwire (`assertAuthCapabilityShape` + compile-time type pins) over the SDK's
UNSTABLE `AuthCapabilities` surface.
