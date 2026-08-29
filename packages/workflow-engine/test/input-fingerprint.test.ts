import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentResult, AgentRunner, RunOptions, WorkflowBackendConfig } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import { CALL_INPUTS_FORMAT, type WorkflowRunOptions, runWorkflow } from "../src/workflow.js";

type RunOverrides = Omit<WorkflowRunOptions, "agent">;

async function fingerprintFor(optionsSource: string, overrides: RunOverrides = {}): Promise<string | undefined> {
  let fingerprint: string | undefined;
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(
      _prompt: string,
      options?: RunOptions<S>,
    ): Promise<AgentResult<S>> {
      fingerprint = options?.callInputsHash;
      return "ok" as AgentResult<S>;
    },
  };
  await runWorkflow(
    `export const meta = { name: 'fingerprint', description: 'input fingerprint' }
await Promise.resolve()
return await agent('same-prompt', ${optionsSource})`,
    { ...overrides, agent: runner, persistLogs: false },
  );
  return fingerprint;
}

describe("agent input fingerprints", () => {
  it("pins the format and exact canonical bytes for default effective inputs", async () => {
    assert.equal(CALL_INPUTS_FORMAT, 2);
    const fingerprint = await fingerprintFor("{}");
    const canonical = JSON.stringify({
      backends: null,
      cwd: null,
      images: null,
      isolation: null,
      keepSession: false,
      label: "agent 1",
      mcpServers: null,
      meta: null,
      promptMeta: null,
    });
    const expected = createHash("sha256").update(canonical).digest("hex");

    assert.equal(fingerprint, expected);
  });

  it("sorts record keys recursively while preserving array order", async () => {
    const keysA = await fingerprintFor("{ label: 'fixed', meta: { outer: { z: 1, a: 2 }, b: 3, a: 4 } }");
    const keysB = await fingerprintFor("{ meta: { a: 4, b: 3, outer: { a: 2, z: 1 } }, label: 'fixed' }");
    const ordered = await fingerprintFor("{ label: 'fixed', meta: { values: [1, 2, 3] } }");
    const reordered = await fingerprintFor("{ label: 'fixed', meta: { values: [3, 2, 1] } }");

    assert.equal(keysA, keysB);
    assert.notEqual(ordered, reordered);
  });

  it("changes for every script-level unhashed execution input", async () => {
    const nonGitCwd = mkdtempSync(join(tmpdir(), "ap-inputs-nogit-"));
    try {
      const baseline = await fingerprintFor("{ label: 'fixed' }", { cwd: nonGitCwd });
      const variants = await Promise.all([
        fingerprintFor("{ label: 'fixed', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] }", {
          cwd: nonGitCwd,
        }),
        fingerprintFor("{ label: 'fixed', cwd: 'packages/engine' }", { cwd: nonGitCwd }),
        fingerprintFor(
          "{ label: 'fixed', mcpServers: [{ name: 'tools', command: 'tool-server', args: ['--stdio'], env: [] }] }",
          { cwd: nonGitCwd },
        ),
        fingerprintFor("{ label: 'fixed', meta: { channel: 'session', nested: { enabled: true } } }", {
          cwd: nonGitCwd,
        }),
        fingerprintFor("{ label: 'fixed', promptMeta: { channel: 'turn' } }", { cwd: nonGitCwd }),
        fingerprintFor("{ label: 'fixed', keepSession: true }", { cwd: nonGitCwd }),
        fingerprintFor("{ label: 'fixed', isolation: 'worktree' }", { cwd: nonGitCwd }),
      ]);

      for (const variant of variants) {
        assert.notEqual(variant, baseline);
      }
    } finally {
      rmSync(nonGitCwd, { recursive: true, force: true });
    }
  });

  it("hashes the resolved explicit/default label", async () => {
    const trimmed = await fingerprintFor("{ label: '  fixed  ' }");
    const fixed = await fingerprintFor("{ label: 'fixed' }");
    const changed = await fingerprintFor("{ label: 'changed' }");
    let afterCheckpoint: string | undefined;
    await runWorkflow(
      `export const meta = { name: 'default-label', description: 'default label path' }
await checkpoint('occupy index')
return await agent('same-prompt')`,
      {
        agent: {
          async run(_prompt, options) {
            afterCheckpoint = options?.callInputsHash;
            return "ok";
          },
        },
        confirm: async () => true,
        persistLogs: false,
      },
    );
    const firstDefault = await fingerprintFor("{}");

    assert.equal(trimmed, fixed, "labels are fingerprinted after engine trimming");
    assert.notEqual(changed, fixed);
    assert.notEqual(afterCheckpoint, firstDefault, "default labels include the resolved shared agent ordinal");
  });

  it("excludes run-level and per-call operational knobs from the fingerprint", async () => {
    const baseline = await fingerprintFor("{ label: 'fixed' }");
    const variants = await Promise.all([
      fingerprintFor("{ label: 'fixed' }", { agentTimeoutMs: 100 }),
      fingerprintFor("{ label: 'fixed' }", { agentTimeoutMs: 200 }),
      fingerprintFor("{ label: 'fixed', timeoutMs: null }", { agentTimeoutMs: 100 }),
      fingerprintFor("{ label: 'fixed', timeoutMs: 50 }", { agentTimeoutMs: 100 }),
      fingerprintFor("{ label: 'fixed' }", { agentIdleTimeoutMs: 100 }),
      fingerprintFor("{ label: 'fixed', idleTimeoutMs: null }", { agentIdleTimeoutMs: 100 }),
      fingerprintFor("{ label: 'fixed', idleTimeoutMs: 50 }", { agentIdleTimeoutMs: 100 }),
      fingerprintFor("{ label: 'fixed' }", { agentRetries: 1 }),
      fingerprintFor("{ label: 'fixed', retries: 2 }", { agentRetries: 0 }),
      fingerprintFor("{ label: 'fixed' }", { concurrency: 1 }),
      fingerprintFor("{ label: 'fixed' }", { concurrency: 8 }),
    ]);

    for (const variant of variants) assert.equal(variant, baseline);
  });

  it("folds a canonical digest of the approved backend registry into every call", async () => {
    const first: Record<string, WorkflowBackendConfig> = {
      browser: { command: "browser-acp", args: ["--profile", "one"] },
    };
    const equivalent: Record<string, WorkflowBackendConfig> = {
      browser: { args: ["--profile", "one"], command: "browser-acp" },
    };
    const changed: Record<string, WorkflowBackendConfig> = {
      browser: { command: "browser-acp", args: ["--profile", "two"] },
    };
    const firstHash = await fingerprintFor("{ label: 'fixed' }", { scriptBackends: first });
    const equivalentHash = await fingerprintFor("{ label: 'fixed' }", { scriptBackends: equivalent });
    const changedHash = await fingerprintFor("{ label: 'fixed' }", { scriptBackends: changed });

    assert.equal(firstHash, equivalentHash);
    assert.notEqual(firstHash, changedHash);
  });

  it("uses pre-resolution isolation inputs while exposing the actual worktree cwd", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ap-inputs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    const fingerprints: Array<string | undefined> = [];
    const resolvedCwds: string[] = [];
    const runner: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        fingerprints.push(options?.callInputsHash);
        if (options?.cwd) resolvedCwds.push(options.cwd);
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'worktree-input', description: 'worktree input' }
return await agent('same-prompt', { label: 'fixed', isolation: 'worktree' })`;

    try {
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      await runWorkflow(script, { runId: "worktree-a", cwd: repo, agent: runner, persistLogs: false });
      await runWorkflow(script, { runId: "worktree-b", cwd: repo, agent: runner, persistLogs: false });

      assert.equal(fingerprints[0], fingerprints[1]);
      assert.equal(resolvedCwds.length, 2);
      assert.notEqual(resolvedCwds[0], resolvedCwds[1]);
      assert.notEqual(resolvedCwds[0], repo);
      assert.notEqual(resolvedCwds[1], repo);
      assert.match(resolvedCwds[0], /worktree-a-0-fixed$/);
      assert.match(resolvedCwds[1], /worktree-b-0-fixed$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("omits the whole fingerprint when a vm-authored component is not strict JSON", async () => {
    const fingerprint = await fingerprintFor("{ label: 'fixed', meta: { valid: 1, invalid: () => 2 } }");
    assert.equal(fingerprint, undefined);
  });
});
