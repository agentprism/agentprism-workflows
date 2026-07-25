---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/mcp-server": minor
---

Skeleton-first run-monitor graph: the MCP App panel now parses the admitted workflow script (acorn, client-side) into its structural skeleton — agent/checkpoint/workflow call sites, parallel/pipeline groups, loop containers, phase markers, and engine-stdlib fan-out sites (verify/judgePanel/completenessCheck) — and renders it muted from the first frame. Runtime agents attach to their call sites by the engine's structural call path, which `agentStart` events now carry (additive `path` field, captured pre-limiter, never truncated — an oversized capture is dropped). Loops display one iteration at a time with a selector; checkpoint sites activate from settlement callRecords; nested workflow() agents cluster under a labeled bracket; pathless agents stay visible in an unmapped cluster rather than being guessed onto a site. Runs without a fetchable/parseable script fall back to the previous timing-based wave layout.
