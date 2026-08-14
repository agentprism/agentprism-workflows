// The `author-workflow` MCP prompt — the published authoring skill served by the server
// itself. Prompts are a USER-controlled primitive (surfaced as slash commands / palette
// entries by prompt-capable hosts), so this adds zero model-facing tool surface: the tool
// list stays exactly [`workflow`]. The content is SELF-CONTAINED (generated from the skill
// with every same-directory pointer rewritten — a prompt recipient has no filesystem) and
// version-matched to the engine that executes the scripts it teaches.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AUTHORING_PROMPT_CONTENT } from "./generated/authoring-prompt-content.js";

export const AUTHORING_PROMPT_NAME = "author-workflow";

/** Assemble the prompt text: the bundled guide plus a closing instruction, task-framed when
 *  the optional `task` argument is present. */
export function buildAuthoringPromptText(task?: string): string {
  const trimmed = task?.trim();
  const discover =
    "When the script pins models, efforts, or configOptions, read the live catalog first with " +
    "`npx @automatalabs/workflows config [harness ...]` if a shell is available — never guess ids " +
    "or probe with a throwaway workflow.";
  const closing = trimmed
    ? `## Your task\n\nAuthor a workflow script that accomplishes the following, validate it if the validator is available, then run it with the \`workflow\` tool. ${discover}\n\n${trimmed}`
    : `## Next step\n\nAuthor the workflow script the user asks for (its first statement must be \`export const meta\`), validate it if the validator is available, then run it with the \`workflow\` tool. ${discover}`;
  return `${AUTHORING_PROMPT_CONTENT}\n\n---\n\n${closing}\n`;
}

/** Register the `author-workflow` prompt. The SDK advertises the `prompts` capability as a
 *  side effect; hosts without prompt support simply never call prompts/list. */
export function registerAuthoringPrompt(mcp: McpServer): void {
  mcp.registerPrompt(
    AUTHORING_PROMPT_NAME,
    {
      title: "Author an AgentPrism workflow script",
      description:
        "Load the complete AgentPrism workflow-authoring guide — the agent()/parallel()/pipeline() " +
        "DSL, per-call backend routing, structured outputs, checkpoints, determinism " +
        "rules, and the exhaustive option reference — so the assistant can write a correct workflow " +
        "script and run it with the `workflow` tool. Optional `task`: what the workflow should accomplish.",
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
