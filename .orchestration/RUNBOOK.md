# Historical ACP + MCP build-orchestration runbook

This directory is retained as provenance for the workflows that built, integrated, verified, hardened, and prepared this repository for publication. It is **not** the normal development or release procedure. The saved handoffs and workflow prompts contain frozen source snapshots, absolute paths, dependency versions, branch names, and worktree assumptions from their original runs; do not rerun them blindly against a current checkout.

For current development, use the repository commands documented in [`CONTRIBUTING.md`](../CONTRIBUTING.md). In particular, run `pnpm typecheck` and `pnpm test` before merging. Live backend checks are opt-in and require the credentials described there.

## Historical workflow chain

The workflows live in [`.claude/workflows`](../.claude/workflows). Their durable handoffs live beside this runbook.

| Stage | Workflow file | Durable handoff | Historical purpose |
|---|---|---|---|
| 0 | *(manual ground truth)* | `ground-truth.json` | Freeze source evidence and corrections. |
| 1 | `acp-build-phase1-freeze.js` | `phase1-contract.json` | Freeze contracts and scaffold packages. |
| 2 | `acp-build-phase2-implement.js` | `phase2-modules.json` | Implement modules in isolated worktrees. |
| 3 | `acp-build-phase3-integrate.js` | `phase3-integration.json` | Merge module branches and reconcile dependencies. |
| 3b | `acp-build-phase3b-tests.js` | `phase3b-tests.json` | Expand integration coverage. |
| 4 | `acp-build-phase4-verify.js` | *(no committed handoff)* | Verify builds and real-backend smoke behavior. |
| 5 | `acp-build-phase5-completeness.js` | `phase5-completeness.json` | Audit API and feature completeness. |
| 6 | `acp-build-phase6-harden.js` | `phase6-harden.json` | Harden failure paths and release quality. |
| Publish | `publish-prep.js` | `publish-prep.json` | Prepare the package set for publication. |
| Auth | `acp-auth-implementation.js` | *(run journal only)* | Implement the authentication design recorded in `docs/specs/acp-auth-spec.md`. |

`ground-truth.json` was authoritative for the initial build; its top-level `corrections` block overrode conflicting `findings` or `readiness` entries. It should not be treated as a current package inventory or dependency manifest.

## Inspecting or replaying a historical workflow

Validate a script before any replay:

```bash
npx @automatalabs/workflows validate .claude/workflows/acp-build-phase1-freeze.js --args '{}'
```

The MCP `workflow` tool accepts the **raw JavaScript source** in its `script` input. It does not resolve a saved workflow name. SDK callers may read a saved file themselves, call `openWorkflowDir(".claude/workflows").read(name)`, or pass the directory view to `runDynamicWorkflow(name, { workflows: view })`.

Runs return a `runId`. A paused run can be resumed with the same script plus `resumeFromRunId`; completed agents are recovered from the persisted journal when their deterministic definitions still match. Authentication pauses return `reason: "auth_required"` (persisted as the run's pause reason): inspect status, complete authentication through the runner or MCP auth tools, then resume the original `runId`.

Before replaying any script, review and update:

- absolute repository, source, SDK, and worktree paths;
- pinned commits and package versions;
- expected branches, handoffs, and already-completed stages;
- backend availability and authentication requirements;
- write scopes in every agent prompt.

## Historical worktree model

Phase 2 created self-managed git worktrees outside the repository, one per module branch, all cut from the scaffold commit recorded in `phase1-contract.json`. Phase 3 merged those branches by commit SHA, ran one dependency install in the main checkout, and removed the temporary worktrees after successful integration. This build-time arrangement is separate from the workflow engine's runtime `isolation: "worktree"` feature.

## State and cleanup

- The committed JSON handoffs are historical records and safe to inspect or diff.
- `sources/`, `sdks/`, and temporary worktrees are recreatable and ignored by git.
- A replay writes normal persisted run state under the configured AgentPrism persistence root (see `AGENTPRISM_PERSISTENCE_ROOT`).
- Do not delete historical handoffs merely to restart current development; they are provenance, not active build state.
