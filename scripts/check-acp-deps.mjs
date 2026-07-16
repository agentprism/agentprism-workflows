#!/usr/bin/env node
// ACP dependency freshness gate (policy: bump ACP deps at every release — see CONTRIBUTING.md).
// Three checks, exit 1 if any fails:
//   1. npm freshness: the pnpm-lock.yaml-resolved versions of the ACP client/agent libraries must
//      match the npm registry's `latest` dist-tag (prints the exact bump command per dep).
//   2. Fork git sync (FORK_SYNC): fork version lines diverge from upstream's, so versions can't be
//      compared — instead check git ancestry: does the upstream repo have commits the fork's
//      published default branch hasn't merged? Policy is merge (not rebase), so ancestry is the
//      right signal. Preferred path: the local fork clone (its `upstream` remote) — fetch both
//      remotes and count origin/<main>..upstream/<main>. Fallback when the clone isn't on this
//      machine: the GitHub compare API against the fork's `parent` repo (same upstream).
//      Unauthenticated GitHub API works but is rate-limited; the pre-push hook passes
//      GITHUB_TOKEN from `gh auth token` when available.
//   3. Wrapped runtime freshness (WRAPPED_RUNTIMES): an adapter can be at npm latest while
//      exact-pinning a stale agent runtime inside it (the runtime is what actually answers
//      prompts), so check 1 is structurally blind to this axis. Compare the lockfile's
//      *transitive* resolution of the wrapped runtime against the runtime's npm `latest` —
//      lockfile-first, so a root pnpm override satisfies the check with no special-casing.
//
// Zero dependencies; run standalone with `node scripts/check-acp-deps.mjs`. Enforced in THREE
// places, with no bypass: .githooks/pre-push (every dev push), the required "Build & test" CI job
// (every PR — stale deps block ALL merges), and release.yml before version/publish (a dep going
// stale between PR-green and publish blocks the release; the workflow reports and leaves the
// Version PR open). The gate FAILS CLOSED: a registry/API that can't be reached after retries is
// a blocker, not a warning — staleness we cannot rule out blocks the same as staleness we can see.
// Triage runbook: CONTRIBUTING.md "When the dependency gate blocks".

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// A dependency is ACP-tracked if its name matches any of these. Extend when a new
// ACP client/agent library is adopted (custom agents shipped as npm packages belong here too).
const ACP_DEP_MATCHERS = [
  (name) => name.startsWith("@agentclientprotocol/"),
  (name) => name === "@automatalabs/codex-acp",
  (name) => name === "@earendil-works/pi-coding-agent",
];

// Forks we maintain whose published default branch must contain their upstream's default branch.
// envDir overrides the clone location; defaultDirs are tried in order; no clone → GitHub API.
const FORK_SYNC = {
  "@automatalabs/codex-acp": {
    envDir: "AGENTPRISM_CODEX_ACP_DIR",
    defaultDirs: [join(homedir(), "codex-acp")],
    upstreamRemote: "upstream",
  },
};

// Adapter packages that wrap an agent runtime whose freshness matters independently of the
// adapter's own version. Fix when behind: bump the adapter if its latest already wraps a current
// runtime, else pin a root pnpm override until upstream catches up (and drop the override once it
// does — the check warns when an override has become redundant).
const WRAPPED_RUNTIMES = {
  "@agentclientprotocol/claude-agent-acp": { wraps: "@anthropic-ai/claude-agent-sdk" },
};

// Env override exists for hermetic tests (point at a local stub registry); production runs never set it.
const REGISTRY = process.env.AGENTPRISM_NPM_REGISTRY || "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 10_000;

function isTracked(name) {
  return ACP_DEP_MATCHERS.some((m) => m(name));
}

// ---- collect tracked deps from every workspace package.json ------------------------------------
const tracked = []; // { dep, specifier, pkgName }
for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, "packages", entry.name, "package.json"), "utf8"));
  } catch {
    continue;
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dep, specifier] of Object.entries(manifest[field] ?? {})) {
      if (isTracked(dep)) tracked.push({ dep, specifier, pkgName: manifest.name });
    }
  }
}

if (tracked.length === 0) {
  console.error("acp-deps: no tracked ACP dependencies found — check ACP_DEP_MATCHERS in scripts/check-acp-deps.mjs");
  process.exit(1);
}

// ---- resolve locked versions from pnpm-lock.yaml ------------------------------------------------
// Importer entries look like:
//       '@agentclientprotocol/sdk':
//         specifier: ^1.2.1
//         version: 1.2.1(zod@4.4.3)
// Only importer blocks carry a `specifier:` line, so this regex never matches snapshot sections.
const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
function lockedVersion(dep) {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`'${escaped}':\\n\\s+specifier: [^\\n]+\\n\\s+version: ([0-9][^\\s(]*)`, "g");
  const versions = new Set([...lockfile.matchAll(re)].map((m) => m[1]));
  return versions.size > 0 ? [...versions] : null;
}

// Transitive resolution: what the lockfile actually installs for `dep`, from the top-level
// `packages:`/`snapshots:` section keys ("  '@scope/name@1.2.3':" / "  name@1.2.3:" /
// "  '@scope/name@1.2.3(peer@x)':"). Importer blocks only cover direct deps, so wrapped
// runtimes never appear there. Anchoring on `@` after the full name keeps platform
// sub-packages (name-darwin-arm64@…) from matching.
function lockedTransitiveVersions(dep) {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^ {2}'?${escaped}@([0-9][^'(:\\n]*)`, "gm");
  const versions = new Set([...lockfile.matchAll(re)].map((m) => m[1].trim()));
  return versions.size > 0 ? [...versions] : null;
}

// Root pnpm overrides (package.json "pnpm".overrides) — consulted only to warn when an override
// that carried the wrapped runtime forward has become redundant.
function rootPnpmOverrides() {
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return manifest.pnpm?.overrides ?? {};
  } catch {
    return {};
  }
}

// ---- semver ------------------------------------------------------------------------------------
function parseVer(v) {
  const [core, pre] = v.split("-", 2);
  return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
}
function semverLt(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  for (let i = 0; i < 3; i++) {
    if ((pa.nums[i] ?? 0) !== (pb.nums[i] ?? 0)) return (pa.nums[i] ?? 0) < (pb.nums[i] ?? 0);
  }
  if (pa.pre && !pb.pre) return true; // 1.2.3-rc.1 < 1.2.3
  if (!pa.pre && pb.pre) return false;
  return pa.pre && pb.pre ? pa.pre < pb.pre : false;
}

// ---- registry / GitHub fetchers ------------------------------------------------------------------
// The gate fails closed on unreachable endpoints, so transient hiccups get retried before they
// become blockers (a 404 is a real answer, not a hiccup — no retry).
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_500;
async function fetchWithRetry(url, init) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return res;
      if (res.status === 404) throw new Error(`HTTP 404 from ${url}`);
      lastErr = new Error(`HTTP ${res.status} from ${url}`);
    } catch (err) {
      if (/HTTP 404 /.test(err.message)) throw err;
      lastErr = err;
    }
    if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
  }
  throw lastErr;
}

const manifestCache = new Map(); // "dep@ref" -> Promise<version manifest JSON>
function fetchManifest(dep, ref) {
  const key = `${dep}@${ref}`;
  if (!manifestCache.has(key)) {
    manifestCache.set(key, (async () => {
      const res = await fetchWithRetry(`${REGISTRY}/${dep.replace("/", "%2F")}/${ref}`);
      return res.json();
    })());
  }
  return manifestCache.get(key);
}
function fetchLatestManifest(dep) {
  return fetchManifest(dep, "latest");
}

async function ghApi(path) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "agentprism-acp-dep-check" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchWithRetry(`https://api.github.com${path}`, { headers });
  return res.json();
}

function githubSlug(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url ?? "");
  return m ? m[1] : null;
}

// ---- check 1: npm freshness ----------------------------------------------------------------------
const outdated = []; // { dep, locked, latest, specifier, pkgName }
const warnings = []; // advisory hints only — never affect the exit code
const blockers = []; // unverifiable states — the gate FAILS CLOSED on these

const freshness = Promise.all(
  tracked.map(async ({ dep, specifier, pkgName }) => {
    const locked = lockedVersion(dep);
    if (!locked) {
      blockers.push(`acp-deps: ${dep} not found in pnpm-lock.yaml importers — lockfile out of sync? (pnpm install)`);
      return;
    }
    let latest;
    try {
      latest = (await fetchLatestManifest(dep)).version;
    } catch (err) {
      blockers.push(`acp-deps: could not verify ${dep} freshness — registry unreachable after ${FETCH_ATTEMPTS} attempts (${err.message})`);
      return;
    }
    const stale = locked.filter((v) => semverLt(v, latest));
    if (stale.length > 0) {
      outdated.push({ dep, locked: stale[0], latest, specifier, pkgName });
    } else {
      console.error(`acp-deps: ${dep} ${locked.join(", ")} == latest — ok`);
    }
  }),
);

// ---- check 2: fork git sync with upstream --------------------------------------------------------
const forkIssues = []; // { dep, where, branch, upstreamRef, missing, fix }

// Git-location env vars that git exports into hook child processes (e.g. GIT_DIR in a pre-push
// hook, pointing at THIS repo's .git). GIT_DIR overrides `-C <dir>` repo discovery, so a hook
// caller's inherited GIT_DIR would silently redirect every `git -C <cloneDir>` below to the wrong
// repo. Strip them from the child env so `-C <dir>` always wins (also protects future hook callers).
const GIT_LOCATION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

function git(dir, ...args) {
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }).trim();
}

// Default branch of a remote as the remote reports it (ls-remote --symref HEAD → refs/heads/<branch>).
function remoteDefaultBranch(dir, remote) {
  const out = git(dir, "ls-remote", "--symref", remote, "HEAD");
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out);
  if (!m) throw new Error(`cannot determine default branch of remote '${remote}'`);
  return m[1];
}

// Local-clone check: commits upstream/<branch> has that the fork's PUBLISHED main (origin/<branch>)
// lacks. origin, not the local branch — releases are cut from the pushed fork main.
function checkForkClone(dep, dir, upstreamRemote) {
  const remotes = git(dir, "remote").split("\n").filter(Boolean);
  if (!remotes.includes(upstreamRemote)) {
    // Self-diagnose a recurrence: report the remotes we actually listed and the git dir git
    // actually resolved. If a stray GIT_DIR/GIT_WORK_TREE ever leaks past the git() env scrub,
    // the resolved dir won't match `dir` — making the misdirection unambiguous instead of
    // masquerading as a genuinely missing remote.
    const resolved = git(dir, "rev-parse", "--absolute-git-dir");
    throw new Error(
      `clone at ${dir} has no '${upstreamRemote}' remote ` +
        `(remotes listed: ${remotes.join(", ") || "none"}; git resolved dir: ${resolved})`,
    );
  }
  const upstreamBranch = remoteDefaultBranch(dir, upstreamRemote);
  const originBranch = remoteDefaultBranch(dir, "origin");
  git(dir, "fetch", "--quiet", upstreamRemote);
  git(dir, "fetch", "--quiet", "origin");
  const missing = parseInt(
    git(dir, "rev-list", "--count", `origin/${originBranch}..${upstreamRemote}/${upstreamBranch}`),
    10,
  );
  return {
    where: dir,
    branch: `origin/${originBranch}`,
    upstreamRef: `${git(dir, "remote", "get-url", upstreamRemote).replace(/\.git$/, "")}#${upstreamBranch}`,
    missing,
    fix: `cd ${dir} && git merge ${upstreamRemote}/${upstreamBranch} && git push origin ${originBranch}`,
  };
}

// API fallback for machines without the clone. compare/BASE...HEAD: ahead_by = commits HEAD
// (upstream parent) has that BASE (our fork's default branch) lacks.
async function checkForkViaApi(dep) {
  const slug = githubSlug((await fetchLatestManifest(dep)).repository);
  if (!slug) throw new Error(`${dep} has no parseable GitHub repository URL`);
  const repo = await ghApi(`/repos/${slug}`);
  if (!repo.parent) throw new Error(`${slug} is not a GitHub fork (no parent)`);
  const parentSlug = repo.parent.full_name;
  const parentBranch = repo.parent.default_branch;
  const cmp = await ghApi(`/repos/${slug}/compare/${repo.default_branch}...${parentSlug.split("/")[0]}:${parentBranch}`);
  return {
    where: slug,
    branch: repo.default_branch,
    upstreamRef: `${parentSlug}#${parentBranch}`,
    missing: cmp.ahead_by,
    fix: `clone the fork, add the upstream remote, merge ${parentSlug}#${parentBranch}, push fork ${repo.default_branch}`,
  };
}

const forkSync = Promise.all(
  Object.entries(FORK_SYNC)
    .filter(([dep]) => tracked.some((t) => t.dep === dep))
    .map(async ([dep, { envDir, defaultDirs, upstreamRemote }]) => {
      try {
        const dirs = [process.env[envDir], ...defaultDirs].filter(Boolean);
        const cloneDir = dirs.find((d) => existsSync(join(d, ".git")));
        const result = cloneDir
          ? checkForkClone(dep, cloneDir, upstreamRemote)
          : await checkForkViaApi(dep);
        if (result.missing > 0) {
          forkIssues.push({ dep, ...result });
        } else {
          console.error(`acp-deps: fork ${result.where} (${result.branch}) contains upstream ${result.upstreamRef} — in sync`);
        }
      } catch (err) {
        blockers.push(
          `acp-deps: could not verify fork sync for ${dep} (${err.message}) — local clone via ${envDir}; API fallback needs gh auth login or GITHUB_TOKEN`,
        );
      }
    }),
);

// ---- check 3: wrapped runtime freshness ----------------------------------------------------------
const wrappedIssues = []; // { dep, wraps, locked, latest, viaAdapterBump }

// Exact-pin version string (e.g. "0.3.207") vs range — only exact pins are comparable.
function exactPin(spec) {
  return typeof spec === "string" && /^[0-9]/.test(spec) ? spec : null;
}

const wrappedRuntimes = Promise.all(
  Object.entries(WRAPPED_RUNTIMES)
    .filter(([dep]) => tracked.some((t) => t.dep === dep))
    .map(async ([dep, { wraps }]) => {
      const locked = lockedTransitiveVersions(wraps);
      if (!locked) {
        blockers.push(
          `acp-deps: ${wraps} (wrapped by ${dep}) not found in pnpm-lock.yaml — lockfile out of sync? (pnpm install)`,
        );
        return;
      }
      let latest;
      try {
        latest = (await fetchLatestManifest(wraps)).version;
      } catch (err) {
        blockers.push(
          `acp-deps: could not verify ${wraps} (wrapped by ${dep}) — registry unreachable after ${FETCH_ATTEMPTS} attempts (${err.message})`,
        );
        return;
      }
      const stale = locked.filter((v) => semverLt(v, latest));
      if (stale.length > 0) {
        // Pick the remediation: if the adapter's latest already pins a current runtime, the fix
        // is the ordinary adapter bump (check 1 is firing too); otherwise a root pnpm override.
        let viaAdapterBump = false;
        try {
          const pin = exactPin((await fetchLatestManifest(dep)).dependencies?.[wraps]);
          viaAdapterBump = pin !== null && !semverLt(pin, latest);
        } catch {
          // Registry hiccup on the adapter manifest — the override remediation below stays valid.
        }
        wrappedIssues.push({ dep, wraps, locked: stale[0], latest, viaAdapterBump });
        return;
      }
      console.error(`acp-deps: ${wraps} ${locked.join(", ")} (wrapped by ${dep}) == latest — ok`);
      const override = rootPnpmOverrides()[wraps];
      if (override !== undefined) {
        try {
          const adapterLocked = lockedVersion(dep)?.[0];
          const pin = adapterLocked
            ? exactPin((await fetchManifest(dep, adapterLocked)).dependencies?.[wraps])
            : null;
          if (pin !== null && !semverLt(pin, latest)) {
            warnings.push(
              `acp-deps: root pnpm override ${wraps}@${override} is redundant (${dep}@${adapterLocked} already pins ${pin}) — remove it from package.json pnpm.overrides and pnpm install`,
            );
          }
        } catch {
          // Best-effort hint only — never noise a push over an unreachable manifest.
        }
      }
    }),
);

await Promise.all([freshness, forkSync, wrappedRuntimes]);

for (const w of warnings) console.error(w);

if (outdated.length > 0) {
  console.error("");
  console.error("acp-deps: ACP libraries are BEHIND npm latest — update before pushing:");
  for (const { dep, locked, latest, specifier, pkgName } of outdated) {
    const exact = /^[0-9]/.test(specifier); // exact pin vs range — preserve the pin style on bump
    const spec = exact ? `${dep}@${latest} --save-exact` : `${dep}@^${latest}`;
    console.error(`  ${dep}: locked ${locked}, latest ${latest}`);
    console.error(`    → pnpm --filter ${pkgName} add ${spec}`);
  }
  console.error("  Then add a changeset for the bump: pnpm changeset");
}

if (forkIssues.length > 0) {
  console.error("");
  console.error("acp-deps: fork(s) OUT OF SYNC with git upstream — merge upstream before pushing:");
  for (const { dep, where, branch, upstreamRef, missing, fix } of forkIssues) {
    console.error(`  ${dep}: upstream ${upstreamRef} has ${missing} commit(s) not in ${where} (${branch})`);
    console.error(`    → ${fix}  # resolve conflicts`);
    console.error(`    → then cut a fork release (release-fork.yml) and bump ${dep} here`);
  }
}

if (wrappedIssues.length > 0) {
  console.error("");
  console.error("acp-deps: wrapped agent runtime(s) BEHIND npm latest — update before pushing:");
  for (const { dep, wraps, locked, latest, viaAdapterBump } of wrappedIssues) {
    console.error(`  ${wraps} (wrapped by ${dep}): installed ${locked}, latest ${latest}`);
    if (viaAdapterBump) {
      console.error(`    → ${dep}@latest already wraps a current ${wraps}: bump ${dep} (check 1 above prints the command)`);
    } else {
      console.error(`    → ${dep}@latest still pins an older ${wraps} — add a root override in package.json:`);
      console.error(`      "pnpm": { "overrides": { "${wraps}": "${latest}" } }`);
      console.error(`      then pnpm install, run the acp-agents live e2e, and push (drop the override once ${dep} catches up)`);
    }
  }
}

if (blockers.length > 0) {
  console.error("");
  console.error("acp-deps: freshness could NOT be verified — the gate fails closed:");
  for (const b of blockers) console.error(`  ${b}`);
}

const failed = outdated.length > 0 || forkIssues.length > 0 || wrappedIssues.length > 0 || blockers.length > 0;
if (failed) {
  console.error("");
  console.error('acp-deps: triage runbook: CONTRIBUTING.md "When the dependency gate blocks"');
}
process.exit(failed ? 1 : 0);
