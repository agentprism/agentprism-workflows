import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { AcpAgentRunner } from "../../acp-agents/dist/index.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const MODEL = process.env.AGENTPRISM_PI_E2E_MODEL;
const HAS_KEY = Boolean(
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.XAI_API_KEY ||
  process.env.OPENROUTER_API_KEY,
);
const skip = !LIVE
  ? "gated pi live e2e — set AGENTPRISM_LIVE_E2E=1, AGENTPRISM_PI_E2E_MODEL, and a provider key"
  : !MODEL || !HAS_KEY
    ? "pi live e2e requires AGENTPRISM_PI_E2E_MODEL and its provider key"
    : false;

test("T23 built-in PiBackend validates through injected StructuredOutput plus common fallback", { skip }, async () => {
  const priorCommand = process.env.AGENTPRISM_PI_ACP_CMD;
  const priorArgs = process.env.AGENTPRISM_PI_ACP_ARGS;
  process.env.AGENTPRISM_PI_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_PI_ACP_ARGS = new URL("../dist/index.js", import.meta.url).pathname;
  const runner = new AcpAgentRunner();
  try {
    const schema = Type.Object({ answer: Type.String() }, { additionalProperties: false });
    const result = await runner.run('Return {"answer":"pong"} and no other value.', {
      model: `pi/${MODEL}`,
      schema,
    });
    assert.deepEqual(result, { answer: "pong" });
  } finally {
    await runner.dispose();
    if (priorCommand === undefined) delete process.env.AGENTPRISM_PI_ACP_CMD;
    else process.env.AGENTPRISM_PI_ACP_CMD = priorCommand;
    if (priorArgs === undefined) delete process.env.AGENTPRISM_PI_ACP_ARGS;
    else process.env.AGENTPRISM_PI_ACP_ARGS = priorArgs;
  }
});
