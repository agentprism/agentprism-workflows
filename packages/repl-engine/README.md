# @automatalabs/repl-engine

The engine package of the **REPL orchestrator** (see
[`docs/roadmap/repl-orchestrator.md`](../../docs/roadmap/repl-orchestrator.md)): a persistent
JavaScript REPL in a capability-free QuickJS-in-WASM VM. One VM per workspace; the workspace
object owns the VM lifecycle (`create` → `eval` → `drainJobs` → `dispose`). The `repl` MCP
tool that registers in `mcp-server` (the daemon wiring below) is a thin entry over
[`WorkspaceRegistry`](#workspace-registry); this package is the engine tier it sits on.

```ts
import { Workspace } from '@automatalabs/repl-engine';

const ws = await Workspace.create('/path/to/project');
const first = await ws.eval('const findings = [1, 2, 3]; findings.map(x => x * 2)');
// first = { kind: 'value', value: [2, 4, 6] } — state persists in the VM
const second = await ws.eval('findings.length');
// second = { kind: 'value', value: 3 }
ws.dispose();
```

## Engine posture

The runtime shim is [`quickjs-wasi`](https://github.com/vercel-labs/quickjs-wasi) used **as-is,
including the npm package's shipped `quickjs.wasm` binary** — the roadmap doc's mapping table
is followed verbatim, and we never build our own binary. `loadShippedWasm()` resolves the
binary through the package export map and compiles it once per process into a reusable
`WebAssembly.Module`. The engine pins `quickjs-wasi` at an exact version because snapshot
compatibility (phase D's envelope + restore) holds only across runs on the same package
version; a version bump refuses old snapshots loudly (both hashes named), never restores
them silently.

- **`memoryLimit` per VM** — passed straight through to `QuickJSOptions.memoryLimit`
  (quickjs-wasi built-in). Exceeding it fails allocations with
  `InternalError: out of memory` (an `EvalErrorInfo` with `outOfMemory: true`); the VM stays
  usable. Default when unconfigured: **64 MiB** (`ReplVm.DEFAULT_MEMORY_LIMIT`) — generous for
  data-plane state while still bounding what a single workspace can make the daemon hold.
- **`interruptHandler` per eval and per settlement drain** — quickjs-wasi's `interruptHandler` is a per-VM
  create-time option, so the engine composes per-operation semantics on top of the built-in: one
  VM-level handler delegates to a per-operation slot that `evalCode` arms for the duration of the
  eval **and its drain**, and `drainJobs({ interruptHandler })` arms for the duration of a
  standalone settlement drain, then restores. Handlers never leak across operations. Returning
  `true` aborts with `InternalError: interrupted` (`EvalErrorInfo.interrupted === true`). Note the
  interrupt budget is instruction-based (quickjs's built-in check interval), so against a
  tiny loop body the handler fires comparatively rarely — that is the shim's native behavior.
  **Why the drain takes its own handler:** a suspended eval's handler is removed when the eval
  returns, and a settlement drain that later resumes a runaway continuation (a continuation left
  queued by an interrupted drain, or resumed by host-side settlement) would run unguarded — the
  drain boundary therefore carries its own interrupt signal.

## Eval semantics

`ReplVm.evalCode` (and `Workspace.eval`) evaluates with `EvalFlags.ASYNC` — the script-global
REPL mode the harness pinned: bindings persist across evals (`var` lands on `globalThis`,
`let`/`const`/`class`/`function` in the shared global lexical environment), sloppy mode,
completion value = last expression, **top-level `await` accepted**, and **top-level `return`
stays a syntax error** (the parser's "return not in function" check is independent of the
async flag — pinned by test). The eval returns a promise; the engine drains the job queue
(quickjs-wasi's built-in `executePendingJobs()`, with the per-eval interrupt still armed, so a
runaway microtask loop is bounded) and reports one of:
| Outcome | Meaning |
|---|---|
| `{ kind: 'value', value }` | completion promise fulfilled within the drain |
| `{ kind: 'pending' }` | suspended on an unsettled promise — no fabricated value; the continuation resumes at settlement like a `.then` |
| `{ kind: 'error', error }` | threw (synchronously, via a rejected completion promise, or via a job error during the drain — the canonical drain error is the per-eval interrupt firing inside a resumed continuation) |

The eval promise is fulfilled **synchronously** — the completion is read straight from the
runtime through the raw `qjs_promise_result` export, never through `resolvePromise()` (whose
host promise yields through the microtask queue even when already settled). This makes an eval
structurally un-raceable by `dispose()`: `const p = ws.eval('6*7'); ws.dispose(); await p`
returns `42` (review regression: the yielding completion read crashed on nulled WASM exports).
All VM operations serialize for the same reason, so concurrent evals can never reorder the
interrupt-slot save/restore (review regression: a stale handler stayed armed).

## Trap-free rendering (from day one)

Rendering guest state is adversarial territory (roadmap doc transfer lesson R69: a single
`[[Get]]` on the completion wrapper let `Object.prototype.value` pollution hijack every eval
result). This package follows the rule from its first line of engine code, and it is enforced
**structurally** — two quickjs-wasi paths that would violate it are never taken:

- `QuickJS.evalCode()` wraps synchronous failures (parse errors) in a `JSException` whose
  **constructor** performs guest-visible `[[Get]]` reads of `name`/`message`/`stack` on the
  guest exception — a getter installed on `SyntaxError.prototype.name` runs during error
  construction, before any host `catch`. The engine instead drives the same raw `qjs_eval`
  export (through the package's public `_getExports()`/`_writeString()` accessors) and reads
  a synchronous exception own-property-descriptor-wise itself; the exception value is freed
  immediately after. Adversarial tests pin this: getters on
  `SyntaxError.prototype.name/message/stack`, `Error.prototype.name`, and
  `TypeError.prototype.name` never fire, and a thrown **proxy** reports a trap-free
  `[Proxy]` marker (proxies fire traps on descriptor/prototype reads — every such read is
  `isProxy`-guarded, including the prototype of an error whose prototype was replaced with a
  proxy via `Object.setPrototypeOf`).
- `JSValueHandle.getOwnPropertyDescriptor()` throws a `JSException` when the C descriptor read
  fails (allocation edge) — and that constructor runs the same guest-visible getters. The
  engine's descriptor path (`readOwnDataProperty`) never calls it: it drives
  `qjs_get_own_property_descriptor` directly, takes a failed read's exception value out of
  the runtime and frees it (no `JSException` is ever constructed), and reads the
  engine-created descriptor object's own data properties through raw `qjs_get_prop_value`.
  A regression test forces every descriptor read to fail C-side and asserts zero guest
  getter executions and a still-usable VM.
- `QuickJS.executePendingJobs()` renders a failed job's exception through `exc.toString()` —
  a JavaScript string conversion that **executes guest code**. The engine's `drainJobs()`
  runs the same built-in pending-job loop (`qjs_is_job_pending` / `qjs_execute_pending_job`,
  which is all the built-in is) but reads the exception trap-free and throws a
  `DrainJobError` carrying `EvalErrorInfo`; `evalCode` converts that into the error outcome.
- The engine-created `{ value }` completion wrapper is unwrapped via
  **own-property-descriptor reads** (`getOwnPropertyDescriptor`), never `[[Get]]`.
- Completion values and error info are read the same way: own **data** properties only,
  accessors skipped (**and their `get`/`set` handles disposed — a leaked accessor handle
  pins guest memory**; review measured a 1 MiB VM exhausting after ~3,128 accessor-valued
  completions), proxies and branded objects (`[Promise]`, `[Date]`, `[Map]`, …) rendered as
  markers, depth ≤ 4, ≤ 256 properties per level, cycle-guarded. This shallow read is the
  conservative seed of the ObjectPreview rendering a later phase owns; the tool-result caps
  live there.
- Error names come from the error prototype's own `name` data property when instances carry
  none (quickjs-ng stores `name` on the prototype) — still trap-free; a guest-installed
  accessor or proxy prototype is skipped and the name falls back to `'Error'`.
- **No handle is ever leaked from a failed path**: the exception values of failed evals, failed
  jobs, and failed descriptor reads are disposed in `finally` blocks, and accessor
  descriptors' `get`/`set` handles are disposed on the spot — long-lived VMs must not
  accumulate guest memory from error paths (both leaks were measured during adversarial
  review and are pinned by bounded-memory regression tests).
- Error rendering converts **symbols** natively (the bare brand, FORMAT.md §5.7): a
  thrown `Symbol('x')` reports `Symbol`, never the fabricated `NaN` the default
  number conversion produced. The description is deliberately NOT read — the raw
  `qjs_get_symbol_description` export invokes guest `Symbol.keyFor` (FORMAT.md §1.1),
  a forbidden seam, so `Symbol(x)` is unimplementable trap-free, not merely
  unimplemented (review regression, pinned by test).

The published type graph is also self-contained: the public options take `WasmInput` — a
locally declared stand-in for `WebAssembly.Module | BufferSource` (`ArrayBuffer |
ArrayBufferView | WasmModule`, see `src/types.ts`) — because the repo's tsconfig has no DOM
lib and the ambient declarations the package compiles against are source-only (never
published; the package ships `dist` only). `WasmModule` is **opaque/branded**: its only
producer is `loadShippedWasm()`, so accidental values (`{ wasm: 42 }`, a plain object, a
string) are compile-time errors — pinned by `@ts-expect-error` negative cases in the
consumer fixture (review regression: `WasmModule` used to be an empty interface that
satisfied every non-null value). Custom WASM is accepted as raw bytes (`ArrayBuffer` /
`ArrayBufferView`). A consumer check with the repo's non-DOM lib and
`skipLibCheck: false` is part of the test suite (`test/public-types.test.ts`).

## The guest library and the bridge (phase B)

At VM creation the host installs the **guest-side library** — a version-marked plain script
evaluated exactly once in the realm — plus the four `__host_*` callbacks that are the realm's
entire effect surface. The library is this package's fresh implementation (not a vendor of the
harness's `guest/dsl.js`); its source is `src/guest/guest-library.ts`, its version is
`GUEST_LIBRARY_VERSION` (marker global `__REPL_GUEST_VERSION`), and its semantics follow the
roadmap doc's DSL split: only a sliver needs host effects, everything else is pure JS.

### Sandbox globals

- `agent(modelSpec, task, options?) → Promise` — the delegation primitive, per the roadmap
  doc's own example (`agent("pi/deepseek-v4-flash-max", "research X")`). `modelSpec` is
  the backend-routing spec; `task` the worker's prompt; `options` (structured-output
  schema, cwd, backend config) cross the bridge as JSON. The returned promise **is** the
  live handle: it may sit in a variable across evals, and it carries own non-enumerable
  handle methods `followUp(prompt, opts?)` / `steer(prompt, opts?)` / `cancel()` — each
  resolving with **what actually happened** (the host settles with the steering outcome,
  live injection vs queued delivery, mirroring the outcome values `acp-agents` surfaces
  in its steering events) — plus `id` (the stable call id `"c1"`, … used by
  `status`/`interrupt`).
- `checkpoint(question, options?) → Promise` and `checkpoint.answer(callId, value) → boolean`
  — the data plane interrupting the intent plane. The answer enters the data plane only
  through `checkpoint.answer` (the `__host_checkpoint` trailing-argument answer mode); it
  returns whether a pending checkpoint with that id was answered.
- `console.{log,info,warn,error,debug}` — the bridge: every argument is frozen (structuredClone
  via the shipped quickjs-wasi extension, with an iterative marker-copy fallback) into a real
  `$N` global, then forwarded as `{ refs, args }` to `__host_console`.
- `parallel` / `pipeline` / `verify` / `judgePanel` / `gate` / `retry` / `loopUntilDry` —
  pure JavaScript layered on `agent()`, following `packages/workflows/src/dsl.d.ts` semantics.
  A rejection with `recoverable: false` halts the surrounding orchestration; any other
  rejection is recoverable (a `null` slot in `parallel`/`pipeline`, reported via
  `console.warn`). **There is no budget surface**: no `budget()` global, no ledger, no caps
  vocabulary — resource limits are server configuration, invisible to the guest (the host's
  non-recoverable signal is exclusively `recoverable: false`). `phase()` is deleted per the
  doc.

### Guest library ⇄ host contract

| Function | Meaning |
|---|---|
| `__host_agent(callId, modelSpec, task, optionsJson)` | Kick off one worker run against the backend routed by `modelSpec`. May return a thenable (the bridge's `GuestCall` promise) — the guest chains onto it — or `undefined` (settle later via the surface). |
| `__host_checkpoint(callId, question, optionsJson, answerJson?)` | Question mode: three arguments, like `__host_agent`. Answer mode: a PRESENT fourth argument (the JSON-encoded answer) — the host settles the pending checkpoint and returns a boolean synchronously; nothing new pends. |
| `__host_agent_steer(callId, sessionId, action, payloadJson)` | Steering: `callId` is the operation's OWN registry id (the settlement key), `sessionId` the FOUNDING call id of the session being steered (the dispatch and post-restore re-issue target); `action` is `"followUp"` \| `"steer"` \| `"cancel"` and `payloadJson` is `{ prompt, options }` or `null` for cancel. The host settles with the steering outcome. |
| `__host_console(level, payloadJson)` | The console bridge, called synchronously after the guest froze each argument into `$N`. |

Settlement is first-wins idempotent by call id, through two always-valid routes: the live
`GuestCall` (a promise created via the raw `qjs_new_promise` export whose parts the call
owns and disposes completely — the TS analogue of the Rust reference broker's
`new_promise_raw`/`Deferred`; the shim's `newPromise()` Deferred is deliberately not used
because it pins the reject-function handle until VM dispose, measured to exhaust a 2 MiB
VM after ~5,000 resolved calls) or the **reconciliation surface** after a restore. The
surface — `globalThis[Symbol.for("repl.guest")]`, read host-side via
`readGuestSurface(vm)` — exposes `version`, `pending()` (verbatim details for re-issuing
lost work, including `sessionId` — the founding session id for steering calls — and
`modelSpec`), `settle(callId, outcome, value)` and `stats()`; it is frozen, its binding
non-configurable, and its registry operations use captured intrinsics, so `Map.prototype`
pollution cannot corrupt settlement. The returned surface object pins NO guest memory:
every handle it needs is acquired per call and disposed on the spot. The pending-call
registry lives in the library's closure and **travels inside snapshots**; on restore the
host re-registers the four callbacks by name (`registerGuestHostCallbacks`) and
reconciles — the library itself is never re-evaluated (idempotence guard).

**Eval-await tracking — the continuation lease (version 0.3.0)** — the eval-break
  targeting seam (the `interrupt` tool's no-id arm): the library defines
  `__replAwait(value, token)` — the global the host's `instrumentTopLevelAwaits` rewrite
  inserts around every TOP-LEVEL `await` of an eval (`await x` →
  `await this["__replAwait"](x, TOKEN)`; the `this` base is the engine's global-object
  binding for the script's async wrapper, so the injected expression names no
  shadowable identifier — the phase-E review round-5 hygiene regression: the old
  instrumenter's guest-resolvable `__replAwait` identifier was shadowable by a lexical
  declaration, changing program semantics). With a token the awaited value is WRAPPED in
  a fresh promise whose settling reaction — the job that runs IMMEDIATELY BEFORE the
  eval's continuation segment — sets the CONTINUATION LEASE (the writable `__replLease`
  accessor global) to the eval's token. The host's drain loop reads the lease between
  jobs: a job that starts with a lease set IS the armed eval's continuation, and the
  lease is cleared after the segment ends — the armed signal's genuine per-eval
  identity. An unawaited sibling `.then` registered before the target's await runs
  first in the settlement drain (before the lease-setting reaction) and can neither
  fire nor consume the signal; an indirect wait (`await Promise.all([q])`) is
  targetable through the promise graph (the 0.2.0 log-only targeting refused it); a
  never-settling local promise is refused at arm time (no pending host call can ever
  resume it). The surface's `supportsContinuationLease` reports the capability. A
  snapshot carrying the 0.1.0/0.2.0 library is served as-is (the version-compatibility
  rule below): the host skips the instrumenter on it and the eval-break interrupt
  degrades to the honest refusal (the 0.2.0 log-only targeting is the rejected
  settled-call-ids identity). The transform is a pure source rewrite at exact AST
  boundaries (acorn; nested function bodies are never touched — an await inside a
  `.then` callback or a combinator thunk belongs to its own continuation, not the
  eval's) and injects nothing but the call sites (no helper binding — a top-level
  `const` would persist in the realm's global lexical record and redeclare on the loop
  idiom).

**Version compatibility** (the doc's evolution disciplines): the library is versioned with the
workspace, not the host — a host must serve any snapshot whose resident library is the same or
an older version, the host-call surface is append-only (new optional trailing arguments =
minor; new `__host_*` names = major), and the host discovers the resident version through the
surface rather than assuming. `ReplVm.restore` exists so the evolution discipline is testable
now: state, `$N` store, registry and marker survive a snapshot/restore round trip.

### The console bridge and the previewer

Every `console.log` is truncated in the tool result but **frozen in full inside the VM** as
`$1`, `$2`, … (what-you-saw-is-what-you-have: mutation after the log never changes `$N`), and
the rendered line carries the address, type and size — `[$14 · object · 48kB] {sections:
Array(12), title: "Auth flow", …}` — so the orchestrator slices deeper in a later eval
(`console.log($14.sections.map(s => s.title))`) instead of re-running work. Nothing is lost by
logging it; nothing floods the client's context by being logged.

The truncation format is the Chrome DevTools Protocol's `ObjectPreview` model, adopted as a
spec; the harness's `previewer/FORMAT.md` is the normative reference and this package imitates
its rules: one collapsed level, ≤ 8 properties / 8 leading array entries, 40-char property
strings (24+8 head/tail), 200-char top-level strings (120+40 head/tail), 120-char error
descriptions (72+24), a 400-char collapsed backstop, the `overflow` flag, head+tail elision
everywhere (errors live at the end), positional canonical-index rendering, and the byte-size
format with decimal units and the ≥ 999.95 promotion rule. Preview generation is
**side-effect-free by construction**: engine brand checks only, own-property-descriptor reads
only, proxies detected first and previewed *as* proxies (`Proxy(Array)`, `Proxy(revoked)`),
typed-array elements via the language-guaranteed integer-indexed reads, and the key
materialization read back through descriptors with honest degradation on a corrupted
enumeration (FORMAT.md §6 — a corrupted typed-array key count degrades with `overflow: true`,
never a fabricated "no expandos"). The forbidden seams stay unwired: symbol descriptions are
never read (`qjs_get_symbol_description` invokes guest `Symbol.keyFor` — FORMAT.md §1.1), so
symbols render as the bare brand `Symbol` everywhere, including thrown-symbol error messages,
and `qjs_get_array_buffer`'s raw data pointer is never passed to `qjs_is_exception` (a
guest-controlled buffer must not be able to forge a failed read). Every raw export that
returns heap-allocated JSValues (`qjs_get_typed_array_buffer`'s backing buffer,
`qjs_get_proxy_target`'s exception box) is disposed on every path. A `$N` slot rebound to an
accessor renders an explicit sabotage marker — the getter is never invoked.

### Output caps

`applyOutputCaps` enforces the doc's limits — **256 lines or 10 KB per tool result, whichever
trips first** — line-granular (a line that would trip either cap is not emitted at all) and
byte-counted in UTF-8 with `\n` separators (the canonical serialization). The 256-line cap
counts **physical lines**, not rendered entries: the previewer renders property names verbatim
(FORMAT.md §5.18), so a name carrying 300 line feeds reaches the tool result as 301 physical
lines inside ONE rendered line — both caps account for embedded newlines (the byte cap via
`Buffer.byteLength`, the line cap by splitting on `\n`; review regression, pinned by test).
Over-cap content remains reachable through the `$N` refs the capped lines carry: the cap
costs reads, never data.

## The workspace (phase B)

`Workspace.create` installs the guest bridge at VM creation — the doc's injection discipline:
`agent`/`checkpoint`/the combinators are live from the first eval, never undefined. `options.handlers`
may supply custom bridge handlers; the default is a **parking bridge** (agent/checkpoint/steer calls
park — they pend in the guest registry, visible through `surface()`/`parkedCalls()`, and stay
unsolved until a later phase attaches real backends; parking never fabricates a result — console
events accumulate in `consoleEvents()`). The one deliberate exception is `checkpoint.answer`:
answering a parked question settles the matching pending checkpoint first-wins, so the data plane
can interrupt the intent plane even with no backends attached. The workspace also exposes the
rendering seam
(`renderRef`, `inspectBinding`) and the reconciliation surface (`surface()`) the `repl` tool layer
builds on. A later phase that wires real backends swaps handlers via `registerGuestHostCallbacks`
(the same re-registration the restore path uses) — the broker does exactly that through
`Workspace.rehost`. `Workspace.snapshot()` / `Workspace.restore` are the raw snapshot
seams; the identity envelope (wasm hash + format version + gzip) is the daemon layer's wrap
(`ReplWorkspaceStore`).

## The broker (phase C)

`Broker.attach(workspace, options)` takes over a workspace's four `__host_*` callbacks (by-name
re-registration — the guest library and its pending-call registry are untouched) and implements
the doc's broker contract against real ACP sessions through `@automatalabs/acp-agents`:

- **`agent(modelSpec, task, opts)` dispatches a held-open ACP session** — the runner's
  `openSession` with the routing grammar, model spec and per-call `cwd` (default: the workspace's
  project directory). The guest option bag is exactly `{ schema, cwd, configOptions, mode, tier,
  label, toolNames, disallowedToolNames, meta, promptMeta, maxSchemaRetries, baseInstructions,
  developerInstructions }` — any other key refuses the call (`recoverable: false`). `schema` is a
  JSON Schema object validated by acp-agents' own structured-output ladder (`resolveStructuredOutput`
  driven over the session: convert/check, native + prose extraction, re-prompt, `SCHEMA_NONCOMPLIANCE`
  — the one divergence from `run()`: the client-hosted StructuredOutput MCP capture tool is not
  injected on the interactive path). Sessions stay open for the workspace's lifetime (the
  live-handle contract) and are opened with `keepSession: true`, so the ACP session persists on the
  backend for the restore path's lazy re-attach.
- **Six concurrent subagents per workspace** (doc-settled; `maxConcurrentAgents` configurable —
  server configuration, invisible to the guest). The cap counts live work: unsettled agent calls
  plus sessions running a queued-steer delivery turn. An over-cap dispatch is refused at dispatch
  time — recorded in the store (a refused call is never re-issued after a restore) and rejected
  with a recoverable `ConcurrencyLimitError`; nothing queues and nothing is hidden.
- **Steering resolves with what actually happened** (the doc's "nothing is hidden, nothing
  hard-errors"): `followUp`/`steer` settle with acp-agents' steering-outcome vocabulary where the
  backend advertises `_session/steering`, with the broker's honest `queued` marker where it does
  not (the per-backend steering mechanism table is the GENERATED artifact in
  `docs/steering-mechanism-table.md` — see `src/steering-table.ts` and its gate test). Steering calls NEVER
  hard-error: backend/wire failures resolve `failed`; the only rejections are guest protocol
  violations. `cancel()` resolves `cancelled` (turn in flight), `idle` (nothing running) or
  `failed`; a cancelled call rejects with the RECOVERABLE `AGENT_CANCELLED` (one worker's
  cancellation never halts the surrounding orchestration).
- **The append-only call store** (`src/store.ts`, transfer lesson 1): every call's outcome is
  recorded by call id BEFORE it is settled into the guest. `InMemoryCallStore` for tests and
  ephemeral hosts; `JsonlCallStore` is the durable append-only JSON-lines file — every mutation
  one fsynced line, torn-tail repair on open (fragment sidecarred then truncated; unterminated-
  but-complete records kept; newline-terminated corruption refused), and appends heal to the
  acknowledged prefix after a failed write. The pump's delivery loop is record → settle →
  consume, with both sides first-wins idempotent — a crash between the store write and the guest
  settlement is healed by the next delivery, exactly once (pinned by the simulated-crash tests,
  including the snapshot/restore + `reconcile()` path).
- **The eval tool-result shape** (`Broker.eval` → `{ output, outputTruncated, result?, pending,
  checkpoints, completed }`): output lines (console events rendered through the previewer — one
  line per logged argument, non-log levels prefixed `warn:`/`error:`/… — capped at 256 lines /
  10 KB), the previewed completion value when the eval resolved (trap-free, from the live
  completion handle), the pending call ids when it suspended (no fabricated value), the raised
  checkpoints (previewed questions), and the call ids this operation settled (checkpoint answers
  deliberately excluded — an answered id leaves the `checkpoints` list). Eval errors render as
  plain `Name: message` lines in `output`.
- **Suspended-eval semantics** (transfer lesson 3): top-level `await` accepted; an eval whose
  completion resolves within its drain reports the previewed value; a suspension returns
  immediately with the pending call ids; the continuation resumes at settlement like a `.then`
  (its output lands in the next tool result); a late uncaught rejection surfaces as an
  error-level console line in the next tool result (the VM's rejection bridge, armed by the
  broker); top-level `return` stays a syntax error.
- **Checkpoints** (transfer lesson 4): `checkpoint(question)` parks a promise and records the
  dispatch; the question appears in the tool result's `checkpoints` list previewed through the
  top-level string rule (quoted, head+tail elided past 200 chars — guest-chosen text never
  crosses unbounded); `checkpoint.answer(id, value)` in a later eval records the answer and
  settles the parked promise within that eval — root-mediated by construction, first-wins, and
  the answer's continuation output lands in the delivering eval's own tool result.

The broker's public type surface is fully self-contained (structural `BrokerRunner`/
`BrokerSession` stand-ins — no acp-agents or quickjs-wasi types leak into the published
declarations; verified by the consumer fixture). `Broker.eval`/`pump`/`reconcile`/`dispose`
serialize, so overlapping tool calls can never interleave settlement bookkeeping.

## Decisions for spec-owed details

These are the decisions this phase made where the roadmap doc left room; later phases must
build on them rather than re-open them.

- **Default memory limit: 64 MiB per VM** (configurable per workspace and per registry).
- **Per-eval and per-drain interrupts composed over the built-in per-VM handler** (see
  Engine posture) — this is the only composition quickjs-wasi's API allows, and it keeps the
  whole interrupt mechanism on the built-in `qjs_set_interrupt_handler` path. A standalone
  settlement drain arms its own handler because the suspended eval's handler is gone.
- **`<repl>` as the default eval filename** for guest stack traces.
- **Eval completion is synchronous**: the completion value is read through the raw
  `qjs_promise_result` export instead of the shim's `resolvePromise()` (whose host promise
  yields even when already settled). This makes `dispose()` structurally un-raceable and
  serializes all VM operations, which in turn makes the interrupt-slot save/restore
  concurrency-safe (an `opDepth` reentrancy guard makes the serialization invariant
  structural).
- **Drain errors are authoritative eval errors**: when a drained job throws (interrupt-in-job
  is the canonical case), the eval reports that error; the guest exception has already been
  consumed and cleared by the drain loop, so the VM stays usable. The drain is the built-in
  pending-job loop, but the failed job's exception is read trap-free (see Trap-free
  rendering) and thrown as `DrainJobError` — never rendered through `toString()`.
- **A failed eval's exception value is freed immediately** (in a `finally`), and accessor
  descriptors' `get`/`set` handles are disposed on the spot — long-lived VMs must not
  accumulate guest memory from error paths (both leaks were measured during adversarial
  review and are pinned by bounded-memory regression tests).
- **The public wasm surface uses self-contained, branded types** (`WasmInput`/`WasmModule`
  from `src/types.ts`) instead of the DOM-lib `BufferSource`/`WebAssembly.Module` names, so
  the published declarations compile under the repo's non-DOM lib with `skipLibCheck: false`
  — and `WasmModule` is opaque, so only `loadShippedWasm()` can produce one (custom wasm
  goes in as raw bytes).
- **The registry dedupes the in-flight creation promise**: concurrent first-touches of one
  project key share a single creation, so exactly one VM is instantiated per workspace (the
  first caller's options win). `dispose` during an in-flight create cancels it — the created
  VM is torn down without materializing, the waiting `get` rejects, and a later `get`
  starts fresh.
- **Primitive error rendering follows native conversions for every primitive type**, with
  symbols as the one deliberate exception: a thrown symbol renders the bare brand `Symbol`
  (FORMAT.md §5.7) — its description is not readable trap-free, because reading it reaches
  `qjs_get_symbol_description`, which invokes guest `Symbol.keyFor` (FORMAT.md §1.1). A
  guest that replaces `Symbol.keyFor` must not be able to forge error rendering (pinned by
  test).
- **Realpath validation of `projectDir`** is deliberately NOT here: that is the daemon's
  project-registry concern (the `repl` tool's phase); the registry keys by the string it is
  given.

Phase C decisions (the broker, the call store, the eval tool-result semantics):

- **The broker dispatches held-open sessions** (`runner.openSession`), not one-shot `run()`
  calls: the live-handle contract (followUp/steer/cancel on a settled call) requires a session
  that outlives the call. Sessions are opened with `keepSession: true` (the ACP session persists
  on the backend for the restore path's re-attach) and stay open while any MCP client is
  connected to the project; on last-client disconnect the daemon drives the client-presence
  drain (`drainForDisconnect` — in-flight turns drain to completion, then idle children
  close) and later followUp/steer/cancel re-attach the session lazily. `schema` calls
  drive acp-agents' own `resolveStructuredOutput` over the session (`tryNative` = raw
  structured output, else the generic parse-final-JSON dialect) — the one divergence from
  `run()`: the client-hosted StructuredOutput MCP capture tool is not injected on the
  interactive path.
- **The concurrency cap counts live work** — unsettled agent calls plus sessions running a
  queued-steer delivery turn (a follow-up turn is a subagent working). Over-cap dispatches are
  refused AT DISPATCH TIME (nothing queues): recorded in the store (dispatched + rejected, so a
  restore never re-issues them) and rejected with a recoverable `ConcurrencyLimitError` with NO
  code — the doc deletes the budget vocabulary (`AGENT_LIMIT_EXCEEDED`/`BUDGET_EXHAUSTED` have
  no counterpart here), and `recoverable: true` is the one signal the guest needs.
- **The steering mechanism table** (the doc's spec-owed decision): extension backend + turn in
  flight → live `_session/steering` wire call, resolving with the backend's verbatim outcome
  (`injected`/`startedNewTurn`/`failed`); extension backend + idle session → a new turn
  (`startedNewTurn`); no-extension backend + turn in flight → queued for next-turn delivery,
  resolving `queued` IMMEDIATELY (the delivery happens at the next turn boundary; a delivery
  turn's failure surfaces as a warn-level line in the next tool result; a cancelled call drops
  its queue — both documented); no-extension backend + idle session → a new turn
  (`startedNewTurn`). Any wire failure resolves `failed` — steering never hard-errors. `cancel`
  resolves `cancelled` (a turn was in flight and ACP `session/cancel` completed; the cancelled
  call itself rejects with the recoverable `AGENT_CANCELLED` — never a halt signal for the
  orchestration owning it), `idle` (nothing was running), or `failed`. The
  outcome surface is acp-agents' `SteeringOutcome` plus the honest `queued`/`cancelled`/`idle`
  additions — urgency delivery (`injected`) is always distinguishable from next-turn delivery
  (`queued`/`startedNewTurn`).
- **The store records refused calls too** (dispatched + rejected with the refusal error):
  without the record, a restore would re-issue a call that was deliberately refused. `admitted`
  is deliberately absent from the record shape — it was the budget ledger's bookkeeping, and
  the ledger is deleted vocabulary.
- **`completed` excludes checkpoint answers** (the harness's pump convention): an answered id
  leaves the `checkpoints` list — that is its visibility; `completed` reports delegated work
  (pump deliveries + dispatch-time refusals).
- **`result` is the FORMAT.md collapsed rendering** of the completion value (the bare body —
  `42`, `"hello"`, `{a: 1, …}`), previewed from the live completion handle through the
  previewer's own trap-free machinery (the engine's internal eval-with-completion seam returns
  the unwrapped value handle; the published type graph stays clean). Eval errors render as a
  plain `Name: message` line in `output` (the harness's "thrown-exception message" convention;
  late uncaught top-level rejections are the `error:`-prefixed console-bridge lines).
- **Checkpoint questions cross previewed** via the previewer's top-level string rule
  (`stringDescription`: quoted, head+tail elided past 200 chars) — the harness's R74 rule;
  the id stays exact.
- **The broker serializes its async operations** (eval/pump/reconcile/dispose share one
  promise chain): two overlapping tool calls can never interleave settlement bookkeeping or
  the eval's pump-before-eval ordering. The pump delivers ready outcomes one at a time
  (record → settle → consume), keeping a failed delivery staged for the next pump — both the
  store write and the guest settlement are first-wins idempotent, so the retry settles exactly
  once.
- **`Workspace.snapshot()`/`Workspace.restore` are the raw snapshot seams** (the daemon layer
  wraps the identity envelope later); `Workspace.rehost` is the by-name callback re-registration
  the broker uses to take a workspace over — the same re-registration the restore path uses.

Phase D decisions (snapshots + restore; see also the "Snapshots and durability" section):

- **The envelope is a JSON header line + gzip of the shim's own `serializeSnapshot()` output**
  (its versioned QJSS binary with extension metadata) — the doc's "serializeSnapshot() output
  wrapped in the identity envelope" is followed verbatim; gzip is the shim-documented
  compression choice (JS runtimes decompress it natively). The header carries format name +
  format version + wasm sha256 + createdAtMs; the restore path compares the recorded hash
  against `wasmSha256Of` of the binary it restores with and REFUSES LOUDLY naming both
  hashes. The format version is a second refusal axis (version-bump test included).
- **`loadShippedWasm` records the shipped binary's hash against the compiled module** —
  `wasmSha256Of(module)` resolves through that registry; a module the engine did not load
  cannot be hashed (bytes are not recoverable from the compiled form) and refuses loudly
  (pass raw bytes instead).
- **The repl store reuses `@automatalabs/workflows`' store-layout helpers verbatim**
  (`workflowProjectPaths` — the mcp-server project registry's own helpers), so the store key
  derives from the project directory exactly as the workflow engine's and one project has
  one repl store. Files: `repl/snapshot.bin` + `repl/calls.jsonl`.
- **Atomic writes are tmp + rename + fsync** (fixed-name `.tmp`, single-writer discipline;
  best-effort directory fsync); a failed write removes the tmp and throws, leaving the
  previous snapshot untouched; the store directory self-heals on write after a `reset()`.
- **Restore-time corruption is contained in the same refusal family**
  (`SnapshotRestoreError`, code `RESTORE_CORRUPT` — a `SnapshotEnvelopeError` subclass, so
  the daemon's single containment catch covers the whole load path): the envelope's decode
  checks now include pointer-BOUNDS validation (runtime/context/stack pointers must be
  integers strictly inside the snapshot memory — a corrupted in-range VM header like
  `contextPtr: 0xfffffff0` refuses as `CORRUPT_PAYLOAD` at decode, before any VM exists),
  and a payload that passes every at-rest check yet cannot be materialized (a header
  patched to a wrong-but-in-bounds value, a guest surface that cannot be rehosted, a
  provenance registry that cannot bootstrap) refuses from `Workspace.restore` naming the
  underlying failure — after DISPOSING the partially created VM. The daemon records the
  refusal as stable state (later touches surface it without re-attempting the restore;
  `reset` clears it) — never a raw `RuntimeError` retry loop into garbage.
- **The safe-re-issue fence is re-checked after every awaited release** (`reissueReattached`
  and the reconcile catch arm): the loaded session's `release()` can park past the
  client-presence drain's bound (or a disposal's generation bump), during which the drain's
  forced stop settles the call durably and reports `isDrained`; a re-issue that resumed
  after the release would record a reissue and open a FRESH child post-drain. The
  generation captured at entry is re-checked after the await — a fenced landing holds the
  call (no reissue recorded, nothing opened; the call stays as the drain/disposal left it).
- **The debounce is boundary-in/burst-out**: the broker fires `boundary(kind)` per
  doc-defined boundary (after each eval; after each settlement drain that changed VM state)
  and `flush()` at the end of each serialized operation; the store's `snapshotWriter`
  debounces the burst into one atomic write. `SnapshotWriteOptions.debounceBursts` (default
  true) and `fsync` (default true) are the decided knob names; `ReplStoreOptions.persistenceRoot`/
  `env` override the workflow home.
- **The re-attach arm keys on a store-recorded backend session id** (`recordAttached`,
  written at session open BEFORE the prompt — a new append-only log event; overwrites on
  re-issue so a later restore re-attaches the CURRENT session). The capability gate is the
  runner's own `loadSession` (acp-agents' `supportsLoadSession` — a custom backend that
  omits it degrades through the same gate, surfaced guest-visibly).
- **`BrokerSession.awaitCurrentTurn` is REAL on the acp-agents adapter** (the loaded
  session's founding-turn completion; `InteractiveSession.awaitCurrentTurn`, phase-D
  review round 1: the seam used to be absent, so every built-in backend loaded, released,
  and re-issued). Its completion evidence is the **`_session/loaded_turn` vendor
  extension** (phase-D review round 3: the quiet-grace heuristic — a settled stream with
  a trailing assistant chunk treated as completion, which durably settled an assistant
  PARTIAL as a completed-while-down turn when the next live chunk arrived later — and the
  blind re-issue fallback, which duplicated a still-running backend turn, were both
  rejected; an AUTHORITATIVE terminal channel is required). `session/load` obliges the
  agent to replay the entire persisted conversation and only then resolve the load; the
  runner marks the LOAD BOUNDARY synchronously after the response, and the seam then
  asks `_session/loaded_turn/query` whether the founding turn is still running RIGHT
  NOW. The backend answers one of three terminal classifications: (1) `completed` — the
  turn observably completed while the host was down, so the replay's trailing assistant
  message is its FINAL message and the seam resolves immediately with the REAL
  accumulated text (`stopReason` synthesized `end_turn` — the protocol's replay carries
  none; the broker's result-shaping gates still apply); (2) `interrupted` — the turn
  ended without a terminal assistant message and no turn is running, so the seam rejects
  with the SAFE-RE-ISSUE class (nothing to duplicate); (3) `running` — the turn is still
  executing at the backend, so the seam KEEPS THE LOADED SESSION ATTACHED and waits for
  the authoritative `_session/loaded_turn/ended` notification (a quiet gap is only a
  progress-stream gap, never terminal evidence), absorbing the live update stream and
  settling with the turn's REAL accumulated text at the notification, bounded by
  `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS` (default 15 min — the "never hang
  unobserved" backstop). A backend WITHOUT the extension degrades guest-visibly through
  the same strict advertisement gate (never by settling partial output, never by
  re-issuing a possibly-running turn): the seam rejects immediately with the
  non-re-armable `LoadedTurnStillRunningError`, and this broker keeps the loaded session
  attached, leaves the call pending, and surfaces the condition guest-visibly
  (cancelable). A `running` turn past the max-wait bound rejects with the RE-ARMABLE
  form of the same error (the broker re-arms the seam on the still-attached session — a
  later notification or a cancel still settles the call); a turn that failed at the
  backend rejects with `LoadedTurnFailedError` (a definite outcome, settled as an
  ordinary rejection, never re-issued); everything else (no user message in the
  transcript, `interrupted`, a dead process) is the safe-re-issue class. A handle that
  was never load-marked rejects immediately (without the boundary the completion is not
  observable and the seam never guesses). The broker arms the re-attached call on the
  seam WITHOUT blocking reconcile: reconcile returns immediately, the pump delivers the
  completion through the same record → settle → consume path as a live call. A third-
  party `BrokerSession` adapter WITHOUT the seam still re-attaches the session, then
  degrades the same unobservable way (the call stays pending on the attached session,
  surfaced guest-visibly) — never the old release-and-re-issue.
- **Backend identity/pool routing is persisted** (phase-D review round 2): the store
  records the model spec VERBATIM (including the guest's `"default"` sentinel) AND the
  RESOLVED backend id at session open (`recordAttached` — a backend id doubles as a model
  routing spec). The restore's re-attach, the lazy re-attach, and re-issues all route by
  the recorded pin — never by the CURRENT configured default, so a changed default
  across a restart can never load or re-issue on the wrong backend and miss a
  still-resumable original session.
- **Settled handles re-attach lazily** (phase-D review round 2; the doc: "followUp
  re-attaches the subagent session lazily via the capability matrix"): after the
  client-presence drain (or a restore that left settled calls unattached),
  followUp/steer/cancel on a settled handle load its recorded backend session through
  the runner's own `loadSession` — capability-gated exactly like the restore arm (a
  custom backend without the capability degrades through the same gate, surfaced
  guest-visibly as a warn line and the honest `failed` outcome); the loaded session
  serves the steering operation per the mechanism table. Concurrent lazy re-attaches of
  one session share a single load.
- **The client-presence drain** (`Broker.drainForDisconnect`, phase-D review round 2):
  in-flight turns DRAIN TO COMPLETION (each settlement boundary snapshots — never a
  cancel of running work), bounded by the spec-owed concrete bound, which REUSES the
  daemon's session-eviction TTL (the daemon passes `SESSION_IDLE_TTL_MS`; an over-bound
  turn is cancelled — the honest bounded teardown, settled as the recoverable
  `AGENT_CANCELLED`), then every idle child closes (`keepSession` keeps the backend
  sessions re-openable; queued-but-undelivered steers are re-queued durably against
  their founding session ids and delivered by the next re-attach exactly once). The
  workspace and broker stay alive; the next client's followUp/steer/cancel lazily
  re-attaches. Phase-D review round 3 hardens both edges: the drain WAITS for calls
  still OPENING (`openSession` parked — an opening call has no session entry yet, so a
  drain that considered only registered busy sessions returned `true` immediately and
  let the child open and run after the last client disconnected) and in-flight lazy
  re-attaches, and a parked open that outlives the bound is STOPPED (the late child is
  closed before it ever prompts, the call settles as the recoverable `AGENT_CANCELLED`,
  queued steers are dropped durably); and the outer bound is ABSOLUTE — every
  post-deadline cancel/release await races the remaining time, so a hung backend can
  never block disconnect/shutdown past the eviction TTL.
- **The per-eval wall-clock deadline** (`BrokerOptions.evalTimeoutMs`, default 30 s,
  `AGENTPRISM_REPL_EVAL_TIMEOUT_MS`; phase-D review round 2): every eval and settlement
  drain runs under a deadline enforced by the quickjs interrupt handler, COMPOSED with
  the configured signal handler — a currently-running runaway eval is ALWAYS breakable
  (the armed signal alone could only break the NEXT execution, because a synchronous
  eval blocks the event loop before a later request can arm it; the harness's own eval
  guard is the model). The VM stays usable after an interruption.
- **The workspace manifest** (`Broker.workspaceManifest()`, phase-D review round 2; the
  doc's status surface): top-level USER bindings (fresh-realm baseline set difference —
  the baseline is captured once per process from a throwaway VM provisioned exactly like
  a real workspace, and the engine-versioned library never grows the realm's baseline)
  with structure-only tokens (`{2 keys} · 1.2kB`, `string · 10B`, `number`, `Array(3) ·
  …` — metadata, never content: no value fragments, no nested names), provenance labels
  (`via eval N` / `via worker cN` / `session restore` — from the in-realm provenance
  registry, which is HOST policy (bootstrap-installed with the baseline as its `known`
  set) so it travels inside snapshots without touching the guest library; the
  maintenance pass runs after every eval and settlement drain, trap-free descriptor
  reads only, sanitized at render), and live-handle status (`agent handle ·
  pending|settled · call cN` — the call id maps to the task and timestamps in the
  store) and the doc's full provenance surface — `task` (the founding `agent()` call's
  task text for `worker cN` and handle bindings, capped at 200 chars) and
  `provenanceAtMs` (the attribution wall clock; phase-D review round 3: bindings used
  to carry only the label and an internal timestamp). The `$N` log-ref globals render
  as a range (`logs: $1…$4 (4 values)`).
- **Pending steers whose wire call died with the process resolve `failed`** (recorded +
  settled + warned): their outcome is unknowable and re-injecting would duplicate; the one
  exception is queued-but-undelivered steers, whose payload is in the store (the phase-C
  queue rebuild). Pending checkpoints re-surface into the broker's checkpoint table
  (`PendingCheckpoint.call` is null on that path; answers settle through the reconciliation
  surface). Reconcile is idempotent (an `isTracked` guard never re-attaches/re-issues twice)
  and adopts store-unknown entries (foreign snapshot / wiped store) so the replay ledger
  stays complete. Re-issues respect the concurrency cap (over-cap re-issues refuse with the
  recoverable `ConcurrencyLimitError`).

Phase E review round 3 decisions (the carried review's three defects, as re-verified in
round 5):

- **The eval-break signal is keyed to the armed target's CONTINUATION, not to whichever drain runs next.** The carried defect: the drain-phase interrupt handler was installed on every later eval's drain without checking whether that drain resumed an armed target — an unrelated finite eval B (or an unrelated settlement drain) consumed the signal and the interrupted-drain release cleared the target's tracking while its checkpoint stayed pending and uninterruptible. The armed identity is the target's CONTINUATION TOKEN (round 5): the guest library's `__replAwait(value, token)` wrap sets the continuation lease to the eval's token in the job immediately before the eval's continuation segment, the drain loop mirrors the lease per job, and the signal fires only while the executing JOB holds an armed token — the executing job IS the target's continuation. An unrelated drain — and an unrelated JOB inside a drain that settled a target's call (an unawaited sibling `.then` registered before the target's await runs first, before the lease-setting reaction: it can neither fire nor consume the signal) — leaves the armed state intact; an indirect wait (`await Promise.all([q])`) is targetable through the promise graph (round 5's regressions). The interrupted-drain release (`releaseInterruptedEval`) is exact the same way: the interrupted job's lease names the eval whose continuation was actually executing — exactly that eval is released (a deadline-broken resumed runaway releases its tracked eval even when no signal was armed — a stale target would make a later arm target a dead eval); an unrelated interrupted drain leaves the armed state and every tracked eval intact. A no-id interrupt with NOTHING BREAKABLE — no eval in flight, or every in-flight eval suspended with NO pending host call (a never-settling local promise — no execution can ever resume it; a suspended eval's continuation is always queued by a pending call's settlement, directly or through any promise chain) — REFUSES and arms nothing.
- **The bounded wait sleeps only for the REMAINING budget**: `waitForCalls`'s inter-pump sleep is `min(50, deadline - now)` (the carried defect: the unconditional 50 ms sleep made every sub-50 ms `timeoutMs` take ~51 ms, violating the bounded-wait contract). The disconnect drain's pumps already did this; the wait now matches. A zero `timeoutMs` still performs ONE immediately available state read (round 5's regression: the chain acquisition used to return unacquired with the deadline already past, so an idle workspace reported `drained: false` and a pending call's surface read as empty).
- **The pending surface reports the WHOLE guest registry**: the trap-free reader's generic 256-element array cap silently truncated the guest surface's `pending()` list, and its `[ArrayTruncated]` marker mapped to `undefined` in the broker's id lists (a hole in the tool's structured `pending`). `readValue` still bounds the general preview read (default 256); the host-owned metadata surfaces (`readValueComplete` — the pending registry, the await log, the provenance registry's `read()` result) read with NO array-length or object-key cap: they are the frozen guest library's own metadata, bounded by the VM's memory like the metadata itself.

Phase B decisions (the guest library, bridge, previewer):

- **`repl.guest` as the surface key** (`Symbol.for("repl.guest")`, marker global
  `__REPL_GUEST_VERSION`) — a fresh namespace for this product's own library (the harness's
  `agentprism.guest`/`__AGENTPRISM_GUEST_VERSION` are its sibling project's).
- **Four host callbacks, no budget function**: `__host_agent`, `__host_checkpoint`,
  `__host_console`, `__host_agent_steer`. The harness's `__host_budget` is deleted with the
  budget surface; `__host_agent_steer` carries the doc's handle methods
  (`followUp`/`steer`/`cancel`) as a new host-callback name in the initial major.
- **`agent(modelSpec, task, opts?)` carries the model spec as a first-class argument** — the
  roadmap doc's own signature (`agent("pi/deepseek-v4-flash-max", "research X")`). The spec
  crosses the bridge to `__host_agent` verbatim and is recorded in the pending-call registry
  entry (`modelSpec`) so a restore can re-issue the call against the same routing.
- **Steering payloads are `{ prompt, options }` JSON** (or `null` for cancel) — the host
  interprets them; the guest passes the settlement value (the steering outcome) through
  verbatim, mirroring the outcome values `acp-agents` surfaces in its steering events.
- **A pending steer is snapshot-reconcilable**: `__host_agent_steer` receives the operation's
  OWN registry id first (the settlement key) and the founding session id second, and the
  registry entry records both (`id` + `sessionId`) in the pending manifest — the host can
  durably settle (by registry id) or re-issue (to the session) a pending steer after a
  restore (review regression: the entry used to omit the founding id).
- **Combinator model specs**: `verify`/`judgePanel` spawn their reviewers/graders through
  `agent("default", …)` — the DSL options are exactly `{ reviewers, threshold, lens }`
  and `{ judges, rubric }` (packages/workflows/src/dsl.d.ts); there is no per-call model
  option (an invented `opts.model` was removed in review). The `"default"` sentinel is
  host-routed to the configured default backend (mirrors dsl.d.ts, where reviewers
  inherit the run's default model when none is given).
- **The handle is the promise**: `agent()` returns the promise itself with own non-enumerable
  `id`/`followUp`/`steer`/`cancel` — started-not-awaited handles come free with top-level
  await, per the doc (`const research = agent(...)`; end the eval; check in next call). No
  `agent.start`/`agent.continue` variants (the doc does not carry them; `followUp` is the
  continuation vector).
- **Non-recoverable = `recoverable: false` exclusively** — the harness's reserved
  `BUDGET_EXHAUSTED`/`AGENT_LIMIT_EXCEEDED` codes are budget vocabulary, deleted per the doc.
- **`retry` mirrors the workflow engine exactly**: without `until`, the FIRST attempt's
  result is returned (`workflow.ts`: `if (!opts.until || opts.until(last)) return last` —
  "stopping early once `until(result)` holds" holds trivially when there is no predicate);
  with `until`, attempts run until the predicate holds or `attempts` are exhausted, and the
  last result is then returned for the caller to inspect. Review regression: the guest used
  to run every attempt without `until`, diverging from the repository DSL.
- **`loopUntilDry` dedupes within rounds too** (the harness dedupes across rounds only) —
  "collecting fresh (deduped by `key`) items" is honored completely; the default key degrades
  to a safe string for non-serializable items instead of throwing.
- **Weak collections keep typed markers in `$N` — nested ones too**: the structured-clone
  extension silently clones `WeakMap`/`WeakSet`/`WeakRef` to empty plain objects, at ANY
  depth of the logged graph, so `freezeValue` runs an iterative pre-flight over the whole
  reachable graph — depth bound AND nested-uncloneable detection — before attempting
  `structuredClone`; every weak collection (and function/symbol/promise) at any depth
  becomes a typed marker instead of an empty `{}`. An orchestrator must be able to tell a
  WeakMap from a deleted property even inside an object, array, or Map/Set. Review
  regression: the uncloneable check used to test only the logged root, so nested weak
  collections were silently normalized. (Pinned by the nested-weak-collections test.)
- **`GuestCall` owns and disposes every handle it touches** (the Rust broker's Deferred
  discipline): the marshalled value is disposed after settling, both resolving functions are
  disposed at settlement (raw `qjs_new_promise` parts — the shim's `newPromise()` pins the
  reject function until VM dispose, measured to exhaust a 2 MiB VM after ~5,000 resolved
  calls), and the promise handle is released via microtask once the host-callback trampoline
  has dupped it (the shim's host_call path never frees the host-side original). Pinned by
  5,000-call / 20,000-call bounded-memory tests.
- **A throwing handler disposes every deferred part** — `GuestCall.dispose()` frees the raw
  promise handle (synchronously — on the throwing path the trampoline never dups a return
  value) and both resolving functions, without settling, and every `__host_*` question-mode
  maker wraps its handler call in try/catch: the documented synchronous-refusal path can no
  longer strand the unused raw promise/resolver handles (review regression: ~3 JSValues +
  heap boxes leaked per refusal — 30,000 rejected calls filled a 2 MiB VM and the next
  normal agent call failed with `Error: null`; pinned by the 30,000-refusals
  bounded-memory test, which then re-registers working handlers and proves the VM is
  healthy). Answer mode mints no `GuestCall`, so a throw there has nothing to dispose.
- **The $N freeze path and the argument gatherers use captured intrinsics.** The library is
  evaluated exactly once at VM creation, before any guest code can run, so it captures what
  it needs then: the structured-clone extension's native function (a guest that replaces
  `globalThis.structuredClone` with an aliasing function must not make `$N` hold LIVE
  references — mutation after a log must never change the frozen store; review regression,
  pinned by test) and a bound copy of `Array.prototype.slice` (created via
  `Function.prototype.call.bind` at installation — no property lookups at call time, so
  replacing either prototype method with a throwing function cannot make `console.*` or
  `pipeline()` throw; `console.*` NEVER throws by contract; review regression, pinned by
  test).
- **`readGuestSurface` returns a surface that pins no guest memory**: every handle is
  acquired per call and disposed on the spot (review regression: the surface used to capture
  three owned function handles in closures with no disposal contract).
- **The console payload keeps the harness's `{ refs, args }` shape** — `args` is the
  best-effort JSON-safe encoding (capped, tagged wrappers) for hosts without a previewer;
  `$N` refs are the authoritative channel and are never truncated.
- **Output caps are decimal KB (10 × 1000 bytes)** — consistent with the preview format's
  byte-size convention (×1000 units), and line-granular with `\n` separators counted. The
  256-line cap counts PHYSICAL lines (embedded `\n`s inside a rendered line included —
  property names render verbatim per FORMAT.md §5.18, so a name can carry line feeds), so
  the cap matches what the client agent actually receives, line for line (review
  regression: an entry with 300 embedded LFs used to be retained whole with
  `truncated: false`, silently shipping 301 serialized lines).
- **`ReplSnapshot` is a self-contained structural stand-in** for the shim's `Snapshot` type,
  so the public `ReplVm.restore` declaration stays checkable by a non-DOM `skipLibCheck:
  false` consumer; snapshots produced through the shim satisfy it without conversion.
- **The internal shim is reached through a module-scoped map** (`getVmShim`, private to the
  package) — the published type graph never names a quickjs-wasi type (verified by the
  consumer fixture).
- **Engine quirk pinned**: a `value` GETTER on `Object.prototype` makes quickjs-ng's
  async-eval completion wrapper come out empty (engine-internal, guest-code-free — the
  getter never fires, verified by counter); eval completions honestly degrade to `{}` under
  that pollution, and the trap-free fallback never fabricates a value. Similarly, the
  engine's spec-mandated thenability check fires a polluted `then` getter once per eval —
  before any of our code runs; the previewer itself adds zero getter fires (pinned by
  baseline-count tests).

## Snapshots and durability (phase D)

Disk persistence is v1 scope (the roadmap doc's §Snapshots): the workspace survives daemon
restarts — the property that makes a "persistent REPL" trustworthy. Three cooperating pieces:

- **The identity envelope** (`src/snapshot-envelope.ts`, transfer lesson 5): the shim's own
  `serializeSnapshot()` output wrapped in a JSON header line + gzip — the header carries the
  format name (`repl-snapshot`), the envelope format version (`SNAPSHOT_FORMAT_VERSION = 1`),
  the **wasm-binary sha256** (`wasmSha256Of` — raw bytes hash directly; a compiled module
  hashes through the registry `loadShippedWasm` populates) and the creation time. A restore
  whose recorded hash mismatches the running binary REFUSES LOUDLY naming both hashes
  (`WASM_HASH_MISMATCH`) — never a silent restore into garbage; a version bump refuses
  naming both versions (`VERSION_MISMATCH`); corrupt/truncated files refuse with a specific
  `SnapshotEnvelopeError` code, single-shot, no crash-loop.
- **The per-project store** (`src/repl-store.ts`): `ReplWorkspaceStore` lives in a `repl/`
  subdirectory NEXT TO the workflow state under `workflowHomeDir()/projects/<key>/`, reusing
  `@automatalabs/workflows`' store-layout helpers verbatim (the same helpers the mcp-server
  project registry uses — one project, one repl store). It holds `snapshot.bin` (the
  enveloped snapshot) and `calls.jsonl` (the broker's durable `JsonlCallStore`). Snapshot
  writes are atomic (tmp + rename + fsync, best-effort directory fsync — a kill at any
  moment leaves either the old complete snapshot or the new one).
- **The snapshot cadence + debounce**: the broker fires a state-changing boundary after each
  eval and after each settlement drain that changed VM state (`BrokerOptions.snapshotSink`:
  `boundary(kind)` per boundary, `flush()` at the end of each serialized operation — the
  burst boundary). The daemon wires it to `store.snapshotWriter(workspace, wasm)`, which
  debounces one drain burst's boundaries into a single atomic write taken before the
  operation's promise resolves (a broker eval that pumps settlements and then drains the
  eval is ONE write). The debounced gap is always covered by the call store — settlements
  are recorded BEFORE they settle, so a restore replays them from the store arm. Config
  knobs (decided names): `SnapshotWriteOptions.debounceBursts` (default true) and
  `SnapshotWriteOptions.fsync` (default true), plus `ReplStoreOptions.persistenceRoot` /
  `env` for the workflow-home root.
- **The restore path with the full three-way reconciliation** (transfer lesson 1):
  `Broker.reconcile()` reads the in-VM pending-call registry and settles every outstanding
  call exactly one way — completed while down → **settle from the store**; still resumable
  at the backend → **re-attach** via `runner.loadSession` (the capability gate is the
  runner's own, per acp-agents' `supportsLoadSession` — all four built-ins advertise it per
  docs/api.md; a custom backend that omits it degrades through the same gate, surfaced
  guest-visibly as a warn line); lost → **re-issue** under the same call id (reissues
  counter bumped, the existing guest promise settles exactly once, the concurrency cap
  applies). The re-attach keys on the backend session id the store recorded at session
  open (`recordAttached`, written BEFORE the prompt — a crash with a turn in flight leaves
  a restore able to re-attach instead of duplicating) and routes by the store's RECORDED
  backend id (never the current configured default). A re-attached call's completion is
  the loaded session's founding turn, observed through the REAL
  `BrokerSession.awaitCurrentTurn` seam on acp-agents' `InteractiveSession` — the
  `_session/loaded_turn` extension's authoritative terminal classification (a `completed`
  answer settles from the replay immediately; an `interrupted` answer re-issues safely;
  a `running` turn is KEPT ATTACHED and settles only from the `_session/loaded_turn/ended`
  notification — a quiet gap is never settled, a still-running turn is never re-issued,
  and a backend without the extension degrades to the same pending-on-the-attached-
  session posture, surfaced guest-visibly; a turn that failed at the backend settles as
  a definite rejection). Pending checkpoints re-surface (answerable
  across a restore, through the reconciliation surface) and pending steers whose wire call
  died with the process resolve the honest `failed` with a warn line (their outcome is
  unknowable; re-injecting would duplicate; queued-but-undelivered steers are the one
  exception — the phase-C queue rebuild re-queues them exactly once). Reconcile is
  idempotent: a repeated reconcile never re-attaches or re-issues twice. Reconcile-time
  re-issue refusals (invalid registry options, the concurrency cap — including the
  no-recorded-session and adapter-without-seam branches) settle the guest and participate
  in the changed-VM drain + settlement boundary.

## Daemon wiring (phase D, in `mcp-server`)

The `repl` MCP tool is registered in `mcp-server` and wired to the daemon's project model
(the roadmap doc's Surface section): one persistent VM per `projectDir` context. The
per-project context opens this phase's store — `repl/` under
`workflowHomeDir()/projects/<key>/` — and on FIRST TOUCH either restores the stored
workspace (enveloped snapshot → `Workspace.restore` → broker attach → the three-way
`reconcile()`) or creates a fresh one (SINGLE-FLIGHT: concurrent first touches share one
in-flight promise — one VM and broker per project, the single-writer persistence model);
the broker's state-changing-boundary sink is attached so every eval and every settlement
drain that changed VM state persists. A stored snapshot that REFUSES on first touch
(corrupt/truncated, format-version bump, or a wasm-hash mismatch naming both hashes) is
CONTAINED: the refusal is surfaced loudly in every `repl` result and `reset` clears the
store — the daemon never crash-loops and never silently discards the data. The workspace
therefore survives daemon restarts: this is the production wiring the phase-D review
demanded (`ReplWorkspaceStore` used to be exported/tested only).

Every `repl` result also carries the doc's MACHINE-READABLE shape as
`structuredContent` (phase-E review round 3 — the tool used to flatten
everything into text): the published `outputSchema` (the workflow tool's
oneOf-branch pattern) mirrors eval/wait as `{ output, result?, pending,
checkpoints, completed }` plus the wait-only `drained`/`timedOut` flags,
status as structured workspaces (state, the reconcile summary, the
workspace manifest with name/token/size/provenance/task per binding, the
live agents, the pending ops), interrupt as its honest outcome, reset as
the dropped acknowledgement, and the error variant for refusals. Guest
output (the capped console lines, the previewed result) stays in
separate fields from the trusted orchestration metadata — never one
flat string — and every structured field is bounded metadata (output
capped by the broker, checkpoint questions previewed, manifest tokens
structure-only). The bounded text stays alongside for human reading.

## Client presence and the drain (phase D, in `mcp-server`)

The doc's client-presence policy is wired in full. The daemon's session registry measures
liveness by connection presence and now SIGNALS last-connection-closed
(`SessionRegistry.onLastConnectionClosed`); a per-daemon `ReplPresenceLedger` maps MCP
sessions to the repl projects they touched (every `repl` call touches), and a project
whose client set becomes EMPTY is DRAINED: in-flight subagent turns drain to completion —
`Broker.drainForDisconnect` pumps until no session has a turn running, each settlement
boundary snapshots, so "close the laptop while two researchers run" ends with the
findings durable in the workspace — bounded by the SPEC-OWED concrete bound, which
REUSES the daemon's session-eviction TTL (`SESSION_IDLE_TTL_MS`; the runner's own
runaway protections already bound individual turns — the TTL is the outer ceiling; an
over-bound turn is cancelled, the honest bounded teardown), and then every idle child
closes (`keepSession` keeps the backend sessions re-openable). The workspace and broker
stay alive; on the next client connect `followUp`/`steer`/`cancel` on a settled handle
RE-ATTACHES the recorded backend session lazily via the capability matrix
(`Broker.canLazyReattach`/`lazyReattach` — the runner's own `loadSession` gate; a custom
backend without the capability degrades through the same gate, surfaced guest-visibly).
Queued-but-undelivered steers survive the drain (re-queued durably against their founding
session ids — the next re-attach delivers them exactly once). At daemon shutdown every
workspace drains with the shutdown deadline before the broker teardown.

## The generated steering mechanism table

The per-backend steering mechanism table (the doc's spec-owed decision: "the table is
documentation generated from the capability probes") is a GENERATED ARTIFACT:
[`docs/steering-mechanism-table.md`](docs/steering-mechanism-table.md) is produced from
the live capability probes in `@automatalabs/acp-agents`'s
`ACP_EXTENSION_SUPPORT_MATRIX` (see `src/steering-table.ts`), and
`test/steering-table.test.ts` GATES it — the suite regenerates the document and fails
when the checked-in file drifts from the probes. Regenerate with
`pnpm --filter @automatalabs/repl-engine generate:steering-table`. The mechanism per
backend follows directly from the probed disposition: `supported` → live injection via
`session.steer()`; anything else → queued-for-next-turn delivery; a custom backend is
capability-gated per session at open.

## Development

```sh
pnpm build       # tsc -b
pnpm typecheck   # tsc --noEmit
pnpm test        # tsx --test (deterministic, credential-free)
```

The test suite pins the doc-required behaviors: eval round-trip, drain of microtasks/jobs,
memory-limit enforcement, interrupt breaking a runaway eval with the VM still usable after,
top-level-await acceptance, top-level-`return` rejection, pending-suspension with no
fabricated value, trap-free completion reads under `Object.prototype` pollution — plus the
adversarial regressions: no guest getter runs during synchronous parse failures, rejected
completions, drain failures, or **failing descriptor reads** (the raw descriptor path never
constructs quickjs-wasi's getter-invoking `JSException`); thrown proxies and proxy
prototypes report trap-free markers; thrown symbols report the bare brand `Symbol`, never
`NaN`;
standalone settlement drains arm their own interrupt handler and break delayed runaway
continuations; `dispose()` cannot race an in-flight eval; concurrent evals never leak
interrupt handlers; the registry instantiates exactly one VM under concurrent first touches
and cancels in-flight creates on dispose; 20,000 consecutive syntax errors and 20,000
accessor-valued completions leave a 1 MiB VM healthy; and a non-DOM `skipLibCheck: false`
consumer compiles the published declarations — including `@ts-expect-error` negative cases
pinning the opaque `WasmModule` boundary.

Phase B pins the guest library and bridge: install/version-marker/idempotence (re-eval and
re-install are no-ops), the deleted vocabulary (`phase`, the whole budget surface), agent
round trips with the model-spec signature and JSON options, rejections normalizing to Errors
carrying `code`/`recoverable`, the live handle (`id`/`followUp`/`steer`/`cancel`,
non-enumerable, steering addressed to the founding session id), synchronous host-refusal
rejection, started-not-awaited settlement through a later standalone drain, the checkpoint
question→answer flow across evals (with `false` for unknown/answered ids and a TypeError for
non-JSON answers), every combinator over a mocked `__host_agent` (parallel order/null
slots/non-recoverable halts, pipeline stages and slot semantics, retry attempts and `until`,
gate feedback loops, loopUntilDry dedupe/emptiness/maxRounds and circular-safe keys, verify
votes and dropped reviewers routed through the `"default"` sentinel (no `opts.model` in the
DSL options), judgePanel mean scores and stable tie-breaks), the reconciliation surface
(pending/settle/stats with `sessionId` and
`modelSpec` on entries, first-wins idempotence, `Map.prototype` pollution immunity via
captured intrinsics, no pinning of guest memory), steering snapshot-reconciliation (the
pending steer entry carries both ids; settle works by registry id across a restore), handle
hygiene (5,000 resolved agent calls leave a 2 MiB VM healthy; 5,000 parked agent calls leave a
3 MiB VM healthy — parked registry entries are live for the VM's lifetime, so their honest
footprint fills a 2 MiB limit to 99.9%, a knife-edge where any library evolution tips it; the
3 MiB limit keeps ~70% headroom while a per-call leak still cannot hide; 30,000 synchronous
host refusals — agent, steer and checkpoint — leave a 2 MiB VM healthy, with a normal agent
call still completing afterwards), the captured-intrinsic regressions ($N freezing is immune
to `structuredClone` aliasing pollution; `console.*`/`pipeline` keep working when
`Array.prototype.slice` and `Function.prototype.call` are replaced by throwing functions),
host-serving-an-older-library (a workspace whose resident library is v0.0.1 installs, works,
and keeps its resident version under the current host's install path), snapshot
travel (state, `$N` store, registry and marker survive; callbacks re-register by name; new
calls mint fresh ids), `$N` freezing (mutation after log never changes the store; the store
is the agent's writable workspace; hostile values including revoked proxies degrade to typed
markers without throwing; 2000-deep nesting freezes without crashing the VM; cycles are
preserved), and the console payload shapes. The workspace suite pins the phase-B injection:
a created workspace exposes the DSL, accumulates console events, parks calls, and serves the
surface/render/manifest seams. Phase C adds the store and broker suites: the call-store
semantics (in-memory first-wins dispatch/completion idempotence and unknown-id refusal; the
JSONL replay with first-wins across reopens; the torn-tail repair discipline — an
unterminated unparseable tail is sidecarred and truncated, an unterminated-but-complete
record is kept with its terminator restored, newline-terminated corruption anywhere is a
hard error, a partial append heals to the acknowledged prefix — and the missing-file open),
and the broker against a fake runner/session: the eval tool-result shapes (resolved with the
previewed value, suspended with the pending call ids and no fabricated value, rejected with
the error line, top-level `return` as a syntax error), the continuation-at-settlement flow,
the late-uncaught-rejection error line in the next tool result, the schema ladder (validated
extraction, re-prompt, `SCHEMA_NONCOMPLIANCE`) and `AGENT_EMPTY_OUTPUT`, exactly-once
settlement (a simulated crash between the store write and the guest settlement — both the
live pump retry and the snapshot/restore + reconcile settle-from-store arm, with the guest
continuation firing exactly once), the checkpoint round trip (raised → previewed question →
answered in a later eval → settlement within that eval, unknown/answered ids report false,
the answer recorded before settlement), steering outcome visibility (extension backend: live
injection with the backend's verbatim outcome and wire failures resolving `failed`;
no-extension backend: `queued` at enqueue and next-turn delivery, delivery-failure warn
lines; idle sessions start new turns with and without the extension; cancel → `cancelled` +
the call's `AGENT_CANCELLED` rejection, idle cancel → `idle`), the concurrency cap
(dispatch-time refusal recorded in the store, slot release on settlement), trap-free result
rendering (accessor completions render `(...)` and never fire; the `Object.prototype.value`
pollution cannot hijack the result line), and the output caps (preview lines one-per-argument
with level prefixes; truncation at 256 lines with `outputTruncated`). The consumer fixture
exercises the whole phase-C public surface (`Broker`, the store classes, the self-contained
`BrokerRunner`/`BrokerSession` stand-ins, the eval-result types) under the non-DOM
`skipLibCheck: false` configuration. The previewer suite pins the FORMAT.md rules (primitives incl.
`-0`/exponent forms, string head+tail elisions and escaping, functions, errors with
own-data-only names, promise states, arrays with holes/named props/overflow, plain objects
with positional indices and accessor `(...)`, branded objects and typed arrays with expando
overflow, proxies incl. revoked, property-level shorthand tokens, the 400-char backstop,
byte-size formatting with the promotion rule, the `$N` line format), the trap-freedom
guarantees (hostile getters on `Object.prototype`/`Array.prototype` never fire — including
the `Object.prototype.value` pollution case; proxy traps never fire; an accessor-rebound
`$N` slot renders the sabotage marker; a guest that replaces `Symbol.keyFor` cannot forge
thrown-symbol rendering; the byte-size estimate is bounded and cycle-safe), the FORMAT.md §6
degradation (a corrupted key materialization lists nothing and flags overflow — typed arrays
included), and bounded-memory previews (3,000 revoked-proxy and typed-array previews leave a
2 MiB VM healthy). `caps.test.ts` pins 256 lines / 10 KB (whichever trips first),
line-granular truncation and UTF-8 byte counting — with physical-line accounting for
embedded newlines (a rendered line whose property name carries line feeds counts as that
many lines; exact at the 256 boundary; embedded-LF bytes count toward the 10 KB cap).

Phase D adds the snapshot + restore suites: `snapshot-envelope.test.ts` (the envelope round
trip — serialize → deserialize → restore with state intact, gzip actually compressing —
`wasmSha256Of` byte/module/foreign-module behaviors, the version-bump refusal naming BOTH
versions, the format-name refusal, and corrupt/truncated header + payload refusals),
`repl-store.test.ts` (the `repl/` subdirectory layout under
`workflowHomeDir()/projects/<key>/`, the write/load round trip with the call store
coexisting, the wasm-hash-mismatch refusal NAMING BOTH HASHES, the version-bump refusal
through the store, corrupted/truncated handling — loud single-shot failure with the store
immediately usable, no crash-loop — a failed write leaving the previous snapshot untouched
and removing the tmp, the boundary-in/burst-out debounce (one atomic write per drain burst,
`debounceBursts: false` writing per boundary), and `reset()` teardown) and `restore.test.ts`
(the full restore flow with all three reconciliation arms against mock backends — settle
from the store / re-attach via `loadSession` with the capability gate / re-issue under the
same call id with the reissues counter bumped and the guest promise settling exactly once —
the custom-backend-without-the-capability degradation surfaced guest-visibly, the lost-
session degradation, reconcile idempotence, over-cap re-issue refusal with the recoverable
`ConcurrencyLimitError`, checkpoint re-surfacing + answering across a restore, in-flight
steers resolving the honest `failed`, the state-changing-boundary cadence (after each eval
and each settlement drain that changed VM state; nothing for an empty drain; the
reconcile-time refusal branches — invalid options and the over-cap re-issue — settle the
guest and fire the boundary too, and a changed-VM drain that FAILS still fires its
boundary, on the reconcile and pump paths alike), the end-to-end debounce through the
per-project store, and the re-attach arm through the REAL acp-agents adapter (a real
`AcpAgentRunner` + `InteractiveSession` over the fake ACP agent, driven by the
`_session/loaded_turn` extension: a completed-while-down call re-attaches and settles
from the loaded session's replay with no re-issue, wire-log proven — including the
`_session/loaded_turn/query` on the wire; a still-running turn settles ONLY from the
authoritative `_session/loaded_turn/ended` notification — an assistant PARTIAL whose next
live chunk arrives later than any quiet grace is never durably settled, and the
still-running turn is never re-issued (no fresh session ever opens); an `interrupted`
turn re-issues immediately; a backend without the extension degrades to the pending-on-
the-attached-session posture). Phase-D
review round 2 adds `review2.test.ts` (the lazy re-attach of settled handles after the
client-presence drain — followUp/steer/cancel re-attach the recorded backend session
through the capability gate, and a gate failure degrades to the honest `failed` surfaced
guest-visibly; the persisted backend routing pin — restore and re-issue route by the
recorded backend id, never the current default; the `drainForDisconnect` policy — turns
drain to completion with settlement boundaries, the bound cancels an over-bound turn as
the recoverable `AGENT_CANCELLED`, queued-but-undelivered steers survive durably; the
workspace manifest — structure-only tokens, provenance labels, live-handle status,
metadata-never-content asserted hard; the per-eval wall-clock deadline breaking a
currently-running runaway eval with the VM usable after; the provenance passes) and the
mcp-server `repl-review2.test.ts` (the wait action's same-shape output, the status
manifest, the single-flight first touch, the last-client-disconnect drain + lazy
re-attach, the eval-timeout env knob). The consumer fixture exercises the whole
phase-D public surface (envelope functions, `ReplWorkspaceStore`, the snapshot sink, the
manifest/provenance/drain surfaces, the extended report/seam types) under the non-DOM
`skipLibCheck: false` configuration.
