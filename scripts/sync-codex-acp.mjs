#!/usr/bin/env node
// One-command codex-acp upstream sync — the runbook in CONTRIBUTING.md "The codex-acp
// upstream-sync leg" encoded as a script, so the error-prone parts of the ceremony cannot be
// gotten wrong by hand:
//   - the merge is ALWAYS a non-squashed subtree merge (there is no --squash path to mistype;
//     the containment gate requires real ancestry, which a squash can never satisfy),
//   - the recurring mechanical conflicts resolve by their documented policies (fork's
//     lockfile/workflow deletions stay deleted, the changesets-owned CHANGELOG.md wins),
//   - the merged upstream tip is recorded in scripts/attribution-foreign-heads.json in the
//     same change (forgetting it turns CI's attribution leg red on the sync PR),
//   - a changeset is scaffolded but NEVER auto-filled: automation must not guess the bump
//     size, and --pr refuses to deliver while the placeholder text is still present — the
//     human review of upstream changes is where the judgment lives (see the surface map in
//     CONTRIBUTING.md), the script only makes skipping it mechanically impossible,
//   - delivery arms `gh pr merge --auto --merge`: a sync PR must merge as a MERGE COMMIT —
//     the squash button destroys the subtree merge server-side even when the branch is right.
//
// Usage:
//   node scripts/sync-codex-acp.mjs            start: branch off origin/main, fetch, merge
//   node scripts/sync-codex-acp.mjs --finish   after resolving any remaining conflicts:
//                                              verify ancestry, record the tip, scaffold the
//                                              changeset, run the fork suite + gates
//   node scripts/sync-codex-acp.mjs --pr       push + open the PR + arm auto-merge (--merge)
//
// Upstream location/ref come from scripts/acp-backends.manifest.json (the same rows the
// dependency gate enforces), so the sync and the gate can never disagree about what
// "upstream" means. Zero dependencies; git + gh + Node built-ins only.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FOREIGN_HEADS = join(repoRoot, "scripts", "attribution-foreign-heads.json");
const PLACEHOLDER = "EDIT ME (bump size above, upstream summary here)";

function fail(message) {
  console.error(`sync-codex-acp: ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  }).trim();
}

// Like git(), but conflict-producing merges exit non-zero by design — return status instead.
function gitAllowFail(...args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 300_000 });
  return { status: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", timeout: 1_800_000, ...options });
  return result.status ?? 1;
}

function upstreamConfig() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "scripts", "acp-backends.manifest.json"), "utf8"));
  for (const backend of manifest.backends) {
    for (const upstream of backend.freshness.sourceUpstreams) {
      if (upstream.package === "@automatalabs/codex-acp") {
        return { ...upstream, url: process.env[upstream.upstreamUrlEnv] || upstream.upstreamUrl };
      }
    }
  }
  fail("no codex-acp sourceUpstreams row in scripts/acp-backends.manifest.json");
}

function conflictedPaths() {
  const out = git("diff", "--name-only", "--diff-filter=U");
  return out === "" ? [] : out.split("\n");
}

function changesetPath(shortTip) {
  return join(repoRoot, ".changeset", `codex-acp-upstream-${shortTip}.md`);
}

const cfg = upstreamConfig();
const mode = process.argv[2] ?? "";
if (!["", "--finish", "--pr"].includes(mode)) fail(`unknown mode ${mode}`);

git("fetch", "--quiet", cfg.url, cfg.upstreamRef);
const tip = git("rev-parse", "FETCH_HEAD");
const shortTip = tip.slice(0, 7);

if (mode === "") {
  // Tracked-file cleanliness only: untracked files (local notes, .mcp.json) don't block a merge.
  if (git("status", "--porcelain", "--untracked-files=no") !== "") {
    fail("working tree has uncommitted tracked changes — commit or stash first");
  }
  const contained = gitAllowFail("merge-base", "--is-ancestor", tip, "HEAD").status === 0;
  if (contained) {
    console.log(`sync-codex-acp: ${cfg.path} already contains upstream ${shortTip} — nothing to do`);
    process.exit(0);
  }

  git("fetch", "--quiet", "origin", "main");
  const branch = `sync/codex-acp-${shortTip}`;
  if (gitAllowFail("rev-parse", "--verify", branch).status === 0) fail(`branch ${branch} already exists`);
  git("checkout", "-q", "-b", branch, "origin/main");

  console.log(`sync-codex-acp: upstream ${cfg.url}#${cfg.upstreamRef} is ahead by:`);
  console.log(git("log", "--oneline", `HEAD..${tip}`));
  console.log("");
  console.log("sync-codex-acp: REVIEW THE CHANGES ABOVE — a sync is not only a merge. If any");
  console.log('  commit touches a surface we integrate against (CONTRIBUTING.md "ACP dependency');
  console.log('  surface map"), adapt our code on this branch as part of the same PR.');
  console.log("");

  const merge = gitAllowFail(
    "merge", "-X", `subtree=${cfg.path}`, "--no-ff", tip,
    "-m", `sync(codex-acp): merge upstream agentclientprotocol/codex-acp ${cfg.upstreamRef} (${shortTip}) into ${cfg.path}`,
  );
  if (merge.status !== 0) {
    // Known-policy conflicts resolve mechanically; everything else stays for human judgment.
    for (const path of conflictedPaths()) {
      const inPackage = path.startsWith(`${cfg.path}/`);
      if (inPackage && (path.endsWith("/package-lock.json") || path.includes("/.github/workflows/"))) {
        // The fork deliberately deleted upstream's npm lockfile and GitHub workflows; every
        // sync re-raises them as modify/delete conflicts. Deletion stands.
        gitAllowFail("rm", "-q", "-f", path);
        console.log(`sync-codex-acp: auto-resolved ${path} (fork deletion stands)`);
      } else if (path === `${cfg.path}/CHANGELOG.md`) {
        // Changesets owns the fork's CHANGELOG.md; upstream's release-please changelog for the
        // same path loses (its content remains reachable in the merged upstream history).
        git("checkout", "--ours", path);
        git("add", path);
        console.log(`sync-codex-acp: auto-resolved ${path} (changesets-owned, ours)`);
      }
    }
    const remaining = conflictedPaths();
    if (remaining.length > 0) {
      console.log("");
      console.log("sync-codex-acp: conflicts needing human judgment remain:");
      for (const path of remaining) console.log(`  ${path}`);
      console.log(`  ${cfg.path}/package.json: keep the FORK's version/description (its version line`);
      console.log("    is independent of upstream's); keep upstream's dependency changes.");
      console.log("  Source files: keep BOTH sides — fork-owned constructor parameters stay LAST so");
      console.log("    upstream call sites keep positional compatibility.");
      console.log("");
      console.log("  Resolve + `git add`, then run: node scripts/sync-codex-acp.mjs --finish");
      process.exit(2);
    }
    git("commit", "--no-edit", "-q");
  }
  console.log("sync-codex-acp: merge committed cleanly — continuing to --finish");
}

// ---- finish: verify + record + scaffold + gates (runs for start-without-conflicts too) ----

if (mode !== "--pr") {
  if (conflictedPaths().length > 0) fail("unresolved conflicts — resolve and `git add` first");
  if (existsSync(join(git("rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))) {
    git("commit", "--no-edit", "-q");
  }
  // Real conflict markers carry a trailing space + label (`<<<<<<< HEAD`); a bare ======= line
  // is a legitimate setext heading underline in docs, so it is not scanned for.
  const markerScan = gitAllowFail("grep", "-l", "-E", "^(<{7}|>{7}) ", "--", cfg.path);
  if (markerScan.status === 0) fail(`conflict markers remain in:\n${markerScan.out}`);
  if (gitAllowFail("merge-base", "--is-ancestor", tip, "HEAD").status !== 0) {
    fail(`upstream tip ${shortTip} is NOT an ancestor of HEAD — the merge was squashed or lost; start over from origin/main`);
  }

  // Record the merged tip so the attribution gate exempts the imported foreign commits.
  const heads = JSON.parse(readFileSync(FOREIGN_HEADS, "utf8"));
  if (!heads.heads.some((h) => h.sha === tip)) {
    heads.heads.push({
      sha: tip,
      imported: new Date().toISOString().slice(0, 10),
      what: `codex-acp upstream sync: agentclientprotocol/codex-acp ${cfg.upstreamRef} (${git("log", "-1", "--format=%s", tip)})`,
    });
    writeFileSync(FOREIGN_HEADS, `${JSON.stringify(heads, null, 2)}\n`);
    console.log("sync-codex-acp: recorded tip in scripts/attribution-foreign-heads.json");
  }

  if (!existsSync(changesetPath(shortTip))) {
    writeFileSync(changesetPath(shortTip), [
      "---",
      '"@automatalabs/codex-acp": patch',
      "---",
      "",
      `Sync with upstream agentclientprotocol/codex-acp ${cfg.upstreamRef} (non-squashed subtree merge of \`${shortTip}\`).`,
      PLACEHOLDER,
      "",
    ].join("\n"));
    console.log(`sync-codex-acp: scaffolded ${changesetPath(shortTip)} — set the bump size and`);
    console.log("  summarize the upstream changes (what changed, what we adapted). --pr refuses");
    console.log("  to deliver while the placeholder is present.");
  }
  git("add", "-A");
  if (git("status", "--porcelain") !== "") {
    git("commit", "-q", "-m", `chore(codex-acp): record upstream sync tip ${shortTip} in attribution-foreign-heads + changeset`);
  }

  console.log("sync-codex-acp: running the fork suite (excluded from the CI matrix — the sync is");
  console.log("  where it runs) + the dependency and attribution gates…");
  if (run("pnpm", ["--filter", "@automatalabs/codex-acp", "exec", "vitest", "run"]) !== 0) {
    fail("codex-acp fork suite failed — fix before delivering (upstream may have changed an integrated surface)");
  }
  if (run("node", [join(repoRoot, "scripts", "check-acp-deps.mjs")]) !== 0) {
    console.error("sync-codex-acp: dependency gate still red — if only OTHER deps are stale, fix them");
    console.error("  on this branch too (the maintenance PR carries every pending bump), then re-run --finish.");
    process.exit(1);
  }
  if (run("node", [join(repoRoot, "scripts", "check-attribution.mjs"), "origin/main..HEAD"]) !== 0) {
    fail("attribution gate failed on origin/main..HEAD");
  }
  console.log("");
  console.log("sync-codex-acp: READY. Review the branch (surface adaptations included?), finish the");
  console.log("  changeset, then deliver with: node scripts/sync-codex-acp.mjs --pr");
  process.exit(0);
}

// ---- --pr: deliver (merge-commit auto-merge; the squash button must never touch a sync PR) ----

const changeset = changesetPath(shortTip);
if (!existsSync(changeset)) fail(`missing ${changeset} — run --finish first`);
if (readFileSync(changeset, "utf8").includes(PLACEHOLDER)) {
  fail("the changeset still contains the scaffold placeholder — automation must not guess the bump size; describe the upstream changes first");
}
const branchName = git("rev-parse", "--abbrev-ref", "HEAD");
if (!branchName.startsWith("sync/codex-acp-")) fail(`HEAD is ${branchName}, not a sync/codex-acp-* branch`);
if (run("git", ["-C", repoRoot, "push", "-u", "origin", branchName]) !== 0) {
  fail("push failed (pre-push hook output above)");
}
const title = `sync(codex-acp): upstream ${cfg.upstreamRef} ${shortTip}`;
const body = `Non-squashed subtree merge of agentclientprotocol/codex-acp ${cfg.upstreamRef} (\`${tip}\`) into ${cfg.path}, via scripts/sync-codex-acp.mjs.\n\n**Merge method: MERGE COMMIT (auto-merge armed with --merge). Do not squash — a squash destroys the imported history and re-reds the containment gate.**`;
if (run("gh", ["pr", "create", "--title", title, "--body", body]) !== 0) fail("gh pr create failed");
if (run("gh", ["pr", "merge", "--auto", "--merge"]) !== 0) fail("gh pr merge --auto --merge failed");
console.log("sync-codex-acp: PR open, auto-merge armed (merge commit). CI is the final gate.");
