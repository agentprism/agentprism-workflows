---
"@automatalabs/acp-agents": minor
"@automatalabs/pi-acp": minor
"@automatalabs/workflows": minor
"@automatalabs/shared-types": minor
"@automatalabs/mcp-server": minor
"@automatalabs/workflow-engine": patch
---

ACP dependency maintenance with a protocol surface change: `@agentclientprotocol/sdk` 1.3.0 -> 1.4.0
(acp-agents `^1.4.0`, pi-acp exact `1.4.0`, codex-acp `^1.4.0` via the upstream sync) brings ACP
schema 1.21.0, which **removed the `env_var` authentication method from the protocol**
(agentclientprotocol/agent-client-protocol #1796 "removes the env var variant as it proved not really
adopted… the providers API will probably replace this" and #2000 "stabilize terminal authentication").
`AuthMethod` is now `agent | terminal`, the `AuthEnvVar` / `AuthMethodEnvVar` types no longer exist, and
the SDK's lenient parser reads any `env_var`-shaped method as a bare `agent` method — so the variant
cannot be emitted or observed by any SDK >= 1.4.0 peer. We adapted on the same bump rather than holding
the pin back (CONTRIBUTING "When the dependency gate blocks"):

- `@automatalabs/acp-agents` (minor, public types shrink): the `env_var` `AuthMethodDescriptor` variant,
  `AuthMethodType` `"env_var"`, the `"spawn-env"` `CredentialClass` (its only producer was `env_var`),
  `HANDLED_AUTH_METHOD_TYPES` `"env_var"`, and the `AuthEnvVar`/`AuthMethodEnvVar` re-exports are removed.
  `AuthResolution { outcome: "env", values }` is retained for `agent` methods whose credential is read
  from the spawn environment (codex `api-key`); the spawn-env overlay is unchanged. The §4.6.4 drift
  tripwires are retargeted to the two-variant union plus a new compile-time pin that `env_var` stays
  absent. `PI_ACP_PROTOCOL_CONTRACT.authMethodIds` is now `["pi-stored-credentials"]`.
- `@automatalabs/pi-acp` (minor, advertised surface shrinks): advertises only `pi-stored-credentials`;
  the five provider API-key methods (`anthropic-api-key`, `openai-api-key`, `gemini-api-key`,
  `xai-api-key`, `openrouter-api-key`) were `env_var`-typed and are retired — they now reject with
  `unknown_auth_method`. Provider keys are still read from the server's environment exactly as before.
- `@automatalabs/workflows` (minor): drops the `AuthEnvVar`/`AuthMethodEnvVar` facade re-exports.
- `@automatalabs/shared-types` (minor): `AuthErrorContext.methods[].type` is `"agent" | "terminal"`.
- `@automatalabs/mcp-server` (minor): the `workflow` tool's `auth_required` output schema enum loses
  `"env_var"`.
- `@automatalabs/workflow-engine` (patch): persisted `authContext` validation accepts only
  `agent`/`terminal` method types.

Also carried by SDK 1.4.0 / schema 1.21.0:

- Two new UNSTABLE `sessionUpdate` kinds, `compaction_update` and `compaction_summary_chunk` (session
  context compaction, agent-client-protocol #2002). `AcpUpdateKind` / `AcpRunnerEventMap` derive from the
  SDK type, so `@automatalabs/acp-agents` now emits them as per-kind runner events (and under the
  `session_update` catch-all) with no code change; they are bookkeeping kinds for the workflows
  projection (not turn content). The completeness tripwires list them explicitly.
- The elicitation stabilization (`unstable_createElicitation`/`unstable_completeElicitation` ->
  `createElicitation`/`completeElicitation`) touches only the test fixture's agent side; the client
  binds the method constants, which are unchanged.
