---
"@automatalabs/acp-agents": patch
---

Bump the exact `@automatalabs/codex-acp` pin to 1.5.2: client fs routing is scoped to reads — file-change diff content comes through the client's `fs/read_text_file` when advertised (unsaved-buffer-accurate diffs, disk fallback); file writes are codex-internal, as the app-server protocol delegates no file IO to the client.
