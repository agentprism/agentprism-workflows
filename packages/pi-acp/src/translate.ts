import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

interface PiResult {
  content?: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
}

export function mapKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
    case "ls":
      return "read";
    case "edit":
    case "write":
      return "edit";
    case "bash":
      return "execute";
    case "grep":
    case "find":
      return "search";
    default:
      return "other";
  }
}

export function fileLocations(args: unknown): ToolCallLocation[] | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" ? [{ path }] : undefined;
}

export function contentItems(result: PiResult): ContentBlock[] {
  return (result.content ?? []).map((item) =>
    item.type === "text"
      ? { type: "text", text: item.text }
      : { type: "image", data: item.data, mimeType: item.mimeType },
  );
}

export function toContent(result: PiResult): ToolCallContent[] {
  return contentItems(result).map((content) => ({ type: "content", content }));
}

function translateAssistantEvent(event: Extract<AgentSessionEvent, { type: "message_update" }>[
  "assistantMessageEvent"
]): SessionUpdate[] {
  switch (event.type) {
    case "text_delta":
      return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta } }];
    case "thinking_delta":
      return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta } }];
    case "start":
    case "text_start":
    case "text_end":
    case "thinking_start":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
    case "done":
    case "error":
      return [];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function translateEvent(event: AgentSessionEvent, failedResult?: PiResult): SessionUpdate[] {
  switch (event.type) {
    case "message_update":
      return translateAssistantEvent(event.assistantMessageEvent);
    case "tool_execution_start":
      return [{
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId,
        title: event.toolName,
        kind: mapKind(event.toolName),
        status: "pending",
        rawInput: event.args,
        locations: fileLocations(event.args),
        _meta: { toolName: event.toolName },
      }];
    case "tool_execution_update":
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: "in_progress",
        content: toContent(event.partialResult as PiResult),
      };
      const partial = event.partialResult as PiResult;
      if (partial.details !== undefined) update.rawOutput = partial.details;
      return [update];
    case "tool_execution_end": {
      const result = failedResult ?? event.result as PiResult;
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: event.isError ? "failed" : "completed",
        content: toContent(result),
      };
      if (result.details !== undefined) update.rawOutput = result.details;
      return [update];
    }
    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_end":
    case "agent_settled":
    case "queue_update":
    case "compaction_start":
    case "compaction_end":
    case "entry_appended":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return [];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
