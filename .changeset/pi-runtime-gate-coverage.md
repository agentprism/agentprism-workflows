---
"@automatalabs/acp-agents": patch
---

Track `@earendil-works/pi-agent-core` in the pi backend's release freshness set, and extend
the dependency gate's reverse-coverage enforcement to the whole `@earendil-works/` scope: any
workspace dependency from the pi runtime family that is missing from a backend's
`freshness.npm` now fails the gate before any network request, so a new pi-scope package can
never silently drift out of lockstep with its siblings.
