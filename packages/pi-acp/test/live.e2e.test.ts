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

test("T23 full custom-runner structured-output turn validates against a live pi provider", { skip }, async () => {
  const runner = new AcpAgentRunner({
    backends: {
      pi: {
        command: process.execPath,
        args: [new URL("../dist/index.js", import.meta.url).pathname],
        customCapabilities: { namespace: "@automatalabs/pi-acp", gatedKeys: ["outputSchema"] },
        structuredOutputTool: false,
      },
    },
  });
  try {
    const schema = Type.Object({ answer: Type.String() }, { additionalProperties: false });
    const result = await runner.run('Return {"answer":"pong"} and no other value.', {
      model: `pi/${MODEL}`,
      schema,
    });
    assert.deepEqual(result, { answer: "pong" });
  } finally {
    await runner.dispose();
  }
});
