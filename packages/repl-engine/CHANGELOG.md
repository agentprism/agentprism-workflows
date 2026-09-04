# @automatalabs/repl-engine

## 0.4.21

### Patch Changes

- Updated dependencies [e1fd6c2]
  - @automatalabs/workflows@3.0.0

## 0.4.20

### Patch Changes

- Updated dependencies [18561da]
  - @automatalabs/acp-agents@1.1.2
  - @automatalabs/workflows@2.0.1

## 0.4.19

### Patch Changes

- Updated dependencies [67ca48d]
  - @automatalabs/workflows@2.0.0

## 0.4.18

### Patch Changes

- Updated dependencies [3a3932c]
  - @automatalabs/acp-agents@1.1.1
  - @automatalabs/workflows@1.1.3

## 0.4.17

### Patch Changes

- Updated dependencies [58b4a86]
  - @automatalabs/acp-agents@1.1.0
  - @automatalabs/workflows@1.1.2

## 0.4.16

### Patch Changes

- @automatalabs/acp-agents@1.0.2
- @automatalabs/workflows@1.1.1

## 0.4.15

### Patch Changes

- Updated dependencies [620c9ca]
- Updated dependencies [620c9ca]
- Updated dependencies [620c9ca]
  - @automatalabs/workflows@1.1.0
  - @automatalabs/acp-agents@1.0.1
  - @automatalabs/shared-types@1.1.0

## 0.4.14

### Patch Changes

- Updated dependencies [c562237]
- Updated dependencies [c562237]
  - @automatalabs/shared-types@1.0.0
  - @automatalabs/workflows@1.0.0
  - @automatalabs/acp-agents@1.0.0

## 0.4.13

### Patch Changes

- Updated dependencies [52c7701]
  - @automatalabs/acp-agents@0.43.1
  - @automatalabs/workflows@0.58.1

## 0.4.12

### Patch Changes

- Updated dependencies [06725fd]
  - @automatalabs/shared-types@0.34.0
  - @automatalabs/acp-agents@0.43.0
  - @automatalabs/workflows@0.58.0

## 0.4.11

### Patch Changes

- @automatalabs/acp-agents@0.42.1
- @automatalabs/workflows@0.57.1

## 0.4.10

### Patch Changes

- Updated dependencies [1452e15]
  - @automatalabs/shared-types@0.33.0
  - @automatalabs/acp-agents@0.42.0
  - @automatalabs/workflows@0.57.0

## 0.4.9

### Patch Changes

- Updated dependencies [661d9d1]
  - @automatalabs/workflows@0.56.0
  - @automatalabs/acp-agents@0.41.5

## 0.4.8

### Patch Changes

- Updated dependencies [2e87092]
  - @automatalabs/workflows@0.55.0

## 0.4.7

### Patch Changes

- Updated dependencies [7f67500]
  - @automatalabs/acp-agents@0.41.4
  - @automatalabs/workflows@0.54.1

## 0.4.6

### Patch Changes

- Updated dependencies [6821b31]
  - @automatalabs/acp-agents@0.41.3
  - @automatalabs/shared-types@0.32.0
  - @automatalabs/workflows@0.54.0

## 0.4.5

### Patch Changes

- Updated dependencies [9ddec60]
  - @automatalabs/acp-agents@0.41.2
  - @automatalabs/workflows@0.53.2

## 0.4.4

### Patch Changes

- @automatalabs/acp-agents@0.41.1
- @automatalabs/workflows@0.53.1

## 0.4.3

### Patch Changes

- ea0b68c: Make agent configuration fail closed and fully discoverable. Config probes now return effective ACP session modes, including config-option fallback normalization and explicit `null` for unsupported modes; workflow preflight rejects guessed or unadvertised modes before admission. Workflow `agent()` rejects unknown option keys before allocation, while REPL rejects reserved `configOptions.model` with modelSpec-native guidance and preserves independent mode failures instead of falsely blaming carried config keys. Static external MCP resources now accept subscribe/unsubscribe as no-ops.
- Updated dependencies [ea0b68c]
- Updated dependencies [ea0b68c]
- Updated dependencies [ea0b68c]
  - @automatalabs/acp-agents@0.41.0
  - @automatalabs/workflows@0.53.0

## 0.4.2

### Patch Changes

- @automatalabs/workflows@0.52.1

## 0.4.1

### Patch Changes

- Updated dependencies [de4e704]
  - @automatalabs/acp-agents@0.40.0
  - @automatalabs/workflows@0.52.0

## 0.4.0

### Minor Changes

- 4be0807: Replace the REPL's state-dependent `followUp`/steering behavior with strict active-turn steering and durable queued turns. Agent handles now expose `steer`, `queue`, and `cancel`; `followUp` is removed. `steer` never starts or queues work and resolves only `injected`, `idle`, or `unsupported`. `queue` creates an independently awaitable, addressable FIFO turn on the same ACP session with exact cancellation, persistence, restore, and concurrency semantics.

  Make ACP extension metadata transport transparent. `customCapabilities` metadata gates and the derived steering/loaded-turn capability booleans are removed. Interactive steering returns the complete raw extension response, prompt turns expose their underlying `PromptResponse`, and extension owners interpret raw initialize metadata at the point of use.

  Pi ACP and Codex ACP now implement strict active-turn steering only. Idle or settlement-raced steering returns `promptRequired/noRunningTurn`; steering can no longer create a backend turn. REPL guest snapshots and call ledgers from the previous format are intentionally invalidated and auto-reset without executing old guest code.

### Patch Changes

- Updated dependencies [4be0807]
  - @automatalabs/acp-agents@0.39.0
  - @automatalabs/workflows@0.51.0

## 0.3.4

### Patch Changes

- @automatalabs/acp-agents@0.38.1
- @automatalabs/workflows@0.50.1

## 0.3.3

### Patch Changes

- Updated dependencies [205d110]
- Updated dependencies [205d110]
- Updated dependencies [0cf5bc5]
  - @automatalabs/acp-agents@0.38.0
  - @automatalabs/workflows@0.50.0
  - @automatalabs/shared-types@0.31.0

## 0.3.2

### Patch Changes

- Updated dependencies [4b27257]
- Updated dependencies [c90fef0]
  - @automatalabs/acp-agents@0.37.4
  - @automatalabs/workflows@0.49.0

## 0.3.1

### Patch Changes

- Updated dependencies [dfe3c34]
- Updated dependencies [2137490]
  - @automatalabs/acp-agents@0.37.3
  - @automatalabs/workflows@0.48.1

## 0.3.0

### Minor Changes

- c4c5a09: Redesign the interactive REPL around `eval` and `interrupt`. `eval` now waits up to its soft
  bound, returns either `{ output, result }`, `{ output, running }`, or `{ output }`, and supports an
  empty-string polling call. Workspace inspection and teardown move into the guest as `workspace()`,
  `agents()`, and `reset()`; printing uses the depth-limited repr and `_` retains the previous
  completion value. Dispatches beyond the workspace concurrency limit queue in order, follow-up turns
  return their answers, invalid backend/options fail at admission, snapshots that cannot be restored
  auto-reset with a recovery notice, and reconcile/drain details move under workspace diagnostics.

  This is a breaking removal of the workflow execution `tokenBudget` option, the script-visible
  `budget` global, and the per-phase `phase(title, { budget })` option from both
  `@automatalabs/workflows` and `@automatalabs/workflow-engine`. Workflow scripts must use explicit
  loop bounds; `phase()` now accepts only its title. Agent-count, concurrency, timeout, and inspection
  limits remain available.

  ACP assistant message chunks are now joined with a blank line, preventing adjacent chunks from
  being concatenated into a single malformed sentence.

### Patch Changes

- Updated dependencies [c4c5a09]
  - @automatalabs/workflows@0.48.0
  - @automatalabs/acp-agents@0.37.2

## 0.2.4

### Patch Changes

- Updated dependencies [216bc1c]
  - @automatalabs/acp-agents@0.37.1
  - @automatalabs/workflows@0.47.6

## 0.2.3

### Patch Changes

- Updated dependencies [4f18373]
  - @automatalabs/acp-agents@0.37.0
  - @automatalabs/shared-types@0.30.0
  - @automatalabs/workflows@0.47.5

## 0.2.2

### Patch Changes

- Updated dependencies [471de39]
  - @automatalabs/acp-agents@0.36.5
  - @automatalabs/workflows@0.47.4

## 0.2.1

### Patch Changes

- Updated dependencies [0c33e65]
  - @automatalabs/acp-agents@0.36.4
  - @automatalabs/workflows@0.47.3

## 0.2.0

### Minor Changes

- 0ddce7b: repl: emit `console.log` output and eval results up to the result byte budget instead of clamping every string to a 200-char preview.

  A directly emitted top-level string — a `console.log` argument or the eval result — is output the orchestrator asked to see, not a preview of a value's shape, so it is now carried whole up to the byte budget ("200 chars OR the KB max, whichever is greater") rather than head/tail-elided at 200 characters. A subagent's answer comes back whole in one call instead of forcing creative slice-by-slice extraction. The tool-result caps rise to **4000 lines / 50 KB** (from 256 / 10 KB), so a multi-line answer fits; only strings past the budget head/tail-elide (keeping their `$N` ref for the remainder). Nested and property strings are unchanged — they stay preview-short.

### Patch Changes

- Updated dependencies [0ddce7b]
- Updated dependencies [0ddce7b]
  - @automatalabs/workflows@0.47.2

## 0.1.8

### Patch Changes

- Updated dependencies [217ba32]
  - @automatalabs/workflows@0.47.1

## 0.1.7

### Patch Changes

- Updated dependencies [4a7e4b5]
  - @automatalabs/workflows@0.47.0

## 0.1.6

### Patch Changes

- Updated dependencies [d4a0682]
  - @automatalabs/workflows@0.46.10

## 0.1.5

### Patch Changes

- Updated dependencies [7e1f1db]
  - @automatalabs/acp-agents@0.36.3
  - @automatalabs/workflows@0.46.9

## 0.1.4

### Patch Changes

- Updated dependencies [05af591]
  - @automatalabs/acp-agents@0.36.2
  - @automatalabs/workflows@0.46.8

## 0.1.3

### Patch Changes

- Updated dependencies [1a2f27d]
  - @automatalabs/workflows@0.46.7

## 0.1.2

### Patch Changes

- @automatalabs/workflows@0.46.6

## 0.1.1

### Patch Changes

- Updated dependencies [db7b927]
- Updated dependencies [c6a896c]
  - @automatalabs/acp-agents@0.36.1
  - @automatalabs/workflows@0.46.5

## 0.1.0

### Minor Changes

- 6a7ea36: REPL orchestrator phase C: the broker, the append-only call store, and the eval tool-result semantics.

  - **The broker** (`src/broker.ts`) — `Broker.attach(workspace, options)` takes over a workspace's four `__host_*` callbacks (by-name re-registration via the new `Workspace.rehost`; the guest library and its pending-call registry are untouched) and dispatches `agent(modelSpec, task, opts)` as held-open ACP sessions through `@automatalabs/acp-agents` (`openSession`, `keepSession: true`, cwd defaulting to the workspace project dir; `schema` validated by acp-agents' own structured-output ladder driven over the session). **6 concurrent subagents per workspace** (doc-settled; configurable) — over-cap dispatches refuse at dispatch time (recorded in the store, recoverable `ConcurrencyLimitError`). **Steering resolves with what actually happened** — live `_session/steering` injection with the backend's verbatim outcome where the extension is advertised, honest `queued`/`startedNewTurn` next-turn delivery where it is not, `failed` for wire errors (never a hard error), `cancelled`/`idle` for cancel (the cancelled call rejects the RECOVERABLE `AGENT_CANCELLED` — one worker's cancellation never aborts the parallel()/pipeline() owning it). **The eval tool-result shape** — `{ output, outputTruncated, result?, pending, checkpoints, completed }`: previewed console lines (capped 256 lines / 10 KB), the trap-free previewed completion value, pending call ids on suspension (no fabricated value), previewed checkpoint questions, and settled call ids. **Suspended-eval semantics** per transfer lesson 3: continuations resume at settlement like a `.then`; late uncaught rejections surface as error-level console lines in the next tool result (the new `rejectionBridge` eval option). **Checkpoints** per transfer lesson 4: root-mediated answers, recorded before settlement, settling within the answering eval.
  - **The call store** (`src/store.ts`) — transfer lesson 1: every outcome recorded by call id BEFORE the guest settlement; `InMemoryCallStore` plus the durable append-only `JsonlCallStore` (fsynced JSON-lines, torn-tail repair with sidecarred fragments, unterminated-but-complete records kept, newline-terminated corruption refused, appends healing to the acknowledged prefix). The pump's record → settle → consume loop is first-wins idempotent on both sides; `Broker.reconcile()` implements the settle-from-store arm of the three-way restore reconciliation — exactly-once settlement across a simulated crash is pinned by tests (live retry and snapshot/restore paths).
  - **Engine seams** — `ReplEvalOptions.rejectionBridge` (the uncaught-rejection bridge on the pending arm), the internal eval-with-completion handle seam, `Workspace.rehost`/`snapshot`/`restore` (the raw snapshot seams the daemon layer's identity envelope wraps later). `InteractiveSession` gains additive `currentTurnText()`/`finalMessageText()`/`rawStructuredOutput()` passthroughs so the broker can drive acp-agents' own schema ladder.
  - The public type surface stays fully self-contained (structural `BrokerRunner`/`BrokerSession` stand-ins — no acp-agents/quickjs-wasi types in the published declarations; the consumer fixture now exercises the whole phase-C surface).

- 05a8e0f: REPL orchestrator phase B: the guest-side library, the host bridge, the previewer, and the output caps.

  - **Guest library** (`src/guest/guest-library.ts`) — a fresh TypeScript-authored, version-marked plain script injected at VM creation (`__REPL_GUEST_VERSION`, `Symbol.for("repl.guest")` reconciliation surface). Sandbox globals per the roadmap doc: `agent(modelSpec, task, opts?)` — the doc's own signature, `agent("pi/deepseek-v4-flash-max", "research X")` — where the returned promise IS the live handle, carrying non-enumerable `id`/`followUp`/`steer`/`cancel` (the steering calls resolve with what actually happened, mirroring acp-agents steering outcomes); `checkpoint()`/`checkpoint.answer()` (answer delivery through the `__host_checkpoint` trailing-argument mode); `console.{log,info,warn,error,debug}`; and the pure-JS combinators from `packages/workflows/src/dsl.d.ts` semantics (`parallel`, `pipeline`, `verify`, `judgePanel`, `gate`, `retry`, `loopUntilDry`). `phase()` is deleted and there is NO budget surface — no `budget()` global, no ledger, no caps vocabulary; the host signals non-recoverable failures exclusively through `recoverable: false`. The pending-call registry (entries carry `sessionId` — the founding session id for steering calls — and `modelSpec`, so pending work is fully re-issuable) travels inside snapshots; `ReplVm.restore` + `registerGuestHostCallbacks` make the versioning discipline (host serves older guests; never re-inject over a workspace) concrete and tested.
  - **The bridge** (`src/bridge.ts`) — the four `__host_*` callbacks as the realm's entire effect surface: `__host_agent(callId, modelSpec, task, optionsJson)`, `__host_checkpoint(callId, question, optionsJson, answerJson?)`, `__host_agent_steer(callId, sessionId, action, payloadJson)` (both the operation's own registry id and the founding session id cross the bridge, so a pending steer is snapshot-reconcilable), `__host_console(level, payloadJson)`. `GuestCall` owns and disposes every handle it touches — raw `qjs_new_promise` parts (the shim's `newPromise()` Deferred pins the reject function until VM dispose, measured to exhaust a 2 MiB VM after ~5,000 resolved calls), the marshalled value, and the promise handle released via microtask after the trampoline's dup — pinned by 5,000/20,000-call bounded-memory tests. The reconciliation surface (`readGuestSurface`: pending/settle/stats — registry ops use captured intrinsics, immune to `Map.prototype` pollution) pins no guest memory: handles are acquired per call and disposed on the spot.
  - **Workspace injection** — `Workspace.create` installs the bridge at VM creation (the doc's discipline; `agent`/`checkpoint`/combinators are never undefined), with a default parking bridge (calls park honestly, console events accumulate) or custom `handlers` per workspace/registry. The workspace exposes the render (`renderRef`), manifest (`inspectBinding`), parked-call and surface seams the `repl` tool layer builds on.
  - **The console bridge** — every logged argument frozen IN FULL into a real `$N` global via `structuredClone` (with an iterative marker-copy fallback; deep nesting cannot crash the VM; weak collections/functions/symbols/promises degrade to typed markers), best-effort `{ refs, args }` payload, `console.*` never throws.
  - **The previewer** (`src/preview.ts`) — CDP ObjectPreview model per the harness's normative FORMAT.md (imitated): one collapsed level, 8/8/40/200/120 caps, head+tail elision, overflow flag, positional indices, byte-size formatting with the promotion rule, 400-char backstop. Side-effect-free by construction: engine brand checks and own-descriptor reads only, proxies previewed as proxies (incl. `Proxy(revoked)`), typed-array elements via language-guaranteed reads, corrupted key enumeration degrades with `overflow: true` (FORMAT.md §6 — typed arrays included). Forbidden seams stay unwired: symbol descriptions are never read (the bare brand `Symbol`, also for thrown-symbol error messages; a guest that replaces `Symbol.keyFor` cannot forge rendering), `qjs_get_array_buffer`'s raw data pointer is never passed to `qjs_is_exception`, and every heap-returning raw export (`qjs_get_typed_array_buffer`'s backing buffer, `qjs_get_proxy_target`'s exception box) is disposed on every path (3,000-preview bounded-memory test). `renderRefLine`/`renderGlobalLine` render `[$14 · object · 48kB] {…}` lines; accessor-rebound `$N` slots render a sabotage marker (the getter is never invoked).
  - **Output caps** (`src/caps.ts`) — 256 lines or 10 KB per tool result, whichever trips first; line-granular, UTF-8-counted with `\n` separators; over-cap content remains reachable through `$N`.
  - **Engine additions** — the structured-clone extension is attached to every VM (and to restores); `ReplVm.restore`; the trap-free primitives moved to `src/trapfree.ts` (shared with the previewer); the public type graph stays free of quickjs-wasi types (self-contained `ReplSnapshot`; module-scoped shim access) — verified by the non-DOM `skipLibCheck: false` consumer fixture, extended to the new surface.
  - **Pinned engine quirks** — a `value` GETTER on `Object.prototype` empties quickjs-ng's async-eval completion wrapper without running guest code (completions honestly degrade to `{}`); the engine's spec-mandated thenability check fires a polluted `then` getter once per eval before any of our code runs. The previewer itself adds zero getter fires (baseline-count tests).

- 62c01d5: New engine package for the REPL orchestrator: the QuickJS-in-WASM VM layer — one VM per workspace with workspace-owned lifecycle (create/eval/drain/dispose), eval with top-level await plus the job drain, per-VM `memoryLimit`, per-eval `interruptHandler`, and a structurally enforced trap-free result boundary. `quickjs-wasi` is used as-is including its shipped `quickjs.wasm` binary (pinned exact). This is phase A of the `repl-orchestrator` roadmap; the `repl` MCP tool registration lands in a later phase on top of `WorkspaceRegistry`.

  Review-hardened on top of the initial phase: the own-descriptor read drives the raw `qjs_get_own_property_descriptor` export and never constructs quickjs-wasi's getter-invoking `JSException` (a failing descriptor read is a pinned regression test); settlement drains accept their own per-drain `interruptHandler` so a delayed continuation can't run away unguarded; `WorkspaceRegistry.get` dedupes the in-flight creation promise (exactly one VM under concurrent first touches, with dispose-cancels-in-flight semantics); eval completion is fully synchronous (raw `qjs_promise_result`), making disposal un-raceable and serializing VM operations so interrupt-slot save/restore is concurrency-safe; `WasmModule` is an opaque branded type so `{ wasm: 42 }` is a compile-time error (negative consumer tests); thrown symbols render as the trap-free bare brand `Symbol`, never the fabricated `NaN` (the description is not readable without the forbidden `qjs_get_symbol_description` seam).

- 529e954: REPL orchestrator phase-E review fixes (engine side):

  - **Global lexical bindings in the workspace manifest**: top-level `let`/`const`/`class` declarations — the roadmap's canonical `const research = agent(...)` state — are now enumerated by the manifest (and by `inspectGlobal`/`inspectBinding`) with structure-only tokens, provenance labels, and live-handle status. Lexical bindings are not global-object properties and no guest API can enumerate them (ECMAScript's global declarative record is non-reflectable); the engine reaches them through the QuickJS context's internal global-var object, located with a self-calibrating scan (the `global_obj`/`global_var_obj` adjacency invariant of the NaN-boxed JSValue encoding, verified against the pinned quickjs-wasi 0.15.1 binary). A layout the scan cannot find refuses with the coded `LexicalEnumerationError` — never silent omission. A lexical binding shadows a same-named global-object property, so the manifest lists ONE binding per name, the lexical view (what the orchestrator's code sees).
  - **Lexical provenance**: the provenance registry's attribution pass now covers lexical bindings — the host enumerates them and passes the names as the pass's third argument (no guest-visible surface grows; snapshots whose registry predates the feature skip the merge, the doc's older-library-served-as-is discipline). A name first attributed as a property and later shadowed by a lexical declaration is re-attributed to the eval that created the lexical binding, then stable.
  - **`capFinalText`**: the doc's 256-line / 10 KB caps applied to a tool result's FINAL assembled text (console lines, result line, pending/checkpoint/completed sections, timeout notes — everything), with a caller-supplied truncation marker whose own budget is reserved inside the caps so it always ships and the capped result never exceeds the limits.
  - New exports: `baselineLexicalKeys` (the fresh-realm lexical baseline, computed and cached like `baselineGlobalKeys`) and `capFinalText`.

- bd28cd9: The re-attach arm's unobservable-turn degradation and the client-presence drain's two hard edges (phase-D review round 3), plus the manifest's full provenance surface.

  - **The re-attach arm never settles partial output and never re-issues a possibly-running turn.** The loaded-turn seam's rejections are classified three ways (structural markers, so third-party adapter seams can throw the same classes): the still-running class (`LoadedTurnStillRunningError`) — the broker keeps the loaded session attached and the call pending, warns guest-visibly, and RE-ARMS the seam when the rejection is re-armable (a `running` turn past its max-wait bound — a later `_session/loaded_turn/ended` notification or a cancel still settles the call), or resolves a `hold` in-flight outcome when nothing observable will ever arrive (a backend without the `_session/loaded_turn` extension); the failed-at-backend class (`LoadedTurnFailedError`) — a definite outcome, recorded and settled as an ordinary rejection, never re-issued; and the safe-re-issue class (no user message, `interrupted`, a dead process). A third-party `BrokerSession` adapter WITHOUT the `awaitCurrentTurn` seam now keeps the loaded session attached and the call pending (surfaced guest-visibly, cancelable) instead of the old release-and-re-issue. While the broker is draining/disposing, even safe-re-issue rejections hold — a fresh child must never open and run after the last client disconnected. The pump's in-flight outcomes gain the `hold` value (drop the entry without recording/settling).
  - **The client-presence drain waits for opening calls** (`openSession` parked — an opening call has no session entry yet, so the old drain returned `true` immediately and let the child open and run after the last client disconnected) and in-flight lazy re-attaches; a parked open that outlives the bound is STOPPED (the late child is closed before it ever prompts, the call settles as the recoverable `AGENT_CANCELLED`, queued steers are dropped with the durable `dropped` marker).
  - **The outer drain bound is absolute**: every post-deadline cancel/release await races the remaining time, so a hung backend can never block disconnect/shutdown past the reused session-eviction TTL.
  - **The workspace manifest exposes the doc's full provenance surface**: bindings now carry `task` (the founding `agent()` call's task text for `worker cN` and agent-handle bindings, read from the call store, capped at 200 chars) alongside the existing `provenance` label and `provenanceAtMs` wall clock.

- 2e4bb60: Phase-D review round 5 fixes for the client-presence drain, the lazy re-attach, and settlement provenance:

  - **The drain latch never skips in-flight work**: a fresh agent dispatch and a lazy re-attach start now clear the broker's `drained` latch the moment a child may open (it used to stay set until the open/load RESOLVED). A second disconnect after a reconnect with a parked `openSession` (or a parked lazy load) drains again — the parked open is stopped and the late child is closed before it ever prompts.
  - **The drain/disposal generation fence**: the drain deadline and `dispose` bump a generation; an `openSession` or lazy `loadSession` that lands after the bump is released immediately — it never registers a session entry and never prompts (a child can never open or run after the last client disconnected, nor after a reset/dispose).
  - **`cancelCall`'s wire phase runs OUTSIDE the serialized operation chain**: the lazy re-attach (and the session cancel) no longer hold the chain, so a hung backend `loadSession` can never delay `drainForDisconnect`'s entry — the documented outer drain bound is effective even then. A consume phase under the chain re-checks the entry and rolls the cancellation marker back on an idle session (a settled turn is a settled turn; queued steers are never dropped by a stale cancel).
  - **Per-call settlement provenance**: the settlement pump now delivers ONE ready call at a time, running one drain + one provenance pass per settled call (each with its own settlement boundary). Two simultaneously ready independent continuations producing separate bindings are attributed to their OWN worker and task (`worker c1` / `worker c2` with the matching task text), never a joined batch label.

- 142a23e: REPL orchestrator phase D, review round 6: the drain's outer bound is absolute for the guest drain too, the bound's forced stop never orphans a pending call, and a client reconnecting mid-drain aborts the drain.

  - **The disconnect bound now bounds the GUEST drains the drain's pumps trigger** (review: a ready settlement resumed the guest continuation through `drainJobs` under the per-eval deadline alone — a runaway continuation near the disconnect deadline could exceed the session-eviction TTL). `pumpUnlocked`/`drain` take an optional remaining-bound deadline and compose it into the quickjs interrupt handler; both of `drainForDisconnect`'s pumps race it, and an interrupted continuation surfaces as a warn-level line in the next tool result.
  - **The bound's forced stop never orphans a pending call** (review: a re-attached call whose seam rejected mid-drain resolved `hold`, then the release phase discarded its session — the call stayed pending forever, uncancelable except by reset, because reconcile never runs again on a live workspace). After the bound expires, every call still pending on an attached session is settled with the recoverable `AGENT_CANCELLED` (recorded FIRST, settled into the guest, one bounded drain + settlement boundary) — the same forced-stop vocabulary as a stopped open; a still-observing task's later outcome is a first-wins no-op against the recorded completion.
  - **A client reconnecting mid-drain ABORTS the drain** (review: the drain ran to its release phase and closed every child regardless of presence — children must remain warm while any client is connected). `drainForDisconnect(boundMs, shouldAbort?)` consults the abort probe every iteration and before every destructive phase; an abort leaves every child attached and running, keeps the drain latch clear, and returns `false` so the next disconnect drains again.

- 1b9b23f: REPL orchestrator phase D, review round 10: the bounded drain settles every outstanding restored call, the restore fence detaches its releases, and reset/dispose detach a parked first touch.

  - **The bound's forced stop settles every outstanding restored call** (review: the reconciliation registers calls in the opening-call registry only as its serialized loop reaches them — parked on the FIRST pending call's never-resolving `loadSession`, it never processed the entries behind it, so a bounded disconnect settled only that one call and reported drained while the later registry entries stayed pending and uncancelable; and a load that later landed let the resumed loop initiate SUBSEQUENT loads after the drain/disposal generation bump — children opening and running after the last client disconnected). `drainForDisconnect`'s forced stop now also settles every untracked pending registry entry at the bound: completed-while-down entries from the store (the store arm's semantics, first-wins), agent entries with the recoverable `AGENT_CANCELLED`, steers with the honest `failed`, and pending checkpoints the parked reconcile never reached are re-surfaced into the checkpoint table so answering still works. `reconcileAgentCall` refuses to initiate any load or re-issue while the broker is draining/disposed — the resumed loop settles the recorded completions from the store and opens nothing. Regression: multiple pending restored calls with a never-resolving first load, bounded drain, late landing — no pending entry, no second load, exactly-one release.
  - **The restore-time teardown fences detach their best-effort releases** (review: the late-load fences awaited `session.release()` with no deadline — a custom backend with a hung release kept the reconciliation, and with it the daemon's first touch, pending indefinitely, reintroducing the unbounded-teardown defect). The fence releases in `reconcileAgentCall` (both arms), `doLazyReattach` and `runAgentTask`'s stopped-open path are fire-and-forget with catch handlers attached. Regression: a late-landing restore load whose release hangs — the reconciliation completes promptly and the release was issued exactly once.
  - **reset/dispose detach a parked first-touch flight** (review: `disposeReplProjectState`/`resetReplProjectState` left `state.firstTouch` in place — the generation check ran only after `broker.reconcile()` resolved, so with a never-resolving restore-time load every subsequent touch returned the stale promise and hung forever). Both teardown paths drop the flight from the state (a fresh touch starts a new first touch) and mark its eventual rejection handled — the stale touch still aborts loudly for its original caller when the parked load lands. Regression: parked restore load → reset → fresh touch completes on a fresh workspace; the late-loaded session is released exactly once and the stale touch aborts naming the teardown.

- 21f2747: REPL orchestrator phase D, review round 12: the client-presence drain's deadline is absolute against a chain REPLACED mid-wait — the serialized-chain enqueue is atomic with a changed-chain re-check.

  - **The drain bound now survives an operation queued precisely as the prior chain releases** (review rejection: `serialized()`'s deadline path raced ONE chain promise, and after that race won it re-read the mutable `this.opChain` field — an operation enqueued in the microtasks between the chain's release and the re-read chained onto the just-released chain and REPLACED the field, so the drain enqueued behind the NEW operation with no deadline race on it. Reproduced with a pending call: a 20 ms `drainForDisconnect()` took 307 ms; with a replacement op polling another pending call, the drain returned only at the replacement's own 10 s timeout). The post-race path now re-checks the field and, when it changed, re-races the new chain against the REMAINING time — each loop pass only consumes remaining budget, so the total wait can never exceed the deadline plus timer slop no matter how many ops enqueue around a release; and the check-and-enqueue when the field is unchanged run in ONE synchronous block, so no operation can interleave between them. Regression: a drain racing a chain released by a settled call, with a second wait op enqueued mid-wait holding another pending call — the drain returns at its deadline, settles the still-pending call durably, and never waits behind the replacement.

- 73cc45b: REPL orchestrator phase D, review round 7: a bound-expired openSession settles durably at the drain bound, the drain's outer bound is measured from method entry, and the broker teardown is bounded.

  - **A bound-expired openSession settles DURABLY at the bound** (review: the opening call was only flagged in `stoppedOpens` — it was not recorded, guest-settled, drained or snapshotted until `openSession` resolved, so a parked open that NEVER resolves left the broker reporting drained with the call pending and uncancelable). The drain's forced stop now settles every call still opening with the recoverable `AGENT_CANCELLED` at the bound (recorded FIRST, settled into the guest, one bounded drain + settlement boundary) while RETAINING the `stoppedOpens` late-child fence — an eventual landing still closes the child immediately without prompting, and the late reject is a first-wins no-op against the recorded completion. In-flight steer wire calls the bound cut off (a lazy re-attach whose load never lands, an injection/delivery the release phase is about to cut) settle the honest `failed` the same way, so the drain never reports drained with a pending call of any kind.
  - **The drain's outer bound is measured from METHOD ENTRY, before the serialized-chain wait** (review: the clock used to start inside the serialized closure, so a drain queued behind a long operation ran its whole window after the queue wait, and the loop's yield was a fixed 50 ms sleep that could land past the deadline). A deadline already past at chain acquisition skips straight to the forced stop; the loop's yield races the remaining bound.
  - **The broker teardown is bounded** (review: `dispose` awaited `cancelSession`, `session.release` and the owned runner's `dispose` with NO deadline — a hung backend could block daemon shutdown and the reset tool indefinitely). `dispose(boundMs)` races every await against the remaining bound, defaulting to `DEFAULT_DISPOSE_BOUND_MS` (5 s, mirroring the daemon's shutdown deadline); a runner-dispose rejection still propagates when it wins the race.

- af917eb: REPL orchestrator phase D, review round 2: the re-attach arm's completion evidence, the envelope's identity-check ordering, the re-issue branches' refusal cadence, and the daemon wiring.

  - **The still-resumable arm is now fully implemented** (review: a successfully loaded session whose founding turn remained in flight was released and re-issued — duplicated work). The `awaitCurrentTurn` seam on acp-agents' `InteractiveSession` is an OBSERVING wait: after `session/load` resolves, it waits for the update stream to SETTLE (no updates for the loaded-turn settle grace) and only then reads the transcript's trailing content. A turn still running at the backend keeps streaming live chunks after the load response, so the seam KEEPS THE LOADED SESSION ATTACHED and settles from the turn's authoritative completion; the broker arms the call on the seam WITHOUT blocking reconcile (the pump delivers through the same record → settle → consume path as a live call). Re-issue happens only on genuine failure — no user message in the transcript, a released/dead session, a stream settled without a terminal assistant message within the max-wait bound (the never-hang-unobserved backstop), a load failure, or a seam-less third-party adapter — surfaced guest-visibly.
  - **ACP message chunks are never completion evidence by themselves** (review: any trailing `agent_message_chunk` used to be treated as proof of completion with a synthesized `end_turn`, so partial output, refusal, cancellation, or truncation could be settled as success). Completion now requires a SETTLED stream (the settle grace) with a trailing assistant message; the resolved text is the turn's real accumulated outcome and the broker's own result-shaping gates (empty-output refusal, schema ladder) still apply. The stop reason stays synthesized `end_turn` — the protocol's replay carries none for a turn this client did not start (documented decision).
  - **The envelope's identity check precedes payload interpretation** (review: the payload used to be gunzipped and passed through `QuickJS.deserializeSnapshot()` before the running wasm hash was compared — an incompatible old payload failed as `CORRUPT_PAYLOAD` without naming both hashes). `deserializeSnapshot` now takes `expectedWasmSha256` and refuses `WASM_HASH_MISMATCH` naming both hashes between the header parse and the payload decode; `ReplWorkspaceStore.loadSnapshot` passes the running binary's hash. A mismatched-hash test whose payload cannot be deserialized pins the ordering.
  - **Every re-issue branch propagates its refusal cadence** (review: the no-recorded-session and adapter-without-seam re-issue branches discarded `reissueCall()`'s newly-settled flag, so an over-cap refusal skipped the changed-VM settlement drain and its snapshot boundary). Both branches now return the flag; cadence tests cover each.
  - **The daemon wiring** (review: `ReplWorkspaceStore` was exported/tested only — the workspace did not survive daemon restarts): `mcp-server` registers the `repl` tool (eval/wait/status/interrupt/reset per the roadmap doc's Surface section) and each daemon project context opens the per-project `repl/` store, attaches the broker's state-changing-boundary sink, and on first touch restores the stored workspace + reconciles (or creates fresh). A stored snapshot that refuses (corrupt/truncated, version bump, wasm-hash mismatch) is CONTAINED: the refusal is surfaced loudly in every result and `reset` clears the store — no crash-loop, no silent data loss. `ReplWorkspaceStore.callStore()` self-heals its directory after `reset()`.

- af9c9d5: REPL orchestrator phase D: disk persistence — enveloped snapshots, the per-project store, and the restore path's three-way reconciliation.

  - **The identity envelope** (`src/snapshot-envelope.ts`, roadmap doc transfer lesson 5): the shim's own `serializeSnapshot()` output wrapped in a newline-terminated JSON header + gzip. The header carries the format name (`repl-snapshot`), the envelope format version (`SNAPSHOT_FORMAT_VERSION = 1`), the **wasm-binary sha256** and the creation time. A restore whose recorded hash mismatches the running binary REFUSES LOUDLY naming both hashes (`WASM_HASH_MISMATCH` — never a restore into garbage); a version bump refuses naming both versions; corrupt/truncated files refuse with a specific `SnapshotEnvelopeError` code, single-shot, no crash-loop. `wasmSha256Of` hashes raw bytes directly and resolves compiled modules through the registry `loadShippedWasm` populates.
  - **The per-project store** (`src/repl-store.ts`): `ReplWorkspaceStore` — a `repl/` subdirectory NEXT TO the workflow state under `workflowHomeDir()/projects/<key>/`, reusing `@automatalabs/workflows`' store-layout helpers verbatim (the same helpers the mcp-server project registry uses). Holds `snapshot.bin` (the enveloped snapshot) and `calls.jsonl` (the broker's durable call store). Snapshot writes are atomic (tmp + rename + fsync, best-effort directory fsync); a failed write leaves the previous snapshot untouched. Config knobs (decided names): `SnapshotWriteOptions.debounceBursts` (default true) and `.fsync` (default true), plus `ReplStoreOptions.persistenceRoot`/`env`.
  - **The snapshot cadence + debounce**: the broker fires a state-changing boundary after each eval and after each settlement drain that changed VM state (`BrokerOptions.snapshotSink`: `boundary(kind)` per boundary, `flush()` at the end of each serialized operation — the burst boundary). `store.snapshotWriter(workspace, wasm)` debounces one drain burst's boundaries into a single atomic write taken before the operation's promise resolves; the debounced gap is always covered by the call store (settlements are recorded BEFORE they settle, so a restore replays them from the store arm). A drain that changed nothing fires nothing.
  - **The restore path with the full three-way reconciliation** (`Broker.reconcile()`): every outstanding call in the in-VM pending-call registry settles exactly one way — completed while down → **settle from the store**; still resumable at the backend → **re-attach** via `runner.loadSession` (capability-gated per acp-agents' `supportsLoadSession` — all four built-ins advertise it per docs/api.md; a custom backend that omits it degrades through the same gate, surfaced guest-visibly as a warn line); lost → **re-issue** under the same call id (store `reissues` counter bumped, the existing guest promise settles exactly once, the concurrency cap applies — over-cap re-issues refuse with the recoverable `ConcurrencyLimitError`). The re-attach keys on the backend session id the store records at session open (`recordAttached` — a new append-only log event, written BEFORE the prompt, so a crash with a turn in flight leaves a restore able to re-attach instead of duplicating). A re-attached call's completion is the loaded session's founding turn, observed through the OPTIONAL `BrokerSession.awaitCurrentTurn` seam — an adapter without it re-attaches the session, then degrades to re-issue, surfaced guest-visibly, never a hanging call.
  - **Everything else a restore finds**: pending checkpoints re-surface into the broker's checkpoint table (listed again, answerable through the reconciliation surface); pending steers whose wire call died with the process resolve the honest `failed` with a warn line (their outcome is unknowable; re-injecting would duplicate — queued-but-undelivered steers stay the phase-C queue-rebuild exception); reconcile is idempotent (`isTracked` guard) and adopts store-unknown entries (foreign snapshot / wiped store) so the replay ledger stays complete.
  - The public type surface stays fully self-contained (envelope functions return `Uint8Array`; the store's signatures carry no node types; the consumer fixture now exercises the whole phase-D surface under the non-DOM `skipLibCheck: false` configuration).

  Phase D review round 1: the re-attach arm is now REAL through the actual acp-agents adapter — `InteractiveSession.awaitCurrentTurn` observes the completed-while-down turn's final message from the `session/load` replay (tested through a real `AcpAgentRunner` over the fake ACP agent, wire-log proven: load, no re-issue). Review round 2 (see the round-2 changeset) replaced the still-in-flight degradation with the observing-wait semantics: the seam keeps the loaded session attached and settles from the turn's authoritative completion, re-issuing only on genuine unobservability. Reconcile-time refusals (invalid registry options, over-cap re-issue) now participate in the changed-VM bookkeeping: the settlement drain runs and the settlement snapshot boundary fires. A changed-VM settlement drain that FAILS (interrupted continuation) still fires its boundary on the reconcile and pump paths alike — the operation-end flush always has a dirty boundary to persist. The test suite's `setup` helper threads `interruptHandler` through (a silently-dropped handler left a runaway continuation unguarded in the drain-failure regression test).

- 0c29a86: REPL orchestrator phase F, review round 2: authoritative re-attachment/completion for ALL four built-ins, the out-of-band eval-break relay, and addressable truncation references.

  **acp-agents — the observation path for backends without the `_session/loaded_turn` extension** (the built-in claude and opencode backends today; also the fallback when an extension backend's query wire fails). The old degradation — reject with the non-re-armable `LoadedTurnStillRunningError` so the broker releases the loaded session and re-issues the call — could duplicate a still-running backend turn. The seam now classifies the loaded session's founding turn authoritatively: the post-load continuation watch (`AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS`, default 1 s — any CONTENT update after the load boundary is live continuation, the still-running signal) plus the replay probe under the CONNECTION-DEATH CONTRACT (live-verified: claude-agent-acp and pi-acp exit on connection close and cancel their turns, `opencode acp` exits on stdin EOF, codex-acp ends/kills the codex process, and their persisted transcripts hold only completed messages — so at restore the founding turn is never still running and the replay's trailing content is authoritative: an assistant message is the turn's terminal message (completed-while-down, settled from the transcript), anything else means it died mid-way (the safe-re-issue class — nothing running, no duplication)). Live continuation flips the classification to the keep-attached wait (bounded, re-armable). The `_session/loaded_turn` extension path is unchanged. Tests pin the seam-less completed/interrupted/still-running classifications end to end through the real adapter.

  **repl-engine — a possibly-running call is never re-issued** (the broker's restore/re-attach arm): every `LoadedTurnStillRunningError` — re-armable and non-re-armable forms alike — keeps the loaded session attached and re-arms the seam on it (the doc's re-attach-to-a-still-running-task arm); re-issue is reserved for the observably-dead classes (interrupted classification, a transcript that never received its prompt, a dead/released session, a third-party adapter with no seam at all). Also new: **the out-of-band eval-break channel** (`EvalBreakChannel` / `createEvalBreakChannel`) — a worker-thread relay with a loopback HTTP break endpoint and a shared-memory (SAB + Atomics) break flag. The interrupt tool's no-id path becomes deliverable to a SYNCHRONOUSLY running eval: a never-yielding eval blocks the daemon's single thread, so the request itself cannot be processed — the relay (a separate thread) arms the flag, and every eval execution's quickjs interrupt handler consumes it mid-run with the arm-after-start rule (a stale break — armed while the workspace was idle — is dropped on first observation and never breaks a later eval). `BrokerOptions.evalBreakChannel` wires it; the broker reports consumed out-of-band breaks to the tool for the honest outcome.

  **mcp-server — the daemon wiring for both**: `run-daemon` creates the channel and advertises its URL in daemon.json (`replBreakUrl`); the stdio shim fires the relay automatically when it forwards a `repl` interrupt without an id (before forwarding, so the break lands while the daemon is wedged); the interrupt tool reports the honest out-of-band outcome (and clears the flag once its own processing owns the break). And **the structured-output cap's continuation references**: the aggregate 10 KB cap previously discarded the tail entries of elided arrays (pending ids, checkpoint questions, completion ids, status metadata) keeping only counts — the omitted values had no address and repeated reads could never recover them. Every elision now snapshots the dropped entries in the workspace's `TruncationRefStore` under a ref id that the `truncated` record carries (`{ elided, ref }`), and a later eval/wait/status call's optional `refs` parameter reads them back under `referenced` (a referenced read is itself capped, chaining fresh refs) — the cap costs reads, never data, for every omitted field. The truncation marker text now names both the `$N` refs and the structured continuation refs.

- 0baa82c: REPL orchestrator phase-E review round 2 fixes:

  - **The eval-break interrupt targets the RUNNING eval** (`mcp-server` + `repl-engine`): `interrupt` without an id no longer arms a project-wide "next VM execution" boolean. The broker now tracks the suspended eval's completion (retained at suspension, released when the continuation completes or is broken) and `Broker.armEvalBreak()` refuses — an honest "no running eval to interrupt" no-op, nothing armed — when no eval is in flight. When an eval IS in flight, the armed signal is scoped to it and consulted ONLY by settlement drains (the executions that resume suspended-eval continuations), never by a fresh eval's own code or its own job drain — an unrelated eval can neither consume the signal nor be broken by it, and the signal is cleared when its targets settle or the drain it broke reports the interruption (a continuation broken by the quickjs interrupt never settles its engine wrapper — verified against the shipped binary — so the drain-interruption path releases the tracking). An idle workspace's next eval runs normally.
  - **Lexical provenance re-attributes on worker settlement** (`repl-engine`): the provenance registry now tracks global lexical bindings by VALUE — the host reads each binding's current value through the internal global-var object and hands it to the pass, which re-attributes a changed value (SameValue) to the operation that produced it. A `let` binding assigned a worker result, or a suspended `const finding = await research` whose continuation assigned the settled value, now reports `via worker cN` with the founding task and the attribution wall clock instead of the declaring eval's label with no task. A registry whose record closure predates the feature degrades to first-sight-only attribution (an older snapshot is served as-is).
  - **Size metadata for EVERY manifest binding** (`repl-engine`): the manifest token now carries the byte-size estimate for undefined, null, numbers, booleans, bigints, symbols, functions, plain promises, and agent handles — and the broker-enriched binding exposes it as its own `sizeBytes` field (the doc's name/type/size contract; 0 only for the unreadable accessor/sabotage cases). The `status` tool renders it through the tokens.

- 1aacc26: REPL orchestrator phase-E review round 3 fixes — the interrupt breaks a currently-executing runaway, the wait never holds the broker chain, workflow calls register project presence, and daemon idleness counts active REPL drains.

  - **The no-id interrupt breaks an EXECUTING runaway eval** (`repl-engine` + `mcp-server`): the eval-break signal is now consulted by EVERY execution that resumes the running eval's continuation — the settlement drains AND a direct eval's own drain (a suspended eval's continuation can be resumed by a SYNCHRONOUS host-callback settlement — `checkpoint.answer` in a later eval — and that execution runs inside the answering eval's own drain, where the old settlement-drain-only signal was blind; the runaway burned the eval deadline instead of being broken by the interrupt). `runEval` composes the signal as the drain-phase handler (`drainInterruptHandler`, a new vm-level option — the eval's own CODE still never consults it, so an unrelated eval's code is never broken), and an eval whose own drain was interrupted releases the tracked running eval exactly like the pump path (`interruptedInDrain` → `noteInterruptedDrain`) — a broken target can never linger as a stale arm target. The tool's result text and docs now state the real semantics: an eval that yields (suspends on a call) is interruptible at its next execution, mid-run; a fully synchronous runaway is bounded by the per-eval wall-clock deadline (the request cannot physically arrive while the single-threaded daemon executes it).
  - **`waitForCalls` releases the broker serialization chain between its pumps** (`repl-engine`): the wait used to hold the chain across its whole bounded poll (each sleep included), so a concurrent `interrupt` — `cancelCall` or `armEvalBreak` — queued behind it and could not cancel or break until the wait finished or timed out (up to 120 s), by which point the target could already have completed. Each pump is now its own serialized unit; between pumps other operations interleave, so an interrupt lands promptly mid-wait and the wait's very next pump breaks the armed target mid-run. The target set is captured at entry (with other operations interleaving, "every pending call" can only mean "the calls pending when the wait started"), each pump runs under the REMAINING wait time (the wait's bound is absolute for the guest drain, same posture as the disconnect drain), and a mid-wait pump-drain interruption is honest output in the wait's result. The daemon and engine suites now exercise the interrupt mid-wait and the mid-run break of an eval that keeps executing across drains (a runaway loop over subagent calls), plus a concurrent cancelCall completing during a live wait.
  - **The workflow tool registers REPL project presence** (`mcp-server`): the workflow handler resolves the same per-project context the repl tool addresses, and a session that calls it is now registered on the project's repl presence — a workflow-only client B staying connected keeps the workspace warm (children open) when repl-client A disconnects; the drain fires only when the LAST project client of either kind disconnects. A pure-workflow project keeps a stateless repl context (no VM is created — the workspace is materialized only on the first repl tool touch). The presence ledger is now created once per server and shared by both tools.
  - **Daemon idleness counts active REPL drains** (`mcp-server`): the idle reaper's busy check now includes `activeReplDrainCount()` (the presence ledger's scheduled/in-flight drains) alongside sessions and workflow runs — a last-client-disconnect drain may legitimately run for the full session-eviction TTL after the final session is gone, and the default idle shutdown can no longer fire mid-drain and replace its bound with the five-second shutdown deadline. In-flight turns are guaranteed to drain to completion under the documented session-eviction-TTL bound.

- c663a86: REPL orchestrator phase-E review round 3b fixes — the eval-break signal is keyed to the armed target's continuation (unrelated drains neither fire nor consume it), the tool returns the doc's machine-readable shapes as structuredContent with a published output schema, and the bounded wait sleeps only for its remaining budget.

  - **The eval-break signal targets the armed eval's continuation, not whichever drain runs next** (`repl-engine`): the carried defect — the drain-phase interrupt handler was installed on every later eval's drain without checking whether that drain resumed an armed target, so an unrelated finite eval (or an unrelated settlement drain) was interrupted and the interrupted-drain release cleared the target's tracking while its checkpoint stayed pending and uninterruptible. The armed identity is now the union of the armed evals' OWN suspension-time calls (pending at suspension minus the pre-eval baseline — the calls the eval issued itself, whose settlement queues its continuation; a later eval's snapshot never inherits an earlier eval's still-pending calls). Every VM operation maintains a settlement accumulator (`opSettledCalls`, appended by every settlement route and seeded by the pump/reconcile/disconnect drains with the settlements that triggered them), and the signal fires only while that accumulator intersects the armed deps — the currently-executing drain BELONGS to the armed target. An unrelated drain neither fires nor consumes it, and the armed state survives intact. The interrupted-drain release (`noteInterruptedDrain`) is gated the same way: exactly the tracked evals whose own resume keys the interrupted operation settled are released (a deadline-broken resumed runaway releases its tracked eval even when no signal was armed — a stale target would make a later arm target a dead eval), and an unrelated interrupted drain leaves the armed state and every tracked eval intact. A no-id interrupt with NOTHING breakable — no eval in flight, or every in-flight eval suspended on no OWN pending call (a never-settling local promise, or an `await p` on an earlier eval's binding) — refuses and arms nothing.
  - **The `repl` tool returns the doc's machine-readable shapes** (`mcp-server`): the carried defect — eval/wait/status were flattened into text-only MCP content with no output schema, mixing guest output and trusted orchestration metadata into one flat string. The tool now publishes an `outputSchema` (the workflow tool's oneOf-branch pattern) and every result carries `structuredContent`: eval/wait return the doc's `{ output, result?, pending, checkpoints, completed }` (plus `outputTruncated` and the wait-only `drained`/`timedOut` flags), status returns the structured workspaces surface (workspace state, the reconcile summary, the workspace MANIFEST with name/token/size/provenance/task per binding, the live agents, the pending ops, child warmth, a retained drain failure), interrupt returns its honest outcome (`targeted`/`refused-idle`/`cancelled`/`idle`/`failed`/`none`), reset the `dropped` acknowledgement, and the refusal paths a structured `error` variant. Guest output and orchestration metadata stay separate fields, and every structured field is bounded metadata (output capped by the broker, checkpoint questions previewed, manifest tokens structure-only). Status checkpoint questions are now previewed in the text surface too (the doc's previewed-question rule).
  - **The bounded wait sleeps only for the REMAINING budget** (`repl-engine`): the carried defect — the unconditional 50 ms inter-pump sleep made every sub-50 ms `timeoutMs` take ~51 ms, violating the bounded-wait contract. The sleep is now `min(50, deadline - now)`, matching the disconnect drain's pump discipline.
  - **The pending surface reports the WHOLE guest registry** (`repl-engine`): the trap-free reader's generic 256-element array cap silently truncated the guest surface's `pending()` list, and its `[ArrayTruncated]` marker mapped to `undefined` in the broker's id lists — a hole in the structured `pending` field. `readValue` takes an explicit array bound (the preview read is unchanged at 256); the surface read passes `SURFACE_READ_MAX_LEN` (16 384 — the registry is the host's own reconciliation metadata, bounded by VM memory).

- f04776d: repl phase-E review round 4: the eval-break interrupt is keyed to the calls the running eval AWAITS. The engine now instruments top-level awaits (`await x` → `await __replAwait(x)`, acorn-based, guest library 0.2.0) and attributes each suspended eval's resume keys from the guest's await log — an unawaited sibling call's settlement no longer fires or consumes the armed signal (its own `.then` continuation runs to completion), an eval awaiting an EARLIER eval's binding stays targetable, and the wait tool's serialization-chain acquisition is bounded by its absolute deadline. The pending-call registry and provenance reads are now COMPLETE trap-free reads (no 16 384-element array cap, no 256-property object cap) — the whole registry and every binding's provenance survive eval output and restore reconciliation. The repl tool's input is action-discriminated (exact per-action field sets, extraneous fields rejected), the structured manifest gains machine-readable type + live-handle status/call fields, and guest-derived structured status fields (agent task) are capped at the engine seam.
- f17212a: repl phase-E review round 5: the eval-break interrupt now carries a genuine per-eval CONTINUATION IDENTITY. The guest library (0.3.0) wraps every instrumented top-level await (`await x` → `await this["__replAwait"](x, TOKEN)` — a hygienic seam: the `this` keyword base is unshadowable, and no helper binding is injected into the persistent global lexical record) and sets a continuation lease in the job immediately before the eval's continuation segment; the drain loop mirrors the lease per job, so the armed signal fires only while the armed eval's own continuation executes. An unawaited sibling `.then` registered before the target's await can neither fire nor consume the signal (the carried defect broke the sibling's job and let the target run later unbroken), and indirect waits (`await Promise.all([q])`) are targetable through the promise graph (the 0.2.0 log-only identity refused them). The interrupted-drain release is exact the same way (the interrupted job's lease names the eval). A zero `timeoutMs` wait performs one immediately available state read (idle workspaces drain, pending calls report), the top-level-await instrumenter's injected seam can no longer be shadowed by guest identifiers, the workspace manifest enumerates user bindings that SHADOW or OVERWRITE baseline globals (`const Math = 42` is listed with full metadata and provenance — the provenance registry captures the baseline type tokens and its own intrinsics, so host bookkeeping survives lexical shadows of `Math`/`Object`), the repl tool accepts empty `code` strings (valid JavaScript resolving with `undefined`), and the per-backend steering mechanism table is now a GENERATED artifact gated by a test (`docs/steering-mechanism-table.md`, regenerated from `ACP_EXTENSION_SUPPORT_MATRIX` via `generate:steering-table`).
- d24372f: repl phase-E review round 6: three carried-defect fixes. (1) The eval-break continuation lease is now associated with the ACTUAL CONTINUATION JOB, not the next job: the guest library (0.3.1) registers the lease-setting reaction on the awaited value's WRAPPER promise itself — immediately before the await machinery's own reaction — so the wrapper's settlement queues the lease-setting job directly before the continuation job, and a sibling `q.then(...)` registered after the eval started awaiting `q` can no longer run with the lease set (the 0.3.0 reaction ran on the value's settlement, so the sibling consumed the armed signal and the target's continuation ran later unprotected). (2) The for-await ITERABLE wrap preserves the iterable protocol: the new `__replAwaitIterable(value, token)` global returns an async-iterable wrapper (resolved exactly like `for await` resolves an iterable) whose per-`next()` results are lease-wrapped promises, so `for await (const x of [1, 2])` iterates normally through the broker while a running loop stays breakable mid-iteration; the instrumenter gates for-await sites on the new `supportsIterableLease` surface flag, and `for await (... of await y)` is left unwrapped (its own await is instrumented normally). (3) Same-type baseline-global overwrites are tracked and attributed: the provenance registry captures the ORIGINAL baseline values at creation (they travel inside snapshots and are never updated on attribution) and re-attributes known names on SameValue difference, so `Math = { userOwned: true }` is listed in the workspace manifest with `object` type and full provenance even though the type token never changes; the manifest's changed-binding filter consults the registry's changed-known read alongside the host-side token check.
- 9404d4a: repl phase-E review round 7 (the reviewer's rejection of the previous attempt): five defect fixes. (1) The for-await iterable wrap preserves AsyncFromSyncIterator semantics: `__replAwaitIterable` now awaits and unwraps a SYNC iterator's result VALUE (`for await (const x of [Promise.resolve(1)])` yields `1`, never the promise object — the old wrapper resolved with the raw iterator result, and because the wrapper is an async iterable the machinery used the value as-is), while an async iterator's results pass through untouched. (2) Iterable ACQUISITION errors propagate exactly once: resolving `@@asyncIterator`/`@@iterator` follows GetIterator/GetMethod semantics (a present-but-not-callable `@@asyncIterator` is a TypeError, never a fallback) and a throwing getter runs a single time reporting its ORIGINAL error — the old degrade-to-unwrapped made the machinery acquire the iterable a second time (`boom2` instead of native `boom1`). (3) The instrumentation surface runs on CAPTURED pristine Promise intrinsics (`P`/`PResolve`/`PReject`/`pThen`, bound at installation): replacing `Promise.prototype.then`, overwriting `Promise.resolve`, or shadowing `Promise` lexically cannot change the instrumented `await 40` (still `40`) or skip the continuation-lease setting; the same hardening applies to the host-thenable forwarding in `issueHostCall`, which otherwise silently killed every call settlement under a replaced prototype. (4) Provenance recording reads descriptors off the CAPTURED global object: a top-level lexical `const globalThis = 7` no longer blanks every binding's provenance (`var userValue = 42` reaches the manifest with producer/task/time metadata). (5) The broker's continuation-lease availability check is VERSION-GATED on >= 0.3.1: a restored 0.3.0 library (whose lease-setting reaction still runs on the awaited VALUE's settlement — the carried sibling-reaction interrupt-targeting defect) reports `supportsContinuationLease: true` but is now served WITHOUT instrumentation and the eval-break interrupt refuses honestly — the flag alone re-armed the original defect on a supported older snapshot. Regressions cover every finding at the guest-library and broker boundaries, including a restored-0.3.0 snapshot whose sibling reaction never observes a continuation lease.
- 5f1cdba: repl phase-E review round 8 (the reviewer's rejection of the previous attempt): the two remaining defects fixed. (1) `interrupt { id }` (and the guest handle's `cancel()`) now cancels a call whose `openSession()` is still pending: the `cancelCall` decision's new opening arm fences the call in `stoppedOpens`, settles it DURABLY as the recoverable `AGENT_CANCELLED` (recorded first, guest-settled first-wins, concurrency token released, one drain fires the settlement's guest reactions) and returns `cancelled` — the old decision skipped `openingCalls` entirely, returned `none`, and the eventual open resolved into a prompted, supposedly-interrupted call. A late landing closes the child immediately without ever prompting; a daemon restart settles the call from the store. Regressions at the broker boundary (delayed-open cancel + handle cancel + slot release under a cap of one) and a full daemon regression with a delayed `openSession()`. (2) The doc's 256-line/10 KB tool-result cap now applies to `structuredContent` as an AGGREGATE serialized-size cap, not only to the bounded text: the modelSpec is previewed at the ENGINE seam (head+tail 200 chars, the task bound), and a new `capStructuredResult` pass elides the largest lists (head prefix kept) with an explicit path-keyed `truncated` record of elided counts — elision is never a silent hole (the round-4 registry-read defect) and the wire's serialized structured result always fits the 10 KB bound (a 20,000-character model spec and 16,500 pending ids previously crossed uncapped; the 16,500-checkpoint daemon test now pins the bounded, flagged, size-checked wire plus the full registry surviving in the VM across a restart).
- 3b30612: repl phase-E review round 9 (the reviewer's rejection of the previous attempt): four defects fixed. (1) The opening-call cancellation (`interrupt { id }` on a call whose `openSession()` is still pending) is a settlement drain that changed VM state but never fired the per-settlement provenance pass or the state-changing boundary: `cancelCall`'s opening arm now runs `provenancePass('settlement', [callId])` and `sink.boundary('settlement')` after its drain (the boundary still fires on a `DrainJobError`, mirroring the pump), so the manifest immediately attributes the settlement's continuation bindings to the cancelled worker and the daemon's snapshot writer persists the settled workspace before the interrupt's promise resolves — a kill right after the interrupt (no eval or wait in between) restores the SETTLED snapshot, never the pre-settlement one. (2) The opening-cancel's concurrency-slot release now runs the global queued-delivery kick (`kickQueuedDeliveries`, exactly like every other slot-free transition): a cap-pressure follow-up queued on an idle session starts its delivery turn the moment the opening call is cancelled. (3) The GENERATED steering mechanism table is corrected and re-pinned: the `cancel()`-while-opening case was documented as a no-op returning `failed` while the call continues, contradicting the implementation (which cancels the opening call and returns `cancelled`); the generator's case table and the broker module docs now say the opening call is fenced and settled durably as cancelled, the checked-in artifact is regenerated, and the gate test pins the corrected row (and asserts the stale no-op claim is gone). (4) The generator emitted TWO terminal newlines, so `git diff --check` failed with "new blank line at EOF" on the checked-in artifact; the generator now emits exactly one terminal newline and the gate test pins it. Regressions: broker-boundary tests for the immediate-after-interrupt snapshot/restart with a recording sink (exactly `['settlement']` fired, no intervening eval, provenance + store-arm assertions across the restore), the cap-1 queued-follow-up kick, and a daemon regression that kills the daemon IMMEDIATELY after the interrupt (no eval or wait — the round-8 test masked the defect by performing both before restart) and asserts the restart's reconcile has nothing for the store arm and the manifest provenance traveled inside the interrupt's own snapshot.

### Patch Changes

- 149b606: Phase-F review round 1: the re-attach arm's unobservable-completion degradation is replaced
  by the doc's honest re-issue fallback — the undocumented fourth reconciliation arm
  ("pending until interrupt/reset") is gone. The doc's restore path settles every outstanding
  call exactly once through exactly one of the three arms (settle from the store / re-attach /
  re-issue); the old `registerUnobservableReattach` path left a successfully re-attached call
  permanently pending when the loaded session's founding-turn completion was unobservable,
  which is the case for the built-in claude and opencode backends (they do not advertise the
  `_session/loaded_turn` extension, per the live-verified `ACP_EXTENSION_SUPPORT_MATRIX`).
  Now:

  - A loaded session WITHOUT the `awaitCurrentTurn` seam (a third-party adapter) is released
    and the call is re-issued under the same id — the same degradation the catch arm already
    used for load failures, surfaced guest-visibly with a warn line naming the reason.
  - A NON-re-armable `LoadedTurnStillRunningError` (backend without the extension, or a
    failed `_session/loaded_turn/query` wire) degrades the same way: release + re-issue under
    the same id. Never settled from a quiet gap (partial output is still never settled),
    never left pending.
  - The RE-ARMABLE class is unchanged: a `running` turn past the max-wait bound on a backend
    that DOES carry the extension keeps the loaded session attached and re-arms the seam — the
    doc's second arm (re-attach to a still-running task); a later `_session/loaded_turn/ended`
    notification or a cancel still settles the call.
  - The drain/disposal fences are unchanged: while the broker is draining or disposed, even
    safe-re-issue rejections resolve `hold` — the drain's forced stop settles every
    still-pending call DURABLY at its bound (recorded `AGENT_CANCELLED`, guest-settled), so a
    drained call is never left pending, and a disposed broker's state is being torn down.
    These are now the only `hold` producers left in the pump.

  The seam's rejection messages in acp-agents (`LoadedTurnStillRunningError` text) and the
  `awaitCurrentTurn` documentation were re-worded to match (the broker re-issues; the
  re-armable form keeps the wait on the attached session); repl-engine module docs, the
  package READMEs, and docs/api.md document the degradation and the exhaustive three-arm
  contract. Regressions: the seam-absent adapter test and the non-re-armable rejection test
  now pin the re-issue path end to end (loaded session released, reissue recorded, fresh
  turn settles the SAME guest promise exactly once, warn line names the reason), and the
  acp-agents integration test pins the re-worded non-re-armable message.

- bcede5b: REPL orchestrator phase F, review round 3 — the full-repo verification's carried defects, all closed:

  - **ACP freshness gate green**: the `packages/codex-acp` subtree is re-synced with upstream `agentclientprotocol/codex-acp@main` (ea57892 — the goal-extension `resume` action and the v1.1.11–1.1.13 releases) via a true non-squashed merge commit; the fork's `package.json` version line wins, the package lockfile stays deleted, and the imported upstream head is recorded in the attribution allowlist.
  - **The observation path's replay classification is restricted to the verified built-ins** (acp-agents): a CUSTOM backend's quiet observation window is not terminal evidence — its connection-death behavior is not live-verified — so its loaded session stays attached and the seam waits for the authoritative terminal state (the re-armable still-running rejection) instead of settling stale/partial replay or re-issuing a possibly-running call.
  - **Non-re-armable seam rejections are never re-invoked** (repl-engine): the broker kept recursing into a seam that rejects with `LoadedTurnStillRunningError` and `rearmable: false`, spinning in an unbounded microtask/warning loop that starved cancellation, drain, and every other task. The broker now keeps the loaded session attached and waits for the terminal state from the session-level `_session/loaded_turn/ended` surface, the call's cancel (settled as the recoverable `AGENT_CANCELLED`), the session's release (the safe-re-issue class), or the drain's forced stop.
  - **The interrupt is implemented in the in-process/library mode too** (mcp-server): the single-project server now owns an eval-break channel by default and exposes its relay (`replBreakUrl()`); the stdio transport's stdin reader lives on a worker thread that fires the relay for no-id `repl` interrupts, so a synchronous `while(true)` eval is breakable mid-run exactly like in daemon mode. The relay keys are realpath'd on every fire side (shim and in-process reader), so symlinked or non-normalized projectDirs interrupt correctly.
  - **Break targeting has no clock-resolution window** (repl-engine): the eval-break channel now orders arms against execution starts on a shared monotonic arm-sequence counter instead of millisecond `Date.now()` stamps — a break arriving in the same millisecond as the execution start is delivered, never consumed as stale and lost. The channel's slots also GROW on demand (no fixed workspace ceiling) and are released on broker teardown for reuse.
  - **The structured-output cap's continuation refs are cumulative, namespaced, and never evicted** (mcp-server): repeated halving of one field chains every dropped chunk into the advertised ref (earlier tails stay addressable); ref ids carry the workspace's project key so a ref from one project can never resolve in another's store; the store retains every ref until `reset` (which now clears it); and the `wait` result variant accepts `referenced` (the handler attached it, the validator forbade it).
  - Documentation and the phase-F changeset re-worded: the `repl-engine` dependency line and the shipped-tool status are stated as they are, and the changeset no longer carries the banned marker strings.

- 1db93d4: REPL orchestrator phase F, review round 4 — the five carried defects from the full-repo verification's clause checklist, all closed with regressions:

  - **The in-process no-id interrupt honors the documented optional `projectDir`** (mcp-server): the single-project `repl` tool resolves an omitted `projectDir` to the server's own adopted project, and the relay transport's stdin-reader worker now fires the out-of-band eval-break with that same key (exposed as `replDefaultProjectDir()` on the server control, wired into the worker's `workerData`). An omitted-`projectDir` interrupt during a synchronous `while(true)` eval previously skipped the relay entirely, ran to the per-eval deadline, and then reported `refused-idle`; the new e2e pins the out-of-band break.
  - **Streaming UTF-8 decoding in the relay reader** (mcp-server): the worker now decodes the raw stdin byte stream through a `StringDecoder` (`RelayFrameSplitter`), never per-chunk `Buffer.toString("utf8")` — a multibyte character split across reads used to be replaced with U+FFFD, so the claimed byte-identical MCP forwarding was false (a built-server repro changed an expected string length). Unit tests feed a JSON-RPC frame one byte at a time and pin the verbatim decode.
  - **Acknowledged, generation-safe eval-break slot lifecycle** (repl-engine): `EvalBreakChannel.register` now returns a promise the relay worker acknowledges (`{ type: "ack", key, slot, gen }`) only after applying the key→slot mapping, and every serialized broker operation awaits the ack before touching the VM (`runSerialized`) — a first interrupt can no longer 404 against an unapplied mapping and lose the break. Slot assignments carry generations: the worker stamps each arm with the arming key's generation (release order, before the flag), `unregister` clears the flag and invalidates the slot's generation word, the worker clears the flag when a mapping takes a slot over, and `consumeBreak` drops any consumed flag whose generation does not match the consuming key's current one — a stale arm for a released incarnation can never break the workspace that reuses the slot. The channel's worker-message listener is attached only while booting or awaiting acks (Node re-refs the worker port while a message listener is attached; the round-3 code left it attached forever and every server-owning test suite hung on exit).
  - **Cumulative truncation refs preserve verbatim order** (mcp-server): the elision record's chained continuation ref now assembles `[...newestDropped, ...priorDropped]` — the halving pass always drops from the current array's tail, so the newest chunk precedes the older ones in the original array. The advertised ref used to concatenate chunks in reverse (`[4…7,2…3]` after two drops instead of the verbatim tail `[2…7]`); the unit test pins head+ref reassembling the original list exactly.
  - **`send` completion means flushed** (mcp-server): `ReplRelayStdioTransport.send` now awaits the stdout `drain` event when `write()` reports backpressure, exactly like the `StdioServerTransport` it replaces — the old fire-and-forget write resolved immediately, allowing unbounded buffering against a slow client for all in-process MCP traffic. Unit tests drive a fake stdout seam through backpressure and drain.

- 4c046ab: repl phase F — full-repo verification (round 2): the ENTIRE monorepo's CI gates pass green
  with the phase A–E repl work in place — the frozen-lockfile install, the project-references
  build, the monorepo typecheck, every package's test suite (shared-types, codex-acp,
  pi-acp, workflow-engine, acp-agents, workflows, agentprism-otel, repl-engine, mcp-server),
  the `check:acp-backends-manifest` and attribution gates, and now also the required ACP
  dependency freshness gate (`node scripts/check-acp-deps.mjs` — green because this branch
  carries the merged maintenance PRs: claude-agent-acp 0.65.0, pi 0.84.0, the
  claude-agent-sdk 0.3.223 root override, and the codex-acp upstream syncs with their
  attribution allowlist records).

  The clause-by-clause sweep of docs/roadmap/repl-orchestrator.md against the code stands:
  npm-shipped `quickjs.wasm` used as-is (no custom wasm build); fresh TypeScript guest library
  (no vendored `dsl.js`); a single `repl` tool with the exact five actions; no budget surface
  in the guest; snapshots at every state-changing boundary; the per-project `repl/` store
  layout; the 6-subagent cap; the 256-line / 10 KB caps on text and structured content alike;
  guest-visible steering outcomes; presence-keyed lifecycle with the drain bound reusing the
  daemon's session-eviction TTL; plain handles with stable call ids and no canonical path
  addressing; no inter-agent communication surface; `Date.now()`/`Math.random()` working
  natively (pinned in `vm.test.ts`). No unfinished-work markers remain in the repl
  code, and no doc-required behavior is deferred.

- Updated dependencies [30f3aa5]
- Updated dependencies [bd28cd9]
- Updated dependencies [af917eb]
- Updated dependencies [fac9d5d]
- Updated dependencies [a2a76bc]
- Updated dependencies [0c29a86]
- Updated dependencies [149b606]
- Updated dependencies [bcede5b]
  - @automatalabs/acp-agents@0.36.0
  - @automatalabs/workflows@0.46.4
