// AcpAgentRunner — the AgentRunner seam implementation (the LEAF the engine injects against).
// One method, two backend strategies behind it. Per run():
//   1. pick the backend by model/tier (cross-provider routing = which ACP server to spawn)
//   2. ACQUIRE a pooled connection + session/new { cwd } (per-session cwd = worktree isolation;
//      the PROCESS is pool-managed and REUSED across runs — never spawned/killed per run)
//   3. select the model via session/set_config_option (onModelResolved / onModelFallback)
//   4. apply the schema per backend (Claude: at session/new; Codex: per-turn _meta)
//   5. prompt + drain; enforce the tool allow/deny policy via permission auto-responses
//   6. schema  -> native -> validate -> re-prompt ladder -> SCHEMA_NONCOMPLIANCE
//      no schema -> final assistant text (empty -> AGENT_EMPTY_OUTPUT, recoverable)
//      provider wall (thrown) -> PROVIDER_USAGE_LIMIT (non-recoverable, resetHint)
//      pooled process crash (thrown) -> recoverable AGENT_EXECUTION_ERROR (engine retries on a
//        fresh process; the dead connection is evicted from the pool)
//   7. usage -> onUsage on BOTH the success and error paths; honor opts.signal (-> session/cancel)
//   8. RELEASE the session (session/close) WITHOUT killing the process; return it to the pool
//
// Timeout and abort are the ENGINE's job: we honor opts.signal (wired to ACP session/cancel)
// and re-throw on abort, but never implement our own timeout.
import {
  WorkflowError,
  WorkflowErrorCode,
  type AgentResult,
  type AgentRunner,
  type PromptImage,
  type RunOptions,
} from "@automatalabs/shared-types";
import type { ContentBlock, StopReason } from "@agentclientprotocol/sdk";
import type { TSchema } from "typebox";
import type { SessionHandle } from "./acp-client.js";
import { AcpAgentPool, type AcpPoolOptions } from "./pool.js";
import {
  TypedEventEmitter,
  type AcpEventListener,
  type AcpEventName,
  type AcpEventSink,
  type AcpRunnerEventMap,
} from "./events.js";
import type { Backend } from "./backend.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { CustomAcpBackend } from "./backends/custom.js";
import {
  registryWithRunBackends,
  resolveBackendRegistry,
  type BackendRegistry,
  type CustomBackendConfig,
} from "./registry.js";
import { mapThrownError } from "./errors-map.js";
import { toJsonSchema } from "./schema-strict.js";
import type { PermissionResolver, ToolPolicy } from "./permissions.js";
import { resolveStructuredOutput, type StructuredSession } from "./structured-output.js";

type AnyRunOptions = RunOptions<TSchema | undefined>;

/** Constructor options for the runner: pool sizing, client-side handlers, and the custom-backend
 *  registry. `backends` merges over (and wins against) env-declared AGENTPRISM_BACKENDS entries. */
export interface AcpRunnerOptions extends AcpPoolOptions {
  /** Custom ACP backends, keyed by registered name (see registry.ts for the config shape
   *  and the routing rules). Names are case-insensitive; "claude"/"codex" are reserved. */
  backends?: Record<string, CustomBackendConfig>;
  /** Runner-wide human-in-the-loop permission resolver. When set, it replaces ToolPolicy
   *  auto-decisions for every session that does not provide its own resolver. */
  onPermissionRequest?: PermissionResolver;
}

export class AcpAgentRunner implements AgentRunner {
  private readonly pool: AcpAgentPool;
  /** The resolved custom-backend registry (env + option, validated at construction). */
  private readonly backends: BackendRegistry;
  /** Typed bus carrying every ACP event from every pooled session. Beyond the AgentRunner seam
   *  (additive observability) — subscribing never affects a run and never enters the resume hash. */
  private readonly events = new TypedEventEmitter<AcpRunnerEventMap>();
  private readonly emitEvent: AcpEventSink = (name, event) => this.events.emit(name, event);

  constructor(options: AcpRunnerOptions = {}) {
    this.pool = new AcpAgentPool(options, {
      onEvent: this.emitEvent,
      permissionResolver: options.onPermissionRequest,
    });
    this.backends = resolveBackendRegistry(options.backends);
  }

  /**
   * Listen in on the live ACP stream. `name` is an ACP `sessionUpdate` discriminant
   * ("agent_message_chunk", "tool_call", "usage_update", …) or one of the cross-cutting events
   * ("session_update" catch-all, "permission_request", "raw_message", "session_open",
   * "session_close", "backend_error"). The listener is typed to the event. Returns an unsubscribe
   * thunk. A pooled runner multiplexes many concurrent runs, so each event carries
   * `{ sessionId, backendId, label?, runId? }` for filtering. Listeners are best-effort observers:
   * a throwing listener is isolated and never affects the run.
   */
  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.events.on(name, listener);
  }

  /** Subscribe once; the listener auto-unsubscribes after its first delivery. */
  once<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.events.once(name, listener);
  }

  off<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): void {
    this.events.off(name, listener);
  }

  removeAllListeners(name?: AcpEventName): void {
    this.events.removeAllListeners(name);
  }

  listenerCount(name: AcpEventName): number {
    return this.events.listenerCount(name);
  }

  async run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options: RunOptions<S> = {},
  ): Promise<AgentResult<S>> {
    const opts = options as AnyRunOptions;
    const schema = opts.schema;
    // Layer any run-scoped backends (an APPROVED script-declared meta.backends) under the
    // host registry. Malformed/reserved entries fail the call loudly and are NOT retried —
    // re-running a misdeclared registry can never succeed.
    let registry: BackendRegistry;
    try {
      registry = registryWithRunBackends(this.backends, opts.backends);
    } catch (error) {
      throw new WorkflowError((error as Error).message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
        agentLabel: opts.label,
      });
    }
    const backend = selectBackend(opts, registry);
    const policy: ToolPolicy = { allow: opts.toolNames, deny: opts.disallowedToolNames };
    const cwd = opts.cwd ?? process.cwd();
    validatePromptImages(opts.images, opts.label);

    const session: SessionHandle = await this.pool.acquire(backend, {
      cwd,
      schema,
      policy,
      signal: opts.signal,
      mcpServers: opts.mcpServers,
      // Generic session-scoped _meta passthrough (RunOptions.meta) — merged UNDER the
      // backend-computed keys and the runId stamp in openSession. Additive; never hashed.
      meta: opts.meta,
      // Engine correlation id -> session/new _meta (META_KEYS.runId). Additive; never hashed.
      runId: opts.runId,
      // Stamped onto emitted ACP events as context (never sent on the wire).
      label: opts.label,
      // CODEX-ONLY session instruction overrides -> session/new _meta bare keys. Additive; never
      // hashed. The Claude backend ignores them.
      baseInstructions: opts.baseInstructions,
      developerInstructions: opts.developerInstructions,
    });
    try {
      opts.signal?.throwIfAborted();
      // For a CUSTOM backend chosen by its registered name, the name itself is routing, not a
      // model id: "browser" selects nothing; "browser/foo" selects "foo". Built-ins get the
      // full spec unchanged (their catalogs match provider-prefixed and bare ids).
      await applyModelSelection(session, innerModelSpec(opts.model ?? opts.tier, backend), opts);

      const text = buildPrompt(prompt, opts, schema, backend);
      const initialPrompt =
        opts.images && opts.images.length > 0 ? promptWithImages(text, opts.images) : text;
      // Generic turn-scoped _meta passthrough merged UNDER the backend-computed keys (e.g. the
      // outputSchema forward when a schema is set) — user meta never clobbers the schema channel.
      const promptMeta = mergeTurnMeta(opts.promptMeta, backend.promptMeta(schema));
      const response = await session.prompt(initialPrompt, promptMeta);
      opts.signal?.throwIfAborted();
      // Inspect the turn's stop reason BEFORE the text/schema path: a refusal or truncation
      // must surface distinctly here, never be misread as empty output or burned through the
      // schema-repair ladder into SCHEMA_NONCOMPLIANCE.
      assertNormalStopReason(response.stopReason, opts.label);

      if (schema) {
        const structuredSession: StructuredSession = {
          prompt: async (repromptText: string) => {
            const repromptResponse = await session.prompt(repromptText, promptMeta);
            // A repair turn that refuses / truncates / cancels must also surface distinctly
            // instead of silently continuing the ladder.
            assertNormalStopReason(repromptResponse.stopReason, opts.label);
          },
          lastText: () => session.currentTurnText(),
          tryNative: () => backend.nativeStructured(session),
        };
        const result = await resolveStructuredOutput(structuredSession, schema, {
          maxSchemaRetries: opts.maxSchemaRetries,
          signal: opts.signal,
          label: opts.label,
        });
        return result as AgentResult<S>;
      }

      const finalText = session.currentTurnText().trim();
      if (!finalText) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: opts.label,
        });
      }
      return finalText as unknown as AgentResult<S>;
    } catch (error) {
      // Abort is the engine's concern (throwIfAborted before/after the call) — re-throw it raw.
      if (opts.signal?.aborted) throw error;
      throw mapThrownError(error, opts.label);
    } finally {
      // Read real usage on BOTH success and error so partial usage is never lost.
      try {
        opts.onUsage?.(session.usage.toAgentUsage());
      } catch {
        // usage is best-effort; never let it mask the real result/error.
      }
      try {
        opts.onHistory?.(session.history);
      } catch {
        // history is diagnostic only.
      }
      // Release the SESSION (best-effort session/close) WITHOUT killing the pooled process.
      try {
        await session.release();
      } catch {
        // release is best-effort (session already untracked); never mask the real result/error.
      }
    }
  }

  /** Tear down the whole pool (close every long-lived process). Call when the run ends / the
   *  runner is disposed. Beyond the AgentRunner seam (additive) — never enters the resume hash. */
  async dispose(): Promise<void> {
    await this.pool.dispose();
    this.events.removeAllListeners();
  }
}

/** Factory the mcp-server composition root calls to inject the runner into the engine. The pool
 *  size and the custom-backend registry are runner-level options — NOT RunOptions fields, so they
 *  never enter hashAgentCall / the resume identity. Env fallbacks: AGENTPRISM_ACP_POOL_SIZE for
 *  size, AGENTPRISM_BACKENDS (JSON) for backends. */
export function createAcpRunner(options?: AcpRunnerOptions): AcpAgentRunner {
  return new AcpAgentRunner(options);
}

/**
 * Map a PromptResponse.stopReason onto the seam's error contract. `end_turn` (and any
 * unknown future reason) is a normal completion — fall through to the text/schema path.
 * The abnormal reasons each get a DISTINCT, non-recoverable failure so the engine never
 * retries a refused/truncated prompt (burning the retry budget) and never mistakes it for
 * recoverable empty output:
 *   - refusal             -> AGENT_EXECUTION_ERROR "model refused to respond"
 *   - max_tokens / max_turn_requests -> AGENT_EXECUTION_ERROR "output truncated"
 *   - cancelled           -> WORKFLOW_ABORTED
 */
function assertNormalStopReason(stopReason: StopReason, label?: string): void {
  switch (stopReason) {
    case "refusal":
      throw new WorkflowError("model refused to respond", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
        recoverable: false,
        agentLabel: label,
      });
    case "max_tokens":
    case "max_turn_requests":
      throw new WorkflowError(
        `output truncated (stop reason: ${stopReason})`,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    case "cancelled":
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
        recoverable: false,
        agentLabel: label,
      });
    default:
      // "end_turn" and any unrecognized future reason: normal completion.
      return;
  }
}

async function applyModelSelection(
  session: SessionHandle,
  spec: string | undefined,
  opts: AnyRunOptions,
): Promise<void> {
  // `spec` is opts.model ?? opts.tier (`model` wins — frozen contract), with a custom
  // backend's routing name already stripped by innerModelSpec.
  if (!spec) return;
  const { matched, resolved, modifierFallbacks } = await session.selectModel(spec);
  if (matched) opts.onModelResolved?.(resolved ?? spec);
  else opts.onModelFallback?.(spec);
  // Symmetric to model fallback: a requested reasoning_effort / Fast-mode value the catalog
  // does not advertise is a silent no-op in the session. Surface it on the SAME channel so
  // incorrect tiering is observable (best-effort — reported, never thrown).
  for (const fallback of modifierFallbacks ?? []) opts.onModelFallback?.(fallback);
}

function buildPrompt(
  prompt: string,
  opts: AnyRunOptions,
  schema: TSchema | undefined,
  backend: Backend,
): string {
  const parts: string[] = [];
  if (opts.instructions) parts.push(opts.instructions);
  if (opts.label) parts.push(`Task label: ${opts.label}`);
  parts.push(prompt);
  if (schema) {
    const contract = [
      "Final output contract:",
      "- Your FINAL message MUST be a single JSON object that conforms to the required output schema.",
      "- Output ONLY that JSON object — no prose, no explanation, and no markdown code fences.",
      "- If you need to inspect files or run commands first, do so, then emit the JSON object as your final message.",
    ];
    if (backend.embedSchemaInPrompt) {
      // The agent behind a custom backend may ignore the `_meta.outputSchema` forward, so the
      // schema must be STATED, not just wired — otherwise the model invents its own keys and
      // the repair ladder can never converge. Built-ins skip this: their native constraint
      // channel is authoritative.
      contract.push(`- The required output schema (JSON Schema):\n${JSON.stringify(toJsonSchema(schema))}`);
    }
    parts.push(contract.join("\n"));
  }
  return parts.join("\n\n");
}

function validatePromptImages(images: readonly PromptImage[] | undefined, label?: string): void {
  if (!images || images.length === 0) return;
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i] as PromptImage | undefined;
    if (typeof image?.data !== "string" || image.data.trim() === "") {
      throw new WorkflowError(
        `images[${i}].data must be a non-empty string`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    }
    if (typeof image.mimeType !== "string" || image.mimeType.trim() === "") {
      throw new WorkflowError(
        `images[${i}].mimeType must be a non-empty string`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    }
    if (image.uri !== undefined && (typeof image.uri !== "string" || image.uri.trim() === "")) {
      throw new WorkflowError(
        `images[${i}].uri must be a non-empty string when present`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    }
  }
}

function promptWithImages(text: string, images: readonly PromptImage[]): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text }];
  for (const image of images) {
    blocks.push(
      image.uri === undefined
        ? { type: "image", data: image.data, mimeType: image.mimeType }
        : { type: "image", data: image.data, mimeType: image.mimeType, uri: image.uri },
    );
  }
  return blocks;
}

/** Pick the backend by model/tier. Cross-provider routing = which ACP server to spawn.
 *  Registered CUSTOM names resolve FIRST (exact name, or `name/<inner-model>` prefix) so a
 *  registry entry is never shadowed by the built-in heuristics; then the claude/codex
 *  heuristics; then the default backend (AGENTPRISM_DEFAULT_BACKEND — which may itself name
 *  a registered custom backend). */
export function selectBackend(opts: { model?: string; tier?: string }, registry?: BackendRegistry): Backend {
  const custom = customBackendForSpec(opts.model, registry) ?? customBackendForSpec(opts.tier, registry);
  if (custom) return custom;
  const id = backendIdForSpec(opts.model) ?? backendIdForSpec(opts.tier) ?? defaultBackendId(registry);
  if (typeof id !== "string") return id; // the default resolved to a registered custom backend
  return id === "codex" ? new CodexBackend() : new ClaudeBackend();
}

/** Match a model/tier spec against the registry: the whole spec, or its `<name>/` prefix. */
function customBackendForSpec(spec: string | undefined, registry?: BackendRegistry): Backend | undefined {
  if (!spec || !registry || registry.size === 0) return undefined;
  const lower = spec.toLowerCase();
  const slash = lower.indexOf("/");
  const name = slash > 0 ? lower.slice(0, slash) : lower;
  const config = registry.get(name);
  return config ? new CustomAcpBackend(config) : undefined;
}

/** Strip a custom backend's routing name off the model/tier spec: the spec `"name"` selects no
 *  inner model; `"name/foo"` selects `"foo"`. Built-in backends receive the spec unchanged, and
 *  a spec that reached a custom DEFAULT backend without naming it also passes through (the
 *  agent's own catalog may know it). */
function innerModelSpec(spec: string | undefined, backend: Backend): string | undefined {
  if (!spec || !(backend instanceof CustomAcpBackend)) return spec;
  const lower = spec.toLowerCase();
  if (lower === backend.id) return undefined;
  if (lower.startsWith(`${backend.id}/`)) return spec.slice(backend.id.length + 1) || undefined;
  return spec;
}

/** Merge the generic turn-scoped meta passthrough UNDER the backend-computed turn meta. */
function mergeTurnMeta(
  user: Record<string, unknown> | undefined,
  backend: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!user) return backend;
  return { ...user, ...(backend ?? {}) };
}

function backendIdForSpec(spec: string | undefined): "claude" | "codex" | undefined {
  if (!spec) return undefined;
  const lower = spec.toLowerCase();
  const slash = lower.indexOf("/");
  const provider = slash > 0 ? lower.slice(0, slash) : "";
  if (provider === "openai" || provider === "codex") return "codex";
  if (provider === "anthropic" || provider === "claude") return "claude";

  const id = slash > 0 ? lower.slice(slash + 1) : lower;
  if (/codex|gpt|openai|\bo\d/.test(id)) return "codex";
  if (/claude|opus|sonnet|haiku|anthropic/.test(id)) return "claude";
  return undefined;
}

/** Resolve the default backend: a registered custom name wins (returned as a Backend), else
 *  the built-in id. An unknown/unset value falls back to "claude" (the historical default). */
function defaultBackendId(registry?: BackendRegistry): "claude" | "codex" | Backend {
  const name = process.env.AGENTPRISM_DEFAULT_BACKEND?.toLowerCase();
  if (name && registry) {
    const config = registry.get(name);
    if (config) return new CustomAcpBackend(config);
  }
  return name === "codex" ? "codex" : "claude";
}
