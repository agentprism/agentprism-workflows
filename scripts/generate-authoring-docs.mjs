#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repoRoot, "docs", "authoring");
const manifestFile = join(sourceRoot, "manifest.json");
const outFile = join(repoRoot, "packages", "mcp-server", "src", "generated", "authoring-docs-content.ts");

export const DOC_INDEX_MAX_BYTES = 8 * 1024;
export const DOC_TOPIC_MAX_BYTES = 16 * 1024;

const TOPIC_ID = /^(?:workflow|repl)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_MCP_GUIDANCE = [
  /npx\s+@automatalabs\/workflows\s+(?:validate|config)/i,
  /agentprism-workflows\s+(?:validate|config)/i,
  /--mock-answers/,
  /\]\((?:\.\.\/|\.\/|[^):#]+\.md(?:#[^)]+)?|examples\/)[^)]+\)/,
  /\bSKILL\.md\b|\breference\.md\b/,
];

function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

function assertPlainString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`generate-authoring-docs: ${field} must be a non-empty string`);
  }
  return value;
}

function safeSourcePath(file) {
  const normalized = normalize(file);
  if (normalized.startsWith(`..${sep}`) || normalized === ".." || normalized.includes(`..${sep}`)) {
    throw new Error(`generate-authoring-docs: topic file escapes docs/authoring: ${file}`);
  }
  const absolute = join(sourceRoot, normalized);
  const rel = relative(sourceRoot, absolute);
  if (rel.startsWith("..") || rel === "") {
    throw new Error(`generate-authoring-docs: invalid topic file: ${file}`);
  }
  return absolute;
}

function indexText(topics) {
  const lines = [
    "# AgentPrism authoring documentation index",
    "",
    "Read one topic at a time with the `docs` tool. Workflow scripts and REPL evals have different `agent()` signatures and lifecycle semantics; choose the matching namespace.",
    "",
    "Start with `workflow/quickstart` for deterministic batch scripts or `repl/quickstart` for interactive persistent orchestration.",
    "",
  ];
  for (const namespace of ["workflow", "repl"]) {
    lines.push(`## ${namespace === "workflow" ? "Workflow scripts" : "Interactive REPL"}`, "");
    for (const topic of topics.filter((candidate) => candidate.id.startsWith(`${namespace}/`))) {
      lines.push(`- \`${topic.id}\` — **${topic.title}**: ${topic.description}`);
    }
    lines.push("");
  }
  lines.push("Each topic result includes exact related-topic ids. Model, mode, and config-option values remain live backend data: discover them with the `workflow` tool's `action:\"config\"` rather than documentation or memory.", "");
  return lines.join("\n");
}

export function buildAuthoringDocsBundle() {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    throw new Error("generate-authoring-docs: manifest.schemaVersion must be a positive integer");
  }
  if (!Array.isArray(manifest.topics) || manifest.topics.length === 0) {
    throw new Error("generate-authoring-docs: manifest.topics must be a non-empty array");
  }

  const ids = new Set();
  const files = new Set();
  const topics = manifest.topics.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`generate-authoring-docs: topics[${index}] must be an object`);
    }
    const id = assertPlainString(raw.id, `topics[${index}].id`);
    if (!TOPIC_ID.test(id)) throw new Error(`generate-authoring-docs: invalid topic id: ${id}`);
    if (ids.has(id)) throw new Error(`generate-authoring-docs: duplicate topic id: ${id}`);
    ids.add(id);
    const title = assertPlainString(raw.title, `${id}.title`);
    const description = assertPlainString(raw.description, `${id}.description`);
    const file = assertPlainString(raw.file, `${id}.file`);
    if (files.has(file)) throw new Error(`generate-authoring-docs: duplicate topic file: ${file}`);
    files.add(file);
    if (!Array.isArray(raw.related) || raw.related.some((candidate) => typeof candidate !== "string")) {
      throw new Error(`generate-authoring-docs: ${id}.related must be a string array`);
    }
    const related = [...raw.related];
    if (new Set(related).size !== related.length || related.includes(id)) {
      throw new Error(`generate-authoring-docs: ${id}.related must be unique and cannot include itself`);
    }
    const text = `${readFileSync(safeSourcePath(file), "utf8").trimEnd()}\n`;
    const bytes = utf8Bytes(text);
    if (bytes > DOC_TOPIC_MAX_BYTES) {
      throw new Error(`generate-authoring-docs: ${id} is ${bytes} bytes; maximum is ${DOC_TOPIC_MAX_BYTES}`);
    }
    for (const forbidden of FORBIDDEN_MCP_GUIDANCE) {
      if (forbidden.test(text)) {
        throw new Error(`generate-authoring-docs: ${id} contains forbidden MCP-facing guidance/pointer: ${forbidden}`);
      }
    }
    return {
      id,
      title,
      description,
      uri: `agentprism://docs/${id}`,
      mimeType: "text/markdown",
      relatedTopics: related,
      bytes,
      sha256: createHash("sha256").update(text).digest("hex"),
      text,
    };
  });

  for (const topic of topics) {
    for (const related of topic.relatedTopics) {
      if (!ids.has(related)) throw new Error(`generate-authoring-docs: ${topic.id} links unknown topic ${related}`);
    }
  }

  const index = indexText(topics);
  const indexBytes = utf8Bytes(index);
  if (indexBytes > DOC_INDEX_MAX_BYTES) {
    throw new Error(`generate-authoring-docs: index is ${indexBytes} bytes; maximum is ${DOC_INDEX_MAX_BYTES}`);
  }
  const indexTopic = {
    id: "index",
    title: "AgentPrism authoring documentation index",
    description: "Bounded catalog of workflow-script and interactive-REPL documentation topics.",
    uri: "agentprism://docs/index",
    mimeType: "text/markdown",
    relatedTopics: ["workflow/quickstart", "repl/quickstart"],
    bytes: indexBytes,
    sha256: createHash("sha256").update(index).digest("hex"),
    text: index,
  };
  return { schemaVersion: manifest.schemaVersion, topics: [indexTopic, ...topics] };
}

export function renderAuthoringDocsModule(bundle = buildAuthoringDocsBundle()) {
  const ids = bundle.topics.map((topic) => topic.id);
  return [
    "// GENERATED FILE — do not edit by hand.",
    "// Source of truth: docs/authoring/manifest.json + its topic markdown files.",
    "// Regenerate: node scripts/generate-authoring-docs.mjs", "",
    `export const AUTHORING_DOCS_SCHEMA_VERSION = ${JSON.stringify(bundle.schemaVersion)} as const;`,
    `export const AUTHORING_DOC_TOPIC_IDS = ${JSON.stringify(ids)} as const;`,
    "export type AuthoringDocTopicId = (typeof AUTHORING_DOC_TOPIC_IDS)[number];", "",
    "export interface GeneratedAuthoringDocTopic {",
    "  id: AuthoringDocTopicId;",
    "  title: string;",
    "  description: string;",
    "  uri: string;",
    "  mimeType: \"text/markdown\";",
    "  relatedTopics: AuthoringDocTopicId[];",
    "  bytes: number;",
    "  sha256: string;",
    "  text: string;",
    "}", "",
    `export const AUTHORING_DOC_TOPICS: readonly GeneratedAuthoringDocTopic[] = ${JSON.stringify(bundle.topics, null, 2)};`, "",
  ].join("\n");
}

function main() {
  const rendered = renderAuthoringDocsModule();
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, rendered);
  console.log(`generate-authoring-docs: wrote ${outFile} (${utf8Bytes(rendered)} bytes)`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) main();
