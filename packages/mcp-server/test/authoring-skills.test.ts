import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUTHORING_SKILLS,
  AUTHORING_SKILL_ENTRIES,
  DIRECTORY_READ_METHOD,
  SKILLS_EXTENSION_ID,
  SKILLS_GET_METHOD,
  SKILLS_LIST_METHOD,
  directoryReadResultSchema,
  skillsGetResultSchema,
  skillsListResultSchema,
} from "../src/index.js";
import {
  MAX_AUTHORING_FILE_BYTES,
  MAX_RESOURCES_PER_SKILL,
  MAX_TOTAL_SIZE_PER_SKILL,
  buildAuthoringSkillsBundle,
  renderAuthoringSkillsModule,
} from "../../../scripts/generate-authoring-skills.mjs";
import { connect, makeRunner } from "./_harness.js";

const EXPECTED_SKILL_URIS = [
  "skill://agentprism-workflow-authoring/SKILL.md",
  "skill://agentprism-repl-orchestration/SKILL.md",
];

test("generated authoring-skill bundle is byte-for-byte in sync with canonical sources", () => {
  const fresh = buildAuthoringSkillsBundle();
  assert.deepEqual(fresh.skills, AUTHORING_SKILLS);
  const checkedIn = readFileSync(
    new URL("../src/generated/authoring-skills-content.ts", import.meta.url),
    "utf8",
  );
  assert.equal(checkedIn, renderAuthoringSkillsModule(fresh));
});

test("generated manifests account for the exact bytes of every canonical source file", () => {
  assert.deepEqual(AUTHORING_SKILLS.map((skill) => skill.uri), EXPECTED_SKILL_URIS);

  for (const skill of AUTHORING_SKILLS) {
    assert.equal(skill.frontmatter.name, skill.directory);
    assert.equal(typeof skill.frontmatter.description, "string");
    assert.ok(skill.resources.length <= MAX_RESOURCES_PER_SKILL);
    assert.ok(skill.totalSize <= MAX_TOTAL_SIZE_PER_SKILL);
    assert.ok(skill.resources.some((resource) => resource.uri === skill.uri));

    const sourceDirectory = new URL(`../../../docs/authoring/${skill.directory}/`, import.meta.url);
    let observedTotal = 0;
    for (const resource of skill.resources) {
      const sourceBytes = readFileSync(new URL(resource.path, sourceDirectory));
      observedTotal += sourceBytes.length;
      assert.ok(sourceBytes.length <= MAX_AUTHORING_FILE_BYTES);
      assert.equal(resource.text, sourceBytes.toString("utf8"));
      assert.equal(resource.size, sourceBytes.length);
      assert.equal(
        resource.digest,
        `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
      );
    }
    assert.equal(skill.totalSize, observedTotal);
  }
});

test("workflow and REPL guidance remain context-separated and cover their public primitives", () => {
  const workflow = AUTHORING_SKILLS.find((skill) => skill.directory === "agentprism-workflow-authoring")!;
  const workflowText = workflow.resources.map((resource) => resource.text).join("\n");
  for (const name of [
    "agent(prompt, options?)",
    "parallel(thunks)",
    "pipeline(items, ...stages)",
    "workflow(nameOrScript, args?)",
    "gate(thunk, validator",
    "checkpoint(promptText, options?)",
    "phase(title)",
    "log(message)",
  ]) assert.ok(workflowText.includes(name), `workflow skill includes ${name}`);

  const repl = AUTHORING_SKILLS.find((skill) => skill.directory === "agentprism-repl-orchestration")!;
  const replText = repl.resources.map((resource) => resource.text).join("\n");
  for (const name of [
    "agent(modelSpec, task, options?)",
    "checkpoint(question, options?)",
    "checkpoint.answer(callId, value)",
    "workspace()",
    "agents()",
    "reset()",
    "handle.queue",
    "handle.steer",
    "handle.cancel",
  ]) assert.ok(replText.includes(name), `REPL skill includes ${name}`);
  assert.match(workflow.resources.find((resource) => resource.uri === workflow.uri)!.text, /Context:.*workflow/i);
  assert.match(repl.resources.find((resource) => resource.uri === repl.uri)!.text, /Context:.*repl/i);
});

test("initialize advertises SEP-2640 with directory reads and removes the docs tool", async () => {
  const { client, dispose } = await connect(makeRunner(() => "unused"));
  try {
    assert.deepEqual(
      client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION_ID],
      { directoryRead: true },
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "docs"), false);
  } finally {
    await dispose();
  }
});

test("skills/list returns both complete entries without executing runner work", async () => {
  let runs = 0;
  const { client, dispose } = await connect(makeRunner(() => { runs += 1; return "unexpected"; }));
  try {
    const listed = await client.request(
      { method: SKILLS_LIST_METHOD, params: {} },
      skillsListResultSchema,
    );
    assert.deepEqual(listed.skills.map((skill) => skill.uri), EXPECTED_SKILL_URIS);
    assert.ok(listed.skills.every((skill) => Array.isArray(skill.resources) && skill.resources.length > 0));
    assert.equal(listed.cacheScope, "public");
    assert.equal(listed.nextCursor, undefined);
    assert.equal(runs, 0);
  } finally {
    await dispose();
  }
});

test("skills/get matches list entries and rejects unknown skill URIs", async () => {
  const { client, dispose } = await connect(makeRunner(() => "unused"));
  try {
    for (const expected of AUTHORING_SKILL_ENTRIES) {
      const result = await client.request(
        { method: SKILLS_GET_METHOD, params: { uri: expected.uri } },
        skillsGetResultSchema,
      );
      assert.deepEqual(result.skill, expected);
    }
    await assert.rejects(
      client.request(
        { method: SKILLS_GET_METHOD, params: { uri: "skill://unknown/SKILL.md" } },
        skillsGetResultSchema,
      ),
      /Not a skill served by this server|Invalid params/i,
    );
    await assert.rejects(
      client.request(
        { method: SKILLS_LIST_METHOD, params: { cursor: "not-issued" } },
        skillsListResultSchema,
      ),
      /unknown cursor|Invalid params/i,
    );
  } finally {
    await dispose();
  }
});

test("every manifested skill file is listed, directly readable, and digest-identical", async () => {
  const { client, dispose } = await connect(makeRunner(() => "unused"));
  try {
    const listed = await client.listResources();
    const listedUris = new Set(listed.resources.map((resource) => resource.uri));
    for (const skill of AUTHORING_SKILLS) {
      for (const resource of skill.resources) {
        assert.ok(listedUris.has(resource.uri), `${resource.uri} appears in resources/list`);
        const read = await client.readResource({ uri: resource.uri });
        assert.equal(read.contents.length, 1);
        const content = read.contents[0]!;
        assert.equal(content.uri, resource.uri);
        assert.equal(content.mimeType, resource.mimeType);
        assert.ok("text" in content);
        const bytes = Buffer.from(String(content.text), "utf8");
        assert.equal(bytes.length, resource.size);
        assert.equal(
          `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          resource.digest,
        );
      }
    }
    assert.equal(listed.resources.some((resource) => resource.uri.startsWith("agentprism://docs/")), false);
  } finally {
    await dispose();
  }
});

test("resources/directory/read lists direct children and rejects files and unknown directories", async () => {
  const { client, dispose } = await connect(makeRunner(() => "unused"));
  try {
    const root = await client.request(
      {
        method: DIRECTORY_READ_METHOD,
        params: { uri: "skill://agentprism-workflow-authoring" },
      },
      directoryReadResultSchema,
    );
    assert.deepEqual(
      root.resources.map(({ name, mimeType }) => ({ name, mimeType })),
      [
        { name: "references", mimeType: "inode/directory" },
        { name: "SKILL.md", mimeType: "text/markdown" },
      ],
    );

    const references = await client.request(
      {
        method: DIRECTORY_READ_METHOD,
        params: { uri: "skill://agentprism-workflow-authoring/references" },
      },
      directoryReadResultSchema,
    );
    assert.ok(references.resources.some((resource) => resource.name === "run-lifecycle.md"));
    assert.ok(references.resources.every((resource) => resource.mimeType === "text/markdown"));

    for (const uri of [
      "skill://agentprism-workflow-authoring/SKILL.md",
      "skill://agentprism-workflow-authoring/missing",
    ]) {
      await assert.rejects(
        client.request({ method: DIRECTORY_READ_METHOD, params: { uri } }, directoryReadResultSchema),
        /Not a directory resource|Invalid params/i,
      );
    }
  } finally {
    await dispose();
  }
});
