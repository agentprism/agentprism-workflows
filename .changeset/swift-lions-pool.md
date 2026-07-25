---
"@automatalabs/acp-agents": patch
---

Replace per-connection serialization for injected StructuredOutput runs with process-exclusive
elastic pooling, including idle surplus reaping and full disposal coverage.
