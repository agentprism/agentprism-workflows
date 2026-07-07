// Client-side ACP fs/terminal interposition for this ACP CLIENT. The initialized
// `clientCapabilities` advertisement MUST be the exact set of consumer handlers registered on the
// runner; agents may still call unadvertised methods, so the client methods remain installed and
// reject those calls explicitly instead of letting the legacy SDK adapter coalesce absence to null.
//
// CONFINEMENT IS THE CONSUMER'S JOB. This library only routes requests and supplies per-session
// context: sessionId, the session's own cwd, label, and runId. Enforcing worktree roots, resolving
// symlinks, scoping environment variables, bounding output, and applying timeouts belongs to the
// handler implementation. Handlers receive the session's OWN cwd, preserving per-session isolation
// even when a pooled ACP process serves multiple sessions.
import type {
  ClientCapabilities,
  ConnectMcpRequest,
  ConnectMcpResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  DisconnectMcpRequest,
  DisconnectMcpResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  MessageMcpRequest,
  MessageMcpResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

export interface AcpSessionContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly label?: string;
  readonly runId?: string;
}

export interface FsHandlers {
  readTextFile?(
    params: ReadTextFileRequest,
    ctx: AcpSessionContext,
  ): Promise<ReadTextFileResponse> | ReadTextFileResponse;
  writeTextFile?(
    params: WriteTextFileRequest,
    ctx: AcpSessionContext,
  ): Promise<WriteTextFileResponse | void> | WriteTextFileResponse | void;
}

export interface TerminalHandlers {
  createTerminal(
    params: CreateTerminalRequest,
    ctx: AcpSessionContext,
  ): Promise<CreateTerminalResponse> | CreateTerminalResponse;
  terminalOutput(
    params: TerminalOutputRequest,
    ctx: AcpSessionContext,
  ): Promise<TerminalOutputResponse> | TerminalOutputResponse;
  waitForTerminalExit(
    params: WaitForTerminalExitRequest,
    ctx: AcpSessionContext,
  ): Promise<WaitForTerminalExitResponse> | WaitForTerminalExitResponse;
  killTerminal(
    params: KillTerminalRequest,
    ctx: AcpSessionContext,
  ): Promise<KillTerminalResponse | void> | KillTerminalResponse | void;
  releaseTerminal(
    params: ReleaseTerminalRequest,
    ctx: AcpSessionContext,
  ): Promise<ReleaseTerminalResponse | void> | ReleaseTerminalResponse | void;
}

export interface McpHandlers {
  connect(
    params: ConnectMcpRequest,
    ctx: AcpSessionContext,
  ): Promise<ConnectMcpResponse> | ConnectMcpResponse;
  message(
    params: MessageMcpRequest,
    ctx: AcpSessionContext,
  ): Promise<MessageMcpResponse> | MessageMcpResponse;
  disconnect(
    params: DisconnectMcpRequest,
    ctx: AcpSessionContext,
  ): Promise<DisconnectMcpResponse | void> | DisconnectMcpResponse | void;
}

export interface ClientHandlers {
  fs?: FsHandlers;
  terminal?: TerminalHandlers;
  mcp?: McpHandlers;
}

export interface ClientCapabilityOptions {
  /** Advertise unstable ACP elicitation support only when this connection has a runner-wide
   *  responder. Initialize capabilities are fixed for the connection lifetime, so a later
   *  session-scoped responder alone cannot truthfully light this up. */
  elicitation?: boolean;
}

const TERMINAL_HANDLER_METHODS = [
  "createTerminal",
  "terminalOutput",
  "waitForTerminalExit",
  "killTerminal",
  "releaseTerminal",
] as const;

const MCP_HANDLER_METHODS = ["connect", "message", "disconnect"] as const;

/** The client capability advertisement: fs/terminal derived solely from registered consumer
 *  handlers, plus the capabilities this client supports natively regardless of handlers —
 *  boolean session config options (SessionHandle drives the catalog programmatically and
 *  handles `type: "boolean"` entries, e.g. codex-acp's Fast-mode toggle). The installed ACP SDK
 *  has no ClientCapabilities field for MCP-over-ACP; support is declared by sending
 *  `mcpServers[{ type: "acp" }]` on session/new and then gated against handlers at that site. */
export function clientCapabilitiesFor(
  handlers: ClientHandlers | undefined,
  options: ClientCapabilityOptions = {},
): ClientCapabilities {
  const capabilities: ClientCapabilities = { session: { configOptions: { boolean: {} } } };
  if (options.elicitation) capabilities.elicitation = { form: {}, url: {} };
  if (!handlers) return capabilities;

  const fs = handlers.fs;
  const fsCapabilities: NonNullable<ClientCapabilities["fs"]> = {};
  if (typeof fs?.readTextFile === "function") fsCapabilities.readTextFile = true;
  if (typeof fs?.writeTextFile === "function") fsCapabilities.writeTextFile = true;
  if (Object.keys(fsCapabilities).length > 0) capabilities.fs = fsCapabilities;

  if (hasFullTerminalHandlers(handlers.terminal)) capabilities.terminal = true;
  return capabilities;
}

/** Fail-fast validation for JavaScript consumers bypassing the grouped handler types. */
export function validateClientHandlers(handlers: ClientHandlers | undefined): void {
  if (handlers?.terminal) {
    const missing = missingTerminalMethods(handlers.terminal);
    if (missing.length > 0) {
      throw new Error(`clientHandlers.terminal missing required methods: ${missing.join(", ")}`);
    }
  }
  if (handlers?.mcp) {
    const missing = missingMcpMethods(handlers.mcp);
    if (missing.length > 0) {
      throw new Error(`clientHandlers.mcp missing required methods: ${missing.join(", ")}`);
    }
  }
}

function hasFullTerminalHandlers(terminal: TerminalHandlers | undefined): terminal is TerminalHandlers {
  return Boolean(terminal && missingTerminalMethods(terminal).length === 0);
}

export function hasFullMcpHandlers(mcp: McpHandlers | undefined): mcp is McpHandlers {
  return Boolean(mcp && missingMcpMethods(mcp).length === 0);
}

function missingTerminalMethods(terminal: Partial<TerminalHandlers>): string[] {
  return TERMINAL_HANDLER_METHODS.filter((method) => typeof terminal[method] !== "function");
}

function missingMcpMethods(mcp: Partial<McpHandlers>): string[] {
  return MCP_HANDLER_METHODS.filter((method) => typeof mcp[method] !== "function");
}
