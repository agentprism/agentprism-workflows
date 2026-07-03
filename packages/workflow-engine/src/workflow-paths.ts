/**
 * Filesystem layout for workflow-engine run state.
 *
 * New writes live under the user's workflow home so projects do not get
 * scattered `.agentprism/workflows` directories. Project-scoped state is still
 * isolated by a stable cwd-derived namespace.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { WORKFLOW_RUNS_DIR, WORKFLOW_SAVED_DIR } from "./config.js";

export const WORKFLOW_HOME_RELATIVE_DIR = ".agentprism/workflows";
export const WORKFLOW_PROJECTS_SUBDIR = "projects";
export const AGENTPRISM_PERSISTENCE_ROOT_ENV = "AGENTPRISM_PERSISTENCE_ROOT";

export interface WorkflowPathOptions {
  /**
   * Absolute workflow persistence root. When omitted, AGENTPRISM_PERSISTENCE_ROOT
   * wins over the historical homedir default (`~/.agentprism/workflows`).
   */
  persistenceRoot?: string;
  /** Injectable env map for tests; production callers use process.env. */
  env?: Record<string, string | undefined>;
}

export interface WorkflowProjectPaths {
  key: string;
  rootDir: string;
  runsDir: string;
  savedDir: string;
  settingsPath: string;
  legacyRunsDir: string;
  legacySavedDir: string;
}

export function workflowHomeDir(options: WorkflowPathOptions = {}): string {
  return resolveWorkflowHomeDir(options);
}

export function workflowUserSavedDir(options: WorkflowPathOptions = {}): string {
  return join(workflowHomeDir(options), "saved");
}

export function workflowProjectKey(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = sanitizePathSegment(basename(projectPath) || "project");
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

export function workflowProjectPaths(cwd: string, options: WorkflowPathOptions = {}): WorkflowProjectPaths {
  const key = workflowProjectKey(cwd);
  const rootDir = join(workflowHomeDir(options), WORKFLOW_PROJECTS_SUBDIR, key);
  return {
    key,
    rootDir,
    runsDir: join(rootDir, "runs"),
    savedDir: join(rootDir, "saved"),
    settingsPath: join(rootDir, "settings.json"),
    legacyRunsDir: resolve(cwd, WORKFLOW_RUNS_DIR),
    legacySavedDir: resolve(cwd, WORKFLOW_SAVED_DIR),
  };
}

function resolveWorkflowHomeDir(options: WorkflowPathOptions): string {
  // Precedence is explicit option > env fallback > historical homedir default.
  if (options.persistenceRoot !== undefined) return validatePersistenceRoot(options.persistenceRoot, "persistenceRoot");

  const envRoot = (options.env ?? process.env)[AGENTPRISM_PERSISTENCE_ROOT_ENV];
  if (envRoot !== undefined && envRoot.trim() !== "") {
    return validatePersistenceRoot(envRoot, AGENTPRISM_PERSISTENCE_ROOT_ENV);
  }

  return join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
}

function validatePersistenceRoot(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "project";
}
