# Workflow resume and extension reference

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

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
does not appear in an earlier call's prompt, lets those calls replay on resume. The worked example lives in `workflow/determinism-and-resume`. This changed-args pattern is specific to new-run entry
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
