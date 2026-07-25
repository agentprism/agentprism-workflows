---
"@automatalabs/acp-agents": patch
---

Isolate every spawned `opencode acp` process's sqlite database via a per-spawn OPENCODE_DB.
Concurrent OpenCode instances in one project share the cwd-keyed database and interfere across
sessions (anomalyco/opencode#31307), observed as mid-run "ACP connection closed" once
process-exclusive injected pooling overlapped opencode processes. Auth (auth.json) is unaffected;
an explicitly exported OPENCODE_DB still wins. Cross-process session reattach for opencode now
falls back to the runner's fresh-session path.
