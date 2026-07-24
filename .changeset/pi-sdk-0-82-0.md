---
"@automatalabs/pi-acp": patch
---

Bump the Pi SDK lockstep family (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-agent-core`) to 0.82.0. Adapt the event translator for the new
`bash_execution_update` session event (ignored, like other session-side informational events).
Pi 0.82.0 reshapes builtin kimi thinking-level domains — `moonshotai/kimi-k3` now advertises
`low`/`high`/`max` — so per-model advertisement and clamping tests re-anchor to the new catalog,
with the capped-ladder fixture made synthetic so future catalog drift cannot silently change what
the test proves. Provider-error fixture strings re-verified byte-identical against the installed
0.82.0 dists and release-tagged source tests.
