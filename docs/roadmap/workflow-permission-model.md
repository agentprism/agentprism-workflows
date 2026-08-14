# Workflow permission model — permissive by default, restriction authored, escalations surfaced

**Status:** draft for owner review — NOT yet the build bible · **Updated:** 2026-08-07

**Provenance rule for this document.** Every normative clause below is one of:
- **[D]** a decision made by the owner in the design conversation of 2026-08-07;
- **[F]** a verified fact about the current code, cited as `file:line` at main `5c39f2e` (line
  numbers drift; the cited identifiers do not);
- **[C]** a convention-derived specific (a concrete name, shape, or placement chosen to mirror
  existing machinery) — listed in §8 for explicit owner veto before any build starts.

Implementers must not invent requirements beyond this document. Where the document states an
outcome without prescribing an implementation, that is deliberate: any implementation meeting
the acceptance criteria conforms. Where behavior is unspecified and a decision is unavoidable,
the correct move is to surface the question, not to guess.

---

## 1. Why this exists

During the REPL-orchestrator docs workstream, four consecutive workflow runs failed with the
implementer's work staged-but-uncommitted, at a cost of roughly $95, because `mode: "dontAsk"`
on the claude backend silently denied every command execution and most file edits. The
post-incident investigation (2026-08-07, verified against the failed run's event journal
`msihmgcc-gzaptn`) established:

- **[F]** Under `dontAsk`, Edit was denied 22/22 times, Write 4/4, Bash 40/139. The 99
  successful Bash calls succeeded only because they matched the *user's personal*
  `~/.claude/settings.json` allow rules (`Bash(python:*)`, `Bash(echo:*)`, …) — the workflow
  agent's effective capability set was an accident of the machine it ran on.
- **[F]** The denials were emitted at every layer (SDK `permission_denied` frame → adapter
  `tool_call_update {status:"failed"}` → persisted `agentTranscript` record with
  `isError:true`, `run-observability.ts:770-797`) but aggregated at none: `WorkflowRunStatus`
  (`packages/shared-types/src/workflow-result.ts:583-599`) has no denial rollup, the run log
  contained zero occurrences of "permission", and the run terminated `completed`.
- **[F]** The SDK's denial message to the model explicitly invites tool-substitution
  workarounds, converting hard failures into plausible-looking partial work.
- **[F]** One class of signal is not persisted at all: the acp-agents auto-responder's own
  permission decisions (`acp-client.ts:859-872` → `permissions.ts:92-135`) exist only on the
  live event bus; `EVENT_TYPES` (`packages/workflow-engine/src/run-event-persistence.ts:29-44`)
  contains no permission event type.

The owner's verdict on the underlying design: **[D]** "When a user asks their agent to run a
workflow, the assumptive experience is that their authoring agent knows how to permission the
workflow agents properly. … The user should never be prompted for giving workflow agents
permissions. … The default permission model should always be permissive, and is only
unpermissive if the authoring agent specifies so."

## 2. Principles (normative)

- **P1 [D] The user is never prompted.** By invoking the authoring agent, the user delegated
  permissioning autonomy to it. No layer between the authoring agent and a workflow agent may
  re-litigate that delegation with an interactive prompt to the human or a silent deny.
- **P2 [D] Permissive by default, as an explicit posture.** The dispatch layer sets an explicit
  permission mode on every agent session — the most permissive posture the backend supports —
  unless the author specifies otherwise. Writes by agents that need them "just work".
- **P3 [D] We set the mode; we touch nothing else.** The engine's entire involvement with
  permissions is the mode it sets. It does not parse, strip, override, or assume anything about
  the user's existing local configuration (settings files, allowlists, hooks). Whatever the
  harness itself does with local configuration is the harness's business.
- **P4 [D] Restriction is authored, and fails fast when unsupportable.** `mode` remains the
  author's lever for confined agents (read-only reviewers, auditors). A mode the backend does
  not advertise fails the agent call loudly at session open — no silent fallback to an
  unconfined or over-confined session. (This preserves the existing strict-confinement
  semantic, `packages/workflow-engine/src/workflow.ts:305-311`.)
- **P5 [D] Residual harness escalations surface to the authoring agent.** When a backend in a
  permissive posture still raises a caller-side permission request (e.g. codex asking to touch
  paths outside its workspace sandbox), the request is not auto-answered in either direction by
  the middle layer. It becomes a first-class pending item the authoring agent answers
  autonomously, with active delivery attempts on every tool touchpoint, and auto-approves
  after 15 unanswered minutes.

## 3. Current state being changed (all [F])

1. **The deny-flip.** `prepareSession` (`packages/acp-agents/src/runner.ts:1345-1352`) sets the
   auto-responder's `defaultOutcome` to `"deny"` whenever *any* `mode` is set headless (no
   permission resolver). Rationale recorded at `permissions.ts:8-11` (a sandboxed mode must not
   be defeatable by auto-approved escalations) and documented only at
   `packages/shared-types/src/agent-run.ts:114-121`.
2. **Mode plumbing.** The engine passes `mode` verbatim (`workflow.ts:1463`); dispatch sends it
   via ACP `session/set_mode` after validating against the backend's advertised `availableModes`
   (`acp-client.ts:2696-2724`), else fails with `modeSelectionError` (`acp-client.ts:1236-1239`).
   When no mode is authored, nothing is sent and the backend runs whatever it defaults to.
3. **Claude backend specifics.** The wrapped adapter (`@agentclientprotocol/claude-agent-acp`,
   pinned at `packages/acp-agents/package.json`) derives its initial mode from the user's
   `settings.permissions.defaultMode` when none is set, passes
   `settingSources: ["user","project","local"]` to the SDK, and advertises
   `dontAsk` ("deny if not pre-approved"). Under `dontAsk` the bundled CLI denies would-be asks
   *before* the adapter's `canUseTool` is consulted, making surfacing structurally impossible
   in that mode. Under `bypassPermissions` the adapter auto-allows without any ACP round-trip.
4. **Auto-responder.** With no allow/deny lists and no mode, `decidePermission` default-allows
   every request (`permissions.ts:104`); its decisions are never persisted (§1).
5. **Checkpoint machinery** (the surfacing pattern to mirror): the engine's `confirm` hook
   drives MCP form elicitation when the client advertises the capability, with keepalive pings
   (`packages/mcp-server/src/server.ts:262-320`); otherwise the checkpoint's authored headless
   default applies, or a durable checkpoint pauses the run
   (`reason: "checkpoint_required"` + `CheckpointContext`,
   `packages/shared-types/src/errors.ts:80-86`, `run-events.ts:146-152`) and is answered by
   resuming with `checkpointReplies`.
6. **Status shape.** `WorkflowRunStatus` carries `calls: WorkflowRunCallStatus[]`
   (`workflow-result.ts:583-599`) — the natural host for per-call permission rollups.

## 4. Requirements

### R0 — Prerequisite: the daemon event path honors its bounds (outcome-specified)

The surfacing flow in R3 relies on `await` returning early and tool responses being timely.
The 2026-08-07 daemon investigation measured that today every journal read re-parses the whole
`events.jsonl` (`run-event-persistence.ts` `readSidecar`/`parseLog`), the event watcher does one
full re-parse per record consumed (`consume()` calling `readEvents(…, {limit:1})`), and drain
loops are microtask-chained — producing a measured 115.8-second main-thread block for a
500-record catch-up on a real 9.7 MB incident journal, blown `waitMs` bounds, failed 2-second
`/healthz` probes, and two daemon respawn incidents. **[D]** This is fixed as part of this
workstream, before or alongside R3.

Required outcomes (implementation not prescribed; the investigation's suggestions — in-memory
tail/incremental reads from the writer's own offsets, batched watcher wakeups with event-loop
yields, an in-loop deadline check for awaits, per-run change notification instead of a
directory-wide `fs.watch` — are suggestions, not requirements):

- A bounded `await` with `waitMs: W` returns within `W` plus a small constant overhead (< 2 s)
  even when the run's journal holds ≥ 20,000 records and the caller's cursor lags by ≥ 5,000
  records. Covered by an automated test at those magnitudes.
- `/healthz` answers within its existing 2 s probe budget while an events subscription and an
  in-flight `await` are both draining a ≥ 20,000-record journal. Covered by an automated test.
- No events consumer on the daemon's request path performs work proportional to the whole
  journal per record served.

### R1 — Explicit permissive posture on every session

**[D]** When an `agent()` call specifies no `mode`, the dispatch layer explicitly sets the
backend's most permissive advertised posture at session open. Setting the mode is the entire
intervention (P3): no settings parsing, no config overrides, no environment mutation.

| Backend | Posture set when author specifies no mode | Notes |
|---|---|---|
| claude | `bypassPermissions` [D] | Kills both the settings-`defaultMode` dependence and the ask→auto-allow round-trips. |
| codex | `agent` (workspace-write sandbox) [D] | Routine work runs unprompted; outside-workspace escalations surface per R3 — the owner's canonical example of P5. |
| pi | nothing sent [F/D] | pi advertises no modes and is inherently full-permission; there is no posture to set. |
| opencode | `build` [F/D] | opencode's default, full-permission mode (it advertises `build` and `plan`); `plan` remains its authored restrictive option. |
| custom ACP backends (`meta.backends`) | the backend's most-permissive advertised mode [C] | Arbitrary third-party servers only: the concrete id is derived from the advertised `availableModes` at session open, never hardcoded. |

**[D]** Authored modes pass through exactly as today, with fail-fast on unsupported ids (P4).
**[D]** The engine never sends `dontAsk` (see R5).

### R2 — Retire the any-mode deny-flip

**[D]** Remove the `defaultOutcome: "deny"` flip triggered by the mere presence of a mode
(`runner.ts:1345-1352`). Its confinement intent survives in exactly one narrowed form: for
calls whose author explicitly selected a restrictive mode, an **unanswered** surfaced request
resolves to **deny** at the R3 deadline instead of approve. The authoring agent can still
explicitly approve such a request — authored confinement bounds the *unattended default*, not
the authoring agent's autonomy.

With R3 in place, the auto-responder never silently answers a request in either direction when
running headless without a permission resolver; it forwards to the R3 surfacing flow. Embedding
hosts that install a `permissionResolver` (`runner.ts:1345`) keep today's behavior — the
resolver remains the programmatic override point. **[C]** Tool lists declared in custom agent-type
definitions (`tools:` / `disallowedTools:` frontmatter in the `.claude/agents`-style registry,
threaded through as `toolNames`/`disallowedToolNames` at `workflow.ts:1466-1467`) keep their
current semantics and are decided immediately, before surfacing: a definition-listed deny stays
an immediate deny, a listed allow an immediate allow. The definition's author already made that
decision explicitly; there is nothing to surface.

### R3 — The permission-request lifecycle

When an ACP `session/request_permission` reaches dispatch and no list entry or resolver decides
it (R2):

1. **Suspend and persist. [D]** The affected agent call suspends (the backend is simply not
   answered yet — ACP request/response semantics already model this). Unrelated agent calls and
   the script continue. The request is persisted to the run journal at raise time — closing the
   §1 persistence gap. **[C]** Two new persisted event types in `EVENT_TYPES`:
   `permissionRequest` (raise) and `permissionDecision` (resolution), the latter carrying
   `outcome` and `source` (see step 6).
2. **Pending item in status. [D]** The request appears in `WorkflowRunStatus` while pending.
   **[C]** As `pendingPermissions: WorkflowPendingPermission[]` at the top level (mirroring how
   pending checkpoints surface), each item carrying: a stable `requestId`, the raising call's
   index and label, the backend, the ACP request's tool/command/path payload and the harness's
   stated rationale (projected and size-capped like other observability scalars), `raisedAt`,
   `deadline` (absolute), and the effective unattended outcome (`approve` or `deny` per R2).
3. **In-flight `await` returns early. [D]** An `await` in progress when a request is raised
   returns immediately with the pending item, exactly as awaits already return on run pause.
4. **Directive surfacing on every touchpoint. [D]** Every `workflow` tool response concerning
   that run (`await`, `inspect`, and the run-launch response if a request is already pending)
   includes a directive block while any request is pending, stating: what is requested and by
   which call, the exact tool-call shape to answer it, and the auto-approve deadline as both an
   absolute time and minutes remaining. This is the owner's acceptance scenario verbatim: a
   15-minute poller's next check-in reads, in substance, "pending permission request — answer
   explicitly now, auto-approves at &lt;time&gt; (&lt;N&gt;m remaining)."
5. **Explicit answer path.** **[C]** A new `workflow` tool action `action: "permission"` taking
   `projectDir`, `runId`, `requestId`, and `outcome: "approve" | "deny"`; dispatch maps the
   outcome onto the request's ACP-advertised options, preferring the once-scoped variant.
   Answering a request that is no longer pending returns the recorded resolution rather than an
   error. **[C]** Additionally, when the connected MCP client advertises elicitation, the
   pending request is also offered through the existing elicitation channel (the checkpoint
   pattern, `server.ts:262-320`); an elicitation answer and a tool-action answer are
   equivalent, first one wins.
6. **Deadline. [D]** 15 minutes from raise (`900_000` ms; **[C]** one named constant,
   consistent with the system's existing 15-minute idle/drain conventions). At the deadline an
   unanswered request auto-resolves to its R2 unattended outcome. Every resolution is recorded
   (journal + run log + `permissionDecision` event) with a `source` distinguishing
   `explicit` (tool action / elicitation), `resolver`, `policy-list`, and `unattended` — an
   auditor can always tell whether a delegated agent decided or the default did.
7. **Deadline extension on late delivery. [D]** If a tool response surfaces a pending request
   with less than 2 minutes remaining, the deadline extends to 2 minutes from that response.
   The clock only ever extends on a real delivery (a tool response that included the directive
   block — passive events-resource reads do not count **[C]**), so unattended runs still
   resolve in exactly 15 minutes, while an actively polling author is never told about a
   request too late to answer it. No cap on repeated extensions: an author that keeps polling
   without answering is reachable and re-warned each time; when it stops, the request resolves
   2 minutes later.

**[D]** REPL-engine broker dispatch (which rides the same acp-agents layer) surfaces pending
permission requests through its existing client-facing channel the same way checkpoints
surface there: pending items in `status`/`wait` results with the same answer/deadline
semantics, reusing the repl tool's existing interaction shape. **[C]** Exact repl-tool field
naming mirrors its checkpoint fields.

### R4 — Permission decisions are aggregated, wherever they are made

**[D]** Every permission decision becomes visible at the call and run level — including
denials decided *inside* a backend rather than by our layer:

- **[F→C]** Claude in-band denials are detectable today: the adapter emits
  `tool_call_update {status:"failed"}` whose `_meta.claudeCode.toolResponse` carries
  `decisionReasonType`/`decisionReason`, with text prefix `Permission denied:`. The projection
  layer (`packages/workflows/src/agent-event-source.ts:183-196`) recognizes this signature and
  tags the projected record as a permission denial rather than a generic tool error.
- **[C]** `WorkflowRunCallStatus` gains a `permissionDenials` count (and the run-level status a
  rollup); `agentEnd` events carry the per-call count.
- **[D]** The run log gains a WARN line on the first denial for a call, naming the call, the
  tool, and the decision source — the exact line whose absence cost four runs.
- Out of scope **[D/F]**: changing the SDK's denial-message wording (upstream; recorded as
  product feedback) — mitigated structurally because the engine never runs claude in a mode
  that produces pre-`canUseTool` denials (R1/R5).

### R5 — `dontAsk` is rejected as a workflow mode

**[D intent, C severity]** `dontAsk` is structurally incompatible with P5 (its denials occur
before the surfacing layer can see them) and with P2 (its allow set is the user's local
settings). The zero-token validator AND dispatch (`prepareSession`) reject an authored
`mode: "dontAsk"` on the claude backend with an error naming the replacement postures:
`bypassPermissions` (permissive) or `default`/`plan` (restrictive, surfacing-capable).
Rejection severity (error, not warning) is a recommendation pending owner veto — §8.

### R6 — Documentation tells the truth

**[D]** The authoring-skill sources (`reference.md` `mode` row, `environment-and-tools.md`)
and everything generated from them (the checked-in authoring prompt, regenerated via the repo
generator — never hand-edited) state the model of this document: the permissive default and
what it means per backend, authored restriction with fail-fast, the surfacing/answer/deadline
flow from the authoring agent's point of view, and the `dontAsk` rejection. The
`packages/acp-agents` and `packages/mcp-server` READMEs document the new tool action and
status fields where they document their existing siblings. No doc may describe `mode` as a
safety lever without stating the surfacing semantics.

## 5. Non-goals

- **[D]** No parsing, stripping, or overriding of user configuration anywhere. The claude
  adapter's `settingSources` behavior is untouched. Consequence, accepted: under an authored
  restrictive claude mode, the user's local allow rules may pre-approve some tools before asks
  reach the surfacing path — harness semantics, left alone.
- No forks or patches of the wrapped adapters or SDKs. Upstream product feedback (routing asks
  to `session/request_permission` under a programmatic client; the workaround-coaching denial
  message) is recorded for the owner, not implemented here.
- No change to codex sandbox semantics, to checkpoint semantics, or to the permission-resolver
  embedding seam beyond what R2 states.
- No new human-facing prompts of any kind (P1).

## 6. Acceptance criteria (clause-checkable)

1. A workflow whose claude implementer must `git commit` and run tests succeeds with no `mode`
   authored, on a machine whose `~/.claude/settings.json` contains an empty allowlist and
   `defaultMode: "plan"` — proving both permissiveness and configuration independence (R1).
2. A codex agent in default posture that touches a path outside its workspace produces: a
   suspended call, a persisted `permissionRequest` event, an early-returning `await`, a
   directive block in the next `inspect`/`await` response with deadline arithmetic, and — upon
   `action:"permission"` approve — a resumed call and a `permissionDecision{source:"explicit"}`
   record (R3).
3. The same scenario left unanswered auto-approves at 15:00 ± scheduler tolerance with
   `source:"unattended"`; with an authored `read-only` mode it auto-denies instead (R2/R3).
4. A tool response delivered at deadline-minus-90-seconds extends the deadline to that
   response plus 2 minutes; journal records show the extension (R3.7).
5. A claude call under authored `default` mode that accrues an in-band denial yields
   `permissionDenials ≥ 1` on its call status and a WARN log line (R4).
6. `mode: "dontAsk"` fails validation and fails dispatch with the R5 error (R5).
7. The R0 bounded-await and healthz tests pass at the stated magnitudes (R0).
8. Regenerated docs/prompt artifacts match their generators (existing drift tests stay green);
   the authoring reference documents the flow (R6).
9. Full workspace typecheck/lint/test suites green; no new human prompts introduced anywhere.

## 7. Rollout note

R0 and R1+R2 are independently shippable; R3-R5 land together (R3 without R2 would surface
requests the deny-flip already killed; R5 without R3 removes capability with no replacement).
R6 lands with whatever it documents.

## 8. Convention-derived specifics awaiting owner veto ([C] ledger)

1. Event type names `permissionRequest` / `permissionDecision` in `EVENT_TYPES`.
2. Status field names: `pendingPermissions` (run level), `permissionDenials` (call level), and
   the `WorkflowPendingPermission` shape in §R3.2.
3. New tool action name `action: "permission"` and its argument shape (§R3.5); repl-tool field
   naming mirroring its checkpoint fields.
4. Elicitation as an additional delivery channel when advertised (§R3.5) — behavior copied
   from checkpoints, not separately decided in conversation.
5. Outcome→ACP-option mapping "prefer the once-scoped variant" (§R3.5).
6. The named 15-minute constant; "delivery" defined as a directive-block-bearing tool response
   (§R3.6-7).
7. Agent-type definition tool lists (`tools`/`disallowedTools` frontmatter) stay immediate
   decisions, never surfaced (§R2).
8. R5 severity: hard error rather than warning.
9. "Most-permissive advertised mode" derivation for custom ACP backends only (§R1) — opencode
   is now pinned first-class to `build`.
