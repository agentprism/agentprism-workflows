#!/usr/bin/env node
// Attribution gate: no agent attribution enters this history — not in commit MESSAGES, and not in
// commit IDENTITIES (author/committer name + email). NO BYPASSES (owner policy, 2026-07-23;
// identity axis added 2026-07-25 after a squash merge manufactured a co-author trailer out of an
// agent-authored branch commit).
//
// WHY THE IDENTITY AXIS EXISTS. Commit fc50fae ("stop agent-driven run-monitor re-renders", #297)
// landed on main carrying a Claude co-author trailer while the message-only commit-msg hook was
// already in place — and NONE of the three branch commits' messages contained one. The trailer was
// synthesized by GITHUB at squash time: with squash_merge_commit_message=COMMIT_MESSAGES, GitHub
// appends a co-author trailer for every distinct AUTHOR IDENTITY among the squashed commits, and
// branch commit ad2a30ac had been authored under the agent identity (committer was the owner).
// Two gaps had to be open at once: the hook never inspected identity, and the offending text was
// generated server-side, after the last local hook could run. This gate closes both axes.
//
// Zero dependencies (git + Node built-ins only). Two modes:
//   --message-file <path>   check ONE pending commit message + the identity git is about to stamp
//   <rev-list args...>      check every commit a `git rev-list` expression selects, e.g.
//                             check-attribution.mjs base..head
//                             check-attribution.mjs --no-walk <sha>
//                             check-attribution.mjs <sha> --not --remotes=origin
//
// Enforced in THREE places, no bypass: .githooks/commit-msg (every local commit),
// .githooks/pre-push (every dev push, over the commits actually being pushed), and the required
// "Build & test" CI job (every PR, over base..head). Only the CI leg runs before the squash
// button, so it is the one that actually stops the identity path — the local hooks are the
// fast-feedback layers in front of it.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Field/record separators for the git log format below. Written as escapes on BOTH sides (the
// `%x1f` git placeholder here, `\x1f` in the split) so no raw control byte ever lands in a source
// file — a literal one makes git classify the file as binary and elide it from every diff.
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

const MESSAGE_PATTERNS = [
  { re: /^[ \t]*Claude-Session:/im, what: "Claude session trailer" },
  { re: /claude\.ai\/code/i, what: "Claude session link" },
  { re: /^[ \t]*Co-authored-by:.*(claude|anthropic)/im, what: "Claude co-author trailer" },
  { re: /@anthropic\.com/i, what: "Anthropic e-mail address" },
  { re: /Generated with.*Claude/i, what: '"Generated with Claude" banner' },
];

// Identity axis. The e-mail domain is the load-bearing signal (it is what GitHub turns into a
// synthesized co-author trailer); the name check catches identities configured with a non-Anthropic
// address. Both block — a human contributor legitimately named "Claude" would need the policy
// revisited, which is the correct outcome rather than a silent carve-out.
const IDENTITY_PATTERNS = [
  { re: /@anthropic\.com\s*$/i, field: "email", what: "an Anthropic e-mail address" },
  { re: /^claude\b/i, field: "name", what: "an agent identity" },
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function messageProblems(message) {
  return MESSAGE_PATTERNS.filter(({ re }) => re.test(message)).map(({ what }) => `message contains ${what}`);
}

// One finding per role, not per pattern: an agent identity usually trips both the address and
// the name check, and reporting that twice reads like two separate defects.
function identityProblems(role, name, email) {
  const fields = { name, email };
  const matched = IDENTITY_PATTERNS.filter(({ re, field }) => re.test(fields[field]));
  if (matched.length === 0) return [];
  const reasons = matched.map(({ what }) => what).join(" / ");
  return [`${role} identity is ${reasons}: ${name} <${email}>`];
}

// `git var GIT_AUTHOR_IDENT` resolves exactly what git is about to stamp on the pending commit,
// honoring the GIT_AUTHOR_*/GIT_COMMITTER_* env vars git sets for hooks during amend, cherry-pick
// and rebase — so an agent-authored commit being replayed is caught, not just a misconfigured
// user.email. Format: "Name <email> <unix-ts> <tz>".
// Returns null when git cannot resolve an identity at all (no user.name/user.email anywhere — the
// state of a fresh CI runner). Skipping the check there is safe rather than fail-open: git refuses
// to write a commit object without an identity, so the commit cannot exist to carry attribution,
// and git's own "Please tell me who you are" message is the useful one to surface.
function pendingIdentity(role) {
  let ident;
  try {
    ident = git(["var", `GIT_${role.toUpperCase()}_IDENT`], { stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  const match = /^(.*?)\s*<([^>]*)>/.exec(ident);
  return match ? { name: match[1], email: match[2] } : null;
}

function checkMessageFile(path) {
  const inMessage = messageProblems(readFileSync(path, "utf8"));
  const inIdentity = [];
  for (const role of ["author", "committer"]) {
    const identity = pendingIdentity(role);
    if (identity) inIdentity.push(...identityProblems(role, identity.name, identity.email));
  }
  if (inMessage.length === 0 && inIdentity.length === 0) return 0;

  console.error("attribution: REJECTED — this commit carries agent attribution:");
  for (const problem of [...inIdentity, ...inMessage]) console.error(`  ✗ ${problem}`);
  console.error("");
  if (inMessage.length > 0) {
    console.error("  Remove the attribution (session link, co-author trailer, banner) from the message.");
  }
  if (inIdentity.length > 0) {
    console.error("  Re-stamp the commit under your own identity — an agent author identity alone is");
    console.error("  enough for GitHub to synthesize a co-author trailer at squash-merge time:");
    console.error("    git commit --amend --reset-author --no-edit   # for an already-made commit");
    console.error("    git config user.name / user.email             # if this shell's identity is wrong");
  }
  console.error("  Do not weaken this gate to get a commit through (owner policy).");
  return 1;
}

function checkRange(revListArgs) {
  const revs = git(["rev-list", ...revListArgs]).split("\n").filter(Boolean);
  if (revs.length === 0) {
    console.log("attribution: no commits in range — nothing to check");
    return 0;
  }

  const format = ["%H", "%an", "%ae", "%cn", "%ce", "%B"].join("%x1f") + "%x1e";
  const records = git(["log", "--no-walk", "--stdin", `--format=${format}`], { input: revs.join("\n") })
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter(Boolean);

  const offenders = [];
  for (const record of records) {
    const [sha, authorName, authorEmail, committerName, committerEmail, message = ""] =
      record.split(FIELD_SEP);
    const problems = [
      ...identityProblems("author", authorName, authorEmail),
      ...identityProblems("committer", committerName, committerEmail),
      ...messageProblems(message),
    ];
    if (problems.length > 0) {
      offenders.push({ sha, subject: message.split("\n")[0], problems });
    }
  }

  if (offenders.length === 0) {
    console.log(`attribution: ${revs.length} commit(s) checked, no agent attribution — clear`);
    return 0;
  }

  const plural = offenders.length === 1 ? "commit carries" : "commits carry";
  console.error(`attribution: ${offenders.length} ${plural} agent attribution — BLOCKED:`);
  for (const { sha, subject, problems } of offenders) {
    console.error("");
    console.error(`  ${sha.slice(0, 8)}  ${subject}`);
    for (const problem of problems) console.error(`    ✗ ${problem}`);
  }
  console.error("");
  console.error("  An agent AUTHOR identity is enough on its own: GitHub synthesizes a");
  console.error("  \"Co-authored-by:\" trailer from it when the PR is squash-merged, so the trailer");
  console.error("  appears on main even though no branch commit message ever contained one.");
  console.error("");
  console.error("  Fix by rewriting the offending commits, then force-push the branch:");
  console.error("    git rebase origin/main --exec 'git commit --amend --no-edit --reset-author'");
  console.error("    git rebase -i origin/main   # to reword a message instead");
  console.error("  --reset-author re-stamps the commit with your configured user.name/user.email.");
  console.error("  There is no bypass: the same gate is a step of the required CI job.");
  return 1;
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: check-attribution.mjs --message-file <path>");
  console.error("       check-attribution.mjs <git rev-list args...>");
  process.exit(2);
}

process.exit(
  argv[0] === "--message-file" ? checkMessageFile(argv[1]) : checkRange(argv),
);
