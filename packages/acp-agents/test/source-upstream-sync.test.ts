// Hermetic proofs for the dependency gate's source-upstream containment check (#282): the
// workspace codex-acp package must CONTAIN its canonical upstream's history, verified as git
// ancestry against the checked repository's HEAD. Real git fixture repositories, no network for
// the git leg (the npm leg talks to a local fixture registry).
//
// The four proofs pinned here:
//   1. a NON-SQUASHED merge of upstream satisfies the invariant (the sync-PR shape passes);
//   2. upstream advancing past HEAD fails closed and names the subtree-merge remediation;
//   3. a SQUASH import — identical file content, no merged history — can never satisfy it;
//   4. a REWRITTEN upstream tip (amend/rebase) can never satisfy it, even when the original
//      history was merged, because ancestry tracks SHAs, not trees.
// Plus the hook-hardening regression: a GIT_DIR leaked into the environment (pre-push hooks
// export it) must not redirect the gate's `git -C` calls.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gateSource = resolve(repoRoot, "scripts/check-acp-deps.mjs");
const SDK = "@agentclientprotocol/sdk";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
}

function commitFile(dir: string, name: string, contents: string, message: string): void {
  writeFileSync(join(dir, name), contents);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
}

function sourceUpstreamManifest(upstreamUrl: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    backends: [{
      id: "fixture",
      engine: { node: ">=22" },
      server: { kind: "workspace-package", package: "@fixture/server", path: "packages/server" },
      freshness: {
        npm: [SDK],
        sourceUpstreams: [{
          package: "@fixture/server",
          path: "packages/server",
          upstreamUrl,
          upstreamUrlEnv: "FIXTURE_UPSTREAM_URL_UNSET",
          upstreamRef: "main",
        }],
        wrappedRuntimes: [],
      },
    }],
  };
}

function fixtureRoot(upstreamUrl: string): string {
  const root = mkdtempSync(join(tmpdir(), "acp-source-sync-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(gateSource, join(root, "scripts", "check-acp-deps.mjs"));
  writeFileSync(
    join(root, "scripts", "acp-backends.manifest.json"),
    JSON.stringify(sourceUpstreamManifest(upstreamUrl)),
  );
  mkdirSync(join(root, "packages", "acp-agents"), { recursive: true });
  writeFileSync(
    join(root, "packages", "acp-agents", "package.json"),
    JSON.stringify({
      name: "@automatalabs/acp-agents",
      engines: { node: ">=22" },
      dependencies: { [SDK]: "^1.2.1" },
    }),
  );
  mkdirSync(join(root, "packages", "server"), { recursive: true });
  writeFileSync(
    join(root, "packages", "server", "package.json"),
    JSON.stringify({ name: "@fixture/server", engines: { node: ">=22" } }),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\n\nimporters:\n\n  packages/acp-agents:\n    dependencies:\n      '${SDK}':\n        specifier: ^1.2.1\n        version: 1.2.1\n\npackages:\n\n  '${SDK}@1.2.1':\n    resolution: {integrity: sha512-fixture}\n`,
  );
  return root;
}

async function withRegistry<T>(run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.statusCode = decodeURIComponent(request.url ?? "") === `/${SDK}/latest` ? 200 : 404;
    response.end(JSON.stringify({ version: "1.2.1" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

function runGate(
  root: string,
  registryUrl: string,
  environment: Record<string, string> = {},
): Promise<{ status: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, "scripts", "check-acp-deps.mjs")], {
      env: { ...process.env, AGENTPRISM_NPM_REGISTRY: registryUrl, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", fail);
    child.on("close", (status) => done({ status, out }));
  });
}

test("source-upstream containment: merge passes, advance fails, squash and rewrite can never satisfy", async () => {
  const stage = mkdtempSync(join(tmpdir(), "acp-source-repos-"));
  const upstream = join(stage, "upstream");
  initRepo(upstream);
  commitFile(upstream, "core.txt", "v1", "upstream: core v1");
  commitFile(upstream, "core.txt", "v2", "upstream: core v2");

  // 1. The sync-PR shape: monorepo history that MERGED upstream (non-squashed) — in sync.
  const merged = join(stage, "merged");
  initRepo(merged);
  commitFile(merged, "monorepo.txt", "base", "monorepo: base");
  git(merged, "fetch", "--quiet", upstream, "main");
  git(merged, "merge", "--quiet", "--allow-unrelated-histories", "-m", "sync: subtree merge", "FETCH_HEAD");

  // 3. A squash import: identical upstream FILE CONTENT, but committed fresh — no merged history.
  const squashed = join(stage, "squashed");
  initRepo(squashed);
  commitFile(squashed, "monorepo.txt", "base", "monorepo: base");
  commitFile(squashed, "core.txt", "v2", "squash-import upstream content");

  // 4. A rewrite: full upstream history merged, then the merge commit amended — new SHA, same tree.
  const rewritten = join(stage, "rewritten");
  initRepo(rewritten);
  commitFile(rewritten, "monorepo.txt", "base", "monorepo: base");
  git(rewritten, "fetch", "--quiet", upstream, "main");
  git(rewritten, "merge", "--quiet", "--squash", "--allow-unrelated-histories", "FETCH_HEAD");
  git(rewritten, "commit", "--quiet", "-m", "rebase-style import (squash merge)");

  const root = fixtureRoot(upstream);
  try {
    await withRegistry(async (registryUrl) => {
      const inSync = await runGate(root, registryUrl, { AGENTPRISM_SOURCE_SYNC_REPO_DIR: merged });
      assert.equal(inSync.status, 0, inSync.out);
      assert.match(inSync.out, /@fixture\/server \(packages\/server\) contains upstream .*#main — in sync/);

      // GIT_DIR leaked by a hook must not redirect the check to a different repository.
      const leaked = await runGate(root, registryUrl, {
        AGENTPRISM_SOURCE_SYNC_REPO_DIR: merged,
        GIT_DIR: join(squashed, ".git"),
      });
      assert.equal(leaked.status, 0, leaked.out);

      // 2. Upstream advances — the same merged repo is now behind, fail closed with the remediation.
      commitFile(upstream, "core.txt", "v3", "upstream: core v3");
      const behind = await runGate(root, registryUrl, { AGENTPRISM_SOURCE_SYNC_REPO_DIR: merged });
      assert.equal(behind.status, 1, behind.out);
      assert.match(behind.out, /1 commit\(s\) not contained in HEAD/);
      assert.match(behind.out, /git subtree merge \(NO --squash\)/);

      const squashResult = await runGate(root, registryUrl, { AGENTPRISM_SOURCE_SYNC_REPO_DIR: squashed });
      assert.equal(squashResult.status, 1, squashResult.out);

      const rewriteResult = await runGate(root, registryUrl, { AGENTPRISM_SOURCE_SYNC_REPO_DIR: rewritten });
      assert.equal(rewriteResult.status, 1, rewriteResult.out);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

test("an unreachable upstream fails closed as a blocker, never open", async () => {
  const root = fixtureRoot(join(tmpdir(), "acp-source-sync-missing", "does-not-exist"));
  try {
    await withRegistry(async (registryUrl) => {
      const result = await runGate(root, registryUrl, { AGENTPRISM_SOURCE_SYNC_REPO_DIR: repoRoot });
      assert.equal(result.status, 1, result.out);
      assert.match(result.out, /could not verify upstream containment/);
      assert.match(result.out, /fails closed/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
