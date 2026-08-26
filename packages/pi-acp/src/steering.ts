import {
  RequestError,
  type ContentBlock,
  type PromptRequest,
} from "@agentclientprotocol/sdk";

export const SESSION_STEERING_METHOD = "_session/steering" as const;

export interface SteeringRequest {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: PromptRequest["_meta"];
}

export type SteeringResponse =
  | { outcome: "injected" }
  | { outcome: "promptRequired"; reason: "noRunningTurn" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
    case "audio":
      return typeof value.data === "string" && typeof value.mimeType === "string";
    case "resource_link":
      return typeof value.uri === "string" && typeof value.name === "string";
    case "resource": {
      const resource = value.resource;
      return isRecord(resource)
        && typeof resource.uri === "string"
        && (typeof resource.text === "string" || typeof resource.blob === "string");
    }
    default:
      return false;
  }
}

/** Runtime parser used by the ACP SDK's custom-request overload. */
export const steeringRequestParser = {
  parse(value: unknown): SteeringRequest {
    if (
      !isRecord(value)
      || typeof value.sessionId !== "string"
      || !Array.isArray(value.prompt)
      || !value.prompt.every(isContentBlock)
      || (
        value._meta !== undefined
        && value._meta !== null
        && !isRecord(value._meta)
      )
    ) {
      throw RequestError.invalidParams(undefined, "invalid _session/steering request");
    }
    return value as unknown as SteeringRequest;
  },
};
