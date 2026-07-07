---
"@automatalabs/shared-types": patch
"@automatalabs/workflow-engine": patch
---

Backfill version bumps for the StructuredOutput tool-injection slice: shared-types gained the optional `WorkflowBackendConfig.structuredOutputTool` field and workflow-engine validates it in script `meta.backends`. Both changes shipped in the repo at v0.19.0 of the SDK but were not version-bumped; this republishes so the published types and validation match source.
