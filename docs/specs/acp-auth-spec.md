# ACP Authentication — Implemented End-to-End Design Record

## Status and original motivation

AgentPrism's ACP authentication lifecycle is **implemented and shipped**. This document is the
frozen design record that drove the seven-PR auth train; it remains the normative explanation of
credential classes, capability advertisement, pool replay/recycle, host hooks, pause/resume, and
secret handling.

**Verified implementation state (2026-07-09).**

- `@agentclientprotocol/sdk` 1.2.1 is the protocol ground truth; `ClientCapabilities.auth` remains
  UNSTABLE/experimental and `RequestError.authRequired` exclusively reserves `-32000`.
- `AcpRunnerOptions.authCapabilities` advertises only the auth method types a host can complete;
  leaving both it and `onAuth` unset keeps the wire behavior default-off.
- `AuthStore` / `BackendAuthMachine` retain credential intent per runner, replay it after every
  initialize, generation-gate connection selection, recycle stale pools, and redact/zeroize secrets.
- `describeAuthMethods`, `completeAuth`, legacy auth/provider methods, and the `runner.auth`
  controller are live. `onAuth` resolves a `-32000` inline and retries exactly once.
- `AUTH_REQUIRED` is code-first, carries non-secret `authContext`, and pauses a managed workflow
  with `reason:"auth_required"`; cold resume re-arms via `runner.auth.canResume`.
- The default MCP server registers `workflow_auth_status` and `workflow_authenticate` alongside
  `workflow`; `AGENTPRISM_MCP_INLINE_AUTH=1` optionally adds masked elicitation collection.
- Claude, Codex, OpenCode, and Pi profiles plus the profile-less custom-agent fixture are implemented,
  with executable `_meta`/method drift tripwires and credential-gated live suites.

The original five gaps were: no client auth advertisement, no type-dispatched terminal/env
handling, dispose-after-authenticate credential loss, no managed auth pause/MCP surface, and an
English-text-dependent `-32000` matcher. All five are closed by the implementation described here.

Sections 1–3 describe the implemented architecture. Sections 4.6–4.7 preserve the completed test
and PR delivery plan for provenance; their future-tense wording should be read as the sequence that
was executed. File paths and symbol names are authoritative. Numeric source offsets in the agent
dist investigations are snapshot evidence from the 2026-07-08 design freeze and are intentionally
not navigation pointers into today's edited source.

The design is held to nine non-negotiable principles — equal first-class integrations (Codex,
OpenCode, Claude, Pi, and custom agents), base-spec-first, full `_meta` capability support, no deferred
work, headless-library host hooks, the codex-acp fork as a constraint (not a priority ranking),
resume/pool safety, engine pause-for-auth, and strict secret hygiene.

## Table of contents

1. **Base protocol layer**
   - 1.1 Organizing invariant — two credential classes, type-driven
   - 1.2 Client capability advertisement policy
   - 1.3 Type-dispatching auth-flow contracts (host-facing hooks)
   - 1.4 Base-layer conformance guarantee — zero agent-specific code
   - 1.5 Error taxonomy — the `-32000` matcher and structured `AUTH_REQUIRED`
2. **Auth lifecycle**
   - 2.1 The two credential classes (the organizing axis)
   - 2.2 Where chosen `methodId` + `_meta` persist: `AuthIntent`
   - 2.3 The per-backend state machine: `BackendAuthMachine`
   - 2.4 Connection-level stamps: `ConnectionAuthStamp`
   - 2.5 `authenticate` replay after `initialize`
   - 2.6 Pool recycle after host-completed auth
   - 2.7 In-process (gateway) vs disk-persisted methods
   - 2.8 Spawn-time auth channels
   - 2.9 Host-completed auth: `completeAuth` + the shared `applyResolution`
   - 2.10 The `runner.auth` controller
   - 2.11 Retry interaction: inline resolve-and-retry-once
   - 2.12 Engine + WorkflowManager pause-for-auth
   - 2.13 Resume-after-auth
   - 2.14 Secret-handling rules
3. **Integration profiles**
   - 3.1 The `AuthProfile` seam
   - 3.2 Claude Code — `@agentclientprotocol/claude-agent-acp` 0.58.1
   - 3.3 Codex — `@automatalabs/codex-acp` (workspace) (our fork)
   - 3.4 OpenCode — `opencode-ai` 1.17.14
   - 3.4.1 Pi — `@automatalabs/pi-acp` 0.1.1
   - 3.5 Custom agent conformance profile
   - 3.6 Full `_meta` capability support matrix
4. **Host surfaces, testing, and delivery**
   - 4.1 Runner API additions
   - 4.2 `@automatalabs/workflows` SDK exports
   - 4.3 MCP server auth tools
   - 4.4 Native-TTY CLI hosts (non-normative)
   - 4.5 Web app + local runner bindings
   - 4.6 Implemented test matrix (historical plan)
   - 4.7 Completed PR sequencing (historical)

## Glossary

These terms were named or located inconsistently across the four source drafts. The
canonical name/home below is used everywhere in this assembled spec; the inline text has
been normalized to match.

- **`buildAuthDescriptors`** — the pure, agent-agnostic per-method dispatcher (canonical home §1.3) that maps advertised `AuthMethod[]` → `AuthMethodDescriptor[]`. One draft called the per-method step `describeAuthMethod`; normalized to `buildAuthDescriptors`.
- **`AuthController`** — the `runner.auth` controller object (canonical type name, §2.10 / §4.1). One draft named the interface `RunnerAuthController`; normalized to `AuthController`. Its method to enumerate descriptors is `methods()` (an alias of `runner.describeAuthMethods()`); the `describeMethods()` name is retired.
- **`AuthStatusSnapshot`** — the redacted status view (ids/types/names + state only, never secrets). Canonical shape defined in §4.1 (`backendId`, `poolKey`, `state`, `authenticated`, `canResume`, `methods`); §2.10's shorter earlier shape is aligned to it.
- **`CredentialClass`** / **two credential classes** — the type-driven axis with strategy values `"disk"` / `"in-process"` / `"spawn-env"`. Defined canonically in §1.1 as the base contract; restated in §2.1, which now cross-references §1.1.
- **`AuthErrorContext` / `authContext`** — `AuthErrorContext` is the machine-readable type; `authContext` is the field carried on `WorkflowError` and `PausedEvent`. Canonical home §1.5. Drafts variously placed it in "§3" / "§4"; all references now resolve to §1.5.
- **`isAcpAuthRequired` (the `-32000` matcher)** — the code-only auth-required classifier. Canonical home §1.5. Drafts referenced it as "§3" / "§4"; normalized to §1.5.
- **`onAuth` / `AuthResolver`** — the host-facing inline auth resolver hook (contract §1.3; runner wiring §2.9, §4.1).
- **`completeAuth` / `describeAuthMethods`** — the runner's high-level write / read auth entry points (§1.3, §2.9, §4.1).
- **`klass`** — the `CredentialClass`-valued field on `AuthIntent` (§2.2).

Cross-references have additionally been renumbered: the three drafts each assumed a
different global section layout (one imagined a 12-section spec, another a 6-section spec).
All "Section N" / "§N" pointers now resolve to this document's four-section structure.

---

## 1. Base protocol layer

This section fixes the protocol-required behavior that must hold for **any** spec-conformant ACP agent — Claude, Codex, OpenCode, or a custom agent — before any vendor `_meta` extension is layered on. Every decision here branches on the SDK-typed `AuthMethod.type` (`@agentclientprotocol/sdk@1.2.1`) plus a small, fixed set of **cross-agent `_meta` conventions** — the literal keys `gateway`, `terminal-auth`, and `api-key` — that the first-class agents share (claude+codex share `gateway`; claude+opencode share `terminal-auth`). These keys are **not** SDK schema fields: the SDK types every `_meta` as an opaque `{ [key: string]: unknown } | null` and explicitly instructs implementations to make no assumptions about the values at those keys. So this layer names no *agent* (there is **no** `if (backendId === …)` anywhere in it, Principle 1), but it is honestly coupled to these three conventional key *names* — which is the precise boundary of the "no agent-specific code" claim, and which is why the custom-agent contract (§3.5) requires a conformant agent to use those literal keys. Per-agent profiles (§3) are pure data that enrich and label the descriptors produced here — they never gate or redirect the flow. The connection/pool/session lifecycle that consumes these contracts (the `AuthStore`, generation-stamped machine, replay, recycle, and inline resolve-and-retry) is specified in §2; the engine pause-for-auth path is §2.12; the concrete host bindings are §4.

### 1.1 Organizing invariant — two credential classes, type-driven

Every mechanism in this spec derives from one distinction that the base layer computes **without agent identity**, from `AuthMethod.type` plus the cross-agent `_meta` key conventions (`gateway`/`terminal-auth`/`api-key`; not SDK schema fields — §1 intro):

| Class | Survives process respawn? | Applied on a fresh connection | Derived from |
|---|---|---|---|
| **disk-persisted** | Yes — a fresh spawn inherits it | nothing | `terminal`; `agent` with no advertised `_meta` |
| **in-process / per-spawn** | No — dies with the process | replay `authenticate` RPC (in-process) **or** inject env at spawn + recycle (spawn-env) | `agent` with gateway-shaped `_meta`; `env_var` |

Internally the class is named `CredentialClass` with three strategy values (`"disk"`, `"in-process"`, `"spawn-env"`). The inference rule is fixed and agent-agnostic; it is stated here as the base contract and consumed by §2:

- `env_var` → `"spawn-env"`, not disk-backed
- `terminal` → `"disk"`, disk-backed
- `agent` **with** a gateway-shaped `_meta` on the advertised method or resolution → `"in-process"`, not disk-backed
- `agent` **without** `_meta` → `"disk"`, disk-backed

This single rule classifies all three first-class agents correctly with zero agent-specific code (claude gateway/gateway-bedrock = in-process; claude terminal logins = disk; codex `gateway` = in-process; codex `api-key`/`chat-gpt` = disk; opencode `opencode-login` = disk no-op), which is the executable proof of Principle 1 (§1.4).

### 1.2 Client capability advertisement policy

**Seam extended:** `ClientCapabilityOptions` (`packages/acp-agents/src/client-handlers.ts:97-102`) and `clientCapabilitiesFor` (`:120-136`), gated on host-declared capability exactly as `fs`/`terminal`/`elicitation` are gated today (`:125,:130-134`). Wiring mirrors `advertiseElicitation = Boolean(deps.elicitationResolver)` (runner.ts:249 → pool.ts:36,127 → acp-client.ts:942 → the `clientCapabilitiesFor(this.clientHandlers, { elicitation: this.advertiseElicitation })` call at acp-client.ts:1193-1194): default-off, fixed for the connection lifetime, derived once at runner construction.

**`ClientCapabilityOptions` change** (`client-handlers.ts:97-102`):

```ts
export interface ClientCapabilityOptions {
  elicitation?: boolean;
  /** Which auth method TYPES this client can actually complete. Advertising a gate the host
   *  cannot service would invite the agent to offer a method the host can't finish. FIXED for
   *  the connection lifetime (same discipline as `elicitation`, :98-101); derived once at
   *  runner construction, never per-session. */
  auth?: { terminal?: boolean; gateway?: boolean };
}
```

**`clientCapabilitiesFor` change** — appended after the elicitation block (`:125`), before `return capabilities` (`:135`):

```ts
if (options.auth?.terminal || options.auth?.gateway) {
  const auth: NonNullable<ClientCapabilities["auth"]> = {};
  if (options.auth.terminal) auth.terminal = true;              // typed field, SDK schema/types.gen.d.ts:4318-4324
  if (options.auth.gateway)  auth._meta = { gateway: true };    // claude+codex gateway gate
  capabilities.auth = auth;
  if (options.auth.terminal) {
    // claude 0.57.0 (acp-agent.js:339) and opencode 1.17.14 (service.ts:100-101) ALSO read the
    // top-level _meta channel; that variant additionally carries the spawnable {command,args,label}
    // launch hint we prefer. Light both so all three agents reveal their terminal methods.
    capabilities._meta = { ...(capabilities._meta ?? {}), "terminal-auth": true };
  }
}
```

**Runner options + default derivation** (`packages/acp-agents/src/runner.ts`, `AcpRunnerOptions` at `:198-208`):

```ts
authCapabilities?: { terminal?: boolean; gateway?: boolean };
onAuth?: AuthResolver;   // §1.3
```

Default derivation (in the runner constructor, `:241-252`, alongside `advertiseElicitation`):

- `onAuth` set, `authCapabilities` unset → `{ terminal: false, gateway: true }`. Gateway is cheap and non-destructive; terminal needs a real TTY that a generic programmatic host lacks. **Sequencing record (§4.7):** PR3 introduced `onAuth` and its conditioned default after PR2 established the explicit-`authCapabilities` and omit-when-unset paths. The delivered composition preserves the PR2 default when `onAuth` is unset.
- `onAuth` unset (and `authCapabilities` unset) → advertise nothing. The `auth` key is omitted — spec-correct "unsupported" (any capability omitted in `initialize` MUST be treated as unsupported, `agentclientprotocol.com/protocol/v1/initialization`). This is today's exact behavior, so PR2 (§4.7) is a zero-behavior-change opt-in.
- Native-TTY hosts (the local runner, or any CLI host — §4) pass `{ terminal: true, gateway: true }` explicitly.

**Threading.** Add `authCapabilities?: { terminal?: boolean; gateway?: boolean }` to `AcpPoolDeps` (`packages/acp-agents/src/pool.ts:32-36`, next to `advertiseElicitation`), pass it through the `PooledConnection` deps construction (`pool.ts:124-127`), store it on `PooledConnection` (`packages/acp-agents/src/acp-client.ts:920,942`, mirroring `this.advertiseElicitation`), and feed it into the `clientCapabilitiesFor` options object at `acp-client.ts:1193-1194`:

```ts
clientCapabilities: clientCapabilitiesFor(this.clientHandlers, {
  elicitation: this.advertiseElicitation,
  auth: this.authCapabilities,           // undefined => no `auth` key emitted
}),
```

**Why this exact split (grounded in the three agents).** claude 0.57.0 reveals its `terminal`-type login methods (`claude-ai-login`/`console-login`/`claude-login`) when `clientCapabilities.auth.terminal === true` **or** `clientCapabilities._meta["terminal-auth"] === true` (reads at acp-agent.js:317/:338/:339); its `gateway`/`gateway-bedrock` `agent`-type methods gate on `clientCapabilities.auth._meta.gateway === true` (the advertised `authMethods[]._meta.gateway.protocol` block is emitted at acp-agent.js:322). codex-acp 1.5.2 gates its `gateway` method on `clientCapabilities.auth._meta.gateway === true` (read at the snapshot offset index.js:24188; the method's `_meta.gateway {protocol,restartRequired}` block is at index.js:24176) while `api-key`/`chat-gpt` are always visible in that snapshot (index.js:24161). opencode 1.17.14 reads its terminal launch hint under `clientCapabilities._meta["terminal-auth"]` (service.ts:100-101). Lighting `auth.terminal` and the top-level `_meta["terminal-auth"]` together, plus `auth._meta.gateway`, unblocks all three. `agent`-type methods that carry no `_meta` (e.g. codex `api-key`) need no client capability and work with nothing advertised — base-spec-first (Principle 2).

**No typed `env_var` gate exists.** In SDK 1.2.1 `AuthCapabilities = { terminal?: boolean; _meta? }` (`schema/types.gen.d.ts:4318-4335`) — there is no `envVar` boolean. So `env_var` methods are always visible on the wire; they are serviced not by an advertisement but by the presence of an `AuthResolver` that returns `{ outcome: "env" }` (§1.3, §1.5). We do not synthesize a non-standard `_meta` gate for `env_var`.

**UNSTABLE pin (Principle 7).** `ClientCapabilities.auth` (`schema/types.gen.d.ts:4147`, `@experimental`) and `AuthCapabilities` (`schema/types.gen.d.ts:4318`, `@experimental`) are marked UNSTABLE in 1.2.1. In 1.2.1 the `{ terminal?, _meta }` shape is fully typed, so the assignment above compiles with **no** `as` cast. We pin that shape, add a compile-time type-existence assertion and a runtime shape assertion to the drift tripwire (§4.6.4), and honor bump-ACP-deps-every-release. If a future bump compile-guards or renames `auth`, the escape hatch is a **single** localized `as` in this one function with a comment — nowhere else — and the tripwire fails the build so the change is never silent.

**Symmetric describer.** `describeAuthProviderAdvertisement` (`packages/acp-agents/src/capabilities.ts:140-150`) already renders the agent side for error/diagnostic text. Add a parallel:

```ts
// packages/acp-agents/src/capabilities.ts
export function describeClientAuthAdvertisement(auth: ClientCapabilities["auth"], meta: ClientCapabilities["_meta"]): string;
// => e.g. "auth.terminal=true; auth._meta.gateway=true; _meta[\"terminal-auth\"]=true" or "auth=none"
```

### 1.3 Type-dispatching auth-flow contracts (host-facing hooks)

**New file `packages/acp-agents/src/auth/auth-types.ts`.** The library never runs an interactive step itself (Principle 5): it emits an `AuthContext` and consumes an `AuthResolution`. Secret material flows only through resolver return values and the spawn env — never through events, journals, logs, or error messages (Principle 9). Every type here is dispatched on `AuthMethod.type` + the cross-agent `_meta` key conventions (`gateway`/`terminal-auth`; not SDK schema fields — §1 intro), with zero agent-*id* branching.

```ts
// Host-agnostic, fully type-dispatched view of one advertised AuthMethod. ZERO backend branching.
export type AuthMethodDescriptor =
  | { type: "agent"; id: string; name: string; description?: string;
      /** true iff the advertised authMethods[]._meta block is present (a `_meta` object exists —
       *  gateway OR api-key convention). Whether it is *gateway-shaped* is a separate test that
       *  drives `klass` (§2.1), not `expectsMeta`. */
      expectsMeta: boolean; meta?: Record<string, unknown>;
      /** true iff this is a bare `agent` method (no gateway `_meta`) that runs its OWN login
       *  via the authenticate RPC — which may open a browser or need a TTY (e.g. codex
       *  `chat-gpt`). Derived as `!expectsMeta`. Headless hosts (MCP/SDK) use this to skip a
       *  method they cannot complete instead of mapping it to a no-op (§4.3). */
      interactive: boolean; }
  | { type: "terminal"; id: string; name: string; description?: string;
      /** How the host spawns the interactive login. Base fills from EITHER the conventional
       *  _meta["terminal-auth"] {command,args,label} (preferred; not an SDK schema field, §1 intro),
       *  OR the agent binary + AuthMethodTerminal.args/env (spec baseline). */
      launch: { command: string; args: string[]; env?: Record<string, string>; label?: string };
      meta?: Record<string, unknown>; }
  | { type: "env_var"; id: string; name: string; description?: string; link?: string;
      /** Per-var `meta` carries the SDK-first-class `AuthEnvVar._meta`
       *  (schema/types.gen.d.ts:2199-2209) through unchanged, so no env_var surface is silently
       *  dropped (Principle 3, §3.6). */
      vars: Array<{ name: string; label?: string; secret: boolean; optional: boolean; meta?: Record<string, unknown> }>;
      meta?: Record<string, unknown>; };

export type AuthResolution =
  | { outcome: "completed" }                                            // disk cred already present out-of-band (terminal login done, or native store / env pre-set) — no RPC
  | { outcome: "agent-login"; methodId: string }                       // bare `agent` method runs its OWN login NOW via a one-shot authenticate({ methodId }) RPC (e.g. codex chat-gpt browser OAuth; canonical AuthMethodAgent)
  | { outcome: "env"; values: Record<string, string> }                 // env_var values (SECRET)
  | { outcome: "meta"; methodId: string; meta: Record<string, unknown> } // agent-type payload, e.g. gateway (SECRET)
  | { outcome: "cancelled" };

export interface AuthContext {
  readonly backendId: string;
  readonly label?: string;
  readonly methods: readonly AuthMethodDescriptor[];   // all advertised, already dispatched
  readonly cause: "required" | "proactive";            // required = we hit -32000; proactive = pre-run
  readonly signal?: AbortSignal;
}

// Mirrors PermissionResolver / ElicitationResolver EXACTLY (runner.ts:202-207, :227-228).
export type AuthResolver = (ctx: AuthContext) => Promise<AuthResolution> | AuthResolution;
```

**Pure dispatcher.** `buildAuthDescriptors(methods: AuthMethod[], spawn: SpawnConfig): AuthMethodDescriptor[]` maps each advertised `AuthMethod` (`schema/types.gen.d.ts:2159-2163`) to a descriptor with no agent identity:

- **`agent`** (`AuthMethodAgent`, `schema/types.gen.d.ts:2303-2326`; also the default when `type` is absent, `:2155-2158`): `expectsMeta = method._meta != null`; `interactive = !expectsMeta` (a bare `agent` runs its own, possibly browser/TTY, login); pass `meta` through.
- **`terminal`** (`AuthMethodTerminal`, `schema/types.gen.d.ts:2264-2297`): resolve `launch` in a fixed order, both branches agent-id-free (branch 1 keys on the `terminal-auth` convention, not the SDK schema — §1 intro):
  1. Method carries `_meta["terminal-auth"] = { command, args, label }` → use verbatim (claude acp-agent.js:359-401; opencode service.ts:100-101).
  2. Pure-spec fallback → `command = spawn.command`, `args = [...spawn.args, ...(method.args ?? [])]`, `env = { ...(method.env ?? {}) }` (per the SDK, `AuthMethodTerminal.args`/`env` apply to the **agent binary** for terminal auth, `schema/types.gen.d.ts:2277-2286`).
- **`env_var`** (`AuthMethodEnvVar`, `schema/types.gen.d.ts:2221-2252`): map `vars` from `AuthEnvVar[]` (`:2177-2209`), reading SDK defaults — `secret` defaults **true** (`:2186-2192`), `optional` defaults **false** (`:2193-2198`) — carrying `link` (`:2238-2241`) and each var's first-class `AuthEnvVar._meta` (`:2199-2209`) through unchanged (Principle 3, §3.6).

**High-level runner entry points** (the surface §4 hosts drive — MCP tools, SDK, web):

```ts
// packages/acp-agents/src/runner.ts
runner.describeAuthMethods(opts: AuthMethodsOptions): Promise<AuthMethodDescriptor[]>;

interface CompleteAuthOptions extends AuthMethodsOptions {
  methodId: string;
  resolution: AuthResolution;
  label?: string;
}
type AuthOutcome = { status: "authenticated" | "cancelled"; methodId: string; recycled: boolean };
runner.completeAuth(opts: CompleteAuthOptions): Promise<AuthOutcome>;
```

`AuthMethodsOptions` is the existing backend-selection options type already consumed by `runner.authMethods(opts)` (`runner.ts:299`). `describeAuthMethods` opens a dedicated connection, reads `connection.capabilities.authMethods` (populated by `negotiateCapabilities`, `capabilities.ts:98`), runs `buildAuthDescriptors`, and disposes — a read-only probe. `completeAuth` records intent, advances the generation, and recycles the pool; its `AuthStore`/machine internals and the recycle mechanics are §2. The raw `runner.authenticate()` (`runner.ts:313`) is retained for advanced callers but is rebuilt in §2 (§2.9) to record into the `AuthStore` and recycle rather than dispose-after-authenticate.

**Dispatch per resolution** (the base decision table; `completeAuth` and the §2 inline resolver (§2.11) share one internal `applyResolution`):

| Descriptor type | Host action | Library action on the resolution | `CredentialClass` |
|---|---|---|---|
| `agent` (no `_meta`, `interactive`) | on a browser/TTY surface return `{ outcome: "agent-login" }` (headless hosts skip this method — §4.3) | **fire a one-shot `authenticate({ methodId })`** on a connection so the agent runs its own login (codex `chat-gpt` opens the browser; canonical `AuthMethodAgent` logs in internally), then record a disk intent | `disk` |
| `agent` (`expectsMeta`, gateway-shaped `_meta`) | supply `{ baseUrl, headers, … }` as `{ outcome: "meta" }` | record intent; replay `authenticate({ methodId, _meta })` per connection | `in-process` |
| `agent` (`expectsMeta`, non-gateway `_meta`, e.g. codex `api-key`) | supply the key as `{ outcome: "env" }` **or** `{ outcome: "meta", meta:{ "api-key":{apiKey} } }` | record intent; inject at spawn (`DEFAULT_AUTH_REQUEST`/env, §2.8/§3.3); recycle — **no RPC replay** | `disk` |
| `terminal` | spawn `launch.command launch.args` in a TTY, await exit | nothing on the wire (client-executed) | `disk` |
| `env_var` | collect masked `values` as `{ outcome: "env" }` | record intent; inject at spawn; recycle | `spawn-env` |

`{ outcome: "cancelled" }` records no intent and leaves the backend unauthenticated. The `authenticate` wire request — whether the one-shot `agent-login` login or the per-connection in-process replay — carries only `{ methodId, _meta? }` (`AuthenticateRequest`, `schema/types.gen.d.ts:4494-4510`); no credential field exists. env/terminal/api-key credentials reach the agent out-of-band (spawn env / interactive TTY / native store), which is exactly why those types are classified per-spawn or disk rather than replayed. The one bare-`agent` login RPC fires from the `completeAuth`/`applyResolution` path (§2.9), **not** from the per-`initialize` replay (§2.5), because after that login the credential lives on disk and a fresh process re-reads it.

### 1.4 Base-layer conformance guarantee — zero agent-specific code

The dispatcher (§1.3), the class inference (§1.1), the advertisement policy (§1.2), and the error taxonomy (§1.5) form a complete auth flow for any spec-conformant agent **with no code that names an agent**. Conformance is defined as the **absence of a profile**: `Backend` (`packages/acp-agents/src/backend.ts:41`) gains an optional `readonly authProfile?: AuthProfile` (§3.1); built-ins set theirs to enrich labels and provide the codex spawn-env hook, and a custom backend leaves it `undefined`, falling straight through this base layer.

The executable proof is the profile-less fake conformant agent fixture (`packages/acp-agents/test/fixtures/fake-auth-agent.mjs`, specified in §4.6.2): a real stdio ACP server that advertises one `agent`, one `env_var`, and one `terminal` method, emits `-32000` on `session/new` until authenticated, stores gateway `_meta` in-process, reads env credentials from its spawn environment, and supports `logout` — driven end-to-end through the identical dispatcher, class inference, advertisement, and error taxonomy with no registered profile. Because the class inference rule (§1.1) keys only on `AuthMethod.type` + the cross-agent `_meta` conventions (never on an agent id), this fixture and all three first-class agents traverse the same code paths.

### 1.5 Error taxonomy — the `-32000` matcher and structured `AUTH_REQUIRED`

**Seam edited:** `isAcpAuthRequired` (`packages/acp-agents/src/errors-map.ts:70-75`). Today it requires `code === -32000` **and** `/^Authentication required\b/i` — so a conformant custom agent (or a localized/rephrased first-class agent) that emits `-32000` with different message text is misclassified as a *recoverable* `AGENT_EXECUTION_ERROR` and retried into the same wall. The SDK reserves `-32000` **exclusively** for `authRequired` (`RequestError.authRequired`, `jsonrpc.js:818-823`; no other constructor in `jsonrpc.js:764-829` emits it), so the code alone is authoritative. Adopt a code-only primary with a guarded prose fallback for non-conformant agents that signal auth without the reserved code:

```ts
// packages/acp-agents/src/errors-map.ts
const OTHER_RESERVED = new Set([-32700, -32600, -32601, -32602, -32603, -32800, -32002]);

function isAcpAuthRequired(error: unknown, message: string): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // PRIMARY (spec-faithful): -32000 is reserved EXCLUSIVELY for authRequired (jsonrpc.js:818-823).
  // Code alone, ANY message — this unblocks conformant agents that localize/rephrase the text.
  if (code === ACP_AUTH_REQUIRED_ERROR_CODE) return true;
  // FALLBACK: a non-conformant agent that signals auth in prose without the reserved code. A
  // DIFFERENT reserved code that merely mentions the phrase must NEVER mis-route to pause-for-auth.
  return typeof code === "number"
    ? !OTHER_RESERVED.has(code) && /\bauthentication required\b/i.test(message)
    : /\bauthentication required\b/i.test(message);
}
```

`ACP_AUTH_REQUIRED_ERROR_CODE = -32000` is unchanged (`errors-map.ts:16`). The `PROVIDER_USAGE_LIMIT` classification (`classifyProviderLimit`, `shared-types/src/errors.ts:87-96`) is unchanged and the auth check runs first in `mapThrownError` (`errors-map.ts:46`), so a message mentioning both auth and a usage limit never mis-routes. `-32000` is deliberately excluded from `OTHER_RESERVED` (it is the primary). A code comment documents the `-32000`-exclusivity guarantee; the drift tripwire (§4.6.4) fails the build if a future SDK reassigns `-32000`.

**Structured `authContext` — the machine-readable contract.** No host ever parses the enriched human message. A new exported type and a `WorkflowError` field carry the auth surface structurally:

```ts
// packages/shared-types/src/errors.ts
export type AuthErrorContext = {
  backendId?: string;
  methods: { id: string; type: "agent" | "terminal" | "env_var"; name?: string }[];
};

// WorkflowErrorOptions (errors.ts:41-47) gains:
authContext?: AuthErrorContext;
// WorkflowError (errors.ts:49-65) gains a readonly field set from options:
readonly authContext?: AuthErrorContext;
```

`ErrorMapContext` already threads `authMethods` into `mapThrownError` (`errors-map.ts:18-22`; supplied from `pool.ts:80,100`). The `AUTH_REQUIRED` branch (`errors-map.ts:46-52`) builds `authContext` from those advertised `AuthMethod` ids/types/names and attaches it via the new option, keeping `recoverable: false` (retrying cannot help; `AUTH_REQUIRED` is already non-recoverable, `shared-types/src/errors.ts:24`, so the engine retry ladder already skips it):

```ts
if (isAcpAuthRequired(error, message)) {
  const methods = (context.authMethods ?? []).map((m) => ({
    id: m.id, type: (m.type ?? "agent") as AuthErrorContext["methods"][number]["type"], name: m.name,
  }));
  return new WorkflowError(authRequiredMessage(message, context), WorkflowErrorCode.AUTH_REQUIRED, {
    recoverable: false,
    agentLabel: context.label,
    authContext: { backendId: context.backendId, methods },
    details: error,
  });
}
```

`authContext` sources **only** agent-advertised `AuthMethod` fields (ids, types, names) and never our sent `_meta`/env values (Principle 9). The existing `authRequiredMessage` enrichment (`errors-map.ts:77-83`) — which names the backend and method ids — is retained for human readability but is **never** the machine-readable contract; every downstream host (the engine pause path in §2.12, the MCP `auth_required` summary in §4.3, the SDK `isAuthRequired` helper in §4.2) reads `authContext`, not the message string. `AUTH_REQUIRED`'s doc comment (`shared-types/src/errors.ts:24`) is updated to point at `authContext` as the structured surface rather than describing only `runner.authenticate()`.

---

## 2. Auth lifecycle

This section specifies what happens to a credential from the moment a host completes an auth step until every connection that could serve a session reflects it — across process respawns, pool recycles, and workflow resume. The method-discovery contract (`AuthMethodDescriptor`, `buildAuthDescriptors`, `AuthContext`, `AuthResolution`, `AuthResolver`) is defined in §1.3 and the client-capability advertisement in §1.2; the `-32000` classifier and the structured `AuthErrorContext` are defined in §1.5; per-agent `AuthProfile`s and the full `_meta` matrix are defined in §3; host bindings (SDK/MCP/web) in §4; tests in §4.6. This section owns the runtime machinery those sections plug into.

The root defect this section closes (gap 3 of the 2026-07-08 audit): `runner.authenticate()` opens a dedicated connection and disposes it in `finally` (`packages/acp-agents/src/runner.ts:319-331`), so any credential the agent stored *on that process* dies with it; and the pool (`packages/acp-agents/src/pool.ts`) evicts a connection only on process death (`:148-153`), never after an auth completes, so a pooled `run()` connection never learns of it. The fix: **credentials do not live on a connection.** They live in exactly one place — the runner's `AuthStore` — and every connection *pulls* the current intent at the end of its `initialize` handshake.

### 2.1 The two credential classes (the organizing axis)

Every rule below derives from one distinction (the inference rule first stated as the base contract in §1.1): does a credential survive an agent-process respawn?

| Class | Survives respawn? | Examples | Apply on a fresh connection |
|---|---|---|---|
| **disk-persisted** | Yes | codex `api-key`/`chat-gpt` → `auth.json` (`@automatalabs/codex-acp/dist/index.js:25105-25114`; binary `auth.json`); claude terminal login → native keychain/`~/.claude` (`claude-agent-acp/dist/acp-agent.js:557-558`); pre-set env keys | **Nothing.** Dispose-after-authenticate is harmless. |
| **in-process / per-spawn** | No | claude gateway (`this.gatewayAuthRequest`, `acp-agent.js:547`); codex gateway (`this.gatewayConfig`, `index.js:25091-25099`); `env_var` collected values | **Must be re-applied.** in-process → replay `authenticate` after `initialize`; spawn-env → inject env at spawn + recycle. |

The base layer classifies from `AuthMethod.type` (SDK-typed, `@agentclientprotocol/sdk` `schema/types.gen.d.ts:2155-2163`) + the cross-agent `_meta` key conventions (`gateway`/`terminal-auth`; recognized by literal key name, not SDK schema fields — §1 intro), with **zero agent-*id* code** (Principle 1). Internally the class is named `CredentialClass`, a three-value strategy that collapses onto the two classes above:

```ts
// packages/acp-agents/src/auth/auth-store.ts (new)
export type CredentialClass = "disk" | "in-process" | "spawn-env";
// "disk"       -> disk-persisted; apply = nothing
// "in-process" -> per-spawn via authenticate RPC replay (§2.5)
// "spawn-env"  -> per-spawn via env injection + recycle (§2.8)
```

`CredentialClass` inference is type-driven and agent-agnostic:

| Method type | `_meta` present? | `klass` | `diskBacked` |
|---|---|---|---|
| `env_var` | — | `spawn-env` | `false` |
| `terminal` | — | `disk` | `true` |
| `agent` | yes (gateway-shaped) | `in-process` | `false` |
| `agent` | no | `disk` | `true` |

This classifies all three first-class agents and any conformant custom agent correctly, with no branch on backend id: claude gateway/gateway-bedrock = `in-process`; codex gateway = `in-process`; codex `api-key`/`chat-gpt` = `disk`; claude terminal = `disk`; opencode `opencode-login` = `disk` (its `authenticate` is a no-op, `opencode` `acp/service.ts:139-144`).

### 2.2 Where chosen `methodId` + `_meta` persist: `AuthIntent`

The host's completed auth choice is recorded as one immutable `AuthIntent`. This is the **only** place credential material lives in the library. It is held in memory in the runner's `AuthStore` (a native-TTY CLI host may additionally mirror it to a `0600`-permission file — a host concern, §4.4). It is **never** written to the engine's run journal, never emitted in an event, never logged (§2.14).

```ts
// packages/acp-agents/src/auth/auth-store.ts (new)
export interface AuthIntent {
  readonly backendId: string;
  readonly poolKey: string;                              // backend.poolKey ?? backend.id
  readonly methodId: string;
  readonly methodType: "agent" | "terminal" | "env_var";
  readonly klass: CredentialClass;
  /** SECRET. The `_meta` payload for the chosen method — e.g. claude { gateway: { baseUrl,
   *  headers } } or codex { "api-key": { apiKey } }. Populated for BOTH in-process and disk
   *  intents; how it is consumed depends on `klass`, not on whether it is set: for
   *  `in-process` it is replayed on the `authenticate` RPC (§2.5); for `disk` (e.g. codex
   *  `api-key` via meta) it is consumed by `codexAuthProfile.spawnAuthEnv` as
   *  `DEFAULT_AUTH_REQUEST` (§3.3), never by RPC replay. */
  readonly authenticateMeta?: Record<string, unknown>;
  /** SECRET; spawn-env only. Env values injected at agent spawn. */
  readonly envValues?: Record<string, string>;
  /** klass === "disk": a fresh process re-reads the native store; survives cold resume (§2.13). */
  readonly diskBacked: boolean;
}
```

An `AuthIntent` is built from an `AuthResolution` (§1.3) by the shared `applyResolution` internal (§2.9). `applyResolution` records the payload and `methodType` from the outcome, but **derives `klass` from the chosen method's `type` + `_meta` shape (§2.1), never from `AuthResolution.outcome`** — the two are independent axes (resolving the earlier draft that read `klass` off the outcome; the fact-check lens governs here). The derivation is exactly §2.1: `agent` with a *gateway-shaped* `_meta` → `in-process`; `agent` otherwise (no `_meta`, or a non-gateway `_meta` such as codex `api-key`) → `disk`; `env_var` → `spawn-env`; `terminal` → `disk`.

| `AuthResolution` | `methodType` | payload recorded | `klass` (derived per §2.1, NOT from the outcome) |
|---|---|---|---|
| `{ outcome: "completed" }` | `agent`\|`terminal` | none | `disk` |
| `{ outcome: "agent-login", methodId }` | `agent` | none (login persisted to the native store by the one-shot RPC) | `disk`, `diskBacked:true` |
| `{ outcome: "meta", methodId, meta }` | `agent` | `authenticateMeta = meta` | gateway-shaped `meta` → `in-process`; else (e.g. codex `api-key`) → `disk` |
| `{ outcome: "env", values }` | `env_var` \| `agent` (api-key) | `envValues = values` | `env_var` → `spawn-env`; `agent`/api-key → `disk` |
| `{ outcome: "cancelled" }` | — | no intent recorded; state unchanged | — |

### 2.3 The per-backend state machine: `BackendAuthMachine`

One `BackendAuthMachine` per `poolKey`, owned by the `AuthStore`. It is the single source of auth truth. Correctness ("no session is ever served under stale auth") is a **local, mechanical property** enforced by a monotonic generation counter, not by bookkeeping.

```ts
// packages/acp-agents/src/auth/auth-store.ts (new)
export type BackendAuthState =
  | "unauthenticated" | "credentials_held" | "authenticated" | "auth_required";

export type AuthEvent =
  | { t: "initialize_ok"; connectionId: string; advertised: AuthMethod[] }
  | { t: "host_authenticate"; intent: AuthIntent }        // a completeAuth/onAuth resolution succeeded
  | { t: "apply_ok"; connectionId: string; generation: number }
  | { t: "apply_failed"; connectionId: string; generation: number; error: unknown }
  | { t: "auth_required_tripped"; connectionId: string; error: unknown }
  | { t: "logout" }
  | { t: "process_death"; connectionId: string };

export class BackendAuthMachine {
  private _state: BackendAuthState = "unauthenticated";
  private _generation = 0;
  private _intent?: AuthIntent;

  get state(): BackendAuthState { return this._state; }
  get generation(): number { return this._generation; }

  /** Redacted view — ids/types/klass only, NEVER authenticateMeta/envValues. */
  intentView(): Readonly<Omit<AuthIntent, "authenticateMeta" | "envValues">> | undefined;
  /** SECRET accessor — connection-internal only (used by applyAuthIntent, §2.5). */
  applyMeta(): Record<string, unknown> | undefined;
  /** SECRET accessor — pool/connection-internal only (used by spawnEnvFor, §2.8). */
  spawnEnv(): Record<string, string> | undefined;

  send(ev: AuthEvent): void;                              // transition table below
  isStale(stamp: ConnectionAuthStamp): boolean { return stamp.appliedGeneration < this._generation; }
}
```

Transition table (the frozen contract; every row is unit-tested per §4.6):

| From | Event | To | Side effect |
|---|---|---|---|
| `unauthenticated` / `auth_required` | `auth_required_tripped` | `auth_required` | runner surfaces `AUTH_REQUIRED` → paused run (§2.12) |
| `unauthenticated` / `auth_required` | `host_authenticate` | `credentials_held` | store `intent`; **`generation += 1`** |
| `credentials_held` | `apply_ok` | `authenticated` | (connection stamps `applied`, §2.4) |
| **`authenticated`** | **`auth_required_tripped`** | **`auth_required`** | mid-run / scheduled expiry forces re-auth |
| `credentials_held` / `authenticated` | **`apply_failed`** | **`auth_required`** | a replay error is a non-recoverable auth failure |
| any | `logout` | `unauthenticated` | clear `intent`; **zeroize `authenticateMeta`/`envValues`** (§2.14); `generation += 1` |
| any | `process_death` | *unchanged* | the dying connection's stamp is dropped with it |

`generation` is the linchpin: any connection whose `appliedGeneration < machine.generation` is **stale** and must reconcile before it opens a new session. `host_authenticate` and `logout` are the only events that bump `generation`, so a single completed auth atomically invalidates every existing connection's stamp.

### 2.4 Connection-level stamps: `ConnectionAuthStamp`

Each `PooledConnection` carries a stamp recording which intent-generation *this process* reflects. Added to `packages/acp-agents/src/acp-client.ts` on the `PooledConnection` class.

```ts
// packages/acp-agents/src/auth/auth-store.ts (new) — type
export interface ConnectionAuthStamp {
  appliedGeneration: number;   // intent generation applied at initialize / live re-apply
  applied: boolean;
  trippedAuthRequired: boolean;
}

// packages/acp-agents/src/acp-client.ts — PooledConnection additions
class PooledConnection {
  authStamp: ConnectionAuthStamp = { appliedGeneration: -1, applied: false, trippedAuthRequired: false };
  private stampApplied(generation: number): void {
    this.authStamp = { appliedGeneration: generation, applied: true, trippedAuthRequired: false };
  }
  canLiveReapply(machine: BackendAuthMachine): boolean;   // true iff current intent klass === "in-process"
}
```

### 2.5 `authenticate` replay after `initialize` — every connection type

`AcpPoolDeps` (`packages/acp-agents/src/pool.ts:32-37`) gains one field; the runner threads its single `AuthStore` through it (mirroring how `permissionResolver`/`elicitationResolver` are threaded today):

```ts
// packages/acp-agents/src/pool.ts
export interface AcpPoolDeps {
  onEvent?: AcpEventSink;
  permissionResolver?: PermissionResolver;
  elicitationResolver?: ElicitationResolver;
  advertiseElicitation?: boolean;
  authStore?: AuthStore;              // NEW — the one store, per runner
}
```

`PooledConnection.create` (the static factory at `acp-client.ts:1043`) delegates to the `PooledConnection` constructor (`:936`), whose spawn site is `:951-954`; both receive the deps object (constructed at `:122-129` for pooled / `:739-748` for dedicated), so `authStore` is forwarded to the connection. At the end of `PooledConnection.initialize()` (`acp-client.ts:1167-1221`), after `this.negotiated = negotiated` (`:1217`) and before `ready` resolves, the connection reconciles to the current intent:

```ts
// packages/acp-agents/src/acp-client.ts — appended inside initialize(), after :1217
const machine = this.authStore?.machineFor(this.backend.poolKey ?? this.backend.id, this.backend.authProfile);
if (machine) {
  machine.send({ t: "initialize_ok", connectionId: this.id, advertised: negotiated.authMethods });
  await this.applyAuthIntent(machine);
}
```

```ts
// packages/acp-agents/src/acp-client.ts — new PooledConnection method
private async applyAuthIntent(machine: BackendAuthMachine): Promise<void> {
  if (machine.state !== "credentials_held" && machine.state !== "authenticated") {
    this.stampApplied(machine.generation);            // nothing to apply; mark current
    return;
  }
  const intent = machine.intentView();
  if (intent?.klass !== "in-process") {               // disk (native store) + spawn-env (env at spawn)
    this.stampApplied(machine.generation);            //   need no RPC — a fresh process already has them
    return;
  }
  const meta = machine.applyMeta();
  try {
    await this.rawAgentRequest(AGENT_METHODS.authenticate, {
      methodId: intent.methodId, ...(meta ? { _meta: meta } : {}),
    });
    this.stampApplied(machine.generation);
    machine.send({ t: "apply_ok", connectionId: this.id, generation: machine.generation });
  } catch (err) {
    machine.send({ t: "apply_failed", connectionId: this.id, generation: machine.generation, error: err });
    throw err;                                         // -> AUTH_REQUIRED via §1.5; connection unusable
  }
}
```

The `authenticate` RPC payload matches the wire contracts the agents read: claude gateway consumes `_meta.gateway.{baseUrl,headers}` (`acp-agent.js:3135-3147`); codex gateway consumes `_meta["gateway"].{baseUrl,providerName,headers}` (`index.js:25083-25089`) and api-key consumes `_meta["api-key"].apiKey` (`index.js:25063`); the request shape is the spec `AuthenticateRequest = { methodId, _meta? }` (`schema/types.gen.d.ts:4494-4510`).

Because `applyAuthIntent` runs inside `initialize()`, it executes **identically on all three connection types**:

- **Pooled** connections (`pool.selectConnection` → `PooledConnection.create`, `pool.ts:122`) replay at their one-time `initialize`.
- **Dedicated** connections (`runner.createDedicatedConnection`, `runner.ts:739-748`) are constructed with the same `AuthStore` dep and replay at their own `initialize` — this is the direct fix for the dispose-after bug: the *intent* is durable, so a dedicated connection re-primes the credential every time it is spun up.
- **Interactive** sessions (`createInteractiveSession` → dedicated connection, `runner.ts:721`) inherit the same path; no lifecycle change beyond the shared `AuthStore`.

For a `disk` or `spawn-env` intent, `applyAuthIntent` sends no RPC — a freshly spawned process already carries the credential (native store re-read, or env injected at spawn, §2.8) — it only stamps the connection current. This holds for bare-`agent` `disk` methods too (codex `chat-gpt`, opencode `opencode-login`, a canonical `AuthMethodAgent`): their **one-shot login `authenticate({ methodId })` fires once from the `completeAuth`/`applyResolution` path (§2.9)** — the moment the credential is written to the agent's native store — so every subsequent fresh `initialize` re-reads that store and needs no replay. Only `in-process` (gateway) intents require a per-`initialize` replay, because their credential lives on the process and dies with it.

### 2.6 Pool recycle after host-completed auth: generation-gated selection + drain

`AcpAgentPool.selectConnection` (`packages/acp-agents/src/pool.ts:110-136`) is rewritten from "reuse any idle live connection" to "reuse any idle live connection **that is not stale**, reconciling stale ones first." This is the mechanical proof that no session is served under stale auth. Stale-but-busy connections are **drained, not disposed synchronously**, so in-flight prompts finish under the auth they started with.

```ts
// packages/acp-agents/src/pool.ts — replaces selectConnection (:110-136)
private selectConnection(backend: Backend): PooledConnection {
  const key = backend.poolKey ?? backend.id;
  const machine = this.deps.authStore?.machineFor(key, backend.authProfile);
  const conns = this.connectionsFor(key);

  for (const c of conns.filter((c) => c.alive)) {
    if (!machine?.isStale(c.authStamp)) continue;
    if (c.canLiveReapply(machine) && c.activeSessions === 0) c.scheduleReapply(machine); // in-process: re-auth idle conn live
    else if (c.activeSessions === 0) { void c.dispose(); this.drop(key, c); }             // disk/spawn-env: recycle idle now
    else c.markForRecycleWhenIdle(machine);                                               // BUSY: drain, then recycle
  }

  const usable = conns.filter((c) => c.alive && !c.recyclePending && !machine?.isStale(c.authStamp));
  const idle = usable.find((c) => c.activeSessions === 0);
  if (idle) return idle;
  if (usable.length < this.size) return this.spawn(key, backend);   // fresh process primes current intent at initialize
  return usable.length
    ? usable.reduce((least, c) => (c.activeSessions < least.activeSessions ? c : least))
    : this.spawn(key, backend);
}

/** Public: reconcile every live connection for a backend to the current generation. Never blocks. */
recycle(poolKey: string): void { /* same stale sweep as above over connectionsFor(poolKey) */ }
```

`spawn(key, backend)` is the existing `PooledConnection.create` + push path (`pool.ts:120-131`) factored into a helper so both `selectConnection` and `recycle` use it. Supporting `PooledConnection` methods (all in `acp-client.ts`):

```ts
// packages/acp-agents/src/acp-client.ts — new PooledConnection members
recyclePending = false;
scheduleReapply(machine: BackendAuthMachine): void;         // idle in-process conn: re-send authenticate, re-stamp
markForRecycleWhenIdle(machine: BackendAuthMachine): void;  // sets recyclePending = true
async reapplyAuthIfStale(machine: BackendAuthMachine): Promise<boolean>; // in-process -> true (re-applied); else false
```

`release()` (the session-slot return path) disposes-and-drops instead of returning the connection to the pool when `recyclePending` is set. **Live re-apply** (`reapplyAuthIfStale`/`scheduleReapply`) re-sends `authenticate` on an idle live `in-process` connection and re-stamps it — matching that gateway credentials persist for the process lifetime (claude `acp-agent.js:547`, `:553-555`; codex `index.js:25091-25099`, `restartRequired:"false"` `index.js:24179`); for `spawn-env`/`disk` it returns `false`, forcing a recycle so the next process picks up the new env / native store.

**Pool-size-1, multiplexed correctness:** at most one live connection per key. On `host_authenticate`, `generation` bumps; the next `acquire`/`acquirePrepared` (`pool.ts:70,86` — the only session-opening paths, reached from `run()` at `runner.ts:521`) finds the connection stale and either live-re-applies (idle, in-process) or drains-then-recycles it. In-flight sessions on the old process finish under the old auth; the process is disposed once idle. No session is opened on a connection whose `appliedGeneration < generation`.

`completeAuth` (§2.9) calls `pool.recycle(poolKey)` immediately after `host_authenticate`, so a host that authenticates out-of-band and then calls `run()` again always lands on a current connection.

### 2.7 In-process (gateway) vs disk-persisted methods — concrete behavior

| Method (agent) | `klass` | On `host_authenticate` | On every fresh `initialize` | On `logout` |
|---|---|---|---|---|
| claude `gateway`/`gateway-bedrock` | `in-process` | record `authenticateMeta`, bump gen, recycle | replay `authenticate({methodId,_meta})` (§2.5) | zeroize meta, `authenticate` re-required |
| codex `gateway` | `in-process` | same | same replay | same |
| codex `api-key` | `disk` | record intent, bump gen, recycle; **no login RPC** — key reaches the app-server via env / `DEFAULT_AUTH_REQUEST` at spawn (§2.8/§3.3) | **no RPC** — app-server re-reads `auth.json` (`index.js:25105-25114`) | agent `logout` clears `auth.json` (`index.js:25166-25170`) |
| codex `chat-gpt` (interactive) | `disk` | fire **one-shot** `authenticate({methodId})` (browser OAuth; §2.9 step 3), persist to `auth.json`, bump gen, recycle | **no RPC** — app-server re-reads `auth.json` (`index.js:25105-25114`) | agent `logout` clears `auth.json` (`index.js:25166-25170`) |
| claude terminal (`claude-ai-login` etc.) | `disk` | record intent, bump gen, recycle | **no RPC** — native CLI store (`acp-agent.js:557-558`) | agent `logout` shells `claude auth logout` (`acp-agent.js:559-562`) |
| opencode `opencode-login` | `disk` | record intent (no-op success), recycle | **no RPC** — `authenticate` is a no-op (`opencode acp/service.ts:139-144`); creds come from env/`auth.json` | not advertised → gated off (§3) |

The load-bearing distinction: for `in-process` methods the credential lives on the process and is lost on respawn, so it **must** be replayed at every `initialize` and re-applied on every recycle; for `disk` methods the credential lives in the agent's native store or env, so a fresh process already has it and the library sends nothing.

### 2.8 Spawn-time auth channels

**Env-injection API for built-in backends (spawn-env class).** A single-line overlay at the spawn site — no `Backend.spawnConfig()` signature change. The spawn lives in the `PooledConnection` constructor (`packages/acp-agents/src/acp-client.ts:936`, spawn call at `:951-954`; the static `create` at `:1043` delegates to it):

```ts
// BEFORE: const { command, args, env } = backend.spawnConfig();
//         const child = spawn(command, args, { stdio: ["pipe","pipe","pipe"], env });
const { command, args, env } = backend.spawnConfig();
const overlay = this.authStore?.spawnEnvFor(backend.poolKey ?? backend.id);   // machine.spawnEnv() + profile.spawnAuthEnv (§3)
const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: overlay ? { ...env, ...overlay } : env });
```

```ts
// packages/acp-agents/src/auth/auth-store.ts — AuthStore method
spawnEnvFor(poolKey: string): Record<string, string> | undefined;
// returns machine.spawnEnv() (env_var collected values) merged with the backend profile's
// spawnAuthEnv(intent) contribution (§3); undefined when neither applies.
```

Built-in backends pass raw `process.env` today (`claude.ts:19-33`, `codex.ts:27-39`, `opencode.ts:22-30`); custom already merges `config.env` over `process.env` (`custom.ts:49-55`). The overlay slots cleanly above both — pre-set provider keys (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`/`OPENAI_API_KEY`, opencode `*_API_KEY`/`OPENCODE_AUTH_CONTENT`, `index.js:25116-25121`; `opencode auth/index.ts:59-63`) pass through unchanged; the overlay only *adds* host-collected values. Because a spawn-env credential is applied at spawn, a `generation` bump respawns the process with the new value — env injection participates in recycle correctly with no extra code.

**Codex `DEFAULT_AUTH_REQUEST` — optional belt-and-suspenders, delivered via the codex profile.** Research confirmed a startup env channel: `startAcpServer()` parses `DEFAULT_AUTH_REQUEST` (a full `{methodId,_meta?}` JSON object) at boot (`index.js:29584`, `:29587-29588`) and, on the first gated request, auto-runs `authenticate(defaultAuthRequest)` instead of throwing (`checkAuthorization`, `index.js:27386-27391`). This capability is delivered **only** through `codexAuthProfile.spawnAuthEnv(intent)` (defined in §3.3), which emits `DEFAULT_AUTH_REQUEST=JSON.stringify({ methodId, _meta })` for `api-key`/`gateway` intents. It is layered **on top of** the universal post-`initialize` replay (§2.5), never replacing it and never required for correctness — the replay already covers codex. There is **no `if (backend.id === "codex")`** anywhere in this section's code; the codex profile boundary is the entire seam (Principle 1/6). claude and opencode define no `spawnAuthEnv` — a truthful asymmetry, not a ranking.

### 2.9 Host-completed auth: `completeAuth` + the shared `applyResolution`

`AcpRunnerOptions` gains `onAuth?: AuthResolver` (resolver type from §1.3); the `authCapabilities` advertisement field is specified in §1.2. The runner constructs the single `AuthStore` and threads it into `AcpPoolDeps.authStore` and into every `createDedicatedConnection` deps object (`runner.ts:739-748`).

```ts
// packages/acp-agents/src/runner.ts — high-level write path (the read path describeAuthMethods is §1.3)
export interface CompleteAuthOptions extends AuthMethodsOptions {
  methodId: string;
  resolution: AuthResolution;   // §1.3
  label?: string;
}
export type AuthOutcome = { status: "authenticated" | "cancelled"; methodId: string; recycled: boolean };

class AcpAgentRunner {
  completeAuth(opts: CompleteAuthOptions): Promise<AuthOutcome>;   // records intent, bumps gen, recycles pool
  readonly auth: AuthController;                                   // §2.10 controller
}
```

`completeAuth` and the inline resolver (§2.11) share one internal `applyResolution(backend, methodId, resolution)`:

1. `{ outcome: "cancelled" }` → return `{ status: "cancelled" }`; no state change.
2. else build the `AuthIntent` (§2.2 mapping): record the payload/`methodType` from the outcome, but **derive `klass` from the chosen method's `type` + `_meta` shape** (looked up in the backend's advertised `authMethods[]`, §2.1) — `applyResolution` never sets `klass` from `AuthResolution.outcome`. So codex `api-key` supplied as `{ outcome: "meta" }` records `klass:"disk"`/`diskBacked:true` (its `_meta` is not gateway-shaped), is consumed via `spawnAuthEnv`/`DEFAULT_AUTH_REQUEST` (§3.3) rather than held as an in-process replay cred, and does not wrongly re-pause on cold resume (§2.13).
3. **If `resolution.outcome === "agent-login"`** (a bare, `interactive` `agent` method): acquire a connection and fire the **one-shot** `authenticate({ methodId })` so the agent runs its own login (codex `chat-gpt` opens the browser and blocks on `account/login/completed`, `dist/index.js:25066-25080`; a canonical `AuthMethodAgent` logs in internally and persists to its native store). Await it; on success record the `disk`/`diskBacked:true` intent and `machine.send({ t: "host_authenticate", intent })` then `machine.send({ t: "apply_ok", … })` (→ `authenticated`); on failure surface `AUTH_REQUIRED` (§1.5). This is the sole path from which the initial bare-`agent` login RPC ever fires.
4. else `machine.send({ t: "host_authenticate", intent })` (bumps `generation`, → `credentials_held`).
5. `pool.recycle(poolKey)` and return `{ status: "authenticated", methodId, recycled: true }`.

The per-connection `authenticate` RPC for an `in-process` intent is **not** sent from step 4 — it is sent by each connection's `applyAuthIntent`/`reapplyAuthIfStale` on the *pooled* process (§2.5/§2.6), which is precisely why the credential stays alive where the old dedicated-connection path (`runner.ts:319-331`) lost it. The bare-`agent` `agent-login` RPC (step 3) is the one exception, and it is fired exactly once because its result is persisted to disk.

The legacy `runner.authenticate()` / `runner.logout()` (`runner.ts:312-421`) are rebuilt off dispose-after: `authenticate()` records into the `AuthStore` and recycles instead of disposing; `logout()` clears the store (`machine.send({t:"logout"})`, zeroizing secrets) and recycles, so a logged-out backend never replays a stale gateway cred, then issues the agent `logout` RPC where advertised (gated by `NegotiatedCapabilities.supportsLogout`, `capabilities.ts:106`; opencode does not advertise it, §3.4).

### 2.10 The `runner.auth` controller

```ts
// packages/acp-agents/src/runner.ts
export interface AuthStatusSnapshot {              // redacted; ids/types/names only (§2.14)
  backendId: string;
  poolKey: string;
  state: BackendAuthState;
  methods: { id: string; type: "agent" | "terminal" | "env_var"; name?: string }[];
  authenticated: boolean;
  canResume: boolean;
}
// Canonical shape (also surfaced by the MCP tool and web — §4.1).

export interface AuthController {
  methods(opts?: AuthMethodsOptions): Promise<AuthMethodDescriptor[]>;           // §1.3 builder; alias of describeAuthMethods
  authenticate(opts: CompleteAuthOptions): Promise<AuthOutcome>;                 // = completeAuth
  logout(opts?: LogoutOptions): Promise<void>;
  status(opts?: { backend?: string }): AuthStatusSnapshot[];
  canResume(backendId: string): boolean;                                        // §2.13
}
```

### 2.11 Retry interaction: inline resolve-and-retry-once

At the run seam — `run()`'s `pool.acquirePrepared` call (`runner.ts:521`) — if `session/new` throws `-32000` (classified by §1.5) **and** `this.onAuth` is set: catch it, build the `AuthContext` (§1.3) from `connection.capabilities.authMethods`, invoke the resolver, feed the returned `AuthResolution` through `applyResolution` (§2.9), then **retry `acquirePrepared` exactly once**.

Load-bearing invariants (do not weaken):

- **Retry-once guard.** A second `-32000` on the retry propagates as `AUTH_REQUIRED` (→ pause, §2.12). No unbounded auth loop is possible.
- **Mutual exclusivity with pause.** When `onAuth` is set the run resolves auth *before* the error escapes, so it **never pauses**. Pause is strictly the *no-resolver* path. Interactive/long-lived hosts (SDK, web, local runner) resolve inline; headless/tool hosts (MCP, scheduled) pause-and-resume. The two are mutually exclusive by construction.
- **Composability.** The resolver is a plain async callback; concurrent multiplexed sessions each get their own `AuthContext`, so it composes with pool-size-1 multiplexing with no new locking.

Both `-32000` trip points are covered: at `session/new` (all three: claude `createSession` `acp-agent.js:2954-2957`; codex `checkAuthorization` `index.js:27394`; opencode via `ProviderAuthError` on model-invoking calls, `service.ts:856-858`) and mid-`session/prompt` wherever the agent emits it (claude "Please run /login" `acp-agent.js:1362-1363`; opencode `ProviderAuthError`; codex emits `-32000` mid-turn only on a never-authenticated process, §3.3). Mid-run expiry maps to the machine's `authenticated → auth_required` transition (§2.3) exactly when the agent signals it with the protocol's `-32000`; a mid-turn auth failure surfaced under any other reserved code follows the standard recoverable-error path (retry, then a readable failure) — the pause contract is keyed on the protocol's auth signal and nothing else.

### 2.12 Engine + WorkflowManager pause-for-auth

`AUTH_REQUIRED` is already `recoverable:false` (`shared-types/src/errors.ts:24-25`; `errors-map.ts:47-52`), so the retry ladder already skips it — only the pause branch is missing. Generalize the `PROVIDER_USAGE_LIMIT` pause branch in `packages/workflow-engine/src/workflow-manager.ts` (`:620-658`, mirror Principle 8):

```ts
// packages/workflow-engine/src/workflow-manager.ts — executeRun() catch (:620)
const isPauseCode =
  workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT ||
  workflowError.code === WorkflowErrorCode.AUTH_REQUIRED;
const paused = !managed.controller.signal.aborted && isPauseCode;
// ... managed.status = "paused" when paused (existing logic at :627-631) ...
if (paused) {
  const reason = workflowError.code === WorkflowErrorCode.AUTH_REQUIRED ? "auth_required" : "usage_limit";
  this.emit("paused", {
    runId: managed.runId, reason,
    error: workflowError,
    resetHint: workflowError.resetHint,        // undefined for auth
    authContext: workflowError.authContext,    // structured, non-secret (§1.5)
  });
}
```

- There is **no typed `PausedEvent`/events module** to widen: `WorkflowManager` extends node's `EventEmitter` with an untyped `override emit(eventName: string | symbol, ...args: unknown[])` (`workflow-manager.ts:199`), and the paused payload is a bare object literal (the existing `usage_limit` emit is at `workflow-manager.ts:644-648`). The generalized emit simply constructs that literal with `reason: "auth_required"` and an added `authContext` field (`AuthErrorContext`, §1.5). `reason` is already a free-form `string` on `WorkflowRunResult` (`workflow-result.ts:101`) and on the emitted payload, so **no union widening or type change is required** — the value just takes a new string. (The only `PausedPayload` type in the repo lives in `packages/agentprism-otel/src/types.ts` and is unrelated to this emit.)
- `persistRun` (`workflow-manager.ts:692-699`): the `pauseReason` selector switches on `managed.error?.code` (`AUTH_REQUIRED → "auth_required"`, `PROVIDER_USAGE_LIMIT → "usage_limit"`) and persists the **non-secret** `authContext` (backendId + method ids/types/names only — never `authenticateMeta`, never `envValues`). `resetHint` stays usage-limit-only. `PersistedRunState.pauseReason` (`packages/workflow-engine/src/run-persistence.ts:43`) is already a free-form string → no migration; add `authContext?: AuthErrorContext` to `PersistedRunState` and `WorkflowRunResult`.
- `composeResult` (`workflow-manager.ts:~426`): a paused run carrying `AUTH_REQUIRED` reports `reason: "auth_required"`.
- `packages/workflow-engine/src/errors.ts` needs no change — `wrapError` passes an existing `WorkflowError` through with `authContext` intact.

No host parses the enriched message string; the machine-readable contract is `authContext` (§1.5). The `authRequiredMessage` enrichment (`errors-map.ts:77-83`) stays for human readability only.

### 2.13 Resume-after-auth

- **Warm resume (same process).** `manager.resume(runId)` (`workflow-manager.ts:751`) replays the journal and re-runs the failed agent live. Auth state lives in the runner's `AuthStore`, not the journal, so a resume after `completeAuth` naturally acquires an authed connection (the stale sweep in §2.6 does the rest). No secret is ever read from disk.
- **Cold resume (new process).** The `AuthStore` is empty, so an `in-process` gateway / `env_var` intent is gone; a `disk` intent survives (native store / env). Mechanized re-arm:

```ts
// packages/acp-agents/src/runner.ts — AuthController
canResume(backendId: string): boolean;
// true iff machine.state ∈ {authenticated, credentials_held}
//   OR the persisted pause's intent was diskBacked.
```

`workflow-manager.ts resume()` (`:751`), before re-executing, when `persisted.pauseReason === "auth_required"`: consult `runner.auth.canResume(persisted.authContext.backendId)`. If `false` (in-process/env intent lost to a cold process), `resume` **immediately re-pauses** with the same `AUTH_REQUIRED` and message `"re-supply credentials for <backend> via runner auth before resuming"`. If `true`, resume proceeds: disk-backed methods (codex `api-key`/`chat-gpt`, claude terminal login) are re-read from the native store by a fresh process, and a bare re-`initialize` (plus in-process replay only when `credentials_held`) succeeds. **No secret is ever needed on the disk-backed happy path, and no secret is ever persisted.**

### 2.14 Secret-handling rules

Credential material — API keys, gateway headers, `authenticate` `_meta` payloads, collected env values — never appears in logs, events, journals, or error messages (Principle 9).

- **Single home.** The `AuthStore` (`auth-store.ts`) is the only place `authenticateMeta`/`envValues` live: in-memory in the runner; a native-TTY CLI host may additionally file-back it at mode `0600` (§4.4). Nowhere else.
- **Redaction at every boundary.** `BackendAuthMachine.intentView()` and `AuthStatusSnapshot` expose only `backendId`/`methodId`/`methodType`/`name` — never the secret fields. `AuthErrorContext` (§1.5) and the persisted `authContext` (§2.12) carry ids/types/names only.
- **Never on the wire out.** Secrets flow only through resolver return values (`AuthResolution`) and into the spawn env. The engine's persisted run journal (`persistRun`) records `pauseReason` + non-secret `authContext`, never the intent's secret payload.
- **Spawn hygiene.** The env overlay (§2.8) is passed straight to `spawn`, never logged, never included in `backend_error` events (`acp-client.ts:1145`), never in the `SpawnConfig` returned to callers. `stderrTail` (`acp-client.ts:960-962`) is run through a redaction pass that strips known key patterns before it can appear in any error suffix.
- **Zeroization on logout.** The `logout` transition (§2.3) clears `intent` and zeroizes `authenticateMeta`/`envValues` so a logged-out backend cannot replay a stale gateway cred, and bumps `generation` so every live connection recycles.

---

## 3. Integration profiles

This section records the per-agent behavior of the four first-class ACP servers — Claude Code
(`@agentclientprotocol/claude-agent-acp` 0.57.0), Codex (`@automatalabs/codex-acp` 1.5.2, our fork),
OpenCode (`opencode-ai` 1.17.14), and Pi (`@automatalabs/pi-acp` 0.1.1) — plus the custom-agent
conformance profile and the complete `_meta` support matrix. Every profile is **pure data layered on
top of the type-driven base flow**; a profile may enrich, label, or contribute a spawn overlay, but it
**never gates the flow** (Principle 1). Conformance is defined by the *absence* of a profile.

Each agent profile uses the same six-facet structure — **advertised methods + gates**, **per-method
completion path**, **persistence semantics**, **logout**, **spawn-time auth**, **quirks** — with equal
depth. Pi's server-side wire details remain frozen in `docs/specs/pi-acp-spec.md` §9.5.

### 3.1 The `AuthProfile` seam

**New file `packages/acp-agents/src/auth/auth-profiles.ts`.** One profile object per built-in backend; custom backends supply none.

```ts
// packages/acp-agents/src/auth/auth-profiles.ts (new)
import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { ClientCapabilityOptions } from "../client-handlers.js";
import type { AuthMethodDescriptor, AuthResolution } from "./auth-types.js";   // §1.3
import type { AuthIntent } from "./auth-store.js";                             // §2 (lifecycle)

/** The spawnable interactive login a host runs in a TTY. Identical to the `launch`
 *  member of the `terminal` `AuthMethodDescriptor` (§1.3). */
export interface TerminalLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  label?: string;
}

/** Per-agent adapter. Every field is DATA/ENRICHMENT only — none gates the base flow.
 *  A backend with no profile runs the base flow verbatim (conformance-by-absence). */
export interface AuthProfile {
  readonly backendId: string;
  /** Which auth method TYPES to advertise for this backend, given host affordances.
   *  Refines the runner default derivation in §1.2; still connection-lifetime-fixed. */
  clientAuthCapabilities(host: { onAuth: boolean; terminal: boolean }): ClientCapabilityOptions["auth"];
  /** Enrich/label the base descriptor for one advertised method. MUST delegate type
   *  dispatch to the §1.3 buildAuthDescriptors dispatcher; may only override name/description/label. */
  describe(method: AuthMethod, base: AuthMethodDescriptor): AuthMethodDescriptor;
  /** Terminal launch override; base falls back to §1.3's launch-resolution order. */
  terminalLaunch?(method: Extract<AuthMethod, { type: "terminal" }>): TerminalLaunch;
  /** Wrap a `{outcome:"meta"}` resolution into the agent's expected authenticate `_meta`. */
  buildMeta?(method: AuthMethod, resolution: Extract<AuthResolution, { outcome: "meta" }>): Record<string, unknown>;
  /** OPTIONAL spawn-env overlay contributed regardless of `klass` (§2.8, Principle 9).
   *  Codex only — the lever channel. Secret; consumed inside `spawnEnvFor`, never logged. */
  spawnAuthEnv?(intent: AuthIntent): Record<string, string> | undefined;
}

export const claudeAuthProfile: AuthProfile = { /* §3.2 */ };
export const codexAuthProfile: AuthProfile = { /* §3.3 */ };
export const opencodeAuthProfile: AuthProfile = { /* §3.4 */ };
export const piAuthProfile: AuthProfile = { /* §3.4.1 */ };
```

**`Backend` gains one optional field** (`packages/acp-agents/src/backend.ts`, appended to the `Backend` interface at the `readonly authProfile?` slot):

```ts
// packages/acp-agents/src/backend.ts
import type { AuthProfile } from "./auth/auth-profiles.js";
export interface Backend {
  // …existing readonly members…
  /** Per-agent auth adapter. UNDEFINED for custom backends → the base flow (conformance). */
  readonly authProfile?: AuthProfile;
}
```

Built-ins wire theirs with a single line each: `packages/acp-agents/src/backends/claude.ts` sets
`readonly authProfile = claudeAuthProfile;`, `packages/acp-agents/src/backends/codex.ts` sets
`codexAuthProfile`, `packages/acp-agents/src/backends/opencode.ts` sets `opencodeAuthProfile`, and
`packages/acp-agents/src/backends/pi.ts` sets `piAuthProfile`. `packages/acp-agents/src/backends/custom.ts`
leaves it undefined. The lifecycle spine (§2) reads `backend.authProfile` when computing `spawnEnvFor`
(§2.8) and when the runner derives client capabilities (§1.2); `describeAuthMethods`/`completeAuth`
(§1.3, §2.9) consult `profile.describe`/`buildMeta`. The base dispatcher `buildAuthDescriptors` (§1.3)
is authoritative for the `type` discriminant and the terminal-vs-agent decision below; a profile only
re-labels the result.

**Decision — terminal classification (owned by §1.3, relied on by all profiles).** `buildAuthDescriptors` yields a `terminal` descriptor **iff** `method.type === "terminal"` **or** the method carries `_meta["terminal-auth"] = {command,args,label}`. This is why OpenCode's bare-`agent` `opencode-login` (which carries only a `terminal-auth` hint, opencode `packages/opencode/src/acp/service.ts:101-107`) becomes a `terminal` descriptor for us, while Codex's bare-`agent` `gateway` (which carries `_meta.gateway`, codex-acp `dist/index.js:24176`) does not.

---

### 3.2 Claude Code — `@agentclientprotocol/claude-agent-acp` 0.58.1

Agent identity `{ name: "@agentclientprotocol/claude-agent-acp", title: "Claude Agent", version: "0.57.0" }`, peer name `"claude-code-acp"`, `protocolVersion: 1` (claude-agent-acp `dist/acp-agent.js:411,439-443,4181`). Auth-required factory is SDK `-32000` (`@agentclientprotocol/sdk@1.2.1 dist/jsonrpc.js:821-822`).

#### Advertised methods + gates
Five method objects, 0–4 emitted per `initialize`, assembled `[...terminalAuthMethods, ...(supportsGatewayAuth ? [gateway, gateway-bedrock] : [])]` (`dist/acp-agent.js:444-447`). Gate variables: `supportsGatewayAuth = clientCapabilities.auth._meta.gateway === true` (`:317`); `supportsTerminalAuth = clientCapabilities.auth.terminal === true` (`:338`); `supportsMetaTerminalAuth = clientCapabilities._meta["terminal-auth"] === true` (`:339`); `isRemote` from `NO_BROWSER`/`SSH_*`/`CLAUDE_CODE_REMOTE` (`:344-348`).

| Method | Type | Gate |
|---|---|---|
| `claude-ai-login` "Claude Subscription", `args:["--cli","auth","login","--claudeai"]` (`:372-378`) | `terminal` | non-remote branch **and** `!shouldHideClaudeAuth() && (supportsTerminalAuth \|\| supportsMetaTerminalAuth)` (`:403-405`) |
| `console-login` "Anthropic Console", `args:["--cli","auth","login","--console"]` (`:379-385`) | `terminal` | non-remote branch **and** `(supportsTerminalAuth \|\| supportsMetaTerminalAuth)` (`:406-408`) — **not** suppressed by `--hide-claude-auth` |
| `claude-login` "Log in with Claude", `args:["--cli"]` (`:351-357`) | `terminal` | `isRemote` branch **and** `!shouldHideClaudeAuth() && (…)` (`:367-369`) |
| `gateway`, `_meta.gateway.protocol:"anthropic"` (`:318-327`) | `agent` (no `type`) | `supportsGatewayAuth` (`:446`) |
| `gateway-bedrock`, `_meta.gateway.protocol:"bedrock"` (`:328-337`) | `agent` (no `type`) | `supportsGatewayAuth` (`:446`) |

Claude reveals terminal methods on `auth.terminal===true` **or** `_meta["terminal-auth"]===true`, so `claudeAuthProfile.clientAuthCapabilities({onAuth,terminal})` returns `{ terminal, gateway: onAuth }` — and §1.2 lights **both** `auth.terminal` and the top-level `_meta["terminal-auth"]` channel plus `auth._meta.gateway`. There is **no `env_var` method**; Anthropic API-key auth is spawn-env only (§3.2 spawn-time).

#### Per-method completion path (through our flows)
- **Terminal (`claude-ai-login`/`console-login`/`claude-login`)** → §1.3 `terminal` descriptor, `klass:"disk"` (§2.1). `launch` is taken from `_meta["terminal-auth"]={command:process.execPath,args:[…,"--cli",…],label}` when present (`:359-401`), else from the binary + `AuthMethodTerminal.args` (§1.3 launch order). The host (local runner or another native-TTY host, §4.4/§4.5) spawns it in a TTY and returns `{outcome:"completed"}`. **We never send `authenticate` for these** — the agent's `authenticate` throws a plain `Error("Method not implemented.")` for any non-gateway id (`:550`), which is not a `RequestError` and would surface as an opaque internal error. The descriptor `type:"terminal"` structurally prevents an RPC (§1.3 dispatch table).
- **`gateway`/`gateway-bedrock`** → §1.3 `agent` descriptor with `expectsMeta:true` (method carries `_meta.gateway`), `klass:"in-process"` (§2.1). Host returns `{outcome:"meta", methodId, meta:{gateway:{baseUrl,headers}}}`; `claudeAuthProfile.buildMeta` passes the gateway payload through. The lifecycle spine records the in-process intent and **replays `authenticate({methodId,_meta:{gateway:{…}}})` after every `initialize`** (§2.5). The agent stores the whole request on the instance (`this.gatewayAuthRequest = _params`, `:547`) and injects it into each session's SDK-subprocess env via `createEnvForGateway` (`:2818,3131-3151`). After a generation bump the pooled process is recycled/re-primed (§2.6), replaying on the fresh connection — this is the dispose-after-authenticate fix (gap 3) applied to Claude.

#### Persistence semantics
- **`gateway`/`gateway-bedrock`: in-process only.** Field declared `:303`, set `:547`; comment "the gateway method never touches the on-disk credential store" (`:553-554`); lost on process exit → `klass:"in-process"`, `diskBacked:false`. A cold resume re-pauses via the re-arm (§2.13).
- **Terminal methods: on-disk native store** (keychain or `CLAUDE_CONFIG_DIR`/`~/.claude`, `:14`); the ACP agent process never writes them (comment `:557-558`) → `klass:"disk"`, `diskBacked:true`. A fresh spawn inherits them; cold resume proceeds clean (§2.13).

#### Logout
Advertised: `agentCapabilities.auth = { logout: {} }` (`:426-428`) → our `NegotiatedCapabilities.supportsLogout` is true (`packages/acp-agents/src/capabilities.ts:106`). The agent's `logout` (`:552-570`) unconditionally clears in-memory gateway (`this.gatewayAuthRequest = undefined`, `:556`) **and** runs `claude auth logout` (`execFileAsync`, `:562`), throwing `internalError` (`-32603`) on failure (`:564-569`). `runner.logout()` (§4.1) sends the RPC over a dedicated connection, emits the machine `logout` event (zeroizes `authenticateMeta`/`envValues`, §2.3, §2.14, Principle 9), and `pool.recycle`s so no pooled process replays a stale gateway cred.

#### Spawn-time auth
No advertised `env_var` method, but the child `@anthropic-ai/claude-agent-sdk` subprocess is spawned with `env: { ...process.env, ...userProvidedOptions.env, ...createEnvForGateway(this.gatewayAuthRequest), … }` (`:2815-2821`), so `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`/Bedrock/Vertex vars present in `process.env` pass straight through. Our single spawn-site overlay (§2.8) stacks host-collected env values above `process.env` for the built-in claude backend (`packages/acp-agents/src/backends/claude.ts`). Managed-policy env is applied at startup (`dist/index.js:42-50`). `claudeAuthProfile` sets **no `spawnAuthEnv`** — Claude has no `DEFAULT_AUTH_REQUEST`-style pre-auth channel and is consumed client-side only (Principle 6). Gateway env injection is per-session (`ANTHROPIC_BASE_URL`/`ANTHROPIC_CUSTOM_HEADERS`/`ANTHROPIC_AUTH_TOKEN=" "` for anthropic; `CLAUDE_CODE_USE_BEDROCK`/`AWS_BEARER_TOKEN_BEDROCK=" "`/`ANTHROPIC_BEDROCK_BASE_URL` for bedrock, `:3131-3151`).

#### Quirks
- `authenticate` throws a plain `Error` (not `RequestError`) for every non-gateway id (`:550`); the `terminal` descriptor type is what keeps us from ever calling it (§1.3).
- `authenticate` does **not** re-check `supportsGatewayAuth` — it will store a gateway request even if never advertised (`:545-551`); harmless for us (we only send it for a `gateway` descriptor).
- `console-login` is **not** suppressed by `--hide-claude-auth`, unlike `claude-ai-login`/`claude-login` (`:406-408` vs `:403-405,367-369`).
- `--hide-claude-auth` + a resolved claude.ai subscription + no gateway cred throws `-32000` "This integration does not support using claude.ai subscriptions." at `session/new` (`:2954-2957`) — a legitimate `AUTH_REQUIRED` our code-only matcher (§1.5) and pause (§2.12) handle.
- `clientCapabilities` are snapshotted once at `initialize` and never reflect mid-session changes (`:314,1085-1088`) — matching our connection-lifetime-fixed advertisement (§1.2).

---

### 3.3 Codex — `@automatalabs/codex-acp` (workspace) (our fork)

The installed fork version is 1.5.2. The detailed offsets in this subsection were originally captured against 1.4.0 and are retained as snapshot evidence; the current dependency is additionally covered by the executable dist probes and live tests described in §4.6. `protocolVersion: 1` (snapshot `dist/index.js:3744,27335`). Persistence is delegated to the bundled `@openai/codex@0.142.5` Rust app-server, spawned as `codex app-server` (`:21703-21706`). The auth-required factory uses `-32000` (`:20628-20632`).

**Lever note (Principle 6).** codex-acp is *our* maintained fork; agent-side changes are in scope and are specced here. The fork's raison d'être is turn-level `_meta["outputSchema"]` forwarding (`:25467-25471`, the only Automata patch marker). The `DEFAULT_AUTH_REQUEST` spawn channel (`:29587-29588,27386-27391`) and the `gateway` method present as upstream behavior; because we own the fork, `codexAuthProfile.spawnAuthEnv` (below) is a maintained lever we rely on, whereas Claude/OpenCode receive only client-side adaptation. This is a constraint difference, not a priority ranking.

#### Advertised methods + gates
Three **agent-type** methods (no `type` field, `zAuthMethodAgent`, `:18821-18834`) from `getCodexAuthMethods(clientCapabilities, env)` (`:24183-24193`, returned `:27363`):

| Method | `_meta` | Gate |
|---|---|---|
| `api-key` "API Key" (`:24157-24166`) | `_meta["api-key"].provider:"openai"` | **none** — seeded unconditionally (`:24184`) |
| `chat-gpt` "ChatGPT" (`:24167-24171`) | none | `if (!env["NO_BROWSER"])` (`:24185`) — environment gate |
| `gateway` "Custom model gateway" (`:24172-24182`) | `_meta.gateway.{protocol:"openai",restartRequired:"false"}` | `clientCapabilities.auth._meta.gateway === true` (`:24188-24190`) |

Codex advertises **no `env_var` or `terminal` method** even though `api-key` reads env internally — a client cannot discover the env channel from the method list. `codexAuthProfile.clientAuthCapabilities({onAuth,terminal})` returns `{ terminal: false, gateway: onAuth }` (§1.2 lights only `auth._meta.gateway`).

#### Per-method completion path (through our flows)
- **`api-key`** → §1.3 `agent` descriptor, `expectsMeta:true` (carries `_meta["api-key"]`), `klass:"disk"` (§2.1 — the `_meta` is **not** gateway-shaped, so it is not `in-process`). Two host routes, both terminating in `auth.json` (disk):
  1. `{outcome:"env", values:{CODEX_API_KEY|OPENAI_API_KEY}}` → the base spawn overlay injects the key (§2.8); Codex `readApiKeyFromEnv` reads `CODEX_API_KEY` then `OPENAI_API_KEY` (`:25115-25126`).
  2. `{outcome:"meta", methodId:"api-key", meta:{"api-key":{apiKey}}}` → `codexAuthProfile.spawnAuthEnv` (below) emits `DEFAULT_AUTH_REQUEST`; Codex auto-runs `authenticate` at its first gated request (`:27386-27391`), `authenticateWithApiKey → accountLogin` persisting to `auth.json` (`:25062-25065,25105-25114`).
  This is the descriptor-steered headless path (MCP/SDK — §4.3 caveat): `api-key` is serviced as a spawn-env credential even though it is an `agent`-type method — the exact reason the two-credential-class frame (§1.1) is type-plus-`_meta`, not type alone.
- **`chat-gpt`** → §1.3 `agent` descriptor, no `_meta`, so `interactive:true`, `klass:"disk"`. On a browser/TTY-capable surface the host returns `{outcome:"agent-login", methodId:"chat-gpt"}`; the library fires the one-shot `authenticate({methodId:"chat-gpt"})` (§2.9 step 3) → `accountRead`; an existing chatgpt account returns immediately, else it **opens a browser** (`open_default(authUrl)`) and **blocks awaiting `account/login/completed`** (`:25066-25080`). Because `interactive:true`, headless surfaces (MCP/SDK) detect and skip it (§4.3) — steering to `api-key`/`gateway`/env — rather than silently mapping it to a no-op. Persists to `auth.json` (disk), so the login RPC fires only once and every fresh process re-reads it (§2.5).
- **`gateway`** → §1.3 `agent` descriptor, `expectsMeta:true` (gateway-shaped `_meta`), `klass:"in-process"` (§2.1). Host returns `{outcome:"meta", methodId:"gateway", meta:{gateway:{baseUrl,providerName,headers}}}`; `buildMeta` passes it through. The spine replays `authenticate` after each `initialize`; Codex sets `this.gatewayConfig` in-process (`:25081-25100`), applied per session by `mergeGatewayConfig` (`:25307,25766-25778`). Layered belt-and-suspenders: `codexAuthProfile.spawnAuthEnv` also emits `DEFAULT_AUTH_REQUEST` for gateway intents so a freshly recycled process pre-authenticates before its first gated request (§2.8) — never replacing and never required for correctness (the replay covers it).

#### Persistence semantics
- **`api-key`**: on-disk `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) via `accountLogin` (`:25105-25114`; binary "stored locally in auth.json") → `diskBacked:true`.
- **`chat-gpt`**: on-disk OAuth tokens in `auth.json` → `diskBacked:true`.
- **`gateway`**: in-process only (field `:25031`, init `null` `:25040`); never written to disk; lost on restart; `restartRequired:"false"` means no restart is needed to *apply* (it is applied live per session) → `klass:"in-process"`, `diskBacked:false`; cold resume re-pauses (§2.13). `authRequired()` short-circuits `false` while `gatewayConfig != null` (`:25172-25173`).

#### Logout
Advertised: `agentCapabilities.auth = { logout: {} }` (`:27342-27344`). `logout()` → `accountLogout` → `account/logout` RPC (`:25166-25170,29042-29044`) + `refreshSessionsAuthState(null)` (`:27712`); it clears on-disk `auth.json` but **does not** clear in-process `gatewayConfig` — the only ways that reverts are a subsequent `api-key`/`chat-gpt` authenticate or a restart. Therefore `runner.logout()` (§4.1) **must `pool.recycle`** to drop the process holding `gatewayConfig`, aligning with the machine `logout → zeroize + recycle` (§2.3). Codex also exposes extension methods `authentication/status`, `authentication/logout` (`:27366-27380`); we drive the spec `logout` RPC.

#### Spawn-time auth
`DEFAULT_AUTH_REQUEST` (`:29584,29587-29588`) is a full authenticate-request JSON parsed at startup, validated by `isCodexAuthRequest` (`:24194-24196`); on the first `checkAuthorization` that finds auth needed, Codex runs `authenticate(defaultAuthRequest)` instead of throwing (`:27386-27391`). We deliver it **only** through `codexAuthProfile.spawnAuthEnv`, never an inline `if (backend.id === "codex")` (§2.8):

```ts
// codexAuthProfile.spawnAuthEnv (packages/acp-agents/src/auth/auth-profiles.ts)
spawnAuthEnv(intent: AuthIntent): Record<string, string> | undefined {
  if (intent.methodId !== "api-key" && intent.methodId !== "gateway") return undefined;
  const meta = intent.authenticateMeta; // SECRET; undefined for the env-only api-key path
  return { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: intent.methodId, ...(meta ? { _meta: meta } : {}) }) };
}
```

For the env-only `api-key` path this emits `{"methodId":"api-key"}` (forces `readApiKeyFromEnv`, whose `CODEX_API_KEY`/`OPENAI_API_KEY` the base overlay also injects). Because it is an env overlay it participates in recycle correctly — a generation bump respawns Codex with the new value (§2.8). Env auth vars honored: `CODEX_API_KEY`/`OPENAI_API_KEY` (`:25116`); the app-server binary additionally honors `CODEX_ACCESS_TOKEN`/`CODEX_AUTH`/`CODEX_HOME`. Startup subcommands: `login` (chatgpt-only browser pre-auth, `:29466-29509`), `cli` passthrough, default `startAcpServer`; `--version`.

#### Quirks
- No `env_var`/`terminal` method advertised despite `api-key` reading env — serviced via the overlay, not an advertised method (see completion path).
- `_meta.gateway.restartRequired` is the **string** `"false"`, not a boolean (`:24176-24181`).
- A falsy `authenticate` return makes the agent wrapper throw `invalidParams` (`-32602`) (`:27701-27703`); `gateway` with no `_meta` throws `invalidRequest` (`-32600`) (`:25082-25084`).
- Mid-turn auth maps to `authRequired` (`-32000`) **only** when `sessionState.authConfigured === false`; when `authConfigured === true` (the normal case after a successful login) a mid-turn 401/`unauthorized` surfaces as `internalError` (`-32603`) (`createErrorEvent`, `:23523-23538`), and `session/prompt` does not call `checkAuthorization`. **Verified against the fork dist.** Contract behavior: `-32603` is in `OTHER_RESERVED`, so the §1.5 matcher classifies such a failure as a recoverable agent error — the run retries and, if the credential stays invalid, fails with the enriched agent message rather than pausing. This is the same base-contract path every agent takes when a mid-turn auth failure is not signaled with the protocol's `-32000` (§2.11); the `authenticated → auth_required` transition (§2.3) fires only on the protocol signal. The host re-auths (any §1.3 flow) and starts or resumes the run as usual.
- `unstable_setSessionModel`, `authentication/status`, `authentication/logout` are non-core extension methods (`:27366-27381`); `mcpCapabilities` advertises HTTP-only MCP (`:27357-27361`).

---

### 3.4 OpenCode — `opencode-ai` 1.17.14

Spawned `opencode acp` (embedded HTTP server + stdio ACP, `packages/opencode/src/cli/cmd/acp.ts:25,55-61`), `protocolVersion: 1`, `agentInfo:{name:"OpenCode"}`, SDK `@agentclientprotocol/sdk@0.21.0` (wire-compatible subset). Auth-required factory `-32000` (SDK `jsonrpc.ts` `authRequired`).

**Source-grounding note (evidence-parity caveat).** Unlike Claude (`claude-agent-acp/dist/acp-agent.js`) and Codex (`@automatalabs/codex-acp/dist/index.js`), which are declared dependencies whose *compiled dist* is verifiable in `node_modules` and cited to exact lines, `opencode-ai` is **not** a declared dependency: `packages/acp-agents/src/backends/opencode.ts` resolves a compiled `opencode-ai/bin/opencode` at runtime (`require.resolve("opencode-ai/bin/opencode")`, `:52`) or falls back to the PATH `opencode`, and OpenCode ships a **compiled binary** with no consumable TypeScript. Every `packages/opencode/src/...` line citation below is therefore to **upstream source pinned at the `opencode-ai` 1.17.14 release ref** (github.com/sst/opencode at that tag), not to a local artifact — the exact line numbers cannot be re-verified against the shipped binary the way Claude's and Codex's can. The behavior these citations describe is instead grounded empirically by the §4.6.3 opencode live-e2e, which drives the shipped 1.17.14 binary end-to-end. (An alternative that would restore full evidence parity — adding `opencode-ai` as a dev/e2e dependency — is noted for the delivery track, §4.6.3.)

#### Advertised methods + gates
Exactly **one** method, `opencode-login` (id constant `service.ts:49`), always present (`service.ts:92-98`), emitted as the bare/`agent` form (no `type`):

| Method | Fields | Gate |
|---|---|---|
| `opencode-login` "Login with opencode" (`service.ts:94-98`) | `description: "Run \`opencode auth login\` in the terminal"` | base object **unconditional**; the `_meta["terminal-auth"]={command:"opencode",args:["auth","login"],label:"OpenCode Login"}` launch hint attached **only if** `clientCapabilities._meta["terminal-auth"] === true` (`service.ts:100-107`) |

There is **no `agentCapabilities.auth` key** at all (`service.ts:112-128`) → logout unadvertised. `opencodeAuthProfile.clientAuthCapabilities({onAuth,terminal})` returns `{ terminal, gateway: false }` (§1.2 lights the top-level `_meta["terminal-auth"]` channel; OpenCode has no gateway/env_var auth method).

#### Per-method completion path (through our flows)
When the host has a TTY, §1.2 advertises `_meta["terminal-auth"]`, OpenCode attaches the launch hint, and §1.3 classifies `opencode-login` as a **`terminal`** descriptor (per the §3.1 decision — presence of `terminal-auth` is authoritative), `klass:"disk"`. The host spawns `opencode auth login` in a TTY and returns `{outcome:"completed"}`; **no RPC** crosses the wire. When the host has no TTY (headless MCP/SDK), §1.2 omits the hint, OpenCode emits the bare `agent` method with no `_meta`, and §1.3 yields an `agent` descriptor with `interactive:true`, `klass:"disk"`. A headless host therefore treats it as a browser/TTY method and **skips it** (§4.3), relying on the credential having been provisioned out-of-band. This loses nothing, because OpenCode's `authenticate({methodId:"opencode-login"})` is a **pure no-op** that returns `{}`, reads no `_meta`, and performs no login (`service.ts:139-144`) — even the one-shot `agent-login` RPC would provision no credential. Either way the real credential must pre-exist (via `opencode auth login` or env keys, §3.4 spawn-time); our flow provisions it through the terminal descriptor (when a TTY is present) or the spawn-env overlay, never through the `authenticate` RPC. (This is the honest limit of a type-plus-convention base layer: it cannot distinguish a no-op bare-`agent` method like `opencode-login` from a browser-OAuth bare-`agent` method like codex `chat-gpt`, so it marks both `interactive` and lets headless hosts skip them; for OpenCode that is exactly right.)

#### Persistence semantics
`authenticate` writes/stores **nothing** (`service.ts:139-144`). Provider credentials live in `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`, `auth/index.ts:10`), written mode `0o600` (`auth/index.ts:79,88`) **only out-of-band** by the CLI `opencode auth login`, or supplied via env keys / `OPENCODE_AUTH_CONTENT`. `klass:"disk"`, `diskBacked:true`; cold resume proceeds clean (§2.13). No in-process auth state exists (the only in-memory secret is the embedded-server HTTP Basic header, `acp.ts:29` — transport auth, not provider creds).

#### Logout
**Unadvertised** — no `agentCapabilities.auth` key (`service.ts:112-128`); the agent implements no `logout` method (`agent.ts:31-84`), so a raw call would return `methodNotFound` (`-32601`). Our stack gates this off: `NegotiatedCapabilities.supportsLogout` is `false` (`capabilities.ts:106` → `advertised(agent.auth?.logout)`), and the `logout` wrapper's `assertAuthProviderSupported` (`packages/acp-agents/src/acp-client.ts:1121-1132`) refuses cleanly rather than sending an unsupported RPC. `opencodeAuthProfile` advertises no logout capability; `runner.logout()` for OpenCode clears the (empty) `AuthStore` machine and recycles — harmless, no in-process cred — but sends no RPC. Provider logout remains CLI-only (`opencode auth logout` → `Auth.remove`, `providers.ts:491-496`, `auth/index.ts:83-89`).

#### Spawn-time auth
No CLI pre-auth flags and no startup authenticate request (`acp.ts:12-18`). Authentication is achieved purely by env keys and/or a populated `auth.json` before spawn. The multi-provider models.dev registry honors per-provider keys — `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_*`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, AWS/Bedrock (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_PROFILE`/`AWS_REGION`), `AZURE_*`, Cloudflare (`CLOUDFLARE_*`), Vercel (`AI_GATEWAY_API_KEY`), etc. — plus the whole-blob override `OPENCODE_AUTH_CONTENT` (read before the on-disk file, `auth/index.ts:59-63`). When a provider key is present, that provider is authenticated with no `auth login`. Our single spawn-site overlay (§2.8) stacks host-collected provider keys / `OPENCODE_AUTH_CONTENT` above `process.env` for the built-in opencode backend (`packages/acp-agents/src/backends/opencode.ts`). `opencodeAuthProfile` sets **no `spawnAuthEnv`** (no `DEFAULT_AUTH_REQUEST` analog; Principle 6). `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` are transport auth to the embedded server (`server/auth.ts`), passed through unchanged.

#### Quirks
- `authenticate` is a pure no-op acknowledgement (`service.ts:139-144`); credentials cannot be provisioned through the protocol — they must pre-exist. Our terminal descriptor + spawn-env overlay cover both provisioning routes.
- `opencode-login` is emitted as bare `agent` yet is semantically terminal (carries the `terminal-auth` launch hint when gated); §1.3 treats the hint as authoritative → `terminal` descriptor (§3.1 decision).
- Auth-required surfaces primarily at `session/prompt` on a `ProviderAuthError` → `-32000` with `data:{providerId}` and message "Authentication required: provider authentication required" (`service.ts:856-858`, mapped `error.ts:78-79`); the generic `request()` wrapper can also raise it on new/load/list/resume/fork (`service.ts:702-714,1057-1097`). Our code-only matcher (§1.5) classifies all of these regardless of the appended message.
- An unknown `authenticate` methodId → `UnknownAuthMethodError` → `invalidParams` (`-32602`, `error.ts:80-81`), which the `OTHER_RESERVED` guard (§1.5) correctly refuses to route to pause.
- `unstable_forkSession`/`unstable_setSessionModel` (`agent.ts:61,73`); `PromptResponse._meta` is always an empty `{}` placeholder (`service.ts:825,832`).

---

### 3.4.1 Pi — `@automatalabs/pi-acp` 0.1.1

Agent identity is `@automatalabs/pi-acp`; the exact server advertisement and error behavior are frozen
in `docs/specs/pi-acp-spec.md` §5/§8/§9.5.

#### Advertised methods + gates

Pi advertises six methods unconditionally: five `env_var` methods for `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, and `OPENROUTER_API_KEY`, plus the bare `agent`
method `pi-stored-credentials` for `~/.pi/agent/auth.json`. None is terminal- or gateway-gated, so
`piAuthProfile.clientAuthCapabilities` advertises neither optional capability.

#### Per-method completion path

All six `authenticate` calls are ambient no-op acknowledgements. The base descriptor dispatcher keeps
the five provider methods as `env_var` and the stored-credentials method as `agent`; the Pi profile adds
method-specific, non-secret remediation text without changing those base types.

#### Persistence semantics

Provider keys arrive from the inherited/spawn environment. `pi-stored-credentials` is disk-backed and
read by Pi's `ModelRuntime`; the server stores no credential from the ACP request. A known model with a
missing credential rejects `-32000`/`auth_error`, while no selected model rejects
`-32602`/`invalid_model` and must not be misclassified as authentication.

#### Logout

Unadvertised. Pi exposes no ACP logout method; hosts manage provider environment keys and Pi's native
credential store out of band.

#### Spawn-time auth

`PiBackend` inherits `process.env` and defines no `spawnAuthEnv` adapter. Its spawn ladder is
`AGENTPRISM_PI_ACP_CMD`/`_ARGS` override, resolved `@automatalabs/pi-acp` bin under
`process.execPath`, then `npx -y @automatalabs/pi-acp`.

#### Quirks

- All methods are visible even when the client omits `ClientCapabilities.auth`; SDK 1.2.1 has no gate
  for `env_var` or bare `agent` methods.
- `pi-stored-credentials` describes already-provisioned ambient disk credentials, not an interactive
  login flow.
- The `PiBackend` consumes categorical `data.errorKind`; auth remains code-first, while
  `rate_limit`/`billing_error` become provider-usage-limit pauses.

---

### 3.5 Custom agent conformance profile

A custom ACP agent supplies **no `AuthProfile`** (`Backend.authProfile` undefined) and runs the base flow verbatim. This subsection states exactly what the base guarantees, what the agent must implement, and the executable proof.

#### What the base layer guarantees (zero agent-specific code)
For any spec-conformant agent (`@agentclientprotocol/sdk` 1.2.1 schema, agentclientprotocol.com v1):
- **Advertisement (§1.2):** the runner lights `auth.terminal` + top-level `_meta["terminal-auth"]` when the host has a TTY, and `auth._meta.gateway` when an `onAuth` resolver is present. A custom agent gating terminal methods on either channel, `gateway` on `_meta.gateway`, or `env_var` (ungated in SDK 1.2.1 — no typed gate) all become visible.
- **Dispatch (§1.3):** `buildAuthDescriptors` dispatches on `AuthMethod.type` + the cross-agent `_meta` key conventions (recognized by literal key name — §1 intro, not SDK schema fields). `env_var` → `vars[]` with `secret` default `true` / `optional` default `false`, per-var `AuthEnvVar._meta` carried through; `terminal` → `launch` from `_meta["terminal-auth"]` or `AuthMethodTerminal.args` + binary; `agent` → `expectsMeta` from `_meta` presence and `interactive` from its absence; terminal classification per the §3.1 decision.
- **Classification (§2.1):** `env_var → spawn-env`; `terminal → disk`; `agent` + gateway-shaped `_meta` → `in-process`; `agent` otherwise → `disk`.
- **Apply (§2.5, §2.8):** `in-process` → replay `authenticate` after every `initialize`; `spawn-env` → inject env at spawn + recycle; `disk` → nothing.
- **Error (§1.5):** the **code-only** `-32000` matcher classifies `AUTH_REQUIRED` for any message text — the specific fix (gap 5) that a custom agent localizing or rephrasing "Authentication required" previously needed; a *different* reserved code that merely mentions the phrase never mis-routes (`OTHER_RESERVED` guard).
- **Engine (§2.12):** identical pause-for-auth + structured `authContext` + resume, including the cold-resume re-arm driven by `diskBacked`.

#### What a custom agent must implement (its side of the contract)
1. Advertise ≥1 `AuthMethod` of a spec `type` (`agent`/`terminal`/`env_var`) in the `initialize` `authMethods[]`.
2. Emit `RequestError.authRequired` (JSON-RPC **`-32000`**) on `session/new` and/or mid-`session/prompt` while unauthenticated — code `-32000` is the **only** signal the matcher requires; the message is free-form.
3. For gateway-style in-process creds: advertise the method with the **literal `_meta.gateway` key** (the cross-agent convention — §1 intro; this is the exact discriminant that makes us classify the method `in-process` and replay it), read the `authenticate` request `_meta` and hold it in-process, re-accepting it on a fresh connection (we replay after every `initialize`).
4. For env creds: advertise an `env_var` method (or read the keys from the spawn environment directly); we inject the host's `env_var` values as a spawn overlay.
5. For terminal creds: expose a spawnable login — either the SDK `AuthMethodTerminal.args`, or the **literal `_meta["terminal-auth"] = {command,args,label}` key** (the cross-agent launch-hint convention) — and persist to its own native store so a respawn inherits it.
6. For an interactive login the agent drives itself: advertise a bare `agent` method with **no `_meta`**; we classify it `interactive` and complete it with a one-shot `authenticate({ methodId })` on a browser/TTY-capable host (§1.3), skipping it on headless hosts.
7. Optionally advertise `agentCapabilities.auth.logout` to receive `logout` RPCs (else logout is gated off, exactly as OpenCode).

**The convention-key contract is load-bearing.** Because the base layer keys `in-process` classification on the literal `_meta.gateway` key and the terminal launch hint on the literal `_meta["terminal-auth"]` key (neither is an SDK schema field — the SDK treats every `_meta` as opaque), a custom agent that wants those behaviors MUST use those exact key names. An agent that omits them still works — a `_meta`-less `agent` method is treated as an `interactive` disk login, an `env_var` method as spawn-env — but it will not be classified `in-process` or given a launch hint. No custom RPCs and no non-standard error codes are required or honored.

#### The conformance fixture
**New file `packages/acp-agents/test/fixtures/fake-auth-agent.mjs`** — a real stdio ACP server with **no profile**, advertising one method of each type (`agent` with gateway-shaped `_meta`; `terminal` with `_meta["terminal-auth"]`; `env_var` with two `vars`). It emits `-32000` on `session/new` until authenticated, stores gateway `_meta` in-process, reads env creds from the spawn env, and supports `logout`. Driven over the real pool (`packages/acp-agents/test/*.integration.test.ts`, §4.6.2) it asserts the full behavior: advertisement gating end-to-end; proactive `describeAuthMethods`; reactive `-32000` → resolver → **retry-once → success (no pause)**; **env → recycle → fresh process spawned with env** (gap-3 regression); **gateway → recycle → replay-after-initialize** on the new connection; **generation-stamp staleness** (mid-life authenticate → stale connection drained/reapplied, no session served stale); `completeAuth` then a second `run()` reuses the authed pool; interactive dedicated-connection replay; logout clears + recycles + zeroizes. The engine-seam halves of the story — the no-resolver pause with persisted non-secret `authContext`, and the `diskBacked` cold-resume re-arm — are asserted in `packages/workflow-engine/test/auth-pause.test.ts` + `run-persistence.test.ts` (PR4, §2.12/§2.13). This fixture is the executable Principle-1 proof.

---

### 3.6 Full `_meta` capability support matrix

Every `_meta` capability the four servers expose — auth and non-auth — is supported and cited or
represented by an executable drift tripwire in `packages/acp-agents/src/protocol-coverage.ts`. Pi's
six auth methods carry no auth `_meta`, and Pi exposes no non-auth private structured-output namespace;
its structured channel is the standard injected HTTP MCP tool. Direction: `A→C` = agent emits to
client; `C→A` = client sends to / gates agent.

#### Auth `_meta`

| Agent | Capability | Dir | Status |
|---|---|---|---|
| Claude | `authMethods[]._meta.gateway {protocol}` (`dist/acp-agent.js:322-336`) | A→C | Work item — descriptor §1.3 (PR3) + advertise `auth._meta.gateway` §1.2 (PR2) + in-process replay §2.5 (PR3) |
| Claude | `authMethods[]._meta["terminal-auth"] {command,args,label}` (`:359-401`) | A→C | Work item — terminal `launch` §1.3 (PR3) + advertise `_meta["terminal-auth"]` §1.2 (PR2); TTY spawn is a host binding (§4.4 note) |
| Claude | `clientCapabilities.auth.terminal` / `auth._meta.gateway` / `_meta["terminal-auth"]` (read `:338/:317/:339`) | C→A | Work item — §1.2 (PR2) |
| Claude | `authenticate _meta.gateway.{baseUrl,headers}` (consumed `createEnvForGateway` `:3131-3151`) | C→A | Work item — `AuthResolution` `meta` §1.3 + replay §2.5 (PR3) |
| Codex | `authMethods[]._meta["api-key"] {provider}` (`dist/index.js:24161`); `._meta.gateway {protocol,restartRequired}` (`:24176`) | A→C | Work item — descriptor §1.3 (PR3); `restartRequired` informs cold-resume durability §2.13/§3.3 (PR4) |
| Codex | `authenticate _meta["api-key"].apiKey` (`:25063`); `_meta.gateway.{baseUrl,providerName,headers}` (`:25085`) | C→A | Work item — `AuthResolution` `env`/`meta` §1.3 (PR3) |
| Codex | `DEFAULT_AUTH_REQUEST` startup env (`:29587-29588`) | C→A | Work item — `codexAuthProfile.spawnAuthEnv` §3.3/§2.8 (PR7) |
| Codex | `clientCapabilities.auth._meta.gateway` (read `:24188`) | C→A | Work item — §1.2 (PR2) |
| OpenCode | `clientCapabilities._meta["terminal-auth"]` (read `service.ts:100`) + `authMethods[]._meta["terminal-auth"]` launch (write `:101-107`) | C↔A | Work item — advertise §1.2 (PR2) + terminal `launch` §1.3/§3.1 (PR3) |
| OpenCode | `authenticate` no-op; `logout` unadvertised | — | **Supported today** — base returns `{}` for the `agent`/no-op path; `supportsLogout=false` gates logout (`capabilities.ts:106`, `acp-client.ts:1121-1132`) |
| All | provider env keys (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY`/`OPENAI_API_KEY`, `*_API_KEY`/`OPENCODE_AUTH_CONTENT`; Codex `readApiKeyFromEnv` `:25116`) | C→A | Work item — spawn overlay §3.4/§2.8 (PR3); pre-set `process.env` passthrough **supported today** (`claude :2815-2821`, `custom.ts:54`) |
| Claude | managed-policy startup env (`dist/index.js:42-50`) | agent-internal | **Supported today** — inherited via `process.env` passthrough; overlay stacks above (§2.8) |

#### Non-auth `_meta`

| Agent | Capability | Status |
|---|---|---|
| Codex | `session/prompt _meta["outputSchema"]` (existing fork extension, `dist/index.js:25467-25471`) | **Supported today** — `capabilities.ts:44` `GATED_CUSTOM_META_KEYS`; `backends/codex.ts:54-57` |
| Codex | `session _meta.{baseInstructions,developerInstructions}` (`:25685-25706`) | **Supported today** — `backend.ts:34-39` `SessionMetaInputs`; gated `capabilities.ts:47-48` |
| Codex | `session _meta["additionalRoots"]` legacy (`:25678-25683`) | **Supported today** — first-class `additionalDirectories` sent; `additionalRoots` reachable via generic `sessionRequestMeta` passthrough (`acp-client.ts:1267`) |
| Codex | `clientCapabilities._meta["terminal_output"]` (read `:22387`) + `session/update _meta.{terminal_output,terminal_output_delta,terminal_exit}` (emit `:22385-22408,23500-23508`) | **Supported today** — terminal handlers route the lifecycle; the `terminal_output` client gate is **deliberately not advertised** (code-block fallback, Principle 3 — stated with rationale, not silent) |
| Codex | tool-approval `_meta.persist` (`:23952-23975`) | **Supported today** — `persist?` is part of the permission outcome (signature below) |
| Codex | `clientCapabilities.session.configOptions.boolean` (read `:27235`) | **Supported today** — `client-handlers.ts:124` |
| Claude | `session/new _meta.claudeCode.options.{outputFormat,tools,env,mcpServers,hooks,…}`, `systemPrompt`, `disableBuiltInTools`, `additionalRoots` (`dist/acp-agent.js:2752-2928`) | **Supported today** — `backends/claude.ts:43-51` (outputFormat) + generic `opts.meta` passthrough `sessionRequestMeta` (`acp-client.ts:1267`) |
| Claude | `agentCapabilities._meta.claudeCode.promptQueueing` (`:413-417`) | **Supported today** — captured in `NegotiatedCapabilities` (`capabilities.ts`); observational documented no-op (we do not queue) |
| Claude | `session/update _meta`: `_claude/origin` (`:1328`), `_claude/rateLimit` (`:1776`), `_claude/askUserQuestionOption` (`elicitation.js:145`), `claudeCode.{toolName,toolResponse,parentToolUseId}` | **Supported today** — raw channel `CLAUDE_RAW_MESSAGE_METHOD` (`acp-client.ts:993-997`); `_claude/rateLimit` feeds the usage-limit classifier |
| Claude | `session/update _meta.{terminal_info,terminal_output,terminal_exit}` (`tools.js:416-433`) | **Supported today** — terminal handlers route the lifecycle; `terminal_output` client gate **deliberately not advertised** (code-block fallback, Principle 3) |
| Claude | `clientCapabilities.elicitation.{form,url}` / `session.configOptions.boolean` (read `:2189,1175,3262`) | **Supported today** — `client-handlers.ts` |
| OpenCode | `PromptResponse._meta` (`service.ts:825,832`) | **Supported today** — always emitted `{}`; ignored (no payload) |
| OpenCode | `session/update` notifications carry no opencode `_meta` (`event.ts`) | **Supported today** — nothing to consume; verified absent |

**Permission `_meta.persist` — concrete signature.** The tool-approval persist echo (Codex `dist/index.js:23952-23975`) is implemented by the widened permission-resolver outcome in `packages/acp-agents/src/runner.ts` (the `onPermissionRequest` runner-options pattern at `runner.ts:204-207`) and threaded through to the request-permission response `_meta`:

```ts
// packages/acp-agents/src/runner.ts — permission outcome widened (echoed to _meta.persist)
export interface PermissionResolution {
  outcome: "allow" | "deny";
  /** Codex tool-approval persistence (dist/index.js:23952). Echoed as _meta.persist on the
   *  RequestPermission response; agents without the capability ignore it. */
  persist?: "session" | "always";
}
```

This is verified by a dedicated test (§4.6) and completes the `_meta` inventory with **no silent unsupported surface** (Principle 3).

**Implemented files in this section:** `packages/acp-agents/src/auth/auth-profiles.ts` (`AuthProfile`, `TerminalLaunch`, `claudeAuthProfile`, `codexAuthProfile`, `opencodeAuthProfile`), `packages/acp-agents/src/backend.ts` (`Backend.authProfile`), `packages/acp-agents/src/backends/{claude,codex,opencode}.ts` (wiring; `custom.ts` unchanged), `packages/acp-agents/src/runner.ts` (`PermissionResolution.persist`), `packages/acp-agents/src/protocol-coverage.ts` (matrix drift-tripwire assertions), and `packages/acp-agents/test/fixtures/fake-auth-agent.mjs` (conformance fixture).

---

## 4. Host surfaces, testing, and delivery

This section binds the headless library (the `AuthResolver`/`AuthContext`/`AuthResolution` contracts of §1.3, the `AuthStore`/generation-stamped lifecycle of §2, the relaxed `-32000` matcher and structured `authContext` of §1.5, the dispatch table of §1.3, the engine pause-for-auth branch of §2.12, the per-agent profiles of §3, and the spawn-env channels of §2.8) to all five concrete host surfaces, then specifies the complete test plan and the shippable PR sequence. Every decision here is final; nothing is deferred.

The organizing rule for host bindings is the host-experience split established in §2.11: **interactive/long-lived hosts (SDK, web+runner, native-TTY CLIs) set `onAuth` and resolve auth inline, never pausing; headless/tool hosts (MCP, scheduled) omit `onAuth` and pause-then-resume.** The two are mutually exclusive by construction.

---

### 4.1 Runner API additions

All additions follow the existing single-options-bag pattern (every lifecycle/auth-provider method on `AcpAgentRunner` already takes one exported options interface — `authMethods(opts: AuthMethodsOptions)`, `authenticate(opts: AuthenticateOptions)`, `logout(opts: LogoutOptions)`, `runner.ts:299/313/404`). File: **`packages/acp-agents/src/runner.ts`**.

**Constructor options** — extend `AcpRunnerOptions` (`runner.ts:198`), mirroring how `onElicitation`/`onPermissionRequest` are threaded into `AcpPoolDeps` at `runner.ts:245-250`:

```ts
export interface AcpRunnerOptions extends AcpPoolOptions {
  backends?: Record<string, CustomBackendConfig>;
  onPermissionRequest?: PermissionResolver;
  onElicitation?: ElicitationResolver;
  /** Which auth method TYPES this host can complete (§1.2). Default-off; FIXED for the connection
   *  lifetime (same discipline as `elicitation`). When `onAuth` is set but this is unset it
   *  derives to `{ terminal: false, gateway: true }` (§1.2). */
  authCapabilities?: { terminal?: boolean; gateway?: boolean };
  /** Inline auth resolver (§1.3). When set, a -32000 at session/new resolves-and-retries-once and
   *  the run NEVER pauses; when unset, a -32000 run pauses with reason:"auth_required" (§2.12). */
  onAuth?: AuthResolver;
}
```

The constructor stores `onAuth` on the runner, constructs the single `AuthStore` (§2.2), and threads both `authCapabilities` and the `AuthStore` into `AcpPoolDeps` and every `createDedicatedConnection` (`runner.ts:739`) — exactly the deps path `permissionResolver`/`elicitationResolver` already take, so pooled, dedicated, and interactive connections receive identical auth wiring.

**High-level entry points** (the surface every host consumes; `AuthMethodsOptions` at `runner.ts:128` is reused unchanged for backend routing):

```ts
/** Proactively enumerate the selected backend's advertised methods, already type-dispatched (§1.3). */
async describeAuthMethods(opts?: AuthMethodsOptions): Promise<AuthMethodDescriptor[]>;

export interface CompleteAuthOptions extends AuthMethodsOptions {
  /** A method id from describeAuthMethods(). */
  methodId: string;
  /** The host-collected resolution (env values / gateway meta / completed / cancelled) (§1.3). */
  resolution: AuthResolution;
  /** Event/telemetry label used in strict capability errors. */
  label?: string;
  signal?: AbortSignal;
}
export type AuthOutcome = { status: "authenticated" | "cancelled"; methodId: string; recycled: boolean };

/** Record intent into the AuthStore, advance the generation, and recycle the pool (§2.9/§2.6). */
async completeAuth(opts: CompleteAuthOptions): Promise<AuthOutcome>;
```

**The `runner.auth` controller** consolidates the auth verbs into one addressable object (parallel to how `runner.on/once/off` group the event surface). Defined and exported from `runner.ts` (the `AuthController` type, canonical here and referenced by §2.10):

```ts
export interface AuthController {
  /** Alias of describeAuthMethods(). */
  methods(opts?: AuthMethodsOptions): Promise<AuthMethodDescriptor[]>;
  /** Alias of completeAuth(). */
  authenticate(opts: CompleteAuthOptions): Promise<AuthOutcome>;
  /** Clears the AuthStore for the backend, zeroizes secrets (§2.14), and recycles the pool. */
  logout(opts?: LogoutOptions): Promise<void>;
  /** Redacted, synchronous snapshot — ids/types/names + state only, NEVER secrets (§2.14, Principle 9). */
  status(opts?: { backend?: string }): AuthStatusSnapshot[];
  /** Cold-resume re-arm predicate (§2.13): true iff state ∈ {authenticated,credentials_held} or diskBacked. */
  canResume(backendId: string): boolean;
}
readonly auth: AuthController;

/** Redacted status view surfaced by the controller, MCP tool, and web (canonical shape; §2.14 redaction). */
export interface AuthStatusSnapshot {
  backendId: string;
  poolKey: string;
  state: "unauthenticated" | "credentials_held" | "authenticated" | "auth_required";
  authenticated: boolean;
  canResume: boolean;
  methods: { id: string; type: "agent" | "terminal" | "env_var"; name?: string }[];
}
```

The pre-existing raw verbs `runner.authenticate()`/`runner.logout()` (`runner.ts:313/404`) keep their signatures for advanced callers but are rebuilt off the dispose-after-connection path onto the `AuthStore` + recycle (§2) — the dedicated-connection-in-`finally`-dispose that loses the in-process gateway credential (`runner.ts:319-331`) is removed.

**MCP-server detection contract** — so the MCP composition root can register auth tools without widening the frozen `AgentRunner` seam (`packages/shared-types/src/agent-runner.ts:16`, whose only method is `run`), export a structural capability interface from `runner.ts`; `AcpAgentRunner` implements it, `MockRunner`/`WorkflowAgent` do not:

```ts
export interface AuthCapableRunner {
  describeAuthMethods(opts?: AuthMethodsOptions): Promise<AuthMethodDescriptor[]>;
  completeAuth(opts: CompleteAuthOptions): Promise<AuthOutcome>;
  /** Ids of every configured backend (built-ins + AcpRunnerOptions.backends), whether or not it
   *  yet has a BackendAuthMachine. The MCP `workflow_auth_status` handler uses this to enumerate
   *  backends when its `backend` argument is omitted (§4.3). */
  listBackends(): string[];
  readonly auth: AuthController;
}
```

---

### 4.2 `@automatalabs/workflows` SDK exports

File: **`packages/workflows/src/index.ts`**. The SDK is a pure re-export facade over `@automatalabs/acp-agents` and `@automatalabs/workflow-engine`; the auth surface is exposed the same way.

**Type re-exports** (append to the `export type { … } from "@automatalabs/acp-agents"` block at `index.ts:98`):

```ts
export type {
  AuthResolver, AuthContext, AuthResolution, AuthMethodDescriptor,
  CompleteAuthOptions, AuthOutcome, AuthController, AuthStatusSnapshot,
  AuthCapableRunner,
} from "@automatalabs/acp-agents";
export type { AuthErrorContext } from "@automatalabs/shared-types"; // via workflow-engine re-export (§1.5)
```

`packages/mcp-server` imports its runner-facing auth types through this facade (its only `@automatalabs` dependencies are `workflows` and `shared-types`), so the type re-exports and MCP auth tools form one compile-time dependency. The `isAuthRequired` value export below resolves through the workflow-engine re-export chain (§4.7).

**Value export** — `isAuthRequired` sits next to `isProviderUsageLimit`. It is defined once in **`packages/shared-types/src/errors.ts`** beside `isProviderUsageLimit` (`errors.ts:71`), then re-exported by `@automatalabs/workflow-engine` in **two** places: (a) the shared-types re-export block in `packages/workflow-engine/src/errors.ts:17-23` (which names `isProviderUsageLimit` at `:21` and has **no** `export *`), and (b) the named re-export block in `packages/workflow-engine/src/index.ts:37-49`. Both re-export sites are required for the facade to resolve. It is surfaced here in the existing block at `index.ts:64-70`:

```ts
// packages/shared-types/src/errors.ts
export function isAuthRequired(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.AUTH_REQUIRED;
}
```
```ts
// packages/workflows/src/index.ts (append to the existing value export)
export { isAuthRequired } from "@automatalabs/workflow-engine";
```

`createAcpRunner`/`runDynamicWorkflow` are unchanged: they already spread `AcpRunnerOptions` through (`index.ts:79`, `:488` `opts.runner ?? createAcpRunner()`), so `authCapabilities`/`onAuth` flow with zero SDK code change. The documented SDK usage (this section) — an `onAuth` that never pauses; or no `onAuth` + `manager.resume(runId)` after `isAuthRequired(error)` is true — is served entirely by these exports.

---

### 4.3 MCP server auth tools

Files: **`packages/mcp-server/src/server.ts`** (registration + summary branch + optional resolver bridge), new **`packages/mcp-server/src/auth-tool-io.ts`** (Zod shapes, mirroring `workflow-tool-input.ts`/`workflow-tool-output.ts`). The single `workflow` tool (`server.ts:401`) is untouched; two read-only/action tools are added alongside it, sharing the injected runner.

**`createWorkflowServer` stays `createWorkflowServer(runner: AgentRunner): McpServer`** (`server.ts:392`) — the seam is not widened. Inside, it duck-types the runner and registers the auth tools only when the capability is present (the injected `createAcpRunner()` at `index.ts` satisfies it; a stub `AgentRunner` in tests does not, and simply gets the `workflow` tool alone):

```ts
function asAuthCapableRunner(runner: AgentRunner): AuthCapableRunner | undefined {
  const r = runner as Partial<AuthCapableRunner>;
  return typeof r.describeAuthMethods === "function" && typeof r.completeAuth === "function"
    ? (runner as AuthCapableRunner) : undefined;
}
```

**Tool 1 — `workflow_auth_status`** (read-only; no secrets in or out):

```ts
// packages/mcp-server/src/auth-tool-io.ts
export const authStatusInputShape = {
  backend: z.string().optional().describe(
    "Backend id/name to scope to (claude | codex | opencode | a custom backend name). Omit for all."),
} as const;

export const authStatusOutputShape = {
  backends: z.array(z.object({
    backendId: z.string(),
    state: z.enum(["unauthenticated", "credentials_held", "authenticated", "auth_required"]),
    authenticated: z.boolean(),
    canResume: z.boolean(),
    methods: z.array(z.object({
      id: z.string(),
      type: z.enum(["agent", "terminal", "env_var"]),
      name: z.string().optional(),
      description: z.string().optional(),
      // true for a bare `agent` method that needs a browser/TTY to complete (§1.3). A headless
      // host uses this to skip the method rather than calling workflow_authenticate on it.
      interactive: z.boolean().optional(),
      // env_var only: which vars to collect. NAMES/LABELS/flags only — never any value.
      vars: z.array(z.object({
        name: z.string(), label: z.string().optional(),
        secret: z.boolean(), optional: z.boolean(),
      })).optional(),
      link: z.string().optional(),
    })),
  })),
} as const;
```
Handler: for a single `backend`, `runner.describeAuthMethods({ model: backend })` merged with `runner.auth.status({ backend })`. When `backend` is omitted the handler enumerates every registered backend via the new **`runner.listBackends(): string[]`** accessor on `AuthCapableRunner` (§4.1) — which returns the ids of all configured backends (built-ins + `AcpRunnerOptions.backends`), not only those that already have a `BackendAuthMachine` — and calls `describeAuthMethods`/`status` per id. (This closes the earlier ambiguity: `runner.auth.status()` alone reflects only backends that have already been touched, so it is not a source for "all registered backends".) The result is a pure projection of `AuthMethodDescriptor` (§1.3) + `AuthStatusSnapshot` (§4.1).

**Tool 2 — `workflow_authenticate`** (action; `env`/`meta` are SECRET and never echoed):

```ts
export const authenticateInputShape = {
  backend: z.string().describe("Backend id/name (claude | codex | opencode | custom)."),
  methodId: z.string().describe("A method id from workflow_auth_status."),
  env: z.record(z.string()).optional().describe(
    "SECRET env_var values keyed by var name (for env_var methods). Never echoed, journaled, or logged."),
  meta: z.record(z.unknown()).optional().describe(
    "SECRET agent-type _meta payload (e.g. gateway { baseUrl, headers }). Never echoed, journaled, or logged."),
} as const;

export const authenticateOutputShape = {
  status: z.enum(["authenticated", "cancelled"]),
  methodId: z.string(),
  recycled: z.boolean(),
} as const;
```
Handler maps input → `AuthResolution` and calls `runner.completeAuth`, consulting the chosen descriptor (from `describeAuthMethods`) so a browser/TTY-only method is never silently mapped to a no-op:
- `env` present → `{ outcome: "env", values: input.env }`
- else `meta` present → `{ outcome: "meta", methodId: input.methodId, meta: input.meta }`
- else if the descriptor is a non-interactive method already completed out-of-band (a `terminal` login, or an `agent`/api-key credential set in the native store/env) → `{ outcome: "completed" }`
- else (the descriptor is an `interactive` bare-`agent` method, e.g. codex `chat-gpt`, that needs a browser/TTY the MCP host does not have) → the handler does **not** map to a no-op `completed`: it returns `{ status: "cancelled" }` with `content` explaining the method must be completed on a browser-capable surface (web+runner, or another browser-capable host — §4.4/§4.5). The `interactive` flag on the descriptor (§1.3, surfaced in `workflow_auth_status`) is what lets a headless host detect and skip these methods.

The returned `content` text is built **only** from `{status, methodId, recycled}` — the `env`/`meta` inputs go straight to the in-memory `AuthStore` via `completeAuth` and appear in no `content` block, no progress notification, and no log (Principle 9).

**`formatTerminalSummary` auth branch** (`server.ts:366`). `WorkflowRunResult.reason` (`workflow-result.ts:101`) is already a free-form `string`, so it carries `"auth_required"` with no type change; `WorkflowRunResult` gains an optional `authContext?` field (§2.12). The summary reads the structured `authContext` — never the message string:

```ts
if (run.status === "paused" && run.reason === "auth_required" && run.authContext) {
  lines.push(`This run needs authentication for backend "${run.authContext.backendId ?? "?"}".`);
  for (const m of run.authContext.methods) lines.push(`  - ${m.id} (${m.type})${m.name ? `: ${m.name}` : ""}`);
  lines.push(
    `Call workflow_authenticate { backend: "${run.authContext.backendId}", methodId: <one above>, ... }, ` +
    `then re-call workflow with resumeFromRunId="${run.runId}".`);
}
```
The resume path already exists (`server.ts:449-456`): the second `workflow` call re-hydrates the journal and, because the `AuthStore` now holds the credential and the pool recycled to a fresh generation (§2.6), the re-run acquires an authenticated connection. Terminal-type methods degrade to a text instruction ("run `claude /login` in a terminal") — MCP has no TTY.

**Optional inline elicitation bridge** — opt-in, default OFF, matching the env-opt-in discipline of `AGENTPRISM_ALLOW_SCRIPT_BACKENDS` (`server.ts:232`). When `AGENTPRISM_MCP_INLINE_AUTH=1`, the composition root builds a **deferred** resolver (new `packages/mcp-server/src/auth-resolver.ts`) that closes over a server-ref box filled after the server is constructed — this breaks the runner⇄server construction cycle cleanly:

```ts
// packages/mcp-server/src/auth-resolver.ts
export function createDeferredMcpAuthResolver(): { resolver: AuthResolver; bind(server: Server): void };
// index.ts composition (env-gated):
//   const bridge = createDeferredMcpAuthResolver();
//   const runner = createAcpRunner({ authCapabilities: { gateway: true }, onAuth: bridge.resolver });
//   const server = createWorkflowServer(runner);
//   bridge.bind(server.server);
```
The resolver mirrors `createConfirm` (`server.ts:204-217`): if `getClientCapabilities()?.elicitation` is set it collects `env_var` values through masked `server.elicitInput` forms (one per `vars[]`, respecting `secret`/`optional`) and gateway `{baseUrl, headers}` through a form, returning `{outcome:"env"|"meta"}`; a declined/failed elicitation returns `{outcome:"cancelled"}`; `terminal` methods return `{outcome:"cancelled"}` with a one-shot text-instruction elicitation. When elicitation is unadvertised, the resolver returns `{outcome:"cancelled"}` and the run falls back to the pause-and-resume path above. The default (env unset) is pure pause-and-resume — the clean, spec-faithful headless behavior.

---

### 4.4 Native-TTY CLI hosts (non-normative)

No CLI host is in scope for this spec — this note exists so §1.3/§2.11 obligations for TTY-requiring methods have a named home. Any native-TTY CLI that consumes `@automatalabs/workflows` binds the same PR3 seam the other hosts use, with three host-level obligations and no library change:

- **Capabilities:** construct the runner with `authCapabilities: { terminal: true, gateway: true }` — a real TTY can run `terminal` launches, and a desktop browser can complete `interactive` bare-`agent` logins (e.g. codex `chat-gpt`), which is exactly what the MCP host (§4.3) cannot do and hands off to.
- **Short-lived processes:** a fresh-process-per-invocation CLI loses in-process (gateway) and spawn-env credentials between invocations; if it wants them to survive, it must supply its own persistent `AuthStore` implementation (§2.2 interface), file-backed at mode `0600`, secrets redacted from any logging (§2.14). Disk-persisted methods need no cache — the agent's native store holds them.
- **Logout:** clear the host store entry, call `runner.auth.logout` (which recycles the pool), and surface agent-side logout availability per the backend's advertisement.

### 4.5 Web app + local runner bindings

No library change beyond the PR3 lifecycle work (§2). The **local runner** is long-lived (in-memory `AuthStore`, optionally file-backed per the §4.4 note) and constructs `authCapabilities: { terminal: true, gateway: true }` plus an `onAuth` that serializes the `AuthContext` (secrets stripped from any log) to the browser over the control channel and awaits an `AuthResolution`. Division of labor: **the browser owns env/gateway forms; the TTY step (terminal login, codex `chat-gpt` browser OAuth) is delegated to the local runner** — the browser cannot own a TTY, but the runner can, and a real browser exists here for OAuth (unlike MCP). Pause-for-auth (the no-`onAuth` path, e.g. a cloud/scheduled run) surfaces as a resume-gated card analogous to the checkpoint card, reading the persisted non-secret `authContext`. This is a new binding of the §2 seam in the web/runner repos, not a change to `packages/acp-agents`.

---

### 4.6 Implemented test matrix (historical plan)

The following plan was implemented across the package test suites. It remains here as a traceability map from design obligation to executable coverage, so file descriptions use the original delivery language. Runner: `tsx --test "test/**/*.test.ts"` (node:test + `node:assert/strict`) per package. Default `pnpm test` stays deterministic and credential-free; live-e2e is env-gated.

#### 4.6.1 Unit

- **`packages/acp-agents/test/client-handlers.test.ts`** (extend): `clientCapabilitiesFor` auth gating matrix — `{terminal}`/`{gateway}`/both/neither → exact `auth`/`_meta` shapes (§1.2), default-off, and connection-lifetime fixedness. Assert lighting `auth.terminal` also sets top-level `_meta["terminal-auth"]` (the channel claude reads at `dist/acp-agent.js:339` and opencode at `service.ts:100`).
- **`packages/acp-agents/test/auth-descriptors.test.ts`** (new): `buildAuthDescriptors` for each of agent/terminal/env_var; terminal `launch` resolved from `_meta["terminal-auth"]` (claude `:359-401`, opencode `:101-107`) **vs** spec `AuthMethodTerminal.args`+binary; `env_var` `secret` default true / `optional` default false; `agent.expectsMeta = method._meta != null` (gateway-shaped, claude `:318-337`; codex gateway `_meta.gateway`).
- **`packages/acp-agents/test/errors-map.test.ts`** (extend): the §1.5 truth table — `-32000`+English, `-32000`+non-English/localized (must still classify as auth: the SDK reserves `-32000` exclusively, claude `jsonrpc.js:821`, opencode via SDK `authRequired` `error.ts:78-79`), `-32603`+"authentication required" → **not** auth, non-reserved-code+phrase → auth; `authContext` populated with ids/types/names only.
- **`packages/acp-agents/test/auth-store.test.ts`** (new): every `BackendAuthMachine` transition row (§2.3) incl. generation bumps, `authenticated→auth_required`, `apply_failed→auth_required`, and **logout secret-zeroization** (assert `authenticateMeta`/`envValues` cleared/unreachable); `klass` inference for all four cases (§2.1: claude gateway/codex gateway = in-process; codex api-key/chat-gpt = disk; claude terminal = disk; opencode-login = disk noop); redacted `AuthStatusSnapshot` exposes only ids/types/names; `canResume` truth (authenticated/credentials_held/diskBacked).
- **`packages/shared-types/test/errors.test.ts`** (extend the existing suite): `AuthErrorContext` shape (§1.5); `isAuthRequired` true only for `AUTH_REQUIRED`; `WorkflowError.authContext` round-trips.
- **`packages/workflow-engine/test/auth-pause.test.ts`** (new) + **`run-persistence.test.ts`** (extend): `executeRun` pause branch fires for `AUTH_REQUIRED` (generalized predicate, §2.12); `persistRun` `pauseReason` switches on `managed.error.code` and persists non-secret `authContext` only; `composeResult` reports `reason:"auth_required"`; **diskBacked-driven cold-resume re-arm** (§2.13) — cold resume with a disk-backed intent proceeds, with an in-process intent re-pauses with the re-supply message.

#### 4.6.2 Integration — profile-less fake conformant-agent fixture

New **`packages/acp-agents/test/fixtures/fake-auth-agent.mjs`** — a real stdio ACP server (sibling to the existing `fixtures/fake-acp-agent.mjs`), carrying **no** `AuthProfile` (§3.5), the executable proof of Principle 1. It advertises one `agent` + one `env_var` + one `terminal` method; emits `-32000` on `session/new` until authenticated; stores gateway `_meta` in-process; reads env creds from spawn env; supports `logout`.

New **`packages/acp-agents/test/auth.integration.test.ts`** drives it over the real pool and asserts: advertisement gating end-to-end; proactive `describeAuthMethods`; **reactive `-32000` → resolver → retry-once → success (no pause)** and the retry-once guard (a second `-32000` propagates as `AUTH_REQUIRED`); **env resolution → recycle → fresh process spawned with the env overlay** (the gap-3 regression, §2.6); **gateway resolution → recycle → replay-after-initialize on the new connection** (§2.5); **generation-stamp staleness** (authenticate mid-life → the stale connection is drained/reapplied, no session served under stale auth, §2.6); `completeAuth` then a second `run()` reuses the authed pool; interactive + dedicated-connection replay; logout clears + recycles + zeroizes. The pause/resume behaviors live at the engine seam and are asserted in `packages/workflow-engine/test/auth-pause.test.ts` + `run-persistence.test.ts` (PR4, §2.12/§2.13).

Extend **`packages/acp-agents/test/auth-providers.integration.test.ts`** (currently asserts single-`newSession`, non-retry at `:130-152`) so the retry-once + recycle behavior is regression-locked against the change.

New **`packages/mcp-server/test/auth-tools.test.ts`** — against a stub `AuthCapableRunner`: `workflow_auth_status` projection; `workflow_authenticate` env/meta/completed → `AuthResolution` mapping and `{status,methodId,recycled}` output; `formatTerminalSummary` `auth_required` branch reads `authContext` (never the message); the pause → `workflow_authenticate` → `workflow(resumeFromRunId)` loop; and that a plain `AgentRunner` stub registers only the `workflow` tool (detection contract, §4.3).

#### 4.6.3 Live-e2e per first-class backend — all three equally

New **`packages/acp-agents/test/auth.live.e2e.test.ts`**, behind the existing pre-push gate `AGENTPRISM_LIVE_E2E === "1"` (the `SKIP` idiom of `packages/mcp-server/test/live-backend.e2e.test.ts:33-36`), each backend additionally env-guarded and given identical structural depth:

- **codex** — `api-key` via `CODEX_API_KEY`: assert advertised `authMethods` include `api-key` with `_meta["api-key"].provider` and a real authenticated prompt completes; assert the `DEFAULT_AUTH_REQUEST` spawn-env pre-auth path (`dist/index.js:29587`, delivered via `codexAuthProfile.spawnAuthEnv`, §2.8/§3.3) does not break the universal replay.
- **opencode** — a provider key (e.g. `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, honored from the models.dev registry): assert the single `opencode-login` method (`service.ts:49,92-137`), that `authenticate` is a no-op ack (`service.ts:139-144`), and that a prompt succeeds once the key is present (the `ProviderAuthError`→`-32000` path at `service.ts:856-858` does NOT fire).
- **claude** — `gateway` against a stub gateway `baseUrl`: assert `auth._meta.gateway`-gated advertisement (`dist/acp-agent.js:317`), gateway `authenticate` stores in-process (`:545-551`) and injects env per session (`:3131-3151`); the **terminal** login path is documented and CI-skipped (needs a real TTY).

Backend bins resolve exactly as the runner does (`createRequire` against `packages/acp-agents/package.json`), matching the existing e2e resolution (`live-backend.e2e.test.ts:45-50`): claude `@agentclientprotocol/claude-agent-acp`, codex `@automatalabs/codex-acp`, opencode the installed bin. A gated-ON backend that cannot authenticate FAILS loudly (stderr tail dumped), never silently passes.

#### 4.6.4 Protocol-coverage drift-tripwire updates

Files: **`packages/acp-agents/src/protocol-coverage.ts`** (add executable auth assertions), **`packages/acp-agents/test/protocol-coverage.test.ts`** (extend), **`packages/acp-agents/test/docs-drift.test.ts`** (the `_meta` matrix). The method-set is unchanged — `authenticate`/`logout`/`providers_*` are already `driven` (`protocol-coverage.ts:35-51`) — so no coverage-record edit is needed. Add:

1. `clientCapabilitiesFor({ auth: { terminal, gateway } })` emits the pinned SDK-1.2.1 `AuthCapabilities` shape `{terminal?, _meta}` — fails the build if a bump renames/stabilizes `auth` (`schema/types.gen.d.ts:4318`, `@experimental` region `:4147-4167`).
2. Compile-time existence assertions for `ClientCapabilities.auth` and `AuthCapabilities.terminal` (type-level `Expect<…>`), pinning the UNSTABLE surface (Principle 7).
3. The three handled `AuthMethod.type` discriminants (`agent`/`terminal`/`env_var`) — fails if the SDK union widens (`AuthMethod` at `schema/types.gen.d.ts:2159`).
4. The full `_meta` support matrix of §3.6 landed as assertions (in `docs-drift.test.ts`), not prose — so an SDK/agent bump changing a `_meta` surface (claude gateway/terminal-auth, codex `api-key`/gateway/`DEFAULT_AUTH_REQUEST`, opencode `terminal-auth`) fails the build.
5. A doc-note assertion that `-32000` is auth-exclusive (the guarantee the §1.5 matcher relies on).

This honors the bump-ACP-deps-every-release policy: a dependency bump that moves any pinned auth shape trips this suite before release.

#### 4.6.5 Secret-redaction tests

New **`packages/acp-agents/test/auth-secrets.test.ts`** (Principle 9). Assert, against the `fake-auth-agent.mjs` fixture and unit-level stores:
- `authenticateMeta` (gateway payload) and `envValues` never appear in any emitted ACP event (`runner.on(...)`), the persisted journal, `WorkflowError.message`/`authContext`, or `backend_error` events (`acp-client.ts:1145`).
- The spawn-env overlay (§2.8) is never logged, is not returned in `SpawnConfig`, and the `stderrTail` (`acp-client.ts:960`) passes through a redaction pass that strips known key patterns (`*_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_*`, gateway header values).
- `logout` zeroizes secrets in the machine (§2.14).
- MCP `workflow_authenticate` `content`/`structuredContent` never echo the `env`/`meta` inputs (§4.3).
- `AuthStatusSnapshot` (all surfaces) exposes only ids/types/names/state.

---

### 4.7 Completed PR sequencing (historical)

The implementation was delivered as seven PR-sized stages, error-taxonomy-first, each independently green and shippable. The table is historical sequencing, not a list of outstanding work. The compatibility rule remains current: unset `onAuth`/`authCapabilities` preserves the default-off behavior, while ACP dependency bumps remain gated by the §4.6.4 tripwire.

| PR | Scope (spec §) | Key files | Why green in isolation |
|----|----------------|-----------|------------------------|
| **PR1** | Error taxonomy + structured `authContext` (§1.5) | `packages/acp-agents/src/errors-map.ts`, `packages/shared-types/src/errors.ts` (+`isAuthRequired`), `packages/workflow-engine/src/errors.ts` (+`isAuthRequired` in the shared-types re-export block `:17-23`), `packages/workflow-engine/src/index.ts` (+`isAuthRequired` in the named re-export block `:37-49`), `packages/shared-types/test/errors.test.ts`, `errors-map.test.ts` | Pure classification; the three first-class agents already emit `-32000`+English, so the code-only matcher is behavior-preserving and immediately unblocks conformant custom agents. Threading `isAuthRequired` through the workflow-engine re-export here (not later) means PR6's `export { isAuthRequired } from "@automatalabs/workflow-engine"` resolves and builds. |
| **PR2** | Client auth advertisement (§1.2) | `packages/acp-agents/src/client-handlers.ts`, `capabilities.ts`, `acp-client.ts` (initialize thread), `pool.ts`, `runner.ts` (`authCapabilities`), `protocol-coverage.ts`, `client-handlers.test.ts`, `protocol-coverage.test.ts` | Default-OFF; the `auth` key is omitted unless a host sets `authCapabilities`, so zero behavior change. This delivery added the drift shape assertion. |
| **PR3** | Auth contracts + `AuthStore`/`BackendAuthMachine` + generation-stamped lifecycle + resolver + runner API (§1.3, §2, §4.1) | new `packages/acp-agents/src/auth/{auth-types,auth-store}.ts`, `acp-client.ts` (replay-after-initialize + spawn overlay + stamp/reapply), `pool.ts` (generation-gated `selectConnection` + `recycle` + drain), `runner.ts` (`describeAuthMethods`/`completeAuth`/`auth`/`onAuth`/inline retry-once; rebuild `authenticate`/`logout`), `fixtures/fake-auth-agent.mjs`, `auth-descriptors.test.ts`, `auth-store.test.ts`, `auth.integration.test.ts`, `auth-secrets.test.ts`, `auth-providers.integration.test.ts` | The core correctness PR (fixes gap 3). Behavioral but opt-in: unset `onAuth`/`authCapabilities` ⇒ identical to today; the fixture proves conformance-by-absence. |
| **PR4** | Engine pause-for-auth + cold-resume re-arm (§2.12, §2.13) | `packages/workflow-engine/src/workflow-manager.ts`, `run-persistence.ts`, `packages/shared-types/src/{errors,workflow-result}.ts` (`reason` widen + `authContext`), `auth-pause.test.ts`, `run-persistence.test.ts` | Generalizes the existing `PROVIDER_USAGE_LIMIT` pause branch (`workflow-manager.ts:620-649,675-699`); `PersistedRunState.pauseReason` is already free-form (`run-persistence.ts:43`) so no migration. |
| **PR5** | MCP server auth tools (§4.3) | `packages/mcp-server/src/server.ts`, new `auth-tool-io.ts`, new `auth-resolver.ts`, `packages/workflows/src/index.ts` (the §4.2 type re-exports — see the §4.2 sequencing note), `packages/mcp-server/test/auth-tools.test.ts` | Two additive tools + summary branch; `createWorkflowServer` signature unchanged; inline elicitation is env-gated OFF. |
| **PR6** | SDK exports (§4.2) | `packages/workflows/src/index.ts` | Re-exported the `isAuthRequired` value through the facade after the type re-exports described in §4.2; no new behavior. |
| **PR7** | Per-agent profiles + codex spawn channel + `_meta` matrix tripwire + `permission _meta.persist` (§3, §2.8, §3.6) | new `packages/acp-agents/src/auth/auth-profiles.ts`, `backend.ts` (`authProfile?`), the three built-in backends, `codexAuthProfile.spawnAuthEnv` (`DEFAULT_AUTH_REQUEST`), `protocol-coverage.ts`/`docs-drift.test.ts` (`_meta`-matrix assertions), `permissions.ts` (`PermissionResolver.persist?`), `auth.live.e2e.test.ts` | Profiles are pure data layered on the PR3 base; codex `DEFAULT_AUTH_REQUEST` is an existing spawn-time agent surface consumed client-side (Principle 6 lever note, §3.3) on top of the universal replay (never required for correctness); per-agent live-e2e lands here. |

The **web app + local runner** bindings (§4.5) consume the PR3 seam in their own repositories and require no change to `packages/acp-agents`.
