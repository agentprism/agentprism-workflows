import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/check-attribution.mjs, exercised end-to-end against a hermetic fixture repo.
//
// The gate exists because attribution reaches `main` on TWO axes, and only one of them is a
// commit message. Commit fc50fae (#297) landed a Claude co-author trailer while the
// message-only commit-msg hook was already in place: no branch commit message contained one —
// GitHub synthesized it at squash time out of a branch commit's agent AUTHOR IDENTITY. So the
// identity cases below are the regression, and the message cases guard the original rule.

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/check-attribution.mjs");

// Git-location env vars that would otherwise redirect the fixture repo's git calls at the
// repo running the suite (a hook-leaked GIT_DIR is the #162 shape).
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

type Identity = { name: string; email: string };

const HUMAN: Identity = { name: "Test Human", email: "human@example.com" };
const AGENT: Identity = { name: "Claude", email: "noreply@anthropic.com" };

function git(cwd: string, args: string[], identity: Identity = HUMAN): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv({
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: HUMAN.name,
      GIT_COMMITTER_EMAIL: HUMAN.email,
      GIT_AUTHOR_DATE: "2026-07-25T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-25T00:00:00Z",
    }),
  });
}

/** Run the gate; returns its exit code plus the combined output the developer would see. */
function runGate(cwd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnv(env),
  });
  return { code: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function commit(repo: string, message: string, identity: Identity = HUMAN): string {
  writeFileSync(join(repo, "file.txt"), `${message}\n`);
  git(repo, ["add", "file.txt"], identity);
  git(repo, ["commit", "--no-verify", "-m", message], identity);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

// The fixture repo carries its own identity in LOCAL config: a CI runner has no global
// user.name/user.email, so anything relying on ambient git config passes on a dev box and fails
// there. Every git call below also passes explicit *_IDENT env, making this belt-and-braces.
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "attribution-gate-"));
  git(repo, ["init", "--quiet", "--initial-branch=main", "."]);
  git(repo, ["config", "user.name", HUMAN.name]);
  git(repo, ["config", "user.email", HUMAN.email]);
  return repo;
}

/** Identity env for --message-file runs: git var resolves BOTH roles, so both must be set. */
function identityEnv(identity: Identity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

test("range mode: a clean history passes", () => {
  const repo = makeRepo();
  try {
    const base = commit(repo, "chore: base");
    commit(repo, "feat: something clean");
    const { code, output } = runGate(repo, [`${base}..HEAD`]);
    assert.equal(code, 0);
    assert.match(output, /no agent attribution — clear/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// THE REGRESSION. The message is spotless; only the author identity is the agent's — which is
// all GitHub needs to write a co-author trailer into the squash commit.
test("range mode: an agent AUTHOR identity is blocked even with a spotless message", () => {
  const repo = makeRepo();
  try {
    const base = commit(repo, "chore: base");
    commit(repo, "feat: message says nothing about any agent", AGENT);
    const { code, output } = runGate(repo, [`${base}..HEAD`]);
    assert.equal(code, 1);
    assert.match(output, /author identity is an Anthropic e-mail address/);
    assert.match(output, /GitHub synthesizes a/);
    // The identity finding is reported once, not once per matching pattern.
    assert.equal(output.match(/author identity is/g)?.length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("range mode: message-borne attribution is blocked", () => {
  const repo = makeRepo();
  try {
    const base = commit(repo, "chore: base");
    // Lower-case trailer on purpose: this is the casing GitHub emits, and the casing the
    // original grep-based hook's `Co-Authored-By:` pattern did not match.
    commit(repo, "feat: subject\n\nCo-authored-by: Claude <noreply@anthropic.com>");
    commit(repo, "feat: another\n\nClaude-Session: https://claude.ai/code/session_x");
    const { code, output } = runGate(repo, [`${base}..HEAD`]);
    assert.equal(code, 1);
    assert.match(output, /2 commits carry agent attribution/);
    assert.match(output, /Claude co-author trailer/);
    assert.match(output, /Claude session trailer/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Dependency-bump subjects in this repo routinely name claude-agent-sdk / @anthropic-ai
// packages. Those must not trip the gate, or the maintenance flow becomes unmergeable.
test("range mode: naming Claude packages in a subject is not attribution", () => {
  const repo = makeRepo();
  try {
    const base = commit(repo, "chore: base");
    commit(repo, "chore(deps): claude-agent-acp 0.60.0 + @anthropic-ai/claude-agent-sdk 0.3.215");
    commit(repo, "fix: stop agent-driven panel re-renders\n\nClaude polls the tool repeatedly.");
    const { code, output } = runGate(repo, [`${base}..HEAD`]);
    assert.equal(code, 0);
    assert.match(output, /2 commit\(s\) checked/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("range mode: excluded commits are not checked (already-pushed history stays out)", () => {
  const repo = makeRepo();
  try {
    commit(repo, "chore: base");
    const dirty = commit(repo, "feat: agent authored", AGENT);
    const clean = commit(repo, "feat: clean follow-up");
    // The pre-push shape: only what is being pushed. `dirty` is behind the boundary.
    const { code, output } = runGate(repo, [clean, "--not", dirty]);
    assert.equal(code, 0);
    assert.match(output, /1 commit\(s\) checked/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("range mode: an empty range is a pass, not a crash", () => {
  const repo = makeRepo();
  try {
    commit(repo, "chore: base");
    const { code, output } = runGate(repo, ["HEAD..HEAD"]);
    assert.equal(code, 0);
    assert.match(output, /no commits in range/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("message-file mode: clean message under a clean identity passes", () => {
  const repo = makeRepo();
  try {
    commit(repo, "chore: base");
    const messageFile = join(repo, "COMMIT_EDITMSG_FIXTURE");
    writeFileSync(messageFile, "feat: a clean subject\n\nA clean body.\n");
    const { code } = runGate(repo, ["--message-file", messageFile], identityEnv(HUMAN));
    assert.equal(code, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("message-file mode: rejects attribution in the pending message", () => {
  const repo = makeRepo();
  try {
    commit(repo, "chore: base");
    const messageFile = join(repo, "COMMIT_EDITMSG_FIXTURE");
    writeFileSync(messageFile, "feat: subject\n\n🤖 Generated with Claude Code\n");
    const { code, output } = runGate(repo, ["--message-file", messageFile], identityEnv(HUMAN));
    assert.equal(code, 1);
    assert.match(output, /"Generated with Claude" banner/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// `git var GIT_AUTHOR_IDENT` honors the GIT_AUTHOR_* env vars git sets for hooks during amend,
// cherry-pick and rebase — so replaying an agent-authored commit is caught at commit time, not
// only once it reaches a push.
test("message-file mode: rejects the identity git is about to stamp", () => {
  const repo = makeRepo();
  try {
    commit(repo, "chore: base");
    const messageFile = join(repo, "COMMIT_EDITMSG_FIXTURE");
    writeFileSync(messageFile, "feat: a spotless subject\n");
    const { code, output } = runGate(repo, ["--message-file", messageFile], identityEnv(AGENT));
    assert.equal(code, 1);
    assert.match(output, /author identity is/);
    assert.match(output, /--reset-author/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Regression: a fresh CI runner has no user.name/user.email anywhere, so `git var
// GIT_COMMITTER_IDENT` errors. The gate must still report on the MESSAGE rather than dying with
// a raw "Please tell me who you are" from git. Identity is unresolvable here, hence unchecked —
// safe, because git cannot write a commit object without one.
test("message-file mode: survives a host with no resolvable git identity", () => {
  const repo = makeRepo();
  try {
    const messageFile = join(repo, "COMMIT_EDITMSG_FIXTURE");
    writeFileSync(messageFile, "feat: subject\n\nCo-authored-by: Claude <noreply@anthropic.com>\n");
    // HOME/XDG redirected at the temp dir and local config stripped => no identity resolvable.
    git(repo, ["config", "--unset", "user.name"]);
    git(repo, ["config", "--unset", "user.email"]);
    const { code, output } = runGate(repo, ["--message-file", messageFile], {
      HOME: repo,
      XDG_CONFIG_HOME: repo,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: "",
      GIT_COMMITTER_NAME: "",
      GIT_COMMITTER_EMAIL: "",
    });
    assert.equal(code, 1);
    assert.match(output, /Claude co-author trailer/);
    assert.doesNotMatch(output, /Please tell me who you are/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("no arguments is a usage error, never a silent pass", () => {
  const repo = makeRepo();
  try {
    const { code, output } = runGate(repo, []);
    assert.equal(code, 2);
    assert.match(output, /usage: check-attribution\.mjs/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
