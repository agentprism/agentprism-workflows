---
"@automatalabs/acp-agents": minor
---

Per-agent auth profiles + codex spawn channel + `_meta` matrix tripwire + permission
`_meta.persist` (§3, §2.8, §3.6). Adds `packages/acp-agents/src/auth/auth-profiles.ts` with one
pure-data `AuthProfile` per built-in backend (`claudeAuthProfile`/`codexAuthProfile`/
`opencodeAuthProfile`); a custom backend supplies none and runs the type-driven base flow verbatim
(conformance-by-absence, §3.5). Each profile only refines client auth capabilities per backend
(`clientAuthCapabilities`), relabels descriptors (`describe`, identity for built-ins), and reshapes
the gateway payload (`buildMeta`, identity) — it never gates the flow (Principle 1). `codexAuthProfile`
additionally carries the `spawnAuthEnv` lever that emits `DEFAULT_AUTH_REQUEST` for `api-key`/`gateway`
intents, layered on top of the universal post-`initialize` replay (never required for correctness,
§2.8/§3.3). The runner consults `profile.describe`/`buildMeta` and the connection refines
`clientCapabilities.auth` through `profile.clientAuthCapabilities`; default-OFF stays byte-identical.

Widens the permission outcome with an optional Codex tool-approval persistence directive: new
`resolvePermission`/`withPersist` helpers and `PermissionResolution`/`PermissionPersist` types, plus
`ToolPolicy.persist`, echo `_meta.persist` on the `RequestPermission` response (agents without the
capability ignore it, Principle 3). Lands the full §3.6 `_meta` support matrix as executable
drift-tripwire data (`AUTH_META_MATRIX`, `HANDLED_AUTH_METHOD_TYPES`, `AUTH_META_CONVENTION_KEYS`,
`CODEX_SPAWN_AUTH_ENV`, `ACP_AUTH_REQUIRED_CODE_EXCLUSIVE`) with compile-time `AuthMethod`-union pins,
installed-dist probes, and a spec-§3.6 lockstep assertion, so an SDK/agent bump that moves a `_meta`
surface fails the build. Adds the env-gated `auth.live.e2e.test.ts` covering claude, codex, and
opencode with equal structural depth.
