# Contributing

This is a **pnpm workspace** (monorepo) of seven packages under the `@automatalabs` scope. The user-facing overview is in [`README.md`](README.md); the protocol-level design is in [`docs/design-notes.md`](docs/design-notes.md).

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
| `packages/acp-agents` | ACP client + Claude/Codex/OpenCode/custom backends (the `AgentRunner` implementation, pooling, auth/session lifecycle). |
| `packages/mcp-server` | The stdio MCP server / composition root (bin `agentprism-workflow`; workflow + auth tools). |
| `packages/workflows` | The importable SDK facade. |
| `packages/agentprism-otel` | Optional OpenTelemetry bridge for `WorkflowManager` events. |
| `packages/pi-acp` | Standalone in-process ACP server and library adapter for the pi coding agent. |

`workflow-engine` and `acp-agents` are **siblings** — neither imports the other; they meet only at the `AgentRunner` seam in `shared-types`. `workflows` is the single facade that composes them; `mcp-server` builds on `workflows`. So the primary dependency direction is `mcp-server → workflows → { workflow-engine, acp-agents, shared-types }`. `agentprism-otel` is an independent leaf with an `@opentelemetry/api` peer dependency; it observes the manager structurally and is not in that runtime chain.

### Conventions

- TypeScript source resolution in-repo: each package's `exports.types` points at `./src/index.ts` for the dev build; the published manifest is overridden to `./dist` via `publishConfig` (see below). Don't repoint the top-level fields to `dist`.
- Tests use `node:test` via `tsx` (`tsx --test`). Keep the default suite deterministic and credential-free.
- The `AGENTPRISM_*` env vars, the `.agentprism/` runtime dirs, and the `agentprism-workflow` bin are a **wire/CLI contract** — they are intentionally *not* renamed with the npm scope. The ACP `_meta` extension keys are **bare** (un-namespaced): `outputSchema`, `runId`, `baseInstructions`, `developerInstructions` — exported as `META_KEYS` / `CODEX_META_KEYS` from `shared-types`. Beyond the reserved keys, workflows can send **arbitrary** `_meta` via `agent({ meta, promptMeta })` (session/new / session/prompt scoped), and **custom ACP backends** register via `AGENTPRISM_BACKENDS` or `createAcpRunner({ backends })` — see `acp-agents/src/registry.ts` and design-notes §5.9.

## Testing

`pnpm test` runs the full deterministic suite without credentials. Two files contain live tests, and both are skipped unless `AGENTPRISM_LIVE_E2E=1` is set:

- `packages/mcp-server/test/live-backend.e2e.test.ts` drives real Claude, Codex, and OpenCode structured-output/pooling paths.
- `packages/acp-agents/test/auth.live.e2e.test.ts` drives the three first-class auth profiles; individual cases have additional credential/gateway gates.

Run the MCP live suite explicitly with real auth:

```bash
AGENTPRISM_LIVE_E2E=1 pnpm --filter @automatalabs/mcp-server test
```

CI must leave `AGENTPRISM_LIVE_E2E` unset.

Because CI has no agent auth, a **pre-push hook** (`.githooks/pre-push`, wired by the root `prepare` script via `core.hooksPath`) gates every `git push` from a dev machine with two checks:

1. **ACP dependency gate** (`node scripts/check-acp-deps.mjs`, also runnable standalone), three sub-checks:
   - *npm freshness*: the ACP client/agent libraries (`@agentclientprotocol/*`, `@automatalabs/codex-acp`) must match npm `latest` — policy is to bump them at every release. On failure it prints the exact `pnpm add` command per dep (preserving exact-pin vs caret style).
   - *fork git sync*: our codex-acp fork's published `main` must contain its upstream (`agentclientprotocol/codex-acp`) `main` — versions can't be compared because the fork's version line has diverged, so the check counts unmerged upstream commits. It prefers the local fork clone's `upstream` remote (`~/codex-acp`, override with `AGENTPRISM_CODEX_ACP_DIR`) and falls back to the GitHub compare API on machines without the clone (the hook passes `GITHUB_TOKEN` from `gh auth token`). On failure it prints the merge → push → `release-fork.yml` → bump sequence.
   - *wrapped runtime freshness*: an adapter can be at npm `latest` while exact-pinning a stale agent runtime inside it (e.g. `@agentclientprotocol/claude-agent-acp` wraps `@anthropic-ai/claude-agent-sdk` — the runtime that actually answers prompts), which the freshness check can't see. The gate compares the lockfile's *transitive* resolution of each wrapped runtime against the runtime's npm `latest`. Fix when behind: bump the adapter if its latest already wraps a current runtime, else add a root `pnpm.overrides` pin (then `pnpm install` + run the acp-agents live e2e before pushing). The check warns once an override becomes redundant so versions drift back to upstream-managed.

   If the registry or GitHub API is unreachable the gate warns and passes, so being offline never blocks a push. Bypass a single push with `AGENTPRISM_SKIP_ACP_DEP_CHECK=1 git push`.
2. **MCP live suite**: builds the workspace and drives Claude, Codex, and OpenCode (~60–120s, spends real tokens). The auth live suite stays separately env-gated because its provider/gateway credentials vary by developer. Bypass a single push with `AGENTPRISM_SKIP_LIVE_E2E=1 git push`.

`git push --no-verify` skips both; CI pushes are exempt automatically (`CI` env guard).

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
3. That's it — the pipeline does the rest: Changesets opens the mechanical **"Version Packages"** PR (bumps + changelogs) with the release app token, queues auto-merge on it, GitHub lands it the moment the required `Build & test` check passes, and the merge push runs the publish leg via `changeset publish`. Merging a changeset-bearing PR to `main` IS the release. (Without the `RELEASE_APP_CLIENT_ID`/`RELEASE_APP_PRIVATE_KEY` secrets the Version PR is still created but awaits a manual merge.)

The Codex `outputSchema` forward lives in the published `@automatalabs/codex-acp` fork (exact-pinned by `acp-agents`), so a change to that wire key is a **coordinated release**: publish the fork first, then bump the pinned dep. The repo is licensed Apache-2.0 (`LICENSE`).

CI (`.github/workflows/ci.yml`) runs on every PR and push: frozen install → `tsc -b` → `tsc --noEmit` → `pnpm -r test` on Node 24 / pnpm 10. `main` has an active ruleset requiring the `Build & test` check on every merge.
