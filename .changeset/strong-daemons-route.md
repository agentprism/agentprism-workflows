---
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
"@automatalabs/mcp-server": minor
"@automatalabs/pi-acp": patch
---

Keep workflow run control reachable across daemon version succession. Run leases now expose opaque owner identity, managers can safely cold-stop lease-free persisted runs, and daemon successors persist and forward authenticated stop/cancel operations to predecessor execution owners with an explicit fenced force escalation.

Update the embedded Pi runtime packages to 0.84.4. The release changes an unused agent-loop hook ordering and otherwise delivers compatible session, compaction, provider-stream, and Windows abort fixes; the provider error-classification strings remain unchanged.
