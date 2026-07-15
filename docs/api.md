# API reference

The integrator-facing surface of the `@automatalabs/*` packages, in one place. This documents the supported integration APIs; package barrels also expose lower-level protocol utilities for advanced hosts, which remain typed but are not all repeated here. Version references are current for `workflows` 0.23.1, `acp-agents` 0.22.1, `workflow-engine` 0.12.0, `shared-types` 0.14.0, `mcp-server` 0.4.1, and `agentprism-otel` 0.1.0.

Packages (all published to npm, Apache-2.0, ESM-only, Node >= 22):

| Package | What it is | Depend on it when |
|---|---|---|
| `@automatalabs/workflows` | Facade re-exporting the supported orchestration surface (`runDynamicWorkflow`, `createAcpRunner`, `WorkflowManager`, auth/session types) | You want the SDK. **Start here.** |
| `@automatalabs/workflow-engine` | The deterministic script engine + `WorkflowManager` (no agent construction — the runner is injected) | You bring your own `AgentRunner` and don't want ACP deps |
| `@automatalabs/acp-agents` | The ACP runner: pooled Claude/Codex/OpenCode ACP processes, model routing, structured output, events, interactive sessions | You want agent execution without the workflow engine |
| `@automatalabs/shared-types` | The seam contracts: `AgentRunner`, `RunOptions`, `WorkflowError` (+ codes), workflow result/meta types | You implement a custom runner or need `instanceof WorkflowError` across packages |
| `@automatalabs/mcp-server` | Stdio MCP server (bin `agentprism-workflow`) exposing one `workflow` tool for foreground/background run, bounded await, resume, and inspect | You drive workflows from Claude Code / an MCP client |
| `@automatalabs/agentprism-otel` | Optional OpenTelemetry bridge for `WorkflowManager` traces and metrics | Your host owns an OTel SDK and wants run/agent/tool observability |
| `@automatalabs/codex-acp` | Fork of `@agentclientprotocol/codex-acp` adding turn-level `outputSchema` forwarding | Installed automatically by `acp-agents`; only pin it directly to override the version |

---

## Two front doors

**One-shot (facade):** construct nothing, get a terminal result.

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const run = await runDynamicWorkflow(script, {
  cwd: "/abs/path/to/project",   // every agent session runs here
  args: { target: "src/" },      // exposed as the script's `args` global
  exec: { tokenBudget: 500_000 },
});
// Never throws for ordinary outcomes — read run.status: "completed" | "paused" | "failed" | "aborted"
```

Options (`RunDynamicWorkflowOptions`): `runner?` (custom `AgentRunner`; defaults to `createAcpRunner()`), `cwd?`, `args?`, `exec?` (an [`ExecOptions`](#execoptions--per-run)), `allowScriptBackends?` (approval policy for script-declared `meta.backends`), `workflows?` (a [`WorkflowDir`](#workflow-directories--openworkflowdir) view or dir path(s): the first argument may then be a workflow NAME — any string without the mandatory `export const meta` head is resolved via the view's `read()`, throwing a diagnosable searched-dirs/did-you-mean error on a miss — and nested `workflow("<name>")` calls resolve from the same view).

### <a name="workflow-directories--openworkflowdir"></a>Workflow directories — `openWorkflowDir`

`openWorkflowDir(dir | dirs, { cwd? })` binds a read-only view over folders of versioned workflow scripts. Construction does **no I/O** (nothing created, scanned, or cached); every method reads the filesystem at call time so the view always reflects the current working tree, and missing dirs contribute nothing. The filename stem is the name (`review-pr.workflow.js` / `review-pr.js` ⇒ `review-pr`; across dirs first hit wins, within a dir `.workflow.js` beats `.js`; also `.mjs` variants). Surface: `dirs` (absolute, precedence order), `list()` (`[{ name, file, meta?, error? }]`, meta parsed per call, sorted), `read(name)` (script text; throws with searched dirs + closest matches), and `resolve(name)` — `(name) => string | undefined`, deliberately the exact `loadSavedWorkflow` contract, with strict name-shape validation (one flat path segment) so inline nested scripts fall through and path traversal is impossible. Exported by both `@automatalabs/workflow-engine` and the facade.

**Script validation (token-free):** `validateWorkflowScript(script, opts?)` runs a static parse (meta literal, syntax, and direct nondeterministic call expressions) plus a dry run over an in-process mock `AgentRunner`, then opens one no-prompt session on every distinct routed ACP harness to read its advertised config options. The probe spends no tokens. `dryRun.harnessOptions` reports each catalog verbatim on every run, even when the script authors no `configOptions`; the human formatter prints the same per-harness table. Authored exact ids and values are checked for unknown ids, invalid select values, non-boolean boolean values, and the reserved `"model"` id. A probe spawn/auth/session failure adds one warning, sets that harness to `probed:false`, and skips its checks without invalidating the report. A mock live confirm answers checkpoints with `default ?? true`, so `headless: "pause"` dry-runs cleanly; `headless: "abort"` warns because a truly unattended run would abort. Script-declared backends are treated as approved (with a warning). Invalid scripts resolve to a report; read `report.ok` / `report.exitCode` (`0` valid, `1` parse failure, `2` dry-run or config-option failure). `ValidateWorkflowOptions` is `{ args?, workflows?, dryRun?, cwd?, tokenBudget?, maxAgents?, timeoutMs?, mockAnswers? }`; `workflows` accepts a `WorkflowDir` or dir path(s), the mock reports `MOCK_TOKENS_PER_AGENT` = 1000 per call, and timeout defaults to 30 000 ms.

`MockAnswers` is a read-only record from label glob to JSON answer or `{ $sequence: readonly MockAnswerJson[] }`. Matching uses the final resolved label, is case-sensitive and whole-label, and supports `*`, `?`, and backslash escaping. Normalization captures property order once and the last matching rule wins. Raw canonical array-index keys `"0"` through `"4294967294"` are reserved because ECMAScript reorders them; spell an exact numeric-label rule with an escape, such as JSON key `"\\10"` for label `10`. `"01"` and `"4294967295"` are not reserved. A raw array is one answer, while `$sequence` is finite and consumes only when its rule wins.

For schema calls the validator creates a fresh fabricated base per invocation and recursively deep-merges JSON objects; arrays, `null`, falsy primitives, and other scalars replace. It then runs TypeBox `Check` without `Convert`. Any answer-caused error is non-recoverable `SCHEMA_NONCOMPLIANCE`; identical failures inherited from untouched fabricator limitations are accepted with grouped, value-free warnings. Schema-less scripted answers must be nonblank strings. Sequence exhaustion fails rather than repeating or falling back. `ValidatedAgentCall.mockAnswer` records the winning glob and zero-based sequence position; `dryRun.mockAnswers` reports captured-order rule match/consumption counters and item-level `no-match`, `shadowed`, or `not-reached` unused entries. Human positions are one-based. Unused entries only warn.

Inputs are limited to 256 KiB raw CLI UTF-8 and canonical programmatic JSON, 256 rules, 256 UTF-16 code units per glob, 256 sequence items, and answer depth 32; only ordinary JSON data is accepted. Supplying invalid programmatic `mockAnswers` throws `TypeError` before parsing. Mock-enabled validation serializes agent service at concurrency one for deterministic FIFO sequence use, so it is not a load simulator and soft token-budget admission can differ from an unscripted dry run. Attribution, warnings, and validation errors never echo answers, but workflow code receives the fixture normally and may expose it in `log()` or the returned result; fixtures must not contain credentials or production data.

The CLI adds mutually exclusive `--mock-answers <json>` and `--mock-answers-file <path>` to the existing `npx @automatalabs/workflows validate <file-or-name> [--args <json> | --args-file <path>] [--workflows-dir <dir>]… [--parse-only] [--cwd <dir>] [--token-budget <n>] [--max-agents <n>] [--timeout-ms <n>] [--json]` surface (`3` = usage error). With `--workflows-dir` the positional may be a workflow name and nested `workflow("<name>")` calls resolve. The package exports `MockAnswerJson`, `MockAnswerSequence`, `MockAnswerRule`, `MockAnswers`, `ValidatedMockAnswerUse`, `ValidatedMockAnswerRule`, `UnusedMockAnswer`, and `ValidatedMockAnswers`, along with the existing validation types and `fabricateFromSchema()` / `formatValidateReport()` helpers.

**Host-embedded (manager):** long-lived, evented, resumable.

```ts
import { WorkflowManager, createAcpRunner } from "@automatalabs/workflows";

const manager = new WorkflowManager({ cwd: projectRoot, agent: createAcpRunner() });
manager.on("agentEnd", (e) => ui.update(e.runId, e));
manager.on("agentEvent", (e) => ui.stream(e.runId, e));  // live token-level ACP stream (see Events)

const { runId, promise } = manager.startInBackground(script, args, { cwd: worktreePath });
// ... later:
manager.stop(runId);            // or manager.pause(runId), or await manager.resume(runId)
```

---

## WorkflowManager

### Constructor — `WorkflowManagerOptions`

| Option | Default | Meaning |
|---|---|---|
| `cwd` | `process.cwd()` | The manager's base directory. Keys run **state/log storage** and is the default run directory when a run passes no `cwd` of its own. |
| `agent` | — | The injected `AgentRunner`. Required here or per-run (`ExecOptions.agent`); the engine never constructs one. |
| `concurrency` | 8 | Max concurrent agents per run. |
| `journaling` | `true` | Default journaling policy. `false` = the host owns transcripts: no run-state/log files, `resume()` rejects, and startup stale-run recovery is skipped entirely. |
| `persistenceRoot` | `AGENTPRISM_PERSISTENCE_ROOT` env, else `~/.agentprism/workflows` | Absolute root for run state/logs. Relative paths throw. |
| `persistence` | filesystem persistence | Custom `RunPersistence` implementation. Omit it for the default `createRunPersistence(cwd, ..., { persistenceRoot })` path. |
| `defaultAgentTimeoutMs` | `null` (none) | Per-agent timeout default. |
| `defaultAgentRetries` | 0 | Retries after *recoverable* agent failures. |
| `mainModel` | — | Session model spec (registered harness prefix + verbatim id, or backend-only name) used to auto-tier explore-style agents. |
| `sessionId` | — | Tag for new runs; `listRuns()` filters by it (`listAllRuns()` doesn't). Update via `setSessionId()`. |
| `agentsDir` | project + user agent dirs | Override the directory scanned for `agentType` definitions. |
| `loadSavedWorkflow` | — | `(name) => script` resolver enabling nested `workflow("name")` in scripts. `openWorkflowDir(dir).resolve` is a ready-made one. |

On construction, a journaling manager reconciles orphaned `"running"` runs from dead processes to `"paused"` (journal preserved for resume). A `journaling: false` manager never touches persisted state.

### <a name="execoptions--per-run"></a>`ExecOptions` — per-run

Passed as the third argument to `startInBackground` / `runSync`, second to `resume`.

| Option | Meaning |
|---|---|
| `cwd` | **This run's working directory**, overriding the manager `cwd` — the natural fit for a worktree-per-run host. Every subagent ACP session runs here (unless worktree isolation or a per-agent `agent({ cwd })` narrows it further). Persisted with the run, so `resume()` re-runs in the *same* directory. Run state stays keyed to the **manager** cwd, so `listRuns()`/`resume()` survive the run directory's deletion. |
| `agent` | Per-run `AgentRunner` override. |
| `signal` / `externalSignal` | Host `AbortSignal` that aborts this run (aliases). |
| `journaling` | Per-run journaling override. |
| `tokenBudget` | Hard cap; once spent, `agent()` throws `TOKEN_BUDGET_EXHAUSTED`. |
| `maxAgents` | Cap on total agent calls for the run. |
| `agentTimeoutMs` | Per-agent timeout (`null` = none). |
| `concurrency`, `agentRetries` | Per-run overrides of the manager defaults. |
| `confirm` | `(promptText, options) => Promise<reply>` — live human channel for `checkpoint()`. When present it wins over every headless mode, including `"pause"`. |
| `checkpointReplies` | Durable-checkpoint answer channel for `resume()`: `{ [callIndex]: decision }`. The manager injects the matching persisted `checkpointContext` hash/index as a journal entry before replay. |
| `onProgress` | Fires with the live `WorkflowSnapshot` on every progress event. |
| `scriptBackends` | APPROVED script-declared custom backends (`meta.backends`). Omitting leaves them inert — approval belongs to the composition root. |
| `resumeJournal` | Internal resume channel (set by `resume()`; don't pass manually). |

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
| `inspectRun(runId, options?)` | `WorkflowRunStatus \| undefined` | Synchronous, read-only, live-first safe projection; falls back to the manager's project-scoped persistence. Never leases, saves, or changes status. |
| `pause(runId)` | `boolean` | Aborts in-flight work; journal preserved; resumable. |
| `stop(runId)` | `boolean` | Terminal abort. Not resumable. |
| `resume(runId, exec?)` | `Promise<boolean>` | Restarts a paused/failed run in the background: the journaled prefix replays without spending tokens; only un-run steps execute. Runs in the run's original per-run `cwd` unless `exec.cwd` overrides. Requires journaling. |
| `resumeInBackground(runId, exec?)` | `Promise<{ accepted, promise? }>` | `resume()` plus the settlement handle: when accepted, `promise` is the resumed execution's completion promise (same contract as `startInBackground`'s — rejects on failure/pause, side-channel catch attached). The facade manager holds a per-execution `exec.agent` event bridge until it settles. |
| `getRun(runId)` | `ManagedRun \| undefined` | Live in-memory state incl. `status`, `snapshot`, `error`. |
| `listRuns()` / `listAllRuns()` | `PersistedRunState[]` | Persisted runs (session-filtered / all). |
| `getPersistedAgentSessions(runId)` | `AgentSessionRecord[] \| undefined` | Cold-restart counterpart of `WorkflowRunResult.agentSessions`: the re-attach records recovered from persisted state (`undefined` = no such run, `[]` = none recorded), ready for `runner.loadSession()`/`resumeSession()` on a fresh manager. |
| `setSessionId(id)`, `setMainModel(spec)` | — | Rebind session tagging / tier fallback. |
| `dispose()` / `close()` | — | Facade manager only: detach its `agentEvent` runner subscriptions. Never disposes the runner itself. |

`WorkflowRunOptions.onTokenUsage` and the manager's `tokenUsage` event are cumulative snapshots.
They fire after every live attempt—including failed retries and pause/failure attempts—using
provider usage when supplied and the existing estimate fallback otherwise. Replayed journal calls
emit/add nothing. The unchanged successful final total is still emitted, so an observer may receive
it twice. The latest snapshot is persisted at journal and settlement points and survives cold load.
If a process dies, stale persisted `running` runs recover to `paused`; the durable prefix can then
seed a new execution. An in-flight call without a journal result runs again.

### Run inspection and terminal log tails

`WorkflowRunInspectionOptions` has `lastN?` (default 20, integer 1–50), `logLines?` (default
20, integer 0–50), and `labelGlob?` (non-empty, at most 128 Unicode code points). The glob is
case-sensitive and matches the entire raw agent label: `*` matches zero or more Unicode code
points, `?` one, and backslash escapes the next character; a trailing backslash is literal.
Checkpoints and unknown legacy entries do not match a label glob. Filtering precedes latest-N
selection and selected calls return in ascending deterministic index order.

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
  logTail: WorkflowLogTail;
  calls: WorkflowRunCallStatus[];
  filter: { lastN: number; logLines: number; labelGlob?: string };
  truncation: WorkflowRunStatusTruncation;
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
  `{ callIndex, label, phase?, requestedSpec, resolvedModel?, backendId?, kind: "model" | "modifier", message }`; model resolution no longer emits these entries because harness errors propagate.
  `message` is the same human-readable line written to the run log. Exact repeats within one call
  are deduplicated; replayed agent calls do not create entries.
- `checkpointsTaken?: WorkflowCheckpointTaken[]` records each checkpoint that resolved in this
  execution as `{ callIndex, kind, decision, source }`. Source is `"live"`, `"headless-default"`,
  `"journal-replay"`, or `"injected"` (an indexed `checkpointReplies` answer). A checkpoint that
  paused is not resolved and therefore is not listed.

Both arrays persist on `PersistedRunState` for cold terminal reads. Neither enters call hashes, and
neither is added to the bounded `WorkflowRunStatus` inspection shape.

A run that hits a provider usage/quota wall (`PROVIDER_USAGE_LIMIT`) is **paused**, not failed — the journal checkpoints and `resume()` picks up after the budget refills (`resetHint` is synthesized as `Resets at <RFC 3339 instant>` when structured provider reset metadata is present).

A run that hits `AUTH_REQUIRED` is likewise **paused** (`reason: "auth_required"`), not failed: the journal checkpoints and the paused state persists the structured, non-secret `authContext` (`backendId` + advertised method `{ id, type, name }[]` — never credential material). `resume()` re-arms against the runner: for an `"auth_required"` pause it consults `runner.auth.canResume(backendId)` before re-executing. When the credential survived (warm resume in the same process, or a disk-backed method a fresh process re-reads from the native store/env) it proceeds; when an in-process (gateway) or spawn-env intent was lost to a cold process it **immediately re-pauses** with `re-supply credentials for <backend> via runner auth before resuming` rather than re-running into the same wall. A runner with no `auth` controller (the default-off host) cannot confirm resumability and re-pauses.

A checkpoint authored with `headless: "pause"` is the third persisted pause class. With no live
`confirm`, the run pauses with `reason: "checkpoint_required"` and the non-secret
`checkpointContext`. `resume()` accepts the decision through `ExecOptions.checkpointReplies`; the
manager writes the synthetic reply into the journal before execution, then replay returns it without
re-asking. If resume has neither that indexed reply nor a live `confirm`, it re-pauses immediately
with the same context and executes no script or agent calls. The default checkpoint mode remains
headless-default, so detached runs do not pause unless the author opts in.

### Events

`WorkflowManager` is an `EventEmitter`; **every payload carries `runId`** — route by it, no reverse index needed. Listeners are observability-only: a throwing listener is isolated and never affects the run.

| Event | Payload (beyond `runId`) |
|---|---|
| `log` | `message` |
| `phase` | `phase` title |
| `agentStart` | `label`, `phase`, `prompt`, `model?` |
| `agentEnd` | `label`, `phase`, `result` (`null` on error), `tokens`, `error?`, `errorCode?`, `recoverable?`, `model?`, `worktree?` |
| `agentHistory` | `label`, `history` (message/tool-call entries) |
| `journal` | `entry` (`JournalEntry`) — live journal append observations, including when file journaling is disabled |
| `tokenUsage` | `usage` (cumulative input/output/total/cost/cache) |
| `complete` | `result` (the composed `WorkflowRunResult`) |
| `paused` | `reason` (`"usage_limit"` \| `"auth_required"` \| `"checkpoint_required"`), `error`, `resetHint?` (usage-limit only), `authContext?` (auth only), `checkpointContext?` (durable checkpoint only) |
| `stopped` / `resumed` | — |
| `error` | `error` (`WorkflowError`) — emitted only when a listener exists, so an unheard `error` never masks the thrown one |
| `agentEvent` | **The token-level streaming surface** (facade manager only — see below). |

### `agentEvent` — live token-level streaming through the manager

The `WorkflowManager` exported by **`@automatalabs/workflows`** (the facade — not the bare engine class) adds one composition-root bridge: when the injected `AgentRunner` also exposes the acp-agents `.on()` bus (`createAcpRunner()` does), the manager forwards that runner's **entire live ACP stream** as `agentEvent`. This is how a host renders message chunks, tool calls, and plans as they happen without holding a separate runner reference.

```ts
manager.on("agentEvent", (e: AgentEventPayload) => {
  if (e.name === "agent_message_chunk" && e.runId) ui.stream(e.runId, e.label, e.event);
});
```

Payload (`AgentEventPayload<K>`, exported): `{ name, event, backendId, sessionId?, label?, runId? }` —

- `name` is the ACP event name. `session/update` notifications arrive **unwrapped** as their `sessionUpdate` discriminant (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …); the cross-cutting events (`permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `session_open`, `session_close`, `backend_error`) arrive under their own names.
- `event` is the **verbatim** runner payload for that event (typed per `name`).
- The envelope repeats the context fields hosts filter on: `runId` + `label` identify the workflow agent (stamped by the engine on every `agent()` call), `sessionId`/`backendId` identify the ACP session. `backend_error` is connection-scoped and carries no session/run context.

Bridge lifecycle: ref-counted per runner. A constructor-injected runner is bridged for the manager's lifetime; a per-run `ExecOptions.agent` runner is bridged only while its run is active. `manager.dispose()` (alias `close()`) detaches the manager's subscriptions — it does **not** dispose the runner, whose process lifetime stays with the caller. Forwarding is observability-only: a throwing `agentEvent` listener is isolated and never affects the run.

Alternative: subscribe on the runner's bus directly — see [Runner events](#runner-events); same underlying stream, same `runId`/`label` attribution, no manager involved.

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
`replayReport`.

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

`label`, `schema` (JSON Schema / TypeBox), `signal`, `model` / `tier`, `mode`, `configOptions`, `cwd` (per-session working directory — worktree isolation preserved on a pooled process), `instructions`, `toolNames` / `disallowedToolNames` (the `ToolPolicy` allow/deny lists), `mcpServers`, `images`, `meta` / `promptMeta` (ACP `_meta` passthroughs), `backends` (approved script-declared), `runId` (correlation stamp), `keepSession` (skip the release-time best-effort `session/close` so the agent-persisted session stays re-openable), callbacks `onUsage`, `onHistory`, `onModelResolved`, `onModelFallback`, `onSessionOpen`.

**Session hand-off.** `run()`'s return value is always the bare result, so the ACP session identity travels out-of-band: `onSessionOpen` fires once right after `session/new` (before the first prompt) with an `AgentSessionRef` — `{ sessionId, backendId, cwd, reopen: { load, resume, list } }`. The `reopen` flags mirror the connected agent's advertised persistence (`loadSession` / `sessionCapabilities.resume` / `.list`); `backendId` doubles as the `model` routing spec for the reattach calls below. Pair it with `keepSession: true` when you intend to re-open: the runner then leaves the agent-persisted session untouched at release (the pooled process is released either way). The ref contains no secrets and is JSON-round-trippable.

**Structured output channels.** Claude and Codex keep their native schema channels authoritative and unchanged. OpenCode and custom ACP backends use the client-hosted MCP path: when `RunOptions.schema` is set, the backend opts in, and the negotiated initialize response advertises `agentCapabilities.mcpCapabilities.http === true`, the runner appends a client-hosted HTTP MCP server to `session/new.mcpServers`. The injected server is named `structured_output` (or `structured_output_2`, etc. on name collision), runs on `127.0.0.1` with an unguessable token path, and exposes one tool named `StructuredOutput`; agents may show it namespaced, for example `structured_output_StructuredOutput`. The tool input schema is the requested JSON Schema, and a valid call captures the result. Injected-tool schema runs are **serialized per pooled connection**: agents with instance-global, name-keyed MCP registries (OpenCode) expose every registered tool to every live session on the process, so overlapping injected sessions would leak one session's capture into another; the constant server name makes each registration replace the previous, and the per-connection turn guarantees the single live registration belongs to the active run. Scale schema-run parallelism with `AGENTPRISM_ACP_POOL_SIZE` (one registry per process), not concurrent sessions. If any gate fails, or a custom backend sets `structuredOutputTool:false`, behavior falls back to the existing prompt-embedded schema plus final-text JSON parse ladder. OpenCode also receives the generic `_meta.outputSchema` forward for future compatibility, but current OpenCode structured output depends on the injected tool. User-provided `mcpServers` are preserved and are not part of the resume hash.

**Model specs**: after the engine's existing precedence resolves one effective string, the runner splits it on the first `/`. If the first segment, ASCII-case-insensitively, is `claude`, `codex`, `opencode`, or a registered custom backend name, that harness is selected and exactly one segment is stripped; a custom registration wins on collision. A registered harness name by itself is backend-only and issues no model `session/set_config_option`, preserving the harness default. Any other first segment sends the entire authored string unchanged to `AGENTPRISM_DEFAULT_BACKEND` (historical default `claude`), so `anthropic/…`, `openai/…`, bare `opus`, and bare `gpt-…` are not aliases. When an id remains it is the exact `configId:"model"` value: no case folding, normalization, catalog matching, bracket parsing, sibling effort/Fast option driving, retry, echo verification, or fallback. Brackets, dots, and provider-style prefixes are ordinary id characters. Harness rejection follows the existing agent-error path; `onModelFallback` remains source-compatible but model resolution does not emit it. Live-catalog-verified examples: `claude/opus[1m]`, `codex/gpt-5.6-sol`, `opencode/zai/glm-5.2`; use `claude`, `codex`, or `opencode` when the model is configured in the harness.

**Session config options**: `configOptions` is a `Record<string, string | boolean>` of exact
ACP ids and authored values. Entries are sent verbatim in ascending option-id order, after model
selection and before the prompt; the client provides no aliases, coercion, catalog fallback, retry,
or echo verification. Harness rejection follows the ordinary agent-error path. `"model"` is
reserved for the dedicated `model` field and is rejected engine-side before a session opens.
`configOptions` enters replay identity as sorted-key JSON only when non-empty, so absent and empty
bags preserve pre-feature hash bytes. `runner.probeConfigOptions(spec?, { cwd? })` routes normally,
opens exactly one no-prompt session, returns `{ backendId, options }` with verbatim
`SessionConfigOption[]`, and closes it; spawn/auth/session failures throw.

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
- `runner.auth`: the verbs as one object — `methods()` (= `describeAuthMethods`), `authenticate()` (= `completeAuth`), `logout()`, `status()` (redacted `AuthStatusSnapshot[]` — ids/types/names + state only, **never** secrets), and `canResume(backendId)` (cold-resume re-arm predicate). `AuthCapableRunner` is the structural interface an MCP host duck-types to register auth tools.

`env`/`meta` payloads are **SECRET** and flow only through the resolver return value into the `AuthStore` and the spawn env — never into events, journals, logs, error messages, or `status()`. `logout()` clears the store (zeroizing the secret payload), recycles the pool, and issues the agent `logout` RPC only where advertised. Default-OFF: with neither `onAuth` nor `authCapabilities` set, the wire behavior is byte-identical to a host that never opted in.

**Per-agent auth profiles.** The three built-in backends carry a pure-data `AuthProfile` (`claudeAuthProfile`/`codexAuthProfile`/`opencodeAuthProfile`, exported from `@automatalabs/acp-agents`); a custom backend supplies **none** (`Backend.authProfile` undefined) and runs the base flow verbatim — conformance is defined by the *absence* of a profile. A profile is enrichment only and never gates the flow: it refines which auth method **types** the backend advertises via `clientAuthCapabilities({ onAuth, terminal })` (Codex never advertises `terminal`; OpenCode never advertises `gateway`; Claude follows both host affordances), relabels the type-dispatched descriptor via `describe` (identity for the built-ins), and reshapes the gateway payload via `buildMeta` (identity). Only `codexAuthProfile` defines `spawnAuthEnv`: it emits the codex `DEFAULT_AUTH_REQUEST` startup env for `api-key`/`gateway` intents so a freshly recycled process pre-authenticates before its first gated request — layered **on top of** the universal post-`initialize` replay, never replacing it and never required for correctness (Claude/OpenCode define none — a truthful asymmetry). The `AuthMethod.type` discriminants, the cross-agent `_meta` convention keys, and the codex `DEFAULT_AUTH_REQUEST` channel are pinned as build-time drift tripwires (`HANDLED_AUTH_METHOD_TYPES`, `AUTH_META_CONVENTION_KEYS`, `CODEX_SPAWN_AUTH_ENV`, `AUTH_META_MATRIX`).

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

- `@agentclientprotocol/claude-agent-acp@0.59.0`: advertises `auth.logout`, implements `logout`, and implements `authenticate` for its gateway auth methods; terminal login methods are advertised only when the client advertises terminal auth support. It does not advertise or register `providers/*`.
- `@automatalabs/codex-acp@1.6.3`: advertises `auth.logout`, implements `authenticate` (`api-key`, `chat-gpt`, and `gateway` when gateway support is advertised), and implements `logout`. As of 1.6.0 (upstream sync) it also advertises `providers` and implements `providers/list`, `providers/set`, and `providers/disable` for its single client-configurable custom gateway provider: `providerId` `"custom-gateway"`, `supported: ["openai"]`, `required: false`, `current` carrying only the non-secret `{ apiType, baseUrl }` (never headers) and `null` while unconfigured; `providers/set` rejects any other `providerId`/`apiType` with invalid-params and `providers/disable` is idempotent. Its separate reasoning-effort options remain agent-owned configuration; model-spec brackets are never interpreted by this client.
- Host-resolved OpenCode (`opencode-ai` 1.17.14 in the verified profile): advertises the `opencode-login` terminal-style method when the client advertises terminal auth, acknowledges `authenticate`, and relies on its provider credential store; it does not advertise logout. The credential-gated live suite verifies the installed executable because OpenCode is not bundled.

### Protocol passthrough & coverage

`PooledConnection` and `InteractiveSession` expose typed raw ACP `request()` / `notify()` escape hatches for spec methods without named wrappers:

```ts
import { AGENT_METHODS } from "@automatalabs/workflows";

await session.request(AGENT_METHODS.mcp_message, { connectionId, method: "tools/list" });
```

Prefer named wrappers (`prompt()`, `setMode()`, `openSession()`, etc.) when they exist; they preserve engine semantics like drain accumulation, local mode state, and usage recording, while raw `session/prompt` bypasses them.

Raw `request()` rejects the session-stateful methods that would create or reopen sessions outside the router: `session/new` (use `openSession()`), `session/load` (use `loadSession()`), `session/resume` (use `resumeSession()`), and `session/fork` (use `forkSession()`). Those raw sessions are unregistered: updates do not fold into an accumulator, permission requests auto-cancel, and fs/terminal dispatch fails for unknown sessions.

`AGENT_METHOD_COVERAGE` and `CLIENT_METHOD_COVERAGE` classify every method constant exported by the installed ACP SDK. Agent methods are `"driven"`, `"passthrough"`, or `"guarded"`; guarded means no safe driven wrapper exists. Agent coverage is 16 operational driven methods plus `initialize`, 0 guarded methods, and passthrough for `nes/*`, `document/*`, and `mcp/message`. The raw guards for session-stateful `session/new`, `session/load`, `session/resume`, and `session/fork` remain unchanged: callers must use their driven wrappers so routing state is installed. Client methods are currently 14/14 served. A tripwire test compares those manifests against `AGENT_METHODS` / `CLIENT_METHODS`, so SDK bumps cannot silently add or remove protocol surface.

### <a name="runner-events"></a>Events (`runner.on(name, listener)`)

Typed bus; returns an unsubscribe thunk. Names are the ACP `sessionUpdate` discriminants verbatim (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …) plus cross-cutting events: `session_update` (catch-all), `permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `session_open`, `session_close`, `backend_error`. Every payload carries `AcpEventContext`: `{ sessionId, backendId, label?, runId? }` — the engine stamps `runId`/`label` on every workflow agent, so multiplexed streams filter cleanly.

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

`loadSession()` registers the caller-supplied id before sending `session/load`, so replayed `session/update` history is accumulated and permissions during replay are routed. After it resolves, replay is visible in `session.text` / `session.history`. `resumeSession()` reattaches without replay. `forkSession()` can register only after `session/fork` returns its new id, matching `session/new`; subsequent updates, permissions, and prompts route exclusively under that response id. All three adopt response `configOptions`/`modes`; a routed model id is then sent verbatim, while `mode` is validated and applied strictly from the response mode catalog. The upstream SDK marks `session/fork` **UNSTABLE** / `@experimental`; this wrapper may need to track future protocol changes.

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

Set `agent(prompt, { keepSession: true })` in the script (or `RunOptions.keepSession` on direct `run()` calls) when you intend to re-open: it skips the release-time best-effort `session/close`, guaranteeing the agent-persisted session is untouched. Without it the record is still surfaced, and the three first-class agents keep closed sessions loadable — but `keepSession` is the explicit, agent-agnostic contract. Check `reopen.load`/`reopen.resume` before offering re-attach and optional `reopen.fork` before offering a fork in UI: an agent that persists nothing advertises none of them, and its sessions are reachable only while held open (`openSession`). The fork flag is optional so records written before this field existed remain valid.

Lifecycle methods are capability-gated after initialize. In particular, `forkSession()` requires `sessionCapabilities.fork`; when absent it throws a non-recoverable `WorkflowError` naming the backend and `session/fork` before any fork request is sent. The installed `@agentclientprotocol/claude-agent-acp@0.59.0` advertises `loadSession: true` plus `sessionCapabilities` for list/delete/resume/close/fork (fork verified live: the forked session carries the source conversation's context). `@automatalabs/codex-acp@1.6.3` advertises `loadSession: true` plus list/delete/resume/close — no fork yet. OpenCode advertises load/list/resume/close/fork (also verified live); unsupported lifecycle methods still fail through the same gate.

### Capabilities

The one-time `initialize` handshake negotiates per-connection capabilities, readable as `NegotiatedCapabilities` (exported). It includes the full `agentCapabilities`, `agentInfo`, initialize `_meta`, and advertised `authMethods`. Prompt-content flags are **booleans**: `capabilities.agent.promptCapabilities?.image === true` etc. You rarely need to gate manually — `adaptPromptContent` already degrades unsupported `image`/`audio`/`resource` blocks to a bracketed text note naming the backend. The client truthfully advertises: `fs`/`terminal` only when you registered handlers, plus `session.configOptions.boolean` always (boolean config options are handled natively). The installed ACP SDK has no `ClientCapabilities` field for MCP-over-ACP; the real declaration is a `session/new` MCP server entry `{ type: "acp", name, serverId }`, gated before the session is opened.

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

Installed backend status verified from the packaged dists: `@agentclientprotocol/claude-agent-acp@0.59.0` advertises `http`/`sse` MCP support but no `acp`, `@automatalabs/codex-acp@1.6.3` advertises `mcpCapabilities: { acp: false, http: true, sse: false }` and rejects ACP MCP config internally, and OpenCode advertises HTTP/SSE MCP support. Current MCP-over-ACP integration tests therefore use the repository fake agent fixture.

---

## Backends & process resolution

Long-lived ACP server processes are pool-managed (spawned once, sessions multiplexed; per-session `cwd` keeps worktree isolation on a shared process).

| Backend | Default resolution | Overrides |
|---|---|---|
| `claude` | spawns the installed `@agentclientprotocol/claude-agent-acp` dep | `AGENTPRISM_CLAUDE_ACP_CMD` / `_ARGS` |
| `codex` | `require.resolve("@automatalabs/codex-acp")` — the installed dep, no config needed | `AGENTPRISM_CODEX_ACP_BIN` (path), or `AGENTPRISM_CODEX_ACP_CMD` / `_ARGS` (full command) |
| `opencode` | `AGENTPRISM_OPENCODE_ACP_CMD`, else host-installed `opencode-ai/bin/opencode` if resolvable, else `opencode` on PATH; non-override paths pass `acp` | `AGENTPRISM_OPENCODE_ACP_CMD` / `_ARGS` (full command) |
| custom | `backends` option or `AGENTPRISM_BACKENDS` (JSON) | `CustomBackendConfig`: `command`, `args?`, `env?` (a **scoped overlay** for the child only — put per-backend secrets here, never in the ambient env), `sessionMeta?`, `customCapabilities?` |

Workflow scripts may *declare* backends via `meta.backends`, but declarations are inert until the composition root approves them (`allowScriptBackends` / `ExecOptions.scriptBackends` / `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1`).

**Environment variables**: `AGENTPRISM_ACP_POOL_SIZE` (processes per backend, default 1), `AGENTPRISM_ACP_INIT_TIMEOUT_MS` (initialize handshake deadline, default 60s), `AGENTPRISM_DEFAULT_BACKEND` (`claude` | `codex` | `opencode` | custom name), `AGENTPRISM_BACKENDS` (host custom-backend registry JSON), `AGENTPRISM_PERSISTENCE_ROOT`, `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, `AGENTPRISM_OPENCODE_E2E_MODEL` (live e2e only; default `opencode/zai/glm-5.2`), plus the per-backend `*_CMD`/`_ARGS`/`_BIN` above.

---

## Errors — `WorkflowError`

One runtime class (from `@automatalabs/shared-types`, so `instanceof` holds across packages) with `.code`, `.recoverable`, `.agentLabel?`, `.resetHint?`, `.providerUsageLimitContext?`, `.authContext?`, and `.checkpointContext?`. Recoverable agent failures retry up to `agentRetries`, then resolve that agent to `null`; non-recoverable ones halt the run except the three manager-owned pause codes called out below.

| Code | Recoverable | Meaning / engine behavior |
|---|---|---|
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, protocol mismatch). |
| `SCRIPT_ERROR` | no | The script **crashed at runtime**: uncaught throw or unhandled promise rejection in the script body. Run fails. |
| `WORKFLOW_ABORTED` | — | Actual cancellation (pause/stop/signal). Never used for crashes. |
| `AGENT_TIMEOUT` | yes | Engine-enforced per-agent timeout. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call. |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the repair ladder. |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall → the run **pauses** (journaled, resumable), carries `providerUsageLimitContext` and a synthesized `resetHint` when a reset instant is available. |
| `AUTH_REQUIRED` | no | Agent demanded auth (`-32000`) → the run **pauses** (`reason: "auth_required"`, journaled, resumable), carries the non-secret `authContext`; `resume()` re-arms via `runner.auth.canResume`. |
| `CHECKPOINT_REQUIRED` | no | `checkpoint(..., { headless: "pause" })` has no live channel → the run **pauses** with non-secret `checkpointContext`; resume with `checkpointReplies` or a live `confirm`. |
| `TOKEN_BUDGET_EXHAUSTED` / `AGENT_LIMIT_EXCEEDED` | no | Run caps hit. |
| `AGENT_EXECUTION_ERROR` | yes | Other agent-level failure (refusal/truncation are non-recoverable variants). |
| `PERSISTENCE_ERROR`, `UNKNOWN` | no | Storage / unexpected host-level failure. |

**Script-fault containment**: a promise a script floats (un-awaited `agent()`, a stray `Promise.reject`, a `.then()` chain) is attributed to its run by realm identity and fails it with `SCRIPT_ERROR` — it does not crash the host process, and in-flight agents are cancelled. Caveat: Node invokes every `unhandledRejection` listener, so a host that installs its own listener will still *observe* contained script floats; rejections no workflow owns preserve platform semantics (your listener stays in charge; with no listener the process crashes exactly as it would without the engine).

---

## MCP server

`npx @automatalabs/mcp-server` (bin `agentprism-workflow`) speaks stdio MCP and exposes a single tool, **`workflow`** — the server's whole surface. Its input is this union:

```ts
interface WorkflowExecuteToolInput {
  action?: "run";
  script: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  tokenBudget?: number | null;
  resumeFromRunId?: string;
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
}
```

It does not await script/agent completion. The run has no initiating request signal, progress token,
or live checkpoint `confirm`; checkpoints use authored headless behavior. Cancelling the accepted
call cannot abort it. A fifth run fails with
`Background workflow limit reached (4 active or starting runs). Await an existing run and retry.`
Foreground, inspect, and await do not consume slots. A background `resumeFromRunId` creates a new run
ID and copies the complete inherited journal plus any synthetic checkpoint answer into that new
run's initial durable record, preserving multi-hop resume safety.

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
waits only for terminal lifecycle state for at most the requested duration. It uses the local
settlement promise when available and 250-ms project-store polling after restart. Await cancellation
ends only that request and returns
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

Background means detached from one request, not from the server process. Stdio-host exit, SIGTERM,
crash, or machine shutdown can stop in-flight work; there is no daemon/worker handoff. The initial
record and completed call prefix remain durable, later writes are best effort, and the next manager
recovers an orphaned `running` record to `paused` for an explicit new `resumeFromRunId` execution.
The MCP input does not resolve saved workflow names; name resolution is an SDK/`openWorkflowDir`
feature. The server honors the SDK environment variables plus `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`.

Inspect returns exactly `WorkflowRunStatus`. Its JSON structured content is capped at 24,576 bytes
and its formatted text at 8,192 bytes. An existing failed or aborted run is still a successful read.
An unknown/corrupt/unreadable run is `isError:true`, has no structured content, and returns exactly
`No workflow run found for runId "<runId>" in this server's project-scoped run store.` Execution
keeps current error semantics: failed/aborted are tool errors, paused is a successful resumable
call. Non-completed execution text includes the manager's final-20 redacted `logTail` and is capped
at 12,288 bytes; malformed pre-run scripts have no run ID or tail.

**The `author-workflow` prompt.** Prompt-capable hosts additionally get one user-controlled MCP prompt, `author-workflow` (optional `task` argument): it returns the complete, self-contained authoring guide — SKILL.md + the exhaustive reference tables + a validated example script, generated from `skills/agentprism-workflow-authoring` at `scripts/generate-authoring-prompt.mjs` and version-matched to the installed engine. Prompts never enter the model's tool-selection loop, so the tool surface stays exactly `workflow`.

**Auth is the agents' own concern.** Each backend authenticates from its own CLI credential store (`claude /login`, `codex login`, `opencode auth login`) — logged-in CLIs need no MCP-side step, and the server exposes no auth state for a host to inspect or manage. A run that genuinely hits ACP `AUTH_REQUIRED` pauses with `reason:"auth_required"` and a summary built from the structured, non-secret `authContext` (backend id + advertised method `{ id, type, name }[]`) — never parsed from the error message — directing an out-of-band CLI login followed by `workflow` with `resumeFromRunId`. Programmatic credential injection and provider routing (`completeAuth`, `listProviders` / `setProvider` / `disableProvider`) are [SDK runner APIs](#auth--providers) for embedding hosts.

## Workflow script DSL

Scripts run in a deterministic `vm` realm (`Date.now`/`Math.random`/argless `new Date()` throw — the journal/resume identity depends on it; the realm is a determinism boundary, **not** a security boundary). Realm globals:

`agent(prompt, { label?, schema?, model?, mode?, tier?, phase?, isolation?, cwd?, timeoutMs?, retries?, mcpServers?, images?, agentType?, meta?, promptMeta?, keepSession? })` · `parallel(thunks)` (barrier; failed thunks → `null`) · `pipeline(items, ...stages)` (no inter-stage barrier) · `workflow(nameOrScript, args?)` (one level of nesting) · `checkpoint(prompt, opts?)` (journaled human gate; live/default/abort/durable-pause modes) · `gate(thunk, validator, opts?)` · `retry(thunk, opts?)` · `verify(item, opts?)` · `judgePanel(...)` · `loopUntilDry(opts)` · `completenessCheck(args, results)` · `phase(title, { budget? })` · `log(msg)` · `budget.{total,spent(),remaining()}` · `args` · `cwd`.

`gate()` validators may return `{ ok: boolean, feedback?: string, ... }`, a bare boolean, or
`null`. A fulfilled gate returns exactly `{ ok, value, verdict, attempts }`: `value` is the final
producer result and `verdict` is the exact last completed validator return (`null` is retained;
an unsupported explicit `undefined` is normalized to `null`). Bare `true` passes, while `false`
and `null` reject without feedback.

`keepSession:true` skips the release-time `session/close`; the resulting `AgentSessionRecord` is returned in `WorkflowRunResult.agentSessions` so the host can later call `runner.loadSession()` or `runner.resumeSession()`.

See the [README](../README.md#writing-workflow-scripts) for authoring guidance and examples, and [`design-notes.md`](design-notes.md) for the protocol-level design.
