import test from "node:test";
import assert from "node:assert/strict";

import { connect, okRunner } from "./_harness.js";
import { AUTHORING_PROMPT_CONTENT } from "../src/generated/authoring-prompt-content.js";
// The generator is the single source of truth (reads the skill files); the checked-in
// generated module must match a fresh generation byte-for-byte, or someone edited the
// skill without regenerating (or edited the generated file by hand).
import { buildAuthoringPromptContent } from "../../../scripts/generate-authoring-prompt.mjs";

test("generated authoring-prompt content is in sync with the skill sources", () => {
  assert.equal(
    AUTHORING_PROMPT_CONTENT,
    buildAuthoringPromptContent(),
    "regenerate with: node scripts/generate-authoring-prompt.mjs",
  );
});

test("prompts/list advertises author-workflow with the optional task argument", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, 1, "the prompt surface is exactly author-workflow");
    const prompt = prompts[0];
    assert.equal(prompt.name, "author-workflow");
    assert.ok(prompt.description && prompt.description.includes("workflow"), "has a host-facing description");
    const taskArg = prompt.arguments?.find((a) => a.name === "task");
    assert.ok(taskArg, "advertises the task argument");
    assert.notEqual(taskArg.required, true, "task is optional");
  } finally {
    await dispose();
  }
});

test("prompts/get returns the self-contained guide with the task framed in", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const result = await client.getPrompt({
      name: "author-workflow",
      arguments: { task: "Find flaky tests and fix them" },
    });
    assert.equal(result.messages.length, 1);
    const message = result.messages[0];
    assert.equal(message.role, "user");
    assert.equal(message.content.type, "text");
    const text = message.content.text as string;

    // One sentinel per bundled source, plus the framed task.
    assert.ok(text.includes("# Writing AgentPrism workflow scripts"), "contains the SKILL.md guide");
    assert.ok(text.includes("| `keepSession` |"), "contains the reference.md option tables");
    assert.ok(text.includes("loopUntilDry"), "contains the quick-wins example script");
    assert.ok(text.includes("{ ok, value, verdict, attempts }"), "contains the complete gate result contract");
    assert.ok(text.includes("outcome.verdict"), "shows authors how to consume the terminal verdict");
    assert.ok(text.includes("Find flaky tests and fix them"), "frames the task argument");
    assert.ok(text.includes("`workflow` tool"), "directs the host at the workflow tool");

    // Self-contained: no pointer may dangle outside the document.
    assert.ok(!text.includes("(same directory)"), "no same-directory pointers survive");
    assert.ok(!text.includes("](examples/"), "no relative examples/ links survive");
    assert.ok(!text.includes("](reference.md)"), "no relative reference.md links survive");
  } finally {
    await dispose();
  }
});

test("prompts/get without a task closes with the generic authoring instruction", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const result = await client.getPrompt({ name: "author-workflow", arguments: {} });
    const text = result.messages[0].content.text as string;
    assert.ok(text.includes("## Next step"), "generic closing applies");
    assert.ok(!text.includes("## Your task"), "no task framing without a task");
  } finally {
    await dispose();
  }
});

test("the prompt adds zero model-facing tool surface", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["workflow"],
      "the tool list stays exactly [workflow]",
    );
  } finally {
    await dispose();
  }
});
