import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { mapKind, toContent } from "./translate.js";

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ReplayMessage {
  role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | "branchSummary" | "compactionSummary";
  content?: string | ContentItem[] | Array<ContentItem | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: unknown }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  display?: boolean;
  command?: string;
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
}

function blocks(content: string | ContentItem[] | undefined): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (content ?? []).map((item) =>
    item.type === "text"
      ? { type: "text", text: item.text }
      : { type: "image", data: item.data, mimeType: item.mimeType },
  );
}

function bashExecutionToText(message: ReplayMessage): string {
  let text = `Ran \`${message.command ?? ""}\`\n`;
  text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
  if (message.cancelled) text += "\n\n(command cancelled)";
  else if (message.exitCode !== null && message.exitCode !== undefined && message.exitCode !== 0) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

function replayMessage(message: ReplayMessage): SessionUpdate[] {
  switch (message.role) {
    case "user":
      return blocks(message.content as string | ContentItem[]).map((content) => ({
        sessionUpdate: "user_message_chunk",
        content,
      }));
    case "assistant": {
      const updates: SessionUpdate[] = [];
      for (const item of (message.content ?? []) as Array<
        ContentItem | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: unknown }
      >) {
        if (item.type === "text") {
          updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } });
        } else if (item.type === "thinking") {
          updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: item.thinking } });
        } else if (item.type === "toolCall") {
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            title: item.name,
            kind: mapKind(item.name),
            status: "pending",
            rawInput: item.arguments,
            _meta: { toolName: item.name },
          });
        }
      }
      return updates;
    }
    case "toolResult": {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: message.toolCallId ?? "",
        status: message.isError ? "failed" : "completed",
        content: toContent({ content: message.content as ContentItem[] }),
      };
      if (message.details !== undefined) update.rawOutput = message.details;
      return [update];
    }
    case "bashExecution":
      return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: bashExecutionToText(message) } }];
    case "custom":
      return message.display
        ? blocks(message.content as string | ContentItem[]).map((content) => ({
            sessionUpdate: "agent_message_chunk",
            content,
          }))
        : [];
    case "branchSummary":
    case "compactionSummary":
      return [];
  }
}

export function replayEntry(entry: SessionEntry): SessionUpdate[] {
  switch (entry.type) {
    case "message":
      return replayMessage(entry.message as ReplayMessage);
    case "custom_message":
      return entry.display
        ? blocks(entry.content as string | ContentItem[]).map((content) => ({
            sessionUpdate: "user_message_chunk",
            content,
          }))
        : [];
    case "thinking_level_change":
    case "model_change":
    case "compaction":
    case "branch_summary":
    case "custom":
    case "label":
    case "session_info":
      return [];
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}
