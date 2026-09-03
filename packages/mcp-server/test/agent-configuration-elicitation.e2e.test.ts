import assert from "node:assert/strict";
import test from "node:test";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import { structured } from "./_harness.js";
import { connectHttp, makeProjectDir, startDaemon } from "./_http-harness.js";

const SCRIPT = `export const meta = {
  name: "agent-configuration-elicitation",
  description: "choose every unconfigured agent before execution",
  phases: [
    { title: "Research", detail: "Collect primary evidence." },
    { title: "Review", detail: "Check the evidence." }
  ]
};
phase("Research");
await agent("research", { label: "researcher" });
phase("Review");
return agent("review", {
  label: "reviewer",
  model: "codex/gpt-5",
  mode: "codex-authored-mode",
  configOptions: { reasoning: "medium" }
});`;

interface ObservedCall {
  model?: string;
  mode?: string;
  configOptions?: Record<string, string | boolean>;
}

function configurableRunner(seen: ObservedCall[]): AgentRunner {
  return {
    async run<S>(
      _prompt: string,
      options: RunOptions<S>,
    ) {
      seen.push({
        model: options.model,
        mode: options.mode,
        configOptions: options.configOptions,
      });
      return "ok" as never;
    },
    listBackends: () => ["claude", "codex"],
    async probeConfigOptions(spec?: string) {
      const backendId = spec?.startsWith("codex") ? "codex" : "claude";
      if (backendId === "codex") {
        return {
          backendId,
          modes: null,
          options: [
            {
              id: "model",
              name: "Model",
              type: "select" as const,
              currentValue: "gpt-5",
              options: [{ value: "gpt-5", name: "GPT-5" }],
            },
            {
              id: "reasoning",
              name: "Reasoning",
              type: "select" as const,
              currentValue: "medium",
              options: [
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ],
        };
      }
      return {
        backendId,
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "plan", name: "Plan" },
            { id: "code", name: "Code" },
          ],
        },
        options: [
          {
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue: "sonnet",
            options: [{ value: "sonnet", name: "Sonnet" }],
          },
          { id: "fast", name: "Fast", type: "boolean" as const, currentValue: false },
        ],
      };
    },
  } as AgentRunner;
}

function acceptConfiguration(request: ElicitRequest): ElicitResult {
  const params = request.params as {
    message: string;
    requestedSchema: { required?: string[]; properties: Record<string, unknown> };
  };
  assert.match(params.message, /Research — researcher/);
  assert.match(params.message, /Collect primary evidence/);
  assert.match(params.message, /Review — reviewer/);
  assert.match(params.message, /Check the evidence/);
  assert.deepEqual(params.requestedSchema.required, ["agent_0_model", "agent_1_model"]);
  return {
    action: "accept",
    content: {
      agent_0_model: "codex/gpt-5",
      agent_0_provider_1_config_0: "high",
      agent_1_model: "claude/sonnet",
      agent_1_provider_0_mode: "code",
      agent_1_provider_0_config_0: true,
    },
  };
}

test("declining agent configuration prevents admission and live dispatch", async () => {
  const seen: ObservedCall[] = [];
  const daemon = await startDaemon(configurableRunner(seen));
  const projectDir = makeProjectDir("agent-config-decline");
  const connected = await connectHttp(daemon.url, {
    protocolMode: "modern",
    elicit: () => ({ action: "decline" }),
  });
  try {
    const result = await connected.client.callTool({
      name: "workflow",
      arguments: { action: "run", projectDir, script: SCRIPT },
    });
    assert.equal(result.isError, true);
    assert.equal(structured(result)?.runId, undefined);
    assert.deepEqual(seen, []);
    assert.equal(connected.elicitations.length, 1);
  } finally {
    await connected.dispose();
    await daemon.close();
  }
});

for (const protocolMode of ["legacy", "modern"] as const) {
  test(`${protocolMode} clients configure every observed agent in one pre-execution elicitation`, async () => {
    const seen: ObservedCall[] = [];
    const daemon = await startDaemon(configurableRunner(seen));
    const projectDir = makeProjectDir(`agent-config-${protocolMode}`);
    const connected = await connectHttp(daemon.url, {
      protocolMode,
      elicit: acceptConfiguration,
    });
    try {
      const result = await connected.client.callTool({
        name: "workflow",
        arguments: { action: "run", projectDir, script: SCRIPT },
      });
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.equal(structured(result)?.status, "completed");
      assert.equal(connected.elicitations.length, 1);
      assert.deepEqual(seen, [
        { model: "codex/gpt-5", mode: undefined, configOptions: { reasoning: "high" } },
        { model: "claude/sonnet", mode: "code", configOptions: { fast: true } },
      ]);
    } finally {
      await connected.dispose();
      await daemon.close();
    }
  });
}
