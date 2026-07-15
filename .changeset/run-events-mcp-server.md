---
"@automatalabs/mcp-server": patch
---

Tail durable event logs for bounded background awaits and emit monotonic coarse phase and distinct
started/ended-call progress when the await request carries a progress token. Background-start
requests still return without an enduring progress channel or any notification after return, and
legacy/inconsistent-log polling fallback emits no progress notifications. Tool schemas are
unchanged; refresh the bundled workflow-authoring prompt and host guidance accordingly.
