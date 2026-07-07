/**
 * Stable instrumentation names and attribute keys for the AgentPrism OTel bridge.
 * GenAI semantic-convention keys are pinned as string literals to avoid depending
 * on incubating semconv packages at runtime.
 */

import { createRequire } from "node:module";

/** Read the real package version so changeset bumps can never drift from the
 *  tracer/meter instrumentation version (src and dist sit one level below package.json). */
export const VERSION = ((): string => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
export const INSTRUMENTATION_NAME = "@automatalabs/agentprism-otel";

export const DEFAULT_CAPTURE_CONTENT = false;
export const DEFAULT_CONTENT_LIMIT = 8192;

export const SPAN_WORKFLOW = "workflow";
export const SPAN_INVOKE_AGENT_PREFIX = "invoke_agent";
export const SPAN_EXECUTE_TOOL_PREFIX = "execute_tool";

export const EVENT_PHASE = "phase";
export const EVENT_LOG = "log";
export const EVENT_TOOL_STATUS = "tool_status";

export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";

export const ATTR_RUN_ID = "agentprism.run_id";
export const ATTR_RESUMED = "agentprism.resumed";
export const ATTR_STATUS = "agentprism.status";
export const ATTR_AGENT_COUNT = "agentprism.agent_count";
export const ATTR_PAUSED = "agentprism.paused";
export const ATTR_PAUSE_REASON = "agentprism.pause_reason";
export const ATTR_STOPPED = "agentprism.stopped";
export const ATTR_DETACHED = "agentprism.detached";
export const ATTR_DANGLING = "agentprism.dangling";
export const ATTR_PHASE = "agentprism.phase";
export const ATTR_LAST_PHASE = "agentprism.last_phase";
export const ATTR_PROMPT = "agentprism.prompt";
export const ATTR_RESULT = "agentprism.result";
export const ATTR_TOKENS = "agentprism.tokens";
export const ATTR_WORKTREE = "agentprism.worktree";
export const ATTR_ERROR_CODE = "agentprism.error_code";
export const ATTR_RECOVERABLE = "agentprism.recoverable";
export const ATTR_TOOL_KIND = "agentprism.tool_kind";
export const ATTR_BACKEND_ID = "agentprism.backend_id";
export const ATTR_SESSION_ID = "agentprism.session_id";
export const ATTR_LABEL = "agentprism.label";
export const ATTR_TOOL_INPUT = "agentprism.tool_input";
export const ATTR_TOOL_OUTPUT = "agentprism.tool_output";
export const ATTR_TOOL_STATUS = "agentprism.tool_status";
export const ATTR_TOKEN_TYPE = "agentprism.token_type";
export const ATTR_LOG_MESSAGE = "log.message";

export const OPERATION_INVOKE_AGENT = "invoke_agent";
export const OPERATION_EXECUTE_TOOL = "execute_tool";

export const METRIC_TOKENS = "agentprism.tokens";
export const METRIC_COST = "agentprism.cost";
export const METRIC_AGENTS = "agentprism.agents";
export const METRIC_AGENT_DURATION = "agentprism.agent.duration";

export const UNIT_TOKENS = "{token}";
export const UNIT_USD = "usd";
export const UNIT_AGENT = "{agent}";
export const UNIT_SECONDS = "s";
