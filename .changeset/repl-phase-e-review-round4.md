---
"@automatalabs/repl-engine": minor
"@automatalabs/mcp-server": minor
---

repl phase-E review round 4: the eval-break interrupt is keyed to the calls the running eval AWAITS. The engine now instruments top-level awaits (`await x` → `await __replAwait(x)`, acorn-based, guest library 0.2.0) and attributes each suspended eval's resume keys from the guest's await log — an unawaited sibling call's settlement no longer fires or consumes the armed signal (its own `.then` continuation runs to completion), an eval awaiting an EARLIER eval's binding stays targetable, and the wait tool's serialization-chain acquisition is bounded by its absolute deadline. The pending-call registry and provenance reads are now COMPLETE trap-free reads (no 16 384-element array cap, no 256-property object cap) — the whole registry and every binding's provenance survive eval output and restore reconciliation. The repl tool's input is action-discriminated (exact per-action field sets, extraneous fields rejected), the structured manifest gains machine-readable type + live-handle status/call fields, and guest-derived structured status fields (agent task) are capped at the engine seam.
