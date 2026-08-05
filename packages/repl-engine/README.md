# @automatalabs/repl-engine

The engine package of the **REPL orchestrator** (see
[`docs/roadmap/repl-orchestrator.md`](../../docs/roadmap/repl-orchestrator.md)): a persistent
JavaScript REPL in a capability-free QuickJS-in-WASM VM. One VM per workspace; the workspace
object owns the VM lifecycle (`create` → `eval` → `drainJobs` → `dispose`). The `repl` MCP
tool that registers in `mcp-server` (a later phase) is a thin entry over
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
compatibility (a later phase) holds only across runs on the same package version; a version
bump must refuse old snapshots loudly, never restore them silently.

- **`memoryLimit` per VM** — passed straight through to `QuickJSOptions.memoryLimit`
  (quickjs-wasi built-in). Exceeding it fails allocations with
  `InternalError: out of memory` (an `EvalErrorInfo` with `outOfMemory: true`); the VM stays
  usable. Default when unconfigured: **64 MiB** (`ReplVm.DEFAULT_MEMORY_LIMIT`) — generous for
  data-plane state while still bounding what a single workspace can make the daemon hold.
- **`interruptHandler` per eval** — quickjs-wasi's `interruptHandler` is a per-VM
  create-time option, so the engine composes per-eval semantics on top of the built-in: one
  VM-level handler delegates to a per-eval slot that `evalCode` arms for the duration of the
  eval **and its drain**, then restores. Handlers never leak across evals. Returning `true`
  aborts with `InternalError: interrupted` (`EvalErrorInfo.interrupted === true`). Note the
  interrupt budget is instruction-based (quickjs's built-in check interval), so against a
  tiny loop body the handler fires comparatively rarely — that is the shim's native behavior.

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

## Trap-free rendering (from day one)

Rendering guest state is adversarial territory (roadmap doc transfer lesson R69: a single
`[[Get]]` on the completion wrapper let `Object.prototype.value` pollution hijack every eval
result). This package follows the rule from its first line of engine code:

- The engine-created `{ value }` completion wrapper is unwrapped via
  **own-property-descriptor reads** (`getOwnPropertyDescriptor`), never `[[Get]]`.
- Completion values and error info are read the same way: own **data** properties only,
  accessors skipped, proxies and branded objects (`[Promise]`, `[Date]`, `[Map]`, …)
  rendered as markers, depth ≤ 4, ≤ 256 properties per level, cycle-guarded. This shallow
  read is the conservative seed of the ObjectPreview rendering a later phase owns; the
  tool-result caps live there.
- Error names come from the error prototype's own `name` data property when instances carry
  none (quickjs-ng stores `name` on the prototype) — still trap-free.

## Decisions for spec-owed details

These are the decisions this phase made where the roadmap doc left room; later phases must
build on them rather than re-open them.

- **Default memory limit: 64 MiB per VM** (configurable per workspace and per registry).
- **Per-eval interrupts composed over the built-in per-VM handler** (see Engine posture) —
  this is the only composition quickjs-wasi's API allows, and it keeps the whole
  interrupt mechanism on the built-in `qjs_set_interrupt_handler` path.
- **`<repl>` as the default eval filename** for guest stack traces.
- **`Workspace.eval` is synchronous in guest time**: host execution is synchronous from the
  guest's perspective (the only async hop is awaiting quickjs-wasi's already-settled
  `resolvePromise`), so the drain result and the completion state it observes are coherent.
- **Drain errors are authoritative eval errors**: when a drained job throws (interrupt-in-job
  is the canonical case), the eval reports that error; the guest exception has already been
  consumed and cleared by the shim, so the VM stays usable.
- **The registry dedupes concurrent first-touches**: `WorkspaceRegistry.get` under a race
  disposes the duplicate VM and returns the winner, keeping the one-VM-per-workspace
  invariant even under concurrent tool calls.
- **Realpath validation of `projectDir`** is deliberately NOT here: that is the daemon's
  project-registry concern (the `repl` tool's phase); the registry keys by the string it is
  given.

## Out of scope for this phase (later phases, per the roadmap doc)

Host-callback bridge (`agent()`/`checkpoint()`), console interception with `$N` freezing,
the ObjectPreview previewer, the call store and exactly-once settlement broker, enveloped
snapshots (wasm-hash + format version + gzip) and restore reconciliation, the guest DSL
library, and the `repl` MCP tool registration. The engine boundary here — `Workspace` +
`WorkspaceRegistry` + `ReplVm` — is the surface those phases build on; `Workspace.eval`
already returns the `{ value, pending, error }` skeleton the tool result shape fills in.

## Development

```sh
pnpm build       # tsc -b
pnpm typecheck   # tsc --noEmit
pnpm test        # tsx --test (deterministic, credential-free)
```

The test suite pins the doc-required behaviors: eval round-trip, drain of microtasks/jobs,
memory-limit enforcement, interrupt breaking a runaway eval with the VM still usable after,
top-level-await acceptance, top-level-`return` rejection, pending-suspension with no
fabricated value, and trap-free completion reads under `Object.prototype` pollution.
