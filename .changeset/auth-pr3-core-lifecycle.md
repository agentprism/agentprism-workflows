---
"@automatalabs/acp-agents": minor
---

Auth contracts + `AuthStore` lifecycle + resolver + runner auth API (§1.3, §2, §4.1) — the core
correctness PR (closes gap 3: the credential a `runner.authenticate()` stored on a dedicated
connection no longer dies when that connection is disposed).

New `packages/acp-agents/src/auth/{auth-types,auth-store}.ts`: the type-dispatched
`AuthMethodDescriptor`/`AuthResolution`/`AuthContext`/`AuthResolver` contracts and the pure,
agent-agnostic `buildAuthDescriptors` dispatcher (§1.3); the single per-runner `AuthStore`, its
per-`poolKey` generation-stamped `BackendAuthMachine`, and the immutable `AuthIntent` that is the
ONLY home for credential material (§2). Credentials live in the store, not on a connection: every
connection pulls the current intent at the end of `initialize` (in-process gateway creds are
replayed via `authenticate`; disk/spawn-env creds are only stamped), and the pool's
`selectConnection` is generation-gated so no session is ever opened under stale auth — stale-busy
connections drain, stale-idle ones recycle.

Runner API (§4.1): `AcpRunnerOptions.onAuth` (inline resolve-and-retry-once at the run seam; the
run never pauses when set), the `onAuth`-derived `authCapabilities` default `{ terminal:false,
gateway:true }`, `describeAuthMethods`/`completeAuth`, the `runner.auth` controller
(`methods`/`authenticate`/`logout`/`status`/`canResume`), `listBackends`, and the
`AuthCapableRunner` detection interface. Legacy `authenticate()`/`logout()` are rebuilt off
dispose-after onto the `AuthStore` + pool recycle. A spawn-env overlay injects collected `env_var`
values at spawn, and `stderrTail` is run through a secret-redaction pass.

Default-OFF and byte-identical: a host that sets neither `onAuth` nor `authCapabilities` gets the
exact pre-auth wire behavior. Ships the profile-less conformant `fake-auth-agent.mjs` fixture (§3.5)
and its integration suite (the executable Principle-1 proof), plus descriptor/store/secret unit
tests. Per-agent `AuthProfile`s and the engine pause-for-auth path remain PR7/PR4.
