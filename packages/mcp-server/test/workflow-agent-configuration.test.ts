import assert from "node:assert/strict";
import test from "node:test";
import type { ValidateHarnessOptions, ValidatedAgentCall } from "@automatalabs/workflows";
import type { WorkflowMeta } from "@automatalabs/shared-types";
import { buildWorkflowAgentConfigurationPlan } from "../src/workflow-agent-configuration.js";

const meta: WorkflowMeta = {
  name: "configure-agents",
  description: "configuration form",
  phases: [
    { title: "Research", detail: "Collect primary evidence." },
    { title: "Review", detail: "Check the evidence." },
  ],
};

const calls: ValidatedAgentCall[] = [
  { index: 0, label: "researcher", phase: "Research", backend: "claude", schema: false },
  { index: 1, label: "reviewer", phase: "Review", backend: "claude", schema: true },
  {
    index: 2,
    label: "pinned",
    phase: "Review",
    model: "codex/gpt-fixed",
    backend: "codex",
    schema: false,
  },
];

const harnesses: ValidateHarnessOptions[] = [
  {
    backendId: "claude",
    probed: true,
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
        type: "select",
        currentValue: "opus",
        options: [
          { value: "opus", name: "Opus" },
          { value: "sonnet", name: "Sonnet" },
        ],
      },
      {
        id: "effort",
        name: "Effort",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
      { id: "fast", name: "Fast mode", type: "boolean", currentValue: false },
    ],
  },
  {
    backendId: "codex",
    probed: true,
    modes: null,
    options: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "gpt-5",
        options: [{ value: "gpt-5", name: "GPT-5" }],
      },
      {
        id: "reasoning",
        name: "Reasoning",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ],
  },
];

test("builds one flat form for every observed agent call with phase context", () => {
  const plan = buildWorkflowAgentConfigurationPlan(meta, calls, harnesses);
  assert.ok(plan);
  assert.deepEqual(plan.callIndexes, [0, 1, 2]);
  assert.deepEqual(plan.request.requestedSchema.required, ["agent_0_model", "agent_1_model", "agent_2_model"]);
  assert.ok(plan.request.requestedSchema.properties.agent_0_model);
  assert.ok(plan.request.requestedSchema.properties.agent_1_model);
  assert.ok(plan.request.requestedSchema.properties.agent_2_model);
  assert.match(plan.request.message, /Research — researcher/);
  assert.match(plan.request.message, /Collect primary evidence/);
  assert.match(plan.request.message, /Review — reviewer/);
  assert.match(plan.request.message, /Check the evidence/);

  const firstRoute = plan.request.requestedSchema.properties.agent_0_model;
  assert.equal(firstRoute.type, "string");
  if (firstRoute.type !== "string") return;
  assert.deepEqual(firstRoute.oneOf.map((choice) => choice.const), [
    "claude/opus",
    "claude/sonnet",
    "codex/gpt-5",
  ]);
});

test("parses only the chosen provider's advertised mode and config fields", () => {
  const plan = buildWorkflowAgentConfigurationPlan(meta, calls, harnesses);
  assert.ok(plan);
  const configurations = plan.parse({
    agent_0_model: "codex/gpt-5",
    agent_0_provider_1_config_0: "high",
    // A value for an unselected provider is ignored rather than leaked across backends.
    agent_0_provider_0_mode: "code",
    agent_0_provider_0_config_0: "low",
    agent_0_provider_0_config_1: true,
    agent_1_model: "claude/sonnet",
    agent_1_provider_0_mode: "code",
    agent_1_provider_0_config_0: "low",
    agent_1_provider_0_config_1: false,
    agent_2_model: "codex/gpt-5",
  });
  assert.deepEqual(configurations, {
    0: { model: "codex/gpt-5", configOptions: { reasoning: "high" } },
    1: {
      model: "claude/sonnet",
      mode: "code",
      configOptions: { effort: "low", fast: false },
    },
    2: { model: "codex/gpt-5" },
  });
});

test("rejects response values outside the probed catalog", () => {
  const plan = buildWorkflowAgentConfigurationPlan(meta, calls, harnesses);
  assert.ok(plan);
  assert.throws(
    () => plan.parse({
      agent_0_model: "other/unknown",
      agent_1_model: "claude/opus",
      agent_2_model: "codex/gpt-5",
    }),
    /invalid provider\/model selection/,
  );
});
