---
name: agentprism-workflow-authoring
description: Author, review, or debug AgentPrism workflow scripts — the `export const meta` + agent()/parallel()/pipeline() JavaScript DSL executed by @automatalabs/workflows (runDynamicWorkflow / WorkflowManager) and by the @automatalabs/mcp-server `workflow` tool. Use whenever writing or editing a workflow script. Covers routing each agent() call to a different ACP backend (Claude Code, Codex, OpenCode, or any custom ACP agent) within one script, structured outputs via JSON Schema, human checkpoints, token budgets, worktree isolation, and the resume-safe determinism rules.
---

# Writing AgentPrism workflow scripts

A workflow script is a small piece of plain JavaScript (passed around as a **string**, not a module) that orchestrates real, shipped coding agents. The engine runs the script in a deterministic sandboxed realm; every `agent()` call inside it fans out to an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) backend — Claude Code, OpenAI Codex, OpenCode, or any custom ACP agent server — which runs its own tool loop to completion and hands back the final text or a schema-validated object.

This guide is **backend-agnostic**: everything here works the same regardless of which agent serves a given call, and one script can freely mix backends per call. `reference.md` (same directory) holds the exhaustive option tables, routing grammar, and error codes.

## The mental model

- **The script is the orchestrator; agents are workers.** All control flow — loops, fan-out, dedup, aggregation, conditionals — lives in script code. Never ask an agent to "spawn subagents" or "coordinate the other agents"; agents cannot do that. Decompose in the script and give each agent one self-contained task.
- **Every `agent()` call is a fresh session with no memory.** Nothing carries over between calls — not files it read, not conclusions it reached. Thread everything the next agent needs into its prompt explicitly (interpolate prior results).
- **Agents are real coding agents, not chat completions.** They have file access, shells, and tools, rooted at the run's working directory. "Read the failing test and fix it" is a valid prompt; the agent will actually edit files.
- **The DSL primitives are realm globals, not imports.** There is nothing to `import` — `agent`, `parallel`, `pipeline`, `gate`, `checkpoint`, `args`, `budget`, … are injected. Top-level `await` and a top-level `return` are valid (the body runs inside an async wrapper). The script's return value becomes the run's `result`.
- **Scripts are plain JavaScript, not TypeScript.** Type annotations fail to parse. There are also no Node APIs in the realm (no `require`, `import`, `fs`, `fetch`, timers) — all side effects happen through agents.

## Minimal script

```js
export const meta = {
  name: "repo-summary",
  description: "Summarize what a repository does",
};

const summary = await agent(
  `Read the README and the package manifests under ${args.path}, then ` +
  `summarize what this project does in five sentences.`,
  { label: "summarize" },
);
return { summary };
```

Run it with the SDK —

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";
const run = await runDynamicWorkflow(script, { cwd: "/abs/project", args: { path: "." } });
// run.status: "completed" | "paused" | "failed" | "aborted"; run.result: the script's return value
// run.fallbacks / run.checkpointsTaken: optional result-only routing and checkpoint audit trails
```

— or pass the same script string to the `workflow` MCP tool served by `@automatalabs/mcp-server`. `args` arrives in the script as the `args` global; the run's base directory is the `cwd` global. Some hosts hand `args` through as a JSON **string** — a robust script tolerates both shapes (`typeof args === "string" ? JSON.parse(args) : args`) before reading knobs off it.

## The `meta` header

Every script must **begin** with `export const meta = {...}` as a plain object literal (no computed values — it is parsed from the source text before anything runs):

```js
export const meta = {
  name: "fix-flaky-tests",                        // required
  description: "Find flaky tests and fix them",   // required
  phases: [                                        // optional; one entry per phase() call
    { title: "Find", model: "opencode/zai/glm-5.2" },  // per-phase default model
    { title: "Fix" },
  ],
  model: "sonnet",                                 // optional run-wide default model
  backends: { /* optional custom ACP agents — see "Custom ACP backends" */ },
};
```

Per-agent model resolution order: explicit `agent({ model })` > `agent({ tier })` > the current phase's `model` > `meta.model` > the host session's default. So `meta.phases[].model` is how you give a whole phase a backend without repeating it on every call.

## Choosing the agent for each call

The backend is selected **per `agent()` call** from its `model` string. This is the core capability: one script can plan on one vendor's agent, implement on another's, and review on a third's, handing structured results between them.

- **Omit `model` entirely** for maximum portability — the call runs on whatever default backend the host configured (`AGENTPRISM_DEFAULT_BACKEND`, or the host's session model). A script with no model specs anywhere runs unchanged on any backend.
- **Name a model to route**: `opus`, `sonnet`, `haiku`, `claude`, `anthropic/…` → the Claude backend; `gpt-…`, `codex`, `o3`/`o4`, `openai/…` → the Codex backend; `opencode/<provider>/<model>` → OpenCode (the `opencode/` prefix is stripped, the rest selects the model — a bare `glm-5.2` does **not** route to OpenCode); a registered custom backend's name → that backend, with `name/<inner-model>` selecting a model from its catalog.
- **Bracket modifiers** tune backend-native knobs: `gpt-5.5[high]` sets reasoning effort; `[high fast]` also enables the backend's fast mode; `opencode/zai/glm-5.2[high]` maps to that agent's thought-level option.
- **`tier`** (`"small" | "medium" | "big"`) is a coarse alternative resolved from the host's tier config — use it when you want "a cheap model" without naming a vendor.

```js
const plan   = await agent(PLAN_PROMPT,          { label: "plan",      model: "opencode/zai/glm-5.2", schema: PLAN });
const impl   = await agent(implPrompt(plan),     { label: "implement", model: "gpt-5.5[high]" });
const review = await agent(reviewPrompt(impl),   { label: "review",    model: "opus", schema: REVIEW });
```

Two things worth designing for:

- **Cross-vendor independence.** Reviewing or verifying with a *different* vendor than the one that produced the work removes correlated blind spots — an agent family tends to approve its own idioms. When correctness matters, judge across vendors.
- **Fallback is observable, not fatal.** An unroutable or unavailable model spec logs a line (`model "…" unavailable — using the session default`) and the call proceeds on the default. The terminal result also records the live degrade in `fallbacks`; a typo'd model never throws.

## Structured output

Pass `schema` — a **plain JSON Schema object literal** (no schema builders exist inside the realm) — and the call resolves to a **validated object** instead of text:

```js
const FINDINGS = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "summary"],
        properties: {
          file:    { type: "string", description: "Repo-relative path — copy it exactly, never invent one" },
          line:    { type: "number", description: "1-indexed line the finding anchors to" },
          summary: { type: "string", description: "One sentence stating the defect, grounded in code you actually read" },
        },
      },
    },
  },
};

const report = await agent("Review the diff on this branch for correctness bugs.", {
  label: "review", schema: FINDINGS,
});
report.findings.forEach((f) => log(`${f.file}:${f.line} ${f.summary}`));
```

The same schema works on **every** backend; only the fulfillment channel differs, and the runner picks it for you: Claude uses its native `outputFormat`, Codex its strict `outputSchema`, and OpenCode / custom ACP agents either get a client-hosted `StructuredOutput` MCP tool injected into the session (when the agent advertises HTTP MCP support) or fall back to a prompt-embedded schema with the final message parsed as JSON. In every channel the runner validates the value client-side (with type coercion) and re-prompts a bounded number of times before failing the call with non-recoverable `SCHEMA_NONCOMPLIANCE`.

Schema authoring rules that keep all channels healthy:

- Root must be an object; set `additionalProperties: false` and list every property in `required`.
- Put a `description` on every field — descriptions are the per-field prompt, and they are the difference between grounded values and guesses.
- Keep schemas structurally simple. Exotic keywords (`oneOf`, `patternProperties`, unusual `format`s, backreference regexes) are normalized or stripped on the wire for some backends — validation still enforces them client-side, which shows up as re-prompt churn. Prefer `anyOf`, `enum`, and plain types.
- **Guard load-bearing fields against placeholders.** Agents under schema pressure sometimes emit `"TODO"`, `"unknown"`, or an invented path. Say "populate every field from evidence; never emit placeholder values" in the prompt, and check critical fields in script code (e.g. reject findings whose `file` doesn't appear in a known file list) before spending more agents on them.

## Fan-out: `parallel` and `pipeline`

```js
// parallel: an array of THUNKS (not promises!) run concurrently — a barrier that
// resolves in input order. A failed slot resolves to null; filter before use.
const sweeps = (await parallel([
  () => agent("Audit error handling in src/server", { label: "sweep:errors", schema: FINDINGS }),
  () => agent("Audit input validation in src/api",  { label: "sweep:input",  schema: FINDINGS }),
])).filter(Boolean);

// pipeline: each item flows through the stages independently — NO barrier between
// stages, so item A can be in stage 2 while item B is still in stage 1.
// Stages receive (previousResult, originalItem, index).
const verified = (await pipeline(
  sweeps.flatMap((s) => s.findings),
  (f) => agent(`Adversarially verify this finding — try to refute it:\n${JSON.stringify(f)}`,
               { label: `verify:${f.file}`, schema: VERDICT }),
  (verdict, f) => ({ ...f, real: verdict.real }),
)).filter(Boolean).filter((f) => f.real);
```

**Default to `pipeline`** for multi-stage work; use a `parallel` barrier only when the next stage genuinely needs *all* prior results at once (dedup across the full set, early-exit on a zero count, prompts that compare "the other findings"). Passing a promise instead of a thunk to `parallel` is a `TypeError` — wrap every call: `() => agent(...)`.

The host caps concurrent agents per run (default 8); hand `parallel`/`pipeline` as many items as the task needs and let the limiter schedule them. `workflow(nameOrScript, args)` nests another workflow inline (one level deep, sharing this run's budget and limiter) — inline script strings always work; saved names resolve when the host serves a workflows folder (`openWorkflowDir` / the `workflows` run option — see `reference.md`).

## Failure semantics — design for `null`

- A **recoverable** failure (timeout, empty output, transient execution error) is retried per the call's `retries` (default 0), then the call **resolves to `null`** — inside `parallel`/`pipeline` *and* as a bare `await agent(...)`. Null-check anything load-bearing, and set `retries: 1–2` on steps you can't afford to lose.
- A **non-recoverable** failure (schema never validated, script bug) throws and fails the run. You *may* `try/catch` around an `agent()` call to degrade gracefully — rethrow anything you can't meaningfully handle. In particular, **always rethrow pause-class errors** (`err.code === "PROVIDER_USAGE_LIMIT"` or `"AUTH_REQUIRED"`): they must propagate out of the script so the engine can pause the run resumably — swallowing one converts that pause into a fake, lossy completion.
- A **provider quota wall, missing backend authentication, or opted-in durable checkpoint pauses a managed run instead of failing it** — the journal checkpoints and the host can resume after the budget refills, authentication completes, or a checkpoint decision is supplied. Direct `runner.run()` calls still receive the `AUTH_REQUIRED` error because they have no manager lifecycle.
- Per-call knobs: `timeoutMs` (a step allowed to run long: `timeoutMs: null` disables the clock), `retries`.

## Built-in quality loops

These helpers spawn their own subagents (on the default model — hand-roll with `parallel` + `agent` when you want panel members on specific backends). Full signatures in `reference.md`.

| helper | shape | use for |
|---|---|---|
| `gate(produce, validate, { attempts })` | produce → validate → feed `feedback` back; return `{ ok, value, verdict, attempts }` | produce-until-a-reviewer-approves loops that need the final review evidence |
| `retry(thunk, { attempts, until })` | bounded retry until `until(result)` holds | flaky single steps |
| `verify(item, { reviewers, threshold, lens })` | N adversarial reviewers vote `real`/not | killing plausible-but-wrong findings |
| `judgePanel(attempts, { judges, rubric })` | score candidates 0–1 against a rubric, return the best | picking among independent solutions |
| `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` | repeat a round, dedup by `key`, stop when dry | unknown-size discovery (bugs, edge cases) |
| `completenessCheck(args, results)` | one critic lists what's still missing | a final "what did we not cover?" pass |

The `gate` pattern, spelled out — note how the producer thunk threads the validator's feedback into a *fresh* agent's prompt (sessions have no memory):

```js
const outcome = await gate(
  (feedback, attempt) => agent(
    `Implement the fix described here:\n${JSON.stringify(plan)}\n` +
    (feedback ? `\nA reviewer rejected attempt ${attempt}: ${feedback}\nAddress every point.` : ""),
    { label: `fix:${attempt + 1}`, model: "gpt-5.5" },
  ),
  (result) => agent(
    `Run the test suite and review this change summary:\n${result}\n` +
    `Return ok=true only if tests pass and the fix is correct; include the reviewed commit SHA.`,
    { label: "gate-review", model: "opus", schema: { type: "object", additionalProperties: false,
      required: ["ok"], properties: { ok: { type: "boolean" }, feedback: { type: "string" },
        commitSha: { type: "string" } } } },
  ),
  { attempts: 3 },
);
if (!outcome.ok) log(`reviewer never approved after ${outcome.attempts} attempts`);
else log(`reviewer approved commit ${outcome.verdict?.commitSha ?? "(unspecified)"}`);
```

## Human gates: `checkpoint()`

`checkpoint(promptText, options?)` is a zero-token, journaled human gate. With a live SDK `confirm` callback or MCP elicitation it waits for that reply; without a live channel, its default mode takes `default ?? true` immediately, so detached runs never hang.

```js
const proceed = await checkpoint(`Apply this plan?\n${JSON.stringify(plan, null, 2)}`, {
  kind: "confirm",          // "confirm" | "input" | "select"
  default: false,           // default headless mode takes this (or true)
  // headless: "abort",     // abort when no live human is attached
  // headless: "pause",     // or persist a resumable human-decision pause
});
if (!proceed) return { applied: false, plan };
```

`kind: "input"` resolves to free text, `kind: "select"` to one of `choices`. How the question reaches a human is the host's job (`ExecOptions.confirm` in the SDK; elicitation in the MCP server). With no live channel, `headless: "default"` (the default) takes `default ?? true`, `"abort"` aborts, and `"pause"` returns a managed run with `reason: "checkpoint_required"` plus non-secret `checkpointContext`. Resume the last mode with `checkpointReplies: { [context.callIndex]: decision }` or a live confirm; the answer is journaled and replayed. Put a checkpoint before anything hard to reverse — applying diffs, pushing, publishing.

## Budgets and phases

```js
phase("Explore", { budget: 100_000 });   // soft per-phase token sub-budget
// budget.total (null = unbounded) · budget.spent() · budget.remaining() (Infinity when unbounded)

const found = [];
while (budget.total && budget.remaining() > 50_000 && found.length < 20) {
  const r = await agent("Find one more edge case not in: " + JSON.stringify(found.map((f) => f.name)),
                        { label: `edge:${found.length}`, schema: EDGE });
  if (!r) break;
  found.push(r);
}
```

Guard budget-driven loops on `budget.total` being set — with no budget, `remaining()` is `Infinity` and only your own counters stop the loop. The run-level token budget and agent-count cap are hard: once exhausted, further `agent()` calls throw. `phase()` also groups agents in progress UIs and run logs; `log(msg)` (and `console.log`) append to the run log — narrate what matters, especially anything you drop or cap.

## Working directory, isolation, confinement

- Every agent session runs in the run's base `cwd` unless the call narrows it: `agent({ cwd: "packages/api" })` (relative resolves against the base).
- `isolation: "worktree"` runs the agent in a **throwaway git worktree** (`<repoRoot>/.agentprism/worktrees/…`) so parallel agents can edit without colliding. The worktree and its branch are **always deleted when the call ends — an isolated agent's file edits are discarded**. Have isolated agents *return their work as data* (a unified diff, a file map, a report) and apply it in a later non-isolated step; use worktrees for experiments, builds, and verification, not for persistent edits. Outside a git repo, isolation degrades to the shared tree with a logged notice.
- `mode` requests an agent-advertised ACP session mode and is **strict** — an unsupported mode fails the call rather than running unconfined. Mode ids are backend-specific (Claude-family: `plan`, `acceptEdits`, `bypassPermissions`; Codex-family: `read-only`, `agent`, `agent-full-access`; OpenCode via its mode option), so only set `mode` on calls whose `model` you also pin. Use read-only/plan modes for reviewers and auditors that must not write.
- `agentType: "<name>"` binds a reusable subagent definition — a Markdown file at `<cwd>/.agentprism/agents/<name>.md` (project) or `~/.agentprism/agents/<name>.md` (user; project wins) whose frontmatter sets tool allow/deny lists, a model, and isolation, and whose body is the role prompt. An unknown name logs a warning and degrades to defaults.

## Wiring tools and inputs into a call

- `mcpServers: [{ name, command, args: [], env: [] }]` attaches MCP servers to that agent's session — the portable way to hand any backend a capability (image generation, a browser, a ticket system). The agent sees the server's tools natively. Note `env` is a list of `{ name, value }` pairs (ACP shape), not an object map; HTTP/SSE servers use `{ type: "http", name, url, headers: [] }`.
- `images: [...]` appends base64 image blocks to the prompt (backends without image support receive a bracketed text note instead).
- `meta` / `promptMeta` pass generic ACP `_meta` through to `session/new` / `session/prompt` — the escape hatch for driving a custom agent's extension surface.
- `keepSession: true` keeps the agent's ACP session re-openable after the run: the re-attach record (sessionId, backend, cwd, reopen capabilities) lands in `WorkflowRunResult.agentSessions`, and the HOST can continue that agent's conversation later via `runner.loadSession()`. Scripts themselves never re-attach — hand the record to the host through the run result.

### Custom ACP backends

Any process that speaks ACP over stdio can serve `agent()` calls — an in-house browser-QA agent, an image generator, a domain-specific executor. Two ways in:

1. **Host-registered** (preferred): the embedder passes `createAcpRunner({ backends: { browser: { command: "/abs/browser-acp" } } })`; the script just routes with `model: "browser"`.
2. **Script-declared**: the script itself declares the backend in `meta.backends` — but declarations are **inert until the host approves them** (`allowScriptBackends` in the SDK; an elicitation in the MCP server), because they spawn commands on the host machine. Don't rely on them silently working.

```js
export const meta = {
  name: "checkout-qa",
  description: "Implement, then QA the checkout flow in a real browser",
  backends: {
    browser: { command: "browser-acp", args: ["--headless"] },  // requires host approval
  },
};

const change = await agent("Implement the coupon-code field per the spec in docs/coupon.md.",
                           { label: "implement" });              // default backend
const verdict = await agent(
  `Open the app, walk through checkout with coupon SAVE20, and verify the discount line. Change summary:\n${change}`,
  { label: "qa", model: "browser",                               // the custom agent
    schema: { type: "object", additionalProperties: false, required: ["passed"],
              properties: { passed: { type: "boolean" }, notes: { type: "string" } } } },
);
return { change, qa: verdict };
```

Structured output works on custom backends through the same injected-tool/fallback ladder as OpenCode — no special-casing in the script.

## Determinism and resume

Runs are journaled: every `agent()` and `checkpoint()` result is recorded under a deterministic call index, and a paused, killed, or failed run can resume by replaying the completed prefix from the journal at zero token cost.

> **Resume rule:** `args` changes don't invalidate the journal; prompt changes cache-miss from the first changed call.

- `Date.now()`, `Math.random()`, and no-arg `new Date()` throw inside the realm (`new Date(isoString)` is fine). Need a timestamp or random seed? Pass it through `args`.
- An `agent()` replay identity hashes the prompt, resolved `model`, `mode` when set, `tier`, `phase`, `agentType`, the resolved agent definition, and `schema`. The resolved definition covers its tool allowlist/denylist, model, isolation, and body prompt, so editing an agent definition invalidates calls that use it.
- `args` is not hashed directly. If new args only raise a loop cap, earlier calls with the same prompts and other identity fields replay. If new args change a prompt, model selection, phase, schema, call order, or another hashed field, the first affected call is a miss.
- Resume uses the longest unchanged prefix: the first changed or new call and every later call run live. This prevents an unchanged-looking downstream call from reusing a result produced from stale upstream state.
- `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` are not hashed. Changing one does not rerun a cached call; the new value affects only calls that run live. Change a hashed field, normally the prompt, when a call must execute again.
- Keep call order deterministic. Derive iteration from `args` and prior agent results, never from ambient state.

### Worked resume — raise a loop cap

The following workflow requires eight reviews but lets the caller cap how many are attempted in one run:

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

With the MCP `workflow` tool, run it first with `args: { "maxRounds": 6 }`. Then send the same script with `args: { "maxRounds": 8 }` and the first result's `runId` as `resumeFromRunId`. Rounds 1–6 replay for zero tokens and only rounds 7–8 run live because the cap controls call count but is not interpolated into the round prompt. If the prompt included `maxRounds`, round 1 would change and the whole eight-call suffix would run live.

- Narrate decisions and round summaries with `log()`, and give repeated calls stable, descriptive
  labels. MCP hosts can safely retrieve the latest log lines and compact results by label after a
  pause or failure; useful narration turns that inspection into a diagnosis instead of a guess.

When you run through MCP, always retain the returned `runId`. A paused, failed, or aborted response
already includes a redacted final-20 `logTail`; read it before changing the script. If the cause is
still unclear, call the same single `workflow` tool with
`{ action: "inspect", runId, lastN, labelGlob?, logLines }`. Inspection is read-only: use a narrow
label glob and latest-N tail to identify the last relevant work before deciding whether to resume,
edit, or stop. `resumeFromRunId` executes a new run; inspection does not.

Choose `background: true` for work that may outlive one MCP request. The start call returns exactly
`{ runId, status: "running" }` after durable admission; retain that new ID and normally collect with
20-second bounded calls: `{ action: "await", runId, waitMs: 20000 }`. A timeout is progress, not
failure: it returns the newest safe status and cumulative usage, so call await again. Use
`action:"inspect"` (or `waitMs:0`) when you need an immediate filtered diagnostic instead of waiting.
At terminal status await adds `outcome`, the foreground-equivalent authored result/pause context.
That outcome carries optional `fallbacks` and `checkpointsTaken`; inspect and the top-level await
status intentionally do not. `checkpointsTaken` identifies resolved live, headless-default,
journal-replay, and injected `checkpointReplies` decisions without repeating prompt text.

Background is detached from the initiating request, not from the MCP server process; a stdio child
exit can stop in-flight work. It has no progress token or live checkpoint elicitation, so authored
headless checkpoint modes apply. Resume only a paused durable journal: submit a new run with the
script, `resumeFromRunId`, and any `checkpointReplies`. That execution gets a new run ID and durably
inherits the complete replay prefix. Await and inspect are read-only and never resume anything.

## Worked example — cross-vendor build with every major primitive

```js
export const meta = {
  name: "feature-build",
  description: "Plan, gate on approval, implement, cross-vendor review, fix until green",
  phases: [{ title: "Plan" }, { title: "Implement" }, { title: "Review" }],
};

const PLAN = { type: "object", additionalProperties: false, required: ["steps", "risks"],
  properties: {
    steps: { type: "array", items: { type: "string", description: "One concrete implementation step" } },
    risks: { type: "array", items: { type: "string" } } } };
const VERDICT = { type: "object", additionalProperties: false, required: ["ok"],
  properties: { ok: { type: "boolean" },
                feedback: { type: "string", description: "Required when ok=false: concretely what to change" } } };

phase("Plan");
const plan = await agent(
  `Study this repo, then write an implementation plan for: ${args.feature}. Keep steps concrete.`,
  { label: "plan", model: "opencode/zai/glm-5.2", schema: PLAN },
);

const approved = await checkpoint(
  `Implement "${args.feature}" with this plan?\n- ${plan.steps.join("\n- ")}\nRisks: ${plan.risks.join("; ")}`,
  { kind: "confirm", default: true },
);
if (!approved) return { implemented: false, plan };

phase("Implement");
const outcome = await gate(
  (feedback, attempt) => agent(
    `Implement: ${args.feature}\nPlan:\n- ${plan.steps.join("\n- ")}\n` +
    `Run the project's tests before finishing and report results.` +
    (feedback ? `\n\nReviewer feedback on attempt ${attempt}:\n${feedback}\nAddress every point.` : ""),
    { label: `implement:${attempt + 1}`, model: "gpt-5.5[high]", retries: 1 },
  ),
  async (report) => {
    if (!report) return { ok: false, feedback: "implementation agent produced no result" };
    phase("Review");
    const reviews = (await parallel([   // two vendors, two lenses — independent eyes
      () => agent(`Review the working-tree diff for correctness. Implementer's report:\n${report}`,
                  { label: "review:correctness", model: "opus", schema: VERDICT }),
      () => agent(`Review the working-tree diff for regressions and missing tests. Report:\n${report}`,
                  { label: "review:coverage", model: "opencode/zai/glm-5.2", schema: VERDICT }),
    ])).filter(Boolean);
    const rejections = reviews.filter((r) => !r.ok);
    return rejections.length
      ? { ok: false, feedback: rejections.map((r) => r.feedback).join("\n"), reviews }
      : { ok: true, reviews };
  },
  { attempts: 3 },
);

return { implemented: outcome.ok, attempts: outcome.attempts, reviewVerdict: outcome.verdict, plan };
```

(The planner would ideally run read-only, but mode ids are backend-specific — this call routes to OpenCode, so it leaves `mode` unset rather than guessing; a Claude-routed planner could safely say `mode: "plan"`.)

## Worked example — fully backend-agnostic audit

No `model` anywhere: this script runs unchanged on whatever backend the host defaults to.

```js
export const meta = {
  name: "edge-case-audit",
  description: "Exhaustively hunt edge-case bugs in a target dir, verify each, report gaps",
  phases: [{ title: "Hunt" }, { title: "Verify" }],
};

const BUGS = { type: "object", additionalProperties: false, required: ["bugs"],
  properties: { bugs: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["file", "scenario"], properties: {
      file: { type: "string", description: "Repo-relative path you actually opened" },
      scenario: { type: "string", description: "Concrete input/state → wrong behavior" } } } } } };

phase("Hunt");
const seen = [];   // what earlier rounds reported, threaded into each new prompt
const candidates = await loopUntilDry({
  round: async (i) => {
    const r = await agent(
      `Round ${i + 1}: find edge-case bugs in ${args.target} not already in this list:\n` +
      JSON.stringify(seen) + `\nOnly report what you can ground in code you read.`,
      { label: `hunt:${i + 1}`, schema: BUGS },
    );
    const bugs = r ? r.bugs : [];
    seen.push(...bugs);
    return bugs;      // loopUntilDry dedups these by `key` across rounds
  },
  key: (b) => `${b.file}:${b.scenario}`,
  consecutiveEmpty: 2,
  maxRounds: 8,
});

phase("Verify");
const confirmed = (await pipeline(
  candidates,
  (bug) => verify(bug, { reviewers: 3, threshold: 0.66, lens: ["correctness", "reproducibility"] }),
  (v, bug) => (v.real ? bug : null),
)).filter(Boolean);

const gaps = await completenessCheck(args, confirmed);
log(`${confirmed.length}/${candidates.length} confirmed; complete=${gaps.complete}`);
return { confirmed, missing: gaps.missing ?? [] };
```

## Full-scale example scripts

When the inline examples above aren't enough, study the complete, validated scripts in [`examples/`](examples/) (same directory as this file):

- [`examples/repo-triage.workflow.js`](examples/repo-triage.workflow.js) — an autonomous, unattended cross-vendor repo triage and the broadest support-API tour: `pipeline` with no inter-stage barrier, a cross-vendor adversarial verification panel, `gate()` where writer and reviewer are always different vendors, nesting a saved workflow by name, `completenessCheck()`, budget headroom reservation, string-form `args` hardening, placeholder/path guards on schema outputs, and pause-class error rethrow.
- [`examples/quick-wins.workflow.js`](examples/quick-wins.workflow.js) — a small hunter that runs standalone *or* nested: `loopUntilDry()` with per-round vendor rotation, dedup threading via a `seen` list, and an in-round budget floor (nested runs share the parent's budget).

[`examples/README.md`](examples/README.md) maps each script to what it teaches.

## Validate before you run

The SDK ships a validator that costs **zero tokens** and spawns **no agent processes** — always run it on a script you just wrote or edited:

```bash
npx @automatalabs/workflows validate my-workflow.js --args '{"target":"src/"}'
```

It does two passes: a **static parse** (the `meta` literal, syntax, the determinism blocklist), then a **dry run** — the script executes for real in the engine's realm, but every `agent()` call is served by a mock backend that fabricates schema-conforming results. That catches the bugs a parse can't: thunks-vs-promises mistakes, reference errors, broken result plumbing between calls, schema shapes your own code then misreads. A mock live confirm answers checkpoints with `default ?? true`, so `headless: "pause"` dry-runs cleanly; `headless: "abort"` still warns because a truly unattended run would abort. Script-declared `meta.backends` are treated as approved, and the report lists every call with its backend attribution plus warnings (undeclared phases, `headless: "abort"` checkpoints, zero agent calls).

The default fabricator returns `true` for every boolean. Do not accept that all-true path as proof
that a convergence loop works: script its control labels with `--mock-answers` or a reusable
`--mock-answers-file`. Use a finite `$sequence` such as reject-then-approve so validation executes
the revision branch and proves the loop stops; the report identifies every consumed and unused
fixture without printing answer bodies.

Exit codes: `0` valid · `1` parse failure · `2` dry-run failure. Useful flags: `--parse-only`, `--token-budget <n>` (exercises `budget`-guarded paths; the mock reports 1000 tokens per call), `--args-file <path>`, `--json` (machine-readable report). Hosts can do the same programmatically via `validateWorkflowScript(script, opts)` from `@automatalabs/workflows`.

If the script nests saved workflows by name (`workflow("review-pr")`), pass the folder so names resolve — and the positional itself may then be a name: `npx @automatalabs/workflows validate review-pr --workflows-dir ./workflows`. A green dry run proves structure, not judgment — prompts and schemas still deserve review.

## Pre-flight checklist

- [ ] `export const meta = { name, description }` is the first statement, a pure literal.
- [ ] No `Date.now()` / `Math.random()` / no-arg `new Date()`; no imports, no Node APIs — timestamps and randomness come in through `args`.
- [ ] Every `parallel` element is a **thunk**; results are `.filter(Boolean)`-ed or null-checked.
- [ ] Every agent prompt is self-contained — prior results interpolated in, no "as discussed above".
- [ ] Schemas: object root, `additionalProperties: false`, everything `required`, `description` on every field; load-bearing fields checked for placeholders in script code.
- [ ] Model specs only where a specific backend earns its keep; verification crosses vendors when stakes are high; remember unroutable specs degrade silently to the default.
- [ ] `mode` only on calls with a pinned `model`; worktree-isolated agents return their work as data.
- [ ] `checkpoint()` before irreversible actions, with a sane headless `default` or an intentional `headless: "pause"` durable hand-off.
- [ ] Budget loops guard on `budget.total`; caps and drops are `log()`-ed, not silent.
- [ ] `return` a compact, structured result — it is the run's `result`, not a transcript.
- [ ] Boolean-controlled convergence branches are scripted with mock answers (including reject-then-approve), not left to the all-true default.
- [ ] `npx @automatalabs/workflows validate <file> --args '<json>'` exits 0 with no surprising warnings.

For the complete `agent()` option table, model-routing grammar, checkpoint options, error codes, `meta.backends` config fields, and how hosts run scripts, read [`reference.md`](reference.md).
