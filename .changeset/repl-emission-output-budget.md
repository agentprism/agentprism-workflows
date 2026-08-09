---
"@automatalabs/repl-engine": minor
"@automatalabs/mcp-server": patch
"@automatalabs/workflows": patch
---

repl: emit `console.log` output and eval results up to the result byte budget instead of clamping every string to a 200-char preview.

A directly emitted top-level string — a `console.log` argument or the eval result — is output the orchestrator asked to see, not a preview of a value's shape, so it is now carried whole up to the byte budget ("200 chars OR the KB max, whichever is greater") rather than head/tail-elided at 200 characters. A subagent's answer comes back whole in one call instead of forcing creative slice-by-slice extraction. The tool-result caps rise to **4000 lines / 50 KB** (from 256 / 10 KB), so a multi-line answer fits; only strings past the budget head/tail-elide (keeping their `$N` ref for the remainder). Nested and property strings are unchanged — they stay preview-short.
