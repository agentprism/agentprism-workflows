# API reference

The integrator-facing surface of the `@automatalabs/*` packages, in one place. This documents the supported integration APIs; package barrels also expose lower-level protocol utilities for advanced hosts, which remain typed but are not all repeated here. Version references are current for `workflows` 0.54.0, `acp-agents` 0.41.3, `workflow-engine` 0.38.0, `shared-types` 0.32.0, `mcp-server` 0.34.0, `repl-engine` 0.4.6, `agentprism-otel` 0.1.2, `pi-acp` 0.6.1, and `codex-acp` 2.1.1.

Packages (all published to npm, Apache-2.0, ESM-only, Node >= 22):

| Package | What it is | Depend on it when |
|---|---|---|
| `@automatalabs/workflows` | Facade re-exporting the supported orchestration surface (`runDynamicWorkflow`, `createAcpRunner`, `WorkflowManager`, `AcpAgent`, auth/session types) | You want the SDK. **Start here.** |
| `@automatalabs/workflow-engine` | The deterministic script engine + `WorkflowManager` (no agent construction — the runner is injected) | You bring your own `AgentRunner` and don't want ACP deps |
| `@automatalabs/acp-agents` | The ACP runner: pooled Claude/Codex/OpenCode/pi ACP processes, model routing, structured output, events, interactive sessions, the no-prompt harness config catalog (`probeHarnessConfig`), and the [`AcpAgent` SDK](#acpagent-sdk) (one dedicated process per held-open agent, forks, cold reopen) | You want agent execution without the workflow engine |
| `@automatalabs/acp-server` | ACP V1 proxy over stdio, Streamable HTTP, or WebSocket, with negotiated backend discovery and one backend pinned per operational connection | You want one extension-aware ACP endpoint for all configured backends |
| `@automatalabs/shared-types` | The seam contracts: `AgentRunner`, `RunOptions`, `WorkflowError` (+ codes), workflow result/meta types | You implement a custom runner or need `instanceof WorkflowError` across packages |
| `@automatalabs/mcp-server` | Stdio MCP server (bin `agentprism-workflow`) exposing the `workflow` tool (asynchronous run/resume, setup response, bounded status/result, live permission response, stop, and an Apps monitor) and the `repl` tool (a persistent per-project JavaScript REPL for live subagent orchestration) | You drive workflows from Claude Code / an MCP client |
| `@automatalabs/agentprism-otel` | Optional OpenTelemetry bridge for `WorkflowManager` traces and metrics | Your host owns an OTel SDK and wants run/agent/tool observability |
| `@automatalabs/pi-acp` | Standalone in-process pi coding-agent ACP server (bin `pi-acp`) with a side-effect-free library entry | You use the first-class `pi` backend or embed the ACP server directly |
| `@automatalabs/codex-acp` | Fork of `@agentclientprotocol/codex-acp` adding turn-level `outputSchema` forwarding | Installed automatically by `acp-agents`; only pin it directly to override the version |
| `@automatalabs/repl-engine` | The REPL orchestrator engine: persistent JavaScript REPL in a QuickJS-in-WASM VM — workspace lifecycle, eval + job drain, per-VM memory limits, per-eval interrupts | You build a persistent-JS-REPL surface (this package is the engine tier under `mcp-server`'s `repl` tool — see [MCP server](#mcp-server)) |

---

## Two front doors

**One-shot (facade):** construct nothing, get a terminal result.

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const run = await runDynamicWorkflow(script, {
  cwd: "/abs/path/to/project",   // every agent session runs here
  args: { target: "src/" },      // exposed as the script's `args` global
  exec: { concurrency: 4 },
});
// Never throws for ordinary outcomes — read run.status: "completed" | "paused" | "failed" | "aborted"
```

Options (`RunDynamicWorkflowOptions`): `runner?` (custom `AgentRunner`; defaults to `createAcpRunner()`), `cwd?`, `args?`, `exec?` (an [`ExecOptions`](#execoptions--per-run)), `allowScriptBackends?` (approval policy for script-declared `meta.backends`), `workflows?` (a [`WorkflowDir`](#workflow-directories--openworkflowdir) view or dir path(s): the first argument may then be a workflow NAME — any string without the mandatory `export const meta` head is resolved via the view's `read()`, throwing a diagnosable searched-dirs/did-you-mean error on a miss — and nested `workflow("<name>")` calls resolve from the same view).

### <a name="workflow-directories--openworkflowdir"></a>Workflow directories — `openWorkflowDir`

`openWorkflowDir(dir | dirs, { cwd? })` binds a read-only view over folders of versioned workflow scripts. Construction does **no I/O** (nothing created, scanned, or cached); every method reads the filesystem at call time so the view always reflects the current working tree, and missing dirs contribute nothing. The filename stem is the name (`review-pr.workflow.js` / `review-pr.js` ⇒ `review-pr`; across dirs first hit wins, within a dir `.workflow.js` beats `.js`; also `.mjs` variants). Surface: `dirs` (absolute, precedence order), `list()` (`[{ name, file, meta?, error? }]`, meta parsed per call, sorted), `read(name)` (script text; throws with searched dirs + closest matches), and `resolve(name)` — `(name) => string | undefined`, deliberately the exact `loadSavedWorkflow` contract, with strict name-shape validation (one flat path segment) so inline nested scripts fall through and path traversal is impossible. Exported by both `@automatalabs/workflow-engine` and the facade.

**Script validation (token-free):** `validateWorkflowScript(script, opts?)` runs a static parse (meta literal, syntax, and direct nondeterministic call expressions) plus a dry run over an in-process mock `AgentRunner`, then opens one no-prompt session for every distinct routed backend/model pair. `workflowMayUseDefaultModel(script)` remains a conservative static companion for SDK composition roots; MCP does not use it to select a default: it detects direct model-less calls/default-model helpers/nested workflows even behind a branch the fabricated result did not take; dynamic uncertainty fails toward `true`. An authored model is selected verbatim before the echoed, model-specific modes and config options are read; a backend-only route reads its harness/session default. An omitted effective model is accepted only by non-strict SDK validation, never MCP execution. The probe spends no tokens. `dryRun.harnessOptions` reports each routed catalog with optional `model` attribution on every run, even when the script authors no `mode` or `configOptions`; the human formatter prints the same tables. Successfully probed mode ids are validated exactly: only `modes.availableModes` values pass, while `modes:null` rejects any authored mode and tells the author to omit it. Config option ids and values are checked for unknown ids, invalid select values, non-boolean boolean values, and the reserved `"model"` id. A select option may add `_meta["@automatalabs/agentprism"].recognizedValues`: supported values pass unchanged, recognized unsupported values pass with an ordered clamp warning, and unrecognized values fail. Pi derives this domain from its SDK and advertises a per-model `thinkingLevel` subset. Ordered built-ins without that metadata (Claude and Codex) derive it client-side by enumerating the advertised model picker through the existing per-model probe cache and merging consistent per-model orders. Claude's absent `effort` option means unsupported, while `default` is recognized but excluded from ordered ceiling comparisons. `ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT` is 32; a larger picker or inconsistent orders warn and fall back to exact advertised-value validation. OpenCode and custom/unknown backends are exact-set and reject unadvertised thought-level values without clamping. A routed probe spawn/auth/model-selection/session failure adds one warning, sets that pair to `probed:false`, and skips its checks without invalidating the report. A successful probe proves session/config discovery, not universal first-prompt authentication: ACP has no generic zero-token auth-status method and some agents defer credential failure until `session/prompt`. Dry-run checkpoints use kind-valid simulated answers only for discovery, with journaling disabled; simulated answers never approve live execution. Script-declared backends are treated as approved (with a warning). Invalid scripts resolve to a report; read `report.ok` / `report.exitCode` (`0` valid, `1` parse failure, `2` dry-run or agent-configuration failure). `ValidateWorkflowOptions` is `{ args?, workflows?, dryRun?, cwd?, maxAgents?, timeoutMs?, defaultModel?, requireAgentConfiguration?, probeConfig?, probeRunner?, loadSavedWorkflow?, mockAnswers? }`; `defaultModel` is the host-pinned fallback applied to otherwise model-less calls. `requireAgentConfiguration` rejects each actual call without an effective model before hashing or runner dispatch; mock validation cannot prove live-branch coverage. `probeConfig:false` runs the mock routing pass without any no-prompt config probes/checks. `probeRunner` reuses a host-owned live runner without disposing it and `loadSavedWorkflow` keeps nested-name resolution identical to live admission; `workflows` accepts a `WorkflowDir` or dir path(s), the mock reports `MOCK_TOKENS_PER_AGENT` = 1000 per call, and timeout defaults to 30 000 ms.

`MockAnswers` is a read-only record from label glob to JSON answer or `{ $sequence: readonly MockAnswerJson[] }`. Matching uses the final resolved label, is case-sensitive and whole-label, and supports `*`, `?`, and backslash escaping. Normalization captures property order once and the last matching rule wins. Raw canonical array-index keys `"0"` through `"4294967294"` are reserved because ECMAScript reorders them; spell an exact numeric-label rule with an escape, such as JSON key `"\\10"` for label `10`. `"01"` and `"4294967295"` are not reserved. A raw array is one answer, while `$sequence` is finite and consumes only when its rule wins.

For schema calls the validator creates a fresh fabricated base per invocation and recursively deep-merges JSON objects; arrays, `null`, falsy primitives, and other scalars replace. It then runs TypeBox `Check` without `Convert`. Any answer-caused error is non-recoverable `SCHEMA_NONCOMPLIANCE`; identical failures inherited from untouched fabricator limitations are accepted with grouped, value-free warnings. Schema-less scripted answers must be nonblank strings. Sequence exhaustion fails rather than repeating or falling back. `ValidatedAgentCall.mockAnswer` records the winning glob and zero-based sequence position; `dryRun.mockAnswers` reports captured-order rule match/consumption counters and item-level `no-match`, `shadowed`, or `not-reached` unused entries. Human positions are one-based. Unused entries only warn.

Inputs are limited to 256 KiB raw CLI UTF-8 and canonical programmatic JSON, 256 rules, 256 UTF-16 code units per glob, 256 sequence items, and answer depth 32; only ordinary JSON data is accepted. Supplying invalid programmatic `mockAnswers` throws `TypeError` before parsing. Mock-enabled validation serializes agent service at concurrency one for deterministic FIFO sequence use, so it is not a load simulator. Attribution, warnings, and validation errors never echo answers, but workflow code receives the fixture normally and may expose it in `log()` or the returned result; fixtures must not contain credentials or production data.

The CLI adds mutually exclusive `--mock-answers <json>` and `--mock-answers-file <path>` to the existing `npx @automatalabs/workflows validate <file-or-name> [--args <json> | --args-file <path>] [--workflows-dir <dir>]… [--parse-only] [--cwd <dir>] [--max-agents <n>] [--json]` surface (`3` = usage error). With `--workflows-dir` the positional may be a workflow name and nested `workflow("<name>")` calls resolve. The package exports `MockAnswerJson`, `MockAnswerSequence`, `MockAnswerRule`, `MockAnswers`, `ValidatedMockAnswerUse`, `ValidatedMockAnswerRule`, `UnusedMockAnswer`, and `ValidatedMockAnswers`, along with the existing validation types and `fabricateFromSchema()` / `formatValidateReport()` helpers.

**Harness config discovery (token-free):** `probeHarnessConfig` lives in `@automatalabs/acp-agents` and is re-exported by `@automatalabs/workflows`; `probeHarnessConfig({ harnesses?, modelSpecs?, backends?, cwd?, probeRunner?, probeTimeoutMs?, probeConcurrency?, signal? })` runs validate's no-prompt config probe standalone — no script — and resolves to a `HarnessConfigReport` (`{ ok, exitCode, harnessOptions, authoringSummary? }`, per-harness entries in the same `ValidateHarnessOptions` shape with `modes?: SessionModeState | null` and `options?: SessionConfigOption[]`). A successful built-in probe always reports modes explicitly after normalizing ACP's mode config-option fallback; `null` means unsupported, so callers must omit `mode` rather than infer a default. Default targets are the built-in harnesses plus every registered custom backend; `backends` merges over `AGENTPRISM_BACKENDS` exactly like `createAcpRunner`. A per-harness spawn/auth/session failure or timeout (default 60 000 ms) reports `probed:false` without throwing; only a malformed registry or invalid options throw. `probed:true` means the no-prompt session/config path succeeded, not that every adapter proved first-prompt authentication. `formatHarnessConfigReport(report, { includeSummary? })` renders the CLI's human table and includes the authoring summary by default; composition roots can render that summary separately. CLI: `npx @automatalabs/workflows config [harness ...] [--cwd <dir>] [--json]` — exit `0` all probed, `1` at least one probe failed, `3` usage error.

Probes run concurrently with independent cancellation deadlines. `probeTimeoutMs` defaults to
60,000 ms and must be a positive timer-safe integer; `probeConcurrency` defaults to 4 and accepts
1–16. Results retain request order and healthy catalogs when another backend fails. An optional
`signal` shares cancellation across probes, retaining completed catalogs and skipping queued targets.
MCP missing-route diagnostics use a 5,000 ms per-probe bound and concurrency 4. Explicit MCP config requests allow 15,000 ms per probe with a shared 40,000 ms discovery budget inside the 45,000 ms request deadline. Initial and exact-model fallback probes share that budget. Discovery cannot select a route.

`buildHarnessConfigSummary(report)` and `formatHarnessConfigSummary(summary)` expose the compact
view programmatically. `authoringSummary` adds bounded guidance alongside the complete supported
programmatic catalog.
The current model is shown separately as `currentModel`, with `currentRoute` only when it is an
advertised executable leaf; it need not belong to a preference shortlist. `omittedCurrentModel`
reports a value excluded by presentation bounds. Claude and Codex show their small live model
catalogs. Pi's native merged `enabledModels` patterns
produce an ordered preference shortlist intersected with authenticated available models, with
unmatched patterns reported. This is presentation only, never an execution allowlist. Without a
preference list, Pi shows available provider groups. OpenCode shows configured direct-provider models
first, representing each direct provider before filling additional rows when the list is bounded.
Exact provider IDs `openrouter`, `opencode`, `opencode-go`, `huggingface`, `amazon-bedrock`, and
`github-copilot` are classified as aggregators, with browse selectors such as `openrouter/*` and counts. Omitted entries carry counts and expansion guidance.
Browse selectors are not executable models. Expand the full leaf catalog with `modelFilter`
(case-insensitive substring or slash-delimited regex), for example:

```json
{ "action":"config", "harnesses":["opencode"], "modelFilter":"/^openrouter\\//" }
```

Use an exact route such as `opencode/openrouter/openai/gpt-5.6-sol` for execution. Leaf IDs stay
verbatim; do not shorten provider prefixes or infer models from display names. Backend-only probes
report options for the default model only. Probe `modelSpecs:["codex/gpt-5.6-sol"]` (or another exact
returned route) before choosing model-specific mode, effort, or `configOptions`.

**Host-embedded (manager):** long-lived, evented, resumable.

```ts
import { WorkflowManager, createAcpRunner } from "@automatalabs/workflows";

const manager = new WorkflowManager({ cwd: projectRoot, agent: createAcpRunner() });
manager.on("agentEnd", (e) => ui.update(e.runId, e));
manager.on("agentEvent", (e) => ui.stream(e.runId, e));  // live token-level ACP stream (see Events)

const { runId, promise } = manager.startInBackground(script, args, { cwd: worktreePath });
// ... later:
await manager.cancelAgentCall(runId, 7); // settle one in-flight agent null; run stays live
manager.stop(runId);                    // whole-run interruption; the aborted run can resume
```

---

## WorkflowManager

### Constructor — `WorkflowManagerOptions`

| Option | Default | Meaning |
|---|---|---|
| `cwd` | `process.cwd()` | The manager's base directory. Keys run **state/log storage** and is the default run directory when a run passes no `cwd` of its own. |
| `agent` | — | The injected `AgentRunner`. Required here or per-run (`ExecOptions.agent`); the engine never constructs one. |
| `concurrency` | 8 | Max concurrent agents per run. |
| `journaling` | `true` | Default journaling policy. `false` = the host owns transcripts: no run-state/log files, `resume()` rejects, and construction/lazy stale-run reconciliation is skipped entirely. |
| `persistenceRoot` | `AGENTPRISM_PERSISTENCE_ROOT` env, else `~/.agentprism/workflows` | Absolute root for run state/logs. Relative paths throw. |
| `persistence` | filesystem persistence | Custom `RunPersistence` implementation. Omit it for the default `createRunPersistence(cwd, ..., { persistenceRoot })` path. |
| `defaultAgentRetries` | 0 | Retries after *recoverable* agent failures. |
| `mainModel` | — | Session model spec (registered harness prefix + verbatim id, or backend-only name) used to auto-tier explore-style agents. |
| `sessionId` | — | Tag for new runs; `listRuns()` filters by it (`listAllRuns()` doesn't). Update via `setSessionId()`. |
| `agentsDir` | project + user agent dirs | Override the directory scanned for `agentType` definitions. |
| `loadSavedWorkflow` | — | `(name) => script` resolver enabling nested `workflow("name")` in scripts. `openWorkflowDir(dir).resolve` is a ready-made one. |

On construction, a journaling manager attempts the lease for persisted `pending`/`running` rows not
owned in memory. A dead, missing, or corrupt owner lock is replaced; the under-lease reload changes
only a still-`pending`/`running` row to `paused`, with `pauseReason: "interrupted"` and a reason naming
the dead PID when the lock supplied one. A live PID—including `EPERM` from the liveness probe—is
preserved. Cold inspect/list/resume lookups perform the same per-run reconciliation, so a sibling
process that dies after construction does not remain indefinitely `running`. A `journaling: false`
manager never performs these writes.

### <a name="execoptions--per-run"></a>`ExecOptions` — per-run

Passed as the third argument to `startInBackground` / `runSync`, second to `resume`.

| Option | Meaning |
|---|---|
| `cwd` | **This run's working directory**, overriding the manager `cwd` — the natural fit for a worktree-per-run host. Every subagent ACP session runs here (unless worktree isolation or a per-agent `agent({ cwd })` narrows it further). Persisted with the run, so `resume()` re-runs in the *same* directory. Run state stays keyed to the **manager** cwd, so `listRuns()`/`resume()` survive the run directory's deletion. |
| `agent` | Per-run `AgentRunner` override. |
| `signal` / `externalSignal` | Host `AbortSignal` that aborts this run (aliases). |
| `journaling` | Per-run journaling override. |
| `environmentKey` | Host-supplied non-git environment label used for replay provenance diagnostics. It never gates journal replay; git workspaces report measured HEAD + dirty digest instead. |
| `maxAgents` | Cap on total agent calls for the run. |
| `concurrency`, `agentRetries` | Per-run overrides of the manager defaults. |
| `defaultModel` | Host-pinned backend/model for calls with no authored model, agent-definition model, tier, or phase/meta route. It is persisted, passed as the resolved model, and enters call identity. MCP does not automatically select this value. |
| `requireAgentConfiguration` | When true, require a nonblank effective model on every actual call before identity hashing or runner dispatch. A resolved tier or inherited model qualifies; an unresolved tier does not. MCP always enables this; non-strict SDK runners retain their default behavior. |
| `onMissingAgentConfiguration` | Optional `({ label, phase? }) => string \| Promise<string>` diagnostic callback. It can enrich a missing-route error but cannot select a route. Discovery failure does not mask the configuration error. |
| `confirm` | `(promptText, options) => Promise<reply>` — live human channel for `checkpoint()`. A valid explicit answer is journaled; no answer or timeout pauses durably. |
| `resumeFromRunId` | Persisted source ID for a **new** managed execution. Requires journaling, must differ from a caller-supplied new `runId`, and is mutually exclusive with `resumeJournal`. Missing sources fail with `PERSISTENCE_ERROR`. |
| `resumePolicy` | `"auto"` (default) or `"positional"`; requires `resumeFromRunId`. Positional is an index/prefix migration policy, not a bypass for new-format format/metadata/manifest/input checks. |
| `checkpointReplies` | Durable-checkpoint answer channel. With `resumeFromRunId`, keys name call indexes in the **source** run; with same-ID `resume()` they name that persisted run's index. Values must be strict JSON. |
| `onProgress` | Fires with the live `WorkflowSnapshot` on every progress event. |
| `scriptBackends` | APPROVED script-declared custom backends (`meta.backends`). Omitting leaves them inert — approval belongs to the composition root. |
| `script` | Same-run continuation only (`continueRun`/`resume`): the script text read back from the run's file. Identical text continues the persisted script; different text is a revision that must parse and may declare only backends the admission approved. The revision continues through an identity-matched replay of the run's own journal (`continuation.scriptRevised`, `scriptRevisions`); refusals are `script-invalid` and `backends-changed`. |
| `resumeJournal` | Low-level legacy positional channel. Mutually exclusive with `resumeFromRunId`/`resumePolicy`; manual use permanently marks the result legacy. Prefer manager-owned `resumeFromRunId`. |

Agent attempts have no model-facing wall-clock or idle timeout. They remain live until they complete,
fail, or the host explicitly cancels the call or run. Fixed protocol startup, cancellation-grace,
cleanup, lease, and transport bounds remain internal safety controls rather than agent work budgets.
A new resume execution does not inherit operational limits from its source; pass the desired retry,
concurrency, and agent-count values again.

### `CheckpointOptions` — in-script human gates

`checkpoint(promptText, options?)` spends no tokens and journals only an explicit answer.
Options are `kind?: "confirm" | "input" | "select"` (default confirm), `choices?: string[]`,
and `timeoutMs?: number`. Confirm answers are booleans; input answers are strings, including empty;
select answers must be one exact choice. `headless`, `default`, and `pauseOnCheckpoint` are removed.

A live SDK `confirm` callback may collect an explicit answer. Without one, or when it times out or
provides no answer, the run pauses with `reason:"checkpoint_required"` and `checkpointContext`
containing callIndex, hash, prompt, kind, choices, and timeout where authored. Resume supplies
`checkpointReplies:{ [callIndex]: decision }` or a live callback. The first answer is saved under
the run lease before execution continues; repeated answers are idempotent and conflicts cannot
replace it. `false` is an explicit confirm answer, not an automatic abort.

New checkpoint inputs use format 2 and durable decisions carry `checkpointDecision:"explicit-v1"`.
Before continuation or reuse, provenance validation rejects older automatic/ambiguous approvals
and retired pending option shapes. Dry-run simulations are discovery-only and never become live
approval journals. Historical artifacts remain readable where supported without guessed migration.

### Lifecycle

| Method | Returns | Notes |
|---|---|---|
| `startInBackground(script, args?, exec?)` | `{ runId, promise }` | Process-lifetime execution. Returns after lease acquisition and fail-fast initial persistence. A supplied `resumeJournal` is sorted and copied into the child run before that save, so replayed prefixes and synthetic checkpoint answers survive later resume hops under the new run ID. The promise rejects on pause/failure/abort (a side-channel catch prevents host unhandled rejections if ignored). |
| `runSync(script, args?, exec?)` | `Promise<WorkflowRunResult>` | Blocks; always resolves to a **terminal** result (`completed \| paused \| failed \| aborted`) — never throws for ordinary outcomes. |
| `inspectRun(runId, options?)` | `WorkflowRunStatus \| undefined` | Synchronous, live-first safe projection; falls back to project-scoped persistence. A cold `pending`/`running` dead-owner row may be lease-reconciled to `paused` / `interrupted`; other rows are not changed. |
| `reconcileExternallyDeadRun(runId)` | `PersistedRunState \| undefined` | Lease-safe single-run reconciliation used by cold host preflights. Skips manager-owned runs, non-`pending`/`running` states, live owners, and all writes when the manager default is `journaling: false`. |
| `cancelAgentCall(runId, callIndex)` | `Promise<WorkflowAgentCallCancellation>` | Cancels one uniquely matching in-flight attempt, bypasses retries, and resolves after its `AGENT_CANCELLED` call record and `agentEnd` state are durable. The run signal and `abortSignaled` remain untouched. Misses and duplicate scoped indexes throw with the current call-index/label list. |
| `pause(runId)` | `boolean` | Requests a pause of a run this manager is executing: agent calls already executing finish and journal, nothing new is admitted (queued calls settle as interrupted rows), and the run settles as `paused` with `reason: "requested"`. Idempotent while pending; `false` when the run is not running here. |
| `pausePending(runId)` | `boolean` | Whether a pause request is registered for a run this manager is still executing. |
| `stop(runId)` | `boolean` | Whole-run interruption: in-flight work is cancelled and recorded as interrupted rows, and the run settles as `aborted`. The same run ID can `resume()` from its journal, and its retained journal can also seed a new `resumeFromRunId` execution. |
| `resume(runId, exec?)` | `Promise<boolean>` | Same-ID recovery of a paused, failed, or aborted run using historical positional replay; with `exec.script` differing from the persisted text, continues the validated revision instead. Reloads the persisted script/args/cwd, rejects `resumeFromRunId`/`resumePolicy`, emits no resume report, and permanently marks the artifact legacy. Requires journaling. |
| `resumeInBackground(runId, exec?)` | `Promise<{ accepted, promise? }>` | Same-ID `resume()` plus the settlement handle: when accepted, `promise` is the resumed execution's completion promise (same contract as `startInBackground`'s — rejects on failure/pause, side-channel catch attached). The facade manager holds a per-execution `exec.agent` event bridge until it settles. |
| `continueRun(runId, exec?)` | `Promise<WorkflowContinuationStart>` | Strict same-ID continuation used by MCP. Requires a valid versioned canonical admission snapshot, inherits all semantic inputs, accepts runtime controls/checkpoint replies only, and returns a bounded refusal reason instead of guessing missing metadata. |
| `getRun(runId)` | `ManagedRun \| undefined` | Live in-memory state incl. `status`, `snapshot`, `error`. |
| `listRuns()` / `listAllRuns()` | `PersistedRunState[]` | Persisted runs (session-filtered / all); their existing scan lease-reconciles candidate dead-owner rows without a second directory scan. |
| `getPersistedAgentSessions(runId)` | `AgentSessionRecord[] \| undefined` | Cold-restart counterpart of `WorkflowRunResult.agentSessions`: the re-attach records recovered from persisted state (`undefined` = no such run, `[]` = none recorded), ready for `runner.loadSession()`/`resumeSession()` on a fresh manager. |
| `setSessionId(id)`, `setMainModel(spec)` | — | Rebind session tagging / tier fallback. |
| `dispose()` / `close()` | — | Facade manager only: detach its `agentEvent` runner subscriptions. Never disposes the runner itself. |

`WorkflowRunOptions.onTokenUsage` and the manager's `tokenUsage` event are cumulative snapshots.
They fire after every live attempt—including failed retries and pause/failure attempts—using
provider usage when supplied and the existing estimate fallback otherwise. Replayed journal calls
emit/add nothing. The unchanged successful final total is still emitted, so an observer may receive
it twice. The latest snapshot is persisted at journal and settlement points and survives cold load.
If a process dies, stale persisted `pending`/`running` runs recover under their lease to `paused`
with `pauseReason: "interrupted"`; the durable prefix can then seed a new execution. An in-flight
call without a journal result runs again.

Per-call host cancellation is an execution bound, not a replay result. `agent()` receives `null`,
`parallel()` siblings and gates continue normally, and inspect exposes the failed row with
`errorCode: "AGENT_CANCELLED"`. No journal entry is written for that null, so a later resume replays
eligible completed siblings before the cancelled index and executes the cancelled occurrence live.

### Content-addressed incremental resume

`resumeFromRunId` starts a new execution with the caller's current script and args while the
manager owns source loading, admission, candidate persistence, and replay decisions:

```ts
const previous = await manager.runSync(script, { maxRounds: 6 });
const next = await manager.runSync(script, { maxRounds: 8 }, {
  resumeFromRunId: previous.runId,
  resumePolicy: "auto", // default; use "positional" only as a migration escape hatch
});

next.replayEligibility; // bounded admission/progress summary
next.resumeReport;      // per-call correspondence; absent on ordinary/same-ID runs
```

`runDynamicWorkflow(currentScript, { args: currentArgs, exec: { resumeFromRunId } })` exposes the
same manager path for SDK embedding hosts. These fork/replay controls are SDK-only: the MCP tool
neither advertises nor accepts them. On the SDK surface, `resumeFromRunId` must be a non-empty
string; `resumePolicy` must be exactly `"auto" | "positional"`; `checkpointReplies` on a new-run API
requires the source ID; journaling must be enabled; and a caller-minted target `runId` must differ
from the source. Invalid combinations fail before target creation. The manager holds the source's cross-process lease
through validation/cloning and the target's critical initial seed save, then releases it before
execution or background acknowledgement. Every candidate removal/selection is likewise durably
committed before the script can observe a replayed result or live delegation.

Pause recovery has a second, independent channel for the interrupted live call. For a source paused
on `usage_limit` or `auth_required`, the manager joins the root error call record to its coherent
error agent/session row by call index and builds `PreparedContinuation`. At the live boundary,
attempt one reattaches only when index, identity hash, complete execution-input fingerprint, cwd
equality/existence, non-worktree isolation, and the runner's backend/`poolKey`/current reopen gates
all pass. The source call's persisted input-fingerprint format selects the comparison algorithm, so
format-1 paused runs compare against the equivalent legacy fingerprint while current runs use format
2; unsupported formats and genuine semantic input changes still fail to fresh. Each rejected gate
emits a `kind: "continuation"` skip notice and runs fresh; successful
resume/load emits a reattached notice and a diagnostic journal marker. This works for identity,
positional, and all-live correspondence strategies and for same-ID recovery, which has no
`PreparedResume`. Candidate consumption is per execution: several new-run targets may independently
reattach the same still-paused source, while nested workflows receive no candidate channel.

Manager-prepared identity and positional hits re-journal the selected value under the target run's
current index and emit the fresh call record/provenance; the source artifact is never mutated.
Same-ID/manual legacy replay retains the historical seeded-prefix behavior: cached calls republish
execution observations and a call record but do not emit a cached journal callback. This keeps the
durable run-event ordering contract scoped to its existing recovery path while new-run artifacts
become self-contained at their current indexes.

The public correspondence types are exported by `@automatalabs/shared-types`,
`@automatalabs/workflow-engine`, and the `@automatalabs/workflows` facade:

```ts
type ResumePolicy = "auto" | "positional";
type WorkflowResumeStrategy = "identity-v1" | "positional-v1" | "live";
type WorkflowResumeMatch = "path-hash" | "unique-hash" | "index-hash";
type WorkflowResumeSafety = "declared-read-only" | "isolated-worktree"; // legacy diagnostics only

type WorkflowResumeCallDecision =
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "replayed";
      sourceRunId: string;
      recordedIndex: number;
      match: WorkflowResumeMatch;
      checkpointInjected?: true;
    }
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "live";
      reason: WorkflowResumeCallLiveReason;
    }
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "failed";
      reason: WorkflowResumeCallFailedReason;
    };

interface WorkflowResumeReportBase {
  sourceRunId: string;
  requestedPolicy: ResumePolicy;
  replayed: number;
  live: number;
  failed: number;
  calls: WorkflowResumeCallDecision[]; // current root indexes, ascending
}

type WorkflowResumeReport = WorkflowResumeReportBase &
  (
    | { strategy: "identity-v1" }
    | {
        strategy: "positional-v1";
        fallbackReason: WorkflowResumeFallbackReason;
        eligibility: "legacy" | "safe-prefix" | "all-live";
      }
    | { strategy: "live"; disabledReason: WorkflowResumeDisabledReason }
  );

interface WorkflowReplayOperationalChange {
  option: "agentRetries" | "concurrency";
  source: number | null;
  current: number | null;
  detail: string;
}

interface WorkflowReplayEligibilityBase {
  sourceRunId: string;
  predictedReplayablePrefix: number;
  replayedPrefix: number;
  replayed: number;
  live: number;
  failed: number;
  firstNonReplay?: {
    index: number;
    action: "live" | "failed";
    reason:
      | WorkflowResumeCallLiveReason
      | WorkflowResumeCallFailedReason
      | WorkflowResumeDisabledReason
      | WorkflowResumeFallbackReason;
    detail?: string;
  };
  sourceEngineVersion?: string;
  currentEngineVersion: string;
  engineVersionComparison: "same" | "different" | "source-unknown";
  sourceInputsFormat?: number;
  currentInputsFormat: number;
  operationalChanges: WorkflowReplayOperationalChange[];
}

type WorkflowReplayEligibility = WorkflowReplayEligibilityBase &
  (
    | { strategy: "identity-v1" }
    | {
        strategy: "positional-v1";
        fallbackReason: WorkflowResumeFallbackReason;
        eligibility: "legacy" | "safe-prefix" | "all-live";
      }
    | { strategy: "live"; disabledReason: WorkflowResumeDisabledReason }
  );
```

`WorkflowRunResult.resumeReport?` and persisted state carry this report for completed, paused, and
failed resumed runs; ordinary and same-ID recovery runs omit it. `replayEligibility` is the bounded
plan/progress surface for every SDK new-run resume. SDK results retain the final report and
human-readable strategy, prefixes, counts, first non-replay detail, source/current formats, and
non-gating operational changes. A zero predicted or observed prefix is prefixed with `WARNING`.
MCP exposes same-ID continuation and its generation metadata; it does not accept new-run replay
policy inputs or project SDK replay reports into its lifecycle acknowledgements.

#### Identity, correspondence, and world neutrality

Every completed agent result participates in non-contiguous reuse without an author annotation:

```js
const findings = await parallel([
  () => agent("Audit src/api without changing files.", {
    label: "audit:api",
  }),
  () => agent("Try the fix in isolation; return a unified diff.", {
    label: "try:worker",
    isolation: "worktree",
  }),
]);
```

The legacy `resume: { filesystem: "read-only" }` option remains accepted so old scripts and
journals load. It is recorded only as diagnostic provenance, never reaches `AgentRunner`, changes
neither call-hash nor input-fingerprint bytes, and has no effect on admission or matching. New
scripts should omit it. Reader, writer, worktree, and unannotated calls all follow the same journal
correspondence rule.

An agent call's identity hash covers prompt, resolved model, authored mode/config options/tier,
phase, agent type and resolved definition, and schema. Its separate input fingerprint covers the
resolved label, per-call cwd, resolved isolation, `keepSession`, images, MCP servers, metadata,
prompt metadata, and the approved script-backend digest. Host `agentRetries` and
`concurrency`, plus per-call `retries`, are operational bounds and enter neither
hash. They may change on a new-run resume or an interrupted-turn continuation without rejecting an
otherwise matching call.

Identity matching first considers the original exact group `(kind, call path, identity hash)`. One
candidate with an equal input fingerprint replays as `"path-hash"`; duplicates are permanently
ambiguous. With no exact candidate, exactly one original `(kind, identity hash, inputsHash)` row
may move after an insertion/deletion and replay as `"unique-hash"`. Missing/different inputs,
duplicate content, consumed candidates, or empty schema-less output run live. The
matcher never pairs by occurrence ordinal/source order and never uses isolation's path-only
fallback. Stable explicit labels matter because runner-visible label changes alter `inputsHash`.

Before any new-format journal is considered, admission requires a terminal (completed, failed,
paused, or aborted), non-isolation source; exact `effectiveCwd`; exact call-path and checkpoint-input formats; a
compatible agent-input format; and complete journal/call/allocation metadata with a valid
manifest and seed. These are journal-integrity and execution-correspondence checks. Git HEAD/dirty
digest, `environmentKey`, captured start/terminal environment values, Node/V8, and producing engine
version are diagnostics only. Provenance compares the recorded terminal environment (or start
environment when no terminal capture exists) with the current environment. Differences may appear
in `replayEligibility.provenanceChanges`; none disables replay or changes a per-call decision.

The terminal manifest is dense even when a pause or halt catches allocated calls in flight. Those
occurrences carry `outcome: "error"`, `origin: "engine"`, and no journal result, so they execute
live on resume. Non-result agent rows remain in the identity seed as non-replayable
blockers until their occurrence is reached. A blocker participates in exact/content ambiguity but
can never return a value; this preserves alignment while allowing completed calls after a gap to
replay.

A current-format crash snapshot reconciled to `paused` / `interrupted` uses its valid identity
manifest even though it has no quiescent terminal-environment capture. Input formats below 2 take
the input-format positional compatibility bridge; a format greater than the current format is
`runtime-mismatch`. The run-ID lease protects run persistence, not the workspace. The engine does
not attempt to restore or judge filesystem state: replayed writers do not recreate their writes,
and later live agents navigate the world they actually encounter.

Automatic policy selects:

- `"positional-v1"` / `"legacy"` with `fallbackReason: "inputs-format-legacy"` for a marked source
  whose input-fingerprint format is below 2 and whose other structural admission facts agree;
- `"identity-v1"` for a current-format source with a valid represented call manifest and seed,
  including current-format crash snapshots without terminal-environment capture, unannotated
  agents, explicit-answer checkpoints, nested workflows, and source-world drift;
- `"positional-v1"` / `"safe-prefix"` when explicitly requested or when a structurally valid
  source cannot represent every non-result occurrence in the identity seed;
- `"live"` for an invalid or unsupported new-format source, including missing metadata,
  incompatible format literals, and invalid manifest/seed state.

Identity decisions are independent per recorded occurrence. A changed call runs live without
clearing unmatched candidates, so matching calls later in source order, after a live writer, or on
the other side of a nested workflow can still replay. This remains true when a worktree degrades or
a live host checkpoint callback runs. The engine never uses ambient/world effects as an implicit
dependency graph.

Identity replays are free: current `tokenUsage` and provider cost remain zero. Historical
`tokenBudget`, `budgetDebit`, and `logicalBudgetDebit` properties are ignored when old persisted
runs are read and are never copied into new call records, resume provenance, or reports. Replayed
agent sessions open no new session: their record keeps source session/backend/cwd/reopen fields and rebinds only the current
call index, label, and phase. Completed checkpoint decisions use the same identity rules plus an
equal format-2 checkpoint inputs and `explicit-v1` provenance. Automatic or ambiguous historical
answers fail before reuse; only explicit live, journal-replay, and injected decisions are supported.
New-run `checkpointReplies` keys name source indexes. A reply may follow a uniquely moved checkpoint
while earlier correspondence remains intact; after a prior live divergence it must reach the exact
recorded path, preventing a different same-text branch from consuming the human decision.

#### Positional and legacy compatibility

`resumePolicy: "positional"` requests the index/hash prefix matcher, but a new-format source still
must pass cwd, format, metadata, manifest, and seed admission plus per-call input agreement. There
is no force-identity option. Marker-less recordings and permanent `legacyResume`
artifacts use historical hash-only positional matching because their newer facts do not exist.
Manual `resumeJournal` and same-ID `resume()`/`resumeInBackground()` always enter that legacy arm
and cannot be laundered into an identity-capable hop. Aborted or `abortSignaled` sources are never
served from this arm.

Format-1 fingerprints are never reinterpreted as format 2. A marker-less ≤0.23 crash remains
`legacy-recording`; a marked format-1 source takes `inputs-format-legacy`; and a valid format-2
source, including crash residue, may take identity replay. The
`inputs-format-legacy` bridge uses
the established hash-only index/prefix matcher, and every selected row is re-journaled under the
target's format 2 runtime so its next hop can use identity matching. Positional new-run preparation
accepts a journal/call row only when its scope is absent, equals the immediate source ID, or names a
run still persisted in the same run directory. This recovers carried prefixes from ≤0.23 chained
resumes while excluding engine-minted `-nested<N>` scopes and scopes for deleted ancestors. A
paused positional terminal save retains only inherited source rows the current execution visited,
so an unvisited tail runs live on the next hop.

An all-live outcome is normal when correspondence cannot be established, not when the world
changed. Missing resume metadata, incompatible format literals, or invalid manifest/seed state can
disable new-format replay. If any result row lacks a path/input fact—possible when a deep call stack
passes the raw-frame cap or an agent `meta` value is not strict JSON—the source is
`"manifest-invalid"`; ignoring that row could make an ambiguous sibling look unique. Format-1
sources use the input-format positional bridge, while a format greater than the current format is
`"runtime-mismatch"`. Filesystem/environment, Node/V8, and engine-version differences are
diagnostics only.

#### Frozen resume reason catalogs

The runtime arrays below are exported by `@automatalabs/workflow-engine` and re-exported by the
facade. Their literal unions live in `@automatalabs/shared-types`:

- `RESUME_FALLBACK_REASONS`: `legacy-recording`, `crash-residue`, `inputs-format-legacy`, `forced-positional`,
  `unsafe-recording`, `nested-workflows`, `legacy-resume`.
- `RESUME_DISABLED_REASONS`: `unsupported-format`, `source-not-terminal`, `abort-residue`,
  `isolation-recording`, `resume-metadata-missing`, `manifest-invalid`, `cwd-mismatch`,
  `runtime-mismatch`, `environment-missing`, `environment-mismatch`,
  `source-environment-drift`, `resume-seed-invalid`.
- `RESUME_CALL_LIVE_REASONS`: `strategy-live`, `positional-miss`, `positional-suffix`,
  `not-recorded`, `path-missing`, `inputs-missing`, `inputs-changed`, `ambiguous-identity`,
  `ambiguous-content`, `candidate-consumed`, `empty-output`, `safety-changed`, `unsafe-suffix`,
  `worktree-degraded`.
- `RESUME_CALL_FAILED_REASONS`: `seed-persistence-error`, `resume-fatal-latch`.

The catalogs are wire-compatible with existing journals and consumers. World/safety-era literals
such as `crash-residue`, `unsafe-recording`, `nested-workflows`,
`source-environment-drift`, `safety-changed`, and `unsafe-suffix` remain parseable but are not
world-state gates in the current automatic contract. `abort-residue` likewise remains a readable
historical diagnostic; current new-run replay does not disable a source merely because its terminal
status or persisted marker is aborted.

Every branch follows fail-to-live: the report explains why a call ran or why resume was disabled;
no reason authorizes a possibly stale value.

### Run inspection and terminal log tails

`WorkflowRunInspectionOptions` has `lastN?` (default 20, integer 1–50), `logLines?` (default
20, integer 0–50), and `labelGlob?` (non-empty, at most 128 Unicode code points). The glob is
case-sensitive and matches the entire raw agent label: `*` matches zero or more Unicode code
points, `?` one, and backslash escapes the next character; a trailing backslash is literal.
Checkpoints and unknown legacy entries do not match a label glob. Filtering precedes latest-N
selection and selected calls return in ascending deterministic index order.

While a run is pending/running, agents currently in flight are projected as calls with
`status: "queued" | "running"` and a `null` result preview; once a call settles its row comes from
the journal and omits `status`. Terminal and paused runs never project in-flight rows — persisted
agent rows that still read "running" on a dead run are stale, not active calls.

```ts
interface WorkflowLogTail {
  lines: string[];
  totalLines: number;
  omittedLines: number;
  truncatedLines: number;
  redactedLines: number;
}

interface WorkflowRunCallStatus {
  index: number;
  kind: "agent" | "checkpoint" | "unknown";
  label?: string;
  phase?: string;
  model?: string;
  backendId?: string;
  errorCode?: WorkflowErrorCode;
  /** Present only while the call is in flight on a live run; settled calls omit it. */
  status?: "queued" | "running";
  resultPreview: string;
  resultRedacted: boolean;
  resultTruncated: boolean;
}

interface WorkflowRunStatus {
  runId: string;
  status: RunStatus;
  workflowName: string;
  phases: string[];
  currentPhase?: string;
  reason?: string;
  errorCode?: WorkflowErrorCode;
  limits?: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
  logTail: WorkflowLogTail;
  calls: WorkflowRunCallStatus[];
  filter: { lastN: number; logLines: number; labelGlob?: string };
  truncation: WorkflowRunStatusTruncation;
}

interface WorkflowRunLimits {
  maxAgents: number;
  concurrency: number;
  agentRetries: number;
}
```

`WorkflowRunStatusTruncation` reports the fixed `maxStructuredBytes` (24,576), whether the byte
cap removed data, phase total/returned/shortened counts, log total/returned/shortened/redacted
counts, and call total/matched/returned/shortened-result/redacted-result counts. Inspection keeps
at most 64 phase titles and enforces the cap by removing oldest calls, then oldest log lines, then
oldest phases. Every outward text scalar and compact JSON result preview is redacted and capped at
512 UTF-8 bytes. Result compaction keeps depth four, the first ten array items, and first twenty
object keys. Sensitive keys and PEM/auth/URL/JWT/assignment/known-prefix/opaque-token credential
patterns are redacted. There is no raw mode: scripts, args, prompts, histories, journal hashes,
session IDs, cwd, checkpoint prompt/choices, auth context, and raw results are never projected.

`JournalEntry.call?: JournalCallMetadata` adds replay-neutral attribution. Agent metadata contains
`{ kind:"agent", label, phase?, model?, backendId? }`; checkpoint metadata contains
`{ kind:"checkpoint", label:"checkpoint", phase? }`. It never participates in hashes or replay.
Legacy entries remain valid; inspection derives old agent label/phase/backend only from a present
session record, otherwise reports `kind:"unknown"`.

Paused, failed, and aborted `WorkflowRunResult`s carry a `logTail` containing the redacted final 20
snapshot logs, present even when empty. Completed results omit it. The existing full `logs` array
is unchanged.

Terminal run results also expose two replay-neutral audit fields, both absent when empty:

- `fallbacks?: WorkflowRunFallback[]` is retained for compatibility as
  `{ callIndex, label, phase?, requestedSpec, resolvedModel?, backendId?, kind: "model" | "modifier" | "continuation", message, continuation? }`; model resolution no longer emits entries because harness errors propagate. A continuation entry reports `{ outcome: "reattached", method: "resume" | "load" }` or `{ outcome: "skipped", reason }`.
  `message` is the same human-readable line written to the run log. Exact repeats within one call
  are deduplicated; replayed agent calls do not create entries.
- `checkpointsTaken?: WorkflowCheckpointTaken[]` records each checkpoint that resolved in this
  execution as `{ callIndex, kind, decision, source }`. Source is `"live"`,
  `"journal-replay"`, or `"injected"` (an indexed `checkpointReplies` answer). A checkpoint that
  paused is not resolved and therefore is not listed.

Both arrays persist on `PersistedRunState` for cold terminal reads. Neither enters call hashes, and
neither is added to the bounded `WorkflowRunStatus` inspection shape.

A run that hits a provider usage/quota wall (`PROVIDER_USAGE_LIMIT`) is **paused**, not failed — the journal checkpoints and the interrupted session is kept reopenable (`resetHint` is synthesized as `Resets at <RFC 3339 instant>` when structured provider reset metadata is present). On resume, an unchanged root occurrence with the same identity/input fingerprint/backend/cwd continues that session; a failed eligibility or reopen gate runs it fresh.

A run that hits `AUTH_REQUIRED` is likewise **paused** (`reason: "auth_required"`), not failed: the journal checkpoints, keeps the interrupted session reopenable, and persists the structured, non-secret `authContext` (`backendId` + advertised method `{ id, type, name }[]` — never credential material). `resume()` re-arms against the runner: for an `"auth_required"` pause it consults `runner.auth.canResume(backendId)` before the continuation candidate can be consumed. When the credential survived (warm resume in the same process, or a disk-backed method a fresh process re-reads from the native store/env) it proceeds and attempts session continuation; when an in-process (gateway) or spawn-env intent was lost to a cold process it **immediately re-pauses** with `re-supply credentials for <backend> via runner auth before resuming`. A runner with no `auth` controller (the default-off host) cannot confirm resumability and re-pauses.

An unanswered checkpoint is the third persisted pause class. Without an explicit answer,
the run pauses with `reason:"checkpoint_required"` and non-secret `checkpointContext`.
`resume()` accepts `ExecOptions.checkpointReplies` and writes the reply into the journal under the
run lease before continuation. With neither an indexed answer nor a live callback, it returns the
same pause immediately without executing script or agent calls.

### Events

`WorkflowManager` remains a Node `EventEmitter`, but its named methods have typed overloads. Import
the dependency-neutral engine contract from `@automatalabs/shared-types`, the persistence seam from
`@automatalabs/workflow-engine`, or both plus the exact ACP specialization from the SDK facade:

```ts
import type {
  EngineRunEvent,
  EngineRunEventPayloadMap,
  RunEvent,
} from "@automatalabs/shared-types";
import type { RunEventLogRecord, RunEventPersistence } from "@automatalabs/workflow-engine";
import type {
  WorkflowAgentEvent,
  WorkflowAgentEventPayloadMap,
  WorkflowRunEvent,
} from "@automatalabs/workflows";
```

`EngineRunEventPayloadMap["agentEnd"]`, for example, is the payload inferred by
`manager.on("agentEnd", listener)`. `EngineRunEvent` is the exact engine-manager union;
`RunEvent` adds a dependency-neutral generic `agentEvent` branch; and `WorkflowRunEvent` binds that
branch to `AcpRunnerEventMap`. Every engine payload carries `{ runId, scope }`: `runId` owns the
snapshot and sidecar, while `scope` identifies the root or inline nested engine invocation that
originated the observation. Root events use `scope === runId`; an inline child uses its
`${runId}-nested<ordinal>` scope but still writes the parent's sidecar. Use `(scope, callIndex)` as
the logical call key. Listeners are observability-only: a throwing listener is isolated and never
affects the run.

| Event | Main live payload fields beyond `runId` and `scope` |
|---|---|
| `log` | `message` |
| `phase` | `title` |
| `agentStart` | `label`, `phase?`, `prompt`, `model?`, `configOptions?`, `callIndex` |
| `agentEnd` | `label`, `phase?`, `result`, `callIndex`, usage/model/backend/provenance fields, optional error fields |
| `agentHistory` | `label`, `phase?`, `history`, `callIndex` |
| `agentProgress` | `label`, `phase?`, `callIndex`, `executionStartSeq`, `turnCount`, `observedEvents`, `coalescedEvents`, `cause`, exactly one of `latestText` / `lastToolName`, optional `tokensObserved` |
| `agentTranscript` | `label`, `phase?`, `callIndex`, `executionStartSeq`, dense `entryIndex` / `revision`, `operation: "upsert"`, assistant-text or tool-call `entry` |
| `journal` | `entry` (`JournalEntry`) — live journal append observations, including when file journaling is disabled |
| `callRecord` | `record` (`WorkflowCallRecord`), including terminal non-journal exits |
| `tokenUsage` | `usage` (cumulative input/output/total/cost/cache) |
| `complete` | `result` (the composed `WorkflowRunResult`) |
| `paused` | manual pause, or `reason` plus `error`/`errorRecord` and the applicable reset/auth/checkpoint context |
| `stopped` / `resumed` | origin only |
| `error` | `error` plus strict-JSON `errorRecord`; named delivery remains listener-gated |
| `agentEvent` | The SDK's live ACP stream (see below) |

Calling public `manager.emit()` is still a raw EventEmitter operation: it does not update managed
state, assign a sequence, or persist a record. Only manager-owned publication sites enter the
durable stream.

### Durable run-event log

For journaling runs, `WorkflowManager.getPersistence()` and `createRunPersistence()` return the
additive `RunEventPersistence` subtype. The live and persisted policies are fixed in v1:

| Event type | Live named emitter | Persisted by default | Reason |
|---|---:|---:|---|
| `log` | yes | yes | Run narrative and warnings |
| `phase` | yes | yes | Lifecycle/progress boundary |
| `agentStart` | yes | yes | Lifecycle/progress boundary |
| `agentEnd` | yes | yes | Lifecycle/progress boundary and terminal call summary |
| `agentHistory` | yes | no | Transcript-like, content-heavy duplicate |
| `agentProgress` | yes | yes | Redacted, bounded, content-bearing in-flight sample or heartbeat |
| `agentTranscript` | yes | yes | Redacted, bounded in-flight assistant/tool upsert |
| `tokenUsage` | yes | yes | Bounded cumulative usage/cost snapshot |
| `complete` | yes | yes | Root terminal lifecycle |
| `journal` | listener-gated | yes | Deterministic call-result lifecycle |
| `callRecord` | listener-gated | yes | Terminal call structure, including non-journal exits |
| `paused` | yes | yes | Root terminal/resumable lifecycle |
| `error` | listener-gated | yes while lease-owned, even without listeners | Root failure lifecycle |
| `stopped` | yes | yes | Host-requested lifecycle transition |
| `resumed` | yes | yes | Same-run lifecycle transition |
| `agentEvent` | yes, on the SDK manager | no | Verbatim high-frequency ACP stream; host-owned transcript concern |

`journaling: false` disables the snapshot, watermark, sidecar, progress sampler, and transcript
upserts but leaves the raw `agentEvent` and established lifecycle events unchanged. Journaling runs
enable progress and transcript persistence by default; there is no observability flag or backend
allowlist. ACP-capable runners supply real content, while custom runners without a live event bus do
not receive fabricated activity.

`agentProgress` is emitted immediately on the first projectable assistant/tool activity, at most
once per 1,000 ms for later activity, and every 15,000 ms as a heartbeat after content has appeared.
Every record contains real projected content; counts-only heartbeats are forbidden. Final pending
state is flushed before `agentEnd`. `agentTranscript` uses upserts partitioned by
`(scope, callIndex, executionStartSeq)`: retain the greatest revision for each `entryIndex`, render
indexes ascending, and start a fresh partition when same-ID resume opens a new `agentStart` sequence.
If a process dies before the prior `agentEnd`, that later start supersedes the dangling active
execution for validation; the abandoned partition stays readable, while every resumed upsert and
progress sample references the later start's `seq`.
Assistant text is a rolling newest-512-byte Unicode-safe window; tool rows retain projected title
and normalized tool name. Terminal run-JSON `history` and live-only `agentHistory` are unchanged.

The default layout is one generation-pinned sidecar beside the existing files:

```text
<runsDir>/<runId>.json          # atomic resumable snapshot
<runsDir>/<runId>.json.bak      # best-effort snapshot backup
<runsDir>/<runId>.log           # existing unstructured engine log
<runsDir>/<runId>.events.jsonl  # versioned, append-only event records
```

Each LF-terminated line is a `RunEventLogRecord` with `version`, `streamId`, dense positive `seq`,
an ISO timestamp, a bounded `PersistedRunEvent`, and aggregate projection flags. Ordering is by
sequence, never timestamp. `PersistedRunState.eventStreamId` identifies the generation and
`eventSeq` is the snapshot watermark. A delete/recreate of the same `runId` mints another stream
ID, so every continuation must carry the stream ID returned by its snapshot/prior read.

The safe consumption pattern is snapshot plus tail:

```ts
const persistence: RunEventPersistence = manager.getPersistence();
const snapshot = persistence.load(runId);

if (!snapshot?.eventStreamId || snapshot.eventSeq === undefined) {
  // Legacy runs have no gap-free event tail; use inspectRun() explicitly.
  const legacy = manager.inspectRun(runId);
  consumeLegacyStatus(legacy);
} else {
  const page = persistence.readEvents(runId, {
    streamId: snapshot.eventStreamId,
    after: snapshot.eventSeq,
    limit: 100,
  });
  consume(snapshot, page.events);

  const tail = persistence.watchEvents(runId, {
    streamId: page.streamId,
    after: page.cursor,
    signal: abortController.signal,
  });
  for await (const record of tail) consumeEvent(record);
}
```

`readEvents()` defaults to `after: 0, limit: 100`, caps `limit` at 1000, and returns
`{ events, streamId, cursor, endCursor, hasMore }`. `watchEvents()` validates synchronously, yields
backlog first, then follows appends as a pull-based `RunEventStream`; abort/`close()`/`return()` end
normally. Watchers stay open across lifecycle events because the same run may resume. They fail
closed on deletion, generation replacement, corruption, or inconsistency instead of following a
different stream.

#### MCP script file resource

Every admitted run exposes its script as a `file://` resource: the store copy `{runId}.script.js`
written next to the run record for an inline script, or the caller's own `scriptPath` file. Run,
resume, status, and outcome responses name it as `scriptUri` and `scriptPath`, and `resources/list`
enumerates one entry per persisted run. Reads return the file's current UTF-8 text with MIME type
`text/javascript`, so an edit made after admission is visible immediately; the admitted text that
executes is kept in the run record. Only a file some persisted run recorded is addressable: any other
`file://` URI, including an unowned file inside the store, is rejected. Deleting a run removes its
store copy; a caller's `scriptPath` file is never modified or removed.

#### MCP exact workflow result resource

For every completed run with a persisted authored JSON value, the MCP server exposes
`workflow://runs/{runId}/result` with MIME type `application/json`. The resource text is the exact
`JSON.stringify` representation of the authoritative persisted value. It is immutable, survives MCP
server restart, has no server-side envelope cap, and remains readable until run deletion, corruption,
or store loss. Running, paused, failed, aborted, unknown, deleted, and completed-without-value runs
fail closed instead of manufacturing output.

Completed status responses expose `resultUri` and a separately labelled
result `resource_link`; script links are explicitly labelled as scripts. Every admitted durable-log
run and every later status/terminal response exposes `eventsUri` and a separately labelled events
`resource_link`. Foreground and status also
copy exact result JSON up to 4,096 UTF-8 bytes into text for content-first hosts. For larger values,
use the resource directly or page through `{ action:"result", runId, offset, maxBytes }`. The page is
`{ action:"result", runId, status:"completed", resultUri, mimeType:"application/json",
encoding:"utf-8", totalBytes, offset, endOffset, hasMore, chunk }`; `maxBytes` defaults to and is
capped at 16,384. Concatenate chunks and continue at `endOffset`. Page boundaries never split a UTF-8
code point; arbitrary interior offsets are invalid.

The events resource below remains bounded/redacted observability. Its projections are not an exact
result-reconstruction contract.

#### MCP live events resource

The MCP server exposes the same projected log at `workflow://runs/{runId}/events` with MIME type
`application/json`. Admitted run responses return this canonical `eventsUri`; status, stop,
permission-response, terminal outcome, and result retrieval repeat it whenever the durable stream
exists. Subscribe to the canonical URI, treat `notifications/resources/updated` as an
advisory hint, then read cursor pages until `hasMore` is false:

```ts
const canonical = `workflow://runs/${runId}/events`;
await client.subscribeResource({ uri: canonical });
const tail = JSON.parse(resourceText(await client.readResource({ uri: canonical })));
let cursor = tail.cursor;
const streamId = tail.streamId;

client.setNotificationHandler(ResourceUpdatedNotificationSchema, async ({ params }) => {
  if (params.uri !== canonical) return;
  do {
    const uri = `${canonical}?after=${cursor}&limit=1000&streamId=${streamId}`;
    const page = JSON.parse(resourceText(await client.readResource({ uri })));
    for (const record of page.events) reduceTranscriptOrProgress(record);
    cursor = page.cursor;
    if (!page.hasMore) break;
  } while (true);
});
```

The document is `{ schemaVersion:1, runId, streamId, status, finalized, after, cursor,
endCursor, hasMore, events }`. A canonical read returns the latest 100 records. Query reads require
the current 32-hex `streamId`; `after` defaults to 0, `limit` defaults to 100 and accepts 1–1000.
Only the canonical URI is subscribable. At most one notification promise per URI is in flight;
additional appends collapse into one dirty bit, so a slow or absent client cannot queue events or
delay execution. Recovery always pages the durable JSONL stream from the client's last cursor.

Malformed/unknown/unavailable/cursor/generation request errors are MCP `-32602`. Corrupt,
incomplete, unsupported, oversized, projection, sequence, snapshot-ahead, and I/O failures are
`-32603`; error messages contain only the normalized URI/run ID and stable event-log error code.
Watcher failure sends one advisory hint and re-arms only after a successful subscribed-resource read
or duplicate subscribe. Run deletion and connection close remove watchers and scheduler state.

#### Event-log errors and remedies

Every read/watch/append persistence failure is `RunEventLogError` with a typed `code`, raw API
`runId`, optional offending `seq`/absolute `path`, and no raw line or event content in its message.

| `RunEventLogErrorCode` | Meaning and host remedy |
|---|---|
| `RUN_NOT_FOUND` | Neither current snapshot nor sidecar exists. Treat the ID as unknown and re-list runs. |
| `EVENT_LOG_UNAVAILABLE` | The snapshot predates this contract. Fall back explicitly to `inspectRun()`; do not claim a gap-free tail. |
| `INVALID_CURSOR` | `after` is not a non-negative safe integer. Correct the caller input. |
| `INVALID_LIMIT` | `limit` is not an integer in 1–1000. Correct the caller input. |
| `INVALID_STREAM_ID` | The supplied generation is not 32 lowercase hexadecimal characters. Correct the caller input. |
| `CURSOR_AHEAD` | `after` is beyond the valid log tail. Reload the snapshot/current stream and start a new cursor lineage. |
| `ORPHANED_LOG` | A sidecar exists without a loadable snapshot. Do not consume it as resumable state; surface or clean it under the run lease. |
| `WATERMARK_MISSING` | A sidecar is paired with a snapshot that has no `eventSeq`, usually after a downgrade write. Fall back/surface the incompatible pair. |
| `STREAM_ID_MISSING` | A watermarked snapshot has no valid generation ID. Fall back/surface the incompatible pair. |
| `STREAM_MISMATCH` | The supplied cursor, snapshot, and/or records belong to different generations. Stop that cursor and reload the current run; never splice generations. |
| `CORRUPT_LOG` | A terminated record is malformed or violates the v1 shape/dense sequence/run-ID rules. Stop tailing and surface the integrity failure. |
| `UNSUPPORTED_VERSION` | A record version is unknown to this reader. Upgrade the reader; never guess the schema. |
| `SNAPSHOT_AHEAD` | The snapshot watermark exceeds the valid log tail. Use snapshot/journal recovery or bounded inspection and surface the inconsistent observability stream. |
| `EVENT_LOG_INCOMPLETE` | The writer recorded an append/projection failure. Resume may still use the snapshot, but consumers must fall back explicitly instead of presenting a gap-free tail. |
| `SEQUENCE_MISMATCH` | A writer proposed anything other than the next dense sequence. Revalidate the tail while holding the lease and fix the writer; readers should surface it as internal failure. |
| `PROJECTION_ERROR` | Projection of an otherwise admitted live event threw. The manager marks the log incomplete; custom writers should preserve the cause and stop appending. |
| `RECORD_TOO_LARGE` | A terminated/projected line exceeds 65,536 UTF-8 bytes including LF. The manager marks the log incomplete; do not silently reshape or skip it. |
| `IO_ERROR` | A non-ENOENT filesystem/open/write/close/watch failure occurred. Preserve the cause, repair the filesystem condition, and fall back explicitly while the tail is unavailable. |

#### Redaction, durability, retention, and deletion

Persistence projects synchronously before append; readers have no raw mode. Typed strings are
credential-redacted and capped at 512 UTF-8 bytes. Unbounded values become compact JSON previews
(depth 4, first 10 array items, first 20 object keys, sensitive-key replacement, 512-byte cap).
Config options, auth methods, checkpoint choices, and model fallbacks are capped at 20 entries;
session re-attach records, raw runtime errors/stacks, complete-result logs/call arrays, and verbatim
ACP payloads never enter the sidecar. Each complete line is capped at 65,536 bytes including LF.
There is no total-size cap, rotation, compression, prefix deletion, or TTL in v1: history is kept as
long as the run record.

Exactly one writer per run is a precondition. `WorkflowManager` enforces it with the cross-process
run lease; direct/custom `appendEvent()`, `save()`, or `delete()` callers must hold the same lease or
equivalent exclusion. The writer commits the full record before advancing the snapshot watermark,
and durable append succeeds before the corresponding named listener runs. A failed append leaves
the last sequence unchanged, marks `eventLogIncomplete`, disables later appends for that run, and
does not change the workflow's computational result.

`WorkflowManager.deleteRun(runId)` keeps or reacquires the lease, removes the event sidecar first,
delegates snapshot/backup/temp deletion next, and lets the default persistence remove the lock last;
lease release occurs in `finally`. It returns the underlying snapshot-delete boolean. If lease
acquisition fails it returns `false` without deleting anything. Detached callbacks from a deleted
managed execution may retain their legacy live delivery, but can no longer recreate durable state.

### `agentEvent` — live token-level streaming through the manager

The `WorkflowManager` exported by **`@automatalabs/workflows`** (the facade — not the bare engine class) adds one composition-root bridge: when the injected `AgentRunner` also exposes the acp-agents `.on()` bus (`createAcpRunner()` does), the manager forwards that runner's **entire live ACP stream** as `agentEvent`. This is how a host renders message chunks, tool calls, and plans as they happen without holding a separate runner reference.

```ts
manager.on("agentEvent", (e: AgentEventPayload) => {
  if (e.name === "agent_message_chunk" && e.scope && e.callIndex !== undefined) {
    ui.stream(e.scope, e.callIndex, e.event);
  }
});
```

Exact new consumers use `WorkflowAgentEventPayload<K>`; the existing
`AgentEventPayload<K extends AcpEventName = AcpEventName>` alias remains source-compatible,
including its type-only `session_update` branch. The emitted envelope is
`{ name, event, backendId, sessionId?, label?, runId?, scope?, callIndex? }` —

- `name` is the ACP event name. `session/update` notifications arrive **unwrapped** as their `sessionUpdate` discriminant (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …); the cross-cutting events (`permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `session_open`, `session_close`, `backend_error`) arrive under their own names.
- `event` is the **verbatim** runner payload for that event (typed per `name`).
- The envelope repeats the context fields hosts filter on: `(scope, callIndex)` directly identifies
  the engine call, `runId`/`label` retain their compatibility attribution, and
  `sessionId`/`backendId` identify the ACP session. The bridge sets `scope = runId` when a session
  has run context. Direct runner/interactive sessions may omit `callIndex`; `backend_error` is
  connection-scoped and carries no session/run/call context.

Bridge lifecycle: ref-counted per runner. A constructor-injected runner is bridged for the manager's lifetime; a per-run `ExecOptions.agent` runner is bridged only while its run is active. `manager.dispose()` (alias `close()`) detaches the manager's subscriptions — it does **not** dispose the runner, whose process lifetime stays with the caller. Forwarding is observability-only: a throwing `agentEvent` listener is isolated and never affects the run.

`workflowAgentEventSource(runner)` exposes that process-shared, ref-counted multicast as
`WorkflowAgentEventSource.attach({ observe })`. It owns one underlying ACP catch-all/cross-cutting
subscription set per runner, snapshots and isolates sinks, and detaches on the last reference. The
manager feeds the pure `projectWorkflowAgentActivity(event)` adapter into its durable sampler before
forwarding the unchanged raw event. This is the supported seam for a later eval/trajectory sink;
projection and persistence remain manager-owned.

Alternative: subscribe on the runner's bus directly — see [Runner events](#runner-events); same
underlying stream and optional `runId`/`label`/`callIndex` attribution, no manager involved.

### OpenTelemetry

`@automatalabs/agentprism-otel` attaches to any `WorkflowManager` and exports workflow traces and metrics through `@opentelemetry/api` only:

```ts
import { attachOtel } from "@automatalabs/agentprism-otel";

const telemetry = attachOtel(manager, { captureContent: false });
// run workflows...
telemetry.detach();
```

| Span | Source |
|---|---|
| `workflow` / `workflow <meta.name>` | run root, lazily created from the first manager event carrying `runId` |
| `invoke_agent <label>` | `agentStart` → `agentEnd` |
| `execute_tool <title>` | facade `agentEvent` `tool_call` → terminal `tool_call_update` |

Metrics: `agentprism.tokens`, `agentprism.cost`, `agentprism.agents`, and `agentprism.agent.duration`. Content attributes (`prompt`, `result`, tool input/output) are disabled by default and require `captureContent:true`; workflow `log()` messages are always added as root-span events. Without a registered OTel SDK, the API no-ops, so attaching is safe in hosts that do not configure telemetry.

---

## Isolation mode

Isolation mode is the single-shot substitution primitive: it re-executes a completed recorded
workflow, serves every non-target call from that recording, delegates the selected target call to a
live runner, and returns a typed `ReplayReport`. The persisted isolation artifact is quarantined and
cannot itself be resumed or reused as a baseline.

The SDK form defaults `runner` to `createAcpRunner()`, disposes that owned runner after the run, and
uses `allowScriptBackends` to approve the recording's script-declared `meta.backends`:

```ts
import { runIsolation } from "@automatalabs/workflows";

const isolated = await runIsolation({
  baselineRunId: recorded.runId,
  live: [{ label: "step-2", model: "codex/gpt-5.3-codex" }],
  cwd: projectRoot,
  allowScriptBackends: true,
});

if (isolated.status === "completed") {
  const target = isolated.report.calls.find((call) => call.mode === "live-target");
  console.log(target?.recordedUsage, target?.liveUsage);
}
```

`RunIsolationSdkOptions` is the engine's `RunIsolationOptions` without `runner` or
`scriptBackends`, plus optional `runner` and `allowScriptBackends`. An injected runner remains
caller-owned. The backend-neutral engine form requires both fields explicitly:

```ts
import { runIsolation } from "@automatalabs/workflow-engine";

const isolated = await runIsolation({
  baselineRunId,
  runner,
  live: [{ callIndex: 3, model: "candidate/model" }],
  scriptBackends: approvedScriptBackends,
});
```

Both forms are async and never throw synchronously. Load, preflight, target resolution,
environment, lease, run-id collision, and manager-start failures reject with a typed
`WorkflowError` before script execution or live spend. Once script execution starts, every outcome
resolves as `IsolationRunResult.status`: `"completed"`, `"target-failed"`, `"diverged"`, or
`"failed"`.

### `createReplayRunner` composition

`createReplayRunner({ recording, inner, live, rootRunId, executionCwd?, environmentKey? })` is the
in-memory composition primitive. It JSON-normalizes and preflights `recording`; its `confirm`,
`observeAgentEnd`, `report`, and `finalize` methods let a custom host wire checkpoint serving,
sealed target settlement, and report freezing. An own-manager composition must pass the same
baseline marker in the initial managed-run save:

```ts
const replay = createReplayRunner({ recording, inner, live, rootRunId, executionCwd });
manager.on("agentEnd", (event) => replay.observeAgentEnd(event));
const run = await manager.runSync(recording.script, structuredClone(recording.args), {
  agent: replay,
  confirm: replay.confirm,
  runId: rootRunId,
  executionMode: { kind: "isolation", baselineRunId: recording.runId }, // MANDATORY
  cwd: executionCwd,
});
const report = replay.finalize({ scriptCompleted: run.status === "completed" });
```

Omitting `ExecOptions.executionMode` on this own-manager path violates the quarantine contract; a
replayed provenance row still makes later baseline use fail closed. Prefer `runIsolation` unless the
host needs to own the manager lifecycle.

### Targets and model evidence

Every `IsolationTarget` selects exactly one recorded agent call: `{ callIndex, model? }` XOR
`{ label, model? }`. A label must resolve to exactly one terminal root-scope agent row; use
`callIndex` for duplicate labels. Targets must be runner-origin agent rows with an input
fingerprint and a pinnable cwd; checkpoints, worktree calls, journal-replayed calls, missing rows,
and duplicate target selections are rejected as `REPLAY_TARGET_INVALID` (`no-targets`,
`invalid-selector`, `label-not-found`, `label-ambiguous`, `re-record-or-target-by-callindex`,
`call-not-found`, `not-agent-call`, `journal-replay-target`, `not-runner-call`, `worktree-target`,
`no-input-fingerprint`, `path-missing`, or `duplicate-target`). Re-record with the current engine,
target a unique live runner row, or use propagation mode as the named condition requires.

Baseline attribution has three states. A target without a model override is accepted only when the
recorded row positively proves `modelRequested` and `modelResolved` and reports no fallback. An
unverified baseline is refused as `unproven-baseline-model`; supplying explicit `target.model`
states the comparison intent and admits it. Candidate attribution also requires positive evidence:
a sealed resolved model with no fallback is verified, a sealed fallback causes
`candidate-fallback` divergence, and a silent runner is explicitly marked
`candidateEvidence: "unverified"` and listed in `report.unverifiedTargets`.

### Recording refusals

An inadmissible recording rejects with `WorkflowErrorCode.RECORDING_UNUSABLE`; `details.reason` is
one of the following frozen values. First failure wins.

| Reason | Remedy |
|---|---|
| `not-found` | Check `baselineRunId`, `cwd`, and `persistenceRoot`. |
| `corrupt-structure` | Re-record with the current engine; do not hand-edit consumed run fields. |
| `not-completed` | Use a terminal completed run; partial runs belong to propagation mode. |
| `script-invalid` | Repair the recorded script and create a new completed recording. |
| `incomplete-manifest` | Re-record so every allocated call has one dense terminal manifest row. |
| `nested-workflow-recording` | Record a root workflow with no nested `workflow()` execution. |
| `isolation-artifact` | Use the original live recording, never a quarantined isolation artifact. |
| `legacy-resume` | Create a fresh, non-legacy recording with the current engine. |
| `abort-residue` | Use a clean completed run that was never aborted. |
| `engine-origin-row` | Re-record after fixing the engine-owned call failure. |
| `replayed-row` | Use a recording whose rows were produced live, not served from another run. |
| `unreplayable-error` | Re-record with a strict-JSON, losslessly projectable thrown value. |
| `args-unreplayable` | Pass strict-JSON args and record again. |
| `ambiguous-identity` | Give fan-out calls distinct lenses/prompts or call sites, or use propagation mode. |
| `path-missing` | Re-record with an engine that captures call paths. |
| `runtime-mismatch` | Run under exactly the recorded Node/V8 and path/input formats, or re-record. |
| `no-limits` | Re-record so effective execution limits are persisted. |
| `agent-limit-boundary` | Re-record with `maxAgents` strictly greater than allocated calls. |
| `no-execution-cwd` | Supply `executionCwd` for a legacy recording, or create a new recording. |
| `no-environment-identity` | Re-record in Git or supply the same explicit `environmentKey` outside Git. |
| `environment-mismatch` | Restore the recorded Git HEAD/dirty state or matching non-Git key, then retry. |
| `journal-manifest-mismatch` | Create a fresh run whose result journal and terminal call manifest agree. |

The prominent v1 identity refusal is intentional and applies to the whole recording:

> Recordings containing two calls with identical `(kind, path, hash)`
> (`RECORDING_UNUSABLE`, `"ambiguous-identity"`, §4.9). **Prominent consequence
> (opus r5 A2):** the engine's own stdlib produces exactly this — `verify()` with
> no `lens` and ≥2 reviewers, `judgePanel()`, or any
> `parallel(items.map(() => agent(samePrompt)))` emits identical-prompt,
> identical-path calls (`workflow.ts:855-864`), so ANY recording containing such a
> helper call is wholly non-isolatable, even to isolate an unrelated step.
> Remedies: distinct `lens` values (which change the prompt, hence the hash),
> distinct call sites, or propagation mode. Two all-served upstream duplicates
> would be order-safe to serve, so this is over-conservative, not unsound — future
> admission is out of scope.

### Replay divergences

After execution begins, correspondence failures resolve with status `"diverged"` (or `"failed"`
for an unsettled target) and a `REPLAY_DIVERGENCE` error/report event using one frozen kind:

| Kind | Remedy |
|---|---|
| `path-unavailable` | Re-record and replay under the exact supported runtime/path format. |
| `nested-workflow-call` | Keep the isolation replay in root scope; use propagation for nested execution. |
| `identity-reexecuted` | Restore the recording's call count/control flow at that lexical site. |
| `target-site-reexecuted` | Select a target site that arrives exactly once. |
| `dependent-or-drifted-target` | Isolate one independent target and restore its recorded config/context. |
| `ambiguous-path` | Split fan-out across distinct call sites/prompts, target another step, or propagate. |
| `unrecorded-call` | Restore recorded control flow; do not introduce a new live call. |
| `target-inputs-drift` | Restore the target's recorded fingerprint and resolved cwd before live delegation. |
| `target-unsettled` | Await the target and let its terminal `agentEnd` settle before script completion. |
| `candidate-fallback` | Choose a candidate model the runner can positively serve without fallback. |
| `checkpoint-context-unavailable` | Re-record with checkpoint call context support in the current engine. |

### Cost, call identity, and persisted types

An isolation run's own per-call token figures (chars/4 estimates for served calls) are not comparable to a normal run's; the `ReplayReport` — `recordedUsage` vs `liveUsage` — is the only valid cost surface.

The replay substrate is public and additive. `RunOptions` carries optional `callIndex`, `callHash`,
`callPath`, and `callInputsHash` identity plus `onResultProvenance`; runners may ignore these fields,
while replay runners require them. `WorkflowCallRecord` is the root-scope terminal manifest. Actual effective routing is recorded as
`modelRequested?: string`, `modeRequested?: string`, and
`configOptionsRequested?: Record<string, string | boolean>`, before runner dispatch.
These are the requested inputs; `modelResolved` separately attributes the model actually served.
`JournalEntry` adds optional `kind`, `usage`, and `scope`. `PersistedRunState` adds the strict args
snapshot marker, effective cwd/runtime/environment/limits, manifest and allocation facts,
abort/nesting/resume markers, model and agents-directory context, `executionMode`, and
`replayReport`. `RunLease.recoveredOwnerPid` is present only when acquisition replaced a valid lock
whose PID was dead; recovery uses it for the human interruption reason, while missing/corrupt locks
leave it absent. Lease release always remains token-matched.

`PersistedRunState`, `PersistedAgentState`, `JournalEntry`, `WorkflowCallRecord`,
`WorkflowRecordedError`, `AgentResultProvenance`, and `ReplayReport` are documented public types:
their evolution is additive-only, and readers must tolerate absent old fields and unknown future
fields. Baseline admissibility is a stricter overlay and does not make every valid run record
replayable. The runs-directory location/layout, backup/lock files, and cross-tool file discovery are
internal storage details; use the engine's `createRunPersistence` or
`WorkflowManager.getPersistence()` rather than depending on paths. The SDK intentionally adds no
new persistence export.

---

## AcpAgentRunner (`createAcpRunner`)

```ts
import { createAcpRunner } from "@automatalabs/workflows";
const runner = createAcpRunner({
  size: 2,                                  // pooled processes per backend (AGENTPRISM_ACP_POOL_SIZE)
  clientHandlers: { fs: {...}, terminal: {...} },  // optional: route agent fs/terminal through the host
  onPermissionRequest: async (req, ctx) => ({ outcome: { outcome: "selected", optionId } }),
  onElicitation: async (req, ctx) => ({ action: "accept", content: { answer: "yes" } }),
  backends: { myAgent: { command: "/abs/bin", args: [], env: { API_KEY } } },
});
```

`AcpRunnerOptions`: `size?`, `clientHandlers?`, `onPermissionRequest?` (runner-wide async human-in-the-loop resolver; replaces the synchronous `ToolPolicy` auto-decision wherever set — pending resolvers are settled as `cancelled` on session teardown so a turn can never hang), `onElicitation?` (runner-wide ACP `elicitation/create` responder; see below), `authCapabilities?` (`{ terminal?, gateway? }` — which auth method **types** this host can complete; advertised at `initialize`, see below), `onAuth?` (inline `AuthResolver`; resolve-and-retry once instead of pausing, and derives gateway auth capability unless explicitly overridden), `backends?` (custom ACP backends, merged over env `AGENTPRISM_BACKENDS`; names are ASCII-case-insensitive and custom registrations take priority over built-ins on collision).

### `run(prompt, opts)` — the AgentRunner seam

One agent call per invocation; returns the assistant text, or the **validated object** when `schema` is set (native/tool-captured structured output + validate-and-re-prompt). Key `RunOptions`:

`label`, `schema` (JSON Schema / TypeBox), `signal`, `model` / `tier`, `mode`, `configOptions`, `cwd` (per-session working directory — worktree isolation preserved on a pooled process), `instructions`, `systemPrompt` (backend-neutral `{ replace?, append? }` system-prompt instructions — see [System prompt instructions](#system-prompt-instructions)), `toolNames` / `disallowedToolNames` (the `ToolPolicy` allow/deny lists), `mcpServers`, `images`, `meta` / `promptMeta` (ACP `_meta` passthroughs), `backends` (approved script-declared), `runId` (correlation stamp), `keepSession` (skip the release-time best-effort `session/close` so the agent-persisted session stays re-openable), resume-only `continueFromSession` (advisory exact-session reattach), callbacks `onUsage`, `onHistory`, `onResultProvenance`, `onModelResolved`, `onModelFallback`, `onSessionOpen`.

**Session hand-off.** `run()`'s return value is always the bare result, so the ACP session identity travels out-of-band: `onSessionOpen` fires exactly once for whichever acquisition wins — fresh `session/new`, successful `session/resume`/`session/load`, or the fresh fallback after a reopen failure — and always before that acquisition's prompt. Its `AgentSessionRef` is `{ sessionId, backendId, poolKey?, initializeMeta?, cwd, reopen: { load, resume, list, fork }, costGauge? }`; `poolKey` pins the effective custom-backend spawn identity. `costGauge` is the session's latest cumulative cost gauge when the ref was captured — the session's total, not a call's spend — and is absent when the agent reported no cost. Because `onSessionOpen` fires before the first prompt it can only carry a gauge the session already had (a reattach hands the recorded one on); `onSessionCostGauge(amount)` fires at most once at release, next to `onUsage`, with the gauge the call ended on, and the workflow engine folds it into the recorded `AgentSessionRecord` so a later `continueFromSession` baselines it and `onUsage` stays the call's own spend. `agent.sessionRef` on an `AcpAgent` reads the gauge live and keeps it after `close()`. A `costGauge` that is present but not a non-negative finite number fails `AcpAgent.resume/load/fork` validation and invalidates a recorded continuation session. `initializeMeta`, when the initialize response supplies non-null `_meta`, is one complete recursively frozen JSON snapshot owned by the session and shared with its event contexts; absent/null metadata omits the key. Pair a successful call with `keepSession: true` when the host intends to reopen it. Usage/auth pause errors keep the session open automatically for managed continuation. With `continueFromSession`, the runner prefers currently advertised resume, falls back to load, and reports reattached/skipped provenance. Every non-cancellation failure through the reopen RPC cleans up and opens a fresh session with the original prompt; after reopen succeeds, the turn is committed and receives a fixed continuation instruction. The ref contains no secrets added by the client and is JSON-round-trippable; agents remain responsible for what they place in `_meta`.

**Cancellation.** An attempt signal sends ACP `session/cancel` for that session only. If the active
turn does not finish within five seconds, the client sends capability-gated `session/close`,
quarantines the pooled child from new work, and disposes it after existing sibling sessions release.
This policy is identical for every built-in and custom ACP backend. A `child_cleanup_error` returned
by close remains observable through the runner's normal error path.

**Structured output channels.** Claude and Codex keep their agent-specific schema channels authoritative. Pi, OpenCode, and opted-in custom ACP backends use the client-hosted MCP path: when `RunOptions.schema` is set and initialize advertises HTTP MCP support, the runner appends a client-hosted HTTP MCP server to `session/new.mcpServers`. The injected server is named `structured_output` (or `structured_output_2`, etc. on name collision), runs on `127.0.0.1` with an unguessable token path, and exposes `StructuredOutput`; Pi shows the namespaced alias `mcp__structured_output__StructuredOutput`. Its input schema is the requested JSON Schema and a valid call captures the result. Each injected-tool schema run reserves a pooled process exclusively from other injected runs; when every process is reserved, the pool grows elastically past `size`, then keeps surplus idle processes warm briefly before shrinking back to that steady-state size. The reservation remains held through `session.release()`, so two injected runs never share one process. Non-injected runs retain ordinary idle/grow-to-size/least-loaded multiplexing and may co-locate with an injected run. The common prompt-embedded schema plus validated final-text ladder remains the fallback when capture is absent or invalid. User-provided `mcpServers` are preserved and are not part of the resume hash.

**Model specs**: after the engine's existing precedence resolves one effective string, the runner splits it on the first `/`. If the first segment, ASCII-case-insensitively, is `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name, that harness is selected and exactly one segment is stripped; a custom registration wins on collision. A registered harness name by itself is backend-only and issues no model `session/set_config_option`, preserving the harness default. Any other first segment sends the entire authored string unchanged to `AGENTPRISM_DEFAULT_BACKEND` (historical SDK fallback `claude`), so `anthropic/…`, `openai/…`, bare `opus`, and bare `gpt-…` are not aliases. MCP requires an effective model on every actual call, supplied directly or through a named-agent definition, resolved tier, phase, or workflow default. No agent-configuration setup or automatic backend selection fills missing routing. Configured calls on additional live branches are valid; missing routes fail before dispatch with bounded discovery guidance. Format-3 admission snapshots routing files for continuation without drift. Browse selectors ending in `/*` must be expanded through `modelFilter` before dispatch. When an id remains it is the exact `configId:"model"` value: no case folding, normalization, catalog matching, bracket parsing, sibling effort/Fast option driving, retry, echo verification, or fallback. Brackets, dots, and provider-style prefixes are ordinary id characters. For pi, `pi/<provider>/<model-id>` therefore sends `<provider>/<model-id>` verbatim. Harness rejection follows the existing agent-error path; `onModelFallback` remains source-compatible but model resolution does not emit it. Live-catalog-verified examples: `claude/opus[1m]`, `codex/gpt-5.6-sol`, `opencode/zai/glm-5.2`; use backend-only `claude`, `codex`, `opencode`, or `pi` when the model is configured in the harness.

**Session config options**: `configOptions` is a `Record<string, string | boolean>` of exact
ACP ids and authored values. Entries are sent verbatim in ascending option-id order, after model
selection and before the prompt; the client provides no aliases, coercion, catalog fallback, retry,
or echo verification. Harness rejection follows the ordinary agent-error path. `"model"` is
reserved for the dedicated `model` field and is rejected engine-side before a session opens.
`configOptions` enters replay identity as sorted-key JSON only when non-empty, so absent and empty
bags preserve pre-feature hash bytes. Pi's `thinkingLevel` select advertises only the selected
model's supported values. Its additive
`_meta["@automatalabs/agentprism"].recognizedValues` holds Pi's complete SDK-derived ordered domain;
recognized unsupported requests clamp through Pi and echo the effective value, while unrecognized
requests fail with `invalid_config_value`. `runner.probeConfigOptions(spec?, { cwd?, selectModel?, backends?, signal? })`
routes normally, opens exactly one no-prompt session, optionally applies the routed model remainder
when `selectModel:true`, uses any approved run-scoped `backends` only for that probe, returns `{ backendId, options }` with the verbatim echoed
`SessionConfigOption[]`, and closes it; spawn/auth/model-selection/session failures throw.

**Session modes**: `mode` is an exact agent-advertised ACP session mode id. Discovery preserves each mode's raw `id`, `name`, `description`, and `_meta`; it never replaces backend prose with a local interpretation. When `mode` is omitted, AgentPrism explicitly applies the first-class default instead of inheriting ambient harness configuration: Claude `auto`, Codex `agent`, OpenCode `build`, and no Pi mode. Custom backends retain their own current mode. Authored and built-in defaults are strict: the selected backend/model must advertise the exact id before prompt. Dedicated modes use `session/set_mode`; the normalized `category:"mode"` config-option fallback uses `session/set_config_option`.

A mode no longer creates a generic client-side deny overlay. Explicit tool allow/deny lists remain binding; otherwise a configured `PermissionResolver` decides. SDK runners without a resolver retain the ACP-permitted autonomous auto-response path.

**Exact permission options.** `session/request_permission` options are ordered and opaque. The selected `optionId` is authoritative; labels, `kind`, and `_meta.permission` are presentation only. `selectPermissionOption(request, optionId)` validates exact membership and fails closed as cancelled. The deprecated `PermissionPersist` / `PermissionResolution.persist` / `ToolPolicy.persist` / `resolvePermission` / `withPersist` compatibility surface could not distinguish session approval, permanent approval, command/network amendments, strict turn review, decline, and cancel when several choices share the same `kind`.

### <a name="system-prompt-instructions"></a>System prompt instructions (`systemPrompt`)

`systemPrompt?: SystemPromptOptions` (`@automatalabs/shared-types`) is the one backend-neutral way to shape the agent's **system prompt** for a session, accepted by `run()`, `openSession()` / `loadSession()` / `resumeSession()`, and the `AcpAgent` SDK (constructor, `fork()` overrides, and the cold statics). `replace` swaps the backend's built-in system prompt for the given text; `append` adds the text on top of it (of the replaced prompt when both are set). Each field is independently optional; values must be non-blank strings and no other field is accepted. It is additive (never part of the resume identity hash), wins over the same key in the generic `meta` passthrough, and is distinct from the `instructions` string, which is folded into the prompt text on every backend.

Support is executable data — `SYSTEM_PROMPT_SUPPORT` in `packages/acp-agents/src/protocol-coverage.ts`, read by each built-in as `Backend.systemPrompt` and pinned against the installed adapter dists and this document — and it is enforced **before a session opens**: `assertSystemPromptSupported` (exported) rejects a field the routed backend cannot carry, a non-object, an unknown field, or a blank string with a non-recoverable `SCRIPT_VALIDATION_ERROR` naming the backend and the field (the `AcpAgent` SDK surfaces the same refusal as `INVALID_ARGUMENT`). Nothing is ever silently dropped. The value then rides the session `_meta` on `session/new`, `session/resume`, `session/load`, and `session/fork` (and therefore the reattach an id-only fork needs) in the backend's own dialect:

| backend | `replace` | `append` | session `_meta` |
|---|---|---|---|
| `codex` | replaces Codex's base system prompt. Survives `replace`: Codex's other instruction layers — the developer instructions, `AGENTS.md` project instructions, and the environment context — per the app-server protocol's field semantics (documented behavior; not source-verified here) | developer-role instructions on top of it | bare `baseInstructions` / `developerInstructions` (`CODEX_META_KEYS`), threaded by `@automatalabs/codex-acp` into the `thread/start` / `thread/resume` / `thread/fork` params of the same name (a Codex fork is live, so its `session/fork` `_meta` is the only delivery). Live observation on a fork: `replace` takes effect on the forked thread; `append` rides `thread/fork` but the forked thread answered from its source thread's developer instructions — Codex app-server behavior, not source-verified here |
| `claude` | replaces the whole prompt. Survives `replace`: nothing of the `claude_code` preset, its dynamic sections included; tool schemas still reach the model as API tools | appended to the adapter's `claude_code` preset | `systemPrompt` (`META_KEYS.systemPrompt`): a string for `replace`, `{ append }` for `append`; both together become one replacement string — the replaced prompt, a blank line, the appended text — because `claude-agent-acp` accepts either a full string or preset options, never a custom base plus an append |
| `pi` | pi's custom-prompt slot (`SYSTEM.md` / `--system-prompt`) via the loader's `systemPromptOverride`. Survives `replace`: the append entries, the project context files (`AGENTS.md` and friends), the skills block, and the `Current working directory` line; pi's default tool list, guidelines, and docs paths are dropped | one more entry after the operator's append-system-prompt files via `appendSystemPromptOverride` | `systemPrompt` `{ replace?, append? }` verbatim; `@automatalabs/pi-acp` advertises `_meta.systemPrompt: { replace: true, append: true }` at initialize and answers a malformed value with `-32602` / `data.errorKind = "invalid_system_prompt"` (`data.field` names the offender) before any session state exists |
| `opencode` | — | — | `opencode acp` reads no session `_meta` (its ACP service consults `_meta` only for terminal auth at initialize) — there is no system-prompt channel; system prompts live in OpenCode's config and agent definitions, and the option is refused |
| custom | — | — | ACP defines no standard system-prompt key, so a registry backend declares no support and the option is refused; send the agent's own `_meta` keys through `meta` |

A backend's own extras beyond the neutral pair (Claude's `excludeDynamicSections`, for example) still travel through `meta` when `systemPrompt` is not used for that key.

### Elicitation (agent questions)

ACP `elicitation/create` lets an agent ask the human structured questions during a turn. `mode: "form"` carries an SDK `ElicitationSchema` of primitive fields; `mode: "url"` carries a URL and `elicitationId`, with a later `elicitation/complete` notification when that URL flow finishes. The SDK marks this surface **UNSTABLE/@experimental**, so the public API re-exports the SDK request/response/schema types directly.

Configure `createAcpRunner({ onElicitation })` to answer requests. A resolver receives `(request, context)` and returns `CreateElicitationResponse`, for example `{ action: "accept", content: { ... } }`, `{ action: "decline" }`, or `{ action: "cancel" }`. With no resolver for the session, the client auto-declines with `{ action: "decline" }`; parked resolvers are settled with `{ action: "cancel" }` on session cancel, release, or connection death.

Capability advertisement is fixed at `initialize`: the client advertises `elicitation: { form: {}, url: {} }` only when a runner-wide `onElicitation` exists. A session-scoped `openSession({ onElicitation })`, `loadSession({ onElicitation })`, or `resumeSession({ onElicitation })` wins over the runner resolver for that session, but by itself cannot light up initialize-time capabilities on the connection. Agents on that connection may therefore never ask. A resolver may still decline modes it cannot render.

Claude-family agents use this advertisement to enable `AskUserQuestion`, refusal-fallback dialogs, and MCP-elicitation forwarding. Advertising without a real responder would send those agent questions into a void, so this library never advertises elicitation for a stub auto-decline path.

### Client auth capability advertisement

The client tells the agent which authentication method **types** it can actually complete, so the agent only offers gates the host can finish. Like elicitation, this is fixed at `initialize` and derived once at runner construction (never per-session). `createAcpRunner({ authCapabilities })` takes `{ terminal?, gateway? }`:

- `terminal: true` advertises `clientCapabilities.auth.terminal` **and** the top-level `clientCapabilities._meta["terminal-auth"]` channel (both are read by first-class agents — Claude reveals its terminal login methods on either, OpenCode reads the launch hint under the `_meta` channel).
- `gateway: true` advertises `clientCapabilities.auth._meta.gateway` (the gate Claude and Codex use to reveal their gateway auth methods).

**Default-OFF.** With `authCapabilities` unset, the `auth` capability is **omitted entirely** from `initialize` — which the ACP spec treats as "unsupported" — so behavior is byte-identical to a host that never opted in. Ungated `agent` methods (no gateway-shaped `_meta`) are always visible on the wire regardless of this option. A native-TTY CLI host passes `{ terminal: true, gateway: true }`; a generic programmatic host leaves it unset. The `auth` surface is SDK-**UNSTABLE/@experimental**; a drift tripwire (`assertAuthCapabilityShape`) fails the build if a future SDK bump reshapes it.

> **Changed 2026-08-20 (ACP schema 1.21.0 / `@agentclientprotocol/sdk` 1.4.0).** The protocol removed the UNSTABLE `env_var` auth method variant (agentclientprotocol/agent-client-protocol #1796 / #2000); `AuthMethod` is now `agent | terminal`. Accordingly the `env_var` `AuthMethodDescriptor` variant, the `"env_var"` `AuthMethodType`/`AuthErrorContext` literal, the `"spawn-env"` credential class, and the `AuthEnvVar`/`AuthMethodEnvVar` type re-exports are gone from `@automatalabs/acp-agents` and `@automatalabs/workflows`. The `{ outcome: "env", values }` resolution remains for `agent` methods whose credential is read from the spawn environment (codex `api-key`); `@automatalabs/pi-acp` now advertises only `pi-stored-credentials` and reads provider keys from its environment as before.

### Auth & providers

Authentication methods are discovered without opening a session:

```ts
const methods = await runner.authMethods({ model: "codex" }); // AuthMethod[]
await runner.authenticate({ model: "codex", methodId: "api-key" });
```

`authMethods()` returns the selected backend's initialize-advertised `AuthMethod[]` (`[]` when none). `authenticate({ methodId, meta? })` is **rebuilt off dispose-after-authenticate**: instead of firing a fire-and-dispose RPC (which lost any in-process gateway credential the agent stored on that connection), it records the chosen credential into the runner's single durable `AuthStore` and recycles the pool. A method carrying gateway-shaped `_meta` records an in-process intent that is replayed on every pooled connection's `initialize`; a bare method with no `_meta` fires the one-shot login RPC so the agent runs its own login. ACP has no `agentCapabilities` gate for `authenticate`, so a backend that does not implement it may return method-not-found, surfaced with the backend id and method name.

#### Auth lifecycle — the type-dispatched contracts, `AuthStore`, and the `runner.auth` controller

Credentials live in exactly one place — the runner's per-instance `AuthStore` — and every connection pulls the current intent at the end of its `initialize` handshake, so the credential survives pool recycles and process respawns. The base flow is fully type-driven from `AuthMethod.type` plus the cross-agent `_meta` conventions (`gateway`/`terminal-auth`), with **zero agent-specific code** (a spec-conformant custom agent traverses the identical path).

- `runner.describeAuthMethods(opts?)` → `AuthMethodDescriptor[]`: a read-only probe that opens a dedicated connection, reads the advertised methods, and returns their type-dispatched descriptors (`agent` with `expectsMeta`/`interactive`; `terminal` with a resolved `launch`).
- `runner.completeAuth({ methodId, resolution, ... })` → `AuthOutcome` (`{ status, methodId, recycled }`): records the host-collected `AuthResolution` (`{ outcome: "completed" | "agent-login" | "env" | "meta" | "cancelled" }`) into the `AuthStore`, advances the generation, and recycles the pool. The credential class (`disk` / `in-process`) is derived from the chosen method's type + `_meta` shape, never from the outcome; an `env` resolution's values ride the intent and are injected into the spawn environment on recycle.
- `AcpRunnerOptions.onAuth` (an `AuthResolver`): when set, a `-32000` at `session/new` is resolved inline and the acquire retried **exactly once** — the run never pauses (a second `-32000` propagates as `AUTH_REQUIRED`). Setting `onAuth` also derives `authCapabilities` to `{ terminal: false, gateway: true }` unless you pass it explicitly.
- `runner.auth`: the verbs as one object — `methods()` (= `describeAuthMethods`), `authenticate()` (= `completeAuth`), `logout()`, `status()` (redacted `AuthStatusSnapshot[]` — ids/types/names + state only, **never** secrets), and `canResume(backendId)` (cold-resume re-arm predicate). `AuthCapableRunner` is the structural interface an embedding host duck-types to drive this auth surface **programmatically** — the stdio MCP server registers **no** auth tools (auth stays with the agents' own credential stores; a run that hits `AUTH_REQUIRED` pauses and resumes out-of-band).

`env`/`meta` payloads are **SECRET** and flow only through the resolver return value into the `AuthStore` and the spawn env — never into events, journals, logs, error messages, or `status()`. `logout()` clears the store (zeroizing the secret payload), recycles the pool, and issues the agent `logout` RPC only where advertised. Default-OFF: with neither `onAuth` nor `authCapabilities` set, the wire behavior is byte-identical to a host that never opted in.

**Per-agent auth profiles.** The four built-in backends carry a pure-data `AuthProfile` (`claudeAuthProfile`/`codexAuthProfile`/`opencodeAuthProfile`/`piAuthProfile`, exported from `@automatalabs/acp-agents`); a custom backend supplies **none** (`Backend.authProfile` undefined) and runs the base flow verbatim — conformance is defined by the *absence* of a profile. A profile is enrichment only and never gates the flow: it refines which auth method **types** the backend advertises via `clientAuthCapabilities({ onAuth, terminal })` (Codex never advertises `terminal`; OpenCode never advertises `gateway`; pi's stored-credentials method needs neither gate; Claude follows both host affordances), and relabels the type-dispatched descriptor via `describe`. Pi's profile adds concrete remediation for its single advertised method, `pi-stored-credentials`: set one of the provider env keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`) or configure `~/.pi/agent/auth.json`. Only `codexAuthProfile` defines `spawnAuthEnv`: it emits the codex `DEFAULT_AUTH_REQUEST` startup env for `api-key`/`gateway` intents so a freshly recycled process pre-authenticates before its first gated request — layered **on top of** the universal post-`initialize` replay, never replacing it and never required for correctness. The `AuthMethod.type` discriminants, the cross-agent `_meta` convention keys, the codex `DEFAULT_AUTH_REQUEST` channel, and pi's frozen wire profile are pinned as build-time drift tripwires (`HANDLED_AUTH_METHOD_TYPES`, `AUTH_META_CONVENTION_KEYS`, `CODEX_SPAWN_AUTH_ENV`, `AUTH_META_MATRIX`, `PI_ACP_PROTOCOL_CONTRACT`).

If `session/new` or `session/prompt` fails with ACP `RequestError.authRequired()` (JSON-RPC code `-32000`), the runner raises `WorkflowErrorCode.AUTH_REQUIRED` with `recoverable: false`. The SDK reserves `-32000` exclusively for `authRequired`, so the code alone classifies — any message text (including a localized or rephrased one) still routes to auth. As a guarded fallback for non-conformant agents, an error whose code is not a reserved JSON-RPC code (or which carries no code) but whose message matches `authentication required` also classifies; a *different* reserved code (e.g. `-32603` internal error) that merely mentions the phrase never mis-routes. The enriched `.message` names the backend and advertised method ids for readability, but the machine-readable surface hosts should read is `WorkflowError.authContext` (`AuthErrorContext`: `backendId` plus advertised method `{ id, type, name }[]`, sourced only from agent-advertised `AuthMethod`s — never credential material). The SDK re-exports `isAuthRequired(error)` for detecting this code. The engine does not retry this; retrying cannot succeed until the host completes auth. Under `WorkflowManager` the fault **pauses** the run (`reason: "auth_required"`) and persists the non-secret `authContext`; `resume()` re-arms via `runner.auth.canResume(backendId)` (see the pause/resume note above).

Provider management mirrors the SDK request shapes:

```ts
const { providers } = await runner.listProviders({ model: "codex" });
await runner.setProvider({ model: "codex", providerId: "openai", apiType: "openai", baseUrl, headers });
await runner.disableProvider({ model: "codex", providerId: "openai" });
await runner.logout({ model: "codex" });
```

`providers/list`, `providers/set`, and `providers/disable` are gated together by the unstable `agentCapabilities.providers` advertisement. `logout` is gated by `agentCapabilities.auth.logout`. Missing advertised support throws a non-recoverable `WorkflowError` naming the backend, method, and advertised auth/provider capabilities. Like the auth flow, the providers surface is base-spec generic: any backend — built-in or custom — that advertises `providers` is served with zero agent-specific code. `AuthCapableRunner` / `ProviderCapableRunner` are the structural interfaces an embedding host duck-types to reach these runner APIs; `setProvider` `headers` are **SECRET** and never echoed, journaled, or logged.

**Durable routing (record → recycle → replay).** Agents may keep client-configured provider routing as pure in-process state (codex-acp does for its custom gateway), which is the same failure class as the dispose-after-authenticate bug: a bare `providers/set` on a throwaway connection would leave every pooled run silently unrouted. So a successful `setProvider()` also records the routing intent in the runner's in-memory `ProviderStore` and recycles the pool; every fresh connection — pooled, dedicated, and interactive — replays the recorded `providers/set` at the end of its `initialize` handshake (advertise-gated), and connection selection is generation-gated so no session is ever opened on a process running under stale routing. `listProviders()` therefore reflects the configured `current` routing even though it probes a fresh dedicated process. A replay failure fails the connection **loudly** rather than mis-routing traffic. A fresh process that stops advertising the `providers` capability while routing is still recorded (a backend version change, a command override/wrapper, or a startup-dependent advertisement) fails the same way — a non-recoverable `WorkflowError` naming the backend — instead of stamping itself current and silently routing direct-to-provider; the operator either restores the backend or calls `disableProvider()` to accept direct routing. `disableProvider()` drops the intent and recycles; the request-scoped `meta` passthrough rides the immediate call only and is never replayed. Intents live for the runner's lifetime (in memory only — reconfigure after a restart).

Installed adapter status from the bundled dists:

- `@agentclientprotocol/claude-agent-acp@0.79.0`: advertises `auth.logout`, implements `logout`, and implements `authenticate` for its gateway auth methods; terminal login methods are advertised only when the client advertises terminal auth support. As of 0.60.0 it advertises `providers` and implements `providers/list`, `providers/set`, and `providers/disable` for a single provider `providerId` `"main"` supporting `apiType` `anthropic`, `bedrock`, and `vertex`; `providers/set` rejects any other `providerId`/`apiType` with invalid-params, and `vertex` additionally requires `_meta.claudeCode.vertex.{projectId,region}` (recorded as durable routing config and replayed on every reconstructed `providers/set`, so pooled connections re-route correctly). `providers/disable` is idempotent. Adapter 0.71+ can launch a background small-model title-generation call after a first turn; for engine-owned sessions carrying `runId`, `ClaudeBackend` supplies a stable `claudeCode.options.title` derived from the occurrence label (or run id) so that autonomous call is skipped and token telemetry remains complete. Held-open interactive sessions have no engine `runId` and retain generated titles. Adapter 0.76.0 advertises the AIR recommended-config-value extension (a recommended model/effort hint attached to session config options) only to clients that opt in; AgentPrism does not opt in, receives no such hint, and keeps routing the explicit model id verbatim. Adapter 0.77.0 no longer forwards `claudeCode.options.agent` (the main-thread agent picker and its discovery were removed; AgentPrism never sent it), sets the standard ACP `name` on every initial `tool_call` alongside the `_meta.claudeCode.toolName` it already carried (AgentPrism prefers the standard field for tool-policy matching and history, with the vendor key as fallback), lets a host opt a session out of `bypassPermissions` with `claudeCode.options.allowDangerouslySkipPermissions: false` (AgentPrism does not send it, so bypass availability is unchanged), and strips injected `<system-reminder>` blocks from replayed user messages on `session/load`. Adapter 0.78.0 adds experimental compaction updates (`compaction_update` / `compaction_summary_chunk`) only for clients that advertise `clientCapabilities.session.compaction`; AgentPrism does not, so its update stream is unchanged. 0.78.0 also supplies AIR diff counts (`_meta.jetbrains.air.diffStats`) on file-change tool calls and derives file-change reports from Claude checkpoints — additive `_meta` that AgentPrism passes through. Adapter 0.79.0 updates its wrapped runtime to 0.3.274 and changes shell-tool permission prompts (Bash and PowerShell): the permission `title` is now the raw command rather than the tool's description, no longer whitespace-compacted or length-limited, and PowerShell gets the same `terminal_info` metadata as Bash; AgentPrism matches tool policy on the standard `name` and uses `title` only as display decoration, so nothing changes on its side. The wrapped runtime resolves `@anthropic-ai/claude-agent-sdk@0.3.277` through the workspace override, ahead of the adapter's own 0.3.274 pin. 0.3.277 / Claude Code 2.1.277 makes a resumed session's `total_cost_usd` (the adapter's `usage_update.cost.amount`) continue from the earlier turns instead of restarting at zero; AgentPrism baselines that carried-over total from `AgentSessionRef.costGauge` (`COST_GAUGE_INHERITANCE`), so per-turn and per-call cost stay the spend after the resume. A forked Claude session's gauge still starts at zero. The release also reports an internal error and exits instead of hanging a headless session with no result, reads `AGENTS.md` in a project that has no `CLAUDE.md`, removes the deprecated `TaskOutput` tool, and adds fields the adapter does not read (`builtin` on `SlashCommand`, `pasted_content` on `SDKUserMessage`, remote-session latency fields on the success result); the adapter's own `_meta.quota.model_usage` split still measures its first post-resume increment from an empty reading, which AgentPrism does not consume. 0.3.275 fixes the session history the adapter reads on `session/load` and fork (`getSessionMessages()` / `forkSession()` no longer miss a turn's assistant message right after its `result`, a queued message or task notification read while a tool was running comes back where Claude read it, `forkSession` accepts the id returned for a message sent mid-turn, and a deferred tool call re-run at the start of a resumed turn emits `tool_use_result` rather than internal keys); 0.3.276 / Claude Code 2.1.276 fixes the 2.1.275 regression that failed every request with HTTP 400 when `ANTHROPIC_BASE_URL` points at a proxy or gateway. Neither changes an API shape the adapter or AgentPrism consumes. 0.3.274 / Claude Code 2.1.274 add only fields the adapter and AgentPrism do not read (`startup_failure_reason` on the stream-json error result, `mcpServer` / `source` on `canUseTool` options and MCP status rows, the `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` and `CLAUDE_CODE_EMIT_STARTUP_TIMING` env opt-ins); its faster first turn still awaits `options.mcpServers`, which is where ACP-provided servers and AgentPrism's injected StructuredOutput / function-tool hosts ride, and its `getSessionMessages()` fix means a `session/load` replay or fork now includes a user message sent while a tool was running. Claude Code 2.1.269–2.1.273 change nothing on the adapter surface: resumed headless sessions no longer lose a turn's replies when the model was switched or a request retried mid-turn, sessions no longer stick on "Prompt is too long" when auto-compaction has no complete earlier exchange to summarize, 2.1.270 fixes a 2.1.269 regression that re-prompted for read-only git commands, and 2.1.273 no longer reports a sub-agent as failed when its final streamed reply omitted token usage or a model id. The 2.1.268 runtime confirms a model id the CLI does not know locally with the API on first use instead of refusing it; AgentPrism never reaches that path because admission validates routed ids against the discovered catalog. The runtime makes the task-tracking tools (TaskCreate/Get/Update/List, TodoWrite) default tools only on Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6, and Haiku 4.5, so an agent definition that relies on them with a newer model must list them in `tools`. Its new `canUseTool` prompt hints and result-message fields are not read by the adapter, and its new `verification_required` assistant error kind reaches AgentPrism as a generic provider error, like `account_on_hold`. Custom system prompts are still recorded by default (a mid-session change applies at the next compaction); AgentPrism folds `instructions` into the prompt text and drives the adapter's `_meta.systemPrompt` only from the explicit `systemPrompt` option (see [System prompt instructions](#system-prompt-instructions)), and the 2.1.266 rule that `CLAUDE_CODE_USE_GATEWAY` alone is ignored unless both `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are set still holds; 2.1.268 fixes the HTTP 400 every turn hit on third-party Anthropic-compatible endpoints since 2.1.265.
- `@automatalabs/codex-acp` (workspace, `packages/codex-acp`): advertises `auth.logout`, implements `authenticate` (`api-key`, `chat-gpt`, and `gateway` when gateway support is advertised), and implements `logout`. As of 1.6.0 (upstream sync) it also advertises `providers` and implements `providers/list`, `providers/set`, and `providers/disable` for its single client-configurable custom gateway provider: `providerId` `"custom-gateway"`, `supported: ["openai"]`, `required: false`, `current` carrying only the non-secret `{ apiType, baseUrl }` (never headers) and `null` while unconfigured; `providers/set` rejects any other `providerId`/`apiType` with invalid-params and `providers/disable` is idempotent. Its separate reasoning-effort options remain agent-owned configuration; model-spec brackets are never interpreted by this client.
- Host-resolved OpenCode (`opencode-ai` 1.17.14 in the verified profile): advertises the `opencode-login` terminal-style method when the client advertises terminal auth, acknowledges `authenticate`, and relies on its provider credential store; it does not advertise logout. The credential-gated live suite verifies the installed executable because OpenCode is not bundled.
- `@automatalabs/pi-acp`: unconditionally advertises a single bare `agent` method, `pi-stored-credentials`, backed by `~/.pi/agent/auth.json` or the provider API keys in its spawn environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`). The former per-provider `env_var` methods were retired when ACP schema 1.21.0 removed that variant. Authentication is ambient/no-op, while a known model with missing credentials rejects with ACP `-32000`.

### Protocol passthrough & coverage

`PooledConnection` and `InteractiveSession` expose typed raw ACP `request()` / `notify()` escape hatches for spec methods without named wrappers:

```ts
import { AGENT_METHODS } from "@automatalabs/workflows";

await session.request(AGENT_METHODS.mcp_message, { connectionId, method: "tools/list" });
```

Prefer named wrappers (`prompt()`, `setMode()`, `openSession()`, etc.) when they exist; they preserve engine semantics like drain accumulation, local mode state, and usage recording, while raw `session/prompt` bypasses them.

Raw `request()` rejects the session-stateful methods that would create or reopen sessions outside the router: `session/new` (use `openSession()`), `session/load` (use `loadSession()`), `session/resume` (use `resumeSession()`), `session/fork` (use `forkSession()`), and `_session/steering` (use `steer()`). Those raw sessions are unregistered: updates do not fold into an accumulator, permission requests auto-cancel, and fs/terminal dispatch fails for unknown sessions.

`AGENT_METHOD_COVERAGE` and `CLIENT_METHOD_COVERAGE` classify every method constant exported by the installed ACP SDK. Agent methods are `"driven"`, `"passthrough"`, or `"guarded"`; guarded means no safe driven wrapper exists. Agent coverage is 16 operational driven methods plus `initialize`, 0 guarded methods, and passthrough for `nes/*`, `document/*`, and `mcp/message`. The raw guards for session-stateful `session/new`, `session/load`, `session/resume`, `session/fork`, and `_session/steering` require their driven wrappers. `ACP_EXTENSION_SUPPORT_MATRIX` separately documents built-in vendor-extension advertisements (Claude, Codex, and pi advertise steering; OpenCode does not), so it is never counted as a standard `AGENT_METHODS` method and never gates runtime behavior. Client methods are currently 14/14 served. A tripwire test compares the standard manifests against `AGENT_METHODS` / `CLIENT_METHODS`, and probes installed Claude/Codex extension advertisements. Arbitrary agent extensions use the existing generic overloads `session.request<Response, Params>(method, params)` and `session.notify<Params>(method, params)`; method strings, params, responses, and agent-provided numeric errors pass through unchanged, while notifications have no response.

`FORK_SESSION_TRAITS` pins, per built-in, what a `session/fork` response *is*, read from each adapter's source: `id-only` means the response names a persisted copy that is not live (Claude returns `{ sessionId }` alone and prompting it fails with "Session not found"), so the fork must be reopened — `session/resume`, else `session/load` — before its first turn; `live` means the fork handle is the session (Codex: the workspace `@automatalabs/codex-acp` fork keeps the forked thread subscribed — `thread/fork` subscribes the connection exactly like `thread/resume`, and the adapter no longer unsubscribes it — and publishes the fork's available commands and MCP startup status like a resumed session — the fork's liveness and its `available_commands_update` were verified live and are pinned by the codex-acp fork unit test; the MCP startup status publish follows from the removed `operation !== "fork"` publish gate, the same path a resumed session takes, and is not separately verified; pi constructs the fork in-process; OpenCode by live verification). The `cwd` column says whether the fork may re-home (Claude's transcript store is keyed by the source cwd). `forkSessionTrait(agent, declared?)` resolves a row: a built-in's own row, the row a custom backend's `fork` declaration describes (a declaration always wins over a name that shadows a built-in), else `FORK_SESSION_TRAIT_DEFAULT` (`live` / `free`, the plain ACP contract). Data for a fork choreography built on `PooledConnection`; `AcpAgentRunner.forkSession()` returns the raw fork handle and never consults it.

| agent | `session/fork` disposition | reattach | fork cwd |
|---|---|---|---|
| `claude` | `id-only` | `resume-or-load` | `source-only` |
| `codex` | `live` | `none` | `free` |
| `opencode` | `live` | `none` | `free` |
| `pi` | `live` | `none` | `free` |

`PROMPT_USAGE_SCOPES` pins that `PromptResponse.usage` is per-turn on every built-in (the SDK's own `Usage` doc says "across session"; the installed adapters report the turn — Claude resets its accumulator at turn activation, Codex reports the turn's last token count, pi sums the assistant messages after the turn's start index; OpenCode by live verification only), so a session total is the client's own running sum of turn reports and `UsageAccumulator.recordPromptUsage` replaces rather than sums. `promptUsageScope(agent)` answers `"turn"` for built-ins and custom agents alike. Both tables are probed in the installed Claude/Codex/pi dists and welded to this document by the drift suite.

`COST_GAUGE_INHERITANCE` pins whether the cumulative cost gauge (`usage_update.cost.amount`) carries the source session's total into a reopened (`session/resume` / `session/load`) or forked session: `{ agent, reopen, fork }`, each `"inherits"` or `"restarts"`. Claude is `reopen: "inherits"`, `fork: "restarts"` — Claude Code restores a session's saved totals on resume (claude-agent-sdk 0.3.277; earlier runtimes restarted at zero), while `session/fork` writes a new transcript without them. OpenCode and pi are `"inherits"` on both, because they derive the gauge from the stored transcript, which a fork copies. Codex reports no dollar cost, so its row is inert. `costGaugeInheritance(agent, custom?)` answers the row; an unknown or custom agent gets `COST_GAUGE_INHERITANCE_DEFAULT` (`"inherits"` on both — ACP defines `cost` as the cumulative session cost). Where the gauge inherits, the client seeds `UsageAccumulator.settleInheritedCost()` with the source's last known gauge — `AgentSessionRef.costGauge` for a reopen or a cold fork, the live parent's gauge for `agent.fork()` — so every reported cost (`usage.turn.cost`, `usage.session.cost`, the runner's `onUsage`) is the spend after the boundary, never the carried-over total. The seed is confirmed by the first reading: a first reading **below** it proves the agent restarted its gauge (a crash before the totals were saved, say), and nothing is subtracted; a reading that already arrived during the reopen is itself the inherited total and wins over the seed. This table is observed, not readable from a dist: the fork/resume live e2e fails when an installed agent stops matching its row.

### <a name="runner-events"></a>Events (`runner.on(name, listener)`)

Typed bus; returns an unsubscribe thunk. Names are the ACP `sessionUpdate` discriminants verbatim (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …) plus cross-cutting events: `session_update` (catch-all), `permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `steering`, `session_open`, `session_close`, `backend_error`. `steering` carries normal session context plus `{ response }`, the complete raw `_session/steering` response, after every resolved request; it never exposes the request's prompt or metadata, and thrown requests emit nothing. Every session-scoped payload carries `AcpEventContext`: `{ sessionId, backendId, label?, runId?, callIndex?, initializeMeta? }` — the engine stamps `runId`/`label`/`callIndex` on workflow agents, and `initializeMeta` is the session's stable initialize-response snapshot. `backend_error` remains connection-scoped with exactly `{ backendId, error }`.

### Interactive sessions

```ts
const session = await runner.openSession({ model: "claude", cwd: "/abs/dir" }); // held open
const turn = await session.prompt("first turn");            // { stopReason, text, response }
await session.prompt([{ type: "text", text: "..." }], { images });  // image blocks degrade to a
                                                                    // text note if unadvertised
const off = session.on("agent_message_chunk", render);      // session-filtered subscription
await session.setMode("default");                           // switch after host approval
await session.cancel();                                     // cancel the active turn only
await session.release();                                    // end session; pooled process survives
```

`session.prompt()` returns an `InteractiveTurn` whose `response` is the complete underlying ACP `PromptResponse`, including arbitrary response `_meta`; the existing typed-session-failure conversion remains authoritative and throws instead of returning a turn for those terminal failures.

`session.steer(content, { images?, promptMeta? })` is available only while `prompt()` is in flight. It adapts the same text/image content, sends caller metadata unchanged, and returns the complete raw extension response without validating or narrowing it. It never creates or owns a turn, output, usage, retry, or ordering lock; output remains on the original prompt's updates and response. Idle callers receive a host-side error directing them to `prompt()`. For an active prompt, acp-agents does not gate the wire call on parsed initialize metadata, `agentCapabilities._meta`, backend names, versions, or `ACP_EXTENSION_SUPPORT_MATRIX`. A host that owns steering availability must inspect raw `session.capabilities?.initializeMeta` itself.

Vendor metadata is transported transparently. On `session/new`, static backend `sessionMeta` is the lowest layer, caller `meta` wins over it, backend-computed protocol-critical session keys win direct collisions, and the host `runId` stamp wins last. On `session/prompt`, backend-computed protocol-critical keys such as `outputSchema` win direct collisions with caller `promptMeta`. Steering has no backend-computed metadata layer. These collision rules never delete unrelated keys, including arbitrary nested values.

`InteractiveSessionOptions`: `cwd` (required, absolute), `model`/`tier`, `mode` (strict ACP session mode), `configOptions` (exact ACP ids/values, applied in sorted order after model), `toolNames`/`disallowedToolNames`, `onPermissionRequest` (session-scoped, wins over runner-wide), `onElicitation` (session-scoped, wins over runner-wide but cannot affect initialize-time capability advertisement), `mcpServers`, `meta`, `retainSessionLog` (default `false` for held-open sessions; set `true` when the host wants the runner to keep the full transcript), `keepSession` (skip the release-time `session/close` so the session stays re-openable after `release()`). `session.text` / `session.history` expose the retained assistant text and message/tool history; `session.modes` exposes the advertised catalog and current mode; `session.sessionRef` is the re-attach handle (same `AgentSessionRef` shape as `onSessionOpen`) to persist before releasing.

**Session lifecycle (reattach and fork)**:

```ts
const listed = await runner.listSessions({ model: "claude", cwd: "/abs/dir", cursor });
await runner.deleteSession({ model: "claude", sessionId });

const loaded = await runner.loadSession({ sessionId, cwd: "/abs/dir" });
const resumed = await runner.resumeSession({ sessionId, cwd: "/abs/dir" });
const forked = await runner.forkSession({ sessionId, cwd: "/abs/dir" });
```

`listSessions()` returns the SDK `ListSessionsResponse` (`sessions: SessionInfo[]`, plus `nextCursor?`); `deleteSession()` resolves to `void`. `loadSession()`, `resumeSession()`, and `forkSession()` return live `InteractiveSession`s tracked and released like `openSession()` sessions. Their signature is `(opts: ReattachSessionOptions) => Promise<InteractiveSession>`: they accept the same session-scoped fields as `openSession()` plus the required `sessionId`, and `mcpServers` defaults to `[]` on the wire. For `loadSession()` and `resumeSession()`, that id is the session being reopened. For `forkSession()`, it is the **source** session id; ACP returns a **new** independent session seeded with the source's conversation context, and that new id is exposed as both `forked.sessionId` and `forked.sessionRef.sessionId`.

`loadSession()` registers the caller-supplied id before sending `session/load`, so replayed `session/update` history is accumulated and permissions during replay are routed. After it resolves, replay is visible in `session.text` / `session.history`. `InteractiveSession.awaitCurrentTurn()` resolves with the loaded session's founding turn (the turn that was in flight when the host died) — the REPL broker's re-attach arm — using the **`_session/loaded_turn` vendor extension** (the `_session/steering` precedent; advertised at initialize via `InitializeResponse._meta.loadedTurn.supported === true`, served by the in-repo `@automatalabs/pi-acp` and `@automatalabs/codex-acp`): right after the load response the seam asks `_session/loaded_turn/query` whether the founding turn is still running — `completed` (observably completed while the host was down; the replay's trailing assistant message is its FINAL message, resolved immediately with the real accumulated text, stop reason synthesized `end_turn`), `interrupted` (ended without a terminal message, nothing running — the safe-re-issue class), or `running` (kept attached, waiting for the authoritative `_session/loaded_turn/ended` notification — pushed with the stop reason, or the error, when the turn ends; a quiet gap is only a progress-stream gap, never terminal evidence, and the wait is bounded by `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS`, default 15 min). A backend WITHOUT the extension (the built-in claude and opencode backends today) is classified by the **observation path** — the post-load continuation watch plus the replay probe under the **connection-death contract** (phase-F review round 2, restricted to the VERIFIED BUILT-INS in round 3 — a custom registry backend's connection-death behavior is not live-verified, so its quiet observation window is not terminal evidence and degrades to the keep-attached still-running wait): the built-in ACP servers terminate in-flight turns when the client connection closes (live-verified — claude-agent-acp/pi-acp exit on connection close and cancel, `opencode acp` exits on stdin EOF, codex-acp ends/kills the codex process) and their persisted transcripts hold only completed messages, so after a daemon crash the founding turn is NEVER still running at the backend and the replay's trailing content is authoritative — an assistant message is the turn's terminal message (completed-while-down, resolved with the real accumulated text), anything else means the turn died mid-way (the safe-re-issue class — nothing running, no duplication possible). The one caveat — content still in flight when the load response resolved — is absorbed by the bounded post-load continuation watch (`AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS`, default 1 s): any CONTENT update after the load boundary is live continuation, the authoritative still-running signal, and flips the classification to the keep-attached wait. A query FAILURE on an extension backend falls through to the same observation path (a possibly-running call is never released-and-re-issued). A `running` turn past the max-wait bound rejects with the re-armable `LoadedTurnStillRunningError` (the broker re-arms the seam on the still-attached session — a later terminal notification or a cancel still settles the call), and a turn that failed at the backend rejects with `LoadedTurnFailedError` (a definite rejection, never a re-issue). A seam that rejects with the NON-re-armable still-running class (a third-party adapter that can never observe the terminal state) is NOT re-invoked — an immediate recursive re-arm would spin in an unbounded microtask/warning loop (phase-F review round 3): the broker keeps the loaded session attached and waits for the terminal state from the session-level `_session/loaded_turn/ended` surface (when the backend pushes one anyway), the call's cancel (settled as the recoverable `AGENT_CANCELLED`), the session's release (the process died — the safe-re-issue class), or the client-presence drain's forced stop (settled durably at the bound). `resumeSession()` reattaches without replay. `forkSession()` can register only after `session/fork` returns its new id, matching `session/new`; subsequent updates, permissions, and prompts route exclusively under that response id. All three adopt response `configOptions`/`modes`; a routed model id is then sent verbatim, while `mode` is validated and applied strictly from the response mode catalog. The upstream SDK marks `session/fork` **UNSTABLE** / `@experimental`; this wrapper may need to track future protocol changes.

Where does `sessionId` come from? Three sources: `listSessions()`, an `InteractiveSession.sessionRef` you persisted, or — for one-shot workflow agents — `WorkflowRunResult.agentSessions`. Every `agent()` call that opened a live session lands one `AgentSessionRecord` (`AgentSessionRef` + `callIndex`/`label`/`phase`/`keptOpen`) on the run result (even with `journaling: false` — it rides the result, not the journal), in the journal entry (so resume replays it), and on the `agentEnd` event/snapshot. The one-shot-plan round trip:

```ts
const run = await manager.runSync(planScript, args);        // plan produced one-shot
await planStore.save({ plan: run.result, session: run.agentSessions?.[0] });
// later — "discuss this plan" with the agent's full context:
const saved = await planStore.load(id);
const chat = await runner.loadSession({
  sessionId: saved.session.sessionId,
  cwd: saved.session.cwd,
  model: saved.session.backendId,
});
await chat.prompt("Revise section 3 — the user wants X.");
```

Set `agent(prompt, { keepSession: true })` in the script (or `RunOptions.keepSession` on direct `run()` calls) when you intend to re-open: it skips the release-time best-effort `session/close`, guaranteeing the agent-persisted session is untouched. Without it the record is still surfaced, and the four first-class agents keep closed sessions loadable — but `keepSession` is the explicit, agent-agnostic contract. Check `reopen.load`/`reopen.resume` before offering re-attach and optional `reopen.fork` before offering a fork in UI: an agent that persists nothing advertises none of them, and its sessions are reachable only while held open (`openSession`). The fork flag is optional so records written before this field existed remain valid.

Lifecycle methods are capability-gated after initialize. In particular, `forkSession()` requires `sessionCapabilities.fork`; when absent it throws a non-recoverable `WorkflowError` naming the backend and `session/fork` before any fork request is sent. The installed `@agentclientprotocol/claude-agent-acp@0.79.0` advertises `loadSession: true` plus `sessionCapabilities` for list/delete/resume/close/fork; its `session/fork` copies the persisted transcript to a new session id and returns only that id — the fork is not a live session until `session/resume` or `session/load` opens it (verified live on 0.76.0: prompting the forked id directly fails with "Session not found", while resume-then-prompt carries the source conversation's context). `@automatalabs/codex-acp` (workspace) advertises `loadSession: true` plus list/delete/resume/close/fork; its fork implementation creates an independent Codex thread through `thread/fork` — which subscribes the connection to the new thread exactly like `thread/resume` does — keeps that subscription, and returns the new ACP session id as a **live** session that publishes its available commands and MCP startup status like a resumed one and is promptable at once (the liveness and the `available_commands_update` publish were verified live, and the codex-acp unit test pins the fork installing its session and publishing `available_commands_update`; the MCP startup status publish follows from the removed fork publish gate and is not separately verified; upstream codex-acp unsubscribes the forked thread until it is reopened, which is why a custom entry wrapping upstream must declare `id-only`). OpenCode advertises load/list/resume/close/fork (also verified live). `@automatalabs/pi-acp` advertises load plus list/resume/close/fork and deliberately omits delete; unsupported lifecycle methods still fail through the same gate. The `_session/loaded_turn` extension (turn-terminal state for loaded sessions — the re-attach arm's authoritative completion evidence, see the `loadSession()` paragraph above) is advertised and served only by the in-repo `@automatalabs/pi-acp` and `@automatalabs/codex-acp`; claude and opencode do not advertise it, and their re-attached calls are classified by the seam's OBSERVATION path instead — the post-load continuation watch plus the replay probe under the connection-death contract (see the `loadSession()` paragraph): the built-in ACP servers terminate in-flight turns when the client connection closes (live-verified), so the replay's trailing content is authoritative and a possibly-running call is NEVER released-and-re-issued (phase-F review round 2 — re-issue is reserved for the observably-dead classes: the interrupted classification, a transcript that never received its prompt, a dead session, or a third-party adapter with no seam at all). The `ACP_EXTENSION_SUPPORT_MATRIX` in `packages/acp-agents/src/protocol-coverage.ts` pins all eight rows.

### Capabilities

The one-time `initialize` handshake negotiates per-connection capabilities, readable as `NegotiatedCapabilities` (exported). It includes the full `agentCapabilities`, `agentInfo`, raw initialize `_meta` as `initializeMeta`, advertised `authMethods`, and derived standard ACP lifecycle/auth/provider fields. It deliberately does not expose derived steering, loaded-turn, or custom-metadata-gating fields. Extension owners inspect `initializeMeta` at their own decision point. Prompt-content flags are **booleans**: `capabilities.agent.promptCapabilities?.image === true` etc. You rarely need to gate manually — `adaptPromptContent` already degrades unsupported `image`/`audio`/`resource` blocks to a bracketed text note naming the backend. The client truthfully advertises: `fs`/`terminal` only when you registered handlers, plus `session.configOptions.boolean` always (boolean config options are handled natively). The installed ACP SDK has no `ClientCapabilities` field for MCP-over-ACP; the real declaration is a `session/new` MCP server entry `{ type: "acp", name, serverId }`, gated before the session is opened.

### MCP-over-ACP client handlers

`clientHandlers.mcp` serves client-hosted MCP servers over ACP. The consumer owns the MCP implementation and this library only routes opaque payloads with session context:

```ts
const runner = createAcpRunner({
  clientHandlers: {
    mcp: {
      connect: async (params, ctx) => ({ connectionId: `mcp:${params.serverId}` }),
      message: async (params, ctx) => ({ ok: true, echo: params }),
      disconnect: async (params, ctx) => {},
    },
  },
});

await runner.run("use my local tool", {
  cwd,
  mcpServers: [{ type: "acp", name: "local", serverId: "local-acp-mcp" }],
});
```

All three `mcp` methods are required together. Partial objects throw at runner construction. `mcp/connect` receives the SDK shape `{ serverId, _meta? }`; the client allocates and returns `{ connectionId }`. Later `mcp/message` and `mcp/disconnect` carry only `connectionId`, so the runner maps `serverId -> sessionId` from `mcpServers` and `connectionId -> sessionId` from the connect response. On session release or connection death, every live MCP connection for that session gets a best-effort `disconnect` callback.

Two gates run before any prompt tokens are spent:

- The agent must advertise `agentCapabilities.mcpCapabilities.acp === true`; otherwise the ACP server config fails with non-recoverable `SCRIPT_VALIDATION_ERROR`.
- The runner must have a complete `clientHandlers.mcp`; declaring `{ type: "acp" }` without a handler is also a non-recoverable config error.

Installed backend status verified from the packaged dists: `@agentclientprotocol/claude-agent-acp@0.79.0` advertises `http`/`sse` MCP support but no `acp`, `@automatalabs/codex-acp` (workspace) advertises `mcpCapabilities: { acp: false, http: true, sse: false }` and rejects ACP MCP config internally, OpenCode advertises HTTP/SSE MCP support, and `@automatalabs/pi-acp` serves stdio, Streamable HTTP, and SSE while advertising `{ http:true, sse:true }`. Pi also consumes the stable MCP base protocol plus sampling, roots, and form/URL elicitation; client-hosted `acp` remains runner-owned.

---

## <a name="acpagent-sdk"></a>AcpAgent SDK

`AcpAgent` (exported from `@automatalabs/acp-agents`, its home; `@automatalabs/workflows` re-exports it like `InteractiveSession`) is the SDK front door for a **held-open** agent: one dedicated ACP process per agent (and per fork), a lazy constructor that spawns nothing until first use, turns that serialize in a per-agent FIFO, live forks that see everything the parent committed so far, and cold reopen of a recorded session from its `AgentSessionRef`. It composes the same primitives as `AcpAgentRunner` and `InteractiveSession` — `PooledConnection`, `SessionHandle`, the backends, the model-routing grammar, the structured-output tool host — adds a per-agent host for client-side [function tools](#acpagent-function-tools), and owns no pool: every agent is its own process, a parent's `close()` never affects its forks, and a long-lived agent never starves `run()` calls. Claude, Codex, OpenCode, pi, and registered custom backends are all first class.

### Quick start

```ts
import { AcpAgent } from "@automatalabs/acp-agents";

const catalog = await AcpAgent.probe({ modelFilter: "opus" });   // like the MCP workflow tool action:"config"
const primary = new AcpAgent({ cwd: "/abs/path/to/project", model: "claude/opus[1m]" }); // nothing spawned yet
primary.on("agent_message_chunk", (e) => {                        // streaming / events, this agent only
  if (e.content.type === "text") process.stdout.write(e.content.text);
});

const turn = await primary.prompt("Help me investigate the flaky test in src/queue.ts.");
turn.response;   // the verbatim PromptResponse, `_meta` intact
turn.text;       // this turn's assistant text
turn.messages;   // the same turn per message: each message's text blocks, tool calls, and thoughts

// The same turn as an async iterable: this turn's events, then the terminal `turn`.
for await (const event of primary.stream("Now reproduce it under load.")) {
  if (event.type === "agent_message_chunk" && event.content.type === "text") process.stdout.write(event.content.text);
  else if (event.type === "tool_call") console.error(`\n→ ${event.title}`);
  else if (event.type === "turn") console.error("\n", event.turn.usage.turn);   // exactly what prompt() would have resolved
}
// `break` out of the loop and the turn is cancelled (session/cancel) before the loop exits.

const planner = await primary.fork();                    // a NEW process seeded with everything committed so far
const plan = await planner.prompt("Plan the implementation of the fix.", {
  mode: "plan",                     // sticky: applies to this and every later turn of `planner`
  meta: { trace: "plan-1" },        // turn `_meta`, passed through verbatim
});
await primary.prompt("Meanwhile, list the callers of enqueue()."); // primary keeps going, unaffected
await primary.setModel("claude/sonnet");                 // mid-session switch: same backend, sticky; primary.model follows
const reviewer = await primary.fork();                   // includes the follow-up too, and starts on the switched model
// plan.response / plan.updates / plan.raw carry everything the harness sent back — nothing is stripped

await Promise.all([planner.close(), reviewer.close()]);
await primary.close({ keep: true });                     // the process is gone; the session stays re-openable
// The same session on a fresh process. The ref carries no model, so pass the agent's back; `resume`
// replays nothing (history/text start empty) — `AcpAgent.load(ref)` replays the transcript instead.
const again = await AcpAgent.resume(primary.sessionRef!, { model: primary.model });
```

`await using agent = new AcpAgent({ cwd })` closes the agent at scope exit (`Symbol.asyncDispose` is `close()`). `AcpAgent.open(options)` is `new AcpAgent(options)` + `ready()`; on an open failure the agent is closed and the mapped error rethrown.

### Options — `AcpAgentOptions`

- `cwd` (required) — an **absolute** path that exists and is a directory, validated synchronously in the constructor and the statics **before** any process spawns (`INVALID_ARGUMENT` otherwise); sent as the `session/new|fork|resume|load` `cwd`.
- `model?` — a routing spec with the runner's grammar (`resolveModelRoute`): the first `/`-segment routes to a registered custom backend (wins) or a built-in; the remainder is the backend's model id **verbatim**, sent as `session/set_config_option { configId: "model" }` right after the session opens. An unrouted spec (no known first segment) goes whole to the default backend (`AGENTPRISM_DEFAULT_BACKEND`, else `claude`). Omitted = default backend, no model selection. This is the model the agent **starts** on: `setModel(spec)` and a per-turn `model` switch it mid-session, on the same backend (see [Serialization](#acpagent-serialization)), and `agent.model` follows.
- `mode?` — explicit ids are strict (an unadvertised id fails at open); omitted = the backend's default when the live catalog advertises it (Claude `auto`, Codex `agent`, OpenCode `build`; pi/custom none).
- `configOptions?` — applied verbatim via `session/set_config_option` in ascending id order after model selection. `"model"` is reserved (rejected in the constructor); an id the agent did not advertise fails at open with `INVALID_ARGUMENT` listing the advertised ids.
- `schema?` — a session-level [typebox](https://github.com/sinclairzx81/typebox) contract (see [Structured output](#acpagent-structured-output)).
- `schemaRetries?` (default `0`) — the opt-in structured repair ladder (see [Structured output](#acpagent-structured-output)): the number of **extra** turns `prompt()` may spend re-prompting the same session when a schema is active and the turn ended with `structured` absent; an integer ≥ 0, `INVALID_ARGUMENT` in the constructor otherwise. `0` keeps `prompt()` exactly one turn. Overridable per turn; inherited by forks.
- `mcpServers?` — client-provided MCP servers (stdio/http/sse/acp), capability-gated exactly like the runner.
- `tools?` — client-side function tools (`AcpAgentToolDefinition[]`), served to the agent over HTTP MCP from a per-agent local host injected into `mcpServers` as `agent_tools` (see [Function tools](#acpagent-function-tools)). Names are validated in the constructor (`INVALID_ARGUMENT` before any spawn); an agent that does not advertise `mcpCapabilities.http` fails the open with `INVALID_ARGUMENT` — tools are never silently dropped. Inherited by forks, each on a host of its own.
- `permissions?` / `onPermissionRequest?` / `onElicitation?` — the headless `ToolPolicy` auto-policy (allow/deny lists plus `defaultOutcome`), the session-scoped async permission resolver, and the elicitation responder (its presence is what advertises `elicitation` at initialize). The resolver, when present, answers **every** permission request — the runner's default precedence — and `permissions` is the headless fallback consulted only without one.
- `meta?` — generic `session/new` `_meta` passthrough, layered under backend-computed keys and, when `raw !== false`, over `backend.rawMessagesMeta()`.
- `systemPrompt?` — backend-neutral `{ replace?, append? }` system-prompt instructions (see [System prompt instructions](#system-prompt-instructions)): validated against the routed backend in the constructor (and in `fork()` / the statics) **before any process spawns** — a field the backend cannot carry (OpenCode, custom backends), an unknown field, or a blank string is `INVALID_ARGUMENT`, never a silent no-op — then sent on `session/new|resume|load|fork` and an id-only fork's reattach in the backend's dialect (Codex `_meta.baseInstructions` / `_meta.developerInstructions` — a live Codex fork gets them from its `session/fork` request alone, threaded into `thread/fork`; Claude and pi `_meta.systemPrompt`). Wins over the same key in `meta`; inherited by forks and overridable there.
- `label?` — stamped on every event context and every `WorkflowError.agentLabel`, never on the wire.
- `backends?` — a custom-backend registry merged over `AGENTPRISM_BACKENDS` like `createAcpRunner({ backends })`; read once in the constructor (malformed = `INVALID_ARGUMENT`); forks inherit it and cannot override it.
- `signal?` — agent-lifetime abort (see the table below); never inherited by forks.
- `retainHistory?` (default `true`) — keep the session log across turns so `history`/`text` are cumulative and a fork can seed its child; `false` keeps only the latest turn.
- `raw?` (default `true`) — ask the backend for its vendor notification stream (`Backend.rawMessagesMeta()`; the Claude backend answers `{ claudeCode: { emitRawSDKMessages: true } }`) so `_claude/sdkMessage` reaches `on("raw_message")` and `turn.raw`. A session `schema` turns them on for Claude regardless, because the native schema channel needs them.
- `authStore?` / `providerStore?` — optional shared stores. Auth is **default-off**: without them each agent uses its own login, and an ACP `-32000` surfaces as `AUTH_REQUIRED`. Forks share the parent's stores.
- `clientHandlers?` — client-side fs/terminal/mcp handlers advertised at initialize (validated like the runner's).

Read-only members: `backendId`, `cwd`, `label`, `model` (the model this agent is **on**, as a routing spec that leads back to the same backend — `<backendId>/<model id>`, e.g. `"claude/opus[1m]"`: the constructor's until a `setModel()` or per-turn `model` applied, then the switched one; `undefined` when nothing was ever selected; inherited by forks taken after the switch, and what a cold reopen needs back), `state` (`idle` → `opening` → `ready` ⇄ `busy` → `closed`), `sessionId` / `sessionRef` (retained after close — they drive the cold statics), `capabilities` (`NegotiatedCapabilities`), `configOptions` (the latest echoed catalog), `modes`, `history` / `text` / `messages` (the retained log, seeded from the parent on a fork; `history` is per chunk — one entry per streamed `agent_message_chunk` and per `tool_call`, so its length is not a message count — `text` folds the same retained assistant messages exactly like `turn.text`: distinct messages joined by a blank line, a `load` replay included; and `messages` is that log as `AcpAgentMessage`s — per message, each with its tool calls and thoughts, a `load` replay's user prompts included, the same fold as [`turn.messages`](#acpagent-turns) — holding only the latest turn under `retainHistory: false`), `replay` (verbatim `session/update` records received before the session was ready — a `load` replay or a fork's pre-response replay; the latter is in `replay` only, never in `history`/`text`/`messages`, whose seed is the parent's snapshot), `usage` (the running session sum), `schema`, and `traits` (below). Every getter is readable after `close()` and returns retained values or copies.

**Traits.** `agent.traits` is an `AcpAgentTraits` (frozen; a fresh object per read) describing the backend this agent runs on: `backendId`; `custom` (a registry backend rather than a built-in adapter — a registry lookup, so a custom entry that shadows a built-in name is `custom`); `defaultModeId` (the mode selected when `mode` is omitted and the catalog advertises it); `fork` (the `FORK_SESSION_TRAITS` row the fork choreography follows, or a custom entry's declaration — `disposition` / `reattach` / `cwd`); `systemPrompt` (`{ replace, append, source }` — which halves of `systemPrompt` the backend carries and where that answer came from: `table` for a built-in's `SYSTEM_PROMPT_SUPPORT` row, `advertised` for the live agent's initialize advertisement, `none` when there is no channel — every custom backend before open, since `CustomAcpBackend` never carries the neutral instructions); `steering` and `loadedTurn` (`supported` / `not-advertised` / `unknown` for the `_session/steering` and `_session/loaded_turn/query` extensions); `structuredOutput` (how a `schema` reaches the agent, derived from the `Backend` object's behavior, never its id: `session-meta` — Claude; `turn-meta` — Codex; `client-tool` — pi, OpenCode, custom); and `promptUsage` (`turn`, the `PROMPT_USAGE_SCOPES` pin). Before the agent opens, every answer comes from the executable tables in `protocol-coverage.ts` (`steering`/`loadedTurn` are `unknown` for a custom backend). Once the connection is up, the agent's initialize **advertisements win where they exist**: `steering`/`loadedTurn` become `supported` or `not-advertised` from `initializeMeta.steering.supported` / `initializeMeta.loadedTurn.supported`, and `systemPrompt` takes the advertised booleans with `source: "advertised"` — pi under the bare `_meta.systemPrompt` block (`{ replace, append }`), the Codex fork under `agentCapabilities._meta["@automatalabs/codex-acp"]` (`baseInstructions` → `replace`, `developerInstructions` → `append`); Claude advertises nothing and stays `table`. The traits describe, they do not gate: the pre-open validators (`assertSystemPromptSupported`, the fork cwd rule) keep reading the tables so a refused option is refused before a process exists. `AcpAgent.traits(spec?, { backends? })` returns the table-based traits for the backend `spec` routes to — exactly the constructor's routing — without spawning anything; `describeBackendTraits(backend, registry, live?)` is the function behind both.

### <a name="acpagent-turns"></a>Turns — `prompt()` and `AcpAgentTurn`

`prompt(content, options?)` sends one `session/prompt` and resolves an `AcpAgentTurn` for **every** `PromptResponse` the wire returned (`stream(content, options?)` is the same turn observed as an async iterable of its events — see [Streaming a turn](#acpagent-stream)). Nothing is stripped and no `stopReason` is thrown on:

- `response` — the wire `PromptResponse` object with `_meta` intact (Claude's quota meta, Codex's typed-failure meta, anything else the adapter attaches). `stopReason` is `response.stopReason` (`refusal`, `max_tokens`, `cancelled` included — unlike `run()`, none of them is an error here).
- `text` — this turn's assistant messages joined by a blank line (the `run()` fold): exactly the text-bearing entries of `messages`, joined by `"\n\n"`.
- `messages` — this turn as `AcpAgentMessage[]`, folded from `updates`: `{ role: "user" | "assistant", content, toolCalls, thoughts, receivedAt }`. The assistant-message boundary is **the `text` fold's**: text chunks concatenate into one message until a `tool_call`, `tool_call_update`, `agent_thought_chunk`, `plan` / `plan_update` / `plan_removed` or `user_message_chunk` event (or a changed ACP `messageId`) marks a boundary, after which the next text chunk opens a new message; bookkeeping updates (`usage_update`, mode, commands, config, session info) never break one. `content` holds the message's blocks in order — consecutive text chunks fold into one text block (the first chunk's fields, the concatenated text; the verbatim chunks stay in `updates`), other blocks (image, audio, resource, resource_link) as sent. Tool calls attach to the assistant message in progress and open one when none is, so a turn that starts with a tool call has a leading assistant message with no text; a `tool_call_update` updates the call where it lives. Thoughts **lead**: every installed adapter streams its reasoning before the text or tool call it produced, so `agent_thought_chunk`s attach to the assistant message that receives the next assistant content (a thought followed by a user message or the end of the turn is an assistant message of its own). A run of `user_message_chunk`s (a steer the agent echoes, a `load` replay's prompts) is one user message. `receivedAt` is the first folded update's.
- `updates` — every `session/update` of the turn as `{ update, receivedAt }`, structuredClone'd so nested `_meta` survives.
- `raw` — every vendor notification of the turn as `{ method, message, receivedAt }`. Today only Claude's `_claude/sdkMessage` exists; the `_session/loaded_turn/ended` notification is consumed by the seam and never appears here.
- `toolCalls` — `tool_call` and `tool_call_update` folded by `toolCallId` in first-seen order: `{ toolCallId, name?, title, kind?, status, rawInput?, rawOutput?, content?, locations?, meta? }`, where `meta` is the shallow merge of every `_meta` seen for that id and `status` is the last one seen (`pending` when the agent sent none). It is the flattening of `messages[*].toolCalls` — one fold, not two.
- `permissions` / `elicitations` — the resolved permission and elicitation events of the turn.
- `usage` — `{ turn, session, response? }`. **`turn` is this turn's `response.usage`** mapped to `AgentUsage` (every installed adapter reports the turn, not the session — the `PROMPT_USAGE_SCOPES` pin; the ACP SDK's own "across session" doc is not what the adapters send), with `cost` as the clamped delta of the cumulative `usage_update` cost gauge across the turn, measured from a baseline that excludes whatever total the gauge inherited from before this agent held the session (see `COST_GAUGE_INHERITANCE` under [Protocol passthrough](#protocol-passthrough)); when the response carries no `usage`, tokens fall back to the context-token gauge delta exactly like `UsageAccumulator.delta()`. **`session` is the running per-field sum of the turns this agent ran** (starting at zero at open/fork/resume/load — replayed history and the parent's turns are not counted; `cost` is the latest gauge value less the inherited total, so it is this agent's own spend). `response` is `response.usage` verbatim.
- `structured?` / `structuredError?` / `structuredAttempts?` — when a schema was active: the validated object, or why it is absent (the **last** attempt's failure when the repair ladder ran), and the turns this `prompt()` spent — `1` plus the repair turns the `schemaRetries` ladder actually ran, so `1` under the default budget. Without a budget there is no re-prompt; with one, see [Structured output](#acpagent-structured-output). All three are absent when no schema was active.
- `history` — this turn's accumulator entries (copies). They are **per chunk**, not per message: one `assistant`/`text` entry per `agent_message_chunk` the agent streamed and one `tool`/`toolCall` entry per `tool_call`, so `history.length` is not a message count (a two-chunk answer is two entries) — `text` is the folded, per-message view of the same chunks.

`AcpAgentPromptOptions`: `images?` (appended as image blocks, degraded like the runner when unadvertised), `meta?` (turn `_meta` passthrough — backend keys win direct collisions like `mergeTurnMeta`), `model?` (a mid-session model switch with `setModel()`'s validation, applied via `session/set_config_option { configId: "model" }` **before** the turn, inside the FIFO and **ahead of** `configOptions` and `mode` — open's order; `agent.model` follows), `configOptions?` and `mode?` (applied via `session/set_config_option` / `session/set_mode` **before** the turn, inside the FIFO, with the constructor's validation), `schema?` (a per-turn override, Codex only — see below), `schemaRetries?` (this turn's repair budget, winning over the constructor's; an integer ≥ 0 or `INVALID_ARGUMENT` before anything is sent), `signal?`. `model`, `configOptions`, and `mode` are **sticky** for the rest of the session, and every per-turn option is validated before anything is sent — a rejected one means the others of the same call are not sent either.

**Typed session failures reject.** When the agent walls the turn with codex-acp's negotiated typed session failure (a terminal `_meta` record, or the turn-raised latch on an empty turn), `prompt()` rejects with the runner's mapped `WorkflowError` (`mapTypedSessionFailure`: the same `code`, `recoverable`, `details`, `providerUsageLimitContext` contract) carrying the **complete** turn as a non-enumerable `error.turn` — verbatim `response` incl. `_meta`, `usage`, `updates`, `raw`, `toolCalls`, `history`. Narrow with `isAcpAgentTurnError(error)`. The walled turn's tokens are still added to `usage.session` before the rejection, and the agent stays `ready`.

### <a name="acpagent-serialization"></a>Serialization, steering, cancellation, abort

`prompt`, `stream`, `fork`, `setModel`, `setMode`, `setConfigOptions`, and `close` run **FIFO** per agent: each waits behind every earlier queued operation, and the first of them (or `ready()`) opens the session. `steer(content, { images?, meta? })` and `cancel()` overlap the queue: `steer` sends the `_session/steering` extension for the turn in flight and returns the raw response (with no turn in flight it rejects with `INVALID_ARGUMENT`); `cancel()` sends **one** `session/cancel` for the turn in flight (a no-op otherwise) and resolves at the notify boundary — the in-flight `prompt()` then resolves with `stopReason: "cancelled"` when the agent honors it. A turn that ignores the cancel for the `CANCEL_NOT_HONORED_GRACE_MS` grace ends in **process disposal without a wire `session/close`**: the in-flight turn rejects, the agent is closed, and `sessionRef` stays re-openable because nothing was closed on the wire. `cancel()` never touches queued turns, and it reaches only a turn whose `session/prompt` is **on the wire** (a repair turn of the `schemaRetries` ladder included — a cancelled attempt ends the ladder): a `prompt()` that has started (`state` is `busy`) but is still opening the session (the lazy first turn) or applying its per-turn `model`/`configOptions`/`mode` is not cancellable yet, and a `cancel()` in that window is a no-op the turn never sees. A per-call `signal` covers every window — while queued it rejects without sending, in the pre-wire window it rejects with the reason at the next check with nothing sent for that turn, and in flight it sends the one `session/cancel` — so use per-call signals to stop a specific turn. `setMode(id)` and `setConfigOptions(record)` apply the same strict/advertised-id validation as the constructor and stick for the session.

**Switching the model — `setModel(spec)`.** The model is a session setting, not part of the agent's identity: `setModel(spec)` (queued like `setMode`) and the per-turn `prompt(…, { model })` move the session to another model of the **same backend**, sticky for the rest of the session. The spec is resolved with the rule `fork()` applies to a `model` override — the runner's routing grammar, and the route must land on this agent's backend and poolKey, so write `"<backendId>/<model id>"` (`"claude/opus[1m]"`, `"pi/openrouter/some-model"`); an unrouted spec goes to the default backend and passes only when that is this agent's — otherwise `INVALID_ARGUMENT` naming both backends (`AcpAgent.setModel(): model "codex/x" routes to backend "codex" but must stay on backend "claude"`), before anything is sent. A backend-only or blank spec is refused the same way: there is no wire form for "unselect". The switch is then applied exactly as open selects a model — `session/set_config_option { configId: "model" }` with the routed remainder **verbatim**, no aliases, coercion, catalog matching, or fallback; the agent's catalog and validation are authoritative, and a wire rejection maps through the normal error path with `model` unchanged. On success `agent.model` is the routed spec (`configOptions` shows the echoed catalog), so a fork taken afterwards starts on the switched model and a cold reopen inherits it through `AcpAgent.resume(ref, { model: agent.model })`. `"model"` stays reserved in `configOptions`; `setModel` and the per-turn `model` are the one way to move it after open.

| Signal | Aborted before the call | Aborted while queued | Aborted in flight | Result |
|---|---|---|---|---|
| constructor `signal` | every operation rejects with `signal.reason`; nothing spawns (`ready()` too) | every queued promise rejects with `signal.reason` | an in-flight `prompt` gets one `session/cancel`; an in-flight open/fork/reattach has its process disposed | the affected promises reject with `signal.reason` untouched (never a `WorkflowError`, never a resolved `cancelled` turn); `state` is `closed` at once and the agent tears down like `close()` after the in-flight operation settles |
| `prompt({ signal })` | rejects with the reason, nothing sent | the entry is removed and rejected, nothing sent | one `session/cancel`; the turn rejects with `signal.reason` after the wire settles, even if the agent answered `cancelled` | the agent stays `ready` |
| `stream({ signal })`, or leaving the iterator early (`break`, `return()`, `throw()`) | the first `next()` throws the reason, nothing sent | the entry is removed, nothing sent | one `session/cancel`; the iterator drains its buffered events, then throws `signal.reason` — an early exit instead reports `done` (`throw(e)` rethrows `e`) once the turn settled | the agent stays `ready` |
| `fork({ signal })` | becomes the **child's** constructor signal (never the fork operation's) | — | the child's open is aborted and `fork()` rejects with the reason | the parent is unaffected |
| statics `{ signal }` | the new agent's constructor signal | — | the open is aborted, the process disposed | — |
| `probe({ signal })` | `probeHarnessConfig` semantics: completed catalogs are kept, active probes aborted, queued targets report `probed: false` | | | the report, never a throw for per-target aborts |

A constructor-signal abort rejects every queued promise synchronously inside `signal.abort()`, so attach handlers up front (`Promise.allSettled`) when you queue several operations and then abort — the SDK does not pre-attach a `catch` to your promises. `close()` and `cancel()` are unaffected by aborts; `close()` never throws for an aborted or dead agent.

### Forks

`agent.fork(overrides?)` spawns a **new dedicated process**, sends `session/fork` for the parent's session id, and resolves a child `AcpAgent` whose transcript is everything the parent committed so far. The fork point is implicit: `fork()` is queued behind the in-flight turn, so the parent's persisted transcript is always complete and quiescent when the fork is taken (pi rejects busy forks; Claude would copy a partial turn). The parent keeps going, and closing either side never affects the other, so one recorded session can seed N parallel agents while the original stays open. `fork()` requires the agent to advertise `sessionCapabilities.fork` (otherwise the lifecycle `WorkflowError` — `INVALID_ARGUMENT` naming the backend and `session/fork` — before anything is sent).

The child inherits every constructor option except `label` (suffixed `<parent label>/fork-<n>`, or `fork-<n>`) and `signal` — `tools` and `permissions` included, the child running its own `agent_tools` host. `overrides` (`AcpAgentForkOptions`) may change anything but the backend — `backends`, `authStore`, `providerStore`, and `clientHandlers` are typed out; a `model` override must route to the same backend (poolKey-equal) or `INVALID_ARGUMENT`; `cwd` defaults to the parent's and a different cwd is rejected on backends whose fork cwd is `source-only`. The child's model (the one the parent is **on** when the fork is taken — a `setModel()` or per-turn switch included, not the parent's constructor option), `configOptions`, and `mode` are re-applied on the live forked session in wire order. Its `history`/`text` are seeded from a snapshot of the parent's retained log when the fork response carries no replay (so `retainHistory: false` on the parent leaves the child with only the parent's latest turn); a pre-response replay the agent streams under the new id (OpenCode) is buffered and lands in `child.replay` and the accumulator instead.

What a `session/fork` response *is* differs per adapter, and the SDK follows the welded `FORK_SESSION_TRAITS` table under [Protocol passthrough & coverage](#protocol-passthrough--coverage) rather than probing: on the `id-only` backend — **Claude** (`{ sessionId }` alone; prompting it fails with "Session not found") — the child releases the bare fork handle with `keepOpen` (no wire `session/close`) and reattaches the new id (`session/resume` preferred, `session/load` fallback — the child is seeded from the parent's snapshot) **before** applying model/config/mode and before its first turn, so the wire order is always `session/fork` < `session/resume` < `session/prompt` and the trap is impossible by construction; on `live` backends — **Codex** (the workspace fork keeps the forked thread subscribed and publishes its startup state like a resumed session), **pi**, and **OpenCode** — the fork handle is the session. Claude's fork cwd is `source-only` (its transcript store is keyed by the source cwd); Codex, OpenCode, and pi accept a different cwd. **Custom backends** declare their disposition as data on the registry entry — `fork: { disposition: "id-only" | "live", cwd?: "source-only" | "free" }` — and an entry wrapping claude-agent-acp (or upstream codex-acp, which unsubscribes its forks) **must** declare `id-only`; an undeclared entry is treated as `live`/`free` (the plain ACP contract). A declaration always beats a name that shadows a built-in.

### Cold reopen — `AcpAgent.resume` / `load` / `fork(ref)`

The statics rebuild an agent from a persisted `AgentSessionRef` (from `agent.sessionRef`, `InteractiveSession.sessionRef`, or `WorkflowRunResult.agentSessions`) on a fresh dedicated process: `resume(ref, options?)` sends `session/resume` (no replay), `load(ref, options?)` sends `session/load` (the agent replays the transcript before the response; it lands in `history`/`text`/`replay`, and the load boundary is marked so the re-attach classification holds), and `fork(ref, options?)` runs the trait-driven fork choreography on the recorded session with no parent to seed from, so on an id-only backend its reattach **prefers `session/load`** — the agent replays the forked transcript and it lands in the child's `history`/`text`/`messages`/`replay`, with the load boundary marked — and takes `session/resume` (an empty transcript) only when load is not advertised. The live `agent.fork()` keeps the opposite preference (resume, load as the fallback) because its child is seeded from the parent's snapshot.

Routing is by `ref.backendId` through the built-ins and the registry and **never falls back to the default backend**: an unknown backend id, a `poolKey` that does not match the currently resolved backend, or a `model` option whose first segment routes elsewhere all reject with `INVALID_ARGUMENT` before any process spawns (a `model` on the ref's own backend selects that model; an unrouted spec goes verbatim to the ref's backend). `cwd` defaults to `ref.cwd`; a cold `fork` must keep it on `source-only` backends. `AcpAgentReopenOptions` is `Partial<AcpAgentOptions>`. An `AgentSessionRef` carries **no model**: a reopen without `model` runs on the backend's current default, so pass the original agent's back — `AcpAgent.resume(ref, { model: agent.model })` — to keep the session on the model it was running (`agent.model` is the current one, a `setModel()` included). A backend that does not advertise the requested lifecycle method fails through the same capability gate as the runner (surfaced as `INVALID_ARGUMENT` naming the method) and leaves no process behind.

### <a name="acpagent-structured-output"></a>Structured output

A session `schema` drives each backend's native channel exactly like `run()`; each turn reports `structured` or `structuredError`, and `prompt()` is exactly one turn unless `schemaRetries` (constructor or per turn, default `0`) buys repair turns — see the ladder below.

| Backend | session-level `schema` | per-turn `schema` | result read from |
|---|---|---|---|
| `claude` | `_meta.claudeCode.options.outputFormat` on `session/new|resume|load|fork` (with `emitRawSDKMessages`) | rejected | the native result in the `_claude/sdkMessage` stream, validated |
| `codex` | nothing at `session/new`; `_meta.outputSchema` merged on **every** turn | allowed — replaces that turn's `outputSchema` | the final assistant message parsed as JSON, validated |
| `opencode` / `pi` / custom | the client-hosted `StructuredOutput` HTTP MCP tool injected into `mcpServers` when the agent advertises `mcpCapabilities.http`, plus the in-prompt contract (OpenCode and custom entries also forward `_meta.outputSchema`) | rejected | this turn's tool capture → the backend's native result (none on pi), validated → a validated final-text fallback (the last JSON object in the final message) |

The per-turn `schema` rule: allowed only where the backend carries the schema on the turn and does not embed it in the prompt (Codex among the built-ins); elsewhere `prompt()` rejects with `INVALID_ARGUMENT` naming the backend and pointing at the constructor option. The injected tool is registered on one `StructuredOutputToolHost` per agent (created lazily, disposed on `close()`; forks own their own), named `structured_output` (or `structured_output_2`, … when a caller's `mcpServers` already uses the name), and a capture belongs to **one** turn: it is consumed by the turn that produced it and a stale capture from a rejected turn is discarded before the next `session/prompt`. `structuredError` names every channel that applied (`no StructuredOutput capture; native result rejected: …; no JSON object in the final message`).

**Repair ladder — `schemaRetries`.** Off by default: `prompt()` sends one `session/prompt` and reports the miss. With `schemaRetries: n` (an integer ≥ 0, validated in the constructor and per call — `INVALID_ARGUMENT` otherwise, before anything spawns or is sent; the per-turn value wins for that `prompt()`; forks inherit the constructor's), a turn that ended `end_turn` with `structured` absent is followed, **inside the same queued operation**, by up to `n` repair turns on the same session. Each sends the runner's repair prompt — the one `repairPromptText` in `structured-output.ts` (package-internal, the runner's ladder selects through it too): the StructuredOutput-tool variant when the injected tool is active on the session, else the JSON variant, with the previous attempt's `structuredError` appended as `Validation error: …` — as text only (no images, no re-embedded contract; the schema is already in the session's context) and with the same turn `_meta`, so the native channel stays authoritative: Claude's session `outputFormat`, Codex's per-turn `outputSchema` (a per-turn `schema` rides its repairs too), the client-hosted tool on pi / OpenCode / custom. Every repair turn is a real turn — events fire, `stream()` yields them before the one terminal `turn`, `usage.session` and `agent.usage` accumulate, `cancel()` and `steer()` reach it, a per-call `signal` covers it — and the resolved `AcpAgentTurn` is the **final** attempt's (`text`, `messages`, `history`, `usage.turn`, `response`) plus `structuredAttempts` = 1 + the repairs actually run. When the budget is spent and the last attempt still missed, `structured` is absent and `structuredError` describes that last failure; `prompt()` never rejects for a schema miss. Only an `end_turn` miss is repaired: an attempt that ended `cancelled`, `refusal`, `max_tokens`, or `max_turn_requests`, or that was walled by a typed session failure, ends the ladder where it stands (the runner's ladder refuses to continue past those too). The next `prompt()` starts its own ladder.

### <a name="acpagent-function-tools"></a>Function tools — `tools`

`tools?: AcpAgentToolDefinition[]` gives the agent client-side functions it can call mid-turn: the SDK hosts them, the backend reaches them as MCP tools, and each result flows back into the turn like any other tool result.

```ts
import { AcpAgent, defineTool } from "@automatalabs/acp-agents";
import { Type } from "typebox";

const lookupTicket = defineTool({
  name: "lookup_ticket",                                     // ^[A-Za-z0-9_-]{1,64}$, unique per agent
  description: "Fetch one ticket from the tracker by id.",
  inputSchema: Type.Object({ id: Type.String({ minLength: 1 }) }),   // typebox, like `schema`
  async execute({ id }, ctx) {                                // `id` is typed from the schema
    const res = await fetch(`https://tracker.internal/api/tickets/${id}`, { signal: ctx.signal });
    if (!res.ok) throw new Error(`ticket ${id}: HTTP ${res.status}`);   // → an isError result for the agent
    return await res.text();                                  // string | content blocks | { content, isError? }
  },
});

const agent = new AcpAgent({ cwd, model: "pi", tools: [lookupTicket] });
agent.on("tool_call", (e) => console.error(e.title));        // pi announces it as mcp__agent_tools__lookup_ticket
const turn = await agent.prompt("Summarize ticket T-1042.");
```

**Definition.** `AcpAgentToolDefinition<TInput extends TSchema>` is `{ name, description, inputSchema, execute }`: `name` matches `^[A-Za-z0-9_-]{1,64}$` and is unique across the agent's tools; `inputSchema` is a typebox **object** schema (`Type.Object(...)`, JSON `type: "object"` — MCP `tools/call` arguments are an object, so any other top-level type is `INVALID_ARGUMENT` in the constructor) whose JSON Schema (`toJsonSchema`, top-level `$schema` stripped) is what `tools/list` advertises; `execute(input, ctx)` receives the arguments after typebox `Convert` + `Check` against that schema (a `"3"` reaches a `Type.Number()` field as `3`) and returns an `AcpAgentToolResult` — a string (one text block), an array of MCP content blocks, or a complete `{ content, isError? }` (an `isError: true` you set is forwarded as-is). The blocks are **MCP's** `ContentBlock` (`@modelcontextprotocol/sdk/types.js`: `text` / `image` / `audio` / `resource_link` / `resource` — the `tools/call` result shape the agent receives), not the ACP `ContentBlock` the rest of the AcpAgent surface uses for `prompt()` input, `AcpAgentMessage.content`, and the update events; a `{ type: "text", text }` block is valid in both. `defineTool(definition)` is an identity helper that infers `Static<typeof inputSchema>` for `input`. `ctx` is an `AcpAgentToolContext`: `sessionId`, `backendId`, `label?`, `toolCallId?` — the ACP `tool_call` id the backend surfaced for this call when the SDK could correlate it (the latest unsettled `tool_call` of the turn in flight whose standard `name` or `title` is the tool's name or ends in `__<name>`; best-effort, `undefined` otherwise) — and `signal`.

**Hosting.** An agent with a non-empty `tools` runs its own local tool host (`AgentToolHost`, the `StructuredOutputToolHost` pattern generalized): an in-process Streamable HTTP MCP server bound to `127.0.0.1` on an ephemeral port behind an unguessable token path, serving `tools/list` and `tools/call` for every definition. It binds at open, is a separate server from the structured-output host (a `schema` and `tools` coexist as two `mcpServers` entries), and closes with the agent — `close()`, the constructor abort, process death. It is injected after the caller's servers as `{ type: "http", name: "agent_tools", url, headers: [] }` on `session/new`, `session/resume`, `session/load`, `session/fork`, **and** the id-only fork's reattach; the name becomes `agent_tools_2`, `_3`, … when a caller's server already holds it (the `structured_output` rule). Forks inherit `tools` (overridable; `fork({ tools: [] })` drops them) and every fork runs its own host, so a parent's `close()` never takes a child's tools away. An empty array is the same as omitting the option. `AGENT_TOOLS_SERVER_NAME` and `AGENT_TOOL_NAME_PATTERN` are exported.

**Results and errors.** A `tools/call` whose arguments fail the schema, or whose `execute` throws, rejects, or returns something outside the contract, answers the agent with an MCP result `{ content: [{ type: "text", text: <message> }], isError: true }` — the agent reads the message and can retry; it is never a transport or JSON-RPC error and never rejects the turn (`Invalid arguments for tool "<name>": <first errors>`; the thrown error's message; `Tool "<name>" returned undefined; expected a string, …`). The one protocol error is a `tools/call` for a name the host does not serve (`-32602 Unknown tool`), which an agent can only produce by ignoring its own `tools/list`.

**Gating.** The host is injected only when the initialized agent advertises `mcpCapabilities.http === true`. Otherwise the open fails with `INVALID_ARGUMENT` — `function tools need HTTP MCP, but backend "<id>" does not advertise mcpCapabilities.http (<n> tools configured: …)` — the agent is closed, and nothing was sent past `initialize`. Tools are never silently dropped. Every installed adapter advertises HTTP MCP (see [Capabilities](#capabilities)); the gate matters for custom backends — `AcpAgent.probe()` or `agent.capabilities.agent.mcpCapabilities` tells you beforehand.

**Abort.** `ctx.signal` aborts when the turn in flight is cancelled — `cancel()` (reason `AcpAgent.cancel(): the turn was cancelled`), a per-call `prompt({ signal })` / `stream({ signal })` abort or an early stream exit (the caller's reason) — when the constructor `signal` fires (its reason), when the agent closes or its process dies, and when the backend drops the HTTP request before the result was written. An `execute` that honors it settles the aborted call as an `isError` result carrying the reason's message. Once teardown reaches the host — after the FIFO let `close()` run, or straight away on the constructor signal / process death — every in-flight `execute` is aborted and given up to one second to flush before the remaining connections are torn down, so a tool that ignores its signal cannot hold the teardown itself. It can hold a **plain** `close()` before that point: `close()` is queued behind the turn in flight, and that turn settles only when the backend's `session/prompt` does — which is waiting on the tool call — so a signal-ignoring tool during a turn keeps `close()` waiting for as long as the backend waits on it. To close promptly in that situation, `cancel()` first (the tool's `ctx.signal` fires and the backend ends the turn) or abort the constructor `signal` (the queued `close()` is drained and the teardown runs once the abort's own cancel and grace have played out).

**Visibility.** The SDK adds no event: the backend announces the call the way it announces any MCP tool — `tool_call` / `tool_call_update` on the bus, in `turn.toolCalls` and `turn.messages[*].toolCalls`, and through `stream()` — under its own naming (pi: `mcp__agent_tools__<name>`; an `agent_tools_2` server name carries into that alias). Whether a backend asks permission before calling an MCP tool follows its own mode and policy; `permissions` / `onPermissionRequest` see such a request like any other.

### Events — `on(name, listener)`

`on()` / `once()` return an unsubscribe thunk; `off()` removes one listener. The names and payloads are the runner's (`AcpAgentEventMap = AcpRunnerEventMap`; see [Events](#runner-events)) — there are no SDK-specific event names, and turn boundaries are the `prompt()` promise. The bus is **per agent**: it delivers only events carrying this agent's session id (forks get their own emitter), so listening on a parent never shows a child's stream. Because the process is dedicated, `backend_error` (connection-scoped, `{ backendId, error }`) is delivered too — `InteractiveSession` drops it only because its bus is shared. `session_open` is **sticky**: a listener registered after the session opened receives it once on the next microtask, and a listener that saw it live never sees it twice. `session_close` fires once, when the agent's own session is released (`close()`, the constructor abort, or process death); the id-only fork hand-off — the bare fork handle's `keepOpen` release and the reattach's second `session_open` — is never surfaced. Updates that arrive before the session is ready (a `load` replay, an OpenCode fork's pre-response replay) are buffered under the not-yet-known id and adopted once the open resolves — because `fork()` and the statics return only after that, they are observable through `replay`/`history`/`messages`, not through `on()`. Listeners are isolated: a throwing listener never affects the turn or its siblings.

<a name="acpagent-stream"></a>**Streaming a turn — `stream(content, options?)`.** The same turn as `prompt(content, options)` — the same FIFO position (the call queues it), the same `AcpAgentPromptOptions`, the same `AcpAgentTurn` — observed as an async iterable (`AcpAgentStream`: an `AsyncIterable` that is its own iterator, with `next()`, `return()`, and `throw()`) of `AcpAgentStreamEvent`s: every bus event emitted while this turn's operation runs, each tagged with its name as `type` and carrying the payload `on(name)` delivers (`{ type: "agent_message_chunk", content, sessionId, … }`, `{ type: "tool_call", toolCallId, title, … }`, `permission_request`, `elicitation_request`, `raw_message`, a concurrent `steer()`'s `steering`, …), then the terminal `{ type: "turn", turn }`. An update is yielded **once**, under its `sessionUpdate` kind — the `session_update` catch-all is not in the union (`AcpAgentStreamEventName = Exclude<AcpAgentEventName, "session_update">`). The observer is attached inside the queued operation, the instant the turn is dequeued, and detached when the turn settles, so a stream sees **only its own turn's events** — never a previous or a concurrently queued turn's — and, because the window starts at dequeue, a lazy first open's `session_open` and a per-turn `mode`'s `current_mode_update` are part of the turn that caused them. Events are buffered without dropping until consumed (bounded only by the turn). When the turn rejects, the iterator yields the buffered events and then throws that same error, once; a later `next()` is `done`. Leaving early — `break`, `return()`, `throw(error)` — aborts the turn's per-call signal: a turn still queued or not yet on the wire is dropped with nothing sent, a turn in flight gets the one `session/cancel` (and the agent's escalation when it is ignored), and the call resolves only once the turn settled, so a turn never keeps running unobserved; `return()` reports `done`, `throw(error)` rethrows `error`. The caller's own `options.signal` works exactly as for `prompt()`: the iterator throws its reason. `stream()` on a closed agent throws the closed `INVALID_ARGUMENT` error from the first `next()`.

### Discovery — `AcpAgent.probe()`

`AcpAgent.probe({ model?, models?, harnesses?, modelFilter?, backends?, cwd?, probeTimeoutMs?, probeConcurrency?, signal? })` resolves an `AcpAgentCatalog = HarnessConfigReport & { models: HarnessModelsView[] }` — the same no-prompt catalog `probeHarnessConfig` produces and the MCP `action:"config"` is projected from, plus the per-harness `models` view (`modelFilter` is a substring or `/regex/` over leaf model ids → `models[*].matches`). Every target runs on its own dedicated process (spawn, initialize, one `session/new`, model selection for exact specs, release, dispose — the SDK owns no pool); `model`/`models` are exact routed specs selected before the catalog is read, `harnesses` are backend-only targets, and the default (no targets) is every built-in plus every registered custom backend. A failed exact-model probe still carries the bare harness catalog next to the failure (`ok: false`, the failed entry `probed: false` with a redacted `error`), the same fallback the MCP `action:"config"` applies, so a caller can pick a valid id. A per-target spawn/auth/timeout failure never throws; a malformed `modelFilter`/`probeTimeoutMs`/`probeConcurrency` throws a `TypeError` and a malformed registry `INVALID_ARGUMENT`, both before any spawn. Every probed entry carries `traits` (`ValidateHarnessOptions.traits`, the same `AcpAgentTraits` as `agent.traits`, computed from the probe connection — so pi and Codex report `systemPrompt.source: "advertised"` and Claude `"table"`, and `steering`/`loadedTurn` are what that process advertised); `AcpAgentRunner.probeConfigOptions` returns the same field on `ProbedConfigOptions`. A failed entry has none. The MCP byte-budgeted projection stays in `@automatalabs/mcp-server` and does not carry `traits`.

### Errors

SDK misuse is uniformly a `WorkflowError` with code `INVALID_ARGUMENT` (non-recoverable, `agentLabel` set): the SDK's own guards raise it directly, and a shared validator's `SCRIPT_VALIDATION_ERROR` (cwd, the reserved `"model"` id, the registry, `clientHandlers`, `assertSystemPromptSupported`, prompt images, the client's mode-selection and lifecycle-capability gates) is re-coded at the agent boundary with its message, `agentLabel`, and `details` preserved; the function-tool guards (definition shape, the HTTP MCP gate) raise it directly — the SDK never surfaces `SCRIPT_VALIDATION_ERROR`, which stays the runner's and `InteractiveSession`'s code. Wire failures go through the runner's `mapThrownError` ladder; an abort is never mapped.

| Situation | Error |
|---|---|
| bad `cwd`, `"model"` in `configOptions`, malformed `backends`, bad `clientHandlers`, unsupported `systemPrompt`, malformed `tools` (name grammar, duplicate name, missing `execute`/`description`/`inputSchema`, a non-object `inputSchema`) | `INVALID_ARGUMENT` — thrown synchronously by the constructor and `AcpAgent.traits()`; the statics and `probe` reject with it — always before any spawn |
| `tools` on an agent that does not advertise `mcpCapabilities.http` | `INVALID_ARGUMENT` at open: `function tools need HTTP MCP, but backend "<id>" does not advertise mcpCapabilities.http`; the agent is closed, nothing sent past `initialize` |
| unknown config option id (constructor, `setConfigOptions`, per-turn) | `INVALID_ARGUMENT`: `config option "<id>" is not advertised by <backend>; advertised: <ids>` |
| unknown mode | `SessionHandle.setMode`'s mode-selection error, re-coded `INVALID_ARGUMENT` |
| per-turn `schema` on a backend other than Codex; malformed `images` | `INVALID_ARGUMENT` (the schema error points at the constructor option) |
| `fork`: not advertised / `model` routes elsewhere / cwd override on `source-only` | `INVALID_ARGUMENT` (the lifecycle gate's message names `session/fork`) |
| `setModel` / per-turn `model`: the spec routes to another backend or pool, is backend-only (`"claude"`), or is blank | `INVALID_ARGUMENT` naming both backends (`… routes to backend "codex" but must stay on backend "claude"`), before anything is sent — `setModel` checks the route before queueing the operation, so on an agent that has not opened yet nothing is spawned; the per-turn message names the entry point used (`AcpAgent.prompt({ model })` / `AcpAgent.stream({ model })`); `model` unchanged |
| cold statics: unknown `ref.backendId`, `poolKey` mismatch, `model` routes elsewhere, empty `sessionId`/`backendId`, lifecycle method not advertised | `INVALID_ARGUMENT` — never a silent reroute to the default backend |
| `steer()` with no turn in flight | `INVALID_ARGUMENT`: `AcpAgent.steer() requires a prompt() in flight` |
| any operation after `close()`, an abort, or process death | `INVALID_ARGUMENT`: `AcpAgent (<backendId>) is closed[: process exited]`; `close()` itself resolves |
| a queued operation when the process dies | `AcpAgent (<backendId>) is closed: process exited before the queued operation ran` |
| wire rejection (open, prompt, steer, setModel, setMode, setConfigOptions, fork, reattach) | `mapThrownError`: `-32000` → `AUTH_REQUIRED` (with `authContext`); the backend classifier → `PROVIDER_USAGE_LIMIT` (+ `resetHint`); child cleanup → non-recoverable `AGENT_EXECUTION_ERROR`; else recoverable `AGENT_EXECUTION_ERROR` |
| typed session failure (Codex) | `prompt()` **rejects** with the mapped `WorkflowError` carrying `error.turn` (see [Turns](#acpagent-turns)) |
| `stopReason` ∈ `refusal` / `max_tokens` / `max_turn_requests` / `cancelled` | **not** an error — `turn.stopReason` |
| structured output absent or invalid | **not** an error — `turn.structuredError` |
| abort (constructor or per-call signal) | `signal.reason` rethrown untouched |
| `close()`: a `child_cleanup_error` from the release | non-recoverable `AGENT_EXECUTION_ERROR`, thrown after the process is disposed |

Every `AcpAgent` and probe connection is registered with a single module-level `process.once("exit")` hook that kills any still-live dedicated process, so a crashing host leaves no orphaned agents.

---

## ACP aggregation server

`@automatalabs/acp-server` exports `serveAcpServer(options?)`,
`listenAcpHttpServer(options?)`, and the `agentprism-acp-server` ACP V1 executable. The executable
uses stdio by default; `--http` serves Streamable HTTP and WebSocket connections on the same path.
Every client advertises router version 1 under
`clientCapabilities._meta["@automatalabs/agentprism"].acpRouter` and selects either a discovery or
backend connection in the initialize request's top-level `_meta`.

A discovery connection exposes `_automatalabs/agentprism/backends/probe`; its `{ cwd,
additionalDirectories?, mcpServers, _meta? }` input opens one temporary no-prompt session per
configured backend and returns each initialize capability set, session mode catalog, and config
option catalog. A backend connection selects one backend during `initialize`, forwards that request,
and returns the backend response with the router confirmation merged into
`agentCapabilities._meta`. Every `session/new` repeats the same backend assertion. After that check,
all ACP and non-AgentPrism extension traffic passes through unchanged, including native session IDs
and `_meta`; the server keeps no session-routing table.

`ServeAcpServerOptions` is `{ stream?, backends?, targets?, version?, signal? }`.
`ListenAcpHttpServerOptions` adds `{ host?, port?, path?, maxRequestBodyBytes? }` and returns a handle
with the bound HTTP and WebSocket URLs, a `closed` promise, and idempotent `close()`. The network
listener defaults to `127.0.0.1:7331/acp`; the official SDK transport owns its required
`Acp-Connection-Id` and SSE route correlation, while AgentPrism still keeps no session-routing table.
`backends` uses the same custom backend schema and `AGENTPRISM_BACKENDS` merge as `acp-agents`;
`targets` supplies exact embedded/test targets instead. The package exports `BackendTarget`,
discovery result types, extension constants, parsers, and initialize-response helpers. `acp-agents` exports
`openRawBackendConnection(backend)`, the uninitialized process/stream primitive used by this proxy.

## Backends & process resolution

Long-lived ACP server processes are pool-managed (spawned once, sessions multiplexed; per-session `cwd` keeps worktree isolation on a shared process).

The public registry exports are `BUILTIN_BACKENDS`, ordered `BUILTIN_BACKEND_IDS`, exact-case
`builtinBackend(id)`, and `BUILTIN_PROTOCOL_COVERAGE`, with types `BuiltinBackendId`,
`BuiltinBackendDefinition`, `BuiltinBackendReleaseMetadata`, and `BuiltinProtocolCoverageRow`.
The table is the only authored built-in identity source; release topology projects to
`scripts/acp-backends.manifest.json`. Follow [the backend onboarding checklist](backend-onboarding-checklist.md)
for every new first-class row.

| Backend | Default resolution | Overrides |
|---|---|---|
| `claude` | spawns the installed `@agentclientprotocol/claude-agent-acp` dep | `AGENTPRISM_CLAUDE_ACP_CMD` / `_ARGS` |
| `codex` | `require.resolve("@automatalabs/codex-acp")` — the installed dep, no config needed | `AGENTPRISM_CODEX_ACP_BIN` (path), or `AGENTPRISM_CODEX_ACP_CMD` / `_ARGS` (full command) |
| `opencode` | `AGENTPRISM_OPENCODE_ACP_CMD`, else host-installed `opencode-ai/bin/opencode` if resolvable, else `opencode` on PATH; non-override paths pass `acp` | `AGENTPRISM_OPENCODE_ACP_CMD` / `_ARGS` (full command) |
| `pi` | `AGENTPRISM_PI_ACP_CMD` override; else resolved `@automatalabs/pi-acp/dist/index.js` under `process.execPath`; else `npx -y @automatalabs/pi-acp` | `AGENTPRISM_PI_ACP_CMD` / `_ARGS` (full command) |
| custom | `backends` option or `AGENTPRISM_BACKENDS` (JSON) | `CustomBackendConfig`: `command`, `args?`, `env?` (a **scoped overlay** for the child only — put per-backend secrets here, never in the ambient env), `sessionMeta?`, `structuredOutputTool?`, `fork?` (`{ disposition: "id-only" \| "live", cwd?: "source-only" \| "free" }` — how the agent answers `session/fork`, see `FORK_SESSION_TRAITS`; omitted = `live`/`free`; an entry wrapping claude-agent-acp — or upstream codex-acp, which unsubscribes its forks — must declare `{ disposition: "id-only" }`) |

Workflow scripts may *declare* backends via `meta.backends`, but declarations are inert until the composition root approves them (`allowScriptBackends` / `ExecOptions.scriptBackends` / `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1`).

**Environment variables**: `AGENTPRISM_ACP_POOL_SIZE` (processes per backend, default 1), `AGENTPRISM_ACP_INIT_TIMEOUT_MS` (initialize handshake deadline, default 60s), `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS` (the re-attach arm's terminal-wait backstop for a `running` loaded turn, default 15min), `AGENTPRISM_OPENCODE_DATA_ROOT` (overrides the opencode built-in's stable per-user XDG data/state/cache root — the tree where agent-persisted sessions live so cross-process `session/load` re-attachment is real), `AGENTPRISM_DEFAULT_BACKEND` (`claude` | `codex` | `opencode` | `pi` | custom name), `AGENTPRISM_BACKENDS` (host custom-backend registry JSON), `AGENTPRISM_PERSISTENCE_ROOT`, `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, `AGENTPRISM_OPENCODE_E2E_MODEL` (live e2e only; default `opencode/openrouter/moonshotai/kimi-k3`), `AGENTPRISM_PI_E2E_MODEL` (live e2e only; default `openrouter/google/gemini-2.5-flash`), plus the per-backend `*_CMD`/`_ARGS`/`_BIN` above.

---

## Errors — `WorkflowError`

One runtime class (from `@automatalabs/shared-types`, so `instanceof` holds across packages) with `.code`, `.recoverable`, `.agentLabel?`, `.resetHint?`, `.providerUsageLimitContext?`, `.authContext?`, and `.checkpointContext?`. Recoverable agent failures retry up to `agentRetries`, then resolve that agent to `null`; non-recoverable ones halt the run except the three manager-owned pause codes called out below.

| Code | Recoverable | Meaning / engine behavior |
|---|---|---|
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, protocol mismatch). Also the runner's and `InteractiveSession`'s code for invalid call options. |
| `INVALID_ARGUMENT` | no | An `AcpAgent` SDK call received invalid options or arguments, or was made in an invalid state (after `close()`, an abort, or process death). Never raised by scripts, the runner, or `InteractiveSession`; the SDK re-codes a shared validator's `SCRIPT_VALIDATION_ERROR` to this at its boundary. |
| `SCRIPT_ERROR` | no | The script **crashed at runtime**: uncaught throw or unhandled promise rejection in the script body. Run fails. |
| `WORKFLOW_ABORTED` | — | Actual cancellation (pause/stop/signal). Never used for crashes. |
| `AGENT_CANCELLED` | yes | The host selected one in-flight agent. It settles to `null`, skips retries, leaves the run and siblings live, and creates a failed call record but no replayable journal result. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call. |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the repair ladder. |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall → the run **pauses** (journaled, resumable), carries `providerUsageLimitContext` and a synthesized `resetHint` when a reset instant is available. |
| `AUTH_REQUIRED` | no | Agent demanded auth (`-32000`) → the run **pauses** (`reason: "auth_required"`, journaled, resumable), carries the non-secret `authContext`; `resume()` re-arms via `runner.auth.canResume`. |
| `CHECKPOINT_REQUIRED` | no | `checkpoint()` has no explicit answer → the run **pauses** with non-secret `checkpointContext`; resume with `checkpointReplies` or a live `confirm`. |
| `PAUSE_REQUESTED` | no | A host asked for a pause → executing agent calls finish and journal, nothing new is admitted (queued calls become interrupted rows), and the run **pauses** with `reason: "requested"`; resume the same journal. Catching it in-script cannot keep the run going. |
| `AGENT_LIMIT_EXCEEDED` | no | The run's agent-call limit was reached. |
| `AGENT_EXECUTION_ERROR` | yes | Other agent-level failure (refusal/truncation are non-recoverable variants). |
| `PERSISTENCE_ERROR`, `UNKNOWN` | no | Storage / unexpected host-level failure. |

**Script-fault containment**: a promise a script floats (un-awaited `agent()`, a stray `Promise.reject`, a `.then()` chain) is attributed to its run by realm identity and fails it with `SCRIPT_ERROR` — it does not crash the host process, and in-flight agents are cancelled. Caveat: Node invokes every `unhandledRejection` listener, so a host that installs its own listener will still *observe* contained script floats; rejections no workflow owns preserve platform semantics (your listener stays in charge; with no listener the process crashes exactly as it would without the engine).

---

## MCP server

`npx @automatalabs/mcp-server` (bin `agentprism-workflow`) speaks stdio MCP and exposes model-facing tools: deterministic **`workflow`** and persistent interactive **`repl`**, plus **`workflow_monitor`** for Apps-capable clients. By default the stdio process is a thin shim proxying to the shared per-user workflow daemon (Streamable HTTP on loopback, auto-started, spec 2025-11-25 session management and resumability); `--in-process` serves everything in the one stdio process instead, and HTTP-capable hosts can register the daemon URL directly (`agentprism-workflow daemon url`). The tool contract is identical on every path except one knob: the daemon **requires** `projectDir` on workflow config/run and REPL inputs, while an in-process server defaults it to its own project.

The server declares the SEP-2640 extension `io.modelcontextprotocol/skills` with `{ directoryRead:true }` and publishes `skill://agentprism-workflow-authoring/SKILL.md`. `skills/list({ cursor? })` returns that static entry in one page; each entry contains complete `frontmatter` and a complete `resources` array of `{ uri, digest, size }`. `skills/get({ uri })` returns the same entry for one exact served skill URI. Skill files are read through `resources/read`; directories are listed non-recursively through `resources/directory/read({ uri, cursor? })`. Unknown skill or directory URIs and cursors the server did not issue fail with Invalid Params (`-32602`). Digests are `sha256:<lowercase hex>` over the exact raw bytes whose length is `size`.

### Workflow lifecycle

#### Input parameters

Discovery and runtime use the same strict eight-action `oneOf`:
config/run/resume/setup-response/status/result/permissions-response/stop.
Each branch requires its literal `action` and rejects extra fields. Run requires exactly one
of `script` and `scriptPath`. There are no aliases or completion-wait controls.

| Field | Actions | Contract |
| --- | --- | --- |
| `script`, `scriptPath` | run | Raw JavaScript or an absolute server-side regular-file path, exactly one. First statement: `export const meta = { name, description, phases? }`. The accepted UTF-8 text is at most 1 MiB. An inline script is copied into the run store as `{runId}.script.js`; a `scriptPath` run records the path. The admitted text is what executes. |
| `projectDir` | config, run | Absolute project directory, required on the shared daemon; defaults to the server's project under `--in-process`. Other actions locate the project through `runId`. |
| `args` | run | Strict-JSON script input, immutable after admission. |
| `maxAgents`, `concurrency`, `agentRetries` | run, resume | Runtime limits; default agent cap 1000, concurrency clamped to 16, retries clamped to 3. Resolved limits are returned. |
| `harnesses`, `modelSpecs`, `modelFilter` | config | Optional backend names, exact routed models, and bounded model substring or `/regex/` filter for no-prompt discovery. |
| `runId` | resume, setup-response, status, result, permissions-response, pause, stop | Exact persisted identity, matching `^[a-z0-9]+-[a-z0-9]+$`, at most 128 characters. Resume continues the exact run ID, including a paused or stopped one. |
| `checkpointReplies` | resume | Map `checkpointContext.callIndex` to the explicit kind-valid JSON answer. The first durable answer wins. |
| `setupId`, `response` | setup-response | Exact pending setup UUID, with `{ action:"accept", content:{...} }`, `{ action:"decline" }`, or `{ action:"cancel" }`. Accept content must satisfy the persisted `requestedSchema`. |
| `permissionId`, `response` | permissions-response | Exact pending UUID and `{ outcome:{ outcome:"selected", optionId } }` or `{ outcome:{ outcome:"cancelled" } }`. Only an advertised option ID is accepted; response `_meta` is forbidden. |
| `lastN`, `labelGlob`, `logLines` | status, pause, stop | Bounded inspection: latest 1–50 calls (default 20), case-sensitive whole-label glob, and 0–50 log lines (default 20). |
| `offset`, `maxBytes` | result | Exact UTF-8 JSON paging: offset defaults to zero; maxBytes is 4–16,384 (default 16,384). Continue at the previous `endOffset`. |
| `callIndex` | stop | Cancel one uniquely matching live agent; its slot resolves to `null` with `AGENT_CANCELLED`, while siblings continue. |
| `forceOwner` | whole-run stop | Explicitly permit termination of a superseded owner after identity revalidation; may interrupt sibling runs. Forbidden with `callIndex`. |

Discover exact live model, mode, and config values before pinning them:

```json
{ "action":"config", "projectDir":"/absolute/project", "harnesses":["codex"], "modelFilter":"gpt" }
```

Catalogs preserve raw mode IDs, names, descriptions, and `_meta`. For trusted work, choose
Claude `bypassPermissions` or Codex `agent` when advertised. Claude `auto` uses a model classifier and may request permission.

#### Preparation, admission, and setup

```json
{
  "action":"run",
  "projectDir":"/absolute/project",
  "script":"export const meta = { name: 'review', description: 'review the repository', model: 'codex' }; return await agent('Review the repo');"
}
```

The request reads the source, checks its structure, runs the mocked dry run and the routed
no-prompt probes, and only then admits execution under format-3 routing admission and returns.
Nothing is persisted before admission: malformed source, a failed dry run, missing routing, and a
full project are tool execution errors (`isError:true`) with no run behind them, and cancelling the
request (closing the response stream, or `notifications/cancelled` on stdio) abandons preparation
and releases capacity. A script that declares custom backends is validated the same way and then
parked in durable setup (`status:"pending"`, `setup.request`) until `setup-response` approves it.
When the request carries `_meta.progressToken`, preparation stages are reported as progress.

An accepted response is always an acknowledgement, including when work finishes quickly:

```ts
type WorkflowOperationAccepted = {
  accepted: true;
  runId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
  scriptSource: "inline" | "path" | "stored";
  scriptUri: string; // file:// URI of the run's script file
  scriptPath: string; // the same location as an absolute path
  eventsUri: string;
  limits: { maxAgents: number; concurrency: number; agentRetries: number };
  setup?: WorkflowSetup;
} & (
  | { action:"run" }
  | { action:"resume"; continuation: WorkflowContinuationResult }
);

type WorkflowSetup =
  | { state:"preparing" }
  | { state:"input-required"; request: {
      id: string;
      kind: "backend-approval";
      title: string;
      message: string;
      requestedSchema: {
        type:"object";
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties?: false;
      };
    } };
```

It carries no execution result or result URI. Read `status` for the current outcome and `result`
for exact output. Pending setup appears in status and the App immediately. `setup-response` works
with every client; no tool request stays open for a human answer. Repeating the same response to
the same setup ID is idempotent even after execution starts; a conflicting response is rejected.
Decline, cancel, and a false backend approval retain a cancelled (`aborted`) run in history.

Script-declared spawn commands require approval before any probe or live dispatch, unless
`AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` is set. All clients require each actual call to resolve a
model directly or through an agent definition, resolved tier, phase, or `meta.model`. A backend-only
route such as `codex` explicitly retains that backend's default model. Mode and config options remain
optional. Missing routing returns an actionable error with bounded live discovery; there is no
agent-configuration setup or automatic backend selection. Mock validation cannot prove coverage;
additional configured calls on live branches are valid. Format-3 admission captures immutable tier
and named-agent routing inputs and approved backend definitions with an integrity hash before live
dispatch. Same-ID continuation reuses the snapshot without routing discovery or file drift.

#### Output and interaction

`status` is a bounded observation. It includes lifecycle state, resolved limits, log and call tails,
`latestActivity`, live `pendingPermissions`, and `setup` where relevant. Paused or terminal runs add
`outcome`: exact authored result/full logs on completion, or redacted `logTail` and non-secret
`authContext`/`checkpointContext` where applicable. Inspecting failed or aborted runs is a successful
read. Missing, corrupt, and unreadable runs fail clearly. The inherited status projection is capped
at 24,576 UTF-8 bytes and status text at 8,192; raw terminal outcome has no new envelope cap.

Every unanswered script checkpoint pauses with `reason:"checkpoint_required"`. Use the App or:

```json
{ "action":"resume", "runId":"mabc1234-k9x2pq", "checkpointReplies":{"1":true} }
```

Use the exact index from `outcome.checkpointContext`. Confirm replies must be boolean, input replies
strings (including the empty string), and select replies one exact choice. The first answer is
persisted before continuation. Later conflicting answers cannot replace it. There is no `headless`
or `default` checkpoint option; lack of a UI, timeout, or dismissal never approves or aborts work.
SDK users may supply a live `confirm` callback that collects an actual explicit answer.

ACP permissions remain live in the owner process and are answered with `permissions-response` from
the App or a later tool call. Safe projections omit private ACP session IDs, redact diagnostics,
and preserve complete ordered option IDs within a separate 64 KiB envelope. An unrepresentable
request is cancelled rather than partially exposed. Owner loss invalidates the original ACP request;
a successor cannot reconstruct it. Setup and checkpoints, in contrast, are durable waits.

An `AUTH_REQUIRED` pause reports `reason:"auth_required"` and `outcome.authContext`. Configure the
named backend's credentials out of band, then call `action:"resume"` with the same `runId`. Continuation keeps the run's args, cwd, immutable routing inputs, journal, event stream, cumulative usage, and checkpoint answers; resume itself accepts no replacement inputs. The script is re-read from the run's file: an unchanged or missing file continues the persisted script, and a changed file is a revision. A revision is validated exactly like a new run (structure, mocked dry run, routed probes), may declare only backends the run's setup already approved, and then continues with an identity-matched replay of this run's own journal: calls whose prompt and inputs are unchanged replay without provider usage, edited or new calls and everything the revision reorders run live. The acknowledgement's `continuation.scriptRevised:true` marks such a generation, the persisted record adopts the revised text, and `scriptRevisions` lists every accepted revision. A revision that does not parse, fails validation, or widens backend approval is a tool execution error that changes nothing; fix the file and resume again.
Historical records without current admission or explicit checkpoint provenance remain readable
where supported but refuse continuation/reuse clearly; start a fresh run.

#### Status, outcome, and response shapes

`WorkflowRunStatus` and its bounded call/log projection are defined in [run inspection](#run-inspection-and-terminal-log-tails).
The MCP additions and response discriminators are:

```ts
interface WorkflowScriptResourceFields {
  scriptUri: string; // file:// URI of the run's script file
  scriptPath?: string; // the same location as an absolute path
  resultUri?: string; // completed authored JSON only
  eventsUri?: string; // absent for historical rows without a durable stream
}

interface WorkflowExecutionOutcome<T = unknown> extends WorkflowScriptResourceFields {
  runId: string;
  status: "paused" | "completed" | "failed" | "aborted";
  limits?: WorkflowRunLimits;
  result?: T; // completed only; null is a value, undefined has no result resource
  tokenUsage?: TokenUsage;
  logs?: string[];
  logTail?: WorkflowLogTail;
  authContext?: AuthErrorContext;
  checkpointContext?: CheckpointContext;
  fallbacks?: WorkflowRunFallback[];
  checkpointsTaken?: WorkflowCheckpointTaken[];
}

interface WorkflowStatusToolResult<T = unknown> extends WorkflowRunStatus, WorkflowScriptResourceFields {
  tokenUsage?: TokenUsage;
  latestActivity?: WorkflowRunLatestActivity[];
  pendingPermissions?: WorkflowPendingPermission[];
  setup?: WorkflowSetup;
  outcome?: WorkflowExecutionOutcome<T>; // exactly for paused/completed/failed/aborted
}

interface WorkflowRunLatestActivity {
  scope: string;
  callIndex: number;
  executionStartSeq: number;
  label: string;
  phase?: string;
  timestamp: string;
  cursor: number;
  turnCount: number;
  observedEvents: number;
  latestText?: string; // exactly one of latestText / lastToolName
  lastToolName?: string;
  tokensObserved?: number;
  relevance: "current" | "terminal";
}

interface WorkflowPendingPermission {
  version: 1;
  permissionId: string;
  runId: string;
  callIndex: number;
  backendId: string;
  label?: string;
  requestedAt: string;
  request: {
    toolCall: Record<string, unknown>; // sanitized ACP request; private sessionId omitted
    options: Array<{ optionId: string; name: string; kind: string; _meta?: Record<string, unknown> | null }>;
    _meta?: Record<string, unknown> | null;
  };
  requestTruncated: boolean;
  requestRedacted: boolean;
}

interface WorkflowSetupResponseResult extends WorkflowScriptResourceFields {
  action: "setup-response";
  runId: string;
  setupId: string;
  status: WorkflowRunStatus["status"];
  setup?: WorkflowSetup;
}

interface WorkflowResultRetrieval {
  action: "result";
  runId: string;
  status: "completed";
  resultUri: string;
  eventsUri?: string;
  mimeType: "application/json";
  encoding: "utf-8";
  totalBytes: number;
  offset: number;
  endOffset: number;
  hasMore: boolean;
  chunk: string;
}
```

`permissions-response` returns the current run inspection/resource fields plus
`permissionResponse:{permissionId,runId,callIndex,outcome,respondedAt}` and remaining
`pendingPermissions`. `pause` returns the inspection fields plus `pauseRequested` (the request
reached the live execution owner in this call) and `paused` (the run is durably paused now); it
waits up to two seconds for executing agents to finish, and a `running` answer with
`pauseRequested:true` settles on its own, observable through status. An already paused run is a
no-op observation; a terminal or setup-parked run is an error. A final whole-stop response has
terminal status plus `stopped` and `alreadyTerminal`. A stopped (`aborted`) run resumes from its
journal. A bounded pending-stop response has pending/running status, both flags false,
and `control:{state:"pending",operationId,requestedAt,owner?}`. Owner diagnostics include PID,
instance/version, lame-duck state, active-run count, and control protocol when available. Targeted
stop returns the continuing run's current inspection. These observations never carry a new-run
acceptance or final result in place of status.

The complete strict runtime/discovery schema and public TypeScript union are in
[`workflow-tool-output.ts`](../packages/mcp-server/src/workflow-tool-output.ts). Resource links are
labelled separately as script, events, and exact result. Exact JSON up to 4,096 UTF-8 bytes is also
included in completed status text; larger values use resource reads or result paging.

### Request and run lifetimes

- **Preparation is synchronous; execution is not.** Run and Resume prepare inside the request under
  a 120-second ceiling, honor request cancellation before admission, and report preparation
  progress when a progress token is supplied. Observation requests have a 45-second bound. Human
  setup and agent execution outlive individual requests; there is no workflow completion wait, and
  cancellation after admission never stops an admitted run.
- **Capacity.** At most four preparing or executing runs per project are active, with no queue.
  Waiting setup consumes capacity. Rejected preparation and failed/stopped/paused/completed work
  release it.
  Exact retries return the existing operation and do not consume another slot, even at capacity.
- **Same-ID continuation.** Resume durably records its caller operation and generation under the
  run lease before executing. Lost-ack retries reuse that receipt; journal hits add no provider
  usage. Checkpoint answers and setup receipts cannot be overwritten by a conflicting retry.
- **Observation and recovery.** Status never waits for work or collects an answer. A cold accepted
  preparation is recovered under its lease and preserves pending setup IDs. An interrupted admitted
  execution becomes paused/interrupted for explicit resume. A live lease is never stolen on timeout.
- **Pause.** A pause request goes to the live execution owner; there is nothing to record cold.
  Agents already executing finish and journal, nothing new starts, queued calls settle as
  interrupted rows, and the run settles as `paused` with `reason:"requested"`. The response
  carries `pauseRequested` and `paused` after a two-second wait for executing agents; a `running`
  answer settles on its own. Resume continues from the journal. A run whose owner died is
  reconciled to its interrupted pause instead.
- **Stop.** Whole-run stop is location independent: it records a durable intent and forwards to the
  lease owner. Final success requires durable aborted state and a matching stopped event. A bounded
  control wait may return `control.state:"pending"` with an operation ID. Repeated terminal stop is
  a successful no-op. A stopped (`aborted`) run is not final: resume replays its journal and re-runs
  the interrupted calls. Targeted agent cancellation needs a live owner and is not fabricated cold.
- **Process lifetime.** Disconnect, shim kill, and session eviction leave daemon-owned work alive.
  A successor routes setup replies, permission replies, and stop/cancel control to a predecessor
  still holding the lease. Owner process exit can interrupt work; `--in-process` ends with its own
  client-owned process. There is no cross-machine handoff.
- **Retention.** Script, events, exact results, and operation receipts use the project store and
  have no MCP TTL. Deletion/corruption/store loss are explicit boundaries; unreadable accepted
  identities cannot silently turn into a new execution on retry.

---

### Run monitor (MCP Apps)

Call **`workflow_monitor({ runId })`** after a run has been durably accepted. This dedicated
model-facing launcher is the only tool associated with
`ui://agentprism-workflow/run-monitor.html`; `workflow` management calls never open a panel.
Legacy initialize capabilities and modern per-request capabilities must explicitly advertise
`io.modelcontextprotocol/ui` with `mimeTypes:["text/html;profile=mcp-app"]` to discover it.
The app-only `workflow-events`, `workflow-runs`, and `workflow-notifications` tools have
`visibility:["app"]` and no UI resource association.

Like Excalidraw's MCP App, each invocation uses one shared HTML resource and explicit input state.
Hosts that retain App instances can show independent run panels. If a host reuses one iframe,
a new monitor invocation deliberately binds it to the requested run and discards late replies
from the previous binding. Active/recent project navigation is optional. Resource URI alone does
not control whether a host keeps multiple panels.

The panel shows pending setup, phase/agent graph, live usage, selectable agent details, and
expandable tool results. It provides setup answers, explicit checkpoint replies, live permission
choices, targeted agent stop, whole-run stop, and exact-result paging/download. Fullscreen preserves
selection and run identity; narrow layouts adapt the inspector and controls to the available size.
App-only polling consumes no model tool calls.

Selection updates a bounded `ui/update-model-context` snapshot with the selected run/node and
resource URIs. It does not send a chat message. **Ask about this agent** explicitly sends the selected
agent context when the host supports text messages. Automatic messages are limited to required
input and terminal outcomes; phase starts, progress, and usage churn remain quiet. Concurrent views
claim event notifications through a host-scoped receipt ledger. Its scope depends on the host's
session/origin isolation, and an accepted-message/lost-ack crash cannot guarantee exactly-once
message delivery. Hosts lacking a capability simply omit that interaction.

To try the shipped App in the official reference host, run
`node packages/mcp-server/scripts/dev-app-host.mjs` from the repository root; its header describes
basic-host setup. `AGENTPRISM_DEV_CWD=<project dir>` serves an existing run store.

### Claude Code channels

For hosts that cannot render the App, the server delivers the same automatic messages as
[Claude Code channel](https://code.claude.com/docs/en/channels-reference) notifications. It declares
`capabilities.experimental["claude/channel"]` on the legacy initialize result and emits
`notifications/claude/channel` with `{ content, meta: { run_id, kind, status, event_id } }` for
terminal outcomes, checkpoint and other pauses, parked permission requests, and pending setup
requests, using the wording and ids in `src/run-notices.ts` that the App also uses. A session
receives notifications only for runs its own `run`, `resume`, or `status` calls named; a session
that inspects a run attaches to its later updates and nothing earlier is replayed. Hosts without a
channel handler drop the notification. See the
[package README](../packages/mcp-server/README.md#claude-code-channels) for enablement.

### The `repl` tool

The server also registers the interactive model-facing tool **`repl`** — a persistent QuickJS-in-WASM JavaScript REPL, **one VM per `projectDir`**, for live, stateful subagent orchestration (the interactive complement to `workflow`'s deterministic scripts). Workspace state — bindings, pending subagent calls, raised checkpoints, logged values — persists in the VM across tool calls, MCP-session churn, and daemon restarts. Its full contract, with worked examples per action, is in the [package README](../packages/mcp-server/README.md#the-repl-tool); the surface in brief:

```ts
type ReplToolInput =
  | { action: "eval"; projectDir?: string; code: string; timeoutMs?: number } // timeoutMs default 60_000, hard cap 120_000
  | { action: "interrupt"; projectDir?: string; id?: string };
```

`projectDir` is required on the shared daemon for **both** actions, and defaults to the server's own project on `--in-process`. The input schema is **strict**: a missing required field and every key outside the selected action's exact set are rejected as Invalid Params (`-32602`), never silently discarded. Every result carries `structuredContent` (the exact same shape as the published `outputSchema`) alongside the human text. `eval` holds the call open pumping settlements up to the soft bound: the **finished** shape `{ output, result }` when everything the code waits on settles within the bound, the **still-running** shape `{ output, running: [call ids] }` when the bound elapses (the eval continues server-side; any later eval — including `""`, the documented idempotent poll — drains what settled, and a poll picks a drained timed-out eval's completion repr up as its own `result`), or the **thrown** shape `{ output }` (the §4.6 error rendering, no completion value). `output` is one newline-joined string — console lines, raised checkpoint lines, error renderings, and one-line durability notices — and is forwarded without a byte ceiling:

```ts
type ReplToolOutput =
  | { output: string; result: string }                                  // eval finished (a guest undefined renders "undefined")
  | { output: string; running: string[] }                               // eval still running (the in-flight c1, c2, … ids)
  | { output: string }                                                  // eval threw / was broken mid-run
  | { interrupt: { outcome: "targeted" | "refused-idle" | "cancelled" | "idle" | "failed" | "none"; callId?: string } }
  | { error: string };                                                  // isError: true — a missing project context
```

With `id`, `interrupt` cancels that subagent call (the guest promise rejects recoverable, `AGENT_CANCELLED` family); without `id`, it breaks the running eval and reports `refused-idle` when nothing is running. Introspection is in-band through guest functions returning ordinary values: `workspace()` (`{ bindings, inFlight, checkpoints, diagnostics }` — `diagnostics` carries the last reconcile summary, a retained drain error, and `childrenClosed`), `agents()` (the live-agent entries), and `reset()` (teardown after the current eval). A stored snapshot that **refuses** (corrupt, format bump, wasm-hash mismatch) auto-resets: the refused file is renamed aside (`.refused-<ts>`, never deleted) and the next eval's output leads with a one-line notice; a restore that lost calls or a drain failure that lost state gets the same one-line-notice treatment. Printing follows the repr rules (direct strings whole; depth 2; 20 entries per level; nested strings 200 chars head+tail) with no byte ceiling. Subagent `agent()` calls and `checkpoint()` draw from **one shared per-workspace id sequence** — `c1`, `c2`, … — answered by `checkpoint.answer("c2", value)` in a later eval; raised checkpoints surface as output lines. Subagents are [`acp-agents`](#acpagentrunner-createacprunner) sessions, 6 concurrent per workspace (additional dispatches queue); the workspace snapshots to the per-project store at every state-changing boundary and restores **lazily on first touch** with a three-way call reconcile (settle / re-attach / re-issue). `repl` shares the `workflow` tool's project model and daemon lifetime.

## `@automatalabs/repl-engine`

The published engine tier the `repl` tool registers over (imported by `mcp-server` as `workspace:*` in the monorepo and stamped to an exact version at publish time). It is a persistent JavaScript REPL in a capability-free QuickJS-in-WASM VM; the public surface:

- **`Workspace`** / **`WorkspaceRegistry`** (`WorkspaceOptions`, `WorkspaceRegistryOptions`, `WorkspaceManifest`, `WorkspaceBinding`) — one VM per workspace, owning the lifecycle (`create` → `eval` → `drainJobs` → `dispose`) and the manifest surface. `ReplVm` (`loadShippedWasm`, `ReplVmOptions`, `ReplEvalOptions`, `ReplDrainOptions`, `ReplEvalOutcome`, `DrainJobError`) is the raw quickjs-wasi shim tier.
- **`Broker`** (`DEFAULT_MAX_CONCURRENT_AGENTS`, `DEFAULT_EVAL_TIMEOUT_MS`, `DEFAULT_DISPOSE_BOUND_MS`, `BrokerOptions`, `BrokerRunner`, `ReplEvalResult`, `CheckpointSummary`, `LiveAgentInfo`, `ReconcileReport`, `WorkspaceManifestReport`, …) — drives subagents as ACP sessions, records results by call id, and reconciles on restore. The call store is `InMemoryCallStore` / `JsonlCallStore` (`CallStore`, `CallRecord`, `CallOutcome`, …).
- **Snapshots and durability** — `serializeSnapshot` / `deserializeSnapshot` / `wasmSha256Of`, `SNAPSHOT_FORMAT` / `SNAPSHOT_FORMAT_VERSION`, `SnapshotEnvelopeError` / `SnapshotRestoreError`, and the per-project `ReplWorkspaceStore` (`REPL_STORE_SUBDIR`, `SNAPSHOT_FILENAME`, `CALL_STORE_FILENAME`).
- **The previewer** — `renderPreviewLine` / `renderCollapsed` / `renderGlobalLine` / `manifestBinding` / `formatByteSize` and the CDP preview types (`ObjectPreview`, `PropertyPreview`, …). Guest output is forwarded as rendered; the previewer also supplies bounded internal metadata such as manifest tokens and checkpoint/task previews.
- **The guest bridge and provenance** — `installGuestBridge`, `GUEST_LIBRARY_VERSION`, the `HOST_*` callback names; `provenanceRecord` / `provenanceView` (`eval N` / `worker cN` / `session restore` labels).
- **The out-of-band eval-break channel** — `createEvalBreakChannel` / `EvalBreakChannel` (the worker-thread relay the MCP shim fires to break a synchronous runaway).

The full engine contract (guest library, host-call surface, FORMAT.md preview rules, reconcile semantics) is documented in the [package README](../packages/repl-engine/README.md).

### The `repl` adapter exports from `@automatalabs/mcp-server`

`@automatalabs/mcp-server` re-exports the REPL adapter surface for hosts mounting the tool themselves: `replToolInputShape` / `replToolOutputShape` (the Zod input/output schemas), the `ReplToolOptions` type, `createReplProjectState` / `ensureReplWorkspace` / `disposeReplProjectState` / `resetReplProjectState` and the `ReplProjectState` type (per-project workspace state), and `ReplPresenceLedger` (the client-presence drain). `createWorkflowServer` registers both `workflow` and `repl`; `CreateWorkflowServerOptions` exposes `replRunner` / `replPresence` / `replClientId` / `replEvalBreakChannel` / `replDrainBoundMs`. Breaking a *fully synchronous* runaway requires the relay stdio transport `main()` installs; a vanilla `StdioServerTransport` bounds it only by the per-eval deadline (`AGENTPRISM_REPL_EVAL_TIMEOUT_MS`, default 30 000 ms).

## Workflow script DSL

Scripts run in a deterministic `vm` realm (`Date.now`/`Math.random`/argless `new Date()` throw — the journal/resume identity depends on it; the realm is a determinism boundary, **not** a security boundary). Realm globals:

`agent(prompt, { label?, schema?, model?, mode?, configOptions?, tier?, phase?, isolation?, resume?, cwd?, retries?, mcpServers?, images?, agentType?, meta?, promptMeta?, keepSession? })` (unknown option keys reject before call allocation or runner invocation) · `parallel(thunks)` (barrier; failed thunks → `null`) · `pipeline(items, ...stages)` (no inter-stage barrier) · `workflow(nameOrScript, args?)` (one level of nesting) · `checkpoint(prompt, opts?)` (journaled human gate; live/default/abort/durable-pause modes) · `gate(thunk, validator, opts?)` · `retry(thunk, opts?)` · `verify(item, opts?)` · `judgePanel(...)` · `loopUntilDry(opts)` · `completenessCheck(args, results)` · `phase(title)` · `log(msg)` · `args` · `cwd`.

`gate()` validators may return `{ ok: boolean, feedback?: string, ... }`, a bare boolean, or
`null`. A fulfilled gate returns exactly `{ ok, value, verdict, attempts }`: `value` is the final
producer result and `verdict` is the exact last completed validator return (`null` is retained;
an unsupported explicit `undefined` is normalized to `null`). Bare `true` passes, while `false`
and `null` reject without feedback.

`keepSession:true` skips the release-time `session/close`; the resulting `AgentSessionRecord` is returned in `WorkflowRunResult.agentSessions` so the host can later call `runner.loadSession()` or `runner.resumeSession()`.

See the [README](../README.md#writing-workflow-scripts) for authoring guidance and examples.
