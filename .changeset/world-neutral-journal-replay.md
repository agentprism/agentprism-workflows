---
"@automatalabs/workflow-engine": minor
"@automatalabs/shared-types": patch
"@automatalabs/workflows": minor
"@automatalabs/mcp-server": minor
---

Make incremental resume journal-correspondence based and world-neutral. Completed matching agent
and checkpoint calls now replay without filesystem-safety annotations or environment-stability
gates; live calls, nested workflows, host checkpoints, and worktree degradation no longer clear
unrelated candidates. Current-format crash residue keeps identity replay, and usage/auth recovery
replays its completed prefix before reattaching the interrupted ACP session. Legacy safety fields
and reason literals remain readable as diagnostic compatibility metadata, and format-1 interrupted
sessions use their legacy input fingerprint when crossing into the format-2 engine.
