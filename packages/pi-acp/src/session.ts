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
import { shutdownPiSession } from "./pi-shutdown.js";
import { convertPromptContent, type ConvertedPrompt } from "./prompt-content.js";
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
import type { SteeringRequest, SteeringResponse } from "./steering.js";
import {
  LOADED_TURN_ENDED_METHOD,
  type LoadedTurnEndedNotification,
  type LoadedTurnStatus,
} from "./loaded-turn.js";
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
  resumeRefreshesOnSettlement?: true;
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
  private steerChain: Promise<void> = Promise.resolve();
  private configReserved = false;
  private cleanupDirty = false;
  private cleanupGeneration: CleanupGeneration | undefined;
  private resourceDisposePromise: Promise<void> | undefined;
  private bridgeClosePromise: Promise<void> | undefined;
  /** The `_session/loaded_turn` extension's watch flag: set when a
   *  `loadedTurnStatus()` query answered `running` (a client is waiting
   *  for that turn's authoritative end), cleared — and the
   *  `_session/loaded_turn/ended` notification sent — when the turn
   *  finishes for any reason (response outcome with its stop reason, or
   *  a failure with its error). */
  private loadedTurnReportedRunning = false;

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

  /**
   * The `_session/loaded_turn/query` answer — the authoritative
   * founding-turn terminal classification for a loaded session (see
   * `packages/pi-acp/src/loaded-turn.ts`):
   *
   * - `running` when a turn is executing in this process right now (the
   *   client then waits for the `_session/loaded_turn/ended` push — the
   *   watch flag is armed here so the turn's finish sends it),
   * - `completed` when the session journal's last message entry is an
   *   assistant message (pi persists every complete LLM message
   *   atomically at `message_end`, so a completed turn always leaves an
   *   assistant leaf and the replay's trailing assistant message is the
   *   turn's FINAL message — authoritative, never a quiet-gap guess),
   * - `interrupted` otherwise (the journal shows an interrupted or
   *   abandoned turn — no turn is running, so re-issue is safe).
   */
  loadedTurnStatus(): LoadedTurnStatus {
    const turn = this.activeTurn;
    if (turn !== undefined && !turn.completed && !this.closing) {
      this.loadedTurnReportedRunning = true;
      return "running";
    }
    const leaf = this.manager.getLeafEntry();
    if (
      leaf !== undefined &&
      leaf.type === "message" &&
      leaf.message.role === "assistant"
    ) {
      return "completed";
    }
    return "interrupted";
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
    if ("response" in outcome) turn.resolve(outcome.response);
    else turn.reject(outcome.error);
    turn.resolveSettlement();
    turn.releaseBoundary?.();
    turn.releaseBoundary = undefined;
    if (this.activeTurn === turn) this.activeTurn = undefined;
    // The `_session/loaded_turn` extension's authoritative end push: a
    // client that was told this turn was `running` at query time gets the
    // ended notification now — with the turn's stop reason (response
    // outcome) or its error (failure), never both. Best-effort: a
    // failing notification must not break the turn's settlement. The
    // push is ORDERED behind the turn's final update pump (review round
    // 6): the last deltas were only enqueued (the pump delivers them
    // asynchronously), and the re-attach seam settles with the
    // accumulated text at the terminal marker — a marker delivered
    // before the final chunk would durably settle PARTIAL text.
    if (this.loadedTurnReportedRunning) {
      this.loadedTurnReportedRunning = false;
      const notification: LoadedTurnEndedNotification = "response" in outcome
        ? { sessionId: this.sessionId, stopReason: outcome.response.stopReason }
        : { sessionId: this.sessionId, error: normalizeTurnError(outcome.error) };
      void this.drain()
        .catch(() => undefined)
        .then(() => this.client.notify(LOADED_TURN_ENDED_METHOD, notification))
        .catch(() => undefined);
    }
    const generation = this.cleanupGeneration;
    if (generation?.resumeRefreshesOnSettlement && generation.mode === "cancel-only") {
      this.cleanupGeneration = undefined;
      this.mcpBridge.resumeRefreshes();
    }
  }

  private notificationFailure(): void {
    const turn = this.activeTurn;
    if (!turn || turn.completed) return;
    turn.notificationFailed = true;
    this.abortTurn(turn);
    void turn.cleanup?.then(
      () => this.finish(turn, { error: adapterError("notification_error") }),
      (error) => this.finish(turn, { error }),
    );
  }

  private abortTurn(turn: ActiveTurn): void {
    if (turn.completed) return;
    turn.cleanup ??= this.cleanupTurn("cancel-only");
    turn.cleanup.catch((error) => {
      if (!turn.completed) this.turnError(turn, error);
      void this.cleanupWedged();
    });
  }

  private startDisposal(): void {
    this.closing = true;
    // The contract's disposal prefix is intentionally split: transport close
    // admission starts first, then incoming handlers observe session disposal,
    // and only then are refresh/turn signals aborted.
    this.mcpBridge.startDisposal();
    if (!this.lifecycleController.signal.aborted) {
      this.lifecycleController.abort(new Error("session disposed"));
    }
    this.mcpBridge.abortRefreshes();
    this.bridgeClosePromise ??= this.mcpBridge.close();
    this.bridgeClosePromise.catch(() => undefined);
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
    if (mode === "disposal") this.startDisposal();
    else this.mcpBridge.abortRefreshes();
    const turn = this.activeTurn;
    if (turn && !turn.controller.signal.aborted) turn.controller.abort();
    let clearQueuePi = Promise.resolve();
    try {
      this.pi.clearQueue();
    } catch (error) {
      clearQueuePi = Promise.reject(error);
    }
    clearQueuePi.catch(() => undefined);
    let abortPi: Promise<void>;
    try {
      abortPi = this.pi.abort();
    } catch (error) {
      abortPi = Promise.reject(error);
    }
    abortPi.catch(() => undefined);
    // Keep the established abort-before-child-drain failure precedence. Queue
    // clearing is invoked first, but its failure is considered only after both
    // pre-existing cleanup operations.
    const operations = Promise.allSettled([abortPi, captured.drain, clearQueuePi]);

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
          if (turn?.completed) {
            this.cleanupGeneration = undefined;
            this.mcpBridge.resumeRefreshes();
          } else {
            generation.resumeRefreshesOnSettlement = true;
          }
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
      this.discardOrphanedSteering();
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
        this.discardOrphanedSteering();
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
    return this.startTurn(convertPromptContent(params.prompt), { requestSignal });
  }

  /** Open the session's single turn slot and run one pi prompt through the full turn
   *  machinery (turn boundary, cancellation, settlement, usage). Admission is the caller's
   *  job: prompt() rejects while busy. Steering never calls this method. */
  private startTurn(
    converted: ConvertedPrompt,
    opts: { requestSignal?: AbortSignal },
  ): Promise<PromptResponse> {
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
    const requestSignal = opts.requestSignal;
    if (requestSignal) {
      const abortFromRequest = () => this.abortTurn(turn);
      if (requestSignal.aborted) abortFromRequest();
      else {
        requestSignal.addEventListener("abort", abortFromRequest, { once: true });
        turn.removeRequestAbort = () => requestSignal.removeEventListener("abort", abortFromRequest);
      }
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

  /** `_session/steering`: inject only into the live turn. Requests are serialized per
   *  session so concurrent steering calls cannot cross a turn boundary. */
  async steer(params: SteeringRequest): Promise<SteeringResponse> {
    const run = this.steerChain.then(() => this.performSteer(params));
    this.steerChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performSteer(params: SteeringRequest): Promise<SteeringResponse> {
    if (this.closing || this.disposed) throw adapterError("session_terminated");
    const turn = this.activeTurn;
    if (!turn || turn.completed || turn.controller.signal.aborted) {
      return { outcome: "promptRequired", reason: "noRunningTurn" };
    }

    const converted = convertPromptContent(params.prompt);
    // A committed-but-not-yet-streaming turn is steerable too: pi's run loop polls the
    // steering queue before its first LLM call, so the message joins the imminent turn.
    try {
      await this.pi.steer(converted.text, converted.images);
    } catch (error) {
      if (this.activeTurn !== turn || turn.completed || turn.controller.signal.aborted) {
        this.discardOrphanedSteering();
      }
      throw error;
    }
    if (this.activeTurn === turn && !turn.completed && !turn.controller.signal.aborted) {
      return { outcome: "injected" };
    }

    // The run settled (or cancellation won) underneath the native enqueue. Pi only polls
    // this queue from an active run, so leaving any residue would prepend hidden input to a
    // later session/prompt. Remove it and require the caller to issue an explicit prompt.
    this.discardOrphanedSteering();
    return { outcome: "promptRequired", reason: "noRunningTurn" };
  }

  /** Remove native Pi queue residue at a turn boundary. Nothing left by steering may be
   *  consumed by a later public prompt. Unexpected cleanup failures stay exceptional. */
  private discardOrphanedSteering(): void {
    if (this.pi.pendingMessageCount > 0) this.pi.clearQueue();
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
      await this.mcpBridge.drainRefreshes().catch((error) => {
        console.error("pi-acp MCP refresh drain error:", error);
      });
      const results = await Promise.allSettled([
        shutdownPiSession(this.pi),
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

/** Normalize a turn's failure into the loaded-turn ended notification's
 *  `{ name, message }` error shape (best-effort — the notification
 *  carries the turn's error verbatim-ish, never the whole stack). */
function normalizeTurnError(error: unknown): { name: string; message: string } {
  if (error !== null && typeof error === "object") {
    const candidate = error as { name?: unknown; message?: unknown };
    return {
      name: typeof candidate.name === "string" ? candidate.name : "Error",
      message:
        typeof candidate.message === "string"
          ? candidate.message
          : String(candidate.message ?? error),
    };
  }
  return { name: "Error", message: String(error) };
}
