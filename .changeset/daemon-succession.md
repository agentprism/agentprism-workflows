---
"@automatalabs/mcp-server": patch
---

Daemon succession: new clients supersede a stale daemon, and stale daemons drain and exit.

Previously, when a stdio shim's version/env fingerprint diverged from the live daemon, it
restarted the daemon only while it was idle; a **busy** divergent daemon was adopted with just
a warning. Because every new client added a session and reset the daemon's idle clock, new
clients were precisely what kept a superseded daemon alive — so it never died and served
out-of-date code to those clients indefinitely.

Now a shim whose fingerprint diverges from the live daemon **never adopts it** (busy or idle).
It spawns a current-version successor on an ephemeral port, atomically repoints `daemon.json`
at the successor, and connects there. The superseded daemon — whose pid no longer matches
`daemon.json` — becomes a **lame duck**: it rejects new MCP sessions at admission with a clear
error, keeps serving its existing sessions and running workflows to completion, and exits once
idle within the existing idle-TTL bound (lame-duck status neither resets nor extends the TTL).
If discovery is ever repointed back at it, it resumes normal service.

`/healthz` (and `daemon status`) now report the daemon's `version` and `lameDuck` status, and
the shim logs succession loudly (old version/pid → new version/pid, with the reason). The
divergent-but-busy adoption warning is gone because the adoption path is gone. Split-brain
safety is unchanged: the pid-guarded `daemon.json` and per-run leases keep two live daemons
over one run store safe, and the successor never disturbs the predecessor's in-flight runs or
sessions.
