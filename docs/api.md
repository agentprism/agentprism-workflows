# API reference

The integrator-facing surface of the `@automatalabs/*` packages, in one place. This documents the supported integration APIs; package barrels also expose lower-level protocol utilities for advanced hosts, which remain typed but are not all repeated here. Version references are current for `workflows` 0.46.2, `acp-agents` 0.35.2, `workflow-engine` 0.35.1, `shared-types` 0.29.1, `mcp-server` 0.25.0, and `agentprism-otel` 0.1.2. `repl-engine` is unreleased (0.0.0); its engine and the `repl` MCP tool that `mcp-server` registers over it are implemented (see [MCP server](#mcp-server)) but ship with a future release.

Packages (all but `repl-engine` published to npm, Apache-2.0, ESM-only, Node >= 22):

| Package | What it is | Depend on it when |
|---|---|---|
| `@automatalabs/workflows` | Facade re-exporting the supported orchestration surface (`runDynamicWorkflow`, `createAcpRunner`, `WorkflowManager`, auth/session types) | You want the SDK. **Start here.** |
| `@automatalabs/workflow-engine` | The deterministic script engine + `WorkflowManager` (no agent construction — the runner is injected) | You bring your own `AgentRunner` and don't want ACP deps |
| `@automatalabs/acp-agents` | The ACP runner: pooled Claude/Codex/OpenCode/pi ACP processes, model routing, structured output, events, interactive sessions | You want agent execution without the workflow engine |
| `@automatalabs/shared-types` | The seam contracts: `AgentRunner`, `RunOptions`, `WorkflowError` (+ codes), workflow result/meta types | You implement a custom runner or need `instanceof WorkflowError` across packages |
| `@automatalabs/mcp-server` | Stdio MCP server (bin `agentprism-workflow`) exposing the `workflow` tool (foreground/background run, bounded await, resume, inspect, stop) and the `repl` tool (a persistent per-project JavaScript REPL for live subagent orchestration) | You drive workflows from Claude Code / an MCP client |
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

**Script validation (token-free):** `validateWorkflowScript(script, opts?)` runs a static parse (meta literal, syntax, and direct nondeterministic call expressions) plus a dry run over an in-process mock `AgentRunner`, then opens one no-prompt session for every distinct routed `{ backend, model }` pair. An authored model is selected verbatim before the echoed, model-specific config options are read; a call without a model reads its harness/session default. The probe spends no tokens. `dryRun.harnessOptions` reports each routed catalog with optional `model` attribution on every run, even when the script authors no `configOptions`; the human formatter prints the same tables. Authored exact ids and values are checked for unknown ids, invalid select values, non-boolean boolean values, and the reserved `"model"` id. A select option may add `_meta["@automatalabs/agentprism"].recognizedValues`: supported values pass unchanged, recognized unsupported values pass with an ordered clamp warning, and unrecognized values fail. Pi derives this domain from its SDK and advertises a per-model `thinkingLevel` subset. Ordered built-ins without that metadata (Claude and Codex) derive it client-side by enumerating the advertised model picker through the existing per-model probe cache and merging consistent per-model orders. Claude's absent `effort` option means unsupported, while `default` is recognized but excluded from ordered ceiling comparisons. `ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT` is 32; a larger picker or inconsistent orders warn and fall back to exact advertised-value validation. OpenCode and custom/unknown backends are exact-set and reject unadvertised thought-level values without clamping. A routed probe spawn/auth/model-selection/session failure adds one warning, sets that pair to `probed:false`, and skips its checks without invalidating the report. A mock live confirm answers checkpoints with `default ?? true`, so `headless: "pause"` dry-runs cleanly; `headless: "abort"` warns because a truly unattended run would abort. Script-declared backends are treated as approved (with a warning). Invalid scripts resolve to a report; read `report.ok` / `report.exitCode` (`0` valid, `1` parse failure, `2` dry-run or config-option failure). `ValidateWorkflowOptions` is `{ args?, workflows?, dryRun?, cwd?, maxAgents?, timeoutMs?, mockAnswers? }`; `workflows` accepts a `WorkflowDir` or dir path(s), the mock reports `MOCK_TOKENS_PER_AGENT` = 1000 per call, and timeout defaults to 30 000 ms.

`MockAnswers` is a read-only record from label glob to JSON answer or `{ $sequence: readonly MockAnswerJson[] }`. Matching uses the final resolved label, is case-sensitive and whole-label, and supports `*`, `?`, and backslash escaping. Normalization captures property order once and the last matching rule wins. Raw canonical array-index keys `"0"` through `"4294967294"` are reserved because ECMAScript reorders them; spell an exact numeric-label rule with an escape, such as JSON key `"\\10"` for label `10`. `"01"` and `"4294967295"` are not reserved. A raw array is one answer, while `$sequence` is finite and consumes only when its rule wins.

For schema calls the validator creates a fresh fabricated base per invocation and recursively deep-merges JSON objects; arrays, `null`, falsy primitives, and other scalars replace. It then runs TypeBox `Check` without `Convert`. Any answer-caused error is non-recoverable `SCHEMA_NONCOMPLIANCE`; identical failures inherited from untouched fabricator limitations are accepted with grouped, value-free warnings. Schema-less scripted answers must be nonblank strings. Sequence exhaustion fails rather than repeating or falling back. `ValidatedAgentCall.mockAnswer` records the winning glob and zero-based sequence position; `dryRun.mockAnswers` reports captured-order rule match/consumption counters and item-level `no-match`, `shadowed`, or `not-reached` unused entries. Human positions are one-based. Unused entries only warn.

Inputs are limited to 256 KiB raw CLI UTF-8 and canonical programmatic JSON, 256 rules, 256 UTF-16 code units per glob, 256 sequence items, and answer depth 32; only ordinary JSON data is accepted. Supplying invalid programmatic `mockAnswers` throws `TypeError` before parsing. Mock-enabled validation serializes agent service at concurrency one for deterministic FIFO sequence use, so it is not a load simulator. Attribution, warnings, and validation errors never echo answers, but workflow code receives the fixture normally and may expose it in `log()` or the returned result; fixtures must not contain credentials or production data.

The CLI adds mutually exclusive `--mock-answers <json>` and `--mock-answers-file <path>` to the existing `npx @automatalabs/workflows validate <file-or-name> [--args <json> | --args-file <path>] [--workflows-dir <dir>]… [--parse-only] [--cwd <dir>] [--max-agents <n>] [--timeout-ms <n>] [--json]` surface (`3` = usage error). With `--workflows-dir` the positional may be a workflow name and nested `workflow("<name>")` calls resolve. The package exports `MockAnswerJson`, `MockAnswerSequence`, `MockAnswerRule`, `MockAnswers`, `ValidatedMockAnswerUse`, `ValidatedMockAnswerRule`, `UnusedMockAnswer`, and `ValidatedMockAnswers`, along with the existing validation types and `fabricateFromSchema()` / `formatValidateReport()` helpers.

**Harness config discovery (token-free):** `probeHarnessConfig({ harnesses?, backends?, cwd?, timeoutMs? })` runs validate's no-prompt config probe standalone — no script — and resolves to a `HarnessConfigReport` (`{ ok, exitCode, harnessOptions }`, per-harness entries in the same `ValidateHarnessOptions` shape). Default targets are the built-in harnesses plus every registered custom backend; `backends` merges over `AGENTPRISM_BACKENDS` exactly like `createAcpRunner`. A per-harness spawn/auth/session failure or timeout (default 60 000 ms) reports `probed:false` without throwing; only a malformed registry or invalid options throw. `formatHarnessConfigReport(report)` renders the CLI's human table. CLI: `npx @automatalabs/workflows config [harness ...] [--cwd <dir>] [--timeout-ms <n>] [--json]` — exit `0` all probed, `1` at least one probe failed, `3` usage error.

**Host-embedded (manager):** long-lived, evented, resumable.

```ts
import { WorkflowManager, createAcpRunner } from "@automatalabs/workflows";

const manager = new WorkflowManager({ cwd: projectRoot, agent: createAcpRunner() });
manager.on("agentEnd", (e) => ui.update(e.runId, e));
manager.on("agentEvent", (e) => ui.stream(e.runId, e));  // live token-level ACP stream (see Events)

const { runId, promise } = manager.startInBackground(script, args, { cwd: worktreePath });
// ... later:
await manager.cancelAgentCall(runId, 7); // settle one in-flight agent null; run stays live
manager.stop(runId);                    // whole-run terminal abort
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
| `defaultAgentTimeoutMs` | `null` (none) | Host total-wall-clock ceiling for each agent attempt. |
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
| `agentTimeoutMs` | Host total-wall-clock ceiling for each agent attempt (`null` = no host ceiling). |
| `concurrency`, `agentRetries` | Per-run overrides of the manager defaults. |
| `confirm` | `(promptText, options) => Promise<reply>` — live human channel for `checkpoint()`. When present it wins over every headless mode, including `"pause"`. |
| `resumeFromRunId` | Persisted source ID for a **new** managed execution. Requires journaling, must differ from a caller-supplied new `runId`, and is mutually exclusive with `resumeJournal`. Missing sources fail with `PERSISTENCE_ERROR`. |
| `resumePolicy` | `"auto"` (default) or `"positional"`; requires `resumeFromRunId`. Positional is an index/prefix migration policy, not a bypass for new-format format/metadata/manifest/input checks. |
| `checkpointReplies` | Durable-checkpoint answer channel. With `resumeFromRunId`, keys name call indexes in the **source** run; with same-ID `resume()` they name that persisted run's index. Values must be strict JSON. |
| `onProgress` | Fires with the live `WorkflowSnapshot` on every progress event. |
| `scriptBackends` | APPROVED script-declared custom backends (`meta.backends`). Omitting leaves them inert — approval belongs to the composition root. |
| `resumeJournal` | Low-level legacy positional channel. Mutually exclusive with `resumeFromRunId`/`resumePolicy`; manual use permanently marks the result legacy. Prefer manager-owned `resumeFromRunId`. |

A finite `agentTimeoutMs` is an unbypassable host ceiling. An `agent({ timeoutMs })` value may
shorten it; per-call `null` or omission means uncapped only when the host supplied no ceiling. The
clock covers the complete attempt rather than idle time, and every retry starts a new clock. Since
retries are clamped at 3, the maximum timeout envelope is `(resolved retries + 1) × resolved timeout`.
An exhausted timeout settles the call to `null` with recoverable `AGENT_TIMEOUT` and frees its
concurrency slot. The runner cancels the ACP turn; after a five-second grace, an uncooperative turn
is closed where supported and its pooled child is quarantined and recycled after sibling sessions
drain. A new resume execution does not inherit operational limits from its source; pass the desired
timeout, retry, concurrency, and agent-count values again.

### `CheckpointOptions` — in-script human gates

`checkpoint(promptText, options?)` is deterministic, spends no tokens, and journals every resolved
reply. `kind` is `"confirm" | "input" | "select"` (default `"confirm"`); `choices?: string[]` supplies
the select options; `default?: unknown` is the headless reply (`true` when omitted); and `timeoutMs?`
sets the live prompt deadline. `headless` has three modes:

- `"default"` (the default): with no live `ExecOptions.confirm`, take `default ?? true` immediately.
- `"abort"`: with no live channel, throw `WORKFLOW_ABORTED`.
- `"pause"`: with no live channel, pause durably with `reason: "checkpoint_required"` and a
  non-secret `checkpointContext` (`callIndex`, hash, prompt, kind, choices/default). Resume with
  `checkpointReplies: { [context.callIndex]: decision }`, or attach a live `confirm` callback.

The injected decision is persisted as the checkpoint's journal entry and replayed on future cold
resumes. A detached run therefore never hangs or pauses at a checkpoint unless the workflow author
explicitly selects `headless: "pause"`.

### Lifecycle

| Method | Returns | Notes |
|---|---|---|
| `startInBackground(script, args?, exec?)` | `{ runId, promise }` | Process-lifetime execution. Returns after lease acquisition and fail-fast initial persistence. A supplied `resumeJournal` is sorted and copied into the child run before that save, so replayed prefixes and synthetic checkpoint answers survive later resume hops under the new run ID. The promise rejects on pause/failure/abort (a side-channel catch prevents host unhandled rejections if ignored). |
| `runSync(script, args?, exec?)` | `Promise<WorkflowRunResult>` | Blocks; always resolves to a **terminal** result (`completed \| paused \| failed \| aborted`) — never throws for ordinary outcomes. |
| `inspectRun(runId, options?)` | `WorkflowRunStatus \| undefined` | Synchronous, live-first safe projection; falls back to project-scoped persistence. A cold `pending`/`running` dead-owner row may be lease-reconciled to `paused` / `interrupted`; other rows are not changed. |
| `reconcileExternallyDeadRun(runId)` | `PersistedRunState \| undefined` | Lease-safe single-run reconciliation used by cold host preflights. Skips manager-owned runs, non-`pending`/`running` states, live owners, and all writes when the manager default is `journaling: false`. |
| `cancelAgentCall(runId, callIndex)` | `Promise<WorkflowAgentCallCancellation>` | Cancels one uniquely matching in-flight attempt, bypasses retries, and resolves after its `AGENT_CANCELLED` call record and `agentEnd` state are durable. The run signal and `abortSignaled` remain untouched. Misses and duplicate scoped indexes throw with the current call-index/label list. |
| `pause(runId)` | `boolean` | Aborts in-flight work; journal preserved; resumable. |
| `stop(runId)` | `boolean` | Whole-run terminal abort. The same run ID cannot resume in place, but its retained journal can be the source of a new `resumeFromRunId` execution. |
| `resume(runId, exec?)` | `Promise<boolean>` | Same-ID recovery of a paused/failed run using historical positional replay. Reloads the persisted script/args/cwd, rejects `resumeFromRunId`/`resumePolicy`, emits no resume report, and permanently marks the artifact legacy. Requires journaling. |
| `resumeInBackground(runId, exec?)` | `Promise<{ accepted, promise? }>` | Same-ID `resume()` plus the settlement handle: when accepted, `promise` is the resumed execution's completion promise (same contract as `startInBackground`'s — rejects on failure/pause, side-channel catch attached). The facade manager holds a per-execution `exec.agent` event bridge until it settles. |
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
same manager path. MCP execution accepts the same `resumeFromRunId`, optional `resumePolicy`, and
`checkpointReplies`. `resumeFromRunId` must be a non-empty string; `resumePolicy` must be exactly
`"auto" | "positional"`; `checkpointReplies` on a new-run API requires the source ID; journaling
must be enabled; and a caller-minted target `runId` must differ from the source. Invalid
combinations fail before target creation. The manager holds the source's cross-process lease
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
      logicalBudgetDebit?: number;
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
  option: "agentTimeoutMs" | "agentRetries" | "concurrency";
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
plan/progress surface for every new-run resume. The MCP background acknowledgement, foreground
result, inspect status, and nonterminal/terminal await status carry it; terminal await `outcome`
carries the identical final value plus the complete `resumeReport`. Human text names the strategy,
predicted and observed prefixes, counts, first non-replay and detail when known, source/current
engine and input formats, and any non-gating operational changes. A zero predicted or observed
prefix is prefixed with `WARNING`.

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
prompt metadata, and the approved script-backend digest. Host `agentTimeoutMs`, `agentRetries`, and
`concurrency`, plus per-call `timeoutMs` and `retries`, are operational bounds and enter neither
hash. They may change on a new-run resume or an interrupted-turn continuation without rejecting an
otherwise matching call.

Identity matching first considers the original exact group `(kind, call path, identity hash)`. One
candidate with an equal input fingerprint replays as `"path-hash"`; duplicates are permanently
ambiguous. With no exact candidate, exactly one original `(kind, identity hash, inputsHash)` row
may move after an insertion/deletion and replay as `"unique-hash"`. Missing/different inputs,
duplicate content, consumed candidates, or empty schema-less output run live. The
matcher never pairs by occurrence ordinal/source order and never uses isolation's path-only
fallback. Stable explicit labels matter because runner-visible label changes alter `inputsHash`.

Before any new-format journal is considered, admission requires a terminal non-aborted,
non-isolation source; exact `effectiveCwd`; exact call-path and checkpoint-input formats; a
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
  agents, headless checkpoints, nested workflows, and source-world drift;
- `"positional-v1"` / `"safe-prefix"` when explicitly requested or when a structurally valid
  source cannot represent every non-result occurrence in the identity seed;
- `"live"` for an invalid or unsupported new-format source, including missing metadata,
  incompatible format literals, and invalid manifest/seed state.

Identity decisions are independent per recorded occurrence. A changed call runs live without
clearing unmatched candidates, so matching calls later in source order, after a live writer, or on
the other side of a nested workflow can still replay. This remains true when a worktree degrades or
a live host checkpoint callback runs. The engine never uses ambient/world effects as an implicit
dependency graph.

Identity replays preserve the source logical debit on the record, but current `tokenUsage`,
provider cost, and the current physical `WorkflowCallRecord.budgetDebit` remain zero (the script-visible
budget surface — the `budget` global and per-phase sub-budgets — was deleted with the §7 budget
removal; the persisted debit fields stay for record-shape stability). Replayed agent sessions open no new
session: their record keeps source session/backend/cwd/reopen fields and rebinds only the current
call index, label, and phase. Completed checkpoint decisions use the same identity rules plus an
equal fingerprint of `default`, `headless`, and `timeoutMs`, regardless of host/headless origin.
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
world-state gates in the current automatic contract.

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
  timeoutMs?: number | null;
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
  tokenBudget: number | null;
  concurrency: number;
  agentRetries: number;
  agentTimeoutMs: number | null;
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
session IDs, cwd, checkpoint prompt/default, auth context, and raw results are never projected.

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
  execution as `{ callIndex, kind, decision, source }`. Source is `"live"`, `"headless-default"`,
  `"journal-replay"`, or `"injected"` (an indexed `checkpointReplies` answer). A checkpoint that
  paused is not resolved and therefore is not listed.

Both arrays persist on `PersistedRunState` for cold terminal reads. Neither enters call hashes, and
neither is added to the bounded `WorkflowRunStatus` inspection shape.

A run that hits a provider usage/quota wall (`PROVIDER_USAGE_LIMIT`) is **paused**, not failed — the journal checkpoints and the interrupted session is kept reopenable (`resetHint` is synthesized as `Resets at <RFC 3339 instant>` when structured provider reset metadata is present). On resume, an unchanged root occurrence with the same identity/input fingerprint/backend/cwd continues that session; a failed eligibility or reopen gate runs it fresh.

A run that hits `AUTH_REQUIRED` is likewise **paused** (`reason: "auth_required"`), not failed: the journal checkpoints, keeps the interrupted session reopenable, and persists the structured, non-secret `authContext` (`backendId` + advertised method `{ id, type, name }[]` — never credential material). `resume()` re-arms against the runner: for an `"auth_required"` pause it consults `runner.auth.canResume(backendId)` before the continuation candidate can be consumed. When the credential survived (warm resume in the same process, or a disk-backed method a fresh process re-reads from the native store/env) it proceeds and attempts session continuation; when an in-process (gateway) or spawn-env intent was lost to a cold process it **immediately re-pauses** with `re-supply credentials for <backend> via runner auth before resuming`. A runner with no `auth` controller (the default-off host) cannot confirm resumability and re-pauses.

A checkpoint authored with `headless: "pause"` is the third persisted pause class. With no live
`confirm`, the run pauses with `reason: "checkpoint_required"` and the non-secret
`checkpointContext`. `resume()` accepts the decision through `ExecOptions.checkpointReplies`; the
manager writes the synthetic reply into the journal before execution, then replay returns it without
re-asking. If resume has neither that indexed reply nor a live `confirm`, it re-pauses immediately
with the same context and executes no script or agent calls. The default checkpoint mode remains
headless-default, so detached runs do not pause unless the author opts in.

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

#### MCP live events resource

The MCP server exposes the same projected log at `workflow://runs/{runId}/events` with MIME type
`application/json`. Subscribe to the canonical URI, treat `notifications/resources/updated` as an
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
| `no-budget-trajectory` | Re-record so every call has a settlement ordinal and every agent a budget debit. |
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
while replay runners require them. `WorkflowCallRecord` is the root-scope terminal manifest.
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

`label`, `schema` (JSON Schema / TypeBox), `signal`, `model` / `tier`, `mode`, `configOptions`, `cwd` (per-session working directory — worktree isolation preserved on a pooled process), `instructions`, `toolNames` / `disallowedToolNames` (the `ToolPolicy` allow/deny lists), `mcpServers`, `images`, `meta` / `promptMeta` (ACP `_meta` passthroughs), `backends` (approved script-declared), `runId` (correlation stamp), `keepSession` (skip the release-time best-effort `session/close` so the agent-persisted session stays re-openable), resume-only `continueFromSession` (advisory exact-session reattach), callbacks `onUsage`, `onHistory`, `onResultProvenance`, `onModelResolved`, `onModelFallback`, `onSessionOpen`.

**Session hand-off.** `run()`'s return value is always the bare result, so the ACP session identity travels out-of-band: `onSessionOpen` fires exactly once for whichever acquisition wins — fresh `session/new`, successful `session/resume`/`session/load`, or the fresh fallback after a reopen failure — and always before that acquisition's prompt. Its `AgentSessionRef` is `{ sessionId, backendId, poolKey?, initializeMeta?, cwd, reopen: { load, resume, list, fork } }`; `poolKey` pins the effective custom-backend spawn identity. `initializeMeta`, when the initialize response supplies non-null `_meta`, is one complete recursively frozen JSON snapshot owned by the session and shared with its event contexts; absent/null metadata omits the key. Pair a successful call with `keepSession: true` when the host intends to reopen it. Usage/auth pause errors keep the session open automatically for managed continuation. With `continueFromSession`, the runner prefers currently advertised resume, falls back to load, and reports reattached/skipped provenance. Every non-cancellation failure through the reopen RPC cleans up and opens a fresh session with the original prompt; after reopen succeeds, the turn is committed and receives a fixed continuation instruction. The ref contains no secrets added by the client and is JSON-round-trippable; agents remain responsible for what they place in `_meta`.

**Cancellation.** An attempt signal sends ACP `session/cancel` for that session only. If the active
turn does not finish within five seconds, the client sends capability-gated `session/close`,
quarantines the pooled child from new work, and disposes it after existing sibling sessions release.
This policy is identical for every built-in and custom ACP backend. A `child_cleanup_error` returned
by close remains observable through the runner's normal error path.

**Structured output channels.** Claude and Codex keep their agent-specific schema channels authoritative. Pi, OpenCode, and opted-in custom ACP backends use the client-hosted MCP path: when `RunOptions.schema` is set and initialize advertises HTTP MCP support, the runner appends a client-hosted HTTP MCP server to `session/new.mcpServers`. The injected server is named `structured_output` (or `structured_output_2`, etc. on name collision), runs on `127.0.0.1` with an unguessable token path, and exposes `StructuredOutput`; Pi shows the namespaced alias `mcp__structured_output__StructuredOutput`. Its input schema is the requested JSON Schema and a valid call captures the result. Each injected-tool schema run reserves a pooled process exclusively from other injected runs; when every process is reserved, the pool grows elastically past `size`, then keeps surplus idle processes warm briefly before shrinking back to that steady-state size. The reservation remains held through `session.release()`, so two injected runs never share one process. Non-injected runs retain ordinary idle/grow-to-size/least-loaded multiplexing and may co-locate with an injected run. The common prompt-embedded schema plus validated final-text ladder remains the fallback when capture is absent or invalid. User-provided `mcpServers` are preserved and are not part of the resume hash.

**Model specs**: after the engine's existing precedence resolves one effective string, the runner splits it on the first `/`. If the first segment, ASCII-case-insensitively, is `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name, that harness is selected and exactly one segment is stripped; a custom registration wins on collision. A registered harness name by itself is backend-only and issues no model `session/set_config_option`, preserving the harness default. Any other first segment sends the entire authored string unchanged to `AGENTPRISM_DEFAULT_BACKEND` (historical default `claude`), so `anthropic/…`, `openai/…`, bare `opus`, and bare `gpt-…` are not aliases. When an id remains it is the exact `configId:"model"` value: no case folding, normalization, catalog matching, bracket parsing, sibling effort/Fast option driving, retry, echo verification, or fallback. Brackets, dots, and provider-style prefixes are ordinary id characters. For pi, `pi/<provider>/<model-id>` therefore sends `<provider>/<model-id>` verbatim. Harness rejection follows the existing agent-error path; `onModelFallback` remains source-compatible but model resolution does not emit it. Live-catalog-verified examples: `claude/opus[1m]`, `codex/gpt-5.6-sol`, `opencode/zai/glm-5.2`; use backend-only `claude`, `codex`, `opencode`, or `pi` when the model is configured in the harness.

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
requests fail with `invalid_config_value`. `runner.probeConfigOptions(spec?, { cwd?, selectModel? })`
routes normally, opens exactly one no-prompt session, optionally applies the routed model remainder
when `selectModel:true`, returns `{ backendId, options }` with the verbatim echoed
`SessionConfigOption[]`, and closes it; spawn/auth/model-selection/session failures throw.

**Session modes (confinement)**: `mode` is an agent-advertised ACP session mode id. Claude-family agents commonly advertise `default`, `plan`, `acceptEdits`, `bypassPermissions`; Codex-family agents commonly advertise `read-only`, `agent`, `agent-full-access`; OpenCode exposes modes as a `configOptions` select with `category:"mode"` / `id:"mode"`. This is strict: if the backend advertises neither `modes` nor a mode config-option catalog, does not list the requested id, or rejects the wire call, the run fails before any prompt is sent. When `modes` is present, the runner validates it and calls `session/set_mode`; when `modes` is absent but a mode config option is present, it validates against that option and applies `session/set_config_option`.

Permission posture changes when `mode` is explicit: if no `onPermissionRequest` resolver is present, the headless permission fallback flips from allow to deny. Explicit `toolNames` allow-list matches still allow; `disallowedToolNames` still deny; a resolver still decides. This prevents read-only/plan modes from being defeated by automatic escalation approval. Plan/read-only modes confine writes and escalation, not reads.

**Tool-approval persistence (`_meta.persist`).** A permission *allow* may ask a capable agent to remember the approval for the session or permanently. The auto-responder honors `ToolPolicy.persist` (`"session" | "always"`); a resolver can drive the same at a higher altitude with `resolvePermission(request, { outcome: "allow" | "deny", persist? })` — a `PermissionResolution` mapper — or stamp an existing response with `withPersist(response, persist)`. Either way the directive is echoed as `_meta.persist` on the `RequestPermission` response only on allow (a denial persists nothing); Codex reads it (`allow_session`/`allow_always`), and an agent without the capability ignores the extra `_meta`.

### Elicitation (agent questions)

ACP `elicitation/create` lets an agent ask the human structured questions during a turn. `mode: "form"` carries an SDK `ElicitationSchema` of primitive fields; `mode: "url"` carries a URL and `elicitationId`, with a later `elicitation/complete` notification when that URL flow finishes. The SDK marks this surface **UNSTABLE/@experimental**, so the public API re-exports the SDK request/response/schema types directly.

Configure `createAcpRunner({ onElicitation })` to answer requests. A resolver receives `(request, context)` and returns `CreateElicitationResponse`, for example `{ action: "accept", content: { ... } }`, `{ action: "decline" }`, or `{ action: "cancel" }`. With no resolver for the session, the client auto-declines with `{ action: "decline" }`; parked resolvers are settled with `{ action: "cancel" }` on session cancel, release, or connection death.

Capability advertisement is fixed at `initialize`: the client advertises `elicitation: { form: {}, url: {} }` only when a runner-wide `onElicitation` exists. A session-scoped `openSession({ onElicitation })`, `loadSession({ onElicitation })`, or `resumeSession({ onElicitation })` wins over the runner resolver for that session, but by itself cannot light up initialize-time capabilities on the connection. Agents on that connection may therefore never ask. A resolver may still decline modes it cannot render.

Claude-family agents use this advertisement to enable `AskUserQuestion`, refusal-fallback dialogs, and MCP-elicitation forwarding. Advertising without a real responder would send those agent questions into a void, so this library never advertises elicitation for a stub auto-decline path.

### Client auth capability advertisement

The client tells the agent which authentication method **types** it can actually complete, so the agent only offers gates the host can finish. Like elicitation, this is fixed at `initialize` and derived once at runner construction (never per-session). `createAcpRunner({ authCapabilities })` takes `{ terminal?, gateway? }`:

- `terminal: true` advertises `clientCapabilities.auth.terminal` **and** the top-level `clientCapabilities._meta["terminal-auth"]` channel (both are read by first-class agents — Claude reveals its terminal login methods on either, OpenCode reads the launch hint under the `_meta` channel).
- `gateway: true` advertises `clientCapabilities.auth._meta.gateway` (the gate Claude and Codex use to reveal their gateway auth methods).

**Default-OFF.** With `authCapabilities` unset, the `auth` capability is **omitted entirely** from `initialize` — which the ACP spec treats as "unsupported" — so behavior is byte-identical to a host that never opted in. There is no typed `env_var` gate in the SDK, so `env_var` methods are always visible on the wire regardless of this option. A native-TTY CLI host passes `{ terminal: true, gateway: true }`; a generic programmatic host leaves it unset. The `auth` surface is SDK-**UNSTABLE/@experimental**; a drift tripwire (`assertAuthCapabilityShape`) fails the build if a future SDK bump reshapes it.

### Auth & providers

Authentication methods are discovered without opening a session:

```ts
const methods = await runner.authMethods({ model: "codex" }); // AuthMethod[]
await runner.authenticate({ model: "codex", methodId: "api-key" });
```

`authMethods()` returns the selected backend's initialize-advertised `AuthMethod[]` (`[]` when none). `authenticate({ methodId, meta? })` is **rebuilt off dispose-after-authenticate**: instead of firing a fire-and-dispose RPC (which lost any in-process gateway credential the agent stored on that connection), it records the chosen credential into the runner's single durable `AuthStore` and recycles the pool. A method carrying gateway-shaped `_meta` records an in-process intent that is replayed on every pooled connection's `initialize`; a bare method with no `_meta` fires the one-shot login RPC so the agent runs its own login. ACP has no `agentCapabilities` gate for `authenticate`, so a backend that does not implement it may return method-not-found, surfaced with the backend id and method name.

#### Auth lifecycle — the type-dispatched contracts, `AuthStore`, and the `runner.auth` controller

Credentials live in exactly one place — the runner's per-instance `AuthStore` — and every connection pulls the current intent at the end of its `initialize` handshake, so the credential survives pool recycles and process respawns. The base flow is fully type-driven from `AuthMethod.type` plus the cross-agent `_meta` conventions (`gateway`/`terminal-auth`), with **zero agent-specific code** (a spec-conformant custom agent traverses the identical path).

- `runner.describeAuthMethods(opts?)` → `AuthMethodDescriptor[]`: a read-only probe that opens a dedicated connection, reads the advertised methods, and returns their type-dispatched descriptors (`agent` with `expectsMeta`/`interactive`; `terminal` with a resolved `launch`; `env_var` with `vars` carrying SDK defaults `secret=true`/`optional=false`).
- `runner.completeAuth({ methodId, resolution, ... })` → `AuthOutcome` (`{ status, methodId, recycled }`): records the host-collected `AuthResolution` (`{ outcome: "completed" | "agent-login" | "env" | "meta" | "cancelled" }`) into the `AuthStore`, advances the generation, and recycles the pool. The credential class (`disk` / `in-process` / `spawn-env`) is derived from the chosen method's type + `_meta` shape, never from the outcome.
- `AcpRunnerOptions.onAuth` (an `AuthResolver`): when set, a `-32000` at `session/new` is resolved inline and the acquire retried **exactly once** — the run never pauses (a second `-32000` propagates as `AUTH_REQUIRED`). Setting `onAuth` also derives `authCapabilities` to `{ terminal: false, gateway: true }` unless you pass it explicitly.
- `runner.auth`: the verbs as one object — `methods()` (= `describeAuthMethods`), `authenticate()` (= `completeAuth`), `logout()`, `status()` (redacted `AuthStatusSnapshot[]` — ids/types/names + state only, **never** secrets), and `canResume(backendId)` (cold-resume re-arm predicate). `AuthCapableRunner` is the structural interface an embedding host duck-types to drive this auth surface **programmatically** — the stdio MCP server registers **no** auth tools (auth stays with the agents' own credential stores; a run that hits `AUTH_REQUIRED` pauses and resumes out-of-band).

`env`/`meta` payloads are **SECRET** and flow only through the resolver return value into the `AuthStore` and the spawn env — never into events, journals, logs, error messages, or `status()`. `logout()` clears the store (zeroizing the secret payload), recycles the pool, and issues the agent `logout` RPC only where advertised. Default-OFF: with neither `onAuth` nor `authCapabilities` set, the wire behavior is byte-identical to a host that never opted in.

**Per-agent auth profiles.** The four built-in backends carry a pure-data `AuthProfile` (`claudeAuthProfile`/`codexAuthProfile`/`opencodeAuthProfile`/`piAuthProfile`, exported from `@automatalabs/acp-agents`); a custom backend supplies **none** (`Backend.authProfile` undefined) and runs the base flow verbatim — conformance is defined by the *absence* of a profile. A profile is enrichment only and never gates the flow: it refines which auth method **types** the backend advertises via `clientAuthCapabilities({ onAuth, terminal })` (Codex never advertises `terminal`; OpenCode never advertises `gateway`; pi's env-var and stored-credential methods need neither gate; Claude follows both host affordances), and relabels the type-dispatched descriptor via `describe`. Pi's profile adds concrete remediation for all six advertised methods: five provider env keys and `pi-stored-credentials` at `~/.pi/agent/auth.json`. Only `codexAuthProfile` defines `spawnAuthEnv`: it emits the codex `DEFAULT_AUTH_REQUEST` startup env for `api-key`/`gateway` intents so a freshly recycled process pre-authenticates before its first gated request — layered **on top of** the universal post-`initialize` replay, never replacing it and never required for correctness. The `AuthMethod.type` discriminants, the cross-agent `_meta` convention keys, the codex `DEFAULT_AUTH_REQUEST` channel, and pi's frozen wire profile are pinned as build-time drift tripwires (`HANDLED_AUTH_METHOD_TYPES`, `AUTH_META_CONVENTION_KEYS`, `CODEX_SPAWN_AUTH_ENV`, `AUTH_META_MATRIX`, `PI_ACP_PROTOCOL_CONTRACT`).

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

- `@agentclientprotocol/claude-agent-acp@0.66.0`: advertises `auth.logout`, implements `logout`, and implements `authenticate` for its gateway auth methods; terminal login methods are advertised only when the client advertises terminal auth support. As of 0.60.0 it advertises `providers` and implements `providers/list`, `providers/set`, and `providers/disable` for a single provider `providerId` `"main"` supporting `apiType` `anthropic`, `bedrock`, and `vertex`; `providers/set` rejects any other `providerId`/`apiType` with invalid-params, and `vertex` additionally requires `_meta.claudeCode.vertex.{projectId,region}` (recorded as durable routing config and replayed on every reconstructed `providers/set`, so pooled connections re-route correctly). `providers/disable` is idempotent.
- `@automatalabs/codex-acp` (workspace, `packages/codex-acp`): advertises `auth.logout`, implements `authenticate` (`api-key`, `chat-gpt`, and `gateway` when gateway support is advertised), and implements `logout`. As of 1.6.0 (upstream sync) it also advertises `providers` and implements `providers/list`, `providers/set`, and `providers/disable` for its single client-configurable custom gateway provider: `providerId` `"custom-gateway"`, `supported: ["openai"]`, `required: false`, `current` carrying only the non-secret `{ apiType, baseUrl }` (never headers) and `null` while unconfigured; `providers/set` rejects any other `providerId`/`apiType` with invalid-params and `providers/disable` is idempotent. Its separate reasoning-effort options remain agent-owned configuration; model-spec brackets are never interpreted by this client.
- Host-resolved OpenCode (`opencode-ai` 1.17.14 in the verified profile): advertises the `opencode-login` terminal-style method when the client advertises terminal auth, acknowledges `authenticate`, and relies on its provider credential store; it does not advertise logout. The credential-gated live suite verifies the installed executable because OpenCode is not bundled.
- `@automatalabs/pi-acp`: unconditionally advertises `anthropic-api-key`, `openai-api-key`, `gemini-api-key`, `xai-api-key`, `openrouter-api-key`, and `pi-stored-credentials`. The first five are `env_var` methods; the stored-credentials method is a bare `agent` method backed by `~/.pi/agent/auth.json`. Authentication is ambient/no-op, while a known model with missing credentials rejects with ACP `-32000`.

### Protocol passthrough & coverage

`PooledConnection` and `InteractiveSession` expose typed raw ACP `request()` / `notify()` escape hatches for spec methods without named wrappers:

```ts
import { AGENT_METHODS } from "@automatalabs/workflows";

await session.request(AGENT_METHODS.mcp_message, { connectionId, method: "tools/list" });
```

Prefer named wrappers (`prompt()`, `setMode()`, `openSession()`, etc.) when they exist; they preserve engine semantics like drain accumulation, local mode state, and usage recording, while raw `session/prompt` bypasses them.

Raw `request()` rejects the session-stateful methods that would create or reopen sessions outside the router: `session/new` (use `openSession()`), `session/load` (use `loadSession()`), `session/resume` (use `resumeSession()`), `session/fork` (use `forkSession()`), and `_session/steering` (use `steer()`). Those raw sessions are unregistered: updates do not fold into an accumulator, permission requests auto-cancel, and fs/terminal dispatch fails for unknown sessions.

`AGENT_METHOD_COVERAGE` and `CLIENT_METHOD_COVERAGE` classify every method constant exported by the installed ACP SDK. Agent methods are `"driven"`, `"passthrough"`, or `"guarded"`; guarded means no safe driven wrapper exists. Agent coverage is 16 operational driven methods plus `initialize`, 0 guarded methods, and passthrough for `nes/*`, `document/*`, and `mcp/message`. The raw guards for session-stateful `session/new`, `session/load`, `session/resume`, `session/fork`, and `_session/steering` require their driven wrappers. `ACP_EXTENSION_SUPPORT_MATRIX` separately records that vendor extension (Claude, Codex, and pi supported; OpenCode typed-unsupported), so it is never counted as a standard `AGENT_METHODS` method. Client methods are currently 14/14 served. A tripwire test compares the standard manifests against `AGENT_METHODS` / `CLIENT_METHODS`, and probes installed Claude/Codex extension advertisements. Arbitrary agent extensions use the existing generic overloads `session.request<Response, Params>(method, params)` and `session.notify<Params>(method, params)`; method strings, params, responses, and agent-provided numeric errors pass through unchanged, while notifications have no response.

### <a name="runner-events"></a>Events (`runner.on(name, listener)`)

Typed bus; returns an unsubscribe thunk. Names are the ACP `sessionUpdate` discriminants verbatim (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …) plus cross-cutting events: `session_update` (catch-all), `permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `steering`, `session_open`, `session_close`, `backend_error`. `steering` carries normal session context plus only `{ outcome }` after every resolved `_session/steering` response (including `failed`), never the request's prompt or metadata; thrown requests emit nothing. Every session-scoped payload carries `AcpEventContext`: `{ sessionId, backendId, label?, runId?, callIndex?, initializeMeta? }` — the engine stamps `runId`/`label`/`callIndex` on workflow agents, and `initializeMeta` is the session's stable initialize-response snapshot. `backend_error` remains connection-scoped with exactly `{ backendId, error }`.

### Interactive sessions

```ts
const session = await runner.openSession({ model: "claude", cwd: "/abs/dir" }); // held open
const turn = await session.prompt("first turn");            // { stopReason, text }
await session.prompt([{ type: "text", text: "..." }], { images });  // image blocks degrade to a
                                                                    // text note if unadvertised
const off = session.on("agent_message_chunk", render);      // session-filtered subscription
await session.setMode("default");                           // switch after host approval
await session.cancel();                                     // cancel the active turn only
await session.release();                                    // end session; pooled process survives
```

`session.steer(content, { images?, promptMeta? })` is available only while `prompt()` is in flight. It adapts the same text/image content and optional request metadata as a prompt, then returns the backend response unchanged: `"injected"`, `"startedNewTurn"`, or `"failed"`. It never creates or owns a turn, output, usage, retry, or ordering lock; output remains on the original prompt's updates and that prompt's response. Idle callers receive a host-side error directing them to `prompt()`. Support is strict, defensive initialize negotiation only: `InitializeResponse._meta.steering.supported === true`; it does not inspect `agentCapabilities._meta`, backend names, or versions. Claude, Codex, and pi advertise this extension; OpenCode is rejected as a nonrecoverable `SCRIPT_VALIDATION_ERROR` before a steering wire request.

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

Lifecycle methods are capability-gated after initialize. In particular, `forkSession()` requires `sessionCapabilities.fork`; when absent it throws a non-recoverable `WorkflowError` naming the backend and `session/fork` before any fork request is sent. The installed `@agentclientprotocol/claude-agent-acp@0.66.0` advertises `loadSession: true` plus `sessionCapabilities` for list/delete/resume/close/fork (fork verified live: the forked session carries the source conversation's context). `@automatalabs/codex-acp` (workspace) advertises `loadSession: true` plus list/delete/resume/close — no fork yet. OpenCode advertises load/list/resume/close/fork (also verified live). `@automatalabs/pi-acp` advertises load plus list/resume/close/fork and deliberately omits delete; unsupported lifecycle methods still fail through the same gate. The `_session/loaded_turn` extension (turn-terminal state for loaded sessions — the re-attach arm's authoritative completion evidence, see the `loadSession()` paragraph above) is advertised and served only by the in-repo `@automatalabs/pi-acp` and `@automatalabs/codex-acp`; claude and opencode do not advertise it, and their re-attached calls are classified by the seam's OBSERVATION path instead — the post-load continuation watch plus the replay probe under the connection-death contract (see the `loadSession()` paragraph): the built-in ACP servers terminate in-flight turns when the client connection closes (live-verified), so the replay's trailing content is authoritative and a possibly-running call is NEVER released-and-re-issued (phase-F review round 2 — re-issue is reserved for the observably-dead classes: the interrupted classification, a transcript that never received its prompt, a dead session, or a third-party adapter with no seam at all). The `ACP_EXTENSION_SUPPORT_MATRIX` in `packages/acp-agents/src/protocol-coverage.ts` pins all eight rows.

### Capabilities

The one-time `initialize` handshake negotiates per-connection capabilities, readable as `NegotiatedCapabilities` (exported). It includes the full `agentCapabilities`, `agentInfo`, initialize `_meta`, advertised `authMethods`, and strict `supportsSteering`. Steering is true only for the exact top-level `InitializeResponse._meta.steering.supported === true` boolean; `agentCapabilities._meta` remains exclusively the outgoing optional-custom-metadata gate. Prompt-content flags are **booleans**: `capabilities.agent.promptCapabilities?.image === true` etc. You rarely need to gate manually — `adaptPromptContent` already degrades unsupported `image`/`audio`/`resource` blocks to a bracketed text note naming the backend. The client truthfully advertises: `fs`/`terminal` only when you registered handlers, plus `session.configOptions.boolean` always (boolean config options are handled natively). The installed ACP SDK has no `ClientCapabilities` field for MCP-over-ACP; the real declaration is a `session/new` MCP server entry `{ type: "acp", name, serverId }`, gated before the session is opened.

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

Installed backend status verified from the packaged dists: `@agentclientprotocol/claude-agent-acp@0.66.0` advertises `http`/`sse` MCP support but no `acp`, `@automatalabs/codex-acp` (workspace) advertises `mcpCapabilities: { acp: false, http: true, sse: false }` and rejects ACP MCP config internally, OpenCode advertises HTTP/SSE MCP support, and `@automatalabs/pi-acp` serves stdio, Streamable HTTP, and SSE while advertising `{ http:true, sse:true }`. Pi also consumes the stable MCP base protocol plus sampling, roots, and form/URL elicitation; client-hosted `acp` remains runner-owned.

---

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
| custom | `backends` option or `AGENTPRISM_BACKENDS` (JSON) | `CustomBackendConfig`: `command`, `args?`, `env?` (a **scoped overlay** for the child only — put per-backend secrets here, never in the ambient env), `sessionMeta?`, `customCapabilities?` |

Workflow scripts may *declare* backends via `meta.backends`, but declarations are inert until the composition root approves them (`allowScriptBackends` / `ExecOptions.scriptBackends` / `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1`).

**Environment variables**: `AGENTPRISM_ACP_POOL_SIZE` (processes per backend, default 1), `AGENTPRISM_ACP_INIT_TIMEOUT_MS` (initialize handshake deadline, default 60s), `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS` (the re-attach arm's terminal-wait backstop for a `running` loaded turn, default 15min), `AGENTPRISM_OPENCODE_DATA_ROOT` (overrides the opencode built-in's stable per-user XDG data/state/cache root — the tree where agent-persisted sessions live so cross-process `session/load` re-attachment is real), `AGENTPRISM_DEFAULT_BACKEND` (`claude` | `codex` | `opencode` | `pi` | custom name), `AGENTPRISM_BACKENDS` (host custom-backend registry JSON), `AGENTPRISM_PERSISTENCE_ROOT`, `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, `AGENTPRISM_OPENCODE_E2E_MODEL` (live e2e only; default `opencode/openrouter/moonshotai/kimi-k3`), `AGENTPRISM_PI_E2E_MODEL` (live e2e only; default `openrouter/google/gemini-2.5-flash`), plus the per-backend `*_CMD`/`_ARGS`/`_BIN` above.

---

## Errors — `WorkflowError`

One runtime class (from `@automatalabs/shared-types`, so `instanceof` holds across packages) with `.code`, `.recoverable`, `.agentLabel?`, `.resetHint?`, `.providerUsageLimitContext?`, `.authContext?`, and `.checkpointContext?`. Recoverable agent failures retry up to `agentRetries`, then resolve that agent to `null`; non-recoverable ones halt the run except the three manager-owned pause codes called out below.

| Code | Recoverable | Meaning / engine behavior |
|---|---|---|
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, protocol mismatch). |
| `SCRIPT_ERROR` | no | The script **crashed at runtime**: uncaught throw or unhandled promise rejection in the script body. Run fails. |
| `WORKFLOW_ABORTED` | — | Actual cancellation (pause/stop/signal). Never used for crashes. |
| `AGENT_TIMEOUT` | yes | Total wall-clock attempt cap exhausted. Each retry gets a fresh clock; after exhaustion the call settles to `null`, and an ACP turn that ignores cancel is closed/recycled after its grace period. |
| `AGENT_CANCELLED` | yes | The host selected one in-flight agent. It settles to `null`, skips retries, leaves the run and siblings live, and creates a failed call record but no replayable journal result. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call. |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the repair ladder. |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall → the run **pauses** (journaled, resumable), carries `providerUsageLimitContext` and a synthesized `resetHint` when a reset instant is available. |
| `AUTH_REQUIRED` | no | Agent demanded auth (`-32000`) → the run **pauses** (`reason: "auth_required"`, journaled, resumable), carries the non-secret `authContext`; `resume()` re-arms via `runner.auth.canResume`. |
| `CHECKPOINT_REQUIRED` | no | `checkpoint(..., { headless: "pause" })` has no live channel → the run **pauses** with non-secret `checkpointContext`; resume with `checkpointReplies` or a live `confirm`. |
| `AGENT_LIMIT_EXCEEDED` | no | Run caps hit. (`TOKEN_BUDGET_EXHAUSTED` is deleted with the token budget — the §7 budget removal.) |
| `AGENT_EXECUTION_ERROR` | yes | Other agent-level failure (refusal/truncation are non-recoverable variants). |
| `PERSISTENCE_ERROR`, `UNKNOWN` | no | Storage / unexpected host-level failure. |

**Script-fault containment**: a promise a script floats (un-awaited `agent()`, a stray `Promise.reject`, a `.then()` chain) is attributed to its run by realm identity and fails it with `SCRIPT_ERROR` — it does not crash the host process, and in-flight agents are cancelled. Caveat: Node invokes every `unhandledRejection` listener, so a host that installs its own listener will still *observe* contained script floats; rejections no workflow owns preserve platform semantics (your listener stays in charge; with no listener the process crashes exactly as it would without the engine).

---

## MCP server

`npx @automatalabs/mcp-server` (bin `agentprism-workflow`) speaks stdio MCP and exposes two model-facing tools, **`workflow`** and **`repl`** (a persistent JavaScript REPL — see [The `repl` tool](#the-repl-tool) below). By default the stdio process is a thin shim proxying to the shared per-user workflow daemon (Streamable HTTP on loopback, auto-started, spec 2025-11-25 session management and resumability); `--in-process` serves everything in the one stdio process instead, and HTTP-capable hosts can register the daemon URL directly (`agentprism-workflow daemon url`). The tool contract is identical on every path except one knob: the daemon **requires** `projectDir` on run inputs, while an in-process server defaults it to its own project. Its input is this union:

```ts
interface WorkflowExecuteToolInput {
  action?: "run";
  script: string;
  projectDir?: string; // absolute project directory: selects the project-scoped run store and
                       // default execution cwd. REQUIRED on the shared workflow daemon; optional
                       // on a single-project (--in-process) server, defaulting to its own project.
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  resumeFromRunId?: string;
  resumePolicy?: "auto" | "positional";
  checkpointReplies?: Record<number, unknown>;
  background?: boolean; // default false
}

interface WorkflowInspectToolInput extends WorkflowRunInspectionOptions {
  action: "inspect";
  runId: string;
}

interface WorkflowAwaitToolInput extends WorkflowRunInspectionOptions {
  action: "await";
  runId: string;
  waitMs?: number; // default 20_000; integer 0..25_000
}

interface WorkflowExecutionToolResult<T = unknown> {
  runId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
  limits: WorkflowRunLimits;
  result?: T;                            // completed only
  tokenUsage?: TokenUsage;
  logs?: string[];
  logTail?: WorkflowLogTail;             // paused/failed/aborted only
  authContext?: AuthErrorContext;
  checkpointContext?: CheckpointContext;
  fallbacks?: WorkflowRunFallback[];
  checkpointsTaken?: WorkflowCheckpointTaken[];
  resumeReport?: WorkflowResumeReport;   // resumeFromRunId executions only
  replayEligibility?: WorkflowReplayEligibility;
}
```

Mixed/missing branches, invalid run IDs, invalid inspection bounds, and `waitMs` outside 0–25,000
are MCP Invalid Params (`-32602`). Omitted action/background preserves foreground execution byte for
byte: it streams progress, honors request cancellation and live checkpoint elicitation, and returns
`WorkflowExecutionToolResult<T>`. `action:"inspect"` remains immediate and returns exactly the safe
`WorkflowRunStatus`; it never parses a script, invokes a runner, approves a backend, elicits, reports
progress, or acquires a lease.

`background:true` reserves one of four process-local active-or-starting slots, performs parsing,
script-backend approval, lease acquisition, and the durable initial save, then returns:

```ts
interface WorkflowBackgroundAccepted {
  runId: string;
  status: "running";
  limits: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
}
```

It does not await script/agent completion. The initiating request has no enduring signal, progress
channel, or live checkpoint `confirm`; checkpoints use authored headless behavior. Even when that
start request supplied a progress token, it emits no background progress after returning.
Cancelling the accepted call cannot abort the run. A fifth run fails with
`Background workflow limit reached (4 active or starting runs). Await an existing run and retry.`
Foreground, inspect, and await do not consume slots. A background `resumeFromRunId` creates a new run
ID and copies the complete inherited journal plus any synthetic checkpoint answer into that new
run's initial durable record, preserving multi-hop resume safety. Its acknowledgement includes the
admission-time `replayEligibility` prediction before the script body is allowed to execute.

Every newly admitted response reports its resolved `limits`. The same object appears on foreground
results, background acknowledgements, inspect/await status, and terminal await `outcome`; legacy
persisted records that predate limit storage may omit it. Failed call rows include their resolved
`timeoutMs` and `errorCode`, so an exhausted attempt is directly inspectable as `AGENT_TIMEOUT`.

```ts
interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate";
}

interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowAwaitMetadata;
  tokenUsage?: TokenUsage;
  outcome?: WorkflowExecutionToolResult<T>; // present exactly at terminal status
}
```

Await returns immediately for terminal runs, is a non-blocking read at `waitMs:0`, and otherwise
waits only for terminal lifecycle state for at most the requested duration. For new-format runs it
tails the generation-pinned event sidecar. When the **await request** carries a progress token, the
server emits the existing coarse notification shape after each phase, distinct agent start, and
first terminal agent end for `(scope, callIndex)`: `progress` is the number of distinct ended calls,
`total` is distinct started calls (omitted while zero), and `message` is the latest phase title
(omitted until known). Snapshot agent rows/current phase seed those sets, and the tail begins after
the snapshot watermark, so a late await neither scans the unbounded history for progress state nor
double-counts the known prefix.

The local settlement promise may still win the terminal race without disabling tail progress. For
legacy, incomplete, corrupt, mismatched, or otherwise unsafe event logs, await explicitly falls back
to 250-ms `inspectRun()` terminal polling and emits no progress notifications even if that await has
a token. Await cancellation closes its watcher/poller, ends only that request, and returns
`Workflow await for runId "<runId>" was cancelled; the workflow was not cancelled.` with no
structured content. Await is a successful read even for failed/aborted lifecycle status. Partial
`tokenUsage` is cumulative live work in this execution only; cached replay adds zero. At terminal,
top-level and `outcome.tokenUsage` are identical.

Terminal `outcome` is live-first and reconstructed from project-scoped persistence after restart,
normalizing legacy missing `cost` to zero. Completed outcomes contain the exact authored result and
raw full logs; paused outcomes carry existing non-secret `authContext`/`checkpointContext` and resume
guidance. Retrieval has no TTL and remains available until SDK/manual deletion, corruption, or store
loss. The inherited status portion retains its 24,576-byte/redaction budget and await text its
8,192-byte cap; raw terminal `outcome` intentionally has no new envelope cap and is never duplicated
into text.

Runs execute in the shared per-user workflow daemon (the default stdio entry is a thin shim that
proxies to it and auto-starts it), so a client disconnect, shim kill, or session eviction does not
stop in-flight work. Daemon exit (signals, `daemon stop`, crash, machine shutdown) — or, under
`--in-process`, the single client-owned process exiting — can; there is no cross-machine handoff.
The initial record and completed call prefix remain durable, later writes are best effort, and
construction or a cold await/inspect/stop/resume preflight reconciles an orphaned
`pending`/`running` record to `paused` / `interrupted` for an explicit new `resumeFromRunId`
execution.
The MCP input does not resolve saved workflow names; name resolution is an SDK/`openWorkflowDir`
feature. The server honors the SDK environment variables plus `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`.

Inspect returns exactly `WorkflowRunStatus`. Its JSON structured content is capped at 24,576 bytes
and its formatted text at 8,192 bytes. An existing failed or aborted run is still a successful read.
An unknown/corrupt/unreadable run is `isError:true`, has no structured content, and returns exactly
`No workflow run found for runId "<runId>" in this server's project-scoped run store.` Execution
keeps current error semantics: failed/aborted are tool errors, paused is a successful resumable
call. Non-completed execution text includes the manager's final-20 redacted `logTail` and is capped
at 12,288 bytes; malformed pre-run scripts have no run ID or tail.

**The `author-workflow` prompt.** Prompt-capable hosts additionally get one user-controlled MCP prompt, `author-workflow` (optional `task` argument): it returns the complete, self-contained authoring guide — SKILL.md + the exhaustive reference tables + a validated example script, generated from `skills/agentprism-workflow-authoring` at `scripts/generate-authoring-prompt.mjs` and version-matched to the installed engine. Prompts never enter the model's tool-selection loop, so the prompt adds no tool to the model-facing surface (`workflow` and `repl`).

**Auth is the agents' own concern.** Claude, Codex, and OpenCode use their CLI credential stores; pi uses provider environment keys or `~/.pi/agent/auth.json`. Configured credentials need no MCP-side step, and the server exposes no auth state for a host to inspect or manage. A run that genuinely hits ACP `AUTH_REQUIRED` pauses with `reason:"auth_required"` and a summary built from the structured, non-secret `authContext` (backend id + advertised method `{ id, type, name }[]`) — never parsed from the error message — directing out-of-band credential configuration followed by `workflow` with `resumeFromRunId`. Programmatic credential injection and provider routing (`completeAuth`, `listProviders` / `setProvider` / `disableProvider`) are [SDK runner APIs](#auth--providers) for embedding hosts.

### The `repl` tool

The server also registers a second model-facing tool, **`repl`** — a persistent QuickJS-in-WASM JavaScript REPL, **one VM per `projectDir`**, for live, stateful subagent orchestration (the interactive complement to `workflow`'s deterministic scripts). Workspace state — bindings, pending subagent calls, raised checkpoints, logged values — persists in the VM across tool calls, MCP-session churn, and daemon restarts. Its full contract, with worked examples per action, is in the [package README](../packages/mcp-server/README.md#the-repl-tool); the surface in brief:

```ts
type ReplToolInput =
  | { action: "eval"; projectDir?: string; code: string; timeoutMs?: number } // timeoutMs default 60_000, hard cap 120_000
  | { action: "interrupt"; projectDir?: string; id?: string };
```

`projectDir` is required on the shared daemon for **both** actions, and defaults to the server's own project on `--in-process`. The input schema is **strict**: a missing required field and **every key outside the action's exact set** — the deleted v1 `wait`/`status`/`reset` actions, `ids`, `refs`, … included — are rejected as Invalid Params (`-32602`), never silently discarded. Every result carries `structuredContent` (the exact same shape as the published `outputSchema`) alongside the human text. `eval` holds the call open pumping settlements up to the soft bound: the **finished** shape `{ output, result }` when everything the code waits on settles within the bound, the **still-running** shape `{ output, running: [call ids] }` when the bound elapses (the eval continues server-side; any later eval — including `""`, the documented idempotent poll — drains what settled, and a poll picks a drained timed-out eval's completion repr up as its own `result`), or the **thrown** shape `{ output }` (the §4.6 error rendering, no completion value). `output` is ONE newline-joined string — console lines, raised checkpoint lines, error renderings, and the one-line durability notices — with **no caps anywhere** (the v1 `pending`/`completed`/`checkpoints`/`outputTruncated`/`truncated`/`referenced` fields and the whole cap/ref apparatus are deleted with the §7 budget sweep):

```ts
type ReplToolOutput =
  | { output: string; result: string }                                  // eval finished (a guest undefined renders "undefined")
  | { output: string; running: string[] }                               // eval still running (the in-flight c1, c2, … ids)
  | { output: string }                                                  // eval threw / was broken mid-run
  | { interrupt: { outcome: "targeted" | "refused-idle" | "cancelled" | "idle" | "failed" | "none"; callId?: string } }
  | { error: string };                                                  // isError: true — a missing project context
```

`interrupt` keeps v1's semantics: with `id` it cancels that subagent call (the guest promise rejects recoverable, `AGENT_CANCELLED` family); without `id` it breaks the running eval, honestly `refused-idle` when nothing is running. Introspection went in-band as guest functions returning ordinary values: `workspace()` (`{ bindings, inFlight, checkpoints, diagnostics }` — `diagnostics` carries the §6.2 demotions: the last reconcile summary, a retained drain error, `childrenClosed`), `agents()` (the live-agent entries), and `reset()` (teardown after the current eval). A stored snapshot that **refuses** (corrupt, format bump, wasm-hash mismatch) now **auto-resets**: the refused file is renamed aside (`.refused-<ts>`, never deleted) and the next eval's output leads with a one-line notice; a restore that **lost calls** or a drain failure that **lost state** gets the same one-line-notice treatment (losses are never silent). Printing follows the §4.4 repr rules (direct strings whole; depth 2; 20 entries per level; nested strings 200 chars head+tail) with no byte ceilings — the Python posture. Subagent `agent()` calls and `checkpoint()` draw from **one shared per-workspace id sequence** — `c1`, `c2`, … — answered by `checkpoint.answer("c2", value)` in a later eval; raised checkpoints surface as output lines. Subagents are [`acp-agents`](#acpagentrunner-createacprunner) sessions, 6 concurrent per workspace (dispatches above the cap queue); the workspace snapshots to the per-project store at every state-changing boundary and restores **lazily on first touch** with a three-way call reconcile (settle / re-attach / re-issue). `repl` shares the `workflow` tool's project model and daemon lifetime.

## `@automatalabs/repl-engine`

The engine tier the `repl` tool registers over (unreleased at `0.0.0`; imported by `mcp-server` as `workspace:*`). It is a persistent JavaScript REPL in a capability-free QuickJS-in-WASM VM; the public surface:

- **`Workspace`** / **`WorkspaceRegistry`** (`WorkspaceOptions`, `WorkspaceRegistryOptions`, `WorkspaceManifest`, `WorkspaceBinding`) — one VM per workspace, owning the lifecycle (`create` → `eval` → `drainJobs` → `dispose`) and the manifest surface. `ReplVm` (`loadShippedWasm`, `ReplVmOptions`, `ReplEvalOptions`, `ReplDrainOptions`, `ReplEvalOutcome`, `DrainJobError`) is the raw quickjs-wasi shim tier.
- **`Broker`** (`DEFAULT_MAX_CONCURRENT_AGENTS`, `DEFAULT_EVAL_TIMEOUT_MS`, `DEFAULT_DISPOSE_BOUND_MS`, `BrokerOptions`, `BrokerRunner`, `ReplEvalResult`, `CheckpointSummary`, `LiveAgentInfo`, `ReconcileReport`, `WorkspaceManifestReport`, …) — drives subagents as ACP sessions, records results by call id, and reconciles on restore. The call store is `InMemoryCallStore` / `JsonlCallStore` (`CallStore`, `CallRecord`, `CallOutcome`, …).
- **Snapshots and durability** — `serializeSnapshot` / `deserializeSnapshot` / `wasmSha256Of`, `SNAPSHOT_FORMAT` / `SNAPSHOT_FORMAT_VERSION`, `SnapshotEnvelopeError` / `SnapshotRestoreError`, and the per-project `ReplWorkspaceStore` (`REPL_STORE_SUBDIR`, `SNAPSHOT_FILENAME`, `CALL_STORE_FILENAME`).
- **The previewer** — `renderPreviewLine` / `renderCollapsed` / `renderGlobalLine` / `manifestBinding` / `formatByteSize` and the CDP preview types (`ObjectPreview`, `PropertyPreview`, …). The output-cap apparatus (`applyOutputCaps` / `capFinalText`, `OUTPUT_MAX_LINES` / `OUTPUT_MAX_BYTES`) is deleted with the §7 budget sweep — the engine applies no caps to guest output; the previewer stays for internal metadata bounds (manifest tokens, checkpoint/task previews).
- **The guest bridge and provenance** — `installGuestBridge`, `GUEST_LIBRARY_VERSION`, the `HOST_*` callback names; `provenanceRecord` / `provenanceView` (`eval N` / `worker cN` / `session restore` labels).
- **The out-of-band eval-break channel** — `createEvalBreakChannel` / `EvalBreakChannel` (the worker-thread relay the MCP shim fires to break a synchronous runaway).

The full engine contract (guest library, host-call surface, FORMAT.md preview rules, reconcile semantics) is documented in the [package README](../packages/repl-engine/README.md).

### The `repl` adapter exports from `@automatalabs/mcp-server`

`@automatalabs/mcp-server` re-exports the REPL adapter surface for hosts mounting the tool themselves: `replToolInputShape` / `replToolOutputShape` (the Zod input/output schemas), the `ReplToolOptions` type, `createReplProjectState` / `ensureReplWorkspace` / `disposeReplProjectState` / `resetReplProjectState` and the `ReplProjectState` type (per-project workspace state), and `ReplPresenceLedger` (the client-presence drain). `createWorkflowServer` registers both `workflow` and `repl`; `CreateWorkflowServerOptions` exposes `replRunner` / `replPresence` / `replClientId` / `replEvalBreakChannel` / `replDrainBoundMs`. Breaking a *fully synchronous* runaway requires the relay stdio transport `main()` installs; a vanilla `StdioServerTransport` bounds it only by the per-eval deadline (`AGENTPRISM_REPL_EVAL_TIMEOUT_MS`, default 30 000 ms).

## Workflow script DSL

Scripts run in a deterministic `vm` realm (`Date.now`/`Math.random`/argless `new Date()` throw — the journal/resume identity depends on it; the realm is a determinism boundary, **not** a security boundary). Realm globals:

`agent(prompt, { label?, schema?, model?, mode?, configOptions?, tier?, phase?, isolation?, resume?, cwd?, timeoutMs?, retries?, mcpServers?, images?, agentType?, meta?, promptMeta?, keepSession? })` · `parallel(thunks)` (barrier; failed thunks → `null`) · `pipeline(items, ...stages)` (no inter-stage barrier) · `workflow(nameOrScript, args?)` (one level of nesting) · `checkpoint(prompt, opts?)` (journaled human gate; live/default/abort/durable-pause modes) · `gate(thunk, validator, opts?)` · `retry(thunk, opts?)` · `verify(item, opts?)` · `judgePanel(...)` · `loopUntilDry(opts)` · `completenessCheck(args, results)` · `phase(title)` · `log(msg)` · `args` · `cwd`. (`budget` and the per-phase budget option are deleted with the §7 budget removal; `phase(title, { budget })` is a script error.)

`gate()` validators may return `{ ok: boolean, feedback?: string, ... }`, a bare boolean, or
`null`. A fulfilled gate returns exactly `{ ok, value, verdict, attempts }`: `value` is the final
producer result and `verdict` is the exact last completed validator return (`null` is retained;
an unsupported explicit `undefined` is normalized to `null`). Bare `true` passes, while `false`
and `null` reject without feedback.

`keepSession:true` skips the release-time `session/close`; the resulting `AgentSessionRecord` is returned in `WorkflowRunResult.agentSessions` so the host can later call `runner.loadSession()` or `runner.resumeSession()`.

See the [README](../README.md#writing-workflow-scripts) for authoring guidance and examples, and [`design-notes.md`](design-notes.md) for the protocol-level design.
