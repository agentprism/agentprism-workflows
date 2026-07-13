---
"@automatalabs/acp-agents": patch
"@automatalabs/mcp-server": patch
---

Fail loudly when a fresh agent process stops advertising the `providers` capability while gateway provider routing is still configured. Previously the initialize-time replay was advertise-gated but the connection was stamped current unconditionally, so a fresh process that no longer advertised `providers` (an npx-resolved backend version change, a command override/wrapper, or a startup-dependent advertisement) was silently marked up-to-date with no routing applied — subsequent runs then sent traffic direct-to-provider instead of through the configured gateway. `applyProviderIntents` now throws a non-recoverable `WorkflowError` in that case, naming the backend and both operator exits (restore the backend, or disable the provider via `workflow_disable_provider` / the runner's `disableProvider` API), replacing the silent skip-and-stamp. A backend with no recorded routing — including after a disable emptied the intents — is unaffected and stays byte-identical to the default-OFF baseline.
