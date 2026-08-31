# Workflow script reference

Exhaustive tables for the AgentPrism workflow script DSL. `SKILL.md` (same directory) is the authoring guide; this file is the lookup companion. Everything here is verified against `@automatalabs/workflow-engine` / `@automatalabs/acp-agents` as shipped with `@automatalabs/workflows`.

## `agent(prompt, options?)` — full option table

Returns the agent's final assistant text, or the schema-validated object when `schema` is set. Resolves to `null` when a *recoverable* failure survives all retries.

| option | type | meaning |
|---|---|---|
| `label` | `string` | Display/telemetry name; also stamped on every live ACP event for this call. Always set it. Not part of the resume hash. |
| `phase` | `string` | Assign this call to a phase explicitly (needed inside concurrent stages where the global `phase()` state would race). |
| `schema` | JSON Schema object | Structured output. Plain object literal only — no schema builders exist in the realm. Part of the resume hash. |
| `model` | `string` | Model spec: optional registered harness prefix plus a verbatim id, or a backend-only name. See [Model specs & routing](#model-specs--routing). Part of the resume hash. |
| `tier` | `"small" \| "medium" \| "big"` | Coarse tier resolved from host config; beats phase/meta model, loses to explicit `model`. Part of the resume hash. |
| `mode` | `string` | Exact advertised ACP mode. Config preserves raw names/descriptions/metadata. Omission applies Claude `auto`, Codex `agent`, OpenCode `build`, or no Pi mode; `defaultModeId` reports it. Authored/default ids are validated before prompt. Part of the resume hash only when authored. |
| `configOptions` | `Record<string, string \| boolean>` | Exact ACP session option ids and authored values. Applied in ascending id order after model and before the prompt, with no aliases or coercion. `"model"` is reserved for the dedicated `model` field. Part of the resume hash only when non-empty, with sorted keys. With MCP, read the advertised-options table from `workflow` action `config` before choosing values. |
| `agentType` | `string` | Bind a named subagent definition (tools allow/deny, model, isolation, role prompt). See [agentType definitions](#agenttype-definitions). Part of the resume hash. |
| `isolation` | `"worktree"` | Run in a throwaway git worktree branched from the run cwd. **Always removed (worktree + branch) when the call ends** — edits are discarded; return work as data. Degrades to the shared tree outside a git repo (logged). |
| `resume` | `{ filesystem: "read-only" }` | Deprecated compatibility annotation. It is recorded as legacy diagnostic provenance, is not sent to the runner or hashed, and has no effect on replay. New scripts should omit it. |
| `cwd` | `string` | Per-session working directory; relative resolves against the run's base cwd. Overridden by worktree isolation. Not hashed. |
| `timeoutMs` | `number \| null` | Total wall-clock cap for each attempt. A finite value may tighten a finite host `agentTimeoutMs` ceiling but cannot raise or disable it. With no host ceiling, a finite value applies and `null`/omitted is uncapped. |
| `idleTimeoutMs` | `number \| null` | No-backend-activity cap for each attempt. It may tighten a finite host `agentIdleTimeoutMs` ceiling but cannot raise or disable it. |
| `retries` | `number` | Retries after *recoverable* failures (default 0, host-overridable). Exhausted retries ⇒ the call resolves `null`. |
| `mcpServers` | `McpServerConfig[]` | MCP servers attached to this session. Stdio shape: `{ name, command, args: [], env: [{ name, value }] }` (`args`/`env` required, `env` is name/value pairs, not a map); `{ type: "http" \| "sse", name, url, headers: [] }` also accepted. Not hashed. |
| `images` | `PromptImage[]` | Base64 image blocks appended to the prompt; backends without image support get a bracketed text note. Not hashed. |
| `meta` | `object` | ACP `_meta` merged into `session/new` — session-scoped extension passthrough (pairs with custom backends). Not hashed. |
| `promptMeta` | `object` | ACP `_meta` merged into `session/prompt` — turn-scoped passthrough. Backend-computed keys win on conflict. Not hashed. |
| `keepSession` | `boolean` | Skip release-time best-effort `session/close`; the non-secret re-attach record lands in `WorkflowRunResult.agentSessions` for host-side `loadSession()` / `resumeSession()`. Usage/auth pause failures are kept open automatically for managed continuation. Not identity-hashed; included in the input fingerprint. |

The total-wall clock measures the whole attempt, including backend startup, model/config setup,
tool work, and streamed output; it is not an idle timer. The separate idle clock is opt-in and
re-arms on real backend activity (every ACP `session/update`), never synthetic progress heartbeats.
Size it above the longest expected backend-silent local tool call. Each retry starts fresh clocks.
Exhaustion is recoverable `AGENT_TIMEOUT` or `AGENT_IDLE_TIMEOUT`: the call resolves to `null`,
releases its concurrency slot, and asks the ACP session to cancel. A session that keeps running
after the cancellation grace is closed where supported and its pooled child is recycled.

Every new run, including one admitted with `resumeFromRunId`, resolves host limits from that run's
request. It does not inherit `agentTimeoutMs`, `agentIdleTimeoutMs`, retries, concurrency, or
agent-count values from its source, so pass every operational bound the resumed execution should use.

## Model specs & routing

A `model` string is resolved solely from its first segment, then delegated to the harness:

| spec shape | routes to | notes |
|---|---|---|
| *(omitted)* | host-pinned/default backend | MCP: explicit `AGENTPRISM_DEFAULT_BACKEND` wins; when truly unset, zero-token readiness discovery pins one project default before validation/execution and preserves it across resume. SDK runner: configured default, historical fallback `claude`. The selected harness keeps its session default model. Most portable. |
| `claude`, `codex`, `opencode`, `pi`, or `<custom-name>` | that registered harness | Backend-only: no model config call; the harness default remains active. |
| `claude/<id>`, `codex/<id>`, `opencode/<id>`, `pi/<id>`, or `<custom-name>/<id>` | that registered harness | Match the first segment ASCII-case-insensitively and strip exactly one segment. Custom names take priority on collision. The remaining `<id>` is sent verbatim, including further `/` characters. For Pi, that remainder is its `<provider>/<model-id>` and Pi preserves any further slashes in the model id. |
| any other string, including `anthropic/…`, `openai/…`, bare `opus`, or bare `gpt-…` | host default backend | The **entire** authored string is sent verbatim; these are not routing aliases. |

Selection is a single `session/set_config_option` with `configId: "model"` and the exact remaining string. There is no catalog matching, case folding, normalization, bracket parsing, nearest-neighbor selection, sibling effort/Fast option driving, retry, or echo verification. Brackets, dots, and provider-style prefixes are ordinary model-id characters.

Whatever the harness returns is the outcome. A rejection follows the existing agent-error path with no resolution-specific code or model fallback event. `onModelFallback` and `WorkflowRunResult.fallbacks` remain public compatibility surfaces; model resolution does not emit entries, while pause recovery emits `kind: "continuation"` reattach/skip notices.

## Structured output channels

One author API (`schema`), four fulfillment paths — chosen automatically per backend:

| backend | channel |
|---|---|
| Claude | native `outputFormat`, schema normalized to Anthropic's structured-outputs subset (e.g. `oneOf` → `anyOf`; unsupported keywords/formats stripped on the wire) |
| Codex | native strict `outputSchema` (OpenAI strict subset normalization) |
| Pi | a client-hosted `StructuredOutput` MCP tool injected when the agent advertises HTTP MCP support; common prompt-embedded schema and validated final-text JSON fallback |
| OpenCode / custom ACP | a client-hosted **`StructuredOutput` MCP tool** injected into the session when the agent advertises HTTP MCP support (an agent may show it as `structured_output_StructuredOutput`); otherwise prompt-embedded schema + JSON parse of the final message. Custom backends can opt out of tool injection with `structuredOutputTool: false`. |

Pi accepts stdio, Streamable HTTP, and SSE MCP servers; ACP-transport MCP hosting remains client-side.

In every channel the runner coerces + validates client-side and re-prompts a bounded number of times; the final miss fails the call with non-recoverable `SCHEMA_NONCOMPLIANCE`. Constraints stripped from the wire are still enforced client-side — an exotic schema keyword shows up as re-prompt churn, so keep schemas simple.

## DSL globals — complete signatures

```
agent(prompt, options?)                    → Promise<string | object | null>
parallel(thunks)                           → Promise<results[]>   // barrier; input order; failed slot = null
pipeline(items, ...stages)                 → Promise<results[]>   // no inter-stage barrier; stage(prev, original, index); failed item = null
workflow(nameOrScript, args?)              → Promise<unknown>     // one nesting level; names resolve from the host's workflows folder, inline scripts always work
gate(thunk, validator, { attempts = 3 })   → { ok, value, verdict, attempts }
    // thunk(feedback, attempt); validator(result) → { ok, feedback?, ... } | boolean | null (may be async / an agent call)
retry(thunk, { attempts = 3, until? })     → last result           // thunk(attempt); stops early when until(result)
verify(item, { reviewers = 2, threshold = 0.5, lens? })
    → { real, realCount, total, votes: [{ real?, reason? }] }
    // N adversarial reviewers prompted to REFUTE; lens (string | string[]) rotates focus per reviewer
judgePanel(attempts, { judges = 3, rubric = "overall quality and correctness" })
    → { index, attempt, score, judgments }  // mean 0–1 score per candidate; stable tie-break by index
loopUntilDry({ round, key = JSON.stringify, consecutiveEmpty = 2, maxRounds = 50 })
    → unique items[]   // round(i) returns items; stops after N dry rounds; agent-limit exhaustion returns the partial result
completenessCheck(taskArgs, results)       → { complete, missing?: string[] }
checkpoint(promptText, options?)           → Promise<reply>       // journaled human gate; zero tokens
phase(title)                               → void                 // open a named phase
log(message)                               → void                 // console.log/info/warn/error route here too
args                                       // the host-provided input value, verbatim
cwd                                        // the run's base working directory (string); process.cwd() returns it too
```

For `gate()`, `value` is the final producer result and `verdict` is the exact last completed
validator return, including any extra structured fields. `{ ok: true }` and bare `true` pass;
`{ ok: false, feedback? }`, bare `false`, and `null` reject. Only object feedback is threaded into
the next producer attempt. A producer result of `null` is still passed to the validator. Producer
or validator exceptions propagate immediately, so no partial gate result is returned and no later
attempt runs. An explicit unsupported `undefined` validator return is a rejection represented as
`verdict: null`. If the script returns the gate result, its complete verdict is persisted and may
reach the host; keep evidence concise and never put credentials or other secrets in verdict data.

`verify`, `judgePanel`, and `completenessCheck` spawn their subagents on the run's default model — hand-roll with `parallel` + `agent` to pin panel members to specific backends.

## `checkpoint()` options

| option | type | meaning |
|---|---|---|
| `kind` | `"confirm" \| "input" \| "select"` | Reply shape: boolean-ish / free text / one of `choices`. Affects the journal hash and the host UI widget. |
| `choices` | `string[]` | For `kind: "select"`. |
| `default` | `unknown` | Reply taken in the default headless mode — journaled like a real reply. Defaults to `true`. |
| `headless` | `"default" \| "abort" \| "pause"` | No live channel: `"default"` takes `default ?? true`, `"abort"` aborts, and `"pause"` creates a persisted `checkpoint_required` pause. Default `"default"`. |
| `timeoutMs` | `number` | Deadline for the interactive prompt. |

The host supplies the live human channel (elicitation in the MCP server; `ExecOptions.confirm` in the SDK), and that channel wins even when `headless: "pause"` is declared. A durable pause carries non-secret `checkpointContext`; resume with `ExecOptions.checkpointReplies: { [context.callIndex]: decision }` or attach a live channel. On a new `resumeFromRunId` execution, reply keys always name indexes in the **source** recording; identity matching may inject that decision at a shifted current index. Completed host and headless checkpoint results both replay when identity and the checkpoint-options fingerprint over `default`, `headless`, and `timeoutMs` match. A changed option or ambiguous match runs fresh. Detached runs never pause for a checkpoint unless the author opts into `"pause"`.

## Error codes (`WorkflowError.code`)

| code | recoverable | engine behavior |
|---|---|---|
| `AGENT_TIMEOUT` | yes | Total wall-clock attempt cap exhausted. Every retry gets a fresh clock; after the final attempt the call resolves `null`, and ACP cancel escalates to close/recycle when the turn does not stop. |
| `AGENT_IDLE_TIMEOUT` | yes | Opt-in no-backend-activity cap exhausted. Real backend events re-arm it; retries and cancellation match `AGENT_TIMEOUT`. |
| `AGENT_CANCELLED` | yes | The host selected this in-flight call for cancellation. It resolves `null` immediately through an engine race, skips retries, leaves the run live, and is recorded as a failed call rather than a replayable journal result. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call; same retry-then-`null`. |
| `AGENT_EXECUTION_ERROR` | yes* | Generic agent failure (*refusal/truncation variants are non-recoverable). |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the re-prompt ladder. Halts the run (catchable in-script). |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall — the run **pauses** (journaled, resumable), with the provider's reset hint. |
| `AGENT_LIMIT_EXCEEDED` | no | `maxAgents` cap hit. |
| `AUTH_REQUIRED` | no | Backend needs authentication. `WorkflowManager` returns a resumable pause with `reason: "auth_required"` and redacted `authContext`; a direct runner throws. The host completes auth before resuming/retrying. |
| `CHECKPOINT_REQUIRED` | no | `headless: "pause"` reached without a live channel. `WorkflowManager` returns `reason: "checkpoint_required"` plus non-secret `checkpointContext`; resume with `checkpointReplies` or live confirm. |
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, bad `meta.backends` shape). |
| `SCRIPT_ERROR` | no | The script itself crashed (uncaught throw, floated rejection). |
| `WORKFLOW_ABORTED` | — | Real cancellation (pause/stop/host signal) — never used for crashes. |

`loopUntilDry` absorbs `AGENT_LIMIT_EXCEEDED` from its rounds and returns the partial result; everywhere else it propagates.

## Determinism & the resume journal

> **Resume rule:** replay is content-addressed and fail-to-live on correspondence: a completed call replays when its identity and input fingerprint match uniquely. Filesystem or world state never gates replay.

The guide section **Determinism and resume** carries the full semantics: what each hash contains, matching, admission, continuation of interrupted calls, and checkpoint replay. Wire-level specifics for lookup:

- Each `agent()` result is journaled under a monotonic call index and a SHA-256 identity hash. The canonical identity fields, in order, are `prompt`, resolved `model`, `mode` only when set, `configOptions` only when non-empty, `tier`, `phase`, `agentType`, resolved `agentDef`, and `schema`. Config-option keys are sorted before serialization. Missing fields other than `mode` and `configOptions` serialize as `null`; an unset `mode` and an unset/empty `configOptions` key are omitted for compatibility with older journals.
- `agentDef` is the resolved definition's tools, disallowed tools, model, isolation, and body prompt. Changing a named definition therefore invalidates its call even when the `agentType` name is unchanged.
- The legacy `resume: { filesystem: "read-only" }` annotation has no effect on admission or matching. Writers, readers, worktree calls, and unannotated calls follow the same journal rule.
- `resumePolicy: "positional"` requests index/prefix correspondence but cannot bypass new-format format, metadata, manifest, cwd, or input checks. Marker-less journals and permanently marked manual/same-run legacy resumes retain historical hash-only positional behavior. Sources below input format 2 use `inputs-format-legacy`. Ancestor-scoped rows carried by a ≤0.23 resume hop replay only while that ancestor is still persisted; engine-minted nested scopes and deleted ancestor scopes stay live.
- There is no `require`, `import`, Node API, or network API in the realm. `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()` fail static validation; aliased or computed forms are blocked at runtime; `new Date(value)` works.

Every new-run resume exposes `replayEligibility` on admission, polling, inspection, and the terminal result. It reports strategy, predicted/observed replayable prefix and counts, first non-replay/reason/detail, engine/input-format diagnostics, non-gating runtime/environment `provenanceChanges`, and non-gating operational changes; `resumeReport` retains the complete terminal per-call correspondence.

An all-live outcome is expected when correspondence cannot be established, not when the world changed. Missing resume metadata, incompatible format literals, or an invalid manifest/seed can disable reuse. A new-format source containing any result row without a captured call path/input fact—possible with a call stack deeper than the raw-frame cap or a non-strict-JSON `meta` value—is source-wide `"manifest-invalid"`; excluding the row could make an ambiguous sibling look unique. Format-1 bytes are never reinterpreted; they enter the positional bridge and replayed rows are recorded under format 2.

An args-controlled cap is the useful case: a cap that changes how many calls are reachable, but
does not appear in an earlier call's prompt, lets those calls replay on resume. The worked example
lives in the determinism-and-resume guide document and ships as
`examples/resume-loop-cap.workflow.js`. This changed-args pattern is specific to new-run entry
points that accept current args with `resumeFromRunId`. The MCP `workflow` tool does, as does
`WorkflowManager.runSync(script, newArgs, { resumeFromRunId })`. MCP resume always requires
explicit content; a bare `resumeFromRunId` is invalid. `WorkflowManager.resume(runId)` is a
different same-ID recovery API: it reloads the persisted original script/args and permanently uses
legacy positional replay semantics, while the independent default-on channel may still continue an
eligible usage/auth-interrupted live call.

## <a name="custom-backends-metabackends"></a>Custom backends — `meta.backends`

```js
export const meta = {
  name: "…", description: "…",
  backends: {
    browser: {
      command: "browser-acp",          // required: executable (absolute or on PATH)
      args: ["--headless"],            // default []
      env: { BROWSER_PROFILE: "qa" },  // merged OVER the child's inherited env — per-backend secrets go here
      sessionMeta: { viewport: "desktop" },  // static ACP _meta on every session/new (per-call `meta` merges over it)
      structuredOutputTool: true,      // default true; false = keep this backend on the prompt/_meta schema fallback
    },
  },
};
```

Script-declared backends are **trust-gated**: they spawn commands on the host machine, so they stay inert until the composition root approves them — elicitation approval in the MCP server, `allowScriptBackends: true` (or a per-backend callback) on `runDynamicWorkflow`, `ExecOptions.scriptBackends` on a manager, or `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1`. A *declined* backend aborts the run rather than silently rerouting its calls to the default backend. Host-registered names always win over script declarations. Prefer host registration (`createAcpRunner({ backends })` / `AGENTPRISM_BACKENDS` env JSON) when you control the host.

## <a name="agenttype-definitions"></a>`agentType` definitions

Markdown files at `<runCwd>/.agentprism/agents/<name>.md` (project) and `~/.agentprism/agents/<name>.md` (user); project wins on name collision. Frontmatter + body:

```markdown
---
description: Read-only security auditor
tools: [read, grep, glob]        # allowlist of tool names (omit = all)
disallowedTools: [bash]          # denylist, applied after the allowlist
model: claude/opus[1m]           # verified id; agent({ model }) overrides it
isolation: worktree              # optional
---
You are a security auditor. Report findings; never modify files.
```

The body is prepended to the agent's task as role guidance. An unknown `agentType` logs a warning and runs with default tools/model (the name degrades to a prose hint).

## How hosts run scripts (what authors can assume)

The connected MCP `workflow` tool is the canonical way an agent runs an authored script; the per-action contracts are in the Running workflows guide section. The tool is self-contained: `config` discovers live backend options and `run` validates automatically before admission. The `workflow` tool is the server's whole *workflow* surface: config/run/resume/inspect/await/result/permissions-response/stop
are action branches, not separate tools, and this input does not resolve a saved workflow name.
The server also registers model-facing `docs` for selective version-matched workflow/REPL reference topics and `repl` for interactive orchestration. This optional skill remains a standalone guide for non-MCP or skills-first hosts. A
run that pauses with `reason: "auth_required"` resumes via a new run after the backend's own CLI is
logged in out-of-band (see below). Prompt-capable MCP hosts also get the compact **`author-workflow`** prompt with an optional `task` argument; it frames the task and directs the assistant to relevant `docs` topics instead of injecting this entire skill.

Environment knobs shared by the MCP server and the SDK: `AGENTPRISM_DEFAULT_BACKEND`,
`AGENTPRISM_ACP_POOL_SIZE` (schema-run parallelism on OpenCode/custom backends scales with the
pool; one injected-tool registry per process), `AGENTPRISM_BACKENDS`,
`AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, `AGENTPRISM_PERSISTENCE_ROOT`, plus per-backend spawn
overrides. Pi uses `AGENTPRISM_PI_ACP_CMD` with optional `AGENTPRISM_PI_ACP_ARGS`; otherwise the
installed exact-pinned package bin is used before the `npx -y @automatalabs/pi-acp` fallback.

Embedding hosts drive the same contract directly through the SDK — `runDynamicWorkflow` /
`WorkflowManager` from `@automatalabs/workflows`, with `exec` limits (`maxAgents`, `concurrency`,
`agentTimeoutMs`, `agentIdleTimeoutMs`, `agentRetries`), a live `confirm` checkpoint channel, and
`exec.resumeFromRunId` for edited-script resume. See `docs/api.md` in the repository. The shapes
below are the `workflow` tool's MCP surface, which is what script authors interact with.

Exact MCP tool input/output types:

```ts
interface WorkflowConfigToolInput {
  action: "config";
  projectDir?: string;
  harnesses?: string[];
  modelSpecs?: string[];
  modelFilter?: string;
  probeTimeoutMs?: number;
}

interface WorkflowExecuteToolInputBase {
  action?: "run";
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  agentIdleTimeoutMs?: number | null;
  resumeFromRunId?: string;
  resumePolicy?: "auto" | "positional";
  checkpointReplies?: Record<number, unknown>;
  background?: boolean; // default false
}

type WorkflowExecuteToolInput = WorkflowExecuteToolInputBase & (
  | { script: string; scriptPath?: never }
  | { script?: never; scriptPath: string } // absolute path on the server
);
// WorkflowExecuteToolInputBase also carries projectDir?: string — the absolute project
// directory selecting the project-scoped run store and default execution cwd. REQUIRED for
// config/run on the shared workflow daemon (one registration serves every project); optional on a
// single-project (--in-process) server. inspect/await/result/permissions-response/stop never take it: a runId locates
// its project store automatically.

interface WorkflowAwaitToolInput {
  action: "await";
  runId: string;
  waitMs?: number;      // default 20_000; integer 0..25_000
  lastN?: number;       // default 20; integer 1..50
  labelGlob?: string;   // same whole-label glob as inspect
  logLines?: number;    // default 20; integer 0..50
}

interface WorkflowResultToolInput {
  action: "result";
  runId: string;
  offset?: number;    // default 0; UTF-8 byte offset, use the prior endOffset
  maxBytes?: number;  // default/max 16,384; minimum 4
}

interface WorkflowResultRetrieval {
  action: "result";
  runId: string;
  status: "completed";
  resultUri: string;
  mimeType: "application/json";
  encoding: "utf-8";
  totalBytes: number;
  offset: number;
  endOffset: number;
  hasMore: boolean;
  chunk: string;
}

interface WorkflowPermissionResponseToolInput {
  action: "permissions-response";
  runId: string;
  permissionId: string;
  response: { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };
}

interface WorkflowConfigToolResult {
  action: "config";
  ok: boolean;
  harnessOptions: Array<{ backendId: string; defaultModeId?: string; model?: string; probed: boolean; modes?: object | null; options?: unknown[]; error?: string }>;
  models: Array<{ backendId: string; hasModelOption: boolean; matches: string[] }>;
}

interface WorkflowValidationRejected {
  action: "run";
  status: "rejected";
  validation: { ok: false; exitCode: 1 | 2; parse: object; dryRun?: object; warnings: string[] };
}

interface WorkflowBackgroundAccepted {
  runId: string;
  status: "running";
  scriptSource: "inline" | "path";
  scriptUri: string;
  limits: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
  pendingPermissions?: WorkflowPendingPermission[];
  interaction: { permissionRequests: "may-block"; collectWith: ("await" | "inspect")[]; respondWith: "permissions-response"; elicitation: "available" | "unavailable" };
}

interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate" | "action-required" | "permission-resolved";
}

interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowAwaitMetadata;
  tokenUsage?: TokenUsage;
  pendingPermissions?: WorkflowPendingPermission[];
  outcome?: Omit<WorkflowExecutionToolResult<T>, "scriptSource">; // exactly when terminal
  scriptUri: string;
  resultUri?: string;
  lineage: Array<{ runId: string; uri: string; available: boolean }>;
}

interface WorkflowStopToolInput {
  action: "stop";
  runId: string;
  callIndex?: number;  // omitted = whole-run abort; present = cancel one in-flight agent
  lastN?: number;
  labelGlob?: string;
  logLines?: number;
  script?: never;
  scriptPath?: never;
  waitMs?: never;
}
```

The selected stop form requires a live, uniquely addressable agent attempt. Settled/unallocated
indexes, checkpoints, duplicate scoped indexes, and terminal runs are errors that enumerate the
currently in-flight call-index/label pairs. A successful selected cancellation returns the ordinary
live `WorkflowRunStatus`; whole-run stop returns the terminal `WorkflowStopResult`.

`WorkflowRunResult.fallbacks?: WorkflowRunFallback[]` retains the compatibility shape
`{ callIndex, label, phase?, requestedSpec, resolvedModel?, backendId?, kind, message, continuation? }`.
`kind` is `model | modifier | continuation`; continuation details report either a reattached
`resume | load` method or an exact skip reason. The model-resolution pipeline itself produces no entries.
`WorkflowRunResult.checkpointsTaken?: WorkflowCheckpointTaken[]` records resolved checkpoints as
`{ callIndex, kind, decision, source }`, where source is `live`, `headless-default`,
`journal-replay`, or `injected`. A paused checkpoint is not resolved. Both fields are persisted and
appear in foreground results plus terminal await `outcome`; neither appears on `WorkflowRunStatus`.

At most four background runs may be active or starting per server instance. Foreground, inspect,
await, result retrieval, and stop consume no slot; a durably stopped background run frees its slot immediately even
while backend session wind-down remains. A timeout returns the freshest status and partial cumulative usage; replay
hits cost/add zero. Terminal results have no MCP TTL and are reconstructed after restart while the
project run record remains readable. The inherited status fields stay redacted/bounded at 24,576
structured bytes and 8,192 text bytes. The full script lineage is never truncated; when lineage
alone exceeds the status budget, `truncation.maxStructuredBytes` reports the larger actual envelope
limit. Terminal `outcome` preserves the raw authored result/full logs and has no new total cap.
Completed foreground/await results include `resultUri`; exact JSON up to 4,096 UTF-8 bytes is copied
into model-visible text for content-first hosts. Larger results stay out of summary text and point
to `workflow://runs/{runId}/result` plus bounded `action:"result"` paging. The outcome includes
`scriptUri` but not the unpersisted admission-only `scriptSource`.

The background start has no enduring request signal, progress channel, or live checkpoint channel.
It returns immediately and emits no progress after returning, even if the initiating request
supplied a progress token. A later bounded `action:"await"` is a separate request; when that await
carries a progress token, it can stream coarse phase and distinct started/ended-call progress while
pending. The legacy/inconsistent-log polling fallback emits no progress notifications. A headless
checkpoint default continues; abort fails with `WORKFLOW_ABORTED`; pause returns
`checkpoint_required` plus `outcome.checkpointContext`. Auth pauses return non-secret
`outcome.authContext`; log the backend CLI in before resume. Background execution lives in the
serving process (the daemon, or the single process under `--in-process`): that process's death can
interrupt an in-flight call, and stale durable `pending`/`running` state reconciles under its lease
to `paused` / `interrupted`.

Every resumed background run durably seeds its inherited prefix (including a manager-owned
checkpoint injection) beneath its new run ID before acknowledgement, so later resume hops remain
self-contained. The MCP layer never rewrites that seed. Await and inspect never execute or resume
the script; their cold preflight may only reconcile a dead owner's stale `pending`/`running` state
to `paused` / `interrupted`.

Every admitted script is an immutable persistence-backed MCP resource at
`workflow://runs/{runId}/script`. A completed JSON value is independently durable at
`workflow://runs/{runId}/result`. Completed foreground/inspect/await responses include its
`resultUri` and labelled link; run results link the new script, while inspect/await link the full
script resume lineage oldest-to-newest as structured `{ runId, uri, available }` entries. Large
result resources can be reconstructed exactly through 16,384-byte `action:"result"` chunks by
following `endOffset` while `hasMore` is true; the bounded/redacted events resource is observability,
not an exact-result API. Listing and
completion include only the 50 newest runs, but a direct URI read works for any retained project
run. A path is never persisted or implicitly re-read, and the MCP layer retains no scripts, args,
or synthetic lineage metadata in process memory.

`action:"stop"` is location-independent: it stops a local live run, cold-stops a lease-free persisted run, or writes an idempotent intent and forwards signed control to a predecessor that holds the run lease. Final success appends `stopped`, releases the lease, and returns the final inspection projection with `stopped:true`. When cross-generation control does not settle inside the bound, the successful nonterminal result carries `control:{state:"pending",operationId,requestedAt,owner?}`; retry stop, inspect, or await. A repeated stop on a terminal run succeeds with `stopped:false,alreadyTerminal:true`. `forceOwner:true` explicitly authorizes terminating a superseded owner daemon and may interrupt sibling runs; it is forbidden with `callIndex`. Targeted call cancellation routes only to the live owner and is never reconstructed after owner loss. An in-flight stop may lack a quiescent terminal-environment proof, so the manager can conservatively run the following resume live; inspect `replayEligibility` and `resumeReport` rather than assuming a prefix replay.

Retain the run ID and inspect halted runs before guessing. The exact inspection input is:

```ts
interface WorkflowInspectToolInput {
  action: "inspect";
  runId: string;       // /^[a-z0-9]+-[a-z0-9]+$/, at most 128 characters
  lastN?: number;      // default 20; integer 1..50
  labelGlob?: string;  // non-empty; at most 128 Unicode code points
  logLines?: number;   // default 20; integer 0..50
  script?: never;
  scriptPath?: never;
}
```

`labelGlob` matches the whole raw agent label case-sensitively: `*` is zero or more Unicode code
points, `?` is exactly one, and backslash escapes the next character (a trailing backslash is
literal). Checkpoints and unknown legacy calls are excluded when a glob is present. Filtering
happens before `lastN`; selected calls return in ascending call-index order.

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
  idleTimeoutMs?: number | null;
  errorCode?: string;
  resultPreview: string;
  resultRedacted: boolean;
  resultTruncated: boolean;
}

interface WorkflowRunStatus {
  runId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
  workflowName: string;
  phases: string[];
  currentPhase?: string;
  reason?: string;
  errorCode?: string;
  limits?: WorkflowRunLimits; // absent only on legacy persisted records
  replayEligibility?: WorkflowReplayEligibility;
  logTail: WorkflowLogTail;
  calls: WorkflowRunCallStatus[];
  filter: { lastN: number; logLines: number; labelGlob?: string };
  truncation: {
    maxStructuredBytes: number;
    byteCapApplied: boolean;
    phases: { total: number; returned: number; shortened: number };
    logs: { total: number; returned: number; shortened: number; redacted: number };
    calls: {
      total: number;
      matched: number;
      returned: number;
      shortenedResults: number;
      redactedResults: number;
    };
  };
}

interface WorkflowRunLimits {
  maxAgents: number;
  tokenBudget: null; // persisted-shape compatibility field; new runs always report null
  concurrency: number;
  agentRetries: number;
  agentTimeoutMs: number | null;
  agentIdleTimeoutMs: number | null;
}
```

Inspection returns only this allowlisted projection: never raw script, args, prompts, histories,
hashes, session IDs, cwd, checkpoint/auth details, or raw results. Credential-shaped data is
redacted, results are structurally compacted, every outward text scalar/preview is capped at 512
UTF-8 bytes, inherited status JSON at 24,576 bytes, and inspection text at 8,192 bytes. Full lineage
can raise the structured envelope limit as reported by `truncation.maxStructuredBytes`. An unknown ID is
a tool error with no structured content; reading an existing failed run succeeds and reports
`status:"failed"`. Every paused, failed, or aborted execution result also carries a redacted
final-20 `logTail` (present when empty) and renders it in the immediate terminal text. Completed
execution results omit that extra field while retaining their full `logs` array.

Backend auth comes from the machine the host runs on: Claude via a logged-in Claude Code install or `ANTHROPIC_API_KEY`; Codex via `~/.codex/auth.json`; OpenCode via `opencode auth login` (its CLI must be installed — it is not bundled); Pi via one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, or ambient credentials in `~/.pi/agent/auth.json`. A script only needs auth for the backends it actually routes to.

## The validator — `agentprism-workflows validate`

```bash
npx @automatalabs/workflows validate <workflow-file> [options]
```

Zero tokens; three passes — static parse, mocked dry run, then one no-prompt mode/config probe per
routed backend/model target — described in the guide's Validate before you run section. The
tables and grammar below are the exhaustive contract.

| flag | meaning |
|---|---|
| `--args <json>` / `--args-file <path>` | the script's `args` global for the dry run |
| `--mock-answers <json>` | label-glob answers for dry-run calls; mutually exclusive with the file form |
| `--mock-answers-file <path>` | read the same JSON object from a UTF-8 file resolved against the process cwd |
| `--workflows-dir <dir>` | repeatable; a folder of workflow scripts (name = filename stem). Lets the positional be a NAME and resolves nested `workflow("<name>")` calls |
| `--parse-only` | static parse only |
| `--cwd <dir>` | dry-run base cwd (default: throwaway temp dir, so `isolation: "worktree"` no-ops; a real repo cwd creates and cleans up real worktrees) |
| `--max-agents <n>` | cap on dry-run agent calls |
| `--timeout-ms <n>` | dry-run wall-clock limit (default 30000) |
| `--json` | machine-readable `ValidateWorkflowReport` on stdout |

Inline false-branch fixture (exact shell form):

```bash
agentprism-workflows validate flow.workflow.js \
  --mock-answers '{"refute:*":{"real":false}}'
```

Equivalent reusable file with a reject-then-approve sequence:

```json
{
  "refute:*": { "real": false },
  "quality:review": {
    "$sequence": [
      { "ok": false, "feedback": "exercise the revision path" },
      { "ok": true }
    ]
  }
}
```

```bash
agentprism-workflows validate flow.workflow.js --mock-answers-file mock-answers.json
```

Rules match the final resolved label case-sensitively across the whole string. `*` matches zero or more characters (including `:` and `/`), `?` one character, and `\` escapes the next character; empty globs and trailing escapes are invalid. Object order is captured once and the **last matching rule wins**, so put `"*"` before narrower exceptions. Raw canonical array-index keys (`"0"` or a non-zero, no-leading-zero decimal through `"4294967294"`) are reserved because ECMAScript reorders them. To match numeric label `10`, use JSON key `"\\10"`; `"01"` and `"4294967295"` are ordinary keys.

A single answer is reusable. `{ "$sequence": [...] }` is finite and only the winning rule consumes it; a raw array is one array result, and a sequence element is ordinary answer data even when it contains `$sequence`. Exhaustion fails instead of repeating the last item or falling back. The machine report uses zero-based `sequenceIndex`; human lines render one-based `[position/length]`. Earlier matching rules count the match even when shadowed, and `dryRun.mockAnswers.unused` distinguishes `no-match`, `shadowed`, and partially consumed `not-reached` items. Unused fixtures warn but do not fail validation.

For schema calls, each answer deep-merges over a **fresh** fabricated base: JSON objects merge recursively; arrays, `null`, falsy primitives, and other scalars replace. The merged value is TypeBox-checked without coercion. Any answer-caused violation fails non-recoverably with `SCHEMA_NONCOMPLIANCE`; a failure already present at the identical untouched path/message in the simple fabricated base may be accepted with a grouped inherited-fabrication warning. A valid override can repair such a base limitation. Schema-less answers must be nonblank strings. Fixture failure messages, attribution, and warnings contain only labels, globs, positions, paths, and counts—not answer values.

Limits: 256 KiB raw UTF-8 for either CLI source and canonical JSON for programmatic input; 256 rules; 1–256 UTF-16 code units per glob; 256 entries per sequence; answer depth 32. Inputs must be plain JSON data. Mock-enabled validation serves agent calls serially for deterministic FIFO sequence allocation; it is not a concurrency/load simulation. Fixture values still flow into the script like real agent results, so author code can expose them via `log()` or its returned result—never store credentials or production data in fixtures.

Exit codes: `0` valid · `1` parse/static failure · `2` dry-run failure · `3` usage error. The report also lists every checkpoint with the mock reply (`default ?? true`) and warnings for backend approval, phase mismatch, `headless: "abort"`, and agent-less scripts. `headless: "pause"` dry-runs cleanly. A saved nested workflow still needs `--workflows-dir`.

Programmatic: `validateWorkflowScript(script, { args, workflows, dryRun, cwd, maxAgents, timeoutMs, mockAnswers })` from `@automatalabs/workflows` returns the same report. Invalid workflow scripts resolve to reports; invalid `mockAnswers` supplied from untyped JavaScript throws `TypeError` before parsing.

## Harness config discovery — `agentprism-workflows config`

Validate's sibling: the same no-prompt config probe, standalone — no script required. Run it BEFORE authoring to read each harness's advertised, negotiable session surface (model ids including bracket variants, effort levels, modes, boolean knobs) instead of guessing values or writing a throwaway probe workflow.

```bash
npx @automatalabs/workflows config                  # every routable harness
npx @automatalabs/workflows config codex opencode   # only the named harnesses
npx @automatalabs/workflows config claude --json    # machine-readable report
npx @automatalabs/workflows config opencode --models          # provider/group breakdown
npx @automatalabs/workflows config pi --models=anthropic      # only matching model ids
```

Harness names are the routing names: built-in `claude` / `codex` / `opencode` / `pi` plus any custom backend registered via the `AGENTPRISM_BACKENDS` env var (registered customs also join the no-argument default set). Each harness opens one session without a prompt — zero tokens — and its catalog is read fresh; a harness that cannot spawn or authenticate reports `probed: false` with the reason and never blocks the others.

The no-argument built-in sequence comes from `BUILTIN_BACKEND_IDS`; authoring prose describes the
current registry rows and does not define a separate supported-backend list.

A harness with a large model catalog (today pi and opencode advertise hundreds) would otherwise
flood your context, so any select option above ~24 choices — in practice the `model` option — is
rendered as a grouped **summary** (total + per-provider/group counts) rather than the full leaf
list. This applies to BOTH the human table and `--json`, so neither surface dumps the whole catalog;
small catalogs (claude, codex, and every effort/mode/boolean option) are unaffected and print
verbatim. The complete list is reachable only through `--models`, and there is deliberately no
unfiltered full-leaf dump on any surface:

- `config <harness> --models` — the provider/group breakdown with counts (no leaf ids)
- `config <harness> --models=<filter>` — the leaf model ids matching `<filter>`, where `<filter>` is
  a provider name / case-insensitive substring, or a `/regex/`

| flag | meaning |
|---|---|
| `--cwd <dir>` | session cwd for the probes (default: the current directory — harnesses may resolve project-level config, and hence their catalog, from it) |
| `--timeout-ms <n>` | per-harness probe bound (default 60000); a timed-out harness reports `probed:false` |
| `--models[=<filter>]` | list a harness's model catalog: bare prints the provider/group breakdown; `=<provider\|substring\|/regex/>` prints the matching leaf ids. The only way to reach the leaves of a summarized catalog; never dumps them all unfiltered. With `--json`, emits the structured model view (`{ harnessModels: [...] }`) |
| `--json` | machine-readable `HarnessConfigReport` on stdout (`harnessOptions` uses the same per-harness shape as validate's report). An oversized select's `options` array is replaced by `{ truncated: true, choiceSummary: { total, groups, expand } }` — the same summary the human table shows |

Exit codes: `0` all probed · `1` at least one probe failed · `3` usage error.

Programmatic: `probeHarnessConfig({ harnesses, backends, cwd, timeoutMs })` from `@automatalabs/workflows` returns the same report (`backends` merges over `AGENTPRISM_BACKENDS` exactly like `createAcpRunner`); `formatHarnessConfigReport(report)` renders the human table.

## Workflow folders

Hosts that keep versioned folders of workflow scripts serve them by name (the SDK's
`openWorkflowDir` — see `docs/api.md`). The filename stem is the name (`review-pr.workflow.js` ⇒
`review-pr`; `.workflow.js` beats `.js`). For script AUTHORS the takeaway is simply:
`workflow("<name>")` works when the host serves a folder; keep names equal to filename stems.
