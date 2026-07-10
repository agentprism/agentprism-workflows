---
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
---

Formalize persisted agent and journal session records and add `getPersistedAgentSessions` so hosts can depend on `AgentSessionRecord` surviving persistence for cold-restart session recovery.

Re-export the persisted run and agent state types from the workflows SDK facade.
