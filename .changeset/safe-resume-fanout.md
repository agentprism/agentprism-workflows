---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
"@automatalabs/mcp-server": minor
---

Add content-addressed incremental resume for manager-owned `resumeFromRunId` executions.

- `@automatalabs/shared-types` adds the optional safety, replay-provenance, call-decision, and
  `WorkflowResumeReport` contracts; checkpoint-capable `inputsHash` documentation; and additive
  `WorkflowCallRecord` / `WorkflowRunResult` fields. Old object literals and persisted JSON remain
  readable because every new field is optional and omitted when unset.
- `@automatalabs/workflow-engine` adds identity-v1 format admission, durable candidate seeds,
  exact path/hash plus unique content matching, filesystem/worktree barriers, checkpoint-options
  fingerprints, logical replay budget debit, current-index agent-session rebinding, and
  manager-owned `resumeFromRunId` / `resumePolicy` preparation and reports.
- `@automatalabs/workflows` adds the DSL `agent({ resume: { filesystem: "read-only" } })` safety
  declaration, public execution options, and facade re-exports for resume reports and reason
  catalogs.
- `@automatalabs/mcp-server` accepts optional `resumePolicy`, delegates source hydration and
  checkpoint reply mapping to the manager, returns structured resume reports with compact text
  counts, and ships regenerated identity-resume authoring guidance.

For identity-v1-capable sources, the default policy now replays uniquely corresponding safe calls
non-contiguously instead of stopping at the first positional miss. Cached identity hits preserve
their source logical debit in script-visible budget gates while adding zero current provider usage,
and replayed session records rebind to the current call index, label, and phase. New-format sources
must pass exact cwd, Node/V8/runtime-format, terminal-environment, manifest, and seed admission;
unsafe non-git executions without a trustworthy terminal host identity run entirely live.

The positional escape hatch remains an index/prefix matcher, with these hardened observable rules:
nested workflows close the parent prefix before child execution; positional cache hits emit fresh
current-run journal/call observations; new-format positional hits require equal agent/checkpoint
input fingerprints and proven host checkpoint decisions; and only marker-less or permanently
legacy sources retain historical hash-only serving without the new environment facts.

Two fail-safe compatibility changes are intentional. The common terminal gate now rejects aborted
or `abortSignaled` marker-less/legacy sources instead of serving their cache. Terminal compaction
also drops inherited positional suffix rows the current run never visited, so a double-hop pause
runs that bridged tail live on the second hop rather than replaying data absent from the immediate
source manifest. That compaction applies to every new run seeded from a prior journal — including
low-level embedder runs supplied a manual `exec.resumeJournal` — not only manager-owned
`resumeFromRunId` executions, keeping later hops self-contained in both entry paths.
