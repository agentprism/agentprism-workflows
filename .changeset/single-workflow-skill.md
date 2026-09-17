---
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": patch
---

Serve only the `agentprism-workflow-authoring` Agent Skill over the MCP Skills Extension and rewrite it for the agent that drives the `workflow` tool. The `agentprism-repl-orchestration` skill is removed from `skills/list`, `skills/get`, and the resource tree ahead of the `repl` tool's removal, and the `repl` tool description, server instructions, and `author-workflow` prompt no longer point at it. The workflow skill now opens with `action:"config"` discovery and ships only backend-only routes in its examples (a placeholder walkthrough covers pinning an exact model, mode, or config option copied from the config response); it drops tier routing, saved-name `workflow()` nesting, SDK host options, CLI exit codes, protocol-era and app-tool internals, and the stale eight-action count. `@automatalabs/workflows` re-bundles the same server surface.
