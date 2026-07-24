## Working directory, isolation, confinement

- Every agent session runs in the run's base `cwd` unless the call narrows it: `agent({ cwd: "packages/api" })` (relative resolves against the base).
- `isolation: "worktree"` runs the agent in a **throwaway git worktree** (`<repoRoot>/.agentprism/worktrees/…`) so parallel agents can edit without colliding. The worktree and its branch are **always deleted when the call ends — an isolated agent's file edits are discarded**. Have isolated agents *return their work as data* (a unified diff, a file map, a report) and apply it in a later non-isolated step; use worktrees for experiments, builds, and verification, not for persistent edits. Outside a git repo, isolation degrades to the shared tree with a logged notice.
- `resume: { filesystem: "read-only" }` is a deprecated compatibility annotation. It is not a runner mode and has no effect on replay; completed calls replay by journal correspondence whether they read or write. Use `mode`, tool policy, prompts, and worktrees when you actually need confinement.
- `mode` requests an agent-advertised ACP session mode and is **strict** — an unsupported mode fails the call rather than running unconfined. Mode ids are backend-specific and drift with harness versions: read the advertised `mode` select from `npx @automatalabs/workflows config <harness>` or a validator report (Codex-family examples: `read-only`, `agent`; Claude-family advertises permission modes such as `plan` and `acceptEdits`; OpenCode via its mode option; Pi advertises thinking-level config rather than modes). Only set `mode` on calls whose `model` you also pin. Use read-only/plan modes for reviewers and auditors that must not write.
- `agentType: "<name>"` binds a reusable subagent definition — a Markdown file at `<cwd>/.agentprism/agents/<name>.md` (project) or `~/.agentprism/agents/<name>.md` (user; project wins) whose frontmatter sets tool allow/deny lists, a model, and isolation, and whose body is the role prompt. An unknown name logs a warning and degrades to defaults.

## Where a mutating workflow runs

The run's base `cwd` is the USER'S checkout — the working copy they launched the host from. Treat it as borrowed: committing onto whatever branch is checked out, switching branches, or resetting it are defects unless the user asked for exactly that. A script that commits should verify its target workspace in a preflight step, or create its own workspace idempotently, and refuse on a mismatch rather than adapt. `isolation: "worktree"` is NOT such a workspace — it is per-call and throwaway. Note also that a throwaway worktree branches from the run cwd's repository: an isolated agent sees another agent's commits only when they are reachable there.

## Wiring tools and inputs into a call

- `mcpServers: [{ name, command, args: [], env: [] }]` attaches MCP servers to that agent's session — the portable way to hand any backend a capability (image generation, a browser, a ticket system). The agent sees the server's tools natively. Note `env` is a list of `{ name, value }` pairs (ACP shape), not an object map; HTTP/SSE servers use `{ type: "http", name, url, headers: [] }`.
- `images: [...]` appends base64 image blocks to the prompt (backends without image support receive a bracketed text note instead).
- `meta` / `promptMeta` pass generic ACP `_meta` through to `session/new` / `session/prompt` — the escape hatch for driving a custom agent's extension surface.
- `keepSession: true` keeps a successful agent's ACP session re-openable after the run: the re-attach record (sessionId, backend, effective pool identity, cwd, reopen capabilities) lands in `WorkflowRunResult.agentSessions`, and the HOST can continue that conversation later via `runner.loadSession()`. Usage/auth pause failures are kept open automatically so managed resume can continue the interrupted occurrence. Scripts themselves never request reattach.

### Custom ACP backends

Any process that speaks ACP over stdio can serve `agent()` calls — an in-house browser-QA agent, an image generator, a domain-specific executor. Two ways in:

1. **Host-registered** (preferred): the embedder passes `createAcpRunner({ backends: { browser: { command: "/abs/browser-acp" } } })`; the script just routes with `model: "browser"`.
2. **Script-declared**: the script itself declares the backend in `meta.backends` — but declarations are **inert until the host approves them** (an elicitation in the MCP server; `allowScriptBackends` in the SDK), because they spawn commands on the host machine. Don't rely on them silently working.

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
