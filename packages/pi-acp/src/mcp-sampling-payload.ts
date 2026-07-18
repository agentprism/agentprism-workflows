import type { CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

type SamplingParams = CreateMessageRequest["params"];
type SamplingRole = "user" | "assistant";
type MediaKind = "image" | "audio";

interface MediaMarker {
  marker: string;
  role: SamplingRole;
  kind: MediaKind;
  mimeType: string;
  data: string;
}

export interface McpSamplingPayload {
  context: Context;
  onPayload(payload: unknown): unknown;
}

let requestSequence = 0;

function mediaError(): never {
  throw exactMcpError(ErrorCode.InternalError, "Active pi model cannot represent MCP sampling media");
}

function exactMcpError(code: ErrorCode, message: string): McpError {
  const error = new McpError(code, message);
  // The pinned SDK prefixes McpError.message for local display, then serializes that property verbatim.
  // Restore the protocol message so the JSON-RPC error remains the fixed contract string.
  error.message = message;
  return error;
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function allInputText(params: SamplingParams): string[] {
  return params.messages.flatMap((message) => {
    const content = Array.isArray(message.content) ? message.content : [message.content];
    return content.flatMap((block) => block.type === "text" ? [block.text] : []);
  });
}

/**
 * Build a role-faithful Pi context and a request-local provider-payload rewrite. Media is represented
 * by collision-free markers until Pi has assembled the concrete provider request body.
 */
export function createMcpSamplingPayload(params: SamplingParams, model: Model<Api>): McpSamplingPayload {
  const inputText = allInputText(params);
  let token: string;
  do {
    requestSequence += 1;
    token = `PI_ACP_MCP_MEDIA_${requestSequence.toString(36).toUpperCase()}`;
  } while (inputText.some((text) => text.includes(token)));

  const markers: MediaMarker[] = [];
  const context: Context = {
    ...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
    messages: params.messages.map((message) => {
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      const content = blocks.map((block) => {
        if (block.type === "text") return { type: "text" as const, text: block.text };
        if (block.type !== "image" && block.type !== "audio") {
          throw exactMcpError(ErrorCode.InvalidParams, "Unsupported MCP sampling capability");
        }
        const marker = `__${token}_${markers.length.toString(36).toUpperCase()}__`;
        markers.push({ marker, role: message.role, kind: block.type, mimeType: block.mimeType, data: block.data });
        return { type: "text" as const, text: marker };
      });
      if (message.role === "user") return { role: "user" as const, content, timestamp: 0 };
      return {
        role: "assistant" as const,
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop" as const,
        usage: zeroUsage(),
        timestamp: 0,
      };
    }),
  };

  return {
    context,
    onPayload: (payload) => rewriteMcpSamplingPayload(payload, model.api, markers),
  };
}

function dataUrl(marker: MediaMarker): string {
  return `data:${marker.mimeType};base64,${marker.data}`;
}

function nativeBlock(api: Api, marker: MediaMarker, payloadRole: SamplingRole | undefined): unknown {
  if (payloadRole !== marker.role) return mediaError();
  switch (api) {
    case "google-generative-ai":
    case "google-vertex":
      return { inlineData: { mimeType: marker.mimeType, data: marker.data } };
    case "openai-completions":
      if (marker.role === "user" && marker.kind === "image") {
        return { type: "image_url", image_url: { url: dataUrl(marker) } };
      }
      return mediaError();
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      if (marker.role === "user" && marker.kind === "image") {
        return { type: "input_image", image_url: dataUrl(marker), detail: "auto" };
      }
      return mediaError();
    case "anthropic-messages":
      if (
        marker.kind === "image" &&
        ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(marker.mimeType)
      ) {
        return {
          type: "image",
          source: { type: "base64", media_type: marker.mimeType, data: marker.data },
        };
      }
      return mediaError();
    case "mistral-conversations":
      if (marker.role === "user" && marker.kind === "image") {
        return { type: "image_url", imageUrl: dataUrl(marker) };
      }
      return mediaError();
    case "pi-messages":
      if (marker.role === "user" && marker.kind === "image") {
        return { type: "image", data: marker.data, mimeType: marker.mimeType };
      }
      return mediaError();
    case "bedrock-converse-stream":
      // Bedrock's image block retains only a format enum, not the exact MIME string.
      return mediaError();
    default:
      return mediaError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function markerOccurrenceCounts(value: unknown, markers: readonly MediaMarker[]): Map<string, number> {
  const counts = new Map(markers.map(({ marker }) => [marker, 0]));
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      for (const { marker } of markers) {
        let from = 0;
        for (;;) {
          const index = entry.indexOf(marker, from);
          if (index < 0) break;
          counts.set(marker, (counts.get(marker) ?? 0) + 1);
          from = index + marker.length;
        }
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (isRecord(entry)) {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  return counts;
}

function samplingRole(value: unknown): SamplingRole | undefined {
  if (value === "user") return "user";
  if (value === "assistant" || value === "model") return "assistant";
  return undefined;
}

function replaceTextParts(
  parts: unknown,
  role: SamplingRole | undefined,
  api: Api,
  byMarker: ReadonlyMap<string, MediaMarker>,
  replacements: Map<string, number>,
  expectedTextType: string | undefined,
): unknown[] {
  if (!Array.isArray(parts) || !role) return mediaError();
  return parts.map((part) => {
    if (!isRecord(part)) return part;
    const marker = typeof part.text === "string" ? byMarker.get(part.text) : undefined;
    if (!marker) return part;
    if (expectedTextType !== undefined && part.type !== expectedTextType) return mediaError();
    if (expectedTextType === undefined && Object.keys(part).some((key) => key !== "text")) return mediaError();
    replacements.set(marker.marker, (replacements.get(marker.marker) ?? 0) + 1);
    return nativeBlock(api, marker, role);
  });
}

function replaceMessageContent(
  messages: unknown,
  api: Api,
  byMarker: ReadonlyMap<string, MediaMarker>,
  replacements: Map<string, number>,
  expectedTextType: string | undefined,
): unknown[] {
  if (!Array.isArray(messages)) return mediaError();
  return messages.map((message) => {
    if (!isRecord(message)) return message;
    const role = samplingRole(message.role);
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: replaceTextParts(message.content, role, api, byMarker, replacements, expectedTextType),
    };
  });
}

/** Pure structural codec used by the ten pinned built-in API payload fixtures. */
export function rewriteMcpSamplingPayload(
  payload: unknown,
  api: Api,
  media: readonly MediaMarker[],
): unknown {
  if (media.length === 0) return payload;
  const byMarker = new Map(media.map((item) => [item.marker, item]));
  const occurrences = markerOccurrenceCounts(payload, media);
  const replacements = new Map<string, number>();
  if (!isRecord(payload)) return mediaError();

  let rewritten: Record<string, unknown>;
  switch (api) {
    case "openai-completions":
    case "anthropic-messages":
    case "mistral-conversations":
      rewritten = {
        ...payload,
        messages: replaceMessageContent(
          payload.messages,
          api,
          byMarker,
          replacements,
          "text",
        ),
      };
      break;
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      rewritten = {
        ...payload,
        input: replaceMessageContent(payload.input, api, byMarker, replacements, "input_text"),
      };
      break;
    case "google-generative-ai":
    case "google-vertex": {
      if (!Array.isArray(payload.contents)) return mediaError();
      rewritten = {
        ...payload,
        contents: payload.contents.map((message) => {
          if (!isRecord(message)) return message;
          return {
            ...message,
            parts: replaceTextParts(
              message.parts,
              samplingRole(message.role),
              api,
              byMarker,
              replacements,
              undefined,
            ),
          };
        }),
      };
      break;
    }
    case "pi-messages": {
      if (!isRecord(payload.context)) return mediaError();
      rewritten = {
        ...payload,
        context: {
          ...payload.context,
          messages: replaceMessageContent(
            payload.context.messages,
            api,
            byMarker,
            replacements,
            "text",
          ),
        },
      };
      break;
    }
    case "bedrock-converse-stream":
    default:
      return mediaError();
  }

  for (const marker of media) {
    if (occurrences.get(marker.marker) !== 1 || replacements.get(marker.marker) !== 1) return mediaError();
  }
  const remaining = markerOccurrenceCounts(rewritten, media);
  for (const marker of media) {
    if (remaining.get(marker.marker) !== 0) return mediaError();
  }
  return rewritten;
}
