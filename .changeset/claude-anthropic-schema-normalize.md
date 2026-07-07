---
"@automatalabs/acp-agents": patch
---

Normalize Claude `outputFormat` schemas to the JSON-Schema subset Anthropic structured outputs accepts (`toAnthropicJsonSchema`): `additionalProperties: false` forced on every object, unsupported validation keywords / formats / regex features stripped, `oneOf` → `anyOf`, authored `required` preserved. Previously the schema was sent verbatim, so an Anthropic-incompatible schema (e.g. one missing `additionalProperties: false`) made the SDK's native constraint fail and silently degraded schema runs to unconstrained text plus the repair ladder. Also fixes both normalizers to treat `properties`/`$defs` names as data rather than keywords — a property literally named `format` or `title` no longer vanishes from the wire schema.
