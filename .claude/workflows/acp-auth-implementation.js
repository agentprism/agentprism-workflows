export const meta = {
  name: 'acp-auth-implementation',
  description: 'Implement the frozen ACP auth contract (docs/specs/acp-auth-spec.md) as 7 independently-green stacked PRs: error taxonomy, client advertisement, AuthStore lifecycle, engine pause-for-auth, MCP tools, SDK exports, per-agent profiles',
  whenToUse: 'When the ACP auth spec contract review is signed off and the auth train should be built. Sequential: each PR phase implements, adversarially verifies against the spec, and fix-loops to green before the next begins. First run stops at built-not-delivered; re-run with args {deliver:true} + resumeFromRunId to push + open the stacked draft PRs. Recovery: a phase whose IMPLEMENTER reported not-green re-runs live via args {reimpl:{"PR5":"1"}} after you repair or delete its branch; a phase stuck after its FIX rounds re-verifies live via args {reverify:{"PR3":"1"}} after manual repair. Any reimpl/reverify token, once used, must be re-supplied VERBATIM on every later resume of this train (including the {deliver:true} run), and every resume must target the MOST RECENT run id.',
  phases: [
    { title: 'Preflight', detail: 'read-only: clean main == origin/main, spec present, re-locate spec seams in CURRENT code (line drift), stale-state check' },
    { title: 'PR1', detail: 'error taxonomy: code-first -32000 matcher + guarded prose fallback + structured authContext + isAuthRequired chain (§1.5)' },
    { title: 'PR2', detail: 'client auth advertisement, default-OFF (§1.2)' },
    { title: 'PR3', detail: 'core: AuthStore/BackendAuthMachine, replay-after-initialize, recycle/drain, resolver + runner auth API, conformance fixture (§1.3, §2, §4.1)' },
    { title: 'PR4', detail: 'engine pause-for-auth + §2.13 cold-resume re-arm via duck-typed runner.auth.canResume (§2.12, §2.13)' },
    { title: 'PR5', detail: 'MCP auth tools (status + authenticate) + the §4.2 type re-exports they need (§4.3)' },
    { title: 'PR6', detail: 'SDK exports: the isAuthRequired value through the facade (§4.2)' },
    { title: 'PR7', detail: 'per-agent profiles (equal), codex DEFAULT_AUTH_REQUEST spawn channel, _meta tripwire, live e2e (§3, §2.8, §3.6)' },
    { title: 'Integrate', detail: 'full workspace build + every package suite on the stacked tip; live e2e when env allows; TODO + changeset sweep' },
    { title: 'Deliver', detail: 'args-gated: push all branches (one pre-push gate, never bypassed) + open stacked draft PRs' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const SPEC = `${REPO}/docs/specs/acp-auth-spec.md`
const MAX_FIX_ROUNDS = 2
const EXPECTED_PKGS = ['shared-types', 'acp-agents', 'workflow-engine', 'workflows', 'mcp-server', 'agentprism-otel']

// Defensive args parse (args can arrive as a JSON string on some launch paths).
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
// Recovery salts. Each busts the resume cache from ITS call onward (longest-unchanged-prefix
// rule): a reimpl token re-runs that phase's implementer and everything after it; a reverify
// token re-runs that phase's verifiers and everything after them. Safe ONLY for the phase the
// prior run died in (downstream work was never cached). Once used, re-supply verbatim forever.
const REIMPL = A.reimpl && typeof A.reimpl === 'object' ? A.reimpl : {}
const REVERIFY = A.reverify && typeof A.reverify === 'object' ? A.reverify : {}

const PRINCIPLES = `NON-NEGOTIABLE PRINCIPLES (the spec encodes these; hold the line when in doubt):
1. EQUAL FIRST-CLASS INTEGRATIONS — Codex, OpenCode, Claude get identical treatment; never privilege one. The base layer must work for a spec-conformant CUSTOM agent with ZERO agent-specific code; per-agent extensions are pure-data profiles on top.
2. DEFAULT-OFF — a host that sets neither onAuth nor authCapabilities gets byte-identical behavior to today. Every phase must keep the existing suites green untouched.
3. SECRETS — credential material (API keys, gateway headers, authenticate _meta, env values) never appears in logs, events, journals, run results, or error messages.
4. NO DEFERRED WORK — zero TODOs / "future" / weakened assertions for agreed scope. If the spec is genuinely ambiguous or the CURRENT code contradicts it, STOP that item and record a precise question in deviations rather than guessing.
5. The spec is the FROZEN CONTRACT: docs/specs/acp-auth-spec.md. Its file:line cites were taken when written and MAY BE STALE — trust names/behavior and re-locate; never blind-apply a line number.
6. ALL WORK STAYS IN THIS REPOSITORY — never touch, push to, or open issues/PRs against any other repository.`

const DOD = `DEFINITION OF DONE (strict): every change ships with tests that ACTUALLY RUN GREEN — no .skip on the default suite, no trivially-true assertions, no as-any/@ts-ignore to force a pass. Run the touched packages' full suites AND \`pnpm -r build\` before reporting. Add ONE changeset naming exactly the packages whose src/ changed (the consumer-without-source npm trap is real). Update docs/api.md where the public surface changes and keep the docs-drift test green (it pins version citations in docs/api.md AND docs/design-notes.md). Commit on the phase branch with a conventional message ending in "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Do NOT push — the Deliver phase pushes once. You cannot spawn subagents; do all work yourself, work through files/git, and return ONLY the structured report (never dump diffs into your final message).`

// Distilled from spec §4.7 — ORIENTATION ONLY; the spec sections are the authoritative scope.
// Each phase's contract also includes its entries in §4.6 (test plan): the mandated per-PR
// test matrices are part of the frozen contract, for implementers AND verifiers alike.
const PR_DEFS = [
  { n: 1, branch: 'auth/pr1-error-taxonomy', title: 'error taxonomy + structured authContext', sections: '§1.5 (plus the isAuthRequired re-export chain: §4.2 value-export paragraph names the PR1 workflow-engine edits)', effortHigh: true,
    scope: 'packages/acp-agents/src/errors-map.ts (the §1.5 matcher: code-first -32000 primary PLUS the guarded prose fallback — non-reserved code + the authentication-required phrase; -32603 and the other OTHER_RESERVED codes never classify as auth; AuthErrorContext -> non-secret authContext on AUTH_REQUIRED), packages/shared-types/src/errors.ts (+isAuthRequired beside isProviderUsageLimit), packages/workflow-engine/src/errors.ts shared-types re-export block AND packages/workflow-engine/src/index.ts named re-export block (+isAuthRequired in BOTH or PR6 cannot build), tests in packages/shared-types/test/errors.test.ts + packages/acp-agents/test/errors-map.test.ts pinning the full §4.6.1 truth table (-32000+English, -32000+localized/non-English -> auth; -32603+"authentication required" -> NOT auth; non-reserved code + phrase -> auth). Behavior-preserving for the three first-class agents.' },
  { n: 2, branch: 'auth/pr2-advertisement', title: 'client auth capability advertisement (default-OFF)', sections: '§1.2', effortHigh: false,
    scope: 'packages/acp-agents/src/client-handlers.ts (ClientCapabilities.auth derived from host-provided authCapabilities; the auth key is OMITTED entirely when unset; lighting auth.terminal also sets top-level _meta["terminal-auth"]), capabilities.ts, acp-client.ts initialize thread, pool.ts, runner.ts (AcpRunnerOptions.authCapabilities), protocol-coverage.ts drift-shape assertion, client-handlers/protocol-coverage tests incl. the §4.6.1 gating matrix.' },
  { n: 3, branch: 'auth/pr3-core-lifecycle', title: 'AuthStore + lifecycle + resolver + runner auth API (core correctness)', sections: '§1.3, ALL of §2, §4.1', effortHigh: true,
    scope: 'NEW packages/acp-agents/src/auth/{auth-types,auth-store}.ts (AuthIntent with the three §2.1 credential klasses — disk / in-process / spawn-env — classified from method type + _meta shape; AuthResolution incl. the agent-login variant, §2.9; BackendAuthMachine w/ generation stamps; single per-runner AuthStore), acp-client.ts (authenticate replay after EVERY initialize, spawn env overlay, ConnectionAuthStamp/reapply-when-stale), pool.ts (generation-gated selectConnection + recycle + drain), runner.ts (buildAuthDescriptors/describeAuthMethods per §1.3 incl. the literal _meta.gateway / _meta["terminal-auth"] convention keys; completeAuth + shared applyResolution incl. the one-shot agent-login authenticate RPC on a live connection; runner.auth controller incl. canResume; onAuth inline resolve-and-retry-once at the run() session-acquisition seam per §2.11, with mid-turn -32000 handled by §1.5 classification + the §2.3 authenticated->auth_required transition; rebuild legacy authenticate()/logout() off dispose-after-authenticate), NEW fixture test/fixtures/fake-auth-agent.mjs (profile-less conformance agent per §3.5), tests: auth-descriptors, auth-store, auth-secrets, auth.integration covering exactly the §4.6.2 scenario list for this file (the engine-seam pause/cold-resume scenarios are §4.6.2-assigned to the PR4 workflow-engine tests, not this PR), and update auth-providers.integration. Unset onAuth/authCapabilities => byte-identical (prove it: existing suites untouched).' },
  { n: 4, branch: 'auth/pr4-engine-pause', title: 'engine pause-for-auth + cold-resume re-arm', sections: '§2.12, §2.13', effortHigh: true,
    scope: 'packages/workflow-engine/src/workflow-manager.ts (generalize the PROVIDER_USAGE_LIMIT pause branch: AUTH_REQUIRED pauses with reason "auth_required" + non-secret authContext; resume() per §2.13 consults runner.auth.canResume(persisted.authContext.backendId) — a duck-typed runtime consult on the injected runner, NOT a package import — and immediately re-pauses with the re-supply message when false), run-persistence.ts (persist pauseReason + the non-secret authContext only, per §2.14), shared-types errors/workflow-result carry-through, tests per §4.6: packages/workflow-engine/test/auth-pause.test.ts (new) + run-persistence.test.ts (extend) incl. the no-resolver pause/persist/resume and diskBacked cold-resume scenarios §4.6.2 assigns to this PR.' },
  { n: 5, branch: 'auth/pr5-mcp-tools', title: 'MCP server auth tools', sections: '§4.3, plus the §4.2 sequencing note (the type re-exports land in this PR so the tools compile)', effortHigh: false,
    scope: 'packages/mcp-server/src/server.ts + NEW auth-tool-io.ts + auth-resolver.ts: the TWO tools §4.3 defines — workflow_auth_status (read-only, redacted, enumerates backends when arg omitted) and workflow_authenticate (env/meta inputs go straight to completeAuth and NEVER echo into content/logs; interactive browser-only methods return cancelled + an explanation, never a no-op). createWorkflowServer(runner) signature unchanged; auth tools registered only when the runner duck-types as auth-capable. Also packages/workflows/src/index.ts: the §4.2 auth TYPE re-exports (per the §4.2 sequencing note these land here — mcp-server imports them through the facade and cannot compile otherwise). Tests per §4.6: packages/mcp-server/test/auth-tools.test.ts incl. secret-redaction and the stub-runner-gets-workflow-tool-only case.' },
  { n: 6, branch: 'auth/pr6-sdk-exports', title: 'SDK facade exports', sections: '§4.2', effortHigh: false,
    scope: 'packages/workflows/src/index.ts: the isAuthRequired VALUE re-export (resolves through the PR1 workflow-engine chain; the §4.2 type re-exports landed with PR5 per the §4.2 sequencing note). No new behavior; compile + export-surface tests.' },
  { n: 7, branch: 'auth/pr7-profiles', title: 'per-agent profiles + spawn channel + tripwires + live e2e', sections: '§3 (ALL of it, equal depth per agent), §2.8, §3.6', effortHigh: true,
    scope: 'NEW packages/acp-agents/src/auth/auth-profiles.ts (claude/codex/opencode PURE-DATA profiles; custom backends have NO profile and run the base flow — that absence is the conformance contract), backend.ts authProfile? seam + one-line wiring in the three built-in backends, codexAuthProfile.spawnAuthEnv -> the DEFAULT_AUTH_REQUEST spawn channel (an existing agent-side env var consumed client-side; verified in the installed dist), protocol-coverage/docs-drift _meta-matrix assertions per §3.6, permissions.ts (PermissionResolver.persist?), and the env-gated auth.live.e2e.test.ts covering ALL THREE first-class agents equally per §4.6. Everything in this PR is client-side code in THIS repository.' },
]

const PREFLIGHT_SCHEMA = { type: 'object', additionalProperties: false, required: ['ok', 'blockers', 'existingAuthBranches', 'memo'], properties: {
  ok: { type: 'boolean', description: 'true ONLY if every check passed: clean tree, main == origin/main, spec present with §4.7 PR1..PR7, and NO stale auth state (auth/pr* branches or packages/acp-agents/src/auth/)' },
  blockers: { type: 'array', items: { type: 'string' }, description: 'every reason ok is false, precisely stated (stale auth state counts as a blocker)' },
  existingAuthBranches: { type: 'array', items: { type: 'string' }, description: 'the stale auth/pr* branches / auth dir found, if any (informational; also listed in blockers)' },
  memo: { type: 'string', description: 'the line-drift memo: current file+line-range per seam + structural deltas. MUST be complete in this one field — it is embedded verbatim in every implementer prompt — and MUST fit in a single message' } } }

const IMPL_SCHEMA = { type: 'object', additionalProperties: false, required: ['branch', 'baseBranch', 'commitShas', 'filesChanged', 'testsAdded', 'testsPass', 'workspaceBuildOk', 'changesetAdded', 'deviations', 'notes'], properties: {
  branch: { type: 'string', description: 'the branch all commits landed on — must be exactly the assigned phase branch' },
  baseBranch: { type: 'string', description: 'the branch this phase was cut from' },
  commitShas: { type: 'array', items: { type: 'string' } },
  filesChanged: { type: 'array', items: { type: 'string' }, description: 'repo-relative paths' },
  testsAdded: { type: 'number', description: 'count of NEW test cases (it() blocks / test() calls) added by this phase' },
  testsPass: { type: 'boolean', description: 'true ONLY if every touched package suite ran green just now' },
  workspaceBuildOk: { type: 'boolean', description: 'true ONLY if pnpm -r build succeeded just now' },
  changesetAdded: { type: 'boolean' },
  deviations: { type: 'array', items: { type: 'string' }, description: 'every place the CURRENT code contradicted the spec and what you did about it — never silently improvise' },
  notes: { type: 'string' } } }

const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict', 'issues', 'summary'], properties: {
  verdict: { type: 'string', enum: ['pass', 'blocking'] },
  issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'problem', 'fix'], properties: {
    severity: { type: 'string', enum: ['blocking', 'minor'] }, file: { type: 'string' },
    problem: { type: 'string', description: 'the defect, with the spec requirement it violates quoted or tightly cited' },
    fix: { type: 'string', description: 'the complete concrete correction, self-contained in THIS field — never a reference to text elsewhere' } } } },
  summary: { type: 'string' } } }

const INTEG_SCHEMA = { type: 'object', additionalProperties: false, required: ['buildOk', 'suites', 'liveE2e', 'todoFree', 'changesetsOk', 'failures', 'notes'], properties: {
  buildOk: { type: 'boolean', description: 'pnpm -r build succeeded on the stacked tip' },
  suites: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pkg', 'tests', 'pass'], properties: { pkg: { type: 'string' }, tests: { type: 'number' }, pass: { type: 'boolean' } } }, description: 'one entry per workspace package, all six' },
  liveE2e: { type: 'string', enum: ['green', 'skipped-no-env', 'failed'] },
  todoFree: { type: 'boolean', description: 'true ONLY if the diff main..tip contains zero TODO/deferred-work language' },
  changesetsOk: { type: 'boolean', description: 'true ONLY if every PR branch adds a changeset naming exactly the packages whose src/ changed' },
  failures: { type: 'array', items: { type: 'string' }, description: 'every problem found — ANY entry here fails the gate' },
  notes: { type: 'string' } } }

const DELIVER_SCHEMA = { type: 'object', additionalProperties: false, required: ['pushed', 'prUrls', 'notes'], properties: {
  pushed: { type: 'boolean', description: 'true ONLY if the single push succeeded WITH the pre-push gate running' },
  prUrls: { type: 'array', items: { type: 'string' }, description: 'one draft PR URL per phase branch, in PR order' },
  notes: { type: 'string' } } }

const looksPlaceholder = (s) => typeof s !== 'string' || s.trim().length < 20 || /see (the )?(spec|above|below)|as described|placeholder|\bTBD\b/i.test(s)

// ---------- Preflight ----------
phase('Preflight')
const preflight = await agent(
  `Preflight for the ACP auth implementation train in ${REPO}. READ-ONLY: run no state-changing git commands (fetch is fine; no pull/checkout/branch).\n` +
  `Checks (ok=true requires ALL to hold; report every failure in blockers):\n` +
  `1. git status is CLEAN, the checkout is on main, and after \`git fetch origin\`, main == origin/main.\n` +
  `2. ${SPEC} exists and its §4.7 lists PR1..PR7.\n` +
  `3. NO stale state from a prior partial run: no auth/pr* branches (local or origin), no packages/acp-agents/src/auth/ directory. Anything found goes in existingAuthBranches AND blockers (ok=false); do not delete anything.\n` +
  `4. LINE-DRIFT MEMO (the memo field): the spec's file:line cites predate recent merges. For each load-bearing seam the spec names — clientCapabilitiesFor, negotiateCapabilities, PooledConnection initialize/releaseSession, pool selectConnection, runner run()/authenticate()/logout()/createDedicatedConnection, errors-map isAcpAuthRequired, workflow-manager PROVIDER_USAGE_LIMIT pause branch + resume(), run-persistence PersistedRunState, mcp-server registerTool — report its CURRENT file + line-range and one sentence on anything structurally different from how the spec describes it. The memo must be COMPLETE inside the memo field and fit comfortably in a single message — be tight.`,
  { label: 'preflight', phase: 'Preflight', model: 'opus', schema: PREFLIGHT_SCHEMA }
)
if (!preflight || !preflight.ok) throw new Error('preflight failed: ' + JSON.stringify(preflight ? preflight.blockers : 'preflight agent died'))

// ---------- PR phases ----------
const reports = []
let baseBranch = 'main'
for (const pr of PR_DEFS) {
  const phaseTitle = `PR${pr.n}`
  phase(phaseTitle)
  const effort = pr.effortHigh ? { effort: 'high' } : {}

  const implSalt = REIMPL[phaseTitle]
    ? `\n(re-implementation token: ${REIMPL[phaseTitle]}. A prior attempt was repaired or removed by hand. If ${pr.branch} already exists, continue committing on it — do not stop.)`
    : ''
  const implPrompt = `You are implementing ${phaseTitle} of the ACP auth train: ${pr.title}.\n\n` +
    `CONTRACT: read ${SPEC} sections ${pr.sections} IN FULL before writing code (Read the file; it is large — read the named sections completely, plus §1.1 and the glossary once for shared vocabulary, plus THIS PR's entries in §4.6: the test plan's mandated per-PR test matrices are part of the contract).\n\n` +
    `SCOPE ORIENTATION (spec is authoritative; this is the §4.7 distillation):\n${pr.scope}\n\n` +
    `LINE-DRIFT MEMO from preflight (current locations of the seams the spec cites):\n${preflight.memo}\n\n` +
    `GIT: work in ${REPO}. git checkout ${baseBranch}, then git checkout -b ${pr.branch}. If ${pr.branch} already exists and you were given no re-implementation token, do NOT delete or reuse it — record it in deviations, set testsPass:false, and stop. All commits on ${pr.branch}.${implSalt}\n\n` +
    PRINCIPLES + '\n\n' + DOD
  let latestReport = await agent(implPrompt, { label: `impl:${phaseTitle}`, phase: phaseTitle, model: 'opus', ...effort, schema: IMPL_SCHEMA })
  if (!latestReport) throw new Error(`${phaseTitle}: implementer died`)
  if (latestReport.branch !== pr.branch) throw new Error(`${phaseTitle}: implementer reported branch "${latestReport.branch}", expected "${pr.branch}"`)
  if (!latestReport.testsPass || !latestReport.workspaceBuildOk) throw new Error(`${phaseTitle} not green (recover with args {reimpl:{"${phaseTitle}":"1"}} after repairing/removing ${pr.branch}): ${latestReport.notes}`)
  if (latestReport.deviations.length > 0) log(`${phaseTitle} deviations: ${latestReport.deviations.join(' | ')}`)

  const salt = REVERIFY[phaseTitle] ? `\n(re-verify token: ${REVERIFY[phaseTitle]})` : ''
  const verifyCommon = () =>
    `Adversarially verify ${phaseTitle} (${pr.title}) of the ACP auth train.${salt}\n` +
    `You are running in a THROWAWAY WORKTREE copy of the repo. First run: git checkout --detach ${pr.branch} (the branch itself is checked out in the main tree and cannot be checked out twice). You are REPORT-ONLY: never modify files, never commit, never touch branches, and NEVER run git commands against ${REPO} itself.\n` +
    `The diff: git diff ${baseBranch}..${pr.branch} (read it fully; also Read changed files for context).\n` +
    `The contract: the spec at docs/specs/acp-auth-spec.md, sections ${pr.sections}, PLUS this PR's entries in §4.6 (test plan) — the mandated test matrices are contract, not suggestion.\n` +
    `Implementer's latest report: ${JSON.stringify(latestReport)}\n` +
    `Report ONLY defects you can evidence; an empty issues list is a valid outcome. Every fix field must be complete and self-contained.\n`
  const lenses = [
    ['spec-conformance', 'LENS: SPEC CONFORMANCE. Walk the named spec sections requirement by requirement; every MUST/shape/semantic either appears in the diff (cite where) or is a blocking issue. Also flag anything the diff does that the spec does NOT sanction (scope creep breaks the frozen contract). Check the equal-first-class and custom-agent-conformance obligations specifically.'],
    ['quality', 'LENS: QUALITY & REGRESSION. Do the new tests actually pin the contract (would they fail if the behavior regressed)? Any weakened/removed existing assertions, .skip, as-any, TODO/deferred language, secrets reaching logs/events/journals/messages, resume-hash widening (a new option entering hashAgentCall), or default-ON behavior change for hosts that configured nothing? Run the touched packages\' suites yourself IN YOUR WORKTREE to confirm green.'],
  ]
  const runVerifiers = (note) => parallel(lenses.map(([key, lens]) => () =>
    agent(verifyCommon() + (note ? note + '\n' : '') + lens,
      { label: `verify:${phaseTitle}:${key}`, phase: phaseTitle, model: 'opus', effort: 'high', isolation: 'worktree', schema: VERIFY_SCHEMA })))

  let verdicts = await runVerifiers()
  let minorIssues = []
  for (let round = 1; ; round++) {
    const live = verdicts.filter(Boolean)
    if (live.length < lenses.length) throw new Error(`${phaseTitle}: a verifier died — refusing to pass unverified`)
    // Honor both channels: issue-level severity AND a blocking verdict with no blocking-tagged issue.
    const blocking = live.flatMap((v) => {
      const tagged = v.issues.filter((i) => i.severity === 'blocking')
      if (v.verdict === 'blocking' && tagged.length === 0) {
        return [{ severity: 'blocking', file: '(verdict)', problem: v.summary, fix: 'address the verdict summary against the spec' }]
      }
      return tagged
    }).map((i) => looksPlaceholder(i.fix)
      ? { ...i, fix: i.fix + ' [fix text was placeholder-grade; derive the correct fix from the problem + the spec sections]' }
      : i)
    minorIssues = live.flatMap((v) => v.issues.filter((i) => i.severity === 'minor'))
    if (blocking.length === 0) break
    if (round > MAX_FIX_ROUNDS) throw new Error(`${phaseTitle}: ${blocking.length} blocking issues after ${MAX_FIX_ROUNDS} fix rounds (recover: repair ${pr.branch} by hand, then resume with args {reverify:{"${phaseTitle}":"1"}}): ${blocking.map((i) => i.problem).join(' | ').slice(0, 800)}`)
    log(`${phaseTitle}: fixing ${blocking.length} blocking issues (round ${round})`)
    const fixed = await agent(
      `Fix EVERY blocking issue below on branch ${pr.branch} in ${REPO} (verify each fix claim against the spec ${SPEC} ${pr.sections} before applying; if a "fix" is wrong, do the RIGHT fix and say so in notes). Re-run the touched packages' suites + pnpm -r build to green, commit on the branch.\n` +
      `ISSUES:\n${JSON.stringify(blocking, null, 2)}\n\n` + PRINCIPLES + '\n\n' + DOD,
      { label: `fix:${phaseTitle}:r${round}`, phase: phaseTitle, model: 'opus', effort: 'high', schema: IMPL_SCHEMA })
    if (!fixed || !fixed.testsPass || !fixed.workspaceBuildOk) throw new Error(`${phaseTitle} fix round ${round} not green`)
    if (fixed.branch !== pr.branch) throw new Error(`${phaseTitle}: fixer reported branch "${fixed.branch}", expected "${pr.branch}"`)
    latestReport = fixed
    verdicts = await runVerifiers(`NOTE: fix round ${round} was applied after the previous verification. Re-verify from scratch.`)
  }

  reports.push({ pr: pr.n, branch: pr.branch, base: baseBranch, sections: pr.sections, impl: latestReport, minorIssues })
  log(`${phaseTitle} green on ${pr.branch}${minorIssues.length ? ` (${minorIssues.length} minor notes for the PR body)` : ''}`)
  baseBranch = pr.branch
}

// ---------- Integrate ----------
phase('Integrate')
const integ = await agent(
  `Integration check of the full auth train in ${REPO}: checkout ${baseBranch} (the stacked tip).\n` +
  `1. pnpm -r build.\n2. Run EVERY package's test suite (${EXPECTED_PKGS.join(', ')}); report one suites[] entry per package.\n` +
  `3. Live e2e: if the environment has real agent auth (try the repo's env-gated live suite the way .githooks/pre-push does, plus the new auth.live.e2e.test.ts), run it once and report; if the env lacks agent auth, report "skipped-no-env" — do NOT fake it.\n` +
  `4. todoFree: scan the diff main..${baseBranch} for TODO/deferred-work language. changesetsOk: confirm every PR branch adds a changeset naming exactly the packages whose src/ changed.\n` +
  `Record EVERY problem in failures — any entry there fails the gate. Do not commit anything.`,
  { label: 'integrate', phase: 'Integrate', model: 'opus', effort: 'high', schema: INTEG_SCHEMA })
if (!integ || !integ.buildOk || !integ.todoFree || !integ.changesetsOk
    || integ.failures.length > 0 || integ.liveE2e === 'failed'
    || EXPECTED_PKGS.some((p) => !integ.suites.some((s) => s.pkg.includes(p) && s.pass))) {
  throw new Error('integration not green: ' + JSON.stringify(integ && { failures: integ.failures, todoFree: integ.todoFree, changesetsOk: integ.changesetsOk, suites: integ.suites }))
}

// ---------- Deliver ----------
phase('Deliver')
// Human gate: the first invocation builds and stops here; after review, re-invoke with
// args {deliver: true} + resumeFromRunId (re-supplying any recovery tokens verbatim) —
// every phase above replays from cache and only this Deliver phase runs live.
if (A.deliver !== true) {
  if (A.deliver) log('args.deliver is set but is not boolean true — refusing to deliver; pass {deliver:true}')
  log(`auth train green (${integ.suites.reduce((a, s) => a + s.tests, 0)} tests, live e2e: ${integ.liveE2e}) — re-run with args {deliver:true} to push + open the stacked draft PRs`)
  return { status: 'built-not-delivered', branches: reports.map((r) => r.branch), integ }
}

const deliver = await agent(
  `Deliver the auth train from ${REPO}:\n` +
  `1. Push all branches in ONE command so the pre-push gate runs once: git push origin ${PR_DEFS.map((p) => p.branch).join(' ')}\n` +
  `   The pre-push hook runs a live e2e against real agents (~2 min) — let it run. If it fails you MUST NOT retry with --no-verify or AGENTPRISM_SKIP_LIVE_E2E (even though the hook's own output suggests them): return pushed:false with the hook's failure tail in notes and stop.\n` +
  `2. Open 7 DRAFT PRs with gh, STACKED: PR1 base main; PR N base = PR N-1's branch. Title from the branch; body = a distilled summary of that phase's report (below) + "Implements docs/specs/acp-auth-spec.md " + that PR's sections field + a "Review notes" list of the phase's minorIssues (verifier notes worth a human eye) + the standard "🤖 Generated with [Claude Code](https://claude.com/claude-code)" footer.\n` +
    `Per-PR data: ${JSON.stringify(reports.map((r) => ({ pr: r.pr, branch: r.branch, base: r.base, sections: r.sections, files: r.impl.filesChanged.length, testsAdded: r.impl.testsAdded, notes: r.impl.notes, minorIssues: r.minorIssues })))}\n` +
  `Return the PR URLs.`,
  { label: 'deliver', phase: 'Deliver', model: 'opus', schema: DELIVER_SCHEMA })
if (!deliver || !deliver.pushed || deliver.prUrls.length !== PR_DEFS.length) throw new Error('deliver failed: ' + JSON.stringify(deliver))

return { status: 'delivered', prUrls: deliver.prUrls, branches: reports.map((r) => r.branch), integ }
