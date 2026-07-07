// Shared prompt construction helpers for the public one-shot runner and the held-open
// interactive session API. Keep this file purely about request shaping: backend/session
// lifecycle, draining, and error mapping stay in runner.ts / acp-client.ts.
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  WorkflowError,
  WorkflowErrorCode,
  type PromptImage,
} from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import type { Backend } from "./backend.js";
import { toJsonSchema } from "./schema-strict.js";

/** Build the exact one-shot run() prompt text: optional engine instructions, a diagnostic label,
 *  the user prompt, and (for schema runs) the backend-appropriate final-output contract. */
export function buildRunPrompt(
  prompt: string,
  opts: { instructions?: string; label?: string },
  schema: TSchema | undefined,
  backend: Backend,
  structuredToolActive = false,
): string {
  const parts: string[] = [];
  if (opts.instructions) parts.push(opts.instructions);
  if (opts.label) parts.push(`Task label: ${opts.label}`);
  parts.push(prompt);
  if (schema) {
    if (structuredToolActive) {
      parts.push(
        [
          "Final output contract:",
          "- You have been provided an MCP tool named StructuredOutput (it may appear namespaced by its server, e.g. structured_output_StructuredOutput).",
          "- You MUST call it exactly once with your final answer as its arguments; its parameter schema defines the required output shape.",
          "- Complete all necessary research and tool calls BEFORE calling it.",
          "- Do NOT emit your final answer as plain text.",
        ].join("\n"),
      );
    } else {
      const contract = [
        "Final output contract:",
        "- Your FINAL message MUST be a single JSON object that conforms to the required output schema.",
        "- Output ONLY that JSON object — no prose, no explanation, and no markdown code fences.",
        "- If you need to inspect files or run commands first, do so, then emit the JSON object as your final message.",
      ];
      if (backend.embedSchemaInPrompt) {
        // Custom ACP agents may ignore `_meta.outputSchema`; state the schema in-band so the
        // repair ladder is correcting against a visible contract, not an unseen extension key.
        contract.push(`- The required output schema (JSON Schema):\n${JSON.stringify(toJsonSchema(schema))}`);
      }
      parts.push(contract.join("\n"));
    }
  }
  return parts.join("\n\n");
}

/** Validate prompt images before spawning/sending. Invalid images are deterministic script
 *  errors, never provider failures, and the bad index is part of the contract for callers. */
export function validatePromptImages(images: readonly PromptImage[] | undefined, label?: string): void {
  if (!images || images.length === 0) return;
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i] as PromptImage | undefined;
    if (typeof image?.data !== "string" || image.data.trim() === "") {
      throw new WorkflowError(
        `images[${i}].data must be a non-empty string`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    }
    if (typeof image.mimeType !== "string" || image.mimeType.trim() === "") {
      throw new WorkflowError(
        `images[${i}].mimeType must be a non-empty string`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    }
    if (image.uri !== undefined && (typeof image.uri !== "string" || image.uri.trim() === "")) {
      throw new WorkflowError(
        `images[${i}].uri must be a non-empty string when present`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    }
  }
}

/** Convert base64 image attachments to ACP image ContentBlocks without capability adaptation.
 *  SessionHandle.prompt() performs the advertised-capability downgrade at send time. */
function imageContentBlocks(images: readonly PromptImage[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const image of images) {
    blocks.push(
      image.uri === undefined
        ? { type: "image", data: image.data, mimeType: image.mimeType }
        : { type: "image", data: image.data, mimeType: image.mimeType, uri: image.uri },
    );
  }
  return blocks;
}

/** One-shot run() image shape: the text prompt first, then each image attachment. */
export function promptWithImages(text: string, images: readonly PromptImage[]): ContentBlock[] {
  return [{ type: "text", text }, ...imageContentBlocks(images)];
}

/** Interactive prompt image shape: string prompts match run(); ContentBlock prompts keep the
 *  caller's blocks and append this turn's image attachments. */
export function appendPromptImages(
  content: string | ContentBlock[],
  images: readonly PromptImage[] | undefined,
): string | ContentBlock[] {
  if (!images || images.length === 0) return content;
  if (typeof content === "string") return promptWithImages(content, images);
  return [...content, ...imageContentBlocks(images)];
}

/** Merge generic turn-scoped `_meta` UNDER the backend-computed turn meta. */
export function mergeTurnMeta(
  user: Record<string, unknown> | undefined,
  backend: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!user) return backend;
  return { ...user, ...(backend ?? {}) };
}
