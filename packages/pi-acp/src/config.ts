import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { adapterError } from "./errors.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function thinkingLevelOption(session: AgentSession): SessionConfigOption {
  return {
    id: "thinkingLevel",
    name: "Thinking level",
    type: "select",
    category: "thought_level",
    currentValue: session.thinkingLevel,
    options: THINKING_LEVELS.map((value) => ({ value, name: value })),
  };
}

export async function applyConfig(
  session: AgentSession,
  registry: ModelRegistry,
  configId: string,
  value: string | boolean,
): Promise<SessionConfigOption[]> {
  if (configId !== "thinkingLevel" && configId !== "model") {
    throw adapterError("unknown_config_option");
  }
  if (typeof value !== "string") throw adapterError("invalid_config_type");
  if (configId === "thinkingLevel") {
    if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
      throw adapterError("invalid_config_value");
    }
    session.setThinkingLevel(value as ThinkingLevel);
    return [thinkingLevelOption(session)];
  }
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw adapterError("invalid_model");
  const provider = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  const model = registry.find(provider, modelId);
  if (!model) throw adapterError("invalid_model");
  if (!registry.hasConfiguredAuth(model)) throw adapterError("auth_error");
  try {
    await session.setModel(model);
  } catch (error) {
    if (error instanceof Error && /^no api key for /i.test(error.message)) {
      throw adapterError("auth_error");
    }
    throw error;
  }
  return [thinkingLevelOption(session)];
}
