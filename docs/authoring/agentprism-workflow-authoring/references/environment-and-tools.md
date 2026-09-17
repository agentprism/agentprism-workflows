## Working directory, isolation, confinement

**Context:** JavaScript passed to the MCP `workflow` tool.

- Every agent session runs in the run's base `cwd` (the run's `projectDir`) unless the call narrows it: `agent({ cwd: "packages/api" })` (relative resolves against the base). The script sees the base as the `cwd` global.
- `isolation: "worktree"` runs the agent in a **throwaway git worktree** (`<repoRoot>/.agentprism/worktrees/…`) so parallel agents can edit without colliding. The worktree and its branch are **always deleted when the call ends — an isolated agent's file edits are discarded**. Have isolated agents *return their work as data* (a unified diff, a file map, a report) and apply it in a later non-isolated step; use worktrees for experiments, builds, and verification, not for persistent edits. Outside a git repo, isolation degrades to the shared tree with a logged notice.
- `mode` requests an exact backend-advertised ACP session mode. Copy the id from the config response and read the backend-owned description instead of inferring behavior from the id. For trusted implementation/review work use Claude `bypassPermissions` or Codex `agent` when advertised. Claude `auto` uses a model classifier and may request permission, so it is not the full-access mode. Preflight rejects a mode the effective backend/model does not advertise. Use an advertised read-only/plan mode for reviewers that must not write.
- `agentType: "<name>"` binds a reusable subagent definition — a Markdown file at `<projectDir>/.agentprism/agents/<name>.md` (project) or `~/.agentprism/agents/<name>.md` on the server host (user; project wins). Its frontmatter sets tool allow/deny lists, a model, and isolation; its body is prepended to the task as the role prompt:

```markdown
---
description: Read-only security auditor
tools: [read, grep, glob]
disallowedTools: [bash]
model: claude
isolation: worktree
---
You are a security auditor. Report findings; never modify files.
```

  An unknown name logs a warning and uses the remaining authored routing, so the call still needs an effective model. The resolved definition is captured at admission and is part of the call's replay identity.

## Where a mutating workflow runs

The run's base `cwd` is the USER'S checkout — the working copy they launched the host from. Treat it as borrowed: committing onto whatever branch is checked out, switching branches, or resetting it are defects unless the user asked for exactly that. A script that commits should verify its target workspace in a preflight step, or create its own workspace idempotently, and refuse on a mismatch rather than adapt. `isolation: "worktree"` is NOT such a workspace — it is per-call and throwaway. Note also that a throwaway worktree branches from the run cwd's repository: an isolated agent sees another agent's commits only when they are reachable there.

## Wiring tools and inputs into a call

- `mcpServers: [{ name, command, args: [], env: [] }]` attaches MCP servers to that agent's session — the portable way to hand any backend a capability (image generation, a browser, a ticket system). The agent sees the server's tools natively. `env` is a list of `{ name, value }` pairs, not an object map; HTTP/SSE servers use `{ type: "http" | "sse", name, url, headers: [] }`.
- `images: [{ data, mimeType }]` appends base64 image blocks to the prompt (backends without image support receive a bracketed text note instead).
- `meta` / `promptMeta` pass generic ACP `_meta` through to `session/new` / `session/prompt` — the escape hatch for driving a custom agent's extension surface.

## Custom ACP backends

Any process that speaks ACP over stdio can serve `agent()` calls — an in-house browser-QA agent, an image generator, a domain-specific executor. A backend the server operator registered is routed like a built-in (`model: "browser"`) and appears in the config response. A script can also declare its own in `meta.backends`:

```js
export const meta = {
  name: "checkout-qa",
  description: "Implement, then QA the checkout flow in a real browser",
  model: "codex",
  backends: {
    browser: {
      command: "browser-acp",          // required: executable (absolute or on PATH of the server host)
      args: ["--headless"],            // default []
      env: { BROWSER_PROFILE: "qa" },  // merged over the child's inherited env
      sessionMeta: { viewport: "desktop" },
      structuredOutputTool: true,      // false opts out of the injected structured-output tool
    },
  },
};

const change = await agent("Implement the coupon-code field per the spec in docs/coupon.md.",
                           { label: "implement" });              // inherits meta.model
const verdict = await agent(
  `Open the app, walk through checkout with coupon SAVE20, and verify the discount line. Change summary:\n${change}`,
  { label: "qa", model: "browser",                               // the custom agent
    schema: { type: "object", additionalProperties: false, required: ["passed"],
              properties: { passed: { type: "boolean" }, notes: { type: "string" } } } },
);
return { change, qa: verdict };
```

Script-declared backends spawn commands on the server host, so they are **inert until approved**. The run is validated, then parked: status shows `status:"pending"` and `setup.state:"input-required"` with `setup.request` (`id`, `title`, `message`, and a `requestedSchema` of `{ approve: boolean }`). Answer it with `{ action:"setup-response", runId, setupId: setup.request.id, response:{ action:"accept", content:{ approve:true } } }`; `{ action:"decline" }` leaves an inspectable aborted run. A declined backend never reroutes to another provider, a registered backend of the same name wins, and a later script revision cannot add backends the setup did not approve. Structured output works on custom backends through the same injected-tool/fallback path as OpenCode — no special-casing in the script.
