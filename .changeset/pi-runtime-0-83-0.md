---
"@automatalabs/pi-acp": patch
---

Update the direct pi runtime (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, dev `@earendil-works/pi-agent-core`) to 0.83.0, and map the new `"pending"` StopReason explicitly: a resolved turn whose terminal assistant message is still `"pending"` now fails through a named diagnostic instead of the generic unknown-stop-reason error. The provider-error classifier fixture pin was re-verified byte-identical against the 0.83.0 dists (auth guidance, agent-session auth prose, and pi-ai retry/overflow/error-body are unchanged). pi 0.83.0's TypeBox 1.3.7 alias upgrade removes only APIs this package never used; the pinned `typebox@1.3.2` type surface still checks clean.
