import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression for #162: scripts/check-acp-deps.mjs's fork-sync check ran `git -C <cloneDir> …`
// but inherited the parent environment. Git exports GIT_DIR into hook child processes, and
// GIT_DIR overrides `-C` repo discovery — so inside the pre-push hook every `git -C <fork>`
// actually queried THIS repo, saw no `upstream` remote, and the check warn-skipped on every push.
// The fix strips the git-location env vars in the git() helper so `-C` always wins. This test
// runs the real script with GIT_DIR pointing at the WRONG repo (as the hook does) and asserts the
// fork-sync check still queries the intended clone.

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/check-acp-deps.mjs");

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
  git("init", ...(bare ? ["--bare"] : []), "-b", "main", dir);
  if (!bare) {
    git("-C", dir, "config", "user.email", "test@example.com");
    git("-C", dir, "config", "user.name", "Test");
    git("-C", dir, "config", "commit.gpgsign", "false");
  }
}

test("fork-sync check honours -C and ignores a hook-leaked GIT_DIR (#162)", { timeout: 60_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "acp-fork-sync-"));
  try {
    const originBare = join(tmp, "origin.git");
    const upstreamBare = join(tmp, "upstream.git");
    const fork = join(tmp, "fork"); // the codex-acp clone the check should query (origin + upstream)
    const wrong = join(tmp, "wrong"); // the repo GIT_DIR points at (origin only — no upstream)

    initRepo(originBare, true);
    initRepo(upstreamBare, true);

    // A fork clone with both remotes; origin and upstream share the same commit → in sync.
    initRepo(fork, false);
    writeFileSync(join(fork, "README"), "seed\n");
    git("-C", fork, "add", ".");
    git("-C", fork, "commit", "-m", "seed");
    git("-C", fork, "remote", "add", "origin", originBare);
    git("-C", fork, "remote", "add", "upstream", upstreamBare);
    git("-C", fork, "push", "origin", "main");
    git("-C", fork, "push", "upstream", "main");

    // The repo whose GIT_DIR the pre-push hook leaks: it has NO 'upstream' remote, so if GIT_DIR
    // wins over -C the check throws "has no 'upstream' remote" and warn-skips (the #162 bug).
    initRepo(wrong, false);
    writeFileSync(join(wrong, "README"), "wrong\n");
    git("-C", wrong, "add", ".");
    git("-C", wrong, "commit", "-m", "wrong");
    git("-C", wrong, "remote", "add", "origin", originBare);

    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_DIR: join(wrong, ".git"), // exported into hook children by git; must not defeat -C
        AGENTPRISM_CODEX_ACP_DIR: fork, // fork-sync must resolve to this clone
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    // We assert only on the fork-sync line; the npm-freshness portion may pass/warn/fail on network
    // and its exit status is irrelevant here.
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;

    assert.ok(
      !out.includes("has no 'upstream' remote"),
      `fork-sync warn-skipped — a leaked GIT_DIR defeated -C:\n${out}`,
    );
    assert.ok(
      out.includes(`fork ${fork}`) && out.includes("contains upstream") && out.includes("in sync"),
      `fork-sync did not report the intended clone in sync:\n${out}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
