# Contributing

This is a **pnpm workspace** (monorepo) of five packages under the `@automatalabs` scope. The user-facing overview is in [`README.md`](README.md); the protocol-level design is in [`docs/design-notes.md`](docs/design-notes.md).

## Prerequisites

- **Node.js ≥ 22** (`.nvmrc` pins `22`).
- **pnpm 10** (`packageManager: pnpm@10.34.4`; `corepack enable` or install pnpm directly).

## Setup

```bash
pnpm install        # installs deps, fetches backend binaries
pnpm build          # tsc -b across all packages (topological)
pnpm test           # pnpm build && pnpm -r test
pnpm typecheck      # pnpm -r exec tsc --noEmit
```

`pnpm install` does one non-obvious thing:

1. **Fetches native binaries.** Both backends pull an os/cpu-gated native binary (`@openai/codex`, `@anthropic-ai/claude-agent-sdk`). Stay on a glibc x64 runner in CI and do **not** pass `--no-optional`.

> The Codex backend's turn-level `outputSchema` forward is baked into the published `@automatalabs/codex-acp` fork (exact-pinned by `acp-agents`), so there is nothing to patch locally. See [`docs/design-notes.md` §6.3](docs/design-notes.md).

## Package layout

| Package | Role |
|---|---|
| `packages/shared-types` | The `AgentRunner` seam + shared types. |
| `packages/workflow-engine` | The deterministic engine (realm, parallel/pipeline, journal/resume, budget, worktree). |
| `packages/acp-agents` | ACP client + Claude/Codex backends (the `AgentRunner` implementation, pooling). |
| `packages/mcp-server` | The stdio MCP server / composition root (bin `agentprism-workflow`). |
| `packages/workflows` | The importable SDK facade. |

`workflow-engine` and `acp-agents` are **siblings** — neither imports the other; they meet only at the `AgentRunner` seam in `shared-types`. `workflows` is the single facade that composes them; `mcp-server` builds on `workflows`. So the dependency direction is `mcp-server → workflows → { workflow-engine, acp-agents, shared-types }`.

### Conventions

- TypeScript source resolution in-repo: each package's `exports.types` points at `./src/index.ts` for the dev build; the published manifest is overridden to `./dist` via `publishConfig` (see below). Don't repoint the top-level fields to `dist`.
- Tests use `node:test` via `tsx` (`tsx --test`). Keep the default suite deterministic and credential-free.
- The `AGENTPRISM_*` env vars, the `.agentprism/` runtime dirs, and the `agentprism-workflow` bin are a **wire/CLI contract** — they are intentionally *not* renamed with the npm scope. The ACP `_meta` extension keys are **bare** (un-namespaced): `outputSchema`, `runId`, `baseInstructions`, `developerInstructions` — exported as `META_KEYS` / `CODEX_META_KEYS` from `shared-types`. Beyond the reserved keys, workflows can send **arbitrary** `_meta` via `agent({ meta, promptMeta })` (session/new / session/prompt scoped), and **custom ACP backends** register via `AGENTPRISM_BACKENDS` or `createAcpRunner({ backends })` — see `acp-agents/src/registry.ts` and design-notes §5.9.

## Testing

`pnpm test` runs the full suite; everything except one file uses in-memory/fake ACP agents, so no credentials are needed.

The one exception is the **live-backend e2e** (`packages/mcp-server/test/live-backend.e2e.test.ts`), which drives the real Claude + Codex backends end-to-end. It is **skipped by default** and only runs when you opt in with real auth:

```bash
AGENTPRISM_LIVE_E2E=1 pnpm --filter @automatalabs/mcp-server test
```

CI must leave `AGENTPRISM_LIVE_E2E` unset.

Because CI can never run the live e2e, a **pre-push hook** (`.githooks/pre-push`, wired by the root `prepare` script via `core.hooksPath`) runs it on every `git push` from a dev machine — the only place with real agent auth. It builds the workspace and drives both real backends (~30–60s, spends real tokens). Bypass a single push with `git push --no-verify` or `AGENTPRISM_SKIP_LIVE_E2E=1 git push`; CI pushes are exempt automatically (`CI` env guard).

## Releasing

Versioning is managed with **[Changesets](https://github.com/changesets/changesets)**.

```bash
pnpm changeset        # describe your change + pick bump levels
pnpm version          # changeset version — applies bumps + changelogs (usually via the release PR)
pnpm release          # pnpm build && changeset publish (CI only)
```

Publishing runs from [`.github/workflows/release.yml`](.github/workflows/release.yml) on push to `main`, via **OIDC trusted publishing** (no long-lived npm token; SLSA provenance):

1. Check/bump the ACP protocol deps (`@agentclientprotocol/sdk`, `@agentclientprotocol/claude-agent-acp`, `@automatalabs/codex-acp`) to current before cutting a release.
2. Add a changeset (`pnpm changeset`) in your PR describing the change + bump levels, and merge it to `main`.
3. That's it — the pipeline does the rest: Changesets opens the mechanical **"Version Packages"** PR (bumps + changelogs), the workflow merges it immediately and chain-dispatches itself, and the dispatched run publishes the bumped packages via `changeset publish`. Merging a changeset-bearing PR to `main` IS the release.

The Codex `outputSchema` forward lives in the published `@automatalabs/codex-acp` fork (exact-pinned by `acp-agents`), so a change to that wire key is a **coordinated release**: publish the fork first, then bump the pinned dep. The repo is licensed Apache-2.0 (`LICENSE`).

CI (`.github/workflows/ci.yml`) runs on every PR and push: frozen install → `tsc -b` → `tsc --noEmit` → `pnpm -r test` on Node 22 / pnpm 10.
