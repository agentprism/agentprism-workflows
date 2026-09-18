# Repository Agent Instructions

These instructions apply across this repository. A nested `AGENTS.md` may add package-specific guidance, but it does not override the root monorepo, delivery, or release rules.

## Start here

Before changing code, read the relevant parts of:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development, tests, generated artifacts, dependency gates, attribution, PRs, and releases.
- [`README.md`](README.md) — product surface and package map.
- [`docs/api.md`](docs/api.md) — supported integration APIs.
- [`docs/authoring/`](docs/authoring/) — canonical workflow authoring documentation shipped through MCP.

Then read the code. The source and its tests are the current state; prose describes it and never governs it. When prose and code disagree, fix the prose.

`docs/archive/` holds historical design records from past implementation trains. They are not maintained, not an authority, and may be wrong. Do not read them unless the user points you at one.

## Existing implementations are not the design authority

Design from first principles for the user's request. The current code, its tests, and its docs describe what exists, not what must remain. Changing existing architecture, contracts, and the tests that enshrine them is expected whenever it produces a better outcome.

- Read the code, not a description of it, before proposing a design.
- Never treat a document, a test, or an existing structure as a reason to reject or contort a better design. The only fixed constraints are the user's request, the package dependency direction below, the compatibility policy below, and published SDK and wire surfaces, which need an explicit scope decision to change.
- When you change something that was previously documented or tested as a contract, say so plainly in the plan and the PR: what changed, why, and what was migrated. Land the migration, tests, and docs in the same change.
- Nothing in this repository is "frozen". A task that says "implement this document" still requires you to check it against the code and first principles, and to raise problems rather than build them.

The user's actual request remains the source of scope. Preserve its exact intent when creating plans, workflow prompts, or issues; see `CONTRIBUTING.md`'s workflow source-gate rules.

## Compatibility policy

Do not add temporary compatibility layers unless the user explicitly requests one.

- When an approved change replaces an API or contract, remove the old schema fields, aliases, parsers, runtime normalization, deprecated types, fallback behavior, tests, and documentation in the same change train.
- Do not preserve hidden acceptance paths or migration shims “just in case.” Old artifacts that cannot satisfy a new safety invariant must fail clearly rather than be guessed, silently migrated, or executed under weaker semantics.
- Explicitly supported protocol eras, wire versions, and public SDK surfaces are product contracts, not compatibility shims. Changing or removing one requires an explicit scope decision.

## Architecture and package boundaries

This is a pnpm monorepo of nine `@automatalabs/*` packages:

- `shared-types`: shared seams and wire/result types.
- `workflow-engine`: deterministic workflow execution, journaling, resume, checkpoints, and isolation.
- `acp-agents`: ACP client and backend integration for Claude, Codex, OpenCode, pi, and custom agents.
- `acp-server`: connection-pinned ACP proxy and backend-discovery server.
- `workflows`: the public SDK facade composing the engine and ACP runner.
- `mcp-server`: MCP composition root exposing `workflow`, the Apps-capable `workflow_monitor`, and SEP-2640 authoring skills.
- `pi-acp`: in-process pi ACP server.
- `codex-acp`: published fork maintained as a non-squashed upstream subtree.
- `agentprism-otel`: optional observability bridge.

Keep `workflow-engine` backend-agnostic and `acp-agents` engine-agnostic; they meet through `shared-types`. The primary runtime direction is `mcp-server → {workflows, shared-types}`, `acp-server → acp-agents`, `workflows → {workflow-engine, acp-agents, shared-types}`, and `acp-agents → {codex-acp, pi-acp, shared-types}`.

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
- Any stale package or dependency reported by a repository update gate during any task is immediate maintenance work, not an “unrelated” caveat to leave for delivery. This applies to every dependency, runtime, adapter, source upstream, or workspace package the repository gates for currency. Pause the original delivery, open a separate update PR from current `origin/main`, follow that gate’s prescribed update and merge mechanics, land it, then update and revalidate the original branch. Do this proactively and without stopping to ask: this policy pre-authorizes opening, pushing, and merging that maintenance PR, and a stale gate is never a reason to halt the original delivery or hand it back unfinished.
- Never weaken a guard or assertion merely to make a change pass. Deleting or inverting a test because the behavior it protects is being deliberately redesigned is expected; name it in the PR.

## Generated and coupled artifacts

Follow the complete map in `CONTRIBUTING.md`. In particular:

- `docs/authoring/**` contains the canonical Agent Skills served by the MCP Skills Extension. Commit `packages/mcp-server/src/generated/authoring-skills-content.ts` with source changes; `pnpm build` refreshes it through the shared ensure step, and `pnpm generate:authoring-skills` is available for explicit regeneration.
- After changing a built-in backend definition, regenerate and check `scripts/acp-backends.manifest.json`; never hand-edit it.
- Dependency bumps require the welded pin fixtures, behavioral classifications, docs, and lockfile to move together.
- Treat generated Codex app-server types as generated; use the package generator and review the upstream protocol source.

## Delivery and release rules

- Commits must contain no agent attribution in either message or author/committer identity. Run `node scripts/check-attribution.mjs origin/main..HEAD` when needed.
- Add a Changeset for every published package whose artifact or behavior changes. List direct changes only; docs/CI-only work may use an empty changeset or no package release as described in `CONTRIBUTING.md`.
- Normal PRs use the repository’s required **Build & test** check and Changesets release train.
- `packages/codex-acp` upstream syncs are exceptional: preserve real upstream ancestry with the scripted non-squashed subtree merge and merge that PR with a merge commit—never squash or rebase it.
- Do not run the vendored Codex package’s upstream release-please flow. Repository releases are owned by root Changesets automation.
