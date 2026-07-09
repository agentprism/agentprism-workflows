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
| `model` | `string` | Model spec; selects the backend **and** the model. See [Model specs & routing](#model-specs--routing). Part of the resume hash. |
| `tier` | `"small" \| "medium" \| "big"` | Coarse tier resolved from host config; beats phase/meta model, loses to explicit `model`. Part of the resume hash. |
| `mode` | `string` | ACP session mode id advertised by the selected backend. **Strict**: unsupported/unadvertised ids fail the call (never silently unconfined). Claude-family: `default`, `plan`, `acceptEdits`, `bypassPermissions`. Codex-family: `read-only`, `agent`, `agent-full-access`. OpenCode: its mode config option. Part of the resume hash when set. |
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

A `model` string selects the backend, then the concrete model within it:

| spec shape | routes to | notes |
|---|---|---|
| *(omitted)* | host default backend | `AGENTPRISM_DEFAULT_BACKEND` (`claude` \| `codex` \| `opencode` \| custom name; default `claude`), session default model. Most portable. |
| `claude`, `opus`, `sonnet`, `haiku`, `anthropic/…`, `claude/…` | Claude backend | Provider prefixes pass through whole. |
| `codex`, `gpt-…`, `openai/…`, `o3`/`o4`-style ids | Codex backend | |
| `opencode` or `opencode/<provider>/<model>` | OpenCode backend | Prefix is stripped before model selection: `opencode/zai/glm-5.2` selects `zai/glm-5.2`. A bare `glm-5.2` does **not** route to OpenCode. |
| `<custom-name>` or `<custom-name>/<inner-model>` | that registered custom backend | Names are case-insensitive; `claude`/`codex`/`opencode` are reserved. Registered names win over pattern matches. |

**Bracket modifiers** (trailing `[…]`): `gpt-5.5[high]` sets reasoning effort; `[high fast]` also enables the backend's fast mode; on OpenCode/custom backends the effort word maps to a thought-level/effort config option when one exists.

**Fallback is observable, never fatal**: an unmatched model or modifier logs `<label>: model "<spec>" unavailable — using the session default` to the run log and proceeds on the session default.

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
gate(thunk, validator, { attempts = 3 })   → { ok, value, attempts }
    // thunk(feedback, attempt); validator(result) → { ok, feedback? } (may be async / an agent call)
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

`verify`, `judgePanel`, and `completenessCheck` spawn their subagents on the run's default model — hand-roll with `parallel` + `agent` to pin panel members to specific backends.

## `checkpoint()` options

| option | type | meaning |
|---|---|---|
| `kind` | `"confirm" \| "input" \| "select"` | Reply shape: boolean-ish / free text / one of `choices`. Affects the journal hash and the host UI widget. |
| `choices` | `string[]` | For `kind: "select"`. |
| `default` | `unknown` | Reply taken when no human is attached (headless) — journaled like a real reply. Defaults to `true`. |
| `headless` | `"default" \| "abort"` | `"abort"` throws instead of taking the default when no human is attached. |
| `timeoutMs` | `number` | Deadline for the interactive prompt. |

The host supplies the human channel (`ExecOptions.confirm` in the SDK; elicitation in the MCP server). Replies replay from the journal on resume.

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
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, bad `meta.backends` shape). |
| `SCRIPT_ERROR` | no | The script itself crashed (uncaught throw, floated rejection). |
| `WORKFLOW_ABORTED` | — | Real cancellation (pause/stop/host signal) — never used for crashes. |

`loopUntilDry` absorbs `TOKEN_BUDGET_EXHAUSTED` / `AGENT_LIMIT_EXCEEDED` from its rounds and returns the partial result; everywhere else those propagate.

## Determinism & the resume journal

- Banned in the realm (they throw): `Date.now()`, `Math.random()`, no-arg `new Date()` / `Date()`. `new Date(value)` works. No `require`/`import`, no Node or network APIs — the realm is a determinism boundary, not a security sandbox.
- Each `agent()` call journals its result under a monotonic call index plus an identity hash of `prompt + model + mode-when-set + tier + phase + agentType + agent-definition + schema`.
- Resume replays the **longest unchanged prefix** as cache hits (zero tokens); the first changed/new call and everything after runs live. `retry`/`gate` chains cache-miss-cascade on resume by design (attempt N+1's prompt embeds attempt N's live result).
- Additive options are **not** hashed and can differ across resumes: `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, `keepSession`.
- `checkpoint()` replies are journaled and replay on resume instead of re-asking.

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
model: opus                      # any model spec; agent({ model }) overrides it
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
    confirm: async (text, opts) => true,   // resolves checkpoint(); omit = headless defaults
    onProgress: (snapshot) => {},
  },
});
// run.status: "completed" | "paused" | "failed" | "aborted"
// run.result · run.runId (resume handle) · run.tokenUsage · run.logs · run.phases
```

The MCP route (`npx @automatalabs/mcp-server`, tool name `workflow`) accepts **raw script source** + `args`, streams progress, resolves checkpoints via MCP elicitation, and supports `resumeFromRunId`; unlike the SDK's `openWorkflowDir` path, this input does not resolve a saved workflow name. With the default ACP runner it also registers `workflow_auth_status` and `workflow_authenticate` for authentication pause-and-resume. `AGENTPRISM_MCP_INLINE_AUTH=1` opts into masked elicitation for headlessly collectable methods. Environment knobs shared by both: `AGENTPRISM_DEFAULT_BACKEND`, `AGENTPRISM_ACP_POOL_SIZE` (schema-run parallelism on OpenCode/custom backends scales with the pool, one injected-tool registry per process), `AGENTPRISM_BACKENDS`, `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, `AGENTPRISM_PERSISTENCE_ROOT`, plus per-backend `*_CMD`/`_ARGS`/`_BIN` overrides.

Backend auth comes from the machine the host runs on: Claude via a logged-in Claude Code install or `ANTHROPIC_API_KEY`; Codex via `~/.codex/auth.json`; OpenCode via `opencode auth login` (its CLI must be installed — it is not bundled). A script only needs auth for the backends it actually routes to.

## The validator — `agentprism-workflows validate`

```bash
npx @automatalabs/workflows validate <workflow-file> [options]
```

Zero tokens, no ACP processes: a static parse (meta literal, syntax, determinism blocklist) plus a dry run in the real engine realm against a mock `AgentRunner` that fabricates schema-conforming results (`enum[0]`, `true` booleans so ok-gates terminate, `mock-<field>` strings, one array item). No auth is needed to validate.

| flag | meaning |
|---|---|
| `--args <json>` / `--args-file <path>` | the script's `args` global for the dry run |
| `--workflows-dir <dir>` | repeatable; a folder of workflow scripts (name = filename stem). Lets the positional be a NAME and resolves nested `workflow("<name>")` calls |
| `--parse-only` | static parse only |
| `--cwd <dir>` | dry-run base cwd (default: throwaway temp dir, so `isolation: "worktree"` no-ops; a real repo cwd creates and cleans up real worktrees) |
| `--token-budget <n>` | sets `budget.total`; the mock reports 1000 tokens per agent call |
| `--max-agents <n>` | cap on dry-run agent calls |
| `--timeout-ms <n>` | dry-run wall-clock limit (default 30000) |
| `--json` | machine-readable `ValidateWorkflowReport` on stdout |

Exit codes: `0` valid · `1` parse/static failure · `2` dry-run failure · `3` usage error. The report lists every agent call (label, phase, model spec, backend attribution, schema flag), every checkpoint with the default reply the dry run took, and warnings: script-declared backends (approval reminder), declared-but-unused / used-but-undeclared phases, `headless: "abort"` checkpoints, agent-less scripts. Checkpoints resolve exactly like a headless run (`default ?? true`). Limits: `workflow("<saved-name>")` fails without `--workflows-dir` (the report warns and names the fix); the mock's all-success answers can't exercise failure-handling branches — `null`-path handling still needs your own reading.

Programmatic: `validateWorkflowScript(script, { args, workflows, dryRun, cwd, tokenBudget, maxAgents, timeoutMs })` from `@automatalabs/workflows` returns the same report object and never throws for an invalid script.

## Workflow folders — `openWorkflowDir`

Hosts that keep versioned folders of workflow scripts serve them by name with:

```ts
import { openWorkflowDir, runDynamicWorkflow } from "@automatalabs/workflows";

const flows = openWorkflowDir("./workflows");   // or [projectDir, teamDir] — first hit wins; no I/O here
flows.list();                                    // [{ name, file, meta }] — fresh scan per call
const run = await runDynamicWorkflow("review-pr", { workflows: flows, args });
```

The filename stem is the name (`review-pr.workflow.js` ⇒ `review-pr`; `.workflow.js` beats `.js`). With the `workflows` option set, the first argument may be a name AND nested `workflow("<name>")` calls resolve from the same view (`flows.resolve` is a ready-made `loadSavedWorkflow` for hand-built `WorkflowManager`s). Every method reads the filesystem at call time — a git checkout/pull is picked up immediately — and resume stays safe because a run persists its script content. For script AUTHORS the takeaway is simply: `workflow("<name>")` works when the host serves a folder; keep names equal to filename stems.
