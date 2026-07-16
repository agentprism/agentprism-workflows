import {
  methods,
  type AgentContext,
  type PromptRequest,
  type PromptResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { adapterError, classifyPreflight, isRequestError, unexpectedError } from "./errors.js";
import type { PiAcpDeps } from "./deps.js";
import { applyConfig, thinkingLevelOption } from "./config.js";
import { convertPromptContent } from "./prompt-content.js";
import { replayEntry } from "./replay.js";
import { stopReasonFor } from "./stop-reason.js";
import { StructuredOutputState } from "./structured-output.js";
import { translateEvent } from "./translate.js";
import {
  agentMessages,
  promptUsage,
  terminalAssistant,
  usageUpdate,
} from "./usage.js";
import { installPermissionWrapper } from "./permissions.js";
import {
  disposeMcpBridge,
  type McpClientHandle,
  type McpResultProjection,
} from "./mcp-bridge.js";

interface ActiveTurn {
  controller: AbortController;
  settledController: AbortController;
  settlement: Promise<void>;
  resolveSettlement: () => void;
  completed: boolean;
  notificationFailed: boolean;
  backstopStarted: boolean;
  resolve: (response: PromptResponse) => void;
  reject: (error: unknown) => void;
  startMessageIndex: number;
  structured: boolean;
  removeRequestAbort?: () => void;
}

export interface PiSessionOptions {
  sessionId: string;
  session: AgentSession;
  manager: SessionManager;
  client: AgentContext;
  deps: PiAcpDeps;
  mcpClients: McpClientHandle[];
  failedMcpResults: Map<string, McpResultProjection>;
  structured: StructuredOutputState;
  onWedged(sessionId: string, session: PiSession): Promise<void>;
}

export class PiSession {
  readonly sessionId: string;
  readonly pi: AgentSession;
  readonly manager: SessionManager;
  private readonly client: AgentContext;
  private readonly deps: PiAcpDeps;
  private readonly mcpClients: McpClientHandle[];
  private readonly failedMcpResults: Map<string, McpResultProjection>;
  private readonly structured: StructuredOutputState;
  private readonly onWedged: PiSessionOptions["onWedged"];
  private readonly pending: SessionUpdate[] = [];
  private pump: Promise<void> | undefined;
  private pumpFailure: unknown;
  private stopped = false;
  private closing = false;
  private disposed = false;
  private unsubscribe: (() => void) | undefined;
  private activeTurn: ActiveTurn | undefined;

  constructor(options: PiSessionOptions) {
    this.sessionId = options.sessionId;
    this.pi = options.session;
    this.manager = options.manager;
    this.client = options.client;
    this.deps = options.deps;
    this.mcpClients = options.mcpClients;
    this.failedMcpResults = options.failedMcpResults;
    this.structured = options.structured;
    this.onWedged = options.onWedged;
    installPermissionWrapper(this.pi, {
      sessionId: this.sessionId,
      client: this.client,
      drain: () => this.drain(),
      turnSignal: () => this.activeTurn?.controller.signal,
    });
    const innerAfterToolCall = this.pi.agent.afterToolCall;
    this.pi.agent.afterToolCall = async (context, signal) => {
      const innerResult = innerAfterToolCall ? await innerAfterToolCall(context, signal) : undefined;
      const failedResult = this.failedMcpResults.get(context.toolCall.id);
      if (!failedResult) return innerResult;
      return {
        ...innerResult,
        content: failedResult.content,
        ...(failedResult.details === undefined ? {} : { details: failedResult.details }),
        isError: true,
      };
    };
    this.unsubscribe = this.pi.subscribe((event) => {
      const failedResult = event.type === "tool_execution_end" && event.isError
        ? this.failedMcpResults.get(event.toolCallId)
        : undefined;
      if (event.type === "tool_execution_end") this.failedMcpResults.delete(event.toolCallId);
      for (const update of translateEvent(event, failedResult)) this.enqueue(update);
    });
  }

  get busy(): boolean {
    return this.activeTurn !== undefined || this.closing;
  }

  configOptions() {
    return [thinkingLevelOption(this.pi)];
  }

  enqueue(update: SessionUpdate): void {
    if (this.stopped) return;
    this.pending.push(update);
    if (!this.pump) this.startPump();
  }

  private startPump(): void {
    this.pump = (async () => {
      while (!this.stopped && this.pending.length > 0) {
        const update = this.pending.shift();
        if (!update) continue;
        await this.client.notify(methods.client.session.update, {
          sessionId: this.sessionId,
          update,
        });
      }
    })()
      .catch((error) => {
        this.pumpFailure = error;
        this.stopped = true;
        this.pending.length = 0;
        this.notificationFailure();
        throw error;
      })
      .finally(() => {
        this.pump = undefined;
      });
    this.pump.catch(() => undefined);
  }

  async drain(): Promise<void> {
    if (this.pumpFailure !== undefined) throw this.pumpFailure;
    while (this.pump) await this.pump;
    if (this.pumpFailure !== undefined) throw this.pumpFailure;
  }

  async replay(entries: readonly SessionEntry[]): Promise<void> {
    for (const entry of entries) {
      for (const update of replayEntry(entry)) this.enqueue(update);
    }
    try {
      await this.drain();
    } catch {
      throw adapterError("notification_error");
    }
  }

  async setConfig(configId: string, value: string | boolean) {
    if (this.busy) throw adapterError("session_busy");
    return applyConfig(this.pi, this.deps.modelRegistry, configId, value);
  }

  private disarm(turn: ActiveTurn): void {
    if (!turn.structured) return;
    try {
      this.structured.disarm(this.pi);
    } catch (error) {
      console.error("pi-acp structured-output disarm error:", error);
    }
  }

  private finish(turn: ActiveTurn, outcome: { response: PromptResponse } | { error: unknown }, keepBackstop = false): void {
    if (turn.completed) return;
    turn.completed = true;
    turn.removeRequestAbort?.();
    turn.removeRequestAbort = undefined;
    this.disarm(turn);
    if (!keepBackstop) turn.settledController.abort();
    if (this.activeTurn === turn) this.activeTurn = undefined;
    if ("response" in outcome) turn.resolve(outcome.response);
    else turn.reject(outcome.error);
    turn.resolveSettlement();
  }

  private notificationFailure(): void {
    const turn = this.activeTurn;
    if (!turn || turn.completed) return;
    turn.notificationFailed = true;
    this.abortTurn(turn);
    this.finish(turn, { error: adapterError("notification_error") }, true);
  }

  private abortTurn(turn: ActiveTurn): void {
    if (turn.completed) return;
    if (!turn.controller.signal.aborted) turn.controller.abort();
  }

  private turnError(turn: ActiveTurn, error: unknown): void {
    if (turn.completed) return;
    let terminal;
    try {
      terminal = terminalAssistant(agentMessages(this.pi).slice(turn.startMessageIndex));
    } catch {
      terminal = undefined;
    }
    this.finish(turn, { error: isRequestError(error) ? error : unexpectedError(error, terminal) });
  }

  private runTurnTask(turn: ActiveTurn, task: Promise<void>): void {
    void task.catch((error) => {
      if (turn.completed) console.error("pi-acp detached turn error:", error);
      else this.turnError(turn, error);
    });
  }

  private async cleanupWedged(): Promise<void> {
    try {
      await this.onWedged(this.sessionId, this);
    } catch (error) {
      console.error("pi-acp wedged-session cleanup error:", error);
    }
  }

  private startBackstop(turn: ActiveTurn): void {
    if (turn.backstopStarted) return;
    turn.backstopStarted = true;
    const backstop = this.deps.sleep(this.deps.graceMs, turn.settledController.signal).then(
      async () => {
        try {
          if (!turn.completed) {
            const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
            if (!this.pumpFailure) {
              this.enqueue(usageUpdate(this.pi));
              await this.drain();
            }
            if (!turn.completed) {
              this.finish(turn, {
                response: { stopReason: "cancelled", usage: promptUsage(messages) },
              });
            }
          }
        } catch (error) {
          if (this.pumpFailure !== undefined) {
            turn.notificationFailed = true;
            this.finish(turn, { error: adapterError("notification_error") }, true);
          } else {
            this.turnError(turn, error);
          }
        }
        if (turn.completed) await this.cleanupWedged();
      },
      async (error) => {
        if (turn.settledController.signal.aborted || turn.completed) return;
        this.turnError(turn, error);
        await this.cleanupWedged();
      },
    );
    this.runTurnTask(turn, backstop);
  }

  private async handlePiResolved(turn: ActiveTurn): Promise<void> {
    if (turn.completed) return;
    try {
      const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
      if (turn.structured) {
        const json = this.structured.takeJson();
        if (json !== undefined) {
          this.enqueue({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: json } });
        }
      }
      this.enqueue(usageUpdate(this.pi));
      await this.drain();
      if (turn.completed) return;
      const terminal = terminalAssistant(messages);
      const stopReason = stopReasonFor(terminal, turn.controller.signal.aborted);
      this.finish(turn, { response: { stopReason, usage: promptUsage(messages) } });
    } catch (error) {
      if (this.pumpFailure !== undefined) this.notificationFailure();
      else this.turnError(turn, error);
    }
  }

  private async handlePiRejected(turn: ActiveTurn, error: unknown): Promise<void> {
    if (turn.completed) return;
    if (!turn.controller.signal.aborted) {
      this.finish(turn, { error: classifyPreflight(error) });
      return;
    }
    try {
      const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
      this.enqueue(usageUpdate(this.pi));
      await this.drain();
      this.finish(turn, { response: { stopReason: "cancelled", usage: promptUsage(messages) } });
    } catch (settlementError) {
      if (this.pumpFailure !== undefined) this.notificationFailure();
      else this.turnError(turn, settlementError);
    }
  }

  async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
    if (this.busy) throw adapterError("session_busy");
    const converted = convertPromptContent(params.prompt);
    const schema = params._meta?.outputSchema;
    let text = converted.text;
    let structured = false;
    if (schema !== undefined) {
      let instruction: string;
      try {
        instruction = this.structured.arm(this.pi, schema);
      } catch (error) {
        if (isRequestError(error)) throw error;
        throw unexpectedError(error);
      }
      text = text ? `${instruction}\n\n${text}` : instruction;
      structured = true;
    }

    let startMessageIndex: number;
    try {
      startMessageIndex = agentMessages(this.pi).length;
    } catch (error) {
      if (structured) {
        try {
          this.structured.disarm(this.pi);
        } catch (disarmError) {
          console.error("pi-acp structured-output disarm error:", disarmError);
        }
      }
      throw unexpectedError(error);
    }

    let resolve!: (response: PromptResponse) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<PromptResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((res) => {
      resolveSettlement = res;
    });
    const turn: ActiveTurn = {
      controller: new AbortController(),
      settledController: new AbortController(),
      settlement,
      resolveSettlement,
      completed: false,
      notificationFailed: false,
      backstopStarted: false,
      resolve,
      reject,
      startMessageIndex,
      structured,
    };
    this.activeTurn = turn;
    turn.controller.signal.addEventListener("abort", () => {
      try {
        this.pi.agent.abort();
      } catch (error) {
        console.error("pi-acp abort error:", error);
      } finally {
        this.startBackstop(turn);
      }
    }, { once: true });
    const abortFromRequest = () => this.abortTurn(turn);
    if (requestSignal.aborted) abortFromRequest();
    else {
      requestSignal.addEventListener("abort", abortFromRequest, { once: true });
      turn.removeRequestAbort = () => requestSignal.removeEventListener("abort", abortFromRequest);
    }

    let piPromise: Promise<void>;
    try {
      piPromise = this.pi.prompt(text, { images: converted.images });
    } catch (error) {
      this.runTurnTask(turn, this.handlePiRejected(turn, error));
      return result;
    }
    void piPromise.then(
      () => this.runTurnTask(turn, this.handlePiResolved(turn)),
      (error) => this.runTurnTask(turn, this.handlePiRejected(turn, error)),
    );
    return result;
  }

  cancel(): void {
    if (this.activeTurn) this.abortTurn(this.activeTurn);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.closing = true;
    const turn = this.activeTurn;
    if (turn) {
      this.abortTurn(turn);
      await turn.settlement;
    }
    await this.disposeResources();
  }

  async disposeResources(): Promise<void> {
    if (this.disposed) return;
    this.closing = true;
    this.disposed = true;
    this.stopped = true;
    this.pending.length = 0;
    this.failedMcpResults.clear();
    try {
      this.unsubscribe?.();
    } catch (error) {
      console.error("pi-acp unsubscribe error:", error);
    }
    this.unsubscribe = undefined;
    try {
      await this.pi.dispose();
    } catch (error) {
      console.error("pi-acp session dispose error:", error);
    }
    try {
      await disposeMcpBridge(this.mcpClients, this.deps);
    } catch (error) {
      console.error("pi-acp MCP disposal error:", error);
    }
  }
}
