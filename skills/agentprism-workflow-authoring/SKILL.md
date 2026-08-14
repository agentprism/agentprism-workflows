---
name: agentprism-workflow-authoring
description: Write and run AgentPrism workflow scripts — the `export const meta` + agent()/parallel()/pipeline() JavaScript DSL executed by @automatalabs/workflows and by the @automatalabs/mcp-server `workflow` tool. Use when writing or editing a workflow script, or when running one through the MCP `workflow` tool. Covers the script API, per-call routing to ACP backends (Claude Code, Codex, OpenCode, pi, custom agents), structured outputs via JSON Schema, human checkpoints, worktree isolation, the resume rules, and run operations (run, await, inspect, stop, execution logs).
---

# Writing AgentPrism workflow scripts

A workflow script is plain JavaScript, passed around as a **string**, not a module. The engine runs it in a deterministic sandboxed realm. Each `agent()` call opens a session on an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) backend — Claude Code, OpenAI Codex, OpenCode, pi, or a custom ACP agent server. The backend runs its own tool loop to completion and returns final text or a schema-validated object. One script can mix backends per call.

`reference.md` (same directory) holds the exhaustive option tables, routing grammar, and error codes.

## The guide, by task

<!-- guide-index:begin -->
Read the section your task needs — each is a separate document in this skill directory:

1. **[Running workflows](mcp-server-setup.md)** — register `@automatalabs/mcp-server`; the `workflow` tool's run/await/inspect/stop actions; background runs; execution logs through the events resource.
2. **[Backends and structured output](models-and-output.md)** — per-call model routing, `configOptions`, and schema-validated outputs on every backend.
3. **[Composition and failure](composition-and-failure.md)** — the `meta` header, `parallel` and `pipeline`, null semantics, and phases.
4. **[Quality helpers and checkpoints](gates-and-lenses.md)** — `gate`, `retry`, `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, and the human `checkpoint()` gate.
5. **[Execution environment](environment-and-tools.md)** — working directories, worktree isolation, session modes, per-call MCP servers, custom ACP backends.
6. **[Determinism and resume](determinism-and-resume.md)** — what is identity-hashed, content-addressed replay, and how to keep a script resumable.
7. **[Examples and validation](examples-and-validation.md)** — worked examples, the full scripts in `examples/`, and the zero-token validator.
<!-- guide-index:end -->

## The mental model

- **The script is the orchestrator; agents are workers.** All control flow — loops, fan-out, dedup, aggregation, conditionals — lives in script code. Agents cannot spawn agents and cannot see each other. Give each agent one self-contained task.
- **Each `agent()` call opens a fresh session with no memory.** Interpolate everything a later call needs into its prompt. (Sole exception: resume can continue the same usage/auth-interrupted occurrence — see Determinism and resume.)
- **Agents are real coding agents, not chat completions.** They have file access, shells, and tools, rooted at the run's working directory. "Read the failing test and fix it" is a valid prompt; the agent will edit files.
- **The DSL primitives are realm globals, not imports.** There is nothing to `import` — `agent`, `parallel`, `pipeline`, `gate`, `checkpoint`, `args`, … are injected. Top-level `await` and a top-level `return` are valid. The script's return value becomes the run's `result`.
- **Scripts are plain JavaScript, not TypeScript.** Type annotations fail to parse. The realm has no Node APIs (no `require`, `import`, `fs`, `fetch`, timers). All side effects happen through agents.
- **Live observability needs no script annotations.** Journaling runs publish redacted progress and transcript upserts at `workflow://runs/{runId}/events`. Author labels for human correlation, not to enable this behavior.

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

Run scripts through the MCP server's `workflow` tool — registration, the run/await/inspect/stop actions, and the `args`/`cwd` globals are covered in **Running workflows** ([mcp-server-setup.md](mcp-server-setup.md)).

## Pre-flight checklist

- [ ] `export const meta = { name, description }` is the first statement, a pure literal.
- [ ] No `Date.now()` / `Math.random()` / no-arg `new Date()` / `Date()`; no imports, no Node APIs. Timestamps and randomness come in through `args`.
- [ ] Every `parallel` element is a **thunk**; results are `.filter(Boolean)`-ed or null-checked.
- [ ] Every prompt is self-contained: prior results are interpolated in, and every file path a prompt references was written by an earlier call, supplied through `args`, or created by that prompt's own instructions.
- [ ] Schemas: object root, `additionalProperties: false`, everything `required`, a `description` on every field.
- [ ] Model ids, effort values, and `configOptions` come from `npx @automatalabs/workflows config` or a validator report, never from memory. `mode` only on calls with a pinned `model`.
- [ ] Worktree-isolated agents return their work as data — their edits are discarded when the call ends.
- [ ] Replay is intentional: completed calls with matching identity and input fingerprints replay. Change a hashed field (normally the prompt) when a completed call must run again.
- [ ] Loops terminate on bounds the script controls; caps and drops are `log()`-ed, not silent.
- [ ] `checkpoint()` guards irreversible actions, with a sane headless `default` or an intentional `headless: "pause"`.
- [ ] `return` a compact, structured result — it is the run's `result`, not a transcript.
- [ ] `npx @automatalabs/workflows validate <file> --args '<json>'` exits 0 with no surprising warnings.

For the complete `agent()` option table, model-routing grammar, checkpoint options, error codes, `meta.backends` config fields, and the MCP tool input shapes, read [`reference.md`](reference.md).
