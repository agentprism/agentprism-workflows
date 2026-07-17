import {
  methods,
  type AgentContext,
  type PromptRequest,
  type PromptResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { adapterError, classifyPreflight, isRequestError, unexpectedError } from "./errors.js";
import type { PiAcpDeps } from "./deps.js";
import { applyConfig, modelOption, thinkingLevelOption } from "./config.js";
import { convertPromptContent } from "./prompt-content.js";
import { replayEntry } from "./replay.js";
import { stopReasonFor } from "./stop-reason.js";
import { translateEvent } from "./translate.js";
import {
  agentMessages,
  promptUsage,
  terminalAssistant,
  usageUpdate,
} from "./usage.js";
import { installPermissionWrapper } from "./permissions.js";
import type { McpBridge, McpResultProjection } from "./mcp-bridge.js";
import { ChildCleanupFailure, type ChildProcessRegistrySlot } from "./child-process-registry.js";

interface ActiveTurn {
  controller: AbortController;
  settlement: Promise<void>;
  resolveSettlement: () => void;
  completed: boolean;
  diagnosticOpen: boolean;
  errorSettlementStarted: boolean;
  notificationFailed: boolean;
  resolve: (response: PromptResponse) => void;
  reject: (error: unknown) => void;
  startMessageIndex: number;
  cleanup?: Promise<void>;
  removeRequestAbort?: () => void;
  releaseBoundary?: () => void;
}

interface CleanupGeneration {
  mode: "cancel-only" | "disposal";
  status: "pending" | "succeeded" | "failed";
  promise: Promise<void>;
  error?: unknown;
  deadlineController: AbortController;
  timerController: AbortController;
}

export interface PiSessionOptions {
  sessionId: string;
  session: AgentSession;
  manager: SessionManager;
  client: AgentContext;
  deps: PiAcpDeps;
  mcpBridge: McpBridge;
  failedMcpResults: Map<string, McpResultProjection>;
  availableModels: readonly Model<Api>[];
  childRegistry: ChildProcessRegistrySlot;
  lifecycleController: AbortController;
  onWedged(sessionId: string, session: PiSession, cleanupRetryRequired: boolean): Promise<void>;
}

export class PiSession {
  readonly sessionId: string;
  readonly pi: AgentSession;
  readonly manager: SessionManager;
  private readonly client: AgentContext;
  private readonly deps: PiAcpDeps;
  private readonly mcpBridge: McpBridge;
  private readonly failedMcpResults: Map<string, McpResultProjection>;
  private availableModels: readonly Model<Api>[];
  private readonly childRegistry: ChildProcessRegistrySlot;
  private readonly lifecycleController: AbortController;
  private readonly onWedged: PiSessionOptions["onWedged"];
  private readonly pending: SessionUpdate[] = [];
  private pump: Promise<void> | undefined;
  private pumpFailure: unknown;
  private stopped = false;
  private closing = false;
  private disposed = false;
  private unsubscribe: (() => void) | undefined;
  private activeTurn: ActiveTurn | undefined;
  private configReserved = false;
  private cleanupDirty = false;
  private cleanupGeneration: CleanupGeneration | undefined;
  private resourceDisposePromise: Promise<void> | undefined;
  private bridgeClosePromise: Promise<void> | undefined;

  constructor(options: PiSessionOptions) {
    this.sessionId = options.sessionId;
    this.pi = options.session;
    this.manager = options.manager;
    this.client = options.client;
    this.deps = options.deps;
    this.mcpBridge = options.mcpBridge;
    this.failedMcpResults = options.failedMcpResults;
    this.availableModels = options.availableModels;
    this.childRegistry = options.childRegistry;
    this.lifecycleController = options.lifecycleController;
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
    return this.activeTurn !== undefined || this.configReserved || this.closing;
  }

  configOptions() {
    return [thinkingLevelOption(this.pi), modelOption(this.pi, this.availableModels)];
  }

  publishAvailableModels(models: readonly Model<Api>[]): void {
    this.availableModels = [...models];
  }

  activeTurnSignal(): AbortSignal | undefined { return this.activeTurn?.controller.signal; }

  emitMcpDiagnostic(text: string): void {
    if (this.disposed) return;
    if (this.activeTurn && !this.activeTurn.completed && this.activeTurn.diagnosticOpen) {
      this.enqueue({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
    } else {
      console.error(text);
    }
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
    // Reserve synchronously before the corrective catalog refresh.  Prompt,
    // config, fork, and refresh commit all share the same admission boundary.
    this.configReserved = true;
    let release: (() => void) | undefined;
    try {
      release = await this.mcpBridge.acquireTurnBoundary();
      if (this.closing) throw adapterError("session_busy");
      const result = await applyConfig(this.pi, this.deps.modelRuntime, this.availableModels, configId, value);
      this.availableModels = result.availableModels;
      return result.configOptions;
    } finally {
      release?.();
      this.configReserved = false;
    }
  }

  private finish(turn: ActiveTurn, outcome: { response: PromptResponse } | { error: unknown }): void {
    if (turn.completed) return;
    turn.diagnosticOpen = false;
    turn.completed = true;
    turn.removeRequestAbort?.();
    turn.removeRequestAbort = undefined;
    turn.releaseBoundary?.();
    turn.releaseBoundary = undefined;
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
    void turn.cleanup?.then(
      () => this.finish(turn, { error: adapterError("notification_error") }),
      () => undefined,
    );
  }

  private abortTurn(turn: ActiveTurn): void {
    if (turn.completed) return;
    turn.cleanup ??= this.cleanupTurn("cancel-only");
    if (!turn.controller.signal.aborted) turn.controller.abort();
    turn.cleanup.catch((error) => {
      if (!turn.completed) this.turnError(turn, error);
      void this.cleanupWedged();
    });
  }

  private startDisposal(): void {
    this.closing = true;
    // Client.close() reaches the close-signalling transport synchronously.
    // Start every logical close before lifetime abort so incoming MCP handlers
    // take the protocol-owned no-response path.
    this.bridgeClosePromise ??= this.mcpBridge.close();
    this.bridgeClosePromise.catch(() => undefined);
    if (!this.lifecycleController.signal.aborted) {
      this.lifecycleController.abort(new Error("session disposed"));
    }
  }

  private cleanupTurn(mode: CleanupGeneration["mode"]): Promise<void> {
    const current = this.cleanupGeneration;
    if (current?.status === "pending") {
      if (mode === "disposal" && current.mode === "cancel-only") {
        current.mode = "disposal";
        this.startDisposal();
      }
      return current.promise;
    }
    if (current?.status === "succeeded" && current.mode === "disposal") {
      return current.promise;
    }

    if (mode === "disposal") this.startDisposal();
    const deadlineController = new AbortController();
    const timerController = new AbortController();
    const generation: CleanupGeneration = {
      mode,
      status: "pending",
      promise: Promise.resolve(),
      deadlineController,
      timerController,
    };
    this.cleanupGeneration = generation;

    const expiry = this.deps.sleep(this.deps.graceMs, timerController.signal).then(() => {
      const failure = new ChildCleanupFailure(this.childRegistry.remainingChildren);
      deadlineController.abort(failure);
      throw failure;
    });
    expiry.catch(() => undefined);

    // Closing the captured epoch is the synchronous admission barrier.  It
    // must precede Pi abort, because abort can yield while a bash spawn is
    // between its filesystem check and lease acquisition.
    const captured = this.childRegistry.closeEpoch(deadlineController.signal);
    captured.drain.catch(() => undefined);
    let abortPi: Promise<void>;
    try {
      abortPi = this.pi.abort();
    } catch (error) {
      abortPi = Promise.reject(error);
    }
    abortPi.catch(() => undefined);
    const operations = Promise.allSettled([abortPi, captured.drain]);

    generation.promise = new Promise<void>((resolve, reject) => {
      let claimed = false;
      const fail = (error: unknown) => {
        if (claimed) return;
        claimed = true;
        generation.status = "failed";
        this.cleanupDirty = true;
        generation.mode = "disposal";
        this.startDisposal();
        const remaining = error instanceof ChildCleanupFailure
          ? error.remainingChildren
          : this.childRegistry.remainingChildren;
        generation.error = adapterError("child_cleanup_error", { details: { remainingChildren: remaining } });
        timerController.abort();
        reject(generation.error);
      };
      expiry.then(
        () => undefined,
        (error) => {
          if (timerController.signal.aborted && !deadlineController.signal.aborted) return;
          fail(error);
        },
      );
      operations.then((results) => {
        if (claimed) return;
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) {
          fail(failure.reason);
          return;
        }
        claimed = true;
        generation.status = "succeeded";
        this.cleanupDirty = false;
        timerController.abort();
        if (generation.mode === "cancel-only" && this.cleanupGeneration === generation) {
          this.childRegistry.commitRotation(captured.epoch);
          this.cleanupGeneration = undefined;
        }
        resolve();
      });
    });
    generation.promise.catch(() => undefined);
    return generation.promise;
  }

  private turnError(turn: ActiveTurn, error: unknown): void {
    if (turn.completed || turn.errorSettlementStarted) return;
    turn.errorSettlementStarted = true;
    turn.diagnosticOpen = false;
    let terminal;
    try {
      terminal = terminalAssistant(agentMessages(this.pi).slice(turn.startMessageIndex));
    } catch {
      terminal = undefined;
    }
    const mapped = isRequestError(error) ? error : unexpectedError(error, terminal);
    void this.drain().then(
      () => this.finish(turn, { error: mapped }),
      () => this.notificationFailure(),
    );
  }

  private runTurnTask(turn: ActiveTurn, task: Promise<void>): void {
    void task.catch((error) => {
      if (turn.completed) console.error("pi-acp detached turn error:", error);
      else this.turnError(turn, error);
    });
  }

  private async cleanupWedged(): Promise<void> {
    try {
      await this.onWedged(this.sessionId, this, true);
    } catch (error) {
      console.error("pi-acp wedged-session cleanup error:", error);
    }
  }

  private async handlePiResolved(turn: ActiveTurn): Promise<void> {
    if (turn.completed) return;
    try {
      if (this.childRegistry.childCleanupFailed) turn.cleanup ??= this.cleanupTurn("disposal");
      const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
      if (turn.cleanup) await turn.cleanup;
      turn.diagnosticOpen = false;
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
      turn.diagnosticOpen = false;
      try {
        await this.drain();
        this.finish(turn, { error: classifyPreflight(error) });
      } catch {
        this.notificationFailure();
      }
      return;
    }
    try {
      if (turn.cleanup) await turn.cleanup;
      const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
      turn.diagnosticOpen = false;
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
    const text = converted.text;

    let startMessageIndex: number;
    try {
      startMessageIndex = agentMessages(this.pi).length;
    } catch (error) {
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
      settlement,
      resolveSettlement,
      completed: false,
      diagnosticOpen: true,
      errorSettlementStarted: false,
      notificationFailed: false,
      resolve,
      reject,
      startMessageIndex,
    };
    this.activeTurn = turn;
    const abortFromRequest = () => this.abortTurn(turn);
    if (requestSignal.aborted) abortFromRequest();
    else {
      requestSignal.addEventListener("abort", abortFromRequest, { once: true });
      turn.removeRequestAbort = () => requestSignal.removeEventListener("abort", abortFromRequest);
    }

    this.runTurnTask(turn, (async () => {
      turn.releaseBoundary = await this.mcpBridge.acquireTurnBoundary();
      if (turn.controller.signal.aborted) {
        try {
          if (turn.cleanup) await turn.cleanup;
          turn.diagnosticOpen = false;
          this.enqueue(usageUpdate(this.pi));
          await this.drain();
          this.finish(turn, {
            response: {
              stopReason: "cancelled",
              usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 },
            },
          });
        } catch (error) {
          this.turnError(turn, error);
        }
        return;
      }
      let piPromise: Promise<void>;
      try {
        piPromise = this.pi.prompt(text, { images: converted.images });
      } catch (error) {
        await this.handlePiRejected(turn, error);
        return;
      }
      await piPromise.then(
        () => this.handlePiResolved(turn),
        (error) => this.handlePiRejected(turn, error),
      );
    })());
    return result;
  }

  cancel(): void {
    if (this.activeTurn) this.abortTurn(this.activeTurn);
  }

  childCleanupFailure(): void {
    const turn = this.activeTurn;
    if (turn && !turn.completed) {
      this.abortTurn(turn);
      return;
    }
    void this.cleanupWedged();
  }

  async dispose(): Promise<void> {
    if (this.disposed && !this.cleanupDirty && this.childRegistry.remainingChildren === 0 && !this.childRegistry.childCleanupFailed) return;
    const cleanup = this.cleanupTurn("disposal");
    const turn = this.activeTurn;
    let cleanupError: unknown;
    if (turn) {
      this.abortTurn(turn);
      await turn.settlement;
      try { await cleanup; } catch (error) { cleanupError = error; }
    } else {
      try { await cleanup; } catch (error) { cleanupError = error; }
    }
    await this.disposeResources();
    if (cleanupError) throw cleanupError;
  }

  async disposeAfterCleanupFailure(): Promise<void> {
    this.startDisposal();
    await this.disposeResources();
  }

  get remainingChildren(): number { return this.childRegistry.remainingChildren; }

  get cleanupRetryRequired(): boolean {
    return this.cleanupDirty || this.childRegistry.remainingChildren > 0 || this.childRegistry.childCleanupFailed;
  }

  async disposeResources(): Promise<void> {
    this.resourceDisposePromise ??= (async () => {
      if (this.disposed) return;
      this.closing = true;
      this.lifecycleController.abort(new Error("session disposed"));
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
      this.startDisposal();
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.pi.dispose()),
        this.bridgeClosePromise ?? Promise.resolve(),
      ]);
      if (results[0]?.status === "rejected") {
        console.error("pi-acp session dispose error:", results[0].reason);
      }
      if (results[1]?.status === "rejected") {
        console.error("pi-acp MCP disposal error:", results[1].reason);
      }
    })();
    return this.resourceDisposePromise;
  }

  poison(): void {
    if (this.closing || this.disposed) return;
    this.closing = true;
    void this.onWedged(this.sessionId, this, false).catch((error) => {
      console.error("pi-acp poisoned-session cleanup error:", error);
    });
  }
}
