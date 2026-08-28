import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  AUTHORING_DOC_TOPICS,
  AUTHORING_DOC_TOPIC_IDS,
  DOCS_TOOL_NAME,
  docsToolOutputShape,
} from "../src/index.js";
import { buildAuthoringDocsBundle, renderAuthoringDocsModule } from "../../../scripts/generate-authoring-docs.mjs";
import { connect, makeRunner } from "./_harness.js";

const EXPECTED_TOPIC_IDS = [
  "index",
  "workflow/quickstart",
  "workflow/run-lifecycle",
  "workflow/models-and-config",
  "workflow/composition-and-failure",
  "workflow/checkpoints-and-quality",
  "workflow/environment-and-tools",
  "workflow/determinism-and-resume",
  "workflow/api-agents",
  "workflow/api-control-flow",
  "workflow/api-resume-and-backends",
  "workflow/examples",
  "repl/quickstart",
  "repl/state-and-bindings",
  "repl/agent-handles",
  "repl/steering-queueing-and-cancellation",
  "repl/checkpoints-and-introspection",
  "repl/persistence-and-reset",
  "repl/api-reference",
  "repl/examples",
] as const;

function embeddedText(result: CallToolResult): string {
  const resource = result.content.find((block) => block.type === "resource");
  assert.ok(resource && resource.type === "resource", "docs result embeds one resource");
  assert.equal(resource.resource.mimeType, "text/markdown");
  assert.ok("text" in resource.resource);
  return String(resource.resource.text);
}

test("MCP documentation generation is independent of the optional authoring skill", () => {
  const generator = readFileSync(new URL("../../../scripts/generate-authoring-docs.mjs", import.meta.url), "utf8");
  const prompt = readFileSync(new URL("../src/authoring-prompt.ts", import.meta.url), "utf8");
  assert.doesNotMatch(generator, /skills\/agentprism-workflow-authoring|SKILL\.md/);
  assert.doesNotMatch(prompt, /AUTHORING_PROMPT_CONTENT|generated\/authoring-prompt-content/);
});

test("generated selective docs bundle is byte-for-byte in sync with canonical topic sources", () => {
  const fresh = buildAuthoringDocsBundle();
  assert.deepEqual(fresh.topics, AUTHORING_DOC_TOPICS);
  const checkedIn = readFileSync(new URL("../src/generated/authoring-docs-content.ts", import.meta.url), "utf8");
  assert.equal(checkedIn, renderAuthoringDocsModule(fresh));
  assert.deepEqual(AUTHORING_DOC_TOPIC_IDS, EXPECTED_TOPIC_IDS);
});

test("every bundled topic is bounded, closed, linked, hashed, and free of terminal-only/pointer guidance", () => {
  const ids = new Set(AUTHORING_DOC_TOPIC_IDS);
  assert.equal(AUTHORING_DOC_TOPICS.length, ids.size);
  for (const topic of AUTHORING_DOC_TOPICS) {
    assert.equal(topic.uri, `agentprism://docs/${topic.id}`);
    assert.equal(topic.mimeType, "text/markdown");
    assert.equal(topic.bytes, Buffer.byteLength(topic.text, "utf8"));
    assert.equal(topic.sha256, createHash("sha256").update(topic.text).digest("hex"));
    assert.ok(topic.bytes <= (topic.id === "index" ? 8 * 1024 : 16 * 1024), `${topic.id} is bounded`);
    assert.ok(topic.text.trim().length > 0);
    assert.doesNotMatch(topic.text, /npx\s+@automatalabs\/workflows\s+(?:validate|config)/i);
    assert.doesNotMatch(topic.text, /agentprism-workflows\s+(?:validate|config)|--mock-answers/i);
    assert.doesNotMatch(topic.text, /\bSKILL\.md\b|\breference\.md\b/);
    for (const related of topic.relatedTopics) assert.ok(ids.has(related), `${topic.id} -> ${related}`);
  }
});

test("docs coverage names every public workflow and REPL guest primitive in context-separated references", () => {
  const workflow = AUTHORING_DOC_TOPICS.find((topic) => topic.id === "workflow/api-control-flow")!.text;
  for (const name of [
    "agent(prompt, options?)",
    "parallel(thunks)",
    "pipeline(items, ...stages)",
    "workflow(nameOrScript, args?)",
    "gate(thunk, validator",
    "retry(thunk",
    "verify(item",
    "judgePanel(attempts",
    "loopUntilDry({",
    "completenessCheck(taskArgs, results)",
    "checkpoint(promptText, options?)",
    "phase(title)",
    "log(message)",
    "args",
    "cwd",
  ]) assert.ok(workflow.includes(name), `workflow reference includes ${name}`);

  const repl = AUTHORING_DOC_TOPICS.find((topic) => topic.id === "repl/api-reference")!.text;
  for (const name of [
    "agent(modelSpec, task, options?)",
    "checkpoint(question, options?)",
    "checkpoint.answer(callId, value)",
    "parallel(thunks)",
    "pipeline(items, ...stages)",
    "verify(item",
    "judgePanel(attempts",
    "gate(thunk, validator",
    "retry(thunk",
    "loopUntilDry({",
    "sleep(ms)",
    "workspace()",
    "agents()",
    "reset()",
    "handle.queue",
    "handle.steer",
    "handle.cancel",
  ]) assert.ok(repl.includes(name), `REPL reference includes ${name}`);
  assert.match(workflow, /Context:.*workflow/i);
  assert.match(repl, /Context:.*repl/i);
});

test("docs tool defaults to the index, embeds exactly one resource, and executes no runner work", async () => {
  let runs = 0;
  const { client, dispose } = await connect(makeRunner(() => { runs += 1; return "unexpected"; }), { listTools: true });
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === DOCS_TOOL_NAME);
    assert.ok(tool);
    assert.match(tool.description ?? "", /one bounded topic at a time/);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, false);

    const result = await client.callTool({ name: DOCS_TOOL_NAME, arguments: {} });
    assert.equal(result.isError, false);
    const structured = docsToolOutputShape.parse(result.structuredContent);
    assert.equal(structured.topic, "index");
    assert.equal(structured.bytes, Buffer.byteLength(embeddedText(result), "utf8"));
    assert.equal(result.content.filter((block) => block.type === "resource").length, 1);
    assert.equal(result.content.filter((block) => block.type === "text").length, 0, "document text is not duplicated");
    assert.equal(runs, 0);
  } finally {
    await dispose();
  }
});

test("each docs tool topic is byte-identical to its directly readable static MCP resource", async () => {
  const { client, dispose } = await connect(makeRunner(() => "unused"));
  try {
    const listed = await client.listResources();
    const docUris = listed.resources.filter((resource) => resource.uri.startsWith("agentprism://docs/"));
    assert.equal(docUris.length, AUTHORING_DOC_TOPICS.length);
    for (const topic of AUTHORING_DOC_TOPICS) {
      const toolResult = await client.callTool({ name: DOCS_TOOL_NAME, arguments: { topic: topic.id } });
      const direct = await client.readResource({ uri: topic.uri });
      assert.equal(toolResult.isError, false);
      assert.equal(embeddedText(toolResult), topic.text);
      assert.equal(direct.contents.length, 1);
      assert.ok("text" in direct.contents[0]!);
      assert.equal(direct.contents[0]!.text, topic.text);
    }
  } finally {
    await dispose();
  }
});

test("listed static docs resources accept host subscribe/unsubscribe as no-ops", async () => {
  const { client, dispose } = await connect(makeRunner(() => "unused"));
  try {
    const uri = "agentprism://docs/index";
    assert.deepEqual(await client.subscribeResource({ uri }), {});
    assert.deepEqual(await client.unsubscribeResource({ uri }), {});
    const read = await client.readResource({ uri });
    assert.equal(read.contents.length, 1);
  } finally {
    await dispose();
  }
});

test("unknown docs topics fail at the MCP input boundary and never degrade to arbitrary paths", async () => {
  const { client, dispose } = await connect(makeRunner(() => "unused"));
  try {
    for (const topic of ["workflow/unknown", "../../etc/passwd", "https://example.com", ["index"]]) {
      const result = await client.callTool({ name: DOCS_TOOL_NAME, arguments: { topic } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      if (topic === "workflow/unknown") {
        const errorText = result.content.map((block) => block.type === "text" ? block.text : "").join("\n");
        assert.match(errorText, /index/);
        assert.match(errorText, /workflow\/quickstart/);
      }
    }
  } finally {
    await dispose();
  }
});
