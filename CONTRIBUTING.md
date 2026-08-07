# Contributing

This is a **pnpm workspace** (monorepo) of nine packages under the `@automatalabs` scope. The user-facing overview is in [`README.md`](README.md); the protocol-level design is in [`docs/design-notes.md`](docs/design-notes.md).

## Prerequisites

- **Node.js ≥ 22** (`.nvmrc` pins `22`).
- **pnpm 10** (`packageManager: pnpm@10.34.4`; `corepack enable` or install pnpm directly).

## Setup

```bash
pnpm install        # installs deps, fetches backend binaries
pnpm build          # per-package builds, topological (tsc -b; esbuild for codex-acp)
pnpm test           # pnpm build && pnpm -r test
pnpm typecheck      # pnpm -r exec tsc --noEmit
```

`pnpm install` does one non-obvious thing:

1. **Fetches native binaries.** Both backends pull an os/cpu-gated native binary (`@openai/codex`, `@anthropic-ai/claude-agent-sdk`). Stay on a glibc x64 runner in CI and do **not** pass `--no-optional`.

> The Codex backend's turn-level `outputSchema` forward is baked into the workspace `@automatalabs/codex-acp` package (`packages/codex-acp`, consumed by `acp-agents` as `workspace:*`), so there is nothing to patch locally. See [`docs/design-notes.md` §6.3](docs/design-notes.md).

## Package layout

| Package | Role |
|---|---|
| `packages/shared-types` | The `AgentRunner` seam + shared types. |
| `packages/workflow-engine` | The deterministic engine (realm, parallel/pipeline, journal/resume, budget, worktree). |
| `packages/acp-agents` | ACP client + Claude/Codex/OpenCode/pi/custom backends (the `AgentRunner` implementation, pooling, auth/session lifecycle). |
| `packages/mcp-server` | The stdio MCP server / composition root (bin `agentprism-workflow`; the `workflow` and `repl` tools — no auth tools). |
| `packages/workflows` | The importable SDK facade. |
| `packages/agentprism-otel` | Optional OpenTelemetry bridge for `WorkflowManager` events. |
| `packages/repl-engine` | The REPL orchestrator engine: persistent JS REPL in a QuickJS-in-WASM VM (workspace lifecycle, eval + job drain, per-VM memory limits, per-eval interrupts). |
| `packages/pi-acp` | Standalone in-process ACP server and library adapter for the pi coding agent. |
| `packages/codex-acp` | Our codex-acp fork (full upstream history, non-squashed subtree): the ACP server the Codex backend spawns. |

`workflow-engine` and `acp-agents` are **siblings** — neither imports the other; they meet only at the `AgentRunner` seam in `shared-types`. `workflows` is the single facade that composes them; `mcp-server` builds on `workflows`. So the primary dependency direction is `mcp-server → workflows → { workflow-engine, acp-agents, shared-types }`. `agentprism-otel` is an independent leaf with an `@opentelemetry/api` peer dependency; it observes the manager structurally and is not in that runtime chain. `repl-engine` is **not** a leaf: it composes the `quickjs-wasi` shim with `workflows`, `acp-agents`, and `shared-types`, and its `repl` MCP tool is registered in `mcp-server` (which depends on `repl-engine`) — the `repl-orchestrator` roadmap phase is implemented (`docs/roadmap/repl-orchestrator.md`), though the package itself is unreleased at `0.0.0`.

### Conventions

- TypeScript source resolution in-repo: each package's `exports.types` points at `./src/index.ts` for the dev build; the published manifest is overridden to `./dist` via `publishConfig` (see below). Don't repoint the top-level fields to `dist`.
- Tests use `node:test` via `tsx` (`tsx --test`). Keep the default suite deterministic and credential-free.
- The `AGENTPRISM_*` env vars, the `.agentprism/` runtime dirs, and the `agentprism-workflow` bin are a **wire/CLI contract** — they are intentionally *not* renamed with the npm scope. The ACP `_meta` extension keys are **bare** (un-namespaced): `outputSchema`, `runId`, `baseInstructions`, `developerInstructions` — exported as `META_KEYS` / `CODEX_META_KEYS` from `shared-types`. Beyond the reserved keys, workflows can send **arbitrary** `_meta` via `agent({ meta, promptMeta })` (session/new / session/prompt scoped), and **custom ACP backends** register via `AGENTPRISM_BACKENDS` or `createAcpRunner({ backends })` — see `acp-agents/src/registry.ts` and design-notes §5.9.

## Testing

`pnpm test` runs the full deterministic suite without credentials. Six files contain live tests, and all are skipped unless `AGENTPRISM_LIVE_E2E=1` is set:

- `packages/mcp-server/test/live-backend.e2e.test.ts` drives real Claude, Codex, OpenCode, and pi structured-output/pooling paths; `packages/acp-agents/test/steering.live.e2e.test.ts` drives native held-open `_session/steering` for real Claude and Codex.
- `packages/acp-agents/test/auth.live.e2e.test.ts` drives the four built-in auth profiles; individual cases have additional credential/gateway gates.
- `packages/workflows/test/continuation.live.e2e.test.ts` drives a real continuation flow and additionally requires `AGENTPRISM_PI_E2E_MODEL` plus that model's provider key.
- `packages/workflows/test/isolation.live.e2e.test.ts` drives real concurrent-worktree isolation through the default backend; `AGENTPRISM_ISOLATION_E2E_MODEL` may reroute its isolated leg.
- `packages/pi-acp/test/live.e2e.test.ts` drives Pi structured output, a real HTTP MCP tool round-trip, and tracked-bash stop/reap; it additionally requires `AGENTPRISM_PI_E2E_MODEL` and that model's provider key.

Run the pre-push live backend and steering gate explicitly with real auth:

```bash
AGENTPRISM_LIVE_E2E=1 npx tsx --test \
  packages/mcp-server/test/live-backend.e2e.test.ts \
  packages/acp-agents/test/steering.live.e2e.test.ts
```

CI must leave `AGENTPRISM_LIVE_E2E` unset.

Because CI has no agent auth, a **pre-push hook** (`.githooks/pre-push`, wired by the root `prepare` script via `core.hooksPath`) gates every `git push` from a dev machine with three checks:

1. **Attribution gate** (`node scripts/check-attribution.mjs`, also runnable standalone) over the commits actually being pushed — see "No agent attribution in the history" below.
2. **ACP dependency gate** (`node scripts/check-acp-deps.mjs`, also runnable standalone), three sub-checks:
   - *npm freshness*: the ACP client/agent libraries (`@agentclientprotocol/*`, `@earendil-works/pi-coding-agent`) must match npm `latest` — policy is to bump them at every release. On failure it prints the exact `pnpm add` command per dep (preserving exact-pin vs caret style).
     On a pi runtime bump, re-capture `packages/pi-acp/test/fixtures/provider-error-strings.ts` and re-run the classifier suite so provider prose cannot silently change pause/retry classification.
   - *source-upstream containment*: the workspace fork `packages/codex-acp` must CONTAIN its upstream (`agentclientprotocol/codex-acp`) `main` — versions can't be compared because the fork's version line has diverged, so the gate fetches the canonical upstream ref into THIS repository and requires `git merge-base --is-ancestor <upstream tip> HEAD`. Sync policy is merge, never rebase or squash, so ancestry is the exact invariant: a non-squashed subtree merge satisfies it, and a squash or rewritten import can never fake it (new SHAs make the true upstream tip unreachable from HEAD). On failure it names the remediation: open/refresh the upstream-sync PR — `git subtree merge` (NO `--squash`) of upstream `main` into `packages/codex-acp` — review the upstream changes, add a `@automatalabs/codex-acp` changeset, and merge.
   - *wrapped runtime freshness*: an adapter can be at npm `latest` while exact-pinning a stale agent runtime inside it (e.g. `@agentclientprotocol/claude-agent-acp` wraps `@anthropic-ai/claude-agent-sdk` — the runtime that actually answers prompts), which the freshness check can't see. The gate compares the lockfile's *transitive* resolution of each wrapped runtime against the runtime's npm `latest`. Fix when behind: bump the adapter if its latest already wraps a current runtime, else add a root `pnpm.overrides` pin (then `pnpm install` + run the acp-agents live e2e before pushing). The check warns once an override becomes redundant so versions drift back to upstream-managed.

   The gate **fails closed**: if the registry or GitHub API is unreachable after retries, staleness cannot be ruled out and the push is blocked. **There is no bypass.** The same gate also runs as a step of the required **Build & test** CI job — while any tracked dependency is stale, *every* PR merge is blocked — and at the top of `release.yml`, where a failure blocks versioning/publishing, leaves any open Version PR open, and files/updates a "Release blocked: ACP dependency gate failed" issue with the gate output.
3. **MCP live suite + native steering smoke**: builds the workspace and drives Claude, Codex, OpenCode, and pi (~60–120s, spends real tokens), then verifies real Claude and Codex top-level steering advertisement and a held-open `_session/steering` call. The auth live suite stays separately env-gated because its provider/gateway credentials vary by developer. There is no skip: if a leg fails on authentication (stalling turns usually mean an expired OAuth login), re-authenticate and push again. Legs whose default model rides limited credentials can be rerouted — not skipped — via `AGENTPRISM_OPENCODE_E2E_MODEL` / `AGENTPRISM_PI_E2E_MODEL`. On failure the hook re-prints the failing-test section (assertion + per-leg diagnostics) as the last output and keeps the full runner log at `.git/pre-push-live-e2e.log`.

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

## No agent attribution in the history

Commits in this repo carry **no Claude attribution**, on either of two axes, and there is no bypass for first-party commits:

- **Message** — no `Claude-Session:` trailers, no `claude.ai/code` links, no Claude co-author trailers, no "Generated with Claude Code" banners.
- **Identity** — no commit whose *author* or *committer* is an agent identity (an `@anthropic.com` address, or a name beginning `Claude`).

**Imported third-party history is the one recorded exception** (owner decision, 2026-07-28, for the #282 codex-acp fold-in). Non-squashed subtree imports carry upstream contributors' and pre-policy fork commits whose messages we neither wrote nor may rewrite — rewriting upstream commits would break the upstream-ancestry containment invariant the import exists to preserve. `scripts/attribution-foreign-heads.json` records the tip SHA of each imported history; the gate exempts only commits *reachable from a recorded head*. The import and sync merge commits themselves are first-party and stay fully gated, and the allowlist grows only via a reviewed PR that merges that exact history. Identity cannot express this exemption: GitHub's web-flow committer (`noreply@github.com`) appears on both our squash merges and upstream's, so only ancestry separates their history from ours.

The identity axis is not cosmetic, and it is the one that is easy to miss. GitHub composes a squash-merge message from the branch's commit messages **and synthesizes a `Co-authored-by:` trailer for every distinct author identity among them** (this repo uses `squash_merge_commit_message=COMMIT_MESSAGES`). So a single branch commit authored under an agent identity — a cloud-session commit, say, where the committer is you but the author is not — puts a co-author trailer on `main` even though no branch commit message ever contained one, generated server-side where no local hook can reach it. That is exactly how it happened once (`fc50fae`, #297): the message-only `commit-msg` hook was already in place and had nothing to catch.

`scripts/check-attribution.mjs` owns both axes and the pattern list, and runs in **three** places:

| Where | Scope | Blocks |
|---|---|---|
| `.githooks/commit-msg` | the pending message + the identity git is about to stamp | the commit |
| `.githooks/pre-push` | the commits actually being pushed (exact range from git's stdin; a new branch falls back to "not already on origin", after a refresh) | the push |
| **Build & test** CI job | the PR's `base..head` | the **merge** — the only enforcement point that runs *before* the squash button |

Run it standalone over any range: `node scripts/check-attribution.mjs origin/main..HEAD`.

**Fixing a flagged commit** — rewrite it, then force-push the branch:

```bash
git rebase origin/main --exec 'git commit --amend --no-edit --reset-author'  # re-stamp identity
git rebase -i origin/main                                                    # reword a message
```

`--reset-author` re-stamps the commit with your configured `user.name` / `user.email`. If a *cloud or agent session* produced the commit, fix the identity it commits under rather than rewriting after the fact each time. On a push to `main` the CI gate still runs (over the newly-pushed commits) — too late to block, but a loud tripwire that clears itself on the next merge.

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
- **Installed skills do not track this repo.** Consumers — including dev machines driving this repo with coding agents — install the skill via `npx skills add agentprism/agentprism-workflows --global --yes` ([skills.sh](https://skills.sh)), which copies it under `~/.agents/skills/` (Claude Code reads it through a `~/.claude/skills/` symlink). Keep the explicit global flag: inside a project, the CLI otherwise defaults to that project's ignored `.agents/skills/` copy instead of updating the user-level installation. After merging skill changes to `main`, **re-run that install on each machine**: a stale installed copy keeps teaching agents retired contracts. The root `skills-lock.json` is the skills.sh lockfile for *third-party* skills installed INTO this repo; it is unrelated to publishing ours.
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

### The codex-acp upstream-sync leg (when the dependency gate demands it)

`@automatalabs/codex-acp` lives in this monorepo at `packages/codex-acp` — our fork of `agentclientprotocol/codex-acp`, imported with its full history as a **non-squashed subtree** (#282) — and releases through the ordinary Changesets train like every other package. When the gate reports the package behind its upstream, the fix is one sync PR:

1. `git fetch https://github.com/agentclientprotocol/codex-acp.git main`, then merge it into `packages/codex-acp` with `git subtree merge --prefix=packages/codex-acp` (or `git merge -X subtree=packages/codex-acp`) — **never `--squash`, never a rebase**: the gate verifies real ancestry, and a squashed or rewritten import can never satisfy it. Resolve the recurring `package.json` version/metadata conflict in the **fork's** favor (its version line is independent of upstream's).
2. Review the upstream changes, run the codex-acp suite (`pnpm --filter @automatalabs/codex-acp test`) and the acp-agents live e2e, and add an explicit `@automatalabs/codex-acp` changeset — automation must not guess the bump size.
3. Merge the sync PR; the normal release train versions and publishes the package with everything else. Imported upstream commits are exempt from the attribution gate via `scripts/attribution-foreign-heads.json` — record the merged upstream tip there in the same PR.

The Codex `outputSchema` forward lives in `packages/codex-acp` (consumed by `acp-agents` as `workspace:*`, published as an exact version), so any change to that wire key ships atomically with the adapter in one release. The package is licensed Apache-2.0 (`packages/codex-acp/LICENSE`).

CI (`.github/workflows/ci.yml`) runs on every PR and push: frozen install → `pnpm build` (per-package builds — `tsc -b` for the TypeScript project references, esbuild for `packages/codex-acp`) → `tsc --noEmit` → `pnpm -r test` on Node 24 / pnpm 10. `main` has an active ruleset requiring the `Build & test` check on every merge.
