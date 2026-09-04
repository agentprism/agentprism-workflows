#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repoRoot, "docs", "authoring");
const manifestFile = join(sourceRoot, "manifest.json");
const outFile = join(
  repoRoot,
  "packages",
  "mcp-server",
  "src",
  "generated",
  "authoring-skills-content.ts",
);

export const MAX_RESOURCES_PER_SKILL = 512;
export const MAX_TOTAL_SIZE_PER_SKILL = 16 * 1024 * 1024;
export const MAX_AUTHORING_FILE_BYTES = 16 * 1024;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;

function fail(message) {
  throw new Error(`generate-authoring-skills: ${message}`);
}

function assertPlainString(value, field) {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
  return value;
}

function assertJsonValue(value, field) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${field} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${field}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${field}.${key}`);
    return;
  }
  fail(`${field} must contain only JSON values`);
}

function parseFrontmatter(text, source) {
  const match = FRONTMATTER.exec(text);
  if (!match) fail(`${source} must begin with YAML frontmatter`);
  let parsed;
  try {
    parsed = parse(match[1], { schema: "core", uniqueKeys: true, version: "1.2" });
  } catch (error) {
    fail(`${source} has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${source} frontmatter must be an object`);
  }
  assertJsonValue(parsed, `${source} frontmatter`);
  return parsed;
}

function mimeTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".js": return "text/javascript";
    case ".yaml":
    case ".yml": return "application/yaml";
    case ".txt": return "text/plain";
    default: fail(`${path} has no supported text MIME type`);
  }
}

function collectFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`${relative(sourceRoot, absolute)} must not be a symbolic link`);
    if (entry.isDirectory()) files.push(...collectFiles(root, absolute));
    else if (entry.isFile()) files.push(absolute);
    else fail(`${relative(sourceRoot, absolute)} must be a regular file or directory`);
  }
  return files;
}

function resourcePath(skillDir, absolute) {
  const path = relative(skillDir, absolute).split(sep).join("/");
  if (path === "" || path.startsWith("../") || posix.isAbsolute(path)) fail(`invalid skill resource path: ${path}`);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") fail(`unsafe skill resource path: ${path}`);
  }
  return path;
}

function resourceUri(skillName, path) {
  return `skill://${skillName}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function verifyMarkdownLinks(skillDir, file, knownFiles) {
  if (extname(file).toLowerCase() !== ".md") return;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const raw = match[1].trim();
    if (/^(?:https?:|mailto:|#)/i.test(raw)) continue;
    const target = raw.split("#", 1)[0];
    if (!target) continue;
    const resolved = resolve(dirname(file), decodeURIComponent(target));
    const rel = relative(skillDir, resolved).split(sep).join("/");
    if (rel.startsWith("../") || rel === ".." || !knownFiles.has(rel)) {
      fail(`${resourcePath(skillDir, file)} links missing or out-of-skill resource ${raw}`);
    }
  }
}

function buildSkill(directory) {
  if (!SKILL_NAME.test(directory) || directory.length > 64) fail(`invalid skill directory name: ${directory}`);
  const skillDir = join(sourceRoot, directory);
  const rootStat = lstatSync(skillDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`${directory} must be a real directory`);

  const files = collectFiles(skillDir);
  const paths = files.map((file) => resourcePath(skillDir, file));
  if (!paths.includes("SKILL.md")) fail(`${directory} is missing SKILL.md`);
  if (paths.length > MAX_RESOURCES_PER_SKILL) {
    fail(`${directory} has ${paths.length} files; maximum is ${MAX_RESOURCES_PER_SKILL}`);
  }

  const collisionKeys = new Set();
  for (const path of paths) {
    const key = path.normalize("NFC").toLowerCase();
    if (collisionKeys.has(key)) fail(`${directory} has a case/Unicode-normalization path collision at ${path}`);
    collisionKeys.add(key);
  }
  const knownFiles = new Set(paths);
  files.forEach((file) => verifyMarkdownLinks(skillDir, file, knownFiles));

  const resources = files.map((file) => {
    const path = resourcePath(skillDir, file);
    const bytes = readFileSync(file);
    if (bytes.length > MAX_AUTHORING_FILE_BYTES) {
      fail(`${directory}/${path} is ${bytes.length} bytes; maximum is ${MAX_AUTHORING_FILE_BYTES}`);
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail(`${directory}/${path} is not canonical UTF-8 text`);
    return {
      path,
      uri: resourceUri(directory, path),
      mimeType: mimeTypeFor(path),
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.length,
      text,
    };
  }).sort((left, right) => left.uri.localeCompare(right.uri));

  const totalSize = resources.reduce((sum, resource) => sum + resource.size, 0);
  if (totalSize > MAX_TOTAL_SIZE_PER_SKILL) {
    fail(`${directory} is ${totalSize} bytes; maximum is ${MAX_TOTAL_SIZE_PER_SKILL}`);
  }

  const skillDocument = resources.find((resource) => resource.path === "SKILL.md");
  if (!skillDocument) fail(`${directory} is missing generated SKILL.md content`);
  const frontmatter = parseFrontmatter(skillDocument.text, `${directory}/SKILL.md`);
  const name = assertPlainString(frontmatter.name, `${directory}/SKILL.md frontmatter.name`);
  const description = assertPlainString(frontmatter.description, `${directory}/SKILL.md frontmatter.description`);
  if (name !== directory) fail(`${directory}/SKILL.md name must equal its directory name`);
  if (!SKILL_NAME.test(name) || name.length > 64) fail(`${directory}/SKILL.md has an invalid name`);
  if (description.length > 1024) fail(`${directory}/SKILL.md description exceeds 1024 characters`);

  return {
    directory,
    uri: skillDocument.uri,
    frontmatter,
    resources,
    totalSize,
  };
}

export function buildAuthoringSkillsBundle() {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    fail("manifest.schemaVersion must be a positive integer");
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    fail("manifest.skills must be a non-empty array");
  }

  const directories = manifest.skills.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`manifest.skills[${index}] must be an object`);
    }
    return assertPlainString(raw.directory, `manifest.skills[${index}].directory`);
  });
  if (new Set(directories).size !== directories.length) fail("manifest skill directories must be unique");

  const unlisted = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !directories.includes(entry.name))
    .map((entry) => entry.name);
  if (unlisted.length > 0) fail(`unlisted authoring skill directories: ${unlisted.join(", ")}`);
  for (const directory of directories) {
    if (!existsSync(join(sourceRoot, directory))) fail(`missing authoring skill directory: ${directory}`);
  }

  return {
    schemaVersion: manifest.schemaVersion,
    skills: directories.map(buildSkill),
  };
}

export function renderAuthoringSkillsModule(bundle = buildAuthoringSkillsBundle()) {
  return [
    "// GENERATED FILE — do not edit by hand.",
    "// Source of truth: docs/authoring/manifest.json + its Agent Skill directories.",
    "// Regenerate: pnpm generate:authoring-skills",
    "",
    `export const AUTHORING_SKILLS_SCHEMA_VERSION = ${JSON.stringify(bundle.schemaVersion)} as const;`,
    "",
    "export interface GeneratedAuthoringSkillResource {",
    "  path: string;",
    "  uri: string;",
    "  mimeType: string;",
    "  digest: string;",
    "  size: number;",
    "  text: string;",
    "}",
    "",
    "export interface GeneratedAuthoringSkill {",
    "  directory: string;",
    "  uri: string;",
    "  frontmatter: Record<string, unknown>;",
    "  resources: GeneratedAuthoringSkillResource[];",
    "  totalSize: number;",
    "}",
    "",
    `export const AUTHORING_SKILLS: readonly GeneratedAuthoringSkill[] = ${JSON.stringify(bundle.skills, null, 2)};`,
    "",
    "export const AUTHORING_SKILL_URIS = AUTHORING_SKILLS.map((skill) => skill.uri);",
    "",
  ].join("\n");
}

function main() {
  const rendered = renderAuthoringSkillsModule();
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, rendered);
  console.log(`generate-authoring-skills: wrote ${outFile} (${Buffer.byteLength(rendered, "utf8")} bytes)`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) main();
