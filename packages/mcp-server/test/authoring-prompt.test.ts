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

test("generated authoring-prompt distinguishes background start from awaited progress", () => {
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("background start has no enduring request channel"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("emits no progress after returning"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("when that await carries a progress token"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("distinct started/ended-call progress"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("polling fallback emits no progress notifications"));
  assert.ok(!AUTHORING_PROMPT_CONTENT.includes("It has no progress token or live checkpoint elicitation"));
});

test("generated authoring-prompt teaches fail-to-live identity resume semantics", () => {
  assert.ok(
    AUTHORING_PROMPT_CONTENT.includes(
      "**Resume rule:** replay is content-addressed and fail-to-live: an admitted safe call replays only when its identity and input fingerprint match uniquely.",
    ),
  );
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("resolved agent definition"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes('resume: { filesystem: "read-only" }'));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes('replay as `"unique-hash"`'));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("Source headless decisions always execute fresh."));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("keys always name the checkpoint index in the source run"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes('resumePolicy: "positional"'));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes('source-wide `"manifest-invalid"`'));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("A Node or V8 upgrade"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes('maxRounds": 6'));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes('maxRounds": 8'));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("only rounds 7–8 run live"));
});

test("generated authoring-prompt teaches scriptPath, resources, and stop-patch-resume", () => {
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("`scriptPath` (an absolute path on the server's filesystem)"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("workflow://runs/{runId}/script"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("a bare `resumeFromRunId`"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("never silently reuses the old script"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes('{ action: "stop", runId, lastN?, labelGlob?, logLines? }'));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("authoritative durable acknowledgement"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("absolute `scriptPath` plus"));
});

test("generated authoring-prompt teaches registered-prefix routing and verbatim selection", () => {
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("Route by one registered first segment."));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("No model config call is made."));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("sent byte-for-byte"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("no catalog matching, case folding, bracket parsing"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("`codex/gpt-5.6-sol`"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("`pi/openrouter/vendor/model-id`"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("Pi's native path neither embeds the schema in the prompt nor injects an MCP tool."));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("model resolution does not emit them"));
});

test("generated authoring-prompt teaches configOptions and validate-time probe surfacing", () => {
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("| `configOptions` |"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("Ids and string/boolean values pass through verbatim"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("advertised-options table"));
  assert.ok(AUTHORING_PROMPT_CONTENT.includes("marks it `probed:false`"));
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
    assert.ok(text.includes("--mock-answers"), "documents inline validator mock answers");
    assert.ok(text.includes("--mock-answers-file"), "documents reusable validator fixture files");
    assert.ok(text.includes("$sequence"), "documents finite repeated-call fixtures");
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
