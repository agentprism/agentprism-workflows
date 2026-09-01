/**
 * Configuration constants for @automatalabs/workflow-engine.
 */

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;

/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 3;

/** Legacy project-relative directory for persisted workflow run state. New writes use workflowProjectPaths(). */
export const WORKFLOW_RUNS_DIR = ".agentprism/workflows/runs";

/** Legacy project-relative directory for saved workflow commands. New writes use workflowProjectPaths(). */
export const WORKFLOW_SAVED_DIR = ".agentprism/workflows/saved";

/** User-level model tiers config file, relative to the home directory. */
export const MODEL_TIERS_FILE = ".agentprism/workflows/model-tiers.json";

/**
 * Default named workflow subagent definitions directory, relative to a base dir.
 * Resolved both project-relative (cwd/<AGENTS_DIR>) and home-relative
 * (~/<AGENTS_DIR>); project entries win on name collision. Each `*.md` file is an
 * agent definition (frontmatter + body prompt). The engine no longer hardcodes the
 * agents directory; callers may override it via the engine's `agentsDir` option
 * (see WorkflowRunOptions.agentsDir).
 */
export const AGENTS_DIR = ".agentprism/agents";
