import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/check-acp-deps.mjs fork-sync check, exercised end-to-end against hermetic fixtures.
//
// Covers the #162 regression (a hook-leaked GIT_DIR must not defeat `git -C`) plus the
// clone-first design: remote identity verification (origin must be the fork — read-only, BEFORE
// any mutation), auto-repair of the upstream remote, the temp-clone fallback when no working
// clone exists (including reuse across runs), the clean-tree and fully-pushed requirements on a
// working clone, and the out-of-sync report when upstream has unmerged commits.
//
// Fixture remotes are local bare repos whose paths END in the expected owner/repo slugs
// (VikashLoomba/codex-acp, agentclientprotocol/codex-acp) — the gate compares remote identity by
// slug, exactly so https/ssh/path forms of the same repo all match. The npm-freshness portion is
// pointed at a refused port (fails fast as blockers); assertions only concern fork-sync lines.

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/check-acp-deps.mjs");
const DEAD_REGISTRY = "http://127.0.0.1:9";

// git-location env vars that must never leak into the setup git calls below.
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

function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  return { ...env, ...overrides };
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo(dir: string, bare: boolean): void {
  mkdirSync(dirname(dir), { recursive: true });
  git("init", ...(bare ? ["--bare"] : []), "-b", "main", dir);
  if (!bare) {
    git("-C", dir, "config", "user.email", "test@example.com");
    git("-C", dir, "config", "user.name", "Test");
    git("-C", dir, "config", "commit.gpgsign", "false");
  }
}

interface ForkFixture {
  originBare: string; // .../VikashLoomba/codex-acp — slug-matches the gate's expected fork
  upstreamBare: string; // .../agentclientprotocol/codex-acp — slug-matches the true upstream
  fork: string; // working clone with origin (+ optionally upstream), seeded and pushed to both
}

function makeForkFixture(tmp: string, opts: { withUpstreamRemote?: boolean } = {}): ForkFixture {
  const originBare = join(tmp, "remotes", "VikashLoomba", "codex-acp");
  const upstreamBare = join(tmp, "remotes", "agentclientprotocol", "codex-acp");
  const fork = join(tmp, "fork");
  initRepo(originBare, true);
  initRepo(upstreamBare, true);
  initRepo(fork, false);
  writeFileSync(join(fork, "README"), "seed\n");
  git("-C", fork, "add", ".");
  git("-C", fork, "commit", "-m", "seed");
  git("-C", fork, "remote", "add", "origin", originBare);
  if (opts.withUpstreamRemote !== false) git("-C", fork, "remote", "add", "upstream", upstreamBare);
  git("-C", fork, "push", "--quiet", "origin", "main");
  git("-C", fork, "push", "--quiet", upstreamBare, "main");
  return { originBare, upstreamBare, fork };
}

function runGate(env: Record<string, string>): string {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: cleanEnv({ AGENTPRISM_NPM_REGISTRY: DEAD_REGISTRY, GIT_TERMINAL_PROMPT: "0", ...env }),
  });
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

test("fork-sync honours -C and ignores a hook-leaked GIT_DIR (#162)", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "acp-fork-sync-"));
  try {
    const { fork } = makeForkFixture(tmp);

    // The repo whose GIT_DIR the pre-push hook leaks. Its origin is NOT the fork, so if GIT_DIR
    // ever defeated -C the gate would fail on origin identity (read-only, before any mutation)
    // rather than silently checking — or worse, repairing — the wrong repository.
    const wrong = join(tmp, "wrong");
    const unrelatedBare = join(tmp, "remotes", "someoneelse", "unrelated");
    initRepo(unrelatedBare, true);
    initRepo(wrong, false);
    writeFileSync(join(wrong, "README"), "wrong\n");
    git("-C", wrong, "add", ".");
    git("-C", wrong, "commit", "-m", "wrong");
    git("-C", wrong, "remote", "add", "origin", unrelatedBare);

    const out = runGate({
      GIT_DIR: join(wrong, ".git"), // exported into hook children by git; must not defeat -C
      AGENTPRISM_CODEX_ACP_DIR: fork,
    });

    assert.ok(
      !out.includes("expected the fork"),
      `fork-sync checked the wrong repo — a leaked GIT_DIR defeated -C:\n${out}`,
    );
    assert.ok(
      out.includes(`fork ${fork}`) && out.includes("contains upstream") && out.includes("in sync"),
      `fork-sync did not report the intended clone in sync:\n${out}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fork-sync adds a missing upstream remote instead of failing", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "acp-fork-sync-"));
  try {
    const { fork, upstreamBare } = makeForkFixture(tmp, { withUpstreamRemote: false });
    const out = runGate({
      AGENTPRISM_CODEX_ACP_DIR: fork,
      AGENTPRISM_CODEX_ACP_UPSTREAM_URL: upstreamBare,
    });
    assert.ok(out.includes("added missing 'upstream' remote"), out);
    assert.ok(out.includes("in sync"), out);
    assert.equal(git("-C", fork, "remote", "get-url", "upstream").trim(), upstreamBare);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fork-sync clones to the temp dir when no working clone exists, and reuses it", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "acp-fork-sync-"));
  try {
    const { originBare, upstreamBare } = makeForkFixture(tmp);
    const scratch = join(tmp, "scratch");
    mkdirSync(scratch);
    const env = {
      AGENTPRISM_CODEX_ACP_DIR: join(tmp, "does-not-exist"),
      AGENTPRISM_CODEX_ACP_ORIGIN_URL: originBare,
      AGENTPRISM_CODEX_ACP_UPSTREAM_URL: upstreamBare,
      TMPDIR: scratch,
    };

    const first = runGate(env);
    assert.ok(first.includes("no local fork clone found — cloning"), first);
    assert.ok(first.includes("in sync"), first);
    assert.ok(existsSync(join(scratch, "codex-acp", ".git")), "temp clone was not created");

    const second = runGate(env);
    assert.ok(!second.includes("no local fork clone found"), `expected temp-clone reuse:\n${second}`);
    assert.ok(second.includes("in sync"), second);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a disposable broken clone is deleted and re-cloned exactly once", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "acp-fork-sync-"));
  try {
    const { originBare, upstreamBare } = makeForkFixture(tmp);
    const scratch = join(tmp, "scratch");
    const disposable = join(scratch, "codex-acp");
    const wrongBare = join(tmp, "remotes", "wrong-owner", "wrong-repo");
    mkdirSync(scratch);
    initRepo(wrongBare, true);
    git("clone", "--quiet", wrongBare, disposable);

    const out = runGate({
      AGENTPRISM_CODEX_ACP_DIR: join(tmp, "does-not-exist"),
      AGENTPRISM_CODEX_ACP_ORIGIN_URL: originBare,
      AGENTPRISM_CODEX_ACP_UPSTREAM_URL: upstreamBare,
      TMPDIR: scratch,
    });

    assert.equal(
      out.split("no local fork clone found — cloning").length - 1,
      1,
      `the one-repair contract must perform exactly one replacement clone:\n${out}`,
    );
    assert.ok(out.includes("in sync"), out);
    assert.equal(git("-C", disposable, "remote", "get-url", "origin").trim(), originBare);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fork-sync blocks on a dirty working clone", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "acp-fork-sync-"));
  try {
    const { fork } = makeForkFixture(tmp);
    writeFileSync(join(fork, "WIP"), "uncommitted\n");
    const out = runGate({ AGENTPRISM_CODEX_ACP_DIR: fork });
    assert.ok(out.includes("uncommitted changes"), out);
    assert.ok(out.includes("could not verify fork sync"), out);
    assert.ok(out.includes("fails closed"), out);
    assert.ok(existsSync(join(fork, "WIP")), "a selected working clone must never be deleted or repaired");
    assert.ok(!out.includes("no local fork clone found — cloning"), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fork-sync blocks on unpushed local commits (releases cut from pushed main)", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "acp-fork-sync-"));
  try {
    const { fork } = makeForkFixture(tmp);
    writeFileSync(join(fork, "LOCAL"), "merged upstream locally, never pushed\n");
    git("-C", fork, "add", ".");
    git("-C", fork, "commit", "-m", "local-only sync");
    const out = runGate({ AGENTPRISM_CODEX_ACP_DIR: fork });
    assert.ok(out.includes("not pushed to origin"), out);
    assert.ok(out.includes("could not verify fork sync"), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fork-sync reports OUT OF SYNC when upstream has unmerged commits", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "acp-fork-sync-"));
  try {
    const { fork, upstreamBare } = makeForkFixture(tmp);
    // Land a commit on upstream main that the fork has not merged.
    const upstreamWork = join(tmp, "upstream-work");
    git("clone", "--quiet", upstreamBare, upstreamWork);
    git("-C", upstreamWork, "config", "user.email", "test@example.com");
    git("-C", upstreamWork, "config", "user.name", "Test");
    git("-C", upstreamWork, "config", "commit.gpgsign", "false");
    writeFileSync(join(upstreamWork, "UPSTREAM"), "new upstream work\n");
    git("-C", upstreamWork, "add", ".");
    git("-C", upstreamWork, "commit", "-m", "upstream advance");
    git("-C", upstreamWork, "push", "--quiet", "origin", "main");

    const out = runGate({ AGENTPRISM_CODEX_ACP_DIR: fork });
    assert.ok(out.includes("OUT OF SYNC"), out);
    assert.ok(out.includes("1 commit(s) not in"), out);
    assert.ok(out.includes("git merge upstream/main"), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
