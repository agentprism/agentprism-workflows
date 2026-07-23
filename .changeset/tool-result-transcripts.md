---
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
---

Persist per-tool results in agent transcripts. Terminal ACP `tool_call_update` notifications
carrying displayable content now map to a new `tool-result` observability activity
(`@automatalabs/workflows` adapter) and are published as durable `toolResult` transcript
entries — redacted and byte-capped like every other transcript record — instead of being
collapsed into a bare content boundary. Non-terminal and content-less updates keep the
previous boundary behavior. The run event persistence schema accepts the new entry shape
(`kind: "toolResult"`, optional `toolName`, optional `isError: true`).
