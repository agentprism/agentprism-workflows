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
   - *npm freshness*: the ACP client/agent libraries (`@agentclientprotocol/*`, `@automatalabs/codex-acp`, `@earendil-works/pi-coding-agent`) must match npm `latest` — policy is to bump them at every release. On failure it prints the exact `pnpm add` command per dep (preserving exact-pin vs caret style).
   - *fork git sync*: our codex-acp fork's published `main` must contain its upstream (`agentclientprotocol/codex-acp`) `main` — versions can't be compared because the fork's version line has diverged, so the check counts unmerged upstream commits. It always works against a **real clone** (no API summary): the working clone (`~/codex-acp`, override with `AGENTPRISM_CODEX_ACP_DIR`) when present, otherwise a managed temp clone the gate creates at `<tmpdir>/codex-acp` and reuses (this is the CI path — public repos, no token). Either way the clone is verified and prepared first: `origin` must be the fork (`VikashLoomba/codex-acp`, matched by owner/repo so https/ssh forms both pass — read-only check, the gate never mutates a repo that isn't provably the fork); the `upstream` remote is added or re-pointed to the true upstream when wrong; both remotes are fetched; the checkout is put on `main` and pulled current (a working clone must be clean and must have no unpushed commits — releases are cut from the *pushed* fork main, so a locally-merged-but-unpushed sync still blocks). Only then are upstream commits counted against the local checkout. On failure it prints the merge → push → `release-fork.yml` → bump sequence.
   - *wrapped runtime freshness*: an adapter can be at npm `latest` while exact-pinning a stale agent runtime inside it (e.g. `@agentclientprotocol/claude-agent-acp` wraps `@anthropic-ai/claude-agent-sdk` — the runtime that actually answers prompts), which the freshness check can't see. The gate compares the lockfile's *transitive* resolution of each wrapped runtime against the runtime's npm `latest`. Fix when behind: bump the adapter if its latest already wraps a current runtime, else add a root `pnpm.overrides` pin (then `pnpm install` + run the acp-agents live e2e before pushing). The check warns once an override becomes redundant so versions drift back to upstream-managed.

   The gate **fails closed**: if the registry or GitHub API is unreachable after retries, staleness cannot be ruled out and the push is blocked. **There is no bypass.** The same gate also runs as a step of the required **Build & test** CI job — while any tracked dependency is stale, *every* PR merge is blocked — and at the top of `release.yml`, where a failure blocks versioning/publishing, leaves any open Version PR open, and files/updates a "Release blocked: ACP dependency gate failed" issue with the gate output.
2. **MCP live suite**: builds the workspace and drives Claude, Codex, OpenCode, and pi (~60–120s, spends real tokens). The auth live suite stays separately env-gated because its provider/gateway credentials vary by developer. There is no skip: if a leg fails on authentication (stalling turns usually mean an expired OAuth login), re-authenticate and push again. Legs whose default model rides limited credentials can be rerouted — not skipped — via `AGENTPRISM_OPENCODE_E2E_MODEL` / `AGENTPRISM_PI_E2E_MODEL`. On failure the hook re-prints the failing-test section (assertion + per-leg diagnostics) as the last output and keeps the full runner log at `.git/pre-push-live-e2e.log`.

CI pushes are exempt from the *hook* automatically (`CI` env guard) because CI enforces the dependency gate itself in the required job and the release workflow.

### When the dependency gate blocks

The gate failing anywhere — pre-push, a PR's required check, or the release workflow — means the same thing: a tracked upstream moved (or freshness could not be verified) and **all merges and releases stay blocked until a maintenance PR lands on `main`**. Triage in this order:

1. **Identify what is stale** from the gate output: an ACP library behind npm `latest`, the codex-acp fork missing upstream commits, or a wrapped runtime lagging inside a current adapter.
2. **Read the upstream changes before bumping** — the release notes/changelog, and for substantial jumps the source diff of the surfaces we integrate against. Decide which of three shapes this is:
   - *Mechanical*: no cited surface changed — bump the pin (or merge upstream into the fork and cut a fork release), `pnpm install`, add a changeset, run the full suite plus the live e2e.
   - *Upstream broke or changed our integration surface*: adapt the agentprism packages to the new API as part of the same PR — the bump and the adaptation land together, never a pin held back to avoid the work.
   - *Upstream added capability we should exploit*: land the mechanical bump first to unblock the gate, and file an issue for the capability work so it is tracked, not lost.
3. **Land the maintenance PR** — its own CI passes because its tree carries the fixed pins, which is exactly why a stale gate never wedges the repo: the fix PR is always mergeable. Once it merges, every blocked PR unblocks on rebase/re-run, and the next push to `main` versions and publishes normally.

## Workflow launches carry the user's verbatim request (source gate)

Agent-driven development in this repo runs through AgentPrism workflows, and the highest-leverage failure observed to date is not inside any workflow — it is the seam **between the user's request and the prose the driving agent writes into the workflow's prompts**. Once a paraphrase or a silently narrowed scope enters at authoring time, every downstream gate faithfully verifies against the authored framing (spec, brief, frozen contract) rather than the request, and the error is amplified instead of caught.

That seam now has a deterministic gate: a Claude Code `PreToolUse` hook (`.claude/settings.json` → `scripts/hooks/workflow-source-gate.mjs`) intercepts every `workflow` tool **run** and blocks it unless `args.sourceRequest` (string or `string[]`) carries the user's request sentences and each one is found — whitespace-normalized, role-verified — in a **genuine user-authored turn** of this project's session transcripts (current session first, then the 100 most recent). Agent-authored text structurally cannot pass: assistant records, tool results, sidechain (subagent) prompts, `isMeta` records, the compaction summary (which quotes user sentences but is agent-authored), and machine-injected spans (`<system-reminder>`, command wrappers) are all excluded from the search space. No transcript ⇒ fails closed. `inspect`/`await`/`stop` are ungated. There is no bypass.

The gate verifies **authenticity, not relevance** — choosing the right sentences and honoring them is the launcher's contract:

1. Quote the exact request sentence(s) the workflow serves, including scope-bearing follow-ups from the conversation (e.g. a later "I want it to be a first class backend" belongs next to the original ask). Over-inclusion is cheap; selection bias is the failure mode.
2. Before launching, reconcile the script's prompts against the quoted source: remove additions the user never asked for, restore pieces the prompts dropped, and put every genuine ambiguity to the user as a binary question — *"Your request was: ⟨verbatim X⟩. The workflow says: ⟨Y⟩. Correct?"* — while corrections are still free.
3. Propagate the quote: derived artifacts (issues, specs, briefs, focus files) carry the verbatim source block so later stages — and later workflow launches — re-anchor to what the user said, not to the previous derivation. Avoid interpolating `sourceRequest` into `agent()` prompt strings unless intended: prompts are replay-identity-hashed, focus files are not.

Tests: `packages/mcp-server/test/workflow-source-gate.test.ts` (hermetic fixture transcripts covering every provenance trap).

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
