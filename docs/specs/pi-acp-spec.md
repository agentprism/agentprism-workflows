# `@automatalabs/pi-acp` — In-process ACP Server for the pi Coding Agent

**Date:** 2026-07-16

**Status:** Frozen implementation contract for issue #198. Freeze revision (supersedes rounds 1–3),
closing the terminal adjudication's four blockers, six majors, and five minors as a single coherent
revision: the MCP `tools/call` timeout now defaults to the MCP SDK's own
`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (cited, never invented); a **single turn-settlement state machine**
(§6.2.1) from which §6.5/§9.1.6/§9.6/T22 are derived; a redaction contract that reads pi's real
`AssistantMessageDiagnostic` fields and never forwards `error.message`/`.stack`; every error mapping named
to its producing mechanism (the `setModel` auth precheck) with a canonical `{ errorKind, message }` wire
shape; source-qualified MCP/control extension collision detection; pinned opening-transaction races
(cancel/close/dispose); a categorical empty-live-fork error; mutation-safe cursor pagination; a total MCP
bridge over the pinned SDK (paginated `tools/list`, the five-member `CallToolResult` union, and a
timeout/detach/orphan-child protocol); `allow_always` that still runs the extension chain plus a
fail-safe deny for malformed selections; exact auth-method `name` strings with a narrowed
missing-credential claim; `agent_end`/`done`/`error` totality; and the three corrected SDK line numbers.
This revision builds on round 3, which had already closed the round-2 adversarial-completeness findings
(the pi-main forward-compat note, the real `CreateAgentSessionResult` DI type + shared `modelRuntime`
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
`@earendil-works/pi-coding-agent@0.80.10` (repo `earendil-works/pi` tag `v0.80.10`,
commit `8dc78834cde4e329284cf505f9e3f99763df5529`), `@modelcontextprotocol/sdk@1.29.0`.

---

## 0. Implementation-time re-verification (normative, do this FIRST)

pi releases every ~2–3 days. Before writing any code, the implementer MUST re-run the external
freshness protocol and treat any drift as a stop-and-report discrepancy — never re-implement around a
moved pin silently:

1. Fresh temp clone of `https://github.com/earendil-works/pi`, then `git fetch --tags`.
2. `gh api repos/earendil-works/pi/releases/latest --jq .tag_name` **and**
   `npm view @earendil-works/pi-coding-agent version`; the two MUST agree.
3. Compare against the pin in §14 (`v0.80.10` / `8dc7883` / npm `0.80.10`). **If the pin is no longer the
   latest release, that is a STOP:** re-verify every pi citation in this contract (`sdk.ts`,
   `agent-session.ts`, `session-manager.ts`, `agent.ts`, `agent/types.ts`, `ai/types.ts`,
   `env-api-keys.ts`, `model-registry.ts`, `auth-storage.ts`, `extensions/types.ts`) against the new
   latest, update the exact manifest pins (§2.3) and every changed claim, re-pin §14, and re-open the
   contract for review before building. Do not install "whatever is latest on implementation day" under
   the frozen behavior claims of this document.
4. Re-run `npm view @agentclientprotocol/sdk version`. If it is no longer `1.2.1`, re-verify every SDK
   citation (§14) against the new dist and re-pin §2.3 before building.

The freshness gate (§10.1) enforces the same discipline continuously after landing.

### 0.1 pi v0.80.8 model-runtime erratum (normative)

The implementation-time §0 check found that the model/auth rewrite flagged by the frozen contract had
landed in the **released** pin `v0.80.8` (npm `@earendil-works/pi-coding-agent@0.80.8`, commit
`fae7176cb9f7c4725a40d9d481d8d70b80f18086`). The affected citations were re-verified mechanically:

- `CreateAgentSessionOptions.modelRegistry` is replaced by `modelRuntime?: ModelRuntime`
  (`sdk.ts:39-40`), and `createAgentSession` uses that runtime for restore, initial resolution,
  stream-time auth, and the constructed `AgentSession` (`sdk.ts:171,192-210,307,371-385`).
- The public `AuthStorage` export and `ModelRegistry.create` factory are gone. The canonical default is
  `await ModelRuntime.create({ authPath?, modelsPath? })` (`model-runtime.ts:58-68,130-165`), which owns
  credential storage and model configuration. `ModelRegistry` survives only as a synchronous
  compatibility facade constructed with `new ModelRegistry(runtime)` (`model-registry.ts:16-49`).
- Internal resolution and auth checks now use `ModelRuntime.getModel(provider, id)` and
  `ModelRuntime.hasConfiguredAuth(provider)` directly (`model-runtime.ts:293-295,354-356`).

This erratum changes only the adapter's model/auth dependency seam and the asynchronous construction
needed by `ModelRuntime.create`; the ACP wire contract, error codes, ordering, and lifecycle behavior
remain unchanged.

### 0.2 pi v0.80.9 freshness repin (normative)

The issue #213 implementation-time check found `v0.80.9` / npm `0.80.9` at commit
`2d16f92973230a7e095aa984f150ba8702784f50`. A fresh-clone diff over every §14-cited pi surface found
one additive optional field, `OpenAICompletionsCompat.deferredToolsMode?: "kimi"`, in
`packages/ai/src/types.ts`; the provider-compat interface is not consumed by this contract. Every
load-bearing cited surface is byte-identical to `v0.80.8`, so the runtime pin advances without changing
the ACP wire contract or the claims below.

### 0.3 pi v0.80.10 freshness repin (normative)

The 2026-07-16 dependency-gate check found `v0.80.10` / npm `0.80.10` at commit
`8dc78834cde4e329284cf505f9e3f99763df5529`. The upstream diff `v0.80.9..v0.80.10` touches only
`packages/ai` provider model catalogs (Kimi/Moonshot/xAI/openrouter metadata, pricing, thinking
levels) plus changelogs and lockfiles; no §14-cited surface changed. The runtime pin advances
without changing the ACP wire contract or the claims below.

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
(workspace/changesets/CI/tsconfig). Outside the package, this train updates the ACP freshness gate
(§10.1) and the coordinated `acp-agents` caller/release surfaces (§10.4).

**Out of scope (see §11 Non-goals):** fs/terminal client-delegation; subprocess/RPC mode;
`additionalDirectories`; audio prompt content; branch-topology replay.
Issue #213 consumes this frozen server contract from the first-class `PiBackend`; direct hosts can also
drive the server through the generic custom-backend registry. The freshness-gate edit in §10.1 and the
coordinated `acp-agents` caller/release amendments in §10.4 are the specified out-of-package changes.

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
4. **One in-flight prompt turn per session.** pi's `AgentSession.prompt()` throws when a turn is already
   streaming unless a `streamingBehavior` is supplied (`agent-session.ts:1121-1126`); ACP
   `session/prompt` is serialized per session by construction. The separately negotiated
   `_session/steering` extension (§6.6) injects into that one live turn, or — when the session is
   idle — starts a fire-and-forget turn that occupies the same single turn slot; two concurrent
   turns never exist.
5. **Ordered, drained delivery.** pi's `AgentSession` event bus is **synchronous** — `_emit` calls each
   listener and does not await it (`agent-session.ts:501-505`; listener type is `(e) => void`,
   `:156`). The adapter therefore funnels every translated update through one per-session FIFO send
   queue and **drains it before resolving** the originating request (§6.2), so notifications are never
   reordered and a response never overtakes its own updates.
6. **Truthful, correctly-scoped usage.** `PromptResponse.usage` carries the **per-turn** token
   breakdown mapped from pi's terminal `Usage`; the streamed `usage_update` carries **current context
   tokens** (`used`) and **cumulative session USD cost** (`cost.amount`) — the exact SDK semantics
   (§6.5). These are different quantities and are computed from different pi sources.
7. **Standard structured output over injected MCP.** Pi advertises HTTP MCP support and receives the
   runner's client-hosted `StructuredOutput` tool through the same injection path as OpenCode. The
   runner also retains its common prompt-embedded schema and validated last-text fallback (§9.4).
8. **License compliance.** pi is MIT; §15 pins the attribution obligation for depending on and
   embedding it.

---

## 2. Package identity, layout, and packaging

### 2.1 Identity

- **npm name:** `@automatalabs/pi-acp` (scoped; unscoped `pi-acp` is the community bridge). Initial
  version `0.0.0`, first release driven by changesets in lockstep with the monorepo (§10).
- **bin name:** `pi-acp` → `dist/index.js`. Spawn resolution for the first-class built-in backend goes
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
    mcp-bridge.ts              # full ACP MCP client + inline extension injection (§9.3)
    mcp-sampling-payload.ts    # lossless provider-payload codecs for MCP sampling media (§9.3.7)
    child-process-registry.ts  # admission-safe tracked core-bash process-tree ownership (§9.6)
    version.ts                 # shared manifest-backed ACP/MCP client version
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
  "repository": { "type": "git", "url": "git+https://github.com/agentprism/agentprism-workflows.git", "directory": "packages/pi-acp" },
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
    "@earendil-works/pi-coding-agent": "0.80.10",
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
- `typebox` matches the monorepo (`1.3.2`); it builds the full MCP bridge's synthetic resource, prompt,
  completion, and subscription tool schemas. Pi
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
const { connection, agent } = await runAcp();                  // real stdio stream (§4)
let shuttingDown: Promise<void> | undefined;
function shutdown(code: number): Promise<void> {
  shuttingDown ??= (async () => {                              // idempotent: one disposal, awaited
    try {
      await withTimeout(agent.dispose(), 66_000);              // child + MCP + scheduling envelope (§9.6)
      process.exit(code);
    } catch {
      console.error("shutdown cleanup failed");
      process.exit(1);
    }
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
- **Bounded teardown.** Disposal is raced against the 66,000-ms process envelope: the 5,000-ms child
  generation, one shared 60,000-ms MCP close deadline, and a 1,000-ms scheduling margin (§9.6).
- **Exit codes:** `0` for a clean transport close / SIGINT / SIGTERM after proven cleanup; `1` when
  `connection.closed` rejects, startup throws, disposal fails, or the shutdown envelope expires. A
  cleanup failure prints exactly `shutdown cleanup failed`, overrides a requested zero exit, and does
  not prevent attempts against the remaining owners.

`runAcp` and `PiAcpAgent` are exported from `lib.ts` for library reuse (the
`ClaudeAcpAgent`/`runAcp` export convention, claude-agent-acp `dist/lib.js:2`).

---

## 4. Server construction (`src/server.ts`)

`runAcp(options?)` builds the agent with the SDK fluent builder and connects it over a stream. The
stream and the dependency object are **injectable** (§4.1) so tests drive the real handlers without a
child process:

```ts
import { agent as acpAgent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

export async function runAcp(options?: { deps?: Partial<PiAcpDeps>; stream?: Stream }) {
  const impl = new PiAcpAgent(await resolveDeps(options?.deps));
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

`PiAcpAgent` takes exactly one constructor argument, a fully-resolved `PiAcpDeps`. The asynchronous
`resolveDeps(partial?)` fills each field with its real default; tests pass overrides. This is the ONLY seam tests use — no ESM
monkey-patching (unreliable) is required.

```ts
export interface PiAcpDeps {
  /**
   * Build a pi session. Default: pi's real createAgentSession (sdk.ts:164), which returns
   * `Promise<CreateAgentSessionResult>` — NOT `Promise<AgentSession>` (resolves adversarial finding 2).
   * The adapter consumes `result.session` (the AgentSession) and `result.extensionsResult` (for the
   * post-construction tool-name reconciliation of §9.3.2). EVERY call site (new/load/resume/fork,
   * §9.1) passes `modelRuntime: deps.modelRuntime` so resolution, restore, stream auth, and setModel
   * all use the one injected runtime.
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
   * Shared model/auth runtime, constructed ONCE per process. Default:
   * await ModelRuntime.create() (model-runtime.ts:130-165), using ~/.pi/agent/auth.json and models.json.
   * `CreateAgentSessionOptions.modelRuntime` accepts it (sdk.ts:39-40), and pi's own restore/find/stream
   * paths read it (sdk.ts:192-210,307). Passing it on every factory call is what keeps injected
   * custom-provider resolution, journal-restored model lookup, `setModel`, and stream-time auth all
   * resolving against the SAME runtime — the divergence adversarial finding 2 flags otherwise.
   */
  modelRuntime: ModelRuntime;
  /** Root for session JSONL. Default: undefined => pi's ~/.pi/agent/sessions/<encoded-cwd>. */
  sessionDir?: string;
  /** Full MCP client factory. Default: the matching real SDK stdio/HTTP/SSE client (§9.3). */
  connectMcpClient(
    server: McpServer,
    signal: AbortSignal,
    binding?: McpSessionBinding,
  ): Promise<McpClientHandle>;
  /**
   * Cancellable timer for the cleanup-generation deadline and MCP bounded liveness (§9.6, §9.3).
   * `sleep(ms, signal)` resolves after `ms` unless `signal` aborts first, in which case it rejects
   * with the signal reason. Injecting the scheduler is what makes cleanup and MCP timeouts
   * DETERMINISTIC in tests (a monotonic clock alone cannot control when a timer fires — the round-2
   * `now()` seam is removed). Default: a real `setTimeout`-based sleep with `clearTimeout` on abort.
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Absolute deadline for one §9.6 child/Pi-abort cleanup generation. Default: 5000. */
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
`sleep`/`graceMs` make the §9.6 cleanup deadline deterministic (a test injects a `sleep` that resolves
at the chosen boundary); `mcpTimeoutMs` does the same for MCP hangs; `sessionDir` points at a
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
    "mcpCapabilities": { "http": true, "sse": true }, // stdio implicit; remote transports served (§9.3)
    // additionalDirectories NOT advertised — pi has no allowed-roots concept (§9.1.7, §11)
    "sessionCapabilities": {
      "resume": {},                           // session/resume
      "fork":   {},                           // session/fork   (UNSTABLE in SDK; native via SessionManager.forkFrom)
      "list":   {},                           // session/list
      "close":  {}                            // session/close
    }
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
- **`mcpCapabilities: { http: true, sse: true }`** — stdio is the implicit baseline and the adapter serves
  both remote transports through the MCP SDK. Client-hosted `acp` transport remains outside the server
  and is not advertised (§9.3.4).
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
- **MCP client capabilities** — every connected MCP client declares base sampling, fixed roots, and
  form/URL elicitation. Sampling losslessly preserves user/assistant text, image, and audio through the
  provider-payload seam; a concrete active-model codec failure returns the fixed
  `Active pi model cannot represent MCP sampling media` error (§9.3.7).

### 5.1 Config surface — truthful `thinkingLevel` and `model` selects (`src/config.ts`)

The `session/new` (and load/resume/fork) response advertises `thinkingLevel` followed by `model`.
Both conform to `docs/specs/config-options.md`; their enumerated choices are load-bearing.

| `configId`      | type / choices | on set → adapter action |
|-----------------|----------------|-------------------------|
| `thinkingLevel` | `select`, choices `["off","minimal","low","medium","high","xhigh","max"]`; `currentValue` = the session's active level | `AgentSession.setThinkingLevel(value)`; echo both options with the clamped level (§5.2) |
| `model` | `select`; choices are the completed credential- and provider-filter-aware `ModelRuntime.getAvailable()` result in order; `currentValue` is active `provider/id` or `""` | refresh the same catalog, require exact membership, call `AgentSession.setModel` with the first matching cached object, and echo both options (§5.2) |

`thinkingLevel` is a standard `configOptions` select consumed verbatim per `config-options.md` — the
mechanism that carries reasoning effort now that the bracket syntax was **removed**
(`config-options.md:14-15`; `model-resolution-determinism.md:56` lists `bracketTokens()`/
`applyModelModifiers()` as removed → "nothing"). This contract does **not** use or reference "effort
brackets" as a live surface.

The earlier objection was that advertising a necessarily-partial "representative" model list would
mislead the validate probe. The list here is not representative: it is an adapter-owned cache populated
only after extension binding and a completed `ModelRuntime.getAvailable()` call. Credential checks and
`Provider.filterModels` produce the same authoritative list required by the set path, and publication
waits for that barrier. Hosts therefore discover the real configured catalog. The runner still forbids
authored `configOptions.model` and uses its reserved model-selection channel.

### 5.2 Config-option state machine (`src/config.ts`) — resolves adversarial finding 10

`setConfigOption(context)` is a total function over the wire request `SetSessionConfigOptionRequest`
(`types.gen.d.ts:5031`); it returns `SetSessionConfigOptionResponse = { configOptions }`
(`:2975`). Transitions are pinned:

| `configId` / `value` | behavior |
|---|---|
| `"thinkingLevel"`, a `string` in the choice set | `setThinkingLevel(value)`; success; echo `configOptions` with `currentValue` = clamped level |
| `"thinkingLevel"`, a `string` NOT in the choice set | reject `invalidParams` (`-32602`), `errorKind:"invalid_config_value"` |
| `"thinkingLevel"`, a `boolean` (wrong discriminator) | reject `invalidParams` (`-32602`), `errorKind:"invalid_config_type"` |
| `"model"`, a `string` `"<provider>/<id>"` present in the refreshed catalog | select the first matching cached object and call `AgentSession.setModel`; success; echo both options |
| `"model"`, unresolvable string | reject `invalidParams` (`-32602`), `errorKind:"invalid_model"` |
| `"model"`, a `boolean` | reject `invalidParams` (`-32602`), `errorKind:"invalid_config_type"` |
| any other `configId` | reject `invalidParams` (`-32602`), `errorKind:"unknown_config_option"` |
| any of the above while a turn is in flight (invariant 4) | reject `invalidParams` (`-32602`), `errorKind:"session_busy"` — never mutate model/level mid-stream |
| session id unknown / poisoned | reject `invalidParams` (`-32602`), `errorKind:"unknown_session"` / `"session_terminated"` (§9.1.6) |

Every set refreshes the completed catalog before mutation. The echo returns `[thinkingLevel, model]`;
`setModel` re-clamps thinking level to the new model
(`agent-session.ts:1543-1549`), so the echoed `thinkingLevel.currentValue` reflects any clamp.

**Auth on the `set_config_option("model", …)` path — the producing mechanism is named (resolves the
setModel-auth gap).** `AgentSession.setModel` rejects with the exact message
`` `No API key for ${model.provider}/${model.id}` `` when the model has no configured auth
(`agent-session.ts:1566-1569`, guarded by `this._modelRuntime.checkAuth(model.provider)`). That message
matches **none** of §8.2's `session.prompt()` pre-flight predicates (which look for `"no api key found"` /
`"authentication failed for"` / `"run '/login"`), so this call site owns its own auth classifier — the
handler does NOT rely on the prompt-path matcher. Concretely, after resolving the model (below), the
handler obtains the model from the credential-aware availability result and wraps `setModel` in a `try/catch`
that maps a thrown `` /^no api key for /i `` message to the same row 1 (a belt-and-suspenders guard for a
races-with-auth-change window); any other `setModel` throw falls to the row-23 catch-all. This mapping is
scoped to the `set_config_option("model")` handler only, never `invalidParams` (T9 covers a known model
with missing auth).

**Model resolution** (completed availability cache, decisive):

1. Construct the runtime once per process via the DI seam: `deps.modelRuntime` (default
   `await ModelRuntime.create()`; `model-runtime.ts:130-165`; its `CreateModelRuntimeOptions`
   `authPath`/`modelsPath` fields are at `:58-68`).
2. For a spec `"<provider>/<model-id>"`, await `modelRuntime.getAvailable()`, copy the result, and select
   the first exact provider/id occurrence. Choices are not sorted, deduplicated, truncated, or fabricated.
3. Found → pass that exact cached object to `setModel`; all construction paths still receive the same
   injected runtime so restore/find/stream-auth agree (§4.1).
4. `undefined` → reject the originating request `invalidParams` (`-32602`, `errorKind:"invalid_model"`),
   naming the unknown `provider/id` (never a silent fallback).
5. No spec supplied before the first prompt → omit `model`; pi picks its configured default
   (`findInitialModel`, `sdk.ts:207-222`).

Neither unfiltered `modelRuntime.getModel` nor builtin/deprecated compatibility catalogs authorize a set.
An active model that later disappears remains its truthful `currentValue` but cannot be reselected.

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
content (T4 covers it). The runner may embed its common schema instruction in the ordinary prompt text
before ACP delivery (§9.4); pi-acp itself performs no private schema splice or turn-level arming.

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
`settled` boolean and a `settle(result)` that resolves or rejects the ACP request **exactly once**. The
cleanup generation is part of that settlement barrier, so cleanup failure is the strongest outcome and
is recorded before any weaker result commits:

| input | trigger | settlement action | usage_update + drain | post-settlement |
|---|---|---|---|---|
| **normal** | `session.prompt()` resolves and no abort source fired | compute stopReason (§7): terminal `stop`/`length`/`toolUse` → **resolve** `{ stopReason, usage }`; terminal `error` → **reject** classified (§8) | **yes**, before `settle` | turn kept live |
| **cancelled** | an abort source (§9.6) fired `turnController.abort()`, `session.prompt()` resolved terminal `aborted`, and the cleanup generation succeeded | **resolve** `{ stopReason:"cancelled", usage }` (§7) | **yes**, before `settle` | cancel-only cleanup installs a fresh child epoch only while admission remains reserved; close/dispose does not reopen it |
| **notify-failure** | the pump's `this.notify(update)` **rejects** mid-turn and the cleanup generation succeeds | abort `turnController`, then **reject** `internalError` (`-32603`, `errorKind:"notification_error"`, row 22) | **no** — the transport is broken, so no update (incl. `usage_update`) can be delivered or ordered; the pump is stopped and `pending` is abandoned | cleanup completes before this weaker outcome commits |
| **cleanup-failure** | a child/Pi-abort operation fails or the absolute `deps.graceMs` cleanup deadline wins (§9.6) | **reject** `internalError` (`-32603`, `errorKind:"child_cleanup_error"`, row 19), overriding cancelled, notification failure, or another prompt outcome | **no** — never emit a false `cancelled` or ordinary timeout result | escalate to disposal, retain the cleanup tombstone, and retry on later close/dispose |

**Invariants derived from the single winner:**

1. **`usage_update` + `drain` precede `settle` on transport-healthy normal and successfully-cancelled
   inputs.** Notify failure and cleanup failure emit none: the former has no usable transport, and the
   latter must not publish a weaker cancelled/timeout outcome.
2. **Exactly one settlement per turn, with cleanup failure strongest.** Notification failure rejects
   row 22 only after successful cleanup; if that cleanup rejects or expires, row 19 commits instead.
   Late Pi resolution/rejection is swallowed after settlement.
3. **Teardown waits for settlement.** Disposal never drops the send queue until the turn's cleanup,
   notification drain, and one-shot settlement have completed. A successful close-racing prompt emits
   `usage_update`, drains, and resolves `cancelled` before queue teardown; failed cleanup rejects row 19
   by the absolute `deps.graceMs` deadline and retains retry ownership.
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
  (never `null`, never the whole message). `details` is the executing Pi tool's exact structured payload
  (including an MCP operation's exact result/pages) — exactly what ACP `rawOutput` is for.
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
| child/Pi-abort cleanup failure or cleanup deadline (§9.6) | **none** — reject `child_cleanup_error`; never emit a false cancelled/ordinary timeout outcome | n/a — the request rejects |

`usage_update` is always emitted **before** `drain()` and before the request resolves/rejects on normal
and successfully-cancelled transport-healthy inputs, so the client observes usage in order. Notify
failure and cleanup failure emit none (§6.2.1 invariant 1). A compaction-drop case is tested (T6): two turns where the second's
`used` is **lower** than the first's while `cost.amount` still rises.

### 6.6 Turn lifecycle and concurrency

One ACP `session/prompt` drives one pi turn: convert content (§6.1), then
`await session.prompt(text, { images })` (`agent-session.ts:1076`), which awaits
`agent.prompt()` plus pi's auto-retry/compaction loop and settles by emitting `agent_settled` in a
`finally` (`agent-session.ts:1023-1034`). After it resolves: compute stopReason (§7) and usage (§6.5),
emit `usage_update`, `await drain()` (§6.2), then resolve `{ stopReason, usage }` — this is the **normal**
settlement input of the §6.2.1 one-shot `settle` (the other inputs — cancelled, notify-failure,
cleanup-failure — are §9.6/§6.2.1).

Concurrency (resolves issue Open item 2, invariant 4): pi permits **one in-flight turn per session** —
`AgentSession.prompt()` throws when already streaming unless a `streamingBehavior` is supplied
(`agent-session.ts:1121-1126`). ACP clients serialize `session/prompt` per session, so this never fires
in normal use; if a second `session/prompt` arrives for a busy session, the adapter rejects it with
`invalidParams` (`-32602`, `errorKind:"session_busy"`) **without** calling `session.prompt`.

`_session/steering` is a deliberately separate vendor request, advertised only at top-level
`InitializeResponse._meta.steering.supported === true`. Its parser accepts `{ sessionId, prompt }` plus
optional request `_meta`, the agent routes it through `requireLive()`, requests are serialized per
session, and content is converted with `convertPromptContent()`. Behavior is codex-shaped — the
"arrived too late" race and the idle session are success outcomes, never errors:

- **Live turn** → `await pi.steer(text, images)` and `{ outcome:"injected" }`. The original
  `session/prompt` remains the exclusive owner of output updates, usage, and settlement.
- **Idle session** → the content starts a fire-and-forget turn through the normal turn machinery (it
  occupies the single turn slot, so a concurrent `session/prompt` is legitimately `session_busy` and
  cancel/close still work) and resolves `{ outcome:"startedNewTurn" }` as soon as the turn commits —
  pi's `preflightResult` hook is the acceptance signal. Nothing owns that turn's `PromptResponse`;
  its output streams through the usual `session/update` path. Preflight failures reject with the
  same mapped errors a `prompt()` caller would see.
- **Turn-end race** → pi's steering queue is polled only from inside a run, so an enqueue the
  settling run never consumed is recovered (`pi.clearQueue()` returns the removed texts) and taken
  down the new-turn path instead of silently prepending itself to the next `session/prompt`. As a
  settlement-time backstop, any orphaned queue content is redispatched as a fire-and-forget turn.
- **Cancellation wins** → a steer racing an in-progress cancel resolves `{ outcome:"failed" }` and
  never restarts the generation the user stopped. During cancellation cleanup, `pi.clearQueue()` is
  invoked synchronously before `pi.abort()`; abort is still attempted when clearing throws and the
  pre-existing cleanup-error precedence remains authoritative.
- **Unexpected internal failure** → the codex-shaped catch-all resolves `{ outcome:"failed" }`;
  only typed adapter errors (unknown/terminated session, malformed params, preflight) surface as
  JSON-RPC errors.

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
| `extension_setup_error` | `"pi extension setup failed"` |
| `child_cleanup_error` | `"child process cleanup failed"` |
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
| 17 | client-hosted `acp` MCP transport sent to a lifecycle method (§9.3.4) | `invalidParams` | `-32602` | `{ errorKind:"unsupported_mcp_transport", server: <name> }` |
| 18 | missing/duplicate/reordered inline control/reserved extension, changed loader runtime/errors identity, or wrong/missing bash/control winner | `internalError` | `-32603` | `{ errorKind:"extension_setup_error" }` |
| 19 | adapter-owned child registry or awaited Pi abort cannot drain under the absolute cleanup deadline | `internalError` | `-32603` | `{ errorKind:"child_cleanup_error", details:{ remainingChildren:<integer> } }` |
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
`empty_prompt` fold (row 7). The round-2 `invalid_content`
errorKind was **unreachable** (nothing schema-valid remained for it to catch) and is **removed**;
schema-valid image `data` is passed to pi as-is (pi does not pre-decode base64 either), so no residual
handler check exists. T8 asserts the SDK pre-handler shape for a malformed block.

**`close` is normally idempotent.** `session/close` for an unknown or cleanup-complete id returns
success. A retained cleanup tombstone is the sole exception: close retries its owned process trees and
returns row 19 until a generation proves them gone (§9.1.6/§9.6).

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
`deps.modelRuntime.hasConfiguredAuth(model.provider) === false` precheck → row 1 (`auth_error`, `-32000`), and a
defensive `/^no api key for /i` catch on the `setModel` throw → the same row 1. That path does **not** use
the `session.prompt()` pre-flight predicates above (the `setModel` message `No API key for
<provider>/<id>` matches none of them).

**Downstream client behavior.** `-32000` → `AUTH_REQUIRED` pause by code alone
(`errors-map.ts:135-146`; `ACP_AUTH_REQUIRED_CODE_EXCLUSIVE`, `protocol-coverage.ts:152-154`). The
first-class `PiBackend.classifyProviderError` promotes categorical `rate_limit`/`billing_error` values
to `PROVIDER_USAGE_LIMIT` pauses; `provider_error` remains a recoverable execution error.

---

## 9. Feature surfaces

### 9.1 Sessions (`src/session.ts`, `src/replay.ts`) — resolves adversarial findings 4, 5, 6

The adapter holds three per-connection structures plus one terminal flag: a `Map<sessionId, PiSession>`
(**live**), a `Map<sessionId, AbortController>` (**opening** — one entry per in-flight opening
transaction, its value the transaction's own `openController` whose `openSignal` gates acquisition and
commit, §9.1.0), a `Set<sessionId>` (**tombstones**, §9.1.6), and a process-`disposed` boolean set by
`PiAcpAgent.dispose()` (§9.1.0 / §3.2). Each `PiSession` owns one `AgentSession`, its translator
subscription, its send queue (§6.2), its permission wrapper (§9.2), its full MCP bridge (§9.3), its
completed model-catalog cache (§5), and its tracked-child registry (§9.6). Structured output is entirely
client-hosted MCP injection (§9.4); no Pi session owns a private structured-output tool or capture state.
`sessionId` is pi's `SessionManager.getSessionId()`.

#### 9.1.0 Transactional acquisition, atomic reservation, and open-time races (resolves adversarial findings 7, 8; the opening-race gaps)

Every session-opening method (new/load/resume/fork) runs one all-or-nothing transaction that is **tracked
by an `openController`, not merely by an id**, so cancellation, close, and dispose have a pinned effect at
every awaited stage. Because Node runs the handler body to its first `await` without interleaving, the
**reservation is atomic**:

1. **Reserve synchronously, before any `await`.** If `disposed` (§3.2) → reject `internalError`
   (`errorKind:"internal_error"`) — the connection is shutting down. For load/resume the id is
   `request.sessionId`; new reserves the id minted by its in-memory `SessionManager`; fork allocates and
   reserves its target id before MCP connect, then passes that exact id to `forkFrom({ id })` after MCP is
   ready. Check `live.has(id) || opening.has(id)` → if set, reject
   `session_already_open` (row 13); check `tombstones.has(id)` → reject `session_terminated` (row 14).
   Otherwise construct `openController = new AbortController()`, set `opening.set(id, openController)`, and
   subscribe it to the request signal: `context.signal.addEventListener("abort", () =>
   openController.abort(context.signal.reason))`. `openSignal = openController.signal` is threaded into
   every awaited step below. This closes the round-2 check-then-await-then-register race in which two
   concurrent `load`s for the same id could both pass a live-map check and both register (leaking one).
2. **Acquire in order, tracking each resource, honoring `openSignal`:** validate cwd (row 11) → obtain the
   in-memory/opened `SessionManager` for new/load/resume (fork instead resolves its source and reserves a
   target id) → connect the full MCP bridge (§9.3, all-or-nothing, each connect/list bounded by
   `deps.mcpTimeoutMs` **and** cancellable by `openSignal`) → for fork only, perform the now-safe
   `forkFrom(..., { id: targetId })` write → load and precedence-order the reserved/control inline
   extensions → `deps.createAgentSession({ resourceLoader, settingsManager, sessionManager,
   modelRuntime: deps.modelRuntime })` → bind extensions, cross the completed model-catalog barrier,
   install the permission wrapper + translator → (load only) replay + `drain()`. If `openSignal`
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
4. **Rollback on ANY failure OR gate-abort at any stage** (best-effort, each step guarded and bounded):
   close tracked-child spawn admission first; synchronously start every acquired MCP wrapper's logical
   close in reverse acquisition order (including HTTP termination); abort the binding lifetime, refresh,
   and turn; start and await pi's **`AgentSession.abort()`** plus the child/refresh drains; only then
   unsubscribe/drop the translator queue and call **`AgentSession.dispose()`** concurrently with the
   already-started physical MCP closes. `AgentSession.dispose()` (`agent-session.ts:799`) remains required
   to invalidate extensions and clean Pi resources; abort/unsubscribe alone would leak them. Finally
   `opening.delete(id)`. **No live registry entry, MCP child, listener, Pi resource, inline-extension
   capture, or tracked child remains.** A replay-`notify` failure (§6.2.1) is a stage-2 failure: it
   rolls back fully, so the id is NOT left live and a retry is a clean `session/load`, never a spurious
   `session_already_open`. Non-child disposal/disconnect errors are logged to stderr and do not mask the
   original rejection. A failed tracked-child/Pi-abort cleanup is the sole exception: it returns the exact
   `child_cleanup_error`, retains hidden retry ownership, and overrides the original open error (§9.6).

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
minted `getSessionId()` (§9.1.0 step 1) → connect the request's stdio/Streamable-HTTP/legacy-SSE MCP
servers (§9.3; row 16/17 on failure, with rollback) → load the reserved MCP/control inline extensions and
`deps.createAgentSession({ resourceLoader, settingsManager, sessionManager,
modelRuntime: deps.modelRuntime })` (§5.2) → bind extensions, await the completed filtered model catalog,
and install the permission wrapper (§9.2) + translator (§6.3) → commit. Return
`{ sessionId, configOptions: [thinkingLevelOption, modelOption], modes: null }` (`NewSessionResponse`,
`types.gen.d.ts:2556`).

#### 9.1.2 `session/load` (reopen + replay)

`validateCwd(request.cwd)` when present (row 11) → reserve `request.sessionId` atomically (§9.1.0 step 1;
`session_already_open`/`session_terminated` guards). Resolve the session file for `sessionId` via
`deps.sessions.list(request.cwd, deps.sessionDir)` (`session-manager.ts:1549`, → `SessionInfo{ id, path,
… }`, `:170-184`); if absent → row 12. `deps.sessions.open(path)` (`:1452`; row 15 on corrupt JSONL);
connect request MCP servers (§9.3, rolled back on failure); `deps.createAgentSession({ sessionManager,
modelRuntime: deps.modelRuntime })` restores the model context internally via `buildSessionContext()`
(`sdk.ts:182-210`). Then **replay the transcript to the client**: iterate
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
`createAgentSession({ …, modelRuntime: deps.modelRuntime })` — but with **no** replay: restore into
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
mid-turn). `validateCwd(request.cwd)` (target, row 11). Allocate and reserve the target id, then connect
the request's MCP servers **first** (all-or-nothing, §9.3) so an MCP failure rolls back before anything
is written. Then `deps.sessions.forkFrom(sourcePath, request.cwd, deps.sessionDir, { id: targetId })`
(`session-manager.ts:1490` — the irreversible JSONL write; §9.1.0 covers a post-write
`createAgentSession` failure). Load the inline extensions, `deps.createAgentSession({ resourceLoader,
settingsManager, sessionManager: forked, modelRuntime: deps.modelRuntime })`, bind the completed model
catalog, install the wrapper/translator, and commit a **new** `PiSession` under
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

`session/close` **disposes** the `PiSession`. Close is normally idempotent success, but the retained
child-cleanup tombstone in §9.6 is the one observable failure exception. The synchronous prefix of the
shared cleanup generation first closes child-spawn admission and starts termination for the captured
epoch; then starts every memoized MCP logical close; then aborts the session lifetime; then aborts the
turn/refresh signals; and finally starts awaited `AgentSession.abort()`, without serial gaps. If a turn
is active, close joins its settlement and cleanup barrier before dropping the send queue,
so any admitted `usage_update` and notification drain complete first. The live entry is removed in a
`finally`, even when cleanup fails, and the cleanup owner remains addressable behind the tombstone.
Ordinary `AgentSession.dispose()`/MCP-close/logging failures stay bounded best-effort diagnostics and do
not fail close; unresolved child ownership, awaited Pi-abort failure, or the absolute `deps.graceMs`
deadline rejects row 19 and retains retry ownership. Pinned behaviors:

| situation | behavior |
|---|---|
| close an unknown / already-closed / ordinary-or-cleanup-complete tombstoned id | **success** (idempotent; never rows 12/14) |
| close whose `AgentSession.dispose()` / MCP `close()` throws, with child/Pi-abort cleanup proven | **success** — the live entry is dropped in the `finally`, non-child disposal errors are fixed diagnostics, and a retry is a clean idempotent success (never row 23) |
| close whose child registry or awaited `AgentSession.abort()` cannot drain by the generation deadline | **reject `child_cleanup_error` (row 19)** after every child and MCP owner has been attempted; retain a cleanup tombstone, and let repeated close start/join a fresh retry generation until proof succeeds |
| duplicate `load`/`resume` for an id already **live or reserved-opening** | reject the second `session_already_open` (row 13) — never overwrite a live/opening wrapper (its subscription/MCP clients would leak) |
| `close` racing an **in-flight opening** transaction (id in `opening`) | close aborts that transaction's `openController` and returns **success**; the transaction fails its §9.1.0 step-3 gate and rolls back — **no post-close resurrection** |
| `close` racing an in-flight `prompt` | close aborts the per-turn controller (§9.6); the racing `prompt` settles `cancelled` (§6.2.1), emitting its `usage_update`/`drain` **before** close tears the queue down; then close disposes |
| `PiAcpAgent.dispose()` racing an opening transaction | dispose sets `disposed`, aborts every `openController`, awaits all opening transactions' rollback, then sweeps `live` (§9.1.0, §3.2) — no post-dispose commit |
| `set_config_option`/`fork` racing an in-flight `prompt` | rejected `session_busy` (§5.2, §9.1.4) |
| `load`/`resume` racing each other for the same id | the atomic §9.1.0 reservation makes the first win; the second sees `opening.has(id)` synchronously → `session_already_open` — neither leaks |
| use of a poisoned/tombstoned id (below) | reject `session_terminated` (row 14) |

**Poisoned-journal guard (resolves the concurrent-writer hole).** When a §9.6 cleanup generation fails,
the underlying pi run may still be alive and could later append to the session's JSONL.
The adapter therefore records the `sessionId` in the per-connection **tombstone** set and rejects any
subsequent `load`/`resume`/`fork`/`prompt`/`set_config_option`/reopen for that id with
`session_terminated` (row 14) for the remainder of the process — preventing a second writer from
corrupting the journal a retained writer may still touch. `session/close` on an ordinary or
cleanup-complete tombstone succeeds idempotently; a retained child-cleanup tombstone follows the retry
exception in the §9.1.6 table. Tombstones are per connection and cleared only on connection teardown.

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
"build extensions"). The adapter bridges ACP-supplied MCP servers into reserved pi inline-extension
tools, on **every**
lifecycle method that carries them — our client sends `mcpServers` on `session/new` **and** on
load/resume/fork (`reattachSession`/`forkSession`, `acp-client.ts:1533,1587,1647`), so all four apply
the bridge.

#### 9.3.1 Connect and register (bounded, fully paginated)

For each `request.mcpServers` entry using **stdio, Streamable HTTP, or legacy SSE** transport,
`deps.connectMcpClient(server, openSignal)` connects a strict-capability `@modelcontextprotocol/sdk`
client using the matching production transport and
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
registered as a pi inline-extension tool (`extensions/types.ts:437-495`): the MCP tool's JSON-Schema
`inputSchema` becomes the pi tool `parameters` (raw JSON Schema accepted — §2.3), and `execute` forwards
to the MCP `tools/call` (`client/index.js:490`, bounded by `deps.mcpTimeoutMs` via `options.timeout`),
converting the result (§9.3.3).

**Timeout / abort resource protocol (resolves the detached-promise + orphan-child gap).** Every
`connect`, `listTools`-page, and `tools/call` promise is raced against `deps.sleep(deps.mcpTimeoutMs,
signal)` (and against `openSignal`/`turnSignal` as applicable). When the timeout or abort wins the race,
the losing MCP promise is **detached** with an attached `.then(() => {}, () => {})` so its late
resolve/reject produces **no unhandled rejection** (extending to MCP the detached-promise guarantee that
previously covered only pi prompt + permission requests, §9.6). For a **failed or timed-out `connect`**,
the wrapper closes the acquired transport, including any stdio child, and observes/closes a handle that
resolves after the outer bound. The returned `McpClientHandle` exposes the complete stable-base
operations plus idempotent `close`; HTTP DELETE and raw close share one absolute
`deps.mcpTimeoutMs` close deadline (60,000 ms by default), so neither phase restarts the clock.

#### 9.3.2 Naming, collisions, partial-init rollback, cleanup (total — resolves adversarial finding 9)

**Extensions stay enabled and are part of collision discovery.** A pi user's configured extensions must
keep working through the ACP server (disabling them would make pi-acp a lesser pi), so extension tools
coexist with our injected ones. But pi's `_refreshToolRegistry` composes tools as
`Map(builtins)` then extension tools in order (`agent-session.ts:2459-2463`). The adapter moves only its
reserved MCP extension first, preserving configured hook and bash precedence.
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
- **Reserved namespaces + post-construction verification.** The built-in catalog is the known set
  `{read,bash,edit,write,grep,find,ls}` (none of which use a reserved prefix), so an injected name — an
  `mcp__…` alias — is **disjoint from every built-in by construction**
  (asserted as a guard against a future pi built-in that adopts a reserved prefix: if that ever holds,
  reject row 16). Extensions are the only entities that could use a reserved prefix; pi-acp reserves
  `mcp__` (declared in the README, §15). `session.getAllTools()` must report every alias with
  `sourceInfo.path = "<inline:agentprism-pi-acp-mcp>"`; missing or wrong-source aliases reject row 16.
- **Partial-init rollback (all-or-nothing).** If any server's connect/`tools/list`/duplicate check or the
  reserved-name verification fails, run the full §9.1.0 rollback (disconnect every already-connected
  client — each bounded by `deps.mcpTimeoutMs` — dispose the session if constructed, drop the
  reservation) and reject with row 16. Global loader/control verification uses row 18. No half-initialized session
  is registered; no child processes leak.
- **Cancellation + timeout.** Each `tools/call` is passed the turn signal (§9.6); on abort the call is
  cancelled. `deps.mcpTimeoutMs` also bounds each `tools/call`; a timeout/abort becomes an error result
  (pi surfaces it as a failed tool, §9.3.3, not a crashed session).
- **Cleanup.** MCP clients are disconnected on `session/close`, on §9.6 cleanup-failure escalation, and on connection
  teardown (§3.2 disposal). All closes are started without awaiting between invocations; each server's
  HTTP DELETE/raw-close pair shares the injected absolute `deps.mcpTimeoutMs` bound. Streamable HTTP
  alone performs DELETE before raw close; stdio and SSE invoke their transport-owned raw `close()` in the
  same synchronous logical-close stack, with no adapter pre-kill or other pre-close step.

#### 9.3.3 Result conversion (total over the pinned `CallToolResult` — resolves the content-union gap)

The pinned MCP SDK 1.29.0 `CallToolResult` (`dist/esm/types.js` `CallToolResultSchema`) is
`{ content: ContentBlock[] (default []), structuredContent?: Record<string,unknown>, isError?: boolean }`,
and `ContentBlockSchema` is the **five-member** union `text | image | audio | resource_link |
embedded resource`. The projection to pi `AgentToolResult` (`{ content: (TextContent|ImageContent)[],
details? }`) is **total over every member**, in `content` order:

- **text** → `{ type:"text", text }`.
- **image** (`{ data, mimeType }`) → `{ type:"image", data, mimeType }`.
- **audio** → a text item `` `[audio mime=${mimeType} bytes=${decodedByteLength}]` `` (pi's tool-result
  content is text-or-image only, `ai/types.ts:403-418`; the canonical text retains media type and byte
  count without leaking or inventing audio playback).
- **resource_link** (`{ uri, name?, title? }`) → a text item `[<title ?? name ?? uri>](<uri>)`.
- **embedded resource** — text contents → the embedded `text`; blob contents → a text item
  `` `[embedded resource uri=${uri} mime=${mimeType ?? "application/octet-stream"} bytes=${decodedByteLength}]` ``.
- **raw result** → set pi `AgentToolResult.details` to the exact complete `CallToolResult` object, so
  `tool_call_update.rawOutput` contains the peer's exact result (including `content`, optional
  `structuredContent`, and optional `isError`) rather than a narrowed or wrapped projection.
- **`isError: true`** → retain the complete projected `{ content, details }` in the session's failed-result
  side map, then throw the fixed `` `MCP tool ${alias} failed` `` so pi takes its normal failed-tool path.
  The paired `afterToolCall` override consumes that entry for the same call and restores the peer's
  projected content plus exact raw result as the single `tool_execution_end { isError:true }`; ACP
  therefore receives `tool_call_update { status:"failed", content, rawOutput }` without an adapter
  crash. The thrown message never contains the peer's raw content, and the side-map entry is consumed
  exactly once.
- A timeout that wins the outgoing arbiter throws fixed
  `` `MCP tool ${alias} timed out` ``. A turn abort emits no late tool failure after ACP settlement;
  disposal or peer close uses the ordinary fixed `failed` label only while the turn is still live.

#### 9.3.4 Transports

v1 serves stdio, Streamable HTTP, and legacy SSE with ordered header folding. HTTP uses zero reconnect,
request-driven 405 idle handling, bounded DELETE-before-close under one absolute per-server deadline,
and fatal raw-error observation. SSE synchronously closes on fatal raw errors and guards later fetches;
stdio raw close is fatal while pipe/parser errors remain diagnostic. Client-hosted `acp` transport alone
rejects `unsupported_mcp_transport`. `mcpCapabilities:{ http:true, sse:true }` is truthful (§5).

#### 9.3.5 Dynamic registration

`notifications/tools/list_changed` is installed before connect and conditioned on the server's
advertised capability. Notifications coalesce in configuration order into one session-wide
prepare-and-commit queue. Preparation fully pages and validates every catalog and output schema without
mutating Pi. Commit holds the same turn-boundary mutex as prompt admission, preserves aliases for stable
remote names, reserves deterministic aliases for additions, replaces definitions, and deactivates
removals. A preparation failure retains the prior snapshot and emits one redacted refresh diagnostic.
Failure after the first Pi mutation poisons/tombstones the session because Pi has no rollback API.

#### 9.3.6 Stable base protocol and lifecycle

Each strict-capability MCP client uses the shared manifest version, pings after initialize, preserves
server instructions through a control extension, and capability-conditions logging, resources,
templates, subscriptions, prompts, completion, and their notifications. Synthetic operations are
ordinary Pi tools, fully page list results with cursor-cycle guards, preserve complete raw pages in
details, forward progress, and copy partial details to ACP `rawOutput`. Fresh clients begin unsubscribed;
replay neither restores subscriptions nor adds an MCP history marker. Outgoing requests share a
settle-once abort/disposal/peer-close/timeout/completion arbiter. A post-publication fatal event disables
only its server at the next turn boundary, removes aliases and instructions, closes its transport, and
never reconnects.

#### 9.3.7 Client features

The client advertises base sampling, one fixed file-URL workspace root, and form/URL elicitation.
Sampling preserves `systemPrompt` and the exact role/order/text/MIME/base64 of stable user/assistant
text, image, and audio. `mcp-sampling-payload.ts` uses request-unique markers in a role-faithful Pi
Context and replaces them exactly once through `StreamOptions.onPayload` for every lossless built-in API
dialect; an absent/moved/duplicate marker or unsupported role/media codec fails with the fixed active-
model representation error before provider send. Base sampling intentionally excludes context/tools.
Form elicitation validates accepted content against the exact requested schema. URL elicitation uses a
process-wide collision-free opaque id registry scoped by agent/session/server ownership and translates
completion back to ACP exactly once. Incoming features use the peer/session/turn/timeout arbiter and
emit optional `0/1` related progress without making telemetry a barrier.

#### 9.3.8 Ownership and rollback

Every session owns its clients, wrappers, handlers, aliases, inline extensions, incoming requests, and
elicitation entries. Open is atomic across connect/ping/logging/list, loader/control validation, Pi
construction/source verification, model-catalog barrier, replay, and publication. Rollback starts all
transport closes in reverse acquisition order without awaiting between starts, drains refresh/incoming
work, and exposes no partial session. Server-attributable failures retain `mcp_init_error` with the exact
configured server; global extension failures use `extension_setup_error` without server/details; a
stronger child/Pi-abort cleanup failure replaces either with `child_cleanup_error` (§9.6).

### 9.4 Structured output through client-hosted MCP injection

`PiBackend` has no private capability namespace, prompt metadata, or native structured hook. It sets
`embedSchemaInPrompt = true` and `injectStructuredOutputTool = true`. Because pi-acp advertises HTTP
MCP, the runner's production `StructuredOutputToolHost` is appended to `session/new.mcpServers`, the
bridge exposes it as `mcp__structured_output__StructuredOutput`, and a schema-valid call is captured and
validated by the common runner path (`runner.ts`, `structured-tool.ts`). If capture is missing or
invalid, the common prompt-embedded schema plus validated last-text recovery ladder remains available.
Pi therefore shares OpenCode's standard transport-independent channel and owns no server-side
structured-output state.

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
| `pi-stored-credentials` | `"pi stored credentials"` | `agent` | pi's default `ModelRuntime` reads its own `~/.pi/agent/auth.json`; the default `AuthMethodAgent` ("agent handles auth itself") with **no** `_meta` |

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

### 9.6 Cancellation, tracked bash, and retained cleanup (`src/session.ts`)

Every session owns a `ChildProcessRegistrySlot`. The normally appended control extension replaces only
Pi's core built-in `bash` with `createBashToolDefinition` using tracked operations; a configured
extension's bash keeps Pi's documented precedence. Each epoch is monotonic
`open → closing → closed`. A lease is acquired synchronously before spawn, registered immediately after
PID acquisition, and remains owned until the leader and complete Unix process group/Windows task tree
are proven gone. Drain closes admission first and includes late registrations and pending spawn leases.

Request cancellation, `session/cancel`, close/dispose, notification failure, and in-turn bash timeout
share one cleanup generation. It closes child admission first; disposal then starts reverse-acquisition
MCP logical/physical close before aborting the binding lifetime; turn/refresh abort follows; and awaited
`AgentSession.abort()` starts last, without serial gaps. One absolute default
5,000-ms deadline covers every child, lease, kill, leader close, and liveness proof. Unix uses detached
process-group `SIGKILL`, leader close, and repeated `kill(-pgid,0)` until `ESRCH`; Windows awaits
`taskkill /T /F` and leader close. A successful cancel-only drain compare-and-swaps a fresh open epoch
before the cancelled prompt settles. Disposal never reopens an epoch.

Any child/Pi-abort operation error or deadline expiry fails the prompt and every joined close with
`child_cleanup_error -32603`, details `{ remainingChildren }`, emits no false cancelled/ordinary timeout
outcome, escalates to disposal, and retains a cleanup tombstone. Repeated close and repeated top-level
dispose use fresh cleanup generations for remaining trees while memoizing Pi/MCP disposal; fail→success,
fail→fail, concurrent join, and post-success no-op are deterministic. Unknown or cleanup-complete close
remains idempotent success. Ordinary Pi dispose, MCP close, and logging failures remain best-effort.

The process shutdown envelope is 66,000 ms: child generation 5,000 + shared per-server MCP close 60,000
+ 1,000 scheduling margin. Failure prints exactly `shutdown cleanup failed`, attempts all owners, and
exits 1. The production ACP caller gives close 6,000 ms and Pi process exit 67,000 ms (§10.4), so it
cannot preempt either server boundary.

---

## 10. Monorepo integration

### 10.1 Freshness gate

Add `@earendil-works/pi-coding-agent` to `ACP_DEP_MATCHERS` in `scripts/check-acp-deps.mjs:34-37`:

```js
const ACP_DEP_MATCHERS = [
  (name) => name.startsWith("@agentclientprotocol/"),
  (name) => name === "@automatalabs/codex-acp",
  (name) => name === "@earendil-works/pi-coding-agent",   // NEW
];
```

Rationale: pi releases every 2–3 days (~30 releases in 10 weeks; v0.80.10 released 2026-07-16), so the
pre-push freshness check must fail when pi-acp's pinned pi runtime falls behind npm `latest`.
`@earendil-works/pi-coding-agent` is a **direct** dependency of a workspace package (pi-acp embeds it),
so it belongs in `ACP_DEP_MATCHERS` (check 1, direct freshness), **not** `WRAPPED_RUNTIMES` (third-party
adapters whose runtime is only transitive, `check-acp-deps.mjs:53-55`). `@agentclientprotocol/sdk` is
already matched by the `@agentclientprotocol/` prefix. The coordinated changes outside
`packages/pi-acp` also include the §10.4 `acp-agents` caller and release amendments.

### 10.2 Changesets, CI

- `packages/pi-acp` is auto-included by `pnpm-workspace.yaml` (`packages/*`).
- CI (`.github/workflows/ci.yml`) runs `pnpm -r exec tsc -b`, `tsc --noEmit`, and `pnpm -r test` on
  Node 24 — pi-acp participates through its `build`/`typecheck`/`test` scripts with no CI-file change.
- The coordinated changeset publishes `@automatalabs/pi-acp` at `0.2.0` together with the §10.4
  four-package release transaction (`.changeset/config.json`, access `public`, baseBranch `main`).

### 10.3 tsconfig project reference

Add `{ "path": "packages/pi-acp" }` to the root `tsconfig.json` `references` array (alongside the
existing package references) so `tsc -b` builds it in dependency order.
`packages/pi-acp/tsconfig.json` is a composite project extending the shared base (the acp-agents
convention).

### 10.4 Production caller cleanup boundary (`packages/acp-agents`)

Pi session close uses the compile-time deadline `5,000 + 1,000 = 6,000 ms`, strictly greater than the
server cleanup generation; other backends retain 5,000 ms. Only exact
`code === -32603 && data.errorKind === "child_cleanup_error"` is propagated. The connection is
atomically quarantined before reuse, every active session receives close before disposal, and disposal
starts after the last close. `SessionHandle.release()` exposes the retained rejection.

`PooledConnection.dispose()` is memoized. Pi receives stdin/request end plus SIGTERM and the complete
`66,000 + 1,000 = 67,000 ms` server envelope before SIGKILL; other backends retain 2,000 ms. Pool,
runner, and interactive disposal are all-settled, always perform teardown, and reject the first retained
child-cleanup error in stable session order. A release-time child failure overrides success, primary
error, or caller abort. Error mapping classifies that exact discriminant as fixed redacted
`AGENT_EXECUTION_ERROR` with `recoverable:false`; another `-32603` retains generic recoverable behavior.

The coordinated Changesets transaction is minor for `@automatalabs/pi-acp` and
`@automatalabs/acp-agents`, patch for `@automatalabs/workflows` and `@automatalabs/mcp-server`. Published
workflow→acp-agents→pi-acp dependency edges and the installed smoke checks are verified together.

---

## 11. Non-goals (v1) — with rationale
- **`session/delete`** — pi's `SessionManager` exposes no delete/unlink API; hand-unlinking `.jsonl`
  files risks corrupting the fork tree and would violate invariant 2. It is outside this adapter contract.
- **Branch-topology + compaction-summary replay on `session/load`** — v1 replays the linear active
  branch (`getBranch()`) only; ACP `session/update` has no representation for fork topology, and the
  compaction summary is model-facing, not a human transcript (§9.1.2). `getTree()` metadata is not
  replayed.
- **`additionalDirectories`** — not advertised; pi has no allowed-roots concept, so extra roots grant no
  capability pi lacks. A present field is accepted and ignored (§9.1.7).
- **Audio prompt content** — no pi representation; not advertised; degraded to a text note (§6.1).
- **fs/terminal client-delegation suite** — terminal output is surfaced via the shared `_meta` tool_call
  convention (like claude-agent-acp/codex-acp), not ACP `terminal/*` or `fs/*`.
- **Client-hosted `acp` MCP transport** — remains owned by the runner; pi-acp serves stdio, Streamable
  HTTP, and legacy SSE (§9.3).
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
   `ModelRuntime.getModel(provider, id)` (`model-runtime.ts:293`) — what `createAgentSession` itself
   uses — is the runtime path covering builtin + custom-configured providers.
5. **Returning `stopReason:"end_turn"` on provider error** (or minting a synthetic `error` stopReason).
   Rejected: the ACP `StopReason` enum has no error member (`types.gen.d.ts:3027`), and an error that
   looks like a normal turn defeats the client's pause/retry logic. Errors reject with `data.errorKind`;
   `-32000` is auth-exclusive (§8).
6. **Advertising a necessarily-partial representative `model` list.** Rejected (the original
   design-minimalism finding 2): such a fabricated list would mislead the `config-options.md` §2.3
   validate probe. The current contract overturns the old no-select conclusion because the adapter now
   advertises the real ordered cache returned by a completed, credential- and `Provider.filterModels`-
   aware `ModelRuntime.getAvailable()` call after extension bind (§5.1–§5.2). The display and set paths
   refresh and use that same cache, so no representative or provisional list is published.
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
10. **Keeping MCP remote transports hidden.** Rejected: Pi serves stdio, Streamable HTTP, and legacy
    SSE and truthfully advertises HTTP/SSE; this is also the standard StructuredOutput injection path.
11. **Advertising `session/delete`** and unlinking session files by hand. Rejected: no first-class pi
    API; risks fork-tree corruption; violates invariant 2.
12. **Replaying `buildSessionContext()` (compaction-aware) on `session/load`.** Rejected: that is the
    model-facing compacted context (summaries replace history), not the human transcript. `getBranch()`
    replays the full active branch (§9.1.2), which is what a client rehydrating a conversation wants.
13. **Aliasing MCP tools only on collision** (the round-2 rule) instead of unconditional `mcp__…`
    prefixing. Rejected (§9.3.2): the reserved inline extension needs a stable namespace that can be
    reserved before remote catalogs and maintained across dynamic add/remove/re-add transactions.
    Unconditional
    `mcp__<server>__<tool>` (the well-known MCP convention) puts every bridged tool in a reserved
    namespace pi built-ins/extensions never use, making MCP-vs-builtin/extension collisions structurally
    impossible and the naming fully deterministic (`_meta.toolName` still carries the alias for the
    permission matcher).
14. **Disabling pi extensions to sidestep tool-name collisions.** Rejected (§9.3.2): a pi user's
    configured extensions must keep working through the ACP server — disabling them makes pi-acp a lesser
    pi. Extensions stay enabled and are part of collision discovery; the reserved `mcp__` extension is
    placed first while configured extension hook and core-bash precedence remain intact.
15. **`session/list` returns the full sorted list with no pagination** (omitting `nextCursor`, which the
    SDK permits). Considered (it is strictly less surface: no cursor codec, no `invalid_cursor` row) and
    rejected: `listAll` (no cwd) can return a user's **entire** cross-project session history — potentially
    thousands of entries — so an unbounded single response is a real memory/latency hazard for our own
    client. Offset pagination (page 100, exact base64url cursor, §9.1.5) bounds each response while
    returning every session across pages (it chunks, never truncates) — the bounded-liveness choice,
    consistent with the injectable MCP/cleanup timeouts.
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
| T8 | §8.1/§8.2 | **every canonical row (1–26)**: pinned code + `errorKind`; the **exact adapter-owned wire shape** `{ code, message:<SDK prefix>, data:{ errorKind, message:<fixed label> } }` (+ `server` for 16/17, redacted diagnostic `details` for 4/23, and integer-only `{ remainingChildren }` for 19); a structurally-malformed prompt block → SDK `zPromptRequest` `invalidParams`, **no** `errorKind` (row 8); `$/cancel_request` during an opening transaction → **`-32800`** with the transaction rolled back (row 25); `close` on unknown/ordinary-or-cleanup-complete tombstoned id **succeeds** (not row 12/14), while a retained child-cleanup tombstone is row 19; row-23 catch-all → `internal_error`; classification precedence (auth>billing>rate>generic); **redaction sentinel: a terminal error whose diagnostic `error.message` AND `error.stack` carry a sentinel secret → the secret is in NONE of `error.message`/`data.message`/`data.details`, diagnostic `data.details` is only the `{ type, timestamp }` projection, and child cleanup details contain only `remainingChildren`** |
| T9 | §5.1/§5.2 | initialize and every successful set return `[thinkingLevel, model]`; the model choices equal the completed credential/filter-aware catalog in order, current-value states are exact, every set refreshes before mutation, duplicate model ids select the first cached object, and an unavailable model rejects `invalid_model` |
| T10 | §5 | initialize returns the exact agent capabilities: load/resume/fork/list/close, image prompts, and `mcpCapabilities:{ http:true, sse:true }`, with no Pi private capability namespace, delete, or additionalDirectories |
| T11 | §9.2 | permission wire order + exactly-once: for each `toolCallId`, the pending `tool_call` (from `tool_execution_start`) is on the wire **before** `session/request_permission` (drain enforced), and the wrapper emits **no** `session/update`; exactly one pending + one terminal `tool_call_update` on **every** path — allow_once, allow_always, reject_once, **unknown/missing `optionId` → fail-safe deny**, cancelled-outcome, turn-abort-wins-race, transport-failure(fail-safe deny, turn continues), inner-hook block, inner-hook throw; **wrapper delegates to `inner` after BOTH a fresh allow AND an `allow_always` cache hit** (a cache hit combined with an inner block/throw still blocks); `allow_always` name-scoped single-session cache skips only the round-trip |
| S1–S4 | §9.4 | PiBackend enables common prompt embedding and HTTP StructuredOutput injection, carries no private metadata/native hook, actual runner+pi-acp transport captures a schema-valid call, and invalid/absent capture uses only the common validated last-text ladder |
| T13 | §9.5 | six auth methods advertised **unconditionally** (incl. when client sends no `auth` capability), each with its **exact pinned `id` + `name`** payload; `authenticate(env_var/agent)` no-op success; `pi-stored-credentials` is `agent`-typed ambient-disk (no interactive login); unknown method → `unknown_auth_method` |

### 13.2 Integration (scripted ACP client over the injected stream)

| # | covers | assertion |
|---|---|---|
| T14 | §6.2/§6.2.1, §6.6 | full turn: ordered `session/update` stream drained before `PromptResponse`; a notify-failure fixture with successful cleanup rejects `notification_error` with NO `usage_update`/`drain`; notification failure plus cleanup failure rejects only `child_cleanup_error`; a close racing an in-flight prompt with successful cleanup still emits `usage_update`+`drain`+resolves `cancelled` before queue teardown |
| T15 | §9.1.0-.6 | lifecycle + concurrency matrix: new→prompt→close; **two concurrent `load`s for one id** → exactly one wins, the other `session_already_open`, no leak (atomic reservation); unknown id (load/resume/prompt) → `unknown_session`; `close` on unknown/already-closed/ordinary-or-cleanup-complete tombstoned id → **success**, and **close whose non-child `dispose()` leg throws → still success (entry dropped, retry clean)**; retained child cleanup is the sole row-19 exception and retries; close-races-prompt → cancelled; busy fork/set_config → `session_busy`; cwd validation on **new/fork-target**/load/resume/list; **the same injected `deps.modelRuntime` object is passed on ALL FOUR `createAgentSession` call sites**; **open-time races: `$/cancel_request` during open → `-32800` + rollback (no leak); `close` during an opening txn → success + rollback (no resurrection); `dispose()` during an opening txn → rollback (no post-dispose commit)** |
| T15b | §9.1.0 | transactional rollback: inject a failure after **each** acquisition stage (MCP connect, `createAgentSession`, wrapper install, load replay-`notify`) and assert no live registry entry, no MCP child, no listener, no pi resource (pi `dispose()` called), and no `opening` reservation remains; a post-rollback retry is a clean open, not `session_already_open`; **the irreversible-fork case: after `forkFrom` writes successfully, inject a `createAgentSession` failure → the new JSONL remains a complete, valid, listable/loadable session while no live/opening/MCP resource leaks** |
| T16 | §9.1.2/.3/.4 | resume emits **no** replay; load replays the linear branch via the **total** SessionEntry/AgentMessage projection — user, assistant (text/thinking/toolCall), toolResult, `bashExecution`, `custom` display-true/false, `branchSummary`/`compactionSummary` (no update), `custom_message` display-true/false, and string-vs-array content; fork round-trips over a temp `sessionDir`, including **cross-cwd** source lookup via `listAll`; **fork of a live never-prompted (unpersisted) source → `session_not_forkable` (row 26), not `session_corrupt`** |
| T17 | §9.1.5 | list with cwd vs `listAll` (no cwd); exact cursor codec (`base64url` of decimal offset, page 100) + `nextCursor` set/omitted; missing/empty cursor → offset 0; `offset===length` → empty page; undecodable / non-canonical → `invalid_cursor`; **a shrink-below-cursor mutation (150 → page-1 cursor 100 → remove 60 → length 90) returns an EMPTY page, NOT `invalid_cursor` or a crash** |
| T18 | §9.1.6/§9.6 | cleanup failure tombstones the session without a false `cancelled` settlement; reopen → `session_terminated`; close succeeds for an ordinary/cleanup-complete tombstone, while a retained child-cleanup tombstone returns row 19 and retries until disappearance proof succeeds |
| T19 | §9.1.7 | non-empty `additionalDirectories` accepted and ignored on **new AND load AND resume AND fork** (session still created; extra roots ignored) |
| T20 | §9.3.1-.3 | base bridge coverage: full tools pagination/cursor-cycle rejection, duplicate names, deterministic 128-char aliases, fixed tool failure/timeout labels, exact full-result `rawOutput`, partial-open close, and new/load/resume/fork injection |
| M1 | §5/§9.3.4 | one table-driven transcript uses actual SDK stdio, Streamable HTTP, and legacy SSE transports, preserves repeated HTTP/SSE header order, advertises `{ http:true, sse:true }`, and rejects only client-hosted `acp` |
| M2 | §9.3.1/§9.3.4 | connect and every outgoing operation use deterministic lifecycle/turn > disposal > peer > timeout > completion arbitration with late-settlement suppression; wrapper logical close is once-only, HTTP alone performs bounded DELETE, stdio/SSE raw close stays transport-owned, every close starts synchronously in reverse acquisition order, and DELETE/raw close share injected `deps.mcpTimeoutMs` |
| M3 | §9.3.3/§9.3.6 | strict capabilities are authoritative (including resources-only/no-tools and subscription conditioning); package identity, ping/instructions, canonical content/result projection, exact raw pages/results, schemas, every stable operation, logging, and advertised/unadvertised notifications are covered |
| M4 | §6.2.1/§9.3.6 | progress reaches Pi and ACP with full `rawOutput`; cancellation reaches the peer and suppresses late updates; interleaved diagnostics and turn updates use one FIFO, prompt settlement drains it, notification failure aborts as `notification_error`, and outside-turn/post-dispose routing is fixed |
| M5 | §6.6/§9.3.5 | exact synthetic-before-remote alias order; ADD/CHANGE/UNCHANGED/REMOVE/RE-ADD state and validators; two-server serialized prepare/commit rebasing; duplicate/task-required open-vs-refresh outcomes; initial coalescing barrier; current-turn snapshot retention; fault rollback/poison; prompt/config/fork admission and close/dispose races |
| M6 | §8/§9.3.2 | configured extension order, reserved-MCP precedence, control/bash verification, exact server-attributable `mcp_init_error`, global `extension_setup_error`, and deep redaction are covered |
| M7 | §9.3.7 | every sampling role/media/payload mapping, system prompt/metadata rule, response mapper, unsupported base-sampling additions, peer/disposal/turn/timeout/completion races, roots, both elicitation modes and registries, progress, exact form validation, and no permission request are covered |
| M8 | §9.3.2/§9.3.8 | post-connect ping failure ownership, partial-open rollback order, pre-publication behavior, raw fatal vs protocol error, held-boundary peer death, per-server disable/no reconnect, exact diagnostics, post-dispose suppression, and original-error × cleanup-result precedence are covered |
| M9 | §9.3.6/§9.3.8 | subscribe then new/load/resume/fork proves every connection starts unsubscribed; replay/fork/open failure adds no MCP history mutation and only an explicit later tool call re-subscribes |
| C1 | §5.1/§5.2 | initial and every successful echo deep-equal the complete two-option surface; a real Pi configured-provider writer fixture exposes provisional unfiltered state while publication waits for completed credential/filter-aware availability; filtered-out models are neither shown nor accepted |
| C2 | §5.1 | no-active/empty, active, active-unlisted, and active-unlisted/empty current-value and option states are exact |
| C3 | §5.1 | an executed hermetic workflows `config pi` origin probe enumerates the model choices while the authored-config model guard remains active |
| C4 | §5.2/§6.6 | every set refreshes before mutation; first duplicate identity wins; filtered/absent/auth/refresh/busy paths are exact; refresh failure is non-mutating; synchronous reservation excludes prompt/config/fork; every success echoes both options |
| E1 | §8.2 | every pinned provider string maps through auth > billing > rate > generic precedence to the intended backend classification, including both OAuth provenance sites and byte-equal normalized guidance |
| E2 | §8.2 | the fixture Pi version equals the installed direct Pi version, making a runtime bump without recapture fail |

### 13.3 Hermetic e2e

| # | covers | assertion |
|---|---|---|
| T21 | §4.1 | inject a `createAgentSession` that wraps `new Agent({ streamFn: mockStream })` in an `AgentSession`; drive a full ACP conversation end-to-end with **zero external credentials** — the same seam consumed by the first-class engine e2e; the spy asserts the injected `deps.modelRuntime` identity is threaded on every `createAgentSession` call |
| A1 | §9.6/§6.2.1 | real Unix/Windows tracked bash launches a leader plus descendant; cancel, close, rollback, shutdown, and tool timeout wait for disappearance proof; Unix ESRCH and Windows successful `taskkill /T /F` plus leader close gate record removal; failure/deadline latches the retained record and only `child_cleanup_error` surfaces |
| A2 | §9.6 | concurrent session trees are isolated: cancelling A removes only A's leader/descendant while B remains alive until B closes |
| A3 | §9.6 | exact cleanup wire shape, retained-record counts, repeated close, concurrent top-level-dispose join, fail→success, fail→fail, post-success no-op, and once-only non-child disposal are covered |
| A4 | §9.1.0/§9.6 | new/load/resume/fork cross cancellation/MCP/extension/replay failures with cleanup success/failure; failure overrides exactly, published and hidden retry ownership is retained, reverse closes and HTTP termination all run, and replacement/shutdown honor the 66,000-ms envelope |
| A5 | §10.4 | acp-agents Pi close/process margins, exact error propagation/quarantine, all-settled runner/interactive disposal, memoized process disposal, and non-recoverable mapping are covered |

### 13.4 Live e2e (gated on provider keys)

| # | covers | assertion |
|---|---|---|
| T23 | §9.4 | the built-in PiBackend live leg uses the injected HTTP StructuredOutput tool plus common prompt fallback; no private Pi capability switch exists. The provider call runs only behind its explicit env/key gate; credential-free CI reports a passing assertion that the gate remains closed. |
| L1 | §9.3.7/§9.6 | the same gated cheap-model leg attaches a real HTTP MCP server and round-trips its tool, then starts `sleep 180`, stops the turn, and proves the tracked child is reaped |

### 13.5 Packaging / integration guards

| # | covers | assertion |
|---|---|---|
| T24 | §2.3 | manifest pins are exact (no caret); `main`/`exports`→`dist/lib.js`, `bin`→`dist/index.js`; packed `files:["dist"]` |
| T25 | §10.1 | `check-acp-deps.mjs` matches `@earendil-works/pi-coding-agent` (freshness matcher) |
| T26 | §10.3, §15 | root `tsconfig.json` references `packages/pi-acp`; a changeset exists |
| T27 | §15 | README covers bin/library/routing, configured model catalog, auth, stdio/HTTP/SSE, client-hosted `acp`, `mcp__`, limits, and attribution; whole-file negatives reject the retired private structured channel and remote-transport-only claims |

Transport conformance also runs one unchanged transcript against actual stdio, Streamable HTTP, and SSE
SDK transports, including paging, dynamic registration, base protocol, client features, cancellation,
headers, and close. A credential-free runner→subprocess→pi-acp→HTTP StructuredOutput test proves the
standard injection path; provider classifier fixtures are pin-guarded against the installed runtime.

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
`github.com/earendil-works/pi`, tag **`v0.80.10`**, commit
**`8dc78834cde4e329284cf505f9e3f99763df5529`**; npm `@earendil-works/pi-coding-agent@0.80.10`
(lockstep with `@earendil-works/pi-agent-core@0.80.10`, `@earendil-works/pi-ai@0.80.10`). Freshness
re-checked 2026-07-16: `releases/latest` = `v0.80.10`, `npm view … version` = `0.80.10` — pin is
current. The released model/auth refactor and its mechanical contract migration are recorded in
**§0.1**; the byte-compatible v0.80.9 repin in **§0.2**; the catalog-only v0.80.10 repin in **§0.3**.

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

### pi `v0.80.10` (commit `8dc7883`)

- `packages/coding-agent/package.json` — name `@earendil-works/pi-coding-agent`, `bin { pi:
  dist/cli.js }`, `exports { ".", "./rpc-entry" }`, `engines.node >=22.19.0`, deps
  pi-agent-core/pi-ai/pi-tui `^0.80.10` + `typebox 1.1.38`.
- `packages/coding-agent/src/core/sdk.ts` — `CreateAgentSessionOptions` :33-80 (cwd, agentDir,
  **`modelRuntime?` :39-40**, model, thinkingLevel, tools/excludeTools/customTools, sessionManager; **no**
  beforeToolCall/streamFn), **`CreateAgentSessionResult { session, extensionsResult,
  modelFallbackMessage? }` :83-91** (the real return type — `.session` is the `AgentSession`),
  `createAgentSession(): Promise<CreateAgentSessionResult>` :164-393 (`const modelRuntime =
  options.modelRuntime ?? await ModelRuntime.create(...)` :169-171; `return { session,
  extensionsResult, modelFallbackMessage }` :388-392), `modelRuntime.getModel` restore :192,
  internal `streamFn` → `modelRuntime.streamSimple` :297-324, `buildSessionContext` restore :182-210,
  `findInitialModel` :201-217, `new AgentSession({ agent, sessionManager, customTools, modelRuntime, … })`
  :371-385.
- `packages/coding-agent/src/index.ts` — public exports of `AgentSession`/`AgentSessionEvent` :15-27,
  `ModelRegistry` compatibility facade :162, `ModelRuntime`/`CreateModelRuntimeOptions`/
  `ModelRuntimeAuthOverrides` :171-175, `createAgentSession*` :188-214, `SessionManager` :235.
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
  `_handlePostAgentRun` :1037-1069, `_isRetryableError` :2577, `setModel` :1566-1580 (async auth check and
  no-auth throw :1567-1569), `setThinkingLevel` :1630-1640 (clamp :1632), `getContextUsage` :3078-3110
  (`ContextUsage.tokens` = current context, drops on compaction — NOT monotonic),
  `getSessionStats` :3023-3076 (cumulative `cost`/`tokens`, `contextUsage`; `cost` monotonic).
- `packages/coding-agent/src/core/auth-guidance.ts` — `formatNoModelSelectedMessage` :18-20,
  `formatNoApiKeyFoundMessage` :22-25 (ground the §8.2 pre-flight predicates); OAuth "Authentication
  failed for … Run '/login" throw at `agent-session.ts:1174-1182`.
- `packages/coding-agent/src/core/model-runtime.ts` — `CreateModelRuntimeOptions` :58-68,
  `ModelRuntimeAuthOverrides` :70-73, asynchronous `ModelRuntime.create` :130-165,
  `getModel(provider, modelId)` :293-295, `hasConfiguredAuth(provider)` :354-356, `getAuth` overloads
  :358-385, and `streamSimple` :472-474.
- `packages/coding-agent/src/core/auth-storage.ts` — internal file-backed credential store factory
  `AuthStorage.create(authPath?)` :180 (not exported from the package index; consumed by
  `ModelRuntime.create` at `model-runtime.ts:131`).
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
- `packages/coding-agent/src/core/model-registry.ts` — synchronous extension compatibility facade,
  constructed as `new ModelRegistry(runtime)` :16-25; `find(provider, modelId)` delegates to
  `runtime.getModel` :44-45, `hasConfiguredAuth(model)` delegates to the provider-level runtime check
  :48-49, `getApiKeyAndHeaders` :52-89, and `isUsingOAuth` :107-109.
- `packages/ai/src/env-api-keys.ts` — `getApiKeyEnvVars` provider→env catalog (ANTHROPIC_API_KEY(+OAuth
  :71), OPENAI_API_KEY :76, GEMINI_API_KEY :80, XAI_API_KEY :84, OPENROUTER_API_KEY :86, …) :64-110,
  `findEnvKeys` :120-122.
- `packages/ai/src/compat.ts` — `getModel`/`getModels` (`@deprecated`) :61-65.
- `packages/ai/src/providers/all.ts` — `getBuiltinModel` :53, `getBuiltinModels` :65.
- `packages/ai/src/api/openai-completions.ts:1110`, `bedrock-converse-stream.ts:918`,
  `google-shared.ts:283-284`, `mistral-conversations.ts:491` — providers consume `tool.parameters` as
  raw JSON Schema (symbol keys stripped), grounding MCP input-schema registration (§9.3).

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
It MUST cover, at minimum (asserted by T27):

- **bin invocation** — `npx @automatalabs/pi-acp` (stdio ACP server; stdout is ACP ndjson only, §3) and
  `pi-acp --version`.
- **library API** — the side-effect-free entry: `runAcp(options?)`, `PiAcpAgent`, `resolveDeps`, and the
  `PiAcpDeps` type; that importing the package starts no server and mutates no console/stdio (§3.1).
- **first-class backend routing** — backend-only `pi`, explicit `pi/<provider>/<model-id>`, exact
  one-segment stripping, and configured model-catalog discovery (§5/§9.4).
- **model format** — `"<provider>/<model-id>"` set via the reserved config channel; unknown → `-32602`
  `invalid_model` (§5.2).
- **auth behavior** — the advertised methods (five env-var providers + `pi-stored-credentials`, each with
  its exact `id`/`name`), ambient-credential resolution, and the `-32000` pause **when a selected/resolvable
  model's credential is missing** (the no-model case is `-32602 invalid_model`, not auth — §9.5).
- **reserved tool namespaces** — pi-acp owns the `mcp__` prefix for injected MCP tools (§9.3.2).
- **v1 limitations** — client-hosted `acp` MCP remains in the runner; no branch-topology/compaction-summary replay; no
  `additionalDirectories`/audio/terminal-login (§11). Native `_session/steering` is documented in §6.6.
- **attribution** — a "Built on pi" note and a THIRD-PARTY notice naming pi
  (`@earendil-works/pi-coding-agent`/`-agent-core`/`-ai`), its authors, its MIT license, and the pinned
  version.

The central backend docs and authoring skill also document the first-class `pi` route; this package
README remains the normative server-level invocation and embedding reference.
