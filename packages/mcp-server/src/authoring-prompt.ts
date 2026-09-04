// The `author-workflow` MCP prompt is a user-controlled convenience that frames an authoring
// task and points the assistant at the version-matched workflow Agent Skill. It deliberately does
// not embed the skill or bypass the host's skill activation and approval path.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const AUTHORING_PROMPT_NAME = "author-workflow";
export const WORKFLOW_AUTHORING_SKILL_URI = "skill://agentprism-workflow-authoring/SKILL.md";

/** Assemble a compact task frame. The agent loads only the skill references it needs. */
export function buildAuthoringPromptText(task?: string): string {
  const trimmed = task?.trim();
  const taskSection = trimmed
    ? `## Your task\n\n${trimmed}`
    : "## Next step\n\nAuthor the workflow script the user asks for, then run it with the `workflow` tool.";
  return [
    "# Author an AgentPrism workflow",
    "",
    `Activate the connected server's Agent Skill at \`${WORKFLOW_AUTHORING_SKILL_URI}\` through the host's skill-loading path. Follow its workflow-script guidance and read only the supporting references needed for this task. Do not use the separate REPL skill: workflow scripts and REPL evals have different \`agent()\` signatures and lifecycle semantics.`,
    "",
    "When the script pins a model, mode, or configOptions, call the `workflow` tool with `action:\"config\"` first; after choosing a model, use `modelSpecs` to read its exact option domain. Read the harness-owned mode names and descriptions before pinning an advertised id. The run action automatically performs static validation, a mocked dry run, and routed no-prompt config checks before admission. Correct any direct rejection diagnostic and re-run.",
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
        "Frame a workflow-authoring task and direct the assistant to activate the connected " +
        "server's version-matched Agent Skill.",
      argsSchema: z.object({
        task: z.string().optional().describe("What the workflow should accomplish (optional)."),
      }),
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
