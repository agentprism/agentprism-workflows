# `@automatalabs/pi-acp` — In-process ACP Server for the pi Coding Agent

**Date:** 2026-07-15

**Status:** Frozen implementation contract for issue #198. Round 2 (supersedes round 1; addresses the
references-accuracy, adversarial-completeness, and design-minimalism review boards).

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

### 3.1 Library entry (`src/lib.ts`)

```ts
export { runAcp, PiAcpAgent } from "./server.js";              // server.js re-exports PiAcpAgent
export type { PiAcpDeps } from "./deps.js";
export { resolveDeps } from "./deps.js";
```

`lib.ts` performs **no** console mutation, opens **no** stdio, and starts **no** server on import.
Importing `@automatalabs/pi-acp` yields `runAcp`/`PiAcpAgent`/`PiAcpDeps` with zero process side effects
(tested per §13.1 T2). `runAcp` only connects a stream when *called*.

### 3.2 Shutdown state machine (resolves adversarial finding 2)

- **Idempotent + awaited.** `shutdown` memoizes its work in `shuttingDown`; concurrent triggers
  (`connection.closed`, SIGINT, SIGTERM) all await the same single disposal. `agent.dispose()` disposes
  **every** open `PiSession` (abort in-flight turns, unsubscribe the translator, drain-and-drop the send
  queue, disconnect MCP clients — §9.6) and resolves once all are disposed.
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
  const app = acpAgent({ name: "@automatalabs/pi-acp", version: PKG_VERSION })
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
truthful response for a method whose capability is not advertised (§5). `$/cancel_request` and
`session/cancel` share one abort path (§9.6): the SDK aborts the in-flight request's `context.signal`,
which the adapter has wired to `agent.abort()`.

Each handler receives an `AgentRequestContext` exposing `context.params` (schema-parsed request),
`context.signal` (aborted on cancel), and `context.client` (an `AgentContext` with `notify(...)` for
`session/update` and `request(...)` for `session/request_permission`) (`acp.d.ts:142-206,367-396`).
All handler contexts wrap the same connection, so a `PiSession` captures its
`notify(update) = context.client.notify(methods.client.session.update, { sessionId, update })` at
`session/new` (or reattach) and reuses it for the session's lifetime.

### 4.1 Dependency-injection seam (`src/deps.ts`) — resolves adversarial finding 13

`PiAcpAgent` takes exactly one constructor argument, a fully-resolved `PiAcpDeps`. `resolveDeps(partial?)`
fills each field with its real default; tests pass overrides. This is the ONLY seam tests use — no ESM
monkey-patching (unreliable) is required.

```ts
export interface PiAcpDeps {
  /** Build an AgentSession. Default: pi's real createAgentSession (sdk.ts:167). */
  createAgentSession(opts: CreateAgentSessionOptions): Promise<AgentSession>;
  /** SessionManager statics. Default: the real class methods (§9.1 citations). */
  sessions: {
    create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
    open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
    forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
    list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
    listAll(sessionDir?: string): Promise<SessionInfo[]>;
  };
  /** Shared model registry. Default: ModelRegistry.create(AuthStorage.create(authPath)). */
  modelRegistry: ModelRegistry;
  /** Root for session JSONL. Default: undefined => pi's ~/.pi/agent/sessions/<encoded-cwd>. */
  sessionDir?: string;
  /** MCP stdio client factory. Default: a real @modelcontextprotocol/sdk stdio client (§9.3). */
  connectMcpClient(server: McpServerStdio, signal: AbortSignal): Promise<McpClientHandle>;
  /** Monotonic clock for the wedged-agent grace timer. Default: () => Date.now(). */
  now(): number;
  /** Grace window after abort before force-resolve (§9.6). Default: 5000. */
  graceMs: number;
}
```

The hermetic e2e substrate (§13.3): a test `createAgentSession` builds
`new AgentSession({ agent: new Agent({ streamFn: mockStream, … }), sessionManager, … })` — the
pi-agent-core injectable `streamFn` (`agent.ts:214`) wrapped in an `AgentSession` (its constructor takes
`agent`, `agent-session.ts:343`) — driven with zero credentials. `now`/`graceMs` make the §9.6 backstop
deterministic; `sessionDir` points at a temp dir; `stream` (runAcp arg) is an in-memory paired ndjson
stream.

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
`setModel` throws synchronously if the model has no configured auth (`agent-session.ts:1538-1540`); that
throw is caught and re-mapped to `authRequired` (`-32000`, §8), not `invalidParams`.

**Model resolution** (`registry`-first, decisive, non-deprecated):

1. Construct the registry once per process via the DI seam: `deps.modelRegistry` (default
   `ModelRegistry.create(AuthStorage.create(authPath))`; `model-registry.ts:391`; `AuthStorage.create`
   at `auth-storage.ts:215`).
2. For a spec `"<provider>/<model-id>"` (first `/` splits provider from the rest verbatim),
   `registry.find(provider, modelId)` (`model-registry.ts:695-696`) — exactly what `createAgentSession`
   uses internally (`sdk.ts:197`); covers builtin + custom-configured providers.
3. Found → pass as `createAgentSession({ model })`; auth resolves at stream time via
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
`errorKind:"empty_prompt"`). Structured-output instruction text (§9.4), when armed, is prepended to the
text buffer after this fold.

### 6.2 Ordered notification delivery (`src/session.ts`) — resolves adversarial finding 4 (ordering)

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

**notify-failure contract.** If `this.notify(update)` rejects (transport closed/broken), the pump stops
and records the failure. During an active turn: `agent.abort()` the turn and reject the originating
request with `internalError` (`-32603`, `errorKind:"notification_error"`). During replay: reject
`session/load` with `internalError` (`errorKind:"notification_error"`). A rejected notify after the turn
already resolved is logged to stderr only (the request is done). On `session/close`/dispose the pump is
cancelled and `pending` dropped.

### 6.3 Live event translation table (pi `AgentSessionEvent` → ACP `SessionUpdate`)

pi's event model has three verified layers: session-level `AgentSessionEvent` (`agent-session.ts:127-155`),
which re-exposes loop-level `AgentEvent` (`agent/types.ts:415-430`), whose `message_update` carries the
pi-ai `AssistantMessageEvent` token-delta union (`ai/types.ts:464-476`).

| pi event (source) | ACP `sessionUpdate` | notes |
|---|---|---|
| `message_update` → `assistantMessageEvent` `text_delta` | `agent_message_chunk` | `content: { type:"text", text: delta }` |
| `message_update` → `assistantMessageEvent` `thinking_delta` | `agent_thought_chunk` | separate thinking stream — the bridge folds this into message chunks; we do not |
| `tool_execution_start` `{toolCallId,toolName,args}` | `tool_call` | `{ toolCallId, title: toolName, kind: mapKind(toolName), status:"pending", rawInput: args, locations: fileLocations(args), _meta:{ toolName } }` (§6.4, §9.2) |
| `tool_execution_update` `{toolCallId,toolName,args,partialResult}` | `tool_call_update` | `{ toolCallId, status:"in_progress", content: toContent(partialResult) }` |
| `tool_execution_end` `{toolCallId,toolName,result,isError}` | `tool_call_update` | `{ toolCallId, status: isError?"failed":"completed", rawOutput: result, content: toContent(result) }`; `read`/`edit`/`write` emit `type:"diff"` content with old/new text when the result exposes it |
| terminal `Usage` (on the terminal `AssistantMessage`) + session stats | `usage_update` (once per turn) + accumulate into `PromptResponse.usage` | §6.5 |
| `compaction_start`/`compaction_end`, `queue_update`, `auto_retry_start`/`auto_retry_end`, `agent_settled`, `session_info_changed`, `thinking_level_changed`, `entry_appended`, `agent_start`, `turn_start`/`turn_end`, `message_start`/`message_end` | **no fabricated `session/update`** | v1 emits none of these as content; `auto_retry_*` and `compaction_*` surface only through the terminal stopReason/usage. No invented updates. |

The `assistantMessageEvent` `*_start`/`*_end` boundary markers sequence chunks (via `contentIndex`) but
emit no standalone update beyond the `*_delta` rows above.

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

Emit exactly one `usage_update` per turn, after the turn settles and before `drain()`. Because
`getSessionStats().cost` and `getContextUsage()` aggregate over the whole session, `used` and
`cost.amount` are monotonic/context-correct across multi-message turns, multiple turns, and after
load/resume (the restored journal is included). Our client reads `cost.amount` into `AgentUsage.cost`
(`usage.ts:11-17,28-59`) and treats `PromptResponse.usage` as authoritative for the token breakdown.

### 6.6 Turn lifecycle and concurrency

One ACP `session/prompt` drives one pi turn: convert content (§6.1), arm structured output if requested
(§9.4), then `await session.prompt(text, { images })` (`agent-session.ts:1076`), which awaits
`agent.prompt()` plus pi's auto-retry/compaction loop and settles by emitting `agent_settled` in a
`finally` (`agent-session.ts:1023-1034`). After it resolves: compute stopReason (§7) and usage (§6.5),
emit `usage_update`, `await drain()` (§6.2), then resolve `{ stopReason, usage }`.

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

| # | condition | constructor | code | `data` |
|---|---|---|---|---|
| 1 | auth required / missing-or-invalid provider credential (pre-flight throw OR classified terminal error) | `authRequired` | **`-32000`** (auth-exclusive) | `{ errorKind:"auth_error" }` |
| 2 | provider rate/quota wall (classified) | `internalError` | `-32603` | `{ errorKind:"rate_limit" }` |
| 3 | provider billing/quota-exhausted wall (classified) | `internalError` | `-32603` | `{ errorKind:"billing_error" }` |
| 4 | other terminal `stopReason "error"` | `internalError` | `-32603` | `{ errorKind:"provider_error", details?: redactedDiagnostics }` |
| 5 | unknown model spec (§5.2) | `invalidParams` | `-32602` | `{ errorKind:"invalid_model" }` |
| 6 | no model selected before first prompt and pi has no default | `invalidParams` | `-32602` | `{ errorKind:"invalid_model" }` |
| 7 | empty prompt (§6.1) | `invalidParams` | `-32602` | `{ errorKind:"empty_prompt" }` |
| 8 | invalid content block (missing image `data`/`mimeType`; malformed block) | `invalidParams` | `-32602` | `{ errorKind:"invalid_content" }` |
| 9 | second concurrent prompt on a busy session (invariant 4) | `invalidParams` | `-32602` | `{ errorKind:"session_busy" }` |
| 10 | set_config_option: unknown id / bad value / wrong type / busy (§5.2) | `invalidParams` | `-32602` | `{ errorKind: as in §5.2 }` |
| 11 | invalid cwd (not absolute / does not exist / not a directory) on new/fork | `invalidParams` | `-32602` | `{ errorKind:"invalid_cwd" }` |
| 12 | unknown session id (load/resume/fork/close/prompt/set_config) | `invalidParams` | `-32602` | `{ errorKind:"unknown_session" }` |
| 13 | poisoned/tombstoned session reopen or use (§9.1.6) | `invalidParams` | `-32602` | `{ errorKind:"session_terminated" }` |
| 14 | malformed/corrupt session JSONL on open | `internalError` | `-32603` | `{ errorKind:"session_corrupt" }` |
| 15 | MCP connect/list failure on a lifecycle method (§9.3) | `internalError` | `-32603` | `{ errorKind:"mcp_init_error", server: <name> }` |
| 16 | structured-tool reserved-name collision (§9.4) | `internalError` | `-32603` | `{ errorKind:"structured_tool_collision" }` |
| 17 | invalid `_meta.outputSchema` (non-object / not a schema) | `invalidParams` | `-32602` | `{ errorKind:"invalid_output_schema" }` |
| 18 | notification delivery failure mid-turn/replay (§6.2) | `internalError` | `-32603` | `{ errorKind:"notification_error" }` |
| 19 | permission `client.request` transport failure (§9.2) | treated as deny → turn continues; if the abort also fails, `internalError` | `-32603` | `{ errorKind:"permission_error" }` |
| 20 | unknown/unsupported method | SDK default | `-32601` | — |

Reserved-code facts (verified in the installed SDK `jsonrpc.js`): `-32700` parseError, `-32600`
invalidRequest, `-32601` methodNotFound, `-32602` invalidParams, `-32603` internalError, `-32800`
requestCancelled, **`-32000` authRequired (exclusive)**, `-32002` resourceNotFound. `-32002` is used by
no row above — pi surfaces "not found" for sessions as `invalidParams`/`unknown_session` (rows 12/13),
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
  `message.errorMessage` **plus** each `message.diagnostics[*]` text (`AssistantMessage.diagnostics` is
  pi's redacted diagnostics, `ai/types.ts:396`). Match in this precedence:
  1. auth: `/\b401\b|\b403\b|unauthorized|invalid api key|authentication|forbidden|expired/` → row 1
     (`auth_error`, `-32000`).
  2. billing/quota-exhausted: `/quota|billing|insufficient|payment|credit|exceeded your/` → row 3
     (`billing_error`).
  3. rate: `/\b429\b|rate limit|too many requests|overloaded/` → row 2 (`rate_limit`).
  4. otherwise → row 4 (`provider_error`).

The precedence is fixed (auth > billing > rate > generic) so two implementations classify the same text
identically. This uses the same `internalError`+`errorKind` shape claude-agent-acp emits
(`dist/acp-agent.js:2044,2080`).

**Redaction rule.** The haystack used for classification is **never** echoed on the wire. `data.message`
is set to a fixed category label (e.g. `"provider rate limit"`), never the raw `errorMessage`.
`data.details`, when present, is set ONLY to `message.diagnostics` (pi-redacted) — never `errorMessage`,
which may contain request echoes or key fragments. Our generic mapper folds `data.message`/`data.details`
into the classifiable error text (`errors-map.ts:33-71`) without needing the raw provider string.

**Downstream client behavior.** `-32000` → `AUTH_REQUIRED` pause by code alone
(`errors-map.ts:135-146`; `ACP_AUTH_REQUIRED_CODE_EXCLUSIVE`, `protocol-coverage.ts:152-154`). Until the
follow-up `PiBackend` adds a `classifyProviderError` (`backends/codex.ts:39-51`) that promotes
`rate_limit`/`billing_error` to `PROVIDER_USAGE_LIMIT` pauses, the generic client classifies rows 2/3/4
as recoverable execution errors — correct default behavior.

---

## 9. Feature surfaces

### 9.1 Sessions (`src/session.ts`, `src/replay.ts`) — resolves adversarial findings 4, 5, 6

The adapter holds a per-connection `Map<sessionId, PiSession>` (live) plus a per-connection
`Set<sessionId>` of **tombstones** (§9.1.6). Each `PiSession` owns one `AgentSession`, its translator
subscription, its send queue (§6.2), its permission wrapper (§9.2), its bridged MCP clients (§9.3), and
(when armed) its structured-output tool (§9.4). `sessionId` is pi's `SessionManager.getSessionId()`.

#### 9.1.1 `session/new`

`validateCwd(request.cwd)` (row 11 on failure) → `deps.sessions.create(cwd, deps.sessionDir)`
(`session-manager.ts:1441`) → connect the request's stdio MCP servers (§9.3; row 15 on failure, with
rollback) → `deps.createAgentSession({ cwd, model?, thinkingLevel?, customTools, sessionManager })`
(§5.2) → register the permission wrapper (§9.2), the translator (§6.3), and the structured-output tool
inactive (§9.4). Return `{ sessionId, configOptions: [thinkingLevelOption], modes: null }`
(`NewSessionResponse`, `types.gen.d.ts:2556`).

#### 9.1.2 `session/load` (reopen + replay)

Resolve the session file for `sessionId` via `deps.sessions.list(request.cwd, deps.sessionDir)`
(`session-manager.ts:1549`, → `SessionInfo{ id, path, … }`, `:170-184`); if absent → row 12.
`deps.sessions.open(path)` (`:1452`; row 14 on corrupt JSONL); connect request MCP servers (§9.3);
`deps.createAgentSession({ sessionManager })` restores the model context internally via
`buildSessionContext()` (`sdk.ts:188-204`). Then **replay the transcript to the client**: iterate
`SessionManager.getBranch()` (`session-manager.ts:1189` — the full active linear branch of
`SessionEntry`, NOT the compaction-summarized `buildSessionContext()`), projecting each entry through
`src/replay.ts` into `session/update` notifications, enqueued on the send queue, and `await drain()`
before returning. Response mirrors `session/new`: `{ configOptions, modes: null }` with restored
`currentValue` (§5.2).

**Replay projection (`src/replay.ts`)** — `SessionEntry` (`session-manager.ts:140-152`) → ACP updates.
This is a distinct table from the live one (§6.3): stored entries are `SessionEntry`/`AgentMessage`
values, not live delta events, and the SDK `SessionUpdate` union DOES include `user_message_chunk`
(`types.gen.d.ts:3437`) for the user side.

| `SessionEntry` | projection |
|---|---|
| `message`, `message.role:"user"` (`UserMessage`) | `user_message_chunk` per content item — text → `{type:"text"}`, image → `{type:"image", data, mimeType}` |
| `message`, `message.role:"assistant"` (`AssistantMessage`) | for each content item in order: `TextContent`→`agent_message_chunk`; `ThinkingContent`→`agent_thought_chunk`; `ToolCall`→`tool_call` `{ toolCallId: id, title:name, kind:mapKind(name), status:"pending", rawInput:arguments, _meta:{toolName:name} }` |
| `message`, `message.role:"toolResult"` (`ToolResultMessage`) | `tool_call_update` `{ toolCallId, status: isError?"failed":"completed", content: toContent(content), rawOutput }` |
| `custom_message` with `display:true` (`CustomMessageEntry`) | `user_message_chunk` (it participates in LLM context as a user message) |
| `thinking_level_change`, `model_change`, `compaction`, `branch_summary`, `custom`, `label`, `session_info`, `custom_message` with `display:false` | **no update** (internal bookkeeping; model/level land in `configOptions.currentValue`; §11 records that branch-topology and compaction summaries are not replayed) |

Message IDs: tool calls/updates use pi's `ToolCall.id`/`ToolResultMessage.toolCallId` (stable); message
chunks carry content only and need no id. Ordering is `getBranch()` array order (append order along the
active path). Compaction policy: replay shows the **full active branch** (what a human reviews), not the
compaction-aware context pi feeds the model — a decisive v1 choice recorded in §11.

#### 9.1.3 `session/resume` (reopen without replay)

Identical open + MCP wiring as load, but **no** replay: restore into `agent.state` and return
immediately with the restored `configOptions`. Highest-value advertisement for our client (§5).

#### 9.1.4 `session/fork`

If the source `sessionId` is unknown → row 12; if the source is **busy** (in-flight turn) → reject
`invalidParams` (`-32602`, `errorKind:"session_busy"`) — do not fork a session mid-turn. Otherwise
resolve the source path (list lookup), `deps.sessions.forkFrom(sourcePath, request.cwd ?? sourceCwd,
deps.sessionDir)` (`session-manager.ts:1490`), connect request MCP servers, wrap in a fresh
`AgentSession`, register a **new** `PiSession` under the new `sessionId`, and return it with fresh
`configOptions`.

#### 9.1.5 `session/list`

`request.cwd` present → `deps.sessions.list(cwd, deps.sessionDir)` (`session-manager.ts:1549`); **absent**
→ `deps.sessions.listAll(deps.sessionDir)` (`:1564`, all project dirs) — this is the optional-cwd policy
(SDK `ListSessionsRequest.cwd` is optional, `types.gen.d.ts:4852`). Map each `SessionInfo` to the ACP
list entry (`sessionId: id`, `cwd`, title from `name ?? firstMessage`). pi returns the full list sorted
by `modified` desc; there is no native pagination. **Cursor policy (pinned):** the adapter paginates in
memory over the sorted list with a fixed page size of **100**. The opaque `cursor`
(`ListSessionsRequest.cursor`, `:4858`) is the base64 of the 0-based offset into that stable sort;
`nextCursor` (`ListSessionsResponse.nextCursor`, `:2816`) is set when more remain, omitted otherwise. An
undecodable/out-of-range cursor → reject `invalidParams` (`-32602`, `errorKind:"invalid_cursor"`).
`getTree()` (`session-manager.ts:1239`) is **not** consulted for `session/list` (list reads
`listSessionsFromDir`, `:747,1553`) — correcting the round-1 claim.

#### 9.1.6 `session/close`, idempotency, and the concurrency matrix

`session/close` disposes the `PiSession` (abort any in-flight turn, cancel+drop the send queue,
unsubscribe, disconnect MCP clients, drop from the registry) and returns success. Pinned behaviors:

| situation | behavior |
|---|---|
| close an unknown/already-closed id | success (idempotent; close is not observable-failing) |
| duplicate `load`/`resume` for an already-live id | reject the second `invalidParams` (`-32602`, `errorKind:"session_already_open"`) — never overwrite a live wrapper (its subscription/MCP clients would leak) |
| `close` racing an in-flight `prompt` | close aborts the turn; the racing `prompt` resolves `cancelled` (§9.6) |
| `set_config_option`/`fork` racing an in-flight `prompt` | rejected `session_busy` (§5.2, §9.1.4) |
| `load`/`resume` racing each other for the same id | first wins and registers; the second sees a live id → `session_already_open` |
| use of a poisoned/tombstoned id (below) | reject `session_terminated` (row 13) |

**Poisoned-journal guard (resolves the concurrent-writer hole).** When the §9.6 backstop force-resolves
a wedged turn, the underlying pi run may still be alive and could later append to the session's JSONL.
The adapter therefore records the `sessionId` in the per-connection **tombstone** set and rejects any
subsequent `load`/`resume`/`fork`/`prompt`/`set_config_option`/reopen for that id with
`session_terminated` (row 13) for the remainder of the process — preventing a second writer from
corrupting the journal a wedged writer may still touch. Tombstones are per connection and cleared only on
connection teardown.

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
adapter must **wrap**, not overwrite it:

```ts
const inner = session.agent.beforeToolCall;                 // extension dispatch installed by AgentSession
session.agent.beforeToolCall = async (ctx, signal) => {
  const decision = await requestAcpPermission(ctx, signal); // ACP round-trip, wired to `signal`
  if (decision.block) return { block: true, reason: decision.reason };
  return inner ? inner(ctx, signal) : undefined;            // preserve the extension chain
};
```

#### 9.2.1 Frozen event/status sequence

For each tool call, in this exact order (no duplicate `tool_call`, no stranded pending):

1. **Eager `tool_call`** enqueued with `status:"pending"`, `toolCallId: ctx.toolCall.id`, title/kind/
   `_meta.toolName`. A per-session `Set<toolCallId>` marks it emitted.
2. **`allow_always` cache check** (§9.2.2): a cached allow for this tool → skip the round-trip, go to
   step 5-allow.
3. `context.client.request(methods.client.session.requestPermission, req)` with the **standard
   three-option shape** (`PermissionOption`, `types.gen.d.ts:591`; `PermissionOptionKind`, `:624`):
   `[{ optionId:"allow_always", name:"Always allow <toolName>", kind:"allow_always" },
   { optionId:"allow_once", name:"Allow once", kind:"allow_once" },
   { optionId:"reject_once", name:"Reject", kind:"reject_once" }]`. The request `toolCall` is a
   `ToolCallUpdate` (`RequestPermissionRequest.toolCall`, `types.gen.d.ts:108`) carrying `title`, `kind`,
   `_meta.toolName = ctx.toolCall.name` (our client's auto-responder reads `_meta.*.toolName`,
   `permissions.ts:164-186`, and matches exact-then-substring, `:88-135`).
4. Wire `signal` (the turn's `AbortSignal`) to abort the permission `request`, so an aborted turn
   dismisses the dialog.
5. **Terminal transition on the SAME `toolCallId`** (never a new pending):
   - **allow** (`outcome:"selected"`, an allow option): return `{}` (no block). pi proceeds; the streamed
     `tool_execution_start` refines the already-emitted call (dedup by `toolCallId` → mapped to
     `tool_call_update`, not a second `tool_call`, §6.3).
   - **allow_always**: cache (§9.2.2), then allow as above.
   - **reject** (`reject_once`): enqueue `tool_call_update { toolCallId, status:"failed" }` (closes the
     eager pending — no stranded UI), return `{ block:true, reason:"denied by user" }`.
   - **cancelled** (`outcome:"cancelled"`) or **abort**: enqueue `tool_call_update { status:"failed" }`,
     return `{ block:true, reason:"cancelled" }`.
   - **resolver/transport failure** (the `client.request` rejects): treat as **deny** (fail-safe) —
     enqueue `tool_call_update { status:"failed" }`, return `{ block:true, reason:"permission
     unavailable" }`; the turn continues. (Row 19 applies only if a subsequent abort also fails.)

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

#### 9.3.1 Connect and register

For each `request.mcpServers` entry of **stdio** transport (`McpServerStdio`, `types.gen.d.ts:4779`),
`deps.connectMcpClient(server, signal)` connects a `@modelcontextprotocol/sdk` stdio client, `tools/list`
enumerates its tools, and each is registered as a pi `defineTool` customTool
(`extensions/types.ts:437-495`): the MCP tool's JSON-Schema `inputSchema` becomes the pi tool
`parameters` (raw JSON Schema accepted — §2.3), and `execute` forwards to the MCP `tools/call`, converting
the result (§9.3.3).

#### 9.3.2 Failure, partial-init rollback, collisions, cleanup

- **Partial-init rollback (all-or-nothing).** If any server's connect or `tools/list` fails, disconnect
  every already-connected client for this request and reject the lifecycle request with row 15
  (`mcp_init_error`, naming the failed server). No half-initialized session is registered; no child
  processes leak.
- **Name collisions (deterministic precedence).** A registered set is built in order: pi built-ins
  (`read/edit/write/bash/grep/find/ls`) first, then MCP tools in server-then-tool order, then the
  reserved `__acp_structured_output` (§9.4) last. An MCP tool whose name collides with a pi built-in or a
  previously-registered MCP tool is registered under a namespaced alias `mcp__<serverName>__<toolName>`
  (the well-known MCP prefixing convention); a collision with the reserved
  `__acp_structured_output` name is likewise aliased. A built-in is never shadowed. The alias is what the
  model sees and what `tool_call._meta.toolName` reports.
- **Cancellation + timeout.** Each `tools/call` is passed the turn `signal`; on abort the call is
  cancelled. A per-call timeout (30 s) rejects a hung `tools/call`; the tool result becomes an error
  result (pi surfaces it as a failed tool, not a crashed session).
- **Cleanup.** MCP clients are disconnected on `session/close`, on the §9.6 backstop, and on connection
  teardown (§3.2 disposal), each disconnect bounded so a hung `close()` cannot wedge shutdown.

#### 9.3.3 Result conversion

MCP `CallToolResult` → pi `AgentToolResult`: text content → `{ type:"text", text }`; image content →
image; embedded resource → text reference; `isError:true` → the pi tool `execute` throws (pi encodes it
as a failed tool result — `extensions/types.ts` requires throwing rather than encoding errors in
`content`), surfaced to the client as a `tool_call_update { status:"failed" }` (§6.3).

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
aliased away, §9.3.2 — if pi itself ever ships a built-in of that exact name, row 16). Its `parameters`
reference a **mutable schema holder**; its `execute` captures `params` into a per-turn slot and returns
`{ content:[{ type:"text", text:"(structured output captured)" }], details: params, terminate: true }`.
It starts **inactive** (removed from the active set via `setActiveToolsByName`, `agent-session.ts:888`).

#### 9.4.2 Per-turn arm/capture/disarm (`try/finally`)

On a `session/prompt` whose `_meta.outputSchema` (bare `META_KEYS.outputSchema`, `meta.ts:7-13`) is
present:

1. **Validate** the schema: it MUST be a JSON object (an object/typed schema). A non-object / top-level
   scalar / null → reject `invalidParams` (row 17, `invalid_output_schema`) before the turn starts.
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

| `AuthMethod` | type | `vars` / behavior |
|---|---|---|
| `id:"anthropic-api-key"` | `env_var` | `[{ name:"ANTHROPIC_API_KEY", secret:true }]` (pi also honors `ANTHROPIC_OAUTH_TOKEN` precedence, `env-api-keys.ts:71`) |
| `id:"openai-api-key"` | `env_var` | `[{ name:"OPENAI_API_KEY", secret:true }]` |
| `id:"gemini-api-key"` | `env_var` | `[{ name:"GEMINI_API_KEY", secret:true }]` |
| `id:"xai-api-key"` | `env_var` | `[{ name:"XAI_API_KEY", secret:true }]` |
| `id:"openrouter-api-key"` | `env_var` | `[{ name:"OPENROUTER_API_KEY", secret:true }]` |
| `id:"pi-stored-credentials"` | `agent` | pi reads its own `~/.pi/agent/auth.json` (`AuthStorage`); the default `AuthMethodAgent` ("agent handles auth itself") with **no** `_meta` |

`env_var` methods use the SDK `AuthMethodEnvVar` shape (`{ id, name, vars:[{ name, label?, secret?,
optional? }], link? }`, `types.gen.d.ts:2221`).

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
  disk — so there is nothing to exchange). A missing credential is NOT reported here; it surfaces at
  prompt time as the `-32000` auth rejection (§8 row 1), the reliable spec-faithful signal our client
  pauses on. This matches acp-auth-spec's base flow for ungated types.
- **unknown `methodId`** → reject `invalidParams` (`-32602`, `errorKind:"unknown_auth_method"`).

No terminal-login method is advertised in v1 (pi's OAuth/login is a TUI flow with no ACP `terminal` auth
surface we serve; §11).

### 9.6 Cancellation and the wedged-agent backstop (`src/session.ts`)

The SDK aborts the in-flight `session/prompt` request's `context.signal` on `session/cancel` **or**
`$/cancel_request` (both wired to the same abort, §4). The adapter registers, for each prompt turn,
`signal.addEventListener("abort", () => session.agent.abort())` (`agent.abort()` aborts the active run's
controller, `agent.ts:310-311`). pi settles the turn with a terminal `aborted` assistant message; the
adapter resolves the ACP request `{ stopReason:"cancelled", usage }` (§7) after `drain()`. Any parked
`session/request_permission` for that turn is dismissed via the same signal (§9.2 step 4).

**Wedged-agent backstop.** `agent.abort()` is cooperative; a provider stream stuck below the abort point
could leave `session.prompt()` unresolved. The adapter races settlement against a bounded timer using the
DI clock: if the turn has not settled within `deps.graceMs` (default 5000, `deps.now()`-driven) after
`agent.abort()`, the adapter force-resolves the ACP request `{ stopReason:"cancelled", usage }`,
**tombstones** the `sessionId` (§9.1.6), and disposes the `PiSession` (unsubscribe, cancel+drop the send
queue, disconnect MCP, abort again) so no later event from the wedged run reaches the connection and no
second writer can reopen the journal. A subsequent request for that id → `session_terminated` (row 13).
This guarantees an aborted turn always returns promptly even if pi's stream hangs.

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
7. **Gating auth-method advertisement on client auth capabilities** (the round-1 rule). Rejected
   (design-minimalism finding 1): SDK `AuthCapabilities` gates only `terminal`; the frozen acp-auth-spec
   makes `env_var`/bare-`agent` methods always visible; gating would return an empty `authMethods` to our
   own default client (whose default omits the `auth` key). All six methods are advertised
   unconditionally (§9.5).
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

---

## 13. Test plan — traceability matrix

All tests run under `tsx --test` (`packages/acp-agents` convention) and use the §4.1 DI seam
(`runAcp({ deps, stream })`) — no external credentials except the gated live leg (§13.4). Every row
cites the normative statement it covers.

### 13.1 Unit / bootstrap

| # | covers | assertion |
|---|---|---|
| T1 | §3, invariant 1 | `pi-acp --version` writes only the version to stdout and exits 0; with a bin that logs on import, stdout stays clean (redirect precedes the dynamic import) |
| T2 | §3.1 | `import("@automatalabs/pi-acp")` yields `runAcp`/`PiAcpAgent`/`PiAcpDeps` and mutates neither `console` nor stdio (no server started) |
| T3 | §3.2 | double `shutdown()` disposes once (awaited); `connection.closed` reject → exit code 1; teardown timeout still exits |
| T4 | §6.1 | ContentBlock fold: multi-text join, image→`options.images`, resource_link/resource/audio projections, empty-input → `empty_prompt` (`-32602`), invalid image → `invalid_content` |
| T5 | §6.3 | live translation table row-by-row incl. `agent_thought_chunk` for thinking and `tool_call` `_meta.toolName`/`kind`/`locations`; no update for the "no fabricated" set |
| T6 | §6.5 | per-turn `PromptResponse.usage` field map + multi-message accumulation; `usage_update.used` = context tokens, `cost.amount` = cumulative `getSessionStats().cost`; monotonic across two turns |
| T7 | §7 | stopReason table `stop|length|toolUse|aborted|error` → `end_turn|max_tokens|end_turn|cancelled|REJECT`; error rejects, never a stopReason |
| T8 | §8.1/§8.2 | every failure row: pinned code + `errorKind`; classification precedence (auth>billing>rate>generic) over fixture messages; redaction (raw `errorMessage` never on the wire; only `diagnostics`) |
| T9 | §5.1/§5.2 | `initialize` advertises exactly `thinkingLevel` (no `model` option); set thinkingLevel valid/invalid/wrong-type; set model hit/miss/busy; unknown configId |
| T10 | §5 | `initialize` returns the exact `agentCapabilities` (loadSession top-level; resume/fork/list/close; `mcpCapabilities:{}`; `_meta` namespace; no delete; no additionalDirectories) |
| T11 | §9.2 | permission sequence: eager `tool_call` → request → allow/allow_always/reject/cancel/abort/resolver-failure → correct terminal status + `{block}`; wrapper delegates to inner; abort dismisses; `allow_always` name-scoped single-session cache |
| T12 | §9.4 | outputSchema armed only when `_meta.outputSchema` present; non-object schema → `invalid_output_schema`; capture → final `agent_message_chunk`; `finally` disarms after auth throw / cancel / notify failure; mixed structured/unstructured sequence; reserved-name collision |
| T13 | §9.5 | six auth methods advertised **unconditionally** (incl. when client sends no `auth` capability); `authenticate(env_var/agent)` no-op success; unknown method → `unknown_auth_method` |

### 13.2 Integration (scripted ACP client over the injected stream)

| # | covers | assertion |
|---|---|---|
| T14 | §6.2, §6.6 | full turn: ordered `session/update` stream drained before `PromptResponse`; a notify-failure fixture aborts + rejects `notification_error` |
| T15 | §9.1.1-.6 | lifecycle + concurrency matrix: new→prompt→close; duplicate load → `session_already_open`; unknown id → `unknown_session`; repeated close idempotent; close-races-prompt → cancelled; busy fork/set_config → `session_busy` |
| T16 | §9.1.2/.3/.4 | resume emits **no** replay; load replays the linear branch via the SessionEntry projection (user/assistant/thinking/toolCall/toolResult); fork round-trips over a temp `sessionDir` |
| T17 | §9.1.5 | list with cwd vs `listAll` (no cwd); pagination cursor (page size 100) + `nextCursor`; undecodable cursor → `invalid_cursor` |
| T18 | §9.1.6 | poisoned/tombstoned reopen after backstop → `session_terminated` |
| T19 | §9.1.7 | non-empty `additionalDirectories` accepted and ignored (session still created) |
| T20 | §9.3 | stdio stub MCP: tools appear as pi customTools + `tools/call` round-trips (on new AND on load/resume/fork); partial-init rollback disconnects earlier clients + rejects `mcp_init_error`; name collision → `mcp__server__tool` alias; non-stdio → `unsupported_mcp_transport`; `tools/call` timeout → failed tool |

### 13.3 Hermetic e2e

| # | covers | assertion |
|---|---|---|
| T21 | §4.1 | inject a `createAgentSession` that wraps `new Agent({ streamFn: mockStream })` in an `AgentSession`; drive a full ACP conversation end-to-end with **zero credentials** — the substrate for future engine e2e |
| T22 | §9.6 | `deps.now`/`deps.graceMs`-driven backstop: a wedged mock stream force-resolves `cancelled` within the grace window and tombstones the session |

### 13.4 Live e2e (gated on provider keys)

| # | covers | assertion |
|---|---|---|
| T23 | §9.4.3 | one cheap-model leg through the full runner (custom backend registered `{ namespace:"@automatalabs/pi-acp", gatedKeys:["outputSchema"] }`), asserting a real structured-output turn validates. Gated on an env key; skipped in credential-free CI (`ci.yml:54-57`). |

### 13.5 Packaging / integration guards

| # | covers | assertion |
|---|---|---|
| T24 | §2.3 | manifest pins are exact (no caret); `main`/`exports`→`dist/lib.js`, `bin`→`dist/index.js`; packed `files:["dist"]` |
| T25 | §10.1 | `check-acp-deps.mjs` matches `@earendil-works/pi-coding-agent` (freshness matcher) |
| T26 | §10.3, §15 | root `tsconfig.json` references `packages/pi-acp`; a changeset exists; README carries the "Built on pi" + THIRD-PARTY MIT notice |

The round-1 "http MCP rejected by capability gating" assertion is **removed** — that tested our client,
not this server; T20's `unsupported_mcp_transport` is the server-side behavior instead.

---

## 14. References (verified file:line + version pins)

**Base commit (this repo), all `packages/…`/`scripts/…`/`docs/…`/config citations verified against:**
`c06d1e3a5a4363d42b892df1d4d12a5e9c5b94b2` (branch `spec/pi-acp`, based on `origin/main`).

**Base-freshness note:** at round-2 authoring `origin/main` had advanced to
`7dd17af1c285322844f4bd7c97b7236b6497ab96`. `git diff c06d1e3..7dd17af --stat` touches ONLY
`packages/mcp-server`, `packages/workflow-engine`, `packages/workflows`, and
`skills/agentprism-workflow-authoring` — **none** of the `packages/acp-agents`, `packages/shared-types`,
`scripts/check-acp-deps.mjs`, `docs/specs`, or config files this contract cites (mcp-server's
`package.json` changed only its version, and is cited only as a bin/publishConfig shape blueprint). All
citations below therefore remain byte-accurate; the base is pinned at `c06d1e3` (the merge-base this
branch builds on).

**pi source, all `packages/{ai,agent,coding-agent}/…` citations verified against:** repo
`github.com/earendil-works/pi`, tag **`v0.80.7`**, commit
**`818d67457cdd6b60bce6b121d16b23141c252dd8`**; npm `@earendil-works/pi-coding-agent@0.80.7`
(lockstep with `@earendil-works/pi-agent-core@0.80.7`, `@earendil-works/pi-ai@0.80.7`). Freshness
re-checked at authoring: `releases/latest` = `v0.80.7`, `npm view … version` = `0.80.7` — pin is current.

**ACP SDK, `@agentclientprotocol/sdk@1.2.1`**, verified against the installed dist at
`node_modules/.pnpm/@agentclientprotocol+sdk@1.2.1_zod@4.4.3/node_modules/@agentclientprotocol/sdk/dist/`.
`npm view @agentclientprotocol/sdk version` = `1.2.1` — pin is current. **Blueprint:**
`@agentclientprotocol/claude-agent-acp@0.59.0` (installed). **MCP client:**
`@modelcontextprotocol/sdk` (pin the exact latest under `^1.29` at implementation time).

### This repo (base `c06d1e3`)

- `packages/acp-agents/src/capabilities.ts` — `supportsLoadSession` :104-105, `supportsResumeSession`
  :109, `supportsForkSession` :108, `GATED_CUSTOM_META_KEYS` :45-49, `gateCustomMeta` :198-213,
  `unsupportedMcpServer` (stdio serviceable; http/sse gated once `mcpCapabilities` exists) :278-300,
  `describeClientAuthAdvertisement` :161-172, unsupported-block degrade :241-271.
- `packages/acp-agents/src/acp-client.ts` — `assertLifecycleSupported` :1220-1235, `selectModel` →
  `applyConfigOption("model", …)` :1972-1974, `applyConfigOption` (no advertisement check; boolean→`type`
  discriminator) :1986-1993, `reattachSession` (load/resume send `mcpServers`) :1533, `forkSession`
  (sends `mcpServers`) :1587,1647.
- `packages/acp-agents/src/protocol-coverage.ts` — `ACP_AUTH_REQUIRED_CODE_EXCLUSIVE = -32000`
  :152-154, auth `_meta` convention keys :143-147.
- `packages/acp-agents/src/structured-output.ts` — `parseFinalJson` :47-64, `resolveStructuredOutput`
  ladder :125-161.
- `packages/acp-agents/src/usage.ts` — field-mapping doc :7-17, `UsageAccumulator.toAgentUsage`/`recordCost`
  :28-72.
- `packages/acp-agents/src/permissions.ts` — `decidePermission` + option-kind orders :88-135,
  `candidateNames`/`_meta.*.toolName` :164-186.
- `packages/acp-agents/src/errors-map.ts` — `ACP_AUTH_REQUIRED_ERROR_CODE` :17, `OTHER_RESERVED` :23,
  `isAcpAuthRequired` (code-only `-32000`) :135-146, error-text fold :33-71.
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
  :2975, `ListSessionsRequest` (`cwd?` :4852, `cursor?` :4858), `ListSessionsResponse` (`nextCursor?`
  :2816) :2807, `McpServerStdio` :4779, additionalDirectories on new/load/fork/resume :4633,4831,4923,4964.
- `dist/acp.d.ts` — `methods` registry :17-79, `agent()` builder :588, `AgentApp.onRequest` :637,
  `AgentContext`/handler contexts :142-206,367-396, `AgentSideConnection` :735, `sessionUpdate` sender
  :765, `requestPermission` sender :778.
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
  authStorage, model, thinkingLevel, tools/excludeTools/customTools, sessionManager; **no**
  beforeToolCall/streamFn), `createAgentSession` :167-406, `registry.find` :197, internal `streamFn` +
  `getApiKeyAndHeaders` :302-303, `buildSessionContext` restore :188-204, `findInitialModel` :207-222,
  `new AgentSession({ agent, sessionManager, customTools, … })` :385-399.
- `packages/coding-agent/src/index.ts` — public exports of `AgentSession`/`AgentSessionEvent` :15-27,
  `createAgentSession*` :204-207, `ModelRegistry` :172, `SessionManager` :240.
- `packages/coding-agent/src/core/agent-session.ts` — `AgentSessionEvent` union :127-155,
  `AgentSessionEventListener = (e) => void` :156, `PromptOptions { images?, streamingBehavior?, … }`
  :204-215, `readonly agent: Agent` :270, `_eventListeners` :278, constructor `_installAgentToolHooks()`
  at :361 (sets `agent.beforeToolCall` at :424), `_emit` (synchronous, no await) :501-505, `subscribe`
  :762, `getActiveToolNames`/`setActiveToolsByName` :861-888, `prompt` :1076-1224 (sync auth throws
  :1140-1154, busy-throw :1121-1126), `_runAgentPrompt` finally→`agent_settled` :1023-1034,
  `_handlePostAgentRun` :1037-1069, `_isRetryableError` :2577, `setModel` :1537-1552 (sync no-auth throw
  :1538-1540), `setThinkingLevel` :1630-1640 (clamp :1632), `getContextUsage` :3078-3110,
  `getSessionStats` :3023-3076 (cumulative `cost`/`tokens`, `contextUsage`).
- `packages/coding-agent/src/core/auth-guidance.ts` — `formatNoModelSelectedMessage` :18-20,
  `formatNoApiKeyFoundMessage` :22-25 (ground the §8.2 pre-flight predicates); OAuth "Authentication
  failed for … Run '/login" throw at `agent-session.ts:1144-1150`.
- `packages/coding-agent/src/core/auth-storage.ts` — `AuthStorage.create(authPath?)` :215.
- `packages/agent/src/agent.ts` — `Agent` ctor + `streamFn`/`beforeToolCall`/`afterToolCall`
  :101-106,171-219, `streamFn` injection :214, `subscribe` :241, `steer` :274, `followUp` :279,
  `hasQueuedMessages` :300, `abort` :310-311, `waitForIdle` :319, `prompt`/`continue` (busy-throw)
  :335-348.
- `packages/agent/src/types.ts` — `BeforeToolCallResult { block?, reason? }` :60-63,
  `BeforeToolCallContext { assistantMessage, toolCall, args, context }` :89-98, `AgentEvent` union
  (`message_update { message, assistantMessageEvent }`; `tool_execution_start { toolCallId, toolName,
  args }`; `tool_execution_update { …, partialResult }`; `tool_execution_end { …, result, isError }`)
  :415-430, `ThinkingLevel` (off,minimal,low,medium,high,xhigh,max) :289.
- `packages/ai/src/types.ts` — `TextContent` :327, `ThinkingContent` :334, `ImageContent { type:"image",
  data, mimeType }` :343, `ToolCall { id, name, arguments }` :349, `Usage` :357-379, `StopReason`
  (stop|length|toolUse|error|aborted) :380, `UserMessage { role:"user", content }` :382-386,
  `AssistantMessage { content, usage, stopReason, errorMessage, diagnostics? }` :388-401,
  `ToolResultMessage { toolCallId, toolName, content, isError }` :403-418, `AssistantMessageEvent`
  (text/thinking/toolcall start/delta/end; `done {reason: stop|length|toolUse}`; `error {reason:
  aborted|error}`) :464-476.
- `packages/coding-agent/src/core/session-manager.ts` — `SessionEntryBase` :46-52, entry interfaces
  (`SessionMessageEntry` :54-57, `ThinkingLevelChangeEntry` :58-61, `ModelChangeEntry` :63-67,
  `CompactionEntry` :69-79, `BranchSummaryEntry` :80-89, `CustomEntry` :100-104, `CustomMessageEntry`
  :127-138, `LabelEntry` :107-111, `SessionInfoEntry` :114-117), `SessionEntry` union :140-152,
  `SessionTreeNode` :156-162, `SessionInfo { path, id, cwd, name?, parentSessionPath?, created, modified,
  messageCount, firstMessage, allMessagesText }` :170-184, `SessionContext { messages, thinkingLevel,
  model }` :164-168, free `buildSessionContext(...)` :457, `listSessionsFromDir` :747, method
  `buildSessionContext()` :1213, `getBranch(fromId?)` :1189, `getTree()` :1239, `static create(cwd,
  sessionDir?, options?)` :1441, `static open(path, sessionDir?, cwdOverride?)` :1452, `static
  forkFrom(sourcePath, targetCwd, sessionDir?, options?)` :1490, `static async list(cwd, sessionDir?,
  onProgress?)` :1549 (reads `listSessionsFromDir`, sorts by `modified` desc :1553-1558), `static async
  listAll(sessionDir?, onProgress?)` :1564-1566 (all project dirs); **no** delete/unlink/remove method
  (verified absent).
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

---

## 15. License and attribution (pi is MIT)

`@automatalabs/pi-acp` depends on and embeds pi (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), which is **MIT** (Earendil Inc. / Mario
Zechner + Armin Ronacher). Obligations, satisfied in-package:

- The MIT license text and copyright notice of the pi packages are retained (they ship in the installed
  dependency's `node_modules`; no source is vendored).
- `packages/pi-acp/README.md` includes a "Built on pi" attribution and a THIRD-PARTY notice naming pi,
  its authors, its MIT license, and the pinned version.
- pi-acp itself is `Apache-2.0` (the monorepo license); Apache-2.0 and MIT are compatible for this
  depend-and-embed relationship. No pi source is copied into pi-acp; the `findJsonBlock`/`extractValidated`
  helpers already in `acp-agents/src/structured-output.ts` were ported from pi under our existing
  attribution and are not re-copied here.
