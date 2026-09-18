# REPL v2 — the eval-plane redesign

**Status: BLESSED (owner, 2026-08-12) — build authorized. No open decisions remain; the §9
[C] ledger passed the owner's veto window unvetoed. This document is the bible for the build:
implementers and reviewers must not invent requirements beyond it, and must not defer
anything it requires.**

This document supersedes the *Surface* section of `docs/roadmap/repl-orchestrator.md` and the
tool-seam output-cap contract that document prescribed. The engine sections of that document
(VM, broker, call store, snapshot envelope, steering, presence lifecycle) **stand unchanged**
except where §6 explicitly amends guest-visible behavior.

Every clause is marked with its provenance, per the established convention:

- **[D]** — decided by the owner in conversation (2026-08-12).
- **[F]** — a fact of the current implementation, verified in code or by live dogfooding
  (2026-08-12 session: 19 tool calls, ~15 live subagent spawns on `pi/deepseek-v4-pro` and
  `codex/gpt-5.6-sol`).
- **[C]** — convention-derived by the drafter to close a gap; awaiting owner veto/bless.
  A [C] clause is a *decision made*, not a question left open — vetoing one replaces it,
  it does not reopen the design.

---

## 1. Vision (the north star)

[D] The owner's founding sentence, verbatim: *"a new eval tool, with a dead simple api, that
lets agents 'program' subagents, without the overhead of a full workflow."*

[D] The design anchor is the Python REPL as agents already use it (Jupyter/IPython kernels):
**one verb, persistent state, everything else in-band.** Agents drive Python kernels through
many calls without friction because every call is the same single concept — run code, see
what printed. The cost that matters is *concept count, not call count*.

[F] The v1 surface failed this test: answering one question with one subagent cost three tool
calls (eval → wait → eval) and five concepts (handle, pending, drain, completed, settled), and
the wire contract spoke broker-internal vocabulary (`startedNewTurn`, completed-without-values,
truncation continuation refs, `$N` capture units).

[D] The diagnosis accepted by the owner: the durability plane works and is worth keeping; the
model-facing contract was derived from engine internals rather than from the agent's seat, and
the budget/cap apparatus adds cognitive overhead the tool's users should not carry.

---

## 2. Decision ledger (resolved 2026-08-12)

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Long-await semantics | **[D] Soft-bound return.** Eval holds the call open up to a bound (default 60 000 ms, per-call `timeoutMs` override, 120 000 ms cap — the same numbers v1's `wait` used), then returns an honest still-running result; work continues server-side; any later eval picks up what settled. Chosen after establishing [F] that the suspension/resume machinery is required in both designs (the VM parks continuations regardless; "blocking" only describes how long the HTTP response is held) and that block-until-done exposes callers to host-owned timeouts and auto-retry re-execution (double-spawned subagents). |
| 2 | Printed-value rendering | **[D] Depth-limited repr.** A dumb, predictable repr for printed values; the full value is always reachable by evaluating a slice or binding. No enforcement machinery, no refs, no elision records. The per-argument `$N` capture system is deleted. |
| 3 | Durability posture | **[D] Keep it, hide it.** Bindings AND in-flight subagent turns survive daemon restarts exactly as today, but the ceremony leaves the surface: a refused snapshot auto-resets with a notice instead of demanding a `reset` call; reconcile reports demote to diagnostics. Engine untouched. |
| 4 | Verb set | **[D] `eval` + `interrupt`.** Interrupt stays out-of-band (the one thing code cannot do: break a wedged VM; also cancels a call by id while an eval is blocked on it). Introspection and teardown go in-band as guest functions returning ordinary values: `workspace()`, `agents()`, `reset()`. The `wait`, `status`, and `reset` actions are deleted. |

Closed as design facts in the same conversation (offered for veto; none exercised):

- **[D]** `followUp`/`steer` on an idle/settled session mint a **real, addressable turn** and
  resolve with its **answer**. (v1 discarded the turn's result at `broker.ts:4354-4356` [F].)
- **[D]** A mid-turn `steer` keeps the delivery-outcome vocabulary (`injected` / `queued` /
  `failed`) — its content folds into the original turn's result, so there is no separate
  answer to return.
- **[D]** Model specs and option keys are validated **at admission**, and validation errors
  enumerate the valid vocabulary. (v1 routed unknown backend prefixes whole to the default
  backend and failed ~40 s later with a mislabeled "Internal error" [F].)
- **[D]** `agent()` dispatches **queue** above the concurrency cap instead of rejecting.
  (v1 rejected the 7th dispatch; the natural `parallel(items.map(...))` idiom lost work [F].)
- **[D]** `console.log` renders **one joined line per call** (args joined with a space).
  (v1 emitted one output line and one `$N` ref per argument [F].)
- **[D]** The string `"backend/model"` spec grammar stays (consistency with the workflow tool).
- **[D]** Checkpoints stay as a feature, semantics unchanged.
- **[D]** Budget removal covers **both tools**: the repl's output-cap/truncation-ref apparatus
  AND the workflow tool's `tokenBudget` surface (§7).

---

## 3. The tool surface

Two actions. `projectDir` addressing is unchanged from v1 [F]: one VM per `projectDir`,
required on the shared daemon, defaulted in single-project mode.

### 3.1 `eval { projectDir, code, timeoutMs? }`

Runs `code` in the workspace VM (top-level `await` allowed; top-level `return` a syntax
error; empty string valid — all [F], unchanged). Then, instead of returning immediately:

1. **[D]** The call is held open while the code runs, pumping settlements server-side —
   the fusion of v1's eval with v1's `wait` pump (both existing, tested paths [F]).
2. **[D]** If everything the code is waiting on settles within the bound, the result is the
   *finished* shape: what printed, plus the completion value's repr.
3. **[D]** If the bound elapses first, the result is the *still-running* shape: what printed
   so far, plus the in-flight call ids. The eval continues server-side. **Any later eval —
   including `""` — drains and reports what settled in the meantime** [F: v1's parked-
   continuation machinery, reused as-is].
4. **[D]** Bound default 60 000 ms; `timeoutMs` overrides per call; hard cap 120 000 ms.

**Result shape** [C]:

```
{ output: string, result?: string, running?: string[] }
```

- `output` — the printed stream, verbatim, in order: console lines (one per call [D]),
  raised checkpoint lines (`checkpoint c9: <question>` [C]), and uncaught-error renderings
  (§5). One string, newline-joined — not an array of capture units.
- `result` — the completion value's repr (§4.4), present only when the code finished.
- `running` — the in-flight call ids, present only when the bound elapsed. The ids are the
  stable `c1, c2, …` vocabulary [F] — they are what `interrupt` targets and what `agents()`
  reports, so they must surface here.
- Nothing else. `pending`/`completed`/`checkpoints`/`outputTruncated`/`truncated`/
  `referenced` are deleted from the wire [D — the cap apparatus; §7]. Structured content
  mirrors exactly this shape [C].

**Idempotent polling** [C]: the documented poll idiom is `eval` with `""` — a no-op script
that drains and reports. This replaces v1's `wait` including its safety property (re-sending
it never re-executes work).

### 3.2 `interrupt { projectDir, id? }`

Unchanged from v1 [F]: with `id`, cancel that subagent call (the guest promise rejects
recoverable, `AGENT_CANCELLED` family); without `id`, break the running eval (honest
`refused-idle` when nothing is running; the out-of-band eval-break channel and the quickjs
interrupt handler stand as built [F]). This is the only out-of-band verb because it is the
only operation that cannot be expressed as code: a wedged VM cannot run the code that would
unwedge it, and a blocked eval cannot run `h.cancel()` [D].

### 3.3 Deleted actions and their replacements

| v1 action | v2 replacement |
|-----------|----------------|
| `wait` | `eval` with `timeoutMs` (the pump is fused in) [D] |
| `status` | `workspace()` / `agents()` guest functions (§4.5) [D]. The daemon-wide projectDir-less listing is deleted with it [C — no agent-facing consumer existed; hosts keep the workflow tool's surfaces]. |
| `reset` | `reset()` guest function [D]; the refused-snapshot arm auto-resets (§6.1) [D] |

---

## 4. The guest API

### 4.1 `agent(modelSpec, task, opts?)`

- **[F]** Spec grammar: `"backend/model"` — backend segment, `/`, model id (which may itself
  contain `/`, e.g. `pi/deepseek/deepseek-v4-pro`). Bare `"backend"` runs the backend's
  default model [F: v1 behavior, retained].
- **[D]** Admission validation: the backend segment MUST resolve against the registry
  (built-ins plus registered custom agents) at call time. An unknown segment rejects the
  call **synchronously** with an error that names the segment and enumerates the known
  backends. A spec with no known-backend prefix is an error, never a silent route to the
  default backend.
- **[D]** Option keys: `schema` (structured-output JSON schema, validated per call [F]),
  `cwd`, `configOptions`, `mode` — all [F: the keys as implemented]. The tool description
  MUST enumerate them with one example [D]. An unknown option key rejects synchronously,
  and the error lists the valid keys [D].
- **[D]** `configOptions` keys are validated at admission against the resolved backend's
  known option vocabulary — a typo'd key (`thinkinglevel`) fails in milliseconds naming the
  key and the valid alternatives, not after a paid spawn with `"invalid config option"`
  [F: the v1 failure mode]. Where a backend's vocabulary is genuinely dynamic and cannot be
  known at admission, the late error MUST name the offending key [C — fallback for custom
  agents whose adapters do not publish their option set].
- **[D]** Dispatches above the concurrency cap **queue** for the next free slot, in dispatch
  order — never a rejection, matching the workflow engine's semantics. The cap itself
  (default 6, `maxConcurrentAgents` server config [F]) is unchanged.
- **[F]** Returns a handle-promise: `await` yields the answer (the `schema`-validated object
  when a schema was given, the text otherwise). Start-and-don't-await stays idiomatic.

### 4.2 Handles: `followUp` / `steer` / `cancel`

- **[D]** `h.followUp(content)` on a settled or idle session mints a **new turn with its own
  call id**, visible in `running`/`agents()` and targetable by `interrupt`, and its promise
  resolves with the **turn's answer** — same value semantics as `agent()`. (v1 awaited the
  turn and discarded its output, resolving the token `"startedNewTurn"` [F].)
- **[D]** `h.steer(content)` with the turn in flight keeps v1's delivery-outcome semantics
  [F]: resolves `injected` (live injection), `queued` (no steering extension; delivered next
  turn), or `failed`. Wire-verified working in dogfooding — the steered agent honored a
  mid-turn redirect [F].
- **[C]** `h.steer(content)` on an idle session is redefined as an alias of `followUp` —
  v1 already collapsed the two on idle sessions (both ran `session.prompt` [F]); v2 keeps
  the alias but gives both the followUp answer semantics. There is no path that runs a turn
  and discards its result.
- **[F]** `h.cancel()` cancels the founding call; the promise rejects recoverable. Unchanged.
- **[F]** Lazy re-attach of drained sessions on `followUp` stands as built.

### 4.3 `checkpoint(question)` / `checkpoint.answer(id, value)`

[D] Unchanged. A raised checkpoint surfaces as an `output` line with its id (§3.1) and in
`workspace()`; `checkpoint.answer` in a later eval resolves it [F: round-trip verified in
dogfooding]. The double-JSON-quoted question rendering is fixed in passing [F: cosmetic v1
defect — the question was stringified twice].

### 4.4 Printing and reprs

- **[D]** `console.log(a, b, c)` renders ONE output line: the args' reprs joined with a
  single space. No per-argument capture, no `$N` allocation, no byte-size annotations.
- **[D]** The repr is depth-limited and predictable — printing conventions, not budgets;
  there is **no byte ceiling and no enforcement machinery anywhere on the path** [D], which
  means an agent CAN flood its own context by printing something enormous; this is accepted
  and documented, the Python posture.
- **[C]** The repr rules, chosen for familiarity with Python's defaults:
  - Strings passed **directly** to `console.log`, and a string **completion value**, print
    **whole** — they are the output the orchestrator asked for [F: the rationale of the
    v1 emission-budget fix `0ddce7b`, now with no upper bound at all].
  - Objects/arrays render to **depth 2**; deeper levels render as `{…}` / `[…]`.
  - Collections render their first **20 entries** per level, then `… +N more`.
  - **Nested** strings (inside a collection) render head-limited at **200 chars**.
  - Everything deeper/longer is reached by evaluating a narrower expression — the values
    are alive in the VM; slicing is the API.
- **[C]** Result history: the `$N` globals are deleted [D]; the sole replacement is `_` —
  the previous eval's completion value, IPython-style. Bindings are the memory; agents that
  want a value later assign it a name.

### 4.5 Introspection: `workspace()` and `agents()`

[D] Guest functions returning **ordinary values** (sliceable in the same eval — the
`dir()` / `%who` idiom), replacing the `status` action:

- **[C]** `agents()` → array of `{ callId, modelSpec, task, state, supportsSteering,
  queuedSteers }` — v1's `liveAgents` entries [F], as plain data.
- **[C]** `workspace()` → `{ bindings: [{ name, type, sizeBytes, provenance, task,
  callId?, status? }], inFlight: [ids], checkpoints: [{id, question}], diagnostics }` —
  v1's manifest [F] as plain data, with `status` gaining the honest `"failed"` value for
  rejected handle calls (v1 showed rejected and fulfilled both as `"settled"` [F]).
  `diagnostics` carries what §6 demotes: the last reconcile summary, a retained drain
  error, `childrenClosed`.
- **[C]** `reset()` → tears the workspace down after the current eval completes (the
  host-side effect the `reset` action performed [F]); returns nothing meaningful.

### 4.6 Failure visibility and error rendering

- **[D]** A rejected call is visibly rejected everywhere it appears: `workspace()` bindings
  say `"failed"`, and awaiting it throws.
- **[C]** An uncaught eval error renders in `output` with: the error name and message, the
  guest stack's top frames with **line numbers in the submitted code**, and — when the
  error came from a subagent call — the call id and resolved backend. (v1 rendered a bare
  message line with no stack, no line, no attribution [F].)
- **[F]** An uncaught throw aborts the remainder of that eval (normal JS semantics); the
  attribution above is what makes that livable.

### 4.7 What the guest keeps from v1

[F] The guest library (`parallel`, `pipeline`, `verify`, `judgePanel`, `gate`, `retry`,
`loopUntilDry`) stands — plain JavaScript over `agent()` — amended only where queue-above-cap
[D] removes their over-cap failure mode. No fs, no net, no timers stands [F]; [C] a
`sleep(ms)` guest helper is added (the universal idiom agents reach for; trivially
implementable host-side, and its absence was a verified stumble).

---

## 5. Subagent result hygiene

- **[D-adjacent, F-verified defect]** Multi-chunk agent replies were concatenated with no
  separator ("…won't modify any files.TypeScript files under…") and narration glued to
  answers. **[C]** The acp-agents result fold joins assistant message chunks with `"\n\n"`.
- **[C]** Backend harness noise (e.g. codex's "Warning: Skill descriptions were shortened…")
  is passed through — we do not curate subagent output — but the known-noise phenomenon is
  documented in the tool description so orchestrating agents expect it. (Filtering another
  agent's output is a correctness risk we decline without a stronger mandate.)

---

## 6. Durability: kept, hidden

[D] The whole apparatus stands as built [F]: snapshot envelope, every-boundary cadence,
three-way reconcile (settle-from-store / re-attach / re-issue), client-presence drain,
lame-duck lifecycle, eval-break channel. Surface changes only:

### 6.1 Refused snapshots auto-reset

[D] A stored snapshot that refuses on first touch (corrupt, format bump, wasm-hash
mismatch) no longer poisons every call until a manual `reset`. The workspace **auto-resets
and starts fresh**, and the next eval's `output` leads with a loud one-line notice that it
happened and why. [C] The refused snapshot file is renamed aside (`.refused-<ts>`), not
deleted — auto-reset must not be silent data destruction; the notice names the file.

### 6.2 Reconcile and drain demote to diagnostics

[D] Restore/reconcile summaries and retained drain errors leave the eval result surface
entirely; they live under `workspace().diagnostics` (§4.5). [C] One exception: a restore
that **lost calls** (`failedLost` non-empty) or a drain failure that **lost state** still
gets a one-line notice in the next eval's `output` — losses are never silent, per the
engine's own review lineage [F].

---

## 7. The budget-removal sweep (both tools)

[D] Owner, verbatim: *"All budget-related things, I want to remove. Its been a pain point
for agents using both the tools, and its just adds unecessary cognitive overhead for users'
and their agent's."*

**repl / mcp-server** — deleted outright:
- The tool-seam text caps (`OUTPUT_MAX_LINES` / `OUTPUT_MAX_BYTES` as *wire enforcement*)
  and `capToolResultText` / `capFinalText` on the repl path.
- The aggregate structured-result cap: `capStructuredResult`, the halving passes, the
  string backstop, the absolute-guarantee pass.
- `TruncationRefStore`, the `refs` input parameter, the `truncated` / `referenced` /
  `outputTruncated` output fields, and the continuation-ref read-back protocol.
- The `$N` capture-unit previewer surface (§4.4) and the emission-budget special-casing
  (`EMISSION_STRING_MAX_CHARS` — subsumed by "direct strings print whole, unbounded").

**repl-engine** — the CDP-style previewer is retained *internally* where the engine needs a
bounded token (manifest tokens, checkpoint-question previews, task previews at the engine
seam [F]); [C] those keep their current 200-char bounds as *metadata formatting*, which is
not caller-facing budget machinery.

**workflow tool** — deleted: the `tokenBudget` input parameter and its enforcement in the
engine, and the script-visible budget surface if any remains reachable. [C] Retained:
`lastN` / `logLines` / `waitMs` / `labelGlob` — pagination and scoping parameters, not
budgets. [C] Retained: `maxAgents` and `concurrency` — safety rails on fan-out, not token
budgets; the owner vetoes here if the intent was broader.

---

## 8. What this resolves (dogfooding traceability)

| v1 finding (2026-08-12 session) | Resolution |
|---|---|
| followUp turn's answer discarded (`startedNewTurn`) | §4.2 — answers returned, turns addressable |
| Backend segment never validated; typo → default backend + late "Internal error" | §4.1 admission validation |
| Failures invisible (`completed` hides rejection; manifest says `settled`) | §3.1 shape + §4.5 `"failed"` status |
| Opts keys undocumented; errors don't teach | §4.1 — enumerated in description and in errors |
| `configOptions` typo admitted, late vague error | §4.1 admission validation of keys |
| Uncaught eval error: bare line, no attribution | §4.6 |
| `console.log` per-arg lines + `$N` pollution | §4.4 |
| `parallel` loses items over the cap | §4.1 queue-above-cap |
| Three round-trips per answer | §3.1 soft-bound eval (1 call when fast, 2 when slow) |
| Chunk concatenation without separator; narration glue | §5 |
| Checkpoint question double-quoted | §4.3 |
| Truncation refs / caps cognitive load | §7 deletion |
| No `sleep`; `setTimeout` stumble | §4.7 |
| First-touch `status` reported `"fresh"` on an untouched project | Moot — the `status` action is deleted; `workspace()` runs in an eval, which is a legitimate first touch [C] |

---

## 9. The [C] ledger (for one-pass veto/bless)

1. §3.1 result shape `{ output, result?, running? }`, structured content mirroring it.
2. §3.1 checkpoint lines rendered in `output` (no dedicated wire field).
3. §3.1 `eval ""` as the documented idempotent poll idiom.
4. §3.3 deletion of the daemon-wide projectDir-less listing with the `status` action.
5. §4.1 late-error fallback for backends with dynamic option vocabularies (must name the key).
6. §4.2 idle-session `steer` = `followUp` alias.
7. §4.4 repr numbers: depth 2, 20 entries/level, nested strings 200 chars, direct strings whole.
8. §4.4 `_` as the only result-history global.
9. §4.5 `workspace()` / `agents()` / `reset()` shapes as specified.
10. §4.6 error rendering contents (stack top frames, line numbers, call id + backend).
11. §4.7 `sleep(ms)` guest helper.
12. §5 chunk joiner `"\n\n"`; harness noise passed through but documented.
13. §6.1 refused snapshot renamed aside, not deleted.
14. §6.2 loss notices (lost calls / lost state) stay one-line loud in `output`.
15. §7 workflow-tool retention boundary: pagination params and fan-out rails stay.
16. §10 versioning: breaking tool-surface change ships as minor bumps (`mcp-server` 0.29.0,
    `repl-engine` 0.3.0) with the snapshot-format version bumped — old stored workspaces
    take the §6.1 auto-reset path on first touch.

---

## 10. Delivery notes

- [C] Versioning per ledger item 16. The guest environment changes (`$N` removal, `_`,
  `sleep`, guest-fn additions) bump `__REPL_GUEST_VERSION` [F: the version global exists],
  which invalidates stored snapshots — intentionally routed through §6.1 auto-reset.
- [F] The known pre-existing `repl-daemon.test.ts` "review round 8" flake (16.5k-checkpoint
  elided-count reconciliation) sits in test surface this redesign deletes (elided-count
  reconciliation is cap machinery); its disposition is noted here so its disappearance is
  read as *deleted with its feature*, not silently fixed.
- Convention: implementation via workflow per the established delivery pipeline; this
  document is the bible for it. No workflow is authorized by this document alone.
