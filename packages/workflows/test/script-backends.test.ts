// runDynamicWorkflow's approval gate for SCRIPT-DECLARED custom ACP backends
// (meta.backends). Script backends spawn commands on the embedder's machine, so they are
// INERT unless approved: no allowScriptBackends => THROW with guidance; true => approve all;
// callback => asked per backend, one decline aborts. Approved registries reach the runner as
// RunOptions.backends on every agent() call.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disposable HOME before any WorkflowManager is constructed (see sdk.test.ts).
const TEST_HOME = mkdtempSync(join(tmpdir(), "automatalabs-workflows-sb-test-home-"));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

import { isWorkflowError, runDynamicWorkflow } from "../src/index.js";
import type { AgentResult, AgentRunner, RunOptions } from "../src/index.js";
import type { TSchema } from "typebox";

const SCRIPT = [
  'export const meta = { name: "sb", description: "d", backends: { browser: { command: "browser-acp" }, imagegen: { command: "imagegen-acp" } } };',
  'return await agent("p", { label: "a", model: "browser" });',
].join("\n");

function capturingRunner(): { runner: AgentRunner; captured: () => RunOptions | undefined } {
  let captured: RunOptions | undefined;
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(
      _prompt: string,
      options?: RunOptions<S>,
    ): Promise<AgentResult<S>> {
      captured = options as RunOptions;
      return "ok" as AgentResult<S>;
    },
  };
  return { runner, captured: () => captured };
}

test("no allowScriptBackends + meta.backends => THROWS with guidance (never a silent drop)", async () => {
  const { runner } = capturingRunner();
  await assert.rejects(runDynamicWorkflow(SCRIPT, { runner }), (error: unknown) => {
    assert.ok(isWorkflowError(error));
    assert.match(error.message, /meta\.backends: browser, imagegen/);
    assert.match(error.message, /allowScriptBackends/);
    return true;
  });
});

test("allowScriptBackends: true approves everything; the registry reaches the runner", async () => {
  const { runner, captured } = capturingRunner();
  const run = await runDynamicWorkflow(SCRIPT, { runner, allowScriptBackends: true });
  assert.equal(run.status, "completed");
  assert.deepEqual(captured()?.backends, {
    browser: { command: "browser-acp" },
    imagegen: { command: "imagegen-acp" },
  });
});

test("callback approval: asked once per backend with the full config; approve-all runs", async () => {
  const { runner, captured } = capturingRunner();
  const asked: string[] = [];
  const run = await runDynamicWorkflow(SCRIPT, {
    runner,
    allowScriptBackends: (backend) => {
      asked.push(`${backend.name}:${backend.command}`);
      return true;
    },
  });
  assert.equal(run.status, "completed");
  assert.deepEqual(asked.sort(), ["browser:browser-acp", "imagegen:imagegen-acp"]);
  assert.ok(captured()?.backends, "the approved registry was threaded");
});

test("callback approval: a single decline ABORTS the run, naming the declined backend", async () => {
  const { runner, captured } = capturingRunner();
  await assert.rejects(
    runDynamicWorkflow(SCRIPT, {
      runner,
      allowScriptBackends: (backend) => backend.name !== "imagegen",
    }),
    /script backend "imagegen" \(command: imagegen-acp\) was declined/,
  );
  assert.equal(captured(), undefined, "no agent ran after the decline");
});

test("a script WITHOUT meta.backends never consults the approval policy", async () => {
  const { runner, captured } = capturingRunner();
  let consulted = false;
  const plain = 'export const meta = { name: "p", description: "d" };\nreturn await agent("p");';
  const run = await runDynamicWorkflow(plain, {
    runner,
    allowScriptBackends: () => {
      consulted = true;
      return false;
    },
  });
  assert.equal(run.status, "completed");
  assert.equal(consulted, false);
  assert.equal(captured()?.backends, undefined);
});

test("a malformed script surfaces the ENGINE's parse error, not an approval-gate error", async () => {
  // runSync throws on malformed scripts (before a run exists) — pre-existing contract. The
  // approval gate must not intercept it with its own message.
  const { runner } = capturingRunner();
  await assert.rejects(runDynamicWorkflow("const nope = 1;", { runner, allowScriptBackends: true }), (error: unknown) => {
    assert.ok(isWorkflowError(error));
    assert.match(error.message, /export const meta/);
    assert.doesNotMatch(error.message, /allowScriptBackends/);
    return true;
  });
});
