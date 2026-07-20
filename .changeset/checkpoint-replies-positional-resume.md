---
"@automatalabs/workflow-engine": patch
"@automatalabs/mcp-server": patch
"@automatalabs/shared-types": patch
---

Honor durable `checkpointReplies` when resuming a positional (non-`resume`-declared) run. Previously a background run paused at a durable `checkpoint(..., { headless: "pause" })` could not be continued: resuming with `resumeFromRunId` + `checkpointReplies` took the positional fallback, re-ran the whole agent prefix live, re-reached the checkpoint, and re-paused. The recorded reply is now applied after the live prefix, matched to the checkpoint's exact call path-hash so a reply only ever applies to the occurrence it targeted.

The resume report and the MCP workflow result now surface a `checkpointReply` outcome: `applied` (with the current call index), or `not-applied` with a safe reason (`checkpoint-identity-mismatch` or `checkpoint-not-reached-at-recorded-call-site`). The not-applied report never echoes the supplied decision value.
