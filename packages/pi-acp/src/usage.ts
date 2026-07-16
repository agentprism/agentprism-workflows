import type { PromptResponse, SessionUpdate, Usage } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoning?: number;
}

export interface AssistantLike {
  role: "assistant";
  usage: PiUsage;
  stopReason: string;
  errorMessage?: string;
  diagnostics?: Array<{
    type: string;
    timestamp: number;
    error?: { name?: string; message: string; stack?: string; code?: string | number };
    details?: unknown;
  }>;
}

export function agentMessages(session: AgentSession): unknown[] {
  return session.agent.state.messages as unknown[];
}

export function assistantMessages(messages: readonly unknown[]): AssistantLike[] {
  return messages.filter(
    (message): message is AssistantLike =>
      typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant",
  );
}

export function terminalAssistant(messages: readonly unknown[]): AssistantLike | undefined {
  return assistantMessages(messages).at(-1);
}

export function promptUsage(messages: readonly unknown[]): Usage {
  const assistants = assistantMessages(messages);
  const sum = (key: keyof PiUsage) =>
    assistants.reduce((total, message) => total + (message.usage[key] ?? 0), 0);
  const usage: Usage = {
    inputTokens: sum("input"),
    outputTokens: sum("output"),
    cachedReadTokens: sum("cacheRead"),
    cachedWriteTokens: sum("cacheWrite"),
    totalTokens: sum("totalTokens"),
  };
  if (assistants.some((message) => message.usage.reasoning !== undefined)) {
    usage.thoughtTokens = sum("reasoning");
  }
  return usage;
}

export function usageUpdate(session: AgentSession): SessionUpdate {
  const context = session.getContextUsage();
  return {
    sessionUpdate: "usage_update",
    used: context?.tokens ?? 0,
    size: context?.contextWindow ?? session.model?.contextWindow ?? 0,
    cost: { amount: session.getSessionStats().cost, currency: "USD" },
  };
}

export function response(stopReason: PromptResponse["stopReason"], messages: readonly unknown[]): PromptResponse {
  return { stopReason, usage: promptUsage(messages) };
}
