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
    case "pending":
      // pi >=0.83.0 marks still-streaming partials "pending"; a finalized message always carries
      // a real reason. A resolved turn whose terminal message is still "pending" means the
      // stream ended without termination — same diagnostic seam as unknown reasons, but named.
      throw unexpectedError(new Error("pi turn resolved with a still-pending terminal message"), terminal);
    case undefined:
      return "end_turn";
    default:
      throw unexpectedError(new Error("Unknown pi stop reason"), terminal);
  }
}
