---
name: agentprism-workflow-authoring
description: Author, review, or debug AgentPrism workflow scripts — the `export const meta` + agent()/parallel()/pipeline() JavaScript DSL executed by @automatalabs/workflows (runDynamicWorkflow / WorkflowManager) and by the @automatalabs/mcp-server `workflow` tool. Use whenever writing or editing a workflow script. Covers routing each agent() call to a different ACP backend (Claude Code, Codex, OpenCode, pi, or any custom ACP agent) within one script, structured outputs via JSON Schema, human checkpoints, token budgets, worktree isolation, and the resume-safe determinism rules.
---

# Writing AgentPrism workflow scripts

A workflow script is a small piece of plain JavaScript (passed around as a **string**, not a module) that orchestrates real, shipped coding agents. The engine runs the script in a deterministic sandboxed realm; every `agent()` call inside it fans out to an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) backend — Claude Code, OpenAI Codex, OpenCode, pi, or any custom ACP agent server — which runs its own tool loop to completion and hands back the final text or a schema-validated object.

This guide is **backend-agnostic**: everything here works the same regardless of which agent serves a given call, and one script can freely mix backends per call. `reference.md` (same directory) holds the exhaustive option tables, routing grammar, and error codes.

## The guide, by task

<!-- guide-index:begin -->
Read the section your task needs — each is a separate document in this skill directory:

1. **[MCP Server Setup](mcp-server-setup.md)** — how workflows actually run: registering `@automatalabs/mcp-server`, the `workflow` tool's run/await/inspect/stop actions, background runs, `script` vs `scriptPath`, the `args`/`cwd` globals, and the operational rules (runId retention, un-hashed recovery knobs).
2. **[Start from the user's outcome](source-contract.md)** — the source contract: carrying the user's verbatim request, hop-zero anchoring, diffing prompts against the source, and serving the implicit bar. Read this before composing anything.
3. **[Choosing agents and structured output](models-and-output.md)** — per-call model routing, `configOptions`, cross-vendor independence, and schema-validated outputs across every backend.
4. **[Composition and failure design](composition-and-failure.md)** — the `meta` header, `pipeline` vs `parallel` by information dependency, null semantics, STOP-and-report, provider failure as an expected path, budgets and phases.
5. **[Gates and lenses](gates-and-lenses.md)** — the built-in quality loops, and the discipline for review gates: falsifiable lens questions, evidence generation, terminal adjudication, the panel-free closed-list fix round, and human `checkpoint()` gates.
6. **[Execution environment and tools](environment-and-tools.md)** — working directories, worktree isolation, confinement modes, attaching MCP servers/images/meta to a call, and custom ACP backends.
7. **[Determinism and resume](determinism-and-resume.md)** — the replay contract: what is identity-hashed, content-addressed resume, continuation of interrupted calls, and the worked resume example.
8. **[Long-running implementation trains](long-running-trains.md)** — the hard-won rules for multi-hour workflows racing a moving repository: base pins, fresh-clone re-verification, design artifacts outside the worktree, report/HEAD discipline.
9. **[Worked examples and validation](examples-and-validation.md)** — two complete inline examples, the full-scale scripts in `examples/`, and the zero-token validator workflow.
<!-- guide-index:end -->

## The mental model

- **The script is the orchestrator; agents are workers.** All control flow — loops, fan-out, dedup, aggregation, conditionals — lives in script code. Never ask an agent to "spawn subagents" or "coordinate the other agents"; agents cannot do that. Decompose in the script and give each agent one self-contained task.
- **Treat agent calls as memoryless orchestration boundaries.** Ordinary calls open fresh sessions, so thread everything a later call needs into its prompt explicitly. The sole automatic exception is recovery of the *same* usage/auth-interrupted occurrence: an unchanged, eligible resume may reopen that recorded session to finish its unfinished turn; it never gives a different call ambient memory.
- **Agents are real coding agents, not chat completions.** They have file access, shells, and tools, rooted at the run's working directory. "Read the failing test and fix it" is a valid prompt; the agent will actually edit files.
- **The DSL primitives are realm globals, not imports.** There is nothing to `import` — `agent`, `parallel`, `pipeline`, `gate`, `checkpoint`, `args`, `budget`, … are injected. Top-level `await` and a top-level `return` are valid (the body runs inside an async wrapper). The script's return value becomes the run's `result`.
- **Assume every agent is brilliant, amnesiac, overconfident, and racing a world that changed since its prompt was written.** Every load-bearing pattern in this guide — self-contained prompts, evidence-demanding schemas, pinned bases re-checked every round, refusal as a first-class outcome — follows from those four facts. The script, not the agents, is responsible for compensating for them.
- **Scripts are plain JavaScript, not TypeScript.** Type annotations fail to parse. There are also no Node APIs in the realm (no `require`, `import`, `fs`, `fetch`, timers) — all side effects happen through agents.
- **Live observability requires no script annotations.** Journaling ACP runs publish coarse,
  redacted progress and execution-partitioned transcript upserts at
  `workflow://runs/{runId}/events`; MCP clients subscribe for update hints and page the durable
  cursor. Author labels for human correlation, not to enable this behavior.

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

Running scripts happens through the MCP server's `workflow` tool — server setup, the run/inspect/await/stop actions, and the `args`/`cwd` globals a running script receives are covered in **MCP Server Setup** ([mcp-server-setup.md](mcp-server-setup.md)).

## Pre-flight checklist

- [ ] `export const meta = { name, description }` is the first statement, a pure literal.
- [ ] No `Date.now()` / `Math.random()` / no-arg `new Date()` / `Date()`; no imports, no Node APIs — timestamps and randomness come in through `args`.
- [ ] Every `parallel` element is a **thunk**; results are `.filter(Boolean)`-ed or null-checked.
- [ ] Every agent prompt is self-contained — prior results interpolated in, no "as discussed above".
- [ ] Schemas: object root, `additionalProperties: false`, everything `required`, `description` on every field; load-bearing fields checked for placeholders in script code.
- [ ] Model specs only where a specific backend earns its keep; use a registered prefix plus a live-catalog-verified id (or backend-only form), and expect harness rejection rather than client fallback.
- [ ] Model ids and effort values were read from `npx @automatalabs/workflows config` (or a validator report), not recalled from memory.
- [ ] Every `configOptions` id/value comes from the selected model's advertised-options table; `"model"` stays in the dedicated field, and any ordered thought-level clamp warning is intentional.
- [ ] `mode` only on calls with a pinned `model`; worktree-isolated agents return their work as data.
- [ ] Every `resume: { filesystem: "read-only" }` assertion is true for all persistent/ambient effects; unordered parallel siblings do not communicate through files, and worktree calls do not commit or mutate outside the throwaway checkout.
- [ ] `checkpoint()` before irreversible actions, with a sane headless `default` or an intentional `headless: "pause"` durable hand-off.
- [ ] New-run `checkpointReplies` use source `checkpointContext.callIndex` keys; changed checkpoint defaults/headless modes/timeouts are expected to run fresh.
- [ ] Budget loops guard on `budget.total`; caps and drops are `log()`-ed, not silent.
- [ ] `return` a compact, structured result — it is the run's `result`, not a transcript.
- [ ] Boolean-controlled convergence branches are scripted with mock answers (including reject-then-approve), not left to the all-true default.
- [ ] The user's verbatim request sentences travel with the run (`args.sourceRequest` / a focus file), your prompts were diffed against them, and every genuine ambiguity became a question to the user — not a silent scope decision.
- [ ] Producer reports have a refusal shape (STOP-and-report) and the checker recognizes it; report-shape validation runs in script code before any reviewer is spawned.
- [ ] Every reviewer charge is one falsifiable question with an evidence field capped in size; full detail goes to design-dir files outside the worktree.
- [ ] Gates are bounded, a terminal adjudicator is designed in, and its findings feed a panel-free fix round — no unaddressed final-round blockers, no unbounded convergence hopes.
- [ ] `npx @automatalabs/workflows validate <file> --args '<json>'` exits 0 with no surprising warnings.

For the complete `agent()` option table, model-routing grammar, checkpoint options, error codes, `meta.backends` config fields, and how hosts run scripts, read [`reference.md`](reference.md).
