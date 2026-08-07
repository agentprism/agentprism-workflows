# MCP TypeScript SDK v2 migration — staged path

**Status:** planned — direction owner-approved, **no stage authorized or started** · **Updated:** 2026-08-07

**Provenance.** Owner directive (2026-08-07): "I don't consider us to be spec conformant if
we're behind on the mcp sdk version. We need a path to upgrade to the latest one." Every
factual claim below comes from a primary-source research pass on 2026-08-07 (typescript-sdk
repo at the 2.0.0 release commit, npm registry, ext-apps repo, MCP Inspector source) or from
direct inspection of this repo at main `4346f87`. Facts may drift — re-verify the §4 gates
before starting any stage.

## 1. Ground truth (2026-08-07)

- `@modelcontextprotocol/sdk` (v1 line): we pin **1.29.0**; npm latest of the line is
  **1.30.0** (2026-07-27 — SSE keep-alive comment frames, keep-alive timer lifecycle fix,
  content-type validation, stdio buffer cap). v1 receives fixes ≥ 6 months post-v2.
- **SDK v2** = new scoped packages (`@modelcontextprotocol/server`, `/client`, `/core`,
  `/node`, `/express`, `/fastify`, `/hono`, `/server-legacy`, `/codemod`), all **2.0.0**
  (2026-07-27), implementing spec revision 2026-07-28 ("Stateless MCP"). Declared the stable
  line. Zero patch releases in the first 11 days; fixes accumulating on main (see §4).
- **Two independent moves, by design**: migrating packages to v2 does NOT change the wire —
  "Nothing in v2 puts a 2026-07-28 byte on the wire by default" (migration docs). Published
  v1 and v2 ship the same supported-version list; **2025-11-25 is the negotiated ceiling on
  both lines today**. Being on 1.x is currency-behind, not protocol-nonconformant.
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
  `registerAppTool`/`registerAppResource` with our server instance — exactly the
  v1-object/v2-object boundary that does not cross (nominal types; removed `zod-compat`).
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

## 2. The staged plan

Each stage is independently shippable and reversible, delivered by the repo's established
convention (workflow-driven closed list, branch → PR → CI → merge → release). Stages must
not run while another workstream is editing the same files (§5).

### Stage 0 — currency + pre-flight (no v2 packages)
- Bump `@modelcontextprotocol/sdk` 1.29.0 → exact 1.30.0 (drop-in minor; the SSE keep-alive
  frames directly benefit the elicitation-hold path). Read release notes first, classify,
  changeset — the ACP-maintenance runbook shape.
- Land/verify zod `^4.2.0` across the workspace; verify Node-version floors and ESM posture
  in the packages that will migrate. Fix what the verification finds, nothing speculative.
- Acceptance: full gates green; no behavior change beyond the SDK minor's own.

### Stage A — shim first (client-only surface)
- Migrate `packages/mcp-server/src/shim/*` (SDK `Client` + `StreamableHTTPClientTransport`)
  to `@modelcontextprotocol/client`. Codemod, then manual sweep of its markers.
- Keep default (legacy) version negotiation — explicitly do NOT enable `'auto'` while the
  daemon is v1 (probe round-trip; the guide warns stdio tools off it).
- Client behavior re-baselining to check: no-cursor `list*()` auto-aggregation; empty-vs-throw
  on missing capability (`enforceStrictCapabilities` restores v1 semantics if needed).
- Acceptance: shim↔v1-daemon interop proven by the existing e2e suite; no wire change.

### Stage B — daemon SDK surface, architecture unchanged
- Codemod `packages/mcp-server` server side to `@modelcontextprotocol/server` + `/node`,
  keeping the per-session transport map exactly as-is. No `createMcpHandler`, no wire change.
- Known manual hotspots (from the guide + our code): method-string `setRequestHandler` for
  subscribe/unsubscribe; `extra.*` → `ctx.*` (`sendNotification`→`notify`, `sessionId`,
  `authInfo`); error taxonomy (`McpError`→`ProtocolError`, `SdkHttpError`, match on codes at
  dual-role boundaries); header reads via `.get()`; eager-capability re-baselining (declaring
  a capability now advertises `listChanged: true` and answers empty lists instead of -32601);
  unknown-tool calls reject instead of `isError`; `pi-acp`'s 3 SDK files.
- **GATE: ext-apps#702 shipped a v2-compatible release** — OR an explicit owner decision to
  adopt Inspector-style shims (cast boundary + `setNotificationHandler` Proxy) as a
  consciously temporary measure. Without one of these, Stage B does not start.
- Acceptance: full gates + live e2e; Apps panel verified working end-to-end in an
  Apps-capable host; no wire change.

### Stage C — actually going modern (2026-07-28 beside 2025)
- HTTP: `isLegacyRequest` routing in front of a `legacy:'reject'` `createMcpHandler`; the
  existing sessionful deployment keeps serving legacy clients (the documented dual-stack
  pattern). stdio: `serveStdio` dual-era arbitration (this also properly answers
  `server/discover`, closing the shim's -32601 stopgap).
- Rewrite elicitation handlers once to the `inputRequired(...)` style — the SDK's legacy
  shim keeps serving 2025 clients via real server→client requests.
- Change delivery via `handler.notify.*`/`ServerEventBus`; modern-era state via sealed
  `requestState` where session state is today (scope per-surface when this stage is specced).
- **GATES**: at least one v2 patch release published (the §4 fix list actually shipping);
  ext-apps has a modern-era answer for extension notifications (typescript-sdk#2569).
- This stage gets its own detailed spec before any build — this document deliberately does
  not spec it.

## 3. Explicit non-goals until their stage

No v2 packages before Stage A. No `createMcpHandler`/`serveStdio`/`versionNegotiation:'auto'`
before Stage C. No ext-apps shimming unless the Stage B gate is consciously taken. No
protocol-era changes to the ACP packages (different protocol; out of scope throughout).

## 4. Gate ledger — re-verify before each stage

- ext-apps v2 compatibility: github.com/modelcontextprotocol/ext-apps/issues/702 (drafts
  #719/#720 competing as of 2026-08-07; no ETA).
- v2 patch cadence: still 2.0.0-across-the-board as of 2026-08-07. Watch for the first
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
