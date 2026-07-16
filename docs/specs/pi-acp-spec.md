# `@automatalabs/pi-acp` — In-process ACP Server for the pi Coding Agent

**Date:** 2026-07-15

**Status:** Frozen implementation contract for issue #198. Freeze revision (supersedes rounds 1–3),
closing the terminal adjudication's four blockers, six majors, and five minors as a single coherent
revision: the MCP `tools/call` timeout now defaults to the MCP SDK's own
`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (cited, never invented); a **single turn-settlement state machine**
(§6.2.1) from which §6.5/§9.1.6/§9.6/T22 are derived; a redaction contract that reads pi's real
`AssistantMessageDiagnostic` fields and never forwards `error.message`/`.stack`; every error mapping named
to its producing mechanism (the `setModel` auth precheck) with a canonical `{ errorKind, message }` wire
shape; observable structured-tool collision (absence-detection); pinned opening-transaction races
(cancel/close/dispose); a categorical empty-live-fork error; mutation-safe cursor pagination; a total MCP
bridge over the pinned SDK (paginated `tools/list`, the five-member `CallToolResult` union, and a
timeout/detach/orphan-child protocol); `allow_always` that still runs the extension chain plus a
fail-safe deny for malformed selections; exact auth-method `name` strings with a narrowed
missing-credential claim; `agent_end`/`done`/`error` totality; and the three corrected SDK line numbers.
This revision builds on round 3, which had already closed the round-2 adversarial-completeness findings
(the pi-main forward-compat note, the real `CreateAgentSessionResult` DI type + shared `modelRegistry`
threading, runtime-vs-compile-time library exports, a permission sequence built on pi's actual
`tool_execution_start`→`beforeToolCall` order, the `session/cancel` vs `$/cancel_request` split with an
injected scheduler, transactional lifecycle with pi `AgentSession.dispose()`, corrected usage
monotonicity, and a normative package README).

**References (summary — full file:line + version pins in §14):**
our repo — `packages/acp-agents/src/capabilities.ts`,
`packages/acp-agents/src/acp-client.ts`,
`packages/acp-agents/src/protocol-coverage.ts`,
`packages/acp-agents/src/structured-output.ts`,
`packages/acp-agents/src/usage.ts`,
`packages/acp-agents/src/permissions.ts`,
`packages/acp-agents/src/errors-map.ts`,
`packages/acp-agents/src/backends/codex.ts`,
`packages/acp-agents/src/backends/custom.ts`,
`packages/acp-agents/src/registry.ts`,
`packages/acp-agents/src/runner.ts`,
`packages/shared-types/src/meta.ts`,
`scripts/check-acp-deps.mjs`,
`docs/specs/config-options.md`,
`docs/specs/model-resolution-determinism.md`,
`docs/specs/acp-auth-spec.md`,
`packages/acp-agents/package.json`,
`packages/mcp-server/package.json`;
external — `@agentclientprotocol/sdk@1.2.1`,
`@agentclientprotocol/claude-agent-acp@0.59.0` (packaging + bootstrap blueprint),
`@earendil-works/pi-coding-agent@0.80.7` (repo `earendil-works/pi` tag `v0.80.7`,
commit `818d67457cdd6b60bce6b121d16b23141c252dd8`), `@modelcontextprotocol/sdk@1.29.0`.

---

## 0. Implementation-time re-verification (normative, do this FIRST)

pi releases every ~2–3 days. Before writing any code, the implementer MUST re-run the external
freshness protocol and treat any drift as a stop-and-report discrepancy — never re-implement around a
moved pin silently:

1. Fresh temp clone of `https://github.com/earendil-works/pi`, then `git fetch --tags`.
2. `gh api repos/earendil-works/pi/releases/latest --jq .tag_name` **and**
   `npm view @earendil-works/pi-coding-agent version`; the two MUST agree.
3. Compare against the pin in §14 (`v0.80.7` / `818d674` / npm `0.80.7`). **If the pin is no longer the
   latest release, that is a STOP:** re-verify every pi citation in this contract (`sdk.ts`,
   `agent-session.ts`, `session-manager.ts`, `agent.ts`, `agent/types.ts`, `ai/types.ts`,
   `env-api-keys.ts`, `model-registry.ts`, `auth-storage.ts`, `extensions/types.ts`) against the new
   latest, update the exact manifest pins (§2.3) and every changed claim, re-pin §14, and re-open the
   contract for review before building. Do not install "whatever is latest on implementation day" under
   the frozen behavior claims of this document.
4. Re-run `npm view @agentclientprotocol/sdk version`. If it is no longer `1.2.1`, re-verify every SDK
   citation (§14) against the new dist and re-pin §2.3 before building.

The freshness gate (§10.1) enforces the same discipline continuously after landing.

### 0.1 pi-main forward-compatibility risk note (normative, from the focus.md step-4 comparison)

The implementation basis is the **released** pin `v0.80.7` (npm `@earendil-works/pi-coding-agent@0.80.7`)
— that is what this contract's every pi citation was verified against and what pi-acp depends on
(§2.3, §14). It is **not** pi's `origin/main`. At authoring, however, pi's unreleased `main`
(commit `c6d8371`) is already **~143 files / +5,974 / −4,577 lines** ahead of `v0.80.7` across the cited
packages (`git diff v0.80.7..origin/main --stat -- packages/{coding-agent,agent,ai}`), and the drift
touches surfaces this contract cites directly:

- `packages/coding-agent/src/core/sdk.ts` (~56 lines) — the `createAgentSession` factory (§4.1, §5.2).
- `packages/coding-agent/src/core/agent-session.ts` (~103 lines) — the event bus, `beforeToolCall`
  install, `setModel`/`setThinkingLevel`, usage getters (§6, §9.2).
- `packages/coding-agent/src/core/model-registry.ts` (~1,032 lines) and `auth-storage.ts` (~366 lines),
  plus a wholesale `packages/ai/src/utils/oauth/*` → `packages/ai/src/auth/oauth/*` reorganization — the
  model/auth runtime this contract touches through `ModelRegistry.create`/`AuthStorage.create` and the
  env-key catalog (§5.2, §9.5).

pi releases every ~2–3 days, so a release folding this rewrite is likely imminent. This note is a
**forward-compatibility risk flag, not a verification basis**: nothing here changes the frozen pin.
Its consequence is operational — when the implementer runs the §0 re-verification and pi has moved
past `v0.80.7` (which it almost certainly will have), the changed model/auth runtime and
`createAgentSession`/`agent-session` surfaces are the **first** places to re-check, and any changed
claim is a stop-and-report discrepancy per §0, never a silent re-implementation.

---

## 1. Problem and scope

`@agentclientprotocol/claude-agent-acp` makes the Claude Agent SDK drivable over ACP; our
`@automatalabs/codex-acp` fork does the same for Codex; `opencode-ai` ships an ACP server for
OpenCode. Each is a first-class backend our workflow runner (`@automatalabs/acp-agents`) drives
symmetrically. The **pi coding agent** (`@earendil-works/*`, MIT) has no first-class ACP server we
control: the one shipped community bridge (`svkozak/pi-acp`) shells out to `pi --mode rpc`, a JSONL RPC
that is neither JSON-RPC nor ACP, and structurally cannot serve per-tool permission prompts, a separate
thinking stream, ACP `mcpServers`, or native structured output.

This contract specifies **one new monorepo package, `packages/pi-acp`, publishing
`@automatalabs/pi-acp`**: an ACP server (stdio, JSON-RPC 2.0, protocolVersion `1`) that embeds pi
**in-process** through its published SDK (`@earendil-works/pi-coding-agent` →
`createAgentSession()`), plus side-effect-free library exports for reuse. Because the seam is
in-process, the server closes every gap the bridge leaves open, and it advertises **only** the surfaces
it actually implements, so our client's feature-detection rewards it truthfully.

**In scope:** the `packages/pi-acp` package — server binary, side-effect-free library entry, a
dependency-injection seam, capability advertisement, session lifecycle (with a full concurrency/error
matrix), prompt-content conversion, event translation with ordered delivery, prompt/stopReason/usage,
an exhaustive error taxonomy, permissions, the MCP bridge across all lifecycle methods, structured
output, auth, cancellation, the config surface, and the monorepo integration for that package
(workspace/changesets/CI/tsconfig). The one client-repo change is adding the pi runtime to the ACP
freshness gate (§10.1).

**Out of scope (see §11 Non-goals):** promoting pi to a built-in `PiBackend` in `acp-agents` (a
follow-up issue mirroring #197 — until it lands, the server is drivable through the existing
custom-backend registry with zero client code); fs/terminal client-delegation; subprocess/RPC mode;
`additionalDirectories`; audio prompt content; mid-turn steering over ACP; branch-topology replay.

### 1.1 Verified baseline and invariants

The implementation preserves these named invariants (each grounded in §14). They are referenced
elsewhere by number ("invariant N").

1. **stdout is ACP-only.** The bin redirects `console.log/info/warn/debug` to stderr **before it
   imports any pi/SDK module**, so nothing but ACP ndjson is ever written to fd 1 (§3). A pi/SDK log
   line on stdout would corrupt the JSON-RPC stream. (Blueprint: claude-agent-acp `dist/index.js:53-56`.)
2. **Advertise only what is implemented.** Every capability flag in the `initialize` response
   corresponds to a served method with real behavior. The server never advertises a lifecycle method it
   will throw on (the anti-pattern our client's `assertLifecycleSupported` catches,
   `acp-client.ts:1220-1235`).
3. **Errors reject; they never masquerade as `end_turn`.** A provider/model/auth failure rejects the
   `session/prompt` request with a `RequestError` carrying a categorical `data.errorKind`; auth walls
   use JSON-RPC code `-32000` exclusively (§7, §8). An empty successful turn is a real `end_turn`,
   never a swallowed error.
4. **One in-flight turn per session.** pi's `AgentSession.prompt()` throws when a turn is already
   streaming unless a `streamingBehavior` is supplied (`agent-session.ts:1121-1126`); ACP
   `session/prompt` is serialized per session by construction. The adapter does not expose mid-turn
   steering/queueing over ACP in v1 (§6.6).
5. **Ordered, drained delivery.** pi's `AgentSession` event bus is **synchronous** — `_emit` calls each
   listener and does not await it (`agent-session.ts:501-505`; listener type is `(e) => void`,
   `:156`). The adapter therefore funnels every translated update through one per-session FIFO send
   queue and **drains it before resolving** the originating request (§6.2), so notifications are never
   reordered and a response never overtakes its own updates.
6. **Truthful, correctly-scoped usage.** `PromptResponse.usage` carries the **per-turn** token
   breakdown mapped from pi's terminal `Usage`; the streamed `usage_update` carries **current context
   tokens** (`used`) and **cumulative session USD cost** (`cost.amount`) — the exact SDK semantics
   (§6.5). These are different quantities and are computed from different pi sources.
7. **Native structured output over the `_meta` channel.** The server advertises
   `agentCapabilities._meta["@automatalabs/pi-acp"] = { outputSchema: true }`, consumes per-turn
   `_meta.outputSchema` through pi's terminating-tool pattern, and emits the captured value as the final
   `agent_message_chunk` so `parseFinalJson(finalMessageText())` reads it (`structured-output.ts:47-64`).
   When driven through the generic `CustomAcpBackend`, the runner **also** embeds the schema in the
   prompt text (`embedSchemaInPrompt = true`, `custom.ts:33`); the adapter treats that embedded text as
   harmless reinforcement and still relies on the `_meta` tool for capture (§9.4). Arm/capture/disarm is
   a per-turn `try/finally` state machine (§9.4).
8. **License compliance.** pi is MIT; §15 pins the attribution obligation for depending on and
   embedding it.

---

## 2. Package identity, layout, and packaging

### 2.1 Identity

- **npm name:** `@automatalabs/pi-acp` (scoped; unscoped `pi-acp` is the community bridge). Initial
  version `0.0.0`, first release driven by changesets in lockstep with the monorepo (§10).
- **bin name:** `pi-acp` → `dist/index.js`. Spawn resolution for the follow-up built-in backend goes
  through the resolved package bin under `process.execPath` (the claude/codex ladder,
  `backends/codex.ts:53-66`), never PATH, so ours cannot collide with the community `pi-acp` bin.
- **License:** `Apache-2.0` (the monorepo license), with the MIT third-party notice of §15.
- **engines:** `"node": ">=22.19.0"` — pinned to pi's own floor (`packages/coding-agent/package.json`
  `engines.node >=22.19.0`), tighter than the monorepo's `>=22`. This resolves issue Open item 4. CI
  runs Node 24 (`ci.yml:36`), satisfying it. pi's `legacy-node20` dist-tag is **not** tracked; we track
  `latest`, which requires Node ≥22.19.

### 2.2 Layout

```
packages/pi-acp/
  package.json
  tsconfig.json                # extends root config; composite project reference
  README.md                    # NORMATIVE deliverable (§15) — bin/library use, backend registration, limits
  src/
    index.ts                   # BIN entry ONLY: console redirect + dynamic import + bootstrap + shutdown
    lib.ts                     # LIBRARY entry: side-effect-free re-exports (runAcp, PiAcpAgent, deps types)
    server.ts                  # runAcp(options): builds PiAcpAgent, wires the SDK, connects the stream
    agent.ts                   # PiAcpAgent: per-connection session registry + method handlers + dispose()
    deps.ts                    # PiAcpDeps interface + resolveDeps(): the DI seam (§4.1)
    session.ts                 # PiSession: one AgentSession + translator + send queue + permission wiring
    prompt-content.ts          # ACP ContentBlock[] -> { text, images } conversion (§6.1)
    translate.ts               # pi AgentSessionEvent -> ACP SessionUpdate (live table, §6.3)
    replay.ts                  # pi SessionEntry[] -> ACP SessionUpdate (load replay projection, §9.1)
    stop-reason.ts             # pi terminal AssistantMessage -> ACP StopReason / RequestError (§7,§8)
    errors.ts                  # error classification predicates + RequestError construction (§8)
    usage.ts                   # pi Usage/stats -> PromptResponse.usage + usage_update (§6.5)
    permissions.ts             # beforeToolCall wrapper -> session/request_permission (§9.2)
    mcp-bridge.ts              # ACP mcpServers (stdio) -> pi customTools, per lifecycle method (§9.3)
    structured-output.ts       # per-turn terminating tool for _meta.outputSchema (§9.4)
    auth.ts                    # authMethods from pi-ai env-key catalog + authenticate (§9.5)
    config.ts                  # thinkingLevel/model config-option state machine (§5)
  test/
    *.test.ts                  # §13 test plan (tsx --test)
```

**Bin vs library are distinct files** (blueprint: claude-agent-acp ships `dist/index.js` as `bin` and
`dist/lib.js` as `main`/`exports`, `package.json` bin→index / main→lib). `src/index.ts` is the ONLY
file with process-mutating bootstrap; `src/lib.ts` re-exports pure surfaces and mutates nothing on
import (invariant 1; resolves adversarial finding 2).

### 2.3 `package.json`

Mirrors the `main→lib / bin→index` split of `packages/mcp-server/package.json` and
`@agentclientprotocol/claude-agent-acp`:

```jsonc
{
  "name": "@automatalabs/pi-acp",
  "version": "0.0.0",
  "license": "Apache-2.0",
  "engines": { "node": ">=22.19.0" },
  "repository": { "type": "git", "url": "git+https://github.com/VikashLoomba/agentprism-workflows.git", "directory": "packages/pi-acp" },
  "type": "module",
  "bin": { "pi-acp": "./dist/index.js" },
  "main": "./dist/lib.js",
  "types": "./src/lib.ts",
  "exports": { ".": { "types": "./src/lib.ts", "import": "./dist/lib.js", "default": "./dist/lib.js" } },
  "files": ["dist"],
  "publishConfig": {
    "access": "public",
    "main": "./dist/lib.js",
    "types": "./dist/lib.d.ts",
    "bin": { "pi-acp": "./dist/index.js" },
    "exports": { ".": { "types": "./dist/lib.d.ts", "import": "./dist/lib.js", "default": "./dist/lib.js" } }
  },
  "scripts": { "build": "tsc -b", "typecheck": "tsc --noEmit", "test": "tsx --test \"test/**/*.test.ts\"", "prepublishOnly": "tsc -b" },
  "dependencies": {
    "@agentclientprotocol/sdk": "1.2.1",
    "@earendil-works/pi-coding-agent": "0.80.7",
    "@modelcontextprotocol/sdk": "1.29.0",
    "typebox": "1.3.2"
  }
}
```

Normative packaging rules (resolves adversarial finding 1 — **exact pins, no carets**):

- **All four runtime deps are exact pins**, matching the versions §14 verified behavior against. A caret
  is not exact and would let a freshness-driven bump silently substitute an API the frozen contract was
  never checked against. The pinned SDK is `1.2.1` (equal to what `acp-agents` resolves, not the
  bridge's 0.26); `@modelcontextprotocol/sdk` is pinned to the exact `1.29.0` current under
  `acp-agents`'s `^1.29` at the base commit (re-verify with `npm view @modelcontextprotocol/sdk version`
  and pin that exact value at implementation time). A later bump of ANY of these requires re-running §0
  and updating §14 — not editing only the manifest.
- `@earendil-works/pi-coding-agent` transitively pulls `@earendil-works/pi-agent-core` and
  `@earendil-works/pi-ai` in lockstep (`packages/coding-agent/package.json` deps), so pi-acp declares
  only the one direct pi dep. The freshness gate (§10.1) keeps it current.
- `typebox` matches the monorepo (`1.3.2`); it builds the structured-output tool schema wrapper. pi
  consumes tool `parameters` as raw JSON Schema and strips symbol keys per provider
  (`openai-completions.ts:1110`, `bedrock-converse-stream.ts:918`, `mistral-conversations.ts:491`), so
  the typebox major mismatch with pi's bundled `1.1.38` is inert.
- `tsconfig.json` is a composite project added to the root `tsconfig.json` `references` array (§10.3).
  No source is published — `files: ["dist"]`; `types` resolves to `dist/lib.d.ts` under `publishConfig`
  (the acp-agents convention).

---

## 3. Bin bootstrap and process lifecycle (`src/index.ts`)

`src/index.ts` is the executable entry and contains **no static import of pi, the ACP SDK, or any
adapter module** — only Node built-ins. This is the fix for the invariant-1 vs side-effect-free-library
conflict (adversarial finding 2): ESM evaluates a module's static imports before its body, so a static
import of pi from the bin would run pi's module-eval side effects **before** the console redirect. The
bin therefore redirects console first, then **dynamically** imports the server.

```ts
#!/usr/bin/env node
// No static pi/SDK/adapter imports here — see §3, invariant 1.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const { version } = await import("../package.json", { with: { type: "json" } }).then((m) => m.default);
  process.stdout.write(version + "\n");        // the only sanctioned fd-1 write; before the stream opens
  process.exit(0);
}
console.log = console.error; console.info = console.error;
console.warn = console.error; console.debug = console.error;   // invariant 1 — BEFORE the dynamic import
process.on("unhandledRejection", (reason) => { console.error("unhandledRejection:", reason); });

const { runAcp } = await import("./server.js");                // side effects (if any) now land on stderr
const { connection, agent } = runAcp();                        // real stdio stream (§4)
let shuttingDown: Promise<void> | undefined;
function shutdown(code: number): Promise<void> {
  shuttingDown ??= (async () => {                              // idempotent: one disposal, awaited
    try { await withTimeout(agent.dispose(), 5000); }         // bounded teardown (§3.2)
    catch (err) { console.error("shutdown error:", err); }
    finally { process.exit(code); }
  })();
  return shuttingDown;
}
connection.closed.then(() => shutdown(0), () => shutdown(1));  // rejected closed => exit 1
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.stdin.resume();                                        // keep the loop alive while the stream is open
```

### 3.1 Library entry (`src/lib.ts`) — resolves adversarial finding 3

```ts
export { runAcp, PiAcpAgent } from "./server.js";              // server.js re-exports PiAcpAgent (VALUE exports)
export { resolveDeps } from "./deps.js";                       // VALUE export (the DI-default builder, §4.1)
export type { PiAcpDeps } from "./deps.js";                    // TYPE-ONLY export (erased at runtime)
```

`lib.ts` performs **no** console mutation, opens **no** stdio, and starts **no** server on import.
`runAcp` only connects a stream when *called*.

**Runtime vs compile-time exports are distinct and tested distinctly.** `runAcp`, `PiAcpAgent`, and
`resolveDeps` are **value** exports: a runtime `await import("@automatalabs/pi-acp")` yields all three as
own enumerable bindings (T2 asserts `typeof runAcp === "function"`, etc., and that neither `console` nor
stdio was mutated — no server started). `PiAcpDeps` is an `export type` that TypeScript **erases** — it
is **not** present on the runtime module object and a test MUST NOT assert it there. Its export is
verified at **compile time**: a `.test-d.ts` file does `import type { PiAcpDeps } from
"@automatalabs/pi-acp"` and type-asserts the interface shape under `tsc --noEmit` (T2b). The round-2
claim that a runtime import "yields `PiAcpDeps`" was impossible and is corrected here.

### 3.2 Shutdown state machine (resolves adversarial finding 2)

- **Idempotent + awaited.** `shutdown` memoizes its work in `shuttingDown`; concurrent triggers
  (`connection.closed`, SIGINT, SIGTERM) all await the same single disposal. `agent.dispose()` sets the
  process-`disposed` flag, aborts every in-flight **opening transaction** and awaits its rollback (so none
  commits after shutdown, §9.1.0), then disposes **every** live `PiSession` (abort in-flight turns
  settlement-ordered, unsubscribe the translator, drain-and-drop the send queue, disconnect MCP clients —
  §9.6, §9.1.6) and resolves once all are disposed.
- **Bounded teardown.** Disposal is raced against a 5000 ms `withTimeout`; on timeout the process still
  exits (a hung MCP-client `close()` cannot wedge shutdown).
- **Exit codes:** `0` for a clean transport close / SIGINT / SIGTERM; `1` when `connection.closed`
  rejects (transport error) or `runAcp()` throws during startup. Disposal errors are logged to stderr but
  do not change the code (best-effort cleanup).

`runAcp` and `PiAcpAgent` are exported from `lib.ts` for library reuse (the
`ClaudeAcpAgent`/`runAcp` export convention, claude-agent-acp `dist/lib.js:2`).

---

## 4. Server construction (`src/server.ts`)

`runAcp(options?)` builds the agent with the SDK fluent builder and connects it over a stream. The
stream and the dependency object are **injectable** (§4.1) so tests drive the real handlers without a
child process:

```ts
import { agent as acpAgent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

export function runAcp(options?: { deps?: Partial<PiAcpDeps>; stream?: Stream }) {
  const impl = new PiAcpAgent(resolveDeps(options?.deps));
  const app = acpAgent({ name: "@automatalabs/pi-acp" })
    .onRequest(methods.agent.initialize,          (c) => impl.initialize(c))
    .onRequest(methods.agent.authenticate,        (c) => impl.authenticate(c))
    .onRequest(methods.agent.session.new,         (c) => impl.newSession(c))
    .onRequest(methods.agent.session.load,        (c) => impl.loadSession(c))
    .onRequest(methods.agent.session.resume,      (c) => impl.resumeSession(c))
    .onRequest(methods.agent.session.fork,        (c) => impl.forkSession(c))
    .onRequest(methods.agent.session.list,        (c) => impl.listSessions(c))
    .onRequest(methods.agent.session.close,       (c) => impl.closeSession(c))
    .onRequest(methods.agent.session.setConfigOption, (c) => impl.setConfigOption(c))
    .onRequest(methods.agent.session.prompt,      (c) => impl.prompt(c))
    .onNotification(methods.agent.session.cancel, (c) => impl.cancel(c));
  const stream = options?.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin)  as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  return { connection, agent: impl };
}
```

Method names come verbatim from the SDK `methods` registry (`acp.d.ts:17-79`). The server registers
**only** the handlers above; unregistered methods (`session/set_mode`, `providers/*`, `logout`, `nes/*`,
`document/*`, `session/delete`) are answered by the SDK as JSON-RPC method-not-found (`-32601`), the
truthful response for a method whose capability is not advertised (§5).

**The two cancellation sources are NOT the same and are handled by different code (resolves adversarial
finding 5).** Only `$/cancel_request` aborts the in-flight request's `context.signal`: the SDK's
`handleProtocolNotification` looks up the incoming request by `requestId` and calls
`controller.abort(...)` on that request's `AbortController` (`jsonrpc.js:640-652`,
`CANCEL_REQUEST_METHOD = "$/cancel_request"` at `:1`). `session/cancel` is an **ordinary ACP
notification** delivered to `impl.cancel(context)` via `.onNotification(methods.agent.session.cancel,
…)`; the SDK does **not** wire it to any request's `context.signal` (the SDK's own `examples/agent.js`
keeps a per-session `pendingPrompt` `AbortController` and aborts it in its `session/cancel` handler,
`:41-42,215-216`). §9.6 therefore composes both sources — plus close/dispose and notify-failure — into
one per-turn controller.

Each handler receives an `AgentRequestContext` exposing `context.params` (schema-parsed request),
`context.signal` (aborts on `$/cancel_request` for this request, or the connection signal for
notifications, `acp.d.ts:373-376`), `context.requestId`, and `context.client` (an `AgentContext` with
generic `notify(method, params)` and `request(method, params, options?)`, `acp.d.ts:142-197`; the
handler is registered as `(ctx) => impl.method(ctx)`). `context.client.request` accepts
`SendRequestOptions.cancellationSignal` — "Aborting this signal sends `$/cancel_request` for the
outgoing request. Cancellation is cooperative: the returned promise is still settled by the peer's
eventual response" (`jsonrpc.d.ts:64-72`) — the mechanism §9.2/§9.6 use to tear down a parked
permission request. All handler contexts wrap the same connection, so a `PiSession` captures its
`notify(update) = context.client.notify(methods.client.session.update, { sessionId, update })` at
`session/new` (or reattach) and reuses it for the session's lifetime.

### 4.1 Dependency-injection seam (`src/deps.ts`) — resolves adversarial finding 13

`PiAcpAgent` takes exactly one constructor argument, a fully-resolved `PiAcpDeps`. `resolveDeps(partial?)`
fills each field with its real default; tests pass overrides. This is the ONLY seam tests use — no ESM
monkey-patching (unreliable) is required.

```ts
export interface PiAcpDeps {
  /**
   * Build a pi session. Default: pi's real createAgentSession (sdk.ts:167), which returns
   * `Promise<CreateAgentSessionResult>` — NOT `Promise<AgentSession>` (resolves adversarial finding 2).
   * The adapter consumes `result.session` (the AgentSession) and `result.extensionsResult` (for the
   * post-construction tool-name reconciliation of §9.3.2). EVERY call site (new/load/resume/fork,
   * §9.1) passes `modelRegistry: deps.modelRegistry` so resolution, restore, stream auth, and setModel
   * all use the one injected registry.
   */
  createAgentSession(opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  /** SessionManager statics. Default: the real class methods (§9.1 citations). */
  sessions: {
    create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
    open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
    forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
    list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
    listAll(sessionDir?: string): Promise<SessionInfo[]>;
  };
  /**
   * Shared model registry, constructed ONCE per process. Default:
   * ModelRegistry.create(AuthStorage.create(authPath)) (model-registry.ts:391; auth-storage.ts:215).
   * `CreateAgentSessionOptions.modelRegistry` accepts it (sdk.ts:43), and pi's own restore/find/stream
   * paths read it (sdk.ts:197,302-303). Passing it on every factory call is what keeps injected
   * custom-provider resolution, journal-restored model lookup, `setModel`, and stream-time auth all
   * resolving against the SAME registry — the divergence adversarial finding 2 flags otherwise.
   */
  modelRegistry: ModelRegistry;
  /** Root for session JSONL. Default: undefined => pi's ~/.pi/agent/sessions/<encoded-cwd>. */
  sessionDir?: string;
  /** MCP stdio client factory. Default: a real @modelcontextprotocol/sdk stdio client (§9.3). */
  connectMcpClient(server: McpServerStdio, signal: AbortSignal): Promise<McpClientHandle>;
  /**
   * Cancellable timer for the wedged-agent grace window and MCP bounded liveness (§9.6, §9.3).
   * `sleep(ms, signal)` resolves after `ms` unless `signal` aborts first, in which case it rejects
   * with the signal reason. Injecting the scheduler is what makes the backstop and MCP timeouts
   * DETERMINISTIC in tests (a monotonic clock alone cannot control when a timer fires — the round-2
   * `now()` seam is removed). Default: a real `setTimeout`-based sleep with `clearTimeout` on abort.
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Grace window after abort before the §9.6 backstop force-resolves. Default: 5000. */
  graceMs: number;
  /**
   * Bounded liveness for each MCP `connect`, `tools/list` page, and `tools/call` (§9.3). A hung MCP
   * server must never wedge a lifecycle request, its rollback, or a turn. Default: **the MCP SDK's own
   * request-timeout constant, `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`**
   * (`@modelcontextprotocol/sdk@1.29.0` `dist/esm/shared/protocol.js:8`, applied at `:712` as
   * `options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`; cjs `:12`/`:716`) — **not an invented number**:
   * `tools/list`/`tools/call` are MCP requests whose SDK default IS 60000, so pi-acp adopts the SDK's own
   * value and passes it as the client request `options.timeout`; `connect` is not an MCP request, so the
   * same 60000 is applied by pi-acp as an equally-generous connect/close liveness deadline (the same
   * constant, argued as liveness, never a stricter invented bound). Injectable (like `graceMs`) so a host
   * running legitimately-slow MCP tools (build/test/scrape servers) can raise or remove the bound; it is a
   * liveness bound, not a data cap (a timed-out `tools/call` becomes a failed tool result the model sees,
   * §9.3.3; a timed-out connect/list rolls the lifecycle request back per §9.3.2).
   */
  mcpTimeoutMs: number;
}
```

The hermetic e2e substrate (§13.3): a test `createAgentSession` returns
`{ session: new AgentSession({ agent: new Agent({ streamFn: mockStream, … }), sessionManager, … }),
extensionsResult: { extensions: [], errors: [], runtime }, modelFallbackMessage: undefined }` — a real
`CreateAgentSessionResult` — the pi-agent-core injectable `streamFn` (`agent.ts:214`) wrapped in an
`AgentSession` (its constructor takes `agent`, `agent-session.ts:343`), driven with zero credentials.
`sleep`/`graceMs` make the §9.6 backstop deterministic (a test injects a `sleep` that resolves when it
chooses, forcing the wedged path); `mcpTimeoutMs` does the same for MCP hangs; `sessionDir` points at a
temp dir; `stream` (runAcp arg) is an in-memory paired ndjson stream.

---

## 5. Capability advertisement (`initialize`)

`initialize` returns `protocolVersion: 1` and this exact `agentCapabilities` block. Every flag maps to a
served method with real behavior (invariant 2); nothing advertised throws.

```jsonc
{
  "protocolVersion": 1,
  "agentInfo": { "name": "@automatalabs/pi-acp", "version": "<pkg version>" },
  "agentCapabilities": {
    "loadSession": true,                     // top-level flag drives session/load (SDK keeps it here, not sessionCapabilities.load)
    "promptCapabilities": { "image": true }, // pi accepts image content; audio/embeddedContext NOT advertised (§6.1, §11)
    "mcpCapabilities": {},                    // stdio only (baseline, implicit); http/sse/acp NOT advertised (§9.3)
    // additionalDirectories NOT advertised — pi has no allowed-roots concept (§9.1.7, §11)
    "sessionCapabilities": {
      "resume": {},                           // session/resume
      "fork":   {},                           // session/fork   (UNSTABLE in SDK; native via SessionManager.forkFrom)
      "list":   {},                           // session/list
      "close":  {}                            // session/close
    },
    "_meta": { "@automatalabs/pi-acp": { "outputSchema": true } }  // structured-output negotiation (§9.4)
  },
  "authMethods": [ /* §9.5 — advertised UNCONDITIONALLY */ ]
}
```

Advertisement rules (each grounded in our client's reader):

- **`loadSession: true`** (top level) — not `sessionCapabilities.load`. The SDK `SessionCapabilities`
  type has **no** `load` field; `session/load` is gated by the top-level `loadSession`. Our client reads
  `agent.loadSession === true || advertised(sessionCapabilities?.load)` (`capabilities.ts:104-105`), so
  the top-level flag drives `supportsLoadSession`.
- **`sessionCapabilities.resume/fork/list/close`** — each is `advertised(...)` in our client
  (`capabilities.ts:106-109`) and hard-gates the corresponding call (`acp-client.ts:1220-1235`).
  `resume` is the single highest-value advertisement (`supportsResumeSession`, `capabilities.ts:109`),
  feeding incremental resume and #183 pause-recovery. `fork` is `@experimental` in the SDK but fully
  typed; native via `SessionManager.forkFrom` (§9.1).
- **`session/delete` is NOT advertised** — pi's `SessionManager` exposes no delete/unlink/remove API
  (verified absent in `session-manager.ts` and the public `index.ts`; only TUI keybinding constants
  exist). Advertising it would force hand-unlinking session `.jsonl` files and risk fork-tree corruption
  (§11).
- **`mcpCapabilities: {}`** — advertising the (empty) object, not omitting it, is truthful: our client's
  `unsupportedMcpServer` treats stdio as always serviceable but **rejects http/sse once any
  `mcpCapabilities` block exists** (`capabilities.ts:278-300`). We serve stdio only (§9.3), so `{}`
  correctly makes the client reject http/sse up front instead of spending tokens then failing. `acp`
  transport is likewise not advertised.
- **`additionalDirectories` is NOT advertised** — the SDK exposes an agent capability for it
  (`AgentCapabilities.additionalDirectories`, `types.gen.d.ts:1624-1634`) and the field rides
  new/load/resume/fork (`:4633,4831,4923,4964`). pi has **no** allowed-roots / additional-directory
  concept anywhere in `packages/coding-agent`/`packages/agent` (verified: zero
  `additionalDirectories`/`allowedDirectories`/`workspaceRoot` occurrences). We therefore do not
  advertise it. Handling when a client sends it anyway is pinned in §9.1.7.
- **`promptCapabilities.image: true`, audio/embeddedContext omitted** — pi's message model carries
  images (`ImageContent{ type:"image", data, mimeType }`, `ai/types.ts:343`), so image blocks map to
  `PromptOptions.images` (§6.1). Audio has no pi representation and is degraded to a text note, not
  advertised; our client already degrades unsupported blocks to bracketed text
  (`capabilities.ts:241-271`).
- **`_meta["@automatalabs/pi-acp"] = { outputSchema: true }`** — the codex-acp custom-capability
  convention (`meta.ts:26-36`, `backends/codex.ts:34-37`). The namespace is our published package
  identity; the single flag `outputSchema` is named exactly like the bare `_meta` wire key it gates
  (`META_KEYS.outputSchema`, `meta.ts:7-13`), so a client tests `block.outputSchema === true` before
  sending `_meta.outputSchema`. **`baseInstructions`/`developerInstructions` are NOT advertised or
  accepted** (resolves issue Open item 3): pi's system-prompt override
  (`AgentSession._systemPromptOverride`) is internal with no stable embedder API; the structured-output
  instruction is delivered as prompt text (§9.4), not a system-prompt override.

### 5.1 Config surface — `thinkingLevel` only (`src/config.ts`)

The `session/new` (and load/resume/fork) response advertises **one** author-settable config option, a
`thinkingLevel` select. It conforms to the frozen `docs/specs/config-options.md` `configOptions`
contract: a select is enumerated, the validate-time probe surfaces "per harness, a table of option id,
type, current value, and the select choices" (`config-options.md:78-101` §2.3), and it checks an
authored select value against those advertised choices — so the choice set is load-bearing and must be
exactly pi's `ThinkingLevel` domain.

| `configId`      | type / choices | on set → adapter action |
|-----------------|----------------|-------------------------|
| `thinkingLevel` | `select`, choices `["off","minimal","low","medium","high","xhigh","max"]` (pi-agent-core `ThinkingLevel`, `types.ts:289`); `currentValue` = the session's active level | `AgentSession.setThinkingLevel(value)` (`agent-session.ts:1630`, which clamps to the model's available levels at `:1632`); echo the updated `configOptions` with `currentValue` = the **clamped** level (§5.2) |

`thinkingLevel` is a standard `configOptions` select consumed verbatim per `config-options.md` — the
mechanism that carries reasoning effort now that the bracket syntax was **removed**
(`config-options.md:14-15`; `model-resolution-determinism.md:56` lists `bracketTokens()`/
`applyModelModifiers()` as removed → "nothing"). This contract does **not** use or reference "effort
brackets" as a live surface.

**No `model` config option is advertised** (design-minimalism finding 2). The client sets the model
through the reserved channel **unconditionally** — `SessionHandle.selectModel` →
`applyConfigOption("model", spec)` → `session/set_config_option` (`acp-client.ts:1972-1974`) — and
`applyConfigOption` sends the request **without checking that the agent advertised a `model` option**
(`acp-client.ts:1986-1993`). So pi-acp only needs to *handle* `set_config_option("model", …)` (§5.2), and
advertising a necessarily-partial "representative" model list would mislead the validate probe (which
would surface it as the model menu). Our client also forbids `model` in authored `configOptions`
(`assertNoModelConfigOption`, `runner.ts:1319-1329`), so the reserved channel is the only model path,
consistent with not advertising it.

### 5.2 Config-option state machine (`src/config.ts`) — resolves adversarial finding 10

`setConfigOption(context)` is a total function over the wire request `SetSessionConfigOptionRequest`
(`types.gen.d.ts:5031`); it returns `SetSessionConfigOptionResponse = { configOptions }`
(`:2975`). Transitions are pinned:

| `configId` / `value` | behavior |
|---|---|
| `"thinkingLevel"`, a `string` in the choice set | `setThinkingLevel(value)`; success; echo `configOptions` with `currentValue` = clamped level |
| `"thinkingLevel"`, a `string` NOT in the choice set | reject `invalidParams` (`-32602`), `errorKind:"invalid_config_value"` |
| `"thinkingLevel"`, a `boolean` (wrong discriminator) | reject `invalidParams` (`-32602`), `errorKind:"invalid_config_type"` |
| `"model"`, a `string` `"<provider>/<id>"` | resolve (§ below) and `AgentSession.setModel(model)` (`agent-session.ts:1537`); success; echo the (unchanged) `configOptions` |
| `"model"`, unresolvable string | reject `invalidParams` (`-32602`), `errorKind:"invalid_model"` |
| `"model"`, a `boolean` | reject `invalidParams` (`-32602`), `errorKind:"invalid_config_type"` |
| any other `configId` | reject `invalidParams` (`-32602`), `errorKind:"unknown_config_option"` |
| any of the above while a turn is in flight (invariant 4) | reject `invalidParams` (`-32602`), `errorKind:"session_busy"` — never mutate model/level mid-stream |
| session id unknown / poisoned | reject `invalidParams` (`-32602`), `errorKind:"unknown_session"` / `"session_terminated"` (§9.1.6) |

Note the `model` echo returns the advertised `configOptions` array (the single `thinkingLevel` option)
with its `currentValue`; `setModel` re-clamps thinking level to the new model
(`agent-session.ts:1543-1549`), so the echoed `thinkingLevel.currentValue` reflects any clamp.

**Auth on the `set_config_option("model", …)` path — the producing mechanism is named (resolves the
setModel-auth gap).** `AgentSession.setModel` throws synchronously with the exact message
`` `No API key for ${model.provider}/${model.id}` `` when the model has no configured auth
(`agent-session.ts:1537-1540`, guarded by `this._modelRegistry.hasConfiguredAuth(model)`). That message
matches **none** of §8.2's `session.prompt()` pre-flight predicates (which look for `"no api key found"` /
`"authentication failed for"` / `"run '/login"`), so this call site owns its own auth classifier — the
handler does NOT rely on the prompt-path matcher. Concretely, after resolving the model (below), the
handler **prechecks `deps.modelRegistry.hasConfiguredAuth(model)` (`model-registry.ts:702`)**; if `false`
it rejects `authRequired` (`-32000`, `errorKind:"auth_error"`, row 1) **without** calling `setModel` —
the precheck IS the deterministic mechanism. It additionally wraps the `setModel` call in a `try/catch`
that maps a thrown `` /^no api key for /i `` message to the same row 1 (a belt-and-suspenders guard for a
races-with-auth-change window); any other `setModel` throw falls to the row-23 catch-all. This mapping is
scoped to the `set_config_option("model")` handler only, never `invalidParams` (T9 covers a known model
with missing auth).

**Model resolution** (`registry`-first, decisive, non-deprecated):

1. Construct the registry once per process via the DI seam: `deps.modelRegistry` (default
   `ModelRegistry.create(AuthStorage.create(authPath))`; `model-registry.ts:391`; `AuthStorage.create`
   at `auth-storage.ts:215`).
2. For a spec `"<provider>/<model-id>"` (first `/` splits provider from the rest verbatim),
   `registry.find(provider, modelId)` (`model-registry.ts:695-696`) — exactly what `createAgentSession`
   uses internally (`sdk.ts:197`); covers builtin + custom-configured providers.
3. Found → pass as `createAgentSession({ model, modelRegistry: deps.modelRegistry, … })` — always with
   the injected registry so restore/find/stream-auth agree (§4.1); auth resolves at stream time via
   `registry.getApiKeyAndHeaders(model)` (`sdk.ts:302-303`).
4. `undefined` → reject the originating request `invalidParams` (`-32602`, `errorKind:"invalid_model"`),
   naming the unknown `provider/id` (never a silent fallback).
5. No spec supplied before the first prompt → omit `model`; pi picks its configured default
   (`findInitialModel`, `sdk.ts:207-222`).

`getBuiltinModel` from `@earendil-works/pi-ai/providers/all` (`providers/all.ts:53`) is **not** the
primary path (strongly typed to the generated catalog; cannot accept arbitrary custom-provider strings).
The deprecated `getModel`/`getModels` aliases (`compat.ts:61-65`, `@deprecated`) are not used.

**Persistence/precedence across load/resume/fork.** pi persists `model_change` and
`thinking_level_change` entries in the JSONL. On reopen, `buildSessionContext()` restores
`SessionContext.model` and `.thinkingLevel` (`session-manager.ts:164-168`), so the reattach response's
`configOptions.thinkingLevel.currentValue` reflects the **journal-restored** level. A subsequent client
`set_config_option` overrides and persists a new entry. Precedence, pinned: journal-restored value is
the initial `currentValue`; a later client set wins and persists; pi's configured default applies only
when the journal carries neither entry.

---

## 6. Prompt turns: content conversion, ordered delivery, translation, stop reasons, usage

### 6.1 Prompt content conversion (`src/prompt-content.ts`) — resolves adversarial finding 3

ACP `PromptRequest.prompt` is an ordered `ContentBlock[]` (text | image | audio | resource_link |
resource; `types.gen.d.ts:236-246`). pi's `AgentSession.prompt(text: string, options?: PromptOptions)`
takes a single `text` string plus `options.images: ImageContent[]` (`agent-session.ts:1076,204-208`).
Conversion is a total, ordered fold `ContentBlock[] → { text: string; images: ImageContent[] }`:

| ACP block | projection |
|---|---|
| `text` | append `block.text` to the text buffer, joining successive appended segments with `"\n\n"` |
| `image` (`{ data: base64, mimeType }`) | push `{ type:"image", data: block.data, mimeType: block.mimeType }` onto `images` (pi `ImageContent`, `ai/types.ts:343`); append nothing to text |
| `resource_link` (`{ uri, name?, title? }`) | append a text line `[<title ?? name ?? uri>](<uri>)` (baseline content the client leaves untouched, `capabilities.ts:241-271`, so the server must project it) |
| `resource` (embedded) with text contents | append the embedded `text` |
| `resource` (embedded) with blob contents | append a text line `[embedded resource: <uri>]` |
| `audio` (not advertised) | append a text line `[unsupported audio content omitted]` — degrade, do not reject |

Ordering: text segments are concatenated in block order; images are collected in block order into
`options.images` (pi attaches images to the user message; strict text↔image interleaving is not a pi
capability and is not preserved — documented, not silently lost). **Empty input:** if the fold yields an
empty text buffer AND no images, reject `session/prompt` with `invalidParams` (`-32602`,
`errorKind:"empty_prompt"`). **Image-only input (empty text buffer, ≥ 1 image) is valid and passed
through:** pi's `AgentSession.prompt(text, options)` builds the user message unconditionally as
`userContent = [{ type:"text", text: expandedText }, ...options.images]`
(`agent-session.ts:1167-1169`), so `prompt("", { images })` lands a well-formed multimodal user message
(an empty text block plus the images) — pi does **not** reject an empty text string; the images carry the
content (T4 covers it). Structured-output instruction text (§9.4), when armed, is prepended to the text
buffer after this fold (which also makes the text buffer non-empty on a structured image-only turn).

### 6.2 Ordered delivery and the turn-settlement state machine (`src/session.ts`) — resolves adversarial finding 4 (ordering) and the settlement contradiction

pi's `AgentSession` bus is synchronous (invariant 5). Each `PiSession` owns:

- a translator listener (`(e: AgentSessionEvent) => void`, installed via `session.subscribe`,
  `agent-session.ts:762`) that maps `e` to zero or more `SessionUpdate`s (§6.3) and **synchronously
  enqueues** them onto a FIFO `pending: SessionUpdate[]`;
- one async **pump** that drains `pending` in order, `await`-ing `this.notify(update)` per item, so
  `session/update` notifications reach the wire in strict emission order;
- a `drain(): Promise<void>` the request handlers await at request boundaries.

**Request-boundary rule.** `session/prompt` (and `session/load` replay, §9.1) computes its result, then
`await this.drain()` **before** resolving, so a `PromptResponse`/`LoadSessionResponse` never overtakes a
queued update.

#### 6.2.1 Turn-settlement state machine (the single source of truth for §6.5/§9.1.6/§9.6/T15/T22)

Every settlement claim elsewhere in this contract is **derived from this one machine** — the sections
below do not each define their own outcome. A `session/prompt` turn owns a **one-shot** settlement: a
`settled` boolean and a `settle(result)` that resolves or rejects the ACP request **exactly once** (the
first caller wins; every later caller is a settlement no-op and may only run cleanup). `settle` is
therefore idempotent regardless of interleaving. Four **settlement inputs** feed it; the **first to fire
is the winner**:

| input | trigger | settlement action | usage_update + drain | post-settlement |
|---|---|---|---|---|
| **normal** | `session.prompt()` resolves and no abort source fired | compute stopReason (§7): terminal `stop`/`length`/`toolUse` → **resolve** `{ stopReason, usage }`; terminal `error` → **reject** classified (§8) | **yes**, before `settle` | turn kept live |
| **cancelled** | an abort source (§9.6 sources 1–3) fired `turnController.abort()`, then `session.prompt()` resolved with terminal `aborted` | **resolve** `{ stopReason:"cancelled", usage }` (§7) | **yes**, before `settle` | close/dispose cleanup runs *after* settle (§9.1.6) |
| **notify-failure** | the pump's `this.notify(update)` **rejects** mid-turn (transport closed/broken) | abort `turnController`, then **reject** `internalError` (`-32603`, `errorKind:"notification_error"`, row 22) | **no** — the transport is broken, so no update (incl. `usage_update`) can be delivered or ordered; the pump is stopped and `pending` is abandoned | the §9.6 backstop, if it later elapses, does **cleanup only** — it never re-settles |
| **wedged-backstop** | `deps.sleep(deps.graceMs)` elapses before `session.prompt()` settles (§9.6) | if still unsettled → **resolve** `{ stopReason:"cancelled", usage }` (best-effort snapshot, §6.5 forced-cancel row) | **best-effort**: emit `usage_update` + `drain` before `settle` *unless* the pump has already failed (then skip, as notify-failure) | detach the pi promise, dispose, tombstone (§9.6) |

**Invariants derived from the single winner:**

1. **`usage_update` + `drain` precede `settle` on every transport-healthy input** (normal, cancelled,
   wedged-backstop). Only **notify-failure skips them** — the wire is already broken, so there is nothing
   to deliver and nothing to order. This removes the old contradiction (a failed pump was asked to deliver
   a usage update).
2. **Exactly one settlement per turn.** A notify-failure that rejects row 22 is the winner; a later
   backstop cleans up but does **not** resolve `cancelled` (T22). A wedged-backstop that resolves
   `cancelled` is the winner; a late pi resolve/reject is swallowed by the detached promise (§9.6). The
   `settled` guard makes this deterministic for any ordering.
3. **Teardown waits for settlement.** Disposal (close/dispose, §9.1.6; or the backstop's own cleanup)
   **never drops the send queue until the turn has settled.** Because the §9.6 backstop force-settles
   within `deps.graceMs` of any abort, settlement is *guaranteed* to occur, so a `session/close` racing an
   in-flight turn (a) aborts `turnController`, (b) **awaits settlement** (bounded by the backstop), then
   (c) disposes and drops the queue. This is exactly why a close-racing prompt can still emit its
   `usage_update`, `drain`, and resolve `cancelled` *before* its queue is destroyed — the ordering the
   round-3 board found unspecified.
4. **Replay uses the same one-shot settle.** During `session/load` replay a notify rejection **rejects**
   `session/load` `notification_error` (row 22) through `settle` and rolls the opening transaction back
   (§9.1.0 stage-2 failure). A rejected notify **after** a turn already settled is logged to stderr only
   (the request is done). On `session/close`/dispose *after* settlement the pump is cancelled and
   `pending` dropped (invariant 3 order).

### 6.3 Live event translation table (pi `AgentSessionEvent` → ACP `SessionUpdate`)

pi's event model has three verified layers: session-level `AgentSessionEvent` (`agent-session.ts:127-155`),
which re-exposes loop-level `AgentEvent` (`agent/types.ts:415-430`), whose `message_update` carries the
pi-ai `AssistantMessageEvent` token-delta union (`ai/types.ts:464-476`).

| pi event (source) | ACP `sessionUpdate` | notes |
|---|---|---|
| `message_update` → `assistantMessageEvent` `text_delta` | `agent_message_chunk` | `content: { type:"text", text: delta }` |
| `message_update` → `assistantMessageEvent` `thinking_delta` | `agent_thought_chunk` | separate thinking stream — the bridge folds this into message chunks; we do not |
| `tool_execution_start` `{toolCallId,toolName,args}` | `tool_call` (**the SOLE `pending`**) | `{ toolCallId, title: toolName, kind: mapKind(toolName), status:"pending", rawInput: args, locations: fileLocations(args), _meta:{ toolName } }` (§6.4). This event is emitted by pi's loop **before** `beforeToolCall` runs (`agent-loop.ts:389/447/502` vs `:621`), so the translator — not the permission wrapper — owns the single pending `tool_call` for each `toolCallId` (§9.2) |
| `tool_execution_update` `{toolCallId,toolName,args,partialResult}` | `tool_call_update` | `{ toolCallId, status:"in_progress", content: toContent(partialResult) }` (§6.3.1) |
| `tool_execution_end` `{toolCallId,toolName,result,isError}` | `tool_call_update` (**the SOLE terminal**) | `{ toolCallId, status: isError?"failed":"completed", content: toContent(result), rawOutput: result.details }` (§6.3.1). pi's loop emits exactly one `tool_execution_end` per call on **every** path — normal, immediate-error, and permission block/abort (`agent-loop.ts` `emitToolExecutionEnd`) — so this is the sole terminal update; the permission wrapper adds none (§9.2) |
| terminal `Usage` (on the terminal `AssistantMessage`) + session stats | `usage_update` (once per turn) + accumulate into `PromptResponse.usage` | §6.5 |
| `compaction_start`/`compaction_end`, `queue_update`, `auto_retry_start`/`auto_retry_end`, `agent_settled`, `session_info_changed`, `thinking_level_changed`, `entry_appended`, `agent_start`, **`agent_end`**, `turn_start`/`turn_end`, `message_start`/`message_end` | **no fabricated `session/update`** | v1 emits none of these as content; `auto_retry_*` and `compaction_*` surface only through the terminal stopReason/usage. No invented updates. |

**Totality note (resolves the live-projection exhaustiveness gap).** The translator subscribes to
`AgentSessionEvent`, which is `Exclude<AgentEvent, { type:"agent_end" }>` plus a session-level
`agent_end` (`{ messages, willRetry }`) plus the session-level events above (`agent-session.ts:127-155`).
Every member is covered: the `message_update`/`tool_execution_*` rows and the terminal-`Usage` row above,
and the no-update row (now including **`agent_end`**) for the rest — so an exhaustive `switch` over the
union has no unhandled arm (T5). Inside `message_update.assistantMessageEvent` (`ai/types.ts:464-476`):
the `text_delta`/`thinking_delta` rows emit chunks; the `*_start`/`*_end` boundary markers sequence chunks
(via `contentIndex`) but emit **no** standalone update; and the stream terminators **`done`
(`{ reason: stop|length|toolUse }`) and `error` (`{ reason: aborted|error }`) emit no chunk** — the turn's
final outcome is read from the **terminal `AssistantMessage`** by §7 (stopReason) and §8 (error
classification), never from the streamed `done`/`error` event. So `done`/`error` are pinned no-chunk
terminal markers, and T5 asserts an exhaustive switch produces exactly the tabulated updates and nothing
for `agent_end`/`done`/`error`.

#### 6.3.1 Tool-result content projection (`toContent`, total) — resolves adversarial finding 10

pi's `tool_execution_update.partialResult` and `tool_execution_end.result` are both `AgentToolResult`
values shaped `{ content: (TextContent | ImageContent)[]; details?: unknown }` (grounded: pi's own
`createErrorToolResult` returns `{ content:[{type:"text",text}], details:{} }`, `agent-loop.ts`;
`ToolResultMessage.content` is `(TextContent | ImageContent)[]`, `ai/types.ts:403-418`). The projection
is total and identical for live and replay:

- `toContent(r)` maps `r.content` in order: `TextContent` → `{ type:"text", text }`; `ImageContent` →
  `{ type:"image", data, mimeType }`. `r.content` is always an array here (pi normalizes tool results,
  `createToolResultMessage` `content: result.content ?? []`); an empty array → an empty `content` array
  (a valid, terminal `tool_call_update` with no content blocks).
- `rawOutput` = `r.details` when `details` is a non-`undefined` value, else the field is **omitted**
  (never `null`, never the whole message). `details` is pi's structured tool payload — exactly what ACP
  `rawOutput` ("raw structured output") is for.
- **No `type:"diff"` projection.** pi's `AgentToolResult` exposes no standardized old-text/new-text pair
  (only `content` + arbitrary `details`), so a diff content block would be fabricated. `read`/`edit`/
  `write` results are projected uniformly through `toContent` (pi renders a human-readable summary into
  `content`); the round-2 "emit `type:"diff"` when the result exposes it" clause is **removed** as
  ungrounded (recorded in §12).

### 6.4 Tool-call metadata mapping (`mapKind`)

`ToolKind` is the SDK enum `"read"|"edit"|"delete"|"move"|"search"|"execute"|"think"|"fetch"|
"switch_mode"|"other"` (`types.gen.d.ts:196`). Map pi's built-in tool names decisively: `read`→`read`,
`edit`→`edit`, `write`→`edit`, `bash`→`execute`, `grep`→`search`, `find`→`search`, `ls`→`read`;
everything else (custom/MCP tools) → `other`. `locations` (`ToolCallLocation`, `types.gen.d.ts:568`) are
populated from tool args that name a file path (`read`/`edit`/`write` `path`, etc.). `_meta.toolName` is
stamped with pi's exact tool name so the client's permission matcher identifies it precisely (§9.2).

### 6.5 Usage (`src/usage.ts`) — corrected semantics, resolves adversarial finding 8

Two **distinct** quantities, from two pi sources:

**(a) Per-turn breakdown → `PromptResponse.usage`.** pi's `Usage` (`ai/types.ts:357-379`) on the
turn's assistant messages maps onto the ACP `Usage` field names our client's `UsageAccumulator` consumes
(`usage.ts:7-17,50-72`; `types.gen.d.ts:3037`), summed across the assistant messages of the turn:

| ACP `PromptResponse.usage` field | pi source |
|---|---|
| `inputTokens` | Σ `usage.input` |
| `outputTokens` | Σ `usage.output` |
| `cachedReadTokens` | Σ `usage.cacheRead` |
| `cachedWriteTokens` | Σ `usage.cacheWrite` |
| `totalTokens` | Σ `usage.totalTokens` |
| `thoughtTokens` | Σ `usage.reasoning` (omit when every message left it undefined) |

**(b) Context + cumulative cost → streamed `usage_update`.** The SDK defines `UsageUpdate.used` as
"Tokens currently in context" and `Cost.amount` as "Total cumulative cost for session"
(`types.gen.d.ts:3928-3985`). These are NOT the per-message totals. Compute them from pi's own
aggregators:

- `used` = `session.getContextUsage()?.tokens ?? 0` — current context tokens
  (`agent-session.ts:3078`; `ContextUsage.tokens`, `extensions/types.ts:283-288`);
- `size` = `session.getContextUsage()?.contextWindow ?? model.contextWindow ?? 0`;
- `cost` = `{ amount: session.getSessionStats().cost, currency: "USD" }` — cumulative session cost,
  summed across ALL assistant entries incl. compacted history (`getSessionStats`,
  `agent-session.ts:3023-3060`; the method's own doc: "totals reflect what was actually billed across
  the session").

**Monotonicity — corrected (resolves adversarial finding 11).** `cost.amount` is
`getSessionStats().cost`, a sum of `usage.cost.total` over **all** persisted assistant entries, so it is
**monotonically non-decreasing** across messages, turns, and after load/resume. `used` is
`getContextUsage().tokens`, the tokens **currently in the context window**, and is **NOT monotonic**: a
compaction that summarizes history **reduces** `used` on the next `usage_update`. The contract makes no
monotonicity claim about `used`; only cumulative `cost.amount` is monotonic. Our client reads
`cost.amount` into `AgentUsage.cost` (`usage.ts:11-17,28-59`) and treats `PromptResponse.usage` as
authoritative for the per-turn token breakdown.

**Per-outcome usage behavior (pinned, one row per settlement input of §6.2.1 / exit of §7/§8/§9.6):**

| turn outcome (§6.2.1 input) | `usage_update` | `PromptResponse.usage` |
|---|---|---|
| normal completion (`end_turn`/`max_tokens`) | emit once, from the post-settle `getContextUsage()`/`getSessionStats()` snapshot, then `drain()` | per-turn breakdown Σ over the turn's assistant messages |
| normal cancel (turn settled `aborted` via §9.6 sources 1–3) | emit once from the post-settle snapshot, then `drain()` | per-turn breakdown over whatever assistant messages accumulated before the abort (may be all-zero) |
| provider error (terminal `stopReason "error"`, §8 reject) | emit once from the post-settle snapshot **before** rejecting (so cumulative cost includes the billed failed attempts), then `drain()` | n/a — the request rejects (no `usage`) |
| pre-flight throw (synchronous, nothing streamed) | **none** — no assistant message and no new billed tokens exist | n/a — the request rejects |
| **notify-failure** (row 22, §6.2.1 input 3) | **none** — the transport is broken, so no update (incl. `usage_update`) can be delivered or ordered; the pump is stopped | n/a — the request rejects `notification_error` |
| forced cancel (wedged backstop, §9.6 — turn never settled) | emit once from the **current** `getContextUsage()`/`getSessionStats()` snapshot (best-effort; may equal the pre-turn values), then `drain()` — **unless** the pump already failed (then skip, as notify-failure) | per-turn breakdown over any assistant messages captured so far (commonly all-zero) |

`usage_update` is always emitted **before** `drain()` and before the request resolves/rejects on every
transport-healthy input, so the client observes usage in order; the sole exception is the notify-failure
input, whose broken transport can deliver nothing (§6.2.1 invariant 1). A compaction-drop case is tested (T6): two turns where the second's
`used` is **lower** than the first's while `cost.amount` still rises.

### 6.6 Turn lifecycle and concurrency

One ACP `session/prompt` drives one pi turn: convert content (§6.1), arm structured output if requested
(§9.4), then `await session.prompt(text, { images })` (`agent-session.ts:1076`), which awaits
`agent.prompt()` plus pi's auto-retry/compaction loop and settles by emitting `agent_settled` in a
`finally` (`agent-session.ts:1023-1034`). After it resolves: compute stopReason (§7) and usage (§6.5),
emit `usage_update`, `await drain()` (§6.2), then resolve `{ stopReason, usage }` — this is the **normal**
settlement input of the §6.2.1 one-shot `settle` (the other inputs — cancelled, notify-failure,
wedged-backstop — are §9.6/§6.2.1).

Concurrency (resolves issue Open item 2, invariant 4): pi permits **one in-flight turn per session** —
`AgentSession.prompt()` throws when already streaming unless a `streamingBehavior` is supplied
(`agent-session.ts:1121-1126`). ACP clients serialize `session/prompt` per session, so this never fires
in normal use; if a second `session/prompt` arrives for a busy session, the adapter rejects it with
`invalidParams` (`-32602`, `errorKind:"session_busy"`) **without** calling `session.prompt` (it never
supplies `streamingBehavior`, so pi's steer/followUp queue is never engaged). pi's mid-turn
steering/follow-up (`steer`/`followUp`, `agent-session.ts:1294,1314`) is **not** exposed over ACP in v1
(§11).

---

## 7. Stop-reason taxonomy

The ACP `StopReason` enum is exactly `"end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|"cancelled"`
(`types.gen.d.ts:3027`) — there is **no** `error` member, which is why errors must reject (§8). pi's
terminal signal is the last `AssistantMessage` of the turn, carrying `stopReason` and optional
`errorMessage`, where pi's `StopReason = "stop"|"length"|"toolUse"|"error"|"aborted"`
(`ai/types.ts:380,388-401`); the streaming union terminates with
`{ type:"done", reason:"stop"|"length"|"toolUse" }` or `{ type:"error", reason:"aborted"|"error" }`
(`ai/types.ts:464-476`). This resolves issue Open item 1.

After `session.prompt()` resolves, read the terminal assistant message (`agent.state.messages` last
`role:"assistant"`, mirroring pi's `_findLastAssistantMessage`) and map:

| pi terminal signal | ACP result |
|---|---|
| `stopReason "stop"` | resolve `{ stopReason:"end_turn", usage }` |
| `stopReason "length"` | resolve `{ stopReason:"max_tokens", usage }` |
| `stopReason "toolUse"` as the terminal message (loop settled on a tool turn) | resolve `{ stopReason:"end_turn", usage }` (loop drained; normal completion) |
| `stopReason "aborted"` **or** the adapter observed `agent.abort()` for this turn | resolve `{ stopReason:"cancelled", usage }` |
| `stopReason "error"` (retries exhausted; `errorMessage` set) | **reject** per §8 (classified) |
| `session.prompt()` threw synchronously (pre-flight, `agent-session.ts:1140-1154`) | **reject** per §8 (classified) |

`refusal` and `max_turn_requests` have no pi equivalent in v1 and are never emitted. pi does **not**
throw on a mid-turn provider error; it records a terminal assistant message with `stopReason "error"`
after exhausting auto-retries (`agent-session.ts:1023-1027,1044,2577`), so the adapter inspects that
terminal message and rejects — it does not merely propagate a thrown error. (Pre-flight auth/model
failures *are* thrown from `prompt()` and are caught, §8.)

---

## 8. Error taxonomy and pinned wire codes (`src/errors.ts`)

Every hard failure **rejects** with a `RequestError` (SDK static constructors, `jsonrpc.js:783-827`).
JSON-RPC codes are pinned; `data.errorKind` is the categorical convention claude-agent-acp emits
(`errorKindData(errorKind) => { errorKind }`, `dist/acp-agent.js:4113`). No raw provider text is echoed
(redaction rule below).

### 8.1 Complete failure table

This is the **canonical, complete** table: every hard failure introduced by any normative section
appears here exactly once, and every `errorKind` string is exactly one of these.

**Canonical wire shape of an adapter-owned error (resolves the error-shape gap; T8 asserts it exactly).**
Every adapter-owned row is constructed with the SDK static factory `RequestError.<ctor>(data,
additionalMessage?)`, whose signature is `RequestError(code, message, data)` (`jsonrpc.js:764-827`,
verified). The resulting wire object is exactly:

```jsonc
{ "code": <pinned code>,
  "message": "<SDK reserved-code prefix>",          // e.g. "Internal error" / "Authentication required" / "Invalid params" — SDK-generated, NEVER raw provider/exception text
  "data": { "errorKind": "<the row's kind>",         // the categorical MACHINE label (claude-agent-acp `errorKindData`, dist/acp-agent.js:4113)
            "message": "<fixed category label>",      // a constant HUMAN label from the lookup below — NEVER raw provider/exception text
            /* + row extras only where the table's data cell lists them: */
            "server": "<name>",                       // rows 16/17 only
            "details": [ /* §8.2 redacted projection */ ] } }  // rows 4/23 only, optional
```

The fixed label lives in **`data.message`** (the field our client folds via `errorDataText`,
`errors-map.ts:63-71`, which reads string `data.message`/`data.details` — exactly the codex-acp
`usageLimitExceeded` convention the mapper cites), **and** the machine label in **`data.errorKind`**; the
JSON-RPC top-level `error.message` stays the SDK's reserved-code prefix. There is **no** free-standing
`data.details` string and **no** raw text anywhere. `data.message` fixed-label lookup (one constant per
`errorKind`, never interpolated with provider text):

| `errorKind` | `data.message` (fixed) |
|---|---|
| `auth_error` | `"provider credentials required"` |
| `rate_limit` | `"provider rate limit"` |
| `billing_error` | `"provider billing or quota wall"` |
| `provider_error` | `"provider error"` |
| `invalid_model` | `"unknown or unselectable model"` |
| `empty_prompt` | `"prompt has no text or images"` |
| `session_busy` | `"session has a turn in flight"` |
| `invalid_config_value` / `invalid_config_type` / `unknown_config_option` | `"invalid config option"` |
| `invalid_cwd` | `"invalid working directory"` |
| `unknown_session` | `"unknown session id"` |
| `session_already_open` | `"session already open"` |
| `session_terminated` | `"session terminated"` |
| `session_corrupt` | `"session file could not be read"` |
| `session_not_forkable` | `"session has no persisted history to fork"` |
| `mcp_init_error` | `"mcp server initialization failed"` |
| `unsupported_mcp_transport` | `"unsupported mcp transport"` |
| `structured_tool_collision` | `"structured-output tool unavailable"` |
| `invalid_output_schema` | `"invalid output schema"` |
| `invalid_cursor` | `"invalid list cursor"` |
| `unknown_auth_method` | `"unknown auth method"` |
| `notification_error` | `"notification delivery failed"` |
| `internal_error` | `"internal error"` |

`data.details` is only ever the §8.2 **redacted diagnostics projection** (rows 4/23), never raw
`diagnostics`, `errorMessage`, or an exception (redaction rule, §8.2). The table's `data` column below
lists the `errorKind` and any row extras; the uniform `{ errorKind, message, … }` shape above applies to
every adapter-owned row.

| # | condition | constructor | code | `data` |
|---|---|---|---|---|
| 1 | auth required / missing-or-invalid provider credential (pre-flight throw OR classified terminal error) | `authRequired` | **`-32000`** (auth-exclusive) | `{ errorKind:"auth_error" }` |
| 2 | provider rate/quota wall (classified) | `internalError` | `-32603` | `{ errorKind:"rate_limit" }` |
| 3 | provider billing/quota-exhausted wall (classified) | `internalError` | `-32603` | `{ errorKind:"billing_error" }` |
| 4 | other terminal `stopReason "error"` | `internalError` | `-32603` | `{ errorKind:"provider_error", details?: redactedDiagnostics }` (§8.2 projection; omitted when no diagnostics) |
| 5 | unknown model spec (§5.2) | `invalidParams` | `-32602` | `{ errorKind:"invalid_model" }` |
| 6 | no model selected before first prompt and pi has no default | `invalidParams` | `-32602` | `{ errorKind:"invalid_model" }` |
| 7 | empty prompt — the §6.1 fold yields no text **and** no images (schema-valid but semantically empty) | `invalidParams` | `-32602` | `{ errorKind:"empty_prompt" }` |
| 8 | **structurally-malformed prompt content** (bad `ContentBlock` discriminant, missing required image `data`/`mimeType`, etc.) | **SDK pre-handler** — `invalidParams` from `zPromptRequest` | `-32602` | SDK Zod-format `data` (**no** `errorKind`; see note) |
| 9 | second concurrent prompt on a busy session (invariant 4), **or** `fork` of a busy source (§9.1.4) | `invalidParams` | `-32602` | `{ errorKind:"session_busy" }` |
| 10 | set_config_option: unknown id / bad value / wrong type / busy (§5.2) | `invalidParams` | `-32602` | `{ errorKind: as in §5.2 }` |
| 11 | invalid cwd (not absolute / does not exist / not a directory) — on new/fork(target)/load/resume/list whenever `cwd` is present | `invalidParams` | `-32602` | `{ errorKind:"invalid_cwd" }` |
| 12 | unknown session id — load / resume / prompt / set_config / fork **source** (§9.1.4). **Not `close`** (row 24) | `invalidParams` | `-32602` | `{ errorKind:"unknown_session" }` |
| 13 | duplicate open — `load`/`resume` for an id already live **or reserved-opening** (§9.1.6) | `invalidParams` | `-32602` | `{ errorKind:"session_already_open" }` |
| 14 | poisoned/tombstoned session reopen or use (§9.1.6) | `invalidParams` | `-32602` | `{ errorKind:"session_terminated" }` |
| 15 | malformed/corrupt session JSONL on open (`SessionManager.open`/`forkFrom` throw) | `internalError` | `-32603` | `{ errorKind:"session_corrupt" }` |
| 16 | MCP connect / `tools/list` failure **or timeout** (`deps.mcpTimeoutMs`) on a lifecycle method, or a duplicate MCP server name (§9.3) | `internalError` | `-32603` | `{ errorKind:"mcp_init_error", server: <name> }` |
| 17 | non-stdio (`http`/`sse`/`acp`) MCP server sent to a lifecycle method (§9.3.4) | `invalidParams` | `-32602` | `{ errorKind:"unsupported_mcp_transport", server: <name> }` |
| 18 | reserved `__acp_structured_output` **absent** from `getAllTools()` after construction (removed by a filter or a pi change), so the structured-output channel cannot function (§9.4.1/§9.3.2) | `internalError` | `-32603` | `{ errorKind:"structured_tool_collision" }` |
| 19 | invalid `_meta.outputSchema` (non-object / not a schema) | `invalidParams` | `-32602` | `{ errorKind:"invalid_output_schema" }` |
| 20 | invalid `session/list` cursor (undecodable / not a canonical non-negative integer, §9.1.5). A well-formed offset past the end is **not** an error (empty page) | `invalidParams` | `-32602` | `{ errorKind:"invalid_cursor" }` |
| 21 | `authenticate` with an unknown `methodId` (§9.5) | `invalidParams` | `-32602` | `{ errorKind:"unknown_auth_method" }` |
| 22 | notification delivery failure mid-turn/replay (§6.2) | `internalError` | `-32603` | `{ errorKind:"notification_error" }` |
| 23 | **catch-all** — any other unexpected error from `SessionManager`, `createAgentSession`, replay, config, MCP result conversion, or `dispose` not classified above | `internalError` | `-32603` | `{ errorKind:"internal_error", details?: redactedDiagnostics }` (fixed label; **no** raw text; §8.2 projection when a terminal message with diagnostics is in hand) |
| 24 | unknown/unsupported method | SDK default | `-32601` | — |
| 25 | **lifecycle-open request cancelled** — `$/cancel_request` for an in-flight `session/new`/`load`/`resume`/`fork` **before commit** (§9.1.0) | SDK default (`abortErrorToRequestCancelled`, `jsonrpc.js:124-129`) | `-32800` | — (SDK-produced when the handler's abort-throw propagates under the aborted `context.signal`; the transaction rolls back, §9.1.0) |
| 26 | `fork` **source** is a live session with no persisted history yet (never produced an assistant message, so no JSONL on disk — §9.1.4) | `invalidParams` | `-32602` | `{ errorKind:"session_not_forkable" }` |

**Row 8 (structural prompt malformation) is the SDK's, not the handler's.** The agent builder registers
`prompt` with the Zod parser `zPromptRequest` (`acp.js:599`), so a `PromptRequest` whose `ContentBlock`s
are structurally invalid is rejected by the SDK with `invalidParams` (`-32602`) carrying the SDK's
Zod-format `data` **before** `impl.prompt` runs — the handler cannot attach an `errorKind` and MUST NOT
try. The adapter's own content checks are therefore only the **semantic** ones the schema permits: the
`empty_prompt` fold (row 7) and `invalid_output_schema` (row 19). The round-2 `invalid_content`
errorKind was **unreachable** (nothing schema-valid remained for it to catch) and is **removed**;
schema-valid image `data` is passed to pi as-is (pi does not pre-decode base64 either), so no residual
handler check exists. T8 asserts the SDK pre-handler shape for a malformed block.

**`close` is never an error (resolves the row-12 contradiction).** `session/close` for an unknown,
already-closed, or tombstoned id returns **success** (idempotent, §9.1.6) — it is deliberately absent
from rows 12/14. Only load/resume/prompt/set_config/fork-source reach `unknown_session`.

**Permission transport failure is not a reject.** If the `session/request_permission` `client.request`
rejects (transport broken/closed), the permission wrapper treats it as a **fail-safe deny** for that one
tool and **returns `{ block:true }`** to pi; the turn continues and settles normally (§9.2.1 step 4). It
does **not** reject `session/prompt` and has **no** `errorKind` — the round-2 "row 19 … if the abort also
fails" clause referenced an abort that path never performs and is removed. (A genuinely broken transport
surfaces instead as row 22 when a subsequent `notify` fails, or as the turn settling and resolving
normally.)

Reserved-code facts (verified in the installed SDK `jsonrpc.js`): `-32700` parseError, `-32600`
invalidRequest, `-32601` methodNotFound, `-32602` invalidParams, `-32603` internalError, `-32800`
requestCancelled, **`-32000` authRequired (exclusive)**, `-32002` resourceNotFound. `-32002` is used by
no row above — pi surfaces "not found" for sessions as `invalidParams`/`unknown_session` (rows 12/14),
because our client's generic mapper routes ONLY `-32000` to pause-for-auth and treats every other
reserved code as non-auth (`OTHER_RESERVED`, `errors-map.ts:23`; `isAcpAuthRequired` code-only,
`:135-146`), so `unknown_session` on `-32602` cannot mis-route.

### 8.2 Classification predicates (ordered, deterministic) — resolves adversarial finding 9

Two entry points feed classification:

- **Pre-flight throw** from `session.prompt()` (synchronous, before streaming, `agent-session.ts:1140-1154`).
  Match the thrown `Error.message` (pi's own static factories, no secrets) case-insensitively, in order:
  1. contains `"no model selected"` (`formatNoModelSelectedMessage`, `auth-guidance.ts:18`) → row 6
     (`invalid_model`, `-32602`).
  2. contains `"no api key found"` (`formatNoApiKeyFoundMessage`, `:22`) **or** `"authentication failed for"`
     **or** `"run '/login"` → row 1 (`auth_error`, `-32000`).
  3. otherwise → row 4 (`provider_error`, `-32603`).
- **Terminal `stopReason "error"`** (retries exhausted). Build a lowercase haystack from
  `message.errorMessage` **plus**, for each `d` in `message.diagnostics ?? []`, its `d.type` and
  `d.error?.name` and `d.error?.message` (the **actual** fields of pi's `AssistantMessageDiagnostic =
  { type, timestamp, error?, details? }`, where `DiagnosticErrorInfo = { name?, message, stack?, code? }`
  — `packages/ai/src/utils/diagnostics.ts:1-13`; `AssistantMessage.diagnostics?:
  AssistantMessageDiagnostic[]` at `ai/types.ts:396`). **There is no `text` field** — the round-3 spec's
  `diagnostics[*].text` did not exist and is corrected here. The haystack is read for classification
  **only** and never echoed on the wire (redaction rule below reads a strictly narrower projection).
  Match in this precedence:
  1. auth: `/\b401\b|\b403\b|unauthorized|invalid api key|authentication|forbidden|expired/` → row 1
     (`auth_error`, `-32000`).
  2. billing/quota-exhausted: `/quota|billing|insufficient|payment|credit|exceeded your/` → row 3
     (`billing_error`).
  3. rate: `/\b429\b|rate limit|too many requests|overloaded/` → row 2 (`rate_limit`).
  4. otherwise → row 4 (`provider_error`).

The precedence is fixed (auth > billing > rate > generic) so two implementations classify the same text
identically. This uses the same `internalError`+`errorKind` shape claude-agent-acp emits
(`dist/acp-agent.js:2044,2080`).

**Redaction rule (applies to every row, including the row-23 catch-all).** The classification haystack is
**never** echoed on the wire. `data.message` is the fixed category label from the §8.1 lookup (a constant
per `errorKind`), never the raw `errorMessage` and never a caught exception's `.message`/`.stack`.
`data.details`, when present (rows 4/23 only), is the **safe redacted projection**
`redactedDiagnostics(message.diagnostics) = message.diagnostics?.map(d => ({ type: d.type, timestamp:
d.timestamp }))` — **only** the diagnostic `type` and `timestamp` per entry. The entire `error`
sub-object (`name`/`message`/`stack`/`code`) **and** pi's arbitrary `details` record are **dropped and
never reach the wire**, because `extractDiagnosticError` copies the caught error's **raw `message` and
`stack`** into `error` (`diagnostics.ts:21-30`, verified) — forwarding that object would ship request
echoes, file paths, and key fragments. When `message.diagnostics` is empty/undefined, `data.details` is
**omitted**. The row-23 catch-all wraps ANY unclassified throw (`SessionManager`, `createAgentSession`,
replay, config, MCP conversion, `dispose`) as `internalError` + `{ errorKind:"internal_error", message:
"internal error" }`, attaching `details` only when a terminal message with diagnostics is in hand, and
logs the raw error to stderr only. Our generic mapper folds string `data.message`/string `data.details`
into the classifiable error text (`errors-map.ts:33-71`); the `data.details` **array** projected here is
object-typed, so the mapper's string-only fold ignores it (never mis-classifying it) while a richer client
can still read the safe `{ type, timestamp }` list. **Sentinel test (T8):** a terminal error whose
diagnostic `error.message` and `error.stack` both contain a sentinel secret asserts the secret appears in
**none** of `error.message`, `data.message`, or `data.details`.

**The `set_config_option("model")` auth path** classifies at its own call site (§5.2): a
`deps.modelRegistry.hasConfiguredAuth(model) === false` precheck → row 1 (`auth_error`, `-32000`), and a
defensive `/^no api key for /i` catch on the `setModel` throw → the same row 1. That path does **not** use
the `session.prompt()` pre-flight predicates above (the `setModel` message `No API key for
<provider>/<id>` matches none of them).

**Downstream client behavior.** `-32000` → `AUTH_REQUIRED` pause by code alone
(`errors-map.ts:135-146`; `ACP_AUTH_REQUIRED_CODE_EXCLUSIVE`, `protocol-coverage.ts:152-154`). Until the
follow-up `PiBackend` adds a `classifyProviderError` (`backends/codex.ts:39-51`) that promotes
`rate_limit`/`billing_error` to `PROVIDER_USAGE_LIMIT` pauses, the generic client classifies rows 2/3/4
as recoverable execution errors — correct default behavior.

---

## 9. Feature surfaces

### 9.1 Sessions (`src/session.ts`, `src/replay.ts`) — resolves adversarial findings 4, 5, 6

The adapter holds three per-connection structures plus one terminal flag: a `Map<sessionId, PiSession>`
(**live**), a `Map<sessionId, AbortController>` (**opening** — one entry per in-flight opening
transaction, its value the transaction's own `openController` whose `openSignal` gates acquisition and
commit, §9.1.0), a `Set<sessionId>` (**tombstones**, §9.1.6), and a process-`disposed` boolean set by
`PiAcpAgent.dispose()` (§9.1.0 / §3.2). Each `PiSession` owns one `AgentSession`, its translator
subscription, its send queue (§6.2), its permission wrapper (§9.2), its bridged MCP clients (§9.3), and
(when armed) its structured-output tool (§9.4). `sessionId` is pi's `SessionManager.getSessionId()`.

#### 9.1.0 Transactional acquisition, atomic reservation, and open-time races (resolves adversarial findings 7, 8; the opening-race gaps)

Every session-opening method (new/load/resume/fork) runs one all-or-nothing transaction that is **tracked
by an `openController`, not merely by an id**, so cancellation, close, and dispose have a pinned effect at
every awaited stage. Because Node runs the handler body to its first `await` without interleaving, the
**reservation is atomic**:

1. **Reserve synchronously, before any `await`.** If `disposed` (§3.2) → reject `internalError`
   (`errorKind:"internal_error"`) — the connection is shutting down. For load/resume the id is
   `request.sessionId`; for new/fork the id is not known until pi mints it, so those reserve on the minted
   id at the first sync point after minting. Check `live.has(id) || opening.has(id)` → if set, reject
   `session_already_open` (row 13); check `tombstones.has(id)` → reject `session_terminated` (row 14).
   Otherwise construct `openController = new AbortController()`, set `opening.set(id, openController)`, and
   subscribe it to the request signal: `context.signal.addEventListener("abort", () =>
   openController.abort(context.signal.reason))`. `openSignal = openController.signal` is threaded into
   every awaited step below. This closes the round-2 check-then-await-then-register race in which two
   concurrent `load`s for the same id could both pass a live-map check and both register (leaking one).
2. **Acquire in order, tracking each resource, honoring `openSignal`:** validate cwd (row 11) → obtain the
   `SessionManager` (create/open/forkFrom) → connect MCP (§9.3, all-or-nothing, each connect/list bounded
   by `deps.mcpTimeoutMs` **and** cancellable by `openSignal`) →
   `deps.createAgentSession({ …, modelRegistry: deps.modelRegistry })` → install the permission wrapper
   + translator + (inactive) structured-output tool → (load only) replay + `drain()`. If `openSignal`
   aborts at or between any step, the in-flight step is cancelled and the transaction proceeds to
   rollback (step 4). `forkFrom`'s eager write is the one step that cannot be un-done (§9.1.4); an
   `openSignal` abort strictly after it still rolls back the *live* state, leaving only a complete valid
   JSONL nobody registered.
3. **Commit (gated).** Re-check the gate **synchronously**, in the same microtask as the registry
   mutation, with no intervening `await`: if `openSignal.aborted || disposed || tombstones.has(id)` →
   **do not commit**; run rollback (step 4) instead. Otherwise `live.set(id, session)`,
   `opening.delete(id)`, and return the response. Because the gate check and `live.set` are synchronous,
   no close/dispose/cancel can interleave between them — a session can never be resurrected after a
   close/dispose that landed during opening.
4. **Rollback on ANY failure OR gate-abort at any stage** (reverse order, best-effort, each step guarded
   and bounded): call pi's **`AgentSession.dispose()`** (`agent-session.ts:799` — aborts pi's
   retry/compaction/bash hooks + `agent.abort()`, invalidates extensions, cleans pi resources;
   abort/unsubscribe alone would leak them), unsubscribe the translator, cancel + drop the send queue,
   disconnect every MCP client already connected (each bounded by `deps.mcpTimeoutMs` so a hung `close()`
   cannot wedge rollback), and `opening.delete(id)`. **No live registry entry, MCP child, listener, pi
   resource, or structured tool remains.** A replay-`notify` failure (§6.2.1) is a stage-2 failure: it
   rolls back fully, so the id is NOT left live and a retry is a clean `session/load`, never a spurious
   `session_already_open`. Disposal/disconnect errors during rollback are logged to stderr and never mask
   the original rejection.

**Open-time race outcomes (pinned).**

- **`$/cancel_request` during open** (any awaited stage — MCP connect/list, replay drain, or after
  `forkFrom` writes): the SDK aborts `context.signal`, which aborts `openSignal`; the transaction rolls
  back (step 4) and its in-flight step's abort-throw propagates. Because `context.signal.aborted` holds,
  the SDK's `abortErrorToRequestCancelled` (`jsonrpc.js:124-129`) converts that throw into a **`-32800`
  `requestCancelled`** wire result (error-table **row 25**) — no live/opening/MCP resource leaks. A cancel
  that arrives strictly after the synchronous commit (step 3) races an already-returned response: the
  session is live and the client may `session/close` it (idempotent).
- **`session/close` during open** (id in `opening`): close reads `opening.get(id)`, calls
  `openController.abort(<close reason>)`, and returns **success** (idempotent) **without** waiting; the
  opening transaction fails its step-3 gate (`openSignal.aborted`) and rolls back — the session is never
  committed live, so there is no post-close resurrection (§9.1.6 matrix).
- **`PiAcpAgent.dispose()` during open:** dispose sets `disposed = true`, aborts every `openController` in
  `opening` (and every live turn), then **awaits all opening transactions to settle** (each rolls back via
  the step-3 gate) **before** sweeping `live` (§3.2). No transaction can commit after `disposed` is set —
  the step-3 gate re-checks `disposed` synchronously with the `live.set`.

**The one irreversible step is `forkFrom` (§9.1.4).** It writes the new JSONL eagerly
(`session-manager.ts:1490`, `writeFileSync` + `appendFileSync`, flag `wx`). MCP is connected **before**
`forkFrom`, so an MCP failure rolls back with nothing written. If the only post-write step
(`createAgentSession`) then fails, the forked JSONL is a **complete, valid, loadable** session (pi copied
the full source history) — it is never registered live and is not corrupt; we cannot and do not
hand-delete it (no pi delete API, §11). This satisfies "no half-initialized **live** session" (invariant
2) without hand-editing journals.

#### 9.1.1 `session/new`

`validateCwd(request.cwd)` (row 11) → `deps.sessions.create(cwd, deps.sessionDir)`
(`session-manager.ts:1441`; constructs in memory, writes no JSONL until the first append) → reserve the
minted `getSessionId()` (§9.1.0 step 1) → connect the request's stdio MCP servers (§9.3; row 16/17 on
failure, with rollback) → `deps.createAgentSession({ cwd, model?, thinkingLevel?, customTools,
sessionManager, modelRegistry: deps.modelRegistry })` (§5.2) → install the permission wrapper (§9.2), the
translator (§6.3), and the structured-output tool inactive (§9.4) → commit. Return
`{ sessionId, configOptions: [thinkingLevelOption], modes: null }` (`NewSessionResponse`,
`types.gen.d.ts:2556`).

#### 9.1.2 `session/load` (reopen + replay)

`validateCwd(request.cwd)` when present (row 11) → reserve `request.sessionId` atomically (§9.1.0 step 1;
`session_already_open`/`session_terminated` guards). Resolve the session file for `sessionId` via
`deps.sessions.list(request.cwd, deps.sessionDir)` (`session-manager.ts:1549`, → `SessionInfo{ id, path,
… }`, `:170-184`); if absent → row 12. `deps.sessions.open(path)` (`:1452`; row 15 on corrupt JSONL);
connect request MCP servers (§9.3, rolled back on failure); `deps.createAgentSession({ sessionManager,
modelRegistry: deps.modelRegistry })` restores the model context internally via `buildSessionContext()`
(`sdk.ts:188-204`). Then **replay the transcript to the client**: iterate
`SessionManager.getBranch()` (`session-manager.ts:1189` — the full active linear branch of
`SessionEntry`, NOT the compaction-summarized `buildSessionContext()`), projecting each entry through
`src/replay.ts` into `session/update` notifications, enqueued on the send queue, and `await drain()`
before returning. Response mirrors `session/new`: `{ configOptions, modes: null }` with restored
`currentValue` (§5.2).

**Replay projection (`src/replay.ts`) — total over the pinned `SessionEntry` union and the
`AgentMessage` sub-union (resolves adversarial finding 10).** `getBranch()` returns
`SessionEntry[]` (`session-manager.ts:140-152`). A `SessionMessageEntry.message` is the **extensible
`AgentMessage`** union (`agent/src/types.ts:314` = `Message | CustomAgentMessages[keyof …]`), whose role
is one of `user | assistant | toolResult | bashExecution | custom | branchSummary | compactionSummary`
(`ai/types.ts:382-419`; `agent/src/harness/messages.ts:19-60`). The table below is **exhaustive** over
both unions — every entry type and every message role has a pinned projection or an explicit no-update
rule, so two implementations produce the identical transcript. `UserMessage.content`,
`CustomMessage.content`, and `CustomMessageEntry.content` are each `string | (TextContent |
ImageContent)[]`; the `contentItems(c)` helper normalizes: a `string` → one text item; an array → its
items in order (text → `{type:"text"}`, image → `{type:"image", data, mimeType}`). `toContent`/`rawOutput`
are exactly §6.3.1.

| `SessionEntry` / message role | projection |
|---|---|
| `message`, role `user` (`UserMessage`) | one `user_message_chunk` per `contentItems(message.content)` |
| `message`, role `assistant` (`AssistantMessage`) | for each content item in order: `TextContent`→`agent_message_chunk`; `ThinkingContent`→`agent_thought_chunk`; `ToolCall`→`tool_call` `{ toolCallId:id, title:name, kind:mapKind(name), status:"pending", rawInput:arguments, _meta:{toolName:name} }` |
| `message`, role `toolResult` (`ToolResultMessage`) | `tool_call_update` `{ toolCallId, status: isError?"failed":"completed", content: toContent(message), rawOutput: message.details }` |
| `message`, role `bashExecution` (`BashExecutionMessage`) | one `agent_message_chunk` with text `bashExecutionToText(message)` (pi's own rendering, `messages.ts:63-80`) — agent-side shell activity shown as an assistant chunk |
| `message`, role `custom` (`CustomMessage`), `display:true` | one `agent_message_chunk` per `contentItems(message.content)` (agent-displayed custom text) |
| `message`, role `custom` (`CustomMessage`), `display:false` | **no update** (hidden from the transcript, as in pi's TUI) |
| `message`, role `branchSummary` (`BranchSummaryMessage`) | **no update** (branch topology not replayed, §11) |
| `message`, role `compactionSummary` (`CompactionSummaryMessage`) | **no update** (compaction summary is model-facing, §11) |
| `custom_message` entry, `display:true` (`CustomMessageEntry`) | one `user_message_chunk` per `contentItems(content)` (it is injected into LLM context as a user message, `session-manager.ts:127-138`) |
| `custom_message` entry, `display:false` | **no update** (hidden) |
| `thinking_level_change`, `model_change`, `compaction`, `branch_summary`, `custom` (entry), `label`, `session_info` | **no update** (internal bookkeeping; model/level land in `configOptions.currentValue`) |

Message IDs: tool calls/updates use pi's `ToolCall.id`/`ToolResultMessage.toolCallId` (stable); message
chunks carry content only and need no id. Ordering is `getBranch()` array order (append order along the
active path). Compaction policy: replay shows the **full active branch** (what a human reviews), not the
compaction-aware context pi feeds the model — a decisive v1 choice recorded in §11.

#### 9.1.3 `session/resume` (reopen without replay)

Identical to load — `validateCwd` (row 11), atomic reservation (§9.1.0), open + MCP wiring, and
`createAgentSession({ …, modelRegistry: deps.modelRegistry })` — but with **no** replay: restore into
`agent.state` and return immediately with the restored `configOptions`. Highest-value advertisement for
our client (§5).

#### 9.1.4 `session/fork`

`ForkSessionRequest.cwd` is the **target** cwd (required by the SDK, `types.gen.d.ts:4915`) — it does
**not** identify the source file — so the source must be resolved by id. **Source lookup order
(pinned):**

1. If `request.sessionId` is a **live** `PiSession`, use its `SessionManager` file path
   (`getSessionFile()`, `session-manager.ts:942`). **Empty-live-source guard (resolves the lazy-persist
   fork gap):** pi persists lazily — `_persist` does not create the JSONL until the session's first
   **assistant** message exists (`session-manager.ts:946-977`, verified), so a live but never-prompted
   session has a path whose file does not yet exist on disk, and `forkFrom` would call
   `loadEntriesFromFile` and throw `Cannot fork: source session file is empty or invalid`
   (`session-manager.ts:1498-1500`) — a healthy state that must NOT be mislabeled `session_corrupt`.
   Therefore, for a live source, if `existsSync(getSessionFile())` is `false` (no persisted history yet),
   reject `invalidParams` (`errorKind:"session_not_forkable"`, **row 26**), naming that the source has no
   persisted history to fork. (A non-live source resolved in step 2 always has an on-disk file by
   construction, so this guard is live-source-only.)
2. Otherwise `deps.sessions.listAll(deps.sessionDir)` (`session-manager.ts:1564`, all project dirs —
   this is what makes **cross-cwd** forks work: the source may live under a different cwd than the
   target) and select the `SessionInfo` whose `id === request.sessionId`. If **multiple** match
   (duplicate ids across dirs), pick the most-recently-`modified` (the list is already sorted `modified`
   desc, `:1556`) — deterministic. If **none** → row 12 (`unknown_session`).

Then: if the source is a live **busy** session (in-flight turn) → reject `session_busy` (do not fork
mid-turn). `validateCwd(request.cwd)` (target, row 11). Connect the request's MCP servers **first**
(all-or-nothing, §9.3) so an MCP failure rolls back before anything is written. Then
`deps.sessions.forkFrom(sourcePath, request.cwd, deps.sessionDir)` (`session-manager.ts:1490` — the
irreversible JSONL write; §9.1.0 covers a post-write `createAgentSession` failure). Reserve the minted
new `getSessionId()`, `deps.createAgentSession({ sessionManager: forked, modelRegistry:
deps.modelRegistry })`, install wrapper/translator/structured tool, commit a **new** `PiSession` under
the new `sessionId`, and return it with fresh `configOptions`.

#### 9.1.5 `session/list`

`validateCwd(request.cwd)` when present (row 11). `request.cwd` present →
`deps.sessions.list(cwd, deps.sessionDir)` (`session-manager.ts:1549`); **absent** →
`deps.sessions.listAll(deps.sessionDir)` (`:1564`, all project dirs) — this is the optional-cwd policy
(SDK `ListSessionsRequest.cwd` is optional, `types.gen.d.ts:4856`). Map each `SessionInfo` to the ACP
list entry (`sessionId: id`, `cwd`, title from `name ?? firstMessage`). pi returns the full list sorted
by `modified` desc; there is no native pagination.

**Cursor encoding and pagination semantics (pinned, exact).** The adapter paginates in memory over the
freshly-read, `modified`-desc-sorted list with a fixed page size of **100**.

- **Encoding:** the opaque `cursor` (`ListSessionsRequest.cursor`, `:4860`) is
  `base64url(utf8(decimalString(offset)))` — the canonical base64url (no padding) of the ASCII decimal
  of the 0-based offset (e.g. offset `100` → `"MTAw"`). `nextCursor` (`ListSessionsResponse.nextCursor`,
  `:2816`) is the encoding of `offset + 100` when `offset + 100 < length`, and is **omitted** otherwise
  (SDK permits omission → "no more pages").
- **Decoding & validation (mutation-safe — resolves the cursor-vs-tolerance contradiction).** A
  missing/`null`/empty cursor → offset `0`. Otherwise base64url-decode; the bytes MUST be a canonical
  non-negative decimal integer (`/^(0|[1-9][0-9]*)$/`, no leading zeros, no sign, no whitespace).
  **Undecodable or non-canonical → reject `invalid_cursor` (row 20).** A well-formed offset is **never
  rejected for being large**: `offset ≥ length` (including a legitimately server-issued cursor that has
  since fallen past the end because the list shrank) returns an **empty page with no `nextCursor`** — not
  an error. This is the rule the weak-pagination tolerance below requires; the round-3 `> length → reject`
  clause is **removed** (it contradicted the tolerance). The page is `list.slice(offset, offset + 100)`.
- **Weak pagination (pinned).** pi exposes no list snapshot, so each page re-reads and re-sorts the
  directory; pagination is **weak/offset-based**, not a stable snapshot. Between pages a
  session added/removed/re-`modified` can shift entries by offset, so a caller MAY observe a duplicate
  or skipped entry at a page boundary, and a shrink below a previously-issued cursor yields an empty page
  (never a crash or `invalid_cursor`, per the rule above). This is acceptable: sessions are append-mostly,
  the sort is deterministic per call, and no entry is silently truncated (paging to the end returns every
  session). Recorded, not hidden.

`getTree()` (`session-manager.ts:1239`) is **not** consulted for `session/list` (list reads
`listSessionsFromDir`, `:747,1553`) — correcting the round-1 claim.

#### 9.1.6 `session/close`, idempotency, and the concurrency matrix

`session/close` **disposes** the `PiSession` and returns success. **Close is total and never
observable-failing (resolves the known-close cleanup-failure gap):** the live entry is dropped from `live`
in a `finally`, so the drop happens even if disposal throws; each disposal sub-step is guarded and bounded
and its errors are logged to stderr only (best-effort, never surfaced) — so a `session/close` never
reaches the row-23 catch-all, and a retry is a clean idempotent success. Disposal (the same routine §3.2
calls; **settlement-ordered** per §6.2.1 invariant 3): if a turn is in flight, abort the per-turn
controller (§9.6) and **await the turn's settlement** (guaranteed within `deps.graceMs` by the wedged
backstop) so its `usage_update`/`drain`/resolve complete first; then call pi's
**`AgentSession.dispose()`** (`agent-session.ts:799`), cancel + drop the send queue, unsubscribe the
translator, disconnect every MCP client (each bounded by `deps.mcpTimeoutMs`), and (in the `finally`) drop
from `live`. Pinned behaviors:

| situation | behavior |
|---|---|
| close an unknown / already-closed / tombstoned id | **success** (idempotent; close is never observable-failing — never rows 12/14) |
| close whose `AgentSession.dispose()` / MCP `close()` throws | **success** — the live entry is dropped in the `finally`, disposal errors logged to stderr only; a retry is a clean idempotent success (never row 23) |
| duplicate `load`/`resume` for an id already **live or reserved-opening** | reject the second `session_already_open` (row 13) — never overwrite a live/opening wrapper (its subscription/MCP clients would leak) |
| `close` racing an **in-flight opening** transaction (id in `opening`) | close aborts that transaction's `openController` and returns **success**; the transaction fails its §9.1.0 step-3 gate and rolls back — **no post-close resurrection** |
| `close` racing an in-flight `prompt` | close aborts the per-turn controller (§9.6); the racing `prompt` settles `cancelled` (§6.2.1), emitting its `usage_update`/`drain` **before** close tears the queue down; then close disposes |
| `PiAcpAgent.dispose()` racing an opening transaction | dispose sets `disposed`, aborts every `openController`, awaits all opening transactions' rollback, then sweeps `live` (§9.1.0, §3.2) — no post-dispose commit |
| `set_config_option`/`fork` racing an in-flight `prompt` | rejected `session_busy` (§5.2, §9.1.4) |
| `load`/`resume` racing each other for the same id | the atomic §9.1.0 reservation makes the first win; the second sees `opening.has(id)` synchronously → `session_already_open` — neither leaks |
| use of a poisoned/tombstoned id (below) | reject `session_terminated` (row 14) |

**Poisoned-journal guard (resolves the concurrent-writer hole).** When the §9.6 backstop force-resolves
a wedged turn, the underlying pi run may still be alive and could later append to the session's JSONL.
The adapter therefore records the `sessionId` in the per-connection **tombstone** set and rejects any
subsequent `load`/`resume`/`fork`/`prompt`/`set_config_option`/reopen for that id with
`session_terminated` (row 14) for the remainder of the process — preventing a second writer from
corrupting the journal a wedged writer may still touch. (`session/close` on a tombstoned id still
succeeds idempotently, §9.1.6 table.) Tombstones are per connection and cleared only on connection
teardown.

#### 9.1.7 `additionalDirectories` (accept-and-ignore, documented)

We do not advertise `additionalDirectories` (§5). If a new/load/resume/fork request carries a non-empty
`additionalDirectories`, the adapter **accepts the request and ignores the extra directories** — it does
not reject. Rationale: pi's tools operate by absolute path and are not root-confined (verified: pi has no
allowed-roots concept), so additional roots grant no capability pi lacks; rejecting would break
otherwise-valid sessions. This is documented behavior, not a silent drop, and is recorded in §11.

### 9.2 Permissions (headline differentiator, `src/permissions.ts`) — resolves adversarial finding 7

pi's permission seam is `Agent.beforeToolCall(context, signal) => Promise<{ block?, reason? } |
undefined>` (`agent.ts:105,183-186`; `BeforeToolCallContext = { assistantMessage, toolCall, args,
context }`, `BeforeToolCallResult = { block?, reason? }`, `agent/types.ts:60-98`). **The `AgentSession`
constructor already installs `agent.beforeToolCall`** to dispatch extension `tool_call` handlers
(`agent-session.ts:361` → `_installAgentToolHooks` → sets `agent.beforeToolCall` at `:424`) — so the
adapter must **wrap**, not overwrite it. **The wrapper emits NO wire updates; it is a pure decision
function.**

```ts
const inner = session.agent.beforeToolCall;                 // extension dispatch installed by AgentSession
session.agent.beforeToolCall = async (ctx, signal) => {
  const decision = await resolveAcpPermission(ctx, signal); // cache hit OR ACP round-trip — NO session/update
  if (decision.block) return { block: true, reason: decision.reason };
  return inner ? inner(ctx, signal) : undefined;            // ALWAYS run inner after an allow (fresh OR cached)
};
```

The single `return inner ? inner(ctx, signal) : undefined` is the **only** allow exit, so the extension
chain runs after **every** allow — fresh or `allow_always`-cached. `resolveAcpPermission` (the wrapper's
own decision function — distinct from the client's `decidePermission` auto-responder, §14) never returns
`undefined` to bypass it; a cache hit returns `{ block:false }` (no round-trip) and still falls through to
`inner`. This is the reason the wrapper exists (preserving pi's installed hook), so no allow may skip it.

#### 9.2.1 Frozen event/status sequence — rebuilt on pi's real ordering (resolves adversarial finding 4)

**pi emits `tool_execution_start` BEFORE it runs `beforeToolCall`.** In pi's loop, each tool call is
`emit("tool_execution_start", {toolCallId, toolName, args})` (`agent-loop.ts:389/447/502`) **then**
`prepareToolCall(...)`, which is the only place `config.beforeToolCall` runs (`:602,621-643`); and on
**every** outcome — allow, deny/`block`, abort, or an inner-hook throw — pi always emits exactly one
`tool_execution_end` afterward (immediate error result for a block/abort/throw, real result otherwise;
`emitToolExecutionEnd`). Consequences the sequence is built on:

- **The translator (§6.3) owns the single `tool_call` pending** (from `tool_execution_start`) **and the
  single terminal `tool_call_update`** (from `tool_execution_end`), each keyed by `toolCallId`. The
  permission wrapper enqueues **nothing** — so a duplicate `tool_call` and a double-`failed` update are
  structurally impossible (the round-2 eager-pending design produced both).
- **`beforeToolCall` runs after the pending `tool_call` was already enqueued** (pi's per-event `emit` is
  awaited and the bus is synchronous, invariant 5), so the pending is on the send queue before the
  wrapper acts.

Per tool call, the wrapper does, in order:

1. **`allow_always` cache check** (§9.2.2): a cached allow for `ctx.toolCall.name` returns
   `{ block:false }` with **no** round-trip — but the wrapper **still delegates to `inner`** afterward (the
   single allow exit above), so a cached ACP decision can **never** disable a later extension block/throw.
   The cache skips the ACP round-trip only, not the extension chain (resolves the cache-bypasses-inner
   gap). pi then executes (unless `inner` blocks); `tool_execution_end` yields the terminal update.
2. **`await drain()`** (§6.2) so the already-enqueued pending `tool_call` for this `toolCallId` is
   **on the wire before** the permission request is issued — this is the enforced ordering the SDK's send
   queue alone does not guarantee.
3. `context.client.request(methods.client.session.requestPermission, req, { cancellationSignal:
   turnSignal })` (§9.6 per-turn signal) with the **standard three-option shape** (`PermissionOption`,
   `types.gen.d.ts:591`; `PermissionOptionKind`, `:624`):
   `[{ optionId:"allow_always", name:"Always allow <toolName>", kind:"allow_always" },
   { optionId:"allow_once", name:"Allow once", kind:"allow_once" },
   { optionId:"reject_once", name:"Reject", kind:"reject_once" }]`. The request `toolCall` is a
   `ToolCallUpdate` (`RequestPermissionRequest.toolCall`, `types.gen.d.ts:108`) carrying `title`, `kind`,
   `_meta.toolName = ctx.toolCall.name` (our client's auto-responder reads `_meta.*.toolName`,
   `permissions.ts:164-186`, matches exact-then-substring, `:88-135`). Because ACP cancellation is
   cooperative (`SendRequestOptions.cancellationSignal`, §4), the wrapper **races** the request against
   `turnSignal` so an abort resolves the wrapper even if the client never responds; a late response to
   the abandoned request is swallowed (no unhandled rejection).
4. **Map the response to a decision** (`resolveAcpPermission` returns `{ block }` to the wrapper; no wire
   update — pi's `tool_execution_end` carries the terminal state). The response's `outcome:"selected"`
   `optionId` MUST be exactly one of the three offered:
   - **allow_once** (`optionId:"allow_once"`) → `{ block:false }`; the wrapper then runs `inner` (step
     above) and, absent an inner block, pi executes: `tool_execution_end {isError:false}` →
     `tool_call_update {status:"completed"}`.
   - **allow_always** (`optionId:"allow_always"`) → cache (§9.2.2), then `{ block:false }` — same
     inner-then-execute path as `allow_once`.
   - **reject_once** (`optionId:"reject_once"`) → `{ block:true, reason:"denied by user" }`. pi's
     `prepareToolCall` returns an immediate error result → `tool_execution_end {isError:true}` →
     `tool_call_update {status:"failed"}`.
   - **unknown / missing `optionId`** (`outcome:"selected"` with an id NOT in the three offered, or a
     malformed response) → **fail-safe deny**: `{ block:true, reason:"unrecognized permission selection" }`
     (never treated as an allow) → one `tool_call_update {status:"failed"}`. A buggy/hostile client can
     therefore never smuggle an unoffered selection into an allow.
   - **cancelled** (`outcome:"cancelled"`) or **turn abort won the race** → `{ block:true,
     reason:"cancelled" }`. pi (which sees `signal.aborted`) yields "Operation aborted" →
     `tool_execution_end {isError:true}` → one `tool_call_update {status:"failed"}`.
   - **transport failure** (the `client.request` rejects) → **fail-safe deny**: `{ block:true,
     reason:"permission unavailable" }`; the turn continues. No wire update, no `session/prompt` rejection
     (error table note under §8.1).
   - The **inner extension hook** (`inner(ctx, signal)`) runs after **every** allow (fresh or cached); if
     it returns `block` or throws, that likewise flows through pi's single `tool_execution_end
     {isError:true}` — the wrapper adds nothing. Exactly one pending + one terminal update per
     `toolCallId` on every path.

#### 9.2.2 `allow_always` scope and lifetime (pinned)

The cache key is **the tool NAME only** (`ctx.toolCall.name`), scoped to the **single `PiSession`**
(dropped on `session/close`/dispose). It does not persist to disk, across sessions, or across process
restarts, and it is NOT argument-scoped (arg-scoping would make "always allow bash" fire a prompt on
every distinct command — false economy, and pi's own permission model is name-granular). This makes the
`allow_always` option's name truthful (it really suppresses future prompts for that tool in this
session) without granting broadly across sessions. Recorded as a decisive choice in §12.

### 9.3 MCP bridge (`src/mcp-bridge.ts`) — resolves adversarial finding 6

pi ships **no native MCP** (verified: zero `modelcontextprotocol` deps in pi source; README stance is
"build extensions"). The adapter bridges ACP-supplied MCP servers into pi `customTools`, on **every**
lifecycle method that carries them — our client sends `mcpServers` on `session/new` **and** on
load/resume/fork (`reattachSession`/`forkSession`, `acp-client.ts:1533,1587,1647`), so all four apply
the bridge.

#### 9.3.1 Connect and register (bounded, fully paginated)

For each `request.mcpServers` entry of **stdio** transport (`McpServerStdio`, `types.gen.d.ts:4779`),
`deps.connectMcpClient(server, openSignal)` connects a `@modelcontextprotocol/sdk` stdio client and
**enumerates its tools across ALL pages** — **each of connect and each `tools/list` page bounded by
`deps.mcpTimeoutMs`** (§4.1; passed as the SDK client request `options.timeout`; a timeout is a stage
failure → rollback + row 16). **Full cursor enumeration (resolves the multi-page tool-loss gap):**
`ListToolsResult` extends `PaginatedResult` and carries an optional `nextCursor` (MCP SDK 1.29.0,
`dist/esm/types.js` `ListToolsResultSchema`/`PaginatedResultSchema`), so the bridge calls
`client.listTools({ cursor })` (`client/index.js:565`) repeatedly, accumulating `result.tools` and
following `result.nextCursor` until it is absent. The bound applies **per page** (each `listTools` request
gets `deps.mcpTimeoutMs`), not once for the whole enumeration. **Cycle guard:** the bridge tracks the set
of cursors already requested; if a server returns a `nextCursor` it has already served (a
buggy/looping server), enumeration **stops** and the lifecycle request is rejected row 16
(`mcp_init_error`, naming the server) rather than looping forever. **Duplicate server names within one
request → reject** row 16 (`mcp_init_error`, naming the duplicate): the ACP contract sends unique server
names, so a duplicate is a client error, not something to silently merge. Each enumerated tool is
registered as a pi `defineTool` customTool (`extensions/types.ts:437-495`): the MCP tool's JSON-Schema
`inputSchema` becomes the pi tool `parameters` (raw JSON Schema accepted — §2.3), and `execute` forwards
to the MCP `tools/call` (`client/index.js:490`, bounded by `deps.mcpTimeoutMs` via `options.timeout`),
converting the result (§9.3.3).

**Timeout / abort resource protocol (resolves the detached-promise + orphan-child gap).** Every
`connect`, `listTools`-page, and `tools/call` promise is raced against `deps.sleep(deps.mcpTimeoutMs,
signal)` (and against `openSignal`/`turnSignal` as applicable). When the timeout or abort wins the race,
the losing MCP promise is **detached** with an attached `.then(() => {}, () => {})` so its late
resolve/reject produces **no unhandled rejection** (extending to MCP the detached-promise guarantee that
previously covered only pi prompt + permission requests, §9.6). For a **failed or timed-out `connect`**,
`deps.connectMcpClient` **closes the stdio child it spawned** before returning/throwing (the
`StdioClientTransport` `close()` kills the spawned process, `client/stdio.js`), so a factory that spawned a
child but never returned a usable handle leaves **no orphan process**. The returned `McpClientHandle`
exposes `listTools`/`callTool`/`close`; `close` is idempotent and bounded by `deps.mcpTimeoutMs`.

#### 9.3.2 Naming, collisions, partial-init rollback, cleanup (total — resolves adversarial finding 9)

**Extensions stay enabled and are part of collision discovery.** A pi user's configured extensions must
keep working through the ACP server (disabling them would make pi-acp a lesser pi), so extension tools
coexist with our injected ones. But pi's `_refreshToolRegistry` composes tools as
`Map(builtins)` then `Map.set` over `[...extensionTools, ...customTools]` (`agent-session.ts:2459-2463`),
so an injected customTool that **shares a name** with a built-in or extension **silently overrides** it.
Naming is therefore made total so no injected name can ever occupy a built-in/extension name:

- **MCP tools are ALWAYS namespaced** (not only on collision): `mcp__<serverSlug>__<toolSlug>`, where
  each slug replaces every char outside `[A-Za-z0-9_-]` with `_` and collapses runs of `_`; an **empty
  slug** (a name that sanitizes away entirely) becomes the single char `_`, so the `mcp__…__…` skeleton is
  always well-formed. The `mcp__` prefix is a pi-acp **reserved namespace** that pi's built-ins
  (`read/bash/edit/write/grep/find/ls`) and standard extensions do not use, so an MCP tool can never
  shadow one. The alias is what the model sees and what `tool_call._meta.toolName` reports.
- **Alias uniqueness and suffix-aware length (deterministic, ≤ 128 — resolves the truncate-then-suffix
  conflict).** The alias length limit is **128 chars including any uniqueness suffix**. Build the alias set
  in (serverIndex, toolIndex) order over an initially-empty `Set`. For each candidate `base =
  mcp__<serverSlug>__<toolSlug>`: (1) if no collision, the alias is `base` truncated to 128 chars; (2) if
  `base` (so truncated) is already present (sanitization collapsed two distinct names, or two tools map
  alike), find the smallest `_<n>` (n ≥ 2) whose alias is unique, where the alias is `base` **truncated to
  reserve exactly `("_"+n).length` chars** then concatenated with `_<n>` — so the full alias, suffix
  included, is **always ≤ 128** and the suffix is **never** truncated (digit growth of `n` is accounted
  for by re-reserving on each try). Fully deterministic → two implementations produce identical names.
- **Structured-output reserved name** `__acp_structured_output` (double-underscore `__acp_` prefix,
  another reserved namespace, §9.4).
- **Reserved namespaces + post-construction verification.** The built-in catalog is the known set
  `{read,bash,edit,write,grep,find,ls}` (none of which use a reserved prefix), so an injected name — an
  `mcp__…` alias or `__acp_structured_output` — is **disjoint from every built-in by construction**
  (asserted as a guard against a future pi built-in that adopts a reserved prefix: if that ever holds,
  reject row 18/16). Extensions are the only entities that could use a reserved prefix; pi-acp
  **reserves** `mcp__` and `__acp_` (declared in the README, §15), so a compliant extension never does.
  If a non-compliant extension registers such a name, pi's `Map.set` composition
  (`[...extensionTools, ...customTools]`, `agent-session.ts:2459-2463`) makes **our** tool win
  deterministically — pi-acp's reserved tool is never shadowed (the extension's squatting tool is the one
  dropped); that is the documented, safe-for-us consequence of the reservation, not a silent pi-acp
  failure. The one positively-detectable defect is checked via `session.getAllTools()`
  (`agent-session.ts:868`): if `getToolDefinition("__acp_structured_output")` is **absent** after
  construction (an allow/exclude filter or a pi change removed it), the structured-output channel cannot
  function → dispose + reject row 18 (`structured_tool_collision`); likewise every `mcp__…` alias MUST be
  present (else the bridge is broken) → dispose + reject row 16 (`mcp_init_error`).
- **Partial-init rollback (all-or-nothing).** If any server's connect/`tools/list`/duplicate check or the
  reserved-name verification fails, run the full §9.1.0 rollback (disconnect every already-connected
  client — each bounded by `deps.mcpTimeoutMs` — dispose the session if constructed, drop the
  reservation) and reject with row 16 (or 18 for the structured-name clash). No half-initialized session
  is registered; no child processes leak.
- **Cancellation + timeout.** Each `tools/call` is passed the turn signal (§9.6); on abort the call is
  cancelled. `deps.mcpTimeoutMs` also bounds each `tools/call`; a timeout/abort becomes an error result
  (pi surfaces it as a failed tool, §9.3.3, not a crashed session).
- **Cleanup.** MCP clients are disconnected on `session/close`, on the §9.6 backstop, and on connection
  teardown (§3.2 disposal), each disconnect bounded by `deps.mcpTimeoutMs` so a hung `close()` cannot
  wedge shutdown.

#### 9.3.3 Result conversion (total over the pinned `CallToolResult` — resolves the content-union gap)

The pinned MCP SDK 1.29.0 `CallToolResult` (`dist/esm/types.js` `CallToolResultSchema`) is
`{ content: ContentBlock[] (default []), structuredContent?: Record<string,unknown>, isError?: boolean }`,
and `ContentBlockSchema` is the **five-member** union `text | image | audio | resource_link |
embedded resource`. The projection to pi `AgentToolResult` (`{ content: (TextContent|ImageContent)[],
details? }`) is **total over every member**, in `content` order:

- **text** → `{ type:"text", text }`.
- **image** (`{ data, mimeType }`) → `{ type:"image", data, mimeType }`.
- **audio** → a text item `[unsupported audio tool-result omitted]` (pi's tool-result content is
  text-or-image only, `ai/types.ts:403-418`; audio has no pi representation — degrade, don't drop
  silently).
- **resource_link** (`{ uri, name?, title? }`) → a text item `[<title ?? name ?? uri>](<uri>)`.
- **embedded resource** — text contents → the embedded `text`; blob contents → a text item
  `[embedded resource: <uri>]`.
- **`structuredContent`** (when present) → set pi `AgentToolResult.details = structuredContent`, so it
  surfaces to the client as `tool_call_update.rawOutput` (§6.3.1) rather than being lost.
- **`isError: true`** → the pi tool `execute` **throws** (pi encodes a thrown tool error as a failed tool
  result — `extensions/types.ts` requires throwing rather than encoding errors in `content`), surfaced to
  the client as `tool_call_update { status:"failed" }` (§6.3). The thrown `Error.message` is a **fixed**
  string `` `MCP tool ${alias} returned an error result` `` — **never** the raw provider `content` text
  (redaction parity with §8.2); the result `content` (already converted above) is still projected as the
  failed update's `content`, so the model sees the tool's own error text there without a raw exception on
  any error channel.
- A **timed-out / aborted** `tools/call` (§9.3.1) throws the same way (fixed message
  `` `MCP tool ${alias} timed out` ``) → a failed tool result the model sees, never a crashed session.

#### 9.3.4 Transports

**v1 serves stdio only.** `mcpCapabilities: {}` is advertised (§5), so our client rejects http/sse before
sending them (`unsupportedMcpServer`, `capabilities.ts:278-300`). If **another** client sends a non-stdio
(`http`/`sse`) server anyway, the bridge rejects that lifecycle request with `invalidParams` (`-32602`,
`errorKind:"unsupported_mcp_transport"`, naming the server) — it does not silently drop it. http is a
deferred item (§11).

### 9.4 Structured output (`src/structured-output.ts`) — resolves adversarial finding 11

pi has no native constrained decoding; the canonical pi pattern is a **terminating tool** carrying a
JSON-Schema parameter that ends the turn (`examples/extensions/structured-output.ts`,
`{ …, terminate: true }`). The adapter implements the ACP native `_meta.outputSchema` channel with it,
as a per-turn `try/finally` state machine.

#### 9.4.1 Registration (once, at session creation)

Register a customTool `__acp_structured_output` (reserved name; a client/MCP tool of the same name is
aliased away, §9.3.2). **Collision policy is absence-detection, not pre-existence (resolves the collision
contradiction, aligns with §9.3.2).** Because pi composes tools as `Map(builtins)` then `Map.set` over
`[...extensionTools, ...customTools]` (`agent-session.ts:2459-2463`, verified), our injected
`__acp_structured_output` **always wins** over any built-in/extension squatting the same name — so a
"pre-existing owner" is never observable and is *not* the trigger. The only positively-detectable defect
is **absence after construction**: if `getToolDefinition("__acp_structured_output")` is missing from
`session.getAllTools()` (`agent-session.ts:868`/`:878`) — an allow/exclude filter or a pi change removed
it — the structured-output channel cannot function → dispose + reject **row 18**
(`structured_tool_collision`). That is the single condition row 18 fires on. Its `parameters` reference a
**mutable schema holder**; its `execute` captures `params` into a per-turn slot and returns
`{ content:[{ type:"text", text:"(structured output captured)" }], details: params, terminate: true }`.
It starts **inactive** (removed from the active set via `setActiveToolsByName`, `agent-session.ts:888`).

#### 9.4.2 Per-turn arm/capture/disarm (`try/finally`)

On a `session/prompt` whose `_meta.outputSchema` (bare `META_KEYS.outputSchema`, `meta.ts:7-13`) is
present:

1. **Validate** the schema: it MUST be a JSON object (an object/typed schema). A non-object / top-level
   scalar / null → reject `invalidParams` (row 19, `invalid_output_schema`) before the turn starts.
2. In a `try`: set the holder's schema (assigned directly as `parameters`; providers consume it as raw
   JSON Schema — `openai-completions.ts:1110` et al.), **clear** the capture slot, arm via
   `setActiveToolsByName([...base, "__acp_structured_output"])`, and prepend the one-line instruction to
   the prompt text (§6.1) telling the model to finish by calling `__acp_structured_output` with a value
   conforming to the schema. Safe because exactly one turn runs per session (invariant 4).
3. After the turn settles, if a value was captured, emit it as the **final** `agent_message_chunk`
   (`content:{ type:"text", text: safeStringify(captured) }`) so `parseFinalJson(finalMessageText())`
   reads it and the client's typebox `Convert`+`Check` ladder validates it
   (`structured-output.ts:47-64,125-161`). If nothing was captured, the plain final assistant text is
   emitted and the client's validate-then-reprompt ladder recovers or fails with `SCHEMA_NONCOMPLIANCE`
   — no fabrication. If `safeStringify` throws (circular `details`) → emit nothing captured and let the
   plain text path run (the client ladder handles it); do not crash the turn.
4. **`finally`: always disarm** (`setActiveToolsByName(base)`) and clear the capture slot — even on
   pre-flight auth throw, provider rejection, cancellation/backstop, permission failure, or notification
   failure. This guarantees no stale schema/capture leaks into the next (possibly unstructured) turn.
5. **Multiple invocations** in one turn: the capture slot holds the **last** `__acp_structured_output`
   call's `params`; `terminate:true` normally ends the turn on the first call, so a second is only
   possible with a non-conforming loop — last-wins is deterministic and documented.

#### 9.4.3 Current-path truth and registration (corrects the round-1 "no prompt-embedding" claim)

When pi-acp is driven through the existing generic `CustomAcpBackend` (the pre-`PiBackend` path), the
runner **embeds the schema in the prompt text** (`embedSchemaInPrompt = true`, `custom.ts:33`,
unconditional) **and** sends `_meta.outputSchema` (`promptMeta`, `custom.ts:72-78`, gated by the backend's
`gatedKeys`). So pi-acp receives the schema on BOTH channels; it uses the `_meta` tool for capture and
treats the embedded prompt text as harmless reinforcement (invariant 7). The custom-backend registration
that drives pi-acp is therefore **exactly**:

```jsonc
{ "customCapabilities": { "namespace": "@automatalabs/pi-acp", "gatedKeys": ["outputSchema"] } }
```

Both fields are **required**: the registry rejects an empty/missing `namespace` and an empty/missing
`gatedKeys` (`registry.ts:149-161`). The round-1 claim that the custom backend "needs only
`customCapabilities.namespace`" was wrong; `gatedKeys: ["outputSchema"]` is mandatory. The runner also
does NOT inject its client-hosted StructuredOutput MCP tool, because that path gates on
`mcpCapabilities.http === true` (`supportsStructuredOutputToolTransport`, `runner.ts:1294-1296`) and
pi-acp advertises `mcpCapabilities: {}` (no http). The future `PiBackend` (§11) sets
`embedSchemaInPrompt = false` to drop the redundant embed; until then the redundancy is inert.

### 9.5 Auth (`src/auth.ts`) — resolves design-minimalism finding 1 / adversarial finding 12

`authMethods` are derived from pi-ai's env-key catalog (`env-api-keys.ts:64-110`, `getApiKeyEnvVars`),
kept **small and justified** — the major providers plus one stored-credentials method — and advertised
**UNCONDITIONALLY**:

Every method carries the SDK-required human-readable **`name`** (both `AuthMethodEnvVar` and
`AuthMethodAgent` require `name`, `types.gen.d.ts:2221`/`:2303`) — the exact wire strings are pinned here,
not implementer-invented:

| `id` | `name` (exact) | type | `vars` / behavior |
|---|---|---|---|
| `anthropic-api-key` | `"Anthropic API key"` | `env_var` | `[{ name:"ANTHROPIC_API_KEY", secret:true }]` (pi also honors `ANTHROPIC_OAUTH_TOKEN` precedence, `env-api-keys.ts:71`) |
| `openai-api-key` | `"OpenAI API key"` | `env_var` | `[{ name:"OPENAI_API_KEY", secret:true }]` |
| `gemini-api-key` | `"Google Gemini API key"` | `env_var` | `[{ name:"GEMINI_API_KEY", secret:true }]` |
| `xai-api-key` | `"xAI API key"` | `env_var` | `[{ name:"XAI_API_KEY", secret:true }]` |
| `openrouter-api-key` | `"OpenRouter API key"` | `env_var` | `[{ name:"OPENROUTER_API_KEY", secret:true }]` |
| `pi-stored-credentials` | `"pi stored credentials"` | `agent` | pi reads its own `~/.pi/agent/auth.json` (`AuthStorage`); the default `AuthMethodAgent` ("agent handles auth itself") with **no** `_meta` |

`env_var` methods use the SDK `AuthMethodEnvVar` shape (`{ id, name, vars:[{ name, label?, secret?,
optional? }], link? }`, `types.gen.d.ts:2221`); the `agent` method uses `AuthMethodAgent` (`{ id, name,
_meta? }`, `:2303`). `pi-stored-credentials` (type `agent`, no-op `authenticate`) denotes
**already-provisioned ambient disk credentials** in `~/.pi/agent/auth.json` — it is **not** an interactive
login the server performs; the base `authenticate` no-op reflects that there is nothing to exchange (T13
asserts the exact advertised payload and the no-op).

**Unconditional advertisement is normative.** The SDK's `AuthCapabilities = { terminal?: boolean; _meta? }`
(`types.gen.d.ts:4318`) has **only** a `terminal` gate — there is no `env_var` or generic-`agent` gate.
The frozen `docs/specs/acp-auth-spec.md` §1.2 states env_var methods "are always visible on the wire" and
bare-`_meta` `agent` methods "need no client capability and work with nothing advertised —
base-spec-first"; §3.5 (the custom-agent conformance profile governing a new agent like pi-acp) requires
only that these methods be *advertised* and the base flow services them. The "claude hide all methods"
behavior is a claude-specific artifact (all of claude's methods are terminal/gateway-gated); it is NOT a
general rule, and pi-acp advertises **zero** terminal/gateway methods. **We therefore delete the round-1
client-capability gate and the empty-when-none rule** — all six methods are always visible. (Only
`terminal`-type methods would gate on `auth.terminal`, and gateway-`_meta` `agent` methods on
`auth._meta.gateway`; pi-acp advertises neither.) This is exactly what serves our own default client —
whose default advertisement omits the `auth` key entirely (acp-auth-spec §1.2) — maximally and
truthfully.

**`authenticate` semantics.** `authenticate(methodId)`:

- `env_var` / `pi-stored-credentials` (`agent`) → **no-op success** (credentials are ambient — env or
  disk — so there is nothing to exchange). A missing credential is NOT reported here. **Narrowed claim
  (resolves the missing-credential-vs-default-model conflict):** the `-32000` auth rejection (§8 row 1)
  surfaces at prompt time **when a model is selected or resolvable but its credential is missing** (the
  `session.prompt()` `formatNoApiKeyFoundMessage` throw, §8.2; or the `set_config_option("model")`
  `hasConfiguredAuth` precheck, §5.2). It does **not** cover the distinct state of **no model at all**:
  with no explicit model and no configured credentials, pi's `findInitialModel` selects nothing and
  `session.prompt()` throws `No model selected` → **row 6 `invalid_model` (`-32602`)**, deliberately not
  auth (§8.2). So the reliable auth pause is credential-missing-for-a-known-model, not the no-model case
  (T9 covers both). This matches acp-auth-spec's base flow for ungated types.
- **unknown `methodId`** → reject `invalidParams` (`-32602`, `errorKind:"unknown_auth_method"`).

No terminal-login method is advertised in v1 (pi's OAuth/login is a TUI flow with no ACP `terminal` auth
surface we serve; §11).

### 9.6 Cancellation and the wedged-agent backstop (`src/session.ts`)

**One per-turn controller, four abort sources (resolves adversarial finding 5).** Each `session/prompt`
creates a fresh `turnController = new AbortController()` stored on the `PiSession` for the turn's
duration. `turnSignal = turnController.signal` is the single cancellation axis threaded through the whole
turn: `agent.abort()`, the parked `session/request_permission` (§9.2.1 step 3, via `cancellationSignal` +
the wrapper's race), and each MCP `tools/call` (§9.3). Four sources abort it, all entering **one
idempotent path** (`turnController.abort()` is naturally idempotent):

1. **`$/cancel_request`** — the SDK aborts the request's `context.signal` (`jsonrpc.js:640-652`); the
   prompt handler does `context.signal.addEventListener("abort", () => turnController.abort())`.
2. **`session/cancel`** — the ordinary notification `impl.cancel(context)` looks up the `PiSession` by
   `context.params.sessionId` and calls its `turnController.abort()` (no-op if no turn is in flight).
   This is a **separate** mechanism from (1): the SDK does not wire `session/cancel` to any
   `context.signal` (§4).
3. **`session/close` / dispose** — aborts `turnController`, then tears the session down **after**
   settlement (§6.2.1 invariant 3, §9.1.6).
4. **Notification-delivery failure** mid-turn (§6.2.1 input 3) — aborts `turnController` **and settles the
   turn by rejecting** `notification_error` (row 22); this is a *settlement* source, not a cancelled path.

**Settlement is owned by §6.2.1, not re-decided here.** Sources 1–3 are cooperative aborts: on abort,
`turnController.signal` fires `session.agent.abort()` (`agent.abort()` aborts the active run's controller,
`agent.ts:310-311`); pi settles the turn with a terminal `aborted` assistant message, `session.prompt()`
resolves, and the **cancelled** settlement input (§6.2.1) emits `usage_update`, `await drain()`, and
resolves `{ stopReason:"cancelled", usage }` (§7). Source 4 is the **notify-failure** input: it rejects
row 22 and (transport broken) emits no `usage_update`/`drain`. Whichever fires first wins; `settle` is
one-shot (§6.2.1 invariant 2).

**Wedged-agent backstop (scheduler-driven, deterministic).** `agent.abort()` is cooperative; a provider
stream stuck below the abort point could leave `session.prompt()` unresolved. When `turnController`
aborts, the adapter starts `deps.sleep(deps.graceMs, settledSignal)` (default `graceMs` 5000);
`settledSignal` is aborted the moment the turn **settles** (any §6.2.1 input), which cancels the sleep. If
the sleep **elapses first** (the turn is wedged), the backstop is the **wedged-backstop** settlement input
(§6.2.1):

- **if the turn is still unsettled**, it **force-resolves** the ACP request `{ stopReason:"cancelled",
  usage }` — `usage` is the best-effort snapshot of §6.5's forced-cancel row (commonly all-zero) — after
  emitting a `usage_update` from the current context/cost snapshot and `drain()` (skipped if the pump
  already failed). **If the turn already settled** (e.g. notify-failure already rejected row 22), the
  backstop performs **cleanup only** and never re-settles (§6.2.1 invariant 2);
- **detaches the pi promise safely:** `session.prompt()` is left with an attached
  `.then(() => {}, () => {})` so a late resolve/reject after force-resolution produces **no unhandled
  rejection** and does not touch the already-settled request;
- **tombstones** the `sessionId` (§9.1.6) and **disposes** the `PiSession` — pi's `AgentSession.dispose()`
  (`agent-session.ts:799`), unsubscribe, cancel + drop the send queue, disconnect MCP (bounded by
  `deps.mcpTimeoutMs`), `turnController.abort()` again — so no later event from the wedged run reaches the
  connection and no second writer can reopen the journal. A subsequent request for that id →
  `session_terminated` (row 14).

Because the timer is `deps.sleep` (not a wall clock), a test injects a `sleep` it resolves on demand to
drive the wedged path deterministically (T22). This guarantees that from **any** of the four sources the
turn settles promptly even if pi's stream hangs — cancelled via the backstop for sources 1–3, or row 22
for source 4 (with the backstop then cleaning up).

---

## 10. Monorepo integration

### 10.1 Freshness gate (the one client-repo change)

Add `@earendil-works/pi-coding-agent` to `ACP_DEP_MATCHERS` in `scripts/check-acp-deps.mjs:34-37`:

```js
const ACP_DEP_MATCHERS = [
  (name) => name.startsWith("@agentclientprotocol/"),
  (name) => name === "@automatalabs/codex-acp",
  (name) => name === "@earendil-works/pi-coding-agent",   // NEW
];
```

Rationale: pi releases every 2–3 days (~30 releases in 10 weeks; latest 0.80.7, 2026-07-14), so the
pre-push freshness check must fail when pi-acp's pinned pi runtime falls behind npm `latest`.
`@earendil-works/pi-coding-agent` is a **direct** dependency of a workspace package (pi-acp embeds it),
so it belongs in `ACP_DEP_MATCHERS` (check 1, direct freshness), **not** `WRAPPED_RUNTIMES` (third-party
adapters whose runtime is only transitive, `check-acp-deps.mjs:53-55`). `@agentclientprotocol/sdk` is
already matched by the `@agentclientprotocol/` prefix. This is the only normative change outside
`packages/pi-acp`.

### 10.2 Changesets, CI

- `packages/pi-acp` is auto-included by `pnpm-workspace.yaml` (`packages/*`).
- CI (`.github/workflows/ci.yml`) runs `pnpm -r exec tsc -b`, `tsc --noEmit`, and `pnpm -r test` on
  Node 24 — pi-acp participates through its `build`/`typecheck`/`test` scripts with no CI-file change.
- A changeset accompanies the introducing PR so the package publishes on the next release wave
  (`.changeset/config.json`, access `public`, baseBranch `main`); its first publish is a new-package
  release at `0.0.0` → the changeset's bump.

### 10.3 tsconfig project reference

Add `{ "path": "packages/pi-acp" }` to the root `tsconfig.json` `references` array (alongside the
existing package references) so `tsc -b` builds it in dependency order.
`packages/pi-acp/tsconfig.json` is a composite project extending the shared base (the acp-agents
convention).

---

## 11. Non-goals (v1) — with rationale

- **`PiBackend` built-in backend in `acp-agents`** — a follow-up issue mirroring #197 (spawn ladder
  `AGENTPRISM_PI_ACP_CMD` → resolved bin under `process.execPath` → npx; auth profile; native
  structured-output posture with `embedSchemaInPrompt = false`; `classifyProviderError` for pi's
  retry/errorKind signals; docs/skill/live e2e). Kept separate: client-repo work with its own review
  surface. Until it lands, the server is drivable through the existing custom-backend registry
  (`resolveModelRoute`, `runner.ts:1356-1370`) with the registration of §9.4.3.
- **`session/delete`** — pi's `SessionManager` exposes no delete/unlink API; hand-unlinking `.jsonl`
  files risks corrupting the fork tree and would violate invariant 2. Revisit if pi adds a first-class
  delete.
- **Branch-topology + compaction-summary replay on `session/load`** — v1 replays the linear active
  branch (`getBranch()`) only; ACP `session/update` has no representation for fork topology, and the
  compaction summary is model-facing, not a human transcript (§9.1.2). `getTree()` metadata is not
  replayed.
- **`additionalDirectories`** — not advertised; pi has no allowed-roots concept, so extra roots grant no
  capability pi lacks. A present field is accepted and ignored (§9.1.7).
- **Audio prompt content** — no pi representation; not advertised; degraded to a text note (§6.1).
- **Mid-turn steering / follow-up queue over ACP** — pi's `steer`/`followUp` have no in-band ACP
  surface; inventing one would be an unadvertised non-portable extension. One serialized turn per session
  (§6.6).
- **fs/terminal client-delegation suite** — terminal output is surfaced via the shared `_meta` tool_call
  convention (like claude-agent-acp/codex-acp), not ACP `terminal/*` or `fs/*`.
- **http/sse/acp MCP transports** — v1 serves stdio MCP only (§9.3). http is the natural next step
  (advertise `mcpCapabilities: { http: true }` when the client lands).
- **`baseInstructions`/`developerInstructions` `_meta`** — pi's system-prompt override is internal and
  unstable (§5); not advertised or accepted.
- **Terminal-login auth method** — pi's login is a TUI OAuth flow with no ACP `terminal` auth surface we
  serve; env/disk credentials + the `-32000` pause signal cover v1 (§9.5).
- **Subprocess / `pi --mode rpc` mode; upstreaming; changes to community bridges; pi extension
  marketplace surfaces** — explicitly excluded; in-process SDK only.

---

## 12. Rejected alternatives (with rationale)

1. **Subprocess bridge over `pi --mode rpc`** (the `svkozak/pi-acp` architecture). Rejected: pi's RPC
   executes tools autonomously with no per-tool permission callback, folds thinking into message chunks,
   accepts `mcpServers` without wiring them, and offers no native structured output — exactly the
   surfaces our client feature-detects. The in-process SDK (`createAgentSession`) is the only seam that
   closes all of them.
2. **Reusing/forking `victor-software-house/pi-acp`** — the issue's other prior art, an **in-process**
   embed (1★, "architecturally right, effectively unadopted"). Considered and rejected: motivation #2 is
   a **fully-owned, MIT, end-to-end-controlled reference server** (with the injectable-`streamFn`
   hermetic-e2e substrate, §4.1) — building new gives us that ownership; an unadopted third-party embed
   would still be someone else's code path. The design is nonetheless validated as sound by that prior
   art's existence.
3. **Overwriting `agent.beforeToolCall`** instead of wrapping it. Rejected: `AgentSession` installs its
   own `beforeToolCall` to dispatch extension `tool_call` handlers (`agent-session.ts:361→424`);
   overwriting would silently disable every pi extension's tool interception. The wrapper (§9.2)
   preserves the chain.
4. **`getModel(provider, id)` from `@earendil-works/pi-ai/compat` as the primary model resolver** (the
   issue's suggestion). Rejected: that alias is `@deprecated` (`compat.ts:61`) and `getBuiltinModel` is
   strongly typed to generated catalog keys, so neither accepts arbitrary custom-provider strings.
   `ModelRegistry.find(provider, id)` (`model-registry.ts:695`) — what `createAgentSession` itself uses —
   is the runtime path covering builtin + custom-configured providers.
5. **Returning `stopReason:"end_turn"` on provider error** (or minting a synthetic `error` stopReason).
   Rejected: the ACP `StopReason` enum has no error member (`types.gen.d.ts:3027`), and an error that
   looks like a normal turn defeats the client's pause/retry logic. Errors reject with `data.errorKind`;
   `-32000` is auth-exclusive (§8).
6. **Advertising a `model` select config option.** Rejected (design-minimalism finding 2): the client
   sets the model unconditionally through the reserved channel and `applyConfigOption` does not check
   advertisement (`acp-client.ts:1986-1993`), so advertising is unneeded surface; worse, a partial
   "representative" list would mislead the `config-options.md` §2.3 validate probe. We only *handle*
   `set_config_option("model", …)` (§5.2).
7. **Gating auth-method advertisement on client auth capabilities** (the round-1 rule; also the literal
   phrasing of the focus.md auth directive, "gated on advertised client auth capabilities"). Rejected —
   and this resolves, decisively and from the repo, the tension the round-2 adversarial board routed as
   an owner decision. The frozen house contract `docs/specs/acp-auth-spec.md` §1.2 (verified) states
   `env_var` methods "are always visible on the wire" and bare-`_meta` `agent` methods "need no client
   capability and work with nothing advertised — base-spec-first"; the SDK's typed
   `AuthCapabilities = { terminal?, _meta? }` (`types.gen.d.ts:4318`) has **no** `env_var` or
   generic-`agent` gate to key off; and gating would return an **empty** `authMethods` to our own default
   client (whose default advertisement omits the `auth` key), starving the very client this contract must
   serve maximally. The focus.md phrasing is satisfied in substance for the *only* gate that exists:
   `terminal`-type methods would gate on `auth.terminal` and gateway-`_meta` `agent` methods on
   `auth._meta.gateway` — and pi-acp advertises **neither**. All six methods are therefore advertised
   **unconditionally** (§9.5). No `ownerQuestion` is raised: the frozen house auth spec plus the SDK's
   typed capabilities settle it. (Consistent with [never flag-gate features]: safety comes from behavior
   — the `-32000` pause on a missing credential — not from hiding the method.)
8. **`allow_always` cached per (tool, arguments)** or persisted across sessions. Rejected (§9.2.2):
   argument-scoping re-prompts on every distinct command (false economy); cross-session persistence
   over-grants. Name-scoped, single-session, in-memory is the truthful minimum.
9. **Enumerating pi-ai's full ~30-provider env-key catalog as `authMethods`.** Rejected: noise. Five
   major providers + one disk-credentials method is the small, justified set; missing credentials still
   surface at prompt time via `-32000`.
10. **Advertising `mcpCapabilities: { http: true }` in v1** to unlock the client-hosted StructuredOutput
    MCP fallback. Rejected: we do not serve http MCP in v1 (advertise-and-fail), and pi serves
    outputSchema natively (§9.4). `{}` correctly gates http/sse out.
11. **Advertising `session/delete`** and unlinking session files by hand. Rejected: no first-class pi
    API; risks fork-tree corruption; violates invariant 2.
12. **Replaying `buildSessionContext()` (compaction-aware) on `session/load`.** Rejected: that is the
    model-facing compacted context (summaries replace history), not the human transcript. `getBranch()`
    replays the full active branch (§9.1.2), which is what a client rehydrating a conversation wants.
13. **Aliasing MCP tools only on collision** (the round-2 rule) instead of unconditional `mcp__…`
    prefixing. Rejected (§9.3.2): "only on collision" requires knowing the built-in + extension name set
    to detect a collision, but customTools are fixed at `createAgentSession` construction and pi has no
    post-hoc registration API — a chicken-and-egg the unconditional prefix avoids. Unconditional
    `mcp__<server>__<tool>` (the well-known MCP convention) puts every bridged tool in a reserved
    namespace pi built-ins/extensions never use, making MCP-vs-builtin/extension collisions structurally
    impossible and the naming fully deterministic (`_meta.toolName` still carries the alias for the
    permission matcher).
14. **Disabling pi extensions to sidestep tool-name collisions.** Rejected (§9.3.2): a pi user's
    configured extensions must keep working through the ACP server — disabling them makes pi-acp a lesser
    pi. Extensions stay enabled and are part of collision discovery; the reserved `mcp__`/`__acp_`
    namespaces + the `getAllTools()` reserved-name verification make coexistence safe without disabling
    anything.
15. **`session/list` returns the full sorted list with no pagination** (omitting `nextCursor`, which the
    SDK permits). Considered (it is strictly less surface: no cursor codec, no `invalid_cursor` row) and
    rejected: `listAll` (no cwd) can return a user's **entire** cross-project session history — potentially
    thousands of entries — so an unbounded single response is a real memory/latency hazard for our own
    client. Offset pagination (page 100, exact base64url cursor, §9.1.5) bounds each response while
    returning every session across pages (it chunks, never truncates) — the bounded-liveness choice,
    consistent with the injectable MCP/backstop timeouts.
16. **Emitting `type:"diff"` tool-call content for `read`/`edit`/`write`.** Rejected (§6.3.1): pi's
    `AgentToolResult` exposes no standardized old-text/new-text pair (only `content` + arbitrary
    `details`), so a diff block would be fabricated. All tool results project uniformly through
    `toContent` + `rawOutput = details`; the round-2 conditional-diff clause was ungrounded and removed.
17. **Hardcoding the MCP `tools/call` timeout at an invented literal** (the round-2 `30000`) instead of an
    injectable `deps.mcpTimeoutMs` defaulting to the MCP SDK's **own** constant. Rejected (design-minimalism
    owner-point A; the no-uninvited-resource-bounds house rule): an invented `30000` is inconsistent with
    the spec's own injectable-liveness pattern (`deps.graceMs`), stricter than the SDK's own request bound,
    and too short for legitimately slow MCP servers (build/test/scrape), which would surface a
    correct-but-slow tool as failed. `deps.mcpTimeoutMs` defaults to the MCP SDK's own
    `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (`@modelcontextprotocol/sdk@1.29.0`
    `dist/esm/shared/protocol.js:8`, applied `:712`; cjs `:12`/`:716`) — a cited SDK value, never an
    invented number — and applies to connect, each `tools/list` page, **and** `tools/call` (§4.1, §9.3);
    it is injectable liveness, not a data cap, so a host can raise or remove it.

---

## 13. Test plan — traceability matrix

All tests run under `tsx --test` (`packages/acp-agents` convention) and use the §4.1 DI seam
(`runAcp({ deps, stream })`) — no external credentials except the gated live leg (§13.4). Every row
cites the normative statement it covers.

### 13.1 Unit / bootstrap

| # | covers | assertion |
|---|---|---|
| T1 | §3, invariant 1 | `pi-acp --version` writes only the version to stdout and exits 0; with a bin that logs on import, stdout stays clean (redirect precedes the dynamic import) |
| T2 | §3.1 | runtime `await import("@automatalabs/pi-acp")` yields the **value** exports `runAcp`/`PiAcpAgent`/`resolveDeps` (each `typeof === "function"`), `PiAcpDeps` is **absent** at runtime, and neither `console` nor stdio was mutated (no server started) |
| T2b | §3.1 | compile-time: a `.test-d.ts` does `import type { PiAcpDeps }` and type-asserts its shape; `tsc --noEmit` passes (the erased type-only export exists) |
| T3 | §3.2 | double `shutdown()` disposes once (awaited); `connection.closed` **resolve** → exit 0 and **reject** → exit 1; SIGINT/SIGTERM → exit 0; a `runAcp()` startup throw → exit 1; teardown timeout still exits |
| T4 | §6.1 | ContentBlock fold: multi-text join, image→`options.images` (base64 `data` passed as-is), resource_link/resource/audio projections, empty-input → `empty_prompt` (`-32602`); **image-only input (empty text, ≥ 1 image) is accepted** and reaches pi as `prompt("", { images })` (agent-session.ts:1167-1169), not rejected; a structurally-malformed block is rejected by the SDK `zPromptRequest` parser pre-handler (no `invalid_content` errorKind — the handler never sees it, row 8) |
| T5 | §6.3/§6.3.1 | live translation row-by-row incl. `agent_thought_chunk` for thinking; the SOLE `tool_call` pending comes from `tool_execution_start` and the SOLE terminal `tool_call_update` from `tool_execution_end` (translator-owned); `toContent(result)` text+image mapping, `rawOutput = result.details` (omitted when `undefined`), empty-content → empty array, **no** `type:"diff"`; an **exhaustive switch** over `AgentSessionEvent` has no unhandled arm — **`agent_end`, and `assistantMessageEvent` `done`/`error`, produce no update** (terminal outcome read from the terminal message per §7/§8) — plus the rest of the "no fabricated" set |
| T6 | §6.5 | per-turn `PromptResponse.usage` field map + multi-message accumulation; `usage_update.used` = `getContextUsage().tokens`, `cost.amount` = cumulative `getSessionStats().cost`; **cost.amount monotonic across two turns, and a compaction-drop turn where `used` DECREASES while `cost.amount` rises**; per-outcome usage (provider-error emits before reject; pre-flight emits none; **notify-failure emits none**; forced-cancel best-effort) |
| T7 | §7 | stopReason table `stop\|length\|toolUse\|aborted\|error` → `end_turn\|max_tokens\|end_turn\|cancelled\|REJECT`; error rejects, never a stopReason |
| T8 | §8.1/§8.2 | **every canonical row (1–26)**: pinned code + `errorKind`; the **exact adapter-owned wire shape** `{ code, message:<SDK prefix>, data:{ errorKind, message:<fixed label> } }` (+ `server` for 16/17, `details` for 4/23); a structurally-malformed prompt block → SDK `zPromptRequest` `invalidParams`, **no** `errorKind` (row 8); `$/cancel_request` during an opening transaction → **`-32800`** with the transaction rolled back (row 25); `close` on unknown/tombstoned id **succeeds** (not row 12/14); row-23 catch-all → `internal_error`; classification precedence (auth>billing>rate>generic); **redaction sentinel: a terminal error whose diagnostic `error.message` AND `error.stack` carry a sentinel secret → the secret is in NONE of `error.message`/`data.message`/`data.details`, and `data.details` is only the `{ type, timestamp }` projection** |
| T9 | §5.1/§5.2 | `initialize` advertises exactly `thinkingLevel` (no `model` option); set thinkingLevel valid/invalid/wrong-type; **echoed `thinkingLevel.currentValue` reflects the model's clamp, and a model switch re-clamps it**; set model hit/miss/busy; **a known model whose auth is unconfigured (`hasConfiguredAuth === false`) → `authRequired` (`-32000`, `auth_error`), not `invalidParams`**; **no model selected → `invalid_model` (`-32602`), not auth**; **journal-restored `thinkingLevel`/`model` precedence** (restored value is initial, a later set wins and persists); unknown configId |
| T10 | §5 | `initialize` returns the exact `agentCapabilities` (loadSession top-level; resume/fork/list/close; `mcpCapabilities:{}`; `_meta` namespace; no delete; no additionalDirectories) |
| T11 | §9.2 | permission wire order + exactly-once: for each `toolCallId`, the pending `tool_call` (from `tool_execution_start`) is on the wire **before** `session/request_permission` (drain enforced), and the wrapper emits **no** `session/update`; exactly one pending + one terminal `tool_call_update` on **every** path — allow_once, allow_always, reject_once, **unknown/missing `optionId` → fail-safe deny**, cancelled-outcome, turn-abort-wins-race, transport-failure(fail-safe deny, turn continues), inner-hook block, inner-hook throw; **wrapper delegates to `inner` after BOTH a fresh allow AND an `allow_always` cache hit** (a cache hit combined with an inner block/throw still blocks); `allow_always` name-scoped single-session cache skips only the round-trip |
| T12 | §9.4 | outputSchema armed only when `_meta.outputSchema` present; non-object schema → `invalid_output_schema`; capture → final `agent_message_chunk`; `finally` disarms after auth throw / cancel / notify failure; mixed structured/unstructured sequence; the reserved `__acp_structured_output` **absent** from an injected `getAllTools` (e.g. filtered out) → `structured_tool_collision` (absence, not pre-existence) |
| T13 | §9.5 | six auth methods advertised **unconditionally** (incl. when client sends no `auth` capability), each with its **exact pinned `id` + `name`** payload; `authenticate(env_var/agent)` no-op success; `pi-stored-credentials` is `agent`-typed ambient-disk (no interactive login); unknown method → `unknown_auth_method` |

### 13.2 Integration (scripted ACP client over the injected stream)

| # | covers | assertion |
|---|---|---|
| T14 | §6.2/§6.2.1, §6.6 | full turn: ordered `session/update` stream drained before `PromptResponse`; a notify-failure fixture aborts + **rejects `notification_error` (settlement input 3) with NO `usage_update`/`drain`**; a close racing an in-flight prompt still emits `usage_update`+`drain`+resolves `cancelled` **before** the queue is torn down (teardown-waits-for-settlement) |
| T15 | §9.1.0-.6 | lifecycle + concurrency matrix: new→prompt→close; **two concurrent `load`s for one id** → exactly one wins, the other `session_already_open`, no leak (atomic reservation); unknown id (load/resume/prompt) → `unknown_session`; `close` on unknown/already-closed/**tombstoned** id → **success**, and **close whose `dispose()` throws → still success (entry dropped, retry clean)**; close-races-prompt → cancelled; busy fork/set_config → `session_busy`; cwd validation on **new/fork-target**/load/resume/list; **the same injected `deps.modelRegistry` object is passed on ALL FOUR `createAgentSession` call sites**; **open-time races: `$/cancel_request` during open → `-32800` + rollback (no leak); `close` during an opening txn → success + rollback (no resurrection); `dispose()` during an opening txn → rollback (no post-dispose commit)** |
| T15b | §9.1.0 | transactional rollback: inject a failure after **each** acquisition stage (MCP connect, `createAgentSession`, wrapper install, load replay-`notify`) and assert no live registry entry, no MCP child, no listener, no pi resource (pi `dispose()` called), and no `opening` reservation remains; a post-rollback retry is a clean open, not `session_already_open`; **the irreversible-fork case: after `forkFrom` writes successfully, inject a `createAgentSession` failure → the new JSONL remains a complete, valid, listable/loadable session while no live/opening/MCP resource leaks** |
| T16 | §9.1.2/.3/.4 | resume emits **no** replay; load replays the linear branch via the **total** SessionEntry/AgentMessage projection — user, assistant (text/thinking/toolCall), toolResult, `bashExecution`, `custom` display-true/false, `branchSummary`/`compactionSummary` (no update), `custom_message` display-true/false, and string-vs-array content; fork round-trips over a temp `sessionDir`, including **cross-cwd** source lookup via `listAll`; **fork of a live never-prompted (unpersisted) source → `session_not_forkable` (row 26), not `session_corrupt`** |
| T17 | §9.1.5 | list with cwd vs `listAll` (no cwd); exact cursor codec (`base64url` of decimal offset, page 100) + `nextCursor` set/omitted; missing/empty cursor → offset 0; `offset===length` → empty page; undecodable / non-canonical → `invalid_cursor`; **a shrink-below-cursor mutation (150 → page-1 cursor 100 → remove 60 → length 90) returns an EMPTY page, NOT `invalid_cursor` or a crash** |
| T18 | §9.1.6 | poisoned/tombstoned reopen after backstop → `session_terminated`; `close` on it still succeeds |
| T19 | §9.1.7 | non-empty `additionalDirectories` accepted and ignored on **new AND load AND resume AND fork** (session still created; extra roots ignored) |
| T20 | §9.3 | stdio stub MCP: tools appear as pi customTools under **unconditional** `mcp__server__tool` aliases + `tools/call` round-trips (on new AND on load/resume/fork); **multi-page `tools/list` (server returns a `nextCursor`) enumerates ALL pages — no tool lost — and a repeated/cycling cursor → `mcp_init_error`**; **result conversion covers every `CallToolResult` member — text/image/audio(→text note)/resource_link(→link)/embedded(text|blob), `structuredContent`→`rawOutput`, and `isError:true`→failed tool with a FIXED (non-raw) thrown message**; partial-init rollback disconnects earlier clients + rejects `mcp_init_error`; **duplicate server name → `mcp_init_error`**; alias-vs-alias → deterministic `_2` suffix, **and a 128-char-boundary collision keeps the full suffix within 128 chars**; a missing injected `mcp__` alias in an injected `getAllTools` → `mcp_init_error`; non-stdio → `unsupported_mcp_transport`; connect/list/call bounded by injected `mcpTimeoutMs` (hung connect → rollback+reject **and the spawned child is closed**; hung call → failed tool); **a late resolve/reject of a timed-out connect/list/call produces NO unhandled rejection (detached)** |

### 13.3 Hermetic e2e

| # | covers | assertion |
|---|---|---|
| T21 | §4.1 | inject a `createAgentSession` that wraps `new Agent({ streamFn: mockStream })` in an `AgentSession`; drive a full ACP conversation end-to-end with **zero credentials** — the substrate for future engine e2e; the spy asserts the injected `deps.modelRegistry` identity is threaded on every `createAgentSession` call |
| T22 | §9.6/§6.2.1 | `deps.sleep`/`deps.graceMs`-driven backstop against a **wedged** mock stream, driven **separately** per abort source: the **three cooperative sources** (`$/cancel_request`, `session/cancel`, `session/close`) each **force-resolve `cancelled`** when the injected `sleep` elapses (emit `usage_update`, tombstone, call pi `dispose()`); the **notify-failure** source instead **rejects `notification_error` (row 22) as the settlement, with the later backstop performing cleanup-only (no second settlement) and no `usage_update`**; every source produces **no** unhandled rejection when the detached pi promise later settles; a **non-wedged** abort (turn settles first) takes the normal path (sleep cancelled) |

### 13.4 Live e2e (gated on provider keys)

| # | covers | assertion |
|---|---|---|
| T23 | §9.4.3 | one cheap-model leg through the full runner (custom backend registered `{ namespace:"@automatalabs/pi-acp", gatedKeys:["outputSchema"] }`), asserting a real structured-output turn validates. Gated on an env key; skipped in credential-free CI (`ci.yml:54-57`). |

### 13.5 Packaging / integration guards

| # | covers | assertion |
|---|---|---|
| T24 | §2.3 | manifest pins are exact (no caret); `main`/`exports`→`dist/lib.js`, `bin`→`dist/index.js`; packed `files:["dist"]` |
| T25 | §10.1 | `check-acp-deps.mjs` matches `@earendil-works/pi-coding-agent` (freshness matcher) |
| T26 | §10.3, §15 | root `tsconfig.json` references `packages/pi-acp`; a changeset exists |
| T27 | §15 | `README.md` exists and (a string/section assertion) covers every required topic: `pi-acp` bin invocation, the side-effect-free library API (`runAcp`/`PiAcpAgent`/`resolveDeps`/`PiAcpDeps`), the custom-backend registration `{ namespace:"@automatalabs/pi-acp", gatedKeys:["outputSchema"] }`, the `provider/id` model format, auth behavior (env-var/stored-credentials + the `-32000` pause), the reserved `mcp__`/`__acp_` tool namespaces, the v1 limitations list, and the "Built on pi" + THIRD-PARTY MIT notice |

The round-1 "http MCP rejected by capability gating" assertion is **removed** — that tested our client,
not this server; T20's `unsupported_mcp_transport` is the server-side behavior instead.

---

## 14. References (verified file:line + version pins)

**Base commit (this repo), all `packages/…`/`scripts/…`/`docs/…`/config citations verified against:**
`c06d1e3a5a4363d42b892df1d4d12a5e9c5b94b2` (branch `spec/pi-acp`, based on `origin/main`).

**Base-freshness note:** at freeze-revision authoring `origin/main` has advanced to
`06e0dcb53c0d1bf8d18d669faa64c1577b587f3f` (from `e9c94aa…` at round 3). `git diff c06d1e3..origin/main
--name-status -- packages/acp-agents packages/shared-types scripts/check-acp-deps.mjs docs/specs` is a
**single addition** — `A docs/specs/pause-recovery-continuation-spec.md`, a new sibling spec this contract
does **not** cite. It touches **none** of `packages/acp-agents`, `packages/shared-types`,
`scripts/check-acp-deps.mjs`, the three cited `docs/specs/*` files (`config-options.md`,
`model-resolution-determinism.md`, `acp-auth-spec.md` — all verified untouched), or the config files this
contract cites. All citations below therefore remain byte-accurate; the base is pinned at `c06d1e3` (the
merge-base this branch builds on, matching `.agentprism/design-198/base-sha.txt`).

**pi source, all `packages/{ai,agent,coding-agent}/…` citations verified against:** repo
`github.com/earendil-works/pi`, tag **`v0.80.7`**, commit
**`818d67457cdd6b60bce6b121d16b23141c252dd8`**; npm `@earendil-works/pi-coding-agent@0.80.7`
(lockstep with `@earendil-works/pi-agent-core@0.80.7`, `@earendil-works/pi-ai@0.80.7`). Freshness
re-checked at the freeze revision: `releases/latest` = `v0.80.7`, `npm view … version` = `0.80.7` — pin is
current. pi's **unreleased** `origin/main` (`c6d8371`) has meanwhile drifted heavily across the cited
model/auth/session surfaces; that forward-compatibility risk is recorded in **§0.1** and does not change
the frozen release pin.

**ACP SDK, `@agentclientprotocol/sdk@1.2.1`**, verified against the installed dist at
`node_modules/.pnpm/@agentclientprotocol+sdk@1.2.1_zod@4.4.3/node_modules/@agentclientprotocol/sdk/dist/`.
`npm view @agentclientprotocol/sdk version` = `1.2.1` — pin is current. **Blueprint:**
`@agentclientprotocol/claude-agent-acp@0.59.0` (installed). **MCP client:**
`@modelcontextprotocol/sdk@1.29.0`, verified against the installed dist (`DEFAULT_REQUEST_TIMEOUT_MSEC`,
the `CallToolResult`/`ContentBlock` unions, the paginated `tools/list`, and the stdio client — sub-section
below); `npm view @modelcontextprotocol/sdk version` = `1.29.0` — pin is current. Re-verify at
implementation time per §0.

### This repo (base `c06d1e3`)

- `packages/acp-agents/src/capabilities.ts` — `supportsLoadSession` :104-105, `supportsResumeSession`
  :109, `supportsForkSession` :108, `GATED_CUSTOM_META_KEYS` :45-49, `gateCustomMeta` :198-213,
  `unsupportedMcpServer` (stdio serviceable; http/sse gated once `mcpCapabilities` exists) :278-300,
  `describeClientAuthAdvertisement` :161-172, unsupported-block degrade :241-271.
- `packages/acp-agents/src/acp-client.ts` — `assertLifecycleSupported` :1220-1235, `selectModel` →
  `applyConfigOption("model", …)` :1972-1974, `applyConfigOption` (no advertisement check; boolean→`type`
  discriminator) :1986-1993, `newSession` (sends `mcpServers`) :1533, `forkSession` (defined :1564, sends
  `mcpServers`) :1587, `reattachSession` (defined :1620; load :1555/resume :1560 route through it, sends
  `mcpServers`) :1647.
- `packages/acp-agents/src/protocol-coverage.ts` — `ACP_AUTH_REQUIRED_CODE_EXCLUSIVE = -32000`
  :152-154, auth `_meta` convention keys :143-147.
- `packages/acp-agents/src/structured-output.ts` — `parseFinalJson` :47-64, `resolveStructuredOutput`
  ladder :125-161.
- `packages/acp-agents/src/usage.ts` — field-mapping doc :7-17, `UsageAccumulator.toAgentUsage`/`recordCost`
  :28-72.
- `packages/acp-agents/src/permissions.ts` — `decidePermission` + option-kind orders :88-135,
  `candidateNames`/`_meta.*.toolName` :164-186.
- `packages/acp-agents/src/errors-map.ts` — `ACP_AUTH_REQUIRED_ERROR_CODE` :17, `OTHER_RESERVED` :23,
  `isAcpAuthRequired` (code-only `-32000`) :135-146, `errorText` fold of `data.message`/`data.details`
  strings :33-46, `errorDataText` (reads string `data.message`/`data.details`) :63-71 — grounds the
  §8.1 canonical `data.message` fixed-label shape.
- `packages/acp-agents/src/backends/codex.ts` — `customCapabilities { namespace, gatedKeys }` :34-37,
  `classifyProviderError` :39-51, `spawnConfig` bin ladder :53-66, `promptMeta` outputSchema :80-83,
  `nativeStructured` :85-90.
- `packages/acp-agents/src/backends/custom.ts` — `embedSchemaInPrompt = true` :33, `customCapabilities`
  field :35-40, `promptMeta` → `{ [META_KEYS.outputSchema]: toJsonSchema(schema) }` :72-78,
  `nativeStructured` → `parseFinalJson(finalMessageText())` :80-84.
- `packages/acp-agents/src/registry.ts` — `customCapabilities { namespace, gatedKeys }` type :25-27,
  non-empty `namespace` check :149-150, non-empty `gatedKeys` check :153-161.
- `packages/acp-agents/src/runner.ts` — `shouldInjectStructuredOutputTool` :1286-1293 →
  `supportsStructuredOutputToolTransport` (http gate) :1294-1296, `applyModelSelection` :1309-1316,
  `assertNoModelConfigOption` :1319-1329, `resolveModelRoute` (prefix strip) :1356-1370.
- `packages/shared-types/src/meta.ts` — `META_KEYS.outputSchema` :7-13, `CODEX_META_KEYS` :19-24,
  `CODEX_CUSTOM_CAPABILITY_NAMESPACE` :36.
- `scripts/check-acp-deps.mjs` — `ACP_DEP_MATCHERS` :34-37, `WRAPPED_RUNTIMES` :53-55.
- `docs/specs/config-options.md` — bracket-syntax removed / effort via configOptions :14-15,
  `configOptions` authoring surface §2.1 :26-41, probe API §2.2 :54-74, validate-time surfacing +
  select-choice check §2.3 :78-101.
- `docs/specs/model-resolution-determinism.md` — verbatim selection / no bracket parsing :36,
  `bracketTokens()`/`applyModelModifiers()` removed → "nothing" :56.
- `docs/specs/acp-auth-spec.md` — env_var always visible / base-spec-first §1.2, custom-agent
  conformance profile §3.5.
- `packages/acp-agents/package.json` (packaging/exports/publishConfig blueprint),
  `packages/mcp-server/package.json` (bin/main→lib/publishConfig blueprint), `tsconfig.json`
  (references), `pnpm-workspace.yaml`, `.changeset/config.json`, `.github/workflows/ci.yml` (node 24
  :36, test steps :48-57).

### `@agentclientprotocol/sdk@1.2.1` (`dist/…`)

- `schema/types.gen.d.ts` — `ContentBlock` (text/image/audio/resource_link/resource) :236-246,
  `RequestPermissionRequest` :108, `ToolCall`/`ToolCallUpdate` :140-186, `ToolKind` :196,
  `ToolCallStatus` :204, `ToolCallLocation` :568, `PermissionOption` :591, `PermissionOptionKind` :624,
  `SessionUpdate` union (incl. `user_message_chunk` :3437, `usage_update` :3461) :3436-3462,
  `SessionNotification` :3409, `StopReason` :3027, `PromptResponse` (usage) :2996-3021, `Usage`
  (inputTokens/outputTokens/cachedReadTokens/cachedWriteTokens/totalTokens/thoughtTokens) :3037-3075,
  `Cost` (`amount` = "Total cumulative cost for session") :3928-3947, `UsageUpdate` (`used` = "Tokens
  currently in context", `size`, `cost`) :3951-3985, `AuthMethod` :2159, `AuthMethodEnvVar` :2221,
  `AuthEnvVar` :2177, `AuthMethodTerminal` :2264, `AuthMethodAgent` :2303, `AgentCapabilities` :1455,
  `AgentCapabilities.additionalDirectories` :1624-1634, `AuthCapabilities` (`terminal?` only) :4318,
  `AgentAuthCapabilities` :1787, `PromptCapabilities` :1537, `McpCapabilities` :1567,
  `SessionCapabilities` :1608, `NewSessionResponse` :2556, `SessionConfigOption` :2643,
  `SessionConfigSelect` :2760, `SetSessionConfigOptionRequest` :5031, `SetSessionConfigOptionResponse`
  :2975, `ListSessionsRequest` (type header :4852, `cwd?` :4856, `cursor?` :4860), `ListSessionsResponse`
  (`nextCursor?` :2816) :2807, `ForkSessionRequest` (header :4907, **`cwd` (target, required) :4915**),
  `McpServerStdio` :4779, additionalDirectories on new/load/fork/resume :4633,4831,4923,4964.
- `dist/acp.d.ts` — `methods` registry :17-79, `agent()` builder :588, `AgentApp.onRequest` :637,
  `AgentContext` (generic `request(method, params, options?: SendRequestOptions)` :188-189, `notify` :196)
  :142-197, `AgentHandlerContext { params, signal (aborts on `$/cancel_request`), client }` :367-382,
  `AgentRequestContext` (+`requestId`) :385-391, `SessionCapabilities` re-export, `AgentSideConnection`
  :735 (named `sessionUpdate` :765 / `requestPermission` :778).
- `dist/jsonrpc.d.ts` / `dist/jsonrpc.js` — `SendRequestOptions.cancellationSignal` ("aborting sends
  `$/cancel_request`; cancellation is cooperative — promise still settled by the peer") jsonrpc.d.ts
  :64-72; `CANCEL_REQUEST_METHOD = "$/cancel_request"` jsonrpc.js:1; `handleProtocolNotification` aborts
  the incoming request's controller with `RequestError.requestCancelled({ requestId })` (`$/cancel_request`
  only) jsonrpc.js:640-652; `abortErrorToRequestCancelled(error, signal)` :124-129 (called by
  `errorToRequestResult` :120-123; returns `requestCancelledError` :114-119) converts an aborted handler's
  abort-throw into a `-32800` result — grounds error-table row 25; `class RequestError extends Error`
  :764, `constructor(code, message, data)` :770-780 (top-level `error.message` is the reserved-code
  prefix; `error.data` is the `data` object), static ctors take `(data, additionalMessage?)`
  (parseError :783 … authRequired :821 … resourceNotFound :827) — grounds the §8.1 canonical shape;
  per-request `AbortController` in `toIncomingMessage` :589-603.
- `dist/acp.js` — `prompt: requestSpec(session_prompt, validate.zPromptRequest)` :599 (the SDK
  Zod-parses `PromptRequest` and rejects malformed content with `invalidParams` **before** the handler,
  grounding error-table row 8).
- `dist/examples/agent.js` — per-session `pendingPrompt` `AbortController` created in `prompt` :41-42 and
  aborted in the `session/cancel` handler :215-216 (`.onNotification("session/cancel", …)` :230) — the
  reference pattern for §9.6's session/cancel-is-separate handling.
- `dist/stream.d.ts` — `ndJsonStream` :30.
- `dist/jsonrpc.js` — `RequestError` static constructors (at their `static` line): parseError -32700
  :783, invalidRequest -32600 :789, methodNotFound -32601 :795, invalidParams -32602 :803, internalError
  -32603 :809, requestCancelled -32800 :815, **authRequired -32000 :821**, resourceNotFound -32002 :827.

### `@agentclientprotocol/claude-agent-acp@0.59.0` (blueprint, `dist/…`)

- `dist/index.js` — console redirect (log/info/warn/debug→error) :53-56, `runAcp()` :60, shutdown +
  `connection.closed`/SIGTERM/SIGINT + `stdin.resume()` :61-84; `agent.dispose()` awaited in shutdown.
- `package.json` — `bin.claude-agent-acp` = `dist/index.js`, `main` = `dist/lib.js`, `types` =
  `dist/lib.d.ts`, `exports["."]` → `dist/lib.js` (the bin/lib split blueprint for §2.3/§3.1).
- `dist/acp-agent.js` — imports `agent as acpAgent, methods, ndJsonStream, RequestError` :1,
  `errorKindData(errorKind) => { errorKind }` :4113, `RequestError.authRequired()` :2036,2391,
  `RequestError.internalError(errorKindData(...), …)` :2044,2080.
- `dist/lib.js` — `runAcp`/`ClaudeAcpAgent` library exports :2.

### pi `v0.80.7` (commit `818d674`)

- `packages/coding-agent/package.json` — name `@earendil-works/pi-coding-agent`, `bin { pi:
  dist/cli.js }`, `exports { ".", "./rpc-entry" }`, `engines.node >=22.19.0`, deps
  pi-agent-core/pi-ai/pi-tui `^0.80.7` + `typebox 1.1.38`.
- `packages/coding-agent/src/core/sdk.ts` — `CreateAgentSessionOptions` :34-83 (cwd, agentDir,
  authStorage, **`modelRegistry?` :43**, model, thinkingLevel, tools/excludeTools/customTools,
  sessionManager; **no** beforeToolCall/streamFn), **`CreateAgentSessionResult { session, extensionsResult,
  modelFallbackMessage? }` :86-93** (the real return type — `.session` is the `AgentSession`),
  `createAgentSession(): Promise<CreateAgentSessionResult>` :167-406 (`const modelRegistry =
  options.modelRegistry ?? ModelRegistry.create(...)`; `return { session, extensionsResult,
  modelFallbackMessage }` :402), `registry.find` :197, internal `streamFn` + `getApiKeyAndHeaders`
  :302-303, `buildSessionContext` restore :188-204, `findInitialModel` :207-222,
  `new AgentSession({ agent, sessionManager, customTools, … })` :385-399.
- `packages/coding-agent/src/index.ts` — public exports of `AgentSession`/`AgentSessionEvent` :15-27,
  `createAgentSession*` :204-207, `ModelRegistry` :172, `SessionManager` :240.
- `packages/coding-agent/src/core/agent-session.ts` — `AgentSessionEvent` union :127-155,
  `AgentSessionEventListener = (e) => void` :156, `PromptOptions { images?, streamingBehavior?, … }`
  :204-215, `readonly agent: Agent` :270, `_eventListeners` :278, constructor `_installAgentToolHooks()`
  at :361 (sets `agent.beforeToolCall` at :424), `_emit` (synchronous, no await) :501-505, `subscribe`
  :762, `getActiveToolNames` :861, `getAllTools(): ToolInfo[]` (name + `sourceInfo.source`) :868,
  `getToolDefinition` :878, `setActiveToolsByName` :888, `dispose(): void` (abortRetry/Compaction/Bash +
  `agent.abort()` + extension invalidate + disconnect + `cleanupSessionResources`) :799-816,
  `_refreshToolRegistry` (builtins `Map`, then `Map.set` over `[...extensionTools, ...customTools]`)
  :2459-2463 (in :2397-2489), `prompt` :1076-1224 (sync auth throws
  :1140-1154, busy-throw :1121-1126, **user-message build `userContent = [{ type:"text", text:
  expandedText }, ...images]` :1167-1169** — grounds image-only prompts, §6.1), `_runAgentPrompt`
  finally→`agent_settled` :1023-1034,
  `_handlePostAgentRun` :1037-1069, `_isRetryableError` :2577, `setModel` :1537-1552 (sync no-auth throw
  :1538-1540), `setThinkingLevel` :1630-1640 (clamp :1632), `getContextUsage` :3078-3110
  (`ContextUsage.tokens` = current context, drops on compaction — NOT monotonic),
  `getSessionStats` :3023-3076 (cumulative `cost`/`tokens`, `contextUsage`; `cost` monotonic).
- `packages/coding-agent/src/core/auth-guidance.ts` — `formatNoModelSelectedMessage` :18-20,
  `formatNoApiKeyFoundMessage` :22-25 (ground the §8.2 pre-flight predicates); OAuth "Authentication
  failed for … Run '/login" throw at `agent-session.ts:1144-1150`.
- `packages/coding-agent/src/core/auth-storage.ts` — `AuthStorage.create(authPath?)` :215.
- `packages/agent/src/agent.ts` — `Agent` ctor + `streamFn`/`beforeToolCall`/`afterToolCall`
  :101-106,171-219, `streamFn` injection :214, `subscribe` :241, `steer` :274, `followUp` :279,
  `hasQueuedMessages` :300, `abort` :310-311, `waitForIdle` :319, `prompt`/`continue` (busy-throw)
  :335-348.
- `packages/agent/src/agent-loop.ts` — `tool_execution_start` emitted **before** `prepareToolCall`
  (sequential :447-454, parallel :502-509, truncated :389-396); `prepareToolCall` runs
  `config.beforeToolCall` :602,621-643 (block → immediate error result :639-642; abort → :629-635);
  `executePreparedToolCall` emits `tool_execution_update {partialResult}` :672-696; `emitToolExecutionEnd`
  (one per call, every path) :764-772; `createErrorToolResult` = `{content:[{type:text}],details:{}}`.
- `packages/agent/src/types.ts` — `BeforeToolCallResult { block?, reason? }` :60-63,
  `BeforeToolCallContext { assistantMessage, toolCall, args, context }` :89-98, **`AgentMessage = Message |
  CustomAgentMessages[keyof CustomAgentMessages]` :314**, `AgentEvent` union
  (`message_update { message, assistantMessageEvent }`; `tool_execution_start { toolCallId, toolName,
  args }`; `tool_execution_update { …, partialResult }`; `tool_execution_end { …, result, isError }`)
  :415-430, `ThinkingLevel` (off,minimal,low,medium,high,xhigh,max) :289.
- `packages/agent/src/harness/messages.ts` — `BashExecutionMessage` :19-29, `CustomMessage
  { role:"custom", content:string|(text|image)[], display, details? }` :31-38, `BranchSummaryMessage`
  :40-45, `CompactionSummaryMessage` :47-52, `CustomAgentMessages` declare-module :54-61,
  `bashExecutionToText` :63-80 (grounds the replay projection of §9.1.2).
- `packages/ai/src/types.ts` — `TextContent` :327, `ThinkingContent` :333, `ImageContent { type:"image",
  data, mimeType }` :343, `ToolCall { id, name, arguments }` :349, `Usage` :357-379, `StopReason`
  (stop|length|toolUse|error|aborted) :380, `UserMessage { role:"user", content: string | (TextContent |
  ImageContent)[] }` :382-386, `AssistantMessage { content: (TextContent | ThinkingContent | ToolCall)[],
  usage, stopReason, errorMessage, diagnostics? }` :388-401, `ToolResultMessage<TDetails> { toolCallId,
  toolName, content: (TextContent | ImageContent)[], details?, isError }` :403-418, `Message = UserMessage
  | AssistantMessage | ToolResultMessage` :419, `AssistantMessageEvent`
  (text/thinking/toolcall start/delta/end; `done {reason: stop|length|toolUse}`; `error {reason:
  aborted|error}`) :464-476.
- `packages/ai/src/utils/diagnostics.ts` — `DiagnosticErrorInfo { name?, message, stack?, code? }` :1-6,
  **`AssistantMessageDiagnostic { type, timestamp, error?, details? }` :8-13** (no `text` member —
  grounds §8.2's corrected haystack + redaction), `extractDiagnosticError` copies the caught error's raw
  `message` **and `stack`** :21-30, `createAssistantMessageDiagnostic` :32-38.
- `packages/coding-agent/src/core/session-manager.ts` — `SessionEntryBase` :46-52, entry interfaces
  (`SessionMessageEntry` :53-57, `ThinkingLevelChangeEntry` :58-61, `ModelChangeEntry` :63-67,
  `CompactionEntry` :69-79, `BranchSummaryEntry` :80-89, `CustomEntry` :100-104, `CustomMessageEntry`
  :131-138, `LabelEntry` :107-111, `SessionInfoEntry` :114-117), `SessionEntry` union :140-152,
  `SessionTreeNode` :155-162, `SessionInfo { path, id, cwd, name?, parentSessionPath?, created, modified,
  messageCount, firstMessage, allMessagesText }` :170-184, `SessionContext { messages, thinkingLevel,
  model }` :164-168, `getSessionId()` :938, `getSessionFile(): string | undefined` :942, `_persist`
  (lazy — no JSONL until an assistant message exists, `openSync(..., "wx")`) :946-977, free
  `buildSessionContext(...)` :457, `listSessionsFromDir` :747, method `buildSessionContext()` :1213,
  `getBranch(fromId?)` :1189, `getTree()` :1239, `static create(cwd, sessionDir?, options?)` :1441,
  `static open(path, sessionDir?, cwdOverride?)` :1452, `static forkFrom(sourcePath, targetCwd,
  sessionDir?, options?)` :1490 (eager `writeFileSync(..., { flag:"wx" })` + `appendFileSync`;
  empty-source throw `Cannot fork: source session file is empty or invalid` :1498-1500), `static async
  list(cwd, sessionDir?, onProgress?)` :1549 (reads `listSessionsFromDir`, sorts by `modified` desc
  :1553-1558), `static async listAll(sessionDir?, onProgress?)` :1564-1566 (all project dirs); **no**
  delete/unlink/remove method (verified absent).
- `packages/coding-agent/src/core/extensions/types.ts` — `ToolDefinition<TParams extends TSchema>`
  (`parameters: TParams`) :437-449, `defineTool` :495, `ContextUsage { tokens: number|null,
  contextWindow, percent }` :283-289.
- `packages/coding-agent/examples/extensions/structured-output.ts` — terminating tool pattern
  (`defineTool` + `execute` returning `{ content, details, terminate: true }`).
- `packages/coding-agent/src/core/model-registry.ts` — `static create` :391, `find(provider, modelId)`
  :695-696, `hasConfiguredAuth` :702, `getApiKeyAndHeaders` :745, `isUsingOAuth` :860.
- `packages/ai/src/env-api-keys.ts` — `getApiKeyEnvVars` provider→env catalog (ANTHROPIC_API_KEY(+OAuth
  :71), OPENAI_API_KEY :76, GEMINI_API_KEY :80, XAI_API_KEY :84, OPENROUTER_API_KEY :86, …) :64-110,
  `findEnvKeys` :120-122.
- `packages/ai/src/compat.ts` — `getModel`/`getModels` (`@deprecated`) :61-65.
- `packages/ai/src/providers/all.ts` — `getBuiltinModel` :53, `getBuiltinModels` :65.
- `packages/ai/src/api/openai-completions.ts:1110`, `bedrock-converse-stream.ts:918`,
  `google-shared.ts:283-284`, `mistral-conversations.ts:491` — providers consume `tool.parameters` as
  raw JSON Schema (symbol keys stripped), grounding the outputSchema-as-parameters injection (§9.4).

### `@modelcontextprotocol/sdk@1.29.0` (MCP client, installed dist; version confirmed 1.29.0)

- `dist/esm/shared/protocol.js` — **`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` :8**, applied as
  `options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC` :712 (cjs `dist/cjs/shared/protocol.js` :12 / :716)
  — grounds the `deps.mcpTimeoutMs` default (§4.1, §9.3, §12.17); `Protocol.close()` :500.
- `dist/esm/types.js` — `CallToolResultSchema` :1289 `{ content: z.array(ContentBlockSchema).default([]),
  structuredContent?: z.record(...), isError?: z.boolean() }`; `ContentBlockSchema` five-member union
  `[TextContent, ImageContent, AudioContent, ResourceLink, EmbeddedResource]` :1131-1137
  (`AudioContentSchema` :1057, `EmbeddedResourceSchema` :1107, `ResourceLinkSchema` :1125);
  `ListToolsResultSchema = PaginatedResultSchema.extend({ tools })` :1283 and
  `PaginatedResultSchema.nextCursor?` :612 — grounds the total content projection (§9.3.3) and paginated
  `tools/list` (§9.3.1).
- `dist/esm/client/index.js` — `connect(transport, options)` :285, `callTool(params, resultSchema,
  options)` :490, `listTools(params, options)` :565 (cursor-paginated) — the bounded, paginated client
  surface (§9.3.1).
- `dist/esm/client/stdio.js` — `StdioClientTransport` spawns the server child (`spawn(...)` :65) and
  `close()` kills it — grounds the orphan-child cleanup on failed/timed-out connect (§9.3.1).

---

## 15. License and attribution (pi is MIT)

`@automatalabs/pi-acp` depends on and embeds pi (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), which is **MIT** (Earendil Inc. / Mario
Zechner + Armin Ronacher). Obligations, satisfied in-package:

- The MIT license text and copyright notice of the pi packages are retained (they ship in the installed
  dependency's `node_modules`; no source is vendored).
- pi-acp itself is `Apache-2.0` (the monorepo license); Apache-2.0 and MIT are compatible for this
  depend-and-embed relationship. No pi source is copied into pi-acp; the `findJsonBlock`/`extractValidated`
  helpers already in `acp-agents/src/structured-output.ts` were ported from pi under our existing
  attribution and are not re-copied here.

### 15.1 `packages/pi-acp/README.md` — normative published deliverable (resolves adversarial finding 12)

The README is a **required file** (§2.2 layout) and a **published** doc (it ships in the npm tarball).
Because the built-in `PiBackend` is a follow-up (§11), the README is — until that lands — the only
place a consumer learns how to drive the server, so it MUST cover, at minimum (asserted by T27):

- **bin invocation** — `npx @automatalabs/pi-acp` (stdio ACP server; stdout is ACP ndjson only, §3) and
  `pi-acp --version`.
- **library API** — the side-effect-free entry: `runAcp(options?)`, `PiAcpAgent`, `resolveDeps`, and the
  `PiAcpDeps` type; that importing the package starts no server and mutates no console/stdio (§3.1).
- **custom-backend registration** — the exact object a host registers to drive pi-acp through the
  existing generic custom backend: `{ namespace: "@automatalabs/pi-acp", gatedKeys: ["outputSchema"] }`
  (both fields required, §9.4.3).
- **model format** — `"<provider>/<model-id>"` set via the reserved config channel; unknown → `-32602`
  `invalid_model` (§5.2).
- **auth behavior** — the advertised methods (five env-var providers + `pi-stored-credentials`, each with
  its exact `id`/`name`), ambient-credential resolution, and the `-32000` pause **when a selected/resolvable
  model's credential is missing** (the no-model case is `-32602 invalid_model`, not auth — §9.5).
- **reserved tool namespaces** — pi-acp owns the `mcp__` prefix (bridged MCP tools) and
  `__acp_structured_output`; extensions must not squat them (§9.3.2).
- **v1 limitations** — stdio MCP only; no branch-topology/compaction-summary replay; no
  `additionalDirectories`/audio/mid-turn steering/terminal-login; `PiBackend` built-in is a follow-up
  (§11).
- **attribution** — a "Built on pi" note and a THIRD-PARTY notice naming pi
  (`@earendil-works/pi-coding-agent`/`-agent-core`/`-ai`), its authors, its MIT license, and the pinned
  version.

The central backend docs page / authoring skill entry remains the explicitly deferred follow-up (§11,
tied to the `PiBackend` promotion); only this package README is required at v1.
