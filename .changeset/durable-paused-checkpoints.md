---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---

Add durable paused checkpoints. Workflows can opt into `headless: "pause"`, expose a non-secret `checkpointContext`, and resume with a journaled `checkpointReplies` decision that survives cold restarts.

Expose the checkpoint context through the shared and workflows type barrels, persist and classify `CHECKPOINT_REQUIRED` runs in the engine, and add the MCP pause-and-resume wire flow for clients without elicitation.
