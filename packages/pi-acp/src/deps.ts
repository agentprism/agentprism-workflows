import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type NewSessionOptions,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { McpServer } from "@agentclientprotocol/sdk";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  connectDefaultMcpClient,
  type McpClientHandle,
  type McpSessionBinding,
} from "./mcp-bridge.js";

export interface PiAcpDeps {
  createAgentSession(opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  sessions: {
    create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
    open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
    forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
    list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
    listAll(sessionDir?: string): Promise<SessionInfo[]>;
  };
  modelRuntime: ModelRuntime;
  sessionDir?: string;
  connectMcpClient(
    server: McpServer,
    signal: AbortSignal,
    binding?: McpSessionBinding,
  ): Promise<McpClientHandle>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  graceMs: number;
  mcpTimeoutMs: number;
}

export function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export async function resolveDeps(partial: Partial<PiAcpDeps> = {}): Promise<PiAcpDeps> {
  const sleep = partial.sleep ?? realSleep;
  const mcpTimeoutMs = partial.mcpTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
  const modelRuntime = partial.modelRuntime ?? await ModelRuntime.create();
  const sessions = partial.sessions ?? {
    create: SessionManager.create,
    open: SessionManager.open,
    forkFrom: SessionManager.forkFrom,
    list: SessionManager.list,
    listAll: (sessionDir?: string) => SessionManager.listAll(sessionDir),
  };
  return {
    createAgentSession: partial.createAgentSession ?? createAgentSession,
    sessions,
    modelRuntime,
    sessionDir: partial.sessionDir,
    sleep,
    graceMs: partial.graceMs ?? 5_000,
    mcpTimeoutMs,
    connectMcpClient:
      partial.connectMcpClient ??
      ((server, signal, binding) => connectDefaultMcpClient(server, signal, mcpTimeoutMs, sleep, binding)),
  };
}
