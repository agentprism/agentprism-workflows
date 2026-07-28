#!/usr/bin/env node
// Generates packages/mcp-server/src/generated/authoring-prompt-content.ts from the
// published authoring skill (skills/agentprism-workflow-authoring). The skill files are
// the single source of truth; the MCP `author-workflow` prompt must be SELF-CONTAINED
// (a prompt recipient has no filesystem), so every same-directory pointer is rewritten
// to an in-document section or an absolute GitHub URL. Each rewrite targets an exact
// marker and THROWS when the marker is missing — a wording change in the skill fails
// generation (and the drift test) instead of silently shipping a dangling pointer.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = join(repoRoot, "skills", "agentprism-workflow-authoring");
const outFile = join(repoRoot, "packages", "mcp-server", "src", "generated", "authoring-prompt-content.ts");

const EXAMPLES_URL =
  "https://github.com/agentprism/agentprism-workflows/blob/main/skills/agentprism-workflow-authoring/examples";

function replaceOnce(text, marker, replacement, file) {
  const parts = text.split(marker);
  if (parts.length !== 2) {
    throw new Error(
      `generate-authoring-prompt: expected exactly one occurrence of marker in ${file} (found ${parts.length - 1}):\n${marker}`,
    );
  }
  return parts[0] + replacement + parts[1];
}

// The guide's sub-documents, inlined into the self-contained prompt in index reading order.
const GUIDE_PARTS = [
  "mcp-server-setup.md",
  "models-and-output.md",
  "composition-and-failure.md",
  "gates-and-lenses.md",
  "environment-and-tools.md",
  "determinism-and-resume.md",
  "examples-and-validation.md",
];

export function buildAuthoringPromptContent() {
  let skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  let reference = readFileSync(join(skillDir, "reference.md"), "utf8");
  const quickWins = readFileSync(join(skillDir, "examples", "quick-wins.workflow.js"), "utf8");
  if (quickWins.includes("```")) {
    throw new Error("generate-authoring-prompt: quick-wins.workflow.js contains a ``` fence — embedding would break the markdown");
  }

  // Strip the skill frontmatter — the prompt's description is authored in authoring-prompt.ts.
  const bodyStart = skill.indexOf("\n---\n", skill.startsWith("---\n") ? 4 : 0);
  if (!skill.startsWith("---\n") || bodyStart === -1) {
    throw new Error("generate-authoring-prompt: SKILL.md frontmatter block not found");
  }
  skill = skill.slice(bodyStart + "\n---\n".length).trimStart();

  // Inline every guide sub-document at the index span, in reading order — the prompt
  // recipient has no filesystem, so the on-disk link index becomes the content itself.
  const INDEX_BEGIN = "<!-- guide-index:begin -->";
  const INDEX_END = "<!-- guide-index:end -->";
  const begin = skill.indexOf(INDEX_BEGIN);
  const end = skill.indexOf(INDEX_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error("generate-authoring-prompt: guide-index markers not found in SKILL.md");
  }
  const inlined = GUIDE_PARTS.map((f) => readFileSync(join(skillDir, f), "utf8").trimEnd()).join("\n\n");
  skill =
    skill.slice(0, begin) +
    "Every section of the guide is inlined below, after the core: Running workflows (the MCP server and `workflow` tool), backends and structured output, composition and failure, quality helpers and checkpoints, the execution environment, determinism and resume, and worked examples with validation." +
    skill.slice(end + INDEX_END.length) +
    "\n\n" +
    inlined;

  // Same-directory pointers → in-document sections / absolute URLs (applied to the STITCHED text).
  skill = replaceOnce(
    skill,
    "the `args`/`cwd` globals are covered in **Running workflows** ([mcp-server-setup.md](mcp-server-setup.md)).",
    "the `args`/`cwd` globals are covered in the **Running workflows** section below.",
    "SKILL.md",
  );
  skill = replaceOnce(
    skill,
    "background collection, and the events resource are covered in **Running workflows** ([mcp-server-setup.md](mcp-server-setup.md)).",
    "background collection, and the events resource are covered in the **Running workflows** section above.",
    "determinism-and-resume.md",
  );
  skill = replaceOnce(
    skill,
    "`reference.md` (same directory) holds the exhaustive option tables, routing grammar, and error codes.",
    "The **Workflow script reference** section at the end of this document holds the exhaustive option tables, routing grammar, and error codes.",
    "SKILL.md",
  );
  skill = replaceOnce(
    skill,
    "saved names resolve when the host serves a workflows folder (see `reference.md`).",
    "saved names resolve when the host serves a workflows folder (see the reference section below).",
    "composition-and-failure.md",
  );
  skill = replaceOnce(
    skill,
    "Full signatures in `reference.md`.",
    "Full signatures in the reference section below.",
    "SKILL.md",
  );
  skill = replaceOnce(
    skill,
    "study the complete, validated scripts in [`examples/`](examples/) (same directory as this file):",
    "study the complete, validated scripts that ship with the published authoring skill:",
    "SKILL.md",
  );
  skill = replaceOnce(
    skill,
    "[`examples/repo-triage.workflow.js`](examples/repo-triage.workflow.js)",
    `[\`repo-triage.workflow.js\`](${EXAMPLES_URL}/repo-triage.workflow.js)`,
    "SKILL.md",
  );
  skill = replaceOnce(
    skill,
    "[`examples/quick-wins.workflow.js`](examples/quick-wins.workflow.js)",
    "`quick-wins.workflow.js` (included in full at the end of this document)",
    "SKILL.md",
  );
  skill = replaceOnce(
    skill,
    "[`examples/resume-loop-cap.workflow.js`](examples/resume-loop-cap.workflow.js)",
    `[\`resume-loop-cap.workflow.js\`](${EXAMPLES_URL}/resume-loop-cap.workflow.js)`,
    "examples-and-validation.md",
  );
  skill = replaceOnce(
    skill,
    "[`examples/README.md`](examples/README.md) maps each script to what it teaches.",
    `[\`examples/README.md\`](${EXAMPLES_URL}/README.md) maps each script to what it teaches.`,
    "SKILL.md",
  );
  skill = replaceOnce(
    skill,
    "For the complete `agent()` option table, model-routing grammar, checkpoint options, error codes, `meta.backends` config fields, and the MCP tool input shapes, read [`reference.md`](reference.md).",
    "For the complete `agent()` option table, model-routing grammar, checkpoint options, error codes, `meta.backends` config fields, and the MCP tool input shapes, see the **Workflow script reference** section below.",
    "SKILL.md",
  );

  // reference.md same-directory pointer → the guide above.
  reference = replaceOnce(
    reference,
    "`SKILL.md` (same directory) is the authoring guide; this file is the lookup companion.",
    "The guide above covers authoring; this section is the lookup companion.",
    "reference.md",
  );

  return [
    skill.trimEnd(),
    "\n\n---\n\n",
    reference.trimEnd(),
    "\n\n---\n\n",
    "# Complete example — quick-wins.workflow.js\n\n",
    "A complete, validated script (`loopUntilDry()` with per-round vendor rotation, dedup threading via a `seen` list, and an in-round budget floor; runs standalone or nested):\n\n",
    "```js\n",
    quickWins.trimEnd(),
    "\n```\n",
  ].join("");
}

function main() {
  const content = buildAuthoringPromptContent();
  const banner =
    "// GENERATED FILE — do not edit by hand.\n" +
    "// Source of truth: skills/agentprism-workflow-authoring/{SKILL.md, reference.md, examples/quick-wins.workflow.js}\n" +
    "// Regenerate: node scripts/generate-authoring-prompt.mjs (drift is CI-guarded by packages/mcp-server/test/authoring-prompt.test.ts)\n" +
    "\n" +
    "/** The self-contained authoring guide served by the MCP `author-workflow` prompt. */\n";
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${banner}export const AUTHORING_PROMPT_CONTENT: string = ${JSON.stringify(content)};\n`);
  console.log(`generate-authoring-prompt: wrote ${outFile} (${content.length} chars)`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) {
  main();
}
