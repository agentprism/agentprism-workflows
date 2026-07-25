---
"@automatalabs/acp-agents": patch
---

Isolate every spawned `opencode acp` process behind fresh per-spawn XDG data/state/cache trees
with the user's credentials seeded in (and autoupdate disabled for the child). Concurrent
OpenCode instances share the sqlite database, snapshot git index, log, and auth.json, and
interfere across sessions (anomalyco/opencode#31307, #29395, #21215, #38366, #37059) — observed
as mid-run "ACP connection closed" once process-exclusive injected pooling overlapped opencode
processes. Isolating only OPENCODE_DB is insufficient (#33321). User config (XDG_CONFIG_HOME)
stays shared; an explicitly exported OPENCODE_DB passes through. Cross-process session reattach
for opencode now falls back to the runner's fresh-session path.
