import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, AgentRunner, JournalEntry, RunOptions, WorkflowBackendConfig } from "@automatalabs/shared-types";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";

// meta.backends is a SCRIPT-DECLARED, TRUST-GATED input: the engine PARSES it (structural
// validation) but never acts on it — script backends reach agent() calls ONLY when the
// composition root passes an approved registry via options.scriptBackends. Secure-by-default
// at the engine layer: meta.backends alone must thread NOTHING to the runner.

const BACKENDS_SNIPPET =
  'backends: { browser: { command: "browser-acp", args: ["--headless"], env: { HEADLESS: "1" }, sessionMeta: { mode: "verify" }, structuredOutputTool: false } }';

const SCRIPT_WITH_BACKENDS = [
  `export const meta = { name: "m", description: "d", ${BACKENDS_SNIPPET} };`,
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

describe("meta.backends parsing", () => {
  it("accepts a valid backends block and exposes it on parsed meta", () => {
    const { meta } = parseWorkflowScript(SCRIPT_WITH_BACKENDS);
    assert.deepEqual(meta.backends, {
      browser: {
        command: "browser-acp",
        args: ["--headless"],
        env: { HEADLESS: "1" },
        sessionMeta: { mode: "verify" },
        structuredOutputTool: false,
      },
    });
  });

  it("rejects malformed backends blocks with legible messages", () => {
    const bad = (backends: string) =>
      `export const meta = { name: "m", description: "d", backends: ${backends} };\nreturn 1;`;
    assert.throws(() => parseWorkflowScript(bad("[]")), /meta\.backends must be an object/);
    assert.throws(() => parseWorkflowScript(bad('{ b: "cmd" }')), /must be an object with at least \{ command \}/);
    assert.throws(() => parseWorkflowScript(bad("{ b: { command: '' } }")), /command must be a non-empty string/);
    assert.throws(() => parseWorkflowScript(bad('{ b: { command: "x", args: "no" } }')), /args must be an array of strings/);
    assert.throws(() => parseWorkflowScript(bad('{ b: { command: "x", env: ["no"] } }')), /env must be an object of string values/);
    assert.throws(() => parseWorkflowScript(bad('{ b: { command: "x", sessionMeta: 3 } }')), /sessionMeta must be an object/);
    assert.throws(
      () => parseWorkflowScript(bad('{ b: { command: "x", structuredOutputTool: "no" } }')),
      /structuredOutputTool must be a boolean/,
    );
  });
});

describe("scriptBackends threading (composition-root-gated)", () => {
  it("meta.backends ALONE threads nothing — script backends are inert by default", async () => {
    const { runner, captured } = capturingRunner();
    await runWorkflow(SCRIPT_WITH_BACKENDS, { agent: runner, persistLogs: false });
    assert.equal(captured()?.backends, undefined, "the engine never reads meta.backends into the run");
  });

  it("options.scriptBackends is threaded to every agent() call as RunOptions.backends", async () => {
    const { runner, captured } = capturingRunner();
    const approved: Record<string, WorkflowBackendConfig> = {
      browser: { command: "browser-acp", args: ["--headless"], structuredOutputTool: false },
    };
    await runWorkflow(SCRIPT_WITH_BACKENDS, { agent: runner, persistLogs: false, scriptBackends: approved });
    assert.deepEqual(captured()?.backends, approved);
  });

  it("does NOT fold scriptBackends into the resume identity hash", async () => {
    const echo: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        return `ran:${prompt}` as AgentResult<S>;
      },
    };
    const journalOf = async (withBackends: boolean): Promise<JournalEntry[]> => {
      const journal: JournalEntry[] = [];
      await runWorkflow(SCRIPT_WITH_BACKENDS, {
        agent: echo,
        persistLogs: false,
        scriptBackends: withBackends ? { browser: { command: "browser-acp" } } : undefined,
        onAgentJournal: (e) => journal.push(e),
      });
      return journal;
    };
    const [withBackends] = await journalOf(true);
    const [without] = await journalOf(false);
    assert.equal(withBackends.hash, without.hash, "resume keys stay byte-identical across backend wiring");
  });

  it("a nested workflow() inherits the parent's APPROVED scriptBackends (same trust context)", async () => {
    const { runner, captured } = capturingRunner();
    const parent = [
      'export const meta = { name: "parent", description: "d" };',
      'return await workflow(`export const meta = { name: "child", description: "d" };\\nreturn await agent("p", { model: "browser" });`);',
    ].join("\n");
    const approved: Record<string, WorkflowBackendConfig> = { browser: { command: "browser-acp" } };
    await runWorkflow(parent, { agent: runner, persistLogs: false, scriptBackends: approved });
    assert.deepEqual(captured()?.backends, approved, "the child run's agent() saw the parent's approved registry");
  });
});
