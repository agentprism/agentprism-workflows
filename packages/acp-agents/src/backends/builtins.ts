import type { Backend } from "../backend.js";
import { claudeBackendDefinition } from "./claude.js";
import { codexBackendDefinition } from "./codex.js";
import type { BuiltinBackendDefinition } from "./define.js";
import { opencodeBackendDefinition } from "./opencode.js";
import { piBackendDefinition } from "./pi.js";

export const BUILTIN_BACKENDS = {
  claude: claudeBackendDefinition,
  codex: codexBackendDefinition,
  opencode: opencodeBackendDefinition,
  pi: piBackendDefinition,
} as const satisfies Readonly<Record<string, BuiltinBackendDefinition<string>>>;

export type BuiltinBackendId = keyof typeof BUILTIN_BACKENDS;

export const BUILTIN_BACKEND_IDS = Object.freeze(
  Object.keys(BUILTIN_BACKENDS) as BuiltinBackendId[],
);

export function assertBuiltinBackendTable(
  table: Readonly<Record<string, BuiltinBackendDefinition<string>>>,
): void {
  for (const [key, definition] of Object.entries(table)) {
    if (definition.id !== key) {
      throw new Error(
        `Built-in backend table key "${key}" does not match definition id "${definition.id}"`,
      );
    }
  }
}

assertBuiltinBackendTable(BUILTIN_BACKENDS);

function isBuiltinBackendId(id: string): id is BuiltinBackendId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_BACKENDS, id);
}

/** Exact, case-sensitive lookup for an untrusted id. Routing owns normalization and fallback. */
export function builtinBackend(id: string): Backend | undefined {
  return isBuiltinBackendId(id) ? BUILTIN_BACKENDS[id].create() : undefined;
}
