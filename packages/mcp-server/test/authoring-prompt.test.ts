import assert from "node:assert/strict";
import test from "node:test";

import { buildAuthoringPromptText } from "../src/authoring-prompt.js";
import { connect, okRunner } from "./_harness.js";

test("prompts/list advertises the compact author-workflow task frame", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, 1);
    const prompt = prompts[0]!;
    assert.equal(prompt.name, "author-workflow");
    assert.match(prompt.description ?? "", /version-matched Agent Skill/);
    const taskArg = prompt.arguments?.find((argument) => argument.name === "task");
    assert.ok(taskArg);
    assert.notEqual(taskArg.required, true);
  } finally {
    await dispose();
  }
});

test("prompts/get frames the task and directs host-controlled skill activation", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const result = await client.getPrompt({
      name: "author-workflow",
      arguments: { task: "Find flaky tests and fix them" },
    });
    assert.equal(result.messages.length, 1);
    const text = String(result.messages[0]!.content.type === "text" ? result.messages[0]!.content.text : "");
    assert.match(text, /skill:\/\/agentprism-workflow-authoring\/SKILL\.md/);
    assert.match(text, /host's skill-loading path/);
    assert.match(text, /supporting references needed/);
    assert.match(text, /action:"config"/);
    assert.match(text, /mocked dry run/);
    assert.match(text, /Find flaky tests and fix them/);
    assert.ok(Buffer.byteLength(text, "utf8") < 2_000, "prompt frames the task without injecting all docs");
    assert.doesNotMatch(text, /# Workflow agent API reference|\| `keepSession` \||skill:\/\/agentprism-repl-orchestration/i);
  } finally {
    await dispose();
  }
});

test("author-workflow without a task uses the generic next step", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const result = await client.getPrompt({ name: "author-workflow", arguments: {} });
    const content = result.messages[0]!.content;
    assert.equal(content.type, "text");
    const text = content.type === "text" ? content.text : "";
    assert.match(text, /## Next step/);
    assert.doesNotMatch(text, /## Your task/);
  } finally {
    await dispose();
  }
});

test("MCP-facing prompt contains no terminal validation or config instructions", () => {
  for (const text of [buildAuthoringPromptText(), buildAuthoringPromptText("Review code")]) {
    assert.doesNotMatch(text, /npx @automatalabs\/workflows (?:validate|config)/i);
    assert.doesNotMatch(text, /agentprism-workflows (?:validate|config)|--mock-answers/i);
    assert.doesNotMatch(text, /if (?:a )?shell|validator is available/i);
  }
});

test("prompt registration includes only core tools and app-only monitor queries", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["repl", "workflow", "workflow-events", "workflow-runs"],
    );
  } finally {
    await dispose();
  }
});
