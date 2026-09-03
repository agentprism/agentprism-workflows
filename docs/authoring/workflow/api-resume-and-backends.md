# Workflow continuation and extension reference

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

## Same-run continuation journal

Each `agent()` and `checkpoint()` result is journaled under a monotonic call index and identity hash.
MCP `{ action:"resume", runId }` reloads the same run's persisted script, args, canonical effective
agent configuration, journal, events, cumulative usage, and checkpoint decisions. It returns the
same `runId`; there is no public execution-attempt or child-run model.

The canonical agent identity fields are `prompt`, resolved `model`, authored `mode`, non-empty
sorted `configOptions`, `tier`, `phase`, `agentType`, resolved agent definition, and `schema`.
Exact journal hits reconstruct completed calls without current provider usage. Eligible interrupted
ACP calls may reattach at the live boundary. New live usage is added to the prior cumulative total.

The host persists a versioned canonical admission snapshot before execution. Same-ID continuation
uses it without new provider/model elicitation. Missing, invalid, or uncovered admission metadata
fails closed. Checkpoint replies are first-writer-wins under the run lease and become permanent
journal facts.

## <a name="custom-backends-metabackends"></a>Custom backends — `meta.backends`

```js
export const meta = {
  name: "…", description: "…",
  backends: {
    browser: {
      command: "browser-acp",          // required: executable (absolute or on PATH)
      args: ["--headless"],            // default []
      env: { BROWSER_PROFILE: "qa" },  // merged over the child's inherited env
      sessionMeta: { viewport: "desktop" },
      structuredOutputTool: true,
    },
  },
};
```

Script-declared backends spawn commands on the host and are trust-gated before admission. The MCP
server obtains explicit approval; SDK hosts use `allowScriptBackends`, `ExecOptions.scriptBackends`,
or their configured environment policy. A declined backend aborts admission rather than rerouting.
Host-registered names win. Approved canonical backend definitions are stored in the run's admission
snapshot so continuation never re-elicits or changes them.

## <a name="agenttype-definitions"></a>`agentType` definitions

Markdown files at `<runCwd>/.agentprism/agents/<name>.md` and
`~/.agentprism/agents/<name>.md`; project wins:

```markdown
---
description: Read-only security auditor
tools: [read, grep, glob]
disallowedTools: [bash]
model: claude/opus[1m]
isolation: worktree
---
You are a security auditor. Report findings; never modify files.
```

The body is prepended to the task. An unknown type warns and degrades to defaults. The resolved
definition participates in agent identity, so a same-run continuation only replays the exact
definition captured by its journal and admitted configuration.
