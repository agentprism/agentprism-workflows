export const meta = {
  name: 'acp-auth-implementation',
  description: 'Implement the frozen ACP auth contract (docs/specs/acp-auth-spec.md) as 7 independently-green stacked PRs: error taxonomy, client advertisement, AuthStore lifecycle, engine pause-for-auth, MCP tools, SDK exports, per-agent profiles + codex fork patch',
  whenToUse: 'When the ACP auth spec contract review is signed off and the auth train should be built. Sequential: each PR phase implements, adversarially verifies against the spec, and fix-loops to green before the next begins.',
  phases: [
    { title: 'Preflight', detail: 'clean main, spec present, re-locate spec seams in CURRENT code (line drift), idempotence check' },
    { title: 'PR1', detail: 'error taxonomy: code-only -32000 matcher + structured authContext + isAuthRequired chain (§1.5)' },
    { title: 'PR2', detail: 'client auth advertisement, default-OFF (§1.2)' },
    { title: 'PR3', detail: 'core: AuthStore/BackendAuthMachine, replay-after-initialize, recycle/drain, resolver + runner auth API, conformance fixture (§1.3, §2, §4.1)' },
    { title: 'PR4', detail: 'engine pause-for-auth + cold-resume re-arm from persisted diskBacked (§2.12, §2.13)' },
    { title: 'PR5', detail: 'MCP auth tools: status/authenticate/logout + facade type re-exports it needs (§4.3)' },
    { title: 'PR6', detail: 'SDK exports: auth types + isAuthRequired value through the facade (§4.2)' },
    { title: 'PR7', detail: 'per-agent profiles (equal), codex DEFAULT_AUTH_REQUEST spawn channel + mid-turn -32000 fork release, _meta tripwire, live e2e (§3, §2.8, §3.6)' },
    { title: 'Integrate', detail: 'full workspace build + every package suite on the stacked tip; live e2e when env allows' },
    { title: 'Deliver', detail: 'checkpoint, then push all branches (one pre-push gate) + open stacked draft PRs' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const SPEC = `${REPO}/docs/specs/acp-auth-spec.md`
const FORK = '/home/vikash/codex-acp'
const MAX_FIX_ROUNDS = 2

// Defensive args parse (args can arrive as a JSON string on some launch paths).
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})

const PRINCIPLES = `NON-NEGOTIABLE PRINCIPLES (the spec encodes these; hold the line when in doubt):
1. EQUAL FIRST-CLASS INTEGRATIONS — Codex, OpenCode, Claude get identical treatment; never privilege one. The base layer must work for a spec-conformant CUSTOM agent with ZERO agent-specific code; per-agent extensions are pure-data profiles on top.
2. DEFAULT-OFF — a host that sets neither onAuth nor authCapabilities gets byte-identical behavior to today. Every phase must keep the existing suites green untouched.
3. SECRETS — credential material (API keys, gateway headers, authenticate _meta, env values) never appears in logs, events, journals, run results, or error messages.
4. NO DEFERRED WORK — zero TODOs / "future" / weakened assertions for agreed scope. If the spec is genuinely ambiguous or the CURRENT code contradicts it, STOP that item and record a precise question in deviations rather than guessing.
5. The spec is the FROZEN CONTRACT: docs/specs/acp-auth-spec.md. Its file:line cites were taken when written and MAY BE STALE — trust names/behavior and re-locate; never blind-apply a line number.`

const DOD = `DEFINITION OF DONE (strict): every change ships with tests that ACTUALLY RUN GREEN — no .skip on the default suite, no trivially-true assertions, no as-any/@ts-ignore to force a pass. Run the touched packages' full suites AND \`pnpm -r build\` before reporting. Add ONE changeset naming exactly the packages whose src/ changed (the consumer-without-source npm trap is real). Update docs/api.md where the public surface changes and keep the docs-drift test green (it pins version citations in docs/api.md AND docs/design-notes.md). Commit on the phase branch with a conventional message ending in "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Do NOT push — the Deliver phase pushes once. You cannot spawn subagents; do all work yourself, work through files/git, and return ONLY the structured report (never dump diffs into your final message).`

// Distilled from spec §4.7 — ORIENTATION ONLY; the spec sections are the authoritative scope.
const PR_DEFS = [
  { n: 1, branch: 'auth/pr1-error-taxonomy', title: 'error taxonomy + structured authContext', sections: '§1.5 (plus the isAuthRequired re-export chain named in §4.2/§4.7)',
    scope: 'packages/acp-agents/src/errors-map.ts (code-only -32000 matcher; AuthErrorContext -> non-secret authContext on AUTH_REQUIRED), packages/shared-types/src/errors.ts (+isAuthRequired beside isProviderUsageLimit), packages/workflow-engine/src/errors.ts shared-types re-export block AND packages/workflow-engine/src/index.ts named re-export block (+isAuthRequired in BOTH or PR6 cannot build), tests in packages/shared-types/test/errors.test.ts + packages/acp-agents/test/errors-map.test.ts. Behavior-preserving: the three first-class agents already emit -32000 with the English message.' },
  { n: 2, branch: 'auth/pr2-advertisement', title: 'client auth capability advertisement (default-OFF)', sections: '§1.2',
    scope: 'packages/acp-agents/src/client-handlers.ts (ClientCapabilities.auth derived from host-provided authCapabilities; the auth key is OMITTED entirely when unset), capabilities.ts, acp-client.ts initialize thread, pool.ts, runner.ts (AcpRunnerOptions.authCapabilities), protocol-coverage.ts drift-shape assertion, client-handlers/protocol-coverage tests.' },
  { n: 3, branch: 'auth/pr3-core-lifecycle', title: 'AuthStore + lifecycle + resolver + runner auth API (core correctness)', sections: '§1.3, ALL of §2, §4.1',
    scope: 'NEW packages/acp-agents/src/auth/{auth-types,auth-store}.ts (AuthIntent + credential klasses incl. agent-live, AuthResolution incl. agent-login, BackendAuthMachine w/ generation stamps, single per-runner AuthStore), acp-client.ts (authenticate replay after EVERY initialize, spawn env overlay, ConnectionAuthStamp/reapply-when-stale), pool.ts (generation-gated selectConnection + recycle + drain), runner.ts (buildAuthDescriptors/describeAuthMethods, completeAuth + shared applyResolution incl. the one-shot agent-live RPC on a live connection, runner.auth controller, onAuth inline resolve-and-retry-once at BOTH the session/new and mid-session/prompt trip points, rebuild legacy authenticate()/logout() off dispose-after-authenticate), NEW fixture test/fixtures/fake-auth-agent.mjs (profile-less conformance agent: one method of each type + a bare agent method, -32000 until authed, in-process gateway, spawn-env creds, logout), tests: auth-descriptors, auth-store, auth.integration (the §4.6.2 scenario list), auth-secrets, and update auth-providers.integration. Unset onAuth/authCapabilities => byte-identical (prove it: existing suites untouched).' },
  { n: 4, branch: 'auth/pr4-engine-pause', title: 'engine pause-for-auth + cold-resume re-arm', sections: '§2.12, §2.13',
    scope: 'packages/workflow-engine/src/workflow-manager.ts (generalize the PROVIDER_USAGE_LIMIT pause branch: AUTH_REQUIRED pauses with reason "auth_required" + non-secret authContext), run-persistence.ts (persist authContext incl. the diskBacked boolean; cold-resume re-arm decided PURELY from persisted state — the engine never imports acp-agents), shared-types errors/workflow-result carry-through, tests: auth-pause + run-persistence.' },
  { n: 5, branch: 'auth/pr5-mcp-tools', title: 'MCP server auth tools', sections: '§4.3 (+ the §4.2 note on which type re-exports land HERE so this PR compiles)',
    scope: 'packages/mcp-server/src/server.ts + NEW auth-tool-io.ts + auth-resolver.ts: workflow_auth_status (read-only, redacted, enumerates backends when arg omitted), workflow_authenticate (env/meta inputs go straight to completeAuth and NEVER echo into content/logs; interactive browser-only methods return cancelled + an explanation, never a no-op), workflow_auth_logout. Move the @automatalabs/workflows auth TYPE re-exports needed for compilation into this PR (packages/workflows/src/index.ts). Tests: packages/mcp-server/test/auth-tools.test.ts incl. secret-redaction.' },
  { n: 6, branch: 'auth/pr6-sdk-exports', title: 'SDK facade exports', sections: '§4.2',
    scope: 'packages/workflows/src/index.ts: remaining auth type re-exports + the isAuthRequired VALUE re-export (resolves through the PR1 workflow-engine chain). No new behavior; compile + export-surface tests.' },
  { n: 7, branch: 'auth/pr7-profiles-fork', title: 'per-agent profiles + codex fork lever + tripwires + live e2e', sections: '§3 (ALL of it, equal depth per agent), §2.8, §3.6',
    scope: 'NEW packages/acp-agents/src/auth/auth-profiles.ts (claude/codex/opencode PURE-DATA profiles; custom backends have NO profile and run the base flow — that absence is the conformance contract), backend.ts authProfile? seam + one-line wiring in the three built-in backends, codexAuthProfile.spawnAuthEnv -> the DEFAULT_AUTH_REQUEST spawn channel (upstream env var, verified in the fork dist), the codex-acp FORK change (mid-turn auth failures emit RequestError.authRequired/-32000 regardless of authConfigured): implement in ' + FORK + ' on MAIN (the release branch — automatalabs branch is retired), release via the "Publish (OIDC)" workflow_dispatch and bump the dep here (mirror the 1.4.1 flow; the spec mentions a pnpm-patch channel — no patchedDependencies exist today, so the fork-release channel is correct; record this deviation), protocol-coverage/docs-drift _meta-matrix assertions per §3.6, permissions.ts PermissionResolver.persist?, and the env-gated auth.live.e2e.test.ts covering ALL THREE first-class agents equally. Fork dep bump => update version cites in docs/api.md AND docs/design-notes.md (docs-drift).' },
]

const IMPL_SCHEMA = { type: 'object', additionalProperties: false, required: ['branch', 'baseBranch', 'commitShas', 'filesChanged', 'testsAdded', 'testsPass', 'workspaceBuildOk', 'changesetAdded', 'deviations', 'notes'], properties: {
  branch: { type: 'string' }, baseBranch: { type: 'string' },
  commitShas: { type: 'array', items: { type: 'string' } },
  filesChanged: { type: 'array', items: { type: 'string' } },
  testsAdded: { type: 'number' }, testsPass: { type: 'boolean' }, workspaceBuildOk: { type: 'boolean' },
  changesetAdded: { type: 'boolean' },
  deviations: { type: 'array', items: { type: 'string' }, description: 'every place the CURRENT code contradicted the spec and what you did about it — never silently improvise' },
  notes: { type: 'string' } } }

const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict', 'issues', 'summary'], properties: {
  verdict: { type: 'string', enum: ['pass', 'blocking'] },
  issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'problem', 'fix'], properties: {
    severity: { type: 'string', enum: ['blocking', 'minor'] }, file: { type: 'string' },
    problem: { type: 'string', description: 'the defect, with the spec requirement it violates quoted or tightly cited' },
    fix: { type: 'string', description: 'the complete concrete correction — never a placeholder or a reference to text not included here' } } } },
  summary: { type: 'string' } } }

const INTEG_SCHEMA = { type: 'object', additionalProperties: false, required: ['buildOk', 'suites', 'liveE2e', 'failures', 'notes'], properties: {
  buildOk: { type: 'boolean' },
  suites: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pkg', 'tests', 'pass'], properties: { pkg: { type: 'string' }, tests: { type: 'number' }, pass: { type: 'boolean' } } } },
  liveE2e: { type: 'string', enum: ['green', 'skipped-no-env', 'failed'] },
  failures: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }

const DELIVER_SCHEMA = { type: 'object', additionalProperties: false, required: ['pushed', 'prUrls', 'notes'], properties: {
  pushed: { type: 'boolean' }, prUrls: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }

// ---------- Preflight ----------
phase('Preflight')
const preflight = await agent(
  `Preflight for the ACP auth implementation train in ${REPO}.\n` +
  `1. Assert git status is CLEAN and the checkout is on main, pulled up to date — else STOP and say why.\n` +
  `2. Assert ${SPEC} exists and its §4.7 lists PR1..PR7 — else STOP.\n` +
  `3. LINE-DRIFT MEMO: the spec's file:line cites predate recent merges (e.g. the session hand-off feature touched runner.ts/pool.ts/acp-client.ts/workflow-manager.ts). For each load-bearing seam the spec names — clientCapabilitiesFor, negotiateCapabilities, PooledConnection initialize/releaseSession, pool selectConnection/recycle-candidates, runner run()/authenticate()/logout()/createDedicatedConnection, errors-map isAcpAuthRequired, workflow-manager PROVIDER_USAGE_LIMIT pause branch, run-persistence PersistedRunState, mcp-server registerTool — report its CURRENT file + line-range and one sentence on anything structurally different from how the spec describes it.\n` +
  `4. IDEMPOTENCE: report any auth/pr* branches or packages/acp-agents/src/auth/ dir that already exist (a previous partial run) — list them; do not delete anything.\n` +
  `Return the memo as plain text (keep it under ~200 lines).`,
  { label: 'preflight', phase: 'Preflight', model: 'opus' }
)
if (!preflight || /STOP/i.test(preflight.slice(0, 200))) throw new Error('preflight failed: ' + String(preflight).slice(0, 500))

// ---------- PR phases ----------
const reports = []
let baseBranch = 'main'
for (const pr of PR_DEFS) {
  const phaseTitle = `PR${pr.n}`
  phase(phaseTitle)

  const implPrompt = `You are implementing ${phaseTitle} of the ACP auth train: ${pr.title}.\n\n` +
    `CONTRACT: read ${SPEC} sections ${pr.sections} IN FULL before writing code (Read the file; it is large — read the named sections completely, plus §1.1 and the glossary once for shared vocabulary).\n\n` +
    `SCOPE ORIENTATION (spec is authoritative; this is the §4.7 distillation):\n${pr.scope}\n\n` +
    `LINE-DRIFT MEMO from preflight (current locations of the seams the spec cites):\n${preflight}\n\n` +
    `GIT: create branch ${pr.branch} off ${baseBranch} in ${REPO} (git checkout -b ${pr.branch} ${baseBranch} after checking out ${baseBranch}). All commits on that branch.\n\n` +
    PRINCIPLES + '\n\n' + DOD
  const impl = await agent(implPrompt, { label: `impl:${phaseTitle}`, phase: phaseTitle, model: 'opus', effort: 'high', schema: IMPL_SCHEMA })
  if (!impl) throw new Error(`${phaseTitle}: implementer died`)
  if (!impl.testsPass || !impl.workspaceBuildOk) throw new Error(`${phaseTitle} not green: ${impl.notes}`)
  if (impl.deviations.length > 0) log(`${phaseTitle} deviations: ${impl.deviations.join(' | ')}`)

  const verifyCommon = `Adversarially verify ${phaseTitle} (${pr.title}) of the ACP auth train.\n` +
    `The diff: git -C ${REPO} diff ${baseBranch}..${pr.branch} (read it fully; also Read changed files for context).\n` +
    `The contract: ${SPEC} sections ${pr.sections}.\n` +
    `Implementer's report: ${JSON.stringify(impl)}\n` +
    `Report ONLY defects you can evidence; an empty issues list is a valid outcome. Every fix field must be complete and self-contained.\n`
  const lenses = [
    ['spec-conformance', 'LENS: SPEC CONFORMANCE. Walk the named spec sections requirement by requirement; every MUST/shape/semantic either appears in the diff (cite where) or is a blocking issue. Also flag anything the diff does that the spec does NOT sanction (scope creep breaks the frozen contract). Check the equal-first-class and custom-agent-conformance obligations specifically.'],
    ['quality', 'LENS: QUALITY & REGRESSION. Do the new tests actually pin the contract (would they fail if the behavior regressed)? Any weakened/removed existing assertions, .skip, as-any, TODO/deferred language, secrets reaching logs/events/journals/messages, resume-hash widening (a new option entering hashAgentCall), or default-ON behavior change for hosts that configured nothing? Run the touched packages\' suites yourself to confirm green.'],
  ]
  let verdicts = await parallel(lenses.map(([key, lens]) => () =>
    agent(verifyCommon + lens, { label: `verify:${phaseTitle}:${key}`, phase: phaseTitle, model: 'opus', effort: 'high', schema: VERIFY_SCHEMA })))

  for (let round = 1; ; round++) {
    const blocking = verdicts.filter(Boolean).flatMap((v) => v.issues).filter((i) => i.severity === 'blocking')
    if (blocking.length === 0) break
    if (round > MAX_FIX_ROUNDS) throw new Error(`${phaseTitle}: ${blocking.length} blocking issues after ${MAX_FIX_ROUNDS} fix rounds: ${blocking.map((i) => i.problem).join(' | ').slice(0, 800)}`)
    log(`${phaseTitle}: fixing ${blocking.length} blocking issues (round ${round})`)
    const fixed = await agent(
      `Fix EVERY blocking issue below on branch ${pr.branch} in ${REPO} (verify each fix claim against the spec ${SPEC} ${pr.sections} before applying; if a "fix" is wrong, do the RIGHT fix and say so in notes). Re-run the touched packages' suites + pnpm -r build to green, amend or add commits on the branch.\n` +
      `ISSUES:\n${JSON.stringify(blocking, null, 2)}\n\n` + PRINCIPLES + '\n\n' + DOD,
      { label: `fix:${phaseTitle}:r${round}`, phase: phaseTitle, model: 'opus', effort: 'high', schema: IMPL_SCHEMA })
    if (!fixed || !fixed.testsPass || !fixed.workspaceBuildOk) throw new Error(`${phaseTitle} fix round ${round} not green`)
    verdicts = await parallel(lenses.map(([key, lens]) => () =>
      agent(verifyCommon + `NOTE: fix round ${round} applied: ${JSON.stringify(fixed.notes)}. Re-verify from scratch.\n` + lens,
        { label: `reverify:${phaseTitle}:${key}:r${round}`, phase: phaseTitle, model: 'opus', effort: 'high', schema: VERIFY_SCHEMA })))
  }

  reports.push({ pr: pr.n, branch: pr.branch, base: baseBranch, impl })
  log(`${phaseTitle} green on ${pr.branch}`)
  baseBranch = pr.branch
}

// ---------- Integrate ----------
phase('Integrate')
const integ = await agent(
  `Integration check of the full auth train in ${REPO}: checkout ${baseBranch} (the stacked tip).\n` +
  `1. pnpm -r build.\n2. Run EVERY package's test suite (shared-types, acp-agents, workflow-engine, workflows, mcp-server, agentprism-otel); report per-package counts.\n` +
  `3. Live e2e: if the environment has real agent auth (try the repo's env-gated live suite the way .githooks/pre-push does, plus the new auth.live.e2e.test.ts), run it once and report; if the env lacks agent auth, report "skipped-no-env" — do NOT fake it.\n` +
  `4. Confirm zero TODO/deferred-work language in the diff main..${baseBranch} and that every PR branch has a changeset.\nDo not commit anything.`,
  { label: 'integrate', phase: 'Integrate', model: 'opus', effort: 'high', schema: INTEG_SCHEMA })
if (!integ || !integ.buildOk || integ.suites.some((s) => !s.pass) || integ.liveE2e === 'failed') {
  throw new Error('integration not green: ' + JSON.stringify(integ && integ.failures))
}

// ---------- Deliver ----------
phase('Deliver')
// Human gate WITHOUT a checkpoint primitive: the first invocation builds and stops here;
// after review, re-invoke with args {deliver: true} + resumeFromRunId — every phase above
// replays from cache and only this Deliver phase runs live.
if (A.deliver !== true) {
  log(`auth train green (${integ.suites.reduce((a, s) => a + s.tests, 0)} tests, live e2e: ${integ.liveE2e}) — re-run with args {deliver:true} to push + open the stacked draft PRs`)
  return { status: 'built-not-delivered', branches: reports.map((r) => r.branch), integ }
}

const deliver = await agent(
  `Deliver the auth train from ${REPO}:\n` +
  `1. Push all branches in ONE command so the pre-push gate runs once: git push origin ${PR_DEFS.map((p) => p.branch).join(' ')}\n` +
  `2. Open 7 DRAFT PRs with gh, STACKED: PR1 base main; PR N base = PR N-1's branch. Title from the branch; body = a distilled summary of that phase's implementer report (below) + "Implements docs/specs/acp-auth-spec.md <sections>" + the standard "🤖 Generated with [Claude Code](https://claude.com/claude-code)" footer.\n` +
  `Reports: ${JSON.stringify(reports.map((r) => ({ pr: r.pr, branch: r.branch, base: r.base, files: r.impl.filesChanged.length, testsAdded: r.impl.testsAdded, notes: r.impl.notes })))}\n` +
  `Return the PR URLs.`,
  { label: 'deliver', phase: 'Deliver', model: 'opus', schema: DELIVER_SCHEMA })

return { status: 'delivered', prUrls: deliver ? deliver.prUrls : [], branches: reports.map((r) => r.branch), integ }
