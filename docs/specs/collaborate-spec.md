# `collaborate()`: PM-Supervised Collaboration Blocks

**Date:** 2026-07-17

**Status:** Frozen for contract review — not yet implemented. All design decisions in §6 are
settled (owner-approved); there are no open questions in this document.

**References:** `docs/specs/run-events-spec.md` (event log this extends);
`docs/specs/pause-recovery-continuation-spec.md` (session-reattach machinery this reuses);
`packages/shared-types/src/agent-runner.ts:16` (the frozen `run()` seam);
`packages/shared-types/src/agent-run.ts` (`mcpServers` :157, `keepSession` :213,
`onSessionOpen` :222, `continueFromSession` :230, `onUsage` :141);
`packages/acp-agents/src/structured-output.ts` (structured-output ladder),
`packages/acp-agents/src/structured-tool.ts:25` (injected-server precedent);
prior art: [tmux-bridge](https://github.com/maxeonyx/tmux-bridge) and the tmux
"PM window" pattern it enables.

## 1. Problem

Every inter-agent data flow the DSL can express today is **script-mediated and inter-turn**: an
`agent()` call runs exactly one turn to completion (`agent-runner.ts:16`), returns its result to
script code, and the script threads that result into the next call's prompt. Two agents running
concurrently inside `parallel()` are mutually invisible. There is no way for a coordinating
*model* — as opposed to coordinating *script code* — to interrogate a subagent about its output,
push back on a weak finding, ask a follow-up with the subagent's context intact, and then
synthesize a final answer.

The pattern this misses is well established in the wild: a human talks to one **anchor/PM agent**,
the PM drives a roster of role-named peer agents (Coder, Infra, Security, …) by sending them
messages and reading their replies, and the PM owns the final synthesized answer. The common
implementation — agent CLIs in tmux panes, the PM shelling out to `tmux send-keys` /
`capture-pane` with `sleep`-and-poll loops — demonstrates both the demand and the jank: hand-rolled
polling, scraped scrollback, no structured output, no journaling, no resume. Two properties of
that implementation are worth preserving, because they are what make it sound: **messages are
delivered only at turn boundaries** (typing into a busy CLI queues as ordinary user input; nothing
ever preempts an in-flight turn), and **reading a peer is pull-based** (nobody pushes into a
running turn).

`collaborate()` brings that pattern into the DSL with the jank removed: deterministic script
structure preserved, conversations journaled, output schema-validated, and every delivery
turn-boundary-only.

## 2. The primitive

```js
const verdict = await collaborate(
  {
    prompt: "You are coordinating this review. Push back on weak findings.",
    model: "fable",                    // any catalog model; PM runs on any ACP backend
    schema: REVIEW_VERDICT,            // the PM's final output contract
    peers: { oracle: { model: "opus" } },   // OPTIONAL pre-enrolled idle peers (§3.1)
    deliveryTimeoutMs: 60_000,         // OPTIONAL, default 60s (§6.2)
  },
  async () => {                        // OPTIONAL closure — the scripted work being supervised
    phase("Review");
    const findings = await parallel(DIMS.map((d) => () => agent(d.prompt)));
    return findings;                   // handed to the PM at finalization
  },
);
```

`collaborate(pmOptions, closure?)` is a new script global alongside `agent`/`parallel`/`pipeline`.
It runs a **PM agent** (an ordinary ACP session on any backend) alongside the closure's scripted
work. Subagent calls inside the closure behave exactly as they do outside it — same returns to the
same variables, same journal entries, same resume identity (§5) — but their sessions are kept
alive and enrolled in the PM's roster. The PM receives each completion as a message, can converse
with any enrolled agent across further turns, and finishes by submitting its schema-validated
output, which becomes `collaborate()`'s return value.

Both established shapes of the pattern are the same primitive:

- **Supervision mode** — closure present. The script keeps deterministic control of *what runs*
  (fan-out, prompts, ordering); the PM supplies judgment (follow-up interrogation, quality
  pressure, synthesis). Wrapping an existing phase is a two-line diff and does not disturb its
  agents (§5).
- **Anchor mode** — no closure, only `peers`. The PM is the sole driver, conversing with
  pre-enrolled idle peers until satisfied. This is the tmux-PM pattern verbatim, minus tmux.

The script-facing contract mirrors `agent()`: the call resolves to the PM's validated output
(`Static<schema>`, or final text when no schema is given), throws `WorkflowError` on
non-recoverable failure, and occupies one journal entry.

## 3. Semantics

### 3.1 Enrollment

An agent is **enrolled** when it becomes messageable by the PM. Two paths:

- **Scripted calls** inside the closure enroll automatically at call time, keyed by their label
  (the `opts.label` / default label already used for display). Enrollment sets `keepSession: true`
  (`agent-run.ts:213`) on the call and registers its `onSessionOpen` ref (`agent-run.ts:222`) with
  the block's roster. **Enrollment adds nothing else to the call**: no prompt preamble, no injected
  tools, no option that participates in the resume identity hash. A subagent needs no standing
  instructions to answer a follow-up — a PM message is just the next user-role turn on its session.
- **`peers`** entries are pre-enrolled at block start but their sessions open lazily, on first
  message delivery. A peer's first turn is its first PM message; it has no scripted turn.

Enrollment scope is the current engine run only. Agents spawned by a nested `workflow()` child
belong to the child run and are not enrolled. `collaborate()` blocks do not nest (same one-level
rule as `workflow()`); concurrent sibling blocks are allowed (§4.3).

Attribution inside the closure uses ambient async context (§4.3), so existing script code works
unmodified. The explicit escape hatch `agent(prompt, { collab: false })` excludes a call from
enrollment; `{ collab: true }` force-includes one from helper code where ambient context is
uncertain — the same shape as the existing `opts.phase` override for the analogous
`state.currentPhase` ambiguity (`workflow.ts:396`, `:915`).

### 3.2 The mail model

The engine is the mailman; every participant — PM and subagents alike — is a kept-alive ACP
session that receives mail **only as new turns at its own turn boundaries**. Interjection into an
in-flight turn does not exist anywhere in this design, matching ACP's own prompt-lifecycle rule
and the tmux prior art.

**Mailboxes.** One inbound queue per enrolled agent, one for the PM. Delivering a mailbox means:
wait for the target's current turn (if any) to end, then start one new turn whose prompt is the
entire drained queue — every pending message in arrival order, individually attributed:

```
[Message 1 — from PM]: …
[Message 2 — from PM]: …
```

**PM events.** The PM's mailbox receives, and its turns are woken by:

- *enrollment* — "`review:bugs` (call #3) started" (a `parallel()` fan-out enrolls its whole batch
  at once, so these naturally coalesce into one wake-up);
- *completion* — "`review:bugs` completed:" + the call's journaled output;
- *reply* — an enrolled agent's conversation-turn output, routed back;
- *finalize* — delivered when the closure resolves: "scripted work complete; closure returned:" +
  the closure's return value (or immediately at block start in anchor mode).

The PM is woken on the **first** event after it goes idle; whatever else has queued by the time
its turn starts is coalesced into the same delivery. There is no batching timer and no artificial
delay. An idle PM is a dormant session: no pending tool call, no polling, zero tokens.

### 3.3 The PM toolbelt

The PM's session — and only the PM's session — gets one engine-owned in-process MCP server
injected via the existing additive `mcpServers` seam (`agent-run.ts:157`), following the
structured-output server precedent (`structured-tool.ts:25`): constant server name
(`collaborate`), per-connection state, no instance-global registries. Two tools:

- **`message_agent({ agent, message })`** — post `message` to the named enrolled agent's mailbox.
  Blocks until the message is *delivered* (target at a turn boundary, its turn started), up to
  `deliveryTimeoutMs`. Returns `{ status: "delivered" }`, or on timeout
  `{ status: "queued", note: "『coder』 is still responding to your previous message; this message
  is queued and will be delivered when its current turn ends." }` — instructive, recoverable, and
  the message is **never dropped** (§6.2). The reply, whenever it comes, arrives as a future PM
  turn — this tool never waits for it (§6.3). Unknown agent names return an error listing the
  current roster.
- **`submit_output({ output })`** — validate `output` against `schema` (typebox `Convert` →
  `Check`, the same client-side gate as `structured-output.ts`); on failure return the validation
  errors as the tool result so the PM retries within its turn; on success the block finalizes
  (§3.4). With no `schema`, `submit_output` accepts `{ output: string }`. An explicit tool is
  required because the PM is multi-turn: "end of the turn" no longer identifies the final answer,
  so finalization must be an act, not a position. The schema-retry ladder
  (`maxSchemaRetries`, strict extraction, `SCHEMA_NONCOMPLIANCE`) applies to the PM's
  finalize exchange exactly as it does to `agent()` calls today.

The PM's opening turn carries its task `prompt` plus an engine-generated protocol preamble: the
toolbelt contract, the mail semantics above, the initial `peers` roster, and the instruction that
scripted-agent completions and replies will arrive as future messages.

### 3.4 Finalization

`submit_output` success is **terminal**: the block's result is the validated output; in-flight
*conversation* turns are cancelled via the normal `options.signal` → `session/cancel` path;
undelivered mail is recorded as dropped in the event stream; enrolled sessions are released
(normal disposal — `keepSession` was block-scoped). Scripted calls inside the closure are never
cancelled by finalization: if the PM submits before the closure resolves, the closure keeps
running to completion (its calls journal normally) and its eventual return value is discarded —
but the engine delivers the finalize event only after the closure resolves, so early submission
can only follow completions the PM has already seen, and the preamble tells the PM the closure is
still running until the finalize event arrives.

If the PM's session dies or hits a provider wall, the standard error taxonomy applies
(`PROVIDER_USAGE_LIMIT` pauses the run; recoverable errors retry the PM turn per `agentRetries`).

## 4. Mechanism

### 4.1 Conversation turns ride the existing runner seam

Every conversation turn — a subagent receiving PM mail, a peer's first turn, each PM wake-up — is
one `runner.run(drainedMailbox, options)` call whose options carry a new **additive, non-hashed**
`RunOptions` field:

```ts
/** Deliver this prompt as a NEW turn on this existing kept-alive session instead of opening
 *  session/new. Distinct from continueFromSession (agent-run.ts:230), which continues an
 *  INTERRUPTED turn during resume. ADDITIVE and never part of the resume identity hash. */
promptSession?: AgentSessionRef;
```

The acp-agents client already performs multiple `session/prompt` calls on one session (the
schema re-prompt ladder), so this exposes existing capability rather than new protocol work. The
frozen `run()` shape — prompt in, raw result out, usage via `onUsage` — is unchanged; the field
joins the additive family (`mcpServers`, `keepSession`, `continueFromSession`) documented in
`agent-run.ts`.

Conversation turns share the run's concurrency limiter like any runner call. Mail *queuing* takes
no slot; only turns do, so saturation delays conversation without deadlock (scripted calls never
wait on the PM; the PM waiting on a slot is just a late wake-up).

### 4.2 Delivery loop

Per enrolled agent, the engine maintains `{ mailbox, sessionRef, turnInFlight }`. When mail
arrives and no turn is in flight, drain and start a turn. When a turn ends: route its output —
to the PM's mailbox if the turn was PM-initiated conversation; to the script (and a *completion*
event to the PM) if it was the scripted call's own turn — then, if the mailbox is non-empty,
immediately drain and start the next turn. `message_agent`'s delivery-block resolves when the
drain that includes its message starts a turn, or returns `queued` at `deliveryTimeoutMs`.

### 4.3 Ambient enrollment context

`collaborate()` runs its closure inside an `AsyncLocalStorage` scope carried by the host (the vm
realm's promises are host-adopted — `workflow.ts:2560` — so context propagates through script
`await` chains). `agent()` consults the ambient scope at call time for enrollment, exactly where
it consults `state.currentPhase` today (`workflow.ts:915`). ALS makes concurrent sibling
`collaborate()` blocks correct without the known global-state race that `phase()` has; the
`opts.collab` override remains for code paths that detach from the context (e.g. callbacks stored
and invoked outside the closure's chain).

### 4.4 Events and observability

The `RunEvent` union (`run-events-spec.md`) gains additive members carrying the block's call
index plus a `conversationTurn` discriminator: `collab/enrolled`, `collab/mail-queued`,
`collab/mail-delivered` (with coalesced-count), `collab/turn-started`, `collab/turn-completed`,
`collab/mail-dropped`, `collab/finalized`. ACP session updates from conversation turns flow into
the existing per-event `callIndex` stream so a host can render the whole conversation live. The
full mail transcript is therefore reconstructible from the event log; it is deliberately **not**
part of the resume journal (§5).

### 4.5 Usage and budget

Every conversation turn reports through `onUsage` (`agent-run.ts:141`) and rolls into the shared
`budget.spent()` pool, attributed to the `collaborate()` call's index. No turn-count or
message-count caps exist: the block is bounded by the PM's own judgment, the token budget when
one is set, and the per-turn timeout the engine already applies to every runner call. The only
timeout this spec introduces is `deliveryTimeoutMs`, which bounds a tool call's *wait*, never the
work.

## 5. Determinism, journal, resume

**One journal entry.** A `collaborate()` call journals like an `agent()` call: identity =
sha256 of the PM configuration ({prompt, model, schema, peers roster/configs, agentType/agentDef
when set}) in the existing `hashAgentCall` scheme; result = the PM's validated final output,
replayed verbatim on resume. Interior conversation turns are observability (RunEvents), not
journal entries — their count and content are model-driven and nondeterministic by design, so
they must never participate in replay identity.

**Wrapping is identity-neutral — the load-bearing guarantee.** Scripted calls inside the closure
keep their normal, individual journal entries, and enrollment touches only non-hashed fields
(`keepSession`, callbacks). Therefore wrapping an existing phase in `collaborate()` preserves
every cached identity: a resume against a pre-wrap journal still replays the inner calls, and
un-wrapping later is equally non-destructive. This is what makes "take an existing phase and add
a PM" a real two-line diff rather than a cache-invalidating rewrite.

**Interrupted blocks fail-to-fresh.** On resume of a run killed mid-block: inner scripted calls
replay from their journal entries as usual; the PM — whose interior state lived in a now-dead
session — restarts fresh with a rebuilt opening turn (protocol preamble + all already-completed
enrolled outputs redelivered as its first mail batch), mirroring the pause-recovery rule that a
failed reattach falls back to a fresh session rather than guessing. PM messages to an enrolled
agent whose scripted turn was replayed (no live session) first attempt reopen via the advertised
`session/load` / `session/resume` capabilities (`workflow-result.ts:95-101`); when the backend
does not support reopen, delivery falls back to a fresh session for that agent seeded with its
recorded scripted output — degraded context, never an error. Turn-by-turn PM replay via
`session/load` is a compatible future refinement, not v1.

## 6. Settled decisions

**6.1 Queued mail concatenates.** All messages pending for one agent deliver as a single turn,
ordered and attributed. One-message-one-turn was rejected: it multiplies turn overhead (each turn
is a cached-prefix read plus generation), journals nothing useful in exchange, and models don't
need per-message reply attribution — while concatenation matches how agent CLIs already treat
input queued mid-turn and makes duplicate sends merely redundant, which decision 6.2 depends on.

**6.2 Delivery timeout queues, never drops.** `message_agent` hangs up to `deliveryTimeoutMs`
(default 60 000 ms — long enough to catch a target finishing up, short enough never to resemble a
stuck call) and on timeout returns the instructive still-responding message *with the message
left queued*. Drop-on-timeout was rejected because it makes correctness depend on the PM
remembering to resend: a forgetful PM silently loses mail, and a paraphrased resend diverges from
what the PM believes it sent. Under queue-on-timeout the failure mode of a forgetful PM is a
harmless duplicate (absorbed by 6.1); the failure mode of drop-on-timeout is lost intent.

**6.3 No blocking reply mode.** `message_agent` never waits for the reply; every reply is a PM
turn. An opt-in `wait: true` was rejected for v1: it reintroduces tool calls that pend for the
full length of a subagent's working turn (the harness-idle-timeout exposure the multi-turn PM
model exists to avoid), creates a second delivery path with a distinct journal/replay shape, and
invites PMs to serialize their fan-out. It remains cleanly additive if PM transcripts ever show
the need.

**6.4 PM-hub topology.** Mail flows PM↔subagent only; subagents are not told the roster and
cannot message each other. This is the pattern's actual shape (the PM is the synthesis point) and
keeps the preamble, the tool surface, and the delivery loop minimal. Subagent↔subagent mail is a
compatible extension.

**6.5 No batching timer.** First event wakes the PM; coalescing is whatever queued meanwhile.
A delay window would add latency to every wake-up to save wake-ups that natural coalescing
already absorbs in the common case (batch fan-out completions).

**6.6 Finalize is terminal.** Submission ends the block immediately (§3.4). Letting the block
linger for post-submission conversation was rejected: it has no consumer (the result is already
returned) and would hold sessions and limiter slots open indefinitely.

## 7. Rejected alternatives

- **Mid-turn message channel** (agents post/read a shared bus while turns are in flight).
  Violates turn integrity — the observed prior art does not do this either — and makes an agent's
  turn output depend on asynchronous interior arrivals, which is unsound against content-addressed
  replay identity.
- **Bare DSL session handle** (`session()` → repeated `prompt()` as a script global). Covers
  interrogation but leaves orchestration in script code — the PM's judgment loop is the point of
  this primitive — and widens the script surface permanently for what `collaborate()` provides
  with structure. Revisit only with an independent use case.
- **Single-long-turn PM with a long-poll inbox tool** (`await_updates()` blocking until the next
  event). Token-equivalent to the multi-turn model per delivered event, but the PM can never go
  idle without holding a pending tool call open — exposing the block to backend/harness idle
  timeouts on hour-scale waits — and concurrent conversations require a send/collect tool split.
  The multi-turn model gets rest-for-free and fan-out-for-free from turn boundaries.
- **`peers` as an option on `agent()`** rather than a distinct global. Superficially composable,
  but it buries a second return-path (who finishes: the call or its PM?) inside every call site
  and cannot express supervision mode (a PM over *other* scripted calls) at all.

## 8. Out of scope (compatible extensions)

Subagent↔subagent mail (6.4); a read-only `observe` tool for polling a sibling's in-progress
RunEvents (pull-based, viable atop the event log with no protocol change); PM turn-by-turn resume
replay (§5); blocking replies (6.3); nested collaborate blocks.

## 9. Delivery shape

Ships default-on across three packages, no feature flags: `shared-types` (`promptSession` field,
RunEvent members), `acp-agents` (multi-turn session driving via `promptSession`, the `collaborate`
MCP toolbelt server), `workflow-engine` (the global, ALS enrollment scope, mailboxes/delivery
loop, journal + resume behavior). Follow-ups in the same train: the authoring skill
(`skills/agentprism-workflow-authoring` + regenerated MCP `author-workflow` prompt) and
`docs/roadmap` gain the primitive once implemented; the MCP server needs no tool-surface change
(`collaborate` is script-level, reached via the existing `workflow` tool).
