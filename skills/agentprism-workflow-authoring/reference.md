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
| `configOptions` | `Record<string, string \| boolean>` | Exact ACP session option ids and authored values. Applied in ascending id order after model and before the prompt, with no aliases or coercion. `"model"` is reserved for the dedicated `model` field. Part of the resume hash only when non-empty, with sorted keys. Run validation and read the advertised-options table before choosing values. |
| `agentType` | `string` | Bind a named subagent definition (tools allow/deny, model, isolation, role prompt). See [agentType definitions](#agenttype-definitions). Part of the resume hash. |
| `isolation` | `"worktree"` | Run in a throwaway git worktree branched from the run cwd. **Always removed (worktree + branch) when the call ends** — edits are discarded; return work as data. Degrades to the shared tree outside a git repo (logged). |
| `cwd` | `string` | Per-session working directory; relative resolves against the run's base cwd. Overridden by worktree isolation. Not hashed. |
| `timeoutMs` | `number \| null` | Per-call timeout; `null` disables. Defaults to the host's per-agent timeout (none unless configured). |
| `retries` | `number` | Retries after *recoverable* failures (default 0, host-overridable). Exhausted retries ⇒ the call resolves `null`. |
| `mcpServers` | `McpServerConfig[]` | MCP servers attached to this session. Stdio shape: `{ name, command, args: [], env: [{ name, value }] }` (`args`/`env` required, `env` is name/value pairs, not a map); `{ type: "http" \| "sse", name, url, headers: [] }` also accepted. Not hashed. |
| `images` | `PromptImage[]` | Base64 image blocks appended to the prompt; backends without image support get a bracketed text note. Not hashed. |
| `meta` | `object` | ACP `_meta` merged into `session/new` — session-scoped extension passthrough (pairs with custom backends). Not hashed. |
| `promptMeta` | `object` | ACP `_meta` merged into `session/prompt` — turn-scoped passthrough. Backend-computed keys win on conflict. Not hashed. |
| `keepSession` | `boolean` | Skip release-time best-effort `session/close`; the non-secret re-attach record lands in `WorkflowRunResult.agentSessions` for host-side `loadSession()` / `resumeSession()`. Not hashed. |

## Model specs & routing

A `model` string is resolved solely from its first segment, then delegated to the harness:

| spec shape | routes to | notes |
|---|---|---|
| *(omitted)* | host default backend | `AGENTPRISM_DEFAULT_BACKEND` (`claude` \| `codex` \| `opencode` \| custom name; default `claude`), session default model. Most portable. |
| `claude`, `codex`, `opencode`, or `<custom-name>` | that registered harness | Backend-only: no model config call; the harness default remains active. |
| `claude/<id>`, `codex/<id>`, `opencode/<id>`, or `<custom-name>/<id>` | that registered harness | Match the first segment ASCII-case-insensitively and strip exactly one segment. Custom names take priority on collision. The remaining `<id>` is sent verbatim, including further `/` characters. |
| any other string, including `anthropic/…`, `openai/…`, bare `opus`, or bare `gpt-…` | host default backend | The **entire** authored string is sent verbatim; these are not routing aliases. |

Selection is a single `session/set_config_option` with `configId: "model"` and the exact remaining string. There is no catalog matching, case folding, normalization, bracket parsing, nearest-neighbor selection, sibling effort/Fast option driving, retry, or echo verification. Brackets, dots, and provider-style prefixes are ordinary model-id characters. Live-catalog-verified examples are `claude/opus[1m]`, `codex/gpt-5.6-sol`, and `opencode/zai/glm-5.2`; prefer backend-only forms for harness-configured models.

Whatever the harness returns is the outcome. A rejection follows the existing agent-error path with no resolution-specific code or fallback event. `onModelFallback` and `WorkflowRunResult.fallbacks` remain public compatibility surfaces, but model resolution does not emit them.

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
session. The catalog varies by harness version, login, and machine, so run the validator every
time and read its advertised config options before picking an id or select value.

## Structured output channels

One author API (`schema`), three fulfillment paths — chosen automatically per backend:

| backend | channel |
|---|---|
| Claude | native `outputFormat`, schema normalized to Anthropic's structured-outputs subset (e.g. `oneOf` → `anyOf`; unsupported keywords/formats stripped on the wire) |
| Codex | native strict `outputSchema` (OpenAI strict subset normalization) |
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

The host supplies the live human channel (`ExecOptions.confirm` in the SDK; elicitation in the MCP server), and that channel wins even when `headless: "pause"` is declared. A durable pause carries non-secret `checkpointContext`; resume with `ExecOptions.checkpointReplies: { [context.callIndex]: decision }` or attach a live channel. The decision is injected into the journal and replays on later resumes. Detached runs never pause for a checkpoint unless the author opts into `"pause"`.

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

> **Resume rule:** `args` changes don't invalidate the journal; prompt changes cache-miss from the first changed call.

- Direct calls that break deterministic replay fail static validation: `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()`. The realm also blocks aliased or computed forms at runtime. `new Date(value)` works. There is no `require`, `import`, Node API, or network API in the realm.
- Each `agent()` result is journaled under a monotonic call index and a SHA-256 identity hash. The canonical identity fields, in order, are `prompt`, resolved `model`, `mode` only when set, `configOptions` only when non-empty, `tier`, `phase`, `agentType`, resolved `agentDef`, and `schema`. Config-option keys are sorted before serialization. Missing fields other than `mode` and `configOptions` serialize as `null`; an unset `mode` and an unset/empty `configOptions` key are omitted for compatibility with older journals.
- `agentDef` is the resolved definition's tools, disallowed tools, model, isolation, and body prompt. Changing a named definition therefore invalidates its call even when the `agentType` name is unchanged.
- `args` is exposed to the script but is not directly included in the call hash. An args change cache-misses only when evaluating the script produces a changed hashed field, changed call order, or a new call.
- Resume replays the longest unchanged prefix as cache hits with zero agent tokens. The first changed/new call and every call after it run live. `retry` and `gate` chains naturally cascade because a later attempt's prompt usually includes the preceding live result.
- The additive options `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` are not hashed. A changed value affects only a live call; it does not invalidate or modify a replayed result.
- `checkpoint()` uses the same monotonic call sequence and hashes its prompt, normalized kind, and choices. Real or synthetic `checkpointReplies` decisions are journaled and replay instead of being requested again.

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
      { label: `review:${i + 1}`, phase: "Review" },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
```

The first MCP request uses `{ "args": { "maxRounds": 6 } }` and returns a failed run with a persisted six-entry journal. The next request sends the same `script`, `{ "args": { "maxRounds": 8 } }`, and the returned run ID as `resumeFromRunId`. Calls 0–5 replay for zero tokens; calls 6–7 are new and run live. This changed-args pattern is specific to entry points that accept new args together with a hydrated journal. The MCP `workflow` tool does. `WorkflowManager.resume(runId)` instead reloads the persisted original script and args; an SDK caller that needs changed args uses `runSync(script, newArgs, { resumeJournal })`.

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
    checkpointReplies: { 2: true },        // resume-only durable checkpoint answers by call index
    onProgress: (snapshot) => {},
  },
});
// run.status: "completed" | "paused" | "failed" | "aborted"
// run.result · run.runId (resume handle) · run.tokenUsage · run.logs · run.phases
// run.fallbacks? (compatibility) · run.checkpointsTaken? (absent when empty)
```

The MCP route (`npx @automatalabs/mcp-server`, tool name `workflow`) accepts **raw script source** + `args`. Foreground is the default and streams progress/resolves checkpoints live; long work uses `background:true` plus bounded `action:"await"`. It supports `resumeFromRunId`, and non-elicitation clients resume `headless: "pause"` checkpoints with `checkpointReplies` from terminal `outcome.checkpointContext`. Unlike the SDK's `openWorkflowDir` path, this input does not resolve a saved workflow name. The `workflow` tool is the server's whole tool surface — run/resume/inspect/await are action branches, not separate tools. A run that pauses with `reason: "auth_required"` resumes via a new run after the backend's own CLI is logged in out-of-band (see below). Prompt-capable MCP hosts (e.g. Claude Code, where it surfaces as a slash command) also get this entire guide from the server itself as the **`author-workflow`** prompt, with an optional `task` argument. Environment knobs shared by both: `AGENTPRISM_DEFAULT_BACKEND`, `AGENTPRISM_ACP_POOL_SIZE` (schema-run parallelism on OpenCode/custom backends scales with the pool, one injected-tool registry per process), `AGENTPRISM_BACKENDS`, `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, `AGENTPRISM_PERSISTENCE_ROOT`, plus per-backend `*_CMD`/`_ARGS`/`_BIN` overrides.

Exact detached host types:

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
}

interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate";
}

interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowAwaitMetadata;
  tokenUsage?: TokenUsage;
  outcome?: WorkflowExecutionToolResult<T>; // present exactly when lifecycle is terminal
}
```

`WorkflowRunResult.fallbacks?: WorkflowRunFallback[]` retains the compatibility shape
`{ callIndex, label, phase?, requestedSpec, resolvedModel?, backendId?, kind, message }`; the model
resolution pipeline no longer produces entries.
`WorkflowRunResult.checkpointsTaken?: WorkflowCheckpointTaken[]` records resolved checkpoints as
`{ callIndex, kind, decision, source }`, where source is `live`, `headless-default`,
`journal-replay`, or `injected`. A paused checkpoint is not resolved. Both fields are persisted and
appear in foreground results plus terminal await `outcome`; neither appears on `WorkflowRunStatus`.

At most four background runs may be active or starting per server instance. Foreground, inspect,
and await consume no slot. A timeout returns the freshest status and partial cumulative usage; replay
hits cost/add zero. Terminal results have no MCP TTL and are reconstructed after restart while the
project run record remains readable. The inherited status fields stay redacted/bounded at 24,576
structured bytes and 8,192 text bytes. Terminal `outcome` preserves the raw authored result/full
logs and has no new total cap, but it is never copied into text.

Background has no request signal, progress token, or live checkpoint channel. Headless checkpoint
default continues, abort fails with `WORKFLOW_ABORTED`, and pause returns `checkpoint_required` plus
`outcome.checkpointContext`. Auth pauses return non-secret `outcome.authContext`; log the backend CLI
in before resume. Background is process-lifetime, not daemon execution: process death can interrupt
an in-flight call, and stale durable `running` state recovers to `paused`.

`action:"await"` and `action:"inspect"` are read-only: they never replay the script, spend tokens,
or acquire the run lease. `resumeFromRunId` executes a new run with the caller's current script/args
and a new run ID. Every resumed background run durably seeds its inherited prefix (including a
synthetic checkpoint answer) beneath that new ID before acknowledgement, so later resume hops remain
self-contained.

Retain the run ID and inspect halted runs before guessing. The exact inspection input is:

```ts
interface WorkflowInspectToolInput {
  action: "inspect";
  runId: string;       // /^[a-z0-9]+-[a-z0-9]+$/, at most 128 characters
  lastN?: number;      // default 20; integer 1..50
  labelGlob?: string;  // non-empty; at most 128 Unicode code points
  logLines?: number;   // default 20; integer 0..50
  script?: never;
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
UTF-8 bytes, structured JSON at 24,576 bytes, and inspection text at 8,192 bytes. An unknown ID is
a tool error with no structured content; reading an existing failed run succeeds and reports
`status:"failed"`. Every paused, failed, or aborted execution result also carries a redacted
final-20 `logTail` (present when empty) and renders it in the immediate terminal text. Completed
execution results omit that extra field while retaining their full `logs` array.

Backend auth comes from the machine the host runs on: Claude via a logged-in Claude Code install or `ANTHROPIC_API_KEY`; Codex via `~/.codex/auth.json`; OpenCode via `opencode auth login` (its CLI must be installed — it is not bundled). A script only needs auth for the backends it actually routes to.

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

## Workflow folders — `openWorkflowDir`

Hosts that keep versioned folders of workflow scripts serve them by name with:

```ts
import { openWorkflowDir, runDynamicWorkflow } from "@automatalabs/workflows";

const flows = openWorkflowDir("./workflows");   // or [projectDir, teamDir] — first hit wins; no I/O here
flows.list();                                    // [{ name, file, meta }] — fresh scan per call
const run = await runDynamicWorkflow("review-pr", { workflows: flows, args });
```

The filename stem is the name (`review-pr.workflow.js` ⇒ `review-pr`; `.workflow.js` beats `.js`). With the `workflows` option set, the first argument may be a name AND nested `workflow("<name>")` calls resolve from the same view (`flows.resolve` is a ready-made `loadSavedWorkflow` for hand-built `WorkflowManager`s). Every method reads the filesystem at call time — a git checkout/pull is picked up immediately — and resume stays safe because a run persists its script content. For script AUTHORS the takeaway is simply: `workflow("<name>")` works when the host serves a folder; keep names equal to filename stems.
