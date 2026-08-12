#!/usr/bin/env node
// ACP dependency freshness gate (policy: bump ACP deps at every release — see CONTRIBUTING.md).
// Three checks, exit 1 if any fails:
//   1. npm freshness: the pnpm-lock.yaml-resolved versions of the ACP client/agent libraries must
//      match the npm registry's `latest` dist-tag (prints the exact bump command per dep).
//   2. Source-upstream containment (SOURCE_UPSTREAMS): a workspace package that is our maintained
//      fork of an external repo (codex-acp at packages/codex-acp, imported as a non-squashed
//      subtree — #282) must CONTAIN its upstream's history. Version lines diverge, so versions
//      can't be compared — instead fetch the canonical upstream ref into THIS repository and
//      check git ancestry: `merge-base --is-ancestor <upstream tip> HEAD`. Sync policy is merge
//      (never rebase or squash), so ancestry is the right signal, and a squash/rebase import can
//      never satisfy it. When upstream has advanced, the fix is the upstream-sync PR: a
//      non-squashed subtree merge into the package path.
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

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "scripts", "acp-backends.manifest.json");
// Any workspace dependency under these scopes must appear in some backend's freshness.npm —
// the ACP protocol libraries and the pi runtime family both ride coordinated release lines,
// so an untracked package from either scope silently drifts out of step with its siblings.
const MANIFEST_COVERAGE_PREFIXES = Object.freeze(["@agentclientprotocol/", "@earendil-works/"]);
const NODE_FLOOR = /^>=(0|[1-9]\d*)(?:\.(0|[1-9]\d*)\.(0|[1-9]\d*))?$/;

const backendManifest = loadBackendManifest();
const manifestNpm = new Set(
  backendManifest.backends.flatMap((backend) => backend.freshness.npm),
);
if (manifestNpm.size === 0) {
  manifestFailure("backends derived freshness.npm set must not be empty");
}

// These three work sets are projections of the committed manifest, never authored gate lists.
const SOURCE_UPSTREAMS = Object.freeze(
  backendManifest.backends.flatMap((backend) =>
    backend.freshness.sourceUpstreams.map((upstream) => ({
      dep: upstream.package,
      config: upstream,
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

  exactObject(backend.freshness, ["npm", "sourceUpstreams", "wrappedRuntimes"], [], `${path}.freshness`);
  stringArray(backend.freshness.npm, `${path}.freshness.npm`);
  objectArray(backend.freshness.sourceUpstreams, `${path}.freshness.sourceUpstreams`);
  objectArray(backend.freshness.wrappedRuntimes, `${path}.freshness.wrappedRuntimes`);
  duplicateFree(
    backend.freshness.sourceUpstreams.map((upstream) => [
      upstream?.package,
      upstream?.path,
      upstream?.upstreamUrl,
      upstream?.upstreamUrlEnv,
      upstream?.upstreamRef,
    ].join("\u0000")),
    `${path}.freshness.sourceUpstreams`,
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

  backend.freshness.sourceUpstreams.forEach((upstream, upstreamIndex) => {
    const upstreamPath = `${path}.freshness.sourceUpstreams[${upstreamIndex}]`;
    exactObject(upstream, [
      "package", "path", "upstreamUrl", "upstreamUrlEnv", "upstreamRef",
    ], [], upstreamPath);
    for (const field of [
      "package", "path", "upstreamUrl", "upstreamUrlEnv", "upstreamRef",
    ]) nonemptyString(upstream[field], `${upstreamPath}.${field}`);
    if (backend.server.kind !== "workspace-package") {
      manifestFailure(`${upstreamPath} requires a workspace-package server`);
    } else if (upstream.package !== backend.server.package || upstream.path !== backend.server.path) {
      manifestFailure(`${upstreamPath} must reference the backend's workspace server package and path`);
    }
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

// ---- check 2: source-upstream containment --------------------------------------------------------
const upstreamIssues = []; // { dep, upstreamRef, missing, fix }

// Git-location env vars that git exports into hook child processes (e.g. GIT_DIR in a pre-push
// hook, pointing at THIS repo's .git *for a different worktree*). GIT_DIR overrides `-C <dir>`
// repo discovery, so a hook caller's inherited GIT_DIR could silently redirect every `git -C`
// below. Strip them from the child env so `-C <dir>` always wins.
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
    timeout: 120_000, // covers the upstream fetch
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }).trim();
}

// The repository whose HEAD must contain each source upstream. The env override exists solely so
// the hermetic tests can point the check at fixture repositories; every real invocation checks
// the repository this script lives in.
const SOURCE_SYNC_REPO = process.env.AGENTPRISM_SOURCE_SYNC_REPO_DIR || repoRoot;

// Fetch the canonical upstream ref into this repository's object store and require it to be an
// ancestor of HEAD. Merge-based sync makes ancestry the exact invariant: a non-squashed subtree
// merge satisfies it, and a squash or rebase import cannot (those manufacture new SHAs, so the
// true upstream tip is never reachable from HEAD).
function checkSourceUpstream(cfg) {
  const upstreamUrl = process.env[cfg.upstreamUrlEnv] || cfg.upstreamUrl;
  const dir = SOURCE_SYNC_REPO;
  git(dir, "fetch", "--quiet", upstreamUrl, cfg.upstreamRef);
  const upstreamSha = git(dir, "rev-parse", "FETCH_HEAD");
  const upstreamRef = `${upstreamUrl.replace(/\.git$/, "")}#${cfg.upstreamRef}`;
  try {
    git(dir, "merge-base", "--is-ancestor", upstreamSha, "HEAD");
    return { upstreamRef, missing: 0 };
  } catch {
    const missing = parseInt(git(dir, "rev-list", "--count", `HEAD..${upstreamSha}`), 10);
    return {
      upstreamRef,
      missing,
      fix: `open/refresh the upstream-sync PR: git subtree merge (NO --squash) of ${upstreamRef} into ${cfg.path}`,
    };
  }
}

const sourceUpstreamSync = Promise.all(
  SOURCE_UPSTREAMS.map(async ({ dep, config: cfg }) => {
    try {
      const result = checkSourceUpstream(cfg);
      if (result.missing > 0) {
        upstreamIssues.push({ dep, ...result });
      } else {
        console.error(`acp-deps: ${dep} (${cfg.path}) contains upstream ${result.upstreamRef} — in sync`);
      }
    } catch (err) {
      blockers.push(
        `acp-deps: could not verify upstream containment for ${dep} (${err.message}) — upstream ${cfg.upstreamUrl} must be reachable; the gate fails closed`,
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

await Promise.all([freshness, sourceUpstreamSync, wrappedRuntimes]);

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

if (upstreamIssues.length > 0) {
  console.error("");
  console.error("acp-deps: workspace package(s) BEHIND their source upstream — sync before pushing:");
  for (const { dep, upstreamRef, missing, fix } of upstreamIssues) {
    console.error(`  ${dep}: upstream ${upstreamRef} has ${missing} commit(s) not contained in HEAD`);
    console.error(`    → ${fix}`);
    console.error(`    → review the upstream changes, add a ${dep} changeset, and merge the sync PR`);
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

// Staleness (as opposed to an unverifiable blocker) always carries a judgment call the
// remediation commands above cannot make: whether upstream's changes touch a surface we
// integrate against. Spell that out here so whoever hits the gate — human or agent — never
// treats "make the gate green" as the whole task (owner directive, 2026-08-12).
const stale = outdated.length > 0 || upstreamIssues.length > 0 || wrappedIssues.length > 0;
if (stale) {
  console.error("");
  console.error("acp-deps: a pin bump alone is only the right fix when upstream changed NOTHING we");
  console.error("  integrate against. For EACH stale item above: read the upstream release notes /");
  console.error("  changelog (and for substantial jumps the source diff of the surfaces we consume),");
  console.error("  then pick the shape:");
  console.error("    1. mechanical      — no integrated surface changed: the bump + changeset IS the fix");
  console.error("    2. surface changed — upstream broke or changed an API/wire surface we consume:");
  console.error("                         adapt our integration code in the SAME PR as the bump;");
  console.error("                         never land a bare bump just to get past the gate");
  console.error("    3. new capability  — land the mechanical bump to unblock the gate, and file a");
  console.error("                         tracking issue so the capability work is not lost");
  console.error('  Our integration surface per dependency: CONTRIBUTING.md "ACP dependency surface map".');
}

const failed = stale || blockers.length > 0;
if (failed) {
  console.error("");
  console.error('acp-deps: triage runbook: CONTRIBUTING.md "When the dependency gate blocks"');
}
process.exit(failed ? 1 : 0);
