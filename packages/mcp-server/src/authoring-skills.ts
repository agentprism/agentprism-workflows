import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  AUTHORING_SKILLS,
  type GeneratedAuthoringSkill,
  type GeneratedAuthoringSkillResource,
} from "./generated/authoring-skills-content.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
export const SKILLS_LIST_METHOD = "skills/list";
export const SKILLS_GET_METHOD = "skills/get";
export const DIRECTORY_READ_METHOD = "resources/directory/read";
export const INODE_DIRECTORY_MIME_TYPE = "inode/directory";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const resultMetaSchema = z.record(z.string(), z.unknown()).optional();
const skillResourceRefSchema = z.object({
  uri: z.string().min(1),
  digest: digestSchema,
  size: z.number().int().nonnegative(),
}).strict();
const skillEntrySchema = z.object({
  uri: z.string().min(1),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.union([z.array(skillResourceRefSchema), z.literal("dynamic")]),
}).strict();

export const skillsListParamsSchema = z.object({
  cursor: z.string().optional(),
}).loose();
export const skillsListResultSchema = z.object({
  // The 2026 codec preserves resultType; the legacy 2025 codec projects it away.
  resultType: z.literal("complete").optional(),
  skills: z.array(skillEntrySchema),
  nextCursor: z.string().optional(),
  ttlMs: z.number().int().nonnegative().optional(),
  cacheScope: z.enum(["public", "private"]).optional(),
  _meta: resultMetaSchema,
}).strict();
export const skillsGetParamsSchema = z.object({
  uri: z.string().min(1),
}).loose();
export const skillsGetResultSchema = z.object({
  // The 2026 codec preserves resultType; the legacy 2025 codec projects it away.
  resultType: z.literal("complete").optional(),
  skill: skillEntrySchema,
  _meta: resultMetaSchema,
}).strict();
export const directoryReadParamsSchema = z.object({
  uri: z.string().min(1),
  cursor: z.string().optional(),
}).loose();
export const directoryReadResultSchema = z.object({
  // The 2026 codec preserves resultType; the legacy 2025 codec projects it away.
  resultType: z.literal("complete").optional(),
  resources: z.array(z.object({
    uri: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative().optional(),
  }).strict()),
  nextCursor: z.string().optional(),
  _meta: resultMetaSchema,
}).strict();

export interface AuthoringSkillResourceRef {
  uri: string;
  digest: string;
  size: number;
}

export interface AuthoringSkillEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: AuthoringSkillResourceRef[];
}

export interface AuthoringSkillDirectoryChild {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
}

export interface RegisterAuthoringSkillsOptions {
  /**
   * WorkflowScriptResources owns this server's resources/read dispatcher. Register each exact
   * generated skill URI there as well as through McpServer.registerResource.
   */
  registerResourceReader(
    uri: string,
    read: () => { contents: Array<{ uri: string; mimeType: string; text: string }> },
  ): void;
}

function skillEntry(skill: GeneratedAuthoringSkill): AuthoringSkillEntry {
  return {
    uri: skill.uri,
    frontmatter: { ...skill.frontmatter },
    resources: skill.resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
  };
}

export const AUTHORING_SKILL_ENTRIES: readonly AuthoringSkillEntry[] = AUTHORING_SKILLS.map(skillEntry);

const entriesByUri = new Map(AUTHORING_SKILL_ENTRIES.map((entry) => [entry.uri, entry]));
const resourcesByUri = new Map<string, GeneratedAuthoringSkillResource>();
for (const skill of AUTHORING_SKILLS) {
  for (const resource of skill.resources) resourcesByUri.set(resource.uri, resource);
}

function cloneEntry(entry: AuthoringSkillEntry): AuthoringSkillEntry {
  return {
    uri: entry.uri,
    frontmatter: { ...entry.frontmatter },
    resources: entry.resources.map((resource) => ({ ...resource })),
  };
}

export function authoringSkillResource(uri: string): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  const resource = resourcesByUri.get(uri);
  if (!resource) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Authoring skill resource not found: ${uri}`);
  }
  return {
    contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
  };
}

function addDirectoryChild(
  directories: Map<string, Map<string, AuthoringSkillDirectoryChild>>,
  parentUri: string,
  child: AuthoringSkillDirectoryChild,
): void {
  let children = directories.get(parentUri);
  if (!children) {
    children = new Map();
    directories.set(parentUri, children);
  }
  children.set(child.uri, child);
}

function buildDirectoryIndex(): Map<string, AuthoringSkillDirectoryChild[]> {
  const directories = new Map<string, Map<string, AuthoringSkillDirectoryChild>>();
  for (const skill of AUTHORING_SKILLS) {
    const rootUri = `skill://${skill.directory}`;
    if (!directories.has(rootUri)) directories.set(rootUri, new Map());
    for (const resource of skill.resources) {
      const segments = resource.path.split("/");
      let parentUri = rootUri;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        const childUri = `${parentUri}/${encodeURIComponent(name)}`;
        addDirectoryChild(directories, parentUri, {
          uri: childUri,
          name,
          mimeType: INODE_DIRECTORY_MIME_TYPE,
        });
        if (!directories.has(childUri)) directories.set(childUri, new Map());
        parentUri = childUri;
      }
      addDirectoryChild(directories, parentUri, {
        uri: resource.uri,
        name: segments.at(-1)!,
        mimeType: resource.mimeType,
        size: resource.size,
      });
    }
  }
  return new Map(
    [...directories].map(([uri, children]) => [
      uri,
      [...children.values()].sort((left, right) => left.uri.localeCompare(right.uri)),
    ]),
  );
}

const directoryIndex = buildDirectoryIndex();

function invalidCursor(method: string, cursor: string): never {
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `${method} issued no pagination cursor; received unknown cursor: ${cursor}`,
  );
}

/** Register the static AgentPrism authoring skills and SEP-2640 request handlers. */
export function registerAuthoringSkills(mcp: McpServer, options: RegisterAuthoringSkillsOptions): void {
  for (const skill of AUTHORING_SKILLS) {
    for (const resource of skill.resources) {
      const isSkillDocument = resource.uri === skill.uri;
      const read = () => authoringSkillResource(resource.uri);
      mcp.registerResource(
        isSkillDocument ? skill.directory : `${skill.directory}:${resource.path}`,
        resource.uri,
        {
          title: isSkillDocument ? String(skill.frontmatter.name) : resource.path,
          description: isSkillDocument
            ? String(skill.frontmatter.description)
            : `Supporting file for the ${skill.directory} Agent Skill.`,
          mimeType: resource.mimeType,
          size: resource.size,
          annotations: {
            audience: ["assistant"],
            priority: isSkillDocument ? 1 : 0.5,
          },
        },
        read,
      );
      options.registerResourceReader(resource.uri, read);
    }
  }

  mcp.server.setRequestHandler(
    SKILLS_LIST_METHOD,
    { params: skillsListParamsSchema, result: skillsListResultSchema },
    async ({ cursor }) => {
      if (cursor !== undefined) invalidCursor(SKILLS_LIST_METHOD, cursor);
      return {
        resultType: "complete" as const,
        skills: AUTHORING_SKILL_ENTRIES.map(cloneEntry),
        cacheScope: "public" as const,
      };
    },
  );

  mcp.server.setRequestHandler(
    SKILLS_GET_METHOD,
    { params: skillsGetParamsSchema, result: skillsGetResultSchema },
    async ({ uri }) => {
      const entry = entriesByUri.get(uri);
      if (!entry) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Not a skill served by this server: ${uri}`);
      }
      return { resultType: "complete" as const, skill: cloneEntry(entry) };
    },
  );

  mcp.server.setRequestHandler(
    DIRECTORY_READ_METHOD,
    { params: directoryReadParamsSchema, result: directoryReadResultSchema },
    async ({ uri, cursor }) => {
      if (cursor !== undefined) invalidCursor(DIRECTORY_READ_METHOD, cursor);
      const resources = directoryIndex.get(uri);
      if (!resources) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Not a directory resource: ${uri}`);
      }
      return {
        resultType: "complete" as const,
        resources: resources.map((resource) => ({ ...resource })),
      };
    },
  );
}
