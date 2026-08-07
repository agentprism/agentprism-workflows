---
"@automatalabs/acp-agents": patch
---

ACP maintenance: lift the wrapped Claude runtime to `@anthropic-ai/claude-agent-sdk@0.3.224` by
moving the root `pnpm.overrides` pin from 0.3.223 (`@agentclientprotocol/claude-agent-acp@0.65.0`
still exact-pins 0.3.220, and its latest has not yet caught up, so the override remains — drop it
once the adapter advances; see CONTRIBUTING "When the dependency gate blocks").

0.3.224 is a mechanical patch relative to 0.3.223: additive settings and capabilities
(`crossSessionInbound`/`dialogExpiry` cross-session messaging, an additive `SDKMessageOrigin`
`subkind: 'peer-send-message'`, archive-source plugin install, sandbox credential masking) plus a
bug fix (long project paths no longer cross-referencing other projects' sessions). The runtime is
wrapped behind the `claude-agent-acp` adapter — we never import it directly — so an additive+fix
patch changes no ACP surface the Claude backend integrates against. The `@earendil-works` and
`@agentclientprotocol` legs of the dependency gate pass clean, and the acp-agents live steering e2e
(real Claude driven through the adapter over the 0.3.224 runtime) is green.
