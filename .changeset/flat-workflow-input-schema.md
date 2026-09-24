---
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---

Publish the `workflow` tool's input as one flat, strict JSON Schema object instead of a top-level `oneOf`.

The Anthropic API rejects a tool `input_schema` whose top level is `oneOf`/`anyOf`/`allOf`, so Claude-based MCP hosts either dropped the `workflow` tool entirely (Claude Code logged `skipping tool "workflow": its input schema uses top-level oneOf` and the server showed no tools) or flattened it lossily on their own, leaving `action` pinned to `"config"` and `script`/`scriptPath`/`args` missing. Discovery now publishes `type:"object"` with `action` required (an enum of all nine actions), every other field optional, and `additionalProperties:false`; the `action` description lists which fields each action takes. The published schema is also smaller (about 5.6 KB, down from 10 KB).

Runtime acceptance is unchanged. `workflowToolInputSchema` still rejects everything the per-action branches rejected — cross-action fields, missing required fields, both or neither of `script`/`scriptPath`, `callIndex` with `forceOwner`, and a `response` of the other action's shape — now with messages that name the action, the field, and the fields that action accepts (for example `action "run" does not accept lastN; it accepts script, scriptPath, projectDir, args, maxAgents, concurrency, agentRetries`). Validated input is still narrowed through the strict `workflowToolCanonicalInputSchema`, which is now runtime-only and no longer carries a published `type:"object"` annotation.

`workflowToolInputShape` now matches the published fields: `action` includes `pause`, and `response` accepts either the setup-response or the permissions-response shape (the action decides which is valid).
