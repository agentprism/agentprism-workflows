/**
 * openWorkflowDir — a read-only VIEW over one or more directories of workflow-script
 * files, for integrators who keep versioned folders of workflows and don't want to
 * hand-roll readFileSync plumbing or a `loadSavedWorkflow` resolver.
 *
 * Construction does NO I/O — no directory is created, nothing is scanned or cached.
 * Every method reads the filesystem at call time, so a long-lived view always reflects
 * the current working tree (these folders are typically git-versioned; a cached scan
 * would serve stale scripts after a checkout/pull/save). Directories that don't exist
 * simply contribute nothing — a normal state for an optional shared/user tier.
 *
 * Name convention: the filename stem is the workflow name (`review-pr.workflow.js` or
 * `review-pr.js` => "review-pr"), mirroring the agentType registry's
 * `.agentprism/agents/<name>.md`. Across dirs, the FIRST hit wins (list dirs in
 * precedence order, e.g. project before shared); within a dir, the more specific
 * `.workflow.js` beats `.js`.
 *
 * `resolve(name)` deliberately matches the `loadSavedWorkflow` contract
 * (`(name) => string | undefined`), so a view plugs straight into WorkflowManager /
 * WorkflowRunOptions and serves nested `workflow("<name>")` calls. Because the engine
 * hands that hook whatever string the script passed — including full INLINE nested
 * scripts — resolve() strictly validates the name shape and returns undefined for
 * anything else (which also blocks path traversal out of the configured dirs).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { WorkflowMeta } from "@automatalabs/shared-types";
import { parseWorkflowScript } from "./workflow.js";

/** One workflow file found by WorkflowDir.list(). */
export interface WorkflowDirEntry {
  /** The lookup name: the filename stem. */
  name: string;
  /** Absolute path of the file that wins for this name. */
  file: string;
  /** The parsed `export const meta` literal — undefined when the file doesn't parse. */
  meta?: WorkflowMeta;
  /** Parse error message when `meta` is undefined. */
  error?: string;
}

/** A read-only, per-call-fresh view over directories of workflow scripts. */
export interface WorkflowDir {
  /** The directories this view searches, absolute, in precedence order. */
  readonly dirs: readonly string[];
  /** Scan now and index every workflow file (first hit per name wins). Sorted by name. */
  list(): WorkflowDirEntry[];
  /**
   * Resolve a workflow name to its script text; undefined when no file matches (or the
   * string isn't a plausible name — e.g. an inline script). Matches the
   * `loadSavedWorkflow` contract, so pass it directly as that option.
   */
  resolve(name: string): string | undefined;
  /** Like resolve(), but throws a diagnosable error (searched dirs + closest matches). */
  read(name: string): string;
}

export interface OpenWorkflowDirOptions {
  /** Base for resolving relative directory paths. Default process.cwd(). */
  cwd?: string;
}

/** Extension priority within a directory: more specific first. */
const WORKFLOW_FILE_EXTENSIONS = [".workflow.js", ".workflow.mjs", ".js", ".mjs"] as const;

/** A plausible workflow NAME (vs an inline script / a path): one flat path segment. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

function isPlausibleName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes("..") && name.length <= 128;
}

function stemOf(fileName: string): { stem: string; priority: number } | undefined {
  for (let i = 0; i < WORKFLOW_FILE_EXTENSIONS.length; i++) {
    const ext = WORKFLOW_FILE_EXTENSIONS[i];
    if (fileName.toLowerCase().endsWith(ext) && fileName.length > ext.length) {
      return { stem: fileName.slice(0, -ext.length), priority: i };
    }
  }
  return undefined;
}

/** Open a read-only view over `dir` (or several dirs in precedence order). No I/O here. */
export function openWorkflowDir(dir: string | string[], options: OpenWorkflowDirOptions = {}): WorkflowDir {
  const base = options.cwd ?? process.cwd();
  const dirs = (Array.isArray(dir) ? dir : [dir]).map((d) => (isAbsolute(d) ? d : resolvePath(base, d)));
  if (dirs.length === 0) throw new Error("openWorkflowDir requires at least one directory");

  /** name -> winning file, honoring dir precedence then extension priority. */
  const scan = (): Map<string, string> => {
    const winners = new Map<string, { file: string; dirIndex: number; priority: number }>();
    for (let dirIndex = 0; dirIndex < dirs.length; dirIndex++) {
      let fileNames: string[];
      try {
        fileNames = readdirSync(dirs[dirIndex]);
      } catch {
        continue; // missing/unreadable dir contributes nothing
      }
      for (const fileName of fileNames) {
        if (fileName.startsWith(".")) continue;
        const parsed = stemOf(fileName);
        if (!parsed) continue;
        const file = join(dirs[dirIndex], fileName);
        try {
          if (!statSync(file).isFile()) continue; // follows symlinks; skips subdirs
        } catch {
          continue;
        }
        const existing = winners.get(parsed.stem);
        const loses =
          existing !== undefined &&
          (existing.dirIndex < dirIndex || (existing.dirIndex === dirIndex && existing.priority <= parsed.priority));
        if (!loses) winners.set(parsed.stem, { file, dirIndex, priority: parsed.priority });
      }
    }
    return new Map([...winners].map(([name, w]) => [name, w.file]));
  };

  const resolve = (name: string): string | undefined => {
    if (typeof name !== "string" || !isPlausibleName(name)) return undefined;
    for (const d of dirs) {
      for (const ext of WORKFLOW_FILE_EXTENSIONS) {
        const file = join(d, `${name}${ext}`);
        try {
          if (statSync(file).isFile()) return readFileSync(file, "utf8");
        } catch {
          /* try the next candidate */
        }
      }
    }
    return undefined;
  };

  return {
    dirs,
    resolve,
    list(): WorkflowDirEntry[] {
      const entries: WorkflowDirEntry[] = [];
      for (const [name, file] of scan()) {
        try {
          entries.push({ name, file, meta: parseWorkflowScript(readFileSync(file, "utf8")).meta });
        } catch (error) {
          entries.push({ name, file, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },
    read(name: string): string {
      const script = resolve(name);
      if (script !== undefined) return script;
      const known = [...scan().keys()];
      const suggestions = closestMatches(name, known);
      throw new Error(
        `workflow "${name}" not found. Searched (for <name>{${WORKFLOW_FILE_EXTENSIONS.join(",")}}): ${dirs.join(", ")}.` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : known.length ? ` Available: ${known.sort().join(", ")}.` : " No workflow files found."),
      );
    },
  };
}

/** Tiny edit-distance ranking for read()'s did-you-mean; good enough for CLI typos. */
function closestMatches(target: string, candidates: string[], max = 3): string[] {
  const t = target.toLowerCase();
  return candidates
    .map((name) => ({ name, distance: editDistance(t, name.toLowerCase()) }))
    .filter((c) => c.distance <= Math.max(2, Math.floor(t.length / 3)))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((c) => c.name);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const insertOrDelete = Math.min(prev[j], prev[j - 1]) + 1;
      const substitute = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      diagonal = prev[j];
      prev[j] = Math.min(insertOrDelete, substitute);
    }
  }
  return prev[b.length];
}
