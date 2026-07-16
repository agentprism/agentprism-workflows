import type { AuthMethod } from "@agentclientprotocol/sdk";
import { adapterError } from "./errors.js";

export const AUTH_METHODS: AuthMethod[] = [
  {
    id: "anthropic-api-key",
    name: "Anthropic API key",
    type: "env_var",
    vars: [{ name: "ANTHROPIC_API_KEY", secret: true }],
  },
  {
    id: "openai-api-key",
    name: "OpenAI API key",
    type: "env_var",
    vars: [{ name: "OPENAI_API_KEY", secret: true }],
  },
  {
    id: "gemini-api-key",
    name: "Google Gemini API key",
    type: "env_var",
    vars: [{ name: "GEMINI_API_KEY", secret: true }],
  },
  {
    id: "xai-api-key",
    name: "xAI API key",
    type: "env_var",
    vars: [{ name: "XAI_API_KEY", secret: true }],
  },
  {
    id: "openrouter-api-key",
    name: "OpenRouter API key",
    type: "env_var",
    vars: [{ name: "OPENROUTER_API_KEY", secret: true }],
  },
  { id: "pi-stored-credentials", name: "pi stored credentials" },
];

const IDS = new Set(AUTH_METHODS.map(({ id }) => id));

export function authenticateMethod(methodId: string): Record<string, never> {
  if (!IDS.has(methodId)) throw adapterError("unknown_auth_method");
  return {};
}
