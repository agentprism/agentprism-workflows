import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { ClientCapabilityOptions } from "../client-handlers.js";
import type { AuthIntent } from "./auth-store.js";
import type { AuthMethodDescriptor, AuthResolution } from "./auth-types.js";

/** A spawnable interactive login a host runs in a TTY. */
export interface TerminalLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  label?: string;
}

/** Per-agent auth adaptation. Every field enriches the common type-driven auth flow. */
export interface AuthProfile {
  readonly backendId: string;
  clientAuthCapabilities(host: {
    onAuth: boolean;
    terminal: boolean;
  }): ClientCapabilityOptions["auth"];
  describe(method: AuthMethod, base: AuthMethodDescriptor): AuthMethodDescriptor;
  terminalLaunch?(method: Extract<AuthMethod, { type: "terminal" }>): TerminalLaunch;
  buildMeta?(
    method: AuthMethod,
    resolution: Extract<AuthResolution, { outcome: "meta" }>,
  ): Record<string, unknown>;
  spawnAuthEnv?(intent: AuthIntent): Record<string, string> | undefined;
}
