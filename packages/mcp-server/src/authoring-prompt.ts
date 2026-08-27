// The `author-workflow` MCP prompt is a user-controlled convenience that frames an authoring
// task and points the assistant at the selective, version-matched `docs` tool. It deliberately
// does not inject the complete optional skill or every API topic into one context window.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const AUTHORING_PROMPT_NAME = "author-workflow";

/** Assemble a compact task frame. The agent chooses only the documentation topics it needs. */
export function buildAuthoringPromptText(task?: string): string {
  const trimmed = task?.trim();
  const taskSection = trimmed
    ? `## Your task\n\n${trimmed}`
    : "## Next step\n\nAuthor the workflow script the user asks for, then run it with the `workflow` tool.";
  return [
    "# Author an AgentPrism workflow",
    "",
    "Use the connected `docs` tool for version-matched authoring guidance. Read topic `workflow/quickstart` first, then read only the related workflow topics needed for this task; do not load every topic. Workflow scripts and REPL evals have different `agent()` signatures, so use only `workflow/*` topics here.",
    "",
    "When the script pins a model, mode, or configOptions, call the `workflow` tool with `action:\"config\"` first; after choosing a model, use `modelSpecs` to read its exact option domain. Set mode only when that selected entry's `modes.availableModes` explicitly lists the exact id; `modes:null` means omit it, and never infer a generic `default`. The run action automatically performs static validation, a mocked dry run, and routed no-prompt config checks before admission. Correct any direct rejection diagnostic and re-run.",
    "",
    taskSection,
    "",
  ].join("\n");
}

/** Register the optional prompt; hosts without prompt support simply never call prompts/list. */
export function registerAuthoringPrompt(mcp: McpServer): void {
  mcp.registerPrompt(
    AUTHORING_PROMPT_NAME,
    {
      title: "Author an AgentPrism workflow script",
      description:
        "Frame a workflow-authoring task and direct the assistant to select only the version-matched " +
        "workflow documentation topics it needs through the `docs` tool.",
      argsSchema: {
        task: z.string().optional().describe("What the workflow should accomplish (optional)."),
      },
    },
    ({ task }) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: buildAuthoringPromptText(task) },
        },
      ],
    }),
  );
}
