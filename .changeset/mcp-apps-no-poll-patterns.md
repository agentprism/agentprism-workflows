---
"@automatalabs/mcp-server": minor
---

Keep agents from re-rendering the MCP Apps run-monitor by polling: the panel now mirrors run status into the host's model context via `ui/update-model-context` (throttled, overwrite semantics, immediate on pauses/terminal states), the `workflow` tool description and background-admission text steer agents to a single bounded `await` instead of `inspect` polling (and document `_meta.progressToken` support), and `inspect`/`await` text summaries carry `annotations.audience: ["assistant"]`. README documents the upstream per-call rendering limitation (ext-apps#430).
