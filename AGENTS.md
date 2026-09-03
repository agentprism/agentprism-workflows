# Repository Agent Instructions

These instructions apply across this repository. A nested `AGENTS.md` may add package-specific guidance, but it does not override the root monorepo, delivery, or release rules.

## Start with the authoritative sources

Before changing code, read the relevant parts of:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development, tests, generated artifacts, dependency gates, attribution, PRs, and releases.
- [`README.md`](README.md) — product surface and package map.
- [`docs/design-notes.md`](docs/design-notes.md) — protocol and package architecture.
- [`docs/api.md`](docs/api.md) — supported integration APIs.
- [`docs/authoring/`](docs/authoring/) — canonical workflow and REPL authoring documentation shipped through MCP.
- [`docs/specs/`](docs/specs/) — implemented contracts and design records; apply the planning distinction below.

Prefer executable guards and current source over stale prose. When they disagree, investigate and update the authoritative documentation rather than coding around the discrepancy.

## Design first; do not fossilize implemented contracts

Documents under `docs/specs/` are authoritative descriptions of implemented contracts, not an untouchable architectural constitution.

- **During design and planning**, treat existing specs as current-state evidence and migration surface, not as constraints on the quality of the target design. Question whether the current architecture should be improved. Design the best coherent solution for the user's request.
- If that design conflicts with an implemented or “frozen” contract, make the conflict explicit. Explain what should be preserved, revised, superseded, or migrated, including compatibility, rollout, test, and documentation consequences. Do not silently contort a new design around an older contract, and do not silently break one.
- **During implementation**, after the design and scope are agreed, preserve contracts outside the approved change. Deliberate contract changes belong in the same implementation train as their migrations, tests, and documentation updates.
- When a task is explicitly scoped to implement or verify an already-approved frozen contract, that contract is the implementation authority for that scoped task. If following it would create a material architectural problem, stop and surface the issue instead of improvising a different contract.

The user's actual request remains the source of scope. Preserve its exact intent when creating plans, workflow prompts, issues, or derived specifications; see `CONTRIBUTING.md`’s workflow source-gate rules.

## Compatibility policy

Do not add temporary compatibility layers unless the user explicitly requests one.

- When an approved change replaces an API or contract, remove the old schema fields, aliases, parsers, runtime normalization, deprecated types, fallback behavior, tests, and documentation in the same change train.
- Do not preserve hidden acceptance paths or migration shims “just in case.” Old artifacts that cannot satisfy a new safety invariant must fail clearly rather than be guessed, silently migrated, or executed under weaker semantics.
- Explicitly supported protocol eras, wire versions, and public SDK surfaces are product contracts, not compatibility shims. Changing or removing one requires an explicit scope decision.

## Architecture and package boundaries

This is a pnpm monorepo of ten `@automatalabs/*` packages:

- `shared-types`: shared seams and wire/result types.
- `workflow-engine`: deterministic workflow execution, journaling, resume, checkpoints, and isolation.
- `acp-agents`: ACP client and backend integration for Claude, Codex, OpenCode, pi, and custom agents.
- `acp-server`: connection-pinned ACP proxy and backend-discovery server.
- `workflows`: the public SDK facade composing the engine and ACP runner.
- `repl-engine`: persistent QuickJS REPL orchestration over the same backend stack.
- `mcp-server`: MCP composition root exposing `workflow`, `repl`, and selective authoring docs.
- `pi-acp`: in-process pi ACP server.
- `codex-acp`: published fork maintained as a non-squashed upstream subtree.
- `agentprism-otel`: optional observability bridge.

Keep `workflow-engine` backend-agnostic and `acp-agents` engine-agnostic; they meet through `shared-types`. The primary runtime direction is `mcp-server → {workflows, repl-engine, shared-types}`, `acp-server → acp-agents`, `workflows → {workflow-engine, acp-agents, shared-types}`, `repl-engine → {workflows, acp-agents, shared-types}`, and `acp-agents → {codex-acp, pi-acp, shared-types}`.

For MCP server work, preserve the deliberate SDK boundary: production server code uses the split MCP SDK v2 packages, legacy 2025 and modern `2026-07-28` traffic share one implementation through era-specific transport seams, and no v1 SDK object may be passed into a v2 API. `@modelcontextprotocol/ext-apps` remains browser-build/test-side; production server code must not import its v1 server helpers.

## Development workflow

- Use Node.js 22 or newer and pnpm 10; run commands from the repository root unless package guidance says otherwise.
- Start from current `origin/main` on a branch. Do not overwrite or remove unrelated working-tree changes or untracked files.
- Install with `pnpm install`; do not use `--no-optional`, because backend native binaries are optional platform packages.
- Keep the default test suite deterministic and credential-free. Live tests stay behind their documented environment gates.
- Prefer package-focused tests while iterating, then run the repository gates before delivery:

  ```bash
  pnpm build
  pnpm typecheck
  pnpm test
  node scripts/check-acp-deps.mjs
  pnpm changeset status --since=origin/main
  ```

- The pre-push hook additionally runs attribution, dependency freshness, and real Claude/Codex/OpenCode/pi plus steering gates. It has no bypass; fix authentication or dependency failures.
- Any stale package or dependency reported by a repository update gate during any task is immediate maintenance work, not an “unrelated” caveat to leave for delivery. This applies to every dependency, runtime, adapter, source upstream, or workspace package the repository gates for currency. Pause the original delivery, open a separate update PR from current `origin/main`, follow that gate’s prescribed update and merge mechanics, land it, then update and revalidate the original branch.
- Never weaken a guard or assertion merely to make a change pass. Fix the implementation or the documented contract that the guard protects.

## Generated and coupled artifacts

Follow the complete map in `CONTRIBUTING.md`. In particular:

- `docs/authoring/**` is the source for the selective MCP `docs` tool. After editing it, run `pnpm generate:authoring-docs` and commit `packages/mcp-server/src/generated/authoring-docs-content.ts` with the source.
- `skills/agentprism-workflow-authoring/**` is the separate optional guide for non-MCP/skills-first hosts. Update it when the same contract affects those users, but do not treat it as the source of the MCP docs bundle.
- After changing a built-in backend definition, regenerate and check `scripts/acp-backends.manifest.json`; never hand-edit it.
- Dependency bumps require the welded pin fixtures, behavioral classifications, docs, and lockfile to move together.
- Treat generated Codex app-server types as generated; use the package generator and review the upstream protocol source.

## Delivery and release rules

- Commits must contain no agent attribution in either message or author/committer identity. Run `node scripts/check-attribution.mjs origin/main..HEAD` when needed.
- Add a Changeset for every published package whose artifact or behavior changes. List direct changes only; docs/CI-only work may use an empty changeset or no package release as described in `CONTRIBUTING.md`.
- Normal PRs use the repository’s required **Build & test** check and Changesets release train.
- `packages/codex-acp` upstream syncs are exceptional: preserve real upstream ancestry with the scripted non-squashed subtree merge and merge that PR with a merge commit—never squash or rebase it.
- Do not run the vendored Codex package’s upstream release-please flow. Repository releases are owned by root Changesets automation.
