# REPL orchestrator — the workspace as an MCP server

**Status:** implemented (roadmap phase E) — the `repl` tool ships in [`@automatalabs/mcp-server`](../../packages/mcp-server) over the [`@automatalabs/repl-engine`](../../packages/repl-engine) tier; this doc remains the semantic reference, and the exact tool contract lives in the [package README](../../packages/mcp-server/README.md#the-repl-tool). · **Updated:** 2026-08-07

A deliberately small MCP surface whose entire product is a **persistent JavaScript REPL** in a
capability-free QuickJS-in-WASM VM. The client's agent (Claude Code, or any MCP client) scripts
subagent orchestration as live JS against promise-bearing primitives; subagents are ACP sessions
run through [`acp-agents`](../../packages/acp-agents); the tool result is console output plus
pending/completed state. Workflows is the batch orchestrator — deterministic scripts, replay,
gates. This is the interactive one: a live steering plane where state persists between tool
calls because it lives in a real VM, not in a transcript.

```js
const pi = agent("pi/deepseek-v4-flash-max", "research X");   // returns immediately
const codex = agent("codex/gpt-5.6-sol", "research Y");
// …tool call returns with console output; agents keep running server-side.
// A later eval, same VM: variables still there, promises settle for real.
const [a, b] = [await pi, await codex];
console.log(a.summary, b.summary);
```

It ships as a new engine package with its `repl` tool registered in the existing
[`mcp-server`](../../packages/mcp-server) alongside `workflow` — anyone already connected to
the AgentPrism MCP server gets the REPL with no new install or configuration.

## External reference: the AgentPrism harness

This concept borrows its execution model — and its hardest-won lessons — from a **separate
project** that is not part of this monorepo: the AgentPrism harness, checked out on this
machine at `/home/vikash/agentprism-harness` (GitHub: `agentprism/agentprism` is the
umbrella repo; `agentprism/agentprism-rust`, vendored there as a submodule, is the Rust
implementation). If you work only in agentprism-workflows, here is the minimum context:

- The harness is an **orchestration-only conversational agent**: its root LLM has exactly one
  tool — evaluating JavaScript in a persistent, sandboxed QuickJS-in-WASM VM. Worker agents
  (with filesystem/shell tools) do all real-world execution; the root only orchestrates them
  through promise-returning primitives in the VM. The concept is specified in three frozen
  design documents:
  - [`orchestration-only-repl-harness.md`](/home/vikash/agentprism-harness/orchestration-only-repl-harness.md)
    — the platform-independent concept (the primary read; ~400 lines).
  - [`rust-host.md`](/home/vikash/agentprism-harness/rust-host.md) — the shipped Rust
    implementation's design.
  - [`typescript-host.md`](/home/vikash/agentprism-harness/typescript-host.md) — the planned
    TypeScript implementation's design (85 lines; directly relevant here, see the mapping
    table below).
- The Rust implementation is built and works end-to-end (driven by a stock ACP client). Its
  engineering ledger — [`DEBT.md`](/home/vikash/agentprism-harness/DEBT.md) — records every
  known defect, closed fix, and accepted trade-off under stable IDs (`R68`, `G33`, …). When
  this document cites a ledger ID, that file is where the full history lives.
- The VM's guest-visible API in the harness is a **versioned, shared artifact**, not ad-hoc
  host code: the library [`guest/dsl.js`](/home/vikash/agentprism-harness/guest/dsl.js) and
  its host-side contract
  [`guest/HOST-CALLS.md`](/home/vikash/agentprism-harness/guest/HOST-CALLS.md) (currently
  version 0.2.0) define exactly what code inside the VM can call, and how that surface is
  allowed to evolve. This server does not vendor that artifact — its guest library is a fresh
  TypeScript implementation (see §Surface) — but the harness's evolution rules are the model
  it imitates.
- **The lineage is circular, and that matters here.** The harness's design doc states that the
  *only* thing it carried over from AgentPrism is the DSL's language semantics — the shapes
  declared in **this repo's own
  [`packages/workflows/src/dsl.d.ts`](../../packages/workflows/src/dsl.d.ts)** — re-implemented
  inside the VM ([design doc :23-28](/home/vikash/agentprism-harness/orchestration-only-repl-harness.md)).
  This concept is that vocabulary coming home: the same `agent`/`parallel`/`pipeline`/
  `judgePanel` shapes this repo's workflow authors already write, but running in a persistent
  live VM instead of a one-shot deterministic script.

**Why the model works (the harness's motivating argument, in brief):** a conventional agent
interprets the user's intent *and* wades through the environment's content in the same context
window, so the repository or research dump starts competing with the user for authority. The
harness splits state along the same line it splits authority: the context window holds the
**intent plane** (what the user wants, what's decided, what's pending), the VM holds the
**data plane** (the twenty files of findings, sitting in variables the orchestrator queries
selectively — `findings.filter(...)` — without pulling raw content into context). The stated,
testable hypothesis: preventing the conversational agent from directly touching the
environment preserves user-intent fidelity, because implementation context cannot quietly
become policy. In the MCP packaging, the client agent gets exactly this property with respect
to everything its subagents produce.

Everything below is written to be understandable without reading the harness first, but the
links are there when you need the primary source.

## The packaging inversion

The harness ships its concept as a **whole agent**: it owns the root LLM loop, the provider
stack, the system prompt, and serves the conversation as an ACP agent. This MCP server inverts
the packaging: **the root LLM lives in the MCP client** (Claude Code or any other), and the
product is just the workspace-as-a-tool. That deletes the root prompt, the provider stack, and
the ACP-serving surface entirely — and it makes the harness's central integrity rule structural
rather than enforced: no server code can ever intercept or reinterpret the human's words,
because the only way anything enters the workspace is an eval that the client's agent wrote.
(The harness had to *remove an entire host-side interception subsystem* to reach that state —
ledger ID R68 in [`DEBT.md`](/home/vikash/agentprism-harness/DEBT.md) tells that story. Here
the wrong design is unrepresentable.)

[`typescript-host.md`](/home/vikash/agentprism-harness/typescript-host.md)'s contract carries
over nearly wholesale, re-based onto this monorepo's artifacts:

| typescript-host.md says | REPL orchestrator uses |
|---|---|
| [quickjs-wasi](https://github.com/vercel-labs/quickjs-wasi) as the full shim tier (eval, job drain, name-keyed host callbacks, snapshot/restore, memory caps, interrupts) | same — quickjs-wasi as-is, **including the npm package's shipped `quickjs.wasm` binary**. The harness builds its own binary for cross-host snapshot exchange; this server deliberately does not (§Snapshots) |
| pi-agent-core + pi-ai as the agent runtime | **[`acp-agents`](../../packages/acp-agents)** — subagents are ACP sessions against any backend in the [registry](../specs/backend-registry-spec.md) (claude, codex, pi, opencode, custom), with the existing model-routing grammar |
| root = an in-process `Agent` holding one eval tool | root = the client's agent holding this server's `repl` tool |
| host serves the conversation over ACP | host serves MCP; ACP is the *downward* protocol to subagents |
| build surface: broker with call-ID store, CDP-style previewer, `console.log` interception, guest library injection, snapshot storage | the identical list — this is this package's build surface |

One deliberate divergence deserves its own line. The harness's design declares **exactly two
platform-invariant specified surfaces**: the DSL the orchestrator speaks, and the tool schemas
its worker agents hold (it maintains the latter as a normative artifact,
[`TOOL-SCHEMAS.md`](/home/vikash/agentprism-harness/agentprism-rust/crates/host/TOOL-SCHEMAS.md)).
This server keeps surface one and **cedes surface two to the backends**: a subagent spawned as
a Claude Code or Codex ACP session brings that backend's own tools, not a harness-controlled
toolset. That is a real weakening of the harness's "delegation means the same thing
everywhere" invariant, accepted deliberately because backend diversity is this repo's entire
value proposition. There is also a pleasing symmetry: the harness's only sanctioned extension
channel is MCP *downward* (capability enters as MCP servers attached to worker agents — never
as additions to the VM), while this product is itself MCP *upward*. In both directions the
realm stays fixed.

## What transfers from the harness (built, tested, adversarially verified there)

The Rust harness has shipped ~40 verified work packages against this exact execution model.
These are the lessons that enter the v1 contract here instead of being rediscovered:

1. **Settlement is the hard part, not the bridge.** "Worst case the tool returns
   still-running" only holds if every promise continuation fires **exactly once**, including
   across process crashes. The harness's broker
   ([`crates/broker/src/broker.rs`](/home/vikash/agentprism-harness/agentprism-rust/crates/broker/src/broker.rs)
   and its append-only call store
   [`store.rs`](/home/vikash/agentprism-harness/agentprism-rust/crates/broker/src/store.rs))
   is the reference: results recorded by call ID before being settled into the guest; on
   restore, a three-way reconciliation per outstanding call (settle from the store / re-attach
   to a still-running task / re-issue a lost one); crash-torn store tails repaired rather than
   bricking the session (ledger IDs R55/R81). Port the *semantics*, not necessarily the code.
2. **The tool result is a trust boundary.** Console output crossing into the client agent's
   context needs previewing with hard caps (the harness elides long strings head+tail on a
   200-character budget — the normative rendering rules are in the previewer's
   [`FORMAT.md`](/home/vikash/agentprism-harness/agentprism-rust/crates/previewer/FORMAT.md)),
   per-call output caps so a busy workspace can't flood the client, and **trap-free reads** —
   never execute guest getters while rendering results. This is not theoretical: the harness
   took a verified regression when a single property read on an engine-created wrapper let
   `Object.prototype.value` pollution hijack every eval result (ledger ID R69's fix round in
   [`DEBT.md`](/home/vikash/agentprism-harness/DEBT.md)). Rendering guest state is adversarial
   territory; use own-property-descriptor reads (quickjs-wasi exposes them natively).
3. **Suspended-eval semantics are already worked out.** The harness's top-level-await work
   (ledger ID R69) defines and pins the shapes this server needs verbatim: top-level `await`
   accepted; an eval whose promise resolves within the job drain reports the value; one that
   suspends on a subagent call returns **immediately, with no fabricated value**, listing the
   pending call IDs; the continuation resumes when the call settles, exactly like a `.then`;
   late uncaught rejections surface as error-level console lines in the next tool result.
   MCP's poll-shaped client ("call again") replaces the harness's push/wake path — everything
   else maps one-to-one. Top-level `return` stays a syntax error.
4. **Ask-the-user needs no protocol.** `checkpoint("question")` parks a promise inside the VM;
   the question appears (previewed, truncated) in the tool result; the client's agent relays
   it to its human; the answer comes back as `checkpoint.answer(id, value)` in a later eval.
   The harness's contract for this — including durability of a delivered answer — is in
   [`guest/HOST-CALLS.md`](/home/vikash/agentprism-harness/guest/HOST-CALLS.md) and the
   Checkpoints section of its
   [`ACP-MAPPING.md`](/home/vikash/agentprism-harness/agentprism-rust/crates/host/ACP-MAPPING.md);
   the semantics transfer even though this server's guest library is its own implementation.
5. **Snapshot identity, or silent corruption.** quickjs-wasi snapshots are raw WASM linear
   memory — valid only against the byte-identical `quickjs.wasm` build. A package upgrade plus
   a disk snapshot = a restore into garbage with **no diagnosis**, unless the snapshot file
   itself records which binary laid it out. The harness's answer (in review on its branch
   `wp35/snapshot-surfaces` at the time of writing): an at-rest envelope carrying the wasm
   sha256 + a format version + gzip compression, so a mismatched restore fails loudly naming
   both hashes. Measured there on real snapshots: ~7.9x (1.5 MB → 189 KB), with gzip chosen
   over zstd because JS runtimes decompress gzip natively. Disk persistence is v1 scope here
   (§Snapshots), so the envelope comes with it from day one.
6. **The guest surface is a versioned contract, not a pile of globals.** Whatever globals you
   install are captured inside snapshots, and you cannot safely re-inject a newer library over
   a restored VM (rule 3 in the harness's
   [`guest/HOST-CALLS.md`](/home/vikash/agentprism-harness/guest/HOST-CALLS.md)). This
   server's guest library is its own TypeScript implementation, but the harness's disciplines
   apply to it as requirements: the library carries a version marker, travels inside
   snapshots, evolves only through backward-compatible vectors (new optional trailing
   arguments = minor; new host-callback names = major), and the host must serve snapshots
   carrying older library versions than the one it currently injects.

## Surface

One `repl` tool, action-enum shaped — the same pattern as this repo's `workflow` MCP tool.
**Workspaces follow the daemon's project model exactly.** The workflows MCP server is a thin
entry over a long-lived loopback HTTP daemon
([`http-daemon.ts`](../../packages/mcp-server/src/daemon/http-daemon.ts)) where MCP sessions
are ephemeral, project-agnostic transports and durable state lives in **per-project contexts**
([`project-registry.ts`](../../packages/mcp-server/src/project-registry.ts): one context per
validated, realpathed project directory, created on first use). The REPL workspace is such a
context — one VM per `projectDir`, addressed by the same required-in-daemon-mode `projectDir`
argument the `workflow` tool uses. MCP-session churn (client restarts, transport eviction)
never touches the workspace; the daemon's lifetime plus disk snapshots carry it across
everything else.

*As implemented, each result carries a machine-readable `structuredContent` (the published
`outputSchema`) alongside the bounded text; the exact field shapes are in the
[package README](../../packages/mcp-server/README.md#the-repl-tool).*

- `eval { projectDir, code }` → `{ output, outputTruncated, result?, pending: [...], checkpoints: [...], completed: [...] }`
  — runs the script, drains microtasks/jobs, settles what it can, returns. `result` is the
  previewed completion value present **when the eval resolves to a value** — a guest `undefined`
  (a declaration or a bare `console.log(...)`) renders as the string `"undefined"`, not a missing
  field; `result` is absent when the eval **suspends** (on a subagent call, a `checkpoint()`, or
  any other unsettled promise) or when it **throws, rejects, syntax-errors, or is interrupted**.
  `checkpoints` are `{ id, question }`, the question previewed; `completed` excludes checkpoint answers.
- `wait { projectDir, ids?, timeoutMs }` → bounded server-side wait; returns the same shape
  plus `drained` / `timedOut` ("still running" on timeout — absorbs client tool-call timeouts).
- `status { projectDir? }` → `{ workspaces: [...] }`: per workspace the `state`
  (`not-opened`/`fresh`/`restored`/`refused`), the restore `reconcile` summary, live agents,
  pending ops, and the **workspace manifest** — the harness's answer to the orchestrator
  *losing track of what it has* thirty calls in: top-level bindings with name, type, size,
  provenance (which subagent produced the value, from what task, when — `eval N` / `worker cN`
  / `session restore`), and live-handle status. Metadata, never content — `ls` for the data
  plane. A **named** `status` is a first touch (creates/restores); only projectless `status`
  is non-materializing.
- `interrupt { projectDir, id? }` → `{ interrupt: { outcome, callId? } }`. With `id`, cancel one
  subagent call (ACP `session/cancel` downward) — `outcome` `cancelled`/`idle`/`failed`/`none`.
  Without `id`, break the running eval (the quickjs interrupt handler) — `outcome` `targeted`
  or `refused-idle` (nothing breakable is in flight).
- `reset { projectDir }` → `{ dropped: true }`: teardown (cancels in-flight ACP sessions, drops
  the VM and its stored state, and clears the workspace's continuation refs).

Snapshotting is implicit — there is no user-facing snapshot action (§Snapshots).

**Output is addressed, not just truncated.** Per the harness's bridge design, every
`console.log` is truncated in the tool result but frozen in full inside the VM as `$1`, `$2`, …
(DevTools-style, via `structuredClone`), and the rendered line carries its address in the
previewer's collapsed CDP syntax — property names unquoted, strings double-quoted, nested objects
and arrays as brand tokens — e.g. `[$14 · object · 48kB] {sections: Array(12), title: "Auth flow", …}`
— so the orchestrator slices deeper in a later eval (`console.log($14.sections.map(s => s.title))`)
instead of re-running work.
Nothing is lost by logging it; nothing floods the client's context by being logged. The
truncation format is the Chrome DevTools Protocol's `ObjectPreview` model, adopted as a spec
(the harness's normative record:
[`FORMAT.md`](/home/vikash/agentprism-harness/agentprism-rust/crates/previewer/FORMAT.md)).
The harness's design calls this format "the perception system of the agent" — it shapes
orchestrator behavior more than any prompt; it deserves spec-level care here too.

The sandbox globals follow the design doc's DSL split: only a sliver needs host effects —
`agent(modelSpec, task, opts?) → Promise` (opts: structured-output schema —
[`acp-agents`](../../packages/acp-agents) already validates schemas per call; cwd; backend
config), `checkpoint()` / `checkpoint.answer()`, and `console` itself. Handle methods
`followUp` / `steer` / `cancel` ride the agent handle, and they **resolve with what actually
happened** — live injection where the backend supports the
[`_session/steering` extension](../../packages/acp-agents/src/events.ts), queued-for-next-turn
delivery where it doesn't — mirroring the outcome values acp-agents already surfaces in its
steering events. Nothing is hidden and nothing hard-errors; the orchestrator can tell urgency
delivery from queued delivery and adapt. Agents are addressed by their JS bindings and stable
call IDs (`c1`, `c2`, … — needed anyway for `interrupt` and `status`); canonical path
addressing arrives with inter-agent communication in v2, which is what needs it.

Everything else this repo's workflow authors know from
[`dsl.d.ts`](../../packages/workflows/src/dsl.d.ts) — `parallel`, `pipeline`, `verify`,
`judgePanel`, `gate`, `retry`, `loopUntilDry` — is **pure JavaScript layered on `agent()`**,
injected as the guest-side library. The design doc's deliberate vocabulary rewrite applies:
`phase()` is deleted (it presupposes "a run" that no longer exists), and `checkpoint()`
becomes the mechanism by which the data plane interrupts the intent plane.
Started-not-awaited handles come free with top-level await (`const research = agent(...)` —
end the eval, check in next call). **There is no budget surface**: no `budget()` global, no
ledger, no caps vocabulary in the guest — where the harness's DSL carries a budget read, this
server drops it, and resource limits are server configuration, invisible to the guest. No fs,
no net, no timers beyond the job drain — the VM's entire effect surface is the host-callback
bridge.

Engine posture (all quickjs-wasi built-ins): `memoryLimit` per VM, `interruptHandler` per
eval. Limits: **6 concurrent subagents per workspace**; the tool result's **text** is capped at
**256 physical lines or 10 KB, whichever trips first**, and its **`structuredContent`** at a
**10 KB serialized-JSON** bound *only* (no line cap). Console output beyond the cap remains
reachable through `$N` slicing; an elided structured array that captured a continuation ref is
read back through the `refs` parameter — so *that* elision costs only a read. The guarantee is
not universal: an array dropped with no ref store available records a bare count, and the string
backstop head+tail-*shortens* an oversized string element in place (a bare `strings` count, never
stored), so those elisions do lose data.

## Snapshots and durability

Disk persistence is **v1 scope**: the workspace survives daemon restarts, which is the
property that makes a "persistent REPL" trustworthy rather than merely convenient. Three
cooperating pieces:

- **The call store** — append-only results-by-call-ID (transfer lesson 1). This is how
  exactly-once settlement works at all, so it exists regardless of snapshots.
- **Enveloped snapshots** — `serializeSnapshot()` output wrapped in the identity envelope
  (transfer lesson 5): wasm-binary hash + format version + gzip. Snapshots are written at
  **every state-changing boundary** — after each eval and after each settlement drain that
  changed VM state. Because durability is boundary-based, a daemon kill loses at most the
  *in-flight* operation that had not yet reached a boundary; every committed boundary — and,
  through the append-only call store, every recorded subagent result — is durable, so in the
  harness design's words reconciliation on relaunch is the normal startup path, not a recovery
  path. Snapshots and the call store live in the daemon's existing per-project
  store — a `repl/` subdirectory next to the workflow state under
  `workflowHomeDir()/projects/<key>/`, whose `project.json` manifest already maps the store
  key back to its project directory.
- **The restore path** — **lazy, on the first touch of a stored workspace** (a named `status`,
  `eval`, `wait`, or `interrupt` — there is no daemon-startup restore sweep): restore the
  VM, re-register host callbacks by name (a quickjs-wasi built-in), read the in-VM
  pending-call registry, and reconcile each outstanding call three ways — completed while
  down → settle from the store; still resumable at the backend → re-attach; lost → re-issue.
  Re-attach is real on every built-in backend: **all four advertise `loadSession: true`**,
  per the live-verified capability matrix in [`docs/api.md`](../api.md) (claude additionally
  list/delete/resume/close/fork; codex list/delete/resume/close; opencode
  load/list/resume/close/fork; pi load/list/resume/close). The mechanism is capability-gated
  ([`capabilities.ts`](../../packages/acp-agents/src/capabilities.ts)), so a custom backend
  that omits the capability degrades through the same gate — re-issue is the honest fallback,
  surfaced guest-visibly.

**Subagent processes are client-presence keyed, with graceful drain.** Child ACP processes
stay warm while any MCP client is connected to the project (the daemon's session registry
already measures liveness by connection presence — a live client always holds an open
connection; the presence ledger is shared with the `workflow` tool, so a workflow-only client
keeps the workspace warm too). On last-client disconnect, in-flight subagent turns **drain to
completion within a bound** — the daemon's session-eviction TTL (`SESSION_IDLE_TTL_MS`,
default 2 h) — their results settle into the VM and each settlement boundary snapshots, so
"close the laptop while two researchers run" ends with the findings durable in the workspace;
a turn that overruns the bound is force-settled as the recoverable `AGENT_CANCELLED`, and then
idle children close. A client that **reconnects mid-drain aborts it**, keeping the children
warm. On the next client connect, the workspace is live (or restores from snapshot) and
`followUp` re-attaches the subagent session lazily via the capability matrix above.

Consequences of the npm-shipped binary: snapshots are compatible across daemon restarts and
across machines running the **same quickjs-wasi package version**; a version bump makes old
snapshots refuse loudly (both hashes named) instead of corrupting. Snapshot portability with
the Rust harness is explicitly **not** a goal — different binary, different layout, and the
envelope makes that a clean rejection rather than a surprise.

## What v1 deliberately excludes

- **Inter-agent communication — deferred to v2.** No messaging sidecar attached to
  subagents, no peer-to-peer `send_message`. All coordination is scripted by the orchestrator
  in evals (`pi.followUp(...)`), which keeps the call graph observable in one place and
  provenance attributable — the orchestration-only property that is the whole point of the
  model. When v2 takes this up, the candidates are a messaging MCP server attached to
  subagent sessions and Codex's native collaboration mode riding
  [`codex-acp`](../../packages/codex-acp), with the observability trade-off stated; canonical
  path addressing lands then too.
- **Determinism and replay.** This is the harness design doc's own call (:26-28: "no journal,
  no deterministic-replay requirement"); `Date.now()` and `Math.random()` work normally. The
  [workflow engine](../../packages/workflow-engine) keeps batch determinism; this package
  deliberately doesn't compete with it.

## What the implementation resolved

These decisions the concept doc left open were made and shipped in phases C–F:

- The drain-completion bound on disconnect **reuses the daemon's session-eviction TTL**
  (`SESSION_IDLE_TTL_MS`); a turn that overruns it is force-settled as the recoverable
  `AGENT_CANCELLED`, and a mid-drain reconnect aborts the drain.
- Snapshot-write mechanics (atomic tmp+rename, debounce within a drain burst) and the config
  knobs landed — the per-eval deadline is `AGENTPRISM_REPL_EVAL_TIMEOUT_MS` (default 30 000 ms).
- The per-backend steering *mechanism* table is a **generated artifact**
  ([`packages/repl-engine/docs/steering-mechanism-table.md`](../../packages/repl-engine/docs/steering-mechanism-table.md)),
  produced from the live capability probes in `@automatalabs/acp-agents` and gated by a test.
- Interruption of a *fully synchronous* runaway is delivered **out of band** (phase F) by a
  worker-thread relay the stdio shim fires; a host on ordinary HTTP falls back to the per-eval
  deadline. The interactive no-id `interrupt` honestly refuses the cases it cannot key.

## Relationship to existing roadmap items

Complementary to [`evals.md`](./evals.md) (a live orchestration session is a natural eval
subject via the same observability events), [`remote-execution.md`](./remote-execution.md) (a
remote REPL session is the same surface over a transport), and the workflow engine (batch vs
interactive — a workflow step could even hold a REPL session for its duration). No overlap
with [`acp-v2-readiness.md`](./acp-v2-readiness.md) beyond sharing `acp-agents`.
