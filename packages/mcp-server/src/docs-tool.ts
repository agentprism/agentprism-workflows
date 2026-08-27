import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  AUTHORING_DOC_TOPICS,
  AUTHORING_DOC_TOPIC_IDS,
  type AuthoringDocTopicId,
  type GeneratedAuthoringDocTopic,
} from "./generated/authoring-docs-content.js";

export const DOCS_TOOL_NAME = "docs";
export const AUTHORING_DOC_MIME_TYPE = "text/markdown" as const;

const topicSchema = z.enum(AUTHORING_DOC_TOPIC_IDS);

export const docsToolInputShape = {
  topic: topicSchema
    .optional()
    .describe(
      'One version-matched documentation topic to read. Omit or use "index" for the bounded catalog; ' +
        "one call returns exactly one topic, never the whole documentation set.",
    ),
};

export const docsToolOutputShape = z
  .object({
    topic: topicSchema,
    title: z.string(),
    description: z.string(),
    uri: z.string(),
    mimeType: z.literal(AUTHORING_DOC_MIME_TYPE),
    relatedTopics: z.array(topicSchema),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export interface DocsToolResult {
  [key: string]: unknown;
  topic: AuthoringDocTopicId;
  title: string;
  description: string;
  uri: string;
  mimeType: typeof AUTHORING_DOC_MIME_TYPE;
  relatedTopics: AuthoringDocTopicId[];
  bytes: number;
}

export interface RegisterAuthoringDocsOptions {
  /**
   * WorkflowScriptResources owns the server's resources/read dispatcher. Register every fixed
   * docs URI there as well as through McpServer.registerResource so direct reads keep working.
   */
  registerResourceReader(
    uri: string,
    read: () => { contents: Array<{ uri: string; mimeType: string; text: string }> },
  ): void;
}

const topicsById = new Map<AuthoringDocTopicId, GeneratedAuthoringDocTopic>(
  AUTHORING_DOC_TOPICS.map((topic) => [topic.id, topic]),
);

export function authoringDocTopic(topic: AuthoringDocTopicId): GeneratedAuthoringDocTopic {
  const found = topicsById.get(topic);
  if (found === undefined) throw new Error(`Bundled authoring documentation topic is missing: ${topic}`);
  return found;
}

export function authoringDocResource(topic: GeneratedAuthoringDocTopic): {
  contents: Array<{ uri: string; mimeType: typeof AUTHORING_DOC_MIME_TYPE; text: string }>;
} {
  return {
    contents: [{ uri: topic.uri, mimeType: AUTHORING_DOC_MIME_TYPE, text: topic.text }],
  };
}

function docsResult(topic: GeneratedAuthoringDocTopic): DocsToolResult {
  return {
    topic: topic.id,
    title: topic.title,
    description: topic.description,
    uri: topic.uri,
    mimeType: AUTHORING_DOC_MIME_TYPE,
    relatedTopics: [...topic.relatedTopics],
    bytes: topic.bytes,
  };
}

/** Register the model-facing selective docs tool plus byte-identical static MCP resources. */
export function registerAuthoringDocs(mcp: McpServer, options: RegisterAuthoringDocsOptions): void {
  for (const topic of AUTHORING_DOC_TOPICS) {
    const read = () => authoringDocResource(topic);
    mcp.registerResource(
      `agentprism-docs-${topic.id.replaceAll("/", "-")}`,
      topic.uri,
      {
        title: topic.title,
        description: topic.description,
        mimeType: AUTHORING_DOC_MIME_TYPE,
      },
      read,
    );
    options.registerResourceReader(topic.uri, read);
  }

  mcp.registerTool(
    DOCS_TOOL_NAME,
    {
      title: "Read AgentPrism workflow or REPL documentation",
      description:
        "Read version-matched AgentPrism authoring documentation one bounded topic at a time. " +
        'Omit topic or use "index" to see the catalog, then select only the workflow-script or REPL topic needed. ' +
        "Workflow and REPL agent() signatures differ, so use their separate namespaces. The result embeds the " +
        "exact text/markdown MCP resource and lists related topic ids. This tool is read-only: it needs no " +
        "projectDir, opens no backend session, runs no code, persists nothing, and spends no model tokens.",
      inputSchema: z.object(docsToolInputShape).strict(),
      outputSchema: docsToolOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ topic = "index" }) => {
      const document = authoringDocTopic(topic);
      const structuredContent = docsResult(document);
      return {
        structuredContent,
        content: [
          {
            type: "resource" as const,
            resource: {
              uri: document.uri,
              mimeType: AUTHORING_DOC_MIME_TYPE,
              text: document.text,
            },
          },
        ],
        isError: false,
      };
    },
  );
}
