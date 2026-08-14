---
"@automatalabs/codex-acp": patch
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `c4a9311`).
Additive upstream changes: a new provider-neutral `contextCompaction` tool-call `_meta`
extension (`ContextCompactionMeta.ts`) carrying compaction-specific facts (trigger,
pre/post tokens, duration, error) on synthetic context-compaction tool calls, with the
tool-call mapper emitting it and lifecycle/load-session fixtures updated accordingly. No
surface we integrate against changed; mechanical sync per the dependency-gate runbook.
