// CodexBackend.spawnConfig() — proves Codex ships on a clean `git clone && pnpm install` from the
// installed npm dep @automatalabs/codex-acp (a published fork that bakes in the outputSchema
// patch), NOT a gitignored vendored build. The default path resolves the package's main from
// node_modules and runs it under the current node; the env overrides still win.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CodexBackend } from "../src/index.js";

const ENV_KEYS = ["AGENTPRISM_CODEX_ACP_CMD", "AGENTPRISM_CODEX_ACP_ARGS", "AGENTPRISM_CODEX_ACP_BIN"] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("CodexBackend.spawnConfig: default resolves the workspace package dist under the current node", () => {
  withEnv({}, () => {
    const cfg = new CodexBackend().spawnConfig();
    assert.equal(cfg.command, process.execPath); // run under the current node, not a shell/npx
    assert.equal(cfg.args.length, 1);
    const bin = cfg.args[0];
    // In this monorepo require.resolve follows the workspace symlink to packages/codex-acp;
    // a published install resolves the same package under node_modules.
    assert.match(bin, /(packages|node_modules[/\\].*@automatalabs)[/\\]codex-acp[/\\]dist[/\\]index\.js$/);
    assert.equal(bin.includes("vendor"), false);
    assert.equal(cfg.env, process.env);
  });
});

test("CodexBackend.spawnConfig: the resolved bin carries the outputSchema patch (baked into the published fork)", () => {
  withEnv({}, () => {
    const bin = new CodexBackend().spawnConfig().args[0];
    // The @automatalabs/codex-acp fork bakes in the forward of
    // request._meta["outputSchema"] -> turn/start.outputSchema. The bracket-read of the bare
    // key off `_meta` is unique to the patch (native Codex code never brackets outputSchema off
    // _meta), so its presence in the installed file is the end-to-end proof the fork ships it.
    const contents = readFileSync(bin, "utf8");
    assert.ok(
      contents.includes('_meta?.["outputSchema"]'),
      'installed codex-acp dist/index.js must contain the _meta["outputSchema"] forward patch',
    );
  });
});

test("CodexBackend.spawnConfig: AGENTPRISM_CODEX_ACP_BIN overrides the resolved path (still node)", () => {
  withEnv({ AGENTPRISM_CODEX_ACP_BIN: "/custom/codex-acp.js" }, () => {
    const cfg = new CodexBackend().spawnConfig();
    assert.equal(cfg.command, process.execPath);
    assert.deepEqual(cfg.args, ["/custom/codex-acp.js"]);
  });
});

test("CodexBackend.spawnConfig: AGENTPRISM_CODEX_ACP_CMD/ARGS override the command and argv", () => {
  withEnv({ AGENTPRISM_CODEX_ACP_CMD: "my-codex", AGENTPRISM_CODEX_ACP_ARGS: "--stdio  --foo bar" }, () => {
    const cfg = new CodexBackend().spawnConfig();
    assert.equal(cfg.command, "my-codex");
    assert.deepEqual(cfg.args, ["--stdio", "--foo", "bar"]); // splitArgs collapses whitespace
  });
});

test("CodexBackend.spawnConfig: CMD with no ARGS yields an empty argv", () => {
  withEnv({ AGENTPRISM_CODEX_ACP_CMD: "my-codex" }, () => {
    assert.deepEqual(new CodexBackend().spawnConfig().args, []);
  });
});
