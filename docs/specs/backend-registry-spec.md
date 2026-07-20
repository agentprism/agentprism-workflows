# Built-in backend registry and onboarding contract

## Source

The following owner statements are reproduced verbatim. They are the product authority for this contract.

> "Additionally, it seems like Kimi's architectural suggestions have just completely been dropped. The work we're planning is great and all, but what about all the architectural stuff? I explicitly asked Kimi for that part of the review because I told Kimi that its too hard to add a first class ACP agent right now, so it came up with an architecture that would make it easier" *(2026-07-16)*

> "Please draft the train 1 issue, and train 2 issue. After the issues are created, we'll start with a contract workflow for train 1, then implementation and release train. After that, same process for the train 2 issue." *(2026-07-16)*

> "i think we can continue to 225. use gpt 5.6 sol xhigh/kimi k3. kimi k3 is good at finding bugs and gaps btw" *(2026-07-18)*

This specification is the frozen Train 1 implementation contract requested by those statements. Issue [#225](https://github.com/VikashLoomba/agentprism-workflows/issues/225)—its Motivation, eight Deliverables, Acceptance shape, and Non-goals—is normative input in full; it had no comments as of 2026-07-19.

The complete operative source directives are stated here and carried into the numbered requirements below. The acceptance boundary is one self-describing backend file, one `BUILTIN_BACKENDS` row, the dependency or system-command prerequisite, a regenerated manifest, and the documented non-derivable checklist, with drift tests making every missed mechanical surface loud. The design is default-on, adds no uninvited resource cap, treats all built-ins symmetrically with no primary agent, preserves model resolution fully verbatim, provides public-path re-export shims for moved values, and defers work only through an explicit Non-goal. `BuiltinBackendId` derives from the `as const` table; `builtinBackend` accepts `string`; tests codify custom-over-built-in shadowing, spawn-config-hash custom pool keys, and unknown-default fallback to Claude. The manifest and drift tests mechanically cover registry-derived surfaces, while the checked-in onboarding checklist owns semantic review of release machinery, MCP descriptions, the authoring-skill-to-generated-prompt pipeline, and live-e2e per-backend tables. Centralized protocol coverage is the resolved design in §4.1, with the rejected per-backend alternative recorded in §9.

Issue #225's source inventory predates merges #232, #238, and #240. Every cited location, count, and mechanism was therefore re-verified against the pinned base rather than copied from that inventory; counts are claims that require the same re-verification. Current evidence and inventory deltas are recorded in §13.

All repository citations were verified at base commit `248aa1b374d0f2a0343a4c2e9e07d9bd7e008988`. External ACP SDK citations were independently verified from a fresh clone and the current npm `latest` release as described in §12.

Four current-tree facts govern this contract. Exactly four runner identity decision sites exist at the locations cited in §13.1. Pi is a workspace server with full MCP behavior rather than a normal locked npm server. Initialize `_meta` is already captured in `NegotiatedCapabilities`, so this train projects it onto refs/events rather than recapturing the handshake. Generic outbound `request`/`notify` wrappers already exist locally, and the pinned SDK deprecates `extMethod`/`extNotification` in favor of those wrappers.

## 1. Goal and governing invariants

**Traceability:** owner quotations 1–3 and the Source directives for the Train 1 acceptance boundary, default-on behavior, symmetry, and complete delivery.

Train 1 replaces the scattered definition of “built-in backend” with one executable registry. After this contract lands, adding built-in backend N consists of:

1. one self-describing backend file;
2. one row in `BUILTIN_BACKENDS`;
3. its runtime dependency or documented system-command prerequisite;
4. regeneration of the committed preinstall manifest; and
5. completion of every mechanically enforced and human-reviewed onboarding item in §6.

No other source file may carry an independently maintained list, union, switch, or boolean chain of built-in identities. Tests must fail loudly when identity, construction, dependency freshness, protocol coverage, documentation, or live validation drifts.

The following rules govern every section of this contract:

- The registry and all observability additions ship enabled by default. There is no feature flag, environment opt-in, staged rollout switch, or newly introduced resource cap.
- Claude, Codex, OpenCode, pi, and every subsequently added built-in are peers. A registry row has no `primary`, preferred, priority, or maturity field. Claude remains only the historical fallback for an absent or unknown default-backend setting (§2.5); that compatibility fallback does not give its row different construction or metadata semantics.
- Model routing and model selection retain their exact current behavior. Prefix matching is ASCII-case-insensitive, custom registrations shadow built-ins, the model portion is forwarded verbatim, and an unrecognized prefix is forwarded in full to the selected default backend.
- Existing public root exports and existing source-path imports remain valid through re-export shims. The refactor must not require consumers to change import paths.
- Work required by this contract is not optional and is not conditional on backend count, package topology, or whether an existing backend happens to exercise a field.

## 2. The executable built-in registry

**Traceability:** owner quotation 1 and the Source directives for registry typing, routing invariants, one-file/one-row onboarding, symmetry, public-path shims, and removal of `stripsRoutingPrefix`.

### 2.1 Required modules and single identity source

Add these modules:

- `packages/acp-agents/src/backends/define.ts`: lower-level definition types and `defineBuiltinBackend`; it must not import the registry table.
- `packages/acp-agents/src/backends/builtins.ts`: the registry table, derived identifier type, stable identifier array, lookup, and factory.
- `packages/acp-agents/src/auth/auth-profile.ts`: the `AuthProfile` and `TerminalLaunch` types currently mixed into the multi-profile implementation module.

`builtins.ts` must have this identity shape:

```ts
export const BUILTIN_BACKENDS = {
  claude: claudeBackendDefinition,
  codex: codexBackendDefinition,
  opencode: opencodeBackendDefinition,
  pi: piBackendDefinition,
} as const satisfies Readonly<Record<string, BuiltinBackendDefinition<string>>>;

export type BuiltinBackendId = keyof typeof BUILTIN_BACKENDS;

export const BUILTIN_BACKEND_IDS = Object.freeze(
  Object.keys(BUILTIN_BACKENDS) as BuiltinBackendId[],
);
```

The single assertion around `Object.keys` is permitted because the table is a closed `as const` object. `BUILTIN_BACKEND_IDS` preserves table insertion order and is the sole ordered built-in list. The initial order is exactly `claude`, `codex`, `opencode`, `pi`, preserving `listBackends()` output. `BuiltinBackendId` must not appear as a handwritten string union anywhere.

The public lookup accepts an untrusted string and narrows it with an own-property check:

```ts
export function builtinBackend(id: string): Backend | undefined;
```

It is case-sensitive and returns `undefined` for an empty string, a case variant, an unknown string, and prototype names such as `toString`; it does not normalize and does not choose a fallback. Routing performs its existing ASCII lowercase normalization before calling it. This separation keeps a generic public lookup predictable while preserving route compatibility.

### 2.2 Self-describing definitions and construction

Each existing backend file remains at its current path and must export all of the following from that one file:

- its public backend class;
- its exact `AuthProfile` object;
- its `defineBuiltinBackend(...)` result;
- its engine floor, server topology, dependency-freshness declarations, and link to its central protocol-coverage row.

Move the four profile implementations out of `auth/auth-profiles.ts` and into their corresponding backend files. `auth/auth-profiles.ts` remains as a compatibility shim that re-exports the four values from their backend files and the two public types from `auth/auth-profile.ts`. The package root continues to export the same profile names and types. Existing class paths and root class exports remain unchanged.

`defineBuiltinBackend` accepts a literal id, the exact profile object, a profile-aware constructor callback, release metadata, and a central protocol-coverage row. It returns an immutable `BuiltinBackendDefinition<Id>` with at least:

```ts
interface BuiltinBackendDefinition<Id extends string> {
  readonly id: Id;
  readonly authProfile: AuthProfile;
  readonly create: () => Backend & { readonly id: Id; readonly authProfile: AuthProfile };
  readonly release: BuiltinBackendReleaseMetadata;
  readonly protocolCoverage: BuiltinProtocolCoverageRow;
}
```

The helper owns the composition, rather than each runner caller remembering it. At module initialization it throws if `authProfile.backendId !== id`. On every `create()` it calls the supplied constructor callback with that exact profile instance and throws if the result's `id` differs from the definition id or its `authProfile` is not the exact supplied object. The returned definition is frozen. Every object and array reachable through `definition.release` is recursively frozen, including `engine`, `server`, `freshness`, fork rows, wrapper rows, and every nested array. In strict-mode tests, assigning a release field or mutating a nested array must throw and leave the definition unchanged. This deep-freeze obligation is deliberately limited to the definition-owned release tree: the helper does not recursively freeze the pre-existing auth-profile object or the centralized protocol-coverage row. The callback and checks make profile attachment executable and testable without changing ownership of those referenced public objects.

Each public class constructor takes its profile with the colocated profile as its default, for example `constructor(readonly authProfile: AuthProfile = claudeAuthProfile)`. Consequently both `builtinBackend("claude")` and existing direct construction with `new ClaudeBackend()` retain the current profile behavior. Custom backends remain profile-less and outside `BUILTIN_BACKENDS`.

`BuiltinBackendReleaseMetadata` is the in-memory counterpart of §3.2. It contains no version number copied from `package.json` or the lockfile. Package names, topology, engine floors, and freshness relationships are architecture; resolved versions remain authoritative in package manifests and `pnpm-lock.yaml`.

### 2.3 Table integrity and exports

At module load, `builtins.ts` validates every row's `definition.id` equals its table key and throws a diagnostic naming both values on mismatch. `builtinBackend(id)` calls only that row's `create()`.

The package root must newly export the values `BUILTIN_BACKENDS`, `BUILTIN_BACKEND_IDS`, `builtinBackend`, and `BUILTIN_PROTOCOL_COVERAGE`, and the types `BuiltinBackendDefinition`, `BuiltinBackendReleaseMetadata`, `BuiltinBackendId`, and `BuiltinProtocolCoverageRow`. The existing `BuiltinBackendId` import path through `packages/acp-agents/src/backend.ts` is preserved with a type-only re-export from `backends/builtins.ts`; the old union is deleted. Existing class, auth-profile, registry, protocol-coverage, and backend-type exports remain.

The workflows package imports `BUILTIN_BACKEND_IDS` from `@automatalabs/acp-agents` and deletes its local `BUILTIN_HARNESSES`. `probeHarnessConfig` retains its existing composition: a non-empty `options.harnesses` is deduplicated and probed in caller order; otherwise the targets are `[...BUILTIN_BACKEND_IDS, ...registry.keys()]`, deduplicated in that order. It continues calling `ValidateProbeRunner.probeConfigOptions(target, { cwd })` once per target. `ValidateProbeRunner` is not widened with `listBackends()`. This keeps explicit harness filtering and the current test seam intact while deriving the default built-in set from the registry.

### 2.4 Removing duplicated runner decisions

All four current runner identity sites become table consumers:

1. `listBackends()` seeds its set from `BUILTIN_BACKEND_IDS` and then appends custom registry keys.
2. The local class switch is deleted; callers use the exported `builtinBackend(string)`.
3. `resolveModelRoute` performs one custom lookup followed by one `builtinBackend(firstSegment)` lookup.
4. `defaultBackend` performs one custom lookup followed by one `builtinBackend(name)` lookup and otherwise constructs the guaranteed `claude` row.

`runner.ts` must no longer import concrete built-in classes or contain built-in string equality branches. A source-level drift test scans the production runner and workflows configuration source and fails if the old class imports, `BUILTIN_HARNESSES`, a built-in `switch`, or a hand-maintained identity chain returns. The test must not merely count occurrences; it must assert that the named consumers import the registry API.

### 2.5 Frozen routing behavior

The refactor preserves these ordered rules exactly:

1. Before either custom or built-in lookup, the effective custom registry layers run-scoped entries under host entries: run-scoped entries are inserted first, host entries second, and the host wins an equal normalized name. A script can never replace an operator-configured backend.
2. The effective spec is `model ?? tier`.
3. An absent spec selects the configured default.
4. The first slash-delimited segment alone is ASCII-lowercased for routing. Non-ASCII characters and the remainder are not transformed.
5. A match in the effective custom registry is checked first and shadows a built-in of the same lowercased name.
6. A built-in match is checked second through `builtinBackend(firstSegment)`.
7. For a recognized custom or built-in prefix, the substring after the first slash is passed to model selection verbatim. No slash means no model-selection call. Empty substrings, additional slashes, whitespace, punctuation, and casing in the remainder are not normalized.
8. For an unrecognized prefix, the full original spec is passed verbatim to the configured default backend.
9. `AGENTPRISM_DEFAULT_BACKEND` is ASCII-lowercased. A match in the effective custom registry wins, then a built-in table match. An absent, empty, or unknown setting selects Claude.
10. Custom pool identity remains `name + spawn-config hash`; built-ins continue to default to the logical id because they define no `poolKey`.

No row may add a model catalog, alias table, provider mapping, or routing priority. The connected agent's model option remains authoritative, and `applyModelSelection` continues sending the resolved model string and reporting the same string without modification.

### 2.6 Delete the deprecated routing compatibility property

Delete `Backend.stripsRoutingPrefix` and every assignment/assertion for it from built-in and custom backends and tests. Prefix handling is solely the ordered router contract in §2.5. Do not replace the property with another backend flag. Historical specification prose may remain historical, but current API documentation, source comments, and tests must not describe it as a live field.

## 3. Generated dependency and runtime manifest

**Traceability:** owner quotation 1 and the Source directives for a zero-dependency preinstall gate, real schema axes, engine floors/topology, no hand-maintained work lists, and default-on/no-cap behavior.

### 3.1 Authority and files

The TypeScript table is the only authored built-in registry. Add:

- `scripts/generate-acp-backends-manifest.ts`, an after-install generator/checker that imports the table;
- `scripts/acp-backends.manifest.json`, its committed canonical JSON output; and
- root scripts `generate:acp-backends-manifest` and `check:acp-backends-manifest`, both run with the existing `tsx` development dependency.

The preinstall freshness gate must consume only the committed JSON file using Node built-ins. It must not import TypeScript, invoke `tsx`, resolve workspace code, or require `node_modules`. This preserves the current CI and release ordering in which the gate runs before `pnpm install`.

The generator is the only code allowed to write the manifest. Normal generation rewrites canonical two-space-indented JSON with one trailing newline. `--check` performs no writes, compares the canonical projection byte-for-byte with the committed file, prints a regeneration command on mismatch, and exits `1`; a match exits `0`.

### 3.2 Pinned schema

The committed file has exactly this versioned shape; unrecognized fields are errors rather than ignored extension points:

```ts
interface AcpBackendsManifestV1 {
  schemaVersion: 1;
  backends: Array<{
    id: string;
    engine: { node: string };
    server:
      | { kind: "npm-package"; package: string }
      | { kind: "workspace-package"; package: string; path: string }
      | { kind: "system-command"; command: string; optionalPackageProbe?: string };
    freshness: {
      npm: string[];
      forks: Array<{
        package: string;
        envDir: string;
        defaultDirs: string[];
        tempCloneName: string;
        originUrl: string;
        originUrlEnv: string;
        upstreamUrl: string;
        upstreamUrlEnv: string;
        upstreamRemote: string;
      }>;
      wrappedRuntimes: Array<{ adapterPackage: string; runtimePackage: string }>;
    };
  }>;
}
```

`schemaVersion` must be a JSON number whose parsed value is exactly `1`; a string, boolean, `null`, array, object, non-integer, or any other numeric value is invalid. `defaultDirs` stores portable tokens, not machine-expanded paths. Version 1 permits exactly `$HOME/<single-relative-path>` tokens; the gate expands `$HOME` with `homedir()` at runtime. Absolute developer paths, `..`, globs, and arbitrary environment substitution are invalid. All ids, package names, commands, paths, remotes, environment names, and `engine.node` values must be non-empty strings. Because `engine.node` is a minimum floor rather than a general dependency range, its canonical zero-dependency grammar is `/^>=(0|[1-9]\d*)(?:\.(0|[1-9]\d*)\.(0|[1-9]\d*))?$/`: exactly `>=MAJOR` or `>=MAJOR.MINOR.PATCH`, without whitespace, leading zeroes, prereleases, upper bounds, or unions. Values such as `""`, `"22"`, and `"banana"` are blockers. Backend ids and every array within a row must be duplicate-free. Backend ids must be unique and in the same order as `BUILTIN_BACKEND_IDS`.

Cross-field validation is mandatory:

- An `npm-package` server package appears in that row's `freshness.npm`.
- A `workspace-package` resolves to the named workspace `package.json` at the named path and is not sent to `lockedVersion()` merely because it is the server.
- A `system-command` is validated by packaging documentation and live e2e, not npm freshness. `optionalPackageProbe` records the optional resolution path but does not pretend the package is installed.
- Every fork `package` and every wrapped runtime's `adapterPackage` appears in the same row's `freshness.npm`.
- Every name in `freshness.npm` exists in at least one workspace `dependency`, `devDependency`, or `optionalDependency` and resolves through `lockedVersion()` in the lockfile. Repetition across backend rows is deduplicated before network checks.
- Every `wrappedRuntimes[].runtimePackage` resolves transitively through `lockedTransitiveVersions()`; it need not be a direct workspace dependency. A root `pnpm.overrides` entry is not treated as a direct dependency.
- A `system-command.optionalPackageProbe` is descriptive runtime resolution metadata. It may be absent from every workspace manifest and from the lockfile and is never passed to `lockedVersion()` or `lockedTransitiveVersions()` merely because it is named here.

### 3.3 Required initial projection

The initial generated rows encode the current real topology:

| id | Node floor | server | npm freshness packages | fork sync | wrapped runtime |
|---|---|---|---|---|---|
| `claude` | `>=22` | npm package `@agentclientprotocol/claude-agent-acp` | `@agentclientprotocol/sdk`, `@agentclientprotocol/claude-agent-acp` | none | adapter `@agentclientprotocol/claude-agent-acp` wraps `@anthropic-ai/claude-agent-sdk` |
| `codex` | `>=22` | npm package `@automatalabs/codex-acp` | `@agentclientprotocol/sdk`, `@automatalabs/codex-acp` | the exact existing `AGENTPRISM_CODEX_ACP_DIR`/fork/upstream/temporary-clone configuration | none |
| `opencode` | `>=22` | system command `opencode`, optional package probe `opencode-ai` | `@agentclientprotocol/sdk` | none | none |
| `pi` | `>=22.19.0` | workspace package `@automatalabs/pi-acp` at `packages/pi-acp` | `@agentclientprotocol/sdk`, `@earendil-works/pi-coding-agent` | none | none |

The Codex fork object must preserve: `$HOME/codex-acp`; temporary clone name `codex-acp`; origin `https://github.com/VikashLoomba/codex-acp.git`; upstream `https://github.com/agentclientprotocol/codex-acp.git`; override variables `AGENTPRISM_CODEX_ACP_ORIGIN_URL` and `AGENTPRISM_CODEX_ACP_UPSTREAM_URL`; and remote name `upstream`.

The table records engine floors as release/deployment metadata. It does not add a runtime router rejection. Provenance and divergence detection are frozen per server kind:

- For a `workspace-package` server, the named workspace package's `package.json#engines.node` is authoritative. The table and generated manifest must equal it byte-for-byte; absent or divergent values fail generation, the preinstall manifest check, and the registry test. Thus pi's row must equal `packages/pi-acp/package.json`, currently `>=22.19.0`.
- For an `npm-package` server, `packages/acp-agents/package.json#engines.node` is the authoritative host floor and the row must equal it byte-for-byte. When the resolved installed server package also declares `package.json#engines.node`, the after-install generator/check additionally requires that declaration to equal the same value. When the upstream package omits the field, the checklist records evidence of the absence and runtime validation at the host floor.
- For a `system-command` server, `packages/acp-agents/package.json#engines.node` is the authoritative host floor. The checklist separately records the command's external runtime prerequisite and requires the table/host floor to be raised together if that prerequisite is higher.

The after-install generator owns installed-package inspection; the zero-dependency preinstall gate never resolves `node_modules`. It still verifies every workspace-package row against its repository package and every npm-package/system-command row against the acp-agents host package. CI Node selection, packaging tests, and the checklist supply the remaining install/build/release evidence.

### 3.4 Freshness-gate refactor

`scripts/check-acp-deps.mjs` deletes the authored package work list `ACP_DEP_MATCHERS` and the authored `FORK_SYNC` and `WRAPPED_RUNTIMES` objects. It parses and strictly validates `scripts/acp-backends.manifest.json`, derives the three existing checks, and otherwise retains their semantics.

One reverse-coverage policy remains deliberately outside the manifest, expressed as valid zero-dependency JavaScript in the `.mjs` gate: `const MANIFEST_COVERAGE_PREFIXES = Object.freeze(["@agentclientprotocol/"]);`. Before any network request, the gate scans `dependencies`, `devDependencies`, and `optionalDependencies` in every `packages/*/package.json`; a name matching that prefix but absent from the union of all rows' `freshness.npm` entries is a blocker naming the package and workspace. This scan deliberately mirrors the current gate's `packages/*` and three-field scope; root-manifest and `peerDependencies` discovery are not silently implied. The prefix is not a source of npm/fork/wrapper work and is not a built-in identity list. It exists because a manifest cannot detect a package omitted from itself. The nonstandard Codex package remains loud through the npm-server and fork cross-field rules; the nonstandard pi runtime is pinned by the required initial projection and its golden test.

- npm freshness compares every manifest-declared direct tracked package's lockfile version with npm `latest`;
- fork freshness verifies a real clone's remotes, fetches origin/upstream, and checks containment against the pushed fork default branch;
- wrapped-runtime freshness compares the transitive lock resolution with npm `latest` and retains the adapter-bump/root-override remediation;
- npm registry HTTP retains exactly three attempts, a 10-second timeout per attempt, and waits of 1.5 seconds then 3 seconds before attempts two and three; HTTP 404 is not retried;
- each Git `fetch`, `ls-remote`, and working-clone `pull --ff-only` remains one `execFileSync` attempt with the existing 120-second timeout and fails closed on error;
- a disposable managed temp clone retains one repair: on any initial clone/check failure, delete it, clone once more, and check once more; a selected working clone is never deleted or repaired;
- an empty backend array or empty derived npm set is a blocker;
- malformed, missing, or semantically inconsistent manifest data is a blocker before any network request; table-to-manifest generator drift is caught by the after-install `--check` test;
- the gate remains zero-dependency and preinstall-safe; and
- success exits `0`; stale, malformed, missing, unreachable, or unverifiable state exits `1`.

CI, pre-push, and release continue invoking the same gate at their current points. There is no bypass or advisory mode. Tests that use the registry/fork URL environment seams remain hermetic.

### 3.5 Mechanical drift guarantees

The normal test suite must prove all of the following:

1. The generator's table projection is byte-identical to the committed manifest.
2. Table keys, row ids, profile ids, factory result ids, central protocol-coverage keys, and manifest ids are the same ordered set.
3. Every factory result carries the exact profile object declared by its row.
4. Every server/dependency/fork/wrapper cross-field rule in §3.2 holds, including direct-only validation for `freshness.npm`, transitive-only validation for wrapped runtimes, and no installation requirement for an optional system-command probe.
5. Every engine value satisfies the canonical floor grammar and the §3.3 source-of-truth parity rule for its server kind; an upstream npm server that adds or changes `engines.node`, a workspace server mismatch, or a stale fallback host floor fails loudly.
6. Every workspace dependency matching `MANIFEST_COVERAGE_PREFIXES` appears in at least one `freshness.npm` array; an unrepresented match fails before network access.
7. The gate derives current npm/fork/wrapper work only from a supplied manifest fixture; adding a fixture row activates each relevant check without editing gate source.
8. A missing manifest, bad JSON, nonnumeric or unknown schema version, unknown field, invalid engine floor, duplicate id/dependency, empty backend array, empty derived npm set, missing package/lock entry, reverse-coverage miss, workspace mismatch, illegal `$HOME` token, inconsistent server relation, or generator drift exits `1` with the applicable file, backend id, and field path in the diagnostic.
9. The dependency-gate runbook test in §10.6 proves that the manifest path and generation/check commands are present in the named runbook section.

## 4. Protocol coverage, initialization metadata, and extensions

**Traceability:** owner quotation 1, Issue #225 deliverables 4 and 7, and the Source directive requiring a decisive centralized-coverage design.

### 4.1 Centralized protocol coverage is the chosen design

Keep `packages/acp-agents/src/protocol-coverage.ts` centralized. ACP method classification, SDK schema tripwires, auth/meta conventions, and installed-distribution probes are cross-backend policy and must be compared as one matrix. Moving fragments into adapter files would hide omissions and make SDK bumps harder to audit.

Add `BUILTIN_PROTOCOL_COVERAGE`, an immutable object with one key per built-in. Each value is a `BuiltinProtocolCoverageRow` that references the universal client/agent method classifications and declares that backend's auth/meta convention rows and required installed-dist or live probes. Both the value and the row type are public package-root exports. Every backend definition must receive the exact central row object, not a copy: for every `id`, `BUILTIN_BACKENDS[id].protocolCoverage === BUILTIN_PROTOCOL_COVERAGE[id]`. The registry integrity test enforces both exact key parity and this reference-identity assertion; therefore a table row cannot land without an explicit central protocol-coverage disposition, and a backend file cannot fork the drift anchor behind an equal-looking object.

The existing exported constants and types remain exported. `protocol-coverage.ts` must not import `BuiltinBackendId`, the table, or concrete backend files; parity is enforced from the higher registry test to avoid a runtime cycle.

### 4.2 Initialize metadata on persistent public surfaces

`NegotiatedCapabilities.initializeMeta` already captures `InitializeResponse._meta`; keep that live getter behavior. Add an optional `initializeMeta?: Readonly<Record<string, unknown>>` to:

- `AgentSessionRef`, and therefore `AgentSessionRecord`, journal entries, snapshots, and workflow results;
- `AcpEventContext`, and therefore every session-scoped update, permission, elicitation, raw-message, open, and close event.

Fresh, loaded, resumed, and forked session state receives the connection's negotiated `initializeMeta` after connection readiness and before registration. `contextFor` copies it into every contextual event. Tombstones retain it so late teardown updates and `session_close` expose the same metadata. Runner session refs and `InteractiveSession.sessionRef` read the per-session snapshot through `SessionHandle`, not by independently sampling the connection. `backend_error` remains connection-scoped and retains its exact `{ backendId, error }` shape.

When `_meta` is absent or JSON `null`, the optional property is omitted, not emitted as `undefined` or `null`. When present, the complete JSON-decoded object is exposed without filtering, renaming, truncation, or resource cap. Create one recursively frozen JSON clone per session and share that stable snapshot with its state, refs, and event contexts; consumer mutation attempts must not alter subsequent observations. Do not freeze or otherwise change the existing connection-level `NegotiatedCapabilities` value. The projection is observation-only: it must not affect routing, pool identity, authorization, retry, hashes, or wire requests. Because the value arrived over JSON-RPC, refs/events remain JSON-round-trippable.

### 4.3 Outbound custom request and notification seam

The pinned ACP SDK release makes `request(method, params, options?)` and `notify(method, params?)` the supported agent-bound APIs. Its older `extMethod` and `extNotification` methods are deprecated delegates to them. The local `PooledConnection` and `InteractiveSession` already expose typed overloads plus generic custom-method overloads on `request`/`notify`; retain and document those APIs rather than adding duplicate `ext*` names.

Arbitrary custom methods and notifications pass through unchanged and are raced against process death. Named managed wrappers remain preferred for lifecycle-aware operations. Raw `session/new`, `session/load`, `session/resume`, and `session/fork` requests remain locally guarded because bypassing the router would create unregistered session state. Notifications have no response. Calling either API after an interactive session is released retains its current local error.

Add a fake-agent success fixture for one arbitrary custom request and one arbitrary custom notification, proving the exact method and params reach the wire and the response returns unchanged. Retain the method-not-found test. No backend-specific extension switch is allowed: the seam is symmetric for every built-in and custom ACP backend.

### 4.4 Numeric error and failure contract

This train introduces no new JSON-RPC error code and does not remap an agent's extension error. The pinned wire-visible contracts are:

- JSON-RPC Method not found is numeric code `-32601`. An arbitrary request rejected as unknown by the agent reaches the caller as its `RequestError` with code `-32601`.
- A missing client-side advertised handler continues answering agent-to-client requests with `-32601`; this refactor does not change inbound extension registration.
- Agent-provided custom error codes, messages, and data pass through `request` unchanged.
- Notifications have no response code and therefore cannot report method-not-found to the caller.
- The four guarded stateful raw requests fail locally before wire I/O with the existing guidance error; no numeric wire code applies.
- Manifest generator/check and dependency-gate success is process exit `0`; every contract failure described in §3 is process exit `1`.

The existing reserved ACP auth-required code `-32000` and all `WorkflowErrorCode` mappings are unchanged by this work.

### 4.5 `traceparent` disposition

No `traceparent` is added by Train 1. The repository currently has no W3C trace-context surface, while `runId` is already the established additive correlation field. Emitting a client-only `traceparent` without an agreed agent capability or propagation contract would create a misleading partial trace. End-to-end W3C propagation is explicitly outside this train in §8; this decision does not permit a partial header or `_meta` injection in the registry implementation.

## 5. Compatibility and release behavior

**Traceability:** owner quotations 1–2 and the Source directives for public shims, symmetry, default-on behavior, behavioral compatibility, and release/checklist completeness.

This is an architectural refactor with additive observability. Existing backend ids, routing, spawn overrides, structured-output behavior, auth flows, session lifecycle, pool reuse, public classes, and root exports remain compatible. The only removed public member is the already deprecated and unused `Backend.stripsRoutingPrefix`; routing behavior remains unchanged.

Routing, pooling, auth, and capability negotiation retain their current behavior except for the three routing invariants codified in §2.5 and the additive post-negotiation `initializeMeta` projection in §4.2. That projection does not change the initialize request or response, client-advertised capabilities, agent-advertised or derived negotiated capability values, handshake count, or negotiation timing. It samples the already negotiated value only after connection readiness.

`initializeMeta` is additive and optional. Its absence preserves byte-equivalent serialized refs/events. Its presence can add data to journaled session records and workflow results but cannot affect journal hash inputs that did not previously include it; any persistence hash/projection with an explicit allowlist must be deliberately updated and regression-tested so resume remains deterministic.

Each affected publishable package receives an explicit changeset. `@automatalabs/acp-agents` receives a **minor** changeset covering the additive registry/event surface and removal of the deprecated `stripsRoutingPrefix` member. This contract chooses minor rather than leaving the breaking-member bump ambiguous: the package is pre-1.0, the removed field is documented as unused, and the repository previously shipped removal of the dead `ModelRoute.useRegex` public field in the `0.18.0` minor release. Any package that publishes or re-exports the added session/event types, including `@automatalabs/shared-types` and `@automatalabs/workflows` when their public declarations change, also receives a minor changeset. A package changed only in user-facing prose receives a patch changeset when that prose ships in the package. `@automatalabs/pi-acp` receives a changeset only if its published code or metadata changes.

No opt-in configuration is added. The registry drives production immediately after merge, the generated manifest drives every dependency gate invocation immediately, and `initializeMeta` appears automatically whenever an agent sends it.

## 6. Backend-onboarding checklist and acceptance boundary

**Traceability:** owner quotation 1 and the Source directives for the acceptance boundary, mechanical-versus-checklist ownership, authoring generation, live e2e, engine/topology evidence, symmetry, and complete delivery.

### 6.1 Mechanically enforced work

The following is enforced by types, table validation, generator drift, unit/integration tests, or the preinstall gate. A new built-in cannot pass CI without it:

- a literal table row whose key, definition id, profile id, factory id, exact central coverage-row reference, and generated manifest id agree;
- a factory that attaches the exact colocated auth-profile object;
- a complete release-metadata row with engine, topology, npm, fork, and wrapper fields (empty arrays are explicit dispositions), plus canonical engine-floor syntax and exact §3.3 package-manifest parity;
- a canonical regenerated manifest;
- declared package dependencies and direct lockfile resolutions for every `freshness.npm` entry, plus transitive lockfile resolution for every wrapped runtime;
- reverse coverage from every workspace dependency matching `MANIFEST_COVERAGE_PREFIXES` to at least one `freshness.npm` row;
- a valid workspace name/path for workspace servers;
- registry-derived runner lookup/list/default behavior and workflows configuration recognition;
- custom-shadowing, spawn-hash pool-key, unknown-default-to-Claude, and verbatim-model routing invariants;
- central protocol method/auth/meta coverage parity;
- SDK method/schema drift tests;
- no deprecated routing-prefix property; and
- full initialize-meta and outbound custom request/notification integration coverage.

### 6.2 Human-reviewed work that cannot be honestly inferred from a row

Add `docs/backend-onboarding-checklist.md` as the single checked-in backend-onboarding checklist. It must require a link or a written `not applicable` rationale for every item below and must state that a backend implementation PR cannot merge until every item is completed. These items remain human-reviewed because semantic quality cannot be proved merely by registry shape. A repository-wide pull-request template is not used because these obligations apply only to built-in backend onboarding and would add irrelevant ceremony to every other PR.

- Verify the real backend package/system prerequisite, license, spawn command/bin resolution, environment overrides, shutdown behavior, and minimum Node engine. Record which §3.3 engine source applied; for an npm package with no `engines.node`, link evidence of that absence and runtime validation at the fallback floor; for a system command, link its runtime prerequisite and raise both the host package and row if necessary. For any differing installed npm-server declaration, do not overwrite or normalize upstream metadata: if it is higher, raise the host package and row together; if it is lower or noncanonical, upgrade or replace the server package or obtain an upstream declaration correction before onboarding. For a new workspace server, add workspace package metadata, root TypeScript project references, build/test scripts, package exports/bin/files, packaging tests, and changeset configuration.
- Inspect the agent's complete ACP initialize capabilities and custom `_meta` conventions. Add its row to centralized protocol coverage, installed-dist probes where source is available, auth profile, auth/meta matrix, and capability tests. Empty/unsupported capabilities must be explicit.
- Exercise permissions, elicitation, fs/terminal/MCP handlers, session lifecycle, cancellation, structured output, provider errors, auth, pool reuse, and extension passthrough as applicable. “Same as another backend” requires a test, not a prose assumption.
- Update user/API/readme examples, environment-variable documentation, package export docs, changelogs, and the `CONTRIBUTING.md` section headed `When the dependency gate blocks`. Preserve public re-export shims for any relocated symbols. Human review owns the accuracy of the runbook instructions; the normal test suite separately enforces the literal manifest path and commands in §10.6.
- Update MCP authoring source material, not only its generated prompt. This includes the relevant `skills/agentprism-workflow-authoring/*.md` routing/model/configuration tables. Run `node scripts/generate-authoring-prompt.mjs`, commit the regenerated prompt artifact, and pass both the generated-prompt drift test and its routing sentinel assertions.
- Update `packages/mcp-server/src/server.ts` backend/tool descriptions that enumerate supported agents and their routing syntax.
- Add the backend to `packages/mcp-server/test/live-backend.e2e.test.ts`: its backend union, executable/bin probe table, environment scope table, setup/auth diagnostic, the existing structured-output/pooling matrix, and one schema-less smoke run. Run the real authenticated live leg and record the command/result in the PR. The existing pre-push live gate remains mandatory.
- Run the dependency gate from a zero-`node_modules` checkout state or its hermetic equivalent, then run build, typecheck, package tests, full tests, authoring drift, and live e2e.
- Add changesets for every affected published package and confirm release ordering when a new server workspace/package is introduced.

No checklist item may silently disappear because a backend uses a system command, workspace package, fork, wrapped runtime, or no custom auth. Those conditions determine the evidence or `not applicable` rationale, not whether the row is treated as first class.

### 6.3 Definition of done

Train 1 is complete only when the current four backends are represented symmetrically, every production identity consumer is registry-derived, the manifest/gate design passes its failure fixtures, protocol additions are visible on all required surfaces, documentation/authoring/live tables agree, changesets are present, and the entire §10 test plan passes. There are no unresolved design questions in this contract.

## 7. Failure behavior

**Traceability:** owner quotation 1 and the Source directives for loud drift, exact failure contracts, default-on/no-bypass behavior, and no resource caps.

Failures are deterministic and scoped as follows:

| failure | detection point | required result |
|---|---|---|
| table key, definition id, profile id, or factory id mismatch | module load/factory test | throw with the expected and actual ids; do not construct or route |
| `builtinBackend` receives an unknown string | public lookup | return `undefined`; do not throw or fall back |
| default-backend setting is absent/empty/unknown | default routing | construct Claude from its ordinary table row |
| host and run-scoped custom names collide | effective-registry construction | keep the host entry; do not route to the script entry |
| custom and built-in names collide | route selection | construct custom backend; built-in remains enumerable |
| manifest missing/malformed/stale/inconsistent | generator check or preinstall gate | name the file/backend/field, exit `1`, do not fall back to source constants |
| manifest backend array or derived npm set is empty | preinstall gate, before network | name `backends` or the derived `freshness.npm` set and exit `1`; do not treat the absence of work as success |
| schema version is not numeric `1`, or `engine.node` is empty/noncanonical | generator check or preinstall gate | name the field, exit `1` before network access |
| row engine floor differs from its §3.3 package-manifest source | generator, preinstall gate where repository-readable, or registry test | name the backend and both values, exit `1`; never choose one silently |
| npm registry unavailable after the three attempts in §3.4 | preinstall gate | fail closed, exit `1` |
| working-clone Git operation fails on its single attempt | preinstall gate | fail closed, exit `1`; do not delete or repair the working clone |
| disposable clone still fails after its one delete/reclone repair | preinstall gate | fail closed, exit `1` |
| tracked-namespace workspace dependency is absent from every `freshness.npm` row | preinstall gate, before network | name the dependency and workspace, exit `1` |
| SDK schema or method set drifts | compile/coverage test | fail build with the drifted key/method |
| initialize `_meta` absent/null | ref/event projection | omit `initializeMeta`; preserve prior shape |
| arbitrary extension request unknown to agent | JSON-RPC response | preserve `RequestError.code === -32601` and agent message/data |
| arbitrary extension notification unknown to agent | notification | resolve after write/process race; no fabricated response |
| raw stateful session creation/reopen/fork | local guard | reject before wire with named managed-wrapper guidance |

Diagnostics must not print environment values, auth metadata, initialize metadata, or request params. Registry and manifest diagnostics may print ids, package names, paths, method names, schema field paths, versions, and remote URLs already present in source.

## 8. Non-goals

**Traceability:** the Source directives for explicit Non-goals, the Train 1 boundary, and prohibition on partial delivery, plus §4.5's `traceparent` disposition.

The following are explicitly outside Train 1, with rationale:

- Adding another built-in backend. This train builds and proves the onboarding architecture against the current four; it does not select the next product integration.
- Changing model aliases, tier resolution, backend defaults, prefix syntax, custom-backend precedence, or built-in pool identity. Those are user-visible routing decisions and this issue is explicitly behavior-preserving.
- Adding a backend ranking, “primary” designation, allowlist flag, rollout percentage, or resource limit. They conflict with the required symmetric, default-on registry.
- Replacing the custom backend registry. Custom registrations remain the runtime escape hatch and intentionally shadow built-ins.
- Changing routing, pooling, auth, or capability-negotiation behavior beyond the §2.5 invariant tests and the additive §4.2 projection. The registry must consolidate current behavior, not use the refactor to alter initialization traffic, advertised/negotiated capabilities, negotiation timing, auth decisions, or process reuse.
- Changing pi correctness or MCP behavior. The existing pi backend/server contract is a prerequisite consumed by this train; registry work may relocate or reference its values only through behavior-preserving shims. Further pi correctness/MCP edits belong outside this implementation because they would mix a server-behavior change into an architecture-only registry train.
- Rewriting the freshness algorithms, switching from npm `latest`, replacing real-clone fork verification with an API, or moving the gate after install. The goal is registry-derived configuration while preserving the proven fail-closed mechanisms.
- Requiring the optional `opencode-ai` package. Current behavior supports the system `opencode` command and only probes the package when available; changing distribution policy would alter installation behavior.
- End-to-end W3C `traceparent` propagation. It needs a separately frozen capability, trust, and cross-process propagation contract; client-only `_meta` injection would falsely imply trace continuity.
- Adding inbound arbitrary agent-to-client extension handlers. Train 1 guarantees the already supported client-to-agent `request`/`notify` path; inbound registration changes host security and capability advertisement and are not required to onboard a built-in.

These exclusions are complete scope boundaries, not permission to ship a partial registry, manifest, metadata projection, extension test, checklist, authoring update, or live-e2e update.

## 9. Rejected alternatives

**Traceability:** owner quotation 1 and the Source directive requiring decisive choices with rejected-alternative rationale.

1. **Keep the handwritten union and use a factory switch.** Rejected because identity would still be duplicated and adding a row would not update types, enumeration, or defaults automatically.
2. **Make one backend “primary” and layer other rows as exceptions.** Rejected because the owner required symmetric built-ins; it would perpetuate the architecture that makes the next first-class ACP agent hard.
3. **Lowercase inside `builtinBackend(string)`.** Rejected because normalization belongs to routing, while a general lookup should narrow exact registry keys and reject prototype/case surprises.
4. **Move auth profiles into a separate per-backend registry.** Rejected because it creates another onboarding list. Colocating each profile with its adapter and composing it through `defineBuiltinBackend` makes one backend file self-describing while shims preserve imports.
5. **Move all protocol coverage into backend files.** Rejected because SDK method completeness, auth/meta conventions, and dist probes need one cross-agent audit matrix. The chosen central table is linked and parity-checked from each backend row.
6. **Import the TypeScript table from the preinstall gate.** Rejected because CI/release run the zero-dependency gate before install. A generated committed JSON projection preserves that boundary and makes drift testable.
7. **Continue using broad dependency matchers as the source of freshness work plus special `FORK_SYNC`/`WRAPPED_RUNTIMES` objects.** Rejected because every new nonstandard relationship would require gate edits and could be forgotten. Manifest rows explicitly model each real axis. The retained `MANIFEST_COVERAGE_PREFIXES` has the narrower reverse-only role of detecting an `@agentclientprotocol/*` workspace dependency omitted from every row.
8. **Store package versions in the registry row.** Rejected because package manifests and the lockfile already own specifiers/resolutions. Copying versions would add stale state without improving the gate.
9. **Treat the pi workspace package as an npm-fresh direct dependency.** Rejected because `workspace:*` is not a registry version and cannot satisfy the current `lockedVersion()` contract. The manifest separates server topology from independently tracked npm packages.
10. **Call the SDK's deprecated `extMethod`/`extNotification`.** Rejected because current SDK 1.2.1 implements them only as deprecated delegates. The existing local `request`/`notify` APIs are the supported generic seam and already preserve typed built-ins.
11. **Add new local `extMethod`/`extNotification` aliases.** Rejected because they duplicate a working public API and immediately inherit upstream deprecation.
12. **Put `initializeMeta` only on the capability getter.** Rejected because callers consuming serialized handoff refs, workflow results, journals, or event streams otherwise lose handshake metadata when the connection is unavailable.
13. **Put `initializeMeta` on `backend_error`.** Rejected because that event deliberately has no session context and may represent a failed initialize that produced no negotiated metadata.
14. **Inject `traceparent` opportunistically.** Rejected because no local or negotiated end-to-end contract exists; partial injection is observability theater rather than trace propagation.
15. **Retain `stripsRoutingPrefix` as a compatibility no-op.** Rejected because it is deprecated, unused, and suggests adapter-specific routing. The required architecture has exactly one router rule.
16. **Validate only manifest-to-workspace dependency direction.** Rejected because a newly added `@agentclientprotocol/*` dependency could then be omitted from the table and manifest while every table/manifest parity test still passed. The reverse prefix check makes that omission fail before network access.
17. **Delegate workflow harness enumeration to `ValidateProbeRunner.listBackends()`.** Rejected because that interface does not expose the method and widening it would duplicate rather than simplify the existing explicit `options.harnesses` filtering path. Directly composing `BUILTIN_BACKEND_IDS` with registry keys changes only the duplicated source list.
18. **Put the onboarding checklist in a repository-wide pull-request template.** Rejected because the repository has no such template and backend-specific evidence would burden unrelated PRs. The pinned `docs/backend-onboarding-checklist.md` path gives backend changes one reviewable artifact.
19. **Treat every `engine.node` value as table-authored prose checked only by reviewers.** Rejected because a package engine can move while the row remains stale. The chosen per-kind provenance makes workspace and host-package parity mechanical, checks an installed npm server's declared engine after install, and reserves human evidence only for an npm package that omits the field or a system command outside the workspace.
20. **Accept deep equality or key-set parity for protocol coverage.** Rejected because an adapter could pass a divergent copy while preserving keys and current values, fragmenting the single drift anchor. Reference identity to `BUILTIN_PROTOCOL_COVERAGE[id]` is cheaper and exact.
21. **Leave the manifest path and generator commands as a human-only runbook check.** Rejected because §3.5 promises that missed mechanical surfaces fail in the normal suite. A narrow content test guarantees discoverability while checklist review still owns instructional quality.
22. **Shallow-freeze only the release root.** Rejected because nested arrays and fork objects would remain mutable and could change generated output after module load. Recursive freezing is confined to the definition-owned release tree so it does not seize ownership of shared profile or coverage objects.
23. **Leave the `stripsRoutingPrefix` bump level to implementation or force a 1.0 major.** Rejected because an unfrozen bump makes release behavior ambiguous, while a major would conflict with the repository's concrete `0.18.0` minor precedent for removing the dead `ModelRoute.useRegex` field. This contract pins an `@automatalabs/acp-agents` minor.
24. **Accept arbitrary npm semver-range syntax for `engine.node`.** Rejected because this field represents one minimum floor and the preinstall validator cannot depend on a semver package. The canonical `>=MAJOR`/`>=MAJOR.MINOR.PATCH` grammar covers the required rows and stays zero-dependency.

## 10. Test plan

**Traceability:** owner quotations 1 and 3 and the Source directives for test-plan consistency, mechanical/checklist ownership, exact routing tests, authoring generation, and live e2e.

### 10.1 Registry and type tests

- Compile-time: `BuiltinBackendId` accepts exactly the keys of `typeof BUILTIN_BACKENDS`; a fixture fifth row widens the type without editing a union.
- Runtime: assert exact initial order, key/id/profile/coverage parity, exact profile object identity, `definition.protocolCoverage === BUILTIN_PROTOCOL_COVERAGE[id]`, class direct-construction compatibility, frozen definition roots, and `builtinBackend` unknown/prototype/case behavior. In strict mode, attempt assignment at every release-metadata object depth and mutation of `freshness.npm`, `freshness.forks`, `defaultDirs`, and `wrappedRuntimes`; each must throw, every object/array reachable through `release` must satisfy `Object.isFrozen`, and serialized release metadata must remain unchanged. The referenced auth profile and central coverage row are not asserted as helper-owned deep-freeze targets.
- Source drift: assert runner and workflows production source import registry APIs and contain none of the deleted concrete imports/list/switch/boolean-chain patterns. The same test must inspect both value and type dependency syntax in `backends/define.ts` and `protocol-coverage.ts`, including `import type`, inline `type` specifiers, and `import(...)` type queries: fail if `define.ts` imports the registry table, or if `protocol-coverage.ts` imports `BuiltinBackendId`, the table, or a concrete backend file.
- Workflows config: with no explicit harnesses, assert targets are `BUILTIN_BACKEND_IDS` followed by custom registry keys with first occurrence winning; with a non-empty `options.harnesses`, assert the caller's deduplicated order is used and no default target is added. The `ValidateProbeRunner` fake continues to implement only `probeConfigOptions` and `dispose`.
- Public API: compile root imports of `BUILTIN_PROTOCOL_COVERAGE` and `BuiltinProtocolCoverageRow` along with every other new export, plus imports from `backend.ts`, existing backend class paths, and `auth/auth-profiles.ts` shims.

### 10.2 Routing and pool tests

- Preserve and expand table-driven cases for absent specs; recognized prefixes with no slash, empty remainder, mixed-case prefix, multiple slashes, whitespace, punctuation, non-ASCII model remainder, and mixed-case model remainder; unknown prefixes; and `tier` when `model` is absent. Include `CLÄUDE/model` as an unrecognized prefix: only ASCII letters become lowercase, the non-ASCII `Ä` is unchanged, and the full original string reaches the default backend verbatim.
- Assert the exact string delivered to `selectModel` and `onModelResolved` for every case.
- Assert custom `claude` shadows the table row; when host and run-scoped registries define the same normalized custom name, the host entry wins before custom-versus-built-in lookup; and all built-ins remain listed once.
- Assert an absent, empty, valid mixed-case, custom, and unknown `AGENTPRISM_DEFAULT_BACKEND`; unknown remains Claude.
- Preserve two same-name custom configurations with different command/args/env and prove distinct spawn-hash pool keys/processes.

### 10.3 Manifest and gate tests

- Golden generator check for the four required rows and canonical bytes.
- Schema fixture matrix for every invalid condition in §§3.2, 3.4, 3.5, and 7, with exit `1` and redacted diagnostics. Include `schemaVersion` values `"1"`, `null`, `1.5`, and `2`; `engine.node` values `""`, `"22"`, `"banana"`, `">=022"`, and `">=22 || >=24"`; and valid boundary controls `">=22"` and `">=22.19.0"`.
- Fail-closed emptiness fixtures supply (a) `backends: []` and (b) a non-empty backend array whose rows all have empty `freshness.npm` arrays; each exits `1` before any network stub is called and names the empty collection.
- `--check` behavior fixture corrupts a copy of the committed manifest, runs the checker, and asserts exit `1`, byte-for-byte unchanged file contents, and output naming `pnpm generate:acp-backends-manifest` as the remediation command.
- Reverse-coverage fixtures add an undeclared `@agentclientprotocol/example-agent` dependency in each of `dependencies`, `devDependencies`, and `optionalDependencies`; each fails before a network stub is called, while adding it to one `freshness.npm` row passes and activates the ordinary npm check.
- Cross-field fixtures prove `freshness.npm` requires a direct workspace dependency and importer lock resolution, a wrapped `runtimePackage` needs only transitive lock resolution, and `optionalPackageProbe` may be absent from manifests and the lockfile.
- Engine-provenance fixtures prove: a workspace server row must exactly equal its package's `engines.node`; every npm server row exactly follows the acp-agents host floor and, when the installed server declares an engine, that declaration must equal the same floor; an npm server with no declaration requires the checklist evidence but no invented upstream value; and a system-command row exactly follows the host floor. For the initial rows, assert pi equals `packages/pi-acp/package.json`, while Claude/Codex/OpenCode satisfy the applicable npm/system rule. Each repository-readable divergence fails with both values and no network call; an installed-package mismatch fails in the after-install generator test.
- Parameterized gate fixtures prove adding a manifest npm/fork/wrapper relationship activates the existing algorithm without source edits.
- Preserve npm's three-attempt 10-second-timeout/backoff/404 behavior; prove working-clone Git calls are single-attempt and never repaired; prove a disposable clone receives exactly one delete/reclone repair; and preserve exact lock resolution, fork remote identity/clean/pushed/default-branch/containment, wrapped transitive runtime, and redundant override tests.
- Run the gate from the repository with dependencies unavailable to the script, proving it imports only Node built-ins and JSON.

### 10.4 Initialize-metadata tests

- Fake initialize responses with absent, `null`, empty-object, and nested metadata; mutation attempts cannot alter the recursively frozen per-session snapshot or subsequent projections, and the existing connection getter remains unchanged.
- For fresh, load, resume, and fork, assert `AgentSessionRef` and `InteractiveSession.sessionRef` carry the complete object when present and omit the key when absent/null.
- Assert every `AcpEventContext` event kind carries identical metadata, including `session_open`, `session_close`, all update discriminants, permissions, elicitations, raw messages, the `session_open` emitted after a successful inline-auth resolve-and-retry-once acquisition, and a late tombstone update. No new retry event kind is introduced.
- Assert `backend_error` retains exactly `backendId` and `error`.
- JSON stringify/parse refs, records, journal entries, workflow results, and representative events; assert semantic equality and no secret/log output.
- Assert metadata does not enter wire requests, pool keys, routing, auth decisions, retry decisions, or deterministic workflow call hashes.
- Compare initialize wire logs and negotiated capability snapshots with metadata absent versus present; only the post-readiness ref/event projection may differ, while request shape, handshake count/timing order, and every advertised/derived capability remain identical.

### 10.5 Extension and protocol tests

- Retain the typed built-in request and notification passthrough cases.
- Add successful arbitrary request/notification cases with exact generic types, method strings, params, response, and wire log.
- Retain arbitrary unknown request code `-32601`, agent custom error passthrough, released-session rejection, process-death racing, and guards for all four stateful raw requests.
- Assert central protocol coverage keys exactly match registry keys and every SDK client/agent method remains classified.
- Pin compile/runtime checks to the implementation-time current ACP SDK schema, including `InitializeResponse._meta` and generic `request`/`notify` overloads.

### 10.6 Documentation, authoring, packaging, and live validation

- Add a normal-suite runbook-content test scoped to the `CONTRIBUTING.md` section headed `When the dependency gate blocks`. It must find the exact literals `scripts/acp-backends.manifest.json`, `pnpm generate:acp-backends-manifest`, `pnpm check:acp-backends-manifest`, and `node scripts/check-acp-deps.mjs` within that section; moving or omitting any literal fails with the missing token. This is the mechanical half of §3.5.9; review still validates that the surrounding instructions are accurate.
- Run the generated authoring-prompt drift test and routing sentinel assertions after updating authoring source files.
- Run doc/API/export compile checks and packaging tests, including the pi workspace package topology.
- Run build, typecheck, all package tests, and changeset validation.
- Run the real authenticated live backend matrix for Claude, Codex, OpenCode, and pi after table/manifest conversion. Verify schema and non-schema behavior, correct backend spawn, auth diagnostics, model forwarding, lifecycle/cancellation, and no routing regression. The PR records the exact command and outcome for each row.

## 11. Implementation sequence

**Traceability:** owner quotation 2 and the Source directives for contract-before-implementation/release order and complete delivery.

The implementation treats the current pi correctness/MCP contract as a prerequisite. It may relocate or reference those values with shims but must stop if satisfying this registry contract would require changing pi wire, MCP, structured-output, auth, lifecycle, or error behavior.

The implementation lands as one release-ready change set in this dependency order:

1. Extract the lower auth-profile types; colocate profiles; add public shims.
2. Add `defineBuiltinBackend`, definitions, central coverage rows, and `BUILTIN_BACKENDS`.
3. Convert runner/workflows consumers and remove `stripsRoutingPrefix`.
4. Add release metadata, generator, committed manifest, and manifest-driven zero-dependency gate.
5. Thread `initializeMeta` and complete extension/protocol tests.
6. Complete docs, authoring generation, live-e2e tables, checklist evidence, changesets, and the full test plan.
7. Perform §12 freshness re-verification immediately before implementation conclusions are treated as valid.

Intermediate commits may temporarily fail, but the implementation PR is not mergeable or releasable until all seven steps and §6 are complete.

## 12. External dependency verification and implementation-time re-verification

**Traceability:** §12's mandatory fresh-clone/latest-release verification, main-diff risk check, and stop-and-report behavior are self-contained below.

### 12.1 Verification snapshot

On 2026-07-19, a new temporary clone of `https://github.com/agentclientprotocol/typescript-sdk.git` was created. npm reported `@agentclientprotocol/sdk` `latest` as `1.2.1`. GitHub's current latest release was `v1.2.1`; its tag and release target resolve to commit `26da1ae7ab66fae0f5e77272dee3e5d562d24aee`, and the checked-out package reports version `1.2.1`. The freshly fetched upstream `main` was `0daecae58483e362753004c985119865d7cc6edd`.

At that pin:

- `InitializeResponse._meta` is an optional string-keyed object or `null`.
- The fluent `ClientContext` used by the local connection exposes typed standard-method overloads plus generic string overloads on `request` and `notify`.
- The SDK's legacy `ClientSideConnection` exposes the same `request`/`notify` shape, and its `extMethod`/`extNotification` are deprecated delegates to them; the agent-side legacy connection is symmetric.
- Upstream tests exercise extension requests and notifications in both directions.

`git diff v1.2.1..origin/main` changed only `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, and `package-lock.json`. `git diff --exit-code v1.2.1..origin/main -- src/acp.ts src/schema/types.gen.ts src/schema/zod.gen.ts` exited `0`. Therefore there was no unreleased main change to the cited request/notify/deprecated-alias/initialize-schema surfaces. The forward-compatibility risk is dependency/tooling movement only at this snapshot; a subsequent release can still change these APIs or schemas and must be caught by the required tripwire.

### 12.2 Mandatory implementation-time check

Before writing implementation code, the implementer must repeat the following from a newly created temporary directory, never a retained checkout:

1. Query npm `latest` for `@agentclientprotocol/sdk` and clone/fetch the upstream repository.
2. Resolve the release tag and exact commit corresponding to that npm version; verify the cloned package version matches.
3. Re-open the actual initialize schema, generic request/notify methods, deprecated aliases if still present, and extension tests at that tag.
4. Diff that tag against fetched upstream `main`, both repo-wide and restricted to every cited surface.
5. Record the npm version, tag commit, main commit, changed paths, and restricted-diff result in the implementation PR.

If npm `latest`, the tag, any cited path/line mechanism, overload, deprecation, schema, or unreleased main diff differs from §12.1, stop before building and report the exact drift in the contract workflow. Do not silently adapt the design, pin an older release, or rely on the §12.1 verification clone. Implementation resumes only after the drift is reconciled with the frozen contract.

## 13. References

**Traceability:** all three owner quotations and the Source requirement to re-verify every citation, count, and mechanism against the pinned base.

All local references below are pinned to `248aa1b374d0f2a0343a4c2e9e07d9bd7e008988` and were checked against that tree.

### 13.1 Current identity, routing, and pool surfaces

- Handwritten built-in type and deprecated property: `packages/acp-agents/src/backend.ts:14-18`, `packages/acp-agents/src/backend.ts:60-69`.
- Current class/profile attachment and spawn implementations: `packages/acp-agents/src/backends/claude.ts:23-57`; `packages/acp-agents/src/backends/codex.ts:29-66`; `packages/acp-agents/src/backends/opencode.ts:23-54`; `packages/acp-agents/src/backends/pi.ts:17-61`.
- Current auth profiles are one separate list: `packages/acp-agents/src/auth/auth-profiles.ts:1-17`, `packages/acp-agents/src/auth/auth-profiles.ts:32-53`, `packages/acp-agents/src/auth/auth-profiles.ts:55-124`.
- Runtime profile consumers read from the backend instance: `packages/acp-agents/src/runner.ts:1195-1279`, `packages/acp-agents/src/runner.ts:1584-1595`, `packages/acp-agents/src/acp-client.ts:1310-1329`.
- Four current runner identity sites and exact routing/model behavior: `packages/acp-agents/src/runner.ts:533-538`, `packages/acp-agents/src/runner.ts:1449-1456`, `packages/acp-agents/src/runner.ts:1471-1517`, `packages/acp-agents/src/runner.ts:1640-1651`.
- Custom-shadowing and registry validation: `packages/acp-agents/src/registry.ts:1-8`, `packages/acp-agents/src/registry.ts:40-73`, `packages/acp-agents/src/registry.ts:75-92`, `packages/acp-agents/src/registry.ts:94-170`.
- Custom spawn-hash pool identity consumption: `packages/acp-agents/src/backend.ts:62-66`, `packages/acp-agents/src/pool.ts:149-183`.
- Workflows duplicate list: `packages/workflows/src/config.ts:41-63`.
- Workflows probe composition and workspace dependency: `packages/workflows/src/validate-internal.ts:1-21`, `packages/workflows/package.json:41-52`.
- Current root exports/shim surface: `packages/acp-agents/src/index.ts:50-53`, `packages/acp-agents/src/index.ts:131-161`, `packages/acp-agents/src/index.ts:208-222`.
- Existing routing/default and custom-shadow/pool-key tests: `packages/acp-agents/test/backends.test.ts:149-189`, `packages/acp-agents/test/registry.test.ts:197-255`.

### 13.2 Dependency gate and package topology

- Existing zero-dependency, preinstall, fail-closed contract: `scripts/check-acp-deps.mjs:1-34`.
- Current authored matcher/fork/wrapper lists and tracked-package collection: `scripts/check-acp-deps.mjs:38-100`.
- Workspace/lockfile discovery: `scripts/check-acp-deps.mjs:80-125`.
- npm three-attempt retry/backoff and freshness: `scripts/check-acp-deps.mjs:154-217`.
- Single-attempt Git wrapper, working-clone operations, and disposable one-repair path: `scripts/check-acp-deps.mjs:237-250`, `scripts/check-acp-deps.mjs:263-320`, `scripts/check-acp-deps.mjs:322-356`.
- Wrapped runtime check and pinned exit statuses: `scripts/check-acp-deps.mjs:378-438`, `scripts/check-acp-deps.mjs:440-492`.
- Gate-before-install CI and release ordering: `.github/workflows/ci.yml:39-58`, `.github/workflows/release.yml:87-103`.
- Pre-push gate and mandatory live backend coverage: `.githooks/pre-push:1-24`, `.githooks/pre-push:31-67`.
- ACP-agent package engine/dependencies: `packages/acp-agents/package.json:5-7`, `packages/acp-agents/package.json:38-52`.
- pi workspace server engine/bin/dependencies: `packages/pi-acp/package.json:5-24`, `packages/pi-acp/package.json:44-59`.
- Workspace engine/tooling and project references: `package.json:5-29`, `tsconfig.json:1-11`.
- OpenCode's package-probe/system-command topology: `packages/acp-agents/src/backends/opencode.ts:45-54`, `packages/acp-agents/src/backends/opencode.ts:120-133`.
- Pi's workspace-package bin resolution: `packages/acp-agents/src/backends/pi.ts:46-61`.
- Pi packaging, gate-tracking, project-reference, and release guards: `packages/pi-acp/test/packaging.test.ts:8-40`.
- Dependency-gate command/runbook location and current triage contract: `CONTRIBUTING.md:63-85`.
- Changesets configuration and the concrete minor-release precedent for dead public-field removal: `.changeset/config.json:1-10`, `packages/acp-agents/CHANGELOG.md:408-419`.

### 13.3 Protocol, metadata, events, and extensions

- Central SDK method and auth/meta coverage: `packages/acp-agents/src/protocol-coverage.ts:15-71`, `packages/acp-agents/src/protocol-coverage.ts:73-111`, `packages/acp-agents/src/protocol-coverage.ts:140-205`.
- Existing initialize-meta capture: `packages/acp-agents/src/capabilities.ts:51-88`, `packages/acp-agents/src/capabilities.ts:90-117`; its current test is `packages/acp-agents/test/capabilities.test.ts:42-90`.
- Serializable session-ref shape: `packages/shared-types/src/workflow-result.ts:60-115`.
- Event context and all contextual event types: `packages/acp-agents/src/events.ts:1-40`, `packages/acp-agents/src/events.ts:42-120`, `packages/acp-agents/src/events.ts:126-148`.
- Event context construction, lifecycle, and tombstones: `packages/acp-agents/src/acp-client.ts:360-389`, `packages/acp-agents/src/acp-client.ts:416-445`.
- One-time initialize and live negotiated getter: `packages/acp-agents/src/acp-client.ts:1020-1065`, `packages/acp-agents/src/acp-client.ts:1203-1207`, `packages/acp-agents/src/acp-client.ts:1405-1457`.
- Fresh/fork/reattach session-state construction: `packages/acp-agents/src/acp-client.ts:1585-1613`, `packages/acp-agents/src/acp-client.ts:1626-1667`, `packages/acp-agents/src/acp-client.ts:1683-1715`.
- Runner and interactive session-ref projections: `packages/acp-agents/src/runner.ts:1519-1536`, `packages/acp-agents/src/interactive.ts:285-302`.
- Generic outbound request/notify wrappers and guards: `packages/acp-agents/src/acp-client.ts:165-170`, `packages/acp-agents/src/acp-client.ts:778-785`, `packages/acp-agents/src/acp-client.ts:1865-1893`, `packages/acp-agents/src/interactive.ts:213-249`.
- Existing passthrough tests, including numeric `-32601`: `packages/acp-agents/test/passthrough.integration.test.ts:23-95`, `packages/acp-agents/test/passthrough.integration.test.ts:97-115`.
- Existing contextual/tombstone/backend-error tests: `packages/acp-agents/test/runner-events.integration.test.ts:25-63`, `packages/acp-agents/test/runner-events.integration.test.ts:131-215`, `packages/acp-agents/test/runner-events.integration.test.ts:217-249`.
- Existing session-ref tests: `packages/acp-agents/test/session-handoff.integration.test.ts:38-67`, `packages/acp-agents/test/session-handoff.integration.test.ts:80-125`.
- Workflow-engine telemetry cloning and session recording: `packages/workflow-engine/src/strict-json.ts:140-172`, `packages/workflow-engine/src/workflow.ts:1173-1189`, `packages/workflow-engine/src/workflow.ts:1378-1382`.

### 13.4 Authoring, documentation, and live validation

- Authoring generator inputs/output: `scripts/generate-authoring-prompt.mjs:1-18`, `scripts/generate-authoring-prompt.mjs:30-46`, `scripts/generate-authoring-prompt.mjs:158-168`.
- Generated-prompt drift and routing sentinel tests: `packages/mcp-server/test/authoring-prompt.test.ts:7-17`, `packages/mcp-server/test/authoring-prompt.test.ts:93-113`.
- Authoring routing/config/model source: `skills/agentprism-workflow-authoring/reference.md:55-68`, `skills/agentprism-workflow-authoring/reference.md:598-618`, `skills/agentprism-workflow-authoring/models-and-output.md:1-20`.
- MCP served descriptions that enumerate backends: `packages/mcp-server/src/server.ts:1159-1168`.
- Served-description identity lock: `packages/mcp-server/test/workflow-tool.test.ts:107-114`.
- Live backend union, executable/scope tables, and test matrix: `packages/mcp-server/test/live-backend.e2e.test.ts:30-62`, `packages/mcp-server/test/live-backend.e2e.test.ts:336-422`.
- Current API prose for session refs/events and negotiated initialize metadata: `docs/api.md:1008`, `docs/api.md:1117-1119`, `docs/api.md:1134`, `docs/api.md:1170-1172`.

### 13.5 Fresh external ACP SDK pin

These upstream references are pinned to `agentclientprotocol/typescript-sdk` release `v1.2.1`, commit `26da1ae7ab66fae0f5e77272dee3e5d562d24aee`, verified from a fresh clone on 2026-07-19. Fetched `main` was `0daecae58483e362753004c985119865d7cc6edd`.

- Fluent client-to-agent request/notify overloads used by this repository: `src/acp.ts:303-425`.
- Legacy agent-to-client request/notify and deprecated delegates: `src/acp.ts:2797-2868`; legacy client-to-agent equivalents: `src/acp.ts:3567-3638`.
- Initialize-response metadata schema: `src/schema/types.gen.ts:1550-1582`.
- Bidirectional extension request/notification coverage: `src/acp.test.ts:4038-4167`.
- Release-to-main restricted diff: no changes to `src/acp.ts`, `src/schema/types.gen.ts`, or `src/schema/zod.gen.ts`; repo-wide changes were limited to `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, and `package-lock.json`.
