#!/usr/bin/env node
// ACP dependency freshness gate (policy: bump ACP deps at every release — see CONTRIBUTING.md).
// Two checks, exit 1 if either fails:
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
//
// Zero dependencies; run standalone with `node scripts/check-acp-deps.mjs` or via .githooks/pre-push.
// A registry/API that can't be reached (offline, timeout, rate limit) WARNS and passes — it never
// bricks a push.

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

const REGISTRY = "https://registry.npmjs.org";
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
const manifestCache = new Map(); // dep -> Promise<latest manifest JSON>
function fetchLatestManifest(dep) {
  if (!manifestCache.has(dep)) {
    manifestCache.set(dep, (async () => {
      const url = `${REGISTRY}/${dep.replace("/", "%2F")}/latest`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res.json();
    })());
  }
  return manifestCache.get(dep);
}

async function ghApi(path) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "agentprism-acp-dep-check" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from api.github.com${path}`);
  return res.json();
}

function githubSlug(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url ?? "");
  return m ? m[1] : null;
}

// ---- check 1: npm freshness ----------------------------------------------------------------------
const outdated = []; // { dep, locked, latest, specifier, pkgName }
const warnings = [];

const freshness = Promise.all(
  tracked.map(async ({ dep, specifier, pkgName }) => {
    const locked = lockedVersion(dep);
    if (!locked) {
      warnings.push(`acp-deps: ${dep} not found in pnpm-lock.yaml importers — is the lockfile in sync? (pnpm install)`);
      return;
    }
    let latest;
    try {
      latest = (await fetchLatestManifest(dep)).version;
    } catch (err) {
      warnings.push(`acp-deps: could not reach registry for ${dep} (${err.message}) — SKIPPING freshness check for it`);
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

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  const remotes = git(dir, "remote").split("\n");
  if (!remotes.includes(upstreamRemote)) {
    throw new Error(`clone at ${dir} has no '${upstreamRemote}' remote`);
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
        warnings.push(
          `acp-deps: fork-sync check for ${dep} failed (${err.message}) — SKIPPING it (local clone via ${envDir}; API fallback: gh auth login or GITHUB_TOKEN)`,
        );
      }
    }),
);

await Promise.all([freshness, forkSync]);

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

process.exit(outdated.length > 0 || forkIssues.length > 0 ? 1 : 0);
