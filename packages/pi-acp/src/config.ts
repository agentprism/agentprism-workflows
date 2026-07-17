import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
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

export function modelOption(session: AgentSession, availableModels: readonly Model<Api>[]): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: session.model ? `${session.model.provider}/${session.model.id}` : "",
    options: availableModels.map((model) => ({ value: `${model.provider}/${model.id}`, name: model.name })),
  };
}

export async function applyConfig(
  session: AgentSession,
  modelRuntime: ModelRuntime,
  _availableModels: readonly Model<Api>[],
  configId: string,
  value: string | boolean,
): Promise<{ configOptions: SessionConfigOption[]; availableModels: readonly Model<Api>[] }> {
  if (configId !== "thinkingLevel" && configId !== "model") {
    throw adapterError("unknown_config_option");
  }
  if (typeof value !== "string") throw adapterError("invalid_config_type");
  if (configId === "thinkingLevel") {
    if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
      throw adapterError("invalid_config_value");
    }
    const availableModels = [...await modelRuntime.getAvailable()];
    session.setThinkingLevel(value as ThinkingLevel);
    return {
      configOptions: [thinkingLevelOption(session), modelOption(session, availableModels)],
      availableModels,
    };
  }
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw adapterError("invalid_model");
  const provider = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  const availableModels = [...await modelRuntime.getAvailable()];
  const model = availableModels.find((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (!model) throw adapterError("invalid_model");
  try {
    await session.setModel(model);
  } catch (error) {
    if (error instanceof Error && /^no api key for /i.test(error.message)) {
      throw adapterError("auth_error");
    }
    throw error;
  }
  return {
    configOptions: [thinkingLevelOption(session), modelOption(session, availableModels)],
    availableModels,
  };
}
