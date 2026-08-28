# MCP TypeScript SDK v2 migration — staged path

**Status:** Stage 0 released; split-SDK migration and dual-era serving implemented on `feat/mcp-dual-era` · **Updated:** 2026-08-28

**Provenance.** Owner directives: (2026-08-07) "I don't consider us to be spec conformant if
we're behind on the mcp sdk version. We need a path to upgrade to the latest one"; (2026-08-27)
update the MCP libraries first, preserving backward compatibility through the official migration
path, before auditing MCP Apps negotiation. Every factual claim below comes from a primary-source
research pass on 2026-08-07 (typescript-sdk repo at the 2.0.0 release commit, npm registry,
ext-apps repo, MCP Inspector source) or from
direct inspection of this repo at main `b40e260f`. Facts may drift — re-verify the §4 gates
before starting any stage.

## 1. Ground truth (2026-08-07)

- `@modelcontextprotocol/sdk` (v1 line): Stage 0 released **1.30.0**, which remains npm latest
  on that line (2026-07-27 — SSE keep-alive comment frames, keep-alive timer lifecycle fix,
  content-type validation, stdio buffer cap). v1 receives fixes ≥ 6 months post-v2.
- **SDK v2** = new scoped packages (`@modelcontextprotocol/server`, `/client`, `/core`,
  `/node`, `/express`, `/fastify`, `/hono`, `/server-legacy`, `/codemod`), all **2.0.0**
  (2026-07-27), implementing spec revision 2026-07-28 ("Stateless MCP"). Declared the stable
  line. Zero patch releases in the first 11 days; fixes accumulating on main (see §4).
- **Two independent moves, by design**: migrating packages to v2 does NOT change the wire —
  "Nothing in v2 puts a 2026-07-28 byte on the wire by default" (migration docs). The v1 and
  v2 legacy paths share the same supported-version list; **2025-11-25 is their default negotiated
  ceiling**, while v2's modern era requires explicit opt-in. Being on 1.x is currency-behind,
  not protocol-nonconformant.
- **Stateful parity retained**: v2 keeps the sessionful 2025-era model as a supported
  pattern — our exact architecture (one server + `StreamableHTTPServerTransport` per MCP
  session) survives as `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`
  with unchanged constructor options. Resource subscriptions, both `list_changed` families,
  push elicitation (`ctx.mcpReq.elicitInput`), and progress tokens all remain on 2025-era
  connections.
- **Migration tooling**: first-party 1,855-line agent-executable guide
  (ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2) + `@modelcontextprotocol/codemod`
  (import/symbol/handler/registration rewrites; self-reports non-automatable sites as inline
  `@mcp-codemod-error` markers). Best real-world datapoint: fastmcp ran it — 86 changes,
  3 markers, 442/448 tests green immediately (fastmcp#300).
- **Pre-flight requirements**: zod `^4.2.0` (zod-3 fails **quietly at runtime** on first
  `tools/list`), Node ≥ 20, ESM-first packaging. Real work for our bundling pipeline and
  bundle gates.
- **ext-apps is the hard blocker for the daemon**: `@modelcontextprotocol/ext-apps` latest
  1.7.5 peer-depends on sdk `^1.29.0`; no v2-compatible release exists; the migration is
  unresolved upstream (ext-apps#702, two competing draft PRs #719/#720). The Inspector pairs
  ext-apps with v2 only via casts and a Proxy shim it labels temporary. **Our exposure is
  confirmed direct**: `packages/mcp-server/src/app-ui.ts:69,81` and `src/server.ts:54` call
  `registerAppTool`/`registerAppResource` with our server instance. This is an official migration-
  guide constraint, not a repository authorization policy: v1 and v2 objects must not flow across
  the boundary; where a dependency compiles against the host's v1 SDK, the host files that construct
  or hand it SDK objects must remain on v1 and be excluded from the codemod until that dependency
  migrates. A type cast does not change that runtime/package boundary.
- **Our SDK footprint** (repo sweep at 4346f87): `packages/mcp-server` 13 files (core);
  `packages/pi-acp` 3 files; `packages/acp-agents` 1; `packages/workflows` 1. Heaviest
  coupling is `sdk/types.js` type imports (11 sites), then the `server/mcp.js` McpServer API
  (5). Protocol version strings appear in comments only; the shim sniffs `protocolVersion`
  dynamically. `repl-tool.ts` keys its client-presence lifecycle on MCP sessions (stays valid:
  sessions survive on the 2025 era).
- **Interop for staged migration**: a v2 `Client` speaks byte-identical 2025 `initialize` to
  a v1 server (and vice versa); v1/v2 packages coexist in one manifest. The one hard rule:
  objects never flow between v1-imported and v2-imported modules (nominal types, separate
  error classes). Our shim↔daemon boundary is the wire, so they migrate independently.

### Implementation outcome (2026-08-28)

The migration was executed from the official SDK documents rather than this roadmap:
`upgrade-to-v2` for the codemod/manual v1→v2 API work and `support-2026-07-28` for
protocol adoption. The resulting server:

- uses `@modelcontextprotocol/client`, `/server`, and `/node` 2.0.0 with no production
  import of the monolithic v1 SDK;
- preserves the daemon's stateful legacy session path and routes modern envelopes through
  `createMcpHandler(factory, { legacy: "reject" })` using `isLegacyRequest`;
- uses `serveStdio(factory)` for dual-era in-process stdio and keeps the default stdio shim a
  byte-preserving proxy to the dual-era daemon;
- implements modern checkpoints and script-backend approvals through `inputRequired` plus
  integrity-protected, daemon-family request state while retaining the legacy push behavior
  needed for its existing per-checkpoint timeout contract;
- publishes modern change events through `subscriptions/listen`; and
- removes the ext-apps server-object boundary with a local v2-native, request-aware Apps
  catalog while retaining ext-apps only in the bundled browser UI.

The modern and legacy paths are covered by real HTTP, built stdio, daemon-replacement,
request-state tamper/restart, Apps capability, and subscription end-to-end tests.

## 2. The staged plan

Each stage is independently shippable and reversible, delivered by the repo's established
convention (workflow-driven closed list, branch → PR → CI → merge → release). Stages must
not run while another workstream is editing the same files (§5).

### Stage 0 — currency + pre-flight (no v2 packages; implemented 2026-08-27)
- Bump `@modelcontextprotocol/sdk` 1.29.0 → exact 1.30.0 (drop-in minor; the SSE keep-alive
  frames directly benefit the elicitation-hold path). Read release notes first, classify,
  changeset — the ACP-maintenance runbook shape.
- Land/verify zod `^4.2.0` across the workspace; verify Node-version floors and ESM posture
  in the packages that will migrate. Fix what the verification finds, nothing speculative.
- Acceptance: full gates green; no behavior change beyond the SDK minor's own.
- Implementation: MCP SDK `1.30.0`, MCP Apps `1.7.5`, a workspace Zod floor of
  `^4.2.0`, and wrapped Claude Agent SDK `0.3.248`; package typechecks plus the MCP server,
  ACP runner, Pi ACP, and Codex ACP suites pass. Published from release PR #400 as
  `@automatalabs/mcp-server@0.33.2` and its coordinated dependency set.

### Post-Stage 0 — MCP Apps negotiation audit (completed 2026-08-27)

- **Legacy check confirmed:** ext-apps `1.7.5` and its stable 2026-01-26 Apps specification
  direct servers to call `getUiCapability(server.getClientCapabilities())`, then require
  `mimeTypes` to contain the exact `RESOURCE_MIME_TYPE` value
  (`text/html;profile=mcp-app`). That is the path used by this server.
- **The former SDK bug is closed:** TypeScript SDK versions before the fix stripped
  `capabilities.extensions` while parsing initialize (ext-apps#521). SDK `1.30.0` includes
  `extensions` in both client/server capability schemas. The in-memory integration test crosses
  the real SDK Client/Server initialize exchange and proves the value reaches the helper.
- **No `experimental` fallback:** ext-apps#231 explicitly retained `extensions`; an
  `experimental` lookalike is not affirmative Apps support. Missing, nonmatching, malformed, and
  experimental-only declarations all receive the identical text-only workflow surface.
- **Runtime shape is validated:** `getUiCapability` locates and casts the extension settings but
  does not parse them. The server additionally requires `mimeTypes` to be an actual array before
  exact membership testing, preventing a malformed string from enabling UI.
- **Do not conflate protocol eras:** this v1 server advertises its extension support in the legacy
  initialize response and activates the Apps surface only from the client's initialize capabilities.
  The modern 2026-07-28 protocol instead advertises server extensions through `server/discover` and
  supplies client capabilities per request in
  `_meta["io.modelcontextprotocol/clientCapabilities"]`. Modern discovery/per-request handling
  belongs to Stage C; no speculative dual-path inference is added here.
- **Graceful fallback retained:** the base `workflow` tool is registered before initialization.
  Only an affirmatively capable client receives its UI metadata, `workflow-events`, and the
  `ui://` resource; every other client receives the same input/output schemas and text/structured
  results without an Apps surface.

### Stage A — shim first (client-only surface; implemented 2026-08-28)
- Migrate `packages/mcp-server/src/shim/*` (SDK `Client` + `StreamableHTTPClientTransport`)
  to `@modelcontextprotocol/client`. Codemod, then manual sweep of its markers.
- Keep default (legacy) version negotiation — explicitly do NOT enable `'auto'` while the
  daemon is v1 (probe round-trip; the guide warns stdio tools off it).
- Client behavior re-baselining to check: no-cursor `list*()` auto-aggregation; empty-vs-throw
  on missing capability (`enforceStrictCapabilities` restores v1 semantics if needed).
- Acceptance: shim↔v1-daemon interop proven by the existing e2e suite; no wire change.

### Stage B — daemon SDK surface, architecture unchanged (implemented 2026-08-28)
- Codemod `packages/mcp-server` server side to `@modelcontextprotocol/server` + `/node`,
  keeping the per-session transport map exactly as-is. No `createMcpHandler`, no wire change.
- Known manual hotspots (from the guide + our code): method-string `setRequestHandler` for
  subscribe/unsubscribe; `extra.*` → `ctx.*` (`sendNotification`→`notify`, `sessionId`,
  `authInfo`); error taxonomy (`McpError`→`ProtocolError`, `SdkHttpError`, match on codes at
  dual-role boundaries); header reads via `.get()`; eager-capability re-baselining (declaring
  a capability now advertises `listChanged: true` and answers empty lists instead of -32601);
  unknown-tool calls reject instead of `isError`. `pi-acp` remains a separate package/process
  boundary and was not part of the MCP server migration.
- **Official boundary condition:** ext-apps#702 ships a v2-compatible release, or Stage B is
  redesigned so no SDK object crosses between v1 ext-apps code and v2 server code. The official
  migration guide says dependencies compiled against the host's v1 SDK keep their interfacing host
  files on v1 and outside the codemod until the dependency migrates. Inspector-style casts/proxies
  may demonstrate compatibility but do not satisfy that documented boundary rule.
- Acceptance: full gates + live e2e; Apps panel verified working end-to-end in an
  Apps-capable host; no wire change.

### Stage C — actually going modern (2026-07-28 beside 2025; implemented 2026-08-28)
- HTTP: `isLegacyRequest` routing in front of a `legacy:'reject'` `createMcpHandler`; the
  existing sessionful deployment keeps serving legacy clients (the documented dual-stack
  pattern). stdio: `serveStdio` dual-era arbitration (this also properly answers
  `server/discover`, closing the shim's -32601 stopgap).
- Modern requests return `inputRequired(...)` and resume through sealed request state. The
  legacy path deliberately retains its push elicitation adapter because the workflow DSL's
  per-checkpoint `timeoutMs` contract cannot be represented by the SDK legacy shim's one global
  round timeout; tool execution and durable checkpoint identity remain shared.
- Change delivery via `handler.notify.*`/`ServerEventBus`; modern-era state via sealed
  `requestState` where session state is today (scope per-surface when this stage is specced).
- The pre-implementation gates were discharged by executable proof rather than assumption:
  the stable 2.0.0 entries pass both-era e2e in this topology, and the Apps redesign removes
  all in-process v1/v2 SDK object crossing without consuming an unpublished ext-apps branch.

## 3. Historical staging non-goals

No v2 packages before Stage A. No `createMcpHandler`/`serveStdio`/`versionNegotiation:'auto'`
before Stage C. No direct flow of SDK objects between v1 ext-apps code and v2 server code; casts
are not treated as migration. No protocol-era changes to the ACP packages (different protocol;
out of scope throughout).

## 4. Pre-implementation gate ledger (historical audit context)

- ext-apps v2 compatibility: github.com/modelcontextprotocol/ext-apps/issues/702 remains open
  (#719/#720 both still open as of 2026-08-27; no v2-compatible npm release).
- v2 patch cadence: still 2.0.0-across-the-board as of 2026-08-27. Watch for the first
  patch carrying: validator memory leak fix (#2608, merged unreleased), progress/response
  race (#2580, fix PR #2586), `createMcpHandler` onclose chain leak (#2607, fix #2610),
  probe-fallback on unusable 2xx (#2619).
- Modern-path gaps relevant to us: extension notifications on listen streams (#2569),
  extension methods vs era registry (#2598), missing protocol-version header accepted
  (#2589).
- SEP-2577 logging deprecation window (≥12 months from 2026-07-28) — affects Stage C
  logging surface only.
- The Inspector's own v2 posture (still pinning 2.0.0-beta.5 at 2026-08-05) as a maturity
  signal.

## 5. Sequencing constraints (as of authoring)

- Stage 0 may run any time (maintenance-workflow shape; no file overlap with in-flight work).
- Stages A/B must wait for the daemon-succession workstream (`fix/daemon-succession`) and the
  R0 event-path workstream (`fix/daemon-event-path`) to merge — all three edit
  `packages/mcp-server` shim/daemon files.
- The shim's `server/discover` -32601 stopgap (separate small fix, pending) is superseded by
  Stage C's `serveStdio` but correct and wanted until then.
- Version-skew note: after any stage ships, the daemon-succession mechanism is what ensures
  live daemons actually pick the new code up.
