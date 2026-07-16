import {
  methods,
  type AgentContext,
  type PromptRequest,
  type PromptResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { adapterError, classifyPreflight, unexpectedError } from "./errors.js";
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
import { disposeMcpBridge, type McpClientHandle } from "./mcp-bridge.js";

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
}

export interface PiSessionOptions {
  sessionId: string;
  session: AgentSession;
  manager: SessionManager;
  client: AgentContext;
  deps: PiAcpDeps;
  mcpClients: McpClientHandle[];
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
  private readonly structured: StructuredOutputState;
  private readonly onWedged: PiSessionOptions["onWedged"];
  private readonly pending: SessionUpdate[] = [];
  private pump: Promise<void> | undefined;
  private pumpFailure: unknown;
  private stopped = false;
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
    this.structured = options.structured;
    this.onWedged = options.onWedged;
    this.unsubscribe = this.pi.subscribe((event) => {
      for (const update of translateEvent(event)) this.enqueue(update);
    });
    installPermissionWrapper(this.pi, {
      sessionId: this.sessionId,
      client: this.client,
      drain: () => this.drain(),
      turnSignal: () => this.activeTurn?.controller.signal,
    });
  }

  get busy(): boolean {
    return this.activeTurn !== undefined;
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
    if (!turn.controller.signal.aborted) turn.controller.abort();
    try {
      this.pi.agent.abort();
    } catch (error) {
      console.error("pi-acp abort error:", error);
    }
    this.startBackstop(turn);
  }

  private startBackstop(turn: ActiveTurn): void {
    if (turn.backstopStarted) return;
    turn.backstopStarted = true;
    this.deps.sleep(this.deps.graceMs, turn.settledController.signal).then(
      async () => {
        if (!turn.completed) {
          const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
          if (!this.pumpFailure) {
            this.enqueue(usageUpdate(this.pi));
            try {
              await this.drain();
            } catch {
              turn.notificationFailed = true;
              this.finish(turn, { error: adapterError("notification_error") }, true);
            }
          }
          if (!turn.completed) {
            this.finish(turn, {
              response: { stopReason: "cancelled", usage: promptUsage(messages) },
            });
          }
        }
        if (turn.notificationFailed || turn.completed) {
          await this.onWedged(this.sessionId, this);
        }
      },
      () => undefined,
    );
  }

  async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
    if (this.busy) throw adapterError("session_busy");
    const converted = convertPromptContent(params.prompt);
    const schema = params._meta?.outputSchema;
    let text = converted.text;
    let structured = false;
    if (schema !== undefined) {
      const instruction = this.structured.arm(this.pi, schema);
      text = text ? `${instruction}\n\n${text}` : instruction;
      structured = true;
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
      startMessageIndex: agentMessages(this.pi).length,
      structured,
    };
    this.activeTurn = turn;
    const abortFromRequest = () => this.abortTurn(turn);
    if (requestSignal.aborted) abortFromRequest();
    else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
    turn.controller.signal.addEventListener("abort", () => {
      try {
        this.pi.agent.abort();
      } finally {
        this.startBackstop(turn);
      }
    }, { once: true });

    const piPromise = this.pi.prompt(text, { images: converted.images });
    piPromise.then(
      async () => {
        if (turn.completed) return;
        const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
        if (turn.structured) {
          const json = this.structured.takeJson();
          if (json !== undefined) {
            this.enqueue({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: json } });
          }
        }
        this.enqueue(usageUpdate(this.pi));
        try {
          await this.drain();
        } catch {
          this.notificationFailure();
          return;
        }
        if (turn.completed) return;
        try {
          const terminal = terminalAssistant(messages);
          const stopReason = stopReasonFor(terminal, turn.controller.signal.aborted);
          this.finish(turn, { response: { stopReason, usage: promptUsage(messages) } });
        } catch (error) {
          this.finish(turn, { error });
        }
      },
      (error) => {
        if (turn.completed) return;
        if (turn.controller.signal.aborted) {
          const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
          this.enqueue(usageUpdate(this.pi));
          this.drain().then(
            () => this.finish(turn, { response: { stopReason: "cancelled", usage: promptUsage(messages) } }),
            () => this.notificationFailure(),
          );
          return;
        }
        this.finish(turn, { error: classifyPreflight(error) });
      },
    );
    piPromise.then(() => undefined, () => undefined);
    return result;
  }

  cancel(): void {
    if (this.activeTurn) this.abortTurn(this.activeTurn);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    const turn = this.activeTurn;
    if (turn) {
      this.abortTurn(turn);
      await turn.settlement;
    }
    await this.disposeResources();
  }

  async disposeResources(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    this.pending.length = 0;
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
