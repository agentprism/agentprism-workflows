---
"@automatalabs/acp-agents": patch
---

Bump the exact `@automatalabs/codex-acp` pin to 1.5.0: the Codex adapter now routes file reads/writes through the client's `fs/read_text_file` / `fs/write_text_file` when — and only when — the client advertises `fs` capabilities. Inert for consumers that register no fs handlers (our advertisement is derived from the registered handler set).
