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
| `packages/acp-agents` | ACP client + Claude/Codex/OpenCode/pi/custom backends (the `AgentRunner` implementation, pooling, auth/session lifecycle). |
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

`pnpm test` runs the full deterministic suite without credentials. Five files contain live tests, and all are skipped unless `AGENTPRISM_LIVE_E2E=1` is set:

- `packages/mcp-server/test/live-backend.e2e.test.ts` drives real Claude, Codex, OpenCode, and pi structured-output/pooling paths.
- `packages/acp-agents/test/auth.live.e2e.test.ts` drives the four built-in auth profiles; individual cases have additional credential/gateway gates.
- `packages/workflows/test/continuation.live.e2e.test.ts` drives a real continuation flow and additionally requires `AGENTPRISM_PI_E2E_MODEL` plus that model's provider key.
- `packages/workflows/test/isolation.live.e2e.test.ts` drives real concurrent-worktree isolation through the default backend; `AGENTPRISM_ISOLATION_E2E_MODEL` may reroute its isolated leg.
- `packages/pi-acp/test/live.e2e.test.ts` drives Pi structured output, a real HTTP MCP tool round-trip, and tracked-bash stop/reap; it additionally requires `AGENTPRISM_PI_E2E_MODEL` and that model's provider key.

Run the MCP live suite explicitly with real auth:

```bash
AGENTPRISM_LIVE_E2E=1 pnpm --filter @automatalabs/mcp-server test
```

CI must leave `AGENTPRISM_LIVE_E2E` unset.

Because CI has no agent auth, a **pre-push hook** (`.githooks/pre-push`, wired by the root `prepare` script via `core.hooksPath`) gates every `git push` from a dev machine with two checks:

1. **ACP dependency gate** (`node scripts/check-acp-deps.mjs`, also runnable standalone), three sub-checks:
   - *npm freshness*: the ACP client/agent libraries (`@agentclientprotocol/*`, `@automatalabs/codex-acp`, `@earendil-works/pi-coding-agent`) must match npm `latest` — policy is to bump them at every release. On failure it prints the exact `pnpm add` command per dep (preserving exact-pin vs caret style).
     On a pi runtime bump, re-capture `packages/pi-acp/test/fixtures/provider-error-strings.ts` and re-run the classifier suite so provider prose cannot silently change pause/retry classification.
   - *fork git sync*: our codex-acp fork's published `main` must contain its upstream (`agentclientprotocol/codex-acp`) `main` — versions can't be compared because the fork's version line has diverged, so the check counts unmerged upstream commits. It always works against a **real clone** (no API summary): the working clone (`~/codex-acp`, override with `AGENTPRISM_CODEX_ACP_DIR`) when present, otherwise a managed temp clone the gate creates at `<tmpdir>/codex-acp` and reuses (this is the CI path — public repos, no token). Either way the clone is verified and prepared first: `origin` must be the fork (`VikashLoomba/codex-acp`, matched by owner/repo so https/ssh forms both pass — read-only check, the gate never mutates a repo that isn't provably the fork); the `upstream` remote is added or re-pointed to the true upstream when wrong; both remotes are fetched; the checkout is put on `main` and pulled current (a working clone must be clean and must have no unpushed commits — releases are cut from the *pushed* fork main, so a locally-merged-but-unpushed sync still blocks). Only then are upstream commits counted against the local checkout. On failure it prints the merge → push → `release-fork.yml` → bump sequence.
   - *wrapped runtime freshness*: an adapter can be at npm `latest` while exact-pinning a stale agent runtime inside it (e.g. `@agentclientprotocol/claude-agent-acp` wraps `@anthropic-ai/claude-agent-sdk` — the runtime that actually answers prompts), which the freshness check can't see. The gate compares the lockfile's *transitive* resolution of each wrapped runtime against the runtime's npm `latest`. Fix when behind: bump the adapter if its latest already wraps a current runtime, else add a root `pnpm.overrides` pin (then `pnpm install` + run the acp-agents live e2e before pushing). The check warns once an override becomes redundant so versions drift back to upstream-managed.

   The gate **fails closed**: if the registry or GitHub API is unreachable after retries, staleness cannot be ruled out and the push is blocked. **There is no bypass.** The same gate also runs as a step of the required **Build & test** CI job — while any tracked dependency is stale, *every* PR merge is blocked — and at the top of `release.yml`, where a failure blocks versioning/publishing, leaves any open Version PR open, and files/updates a "Release blocked: ACP dependency gate failed" issue with the gate output.
2. **MCP live suite**: builds the workspace and drives Claude, Codex, OpenCode, and pi (~60–120s, spends real tokens). The auth live suite stays separately env-gated because its provider/gateway credentials vary by developer. There is no skip: if a leg fails on authentication (stalling turns usually mean an expired OAuth login), re-authenticate and push again. Legs whose default model rides limited credentials can be rerouted — not skipped — via `AGENTPRISM_OPENCODE_E2E_MODEL` / `AGENTPRISM_PI_E2E_MODEL`. On failure the hook re-prints the failing-test section (assertion + per-leg diagnostics) as the last output and keeps the full runner log at `.git/pre-push-live-e2e.log`.

CI pushes are exempt from the *hook* automatically (`CI` env guard) because CI enforces the dependency gate itself in the required job and the release workflow.

### When the dependency gate blocks

The gate failing anywhere — pre-push, a PR's required check, or the release workflow — means the same thing: a tracked upstream moved (or freshness could not be verified), so **all merges and releases are blocked; merging the maintenance PR into `main` unblocks them**. Triage in this order:

The authored backend registry generates the preinstall-safe snapshot at
`scripts/acp-backends.manifest.json`. After changing a built-in definition, regenerate and check
that snapshot before running the zero-dependency gate:

```bash
pnpm generate:acp-backends-manifest
pnpm check:acp-backends-manifest
node scripts/check-acp-deps.mjs
```

The generator/check runs after install because it imports the TypeScript registry and verifies
installed npm-server engine declarations. The final command intentionally reads only repository
JSON and Node built-ins, so it remains valid before `pnpm install`. A malformed, stale, empty, or
inconsistent manifest blocks before any network request; fix the named backend/field and regenerate
instead of editing the JSON by hand.

1. **Identify what is stale** from the gate output: an ACP library behind npm `latest`, the codex-acp fork missing upstream commits, or a wrapped runtime lagging inside a current adapter.
2. **Read the upstream changes before bumping** — the release notes/changelog, and for substantial jumps the source diff of the surfaces we integrate against. Decide which of three shapes this is:
   - *Mechanical*: no cited surface changed — bump the pin (for the codex-acp fork: follow "The codex-acp fork leg" under Releasing below — merge upstream, push, the fork **auto-releases**, then bump the pin here), `pnpm install`, add a changeset, run the full suite plus the live e2e.
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

## Generated artifacts and the doc-sync map

When you change a source-of-truth surface, regenerate/update its dependents **in the same PR**. Guard tests fail loudly naming each file, but this is the full map so nothing has to be discovered by failure:

- **Authoring skill → MCP `author-workflow` prompt.** `skills/agentprism-workflow-authoring/**` is the single source of truth. After ANY edit there, run `pnpm generate:authoring-prompt` (alias for `node scripts/generate-authoring-prompt.mjs`) to regenerate `packages/mcp-server/src/generated/authoring-prompt-content.ts`, and commit both together. The drift test (`packages/mcp-server/test/authoring-prompt.test.ts`) fails whenever the skill and the generated file disagree. The generator throws on missing rewrite markers — including SKILL.md's hand-maintained `<!-- guide-index:begin/end -->` block — rather than shipping dangling pointers.
- **Installed skills do not track this repo.** Consumers — including dev machines driving this repo with coding agents — install the skill via `npx skills add VikashLoomba/agentprism-workflows` ([skills.sh](https://skills.sh)), which copies it under `~/.agents/skills/` (Claude Code reads it through a `~/.claude/skills/` symlink). After merging skill changes to `main`, **re-run that install on each machine**: a stale installed copy keeps teaching agents retired contracts. The root `skills-lock.json` is the skills.sh lockfile for *third-party* skills installed INTO this repo; it is unrelated to publishing ours.
- **Backend registry → gate manifest.** After changing a built-in backend definition: `pnpm generate:acp-backends-manifest` then `pnpm check:acp-backends-manifest` (see the dependency-gate runbook above). Never hand-edit `scripts/acp-backends.manifest.json`.
- **Dependency pins → welded tests and docs.** A dependency bump moves, at minimum: the exact-pin map in `packages/pi-acp/test/packaging.test.ts`; `FIXTURE_PI_PIN` plus the cited fixture strings in `packages/pi-acp/test/fixtures/provider-error-strings.ts` (re-verify each string against the new version's installed dists before advancing the pin); `@earendil-works/pi-agent-core` in pi-acp's devDependencies, which moves in lockstep with the pi runtime **even though the gate output does not list it**; installed-version citations in `docs/api.md` and `docs/design-notes.md`; and the version in the `docs/specs/acp-auth-spec.md` §3.3 Codex heading. The docs-drift suite (`packages/acp-agents/test/docs-drift.test.ts`) also welds the event-name tables (the workflows and acp-agents READMEs plus `docs/api.md`), the mcp-server README contract tokens, and this file's own package inventory. Fix what the guards name; never loosen a guard to make an edit pass.
- **Post-publish smoke for the coordinated Pi/MCP train.** After a release that touches the pi-acp ↔ mcp-server wiring, run `node scripts/smoke-pi-mcp-release.mjs`: it installs the just-published **public** artifacts into a fresh directory (workspace links cannot satisfy it) and exercises the train end to end. It is not wired into CI — running it is part of release verification for that train.

## Releasing

All `@automatalabs/*` packages are versioned with **[Semantic Versioning](https://semver.org)**: **patch** = fixes that change no documented behavior, **minor** = backward-compatible additions or behavior changes, **major** = a break in the documented contract. Versioning is managed with **[Changesets](https://github.com/changesets/changesets)** — a changeset records which packages a PR changes and which SemVer bump each deserves. Merging a changeset-bearing PR to `main` **IS** the release — everything after that merge is automation. This section is the complete path from unstaged changes to published npm packages; a person or agent following it needs nothing that isn't written here or in the files it names.

The three root scripts (you normally run only the first; CI runs the others):

```bash
pnpm changeset        # describe your change + pick bump levels
pnpm version          # changeset version — applies bumps + changelogs (runs inside the Version Packages PR)
pnpm release          # pnpm build && changeset publish (runs in release.yml's publish leg)
```

### End to end: unstaged changes → npm

0. **Preconditions** (once per machine): Node ≥ 22 + pnpm 10, `pnpm install` run at the root (this wires the pre-push hook via the `prepare` script's `core.hooksPath`); `gh` authenticated; the agent CLIs logged in for the pre-push live e2e (Claude Code, Codex, OpenCode, pi — see Testing above); optionally a codex-acp fork clone at `~/codex-acp` (the dependency gate manages its own temp clone when absent).
1. **Branch** off current `origin/main`. `main` is protected by a ruleset requiring the `Build & test` check, so all work lands by PR.
2. **Verify locally against the exact CI bar**:

   ```bash
   pnpm -r exec tsc -b               # build — CI invokes tsc directly, NOT package build scripts
   pnpm -r exec tsc --noEmit         # typecheck
   pnpm -r test                      # AGENTPRISM_LIVE_E2E stays unset, exactly like CI
   node scripts/check-acp-deps.mjs   # the dependency gate — when red, see the runbook above
   ```

   Guard tests are executable documentation: on a dependency bump, the pin-contract tests (`packages/pi-acp/test/packaging.test.ts`, `packages/pi-acp/test/fixtures/provider-error-strings.ts`) and the docs-drift tests (`packages/acp-agents/test/docs-drift.test.ts`) fail loudly, naming every file that must move with the bump. Fix what they name; never loosen them. The complete inventory of generated artifacts and welded doc surfaces lives in "Generated artifacts and the doc-sync map" above.
3. **Add a changeset** — `pnpm changeset`, selecting every package whose *published artifact or behavior* changes, with the semver bump each deserves. Workspace dependents are bumped automatically at version time (`updateInternalDependencies: "patch"` in `.changeset/config.json`), so list direct changes only. Check yourself with `pnpm changeset status --since=origin/main`: it previews exactly which packages will release, and it **errors** when packages changed but no changeset covers them (use `pnpm changeset add --empty` to deliberately release nothing). No changeset ⇒ merging releases nothing (correct for docs/CI-only PRs).
4. **Push** — the pre-push hook (Testing above) runs the dependency gate and the live 4-backend e2e (~60–120 s, real tokens, no bypass).
5. **Open the PR and merge it** — the required check is `Build & test` (that exact string — the ruleset matches it verbatim). `gh pr merge --squash --auto` is the normal path.
6. **Automation takes over on the push to `main`** ([`release.yml`](.github/workflows/release.yml); its header comments are the authoritative mechanics):
   - The dependency gate runs FIRST and fails closed: a red gate files/updates a **"Release blocked: ACP dependency gate failed"** issue, comments on any open Version PR, and nothing versions or publishes until a maintenance PR lands (runbook above).
   - `changesets/action` opens/updates the mechanical **"Version Packages"** PR (bumps + changelogs) with the release app token and queues auto-merge; GitHub lands it the moment its own `Build & test` check passes.
   - That merge push re-runs `release.yml`, whose publish leg (`pnpm release` = `pnpm build && changeset publish`) publishes every bumped package via **npm OIDC trusted publishing** (no npm token; SLSA provenance). This requires a trusted publisher configured on npmjs.com for each `@automatalabs/*` package pointing at this repo + `.github/workflows/release.yml`.
   - **Manual fallback**: without the `RELEASE_APP_CLIENT_ID`/`RELEASE_APP_PRIVATE_KEY` secrets the Version PR is still created (plain `GITHUB_TOKEN`) but auto-merge is not queued — a human merges it, and that merge still triggers the publish leg.
7. **Verify it shipped** — every release, no exceptions:

   ```bash
   gh run list --workflow=release.yml --branch=main --limit 3   # your merge's run AND the publish-leg run both green
   gh pr list --search "Version Packages in:title" --state all --limit 3   # the Version PR is MERGED
   npm view @automatalabs/<pkg> version                         # matches what the merged Version PR gave that package
   ```

   Registry propagation can lag a minute or two — retry before concluding failure. A Version PR sitting OPEN with green checks and no auto-merge queued means the app secrets are absent or broken → merge it manually (step 6's fallback). A failed release run with a red gate → the "Release blocked" issue carries the gate output; follow the runbook above. For a release touching the pi-acp ↔ mcp-server wiring, additionally run the post-publish smoke: `node scripts/smoke-pi-mcp-release.mjs` (doc-sync map above).

### The codex-acp fork leg (when the dependency gate demands it)

`@automatalabs/codex-acp` releases from its own repo (`VikashLoomba/codex-acp`), **automatically**: pushing fork `main` with green CI fires its `release-fork.yml` (bump size inferred from commit subjects since the last tag; its `workflow_dispatch` exists only for explicit bump overrides and dry runs), which tags, creates the GitHub release, and chain-dispatches `publish-oidc.yml` to publish to npm. There is no manual trigger to pull on the happy path. The full sequence:

1. In `~/codex-acp`: `git fetch upstream main && git merge upstream/main` — resolve the recurring `package.json`/`package-lock.json` version+description conflict in the **fork's** favor (its version line is independent of upstream's), sanity-build, and `git push origin main`. The gate requires the clone to be clean **and pushed** — a locally-merged-but-unpushed sync still blocks.
2. Watch `gh run list --repo VikashLoomba/codex-acp` until CI → `Release (fork)` → `Publish (OIDC)` are all green, then confirm `npm view @automatalabs/codex-acp version` advanced.
3. Bump the exact pin in `packages/acp-agents/package.json` to that new version as part of the same maintenance PR here (never a separate later PR — the gate compares the pin against npm `latest`).

The Codex `outputSchema` forward lives in that fork (exact-pinned by `acp-agents`), so any change to that wire key is a **coordinated release**: publish the fork first, then bump the pinned dep. The repo is licensed Apache-2.0 (`LICENSE`).

CI (`.github/workflows/ci.yml`) runs on every PR and push: frozen install → `tsc -b` → `tsc --noEmit` → `pnpm -r test` on Node 24 / pnpm 10. `main` has an active ruleset requiring the `Build & test` check on every merge.
