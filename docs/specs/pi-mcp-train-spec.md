# pi-acp: full MCP client (whole base protocol, all transports, client features) + structured output via standard injection + correctness batch

## 0. The source — the owner's verbatim words (hop-0 anchor)

The spec exists to satisfy THESE SENTENCES, not any prior framing, spec, or agent prose. The spec
MUST reproduce this block verbatim in its own Source section, and every normative decision traces
to it. Any addition the owner never asked for needs an explicit rationale; any narrowing of what
these sentences state is a BLOCKING defect at every gate.

> "I want to create a new first class ACP server for pi coding agent, built on its sdk, as a new package in the mono repo." *(2026-07-15)*

> "Ok just re: meta review findings, another aspect it didn't capture (since kimi didn't know about my original request when it wrote the review) was that I ask for MCP support (like the rest of our ACP agents support). That piece was dropped by you from my original request and is kind of a crucial piece since workflows allow passing in mcp servers to the agents." *(2026-07-16)*

> "The MCP servers passed to any ACP agent could be any of the supported MCP protocol transports. If we have artificially created constraints as to the type of MCP server we can pass to a workflow script agent, that is another incorrect assumption. For Pi ACP's case, its a little bit harder because we need to build out the whole MCP client, since pi-coding-agent doesn't support MCP out of the box. We need to support the whole base protocol (which the typescript sdk supports), the difficult part is wiring it in to the seams of the pi-coding-agent sdk, since we're building on top of it." *(2026-07-16)*

> "Just like the OpenCode ACP Server integration, we should just pass the structured output mcp server to pi if a schema is defined on an agent call. As long as we build the MCP client of pi-acp correctly, it would work just like any ACP agent that doesn't have native structured outputs?" *(2026-07-16)*

> "Also this context may be help re: tests, I initially came to Kimi with my inquiry after I was trying to use the `npx @automatalabs/workflows config pi` command to test out the Pi integration, and noticed that the only config that surfaced was `thinkingLevel`." *(2026-07-16)*

**Recorded owner scope decision (binary question, 2026-07-16):** "whole base protocol" = FULL,
INCLUDING MCP client features — sampling (server→pi-LLM completions), roots, elicitation — not
just the server-feature consumption surface. This is OWNER SCOPE: no lens (minimalism included)
may propose descoping it; the spec designs HOW, never shrinks WHAT.

This is the **frozen implementation contract** for issue #224. It specifies the whole train: a full
Model Context Protocol (MCP) client inside `@automatalabs/pi-acp` (all transports + every stable base-
protocol surface in the pinned SDK + client features), retirement of pi-acp's bespoke structured-output
channel in favor of the standard client-hosted injection path already used by OpenCode, a truthful
`model` config option, an error-taxonomy tripwire tied to the runtime pin, a hermetic multi-transport
regression net, and a turn-abort child-cleanup fix. It amends the already-frozen
`docs/specs/pi-acp-spec.md` (the "pi-acp spec") with explicit, apply-ready amendment blocks (§10); the
pi-acp spec remains the base contract and this document is normative where the two differ.

An implementer who has never seen issue #224 can build this without asking questions. Every numbered
section carries a source trace, every mechanism claim carries a verified `file:line` citation (§13),
numeric wire codes are pinned wherever a peer sees them, and design questions are resolved here and in
the rejected-alternatives record (§14), never deferred.

The owner also framed the process (issue #224 "Process"): "we'll start with a contract workflow for
train 1, then implementation and release train." This document is that contract; the implementation and
release trains consume it frozen.

---

## 1. Implementation-time re-verification (normative — do this FIRST)

**Source trace:** owner quotes 1 and 3 require a first-class package built on the current pi and MCP SDK
seams; the focus freshness directive makes drift a blocking discrepancy. This derived gate prevents a
dependency move from silently changing the contract the owner approved.

pi releases every ~2–3 days and the dependency gate (`scripts/check-acp-deps.mjs`) forces the pi runtime
to npm-latest continuously. Before writing any code, the implementer MUST re-run the external freshness
protocol and treat any drift as a **stop-and-report** discrepancy — never re-implement around a moved
pin silently (the pi-acp spec §0 obligation, extended here to the new surfaces this train wires into):

1. Fresh temp clone of `https://github.com/earendil-works/pi`, then
   `git fetch origin main --tags` (a tag-only fetch is insufficient for the release→main risk check).
2. `gh api repos/earendil-works/pi/releases/latest --jq .tag_name` **and**
   `npm view @earendil-works/pi-coding-agent version`,
   `npm view @earendil-works/pi-agent-core version`, and `npm view @earendil-works/pi-ai version`;
   all three npm values MUST agree with the release.
3. Compare against the pin in §13 (`v0.80.10` / commit `8dc78834cde4e329284cf505f9e3f99763df5529` / npm
   `0.80.10`). **If the pin is no longer the latest release, that is a STOP:** re-verify every pi
   citation this contract adds — the inline-extension tool-registration seam
   (`extensions/loader.ts`, `extensions/runner.ts`, `extensions/types.ts`, `resource-loader.ts`), the
   settings seam (`settings-manager.ts`),
   tool-registry internals (`agent-session.ts` `_customTools`/`_refreshToolRegistry`/`setActiveToolsByName`/
   `getAllTools`/`abort`), the LLM completion seam (`model-runtime.ts` `completeSimple`/
   `getAvailableSnapshot`, `ai/src/models.ts` credential/`filterModels` availability, and provider
   filters), and the bash-child kill path (`tools/bash.ts`, `exec.ts`, `utils/shell.ts`) —
   against the new latest, update the pins (§13) and every changed claim, and re-open this contract for
   review before building.
4. Fresh temp clone `https://github.com/modelcontextprotocol/typescript-sdk`, run
   `git fetch origin main --tags`, and compare
   `gh api repos/modelcontextprotocol/typescript-sdk/releases/latest --jq .tag_name` with
   `npm view @modelcontextprotocol/sdk version`. Repeat the fresh clone plus main/tags fetch for
   `https://github.com/agentclientprotocol/typescript-sdk` and compare
   `gh api repos/agentclientprotocol/typescript-sdk/releases/latest --jq .tag_name` with
   `npm view @agentclientprotocol/sdk version`. If either pair is
   no longer `v1.29.0` / `1.29.0` or `v1.2.1` / `1.2.1`, STOP: re-verify the MCP transport, lifecycle,
   completion, subscription, progress/cancellation, output-validator, client-handler, raw transport
   error/close behavior, reconnect configuration, Streamable HTTP DELETE termination, sampling
   `systemPrompt`/message metadata, exact-schema elicitation, and notification surfaces and the
   ACP form/URL elicitation request + completion-notification surfaces against the new release source;
   update the release tag, commit, npm pin, citations, and forward-risk note before building.
5. **Base-freshness (blocking):** fetch `origin/main`; if it has advanced since the base commit
   `78944e3462458de30c4989ff04894fecbf43632d` (§13) with any change that touches a `.ts`/`.mjs`/`.md`
   SOURCE surface this contract cites under `packages/pi-acp`, `packages/acp-agents`,
   `packages/workflows`, `packages/workflow-engine`, `packages/shared-types`, `packages/mcp-server`,
   `docs`, `skills`, the cited scripts, root `README.md`/`CONTRIBUTING.md`, or `.changeset/config.json`,
   STOP and re-verify the affected citations before building. A release-metadata-only advance (package
   `version` bumps + `CHANGELOG.md`, the Changesets "Version Packages" flow) is benign only for SOURCE
   citations. If it changes any §15 base version or target, that numeric claim has drifted: STOP,
   report it, update/re-review the release table, and only then build. Confirm a metadata-only diff;
   never assume it.

For each clone, diff the release tag against fetched upstream main, restricted first to every cited
surface and then name-only across the repo. Record any touching unreleased change before proceeding;
"npm latest did not move" does not waive this mainline-drift check. No code may be written until all
freshness claims still hold or the drift has been reported and the contract re-reviewed.

The freshness gate (pi-acp spec §10.1; `scripts/check-acp-deps.mjs`) enforces the same discipline
continuously after landing. This train adds NO new npm runtime dependency to `packages/pi-acp` — the MCP
TS SDK (`@modelcontextprotocol/sdk@1.29.0`) and ACP SDK (`@agentclientprotocol/sdk@1.2.1`) are already
direct dependencies and stay exact-pinned (no caret). Node built-ins used by the tracked child registry
do not change the dependency graph.

---

## 2. Problem, scope, and verified starting state

**Source trace:** owner quotes 1–5 and the recorded FULL-scope decision define the package, transport,
protocol, structured-output, and configuration outcomes. The error tripwire, hermetic transport matrix,
and child cleanup are derived correctness obligations from the verified issue findings; they make those
owner-visible outcomes durable rather than extending product scope.

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

1. **Full MCP client in pi-acp** (§3): stdio + Streamable HTTP + SSE transports; the whole stable base
   protocol at the pin (initialize/instructions/ping; tools incl. `tools/list_changed`; resources incl.
   subscribe/unsubscribe and both notifications; prompts; `completion/complete`; logging; pagination,
   progress, and cancellation as the SDK surfaces them); client features (sampling routed to pi's LLM,
   roots, form + URL elicitation routed through ACP). Truthful `mcpCapabilities` advertisement follows
   what is served.
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
  child running. The raw `Agent.abort()` call should propagate its run signal to the built-in bash tool,
  so merely replacing it with `AgentSession.abort()` does not explain or close the observed gap; §8
  adds adapter-owned, per-session process-group tracking rather than asserting the symptom away.
- **The runner's script-side reserved-`model`-configOptions guard is untouchable by this spec**:
  `assertNoModelConfigOption` (`runner.ts:1430-1440`) forbids `model` in an author's `configOptions`.
  That is a script-authoring rule, unrelated to capability advertisement; §5 changes advertisement, not
  this guard.

---

## 3. Deliverable 1 — Full MCP client in pi-acp

**Source trace:** owner quote 2 restores the MCP requirement; quote 3 requires every supported
server transport and the whole MCP base protocol; the recorded owner decision explicitly includes
sampling, roots, and elicitation. The pi extension, model-runtime, and ACP-client mappings below are
derived implementation decisions that serve that scope without adding a second protocol.

pi ships no native MCP; the adapter is the MCP client for every server ACP's `mcpServers` union can
deliver (except `acp`, which stays client-hosted — §12.6 non-goal). The MCP TS SDK
(`@modelcontextprotocol/sdk@1.29.0`) already implements the whole client surface; the work is wiring it
into pi's seams. `packages/pi-acp/src/mcp-bridge.ts` grows from a stdio-only slice into a full MCP client
module; sampling uses the already-injected `deps.modelRuntime` and adds no parallel completion
dependency. Every feature is default-on when the
server advertises its corresponding capability. The adapter imposes no server-count, tool-count,
page-count, response-size, or token cap; protocol schemas and provider context limits still apply.

### 3.1 Transports (stdio + Streamable HTTP + SSE)

`bridgeMcpServers` (`mcp-bridge.ts:205`) dispatches per `McpServer` transport instead of hard-rejecting
typed servers (`mcp-bridge.ts:214-216` removed):

| ACP transport (`McpServerConfig`) | MCP SDK transport | construction |
|---|---|---|
| stdio (`{ command, args, env }`) | `StdioClientTransport` (`src/client/stdio.ts:88-130`) | as today (`mcp-bridge.ts:66-70`) |
| `{ type:"http", url, headers }` | `StreamableHTTPClientTransport` (`src/client/streamableHttp.ts:120-155`) | `new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: fold(headers) }, fetch: observedFetch, reconnectionOptions: NO_RECONNECT })` |
| `{ type:"sse", url, headers }` | `SSEClientTransport` (`src/client/sse.ts:57-88`) | `new SSEClientTransport(new URL(url), { requestInit: { headers: fold(headers) }, fetch: guardedSseFetch })` |
| `{ type:"acp", … }` | not served by pi-acp | rejected `unsupported_mcp_transport` (client-hosted; §12.6) |

Every constructed SDK transport is immediately wrapped in one adapter-owned
`CloseSignallingTransport`. The wrapper delegates `start`, `send`, `sessionId`, and
`setProtocolVersion` without transformation and forwards `onmessage`. It owns the raw `onclose` and
`onerror` callbacks and exposes one `signalClose()` once-gate. A raw `onclose` calls that gate. The
wrapper's `close()` calls it synchronously, then, for Streamable HTTP, runs the bounded DELETE policy
below, and finally calls the raw transport's `close()` even when DELETE failed or timed out. With no
pre-close step (stdio/SSE), raw `close()` is invoked in that same synchronous call stack. Pass the
wrapper to `Client.connect` and retain the raw transport only behind this owner; no other code calls raw
`close()` or `terminateSession()`.

The logical-close step is required by the SDK's own `Transport` contract, which says `onclose` is
invoked when `close()` is called (`src/shared/transport.ts:74-127`), and by the protocol layer: only its
installed `onclose` callback aborts incoming request handlers, clears the transport, and rejects pending
requests, while `Client.close()` merely delegates to the installed transport
(`src/shared/protocol.ts:607-674,942-944`). At the pin, HTTP/SSE invoke `onclose` only from explicit
`close()` (`src/client/streamableHttp.ts:442-449`; `src/client/sse.ts:237-241`); stdio additionally
invokes it for a natural child close (`src/client/stdio.ts:141-144`) and can return from explicit close
after `SIGKILL` without awaiting that event (`src/client/stdio.ts:204-243`). The wrapper therefore makes
adapter-initiated disposal transport-independent without falsely claiming that `Client.onclose`
reports a natural HTTP/SSE failure.

**Transport-specific fatal observation and reconnect suppression (pinned).** Raw errors are classified
inside the wrapper before any optional forwarding to the SDK protocol layer; protocol-layer
`Client.onerror` events remain a separate nonfatal diagnostic class (§3.5).

- **stdio:** raw process `close` is fatal in `opening|open`. Raw pipe/parser `onerror` remains nonfatal
  unless followed by process close; it is forwarded to `Client.onerror`.
- **Streamable HTTP:** `NO_RECONNECT` is exactly
  `{ initialReconnectionDelay:0, maxReconnectionDelay:0, reconnectionDelayGrowFactor:1,
  maxRetries:0 }`. The pinned transport otherwise defaults to two reconnects and calls only `onerror`
  after retry exhaustion (`streamableHttp.ts:6-12,49-75,271-299`). With zero retries, GET SSE normal
  EOF and stream error both reach raw `onerror` without scheduling a fetch
  (`streamableHttp.ts:301-409`); every raw HTTP `onerror` in `opening|open` is fatal. `observedFetch`
  additionally rejects a successful `text/event-stream` GET with a missing body as fatal before it is
  returned. The initialized notification starts that optional GET stream
  (`streamableHttp.ts:558-566`). A 405 response means the server deliberately provides no ambient GET
  stream (`streamableHttp.ts:226-240`): this is **request-driven idle mode**, not a failure. Passage of
  time alone never declares such an idle connection dead because the transport exposes no liveness
  channel; its next outgoing request is the probe, and a raw transport error or the operation timeout
  disables the server. A POST SSE response that closes before returning its JSON-RPC result is covered
  by the same operation-timeout rule. Thus a GET-capable idle peer is detected at stream EOF/error,
  while a 405 idle peer is detected at its first failed/timed-out operation; no polling or invented
  keepalive is claimed.
- **legacy SSE:** every raw `SSEClientTransport.onerror` in `opening|open` is fatal. That callback is
  the pinned transport's only natural EventSource termination/failure signal
  (`sse.ts:136-169`); parse and endpoint errors use it too (`sse.ts:175-205`). The fatal handler calls
  `wrapper.close()` synchronously before returning. `SSEClientTransport.close()` synchronously closes
  its EventSource before its first promise yield (`sse.ts:237-241`). In addition,
  `guardedSseFetch` checks the wrapper state before delegating and rejects without an underlying network
  call after the fatal transition; the pinned transport routes that fetch into both EventSource GET and
  recurring POST (`sse.ts:136-147,243-259`). Thus even a transitive EventSource retry cannot reconnect.
  Treating a malformed legacy event as fatal is
  intentionally conservative: the client cannot distinguish a recoverable stream exception from the
  same `onerror` event used for connection loss.

All fatal paths first claim the per-server once-only state transition in §3.5 and synchronously call
`signalClose()`; a simultaneous outgoing completion can therefore never publish after peer close.
Errors caused after state becomes `closing|closed|disabled` are disposal noise and are suppressed.
There is no adapter reconnect and neither SDK transport may issue one.

**Streamable HTTP session termination.** Intentional session disposal, failed-open rollback after a
session id was learned, and a fatal Streamable HTTP disable make a best-effort explicit session
termination attempt because `Client.close()` itself sends no DELETE. After state changes to
`closing`/`disabled` and `signalClose()` has rejected protocol work, the wrapper calls the retained raw
`terminateSession()` under one `deps.mcpTimeoutMs` bound, then calls raw `close()` in `finally` under
the ordinary close bound. `terminateSession()` is a no-op without a session id, sends DELETE with the
session header when present, treats HTTP 405 as a supported refusal, clears the id after success/405,
and reports other statuses/errors (`streamableHttp.ts:612-652`). Success and 405 are silent. Error or
timeout emits only `[mcp:<server>] session termination failed` to stderr, never masks the original
open/close/disable outcome, and never skips physical close. All servers' wrapper closes are started
without awaiting between starts; DELETE-before-close is ordered only within one server.

`fold(headers)` creates a WHATWG `Headers` object and calls `append(name, value)` in input order. WHATWG
combines repeated names into one field value while retaining each value in order; that is the exact wire
semantic promised (the SDK itself normalizes headers to a record in `src/shared/transport.ts:9-20`). The
configured `requestInit.headers` reach both GET and POST on both HTTP transports through `_commonHeaders`
(`streamableHttp.ts:182-224,466-475`; `sse.ts:116-147,243-259`). POST spreads the rest of
`requestInit`; GET does not: Streamable HTTP builds a new GET init, while legacy SSE GET spreads
`eventSourceInit`. The adapter supplies only `requestInit.headers`, so it relies on exactly the common
behavior the pin implements. Call
`client.connect(transport, { timeout: deps.mcpTimeoutMs,
signal: anySignal([sessionSignal, openSignal]) })` so
the SDK bounds its initialize request (`src/client/index.ts:483-502`). Retain the existing outer
`bounded()` race around the entire connect: the pinned SDK starts the transport in
`super.connect(transport)` before it uses those request options, so the options do not bound a hung
transport start, and the outer race also observes a late detached rejection. Every other outgoing
request receives `deps.mcpTimeoutMs` (default 60,000 ms) as SDK `RequestOptions.timeout` and is also
bounded for detached-promise safety. Every outgoing request receives `sessionSignal`; opening operations
also combine the lifecycle transaction's `openSignal`, while `tools/call` and
every synthetic-tool request additionally combine the current turn signal. Incoming
sampling/elicitation handlers combine the SDK request signal, the
session-lifetime signal, the active turn signal when one exists, and the same timeout around their
pi/ACP work; a request outside a turn therefore remains cancellable on session disposal. A
failed/timed-out connect closes the transport it opened, extending
the existing stdio orphan-child guarantee to `transport.close()` for every transport. The
`connectMcpClient` DI factory remains available for unit fault injection, but §7 separately exercises
the real SDK transports.

**Outgoing-operation terminal arbiter (exact).** Connect/initialize, initial and refresh lists, remote
calls, and every synthetic request use one `settleOnce` wrapper around the SDK request plus outer bound;
both promises receive rejection observers before the race. Immediately before committing an outcome,
already-observable conditions have this precedence: (1) lifecycle request/turn abort, (2) session
disposal, (3) per-server fatal/peer close, (4) `deps.mcpTimeoutMs` expiry, (5) operation completion or
rejection. Otherwise the first callback to claim `settleOnce` wins. This ordering preserves the frozen
open-request cancellation contract: `$/cancel_request` during new/load/resume/fork rolls back and
propagates the SDK abort so ACP emits `-32800`, even at the timeout boundary. Close/dispose of an
opening transaction produces `internal_error -32603` for that opening request (the racing
`session/close` itself still succeeds); it is a global gate abort, never a fabricated
`mcp_init_error`. If child cleanup then fails, §3.5's stronger error overrides either outcome.
An ordinary open-time timeout or transport/protocol failure that wins becomes the server-attributable
`mcp_init_error`; a peer fatal observed first is the same open error. During a turn, request/turn abort
produces no tool failure after the turn settles; session disposal/peer close produces the ordinary fixed
`MCP tool <alias> failed` only if the turn is still live; timeout produces `MCP tool <alias> timed out`.
For Streamable HTTP request-driven idle mode, that timeout also claims the server fatal-disable task.
A refresh cancelled by close/disposal exits silently. A refresh rejected because the peer-disable task
won is suppressed by that task and emits **no** second `tools/list refresh failed` diagnostic; a timeout
or other refresh failure while the server remains open retains the fixed refresh-failed diagnostic.
Late resolve/reject/progress callbacks are consumed and cannot emit a second result, diagnostic, update,
or unhandled rejection.

**Truthful advertisement (derived from owner quote 3).** `initialize` advertises
`mcpCapabilities: { http: true, sse: true }` instead of `{}` (`agent.ts:81`). stdio stays the implicit
baseline (the runner treats it as always serviceable, `capabilities.ts:284-300`); `acp` is NOT
advertised (not served). This flips the client gate from "reject http/sse" to "allow http/sse," so
workflow authors can attach HTTP/SSE MCP servers to pi agents and the runner can inject its HTTP
`StructuredOutput` tool (§4). The `McpCapabilities` SDK type carries `http`/`sse` booleans
(`src/schema/types.gen.ts:1711-1732`).

### 3.2 Whole base protocol (server features consumed)

The client consumes every stable base-protocol server surface in MCP SDK 1.29.0. The SDK's initialize
exchange records server capabilities, name/version, optional title, and optional `instructions`; each
client is constructed with `enforceStrictCapabilities: true`. This is defense in depth for the checks
the SDK implements (`src/client/index.ts:540-608`; `src/shared/protocol.ts:60-71,1112-1119`), not the
authoritative feature gate: at this pin `assertCapabilityForMethod` checks `resources.subscribe` for
`resources/subscribe` but not `resources/unsubscribe` (`src/client/index.ts:573-586`). Adapter-level
capability conditioning therefore remains authoritative for every feature and sub-capability, including
registering **both** subscription tools only when `serverCapabilities.resources.subscribe === true`. After
connect, the adapter sends one `ping` and fails session open as `mcp_init_error` if it fails. The client
identity is exactly `{ name: "@automatalabs/pi-acp", version: PKG_VERSION }`, not the current placeholder
`0.0.0`. Move the existing manifest-backed `PKG_VERSION` export (`agent.ts:30-32`) into a new internal
`packages/pi-acp/src/version.ts`; both `agent.ts` and `mcp-bridge.ts` import it. This avoids a circular
bridge→agent import (agent already imports the bridge) and forbids a second version constant or manifest
reader. Incoming
server `ping` is answered automatically by the SDK protocol layer (`src/shared/protocol.ts:366-379`).
Server `instructions`, when non-empty, are appended in server input order to the pi system prompt on
every turn as `\n\n# MCP server instructions (<sanitized-server>)\n<instructions>` using
`before_agent_start`; they are not written into message history
(`extensions/types.ts:685-695,1081-1084`).
Synthetic feature tools and outbound feature requests are installed/sent only when initialize's
server-capability block advertises that feature/sub-capability; stable lifecycle ping is unconditional.
All adapter notification handlers are registered **before** `connect`, then capability-check at dispatch
after initialize. This closes the pinned SDK convenience path's gap (it sends `notifications/initialized`
before installing its configured list-changed handlers, `src/client/index.ts:483-529`). A notification
that arrives before initialize completes or that the server did not advertise is ignored with the fixed
redacted diagnostic `[mcp:<server>] unexpected <method>` using the same active-turn ACP/stderr routing
defined below; it never triggers a feature request.

| MCP server feature | SDK surface | pi/ACP wiring |
|---|---|---|
| **tools** | `tools/list`, `tools/call`, `notifications/tools/list_changed` (`listTools`, `callTool`) | Remote tools become pi extension tools (§3.3). Every list page is consumed. Results preserve all content and `structuredContent`; `isError` produces a failed pi tool result, not an adapter crash. |
| **resources** | `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`; `notifications/resources/list_changed`, `notifications/resources/updated` | Five synthetic tools: `list_resources`, `list_resource_templates`, `read_resource`, `subscribe_resource`, `unsubscribe_resource`. Subscribe tools are registered only when the server advertises `resources.subscribe`; the two notifications become observable diagnostics and the next list/read fetches live state. Nothing is cached across calls. Subscriptions follow the connection-lifetime contract below. |
| **prompts** | `prompts/list`, `prompts/get`, `notifications/prompts/list_changed` | Synthetic `list_prompts` and `get_prompt` tools; messages, embedded resources, and annotations are projected through the same total MCP-content projection as tool results. List-changed becomes a diagnostic; the next list fetch is live. |
| **completion** | `complete` | Synthetic `complete` tool accepting the exact MCP `ref` union (prompt reference or resource-template reference), `argument`, and optional `context`; its result returns every `values` entry plus `total` and `hasMore` without adapter truncation. |
| **logging** | `logging/setLevel`, `notifications/message` (`setLoggingLevel`) | If and only if the server advertises logging, set level `info`. During an active turn, each message becomes an ACP `agent_thought_chunk` prefixed `[mcp:<server>] <level>: `. Outside a turn it is written to stderr with that prefix because an unbound `session/update` is invalid. Data is JSON-stringified when it is not a string. |
| **pagination** | `nextCursor` on list operations | Consume all pages for tools, resources, resource templates, and prompts in server order. Any repeated defined cursor is a protocol failure; there is no adapter page or item cap. |
| **progress** | `RequestOptions.onprogress`; incoming `RequestHandlerExtra._meta`/`sendNotification` | Every remote and synthetic tool passes its pi `onUpdate` callback to each underlying MCP request (including each list page). Each progress notification emits a pi tool update with `details = full progress params` and text formed as `[mcp:<server>] <progress>`, plus `/<total>` iff total exists, plus ` <message>` iff message exists. Amend the pi→ACP translator's `tool_execution_update` row to copy non-undefined partial `details` into `tool_call_update.rawOutput`, just as its end row already does (`translate.ts:95-110`); no progress field is lost. Incoming client-feature progress follows §3.4. |
| **cancellation/timeouts** | `RequestOptions.signal`, `timeout`, cancellation notification | The session signal, plus the turn signal when one exists, and timeout are passed to every outgoing MCP request; incoming handlers additionally combine the SDK request signal. The SDK emits `notifications/cancelled` for an aborted outgoing request and honors incoming cancellation (`src/shared/protocol.ts:1126-1218`). Cancellation is never converted into an ordinary tool error after the ACP turn has settled. |
| **URL elicitation completion** | `notifications/elicitation/complete` | The originating MCP server notifies pi-acp that its out-of-band URL interaction completed; pi-acp translates that server→client notification into ACP agent→client `unstable_completeElicitation` with the corresponding opaque ACP id (§3.4). |

`<server>` in diagnostic prefixes throughout means the same sanitized server token, never raw
untrusted name text. All non-logging notifications use one diagnostic projection: during an active turn,
emit ACP `agent_thought_chunk` text `[mcp:<server>] <method>` (append ` uri=<uri>` for
`notifications/resources/updated`); outside a turn write that exact text to stderr. A post-dispose
notification is ignored. Logging uses its richer fixed prefix from the table; if non-string `data`
serializes to `undefined`, use `String(data)`, otherwise use unindented `JSON.stringify(data)`.

**Diagnostic ordering and delivery (pinned).** Logging, list/update, unexpected-notification,
elicitation-completion, transport-error/disable, progress-send-failure, and refresh-failure diagnostics all call one `PiSession.emitMcpDiagnostic`
function; there is no second MCP notification queue. A turn owns a synchronous diagnostic-admission
gate. While that gate is open, `emitMcpDiagnostic` synchronously enqueues the
`agent_thought_chunk` into the existing FIFO notification pump (`session.ts:121-155`). The settlement
path closes the gate synchronously, then drains the pump, then resolves/rejects the ACP prompt. Thus
every accepted diagnostic orders with ordinary pi updates and `usage_update` and is delivered before
the prompt response; a diagnostic dispatched after the gate closes is written to stderr and can never
leak into the next turn. A pump send rejection has the existing exact behavior: it aborts the active
turn and rejects that ACP prompt as `notification_error` `-32603` (`session.ts:127-148,195-201`). If
that abort also wins an incoming sampling/elicitation operation, §3.4's turn-abort row determines its
MCP outcome. Outside a turn, stderr is the terminal sink and has no ACP delivery failure. A
post-dispose notification or diagnostic is suppressed. This contract applies equally when a refresh
began during a turn but failed after settlement: dispatch-time gate state, not start time, selects the
route.

Synthetic aliases are `mcp__<sanitized-server>__<operation>` and use the same deterministic collision
allocator as remote tools. Reserve them before any remote alias, in server configuration order and,
within each server, this fixed capability-conditioned operation order:
`list_resources`, `list_resource_templates`, `read_resource`, `subscribe_resource`,
`unsubscribe_resource`, `list_prompts`, `get_prompt`, `complete`. An operation the server did not
advertise consumes no reservation. Their TypeBox argument schemas expose the exact model-supplied semantic fields
and bounds without inventing narrower limits. The adapter, not the model, owns pagination cursors (every
list tool consumes and returns all pages) and request `_meta` (the SDK supplies the progress token from
`RequestOptions.onprogress`, `src/shared/protocol.ts:1135-1143`; related-task metadata is absent because
tasks are unadvertised, `src/types.ts:60-94`), so neither
protocol-control field appears in a synthetic tool schema. The resource/template/prompt list tools take
`{}`; read/subscribe/unsubscribe take `{ uri: string }`; `get_prompt` takes
`{ name: string, arguments?: Record<string,string> }`; `complete` takes
`{ ref: {type:"ref/prompt",name:string}|{type:"ref/resource",uri:string},
argument:{name:string,value:string}, context?:{arguments?:Record<string,string>} }`.

**Canonical result projection (exact).** This projection accepts a validated MCP `ContentBlock` and is
used by remote tool results and prompt message content. It returns pi
`(TextContent | ImageContent)[]` in source order:

- MCP `text` → `{ type:"text", text }`; MCP `image` → `{ type:"image", data, mimeType }`.
- MCP `audio` → text `` `[audio mime=${mimeType} bytes=${Buffer.from(data,"base64").byteLength}]` ``.
- MCP `resource_link` → text `` `[${title ?? name ?? uri}](${uri})` ``.
- MCP embedded/text resource → its `text`; embedded/blob resource → text
  `` `[embedded resource uri=${uri} mime=${mimeType ?? "application/octet-stream"} bytes=${Buffer.from(blob,"base64").byteLength}]` ``.
- A block type outside the validated pinned union fails the pi tool result with the fixed text
  `Unsupported MCP content block`; it is never silently omitted.

`resources/read` returns raw `TextResourceContents | BlobResourceContents`, not `ContentBlock`; for each
entry, `read_resource` applies the embedded-resource text/blob branch above directly and in source
order. The model-visible projection is intentionally narrower than MCP, while ACP `rawOutput` remains
lossless for the operation that actually ran: a remote call sets pi result `details` to the **exact
validated `CallToolResult` object**, with no wrapper and no duplicated Tool/list snapshot. A
non-paginated synthetic request likewise sets `details` to its exact SDK result. A paginated list sets
`details = { pages: <exact page results in order> }`; the pages retain every item, cursor, and page
`_meta`, while the model-visible text contains the flattened server-order array. The adapter retains the
exact current `Tool` and complete `tools/list` pages internally for registration, validation, aliasing,
refresh, and diagnostics, but does not retransmit those definitions on every unrelated call. Thus each
call result's explicit `isError:false`, `_meta`, binary bytes, and `structuredContent` remain available
to ACP/UI consumers without a bespoke per-call catalog envelope. The existing
failed-result side map plus `afterToolCall` override
is retained so MCP `isError:true` produces the same projected content/details as a **failed** pi tool
result instead of an adapter crash (`session.ts:92-109`).

Synthetic model-visible outputs are fixed: paginated list tools return one text block containing
unindented `JSON.stringify({ resources })`, `JSON.stringify({ resourceTemplates })`, or
`JSON.stringify({ prompts })` over the flattened server-order array; `read_resource` uses the canonical
projection over `contents`; `get_prompt` emits an optional first text block
`[mcp prompt description]\n<description>`, then for each message a text block
`[mcp prompt role=<role>]` followed by that message's canonical projection; `complete` returns one text
block containing `JSON.stringify(result.completion)`; subscribe/unsubscribe return exactly
`Subscribed to <uri>` / `Unsubscribed from <uri>`. A request timeout throws
`MCP tool <alias> timed out`; any other request/protocol failure throws `MCP tool <alias> failed` so pi
creates a redacted failed tool result. This is the concrete wiring for owner quote 3's “whole base
protocol.”

**Resource-subscription lifetime and reconnect truth (pinned).** A successful
`subscribe_resource` result records a fact about that one MCP connection; it is not a promise that a
future connection is subscribed. Every `session/new`, `session/load`, `session/resume`, and
`session/fork` creates fresh MCP clients and starts with **zero** subscriptions. The adapter does not
scan tool history, match servers by name/URL, issue automatic re-subscriptions, append a durable reset
message, or otherwise mutate replay/history: a historical success cannot prove that the same server
identity, authorization, URI, or user intent still exists. The current connection's synthetic
`subscribe_resource` description and success text are sufficient transient guidance. Re-subscription is
an explicit later tool call. This connection-scoped rule is standard MCP lifecycle behavior and adds no
product-visible persistence side effect to sessions with no server or no prior subscription.

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
   (`resource-loader.ts:122-139`), where `InlineExtension = ExtensionFactory | { name, factory }` and
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

1. Before session construction, the adapter connects the MCP clients and consumes every page of each
   server's advertised tools. That enumeration is the first configuration-ordered batch through the
   same session-wide refresh transaction queue used after open; a list-changed notification received
   during connect/initial enumeration marks one coalesced additional pass and never starts a concurrent list. Resources and prompts are fetched
   only when their synthetic tool is called; eager results would be discarded because §3.2 intentionally
   has no cache.
2. It reserves aliases for all synthetic tools first, then for remote tools in server input order and
   remote list order. A stable `(server identity, remote name) → alias` reservation survives removal so
   re-addition receives the same alias. Each remote definition uses `name = alias`,
   `label = remote.title ?? remote.annotations?.title ?? remote.name` (the pinned MCP display-title
   precedence, `src/types.ts:341-355`),
   `description = remote.description ?? "MCP tool " + remote.name`, and
   `parameters = remote.inputSchema`. The alias state also retains the exact validated `Tool` object
   and exact complete `tools/list` page results for registration, output validation, refresh, and
   diagnostics; they are replaced only by an atomic successful refresh and are not copied into each
   call's `rawOutput` (§3.2). A tool whose
   `execution.taskSupport` is `"required"` cannot be invoked over the stable `tools/call` path and is
   invalid because this client does not advertise experimental tasks: it fails initial open as
   `mcp_init_error`, while a dynamic refresh containing one retains the prior snapshot and emits the
   fixed refresh-failed diagnostic. `"optional"` and `"forbidden"` tools use ordinary `tools/call`.
   One SDK `AjvJsonSchemaValidator` per server is passed into that
   server's `Client` and is also used to compile an adapter-owned `(alias → output validator)` map from every
   page's `outputSchema`. This second map is required because SDK `listTools()` clears its internal
   validator cache on every invocation before caching that one result page
   (`src/client/index.ts:729-783,802-842`); without it, tools from all but the final page would evade
   output-schema validation. After `callTool`, the adapter enforces the SDK's exact rules for every
   alias: a tool with an output schema must return `structuredContent` unless `isError` is true, and any
   present `structuredContent` must validate. A violation becomes the fixed redacted failed tool result
   `` `MCP tool ${alias} failed` ``. The validator provider is a public existing export
   (`package.json:42-46`; `src/validation/ajv-provider.ts:36-97`), so no dependency is added. It builds one
   named inline extension, `<inline:agentprism-pi-acp-mcp>`, whose factory registers **only** every
   synthetic/remote reserved `mcp__…` tool and captures the `ExtensionAPI`, per-server handles, and
   mutable valid-alias map. A second named inline extension,
   `<inline:agentprism-pi-acp-control>`, registers only the tracked core-`bash` fallback (§8) and the
   `before_agent_start` MCP-instructions hook (§3.2). Splitting the extensions prevents reserved-tool
   precedence from changing unrelated hook, flag, renderer, or supported user-`bash` behavior.
3. It constructs `DefaultResourceLoader` with both factories in `extensionFactories` and a public
   `extensionsOverride(base)` callback. Pi normally appends inline factories after configured
   extensions (`resource-loader.ts:517-527`). The callback MUST find exactly one extension for each
   path, remove only `<inline:agentprism-pi-acp-mcp>` from its normal position, and return
   `{ ...base, extensions: [reservedMcpExtension,
   ...base.extensions.filter(e => e !== reservedMcpExtension)] }`: the reserved MCP extension is first;
   **every other extension, including the control extension, retains its original relative order**;
   `runtime` and `errors` retain identity. Missing/duplicate inline-extension matches or changed
   runtime/errors identity are session-global loader failures and fail open as
   `extension_setup_error -32603` (§9), with no fabricated server field.
   Pi's `getAllRegisteredTools()` is first-registration-per-name
   (`extensions/runner.ts:421-432`), so only the reserved `mcp__…` namespace gains adapter precedence.
   Configured extensions continue to run their ordered `before_agent_start` handlers before the
   normally-appended control hook (`extensions/runner.ts:1040-1088`), and a configured extension named
   `bash` continues to beat the control fallback (Pi documents built-in overrides as supported in
   `examples/extensions/built-in-tool-renderer.ts:1-16`). If no configured extension defines `bash`, the
   control definition replaces Pi's built-in and supplies §8 tracking. The loader invokes the supported
   override after loading inline factories (`resource-loader.ts:404-414,517-527`).
4. The adapter awaits `resourceLoader.reload()` and passes that loader to
   `deps.createAgentSession({ resourceLoader, … })` instead of `customTools`. Construction uses one
   public `SettingsManager.create(cwd, agentDir)` instance, with `agentDir = getAgentDir()`, and passes
   that exact instance both to `new DefaultResourceLoader({ settingsManager, … })` and
   `deps.createAgentSession({ resourceLoader, settingsManager, … })` (`sdk.ts:71,76`). The inline
   control factory reads its shell path/command prefix after loader reload for §8. After construction it
   MUST verify `session.getAllTools()` reports
   `sourceInfo.path === "<inline:agentprism-pi-acp-mcp>"` for every live MCP alias; an alias mismatch is
   server-attributable `mcp_init_error` naming the configured server that owns it. For `bash`, either
   (a) no configured extension registered it and the winner MUST have
   `sourceInfo.path === "<inline:agentprism-pi-acp-control>"`, or (b) a configured extension registered
   it and that configured source MUST remain the winner; case (b) is intentionally outside adapter
   child tracking under Non-goal 12.11. A missing/wrong `bash` or control-extension winner is the global
   `extension_setup_error` and triggers §3.5 rollback.
5. The session owns **one session-wide serialized refresh transaction queue**, one
   refresh-lifetime controller, and an `open | closing | closed | poisoned` refresh state. Per-server
   dirty bits coalesce repeated notifications into one additional pass, but no two servers ever prepare
   candidates concurrently. At each scheduler turn, snapshot all dirty servers and process that batch in
   server configuration order; notifications accepted after the snapshot form the next batch. Each pass
   acquires the global refresh-transaction lease, snapshots the latest committed session-global alias
   reservations/valid map/active names, fetches and validates all pages outside the turn mutex, then
   commits before releasing the lease. Therefore a later server always prepares from the latest
   committed global state; no candidate can overwrite another server's aliases or active-name deltas.
   Within a coalesced batch, the earlier configured server receives the unsuffixed alias and later
   colliders receive `_2`, `_3`, …; across batches, existing reservations win and only new aliases gain
   suffixes. A session-wide turn-boundary mutex serializes each refresh **commit** against prompt execution.
   `PiSession.prompt` synchronously changes a separate prompt-admission state from `idle` to `reserved`
   before its first `await` and before waiting for this mutex; a second prompt, config set, or fork
   therefore rejects `session_busy` immediately rather than queueing. The reservation remains busy
   through preflight, pi execution, pump drain, and settlement. A close racing a reserved prompt aborts
   that reservation; after it obtains the mutex it resolves the never-started prompt as `cancelled` with
   all-zero per-turn `PromptResponse.usage`, emits the inherited current-session `usage_update`, drains
   it, and starts no pi run. A completed all-page refresh holds the mutex only while applying
   registrations and the final active-name set. Thus a notification during a turn queues its commit until
   that turn settles, and a new prompt cannot start between individual registrations. A pass consumes and
   validates every page before taking that mutex or changing live state. While holding the global
   refresh lease, it builds candidate reservations and that server's Tool/page/validator/valid/active
   deltas on copies of the latest committed global snapshots; no live alias suffix is consumed before
   commit and the commit merges only that server's deltas. Duplicate remote tool names are malformed:
   initial duplicate names, task-required tools, or output-schema compilation failure fail open as
   `mcp_init_error`; a dynamic duplicate, task-required tool, schema-compilation, cursor/protocol, or
   request failure keeps the last complete tool set and emits fixed diagnostic
   `[mcp:<server>] tools/list refresh failed` through §3.2's
   active-turn ACP/stderr route, and a subsequent
   notification may retry. On a pre-commit failure the candidate copies are discarded in full, so a
   later valid notification receives the same alias it would have received had the bad candidate never
   existed. On a validated `tools/list_changed` pass, the adapter handles each alias:
   - **new alias** (never registered) → `pi.registerTool({ name: alias, … })` (add + refresh; active next turn);
   - **still present, changed or unchanged** → `pi.registerTool({ name: alias, … })` again in remote list
     order. This deterministically refreshes label/description/schema without inventing an object
     canonicalization rule; re-registration on the same extension overwrites
     `extension.tools.set(name)` (`loader.ts:239`); the same atomic commit replaces that alias's exact
     `Tool`, complete list-page results, and adapter-owned compiled output validator (or deletes it when
     `outputSchema` is absent);
   - **removed** → mark the alias invalid and call the public
     `session.setActiveToolsByName(currentActiveNames minus removedAliases)`. This deactivates it for the
     next turn even though pi exposes no public unregister operation;
   - **re-added** → replace the tombstone with a live definition and explicitly add the alias back to
     the active-name set for the next turn.
   After all registrations, apply removals/re-additions with one `setActiveToolsByName` call so the next
   turn sees one complete snapshot **only when every call succeeds**.

   Pi exposes no atomic batch or public unregister: every `registerTool()` first mutates the extension
   map and then immediately rebuilds Pi's registries (`loader.ts:237-244`;
   `agent-session.ts:2430-2521`). Therefore an apply-time throw after the first registration cannot be
   guaranteed rollback-safe. The decisive failure-atomic rule is **poison and tombstone**, not a false
   rollback claim. If any `registerTool`, its synchronous `refreshTools`, or the final
   `setActiveToolsByName` throws, or the runtime unexpectedly becomes stale after the synchronous apply
   block has begun mutating Pi:
   - do not publish any candidate adapter-owned Tool/page/validator/valid-alias/active snapshot or alias
     reservations;
   - synchronously set refresh state `poisoned`, reject new prompts/config/forks with
     `session_terminated`, suppress/coalesce no further notifications, abort every in-flight refresh,
     and clear every not-yet-started pass;
   - emit exactly `[mcp:<server>] tools/list refresh commit failed; session terminated` through §3.2's
     ordered diagnostic route, release the turn-boundary mutex, then invoke the agent-owned termination
     callback that removes the live entry, records the session tombstone, and runs §3.5/§8 disposal;
   - never expose the partially mutated Pi instance to another turn. A future `session/close` is an
     idempotent tombstone close except when §8 retains children for retry.

   Poisoning is session-wide because Pi state may already contain an arbitrary prefix of the candidate;
   attempting to re-register the prior definitions would itself be another non-atomic operation and
   cannot remove newly registered aliases. This is the only observable apply-failure outcome.
6. Each registered pi tool's `execute` dispatches through the handle in the **current turn's committed
   snapshot**. Because refresh commits cannot run during a reserved/active turn, that snapshot remains
   stable from prompt admission through every selected tool execution. After a boundary commit, a
   direct/stale invocation whose alias is now invalid returns a **failed tool result** with the fixed message
   `` `MCP tool ${alias} is no longer available` `` (redaction parity with pi-acp spec §9.3.3), so the
   model sees a clean failure — never a crash or a stale call.

**Exact behavior, pinned (the "documented behavior" the investigation must record):**
- **Timing:** a `tools/list_changed` takes effect on the **next** pi turn, not the current in-flight
  turn — `setActiveToolsByName` documents "Changes take effect on the next agent turn"
  (`agent-session.ts:912-913`). This matches pi's own tool model and is the contract.
- **Additions and schema/description changes:** fully dynamic via `registerTool` + `refreshTools`.
- **Removals:** pi's public `ExtensionAPI` has **no `unregisterTool`** (`extensions/types.ts:1210-1245`).
  The registry retains an inactive tombstone, while `setActiveToolsByName` removes the alias from the
  model-visible active set on the next turn. A tool selected by the already-running turn uses the old
  handle: it may succeed if the server still honors it, or receive the ordinary fixed
  `` `MCP tool ${alias} failed` `` if the peer rejects it; it never sees the post-boundary
  `no longer available` tombstone mid-turn. A later direct invocation after commit receives that
  tombstone. Re-addition replaces and reactivates the same alias. This turn-snapshot rule is realizable
  at Pi's boundary and the inactive tombstone is the only consequence of the missing unregister API.
- **Runtime staleness and close ordering:** `registerTool` calls `runtime.assertActive()` (`loader.ts:238`).
  `session/load`/`resume`/`fork` each build a **fresh** session with a fresh inline extension + loader, so
  no captured `pi` is reused across sessions. Close does not merely assume a queued commit disappeared:
  it synchronously changes refresh state `open → closing`, aborts every fetch, clears coalesced passes,
  and awaits every refresh queue/commit task after acquiring/releasing the turn mutex; only then may it
  call `AgentSession.dispose()`, whose extension invalidation makes the captured API stale
  (`agent-session.ts:825-840`). A queue that observes `closing` before its first mutation exits without a
  diagnostic; an apply already in its synchronous mutation block either completes before close can run
  or throws and follows the poison rule. After drain, state becomes `closed` and no refresh task retains
  Pi. This explicit invalidate → abort → drain → dispose order applies to ordinary close, tombstone,
  failed open, and process shutdown.

**Collision/reserved-namespace note (amends pi-acp spec §9.3.2).** MCP tools now register as pi
**inline-extension** tools (`sourceInfo.path = "<inline:agentprism-pi-acp-mcp>"`) rather than
`customTools` (`sourceInfo.source = "sdk"`). `_refreshToolRegistry` composes `Map(builtins)` and then
overlays the first registered extension definition per name (`agent-session.ts:2438-2463`). Moving only
the reserved MCP extension first makes `mcp__…` aliases take precedence over an identically named user
extension tool without reordering user hooks/flags/renderers. The normally-ordered control extension
replaces built-in `bash` only when a configured extension did not already exercise Pi's supported
`bash` override. The source-qualified post-construction checks above prove which definitions won rather
than only proving names exist (`agent-session.ts:894-905`).

### 3.4 Client features (owner scope: sampling, roots, elicitation)

The adapter declares client capabilities on each MCP client via
`new Client({ name, version }, { enforceStrictCapabilities: true,
capabilities: { sampling: {}, roots: { listChanged: false },
elicitation: { form: {}, url: {} } }, jsonSchemaValidator: serverValidator })` and registers the
corresponding handlers. It deliberately does
not advertise optional `sampling.context` or `sampling.tools` sub-capabilities because pi's
provider-neutral completion seam cannot honor their semantics.

All three incoming request handlers (sampling, roots, elicitation) implement the base progress seam.
When `extra._meta?.progressToken` exists, the handler sends related
`notifications/progress { progressToken, progress:0, total:1 }` immediately before its work and
`{ progressToken, progress:1, total:1 }` immediately before an ordinary completed response, using the SDK's
request-related `extra.sendNotification` (`src/shared/protocol.ts:237-280,734-746`; progress schema
`src/types.ts:641-673`). “Sends” here pins invocation order without making optional telemetry a request
barrier: call `extra.sendNotification`, attach a rejection observer immediately, and do not await it.
At the pinned SDK that invocation synchronously reaches `transport.send` before its returned promise
yields (`src/shared/protocol.ts:734-746,1303-1410`), so `0` is invoked before work and `1` before the
handler returns, while a hung notification promise cannot defeat the request timeout or leak an
unhandled rejection. It sends no terminal `1` after an error or cancellation. Pi's provider-neutral
completion is non-streaming, so inventing token-level intermediate units would be false; deterministic
request-lifecycle units are the exact progress contract. A progress-send rejection emits the fixed
diagnostic `[mcp:<server>] progress notification failed` through §3.2's active-turn ACP/stderr route and
does not replace the feature result or error. Without a token, no progress notification is sent.

**Incoming request arbiter (sampling and elicitation, exact).** Each handler owns one `settleOnce`
arbiter and attaches rejection observers to the underlying pi/ACP promise before racing it, so an
abort-ignoring late resolve/reject is consumed without another response, terminal progress, diagnostic,
or unhandled rejection. Immediately before committing any outcome, already-observable conditions have
this precedence: (1) MCP peer/transport cancellation (`extra.signal`), (2) session disposal, (3) active
turn abort, (4) `deps.mcpTimeoutMs` expiry, (5) operation completion. Otherwise the first callback to
claim `settleOnce` wins. The timeout clock starts immediately before the initial progress `0` send; a
progress-send failure does not reset it. Outcomes are pinned:

| winning event | sampling outcome | elicitation outcome | terminal progress |
|---|---|---|---|
| ordinary operation completion | mapped `CreateMessageResult`, or existing fixed semantic error | exact validated ACP action/content, or the existing unsupported-client `decline` | `1/1` immediately before any ordinary result, including a user-selected `decline`/`cancel`; none before an error |
| MCP peer sends `notifications/cancelled`, or transport close aborts `extra.signal` | **no MCP response** | **no MCP response** | none; the pinned SDK suppresses handler success/error once its request controller is aborted (`src/shared/protocol.ts:550-557,728-853`) |
| session disposal, inside or outside a turn | **no MCP response** | **no MCP response** | none; disposal marks the binding and starts `Client.close()`; the §3.1 close-signalling wrapper synchronously fires the protocol layer's `onclose`, which aborts `extra.signal` and suppresses handler success/error before physical transport close is awaited (`src/shared/protocol.ts:607-618,644-660`) |
| active ACP turn abort (`$/cancel_request`, `session/cancel`, or notification failure) while the MCP connection remains open | MCP error `-32603`, exact message `MCP sampling cancelled` | MCP result `{ action:"cancel" }` | none |
| `deps.mcpTimeoutMs` expires | MCP error `-32603`, exact message `MCP sampling timed out` | MCP result `{ action:"cancel" }` | none |

Roots is synchronous after binding: peer/transport cancellation observed before commit yields no response;
otherwise it returns the root result below and, with a token, the ordinary `0/1` pair. A turn abort is
not attached to roots because listing the already-bound cwd invokes no pi/ACP work. Session disposal
still uses the no-response row. System-generated elicitation `cancel` from turn abort/timeout is
deliberately distinguishable only by the absent terminal `1`; no private metadata is added.

1. **Sampling** — `sampling/createMessage` (`CreateMessageRequestSchema`→`CreateMessageResultSchema`).
   The stable request content union is **fully accepted**: user and assistant `text`, `image`, and
   `audio`, in either the single-block or array form, retain their role, block order, exact MIME string,
   and exact base64 bytes (`src/types.ts:1708-1737`). Tool-use/tool-result blocks remain conditioned on
   the unadvertised optional `sampling.tools` sub-capability, not on base sampling media.

   Pi's public `Context` directly represents user text/image and assistant text, but not assistant image
   or either-role audio (`packages/ai/src/types.ts:343-419`). The adapter therefore adds
   `packages/pi-acp/src/mcp-sampling-payload.ts`, a provider-payload bridge over Pi's public
   `StreamOptions.onPayload` seam (`packages/ai/src/types.ts:113-143`) rather than stringifying or
   rejecting those stable blocks. For every sampling request it:

   1. allocates an ASCII request token absent from every input text block and creates one ordered marker
      per image/audio block;
   2. builds a role-faithful Pi `Context` with each media position occupied by its unique marker; user
      messages use timestamp `0`, while prior assistant messages use
      `api/provider/model = activeModel`, `stopReason = "stop"`, timestamp `0`, and zero usage/cost as
      required by Pi's `AssistantMessage` type;
   3. passes an `onPayload` callback to `modelRuntime.completeSimple` that recognizes the active
      `model.api` and replaces **each marker exactly once** in the fully assembled provider request with
      that API dialect's native binary content block. The exhaustive dialect table is Pi's ten
      `KnownApi` values (`packages/ai/src/types.ts:16-28`): OpenAI Chat, OpenAI/Azure/Codex Responses,
      Anthropic Messages, Bedrock Converse, Google Generative/Vertex, Mistral Conversations, and Pi
      Messages. “Lossless native representation” is mechanical: the pinned provider request type must
      admit a binary content part at the original role whose fields carry either the exact MIME+base64
      pair or the exact `data:<mime>;base64,<data>` URL. A format-only field that discards MIME, a role
      move, or an `unknown` cast to smuggle a block outside the provider union does not qualify. Google
      `inlineData { mimeType, data }` qualifies for user/model image and audio; every other pair is
      implemented only where its pinned request union meets the same rule. Pi's `model.input` metadata
      is not an audio gate because its type can only spell text/image (`packages/ai/src/types.ts:705-721`).
      Each codec is a total structural validator: wrong payload shape, missing/duplicate
      marker, marker moved to another role, or an API dialect with no lossless native representation for
      that role/media pair fails **before provider send** with MCP `InternalError` `-32603` and exact
      message `Active pi model cannot represent MCP sampling media`. It never substitutes a caption,
      transcript, placeholder, data-URI text, or another role. A provider that accepts the native block
      sees the original role/MIME/bytes; a provider/model that rejects a faithfully constructed native
      block follows the ordinary provider-failure row. A custom `Api` string without an installed exact
      codec follows the same active-model `-32603`, not the global `-32602 Unsupported MCP sampling
      capability` error. Thus valid stable media are not rejected merely for being image/audio; only a
      concrete active-model representation failure can reject them.

   Marker replacement runs after Pi authentication/base-URL/header assembly and immediately before the
   provider call: every pinned built-in API invokes `onPayload` on its final request body, and
   `ModelRuntime.completeSimple` forwards the options through `streamSimple`
   (`model-runtime.ts:472-480`). Unit fixtures for every dialect assert exact role/order/MIME/base64
   preservation and zero markers on the outbound body. The bridge is request-local, cannot mutate
   persisted Pi history, and rejects a provider payload that happens to echo or duplicate a marker.

   `params.systemPrompt` maps directly to the request-local Pi `Context.systemPrompt`
   (`MCP types.ts:1742-1751`; Pi `packages/ai/src/types.ts:450-454`): absent stays `undefined` and is
   omitted, empty stays the empty string, and a non-empty value is copied byte-for-byte. It is never
   trimmed, prefixed, appended to, or combined with the ACP session's system prompt or any MCP server
   `instructions`; those belong to ordinary agent turns, while sampling is this isolated
   `completeSimple` call. `SamplingMessage._meta` plus content-block `annotations`/`_meta` are
   intentionally ignored rather than forwarded (`types.ts:1144-1213,1729-1737`): Pi messages have no
   corresponding opaque field, and treating one as provider metadata or prompt text would invent
   control/data semantics.
   This is distinct from top-level `params.metadata`, which is forwarded as specified below.

   The handler always uses the ACP session's active model. `modelPreferences` is advisory and does not
   authorize an attached MCP server to change the workflow author's provider, cost, or data-routing
   choice. `maxTokens`, `temperature`, metadata, and the combined SDK-request, session-lifetime,
   optional-active-turn signal from §3.1 are forwarded; the adapter adds no token cap. A request with
   `includeContext` other than `none`, or with `tools`/`toolChoice`, fails MCP `InvalidParams` `-32602`
   with exact message `Unsupported MCP sampling capability` because those are the separately negotiated
   `sampling.context`/`.tools` features. Experimental `params.task` fails `-32602` with exact message
   `Unsupported experimental MCP task`.

   Because Pi's generic options have no native `stopSequences`, a text result is truncated at the
   earliest requested stop sequence and reports `stopReason: "stopSequence"`: concatenate returned text
   blocks, find the smallest UTF-16 index of any requested sequence (ties use request-array order), and
   slice before that index. With no match, Pi `stop` maps to MCP `endTurn`; `length` maps to
   `maxTokens`. The pure `mapMcpSamplingResult(message: AssistantMessage, stopSequences)` mapper owns
   response conversion. At this pin Pi `AssistantMessage.content` is exactly
   `TextContent | ThinkingContent | ToolCall` (`packages/ai/src/types.ts:388-401`): concatenate text
   blocks in order, omit thinking blocks, and reject if any tool call exists because sampling tools were
   not advertised. The result role is `assistant`, model is
   `message.provider + "/" + (message.responseModel ?? message.model)`, content is the single stable
   `{ type:"text", text:<concatenated/truncated text> }` block, and thinking is not exposed. The mapper
   has no image/audio output arm because production `modelRuntime.completeSimple` cannot return one at
   the pinned Pi type; no broader or test-only completion dependency is introduced. Pi `error`
   fails with MCP `InternalError` `-32603` and exact message `MCP sampling failed`; `aborted` follows the
   arbiter row that caused it or otherwise fails `-32603` with `MCP sampling cancelled`; and unexpected
   tool output fails `-32603` with `MCP sampling returned unsupported tool output` because sampling
   tools were not advertised. Before session binding or with no active model, fail `-32603` with
   `MCP sampling requires an active pi session model`. Provider details never cross those fixed errors.
2. **Roots** — `roots/list` (`ListRootsRequestSchema`→`ListRootsResultSchema`). Returns exactly the
   session's workspace root: `[{ uri: pathToFileURL(sessionManager.getCwd()).href, name: basename }]`
   (`session-manager.ts:926-928`). `roots.listChanged` is false because cwd is fixed; the adapter emits no
   roots-changed notification.
3. **Elicitation** — both MCP `form` and `url` modes route through ACP's typed
   `unstable_createElicitation`, carrying bound `sessionId`, mode, message, and the mode-specific
   requested schema or URL. ACP `decline`/`cancel` map directly back. For form `accept`, the adapter
   requires a non-null content object and validates it **without coercion or default application** against
   the request's exact `requestedSchema`, byte-for-byte and without adding/removing any keyword. It uses the same
   per-server `AjvJsonSchemaValidator` already supplied to the MCP client
   (`ajv-provider.ts:9-20,59-96`); compilation happens before the ACP call. This enforces exactly the
   keywords the server sent. In particular, an undeclared extra property is accepted when the schema
   does not forbid it; the adapter never synthesizes `additionalProperties:false`, defaults, coercion,
   or an ACP-only keyword. The pinned MCP server helper likewise compiles `requestedSchema` verbatim
   (`server/index.ts:550-603`). A valid content
   object is returned byte-for-byte. Missing content or validation failure throws MCP `InvalidParams`
   `-32602` with exact fixed message `Invalid MCP elicitation response`; validator details and submitted
   values are never echoed. A schema-compilation/validator throw becomes MCP `InternalError` `-32603`
   with exact fixed message `MCP elicitation schema validation failed` and the ACP request is not sent.
   ACP `content: null` on non-accept is normalized to absent as MCP's result schema requires. An elicitation
   request carrying experimental `params.task` fails MCP `InvalidParams` `-32602` with fixed message
   `Unsupported experimental MCP task`. For URL
   mode, the agent owns one monotonically increasing `bigint` counter and gives ACP the process-unique
   opaque id `pi-acp-elicitation-<counter>`. It stores a process-wide entry
   `(sessionId, MCP-client identity, original elicitationId) → { opaqueId, state:"pending"|"accepted" }`;
   process scope is required because ACP's completion notification carries no `sessionId`. Equal remote
   ids on different servers therefore cannot collide. A second outstanding URL request with the same
   server+remote id resolves `{ action:"decline" }` and emits fixed diagnostic
   `[mcp:<server>] duplicate elicitation id` through §3.2's route.

   Map lifetime is part of the `settleOnce` arbiter, not a detached ACP-promise side effect. Install
   `pending` immediately before calling ACP. Only an ACP `accept` that **wins** `settleOnce` may
   atomically transition it to `accepted`. ACP decline/cancel/failure, timeout, active-turn abort, peer
   cancellation, MCP transport close, or session disposal atomically removes the active entry before
   publishing/suppressing the winning outcome; an abort-ignoring late ACP resolve/reject is consumed and
   may neither recreate nor mutate it. Removal adds the remote id to a connection-lifetime consumed-id
   tombstone set. A same-id retry on that MCP client resolves `{ action:"decline" }` and emits
   `[mcp:<server>] reused elicitation id`; reuse cannot be made safe because the completion notification
   carries no generation. A fresh MCP client may reuse the id. A completion for a consumed id emits
   `[mcp:<server>] late elicitation completion`; a completion while the entry is still `pending` removes
   it, tombstones the id, settles the MCP create as `{ action:"decline" }` if still pending, and emits the
   same late-completion diagnostic. This prevents late `accept` resurrection and makes every cancellation
   path leak-free.

   Completion direction is pinned: the **MCP server** subsequently sends
   `notifications/elicitation/complete { elicitationId: original }` to pi-acp (`src/types.ts:2041-2061`).
   For an `accepted` entry, the adapter atomically removes it, adds its consumed-id tombstone, and calls the ACP connection's agent→client
   `unstable_completeElicitation({ elicitationId: opaque })` (`src/acp.ts:2779-2794`). Unknown or duplicate
   MCP completion notifications are ignored with fixed diagnostic
   `[mcp:<server>] unknown elicitation completion`; an ACP notification send failure emits fixed
   diagnostic `[mcp:<server>] ACP elicitation completion failed` because there is no response or safe
   replay. These fixed completion diagnostics **use `emitMcpDiagnostic` exactly like §3.2**, rather than
   bypassing it: dispatch while the active-turn gate is open enters the ordered ACP FIFO and can fail
   that prompt as `notification_error`; dispatch after the gate or outside a turn writes stderr; after
   disposal it is suppressed. Closing a session removes active entries and consumed-id tombstones after
   late ACP promises have been rejection-observed. If ACP create returns method-not-found,
   an unrecognized action, or non-timeout transport
   failure, MCP resolves `{ action: "decline" }`; turn abort/timeout/session disposal/peer cancellation
   follow the arbiter table. Permission
   requests remain the separate tool-approval channel.

Sampling is served without a new per-request approval. The pinned MCP schema recommends that the client
inform the user and allow inspection before sampling, but defines no sampling-specific approval wire
exchange (`src/types.ts:1784-1789`). In this workflow product, explicitly attaching the MCP server to the
agent call is the author's authorization; overloading ACP tool permission for every sampling request
would conflate two protocols and deadlock headless runs. This is default-on, as the owner's FULL-scope
decision requires.

### 3.5 Ownership, binding, and failure atomicity

Each ACP session owns its MCP clients, transports, notification handlers, alias table, inline extensions,
and child registry (§8). Before connect, the adapter creates a binding containing `sessionId`, cwd, the
ACP client, one session-lifetime `AbortController` (`sessionSignal` in §3.1), and the agent-owned
elicitation-id allocator/map. Roots works during open. Elicitation is never queued behind
`session/new`: during connect/initial enumeration the adapter forwards neither form nor URL to a human
and returns `{ action:"decline" }` with no URL-map/counter entry. This matches the production
`acp-agents` lifecycle, which registers a session only after `session/new` resolves and declines an
elicitation for an unknown session (`acp-client.ts:522-540,1561-1594`), while avoiding a circular open
wait. Once the session is published, both modes use §3.4 normally. The binding's pi-session/model getter
is populated after `createAgentSession`; sampling before that point follows the fixed no-active-model
`-32603` contract. Raw server names must be exact-JavaScript-string distinct as today (`Set<string>`
identity; no normalization before the duplicate check); the second equal configured name fails open as
server-attributable `mcp_init_error` with that exact configured name. Each receives a stable safe token
from the existing slug function; slug collisions gain `_2`, `_3`, and so on in configuration order.
That token drives aliases, prompt headers, diagnostics, and the server component of elicitation lookup
keys; no other name rule is added. The frozen alias allocator remains unchanged: the full alias is at
most 128 UTF-16 code units,
is truncated before appending an ordered `_2`, `_3`, … collision suffix, and synthetic reservations
participate in the same used-name set. This is pi's existing tool-name compatibility bound, not a
resource cap. Configuration order is authoritative. Session open is atomic: register request and
notification handlers, connect/initialize, ping, send capability-conditioned `logging/setLevel`,
enumerate initial tools, allocate aliases, load and precedence-order the resource loader,
construct pi, source-verify `bash` plus every alias, pass an open gate, replay the existing branch for
load without adding any MCP lifecycle message, pass the final open gate, then publish the session.
Failure adds no MCP-specific journal side effect.
Failure at any step enters §8's disposal generation, which invokes transport closes in reverse
acquisition order **without awaiting between invocations**, then failure-collects them concurrently and
exposes no partial session. `session/close`, failed
open, process shutdown, and replacement each close every owned
client exactly once; one close failure does not skip the remainder. Notification handlers reject work
after disposal and never retain a prior session's ACP client or pi extension. Disposal order is exact:
(1) start/join §8's cleanup generation in disposal mode; its synchronous prefix marks admissions,
starts every MCP close, aborts the session lifetime, then aborts the turn/refresh and starts child/Pi
abort; (2) clear queued refresh passes; (3) drain refresh commits; (4) join the active/reserved turn,
incoming handlers, and cleanup generation; (5) invalidate/dispose Pi; (6) await every bounded MCP close,
all of which were started concurrently in step 1. An incoming handler outside a turn therefore follows §3.4's session-disposal
no-response row and cannot outlive the session. An MCP transport close
failure/timeout writes fixed stderr diagnostic `[mcp:<server>] close failed` after all closes are
attempted; ordinary
`session/close` still succeeds under the inherited best-effort non-child-disposal rule.

**Failed-open error/cleanup precedence (exact).** Rollback always attempts Pi abort/dispose, child
drain, every wrapper close (including HTTP termination), and other acquired resources before settling.
Non-child cleanup failures are redacted diagnostics and do not replace the open outcome. The
child/Pi-abort barrier is different because concealing a possibly live process would falsely report a
clean rollback:

| original opening outcome | child/Pi-abort cleanup succeeds | child/Pi-abort cleanup fails |
|---|---|---|
| lifecycle `$/cancel_request` | preserve SDK `requestCancelled -32800` | replace with `child_cleanup_error -32603` |
| server-attributable MCP open failure | preserve `mcp_init_error -32603` with exact configured `data.server` | replace with `child_cleanup_error -32603` |
| global loader/control verification failure | preserve `extension_setup_error -32603`, no `server` | replace with `child_cleanup_error -32603` |
| replay notification, session corruption, or another construction error | preserve that exact inherited code/data | replace with `child_cleanup_error -32603` |
| `session/close`/agent disposal gate-aborts the opening transaction while its request signal is not aborted | `internal_error -32603` for the opening request; close itself succeeds | replace opening outcome with `child_cleanup_error -32603` |

“Replace” means the wire contains only the fixed child-cleanup shape in §9; the original error is sent
only to the redacted logger. For load/resume, the retained cleanup record is addressable by the requested
session id, so a later `session/close` retries it. For new/fork, the generated target id was never
published: retain the record under that internal id without putting it on the wire, and
`PiAcpAgent.dispose()` is the mandatory retry owner. All retained records also participate in top-level
dispose. A cleanup-successful failed open leaves no cleanup record; a failed one leaves a tombstone and
can never be reopened. A dynamic apply failure instead follows §3.3's poison path and the same cleanup
failure override. §8.2 defines retry generations and repeated top-level dispose.

**Post-publication transport state (exact).** Install the wrapper handlers plus `Client.onclose` and
`Client.onerror` before connect. Each server has `opening | open | disabled | closing | closed` state
and a once-only disable task. Adapter-initiated close sets `closing` before `Client.close()`; the
wrapper's synchronous logical close advances only `closing→closed`. A transport-specific fatal event
from §3.1 while `opening` fails the atomic open as server-attributable `mcp_init_error`. The same event
while `open` atomically changes only that server to `disabled` and performs these steps:

1. synchronously call `signalClose()`, which drives the SDK protocol `onclose` path to abort incoming
   handlers and reject pending outgoing requests; suppress any peer-caused refresh rejection under the
   outgoing arbiter; cancel/remove that server's refresh dirty bit/pass; remove its active URL-
   elicitation mappings under §3.4; and rejection-observe all late ACP outcomes so none can resurrect
   state;
2. emit exactly `[mcp:<server>] connection closed; server disabled` through
   `emitMcpDiagnostic`; the dispatch-time active-gate/stderr/suppression rule in §3.2 applies;
3. enqueue one pass on the **same session-wide refresh transaction/turn mutex** that marks every remote
   and synthetic alias for that server invalid, removes those names from the next active set, and drops
   that server's instructions from future `before_agent_start` output. Existing alias reservations and
   inactive Pi definitions remain tombstones. A mutation failure takes the §3.3 poison path.

4. start the wrapper close; Streamable HTTP first attempts bounded DELETE and all transports then
   physically close under §3.1. Close/termination diagnostics cannot create a second disable.

There is **no automatic reconnect**: HTTP is constructed with zero retries and legacy SSE is
synchronously closed from its raw error callback (§3.1). Reconnect could repeat initialize-time side effects, silently
change authorization/identity, or pretend connection-scoped subscriptions survived; reopening the ACP
session is the explicit recovery. A disable waits for an active turn boundary. The running turn retains
its old instructions/tool snapshot: an already-selected call on the dead peer receives the ordinary
fixed `` `MCP tool ${alias} failed` `` from the SDK connection-closed rejection, while an unrelated
prompt and every other MCP server continue. After commit, a stale direct call receives
`` `MCP tool ${alias} is no longer available` ``. The Pi session itself remains published; no other
server is deactivated and no active prompt is aborted merely because one peer died (an ACP diagnostic
send failure can still invoke the existing `notification_error` rule).

`Client.onerror` remains nonfatal only for **protocol-layer** errors and forwarded stdio pipe/parser
errors: the protocol callback itself only reports and does not close/reject pending work
(`src/shared/protocol.ts:644-674`). While state is `opening|open`, each such callback emits exactly
`[mcp:<server>] transport error` through `emitMcpDiagnostic`, never copies the raw error, and does not
change aliases/instructions/subscriptions. Raw HTTP/SSE `onerror` never enters this branch; the wrapper
classifies it as fatal first. Errors in `disabled|closing|closed` are suppressed. Repeated/late raw
close/error events and simultaneous operation timeout are idempotent under the same disable once-gate.

**Advertisement follows capability.** Because the client now genuinely serves sampling/roots/elicitation
and http/sse transports, `mcpCapabilities` and the client-capability object are truthful — the
overarching invariant "advertise only what is implemented" (pi-acp spec invariant 2) holds.

---

## 4. Deliverable 2 — Structured output rides the standard injection path (bespoke channel retired)

**Source trace:** owner quote 4: "Just like the OpenCode ACP Server integration, we should just pass the structured
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
| `nativeStructured(source)` | `parseFinalJson(source.finalMessageText())` (`pi.ts:84-86`) | **removed** — the owner explicitly classified pi with agents that do not have native structured output; retaining a Pi-specific hook would preserve the superseded semantic claim and duplicate the runner's common last-text repair fallback |

The shared `Backend.nativeStructured` and `StructuredSession.tryNative` members become optional, the
runner supplies `tryNative` only when the selected backend implements it, and the resolver calls it
optionally. Claude/Codex/OpenCode/custom retain their current overrides and behavior; Pi removes its
override. The common validated last-text extraction/repair ladder remains unchanged — it is backend-
agnostic and is not the retired pi server channel (`backend.ts:110`, `structured-output.ts:95-141`,
`runner.ts:947-966`).

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
- After removal `createAgentSession` receives no `customTools` argument: MCP tools and the tracked
  core-`bash` fallback live on the two inline extensions (§3.3/§8), not on the deleted structured tool.
- **Backend native fallback removed:** make `Backend.nativeStructured` optional, delete
  `PiBackend.nativeStructured`, make `StructuredSession.tryNative` optional, and omit it when the method
  is absent. For a schema'd pi call the injected tool is the primary channel; the common last-text
  validation and repair ladder still applies exactly as it does for non-native backends. None of that
  recreates a pi-acp `_meta`, prompt splice, server tool, capture state, or fabricated message.

### 4.4 Replay/history fidelity (resolved by removal)

Because there is no Pi-specific prompt splice or fabricated terminal message, there is no synthetic
structured value for `session/load` to omit. The injected MCP tool call/result is ordinary pi history
and follows the existing generic tool replay path in `replay.ts`; live streaming still includes its
ordinary incremental events, so this contract does not claim universal byte equality between a live
stream and a replay transcript. The pinned fidelity property is narrower and exact: replay contains the
recorded model/tool history, never a Pi-fabricated final structured value and never a bespoke schema
instruction spliced into a user prompt.

### 4.5 Coupled artifacts (see §10 for the apply-ready blocks)

`PI_ACP_PROTOCOL_CONTRACT` (`protocol-coverage.ts:159-172`), the drift assertions
(`docs-drift.test.ts:87-89`, `protocol-coverage.test.ts:147-148`), `pi-backend.test.ts:40-83`, and the
authoring skill's prose (`skills/agentprism-workflow-authoring/SKILL.md:153`) + structured-output table
(`skills/agentprism-workflow-authoring/reference.md:87`) + the generated authoring prompt all reference
the retired channel and change in lockstep (§10).

---

## 5. Deliverable 3 — Model config option (truthful catalog)

**Source trace:** owner quote 5: `npx @automatalabs/workflows config pi` surfaced only `thinkingLevel`. This deliverable
advertises a truthful `model` select so `config pi` enumerates the models the user can actually select,
and **engages and overturns** the frozen §5.1 rationale for omitting it.

### 5.1 The frozen rationale, quoted and answered

pi-acp spec §5.1 ("design-minimalism finding 2") justified omitting a `model` option: "advertising a
necessarily-partial 'representative' model list would mislead the validate probe (which would surface it
as the model menu)." **That objection is to a FAKE/hardcoded partial list. The fix advertises pi's REAL
configured catalog — the models whose provider is actually authenticated — so the validate probe surfaces
exactly what passes a new set request's catalog-membership check.** A truthful enumeration is not
misleading; it is the correct config
surface, and it fixes the origin incident directly. The freeze amendment (§10.2) engages this rationale
by name.

### 5.2 The advertised `model` select

`configOptions()` (`session.ts:117-119`) returns `[thinkingLevelOption(pi), modelOption(pi, deps.modelRuntime)]`,
and `applyConfig` (`config.ts`) returns the SAME two-option array on EVERY set (so a `set` echoes the
current catalog). `modelOption` is a `SessionConfigSelect` (`config-options.md` §2.3; SDK
`SessionConfigSelect`):

- **`id`**: `"model"`. **`name`**: `"Model"`. **`type`**: `"select"`. **`category`**: `"model"`.
- **`options` (choices)**: `deps.modelRuntime.getAvailableSnapshot()` (`model-runtime.ts:318-320`) — the
  last availability snapshot produced by Pi's `Models.getAvailable()`. That method checks each provider's
  credentials/authentication and returns no models for an unauthenticated provider; for an authenticated
  provider it applies the provider's optional credential-aware `filterModels` before returning models
  (`packages/ai/src/models.ts:394-408`). GitHub Copilot makes this distinction concrete by filtering its
  OAuth catalog through `credential.availableModelIds` (`providers/github-copilot.ts:19-27`). The
  separately stored `configuredProviders` set is an auth summary, not the model filter
  (`model-runtime.ts:228-254`). Each available model is mapped to
  `{ value: `${model.provider}/${model.id}`, name: model.name }` in snapshot order. This is pi's REAL
  configured catalog, not a representative list. The adapter does not sort, deduplicate, truncate, or
  append fabricated choices.
- **`currentValue`** (ACP requires a string): defined semantics for every state —
  - a model is active → `` `${session.model.provider}/${session.model.id}` `` (`agent-session.ts:854`);
  - **no model selected yet** (pre-first-prompt; `session.model` undefined) → `""`;
  - **unauthenticated / empty catalog with no active model** → `""`, `options: []`;
  - **active model subsequently absent from the catalog** → its real `provider/id` remains `currentValue`, while
    `options` remains the authenticated catalog (possibly empty). ACP requires a string but does not
    require current value membership; this reports current state without falsely claiming availability.

### 5.3 What the validate probe shows (exact)

`npx @automatalabs/workflows config pi` opens a session and reads `configOptions` (`config-options.md`
§2.2–2.3): it surfaces, per option, `{ id, type, currentValue, choices }`. With this change the pi row
lists `id:"model"`, `type:"select"`, `currentValue` per §5.2, and `choices` = the configured-provider
model ids (`provider/id`). The authored-select-value check (`config-options.md` §2.3) validates an
author's `configOptions.model` against those choices — but note the runner FORBIDS `model` in authored
`configOptions` (`assertNoModelConfigOption`, `runner.ts:1430-1440`; the reserved channel sets the model
instead). So the advertised select is for **discovery** (the `config` probe) and for hosts driving pi-acp
directly; it does not change how the runner selects models (§2.3 constraint honored).

### 5.4 Set-path semantics (catalog and set are symmetric)

`applyConfig("model", "<provider>/<id>")` first parses the value, then finds an exact provider+id match
in the **current `getAvailableSnapshot()`** used by §5.2. Absence returns the inherited
`invalid_model -32602`; it MUST NOT fall back to unfiltered `modelRuntime.getModel()`. The matched
snapshot `Model` object is passed to `session.setModel`; its auth failure still maps to `auth_error
-32000`, and busy behavior remains `session_busy -32602`. This closes the pinned upstream asymmetry:
Pi's old path could resolve an unfiltered registry model and check only provider-level auth, allowing a
GitHub Copilot OAuth model omitted by `filterModels` to be set (`config.ts:36-44` base;
`model-runtime.ts:293-295,354-356`; `agent-session.ts:1566-1580`). After this train, every advertised
choice passes membership and no unadvertised model does; the subsequent auth recheck may still return
`auth_error` if credentials drifted after the snapshot, and a concurrent turn may still return
`session_busy`. An already-active model may remain the
truthful `currentValue` after it disappears from availability, but attempting to set/re-set that absent
value returns `invalid_model`; reporting historical current state does not grant selection authority.

Every successful model or thinking-level set returns `[thinkingLevelOption, modelOption]`; the model
option is recomputed after the mutation and reflects the just-set current model. Failed sets return no
catalog. Other thinking-level semantics remain as frozen in pi-acp spec §5.2.

---

## 6. Deliverable 4 — Error-taxonomy tripwire (fixture-pinned classifiers)

**Source trace:** this is a derived correctness obligation from owner quotes 1 and 5: the first-class
server and its config workflow must retain their established retry/pause semantics as the mandated pi
runtime pin moves.

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

- The exact outputs of `formatNoModelSelectedMessage` and `formatNoApiKeyFoundMessage("anthropic")`
  (`auth-guidance.ts:6-25`) after replacing only the installation-specific `getDocsPath()` prefix with
  the literal `<DOCS>`; the fixture retains every other byte and newline. It also captures both OAuth
  source sites (`agent-session.ts:414-416,1177-1179`) instantiated with provider `anthropic`, whose exact
  common value is `Authentication failed for "anthropic". Credentials may have expired or network is
  unavailable. Run '/login anthropic' to re-authenticate.` Capturing both provenance sites is required
  even while their bytes agree.
- The exact upstream test inputs, not invented provider prose: `"429 quota exceeded"`,
  `"overloaded_error"`, and `"524 status code (no body)"` (`packages/ai/test/retry.test.ts:40-56`);
  `"401 Unauthorized: Token expired (unauthorized)"`, derived by the pinned
  `formatPiMessagesResponseError` from the 401 fixture (`pi-messages.ts:124-144`;
  `pi-messages.test.ts:177-191`); and exactly
  `"OpenAI API error (403): {\"error\":\"blocked by gateway WAF\"}"` and
  `"OpenAI API error (403): {\"error\":{\"message\":\"Permission denied\"}}"`
  (`error-body.test.ts:129-146`). Each expected classification is explicit, including generic cases,
  so the fixture proves both positive matches and non-matches.

| pinned fixture | expected pi-acp `errorKind` | wire/runner class |
|---|---|---|
| no-model guidance | `invalid_model` | ACP `-32602` invalid params |
| no-API-key and both OAuth re-auth messages | `auth_error` | ACP `-32000` auth-required pause |
| 401 token-expired/unauthorized and both formatted 403 messages | `auth_error` | ACP `-32000` auth-required pause |
| `429 quota exceeded` | `billing_error` (billing precedes rate) | pausable `provider_usage_limit` |
| `overloaded_error` | `rate_limit` | pausable `provider_usage_limit` |
| `524 status code (no body)` | `provider_error` | recoverable provider failure |

Each fixture string carries the **pin it was captured at** (`v0.80.10`). A classifier test asserts every
fixture classifies to its intended `errorKind` (and thence the intended `PiBackend` classification —
`rate_limit`/`billing_error` → pausable `provider_usage_limit`; `provider_error` → recoverable). The test
also reconstructs the two normalized guidance strings from the pinned templates and asserts their
complete bytes, not only classifier outcome, so an upstream prose change is visible even if the old
regex would still happen to match. The fixtures are the pinned ground truth: an upstream string that no
longer matches its regex, or a change that reclassifies a pausable error to `provider_error`, breaks the
test.

### 6.2 Tie to the runtime pin (the tripwire)

The fixture file exports its captured pin (`FIXTURE_PI_PIN = "0.80.10"`), and a guard test asserts it
equals the installed `@earendil-works/pi-coding-agent` version. Because that package does not export
`package.json`, resolve its public entry with `createRequire(import.meta.url).resolve(...)`, read
`../package.json` relative to the resolved `dist/index.js`, and compare the parsed `version`; do not read
the workspace manifest, which would miss an installed-version mismatch.
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

**Source trace:** owner quotes 3 and 4 require transport-independence and structured output through the
standard MCP injection. Real-transport tests are derived proof that those outcomes work on the wire.

Today the hermetic MCP→pi coverage is stdio-only and schema-less; structured assertions live only in the
CI-disabled live suite. This deliverable adds a credential-free regression net for the new client
surface and for schema'd structured output through the injected tool.

### 7.1 Per-transport MCP client coverage

`packages/pi-acp/test/` gains a table-driven conformance transcript run unchanged against three actual
SDK transports — not a transport-shaped DI fake:

- **stdio:** spawn a fixture Node MCP server using `StdioServerTransport` and communicate over its real
  stdin/stdout pipes;
- **Streamable HTTP:** bind an ephemeral loopback port and use real
  `StreamableHTTPServerTransport` request/response handling;
- **legacy SSE:** bind an ephemeral loopback port and use the SDK's real SSE server transport and POST
  endpoint.

For every row the transcript initializes, pings, observes instructions, walks multi-page tools/resources/
templates/prompts, calls a tool with progress, lists/reads/subscribes/unsubscribes resources, lists/gets
prompts, completes both reference kinds, consumes logging and list/update notifications, invokes
sampling/roots/form elicitation/URL elicitation with incoming progress tokens and observes each exact
`0/1` lifecycle pair, forwards elicitation completion, exercises
`tools/list_changed`, aborts an in-flight call, and closes. It asserts identical semantic output and
protocol behavior across all transports; the HTTP and SSE rows additionally assert identical header
behavior, including ordered combined values for repeated names. stdio has no HTTP headers. Separate DI
fault tests cover hung connect/request, late rejection, rollback order, notification-after-close,
malformed cursor cycles, and fixed error codes. All servers bind loopback/ephemeral ports and are closed
in test teardown.

### 7.2 Schema'd structured output through the injected tool

A hermetic test drives the actual `@automatalabs/acp-agents` runner, an actual pi-acp subprocess/ACP
stdio connection, and the runner's actual loopback `StructuredOutputToolHost`. A deterministic injected
pi model/session seam emits the tool call, so no provider credential or network access is needed. The
test points `PiBackend`'s existing `AGENTPRISM_PI_ACP_CMD`/`_ARGS` override at a fixture `tsx` child that
calls production `runAcp` with only its model/session dependencies replaced; transport, initialize, MCP
bridge, PiBackend, runner, and structured host remain production code. With a
schema, assert that the runner injects the HTTP MCP server, pi-acp discovers and calls
`mcp__structured_output__StructuredOutput`, the runner validates and captures the object, and no final-
message JSON is needed. A companion unit assertion supplies valid final-message JSON with an invalid/
absent capture and proves the result comes only from the existing common last-text ladder, never a
PiBackend native hook. This is a bridge e2e, not a stubbed initialize assertion.

### 7.3 Turn-abort child-cleanup regression (shared with §8)

The hermetic net includes the §8.3 child-cleanup test.

---

## 8. Deliverable 6 — Turn-abort child cleanup

**Source trace:** owner quote 1 requires a first-class server; leaving processes alive after the ACP
client cancels or closes violates that server lifecycle. The focus file makes the observed leak and its
regression test normative.

Live probe (2026-07-16): stopping a run left the agent's `sleep 180` shell child running. Although pi's
built-in bash tool registers signal cleanup, the current adapter already calls raw `Agent.abort()`, which
is the signal source. Switching only to `AgentSession.abort()` would add retry cancellation and idle
waiting but would not establish independent evidence that the child died. The contract therefore owns
the missing guarantee at the process boundary.

### 8.1 Per-session tracked bash operations

The adapter creates one `ChildProcessRegistrySlot` per ACP session. The slot holds one current
`ChildProcessRegistry` epoch, and the tracked operations call `slot.beginSpawn()` so a successfully
cancelled-but-still-live session can atomically install a fresh epoch as specified in §8.2. It overrides
pi's built-in `bash` through the normally-appended control extension from §3.3. Pi publicly exports `createBashToolDefinition`,
`BashOperations`, and `getShellConfig` (`packages/coding-agent/src/index.ts:263-274,394`); extension tools
overlay built-ins by name (`agent-session.ts:2438-2462,2492-2495`). Register
`createBashToolDefinition(cwd, { commandPrefix: settingsManager.getShellCommandPrefix(),
operations: createTrackedBashOperations(registry, settingsManager.getShellPath()) })` as `bash`. (The
definition's `shellPath` option is deliberately omitted because pi consults it only when `operations`
is absent; the tracked operations consume the same configured path directly at `bash.ts:291-296`.) The
`SettingsManager` is the same instance supplied to the loader and `createAgentSession` (§3.3), so the
override preserves the user's shell path and command prefix in addition to pi's name, schema,
description, output accumulation/truncation, progress updates, and permission behavior. If a configured
extension already defines `bash`, Pi's documented configured-extension winner remains active and the
control fallback is not the source returned by `getAllTools()`; the adapter neither wraps nor claims
that third-party implementation (§3.3/Non-goal 12.11).

This owns and reaps every process group launched through the adapter's tracked core-`bash` fallback,
which replaces Pi's built-in in the ordinary no-user-override configuration and closes the observed
`sleep 180` leak. Remote MCP calls receive protocol
cancellation (§3.2), but any subprocess they launch belongs to the remote MCP server process and is
closed by that server/transport's own lifecycle. A third-party pi extension can launch an unreported
subprocess without using `bash`; pi exposes no child handle for the adapter to register. That genuinely
unobservable case is Non-goal 12.11, not a weakening of the adapter-owned process guarantee.

`createTrackedBashOperations` mirrors the pinned `createLocalBashOperations` algorithm
(`tools/bash.ts:82-147`): validate cwd; apply pi's exact finite-positive timeout-seconds validation and
2,147,483,647 ms ceiling; resolve `getShellConfig(shellPath)`; use the `env` argument already prepared by
`createBashToolDefinition` (`bash.ts:158-160,397-405`); spawn detached on non-Windows; feed stdin when
`commandTransport === "stdin"`; stream stdout/stderr; honor the caller's timeout and signal; and await
process termination. It throws exactly `aborted` or `timeout:<seconds>` so pi retains its existing
user-visible result strings.

The semantic addition is an admission-safe ownership protocol. Each registry epoch's
`ChildProcessRegistry.state` is
monotonic `open → closing → closed`; a failed drain remains `closing`, never reopens. Immediately before
the synchronous `spawn()` call, the operation calls `slot.beginSpawn()`, which reads/delegates to the
current epoch in the same synchronous step. In `open`, that returns a unique
lease and increments `pendingSpawns`; in `closing/closed`, it throws `aborted` and no process is spawned.
A spawn throw calls `lease.failed()` in the same catch path. A successful spawn calls
`lease.register({pid, pgid: process.platform === "win32" ? undefined : pid, child,
leaderClosed:false, treeGone:false})` before feeding stdin or awaiting anything:

- in `open`, registration moves the lease from `pendingSpawns` into the retained process-tree map;
- if shutdown changed state to `closing` between spawn and registration, registration still moves the
  child into the map and immediately starts its process-tree termination. It joins the current drain
  while that generation is pending; if the deadline already failed that generation, its handle and
  termination promise remain in the retained cleanup record and join the next close retry;
- a lease is removed only by `failed()` or registration. A registered record is removed only after the
  production tree-disappearance proof below, never merely because the leader emitted `close`. The drain
  condition is `pendingSpawns === 0 && processTrees.size === 0`, not an initial registry snapshot.

`terminateAll()` synchronously changes `open → closing` before observing records, returns the current
drain-generation promise, and starts termination for every registered tree concurrently. Repeated calls
during that generation return the same promise. Late registrations join it as above, so cancellation
cannot falsely drain between spawn and PID registration. After a successful empty drain, state becomes
`closed`; after a failed/deadline drain, live child handles/PIDs remain in `closing` for the retry rule in
§8.2. A normal operation may settle after its leader closes, but the registry retains its record while
any descendant group remains; later cleanup still owns and kills that group.

On abort/timeout/registry shutdown, kill the whole process tree —
process-group `SIGKILL` to `-pid` on Unix and an awaited
`taskkill /PID <pid> /T /F` on Windows — then prove termination as follows:

- **Unix:** wait for leader `close`, but retain the PGID record. Probe `process.kill(-pgid, 0)` after
  signal delivery and then every 10 ms through the injected `deps.sleep`/clock. Only `ESRCH` proves the
  process group is gone. A successful probe or `EPERM` means it still exists and remains counted; any
  other probe error fails the generation. Remove the record only after both leader close and `ESRCH`,
  within the same absolute §8.2 deadline. This production barrier, not merely the test's descendant PID
  poll, prevents a dead leader from masquerading as a drained tree.
- **Windows:** await `taskkill /T /F` exit **and** leader `close`; successful exit is the OS tree-
  termination completion guarantee for the leader and every child selected by `/T`. A launch error or
  nonzero exit retains the record and fails the generation. The hermetic fixture separately probes its
  known descendant PID after that barrier, so a platform/runtime that violates the guarantee fails the
  suite rather than weakening settlement.

`ESRCH`/already-exited is success; other kill, taskkill-launch, taskkill-exit, leader-close, or liveness-
probe failures fail that drain generation after all process trees were attempted. `remainingChildren`
is always the number of retained live process-tree records, including a record whose leader closed but
whose Unix group has not reached `ESRCH`; it is never just the count of open leader handles. A shell
spawn failure before a PID exists remains pi's ordinary failed bash
result, not `child_cleanup_error`; its lease still releases, so shutdown cannot hang. No global PID
registry or broad kill is allowed: concurrent ACP sessions must be isolated.

### 8.2 Cancel, close, and settlement

`deps.graceMs` is the per-session cleanup deadline and remains exactly **5,000 ms by default**
(`deps.ts:27,66`). It is an absolute deadline for one cleanup generation, not a separate delay per
child or phase. The clock starts synchronously when the first of `session/cancel`, turn abort,
`session/close`, failed-open rollback, replacement, or process shutdown creates the cleanup generation,
immediately before any generation step below. Concurrent causes — in particular cancel + close — join
that generation, its original start time, and its single outcome; none restarts the clock. Generation
mode is monotonic `cancel-only → disposal`: if close/dispose joins a cancel-started generation, it
synchronously performs disposal step 2 below exactly once without changing the deadline. An incoming
request whose active-turn abort already claimed settlement keeps that outcome; otherwise the newly
observable session-disposal condition wins under §3.4's precedence.

`session/cancel` enters this path only when a prompt is active or reserved; cancel on an idle/unknown
session remains the inherited no-op and does not rotate the registry epoch.

At generation start the adapter, without awaiting between starts, (1) closes new prompt/refresh
admission, synchronously captures the slot's current registry epoch, and calls its `terminateAll()`,
whose synchronous `open→closing` transition closes spawn
admission and starts child termination; (2) for disposal causes (`session/close`, failed-open rollback,
replacement, process shutdown), starts all memoized MCP closes and aborts the session-lifetime signal so
incoming requests observe disposal before turn abort — cancel/turn-abort alone skips this step and keeps
the MCP connection open; (3) aborts the turn and refresh signals; and (4) calls and awaits `pi.abort()`
when Pi exists (a failed-open generation before construction treats this leg as already resolved).
`AgentSession.abort()` cancels retry, calls `Agent.abort()`, and waits for
idle at `agent-session.ts:1530-1533`. `void pi.abort()` is forbidden. The barrier succeeds only after
the underlying Pi run is idle, every already-enqueued turn notification has drained, every spawn lease
has resolved, every registered process tree has passed the platform disappearance proof in §8.1, and
every cleanup operation has succeeded. The
ACP prompt settles from this barrier outcome, so the barrier never waits on the promise it controls.
The implementation uses the injected `deps.sleep`/clock
seam already used by cancellation so the boundary is deterministic: if the 5,000-ms deadline callback
records expiry before the success barrier commits, timeout wins; if the barrier commits first, success
wins and the later timer is inert. Thus success at 4,999 ms is allowed and expiry observed at exactly
5,000 ms fails. A cleanup-operation error is recorded without short-circuiting other child/abort work;
if that work all settles before the deadline, the recorded error fails the generation, while a deadline
that records first fails it at 5,000 ms. Both have the same wire outcome below. `pi.dispose()` remains
defense in depth after the barrier, and every MCP transport is still closed even when the barrier fails.

On successful **cancel-only** generation drain, while prompt admission is still reserved, the slot uses
compare-and-swap to replace that exact now-`closed` epoch with a new `open` registry, then cancellation
settles exactly as before (`cancelled`). This does not reopen the old registry: a new object owns later
turns, and a second prompt cannot reach it before the first prompt settles. Disposal mode (including a
close that joined the generation) never installs a new epoch; close returns `{}` only after all other
resources finish closing. On any non-benign kill/taskkill/child-close error,
unresolved lease/PID, `pi.abort()` failure, or deadline expiry, the prompt and every joined close reject
with ACP `child_cleanup_error` (`-32603`); before rejection the generation escalates to disposal mode,
the session is tombstoned/disposed, and **no** `cancelled`
notification is emitted. All children and MCP transports are attempted before that failure settles.
The error names only the remaining process-tree-record count (never PID values, commands, cwd,
headers, or environment).
For a prompt without a joined close, the cleanup-generation failure rejects the prompt after every MCP
close has at least been invoked; bounded resource disposal may continue behind the retained tombstone.
A joined/explicit close waits for all bounded resource-disposal promises before returning the same
generation error. This difference affects only settlement time, never the shared outcome or retry state.

The agent retains a cleanup record behind a `child_cleanup_error` tombstone; this is the one exception
to the inherited rule that every tombstoned `session/close` succeeds. A repeated close on that id starts
a fresh 5,000-ms generation over the retained handles/PIDs (or joins one already running), never
reopens the session, and returns `{}` only if the retry drains. If it fails, it returns the same pinned
error and keeps the record for another idempotent retry. When a retry succeeds, the cleanup record is
removed while the ordinary tombstone remains, so still-later close is the inherited no-op success.
The record memoizes every non-child disposal promise: retry joins a still-pending Pi/MCP dispose and
never calls `Client.close()` or `pi.dispose()` twice, while it does re-run `pi.abort()` and termination/
liveness proof for each remaining process-tree record because those are the retryable guarantees.
Prompt/load/resume/config operations against either tombstone retain the existing closed-session
contract. An ordinary tombstone with no cleanup record still closes successfully.

This explicitly amends pi-acp spec §9.1.6 and T15: ordinary `pi.dispose()`/MCP-close/logging failures
remain best-effort diagnostics and close succeeds, but unresolved adapter-owned child cleanup or
`pi.abort()` failure returns `child_cleanup_error`. `PiAcpAgent.dispose()` has this exact idempotent
retry state machine, replacing the current one-way `disposed` once gate (`agent.ts:427-436`):

- the first call permanently closes agent admission, aborts/awaits all opening transactions, then starts
  cleanup for every live, published-tombstone, and unpublished failed-open record without awaiting
  between starts;
- concurrent calls while that generation is in flight return the same promise and outcome;
- success memoizes a fulfilled terminal state; every later call is an immediate no-op success and starts
  no Pi/MCP/child work;
- `child_cleanup_error` leaves terminal admission closed but retains the dirty records. The next call
  starts one fresh retry generation over all of them; concurrent callers join it. A fail→success removes
  the records and memoizes success; fail→fail retains them for another call.

Across retry generations, `Client.close()`/HTTP DELETE and `pi.dispose()` are memoized once (a still-
pending promise is joined); `pi.abort()`, process-tree signal/taskkill, leader-close wait, and Unix group
liveness probes are retried for unresolved records. Each top-level generation failure is one
`child_cleanup_error` whose `remainingChildren` is the sum of retained live process-tree records across
all sessions, including unpublished opens. Non-child close/dispose failures remain diagnostics. This is
the recovery path for new/fork cleanup records whose generated id was never returned.

The current CLI's outer 5-second process envelope (`packages/pi-acp/src/index.ts:17-51`) is therefore
replaced with **66,000 ms**: the 5,000-ms child generation + the existing 60,000-ms MCP request/close
bound + 1,000 ms scheduling margin. Connection close, SIGTERM, and SIGINT share one process-shutdown
promise. Successful shutdown preserves the requested exit code only after `agent.dispose()` proves all
owned children gone and all MCP closes have settled. If `agent.dispose()` rejects or the 66,000-ms
envelope expires, stderr receives exactly `shutdown cleanup failed` (the caught cause may be logged only
through the existing redacted logger), every remaining session/transport is still attempted, and the
process exits code **1**, overriding a requested zero exit. The process must not report successful
shutdown while the registry still knows an owned child is alive.

`ErrorKind` gains `child_cleanup_error`; `LABELS.child_cleanup_error` is exactly
`"child process cleanup failed"` and it is not added to `INVALID_KINDS`. Keep the compile-time
redaction boundary narrow with four exported overload families: `mcp_init_error` and
`unsupported_mcp_transport` require `{ server:string }`; `provider_error`/`internal_error` take either
no second argument or `{ details?: Array<{type:string; timestamp:number}> }`;
`child_cleanup_error` requires `{ details:{ remainingChildren:number } }`; every remaining kind,
including `extension_setup_error`, has no second argument. The shared implementation accepts only the
union of those three object shapes, never `unknown`, and the overloads expose no cross-kind call.
Construct child failure from the retained process-tree count. No PID,
command, cwd, headers, provider detail, submitted value, or environment can type-check into the wire.

### 8.3 Regression test (hermetic, credential-free)

Use the real tracked `bash` fallback to launch a platform-neutral Node fixture whose leader immediately
spawns a **distinct long-lived descendant**, prints both PIDs through the tool update stream, and keeps
both alive for 180 seconds. On Unix the shell leader, fixture process, and descendant inherit the
tracked detached process group; on Windows they form the `taskkill /T` tree. This is not a mock tool or
a direct-child-only fixture. The registry exposes a read-only leader-PID snapshot for diagnostics/tests;
the fixture exposes its descendant PID. The platform probe waits until every recorded leader and
descendant is observable before triggering cleanup and then until probing each PID reports `ESRCH`/not
found. Cancellation, `session/close`, failed-open rollback, and process shutdown MUST NOT settle before
**both leader and descendant/process group are gone**. Start two such trees in concurrent sessions and
assert cancelling A reaps A's leader and descendant while both B PIDs remain alive until B closes. Inject a
kill failure and a non-closing child to assert `child_cleanup_error` `-32603`, session tombstoning, no
false `cancelled`, and cleanup attempts for all remaining children. Pause independently immediately
before `spawn()` and immediately after `spawn()` but before `lease.register()`; cancel, close,
failed-open rollback, and process shutdown at each pause must either prevent the spawn or kill/join the
late registration before settlement. Deterministic-clock cases pin success at 4,999 ms, deadline failure
at 5,000 ms, cancel+close joining one generation/outcome, a failed first close followed by a successful
retry, a second failed retry, and later no-op close after a successful retry. Agent-level dispose cases
pin concurrent join, fail→success, fail→fail, and post-success no-op, including an unpublished failed-open
record. A failing process-shutdown
case pins the 66,000-ms envelope, exact stderr line, exit 1, and attempts of every session/transport.
Implementation must also rerun the original live probe against the pinned pi release; a remaining leak
is stop-and-report, not a waived test.

---

## 9. Error and failure contracts (pinned wire codes)

**Source trace:** owner quotes 1, 3, and 4 require peer-visible behavior that is transport-independent;
pinning errors prevents a transport or feature from inventing incompatible failure semantics.

All wire codes follow the pi-acp spec §8 taxonomy (adapter-owned `RequestError` with `data.errorKind`
and a fixed `data.message` label; JSON-RPC prefix in `error.message`). This train changes the taxonomy
in exactly these ways:

| condition | code | `errorKind` | notes |
|---|---|---|---|
| `http`/`sse` MCP server now **accepted** | — | — | no error: `bridgeMcpServers` connects it (§3.1). The prior `unsupported_mcp_transport` for http/sse is REMOVED. |
| `acp` transport MCP server sent to pi-acp | `-32602` invalidParams | `unsupported_mcp_transport` | fixed `data.message = "unsupported mcp transport"`; names the server; RETAINED for `acp` only (§12.6). |
| duplicate raw MCP server name, or MCP connect/initialize/ping/logging-setup/initial-list/schema/alias-source verification failure or timeout during open (any transport) | `-32603` internalError | `mcp_init_error` | exact `data = { errorKind:"mcp_init_error", message:"mcp server initialization failed", server:<exact configured name> }`; the duplicate row names the second configured occurrence. Only a failure attributable to that server uses this kind. A call-time failure is instead the fixed failed tool result from §3.2. |
| missing/duplicate/reordered inline control/reserved extension, changed loader runtime/errors identity, or wrong/missing `bash`/control winner | `-32603` internalError | `extension_setup_error` | exact `data = { errorKind:"extension_setup_error", message:"pi extension setup failed" }`; no `server` or `details`, because the failure is session-global and may occur with zero MCP servers (§3.3). |
| removed MCP tool called after `tools/list_changed` | — | — | not a request error: a **failed tool result** with fixed message `` `MCP tool ${alias} is no longer available` `` (§3.3). |
| dynamic `tools/list` refresh fails validation/request | — | — | retain the prior snapshot and emit fixed diagnostic `[…] tools/list refresh failed`; no request error (§3.3). |
| dynamic refresh fails after the first Pi registration/activation mutation | `-32602` invalidParams for any admitted/subsequent operation | `session_terminated` | the prior snapshot cannot be restored through Pi's public API; emit `[…] tools/list refresh commit failed; session terminated`, poison/tombstone, drain, and never publish the partial candidate (§3.3). |
| remote tool requires experimental task execution | `-32603` internalError at open | `mcp_init_error` at open | the client does not advertise tasks; an initial list fails atomically with fixed `data.message = "mcp server initialization failed"`; a dynamic list retains the prior snapshot and uses the fixed refresh-failed diagnostic (§3.3/§12.7). |
| sampling asks for unadvertised context/tools semantics | `-32602` MCP InvalidParams | — | fixed message `Unsupported MCP sampling capability` (§3.4). |
| active Pi API/model has no lossless payload representation for a stable sampling role/media pair | `-32603` MCP InternalError | — | fixed message `Active pi model cannot represent MCP sampling media`; stable text/image/audio are accepted globally and this is a concrete active-model failure, never lossy fallback (§3.4). |
| sampling/elicitation request carries experimental `params.task` | `-32602` MCP InvalidParams | — | fixed message `Unsupported experimental MCP task`; tasks are not advertised (§3.4/§12.7). |
| sampling before binding / with no active model | `-32603` MCP InternalError | — | fixed message `MCP sampling requires an active pi session model` (§3.4). |
| sampling provider failure / turn abort / timeout / unexpected tool output | `-32603` MCP InternalError | — | fixed messages `MCP sampling failed` / `MCP sampling cancelled` / `MCP sampling timed out` / `MCP sampling returned unsupported tool output`; provider details never cross the MCP wire. Peer cancel/transport close and session disposal send no response (§3.4). |
| elicitation unsupported by ACP client | — | — | MCP `{ action:"decline" }` result, not an error (§3.4). |
| elicitation received before ACP session publication | — | — | MCP `{ action:"decline" }`, no ACP human resolver call and no URL mapping/counter; requests are never queued behind open (§3.5). |
| elicitation turn abort / timeout | — | — | MCP `{ action:"cancel" }`, respectively; peer cancel/transport close and session disposal send no response (§3.4). |
| ACP accepts form elicitation with content invalid under the requested MCP schema | `-32602` MCP InvalidParams | — | fixed message `Invalid MCP elicitation response`; no validation details cross the wire (§3.4). |
| dynamic elicitation response-schema compilation fails | `-32603` MCP InternalError | — | fixed message `MCP elicitation schema validation failed`; ACP is not invoked (§3.4). |
| duplicate outstanding server URL-elicitation id | — | — | MCP `{ action:"decline" }` plus fixed diagnostic `[…] duplicate elicitation id`; existing mapping remains (§3.4). |
| reuse of a consumed URL-elicitation id / completion after cancellation | — | — | MCP retry `{ action:"decline" }` + `[…] reused elicitation id`; late completion is ignored + `[…] late elicitation completion`; connection-lifetime tombstone prevents generation ambiguity (§3.4). |
| unknown/duplicate MCP URL-completion notification or ACP completion-send failure | — | — | fixed diagnostics `[…] unknown elicitation completion` / `[…] ACP elicitation completion failed` through `emitMcpDiagnostic`; active-gate delivery may fail that prompt, after-gate/outside-turn uses stderr, post-dispose suppresses (§3.4). |
| incoming sampling/roots/elicitation progress notification cannot be sent | — | — | retain the feature result/error and emit fixed diagnostic `[…] progress notification failed`; progress is optional telemetry and cannot replace the request outcome (§3.4). |
| ordered active-turn MCP diagnostic cannot be delivered over ACP | `-32603` internalError for the active prompt | `notification_error` | abort the turn, close the diagnostic gate, drain/suppress later diagnostics, and reject only after the shared ACP FIFO pump settles (§3.2). |
| outgoing MCP operation abort/disposal/peer-close/timeout/completion race | per §3.1 | — | settle-once precedence is request/turn abort > disposal > peer fatal > timeout > operation; open cancellation remains `-32800`, live tool timeout/failure text is fixed, peer-caused refresh rejection is suppressed, and no late outcome is emitted. |
| Streamable HTTP DELETE session termination fails/times out | — | — | physical close still runs; fixed stderr `[…] session termination failed`; 405 is silent success and clears the id (§3.1). |
| MCP transport close fails/times out | — | — | all closes still run; fixed stderr diagnostic `[…] close failed`; ordinary `session/close` succeeds unless child cleanup fails (§3.5). |
| published MCP peer has a transport-specific fatal event | — | — | stdio raw close, every raw HTTP/SSE error, or request-driven HTTP timeout disables only that server at the next boundary; exact `[…] connection closed; server disabled`, aliases/instructions deactivate, mappings clear, other server/session survives, and zero reconnect occurs (§3.1/§3.5). |
| MCP client reports nonfatal protocol/stdio pipe-parser `onerror` | — | — | exact redacted `[…] transport error` diagnostic; raw HTTP/SSE errors are not in this class (§3.5). |
| repeated pagination cursor / malformed stable-base response | `-32603` internalError | `mcp_init_error` at open; failed tool result during a turn | open uses fixed `data.message = "mcp server initialization failed"`; turn-time text is `MCP tool ${alias} failed`; diagnostics name only the safe server token and operation, never headers/env/content. |
| child registry/Pi abort cannot drain on cancel/close | `-32603` internalError | `child_cleanup_error` | fixed `data.message = "child process cleanup failed"`; `data.details = { remainingChildren: <integer> }`; prompt and joined close fail after all attempts, session tombstoned, never `cancelled`; repeated close retries the retained cleanup record (§8.2). |
| failed-open original error plus child/Pi-abort cleanup failure | `-32603` internalError | `child_cleanup_error` | cleanup failure overrides `-32800`, `mcp_init_error`, `extension_setup_error`, or another original open error; retain addressable load/resume or agent-owned unpublished new/fork cleanup record (§3.5). |
| process shutdown cannot prove cleanup | process exit `1` | — | exact stderr `shutdown cleanup failed`; overrides requested zero exit after all session/transport attempts or the pinned 66,000-ms envelope (§8.2). |
| structured-output errorKinds `structured_tool_collision` / `invalid_output_schema` | — | REMOVED | the bespoke channel is gone (§4.3); these `ErrorKind` literals are deleted from `errors.ts:3-27` and their label/`INVALID_KINDS` rows (`errors.ts:29-72`), and the T12 assertions (pi-acp spec §13) are removed. |
| set `model` absent from current advertised availability snapshot / matched but auth fails / busy | `-32602` / `-32000` / `-32602` | `invalid_model` / `auth_error` / `session_busy` | availability membership is now authoritative; unfiltered registry fallback is removed (§5.4). |

The provider-error classification codes (`auth_error` `-32000`; `billing_error`/`rate_limit`/
`provider_error` via terminal reject) are UNCHANGED; §6 pins their inputs. `PI_ACP_PROTOCOL_CONTRACT.providerErrorKinds`
(`auth_error`, `rate_limit`, `billing_error`, `provider_error`) is UNCHANGED.
`ErrorKind` adds `extension_setup_error` and `child_cleanup_error`; their labels are exactly
`"pi extension setup failed"` and `"child process cleanup failed"`, and neither is in
`INVALID_KINDS`. This explicitly amends pi-acp spec error row 16: `mcp_init_error` always has
`data.server`; global verification never uses it.

---

## 10. Normative amendment blocks (apply these to the frozen artifacts)

**Source trace:** all five owner quotes define one train rather than an isolated bridge. These blocks are
derived consistency work so the earlier frozen spec, executable contract, docs, and authoring surface
cannot contradict the new contract.

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
  (sampling/roots/elicitation, §3.4), including lossless user/assistant text/image/audio sampling through
  the provider-payload seam and the exact active-model representation error.
- **§5.1 (config surface)**: replace "No `model` config option is advertised (design-minimalism finding
  2)" with the truthful-`model`-select amendment — QUOTE the "necessarily-partial representative list
  would mislead the validate probe" rationale and ANSWER it (the advertised catalog is Pi's
  credential- and `Provider.filterModels`-aware availability snapshot, §5.1–5.3). Update §5.2 so a
  model set must belong to that snapshot and every successful set echoes both options.
- **§9.3 (MCP bridge)**: rewrite §9.3.4 "Transports" — v1 now serves stdio + http + sse (not stdio only);
  `unsupported_mcp_transport` is retained for `acp` only. Add §9.3.5 dynamic registration (§3.3),
  §9.3.6 lifecycle/resources/prompts/completion/logging/progress (§3.2), §9.3.7 client features (§3.4),
  and §9.3.8 ownership/rollback (§3.5). Amend the §9.3.2 collision analysis for extension-sourced MCP
  tools (§3.3 collision note). The §9.3.6 progress contract includes the
  `translate.ts` partial-details → ACP `rawOutput` change. Record `enforceStrictCapabilities: true` and the refresh/prompt
  turn-boundary mutex, while stating that adapter-level capability conditioning is authoritative for
  both subscription operations. Record the session-wide prepare+commit transaction queue, split
  reserved-MCP/control extensions, preserved configured hook/`bash` ordering, transport-specific
  fatal observation, HTTP zero-reconnect/request-driven-idle behavior, SSE synchronous reconnect
  suppression, bounded HTTP DELETE-before-close, the outgoing-operation arbiter, post-open per-server
  disable/no-reconnect state, and pre-connect notification registration with post-initialize capability
  dispatch checks; these are part of the request-validity, no-gap, and atomic-snapshot contracts. Move
  `PKG_VERSION` to the shared internal `version.ts` module and use it for both ACP and MCP initialize
  identities (§3.2).
- **§9.4 (structured output)**: §9.4.1–9.4.3 are SUPERSEDED — the terminating-tool/`_meta.outputSchema`
  channel is retired; pi rides the injected `StructuredOutput` HTTP tool like OpenCode (§4). Replace with
  a short section pointing at the runner injection path (`runner.ts:1397-1407`, `structured-tool.ts`).
- **§8 (error taxonomy)**: remove `structured_tool_collision`/`invalid_output_schema`; add
  `extension_setup_error` and `child_cleanup_error` as internal `-32603`, retain mandatory `server` only
  on server-attributable `mcp_init_error`, preserve the narrow kind-specific overload boundary, add the §6
  fixture tripwire, and apply all §9 rows.
- **§9.6 (cancellation)**: add the per-session tracked-bash registry, drain-before-settlement rule, and
  `child_cleanup_error` `-32603` failure (§8); `AgentSession.abort()` is awaited. Explicitly amend
  §9.1.6/T15's close-success rule with the retained-cleanup-tombstone retry contract and the one
  child-cleanup exception; add the open→closing→closed spawn-admission state machine, one absolute
  5,000-ms generation deadline, per-session slot/fresh-epoch swap after successful cancel-only drain,
  retained Unix PGID liveness/Windows tree-completion barrier, repeated `PiAcpAgent.dispose()` retry
  state machine, failed-open precedence/hidden-record ownership, and the 66,000-ms process envelope.
- **§9.1/§9.2 (session lifecycle/history)**: record that every fresh MCP client starts unsubscribed,
  subscriptions are never inferred/restored from replay, and no MCP reset marker or other history
  mutation is added (§3.2). Add prompt `idle→reserved` admission, the incoming-request
  cancellation/timeout arbiter, pre-publication elicitation decline, ordered diagnostic-pump settlement,
  outgoing-operation arbiter, exact `systemPrompt`/per-message `_meta` sampling mapping, exact-schema
  form validation, per-server post-publication disable/no-reconnect behavior, and the dynamic-commit
  poison/tombstone path.
- **§13 (test plan)**: remove T12 (bespoke structured output) and the T9 "no `model` option" clause;
  amend T10 (`mcpCapabilities: { http:true, sse:true }`, no `_meta` namespace), T9 (advertises a `model`
  select with defined `currentValue` states), T20 (http/sse transports, dynamic registration, client
  features), and T8 (deep wire shapes for server-attributable `mcp_init_error`, global
  `extension_setup_error`, and narrow `child_cleanup_error` details); add the §11 rows below.
- **§0 (implementation-time re-verification)**: add a §0.4 repin note if the pin moved at build time.

### 10.3 Drift + conformance tests

- `packages/acp-agents/test/docs-drift.test.ts:87-89`: the spec must now include
  `mcpCapabilities: { http: true, sse: true }` (not `{}`), and MUST NOT assert the `_meta["@automatalabs/pi-acp"]`
  namespace or `{ outputSchema: true }` (those assertions are removed).
- `packages/acp-agents/test/protocol-coverage.test.ts:147-148`: `PI_AGENT_DIST.includes("mcpCapabilities: {}")`
  → the new served block; the `outputSchemaKey` dist assertion is removed.
- `packages/acp-agents/test/pi-backend.test.ts:40-83`: `embedSchemaInPrompt` → `true`;
  `injectStructuredOutputTool` → `true`; the `customCapabilities` deep-equal is removed (now
  `undefined`); the `promptMeta` outputSchema assertions are removed (now `undefined`); the
  `nativeStructured` implementation and assertion are removed.
- `packages/acp-agents/src/backend.ts:110` and `src/structured-output.ts:95-141` make the native hook
  optional; runner `StructuredSession.tryNative` is supplied only for a backend that implements it
  (`runner.ts:947-966`). Existing native backend and common last-text recovery tests remain green; the
  pi e2e proves the captured tool is primary and no PiBackend native hook remains.

### 10.4 Authoring skill + generated prompt

- `skills/agentprism-workflow-authoring/SKILL.md:153`: rewrite the prose that currently says Pi uses
  native `_meta.outputSchema`, final-message JSON, no prompt embedding, and no MCP injection. It must
  instead say Pi advertises HTTP, receives the client-hosted `StructuredOutput` MCP tool, and retains
  the runner's common prompt-embedded schema/validated last-text fallback when no valid capture exists.
- `skills/agentprism-workflow-authoring/reference.md:87` (the structured-output backend table): the **Pi**
  row moves from "native turn-level `_meta.outputSchema` … no injected MCP tool" to the injected-tool
  channel — i.e. Pi joins OpenCode/custom: "a client-hosted `StructuredOutput` MCP tool injected when the
  agent advertises HTTP MCP support." Add a note that Pi now accepts http/sse MCP servers.
- After editing the skill, REGENERATE the MCP `author-workflow` prompt via
  `node scripts/generate-authoring-prompt.mjs` (exact-marker rewrite) so the generated prompt matches;
  the generator reads **both** inputs and concatenates them (`generate-authoring-prompt.mjs:30-43,103-113`),
  and the drift test (`packages/mcp-server` authoring-prompt drift) states the exact command and fails
  until regenerated. This is mandatory — skill edits require regeneration. Static negative assertions
  scan the complete `SKILL.md`, complete `reference.md`, and complete generated prompt and fail on Pi
  claims containing `native`/`_meta.outputSchema`/`final-message JSON` or phrases equivalent to "no
  injected MCP tool"/"neither … injects". Equality alone is insufficient because it can faithfully
  publish two mutually contradictory source claims.

### 10.5 Public docs

Audit and update the **entire contents**, not only the known passages, of root `README.md`,
`docs/api.md`, `docs/design-notes.md`, `packages/workflows/README.md`, and
`packages/pi-acp/README.md`, plus `packages/acp-agents/README.md` and the implemented design record
`docs/specs/acp-auth-spec.md`, to the full-client + injected-tool reality. Known stale anchors include
`README.md:402`, `docs/api.md:892,1078`,
`docs/design-notes.md:193,229,418,434,460-471,660-713`, and
`packages/workflows/README.md:700`, `packages/pi-acp/README.md:22,41,45`,
`packages/acp-agents/README.md:233`, and `docs/specs/acp-auth-spec.md:1050-1055`; they are starting
points, not the scan boundary.
The package README lists stdio/HTTP/SSE, explains `acp` remains client-hosted, removes the
`__acp_structured_output` reservation, and names the configured `model` catalog. Whole-file negative
assertions reject any remaining Pi stdio-only, native `_meta.outputSchema`, bespoke prompt-splice,
`__acp_structured_output`, or no-injected-tool claim in all seven documents. The acp-agents README says
plain JSON Schema is for Claude's native channel while Pi uses injected HTTP MCP plus the common
prompt/last-text fallback. The auth spec §3.6 says Pi's auth methods still carry no auth `_meta`, but Pi
has **no non-auth private structured-output namespace** after this train; remove the claim that
`PI_ACP_PROTOCOL_CONTRACT` pins one while retaining every actual auth-matrix row and its executable
drift relationship (`packages/acp-agents/test/docs-drift.test.ts:38-55`). Historical `CHANGELOG.md`
entries are excluded under Non-goal 12.13; current guidance must not use a changelog as its mechanism
description.

---

## 11. Test plan — traceability matrix

**Source trace:** owner quotes 3–5 require all transports, standard structured injection, and model
discovery; the issue's correctness batch requires classifier and child-cleanup regressions. Every
normative rule above has a row below.

All tests run under `tsx --test` (the package convention) using the DI seam (`runAcp({ deps, stream })`
for pi-acp; the runner's DI for acp-agents) — no external credentials except the gated live leg. Every
row cites the normative statement it covers. Rows extend the pi-acp spec §13 matrix (numbering continues).

### 11.1 Full MCP client (§3)

| # | covers | assertion |
|---|---|---|
| M1 | §3.1/§7.1 | one table-driven transcript passes over actual SDK stdio, Streamable HTTP, and legacy SSE transports; the HTTP/SSE rows prove repeated header values survive in their combined field order while stdio has no header assertion; `initialize` advertises `{ http:true, sse:true }`; `acp` remains `unsupported_mcp_transport` `-32602` |
| M2 | §3.1 | `Client.connect` receives timeout/session signal for initialize and the outer bound independently catches a hung transport start; connect/list/call/synthetic requests are bounded on all transports. The wrapper delegates every member, logically closes once before physical close, and coalesces late raw events. HTTP is constructed with the exact zero-retry object; GET EOF/error disables before any reconnect, 405 request-driven idle stays live until the next operation, and a timed-out next request disables. Legacy SSE `onerror` synchronously closes EventSource and produces zero reconnect fetches; stdio natural close uses raw `onclose`. Raw HTTP/SSE errors are fatal while protocol/stdio pipe errors are nonfatal. Deterministic barriers assert the outgoing precedence for request/turn abort vs disposal vs peer fatal vs timeout vs completion on connect, every tool/synthetic request, and refresh, including cancel-at-timeout and peer-close-at-timeout; peer-caused refresh rejection emits no duplicate refresh diagnostic; late settlement is consumed. Streamable HTTP close with absent/present session id proves DELETE-before-close, 2xx and 405 success, error/timeout diagnostic, and unconditional physical close. |
| M3 | §3.2/§3.3 | exact package client identity, strict-capability defense enabled, and adapter conditioning prevents both subscribe and unsubscribe when `resources.subscribe` is absent (including the SDK unsubscribe guard hole); initialize metadata/instructions (non-empty instructions appear on every turn in server order but never enter ordinary model history), outgoing/incoming ping, canonical text/image/audio/resource-link/embedded-resource/unknown/structured/error projection, remote `rawOutput` equals the exact `CallToolResult` with no Tool/page wrapper, non-paginated synthetic output equals its exact result, and paginated output contains only exact page arrays; exact Tool/list pages remain internally available for registration/validation/refresh. Cover all resource list/template/read/subscribe/unsubscribe surfaces, prompts, both completion refs, conditional logging, every notification (including one sent immediately after initialized), exact synthetic schemas, and all-page enumeration; pre-initialize/unadvertised notification emits only the fixed unexpected diagnostic and no request; output schemas work on first/final list pages; second list/read observes live change; repeated cursor fails; large fixture proves no cap. |
| M4 | §3.2 | MCP call progress reaches pi `onUpdate`, then ACP `tool_call_update` with full params in `rawOutput`; cancellation reaches the MCP peer and no late update/error is emitted after ACP settlement. Interleaved logging/list/update/unexpected/progress-failure/refresh-failure diagnostics and normal turn updates traverse the one ACP FIFO in enqueue order; prompt settlement waits for its accepted diagnostics. Injecting ACP send failure aborts/rejects the active prompt as `notification_error -32603`; later diagnostics are suppressed/stderr-routed exactly by the gate and never leak into a later turn. Outside-turn/post-dispose routes are stderr/suppression as specified. |
| M5 | §3.2/§3.3 | synthetic aliases reserve before remote aliases in exact server/operation order; initial tools use title precedence; list-changed ADD/CHANGE/UNCHANGED/REMOVE/RE-ADD swaps exact internal Tool/page/validator state with next-turn activation, inactive tombstones, and stable aliases. One session-global prepare+commit queue prevents concurrent stale candidates. A two-server barrier delivers simultaneous dirty notifications (reverse arrival), colliding sanitized/truncated aliases, and disjoint additions/removals; configuration order gets the unsuffixed alias, later server gets `_2`, no reservation/active-name delta is lost, and later batches rebase on committed state. An actual Pi turn pauses after model tool selection, sends removal, then executes: the fixture still honors the old tool so the current call succeeds; after settlement the next turn omits it and a direct stale call gets `no longer available`. Fault injection before/through commit proves pre-commit discard/no suffix consumption and post-mutation poison/tombstone. Prompt/config/fork busy admission, prompt-vs-commit atomicity, close races, all-zero reserved-prompt cancellation, no registration after dispose, and optional/forbidden task metadata are covered. |
| M6 | §3.3/§8.1/§9 | configured extensions retain their full relative order. Only `<inline:agentprism-pi-acp-mcp>` moves first and wins reserved collisions; control remains appended. Ordered hooks and configured/core `bash` precedence are exact. Alias-source failure returns `mcp_init_error -32603` with the required exact configured server field; missing/duplicate/global loader/control/wrong-bash failures (including zero servers) return `extension_setup_error -32603` with exact no-server/no-details data. Deep wire assertions amend base T8: only the configured server name appears where required; no path, source, cause, or raw diagnostic leaks. |
| M7 | §3.4 | sampling uses only active model and accepts user/assistant text/image/audio. Every role/media/API payload fixture proves exact replacement or the fixed active-model error, with no marker/lossy fallback. `systemPrompt` fixtures prove undefined omitted, empty preserved, and non-empty byte-copied into only `Context.systemPrompt`, never combined with ACP/MCP instructions; top-level metadata is forwarded while per-message/content annotations and `_meta` are ignored. The pure response mapper is tested over the real Pi `AssistantMessage` union (ordered text concat/stop, thinking omission, tool-call error, provider error/abort); no invented image/audio result seam exists. Optional context/tools/task and no-model errors are pinned. Race sampling and both elicitation modes against peer cancel/transport fatal close, turn abort, disposal, timeout, and ordinary completion on every transport; deterministic simultaneous-event barriers assert the incoming precedence, exactly one/no response as applicable, progress behavior, and late-settlement suppression. URL tests prove pending/accepted removal, consumed-id non-resurrection, same-id rejection on one client, safe reuse on a fresh client, late/unknown completion diagnostics, and no mapping or ACP request before session publication. Form tests compile the exact schema: an undeclared extra key is accepted when not forbidden, while missing/mistyped/bounded values fail; no keyword/default/coercion is added. Roots and no permission request remain covered. |
| M8 | §3.5 | equal raw names fail as `mcp_init_error` naming the second exact configured occurrence; colliding slugs receive stable ordered suffixes. Pre-publication feature behavior is exact. Partial-open failures roll back in reverse order and use the §3.5 original-error × cleanup-result table. Real transports cover stdio raw close, HTTP GET EOF/error and request-driven-idle timeout, and legacy SSE `onerror`: only that server disables, the exact diagnostic/result/boundary behavior holds, and reconnect count is zero. Protocol-layer and stdio pipe/parser `Client.onerror` remain redacted/nonfatal; raw HTTP/SSE errors never take that branch. Post-dispose events are ignored and no state crosses sessions. |
| M9 | §3.2/§3.5 | subscribe, then new/load/resume/fork each creates a fresh connection with zero subscriptions and never auto-resubscribes, even for equal server name/URI or copied fork history. Exact before/after session branches, replay transcript, and model context prove the subscription lifecycle adds no history entry or other journal mutation; open/replay failure likewise adds no MCP journal side effect. Re-subscription occurs only through a later explicit tool call. |

### 11.2 Structured output via injection (§4)

| # | covers | assertion |
|---|---|---|
| S1 | §4.2 | `PiBackend`: injection and prompt embedding true; custom capabilities, prompt metadata, and native override absent; shared native hook is optional; native backends and common validated last-text recovery remain unchanged; provider classification unchanged |
| S2 | §4.1/§7.2 | full runner path: pi advertises `mcpCapabilities.http === true`, schema set → runner injects `StructuredOutput` http server; a mock pi turn calls `mcp__structured_output__StructuredOutput` with a conforming value → runner captures via `tryCaptured()` and returns the validated object (hermetic, credential-free) |
| S3 | §4.3/§4.4 | pi-acp server carries NO `_meta.outputSchema` consumption, NO server-side bespoke prompt splice, NO fabricated final message, NO `__acp_structured_output` tool, NO `StructuredOutputState`; `structured_tool_collision`/`invalid_output_schema` errorKinds are gone; `session/load` replays the ordinary recorded MCP/pi tool history and contains neither a fabricated final structured value nor the retired pi-acp `_meta`-derived splice (the runner's common `embedSchemaInPrompt` behavior remains under S1) |
| S4 | §10.3/§10.4 | drift/conformance: `docs-drift`, `protocol-coverage`, `pi-backend.test` pass with the amended literals; complete `SKILL.md`, complete `reference.md`, and regenerated prompt agree on Pi injection/fallback and each passes the stale-language negative scan; authoring-prompt equality/drift test is green |

### 11.3 Model config option (§5)

| # | covers | assertion |
|---|---|---|
| C1 | §5.2/§5.4 | deep-equal the complete direct ACP `SessionConfigSelect` on initial read and every successful model/thinking set echo: `{ id:"model", name:"Model", type:"select", category:"model", currentValue, options }`, after `thinkingLevel`; choices equal the credential/`filterModels` snapshot order exactly and are neither sorted, truncated, deduplicated, nor fabricated. Include empty and active-but-unlisted catalogs; absent filtered model set is `invalid_model` and cannot use unfiltered lookup. |
| C2 | §5.2 | no active model + empty catalog gives `""`/`[]`; active model gives its id; active-but-unlisted stays current while options remain the authenticated catalog, including empty |
| C3 | §5.3 | the validate probe (`config-options.md` §2.3 surface) enumerates the `model` option with its choices — the `config pi` origin incident is fixed; the runner's `assertNoModelConfigOption` guard is unaffected |
| C4 | §5.4 | advertised hit sets the exact snapshot model; absent/filtered-out value is `invalid_model`, matched auth failure is `auth_error`, busy is `session_busy`, and every success returns the complete two-option echo |

### 11.4 Error-taxonomy tripwire (§6)

| # | covers | assertion |
|---|---|---|
| E1 | §6.1 | every fixture string in `provider-error-strings.ts` classifies to its intended `errorKind` (auth/billing/rate/generic) and thence the intended `PiBackend` classification (pausable vs recoverable); both OAuth provenance sites are represented, and reconstructing the normalized no-model/no-key guidance from the pinned upstream formatters must byte-equal the complete fixtures |
| E2 | §6.2 | the guard test asserts `FIXTURE_PI_PIN` equals the installed `@earendil-works/pi-coding-agent` version — a mismatch (runtime bumped without re-capture) FAILS; the classifier precedence stays ordered (auth>billing>rate>generic) |

### 11.5 Correctness batch (§8)

| # | covers | assertion |
|---|---|---|
| A1 | §8.1/§8.3 | real tracked bash starts the leader+distinct-descendant fixture on Unix and Windows; cancel, close, failed-open rollback, and shutdown each wait until both are gone. Unix unit barriers hold leader close while group probe still succeeds/EPERM and prove settlement/record removal waits for ESRCH; Windows waits for successful taskkill plus leader close and the fixture probes descendant. `remainingChildren` counts retained group records after leader close. Fresh epoch, settings, and both spawn-race barriers are covered. |
| A2 | §8.1/§8.3 | two concurrent sessions each own a leader+descendant tree: cancelling A kills both A PIDs while both B PIDs remain alive until B closes; no global kill or cross-session registry state |
| A3 | §8.2/§9 | cleanup failures return the narrow exact `child_cleanup_error` wire shape and retain records. Repeated close covers retries. Top-level `PiAcpAgent.dispose()` covers concurrent join, fail→success, fail→fail, and post-success no-op; non-child Pi/MCP promises run once while abort/tree termination/liveness retries. Aggregate remaining group count is exact and no forbidden detail type compiles. |
| A4 | §3.5/§8.2 | for each new/load/resume/fork, cross every representative original open outcome (`-32800`, `mcp_init_error`, `extension_setup_error`, replay/other error) with child/Pi-abort cleanup success/failure. Success preserves original; failure returns only child cleanup. Load/resume retry by known id close; unpublished new/fork records retry only through top-level dispose. Every case drains leader+descendant, starts reverse-acquisition wrapper closes concurrently, attempts HTTP termination, and proves fail→retry ownership. Replacement and subprocess/66,000-ms shutdown assertions remain. |

### 11.6 Live e2e (gated on provider keys)

| # | covers | assertion |
|---|---|---|
| L1 | §3.4/§8 | one cheap-model leg: attach a real http MCP server to a pi agent and round-trip a tool; run a `sleep 180` bash turn and stop it, asserting the child is reaped. Gated on an env key; skipped in credential-free CI (per the existing live-suite gate). This EXTENDS, never replaces, the hermetic net. |

### 11.7 Contract and freshness gates

| # | covers | assertion |
|---|---|---|
| R1 | §0/§1/§13 | Source quotes byte-match focus §0; base file equals `78944e3462458de30c4989ff04894fecbf43632d`; implementation records fresh GitHub/npm latest values, tag commits, and release→main cited-surface diffs before code |
| R2 | §10/§13 | docs/protocol/backend/authoring drift suites pass; every referenced local and fresh-clone path exists and every cited line range contains the named symbol or literal |
| R3 | §10.4/§10.5 | whole-file static assertions cover root `README.md`, `docs/api.md`, `docs/design-notes.md`, `packages/workflows/README.md`, `packages/pi-acp/README.md`, `packages/acp-agents/README.md`, `docs/specs/acp-auth-spec.md`, both skill inputs, and generated prompt. All current guidance agrees on stdio/HTTP/SSE, injected structured tool/common fallback, filtered model catalog, client-hosted `acp`, and no Pi private `_meta` namespace; stale-language scans cover every complete non-changelog file. The acp-auth executable matrix test remains green. |

### 11.8 Compatibility and release (§15)

| # | covers | assertion |
|---|---|---|
| REL1 | §15 | the Changesets entry declares minor `pi-acp`, minor `acp-agents`, patch `workflows`, and patch `mcp-server`; no workflow-engine/shared-types bump is introduced; packed/published manifests resolve the coordinated new internal versions after `pnpm version` + `pnpm pack` |
| REL2 | §15 | installed-package smoke runs `npx @automatalabs/workflows@0.38.2 config pi`, the HTTP MCP + injected-structured fixture, tarball/private-channel absence checks (including packed `acp-agents/README.md`), repository release-doc scan of `docs/specs/acp-auth-spec.md`, and generated-authoring-prompt assertion exactly as pinned |

---

## 12. Non-goals (with rationale)

**Source trace:** the recorded owner decision forbids narrowing the stable base protocol. These exclusions
are only surfaces that are not server transports, do not exist in pi, or are not part of the pinned
stable base; each rationale explains why it does not defer a requested deliverable.

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
- **12.5 Other backend behavior.** Claude/Codex/OpenCode/custom retain their current native structured
  overrides and results; only the shared member becomes optional so Pi can remove its override (§4.2).
  The built-in backend registry architecture is unrelated to issue #224.
- **12.6 Serving the `acp` MCP transport from pi-acp.** The `acp` transport is client-hosted (the client
  proxies MCP over the ACP connection); pi-acp is the AGENT and does not host it — `acp` stays rejected
  with `unsupported_mcp_transport`. This is not a narrowing of "all transports": the owner's "all
  supported MCP protocol transports" for a workflow-attached server means stdio/http/sse (the server the
  author provides); `acp` is a client-side hosting mode, not a server the author passes.
- **12.7 Experimental MCP tasks.** The pinned SDK exposes task helpers only under its experimental
  protocol surface; MCP tasks are not part of the stable base protocol promised by the owner. They are
  excluded to avoid advertising a protocol the pinned stable client does not advertise. Any future
  product decision to adopt experimental MCP is a separate compatibility contract.
- **12.8 Optional sampling context/tool sub-capabilities.** The base `sampling/createMessage` feature is
  fully served, including stable user/assistant text/image/audio through §3.4's payload bridge. Only
  separately negotiated context/tool extensions are unadvertised because pi's completion API cannot
  honor them faithfully; accepting them would be false capability advertising.
- **12.9 Adapter resource limits.** No opt-in switch, server/tool/page count limit, response truncation,
  or sampling token ceiling is introduced. Limits required by MCP schemas, provider context windows,
  pi's existing tool-output representation, and the existing request timeout are protocol/runtime
  behavior, not adapter caps.
- **12.10 Unserved-by-design ACP surfaces.** providers/*, logout, session/delete, set_mode stay unserved
  (issue #224 Non-goals; pi-acp spec §11).
- **12.11 Opaque third-party extension subprocesses.** The adapter cannot reap a process that an
  arbitrary user extension launches without exposing a PID/child handle through any pi seam. The
  adapter does reap every process group launched by its tracked core-`bash` fallback when no supported
  configured `bash` override wins, and it cancels remote MCP calls through the protocol; claiming
  ownership of a configured extension's hidden process would both break Pi's extension semantics and be
  unverifiable and would invite unsafe broad process killing.
- **12.12 Automatic resource re-subscription after load/resume/fork.** A replayed `Subscribed to …`
  result does not prove that a fresh server process has the same identity, authorization, resource
  semantics, or current user intent. Silently replaying the side effect could subscribe the wrong peer
  and would turn history into authority. A fresh client simply starts unsubscribed; no durable reset
  marker/history mutation is added, and a new explicit `subscribe_resource` call is required.
- **12.13 Rewriting historical changelog entries.** Existing `CHANGELOG.md` entries accurately describe
  the behavior of their old package releases and remain immutable history; converting them into present
  tense would make those releases' records false. Whole-file stale-guidance assertions target current
  README/docs/skill/generated-prompt surfaces and explicitly exclude changelogs.

Nothing else is deferred; every deliverable of §2.2 is specified in full above.

---

## 13. References (verified `file:line` + version pins)

**Source trace:** the owner's “built on its sdk” and “whole base protocol” requirements make exact pi,
MCP, and ACP seam verification normative; the focus freshness directive requires the release/main risk
record and implementation-time stop gate.

**Base commit (this repo), all `packages/…`/`scripts/…`/`docs/…`/`skills/…` citations verified against:**
`78944e3462458de30c4989ff04894fecbf43632d` (branch `spec/pi-mcp-train`, based on `origin/main`; matches
`.agentprism/design-224/base-sha.txt`).

**Base-freshness note (verified in the round-3 fresh check at `2026-07-17T06:29:19Z`):** `origin/main`
equals that SHA. The worktree's earlier draft commit is not a citation base; every local reference below
was re-read from the pinned base with `git show 78944e3:<path>` or verified unchanged in the working tree.
Package versions at the base are
`@automatalabs/pi-acp@0.1.3`, `@automatalabs/acp-agents@0.30.1`, and
`@automatalabs/workflows@0.38.1`.

**External-freshness note:** round 3 created three new temporary clones under a fresh `mktemp`
directory, completed their initial fetch/latest checks before substantive editing, and at
`2026-07-17T06:28:55Z` re-fetched tags and `origin/main` and re-queried every GitHub/npm latest value
immediately before freeze. GitHub
latest, npm latest, exact tag commit, and release-to-main diffs were resolved independently. Every
citation below was checked at the exact release tag. No prior checkout was reused. The pins, main refs,
ahead/behind counts, and cited-surface diffs below remained unchanged in that final check.

**pi source, all `packages/{ai,agent,coding-agent}/…` citations verified against:** repo
`github.com/earendil-works/pi`, tag **`v0.80.10`**, commit
**`8dc78834cde4e329284cf505f9e3f99763df5529`**; npm `@earendil-works/pi-coding-agent@0.80.10` (lockstep
with `@earendil-works/pi-agent-core@0.80.10`, `@earendil-works/pi-ai@0.80.10`). Freshness re-checked at
authoring: `gh api repos/earendil-works/pi/releases/latest` = `v0.80.10`, `npm view … version` = `0.80.10`
— pin is current. **Forward-compat risk note:** upstream `main` is at `216e672e7c9fc65682553394b74e483c0c9e47f7`,
exactly **one** unreleased commit ahead of the tag; `git diff v0.80.10 216e672 --` over every pi surface
this contract cites is empty. The repo-wide name-only diff contains only the five package
`CHANGELOG.md` files, so no cited source/test seam has unreleased drift. The §1 re-verification clause
obligates re-running this before building.

**MCP SDK source**, fresh clone of `github.com/modelcontextprotocol/typescript-sdk`, tag **`v1.29.0`**,
commit **`e12cbd7078db388152f6e839abdbe09ba01f3f32`**; npm
`@modelcontextprotocol/sdk@1.29.0`. GitHub latest and npm latest both resolved to `1.29.0` this round.
**Forward-compatibility risk:** upstream main
`e81758caed29f6568ce8873f7f9a3bd65b017d9c` and the release tag have diverged, with **276 main-only
commits and 38 tag-only commits** (`git rev-list --left-right --count v1.29.0...origin/main` =
`38 276`; neither ref is an ancestor of the other). The release→main diff deletes the
cited release files `src/client/{index,sse,stdio,streamableHttp}.ts`,
`src/server/{index,sse,stdio,streamableHttp}.ts`, `src/shared/{protocol,transport}.ts`, and `src/types.ts` as
well as `src/validation/ajv-provider.ts` as part of the in-progress next-major package split;
`package.json` also changes. This is a
material seam risk even though v1.29.0 remains latest, and §1 requires stop-and-report if it lands.

**ACP SDK source**, fresh clone of `github.com/agentclientprotocol/typescript-sdk`, tag **`v1.2.1`**,
commit **`26da1ae7ab66fae0f5e77272dee3e5d562d24aee`**; npm
`@agentclientprotocol/sdk@1.2.1`. GitHub latest and npm latest both resolved to `1.2.1` this round.
Upstream main `76da0322243549ee6122ddf62cb1392537991c43` is one commit ahead; its only diff is
`package-lock.json`, with no cited source change. Both SDK dependencies in `packages/pi-acp` stay
exact-pinned; re-verify all three upstreams under §1 before implementation.

### This repo (base `78944e3`)

- `packages/pi-acp/src/mcp-bridge.ts` — `bounded` :40-57, `connectDefaultMcpClient` (stdio; orphan-child
  close on failed connect) :59-126, typed-server hard-reject :214-216, paginated `tools/list` + cycle
  guard :240-256, five-member content + `structuredContent` projection :150-183, `isError` failed-result
  handling :286-290, `bridgeMcpServers` :205-302, `disposeMcpBridge` :304-306.
- `packages/pi-acp/src/agent.ts` — `initialize` `agentCapabilities` (`mcpCapabilities: {}` :81, `_meta`
  namespace :83) :70-87, current manifest-backed `PKG_VERSION` :30-32,
  `createAgentSession({ customTools:[…bridge.tools, structured.tool] })` :146-151,
  post-construction alias/structured-tool presence check :166-173, current close swallows disposal
  failure and always returns `{}` :378-393, tombstone/live gate :396-400, `dispose()` all-settled sweep
  :427-436.
- `packages/pi-acp/src/index.ts` — 5-second process-shutdown envelope and connection-close/SIGTERM/
  SIGINT delegation to `agent.dispose()` :17-51.
- `packages/pi-acp/src/session.ts` — `configOptions()` (thinkingLevel-only) :117-119, `_meta.outputSchema`
  consume + `structured.arm` + prompt splice :313-326, fabricated final `agent_message_chunk` :275-279,
  turn-abort listener calls `this.pi.agent.abort()` :366-374, `cancel()` :396-398, `dispose()` :400-409,
  `disposeResources()` (→ `pi.dispose()`) :411-434; ordered notification queue/pump/failure/drain
  :121-155 and active-turn `notification_error` settlement :195-201.
- `packages/pi-acp/src/config.ts` — `thinkingLevelOption` :8-17, `applyConfig` (accepts `"model"`, echoes
  `[thinkingLevelOption]`) :19-52.
- `packages/pi-acp/src/errors.ts` — `ErrorKind` union (incl. `structured_tool_collision`,
  `invalid_output_schema`) :3-27, labels :29-54, `INVALID_KINDS` :56-72, `adapterError`'s
  current narrow redacted-diagnostic extras and auth/invalid/internal constructor selection :93-103,
  `classifyPreflight` (prose
  regex) :105-116, `classifyTerminal` (auth/billing/rate regex, ordered) :118-140.
- `packages/pi-acp/src/structured-output.ts` — `STRUCTURED_TOOL_NAME` + `StructuredOutputState`
  (arm/capture/disarm) :5-74 (deleted by §4.3).
- `packages/pi-acp/src/deps.ts` — `PiAcpDeps` (`connectMcpClient` :25, `modelRuntime` :23, `mcpTimeoutMs`/
  `graceMs` :27-28), `graceMs` default 5,000 :66, `resolveDeps` default `connectMcpClient` :68-71,
  `DEFAULT_REQUEST_TIMEOUT_MSEC` default :11,51.
- `packages/pi-acp/src/replay.ts` — replay projection (no fabricated message) :47-126.
- `packages/pi-acp/src/translate.ts` — pi `tool_execution_update` → ACP `tool_call_update` currently
  drops partial details :95-101; the end row's `details` → `rawOutput` precedent :102-110.
- `packages/pi-acp/src/permissions.ts` — permission wrapping is tool-name based and delegates to the
  prior hook :23-81 (so the `bash` override retains the existing approval path).
- `packages/pi-acp/test/matrix-gaps.test.ts` — stdio bridge fakes + error-shape table :24-101,328-458
  (extended by §7).
- `packages/pi-acp/package.json` — deps `@modelcontextprotocol/sdk 1.29.0`, `@agentclientprotocol/sdk
  1.2.1`, `@earendil-works/pi-coding-agent 0.80.10` (exact, no caret) :50-59; `version 0.1.3` :2-3.
- `packages/acp-agents/package.json` — `version 0.30.1` :2-3 and workspace dependency on pi-acp :44-50;
  `packages/workflows/package.json` — `version 0.38.1` :2-3, CLI bin :16-18, and workspace dependency
  on acp-agents :47-51; `packages/mcp-server/package.json` — `version 0.15.1` :2-3 (§15 release graph).
- `.changeset/config.json` — public independent package releases and patch internal-dependency update
  policy :1-10; `CONTRIBUTING.md` — Changesets commands and release transaction :97-111.
- `packages/workflow-engine/src/workflow.ts` — `WorkflowAgentOptions.mcpServers?: McpServerConfig[]`
  (additive, past the resume hash) :330-337.
- `packages/shared-types/src/mcp-config.ts` — `McpServerConfig` union (stdio/http/sse/acp), `McpNameValue`,
  identity note (not hashed) :1-67.
- `packages/acp-agents/src/capabilities.ts` — `unsupportedMcpServer` (stdio always serviceable; http/sse
  gated once `mcpCapabilities` exists; acp strict) :278-300, `negotiateCapabilities` :91-117.
- `packages/acp-agents/src/acp-client.ts` — elicitation declines unknown/unregistered sessions
  :522-540; `openReadySession` waits for `session/new` and registers the returned id only afterward
  :1561-1594 (grounds the pre-publication decline contract).
- `packages/acp-agents/src/backends/pi.ts` — `injectStructuredOutputTool = false` :30, `embedSchemaInPrompt
  = false` :29, `customCapabilities` :31-34, `classifyProviderError` (`rate_limit`/`billing_error` →
  `provider_usage_limit`) :36-55, `spawnConfig` bin ladder :57-73, `promptMeta` :79-82, `nativeStructured`
  :84-86.
- `packages/acp-agents/src/backends/opencode.ts` — `embedSchemaInPrompt = true` :28,
  `injectStructuredOutputTool = true` :29, `promptMeta` :61-66, `nativeStructured` :68-72 (parity target).
- `packages/acp-agents/src/backend.ts` — required `nativeStructured` backend member at base :110
  (made optional by §4.2).
- `packages/acp-agents/src/runner.ts` — `shouldInjectStructuredOutputTool` :1397-1403 →
  `supportsStructuredOutputToolTransport` (`mcpCapabilities.http === true`) :1405-1407, injection into
  `session.mcpServers` :822-833, `resolveStructuredOutput` call (`tryCaptured`/`tryNative`) :947-967,
  `availableMcpServerName` :1409-1418, `assertNoModelConfigOption` :1430-1440, `selectBackend`/
  `resolveModelRoute` :1445-1476, `builtinBackend` (`new PiBackend()`) :1449-1460.
- `packages/acp-agents/src/structured-tool.ts` — `STRUCTURED_OUTPUT_TOOL_NAME`/`_SERVER_NAME` :24-25,
  `StructuredOutputToolHost` (localhost Streamable-HTTP host) :51-135, `register`/`tryCaptured`/`release`
  :65-87, capture handler :199-210.
- `packages/acp-agents/src/structured-output.ts` — `StructuredSession` native/captured/last-text seams
  :94-104 and resolution order :125-149.
- `packages/acp-agents/src/protocol-coverage.ts` — `PI_ACP_PROTOCOL_CONTRACT` :159-172.
- `packages/acp-agents/test/docs-drift.test.ts` — pi-acp spec drift assertions (`_meta` namespace :87,
  `{ outputSchema: true }` :88, `mcpCapabilities: {}` :89, authMethodIds :90-91, errorKinds :93-94).
- `packages/acp-agents/test/protocol-coverage.test.ts` — `PI_AGENT_DIST.includes(outputSchemaKey)` :147,
  `includes("mcpCapabilities: {}")` :148.
- `packages/acp-agents/test/pi-backend.test.ts` — `embedSchemaInPrompt`/`injectStructuredOutputTool`/
  `customCapabilities` pins :40-44, `promptMeta` :78-79, `nativeStructured` :83.
- `packages/acp-agents/README.md` — stale public export description calling Pi a native plain-JSON-
  Schema channel :233; `packages/acp-agents/test/docs-drift.test.ts` reads the implemented auth spec's
  full `_meta` matrix and checks it against executable data :38-55.
- `scripts/check-acp-deps.mjs` — `ACP_DEP_MATCHERS` (matches `@earendil-works/pi-coding-agent`) :40-43,
  `WRAPPED_RUNTIMES` :68.
- `CONTRIBUTING.md` — dependency gate and bump runbook :60-81.
- `skills/agentprism-workflow-authoring/SKILL.md` — contradictory Pi-native structured-output prose
  (including no prompt embedding/no MCP injection) :153.
- `skills/agentprism-workflow-authoring/reference.md` — structured-output backend table (Pi row) :83-89,
  pi-acp bin fallback :301, pi auth :498, harness routing/probe :50-52,568.
- `scripts/generate-authoring-prompt.mjs` — reads both skill inputs :30-43, concatenates both into the
  generated output :103-113, exact-marker rewrite + missing-marker throw :7,20-24.
- `packages/mcp-server/src/generated/authoring-prompt-content.ts` — generated source marker and
  published `AUTHORING_PROMPT_CONTENT` export :1-6.
- `packages/mcp-server/test/authoring-prompt.test.ts` — generated-source equality and exact regeneration
  command :5-17.
- `README.md` — obsolete claim that Pi uses native `_meta.outputSchema` rather than MCP injection :402;
  `docs/api.md` — known obsolete Pi native-structured description :892 and stdio-only capability status
  :1078; `docs/design-notes.md` — known obsolete Pi-native/stdio-only claims :193,229,418,434,460-471,
  660-713; `packages/workflows/README.md` — obsolete Pi-native structured-output summary :700;
  `packages/pi-acp/README.md` — obsolete native channel :22, reserved tool
  names :41, and stdio-only limitation :45. §10.5 requires whole-file scans because these anchors are
  not an exhaustive audit boundary.
- `docs/specs/pi-acp-spec.md` — §5 capabilities :502-566, §5.1 config-surface rationale :568-595, §5.2
  set-config state machine :597-661, §9.1.6 close-always-success/tombstone rules :1315-1348, §9.3 MCP
  bridge :1457-1585, §9.4 structured output :1587-1658, §8 error taxonomy :914-1100, §9.6 cancellation
  :1717-1772, T15 close behavior :1966-1968, §13 test plan :1937-2000, §14 references :2002-2307.
- `docs/specs/acp-auth-spec.md` — current/implemented full `_meta` matrix and stale Pi private-
  structured-namespace claim :1050-1055 (amended to no Pi private namespace by §10.5).
- `docs/specs/config-options.md` — probe API §2.2, validate-time surfacing + select-choice check §2.3
  :54-107.

### `@earendil-works/pi-coding-agent@0.80.10` / `@earendil-works/pi-agent-core@0.80.10` / `@earendil-works/pi-ai@0.80.10` (commit `8dc7883`)

- `packages/coding-agent/src/core/sdk.ts` — `CreateAgentSessionOptions` (`modelRuntime?` :39, `customTools?`
  :68, **`resourceLoader?` :71**, `sessionManager?` :74, **`settingsManager?` :76**) :33-80,
  `CreateAgentSessionResult` :83-91,
  injected loaders are not automatically reloaded :165-180, `new AgentSession({ …, customTools,
  resourceLoader-via-services, … })` :371-385.
- `packages/coding-agent/src/core/agent-session.ts` — private `_customTools` :326,362, `getActiveToolNames`
  :887-889, `getAllTools` :894-902, `getToolDefinition` :904-906, `setActiveToolsByName` ("Changes take
  effect on the next agent turn") :912-926, `get model(): Model|undefined` :854, extension-API bindings
  (`registerTool`→`refreshTools`→`_refreshToolRegistry`) :2373-2376, `_refreshToolRegistry` (composes
  `getAllRegisteredTools()` + `_customTools`, activates newly-appeared tools) :2430-2521, construction
  `_refreshToolRegistry` :2571-2574, `async abort()` (`abortRetry`+`agent.abort`+`waitForIdle`) :1530-1533,
  `abortBash()` :2771-2772, `_bashAbortController` :318, `dispose()` (`abortRetry/Compaction/BranchSummary/
  Bash`+`agent.abort`) :825-830, tool execution update forwarding :754-770, `setModel` :1566-1580,
  `setThinkingLevel` :1630-1640, and the two exact OAuth re-authentication message sites :411-419,
  1170-1182.
- `packages/coding-agent/src/core/extensions/loader.ts` — `refreshTools` no-op pre-bind (comment "valid
  during extension load; refresh needed post-bind") :189-190, `createExtensionAPI.registerTool`
  (`extension.tools.set` + `runtime.refreshTools()`) :237-244, `loadExtensionFromFactory` :472-483.
- `packages/coding-agent/src/core/extensions/runner.ts` — `getAllRegisteredTools` (first-per-name)
  :422-433, `getToolDefinition` :435-443, ordered/threaded `before_agent_start` handlers :1040-1088.
- `packages/coding-agent/src/core/extensions/types.ts` — `ExtensionFactory`/`InlineExtension`
  :1474-1483, `ExtensionAPI.registerTool` (no `unregisterTool`) :1219-1221, tool-registration API surface
  :1210-1245, `RegisteredTool` :1488-1491, `ToolDefinition.execute` signal + `onUpdate` :438-473,
  `before_agent_start` system prompt input/result :685-695,1081-1084.
- `packages/coding-agent/src/core/resource-loader.ts` — `ResourceLoader` interface, including `reload` :38-48,
  `DefaultResourceLoaderOptions.settingsManager`/`extensionFactories` + public `extensionsOverride`
  :122-140, `DefaultResourceLoader` retains the supplied settings instance :214-223, construction
  :214-236, override application :404-414, inline-factory load and
  append :517-527, inline naming/loading :889-909, extension/tool source-info rewrite :684-694,
  synthetic inline source info :744-751, `getExtensions` :262.
- `packages/coding-agent/examples/extensions/built-in-tool-renderer.ts` — documented supported
  re-registration/override of built-in tools, including `bash` :1-16.
- `packages/coding-agent/src/core/model-runtime.ts` — availability refresh independently stores
  `Models.getAvailable()` and provider-auth summary :228-254; `getModels` :289-291,
  unfiltered `getModel(provider,id)` :293-295, `getAvailable` :301-316,
  `getAvailableSnapshot()` :318-320, `hasConfiguredAuth` :354-356,
  `completeSimple(model, context, options): Promise<AssistantMessage>` :479-481, `ModelRuntime.create`
  :130-165.
- `packages/ai/src/models.ts` — credential/auth checks and authenticated availability with optional
  credential-aware `Provider.filterModels` :394-408; `packages/ai/src/providers/github-copilot.ts` —
  OAuth `availableModelIds` filter :19-27 (proves catalog membership is narrower than provider auth).
- `packages/coding-agent/src/core/settings-manager.ts` — public `SettingsManager.create` :308-315,
  `getShellPath` :878-880, `getShellCommandPrefix` :910-912.
- `packages/coding-agent/src/core/auth-guidance.ts` — shared docs-path login guidance plus
  `formatNoModelSelectedMessage` and `formatNoApiKeyFoundMessage` :6-25 (ground the §6 pre-flight fixtures).
- `packages/coding-agent/src/core/tools/bash.ts` — timeout validation :24-37,
  `createLocalBashOperations` streaming/signal/timeout/cleanup algorithm :82-147, spawn context gets pi's
  environment :150-160, `createBashToolDefinition` with pluggable operations and settings :291-312,
  operation receives prepared command/cwd/env/signal/timeout :397-405.
- `packages/coding-agent/src/index.ts` — public `getAgentDir` export :8, loader exports :185-186,
  settings-manager exports :241-249, public bash operations/definition exports :263-274, and
  `getShellConfig` export :394.
- `packages/coding-agent/src/core/exec.ts` — `execCommand` spawn + SIGTERM→SIGKILL `killProcess`,
  abort-signal wiring :5,41-70,89-104.
- `packages/coding-agent/src/utils/shell.ts` — `trackDetachedChildPid`/`untrackDetachedChildPid`
  :182-187, `killProcessTree` (process-**group** SIGKILL `process.kill(-pid, "SIGKILL")`) :200-219 (§8.1).
- `packages/agent/src/agent.ts` — `Agent.abort()` (`activeRun.abortController.abort()`) :310-311,
  `get signal()` :304-307, `waitForIdle` :319, busy-throw `prompt` :335-348.
- `packages/agent/src/types.ts` — `AgentToolResult` content/details contract and update callback
  post-settlement behavior :349-370.
- `packages/agent/src/agent-loop.ts` — run `signal` threaded through `runLoop`→`executeToolCalls`→
  `executePreparedToolCall(prepared, signal, emit)` :159,214,417-537, `tool.execute(id, args, signal, …)`
  :677-679.
- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` — `execute` forwards signal and
  update callback :16-17,43 (§3.2/§8.1).
- `packages/ai/src/types.ts` — `KnownApi` ten-value union :16-28; completion options including final-body
  `onPayload` :113-188; image plus Pi `UserMessage`/`AssistantMessage`/`ToolResultMessage` content limits
  :327-419; `Context { systemPrompt?, messages, tools? }` :450-454; `Model.input` text/image metadata
  :705-721.
- Pi's ten built-in provider dialects invoke `onPayload` immediately before dispatch in
  `packages/ai/src/api/openai-completions.ts:181-225`,
  `openai-responses.ts:119-140`, `azure-openai-responses.ts:92-113`,
  `openai-codex-responses.ts:246-267`, `anthropic-messages.ts:535-557`,
  `bedrock-converse-stream.ts:222-246`, `google-generative-ai.ts:72-94`,
  `google-vertex.ts:90-112`, `mistral-conversations.ts:60-85`, and
  `pi-messages.ts:369-391` (the exact lossless media-payload bridge seam in §3.4).
- `packages/ai/src/api/google-shared.ts` — Google request `Content` preserves user role plus
  `inlineData { mimeType, data }` :91-125 and model role/ordered parts :126-175 (the all-base-media
  dialect fixture; the adapter inserts the same typed `inlineData` part for assistant media).
- `packages/ai/test/retry.test.ts` — pinned terminal fixture strings :40-56;
  `packages/ai/src/api/pi-messages.ts` — exact 401 response-message formatter :124-144;
  `packages/ai/test/pi-messages.test.ts` — 401 token-expired/unauthorized fixture :177-191;
  `packages/ai/test/error-body.test.ts` — exact formatted 403 fixtures :129-146.
- `packages/coding-agent/src/core/session-manager.ts` — `getCwd()`, `getSessionId`/`getSessionFile`
  :926-944 (§3.4 roots + fork), and branch traversal/replay source :1184-1198. The absence of any MCP
  reset append is intentional (§3.2).

### `@modelcontextprotocol/sdk@1.29.0` source (tag/commit above)

- `src/client/index.ts` — capability registration :313-324; validated elicitation and sampling handlers
  :326-470 (the elicitation wrapper validates only the general result and optionally applies defaults,
  not accepted content against the request's dynamic schema); connect options apply to initialize after transport start, plus initialized notification
  before configured list handlers
  :483-529; server capabilities/version/instructions and guards :537-608 (including the missing
  `resources.unsubscribe` sub-capability check at :573-586); ping, completion, logging,
  prompt, resource, subscription methods :688-725; tool call/list plus per-list validator-cache reset
  :729-842; list-changed handler
  :845-902; roots-changed :905-906.
- `package.json` — public AJV validator export :42-46; `src/validation/ajv-provider.ts` —
  `AjvJsonSchemaValidator` implementation and `getValidator` :36-97.
- `src/client/streamableHttp.ts` — default/configurable reconnect policy :6-12,49-75,145-155;
  optional GET/405 behavior :206-247; zero-retry-relevant scheduling and SSE EOF/error paths
  :271-409; explicit close-only `onclose` :442-449; common headers/POST :182-224,466-475;
  initialized starts GET :558-566; public DELETE termination (no id no-op, 405 accepted, id cleared,
  other errors surfaced) :612-652. `src/client/sse.ts` — legacy transport/options :45-89,
  EventSource/guarded fetch and raw error callback :136-169, endpoint/parser errors :175-205,
  explicit close-only `onclose` :237-241, recurring POST :243-290. `src/client/stdio.ts` — natural
  process close invokes `onclose` :141-144; explicit close :204-243.
- `src/shared/transport.ts` — header normalization/request-init merge :5-45 and the `Transport`
  lifecycle contract (`onclose` must be invoked when `close()` is called) :74-127;
  `src/shared/protocol.ts` — incoming handler signal/metadata/related notification seam :237-280,734-746;
  peer cancellation aborts that signal :550-557, aborted handlers suppress both success/error response
  and clean up their controller :728-853, protocol close aborts active request handlers :644-660;
  protocol connect installs transport callbacks and natural close clears transport, aborts handlers,
  rejects pending requests, while error only invokes the public handler :607-674; protocol `close()`
  delegates to the installed transport :942-944;
  notification invocation synchronously reaches awaited transport send :1303-1410;
  opt-in strict-capability option :60-71, 60-second default +
  `RequestOptions` :106-135, automatic ping response :366-379, strict request guard :1112-1119,
  cancellation/timeout propagation :1126-1218.
- `src/types.ts` — base request `_meta`/experimental task fields :60-94; MCP `ErrorCode` numeric pins
  :191-206; BaseMetadata Tool display-title precedence :341-355; client/server capabilities
  :475-590; progress/pagination :641-694; resource contents
  (text/blob) :814-861; resource list/update/subscription notifications :1022-1064; canonical
  content-block annotations/`_meta` plus text/image/audio/resource-link/embedded-resource union
  :1144-1278; prompt messages and
  get result :1283-1297; prompt/tool/logging notifications :1302,1511,1614-1642; Tool metadata/list
  result :1307-1439; tool result content/structured/error fields :1444-1474; sampling message `_meta`,
  request `systemPrompt`, top-level metadata, and result schemas :1694-1830 (especially
  `SamplingMessage` :1729-1737 and `systemPrompt` :1742-1751), including the human-review
  recommendation :1784-1789;
  elicitation primitive schemas (including string formats/length but no `pattern`, numeric bounds,
  single/multi-select enums) :1848-1976, request/completion/result :1978-2084; completion request/result
  :2086-2181.
- `src/server/index.ts` — server-originated form elicitation validates accepted content against the
  dynamic requested schema with the configured JSON-schema validator :550-603 (precedent for §3.4).
- `src/server/stdio.ts:12-92`, `src/server/streamableHttp.ts:70-207`, and `src/server/sse.ts:48-229` —
  real server transports used by the hermetic conformance matrix.

### `@agentclientprotocol/sdk@1.2.1` source (tag/commit above)

- `src/schema/index.ts` — client method literals `elicitation/create` and `elicitation/complete`
  :300-314.
- `src/schema/types.gen.ts` — form/URL `CreateElicitationRequest` :863-909, session scope :911-949,
  form/URL payloads :1330-1370, `ElicitationSchema`/property union :952-1031, string constraints including
  `pattern`/format/enum/oneOf :1066-1119, completion notification :4280-4302;
  `McpCapabilities` http/sse/acp fields :1711-1732; `SessionConfigSelect` string current value + options
  :2969-2981; `CreateElicitationResponse` actions and accepted content :6124-6188.
- `src/acp.ts` — typed elicitation request spec :1349-1355, client dispatch for create/complete
  :2567-2575, connection methods :2770-2794, and optional client handlers :3831-3846. ACP marks these
  methods experimental at 1.2.1; this contract pins them and §1 makes any change stop-and-report.
- `src/jsonrpc.ts` — `RequestError.invalidParams` `-32602`, `internalError` `-32603`, and
  `authRequired` `-32000` constructors :1290-1341.

---

## 14. Rejected alternatives (with rationale)

**Source trace:** these are the implementation choices considered while serving the owner quotes and
FULL-scope decision. Each rejection prevents either false advertising, a narrowed protocol, or an
unverifiable correctness claim.

1. **Private-field tool mutation for `tools/list_changed`** (`_customTools` + `_refreshToolRegistry`).
   Rejected: both are `private` (`agent-session.ts:326,2430`); mutating them is illegal TypeScript,
   unsupported, and breaks on any pi refactor. The inline-extension seam (§3.3) is pi's sanctioned public
   path and survives refactors. (Non-goal 12.1.)

2. **Move one combined MCP/instructions/bash extension ahead of all configured extensions, or use only
   name-presence checks.** Rejected: global reordering changes ordered hooks/flags/renderers and steals
   Pi's supported configured `bash` override. Name presence also cannot prove a reserved alias winner.
   The split design moves only the reserved `mcp__` registration extension first, leaves the control
   extension normally appended, and source-verifies each intended winner (§3.3/§8).

3. **Keep `customTools`; document `tools/list_changed` as unsupported (static tool set).** Rejected: a
   real public seam exists (inline extensions, §3.3 investigation), and the owner's directive is to
   "support the whole base protocol … wiring it in to the seams" (quote 3). Choosing a documented
   limitation when a real seam exists would narrow WHAT, which §0 forbids.

4. **Keep the bespoke `_meta.outputSchema` channel and additionally serve HTTP MCP.** Rejected: owner
   quote 4 directs the OpenCode-style injection ("just pass the structured output mcp server to pi …
   it would work just like any ACP agent that doesn't have native structured outputs"). Keeping the
   bespoke channel leaves the fabricated-message, history-splice, and replay-fidelity findings unresolved;
   the directive is resolution BY REMOVAL (§4). Two channels also risks double-capture ambiguity.

5. **Advertise a hardcoded "representative" `model` list.** Rejected explicitly by the frozen §5.1
   rationale (a partial list "would mislead the validate probe") — and this spec agrees. The fix
   advertises pi's REAL configured catalog (`getAvailableSnapshot()`), which is truthful and fixes the
   `config pi` incident (§5.1). A hardcoded list would reintroduce exactly the objection §5.1 raised.

6. **Advertise ALL builtin models (`getModels()`) regardless of auth.** Rejected: that lists models the
   user cannot actually select (unauthenticated providers), misleading the probe and every `set` attempt
   into `auth_error`. `getAvailableSnapshot()` (authed providers only) is the truthful surface the owner's
   `config pi` use-case needs.

7. **Let MCP `modelPreferences` select another configured model.** Rejected: preferences are advisory,
   and an attached server must not change the workflow author's provider, cost, or data-routing choice.
   Sampling always uses the active session model (§3.4); a fresh/global model could also be
   unauthenticated or inconsistent with the run.

8. **Overload `session/request_permission` for MCP elicitation.** Rejected: ACP 1.2.1 has a native
   `elicitation/create` method (`src/schema/index.ts:300-314`) designed exactly for structured user input; the
   permission seam is for tool approval (allow/deny), a different shape. Routing elicitation to its native
   ACP method (§3.4) is the correct wiring the owner named ("routed through the ACP session's
   elicitation/permission seam" — elicitation first, permission is the tool-approval sibling).

9. **Fix the turn-abort leak only by replacing raw `Agent.abort()` with `AgentSession.abort()`.** Rejected:
   raw abort already fires the run signal used by bash; session abort adds retry cancellation and idle
   waiting but does not independently prove process death. Adapter-owned per-session PID tracking closes
   the observed guarantee and supports isolation/failure tests (§8).

10. **Solve the error-taxonomy fragility by replacing prose regex with structured provider codes.**
   Rejected: pi's exposed seam is prose (`errors.ts` consumes message text), so inventing structured
   provider codes in this adapter would still depend on the same strings. The fixture tripwire (§6)
   makes a silent downgrade impossible at the real seam — matching issue #224's
   deliverable 4 exactly ("fixture-pinned classifier tests … so a silent downgrade fails loudly").

11. **Append an active-but-unauthenticated model to catalog choices.** Rejected: choices must mean
    selectable now. The active id remains truthful `currentValue`, while choices remain exactly the
    authenticated snapshot (§5.2); fabricating membership would recreate the frozen spec's objection.

12. **Drop MCP progress because ACP has no MCP-progress object.** Rejected: pi tools already expose
    `onUpdate`, and pi-acp already translates tool execution updates to ACP `tool_call_update`. Mapping
    onto that existing seam preserves the stable protocol signal without inventing a wire extension.

13. **Cache resource/prompt listings and refresh only on notifications.** Rejected: list-changed
    notifications are optional and can race. Synthetic tools fetch live on every call; notifications
    remain observable diagnostics. This gives correct state without a stale-cache policy.

14. **Require an ACP permission round-trip for every sampling request.** Rejected: MCP recommends
    client-side human review but defines no sampling-specific approval wire exchange
    (`src/types.ts:1784-1789`). The workflow author already authorized sampling by attaching the server;
    overloading ACP's tool-permission method would conflate protocols and deadlock headless workflows.
    Sampling is default-on but cannot change the active model (§3.4).

15. **Prove transport parity only with injected fake clients.** Rejected: DI tests prove adapter logic,
    not framing, headers, subprocess cleanup, or legacy SSE behavior. The same conformance transcript
    runs through all three actual SDK transports (§7.1).

16. **Add opt-in flags or adapter resource caps.** Rejected by the issue directive that everything ships
    default-on with no opt-in and no resource caps. Existing protocol validation, request timeouts, and
    provider context windows remain; the adapter introduces no new count/size/token ceilings.

17. **Pass URL elicitation ids through ACP unchanged, or scope opaque ids only to one session.**
    Rejected: MCP scopes the remote id to its server, while ACP's agent→client completion notification
    carries no session id. Process-unique opaque ids plus the server/session reverse map prevent
    cross-server and cross-session completion collisions (§3.4).

18. **Reject stable assistant images/audio globally, or stringify/caption/transcribe them.** Rejected:
    stable text/image/audio are ungated base sampling content at MCP 1.29.0; global rejection narrows the
    owner's FULL scope, while conversion would claim the LLM saw media it did not. The request-local
    `onPayload` bridge preserves role/order/MIME/bytes and reports `-32603` only for a concrete active
    model/API representation failure. Optional tool/context blocks remain separately negotiated (§3.4).

19. **Keep placeholder-only MCP content conversion or put only `structuredContent` in details.**
    Rejected: audio/blob metadata, `_meta`, page metadata, and ordinary result content would disappear.
    Canonical model-visible markers plus exact operation results/page arrays preserve every validated
    field; Tool/list definitions remain exact internal state rather than per-call duplication (§3.2).

20. **Use independent per-server prepare queues and serialize only commit.** Rejected: candidates can
    copy the same stale global alias/active snapshot and the later commit can collide or lose another
    server's delta. One session-wide prepare+commit lease, configuration-ordered batches, and latest-
    snapshot delta merges make collision suffixes and active names deterministic (§3.3).

21. **Override `bash` with the default shell and omit Pi's settings object.** Rejected: that would fix
    child ownership by silently discarding the user's configured shell path or command prefix. One
    shared public `SettingsManager` preserves Pi's existing execution semantics while the custom
    `BashOperations` adds per-session ownership only (§3.3/§8.1).

22. **Leave the MCP SDK's strict-capability option at its default.** Rejected: the SDK defines the
    server-capability guards but invokes them only when `enforceStrictCapabilities === true`
    (`src/shared/protocol.ts:1112-1119`). Enabling it adds useful defense in depth for the checks it
    implements, but it is not complete (`resources/unsubscribe` lacks the subscription sub-capability
    check); adapter conditioning remains authoritative (§3.2/§3.4).

23. **Apply a dynamic tool refresh while a prompt is starting.** Rejected: `registerTool` refreshes one
    definition at a time, so relying only on refresh-request sequencing could expose part of a
    multi-tool snapshot to a racing turn. The session-wide turn-boundary mutex makes commit and prompt
    execution mutually exclusive while preserving next-turn semantics (§3.3).

24. **Rely only on `Client.listTools()` to retain remote output schemas.** Rejected: each paginated
    `listTools()` invocation clears the SDK's validator cache before caching that page
    (`src/client/index.ts:802-842`), leaving earlier-page tools unvalidated. The adapter-owned map uses
    the SDK's same public AJV provider and is atomically replaced with tool metadata (§3.3).

25. **Import `PKG_VERSION` from `agent.ts` into the MCP bridge, or duplicate its manifest reader.**
    Rejected: agent already imports the bridge, so the former introduces a module cycle; the latter can
    drift the two initialize identities. One internal `version.ts` owns the existing logic (§3.2).

26. **Install notification handlers only after inspecting server capabilities.** Rejected: the pinned
    SDK sends `notifications/initialized` before it installs its configured list-changed handlers
    (`src/client/index.ts:521-529`), permitting an immediate conforming notification to race the setup.
    Pre-connect registration plus dispatch-time capability checks closes the gap without issuing an
    unadvertised request (§3.2).

27. **Rely on `Client.connect` request options as the only connect deadline.** Rejected: at the pin,
    `Client.connect` awaits `super.connect(transport)` before it passes those options to initialize
    (`src/client/index.ts:483-502`). The options correctly bound initialize but cannot bound transport
    start or observe a detached late rejection; §3.1 uses both the SDK options and the outer race.

28. **Discard Tool/list definitions after registration, or attach them to every remote call result.**
    Both are rejected: discarding loses schema/metadata needed for validation and refresh; attaching the
    complete catalog to every call duplicates unrelated state with no repository consumer. Retain exact
    Tool/pages internally and expose only exact `CallToolResult`; list operations expose their own exact
    pages (§3.2).

29. **Claim ownership of every process launched by arbitrary user extensions.** Rejected: pi exposes no
    process handle when an extension launches a subprocess privately, and scanning/killing unrelated
    process trees would be unsafe. The adapter owns every group launched through its tracked core-bash
    fallback while preserving configured `bash` overrides, passes cancellation to remote MCP calls, and states the unobservable case precisely in
    Non-goal 12.11.

30. **Release packages independently as each layer lands.** Rejected: a published workflows CLI that
    still resolves the old acp-agents/pi-acp pair would continue to reproduce the origin incident, and
    a regenerated authoring prompt published separately could describe unsupported behavior. The
    coordinated Changesets release in §15 keeps implementation, runtime resolution, and guidance in one
    compatible train.

31. **Fabricate token-level progress for incoming sampling.** Rejected: pi's provider-neutral
    `completeSimple` seam returns one final `AssistantMessage`, not a token stream. The related `0/1`
    request-lifecycle notifications in §3.4 are truthful and transport-independent; invented
    intermediates would misrepresent provider work.

32. **Roll back a partially-applied dynamic tool commit by re-registering the old definitions.**
    Rejected: Pi's public extension API mutates one registration at a time and exposes no unregister or
    atomic batch (`extensions/loader.ts:237-244`; `extensions/types.ts:1219-1221`). A compensating
    re-registration can itself fail and cannot prove removal of a newly-added alias. Pre-commit failures
    retain the snapshot; any post-mutation failure poison/tombstones the session so no partial candidate
    is advertised (§3.3).

33. **Queue a second prompt behind a refresh/first prompt instead of reserving synchronously.**
    Rejected: ACP already defines one in-flight turn per session, and async admission would let two
    callers both observe idle before either owns the mutex. The synchronous `idle→reserved` transition
    preserves the frozen `session_busy` contract and gives close a concrete prompt to cancel (§3.3).

34. **Drain child processes from a snapshot of registered PIDs.** Rejected: a synchronous spawn can
    occur before its PID is inserted, so shutdown could snapshot empty and report success while the
    child escapes. Spawn leases plus the `open→closing→closed` admission state make late registration
    join the active drain (§8.1).

35. **Keep close always-success and discard failed child handles at the 5-second deadline.** Rejected:
    that would knowingly report cancellation/close success while an adapter-owned process may still be
    alive and would make retry impossible. A retained cleanup tombstone returns the pinned error and
    makes repeated close an idempotent cleanup retry (§8.2), explicitly amending the inherited rule.

36. **Keep the CLI's outer process-shutdown timeout equal to the 5-second child deadline.** Rejected:
    equal deadlines race before failure collection and leave no time for the existing 60-second bounded
    MCP close. The 66,000-ms outer envelope contains the 5,000-ms child generation, the unchanged
    60,000-ms MCP bound, and a fixed 1,000-ms scheduling margin (§8.2).

37. **Restore resource subscriptions by scanning replayed `Subscribed to …` text.** Rejected: display
    text is not authoritative state and a fresh connection cannot prove peer identity, authorization,
    URI semantics, or current user intent. Each fresh client starts unsubscribed; a later explicit tool
    call can subscribe (§3.2/§12.12).

38. **Trust ACP `accept` content because the ACP type says it matches the elicitation schema.**
    Rejected: the ACP response type is only a primitive-valued record and the MCP client wrapper at the
    pin validates only the general result, not the request's dynamic schema (`src/client/index.ts:326-420`).
    Validate the server's exact dynamic schema without coercion/defaults. Augmenting it with
    `additionalProperties:false` is also rejected: the pinned validator and server helper accept extra
    keys unless the schema forbids them, so an adapter-added keyword would reject a protocol-valid
    response (§3.4).

39. **Send MCP diagnostics, including elicitation-completion failures, on a separate best-effort/stderr
    channel or ignore ACP delivery failure.**
    Rejected: a second queue can reorder diagnostics around tool updates and settlement; swallowing a
    failed active-turn notification would violate the frozen ordered/drained-delivery invariant. All
    accepted active-turn diagnostics use the existing FIFO pump, whose failure aborts and rejects the
    turn; late/outside-turn diagnostics follow the explicit stderr/suppression routes (§3.2).

40. **Update only the previously named Pi documentation lines.** Rejected: the same obsolete mechanism
    appears elsewhere in each source file and in root/workflows READMEs, while the authoring generator
    can faithfully concatenate contradictory inputs. Whole-file scans over every current guidance
    source catch semantic leftovers; changelogs alone remain historical (§10.4–§10.5/§12.13).

41. **Reopen the same child registry after a successful turn cancel, or leave it closed.** Rejected:
    reopening one object would let late operations from the cancelled epoch enter a later turn, while
    leaving it closed would make the still-live session unable to run bash again. The session slot
    compare-and-swaps a fully drained closed epoch for a distinct open epoch before cancellation
    settlement; disposal/failure never performs that swap (§8.1–§8.2).

42. **Rely on each raw SDK transport to signal `onclose` early enough for incoming-handler disposal.**
    Rejected: the protocol layer aborts incoming request-handler signals only from `onclose`, while the
    pinned stdio `close()` may return after `SIGKILL` before the process `close` event runs
    (`src/shared/protocol.ts:644-660`; `src/client/stdio.ts:204-243`). Transport-specific event timing
    cannot prove the common no-response/no-handler-outlives-session contract. The adapter's once-signalled
    wrapper fires logical close synchronously, then lets every physical transport finish under the
    existing bound (§3.1).

43. **Terminate the entire Pi session, leave stale tools active, or automatically reconnect when one
    published MCP peer dies.** Rejected: session termination breaks unrelated servers/prompts; stale
    tools advertise a dead capability; reconnect can repeat side effects and cannot restore peer identity
    or subscriptions safely. Disable only that server at the next turn boundary, retain the session, and
    require explicit ACP-session reopen for recovery (§3.5).

44. **Publish a removal/dead-server tombstone into the current in-flight turn.** Rejected: refresh and
    disable commits are serialized after the turn, so mid-turn invalidation contradicts the atomic
    snapshot. The current selected call uses its old handle and observes the remote outcome; only later
    invocations see `no longer available` (§3.3/§3.5).

45. **Allow a cancelled URL-elicitation id to be reused on the same MCP connection.** Rejected: the
    later completion carries only the remote id, not a generation, so it could complete the retry by
    mistake. Cleanup removes active state, consumes late ACP outcomes, and retains a connection-lifetime
    id tombstone; a fresh client identity may reuse it (§3.4).

46. **Queue pre-publication elicitation until `session/new` finishes or change acp-agents registration
    timing.** Rejected: waiting creates an open cycle, while early registration publishes a session whose
    construction may still fail. Both form and URL are locally declined during open with no mapping;
    after publication the full ACP route is available (§3.5).

47. **Persist a model-visible subscription-reset custom message on load/resume/fork.** Rejected: MCP
    subscriptions are connection-scoped, and a synthetic durable message would mutate history even with
    no server/prior subscription and create a new open-failure surface. Fresh clients simply start
    unsubscribed; transient tool descriptions/results provide sufficient guidance (§3.2/§12.12).

48. **Test process cleanup by checking only the direct shell PID.** Rejected: killing a group leader can
    pass while its grandchild survives. The real fixture exposes a distinct descendant and every cleanup
    path proves both leader and descendant/process group are gone, including cross-session isolation
    (§8.3/§11).

49. **Treat every `Client.onerror` as nonfatal and wait for `Client.onclose` on HTTP/SSE.** Rejected:
    the pinned HTTP/SSE transports report natural failure through raw `onerror` and reserve `onclose`
    for explicit close. The wrapper classifies raw events per transport, configures HTTP zero retries,
    and synchronously closes legacy SSE; protocol-layer errors remain the narrow nonfatal class
    (§3.1/§3.5).

50. **Add an adapter heartbeat so a Streamable HTTP server that returns GET 405 is declared dead while
    idle.** Rejected: the pinned request-driven mode exposes no ambient liveness stream, and an invented
    heartbeat adds traffic/side effects outside the base lifecycle. Passage of idle time is not failure;
    the next real operation is bounded and disables the peer on transport error/timeout (§3.1).

51. **Rely on `Client.close()` without `terminateSession()`, or close the socket before DELETE.**
    Rejected: the pinned public DELETE lifecycle method is not called by `Client.close()`. The wrapper
    logically closes first, attempts bounded DELETE (405 accepted), and physically closes in `finally`,
    preventing both live handlers and leaked server-side sessions (§3.1).

52. **Let Promise scheduling choose among abort, disposal, peer close, timeout, and completion.**
    Rejected: different schedules would change `-32800` versus init error, tool text, and refresh
    diagnostics. One settle-once precedence preserves lifecycle cancellation, suppresses peer-caused
    refresh noise, and consumes late callbacks (§3.1).

53. **Keep model set on unfiltered `getModel()` plus provider-level auth.** Rejected: credential-aware
    `Provider.filterModels` (concretely GitHub Copilot OAuth) can omit a model that the old path still
    accepts. Current availability-snapshot membership is authoritative for both choices and new sets;
    an unlisted active value remains reportable but cannot be reselected (§5).

54. **Ignore or merge MCP `systemPrompt` into the ACP session/MCP instruction prompt.** Rejected: Pi has
    an exact request-local `Context.systemPrompt` seam. Byte-for-byte forwarding (including empty) serves
    the stable field without contaminating ordinary agent instructions; absent stays absent (§3.4).

55. **Forward per-message/content `_meta` or annotations as provider metadata/prompt text.** Rejected:
    Pi messages have no equivalent and top-level sampling `metadata` is the distinct provider field.
    Promoting opaque message data would invent semantics, so those fields are explicitly ignored
    (§3.4).

56. **Inject a `completeMcpSample` test dependency capable of returning image/audio.** Rejected:
    production already uses injected `modelRuntime.completeSimple`, whose pinned `AssistantMessage`
    union cannot return those blocks. A pure mapper over the real result union tests production behavior
    without a test-only capability Pi cannot produce (§3.4/§11 M7).

57. **Preserve the original failed-open error when child cleanup also fails.** Rejected: returning
    cancellation/init/replay failure while a process may remain alive conceals the stronger broken
    guarantee. `child_cleanup_error` wins, retains a record, and known-id close or top-level dispose owns
    retry (§3.5/§8.2).

58. **Memoize a failed `PiAcpAgent.dispose()` forever under the current once gate.** Rejected: that
    strands retained children and unpublished failed-open records. Concurrent calls join, success is a
    permanent no-op, and failure permits a fresh retry of only abort/tree work (§8.2).

59. **Use `mcp_init_error` without a real configured server for global extension verification.**
    Rejected: the frozen wire shape requires `data.server`, and fabricating one breaks redaction and
    attribution. Global loader/control failures use exact no-server `extension_setup_error`; only a
    server-attributable failure uses `mcp_init_error` (§3.3/§9).

60. **Remove a child registry record after only the leader's `close`.** Rejected: descendants/process
    groups can survive their leader. Unix retains/probes PGID until `ESRCH`; Windows awaits the OS tree-
    kill completion guarantee plus leader close, and retained records drive `remainingChildren`
    (§8.1).

61. **Widen all adapter error `details` to `unknown`.** Rejected: it removes the compile-time redaction
    boundary for an owner-unrequested convenience. Kind-specific overloads grant only
    `child_cleanup_error` its integer count and retains diagnostic arrays only for their existing kinds
    (§8.2/§9).

---

## 15. Compatibility, versioning, and release contract

**Source trace:** owner quotes 1, 4, and 5 require a first-class published Pi server, the common
structured-output route, and a fixed `@automatalabs/workflows config pi` experience. A coordinated
release is the derived requirement that makes those three user-visible outcomes arrive together.

This is a default-on behavioral expansion at the ACP/MCP boundaries plus one intentional pre-1.0
removal. There is no compatibility flag and no dual bespoke/standard mode.

| package at the pinned base | required bump/target | compatibility statement |
|---|---|---|
| `@automatalabs/pi-acp@0.1.3` | **minor → `0.2.0`** | Adds HTTP/SSE and full stable MCP/client capabilities, model advertisement, and cleanup errors; removes the bespoke `_meta.outputSchema` namespace/tool contract. Direct clients that sent that private metadata must instead attach a client-hosted HTTP `StructuredOutput` MCP server. The package is pre-1.0, so this intentional contract removal ships in the minor bump. |
| `@automatalabs/acp-agents@0.30.1` | **minor → `0.31.0`** | Pi changes from a native/private structured channel to the standard injected MCP channel; making the shared native hook optional is source-compatible for existing implementers and preserves every other backend. |
| `@automatalabs/workflows@0.38.1` | **patch → `0.38.2`** | Republishes the CLI/runtime dependency edge so `config pi` and workflow Pi runs resolve the new acp-agents/pi-acp behavior rather than the old workspace-published dependency set. No workflow schema or resume identity changes. |
| `@automatalabs/mcp-server@0.15.1` | **patch → `0.15.2`** | Publishes the regenerated authoring prompt that describes Pi's HTTP/SSE and standard structured-output behavior. |

`@automatalabs/workflow-engine` and `@automatalabs/shared-types` receive no bump because their existing
public MCP union/agent option already carries the required values and this train changes no source in
those packages. The implementation PR MUST add one Changesets entry declaring the four bump levels
above. Release automation publishes them from the same Version Packages transaction; implementation
must verify the published `@automatalabs/workflows` manifest resolves the new acp-agents release and
that the published acp-agents manifest resolves the new pi-acp release. No package is announced as the
issue #224 release until all four are present and the post-publish smoke checks pass:

1. `npx @automatalabs/workflows@0.38.2 config pi` exposes both `thinkingLevel` and `model` under §5.
2. A Pi workflow using an HTTP MCP fixture completes a tool call and a schema'd call captures through
   the injected `StructuredOutput` host under §7.2.
3. Installed tarball/manifest inspection contains no Pi `_meta.outputSchema` namespace or
   `__acp_structured_output` tool; packed `@automatalabs/acp-agents` README describes Pi's injected
   route; repository `docs/specs/acp-auth-spec.md` contains no Pi private-namespace claim; and the
   generated authoring prompt describes the standard route.

The new `mcpCapabilities.http/sse`, client capabilities, model config option, and MCP feature tools are
additive and default-on. The new `child_cleanup_error` `-32603` appears only when cancellation/close
cannot uphold its prior success guarantee. Remote MCP tool aliases and all existing successful ACP
session/config semantics remain as specified above. Because the bespoke namespace is unpublished after
this train, rollback means rolling back the coordinated package set, not enabling an opt-in legacy path.

---

## 16. Implementation order (one indivisible train)

**Source trace:** quotes 1–5 and the recorded FULL scope require the complete client, standard
structured-output behavior, configuration discovery, and tests. This order resolves dependency seams;
it does not create separately shippable subsets or defer any deliverable.

1. Implement the full MCP bridge, transports, lifecycle, content/details projection, dynamic inline
   extension, output validation, client features, and shared SettingsManager/session ownership (§3).
2. Add truthful model advertisement and classifier pin fixtures while the Pi session seams are in hand
   (§5–§6).
3. Remove the bespoke structured channel, switch PiBackend to common injection, and apply every frozen
   protocol/spec/test/skill/generated-prompt/public-doc amendment (§4/§10).
4. Install the tracked bash override and settlement barrier, including pinned failure taxonomy (§8–§9).
5. Land the hermetic transport/structured/cleanup suites, gated live probe, freshness/contract gates,
   four-package Changesets entry, and post-publish smoke script (§7/§11/§15).

All five steps merge as one implementation train. The required merge gate is the repository's frozen
install, build, typecheck, full test suite, authoring-prompt drift test, dependency freshness gate, and
the hermetic tests in §11; the release gate additionally requires the live credential-gated leg and
the §15 post-publish checks.
