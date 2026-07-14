---
"@automatalabs/mcp-server": minor
---

New `author-workflow` MCP prompt: prompt-capable hosts (e.g. Claude Code, where it surfaces as a slash command) get the complete workflow-authoring guide served by the server itself — the published `agentprism-workflow-authoring` skill's guide, the exhaustive DSL reference tables, and a complete validated example script, bundled self-contained (every same-directory pointer rewritten) and version-matched to the installed engine. Pass the optional `task` argument to close the guide with a concrete authoring assignment that ends by running the `workflow` tool. Prompts are a user-controlled MCP primitive, so the model-facing tool surface stays exactly the single `workflow` tool. Content is generated from the skill sources by `scripts/generate-authoring-prompt.mjs` with a CI drift guard.
