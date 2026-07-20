#!/usr/bin/env node
// ACP dependency freshness gate (policy: bump ACP deps at every release — see CONTRIBUTING.md).
// Three checks, exit 1 if any fails:
//   1. npm freshness: the pnpm-lock.yaml-resolved versions of the ACP client/agent libraries must
//      match the npm registry's `latest` dist-tag (prints the exact bump command per dep).
//   2. Fork git sync (FORK_SYNC): fork version lines diverge from upstream's, so versions can't be
//      compared — instead check git ancestry: does the upstream repo have commits the fork's
//      published default branch hasn't merged? Policy is merge (not rebase), so ancestry is the
//      right signal. Always checked against a REAL clone (no API shortcut): the working clone
//      (~/codex-acp, override AGENTPRISM_CODEX_ACP_DIR) when present, else a managed temp clone
//      (<tmpdir>/codex-acp) created on demand. Either way the clone's remotes are VERIFIED first
//      (origin must be our fork; upstream is added/corrected to the true upstream), both remotes
//      are fetched, the checkout is put on origin's default branch and pulled current (working
//      clones must be clean and fully pushed — releases are cut from the PUSHED fork main), and
//      only then is upstream containment counted against the local checkout.
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

import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "scripts", "acp-backends.manifest.json");
const MANIFEST_COVERAGE_PREFIXES = Object.freeze(["@agentclientprotocol/"]);
const NODE_FLOOR = /^>=(0|[1-9]\d*)(?:\.(0|[1-9]\d*)\.(0|[1-9]\d*))?$/;
const HOME_TOKEN = /^\$HOME\/(.+)$/;

const backendManifest = loadBackendManifest();
const manifestNpm = new Set(
  backendManifest.backends.flatMap((backend) => backend.freshness.npm),
);
if (manifestNpm.size === 0) {
  manifestFailure("backends derived freshness.npm set must not be empty");
}

// These three work sets are projections of the committed manifest, never authored gate lists.
const FORK_SYNC = Object.freeze(
  backendManifest.backends.flatMap((backend) =>
    backend.freshness.forks.map((fork) => ({
      dep: fork.package,
      config: {
        ...fork,
        defaultDirs: fork.defaultDirs.map(expandHomeToken),
      },
    })),
  ),
);
const WRAPPED_RUNTIMES = Object.freeze(
  backendManifest.backends.flatMap((backend) =>
    backend.freshness.wrappedRuntimes.map((wrapped) => ({
      dep: wrapped.adapterPackage,
      wraps: wrapped.runtimePackage,
    })),
  ),
);

// Env override exists for hermetic tests (point at a local stub registry); production runs never set it.
const REGISTRY = process.env.AGENTPRISM_NPM_REGISTRY || "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 10_000;

// ---- collect direct deps from every workspace package.json --------------------------------------
const workspacePackages = [];
const directDependencies = [];
for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let manifest;
  const packagePath = join(repoRoot, "packages", entry.name, "package.json");
  try {
    manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    continue;
  }
  workspacePackages.push({ manifest, packagePath });
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dep, specifier] of Object.entries(manifest[field] ?? {})) {
      directDependencies.push({ dep, specifier, pkgName: manifest.name, packagePath, field });
    }
  }
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

validateRepositoryProjection();

const tracked = [...manifestNpm].map((dep) => {
  const declaration = directDependencies.find((entry) => entry.dep === dep);
  return {
    dep,
    specifier: declaration.specifier,
    pkgName: declaration.pkgName,
  };
});

function validateRepositoryProjection() {
  for (const dependency of directDependencies) {
    if (
      MANIFEST_COVERAGE_PREFIXES.some((prefix) => dependency.dep.startsWith(prefix)) &&
      !manifestNpm.has(dependency.dep)
    ) {
      manifestFailure(
        `freshness.npm omits ${dependency.dep} declared by ${dependency.pkgName} (${dependency.packagePath})`,
      );
    }
  }

  for (const dep of manifestNpm) {
    if (!directDependencies.some((entry) => entry.dep === dep)) {
      manifestFailure(`freshness.npm dependency ${dep} is not a direct workspace dependency`);
    }
    if (!lockedVersion(dep)) {
      manifestFailure(`freshness.npm dependency ${dep} has no pnpm-lock.yaml importer resolution`);
    }
  }

  const host = workspacePackages.find(
    ({ manifest }) => manifest.name === "@automatalabs/acp-agents",
  );
  const hostFloor = host?.manifest.engines?.node;
  if (typeof hostFloor !== "string" || hostFloor.length === 0) {
    manifestFailure("packages/acp-agents/package.json engines.node is required");
  }

  for (const backend of backendManifest.backends) {
    const { server } = backend;
    if (server.kind === "workspace-package") {
      const packagePath = resolve(repoRoot, server.path, "package.json");
      if (!packagePath.startsWith(`${resolve(repoRoot)}${process.platform === "win32" ? "\\" : "/"}`)) {
        manifestFailure(`backend ${backend.id} server.path escapes the repository`);
      }
      let workspace;
      try {
        workspace = JSON.parse(readFileSync(packagePath, "utf8"));
      } catch {
        manifestFailure(`backend ${backend.id} server.path does not resolve to a workspace package.json`);
      }
      if (workspace.name !== server.package) {
        manifestFailure(
          `backend ${backend.id} server.package ${server.package} differs from ${server.path}/package.json name ${String(workspace.name)}`,
        );
      }
      if (workspace.engines?.node !== backend.engine.node) {
        manifestFailure(
          `backend ${backend.id} engine.node ${backend.engine.node} differs from ${server.path}/package.json engines.node ${String(workspace.engines?.node)}`,
        );
      }
    } else if (backend.engine.node !== hostFloor) {
      manifestFailure(
        `backend ${backend.id} engine.node ${backend.engine.node} differs from packages/acp-agents/package.json engines.node ${hostFloor}`,
      );
    }

    for (const wrapped of backend.freshness.wrappedRuntimes) {
      if (!lockedTransitiveVersions(wrapped.runtimePackage)) {
        manifestFailure(
          `backend ${backend.id} freshness.wrappedRuntimes runtimePackage ${wrapped.runtimePackage} has no transitive pnpm-lock.yaml resolution`,
        );
      }
    }
  }
}

function loadBackendManifest() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    manifestFailure(`cannot read or parse ${manifestPath} (${errorMessage(error)})`);
  }

  exactObject(parsed, ["schemaVersion", "backends"], [], "manifest");
  if (typeof parsed.schemaVersion !== "number" || parsed.schemaVersion !== 1) {
    manifestFailure("manifest.schemaVersion must be the number 1");
  }
  if (!Array.isArray(parsed.backends)) manifestFailure("manifest.backends must be an array");
  if (parsed.backends.length === 0) manifestFailure("manifest.backends must not be empty");
  duplicateFree(parsed.backends.map((row) => row?.id), "manifest.backends ids");
  parsed.backends.forEach((backend, index) => validateBackendRow(backend, index));
  return parsed;
}

function validateBackendRow(backend, index) {
  const path = `manifest.backends[${index}]`;
  exactObject(backend, ["id", "engine", "server", "freshness"], [], path);
  nonemptyString(backend.id, `${path}.id`);

  exactObject(backend.engine, ["node"], [], `${path}.engine`);
  nonemptyString(backend.engine.node, `${path}.engine.node`);
  if (!NODE_FLOOR.test(backend.engine.node)) {
    manifestFailure(`${path}.engine.node must be >=MAJOR or >=MAJOR.MINOR.PATCH`);
  }

  exactObject(backend.server, ["kind"], ["package", "path", "command", "optionalPackageProbe"], `${path}.server`, false);
  if (backend.server.kind === "npm-package") {
    exactObject(backend.server, ["kind", "package"], [], `${path}.server`);
    nonemptyString(backend.server.package, `${path}.server.package`);
  } else if (backend.server.kind === "workspace-package") {
    exactObject(backend.server, ["kind", "package", "path"], [], `${path}.server`);
    nonemptyString(backend.server.package, `${path}.server.package`);
    nonemptyString(backend.server.path, `${path}.server.path`);
    if (isAbsolute(backend.server.path) || backend.server.path.split(/[\\/]/).includes("..")) {
      manifestFailure(`${path}.server.path must be a repository-relative path`);
    }
  } else if (backend.server.kind === "system-command") {
    exactObject(backend.server, ["kind", "command"], ["optionalPackageProbe"], `${path}.server`);
    nonemptyString(backend.server.command, `${path}.server.command`);
    if ("optionalPackageProbe" in backend.server) {
      nonemptyString(backend.server.optionalPackageProbe, `${path}.server.optionalPackageProbe`);
    }
  } else {
    manifestFailure(`${path}.server.kind is unrecognized`);
  }

  exactObject(backend.freshness, ["npm", "forks", "wrappedRuntimes"], [], `${path}.freshness`);
  stringArray(backend.freshness.npm, `${path}.freshness.npm`);
  objectArray(backend.freshness.forks, `${path}.freshness.forks`);
  objectArray(backend.freshness.wrappedRuntimes, `${path}.freshness.wrappedRuntimes`);
  duplicateFree(
    backend.freshness.forks.map((fork) => [
      fork?.package,
      fork?.envDir,
      ...(Array.isArray(fork?.defaultDirs) ? fork.defaultDirs : []),
      fork?.tempCloneName,
      fork?.originUrl,
      fork?.originUrlEnv,
      fork?.upstreamUrl,
      fork?.upstreamUrlEnv,
      fork?.upstreamRemote,
    ].join("\u0000")),
    `${path}.freshness.forks`,
  );
  duplicateFree(
    backend.freshness.wrappedRuntimes.map((wrapped) =>
      `${wrapped?.adapterPackage}\u0000${wrapped?.runtimePackage}`
    ),
    `${path}.freshness.wrappedRuntimes`,
  );

  const npm = new Set(backend.freshness.npm);
  if (backend.server.kind === "npm-package" && !npm.has(backend.server.package)) {
    manifestFailure(`${path}.server.package must appear in ${path}.freshness.npm`);
  }

  backend.freshness.forks.forEach((fork, forkIndex) => {
    const forkPath = `${path}.freshness.forks[${forkIndex}]`;
    exactObject(fork, [
      "package", "envDir", "defaultDirs", "tempCloneName", "originUrl", "originUrlEnv",
      "upstreamUrl", "upstreamUrlEnv", "upstreamRemote",
    ], [], forkPath);
    for (const field of [
      "package", "envDir", "tempCloneName", "originUrl", "originUrlEnv", "upstreamUrl",
      "upstreamUrlEnv", "upstreamRemote",
    ]) nonemptyString(fork[field], `${forkPath}.${field}`);
    stringArray(fork.defaultDirs, `${forkPath}.defaultDirs`);
    for (const token of fork.defaultDirs) validateHomeToken(token, `${forkPath}.defaultDirs`);
    if (!npm.has(fork.package)) manifestFailure(`${forkPath}.package must appear in ${path}.freshness.npm`);
  });

  backend.freshness.wrappedRuntimes.forEach((wrapped, wrappedIndex) => {
    const wrappedPath = `${path}.freshness.wrappedRuntimes[${wrappedIndex}]`;
    exactObject(wrapped, ["adapterPackage", "runtimePackage"], [], wrappedPath);
    nonemptyString(wrapped.adapterPackage, `${wrappedPath}.adapterPackage`);
    nonemptyString(wrapped.runtimePackage, `${wrappedPath}.runtimePackage`);
    if (!npm.has(wrapped.adapterPackage)) {
      manifestFailure(`${wrappedPath}.adapterPackage must appear in ${path}.freshness.npm`);
    }
  });
}

function exactObject(value, required, optional, path, checkKeys = true) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    manifestFailure(`${path} must be an object`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) manifestFailure(`${path}.${key} is required`);
  }
  if (checkKeys) {
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) manifestFailure(`${path}.${key} is an unrecognized field`);
    }
  }
}

function nonemptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) manifestFailure(`${path} must be a non-empty string`);
}

function stringArray(value, path) {
  if (!Array.isArray(value)) manifestFailure(`${path} must be an array`);
  value.forEach((entry, index) => nonemptyString(entry, `${path}[${index}]`));
  duplicateFree(value, path);
}

function objectArray(value, path) {
  if (!Array.isArray(value)) manifestFailure(`${path} must be an array`);
}

function duplicateFree(value, path) {
  if (new Set(value).size !== value.length) manifestFailure(`${path} must be duplicate-free`);
}

function validateHomeToken(token, path) {
  const match = HOME_TOKEN.exec(token);
  if (!match) manifestFailure(`${path} contains an invalid $HOME token`);
  const segments = match[1].split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." || /[\\*?\[\]{}$]/.test(segment)
    )
  ) manifestFailure(`${path} contains an invalid $HOME relative path`);
}

function expandHomeToken(token) {
  validateHomeToken(token, "manifest freshness.forks.defaultDirs");
  return join(homedir(), token.slice("$HOME/".length));
}

function manifestFailure(message) {
  console.error(`acp-deps: ${manifestPath}: ${message}`);
  process.exit(1);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    timeout: 120_000, // covers fetches and the on-demand temp clone
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

// Repo identity as owner/repo, normalized across https/ssh/local-path remote forms — URL-string
// equality would false-fail an ssh-configured origin (and hermetic tests use path remotes).
function repoSlug(url) {
  const segments = String(url).replace(/\.git$/, "").replace(/\\/g, "/").replaceAll(":", "/").split("/").filter(Boolean);
  return segments.length >= 2 ? segments.slice(-2).join("/").toLowerCase() : null;
}

// Verify + prepare one fork clone, then count upstream containment against its local checkout.
//
// Order matters: origin identity is verified FIRST and read-only — this gate must never mutate a
// repo that isn't provably the fork (it also self-diagnoses a GIT_DIR leak past the env scrub:
// the "wrong" repo's origin won't be the fork). Only then is the upstream remote added when
// missing or re-pointed when it names the wrong repo. After fetching both remotes the checkout is
// put on origin's default branch and brought current: a managed temp clone is hard-reset to
// origin; a working clone must be CLEAN (we never touch uncommitted work), is switched to the
// branch if needed, fast-forward pulled, and must have NO unpushed commits — releases are cut
// from the PUSHED fork main, so "merged upstream locally but never pushed" must stay a blocker
// even though the local diff would look in-sync.
function checkForkAt(dir, { originUrl, upstreamUrl, upstreamRemote, disposable }) {
  const actualOrigin = git(dir, "remote", "get-url", "origin");
  if (repoSlug(actualOrigin) !== repoSlug(originUrl)) {
    const resolved = git(dir, "rev-parse", "--absolute-git-dir");
    throw new Error(`clone at ${dir} has origin ${actualOrigin} — expected the fork ${originUrl} (git resolved dir: ${resolved})`);
  }

  let actualUpstream = null;
  try {
    actualUpstream = git(dir, "remote", "get-url", upstreamRemote);
  } catch {
    // remote not configured yet
  }
  if (actualUpstream === null) {
    git(dir, "remote", "add", upstreamRemote, upstreamUrl);
    console.error(`acp-deps: added missing '${upstreamRemote}' remote (${upstreamUrl}) to ${dir}`);
  } else if (repoSlug(actualUpstream) !== repoSlug(upstreamUrl)) {
    git(dir, "remote", "set-url", upstreamRemote, upstreamUrl);
    console.error(`acp-deps: re-pointed '${upstreamRemote}' remote of ${dir} (${actualUpstream} → ${upstreamUrl})`);
  }

  git(dir, "fetch", "--quiet", upstreamRemote);
  git(dir, "fetch", "--quiet", "origin");
  const originBranch = remoteDefaultBranch(dir, "origin");
  const upstreamBranch = remoteDefaultBranch(dir, upstreamRemote);

  if (disposable) {
    git(dir, "checkout", "--quiet", "-B", originBranch, `origin/${originBranch}`);
  } else {
    if (git(dir, "status", "--porcelain") !== "") {
      throw new Error(`clone at ${dir} has uncommitted changes — commit or stash them so the gate can pull ${originBranch}`);
    }
    const current = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    if (current !== originBranch) {
      git(dir, "switch", "--quiet", originBranch);
      console.error(`acp-deps: switched ${dir} from '${current}' to '${originBranch}'`);
    }
    git(dir, "pull", "--ff-only", "--quiet", "origin", originBranch);
    const unpushed = parseInt(git(dir, "rev-list", "--count", `origin/${originBranch}..HEAD`), 10);
    if (unpushed > 0) {
      throw new Error(
        `${dir} ${originBranch} has ${unpushed} commit(s) not pushed to origin — releases are cut from the pushed fork ${originBranch}; push first`,
      );
    }
  }

  const missing = parseInt(git(dir, "rev-list", "--count", `HEAD..${upstreamRemote}/${upstreamBranch}`), 10);
  return {
    where: dir,
    branch: originBranch,
    upstreamRef: `${upstreamUrl.replace(/\.git$/, "")}#${upstreamBranch}`,
    missing,
    fix: `cd ${dir} && git merge ${upstreamRemote}/${upstreamBranch} && git push origin ${originBranch}`,
  };
}

// Resolve which clone to check: an explicit envDir wins outright, then the default working-clone
// locations; with none on disk the gate clones the fork itself into <tmpdir>/<tempCloneName>
// (blob-filtered — full commit graph for the containment count, no blob download) and reuses that
// clone on later runs. A broken/hijacked temp clone is disposable: delete and re-clone once.
function checkFork(cfg) {
  const originUrl = process.env[cfg.originUrlEnv] || cfg.originUrl;
  const upstreamUrl = process.env[cfg.upstreamUrlEnv] || cfg.upstreamUrl;
  const opts = { originUrl, upstreamUrl, upstreamRemote: cfg.upstreamRemote };

  const envDir = process.env[cfg.envDir];
  const candidates = envDir ? [envDir] : cfg.defaultDirs;
  const workingClone = candidates.find((d) => existsSync(join(d, ".git")));
  if (workingClone) return checkForkAt(workingClone, { ...opts, disposable: false });

  const tempClone = join(tmpdir(), cfg.tempCloneName);
  const cloneFresh = () => {
    console.error(`acp-deps: no local fork clone found — cloning ${originUrl} to ${tempClone}`);
    git(tmpdir(), "clone", "--quiet", "--filter=blob:none", originUrl, tempClone);
  };
  try {
    if (!existsSync(join(tempClone, ".git"))) cloneFresh();
    return checkForkAt(tempClone, { ...opts, disposable: true });
  } catch {
    rmSync(tempClone, { recursive: true, force: true });
    cloneFresh();
    return checkForkAt(tempClone, { ...opts, disposable: true });
  }
}

const forkSync = Promise.all(
  FORK_SYNC
    .filter(({ dep }) => tracked.some((t) => t.dep === dep))
    .map(async ({ dep, config: cfg }) => {
      try {
        const result = checkFork(cfg);
        if (result.missing > 0) {
          forkIssues.push({ dep, ...result });
        } else {
          console.error(`acp-deps: fork ${result.where} (${result.branch}) contains upstream ${result.upstreamRef} — in sync`);
        }
      } catch (err) {
        blockers.push(
          `acp-deps: could not verify fork sync for ${dep} (${err.message}) — working clone via ${cfg.envDir} or ~/${cfg.tempCloneName}; otherwise the gate clones ${cfg.originUrl} itself`,
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
  WRAPPED_RUNTIMES
    .filter(({ dep }) => tracked.some((t) => t.dep === dep))
    .map(async ({ dep, wraps }) => {
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
