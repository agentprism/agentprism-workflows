---
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": patch
---

Add `resumeInBackground` so hosts can observe when an accepted resumed workflow actually settles.

Keep per-execution ACP events connected for the full lifetime of resumed SDK runs, then release the bridge after settlement.
