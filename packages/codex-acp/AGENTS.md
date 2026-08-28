# Codex ACP Subtree Guidance

This file supplements the repository-wide [`../../AGENTS.md`](../../AGENTS.md). Root monorepo, delivery, attribution, and release rules always win over instructions inherited from upstream.

`packages/codex-acp` is AgentPrism's published fork of `agentclientprotocol/codex-acp`, retained as a **non-squashed subtree with real upstream ancestry**. Treat upstream synchronization and ordinary feature work as different operations.

## Project structure

- `src/` — ACP server implementation. Entry point: `src/index.ts`.
- `src/__tests__/` — upstream Vitest behavior tests around ACP and Codex events.
- `src/app-server/` — generated Codex app-server API types; regenerate with the package's `generate-types` script.
- `src/permissions/` and `src/subagents/` — permission and child-session integration.
- `dist/` — generated package output. Do not hand-edit it.
- `docs/` and `readme-dev.md` — package-specific protocol and development documentation.

Fork-owned integration surfaces include turn-level `outputSchema` forwarding and AgentPrism ACP extensions. Review the dependency surface map and Codex sync runbook in root `CONTRIBUTING.md` before changing or merging upstream code in `CodexAcpServer`, `CodexEventHandler`, approvals, steering, goals, or loaded-turn handling.

## Coding conventions

- Keep edits consistent with the existing formatting and generated app-server types.
- When adding environment or configuration knobs, document them in `readme-dev.md` and the relevant root integration docs.
- In discriminated-union or event `switch` statements, handle every variant with an explicit `case`. Use an explicit no-op case when intentionally ignored; do not add a broad fallback merely to satisfy TypeScript.
- Prefer current `thread/*`, `turn/*`, and `item/*` app-server events. Do not introduce the deprecated `codex/event/*` surface.
- For app-server protocol, transport, approval, turn-event, or generated-schema work, check the current upstream Codex app-server documentation and regenerate types instead of inventing local wire shapes.

## Testing

The root deterministic suite deliberately excludes this vendored package's upstream Vitest suite. Run it explicitly whenever changing this package and during every upstream sync:

```bash
pnpm --filter @automatalabs/codex-acp build
pnpm --filter @automatalabs/codex-acp typecheck
pnpm --filter @automatalabs/codex-acp test
```

- Favor event-driven behavioral assertions under `src/__tests__/CodexACPAgent/`.
- Prefer stable file snapshots where the surrounding suite already uses them; normalize unstable response payloads instead of pinning incidental fields, except where exact model-list behavior is the contract.
- Use the package's `/run-codex` skill (`.claude/skills/run-codex/`) when a change needs real Codex event observation.
- The consuming integration lives in `packages/acp-agents`; run its focused tests when changing spawn, config, permission, mode, steering, output-schema, or event behavior.

## Upstream synchronization and releases

Do **not** use this subtree's inherited release-please configuration, `release:preflight`, or standalone squash-release instructions. This monorepo releases `@automatalabs/codex-acp` through root Changesets automation.

When synchronizing upstream, use the root scripted workflow exactly:

```bash
pnpm sync:codex-acp
# resolve reviewed conflicts
pnpm sync:codex-acp --finish
pnpm sync:codex-acp --pr
```

- Never use `git subtree --squash`, squash-merge, rebase, or rewrite imported commits. The dependency gate verifies that the true upstream tip remains an ancestor.
- Preserve both upstream behavior and fork-owned integration surfaces when resolving conflicts. Constructor parameters owned by the fork remain last where the runbook requires it.
- Finish the scaffolded Changeset by hand after reviewing the actual API and behavior changes; automation must not guess SemVer impact.
- Upstream-sync PRs merge with a **merge commit**. Ordinary non-sync PRs follow the root PR policy.
