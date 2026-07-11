---
"@automatalabs/acp-agents": patch
---

Model catalog matching now tries the provider-prefixed spec with its `[effort]` bracket stripped (e.g. `zai/glm-5.2[max]` → `zai/glm-5.2`) before any fuzzy fallback. Previously a bracketed spec never exact-matched its own provider's catalog entry, so the substring fallback could select a cross-provider lookalike serving the same model name (OpenCode's catalog lists e.g. `huggingface/zai-org/GLM-5.2` ahead of `zai/glm-5.2`), silently routing the call — and its token limits — through the wrong provider.
