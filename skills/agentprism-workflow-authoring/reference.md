# Workflow script reference

Exhaustive tables for the AgentPrism workflow script DSL. `SKILL.md` (same directory) is the authoring guide; this file is the lookup companion. Everything here is verified against `@automatalabs/workflow-engine` / `@automatalabs/acp-agents` as shipped with `@automatalabs/workflows`.

## The `meta` header

`export const meta = {...}` must be the script's first statement and a pure object literal (it is parsed from source text before execution).

| field | required | meaning |
|---|---|---|
| `name` | yes | Stable identifier for the workflow (journals, logs, traces). |
| `description` | yes | One line: what the workflow does. |
| `phases` | no | `[{ title, detail?, model? }]` — declare one entry per `phase()` call (matched by exact title). A phase `model` is the default for agents assigned to that phase. |
| `model` | no | Run-wide default model for agents with no `model`/`tier` whose phase has no `model`. |
| `backends` | no | Script-declared custom ACP backends, keyed by routing name — see [Custom backends](#custom-backends-metabackends). Inert until the host approves them. |

Per-agent model precedence: `agent({ model })` > `agent({ tier })` > current phase `model` > `meta.model` > host session default.

## `agent(prompt, options?)` — full option table

Returns the agent's final assistant text, or the schema-validated object when `schema` is set. Resolves to `null` when a *recoverable* failure survives all retries.

| option | type | meaning |
|---|---|---|
| `label` | `string` | Display/telemetry name; also stamped on every live ACP event for this call. Always set it. Not part of the resume hash. |
| `phase` | `string` | Assign this call to a phase explicitly (needed inside concurrent stages where the global `phase()` state would race). |
| `schema` | JSON Schema object | Structured output. Plain object literal only — no schema builders exist in the realm. Part of the resume hash. |
| `model` | `string` | Model spec: optional registered harness prefix plus a verbatim id, or a backend-only name. See [Model specs & routing](#model-specs--routing). Part of the resume hash. |
| `tier` | `"small" \| "medium" \| "big"` | Coarse tier resolved from host config; beats phase/meta model, loses to explicit `model`. Part of the resume hash. |
| `mode` | `string` | ACP session mode id advertised by the selected backend. **Strict**: unsupported/unadvertised ids fail the call (never silently unconfined). Claude-family: `default`, `plan`, `acceptEdits`, `bypassPermissions`. Codex-family: `read-only`, `agent`, `agent-full-access`. OpenCode: its mode config option. Part of the resume hash when set. |
| `configOptions` | `Record<string, string \| boolean>` | Exact ACP session option ids and authored values. Applied in ascending id order after model and before the prompt, with no aliases or coercion. `"model"` is reserved for the dedicated `model` field. Part of the resume hash only when non-empty, with sorted keys. Read the advertised-options table first (`agentprism-workflows config <harness>`, or any validate report) before choosing values. |
| `agentType` | `string` | Bind a named subagent definition (tools allow/deny, model, isolation, role prompt). See [agentType definitions](#agenttype-definitions). Part of the resume hash. |
| `isolation` | `"worktree"` | Run in a throwaway git worktree branched from the run cwd. **Always removed (worktree + branch) when the call ends** — edits are discarded; return work as data. Degrades to the shared tree outside a git repo (logged). |
| `resume` | `{ filesystem: "read-only" }` | Author assertion that the call is safe for content-addressed mainline replay. A non-worktree call must not mutate persistent state; a successfully isolated worktree may contain ordinary checkout edits, but commits and effects outside it remain forbidden. Engine-owned, not passed to the runner, and not hashed. |
| `cwd` | `string` | Per-session working directory; relative resolves against the run's base cwd. Overridden by worktree isolation. Not hashed. |
| `timeoutMs` | `number \| null` | Per-call timeout; `null` disables. Defaults to the host's per-agent timeout (none unless configured). |
| `retries` | `number` | Retries after *recoverable* failures (default 0, host-overridable). Exhausted retries ⇒ the call resolves `null`. |
| `mcpServers` | `McpServerConfig[]` | MCP servers attached to this session. Stdio shape: `{ name, command, args: [], env: [{ name, value }] }` (`args`/`env` required, `env` is name/value pairs, not a map); `{ type: "http" \| "sse", name, url, headers: [] }` also accepted. Not hashed. |
| `images` | `PromptImage[]` | Base64 image blocks appended to the prompt; backends without image support get a bracketed text note. Not hashed. |
| `meta` | `object` | ACP `_meta` merged into `session/new` — session-scoped extension passthrough (pairs with custom backends). Not hashed. |
| `promptMeta` | `object` | ACP `_meta` merged into `session/prompt` — turn-scoped passthrough. Backend-computed keys win on conflict. Not hashed. |
| `keepSession` | `boolean` | Skip release-time best-effort `session/close`; the non-secret re-attach record lands in `WorkflowRunResult.agentSessions` for host-side `loadSession()` / `resumeSession()`. Usage/auth pause failures are kept open automatically for managed continuation. Not identity-hashed; included in the input fingerprint. |

## Model specs & routing

A `model` string is resolved solely from its first segment, then delegated to the harness:

| spec shape | routes to | notes |
|---|---|---|
| *(omitted)* | host default backend | `AGENTPRISM_DEFAULT_BACKEND` (`claude` \| `codex` \| `opencode` \| `pi` \| custom name; default `claude`), session default model. Most portable. |
| `claude`, `codex`, `opencode`, `pi`, or `<custom-name>` | that registered harness | Backend-only: no model config call; the harness default remains active. |
| `claude/<id>`, `codex/<id>`, `opencode/<id>`, `pi/<id>`, or `<custom-name>/<id>` | that registered harness | Match the first segment ASCII-case-insensitively and strip exactly one segment. Custom names take priority on collision. The remaining `<id>` is sent verbatim, including further `/` characters. For Pi, that remainder is its `<provider>/<model-id>` and Pi preserves any further slashes in the model id. |
| any other string, including `anthropic/…`, `openai/…`, bare `opus`, or bare `gpt-…` | host default backend | The **entire** authored string is sent verbatim; these are not routing aliases. |

Selection is a single `session/set_config_option` with `configId: "model"` and the exact remaining string. There is no catalog matching, case folding, normalization, bracket parsing, nearest-neighbor selection, sibling effort/Fast option driving, retry, or echo verification. Brackets, dots, and provider-style prefixes are ordinary model-id characters. Live-catalog-verified examples are `claude/opus[1m]`, `codex/gpt-5.6-sol`, and `opencode/zai/glm-5.2`; prefer backend-only forms for harness-configured models.

Whatever the harness returns is the outcome. A rejection follows the existing agent-error path with no resolution-specific code or model fallback event. `onModelFallback` and `WorkflowRunResult.fallbacks` remain public compatibility surfaces; model resolution does not emit entries, while pause recovery emits `kind: "continuation"` reattach/skip notices.

### Session config options

`configOptions` extends the model rule to any other ACP session knob the routed harness advertises:

```js
await agent("Implement the approved change.", {
  label: "implement",
  model: "codex",
  configOptions: { fast_mode: true, reasoning_effort: "high" },
});
```

Ids and values are verbatim: strings stay strings, booleans stay booleans, and the client has no
aliases, vocabulary, defaults, coercion, or catalog fallback. Entries are sent in ascending
option-id order after model selection and before the prompt. A harness rejection follows the
ordinary agent-error path. Never put `"model"` in this bag; the engine rejects it before opening a
session. The catalog varies by harness version, login, and machine, so read a live advertised
config-options table — `agentprism-workflows config <harness>`, or any validate report — before
picking an id or select value, and run the validator every time after authoring.

## Structured output channels

One author API (`schema`), four fulfillment paths — chosen automatically per backend:

| backend | channel |
|---|---|
| Claude | native `outputFormat`, schema normalized to Anthropic's structured-outputs subset (e.g. `oneOf` → `anyOf`; unsupported keywords/formats stripped on the wire) |
| Codex | native strict `outputSchema` (OpenAI strict subset normalization) |
| Pi | native turn-level `_meta.outputSchema` with plain JSON Schema; final-message JSON is parsed; no schema prompt embedding and no injected MCP tool |
| OpenCode / custom ACP | a client-hosted **`StructuredOutput` MCP tool** injected into the session when the agent advertises HTTP MCP support (an agent may show it as `structured_output_StructuredOutput`); otherwise prompt-embedded schema + JSON parse of the final message. Custom backends can opt out of tool injection with `structuredOutputTool: false`. |

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
    → unique items[]   // round(i) returns items; stops after N dry rounds; budget exhaustion returns the partial result
completenessCheck(taskArgs, results)       → { complete, missing?: string[] }
checkpoint(promptText, options?)           → Promise<reply>       // journaled human gate; zero tokens
phase(title, { budget? })                  → void                 // soft per-phase token sub-budget
log(message)                               → void                 // console.log/info/warn/error route here too
args                                       // the host-provided input value, verbatim
cwd                                        // the run's base working directory (string); process.cwd() returns it too
budget.total | budget.spent() | budget.remaining()
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

The host supplies the live human channel (`ExecOptions.confirm` in the SDK; elicitation in the MCP server), and that channel wins even when `headless: "pause"` is declared. A durable pause carries non-secret `checkpointContext`; resume with `ExecOptions.checkpointReplies: { [context.callIndex]: decision }` or attach a live channel. On a new `resumeFromRunId` execution, reply keys always name indexes in the **source** recording; identity matching may inject that decision at a shifted current index. Identity replay is restricted to host decisions and requires equality of the checkpoint-options fingerprint over `default`, `headless`, and `timeoutMs`; a changed option, ambiguous match, or source headless decision runs fresh. Detached runs never pause for a checkpoint unless the author opts into `"pause"`.

## Error codes (`WorkflowError.code`)

| code | recoverable | engine behavior |
|---|---|---|
| `AGENT_TIMEOUT` | yes | Retried per `retries`, then the call resolves `null`. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call; same retry-then-`null`. |
| `AGENT_EXECUTION_ERROR` | yes* | Generic agent failure (*refusal/truncation variants are non-recoverable). |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the re-prompt ladder. Halts the run (catchable in-script). |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall — the run **pauses** (journaled, resumable), with the provider's reset hint. |
| `TOKEN_BUDGET_EXHAUSTED` | no | Run (or phase) token cap hit; further `agent()` calls throw. |
| `AGENT_LIMIT_EXCEEDED` | no | `maxAgents` cap hit. |
| `AUTH_REQUIRED` | no | Backend needs authentication. `WorkflowManager` returns a resumable pause with `reason: "auth_required"` and redacted `authContext`; a direct runner throws. The host completes auth before resuming/retrying. |
| `CHECKPOINT_REQUIRED` | no | `headless: "pause"` reached without a live channel. `WorkflowManager` returns `reason: "checkpoint_required"` plus non-secret `checkpointContext`; resume with `checkpointReplies` or live confirm. |
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, bad `meta.backends` shape). |
| `SCRIPT_ERROR` | no | The script itself crashed (uncaught throw, floated rejection). |
| `WORKFLOW_ABORTED` | — | Real cancellation (pause/stop/host signal) — never used for crashes. |

`loopUntilDry` absorbs `TOKEN_BUDGET_EXHAUSTED` / `AGENT_LIMIT_EXCEEDED` from its rounds and returns the partial result; everywhere else those propagate.

## Determinism & the resume journal

> **Resume rule:** replay is content-addressed and fail-to-live: an admitted safe call replays only when its identity and input fingerprint match uniquely.

- Direct calls that break deterministic replay fail static validation: `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()`. The realm also blocks aliased or computed forms at runtime. `new Date(value)` works. There is no `require`, `import`, Node API, or network API in the realm.
- Each `agent()` result is journaled under a monotonic call index and a SHA-256 identity hash. The canonical identity fields, in order, are `prompt`, resolved `model`, `mode` only when set, `configOptions` only when non-empty, `tier`, `phase`, `agentType`, resolved `agentDef`, and `schema`. Config-option keys are sorted before serialization. Missing fields other than `mode` and `configOptions` serialize as `null`; an unset `mode` and an unset/empty `configOptions` key are omitted for compatibility with older journals.
- `agentDef` is the resolved definition's tools, disallowed tools, model, isolation, and body prompt. Changing a named definition therefore invalidates its call even when the `agentType` name is unchanged.
- `args` is exposed to the script but is not directly included in the call hash. An args change misses only when evaluating the script produces a changed hashed field, changed call order, new call, or changed runner-visible input fingerprint.
- `resume: { filesystem: "read-only" }` is the author opt-in for non-contiguous identity replay. Without worktree isolation it promises no persistent filesystem or external mutations and no load-bearing ambient dependency. With `isolation: "worktree"`, it permits ordinary edits only inside a successfully created throwaway checkout; commits, shared-git mutations, ignored/out-of-tree artifacts, and external effects remain forbidden. Modes, tool lists, prose, and worktree isolation by themselves do not imply safety.
- Automatic new-format matching first tries one exact `(kind, call path, identity hash)` candidate (`"path-hash"`), then one unique `(kind, identity hash, input fingerprint)` candidate so an unchanged call may replay as `"unique-hash"` across inserted/deleted siblings. The source and current input fingerprints must be equal. Duplicate exact identities, duplicate content, consumed candidates, missing facts, changed safety, or an empty schema-less result run live; no occurrence or source-order guess is made.
- A source is admitted only after exact cwd, full Node/V8/runtime-format, and terminal environment checks. Git sources compare HEAD plus the dirty digest; non-git hosts must provide the same `environmentKey`. Unknown formats, missing facts, source drift, and uncertainty select all-live. A safe, stable source can use identity matching; an unsafe but stable new-format source gets only a safety-checked positional prefix, while nested or source-drifted fallback is all-live.
- The first live call without a valid read-only declaration, any nested workflow, a live host checkpoint callback, or an annotated worktree that degrades/fails closes the remaining identity cache before the effect runs. Declared readers and successfully created declared worktrees may stay open. Unordered `parallel()` siblings must never communicate through files or another persistent/ambient side channel.
- Identity hits add their preserved logical budget debit to `budget.spent()`/`remaining()` so budget-driven control flow stays stable, while current `tokenUsage` and provider cost remain zero. Replayed session records are rebound to the current call index/label/phase without opening a session.
- A root call interrupted by `PROVIDER_USAGE_LIMIT` / `AUTH_REQUIRED` may continue its recorded session on either resume API. Continuation is index-local and independent of replay strategy. It requires matching identity and input fingerprints, a non-worktree call, equal existing cwd, a coherent reopenable session row, and matching runner backend/`poolKey`; current capabilities choose resume before load. Every rejection fails to a fresh call and appears in `fallbacks`, while successful continuation journals its reopen method and charges only continuation-turn usage.
- `checkpoint()` identity replay uses only proven host decisions and requires equal fingerprints of `default`, `headless`, and `timeoutMs`. Source headless decisions always execute fresh. `checkpointReplies` keys refer to source indexes; an unambiguous reply may move to a shifted current checkpoint.
- `resumePolicy: "positional"` is the migration escape hatch: it requests index/prefix correspondence but cannot bypass new-format input, safety, cwd, runtime, or environment gates. Marker-less journals and permanently marked manual/same-run legacy resumes retain historical hash-only positional behavior.
- The additive options `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` are not identity-hashed. A changed value does not invalidate an ordinary replayed result, but it changes the input fingerprint and therefore rejects continuation of an interrupted turn.

Two all-live outcomes are expected calibration, not an engine error. A new-format source containing any result row without a captured call path/input fact—possible with a call stack deeper than the raw-frame cap or a non-strict-JSON `meta` value—is source-wide `"manifest-invalid"`; excluding the row could make an ambiguous sibling look unique. Also, exact runtime equality means a Node or V8 upgrade invalidates every new-format cache (`"runtime-mismatch"`), while marker-less legacy journals keep their historical positional behavior. Relaxing that asymmetry would require a new persisted format literal; v1 bytes are never reinterpreted.

An args-controlled cap is the useful case. In this complete script, `maxRounds` changes how many calls are reachable but does not appear in an earlier call's prompt:

```js
export const meta = {
  name: "resume-loop-cap",
  description: "Run expensive review rounds up to an args-controlled cap",
  phases: [{ title: "Review" }],
};

const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const numericCap = Number(input.maxRounds);
const maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;

phase("Review");
const rounds = [];
for (let i = 0; i < maxRounds; i += 1) {
  rounds.push(
    await agent(
      `Review round ${i + 1}: inspect the repository and report unresolved release blockers.`,
      { label: `review:${i + 1}`, phase: "Review", resume: { filesystem: "read-only" } },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
```

The first MCP request uses `{ "args": { "maxRounds": 6 } }` and returns a failed run with a
persisted six-entry journal. The next request sends the same content via `script` (or the same
absolute `scriptPath`), `{ "args": { "maxRounds": 8 } }`, and the returned run ID as
`resumeFromRunId`. Calls 0–5 match uniquely and replay for zero current provider tokens; calls 6–7
are new and run live. This changed-args pattern is specific to new-run entry points that accept
current args with `resumeFromRunId`. The MCP `workflow` tool does, as does
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

Script-declared backends are **trust-gated**: they spawn commands on the host machine, so they stay inert until the composition root approves them — `allowScriptBackends: true` (or a per-backend callback) on `runDynamicWorkflow`, `ExecOptions.scriptBackends` on a manager, elicitation approval in the MCP server, or `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1`. A *declined* backend aborts the run rather than silently rerouting its calls to the default backend. Host-registered names always win over script declarations. Prefer host registration (`createAcpRunner({ backends })` / `AGENTPRISM_BACKENDS` env JSON) when you control the host.

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

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const run = await runDynamicWorkflow(script, {
  cwd: "/abs/project",              // the script's `cwd` global; every session's base dir
  args: { target: "src/" },         // the script's `args` global, verbatim
  allowScriptBackends: true,        // approve meta.backends (or a per-backend callback)
  exec: {
    tokenBudget: 500_000,           // hard cap → budget.total in-script
    maxAgents: 200,
    concurrency: 8,                 // concurrent agents (default 8)
    agentTimeoutMs: 600_000,
    agentRetries: 1,                // default retries for recoverable failures
    confirm: async (text, opts) => true,   // live checkpoint channel; omit = authored headless mode
    onProgress: (snapshot) => {},
  },
});
// run.status: "completed" | "paused" | "failed" | "aborted"
// run.result · run.runId (resume handle) · run.tokenUsage · run.logs · run.phases
// run.resumeReport? · run.fallbacks? (compatibility) · run.checkpointsTaken? (absent when empty)
```

For edited-script/current-args resume, call the same entry point with
`exec: { resumeFromRunId: previous.runId, resumePolicy: "auto", checkpointReplies }`. Reply keys
name source indexes. The manager prepares and durably persists correspondence before execution.

The MCP route (`npx @automatalabs/mcp-server`, tool name `workflow`) accepts exactly one of raw
`script` source or an absolute server-filesystem `scriptPath`, plus `args`. A path is read once and
snapshotted at admission. Foreground is the default and streams progress/resolves checkpoints live;
long work uses `background:true` plus bounded `action:"await"`. It supports explicit
`resumeFromRunId` with content supplied again by either mechanism; non-elicitation clients resume
`headless: "pause"` checkpoints with `checkpointReplies` from terminal
`outcome.checkpointContext`. Unlike the SDK's `openWorkflowDir` path, this input does not resolve a
saved workflow name. The `workflow` tool is the server's whole tool surface —
run/resume/inspect/await/stop are action branches, not separate tools. A run that pauses with
`reason: "auth_required"` resumes via a new run after the backend's own CLI is logged in out-of-band
(see below). Prompt-capable MCP hosts (e.g. Claude Code, where it surfaces as a slash command) also
get this entire guide from the server itself as the **`author-workflow`** prompt, with an optional
`task` argument. Environment knobs shared by both: `AGENTPRISM_DEFAULT_BACKEND`,
`AGENTPRISM_ACP_POOL_SIZE` (schema-run parallelism on OpenCode/custom backends scales with the pool,
one injected-tool registry per process), `AGENTPRISM_BACKENDS`,
`AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, `AGENTPRISM_PERSISTENCE_ROOT`, plus per-backend spawn
overrides. Pi uses `AGENTPRISM_PI_ACP_CMD` with optional `AGENTPRISM_PI_ACP_ARGS`; otherwise the
installed exact-pinned package bin is used before the `npx -y @automatalabs/pi-acp` fallback.

Exact detached host types:

```ts
interface WorkflowExecuteToolInputBase {
  action?: "run";
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  tokenBudget?: number | null;
  resumeFromRunId?: string;
  resumePolicy?: "auto" | "positional";
  checkpointReplies?: Record<number, unknown>;
  background?: boolean; // default false
}

type WorkflowExecuteToolInput = WorkflowExecuteToolInputBase & (
  | { script: string; scriptPath?: never }
  | { script?: never; scriptPath: string } // absolute path on the server
);

interface WorkflowAwaitToolInput {
  action: "await";
  runId: string;
  waitMs?: number;      // default 20_000; integer 0..25_000
  lastN?: number;       // default 20; integer 1..50
  labelGlob?: string;   // same whole-label glob as inspect
  logLines?: number;    // default 20; integer 0..50
}

interface WorkflowBackgroundAccepted {
  runId: string;
  status: "running";
  scriptSource: "inline" | "path";
  scriptUri: string;
}

interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate";
}

interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowAwaitMetadata;
  tokenUsage?: TokenUsage;
  outcome?: Omit<WorkflowExecutionToolResult<T>, "scriptSource">; // exactly when terminal
  scriptUri: string;
  lineage: Array<{ runId: string; uri: string; available: boolean }>;
}

interface WorkflowStopToolInput {
  action: "stop";
  runId: string;
  lastN?: number;
  labelGlob?: string;
  logLines?: number;
  script?: never;
  scriptPath?: never;
  waitMs?: never;
}
```

`WorkflowRunResult.fallbacks?: WorkflowRunFallback[]` retains the compatibility shape
`{ callIndex, label, phase?, requestedSpec, resolvedModel?, backendId?, kind, message, continuation? }`.
`kind` is `model | modifier | continuation`; continuation details report either a reattached
`resume | load` method or an exact skip reason. The model-resolution pipeline itself produces no entries.
`WorkflowRunResult.checkpointsTaken?: WorkflowCheckpointTaken[]` records resolved checkpoints as
`{ callIndex, kind, decision, source }`, where source is `live`, `headless-default`,
`journal-replay`, or `injected`. A paused checkpoint is not resolved. Both fields are persisted and
appear in foreground results plus terminal await `outcome`; neither appears on `WorkflowRunStatus`.

At most four background runs may be active or starting per server instance. Foreground, inspect,
await, and stop consume no slot; a durably stopped background run frees its slot immediately even
while backend session wind-down remains. A timeout returns the freshest status and partial cumulative usage; replay
hits cost/add zero. Terminal results have no MCP TTL and are reconstructed after restart while the
project run record remains readable. The inherited status fields stay redacted/bounded at 24,576
structured bytes and 8,192 text bytes. The full script lineage is never truncated; when lineage
alone exceeds the status budget, `truncation.maxStructuredBytes` reports the larger actual envelope
limit. Terminal `outcome` preserves the raw authored result/full logs and has no new total cap, but
it is never copied into text. It includes `scriptUri` but not the unpersisted admission-only
`scriptSource`.

The background start has no enduring request signal, progress channel, or live checkpoint channel.
It returns immediately and emits no progress after returning, even if the initiating request
supplied a progress token. A later bounded `action:"await"` is a separate request; when that await
carries a progress token, it can stream coarse phase and distinct started/ended-call progress while
pending. The legacy/inconsistent-log polling fallback emits no progress notifications. Headless
checkpoint default continues, abort fails with `WORKFLOW_ABORTED`, and pause returns
`checkpoint_required` plus `outcome.checkpointContext`. Auth pauses return non-secret
`outcome.authContext`; log the backend CLI in before resume. Background is process-lifetime, not
daemon execution: process death can interrupt an in-flight call, and stale durable `running` state
recovers to `paused`.

`action:"await"` and `action:"inspect"` are read-only: they never replay the script, spend tokens,
or acquire the run lease. `resumeFromRunId` executes a new run with the caller's current script or
path snapshot and args, and a new run ID. Every resumed background run durably seeds its inherited prefix (including a
manager-owned checkpoint injection) beneath that new ID before acknowledgement, so later resume
hops remain self-contained. The MCP layer never rewrites that seed.

Every admitted script is an immutable persistence-backed MCP resource at
`workflow://runs/{runId}/script`. Run results link the new script; inspect/await link the full resume
lineage oldest-to-newest and expose structured `{ runId, uri, available }` entries. A fresh session
can read a lost inline script and explicitly send that text back with `resumeFromRunId`; a path is
never persisted or implicitly re-read. Listing/completion include only the 50 newest runs, but a
direct URI read works for any retained project run.
The MCP layer retains no scripts, args, or synthetic lineage metadata in process memory.

`action:"stop"` durably aborts a `running` or `paused` run live in this server process, cancels any
pending agent/checkpoint request, appends `stopped`, releases the lease, and returns the final
inspection projection with `stopped:true`. Resume is safe immediately; await adds nothing. Only
backend session wind-down can remain, observable through inspect's agent states. A repeated stop on
a terminal run succeeds with `stopped:false, alreadyTerminal:true`. For the kill-patch-resume loop:
stop, edit the file, then submit its `scriptPath` with `resumeFromRunId`. An in-flight stop may lack
a quiescent terminal-environment proof, so the manager can conservatively run that resume live;
inspect `resumeReport` rather than assuming a prefix replay.

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

Zero tokens: a static parse (meta literal, syntax, and direct nondeterministic call expressions) plus a dry run in the real engine realm against a mock `AgentRunner` that fabricates deterministic results (`enum[0]`, `true` booleans, `mock-<field>` strings, one to three array items). Afterward, validation opens each distinct routed ACP harness once without a prompt and surfaces its full advertised config-options table in both human and JSON reports, even when the script authors none. It checks exact authored ids, select values, boolean types, and the reserved `"model"` key; errors name the call label, authored value, and advertised alternatives and exit `2`. A harness spawn/auth/session failure adds one warning, reports `probed:false`, and skips only that harness's checks—it never fails validation by itself. Catalogs are read afresh on every validation. Script boolean-controlled branches explicitly instead of treating the all-true default as convergence coverage.

| flag | meaning |
|---|---|
| `--args <json>` / `--args-file <path>` | the script's `args` global for the dry run |
| `--mock-answers <json>` | label-glob answers for dry-run calls; mutually exclusive with the file form |
| `--mock-answers-file <path>` | read the same JSON object from a UTF-8 file resolved against the process cwd |
| `--workflows-dir <dir>` | repeatable; a folder of workflow scripts (name = filename stem). Lets the positional be a NAME and resolves nested `workflow("<name>")` calls |
| `--parse-only` | static parse only |
| `--cwd <dir>` | dry-run base cwd (default: throwaway temp dir, so `isolation: "worktree"` no-ops; a real repo cwd creates and cleans up real worktrees) |
| `--token-budget <n>` | sets `budget.total`; the mock reports 1000 tokens per agent call |
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

Limits: 256 KiB raw UTF-8 for either CLI source and canonical JSON for programmatic input; 256 rules; 1–256 UTF-16 code units per glob; 256 entries per sequence; answer depth 32. Inputs must be plain JSON data. Mock-enabled validation serves agent calls serially for deterministic FIFO sequence allocation; it is not a concurrency/load simulation, and the soft token gate may admit work differently than an unscripted concurrent dry run. Fixture values still flow into the script like real agent results, so author code can expose them via `log()` or its returned result—never store credentials or production data in fixtures.

Exit codes: `0` valid · `1` parse/static failure · `2` dry-run failure · `3` usage error. The report also lists every checkpoint with the mock reply (`default ?? true`) and warnings for backend approval, phase mismatch, `headless: "abort"`, and agent-less scripts. `headless: "pause"` dry-runs cleanly. A saved nested workflow still needs `--workflows-dir`.

Programmatic: `validateWorkflowScript(script, { args, workflows, dryRun, cwd, tokenBudget, maxAgents, timeoutMs, mockAnswers })` from `@automatalabs/workflows` returns the same report. Invalid workflow scripts resolve to reports; invalid `mockAnswers` supplied from untyped JavaScript throws `TypeError` before parsing.

## Harness config discovery — `agentprism-workflows config`

Validate's sibling: the same no-prompt config probe, standalone — no script required. Run it BEFORE authoring to read each harness's advertised, negotiable session surface (model ids including bracket variants, effort levels, modes, boolean knobs) instead of guessing values or writing a throwaway probe workflow.

```bash
npx @automatalabs/workflows config                  # every routable harness
npx @automatalabs/workflows config codex opencode   # only the named harnesses
npx @automatalabs/workflows config claude --json    # machine-readable report
```

Harness names are the routing names: built-in `claude` / `codex` / `opencode` / `pi` plus any custom backend registered via the `AGENTPRISM_BACKENDS` env var (registered customs also join the no-argument default set). Each harness opens one session without a prompt — zero tokens — and its catalog is read fresh; a harness that cannot spawn or authenticate reports `probed: false` with the reason and never blocks the others.

| flag | meaning |
|---|---|
| `--cwd <dir>` | session cwd for the probes (default: the current directory — harnesses may resolve project-level config, and hence their catalog, from it) |
| `--timeout-ms <n>` | per-harness probe bound (default 60000); a timed-out harness reports `probed:false` |
| `--json` | machine-readable `HarnessConfigReport` on stdout (`harnessOptions` uses the same per-harness shape as validate's report) |

Exit codes: `0` all probed · `1` at least one probe failed · `3` usage error.

Programmatic: `probeHarnessConfig({ harnesses, backends, cwd, timeoutMs })` from `@automatalabs/workflows` returns the same report (`backends` merges over `AGENTPRISM_BACKENDS` exactly like `createAcpRunner`); `formatHarnessConfigReport(report)` renders the human table.

## Workflow folders — `openWorkflowDir`

Hosts that keep versioned folders of workflow scripts serve them by name with:

```ts
import { openWorkflowDir, runDynamicWorkflow } from "@automatalabs/workflows";

const flows = openWorkflowDir("./workflows");   // or [projectDir, teamDir] — first hit wins; no I/O here
flows.list();                                    // [{ name, file, meta }] — fresh scan per call
const run = await runDynamicWorkflow("review-pr", { workflows: flows, args });
```

The filename stem is the name (`review-pr.workflow.js` ⇒ `review-pr`; `.workflow.js` beats `.js`). With the `workflows` option set, the first argument may be a name AND nested `workflow("<name>")` calls resolve from the same view (`flows.resolve` is a ready-made `loadSavedWorkflow` for hand-built `WorkflowManager`s). Every method reads the filesystem at call time — a git checkout/pull is picked up immediately — and resume stays safe because a run persists its script content. For script AUTHORS the takeaway is simply: `workflow("<name>")` works when the host serves a folder; keep names equal to filename stems.
