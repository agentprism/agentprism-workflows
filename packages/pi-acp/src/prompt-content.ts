import type { ContentBlock } from "@agentclientprotocol/sdk";
import { adapterError } from "./errors.js";

export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ConvertedPrompt {
  text: string;
  images: PiImage[];
}

export function convertPromptContent(blocks: readonly ContentBlock[]): ConvertedPrompt {
  const text: string[] = [];
  const images: PiImage[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        text.push(block.text);
        break;
      case "image":
        images.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      case "resource_link":
        text.push(`[${block.title ?? block.name ?? block.uri}](${block.uri})`);
        break;
      case "resource":
        text.push(
          "text" in block.resource
            ? block.resource.text
            : `[embedded resource: ${block.resource.uri}]`,
        );
        break;
      case "audio":
        text.push("[unsupported audio content omitted]");
        break;
      default: {
        const exhaustive: never = block;
        return exhaustive;
      }
    }
  }
  const joined = text.join("\n\n");
  if (!text.some((segment) => segment.length > 0) && images.length === 0) {
    throw adapterError("empty_prompt");
  }
  return { text: joined, images };
}
