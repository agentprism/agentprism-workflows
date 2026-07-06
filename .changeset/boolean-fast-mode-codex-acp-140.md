---
"@automatalabs/acp-agents": minor
---

`@automatalabs/codex-acp` 1.4.0 (upstream sync: codex 0.142.5, boolean Fast-mode config options, message IDs on text chunks, goal-change session metadata, completed image-generation items) + first-class boolean session config options. The client now advertises `session.configOptions.boolean` at initialize, so agents may ship `type: "boolean"` catalog entries; the `model[fast]` spec bracket drives both the new boolean Fast-mode shape (wire request carries the `type: "boolean"` discriminator) and the legacy on/off select. Fast mode is matched by its stable `fast-mode` id — upstream moved the option's category to `model_config`, which the old category-based match would have missed.
