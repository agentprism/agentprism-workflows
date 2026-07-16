import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AgentNotificationContext,
  AgentRequestContext,
  AuthenticateRequest,
  CloseSessionRequest,
  ForkSessionRequest,
  InitializeRequest,
  ListSessionsRequest,
  LoadSessionRequest,
  McpServer,
  NewSessionRequest,
  PromptRequest,
  ResumeSessionRequest,
  SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { AUTH_METHODS, authenticateMethod } from "./auth.js";
import type { PiAcpDeps } from "./deps.js";
import { adapterError, isRequestError, unexpectedError } from "./errors.js";
import {
  bridgeMcpServers,
  disposeMcpBridge,
  type McpBridge,
} from "./mcp-bridge.js";
import { PiSession } from "./session.js";
import { StructuredOutputState, STRUCTURED_TOOL_NAME } from "./structured-output.js";

export const PKG_VERSION = String(
  (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: unknown }).version,
);

interface Opening {
  controller: AbortController;
  id?: string;
}

function validateCwd(cwd: string): void {
  if (!isAbsolute(cwd)) throw adapterError("invalid_cwd");
  try {
    if (!statSync(cwd).isDirectory()) throw adapterError("invalid_cwd");
  } catch (error) {
    if (isRequestError(error)) throw error;
    throw adapterError("invalid_cwd");
  }
}

function openSignal(requestSignal: AbortSignal): AbortController {
  const controller = new AbortController();
  const abort = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) abort();
  else requestSignal.addEventListener("abort", abort, { once: true });
  return controller;
}

export class PiAcpAgent {
  private readonly deps: PiAcpDeps;
  private readonly live = new Map<string, PiSession>();
  private readonly opening = new Map<string, AbortController>();
  private readonly openingControllers = new Set<AbortController>();
  private readonly openingTasks = new Set<Promise<unknown>>();
  private readonly tombstones = new Set<string>();
  private disposed = false;

  constructor(deps: PiAcpDeps) {
    this.deps = deps;
  }

  initialize(_context: AgentRequestContext<InitializeRequest>) {
    return {
      protocolVersion: 1,
      agentInfo: {
        name: "@automatalabs/pi-acp",
        title: "pi coding agent",
        version: PKG_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        mcpCapabilities: {},
        sessionCapabilities: { resume: {}, fork: {}, list: {}, close: {} },
        _meta: { "@automatalabs/pi-acp": { outputSchema: true } },
      },
      authMethods: AUTH_METHODS,
    };
  }

  authenticate(context: AgentRequestContext<AuthenticateRequest>) {
    return authenticateMethod(context.params.methodId);
  }

  private ensureMayOpen(id: string): void {
    if (this.disposed) throw adapterError("internal_error");
    if (this.tombstones.has(id)) throw adapterError("session_terminated");
    if (this.live.has(id) || this.opening.has(id)) throw adapterError("session_already_open");
  }

  private reserve(id: string, controller: AbortController): void {
    this.ensureMayOpen(id);
    this.opening.set(id, controller);
  }

  private beginOpening(requestSignal: AbortSignal): Opening {
    if (this.disposed) throw adapterError("internal_error");
    const controller = openSignal(requestSignal);
    this.openingControllers.add(controller);
    return { controller };
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.openingTasks.add(task);
    task.finally(() => this.openingTasks.delete(task)).catch(() => undefined);
    return task;
  }

  private gate(opening: Opening): void {
    opening.controller.signal.throwIfAborted();
    if (this.disposed || (opening.id !== undefined && this.tombstones.has(opening.id))) {
      throw opening.controller.signal.reason ?? adapterError("internal_error");
    }
  }

  private async construct(
    opening: Opening,
    manager: SessionManager,
    cwd: string,
    client: AgentRequestContext<unknown>["client"],
    mcpServers: readonly McpServer[],
    replay: boolean,
    preconnected?: McpBridge,
  ): Promise<PiSession> {
    const id = manager.getSessionId();
    if (opening.id === undefined) {
      this.reserve(id, opening.controller);
      opening.id = id;
    }
    let bridge = preconnected;
    let pi: AgentSession | undefined;
    let wrapper: PiSession | undefined;
    try {
      this.gate(opening);
      bridge ??= await bridgeMcpServers(mcpServers, opening.controller.signal, this.deps);
      this.gate(opening);
      const structured = new StructuredOutputState();
      const created = await this.deps.createAgentSession({
        cwd,
        sessionManager: manager,
        modelRuntime: this.deps.modelRuntime,
        customTools: [...bridge.tools, structured.tool],
      });
      pi = created.session;
      this.gate(opening);
      wrapper = new PiSession({
        sessionId: id,
        session: pi,
        manager,
        client,
        deps: this.deps,
        mcpClients: bridge.clients,
        failedMcpResults: bridge.failedResults,
        structured,
        onWedged: (sessionId, session) => this.terminateWedged(sessionId, session),
      });
      structured.install(pi);
      const names = new Set(pi.getAllTools().map(({ name }) => name));
      if (!names.has(STRUCTURED_TOOL_NAME)) throw adapterError("structured_tool_collision");
      const missingAlias = bridge.aliases.find((alias) => !names.has(alias));
      if (missingAlias) {
        throw adapterError("mcp_init_error", {
          server: bridge.aliasServers.get(missingAlias) ?? "unknown",
        });
      }
      if (replay) await wrapper.replay(manager.getBranch());
      this.gate(opening);
      this.live.set(id, wrapper);
      this.opening.delete(id);
      return wrapper;
    } catch (error) {
      if (wrapper) await wrapper.disposeResources();
      else {
        if (pi) {
          try {
            await pi.dispose();
          } catch (disposeError) {
            console.error("pi-acp rollback dispose error:", disposeError);
          }
        }
        if (bridge) await disposeMcpBridge(bridge.clients, this.deps);
      }
      throw error;
    } finally {
      if (opening.id !== undefined && this.opening.get(opening.id) === opening.controller) {
        this.opening.delete(opening.id);
      }
      this.openingControllers.delete(opening.controller);
    }
  }

  private openingError(error: unknown): never {
    if (isRequestError(error)) throw error;
    throw unexpectedError(error);
  }

  newSession(context: AgentRequestContext<NewSessionRequest>) {
    validateCwd(context.params.cwd);
    let manager: SessionManager;
    try {
      manager = this.deps.sessions.create(context.params.cwd, this.deps.sessionDir);
    } catch (error) {
      return this.openingError(error);
    }
    const opening = this.beginOpening(context.signal);
    try {
      this.reserve(manager.getSessionId(), opening.controller);
      opening.id = manager.getSessionId();
    } catch (error) {
      this.openingControllers.delete(opening.controller);
      throw error;
    }
    const task = this.construct(
      opening,
      manager,
      context.params.cwd,
      context.client,
      context.params.mcpServers,
      false,
    ).then((session) => ({ sessionId: session.sessionId, configOptions: session.configOptions(), modes: null }))
      .catch((error) => this.openingError(error));
    return this.track(task);
  }

  private reattach(
    context: AgentRequestContext<LoadSessionRequest | ResumeSessionRequest>,
    replay: boolean,
  ) {
    validateCwd(context.params.cwd);
    const opening = this.beginOpening(context.signal);
    try {
      this.reserve(context.params.sessionId, opening.controller);
      opening.id = context.params.sessionId;
    } catch (error) {
      this.openingControllers.delete(opening.controller);
      throw error;
    }
    const task = (async () => {
      try {
        this.gate(opening);
        const infos = await this.deps.sessions.list(context.params.cwd, this.deps.sessionDir);
        this.gate(opening);
        const info = infos.find(({ id }) => id === context.params.sessionId);
        if (!info) throw adapterError("unknown_session");
        let manager: SessionManager;
        try {
          manager = this.deps.sessions.open(info.path, this.deps.sessionDir);
        } catch {
          throw adapterError("session_corrupt");
        }
        const session = await this.construct(
          opening,
          manager,
          context.params.cwd,
          context.client,
          context.params.mcpServers ?? [],
          replay,
        );
        return { configOptions: session.configOptions(), modes: null };
      } catch (error) {
        if (opening.id !== undefined && this.opening.get(opening.id) === opening.controller) {
          this.opening.delete(opening.id);
        }
        this.openingControllers.delete(opening.controller);
        return this.openingError(error);
      }
    })();
    return this.track(task);
  }

  loadSession(context: AgentRequestContext<LoadSessionRequest>) {
    return this.reattach(context, true);
  }

  resumeSession(context: AgentRequestContext<ResumeSessionRequest>) {
    return this.reattach(context, false);
  }

  forkSession(context: AgentRequestContext<ForkSessionRequest>) {
    if (this.tombstones.has(context.params.sessionId)) throw adapterError("session_terminated");
    const liveSource = this.live.get(context.params.sessionId);
    if (liveSource?.busy) throw adapterError("session_busy");
    validateCwd(context.params.cwd);
    const opening = this.beginOpening(context.signal);
    const task = (async () => {
      let bridge: McpBridge | undefined;
      try {
        let sourcePath: string | undefined;
        if (liveSource) {
          sourcePath = liveSource.manager.getSessionFile();
          if (!sourcePath || !existsSync(sourcePath)) throw adapterError("session_not_forkable");
        } else {
          const all = await this.deps.sessions.listAll(this.deps.sessionDir);
          sourcePath = all.find(({ id }) => id === context.params.sessionId)?.path;
          if (!sourcePath) throw adapterError("unknown_session");
        }
        this.gate(opening);
        bridge = await bridgeMcpServers(context.params.mcpServers ?? [], opening.controller.signal, this.deps);
        this.gate(opening);
        if (this.tombstones.has(context.params.sessionId)) throw adapterError("session_terminated");
        if (liveSource?.busy) throw adapterError("session_busy");
        let manager: SessionManager;
        try {
          manager = this.deps.sessions.forkFrom(sourcePath, context.params.cwd, this.deps.sessionDir);
        } catch {
          throw adapterError("session_corrupt");
        }
        this.reserve(manager.getSessionId(), opening.controller);
        opening.id = manager.getSessionId();
        const session = await this.construct(
          opening,
          manager,
          context.params.cwd,
          context.client,
          context.params.mcpServers ?? [],
          false,
          bridge,
        );
        bridge = undefined;
        return { sessionId: session.sessionId, configOptions: session.configOptions(), modes: null };
      } catch (error) {
        if (bridge) await disposeMcpBridge(bridge.clients, this.deps);
        if (opening.id !== undefined && this.opening.get(opening.id) === opening.controller) {
          this.opening.delete(opening.id);
        }
        this.openingControllers.delete(opening.controller);
        return this.openingError(error);
      }
    })();
    return this.track(task);
  }

  async listSessions(context: AgentRequestContext<ListSessionsRequest>) {
    if (context.params.cwd !== undefined && context.params.cwd !== null) validateCwd(context.params.cwd);
    let offset = 0;
    const cursor = context.params.cursor;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, "base64url").toString("utf8");
        if (!/^(0|[1-9][0-9]*)$/.test(decoded)) throw new Error("noncanonical decimal");
        if (Buffer.from(decoded).toString("base64url") !== cursor) throw new Error("noncanonical base64url");
        const value = BigInt(decoded);
        offset = value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
      } catch {
        throw adapterError("invalid_cursor");
      }
    }
    let infos;
    try {
      infos = context.params.cwd
        ? await this.deps.sessions.list(context.params.cwd, this.deps.sessionDir)
        : await this.deps.sessions.listAll(this.deps.sessionDir);
    } catch (error) {
      throw unexpectedError(error);
    }
    const page = infos.slice(offset, offset + 100);
    const nextOffset = offset + 100;
    return {
      sessions: page.map((info) => ({
        sessionId: info.id,
        cwd: info.cwd,
        title: info.name ?? info.firstMessage,
      })),
      ...(nextOffset < infos.length
        ? { nextCursor: Buffer.from(String(nextOffset)).toString("base64url") }
        : {}),
    };
  }

  async closeSession(context: AgentRequestContext<CloseSessionRequest>) {
    const controller = this.opening.get(context.params.sessionId);
    if (controller) {
      controller.abort(new Error("session closed while opening"));
      return {};
    }
    const session = this.live.get(context.params.sessionId);
    if (!session) return {};
    try {
      await session.dispose();
    } catch (error) {
      console.error("pi-acp close error:", error);
    } finally {
      if (this.live.get(context.params.sessionId) === session) this.live.delete(context.params.sessionId);
    }
    return {};
  }

  private requireLive(id: string): PiSession {
    if (this.tombstones.has(id)) throw adapterError("session_terminated");
    const session = this.live.get(id);
    if (!session) throw adapterError("unknown_session");
    return session;
  }

  setConfigOption(context: AgentRequestContext<SetSessionConfigOptionRequest>) {
    const session = this.requireLive(context.params.sessionId);
    return session.setConfig(context.params.configId, context.params.value)
      .then((configOptions) => ({ configOptions }))
      .catch((error) => {
        if (isRequestError(error)) throw error;
        throw unexpectedError(error);
      });
  }

  prompt(context: AgentRequestContext<PromptRequest>) {
    return this.requireLive(context.params.sessionId).prompt(context.params, context.signal);
  }

  cancel(context: AgentNotificationContext<{ sessionId: string }>): void {
    this.live.get(context.params.sessionId)?.cancel();
  }

  private async terminateWedged(id: string, session: PiSession): Promise<void> {
    this.tombstones.add(id);
    if (this.live.get(id) === session) this.live.delete(id);
    await session.disposeResources();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.openingControllers) controller.abort(new Error("agent disposed"));
    await Promise.allSettled([...this.openingTasks]);
    const sessions = [...this.live.values()];
    this.live.clear();
    await Promise.allSettled(sessions.map((session) => session.dispose()));
    this.tombstones.clear();
  }
}
