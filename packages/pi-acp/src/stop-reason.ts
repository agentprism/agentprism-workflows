import type { PromptResponse } from "@agentclientprotocol/sdk";
import { classifyTerminal, unexpectedError } from "./errors.js";
import type { AssistantLike } from "./usage.js";

export function stopReasonFor(
  terminal: AssistantLike | undefined,
  aborted: boolean,
): PromptResponse["stopReason"] {
  if (aborted || terminal?.stopReason === "aborted") return "cancelled";
  switch (terminal?.stopReason) {
    case "stop":
    case "toolUse":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "error":
      throw classifyTerminal(terminal);
    case undefined:
      return "end_turn";
    default:
      throw unexpectedError(new Error("Unknown pi stop reason"), terminal);
  }
}
