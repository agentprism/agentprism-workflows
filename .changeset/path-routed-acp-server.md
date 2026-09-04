---
"@automatalabs/acp-server": major
---

Select discovery or a backend at the transport boundary: HTTP and WebSocket now expose dedicated `/discovery` and `/backends/{id}` paths, while stdio requires `--discovery` or `--backend <id>`. Remove initialize `_meta` routing, repeated `session/new` assertions, the single `/acp` endpoint, the old router helpers and constants, and the aggregator's no-selector ACP registry entry.
