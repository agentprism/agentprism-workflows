---
"@automatalabs/acp-agents": patch
---

Structured output now reads the turn's FINAL assistant message instead of scanning the whole turn's concatenated text. Codex applies the `outputSchema` Responses-API constraint to every sampled assistant message in the turn (field report), so intermediate progress messages come back schema-shaped too — the previous first-balanced-JSON scan over the full turn could return a progress object instead of the result. `SessionState` now segments the final message at tool_call / tool_call_update / agent_thought_chunk / plan / user_message_chunk boundaries, `StructuredSource` gains `finalMessageText()`, and the Codex/OpenCode/custom backends plus the repair ladder's prose extraction all read it.
