# pi-acp: full MCP client (whole base protocol, all transports, client features) + structured output via standard injection + correctness batch

This is the **frozen implementation contract** for issue #224. It specifies the whole train: a full
Model Context Protocol (MCP) client inside `@automatalabs/pi-acp` (all transports + the whole base
protocol + client features), the retirement of pi-acp's bespoke structured-output channel in favor of
the standard client-hosted injection path already used by OpenCode, a truthful `model` config option,
an error-taxonomy tripwire tied to the runtime pin, a hermetic multi-transport regression net, and a
turn-abort child-cleanup fix. It amends the already-frozen `docs/specs/pi-acp-spec.md` (the "pi-acp
spec") with explicit, apply-ready amendment blocks (§10); the pi-acp spec remains the base contract and
this document is normative where the two differ.

An implementer who has never seen issue #224 can build this without asking questions: every normative
statement traces to the owner's words in §0, every mechanism claim carries a verified `file:line`
citation (§13), pinned numeric wire codes are given where the wire sees them, and the design questions
are resolved here (§12) rather than deferred.

---

## 0. Source — the owner's verbatim words (hop-0 anchor)

This contract exists to satisfy THESE sentences. Every normative decision below traces to them; any
addition the owner did not ask for carries an explicit rationale (marked "derived"), and no section may
narrow what these sentences state.

> "I want to create a new first class ACP server for pi coding agent, built on its sdk, as a new package in the mono repo." *(original request, 2026-07-15)*

> "Ok just re: meta review findings, another aspect it didn't capture (since kimi didn't know about my original request when it wrote the review) was that I ask for MCP support (like the rest of our ACP agents support). That piece was dropped by you from my original request and is kind of a crucial piece since workflows allow passing in mcp servers to the agents." *(2026-07-16)*

> "The MCP servers passed to any ACP agent could be any of the supported MCP protocol transports. If we have artificially created constraints as to the type of MCP server we can pass to a workflow script agent, that is another incorrect assumption. For Pi ACP's case, its a little bit harder because we need to build out the whole MCP client, since pi-coding-agent doesn't support MCP out of the box. We need to support the whole base protocol (which the typescript sdk supports), the difficult part is wiring it in to the seams of the pi-coding-agent sdk, since we're building on top of it." *(2026-07-16)*

> "Just like the OpenCode ACP Server integration, we should just pass the structured output mcp server to pi if a schema is defined on an agent call. As long as we build the MCP client of pi-acp correctly, it would work just like any ACP agent that doesn't have native structured outputs?" *(2026-07-16)*

> "Also this context may be help re: tests, I initially came to Kimi with my inquiry after I was trying to use the `npx @automatalabs/workflows config pi` command to test out the Pi integration, and noticed that the only config that surfaced was `thinkingLevel`." *(2026-07-16)*

**Recorded owner scope decision (binary question, 2026-07-16):** "whole base protocol" = **FULL,
including MCP client features** — sampling (server→pi-LLM completions), roots, and elicitation — not
just the server-feature consumption surface. This is OWNER SCOPE: no section of this contract may
propose descoping it. This spec designs **how**, never **what**.

The owner also framed the process (issue #224 "Process"): "we'll start with a contract workflow for
train 1, then implementation and release train." This document is that contract; the implementation and
release trains consume it frozen.

---

## 1. Implementation-time re-verification (normative — do this FIRST)

pi releases every ~2–3 days and the dependency gate (`scripts/check-acp-deps.mjs`) forces the pi runtime
to npm-latest continuously. Before writing any code, the implementer MUST re-run the external freshness
protocol and treat any drift as a **stop-and-report** discrepancy — never re-implement around a moved
pin silently (the pi-acp spec §0 obligation, extended here to the new surfaces this train wires into):

1. Fresh temp clone of `https://github.com/earendil-works/pi`, then `git fetch --tags`.
2. `gh api repos/earendil-works/pi/releases/latest --jq .tag_name` **and**
   `npm view @earendil-works/pi-coding-agent version`; the two MUST agree.
3. Compare against the pin in §13 (`v0.80.10` / commit `8dc78834cde4e329284cf505f9e3f99763df5529` / npm
   `0.80.10`). **If the pin is no longer the latest release, that is a STOP:** re-verify every pi
   citation this contract adds — the inline-extension tool-registration seam
   (`extensions/loader.ts`, `extensions/runner.ts`, `extensions/types.ts`, `resource-loader.ts`), the
   tool-registry internals (`agent-session.ts` `_customTools`/`_refreshToolRegistry`/`setActiveToolsByName`/
   `getAllTools`/`abort`), the LLM completion seam (`model-runtime.ts` `completeSimple`/`streamSimple`/
   `getAvailableSnapshot`), and the bash-child kill path (`tools/bash.ts`, `exec.ts`, `utils/shell.ts`) —
   against the new latest, update the pins (§13) and every changed claim, and re-open this contract for
   review before building.
4. Re-run `npm view @modelcontextprotocol/sdk version` and `npm view @agentclientprotocol/sdk version`.
   If either is no longer `1.29.0` / `1.2.1`, re-verify the MCP client surface (transports, client
   request handlers, notification schemas — §3, §13) and the ACP elicitation surface against the new
   dist and re-pin before building.
5. **Base-freshness (blocking):** if `origin/main` has advanced since the base commit
   `0470ed175e000085f5bd647cb1c0ff729d0dee9a` (§13) with any change that touches a `.ts`/`.mjs`/`.md`
   SOURCE surface this contract cites under `packages/pi-acp`, `packages/acp-agents`,
   `packages/workflows`, `packages/shared-types`, `docs/specs`, or `scripts/check-acp-deps.mjs`,
   STOP and re-verify the affected citations before building. A release-metadata-only advance (package
   `version` bumps + `CHANGELOG.md`, the Changesets "Version Packages" flow) is the benign case and does
   not block — but confirm it, do not assume it.

The freshness gate (pi-acp spec §10.1; `scripts/check-acp-deps.mjs`) enforces the same discipline
continuously after landing. This train adds NO new runtime dependency to `packages/pi-acp` — the MCP TS
SDK (`@modelcontextprotocol/sdk@1.29.0`) is already a direct dependency (`packages/pi-acp/package.json`)
and the ACP SDK (`@agentclientprotocol/sdk@1.2.1`) is already present; both stay exact-pinned (no caret).

---

## 2. Problem, scope, and verified starting state

### 2.1 Problem

pi-acp is a first-class ACP backend our runner (`@automatalabs/acp-agents`) drives symmetrically with
Claude, Codex, and OpenCode. Workflows let an author attach MCP servers to any agent call
(`agent({ mcpServers })`), and that path is **already clean end-to-end EXCEPT at pi-acp**:

- The engine accepts the full ACP transport union: `WorkflowAgentOptions.mcpServers?: McpServerConfig[]`
  (`packages/workflow-engine/src/workflow.ts:337`), where `McpServerConfig` is the four-member union
  `stdio | http | sse | acp` structurally mirroring the ACP SDK `McpServer` union
  (`packages/shared-types/src/mcp-config.ts`). It is threaded past the resume identity hash straight to
  the runner (additive input, not part of `hashAgentCall`).
- The generic client gate is **advertisement-driven**: `unsupportedMcpServer` treats stdio as always
  serviceable and rejects `http`/`sse` only once the agent advertises an `mcpCapabilities` block, and
  rejects `acp` unless both sides advertise it (`packages/acp-agents/src/capabilities.ts:278-300`).
- **pi-acp is the only narrowing.** It advertises `mcpCapabilities: {}` (a present-but-empty block that
  switches OFF the gate's legacy leniency, so the client rejects typed servers up front —
  `packages/pi-acp/src/agent.ts:81`), and its MCP bridge hard-rejects every typed server:
  `bridgeMcpServers` throws `unsupported_mcp_transport` for any server carrying a `type` field
  (`packages/pi-acp/src/mcp-bridge.ts:214-216`). Only stdio is bridged; `tools/list` runs once at
  session creation with no `tools/list_changed`, no resources/prompts/logging, and no client features
  (`packages/pi-acp/src/mcp-bridge.ts:59-126,205-302`).

Two consequences the owner named: (a) MCP servers of `http`/`sse` transport cannot reach a pi agent at
all — an "artificially created constraint"; and (b) because HTTP MCP is foreclosed, structured output
cannot ride the standard client-hosted `StructuredOutput` MCP-tool injection the runner already uses for
OpenCode (`packages/acp-agents/src/runner.ts:1397-1407` gates injection on
`backend.injectStructuredOutputTool && mcpCapabilities.http === true`), so pi-acp carries a bespoke
`_meta.outputSchema` channel with a fabricated final message and a history-splice.

### 2.2 Scope (the six deliverables of issue #224)

1. **Full MCP client in pi-acp** (§3): stdio + Streamable HTTP + SSE transports; the whole base
   protocol (tools incl. `tools/list_changed`, resources, prompts, logging, pagination/progress/
   cancellation as the SDK surfaces them); client features (sampling routed to pi's LLM, roots,
   elicitation routed through ACP). Truthful `mcpCapabilities` advertisement follows what is served.
2. **Structured output rides the standard injection path** (§4): with HTTP MCP served, `PiBackend`
   uses the same client-hosted `StructuredOutput` injection as OpenCode; the bespoke channel is retired
   by removal.
3. **Model config option** (§5): advertise a truthful `model` select enumerated from pi's configured
   (authenticated) provider catalog, so `npx @automatalabs/workflows config pi` lists models.
4. **Error-taxonomy tripwire** (§6): fixture-pinned classifier tests over the real upstream provider
   message strings, exercised on every runtime bump.
5. **Hermetic multi-transport e2e** (§7): credential-free coverage of the MCP client per transport and
   of schema'd structured output through the injected tool.
6. **Turn-abort child cleanup** (§8): cancelling a pi turn terminates in-flight tool children.

§10 carries the apply-ready amendment blocks against the pi-acp spec and the coupled artifacts
(`PI_ACP_PROTOCOL_CONTRACT`, drift tests, the authoring skill + generated prompt, `pi-backend.test.ts`).

### 2.3 Verified starting state (re-verify per §1; do not trust)

- **Client path clean, pi-acp the only narrowing** — as §2.1 (citations there).
- **Bridge today is a thin stdio slice**: MCP SDK `Client` over `StdioClientTransport` only; one
  `tools/list` at session creation, aliased `mcp__<server>__<tool>` (`mcp-bridge.ts:59-126,205-302`);
  typed servers hard-rejected (`mcp-bridge.ts:214-216`). Tools are merged as pi `customTools` once at
  `createAgentSession` (`agent.ts:146-151`), and pi fixes `this._customTools` at construction
  (`agent-session.ts:326,362`, private; consumed by the private `_refreshToolRegistry`,
  `agent-session.ts:2441`) — so the current path has **no** post-birth tool mutation.
- **Structured output — bespoke server-side channel**: `PiBackend.injectStructuredOutputTool = false`,
  `embedSchemaInPrompt = false`, `customCapabilities = { namespace:"@automatalabs/pi-acp",
  gatedKeys:[outputSchema] }` (`packages/acp-agents/src/backends/pi.ts:29-34`); server registers
  `__acp_structured_output` (`packages/pi-acp/src/structured-output.ts`), splices a prompt instruction
  that persists into pi history and replays (`session.ts:319-324`, `replay.ts`), and **fabricates** the
  final `agent_message_chunk` from the captured tool value (`session.ts:275-279`; wire-only —
  `session/load` replay omits it). The runner's injected client-hosted `StructuredOutput` tool
  (`structured-tool.ts`) is HTTP-only and foreclosed for pi today.
- **Config: `thinkingLevel`-only**: `configOptions()` returns `[thinkingLevelOption]`
  (`session.ts:117-119`); `applyConfig` accepts `"model"` writes but echoes a catalog that omits the
  model option (`config.ts:24-52`). The frozen §5.1 records the omission as deliberate; T9 pins it.
- **Error taxonomy by prose regex**: `classifyPreflight`/`classifyTerminal` manufacture `errorKind`s by
  matching provider message text (`errors.ts:105-140`) under the every-2–3-day runtime bump — one
  upstream wording change can silently downgrade pausable `provider_usage_limit` (mapped by `PiBackend`
  from `rate_limit`/`billing_error`, `backends/pi.ts:40-51`) into blind-retry `provider_error`.
- **Hermetic MCP coverage is schema-less**: `matrix-gaps.test.ts` exercises the stdio bridge with a fake
  handle but never a schema'd structured-output turn; structured assertions live only in the
  CI-disabled live suite (pi-acp spec T23).
- **Turn-abort child leak** (live probe 2026-07-16): stopping a run left the agent's `sleep 180` shell
  child running; the kill mechanism exists in pi but the adapter's cancel path did not deliver it (§8).
- **The runner's script-side reserved-`model`-configOptions guard is untouchable by this spec**:
  `assertNoModelConfigOption` (`runner.ts:1430-1440`) forbids `model` in an author's `configOptions`.
  That is a script-authoring rule, unrelated to capability advertisement; §5 changes advertisement, not
  this guard.

---

## 3. Deliverable 1 — Full MCP client in pi-acp

pi ships no native MCP; the adapter is the MCP client for every server ACP's `mcpServers` union can
deliver (except `acp`, which stays client-hosted — §12.6 non-goal). The MCP TS SDK
(`@modelcontextprotocol/sdk@1.29.0`) already implements the whole client surface; the work is wiring it
into pi's seams. `packages/pi-acp/src/mcp-bridge.ts` grows from a stdio-only slice into a full MCP client
module; `src/deps.ts` gains the client-feature dependency seams.

### 3.1 Transports (stdio + Streamable HTTP + SSE)

`bridgeMcpServers` (`mcp-bridge.ts:205`) dispatches per `McpServer` transport instead of hard-rejecting
typed servers (`mcp-bridge.ts:214-216` removed):

| ACP transport (`McpServerConfig`) | MCP SDK transport | construction |
|---|---|---|
| stdio (`{ command, args, env }`) | `StdioClientTransport` (`client/stdio.js`) | as today (`mcp-bridge.ts:66-70`) |
| `{ type:"http", url, headers }` | `StreamableHTTPClientTransport` (`client/streamableHttp.js:23`) | `new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: fold(headers) } })` |
| `{ type:"sse", url, headers }` | `SSEClientTransport` (`client/sse.js:17`) | `new SSEClientTransport(new URL(url), { requestInit: { headers: fold(headers) }, eventSourceInit: { fetch withHeaders } })` |
| `{ type:"acp", … }` | not served by pi-acp | rejected `unsupported_mcp_transport` (client-hosted; §12.6) |

`fold(headers)` maps the ACP `{ name, value }[]` (`shared-types` `McpNameValue`) to a plain header
record. Each `connect`, `tools/list` page, and `tools/call` stays bounded by `deps.mcpTimeoutMs`
(default `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, `shared/protocol.js:8`) via the SDK request
`options.timeout` and the existing `bounded()` race (`mcp-bridge.ts:40-57`), and a failed/timed-out
connect closes the transport it opened (the stdio orphan-child guarantee of `mcp-bridge.ts:71-93` extends
to every transport's `transport.close()`). The `connectMcpClient` DI factory (`deps.ts:25,68-71`)
dispatches by transport so tests inject fakes per transport (§7).

**Truthful advertisement (derived from owner quote 3).** `initialize` advertises
`mcpCapabilities: { http: true, sse: true }` instead of `{}` (`agent.ts:81`). stdio stays the implicit
baseline (the runner treats it as always serviceable, `capabilities.ts:284-300`); `acp` is NOT
advertised (not served). This flips the client gate from "reject http/sse" to "allow http/sse," so
workflow authors can attach HTTP/SSE MCP servers to pi agents and the runner can inject its HTTP
`StructuredOutput` tool (§4). The `McpCapabilities` SDK type carries `http`/`sse` booleans
(`types.gen.d.ts` `McpCapabilities`).

### 3.2 Whole base protocol (server features consumed)

The client consumes every base-protocol server feature the pinned SDK surfaces. Each is wired to the
pi/ACP surface that can carry it; where pi has no representation the value is projected to text (never
silently dropped), matching the existing total tool-result projection (pi-acp spec §9.3.3).

| MCP server feature | SDK client call / handler | pi/ACP wiring |
|---|---|---|
| **tools** (list + call) | `client.listTools(cursor?)` (`client/index.js:565`), `client.callTool` (`client/index.js:490`) | registered as pi tools (§3.3); full cursor enumeration + cycle guard as today (`mcp-bridge.ts:240-256`); result projection total over the five-member `ContentBlock` union + `structuredContent`→`details` + `isError`→throw (`mcp-bridge.ts:150-183`) |
| **`tools/list_changed`** | `client.setNotificationHandler(ToolListChangedNotificationSchema, …)` | dynamic re-registration via the inline-extension seam (§3.3) |
| **resources** (list, read, templates, `resources/list_changed`, `resources/updated`) | `client.listResources`/`readResource`/`listResourceTemplates` + notification handlers (`client/index.js`) | exposed to the model as synthetic read tools per server: `mcp__<server>__list_resources`, `mcp__<server>__read_resource` (JSON-Schema'd), registered alongside the server's tools (§3.3), so pi's tool loop can enumerate and read resources; `resources/updated`/`list_changed` refresh the adapter's cached listing (no wire effect until the model re-reads) |
| **prompts** (list, get, `prompts/list_changed`) | `client.listPrompts`/`getPrompt` + notification handler | exposed as a synthetic tool `mcp__<server>__get_prompt(name, arguments)` returning the prompt's messages as tool-result content; enumerable via `mcp__<server>__list_prompts` |
| **logging** (`logging/setLevel`, `notifications/message`) | `client.setLoggingLevel` + `notifications/message` handler | on connect, `setLoggingLevel("info")`; each `notifications/message` is forwarded to the ACP client as a `session/update` `agent_message_chunk`-adjacent diagnostic — concretely an `agent_thought_chunk` prefixed `[mcp:<server>] <level>: <text>` so it is observable but not confused with the model's own output |
| **pagination** | cursor loops on every `list*` call | already total for tools (`mcp-bridge.ts:240-256`); the same cursor loop + cycle guard applies to resources/prompts |
| **progress / cancellation** | SDK `options.onprogress`, `options.signal`/`options.timeout` | each server call is passed the turn `AbortSignal` (cancellation → the SDK sends `notifications/cancelled`) and `deps.mcpTimeoutMs`; progress notifications are dropped (no ACP progress channel per call — documented, §12.7) |

The synthetic resource/prompt tools are the mechanism by which pi's tool-only loop reaches
resources/prompts (pi's model interface is tools; MCP resources/prompts have no direct pi analogue).
Their aliases share the `mcp__` reserved namespace (pi-acp spec §9.3.2) so they never shadow a pi
built-in; each is JSON-Schema'd so pi validates arguments. This is "support the whole base protocol …
the difficult part is wiring it in to the seams" (owner quote 3) made concrete.

### 3.3 Dynamic tool registration — `tools/list_changed` (INVESTIGATED; a real seam exists)

**The pi dynamic-registration seam was investigated against the pinned pi dist. Resolution: a real,
public seam exists — pi's inline (in-process) extensions — and the MCP bridge migrates onto it.**

**Investigation (verified, §13):** pi offers two tool-registration paths.
1. `CreateAgentSessionOptions.customTools` (`sdk.ts:68`) — merged once into the private, immutable
   `AgentSession._customTools` at construction (`agent-session.ts:326,362`), consumed by the private
   `_refreshToolRegistry` (`agent-session.ts:2441`). There is **no** public method to append to
   `_customTools` or re-run the refresh, so the current `customTools` path CANNOT reflect a
   `tools/list_changed` mid-session. (Reaching into the private field + private method is illegal and
   brittle — rejected, §12.1.)
2. **Inline extensions** — `DefaultResourceLoader({ extensionFactories: InlineExtension[] })`
   (`resource-loader.ts:122-131`), where `InlineExtension = ExtensionFactory | { name, factory }` and
   `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>` (`extensions/types.ts:1474-1483`).
   The factory receives the **durable** `ExtensionAPI` (`pi`), whose `registerTool(tool)`
   (`extensions/loader.ts:237-244`) writes the tool into the extension's tool map AND calls
   `runtime.refreshTools()`. Post-bind, `refreshTools()` is `AgentSession._refreshToolRegistry()`
   (`agent-session.ts:2376`), which recomposes the registry from
   `this._extensionRunner.getAllRegisteredTools()` (`extensions/runner.ts:422-433`) and — when called
   with no explicit active set — activates newly-appeared registry tools (`agent-session.ts:2515-2520`).
   `createAgentSession` accepts an injected `resourceLoader` (`sdk.ts:71`), so the adapter constructs one.

**Design decision (derived, decisive):** the MCP bridge migrates from the `customTools` construction
argument to an **inline extension**. Concretely:

1. Before session construction, the adapter connects the MCP clients and lists each server's tools
   (and resources/prompts, §3.2) as today.
2. It builds an `InlineExtension` factory that, on activation, calls `pi.registerTool(alias, …)` for
   every initial tool/synthetic-tool, and captures the `pi` (`ExtensionAPI`) reference plus the
   per-server `McpClientHandle`s and a mutable **valid-alias map**.
3. It constructs `DefaultResourceLoader({ …, extensionFactories: [factory] })`, `await
   resourceLoader.reload()`, and passes that loader to `deps.createAgentSession({ resourceLoader, … })`
   instead of `customTools`.
4. On a server's `tools/list_changed`, the adapter re-lists that server and, for each alias:
   - **new alias** (never registered) → `pi.registerTool(alias, …)` (add + refresh; active next turn);
   - **changed** (description/schema differs) → `pi.registerTool(alias, …)` again (replaces the prior
     entry deterministically; `getAllRegisteredTools` is first-per-name, and re-`registerTool` on the
     same extension overwrites `extension.tools.set(name)`, `loader.ts:239`);
   - **removed** → mark the alias invalid in the valid-alias map (see below).
5. Each registered pi tool's `execute` dispatches through the adapter's **current** handle for that
   server+tool via the valid-alias map. A tool that has been removed by a `tools/list_changed`
   (alias invalid) returns a **failed tool result** with the fixed message
   `` `MCP tool ${alias} is no longer available` `` (redaction parity with pi-acp spec §9.3.3), so the
   model sees a clean failure — never a crash or a stale call.

**Exact behavior, pinned (the "documented behavior" the investigation must record):**
- **Timing:** a `tools/list_changed` takes effect on the **next** pi turn, not the current in-flight
  turn — `setActiveToolsByName` documents "Changes take effect on the next agent turn"
  (`agent-session.ts:912-913`). This matches pi's own tool model and is the contract.
- **Additions and schema/description changes:** fully dynamic via `registerTool` + `refreshTools`.
- **Removals:** pi's public `ExtensionAPI` has **no `unregisterTool`** (verified: the API exposes
  `registerTool`/`registerCommand`/`registerShortcut`/`registerFlag`/`on`/`registerProvider` only,
  `extensions/types.ts:1210-1245`). A removed tool's alias therefore remains in pi's registry but its
  `execute` returns the fixed "no longer available" failed result (above). Re-addition replaces it with
  a live `execute`. This is the exact, bounded consequence of the missing `unregisterTool`.
- **Runtime staleness:** `registerTool` calls `runtime.assertActive()` (`loader.ts:238`), which throws
  only after session replacement/reload (`ctx.newSession`/`fork`/`switchSession`/`reload`). A single ACP
  session is never reloaded by the adapter, so the captured `pi` stays active for that session's life;
  `session/load`/`resume`/`fork` each build a **fresh** session with a fresh inline extension +
  resourceLoader, so no captured `pi` is reused across sessions.

**Collision/reserved-namespace note (amends pi-acp spec §9.3.2).** MCP tools now register as pi
**extension** tools (`sourceInfo.source = "extension"`) rather than `customTools`
(`sourceInfo.source = "sdk"`), but the `mcp__` reserved-prefix analysis is unchanged: `_refreshToolRegistry`
composes `Map(builtins)` then overlays `[...extensionTools]` (`agent-session.ts:2441-2461`), so an
`mcp__…` alias — disjoint from every built-in by construction — cannot shadow a built-in, and the
post-construction presence check (every `mcp__…` alias present in `session.getAllTools()`, else
`mcp_init_error`) still holds via `agent-session.ts:894-905`.

### 3.4 Client features (owner scope: sampling, roots, elicitation)

The adapter declares client capabilities on each MCP client via
`new Client({ name, version }, { capabilities: { sampling: {}, roots: { listChanged: false }, elicitation: {} } })`
so servers may issue these server→client requests, and registers handlers (`client/index.js:160-278`
`registerCapabilities` + `setRequestHandler`):

1. **Sampling** — `sampling/createMessage` (`CreateMessageRequestSchema`→`CreateMessageResultSchema`).
   Routed to **pi's LLM**: the handler maps the MCP request's `messages`/`systemPrompt` to a pi `Context`
   (`packages/ai/src/types.ts:450-454`), selects the model — the session's current `session.model`
   (`agent-session.ts:854`), or, when the request carries `modelPreferences`, a preference-driven pick
   from `deps.modelRuntime.getAvailableSnapshot()` (§5) — and calls
   `deps.modelRuntime.completeSimple(model, context, options)` (`model-runtime.ts:479-481`), mapping the
   returned pi `AssistantMessage` back to an MCP `CreateMessageResult` (role `assistant`, text/image
   content, `model`, `stopReason`). Bounded by `deps.mcpTimeoutMs` and the turn signal. A provider/auth
   failure returns an MCP error result (`isError`), never crashing the turn; if the session has **no**
   model selected, the handler returns an MCP error `no model selected for sampling`.
2. **Roots** — `roots/list` (`ListRootsRequestSchema`→`ListRootsResultSchema`). Returns exactly the
   session's workspace root: `[{ uri: pathToFileURL(sessionManager.getCwd()).href, name: basename }]`
   (`agent-session.ts:3170` supplies the cwd; pi has no additional-directories concept — pi-acp spec
   §9.1.7 / §12.4). `roots.listChanged` is advertised `false` (the cwd is fixed per session), so no
   `notifications/roots/list_changed` is emitted (documented).
3. **Elicitation** — `elicitation/create` (`ElicitRequestSchema`→`ElicitResultSchema`). Routed **through
   ACP**: the handler forwards to the ACP client via
   `client.request(methods.client.elicitation.create, params)` — ACP 1.2.1 has a native
   `elicitation/create` method (`acp.js:99-101`; `CreateElicitationRequest`/`CreateElicitationResponse`),
   mapping the MCP `ElicitRequest` (`message`, `requestedSchema`) to the ACP request and the ACP response
   (`accept`/`decline`/`cancel` + content) back to the MCP `ElicitResult` action. If the ACP client does
   not handle `elicitation/create` (method-not-found / transport failure), the handler returns the MCP
   result `{ action: "decline" }` — a graceful degradation that never wedges the server. The permission
   seam (`session/request_permission`, `permissions.ts`) remains the tool-approval channel and is not
   overloaded for elicitation.

**Advertisement follows capability.** Because the client now genuinely serves sampling/roots/elicitation
and http/sse transports, `mcpCapabilities` and the client-capability object are truthful — the
overarching invariant "advertise only what is implemented" (pi-acp spec invariant 2) holds.

---

## 4. Deliverable 2 — Structured output rides the standard injection path (bespoke channel retired)

Owner quote 4: "Just like the OpenCode ACP Server integration, we should just pass the structured
output mcp server to pi if a schema is defined on an agent call. As long as we build the MCP client of
pi-acp correctly, it would work just like any ACP agent that doesn't have native structured outputs?"
The answer is yes, and this deliverable makes it so **by removal**, not by patching.

### 4.1 How it works after §3

With HTTP MCP served (§3.1) and `mcpCapabilities.http === true` advertised, the runner's existing
injection path activates for pi with **zero pi-specific code**: when a schema is set,
`shouldInjectStructuredOutputTool(schema, backend, capabilities)` returns true iff
`schema && backend.injectStructuredOutputTool && capabilities.agent.mcpCapabilities?.http === true`
(`runner.ts:1397-1407`); the runner binds its localhost Streamable-HTTP `StructuredOutput` MCP host
(`structured-tool.ts:51-135`) and injects it as an `http` MCP server in the session's `mcpServers`
(`runner.ts:822-833`). pi-acp's MCP client (now full) connects to it, lists the `StructuredOutput` tool,
the model calls it, and the CALL is captured by the runner's host (`structured-tool.ts:199-210`); the
runner reads the capture via `structuredTool.tryCaptured()` (`runner.ts:958`). pi-acp is a transparent
MCP client — it needs to know nothing about structured output.

### 4.2 `PiBackend` mirrors `OpenCodeBackend` (`packages/acp-agents/src/backends/pi.ts`)

`PiBackend` is rewritten to match `OpenCodeBackend`'s structured-output posture exactly:

| field | before | after |
|---|---|---|
| `injectStructuredOutputTool` | `false` (`pi.ts:30`) | **`true`** |
| `embedSchemaInPrompt` | `false` (`pi.ts:29`) | **`true`** (OpenCode parity, `backends/opencode.ts:28`) |
| `customCapabilities` | `{ namespace:"@automatalabs/pi-acp", gatedKeys:[outputSchema] }` (`pi.ts:31-34`) | **removed** (no custom-capability contract; the namespace advertisement is gone from the server, §4.3) |
| `promptMeta(schema)` | `{ [outputSchema]: toJsonSchema(schema) }` (`pi.ts:79-82`) | **`undefined`** — pi no longer consumes any `_meta` structured channel; forwarding it would be dead weight (OpenCode forwards it harmlessly only because it is a documented no-op there; pi's cleaner state is to send nothing) |
| `nativeStructured(source)` | `parseFinalJson(source.finalMessageText())` (`pi.ts:84-86`) | **retained** — the runner's `resolveStructuredOutput` ladder still calls `tryNative` as a fallback after `tryCaptured`; `parseFinalJson(finalMessageText())` is the same harmless final-message parse OpenCode keeps (`backends/opencode.ts:68-72`) |

`classifyProviderError` (`pi.ts:36-55`) is UNCHANGED in shape (it maps the server's `errorKind`
`rate_limit`/`billing_error` → pausable `provider_usage_limit`); §6 pins its inputs with fixtures.
`spawnConfig`/`authProfile`/`sessionMeta` are unchanged.

### 4.3 Server-side removals (`packages/pi-acp`)

The bespoke channel is deleted, resolving the fabricated-message, history-splice, and replay-fidelity
findings at the source:

- **`initialize` `_meta` namespace** removed: delete
  `agentCapabilities._meta = { "@automatalabs/pi-acp": { outputSchema: true } }` (`agent.ts:83`). The
  `agentCapabilities` object no longer carries `_meta`.
- **Per-turn schema consumption** removed: delete the `_meta.outputSchema` read, `structured.arm`, the
  prompt-text splice, and the `structured`-turn bookkeeping in `PiSession.prompt`
  (`session.ts:313-326,332-338`), and the fabricated final `agent_message_chunk` emit
  (`session.ts:275-279`).
- **`StructuredOutputState` + `__acp_structured_output` tool** removed: delete
  `packages/pi-acp/src/structured-output.ts`, its construction/installation (`agent.ts:28,145,165-167`),
  the `structured` field on `PiSession`/`PiSessionOptions` (`session.ts:41,65,84,145-146`), and the
  `disarm` calls (`session.ts:173-180,187,334-338`). The reserved `__acp_` namespace note in the README
  (pi-acp spec §15) is retained only if some other `__acp_` tool remains; after this removal there is
  none, so the README drops the `__acp_structured_output` reservation and keeps only `mcp__`.
- After removal the ONLY custom tools are the MCP-bridged ones, which live on the inline extension
  (§3.3) — so `createAgentSession` no longer receives a `customTools` argument for structured output.

### 4.4 Replay/history fidelity (resolved by removal)

Because there is no prompt splice and no fabricated message, pi history contains exactly what the model
produced. `session/load` replay (`replay.ts`) and live streaming are now byte-consistent for
structured turns — the class of replay-fidelity findings the bespoke channel created cannot recur.

### 4.5 Coupled artifacts (see §10 for the apply-ready blocks)

`PI_ACP_PROTOCOL_CONTRACT` (`protocol-coverage.ts:159-172`), the drift assertions
(`docs-drift.test.ts:87-89`, `protocol-coverage.test.ts:147-148`), `pi-backend.test.ts:40-83`, and the
authoring skill's structured-output table (`skills/agentprism-workflow-authoring/reference.md:87`) +
the generated authoring prompt all reference the retired channel and change in lockstep (§10).

---

## 5. Deliverable 3 — Model config option (truthful catalog)

Owner quote 5: `npx @automatalabs/workflows config pi` surfaced only `thinkingLevel`. This deliverable
advertises a truthful `model` select so `config pi` enumerates the models the user can actually select,
and **engages and overturns** the frozen §5.1 rationale for omitting it.

### 5.1 The frozen rationale, quoted and answered

pi-acp spec §5.1 ("design-minimalism finding 2") justified omitting a `model` option: "advertising a
necessarily-partial 'representative' model list would mislead the validate probe (which would surface it
as the model menu)." **That objection is to a FAKE/hardcoded partial list. The fix advertises pi's REAL
configured catalog — the models whose provider is actually authenticated — so the validate probe surfaces
exactly what the user can select.** A truthful enumeration is not misleading; it is the correct config
surface, and it fixes the origin incident directly. The freeze amendment (§10.2) engages this rationale
by name.

### 5.2 The advertised `model` select

`configOptions()` (`session.ts:117-119`) returns `[thinkingLevelOption(pi), modelOption(pi, deps.modelRuntime)]`,
and `applyConfig` (`config.ts`) returns the SAME two-option array on EVERY set (so a `set` echoes the
current catalog). `modelOption` is a `SessionConfigSelect` (`config-options.md` §2.3; SDK
`SessionConfigSelect`):

- **`id`**: `"model"`. **`name`**: `"Model"`. **`type`**: `"select"`. **`category`**: `"model"`.
- **`options` (choices)**: `deps.modelRuntime.getAvailableSnapshot()` (`model-runtime.ts:318`) — the
  models whose provider is configured/authenticated (`snapshot.available`, filtered by
  `configuredProviders`, `model-runtime.ts:243-251`) — each mapped to
  `{ value: `${model.provider}/${model.id}`, name: <display> }`. This is pi's REAL configured catalog,
  not a representative list. When the current model (below) is set but absent from the snapshot (e.g. a
  provider that later lost auth), it is appended so `currentValue` is always a valid choice.
- **`currentValue`** (ACP requires a string): defined semantics for every state —
  - a model is active → `` `${session.model.provider}/${session.model.id}` `` (`agent-session.ts:854`);
  - **no model selected yet** (pre-first-prompt; `session.model` undefined) → `""`;
  - **unauthenticated / empty catalog** (`getAvailableSnapshot()` empty) → `""`, with `options: []` —
    a truthful empty select that tells the probe "no models available; authenticate a provider," never a
    fabricated entry.

### 5.3 What the validate probe shows (exact)

`npx @automatalabs/workflows config pi` opens a session and reads `configOptions` (`config-options.md`
§2.2–2.3): it surfaces, per option, `{ id, type, currentValue, choices }`. With this change the pi row
lists `id:"model"`, `type:"select"`, `currentValue` per §5.2, and `choices` = the configured-provider
model ids (`provider/id`). The authored-select-value check (`config-options.md` §2.3) validates an
author's `configOptions.model` against those choices — but note the runner FORBIDS `model` in authored
`configOptions` (`assertNoModelConfigOption`, `runner.ts:1430-1440`; the reserved channel sets the model
instead). So the advertised select is for **discovery** (the `config` probe) and for hosts driving pi-acp
directly; it does not change how the runner selects models (§2.3 constraint honored).

### 5.4 Set-path semantics (unchanged behavior, echo updated)

`applyConfig("model", "<provider>/<id>")` (`config.ts:36-51`) is unchanged in resolution/auth behavior
(resolve via `modelRuntime.getModel`, precheck `hasConfiguredAuth`, `setModel`, auth→`auth_error`), but
now returns `[thinkingLevelOption, modelOption]` so the echoed catalog includes the (freshly recomputed)
`model` option with `currentValue` reflecting the just-set model. `thinkingLevel` set/echo is unchanged
(pi-acp spec §5.2). The §5.2 state-machine rows (pi-acp spec) are unchanged except that every successful
echo now carries both options.

---

## 6. Deliverable 4 — Error-taxonomy tripwire (fixture-pinned classifiers)

pi-acp classifies provider errors by prose regex over provider message text
(`errors.ts:105-140`: `classifyPreflight` matches `"no model selected"`/`"no api key found"`/
`"authentication failed for"`/`"run '/login"`; `classifyTerminal` matches `401|403|unauthorized|…`,
`quota|billing|…`, `429|rate limit|…`) while the dependency gate forces the pi runtime to npm-latest
every 2–3 days. One upstream wording change can silently downgrade pausable `provider_usage_limit`
(mapped by `PiBackend` from `rate_limit`/`billing_error`, `backends/pi.ts:40-51`) into blind-retry
`provider_error`. This deliverable makes that downgrade **fail loudly**.

### 6.1 Fixture regime (normative)

A new fixture file `packages/pi-acp/test/fixtures/provider-error-strings.ts` captures the **exact
upstream provider message strings** each classifier row depends on, each with a provenance comment
`// pi <pin> — <file:line or provider>`:

- The pre-flight strings pi throws: `formatNoModelSelectedMessage` / `formatNoApiKeyFoundMessage`
  (`auth-guidance.ts:18-25`) and the OAuth `Authentication failed for … Run '/login` throw
  (`agent-session.ts` OAuth path) — captured verbatim from the pinned pi dist.
- Representative terminal `errorMessage`/diagnostic strings per provider family for the auth (401/403/
  unauthorized/invalid api key/expired), billing (quota/insufficient/payment/credit/exceeded your), and
  rate-limit (429/too many requests/overloaded) buckets — captured from pi-ai's provider error surfaces
  (`packages/ai/src/api/*`, `packages/ai/src/env-api-keys.ts`, provider error mappers) at the pin.

Each fixture string carries the **pin it was captured at** (`v0.80.10`). A classifier test asserts every
fixture classifies to its intended `errorKind` (and thence the intended `PiBackend` classification —
`rate_limit`/`billing_error` → pausable `provider_usage_limit`; `provider_error` → recoverable). The
fixtures are the pinned ground truth: an upstream string that no longer matches its regex, or a change
that reclassifies a pausable error to `provider_error`, breaks the test.

### 6.2 Tie to the runtime pin (the tripwire)

The fixture file exports its captured pin (`FIXTURE_PI_PIN = "0.80.10"`), and a guard test asserts it
equals the installed `@earendil-works/pi-coding-agent` version (read from the resolved package.json).
**On every runtime bump** (the dependency gate raises the pin), this guard fails until an implementer
re-captures the fixtures against the new pin and re-confirms every classification — so a wording change
that would silently downgrade `provider_usage_limit → provider_error` cannot land unnoticed. This
converts the pausable→blind-retry downgrade from a silent regression into a required, reviewed step at
each bump. The dependency-gate runbook (`CONTRIBUTING.md`, pi-acp spec §10.1) gains one line: "on a pi
runtime bump, re-capture `provider-error-strings.ts` and re-run the classifier suite."

### 6.3 Determinism note

The classifier predicates stay ordered and deterministic (auth > billing > rate > generic;
`errors.ts:118-140`), consistent with the string-matcher-audit remediation (AST/structured determinism).
This deliverable does not rewrite the classifiers; it pins their inputs so drift is caught, honoring the
"no silent downgrade" mandate without over-reach.

---

## 7. Deliverable 5 — Hermetic multi-transport e2e (credential-free)

Today the hermetic MCP→pi coverage is stdio-only and schema-less; structured assertions live only in the
CI-disabled live suite. This deliverable adds a credential-free regression net for the new client
surface and for schema'd structured output through the injected tool.

### 7.1 Per-transport MCP client coverage

`packages/pi-acp/test/` gains hermetic tests (`tsx --test`, the `deps` DI seam, no credentials) that
drive the full MCP client per transport, each against an in-process fake MCP server:

- **stdio** — as today, extended to cover resources/prompts/logging synthetic tools and a
  `tools/list_changed` that adds, changes, and removes an alias (asserting: new alias active on the next
  turn; changed alias's new schema in effect; removed alias's `execute` returns the fixed "no longer
  available" failed result).
- **Streamable HTTP** — a fake in-process `StreamableHTTPServerTransport` (the same class the runner's
  `StructuredOutput` host uses, `structured-tool.ts:9,145`) serving `tools/list` + `tools/call`; assert
  connect, list, call round-trip, and result projection.
- **SSE** — a fake SSE server; assert connect + list + call.
- **Client features** — a fake server that issues `sampling/createMessage` (asserting it routes to an
  injected `deps.modelRuntime.completeSimple` and maps the result), `roots/list` (asserting the session
  cwd root), and `elicitation/create` (asserting it forwards to an injected ACP client and maps
  accept/decline/cancel; and that an unsupported client yields `{ action:"decline" }`).

### 7.2 Schema'd structured output through the injected tool

A hermetic test drives the FULL runner path for a pi agent with a schema: it stands up the runner's
`StructuredOutputToolHost`, registers `PiBackend` (`injectStructuredOutputTool = true`), advertises
`mcpCapabilities.http === true` from the injected pi-acp (via the DI seam / a stub initialize), and drives
a mock pi stream whose model calls the injected `mcp__structured_output__StructuredOutput` tool with a
conforming value — asserting the runner captures it via `tryCaptured()` and the call returns the
validated object. This is the regression net the bespoke channel never had: it proves the OpenCode-style
injection works end-to-end for pi with zero credentials, and it would fail if §3/§4 regressed the http
advertisement or the bridge.

### 7.3 Turn-abort child-cleanup regression (shared with §8)

The hermetic net includes the §8.3 child-cleanup test.

---

## 8. Deliverable 6 — Turn-abort child cleanup

Live probe (2026-07-16): stopping a run left the agent's `sleep 180` shell child running. This
deliverable guarantees turn cancellation terminates in-flight tool children.

### 8.1 Root-cause investigation (verified against the pinned pi dist)

pi's kill mechanism is present and correct:
- pi's built-in `bash` tool spawns its child **detached** (`tools/bash.ts:99`
  `detached: process.platform !== "win32"`, a new process group) and, on its `execute(signal)` abort,
  kills the whole tree: `onAbort` → `killProcessTree(child.pid)` (`tools/bash.ts:112-113,126-129`),
  which does a process-**group** SIGKILL `process.kill(-pid, "SIGKILL")` (`utils/shell.ts:200-219`).
- pi's agent-loop hands each in-flight tool the **run** `AbortSignal`:
  `executePreparedToolCall(prepared, signal, emit)` calls `prepared.tool.execute(id, args, signal, …)`
  (`agent-loop.ts:463,525,677-679`), and the tool wrapper forwards `signal`
  (`tools/tool-definition-wrapper.ts:16-17,43`).
- That run signal fires when the run's `abortController.abort()` is called: `Agent.abort()` →
  `this.activeRun?.abortController.abort()` (`agent.ts:310-311`).

So a turn abort that reaches `Agent.abort()` DOES propagate to the in-flight bash tool and SIGKILL its
process group. The adapter's current cancel path calls the **low-level** `this.pi.agent.abort()`
(`session.ts:368`) — the raw `Agent`, bypassing pi's public session-level abort surface
`AgentSession.abort()` (`agent-session.ts:1530-1533`: `abortRetry()` + `agent.abort()` + `waitForIdle()`)
and the session-owned bash controller `abortBash()` (`agent-session.ts:2771-2772`, aborted only inside
`AgentSession.dispose()`, `agent-session.ts:825-830`). The adapter's abort is the seam to correct.

### 8.2 Fix (normative)

1. **Route cancellation through the SDK's session-level abort.** In `PiSession`, the turn-abort listener
   (`session.ts:366-374`) calls `this.pi.abort()` (`AgentSession.abort()`) instead of
   `this.pi.agent.abort()`. This is pi's intended public abort surface; it aborts the run controller
   (hence delivers the abort signal to every in-flight tool `execute`, SIGKILLing the bash process group)
   and additionally aborts retries. The `waitForIdle()` inside `AgentSession.abort()` is NOT awaited on
   the cancel path (the existing `graceMs` backstop, pi-acp spec §6.2.1, owns wire settlement so a wedged
   pi cannot hang the ACP client); the adapter calls it fire-and-forget with a detached
   `.catch(() => {})` (extending the detached-promise guarantee of pi-acp spec §9.6).
2. **Guarantee reaping at teardown.** `PiSession.disposeResources()` (`session.ts:411-434`) already
   calls `this.pi.dispose()`, which runs `abortRetry() + abortCompaction() + abortBranchSummary() +
   abortBash() + agent.abort()` (`agent-session.ts:825-830`) — so on `session/close` and the wedged-agent
   backstop, both session-level and agent-loop tool children are killed. No change needed beyond ensuring
   `dispose()` remains on every close/backstop path (it does, `agent.ts:378-394`, `session.ts:400-434`).
3. **No change to the settlement state machine.** The wire settlement (force-resolve `cancelled` after
   `graceMs`) is unchanged; child reaping is orthogonal and happens via (1) synchronously on cancel and
   (2) at dispose. Even a wedged pi (run loop not honoring abort) still fires the bash tool's
   signal-registered `onAbort` (an event listener independent of the loop's cooperation), so the process
   group is SIGKILLed regardless.

### 8.3 Regression test (hermetic, credential-free)

A hermetic test injects a mock pi tool whose `execute(id, args, signal)` spawns a real child process
(e.g. `sleep 180` via `child_process.spawn`), records its pid, and registers `signal`-based
`killProcessTree`-style cleanup mirroring pi's bash tool. Drive a turn that calls it, then deliver
`session/cancel`; assert that within the grace window `process.kill(pid, 0)` throws `ESRCH` (the child is
dead) and the turn settles `cancelled`. A second variant drives `session/close` mid-tool and asserts the
same. This makes the leak impossible to reintroduce. **Implementation-time obligation:** additionally
re-run the exact live probe (a real pi turn running `sleep 180`, then stop) against the pinned pi dist;
if it still leaks despite (1)/(2), that is a stop-and-diagnose against pi's signal delivery (the kill
mechanism is verified present, §8.1, so a persistent leak indicates a delivery gap to root-cause and
report, per the no-external-issues rule — record findings in this repo only).

---

## 9. Error and failure contracts (pinned wire codes)

All wire codes follow the pi-acp spec §8 taxonomy (adapter-owned `RequestError` with `data.errorKind`
and a fixed `data.message` label; JSON-RPC prefix in `error.message`). This train changes the taxonomy
in exactly these ways:

| condition | code | `errorKind` | notes |
|---|---|---|---|
| `http`/`sse` MCP server now **accepted** | — | — | no error: `bridgeMcpServers` connects it (§3.1). The prior `unsupported_mcp_transport` for http/sse is REMOVED. |
| `acp` transport MCP server sent to pi-acp | `-32602` invalidParams | `unsupported_mcp_transport` | still rejected (client-hosted, not served — §12.6), naming the server. RETAINED for `acp` only. |
| MCP connect/list/call failure or timeout (any transport) | `-32603` internalError | `mcp_init_error` (open-time) / failed tool result (call-time) | unchanged from pi-acp spec §9.3; extended to http/sse. |
| removed MCP tool called after `tools/list_changed` | — | — | not a request error: a **failed tool result** with fixed message `` `MCP tool ${alias} is no longer available` `` (§3.3). |
| sampling with no model selected | — | — | MCP error result (`isError`) `no model selected for sampling`, not a JSON-RPC error (server→client request). |
| elicitation unsupported by ACP client | — | — | MCP `{ action:"decline" }` result, not an error (§3.4). |
| structured-output errorKinds `structured_tool_collision` / `invalid_output_schema` | — | REMOVED | the bespoke channel is gone (§4.3); these `ErrorKind` literals are deleted from `errors.ts:3-27` and their label/`INVALID_KINDS` rows (`errors.ts:29-72`), and the T12 assertions (pi-acp spec §13) are removed. |
| set `model` unresolvable / unauthenticated / busy | `-32602` / `-32000` / `-32602` | `invalid_model` / `auth_error` / `session_busy` | UNCHANGED (pi-acp spec §5.2); the `model` select advertisement (§5) does not alter set-path errors. |

The provider-error classification codes (`auth_error` `-32000`; `billing_error`/`rate_limit`/
`provider_error` via terminal reject) are UNCHANGED; §6 pins their inputs. `PI_ACP_PROTOCOL_CONTRACT.providerErrorKinds`
(`auth_error`, `rate_limit`, `billing_error`, `provider_error`) is UNCHANGED.

---

## 10. Normative amendment blocks (apply these to the frozen artifacts)

The implementer applies each block verbatim in intent. These keep the frozen pi-acp spec and its coupled
executable artifacts consistent with this train. (Per house practice, edits are described as current
state, not narrated as removals.)

### 10.1 `PI_ACP_PROTOCOL_CONTRACT` (`packages/acp-agents/src/protocol-coverage.ts:159-172`)

- `mcpCapabilities: {}` → `mcpCapabilities: { http: true, sse: true }`.
- `customCapabilityNamespace` and `outputSchemaKey` are REMOVED (pi no longer advertises a
  custom-capability namespace or an `outputSchema` `_meta` key — §4.3). Any downstream reference to
  `PI_ACP_PROTOCOL_CONTRACT.customCapabilityNamespace`/`.outputSchemaKey` is updated with them.
- `authMethodIds` and `providerErrorKinds` UNCHANGED.

### 10.2 pi-acp spec `docs/specs/pi-acp-spec.md`

- **§5 (capabilities)**: `mcpCapabilities: {}` → `{ http: true, sse: true }` with the truthful-advertisement
  rationale (§3.1); remove `_meta["@automatalabs/pi-acp"] = { outputSchema: true }` from the advertised
  `agentCapabilities` and the §5 bullet describing it (§4.3); add the client-capability declaration
  (sampling/roots/elicitation, §3.4).
- **§5.1 (config surface)**: replace "No `model` config option is advertised (design-minimalism finding
  2)" with the truthful-`model`-select amendment — QUOTE the "necessarily-partial representative list
  would mislead the validate probe" rationale and ANSWER it (the advertised catalog is pi's real
  configured catalog, §5.1–5.3). Update §5.2 to note every successful set echoes both options.
- **§9.3 (MCP bridge)**: rewrite §9.3.4 "Transports" — v1 now serves stdio + http + sse (not stdio only);
  `unsupported_mcp_transport` is retained for `acp` only. Add §9.3.5 dynamic registration (§3.3),
  §9.3.6 resources/prompts/logging (§3.2), §9.3.7 client features (§3.4). Amend the §9.3.2
  collision analysis for extension-sourced MCP tools (§3.3 collision note).
- **§9.4 (structured output)**: §9.4.1–9.4.3 are SUPERSEDED — the terminating-tool/`_meta.outputSchema`
  channel is retired; pi rides the injected `StructuredOutput` HTTP tool like OpenCode (§4). Replace with
  a short section pointing at the runner injection path (`runner.ts:1397-1407`, `structured-tool.ts`).
- **§8 (error taxonomy)**: remove `structured_tool_collision`/`invalid_output_schema` rows; add the §6
  fixture-tripwire note and the §9 amended MCP-transport rows.
- **§9.6 (cancellation)**: amend the abort trigger to `AgentSession.abort()` and add the child-reaping
  guarantee (§8).
- **§13 (test plan)**: remove T12 (bespoke structured output) and the T9 "no `model` option" clause;
  amend T10 (`mcpCapabilities: { http:true, sse:true }`, no `_meta` namespace), T9 (advertises a `model`
  select with defined `currentValue` states), T20 (http/sse transports, dynamic registration, client
  features), and add the §11 rows below.
- **§0 (implementation-time re-verification)**: add a §0.4 repin note if the pin moved at build time.

### 10.3 Drift + conformance tests

- `packages/acp-agents/test/docs-drift.test.ts:87-89`: the spec must now include
  `mcpCapabilities: { http: true, sse: true }` (not `{}`), and MUST NOT assert the `_meta["@automatalabs/pi-acp"]`
  namespace or `{ outputSchema: true }` (those assertions are removed).
- `packages/acp-agents/test/protocol-coverage.test.ts:147-148`: `PI_AGENT_DIST.includes("mcpCapabilities: {}")`
  → the new served block; the `outputSchemaKey` dist assertion is removed.
- `packages/acp-agents/test/pi-backend.test.ts:40-83`: `embedSchemaInPrompt` → `true`;
  `injectStructuredOutputTool` → `true`; the `customCapabilities` deep-equal is removed (now
  `undefined`); the `promptMeta` outputSchema assertions are removed (now `undefined`); `nativeStructured`
  assertion retained.

### 10.4 Authoring skill + generated prompt

- `skills/agentprism-workflow-authoring/reference.md:87` (the structured-output backend table): the **Pi**
  row moves from "native turn-level `_meta.outputSchema` … no injected MCP tool" to the injected-tool
  channel — i.e. Pi joins OpenCode/custom: "a client-hosted `StructuredOutput` MCP tool injected when the
  agent advertises HTTP MCP support." Add a note that Pi now accepts http/sse MCP servers.
- After editing the skill, REGENERATE the MCP `author-workflow` prompt via
  `node scripts/generate-authoring-prompt.mjs` (exact-marker rewrite) so the generated prompt matches;
  the drift test (`packages/mcp-server` authoring-prompt drift) states the exact command and fails until
  regenerated. This is mandatory — skill edits require regeneration.

### 10.5 `docs/api.md` / `docs/design-notes.md` / `README`

Any prose describing pi-acp as stdio-only MCP or as having a native structured-output channel is updated
to the served-transport + injected-tool reality (the docs-drift suite covers `docs/api.md`).

---

## 11. Test plan — traceability matrix

All tests run under `tsx --test` (the package convention) using the DI seam (`runAcp({ deps, stream })`
for pi-acp; the runner's DI for acp-agents) — no external credentials except the gated live leg. Every
row cites the normative statement it covers. Rows extend the pi-acp spec §13 matrix (numbering continues).

### 11.1 Full MCP client (§3)

| # | covers | assertion |
|---|---|---|
| M1 | §3.1 | `initialize` advertises `mcpCapabilities: { http: true, sse: true }` (not `{}`), no `_meta` namespace; an `http` and an `sse` server both connect and round-trip `tools/call` (fake in-process transports); an `acp` server → `unsupported_mcp_transport` (`-32602`); a stdio server still works |
| M2 | §3.1 | connect/list/call bounded by injected `mcpTimeoutMs` on http AND sse (hung connect → rollback + reject `mcp_init_error` + transport closed; hung call → failed tool); a late resolve/reject of a timed-out op produces NO unhandled rejection (detached) |
| M3 | §3.2 | resources exposed as `mcp__<s>__list_resources`/`read_resource`; prompts as `mcp__<s>__list_prompts`/`get_prompt`; `logging/setLevel("info")` on connect and `notifications/message` → `agent_thought_chunk` `[mcp:<s>] …`; paginated resources/prompts enumerate ALL pages + cycle guard |
| M4 | §3.3 | migration to inline extension: initial tools registered; `tools/list_changed` ADD → new alias active on next turn; CHANGE → new schema/description in effect; REMOVE → alias `execute` returns fixed `no longer available` failed result; re-ADD → live again; per-session fresh extension on load/resume/fork (captured `pi` never reused across sessions) |
| M5 | §3.3 | reserved-namespace invariant holds for extension-sourced MCP tools (no `mcp__…` alias shadows a built-in; every alias present in `getAllTools()` post-construction, else `mcp_init_error`) |
| M6 | §3.4 | sampling → injected `deps.modelRuntime.completeSimple` with the mapped `Context`, result mapped to `CreateMessageResult`; no-model → MCP error `no model selected for sampling`; roots → `[{ uri: file://<cwd> }]`; elicitation → forwards to injected ACP `elicitation/create`, maps accept/decline/cancel; unsupported client → `{ action:"decline" }`; each bounded + turn-signal-cancellable |

### 11.2 Structured output via injection (§4)

| # | covers | assertion |
|---|---|---|
| S1 | §4.2 | `PiBackend`: `injectStructuredOutputTool === true`, `embedSchemaInPrompt === true`, `customCapabilities === undefined`, `promptMeta(schema) === undefined`, `nativeStructured` = `parseFinalJson(finalMessageText())`; `classifyProviderError` maps `rate_limit`/`billing_error` → `provider_usage_limit` (unchanged) |
| S2 | §4.1/§7.2 | full runner path: pi advertises `mcpCapabilities.http === true`, schema set → runner injects `StructuredOutput` http server; a mock pi turn calls `mcp__structured_output__StructuredOutput` with a conforming value → runner captures via `tryCaptured()` and returns the validated object (hermetic, credential-free) |
| S3 | §4.3 | pi-acp server carries NO `_meta.outputSchema` consumption, NO prompt splice, NO fabricated final message, NO `__acp_structured_output` tool, NO `StructuredOutputState`; `structured_tool_collision`/`invalid_output_schema` errorKinds are gone; live vs `session/load` replay are byte-consistent for a structured turn (§4.4) |
| S4 | §10.3/§10.4 | drift/conformance: `docs-drift`, `protocol-coverage`, `pi-backend.test` pass with the amended literals; the authoring skill Pi row + regenerated prompt match (authoring-prompt drift test green) |

### 11.3 Model config option (§5)

| # | covers | assertion |
|---|---|---|
| C1 | §5.2 | `configOptions()` and every successful `set` echo `[thinkingLevel, model]`; the `model` option is a `select` with `choices` = `getAvailableSnapshot()` mapped to `provider/id`; a configured model → `currentValue = "provider/id"` and it is a valid choice |
| C2 | §5.2 | state semantics: no model selected → `currentValue = ""`; empty/unauthenticated catalog → `currentValue = ""`, `options: []`; an active-but-unlisted model is appended so `currentValue` is always a valid choice |
| C3 | §5.3 | the validate probe (`config-options.md` §2.3 surface) enumerates the `model` option with its choices — the `config pi` origin incident is fixed; the runner's `assertNoModelConfigOption` guard is unaffected |
| C4 | §5.4 | set model hit/miss/unauthenticated/busy behavior unchanged (rows of pi-acp spec §5.2), with the two-option echo |

### 11.4 Error-taxonomy tripwire (§6)

| # | covers | assertion |
|---|---|---|
| E1 | §6.1 | every fixture string in `provider-error-strings.ts` classifies to its intended `errorKind` (auth/billing/rate/generic) and thence the intended `PiBackend` classification (pausable vs recoverable) |
| E2 | §6.2 | the guard test asserts `FIXTURE_PI_PIN` equals the installed `@earendil-works/pi-coding-agent` version — a mismatch (runtime bumped without re-capture) FAILS; the classifier precedence stays ordered (auth>billing>rate>generic) |

### 11.5 Correctness batch (§8)

| # | covers | assertion |
|---|---|---|
| A1 | §8.2/§8.3 | a mock tool spawns a real child; `session/cancel` mid-tool → within the grace window `process.kill(pid,0)` throws `ESRCH` (child dead) and the turn settles `cancelled`; a `session/close` mid-tool variant kills it too; NO unhandled rejection from the detached pi promise |
| A2 | §8.2 | the cancel path invokes `AgentSession.abort()` (not the raw `agent.abort()`), fire-and-forget (`waitForIdle` not awaited on the wire path); `dispose()` still runs `abortBash()+agent.abort()` on close/backstop |

### 11.6 Live e2e (gated on provider keys)

| # | covers | assertion |
|---|---|---|
| L1 | §3.4/§8 | one cheap-model leg: attach a real http MCP server to a pi agent and round-trip a tool; run a `sleep 180` bash turn and stop it, asserting the child is reaped. Gated on an env key; skipped in credential-free CI (per the existing live-suite gate). This EXTENDS, never replaces, the hermetic net. |

---

## 12. Non-goals (with rationale)

- **12.1 Private-field tool mutation.** Reaching into `AgentSession._customTools` + the private
  `_refreshToolRegistry` to force dynamic registration is out of scope — it is illegal (private) and
  breaks on any pi refactor. The public inline-extension seam (§3.3) is used instead.
- **12.2 New pi-acp runtime dependencies.** None added; the MCP + ACP SDKs are already direct deps. No
  new transport library is pulled.
- **12.3 Changing the runner's script-side `model`-in-configOptions guard.** `assertNoModelConfigOption`
  (`runner.ts:1430-1440`) is a script-authoring rule, orthogonal to advertisement (§5.3). Untouched.
- **12.4 pi additional-directories / multi-root workspaces.** pi has no allowed-roots concept
  (pi-acp spec §9.1.7); `roots/list` returns the single session cwd. Not a regression — pi simply has one
  root.
- **12.5 Other backends.** No change to Claude/Codex/OpenCode beyond pi reusing the existing injection
  path (issue #224 Non-goals). The built-in backend registry architecture is a separate train.
- **12.6 Serving the `acp` MCP transport from pi-acp.** The `acp` transport is client-hosted (the client
  proxies MCP over the ACP connection); pi-acp is the AGENT and does not host it — `acp` stays rejected
  with `unsupported_mcp_transport`. This is not a narrowing of "all transports": the owner's "all
  supported MCP protocol transports" for a workflow-attached server means stdio/http/sse (the server the
  author provides); `acp` is a client-side hosting mode, not a server the author passes.
- **12.7 Per-call MCP progress forwarding to ACP.** MCP `notifications/progress` during a `tools/call`
  are dropped (no per-tool-call progress channel in ACP); tool-call updates already stream partial
  results (pi-acp spec §6.3). Adding a bespoke progress channel is unrequested and would need a
  client-side surface that does not exist.
- **12.8 Unserved-by-design ACP surfaces.** providers/*, logout, session/delete, set_mode stay unserved
  (issue #224 Non-goals; pi-acp spec §11).

Nothing else is deferred; every deliverable of §2.2 is specified in full above.

---

## 13. References (verified `file:line` + version pins)

**Base commit (this repo), all `packages/…`/`scripts/…`/`docs/…`/`skills/…` citations verified against:**
`0470ed175e000085f5bd647cb1c0ff729d0dee9a` (branch `spec/pi-mcp-train`, based on `origin/main`; matches
`.agentprism/design-224/base-sha.txt`).

**Base-freshness note (verified at authoring):** `origin/main` has advanced to
`78944e3462458de30c4989ff04894fecbf43632d`. `git diff 0470ed1..origin/main --name-status` over
`packages/pi-acp packages/acp-agents packages/workflows packages/shared-types docs/specs
scripts/check-acp-deps.mjs` is release-metadata ONLY — `M packages/{pi-acp,acp-agents,workflows}/package.json`
(version bumps `pi-acp 0.1.2→0.1.3`, `acp-agents 0.30.0→0.30.1`, `workflows 0.38.0→0.38.1`) and their
`CHANGELOG.md` (the Changesets "Version Packages" flow). No `.ts` source, no dependency pin (pi-coding-agent,
`@modelcontextprotocol/sdk`, `@agentclientprotocol/sdk` all untouched), and no cited surface changed. All
citations below remain byte-accurate against the pinned base `0470ed1`.

**pi source, all `packages/{ai,agent,coding-agent}/…` citations verified against:** repo
`github.com/earendil-works/pi`, tag **`v0.80.10`**, commit
**`8dc78834cde4e329284cf505f9e3f99763df5529`**; npm `@earendil-works/pi-coding-agent@0.80.10` (lockstep
with `@earendil-works/pi-agent-core@0.80.10`, `@earendil-works/pi-ai@0.80.10`). Freshness re-checked at
authoring: `gh api repos/earendil-works/pi/releases/latest` = `v0.80.10`, `npm view … version` = `0.80.10`
— pin is current. **Forward-compat risk note:** upstream `main` is at `216e672e7c9fc65682553394b74e483c0c9e47f7`,
exactly **one** unreleased commit ahead of the tag; `git diff v0.80.10 216e672 --` over every pi surface
this contract cites (`agent-session.ts`, `sdk.ts`, `model-runtime.ts`, `extensions/{loader,runner,types}.ts`,
`resource-loader.ts`, `tools/bash.ts`, `exec.ts`, `utils/shell.ts`, `ai/src/types.ts`) is **empty** — no
unreleased drift on any cited seam. The §1 re-verification clause obligates re-running this before building.

**MCP client, `@modelcontextprotocol/sdk@1.29.0`**, verified against the installed dist
(`node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.4.3/…/dist/esm/`); `npm view … version` =
`1.29.0` — pin current. **ACP SDK, `@agentclientprotocol/sdk@1.2.1`**, installed dist; `npm view … version`
= `1.2.1` — pin current. Both stay exact-pinned in `packages/pi-acp/package.json`. Re-verify at
implementation time per §1.

### This repo (base `0470ed1`)

- `packages/pi-acp/src/mcp-bridge.ts` — `bounded` :40-57, `connectDefaultMcpClient` (stdio; orphan-child
  close on failed connect) :59-126, typed-server hard-reject :214-216, paginated `tools/list` + cycle
  guard :240-256, total result projection (five-member `ContentBlock`, `structuredContent`→`details`,
  `isError`→throw) :150-183, `bridgeMcpServers` :205-302, `disposeMcpBridge` :304-306.
- `packages/pi-acp/src/agent.ts` — `initialize` `agentCapabilities` (`mcpCapabilities: {}` :82, `_meta`
  namespace :83) :70-87, `createAgentSession({ customTools:[…bridge.tools, structured.tool] })` :146-151,
  post-construction alias/structured-tool presence check :166-173, `dispose()` :427-436.
- `packages/pi-acp/src/session.ts` — `configOptions()` (thinkingLevel-only) :117-119, `_meta.outputSchema`
  consume + `structured.arm` + prompt splice :313-326, fabricated final `agent_message_chunk` :275-279,
  turn-abort listener calls `this.pi.agent.abort()` :366-374, `cancel()` :396-398, `dispose()` :400-409,
  `disposeResources()` (→ `pi.dispose()`) :411-434.
- `packages/pi-acp/src/config.ts` — `thinkingLevelOption` :8-17, `applyConfig` (accepts `"model"`, echoes
  `[thinkingLevelOption]`) :19-52.
- `packages/pi-acp/src/errors.ts` — `ErrorKind` union (incl. `structured_tool_collision`,
  `invalid_output_schema`) :3-27, labels :29-54, `INVALID_KINDS` :56-72, `classifyPreflight` (prose
  regex) :105-116, `classifyTerminal` (auth/billing/rate regex, ordered) :118-140.
- `packages/pi-acp/src/structured-output.ts` — `STRUCTURED_TOOL_NAME` + `StructuredOutputState`
  (arm/capture/disarm) :5-74 (deleted by §4.3).
- `packages/pi-acp/src/deps.ts` — `PiAcpDeps` (`connectMcpClient` :25, `modelRuntime` :23, `mcpTimeoutMs`/
  `graceMs` :27-28), `resolveDeps` default `connectMcpClient` :68-71, `DEFAULT_REQUEST_TIMEOUT_MSEC`
  default :11,51.
- `packages/pi-acp/src/replay.ts` — replay projection (no fabricated message) :47-126.
- `packages/pi-acp/test/matrix-gaps.test.ts` — stdio bridge fakes + error-shape table :24-101,328-458
  (extended by §7).
- `packages/pi-acp/package.json` — deps `@modelcontextprotocol/sdk 1.29.0`, `@agentclientprotocol/sdk
  1.2.1`, `@earendil-works/pi-coding-agent 0.80.10` (exact, no caret); `version 0.1.2` at base.
- `packages/workflow-engine/src/workflow.ts` — `WorkflowAgentOptions.mcpServers?: McpServerConfig[]`
  (additive, past the resume hash) :330-337.
- `packages/shared-types/src/mcp-config.ts` — `McpServerConfig` union (stdio/http/sse/acp), `McpNameValue`,
  identity note (not hashed).
- `packages/acp-agents/src/capabilities.ts` — `unsupportedMcpServer` (stdio always serviceable; http/sse
  gated once `mcpCapabilities` exists; acp strict) :278-300, `negotiateCapabilities` :91-117.
- `packages/acp-agents/src/backends/pi.ts` — `injectStructuredOutputTool = false` :30, `embedSchemaInPrompt
  = false` :29, `customCapabilities` :31-34, `classifyProviderError` (`rate_limit`/`billing_error` →
  `provider_usage_limit`) :36-55, `spawnConfig` bin ladder :57-73, `promptMeta` :79-82, `nativeStructured`
  :84-86.
- `packages/acp-agents/src/backends/opencode.ts` — `embedSchemaInPrompt = true` :28,
  `injectStructuredOutputTool = true` :29, `promptMeta` :61-66, `nativeStructured` :68-72 (parity target).
- `packages/acp-agents/src/runner.ts` — `shouldInjectStructuredOutputTool` :1397-1403 →
  `supportsStructuredOutputToolTransport` (`mcpCapabilities.http === true`) :1405-1407, injection into
  `session.mcpServers` :822-833, `resolveStructuredOutput` call (`tryCaptured`/`tryNative`) :947-967,
  `availableMcpServerName` :1409-1418, `assertNoModelConfigOption` :1430-1440, `selectBackend`/
  `resolveModelRoute` :1445-1476, `builtinBackend` (`new PiBackend()`) :1449-1460.
- `packages/acp-agents/src/structured-tool.ts` — `STRUCTURED_OUTPUT_TOOL_NAME`/`_SERVER_NAME` :24-25,
  `StructuredOutputToolHost` (localhost Streamable-HTTP host) :51-135, `register`/`tryCaptured`/`release`
  :65-87, capture handler :199-210.
- `packages/acp-agents/src/protocol-coverage.ts` — `PI_ACP_PROTOCOL_CONTRACT` :159-172.
- `packages/acp-agents/test/docs-drift.test.ts` — pi-acp spec drift assertions (`_meta` namespace :87,
  `{ outputSchema: true }` :88, `mcpCapabilities: {}` :89, authMethodIds :90-91, errorKinds :93-94).
- `packages/acp-agents/test/protocol-coverage.test.ts` — `PI_AGENT_DIST.includes(outputSchemaKey)` :147,
  `includes("mcpCapabilities: {}")` :148.
- `packages/acp-agents/test/pi-backend.test.ts` — `embedSchemaInPrompt`/`injectStructuredOutputTool`/
  `customCapabilities` pins :40-44, `promptMeta` :78-79, `nativeStructured` :83.
- `scripts/check-acp-deps.mjs` — `ACP_DEP_MATCHERS` (matches `@earendil-works/pi-coding-agent`) :40-43,
  `WRAPPED_RUNTIMES` :68.
- `skills/agentprism-workflow-authoring/reference.md` — structured-output backend table (Pi row) :83-89,
  pi-acp bin fallback :301, pi auth :498, harness routing/probe :50-52,568.
- `scripts/generate-authoring-prompt.mjs` — exact-marker rewrite + missing-marker throw :7,20-24.
- `docs/specs/pi-acp-spec.md` — §5 capabilities :502-566, §5.1 config-surface rationale :568-595, §5.2
  set-config state machine :597-661, §9.3 MCP bridge :1457-1585, §9.4 structured output :1587-1658, §8
  error taxonomy :914-1100, §9.6 cancellation :1717-1772, §13 test plan :1937-2033, §14 references :2002+.
- `docs/specs/config-options.md` — probe API §2.2, validate-time surfacing + select-choice check §2.3
  :78-101.

### `@earendil-works/pi-coding-agent@0.80.10` / `@earendil-works/pi-agent-core@0.80.10` / `@earendil-works/pi-ai@0.80.10` (commit `8dc7883`)

- `packages/coding-agent/src/core/sdk.ts` — `CreateAgentSessionOptions` (`modelRuntime?` :39, `customTools?`
  :68, **`resourceLoader?` :71**, `sessionManager?` :74) :33-80, `CreateAgentSessionResult` :83-91,
  `new AgentSession({ …, customTools, resourceLoader-via-services, … })` :371-385.
- `packages/coding-agent/src/core/agent-session.ts` — private `_customTools` :326,362, `getActiveToolNames`
  :887-889, `getAllTools` :894-902, `getToolDefinition` :904-906, `setActiveToolsByName` ("Changes take
  effect on the next agent turn") :912-926, `get model(): Model|undefined` :854, extension-API bindings
  (`registerTool`→`refreshTools`→`_refreshToolRegistry`) :2373-2376, `_refreshToolRegistry` (composes
  `getAllRegisteredTools()` + `_customTools`, activates newly-appeared tools) :2430-2521, construction
  `_refreshToolRegistry` :2571-2574, `async abort()` (`abortRetry`+`agent.abort`+`waitForIdle`) :1530-1533,
  `abortBash()` :2771-2772, `_bashAbortController` :318, `dispose()` (`abortRetry/Compaction/BranchSummary/
  Bash`+`agent.abort`) :825-830, `setModel` :1566-1580, `setThinkingLevel` :1630-1640, `getCwd`-backed
  session cwd :3170.
- `packages/coding-agent/src/core/extensions/loader.ts` — `refreshTools` no-op pre-bind (comment "valid
  during extension load; refresh needed post-bind") :189-190, `createExtensionAPI.registerTool`
  (`extension.tools.set` + `runtime.refreshTools()`) :237-244, `loadExtensionFromFactory` :472-483.
- `packages/coding-agent/src/core/extensions/runner.ts` — `getAllRegisteredTools` (first-per-name)
  :422-433, `getToolDefinition` :435-443.
- `packages/coding-agent/src/core/extensions/types.ts` — `ExtensionFactory`/`InlineExtension`
  :1474-1483, `ExtensionAPI.registerTool` (no `unregisterTool`) :1219-1221, tool-registration API surface
  :1210-1245, `RegisteredTool` :1488-1491.
- `packages/coding-agent/src/core/resource-loader.ts` — `ResourceLoader` interface :38-46,
  `DefaultResourceLoaderOptions.extensionFactories?: InlineExtension[]` :122-131, `DefaultResourceLoader`
  (loads inline factories) :159,214,507-509, `getExtensions` :262.
- `packages/coding-agent/src/core/model-runtime.ts` — `getModels` :289-291, `getModel(provider,id)`
  :293-295, `getAvailable` (async) :301, `getAvailableSnapshot()` (authed-provider models) :318-320,
  `hasConfiguredAuth` :354-356, `configuredProviders` snapshot :53,243-251, `streamSimple` :472-477,
  `completeSimple(model, context, options): Promise<AssistantMessage>` :479-481, `ModelRuntime.create`
  :130-165.
- `packages/coding-agent/src/core/auth-guidance.ts` — `formatNoModelSelectedMessage` :18-20,
  `formatNoApiKeyFoundMessage` :22-25 (ground the §6 pre-flight fixtures).
- `packages/coding-agent/src/core/tools/bash.ts` — `createLocalBashOperations` :82, detached spawn
  (`detached: process.platform !== "win32"`) :99, `trackDetachedChildPid` :108, `onAbort`→
  `killProcessTree(child.pid)` :112-113,126-129, timeout kill :117-120 (§8.1).
- `packages/coding-agent/src/core/exec.ts` — `execCommand` spawn + SIGTERM→SIGKILL `killProcess`,
  abort-signal wiring :5,41-70,89-104.
- `packages/coding-agent/src/utils/shell.ts` — `trackDetachedChildPid`/`untrackDetachedChildPid`
  :182-187, `killProcessTree` (process-**group** SIGKILL `process.kill(-pid, "SIGKILL")`) :200-219 (§8.1).
- `packages/agent/src/agent.ts` — `Agent.abort()` (`activeRun.abortController.abort()`) :310-311,
  `get signal()` :304-307, `waitForIdle` :319, busy-throw `prompt` :335-348.
- `packages/agent/src/agent-loop.ts` — run `signal` threaded through `runLoop`→`executeToolCalls`→
  `executePreparedToolCall(prepared, signal, emit)` :159,214,417-537, `tool.execute(id, args, signal, …)`
  :677-679.
- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` — `execute` forwards `signal`
  :16-17,43 (§8.1).
- `packages/ai/src/types.ts` — `Context { systemPrompt?, messages, tools? }` :450-454, `AssistantMessage`
  / `Usage` / `StopReason` (for the §3.4 sampling result mapping) :357-401.
- `packages/coding-agent/src/core/session-manager.ts` — `getCwd()`, `getSessionId`/`getSessionFile`
  (§3.4 roots + fork), lazy `_persist` (unchanged from pi-acp spec §14).

### `@modelcontextprotocol/sdk@1.29.0` (installed dist)

- `dist/esm/client/index.js` — `registerCapabilities` :160-166, `setRequestHandler` with client-feature
  validation (`elicitation/create` :191-242, `sampling/createMessage` :244-278), server-request routing
  gated on client capabilities (`roots/list_changed` :393-395, `sampling` :416-419, `elicitation`
  :421-422), imports `CreateMessageRequestSchema`/`CreateMessageResultSchema`/`ElicitRequestSchema`/
  `ElicitResultSchema`/`ToolListChangedNotificationSchema`/`ResourceListChangedNotificationSchema`/
  `PromptListChangedNotificationSchema` :2, `listTools(cursor?)` :565, `callTool` :490, plus
  `listResources`/`readResource`/`listResourceTemplates`/`listPrompts`/`getPrompt`/`setLoggingLevel`.
- `dist/esm/client/streamableHttp.js` — `StreamableHTTPClientTransport` :23.
- `dist/esm/client/sse.js` — `SSEClientTransport` :17.
- `dist/esm/client/stdio.js` — `StdioClientTransport` (spawns + `close()` kills child).
- `dist/esm/shared/protocol.js` — `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` :8.
- `dist/esm/types.js` — `CallToolResultSchema`/`ContentBlockSchema` (five-member)/`ListToolsResultSchema`
  (paginated) (grounds §3.2 projection, per pi-acp spec §14 pins).

### `@agentclientprotocol/sdk@1.2.1` (installed dist)

- `dist/acp.js` / `dist/acp.d.ts` — `methods.client.elicitation.create = "elicitation/create"`
  (`acp.js:99-101`; `acp.d.ts:71-73`), `CreateElicitationRequest`/`CreateElicitationResponse`
  (`acp.d.ts:3,519`), `unstable_createElicitation` :819, `requestPermission` :778,
  `AgentContext.request(method, params, options?)` / `notify` (the generic client seam pi-acp uses),
  `McpCapabilities` / `SessionConfigSelect` / `SetSessionConfigOptionResponse` (per pi-acp spec §14 pins).

---

## 14. Rejected alternatives (with rationale)

1. **Private-field tool mutation for `tools/list_changed`** (`_customTools` + `_refreshToolRegistry`).
   Rejected: both are `private` (`agent-session.ts:326,2430`); mutating them is illegal TypeScript,
   unsupported, and breaks on any pi refactor. The inline-extension seam (§3.3) is pi's sanctioned public
   path and survives refactors. (Non-goal 12.1.)

2. **Keep `customTools`; document `tools/list_changed` as unsupported (static tool set).** Rejected: a
   real public seam exists (inline extensions, §3.3 investigation), and the owner's directive is to
   "support the whole base protocol … wiring it in to the seams" (quote 3). Choosing a documented
   limitation when a real seam exists would narrow WHAT, which §0 forbids. Recorded here as the runner-up
   because it is the fallback IF a future pi release removes the inline-extension seam (the §1
   re-verification would surface that and re-open the contract).

3. **Keep the bespoke `_meta.outputSchema` channel and additionally serve HTTP MCP.** Rejected: owner
   quote 4 directs the OpenCode-style injection ("just pass the structured output mcp server to pi …
   it would work just like any ACP agent that doesn't have native structured outputs"). Keeping the
   bespoke channel leaves the fabricated-message, history-splice, and replay-fidelity findings unresolved;
   the directive is resolution BY REMOVAL (§4). Two channels also risks double-capture ambiguity.

4. **Advertise a hardcoded "representative" `model` list.** Rejected explicitly by the frozen §5.1
   rationale (a partial list "would mislead the validate probe") — and this spec agrees. The fix
   advertises pi's REAL configured catalog (`getAvailableSnapshot()`), which is truthful and fixes the
   `config pi` incident (§5.1). A hardcoded list would reintroduce exactly the objection §5.1 raised.

5. **Advertise ALL builtin models (`getModels()`) regardless of auth.** Rejected: that lists models the
   user cannot actually select (unauthenticated providers), misleading the probe and every `set` attempt
   into `auth_error`. `getAvailableSnapshot()` (authed providers only) is the truthful surface the owner's
   `config pi` use-case needs.

6. **Route MCP sampling to a fresh/global model instead of the session's.** Rejected: sampling should use
   the agent's active model so a server's assisted completion is consistent with the run
   (`session.model`, `model-runtime.completeSimple`); `modelPreferences` still lets a server steer within
   the configured catalog. A separate global model would surprise authors and could hit an unauthenticated
   provider.

7. **Overload `session/request_permission` for MCP elicitation.** Rejected: ACP 1.2.1 has a native
   `elicitation/create` method (`acp.js:99-101`) designed exactly for structured user input; the
   permission seam is for tool approval (allow/deny), a different shape. Routing elicitation to its native
   ACP method (§3.4) is the correct wiring the owner named ("routed through the ACP session's
   elicitation/permission seam" — elicitation first, permission is the tool-approval sibling).

8. **Fix the turn-abort leak by re-writing pi's bash-child kill.** Rejected: pi's kill mechanism is
   already correct (process-group SIGKILL, §8.1) and lives upstream (not ours to change; no external
   issues per policy). The leak is at the adapter boundary — the raw `agent.abort()` vs. the public
   `AgentSession.abort()` — so the fix is a one-line adapter change plus a hermetic regression test
   (§8.2–8.3), not an upstream rewrite.

9. **Solve the error-taxonomy fragility by replacing prose regex with structured provider codes.**
   Rejected as out of scope for this train: pi surfaces provider errors largely as prose (`errors.ts`
   consumes message text), and a structural rewrite is a larger, separate effort. The requested, bounded
   fix is the fixture tripwire (§6) that makes a silent downgrade impossible — matching issue #224's
   deliverable 4 exactly ("fixture-pinned classifier tests … so a silent downgrade fails loudly").
