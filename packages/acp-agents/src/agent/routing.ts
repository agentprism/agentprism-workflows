// Agent-facing routing over ../routing.js: the registry read (malformed → INVALID_ARGUMENT),
// the runner's model-spec grammar for `new AcpAgent({ model })`, the ref-driven route the cold
// statics use (never the default backend), the same-backend rule a fork override and a
// mid-session model switch (`setModel`, a per-turn `model`) must satisfy, cwd validation that
// fails BEFORE a process spawns, and the fresh-Backend-instance rule a fork child needs.
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";
import type { AgentSessionRef } from "@automatalabs/shared-types";
import type { Backend } from "../backend.js";
import { builtinBackend } from "../backends/builtins.js";
import { CustomAcpBackend } from "../backends/custom.js";
import { resolveBackendRegistry, type BackendRegistry, type CustomBackendConfig } from "../registry.js";
import { asciiLowercase, resolveModelRoute, type ModelRoute } from "../routing.js";
import { agentValidationError } from "./errors.js";
import type { AcpAgentOptions } from "./types.js";

/** The custom-backend registry for an agent: `backends` merged over `AGENTPRISM_BACKENDS`. A
 *  malformed registry is a caller error (INVALID_ARGUMENT; the runner's wrap says
 *  SCRIPT_VALIDATION_ERROR for the same condition). */
export function resolveAgentRegistry(
  backends: Record<string, CustomBackendConfig> | undefined,
  label?: string,
): BackendRegistry {
  try {
    return resolveBackendRegistry(backends);
  } catch (error) {
    throw agentValidationError(error instanceof Error ? error.message : String(error), label);
  }
}

/** The runner's routing grammar applied to `new AcpAgent({ model })`. */
export function resolveAgentRoute(options: Pick<AcpAgentOptions, "model">, registry: BackendRegistry): ModelRoute {
  return resolveModelRoute(options.model, registry);
}

/**
 * Route a cold reopen from a session ref. `ref.backendId` must name a registered custom backend
 * (wins, like `resolveModelRoute`) or a built-in — NEVER the default backend; the ref's `poolKey`
 * must match the currently resolved `poolKey ?? id` (the runner's silent `backend-mismatch` skip,
 * made loud); an optional `model` must stay on the ref's backend: `<ref.backendId>/<inner>` strips
 * the prefix, a spec routing to another known backend is rejected, and an unrouted spec goes
 * VERBATIM to the ref's backend (the same unrouted rule as the runner, applied to this backend).
 */
export function resolveRefRoute(
  ref: AgentSessionRef,
  model: string | undefined,
  registry: BackendRegistry,
  label?: string,
): ModelRoute {
  const backend = backendNamed(ref.backendId, registry);
  if (!backend) {
    throw agentValidationError(
      `session ref names backend "${ref.backendId}" which is neither a built-in nor a registered custom backend`,
      label,
    );
  }
  const expected = backend.poolKey ?? backend.id;
  if (ref.poolKey !== undefined && ref.poolKey !== expected) {
    throw agentValidationError(
      `session ref pool key "${ref.poolKey}" does not match the currently resolved "${expected}" for "${ref.backendId}"`,
      label,
    );
  }
  if (model === undefined) return { backend, modelSpec: undefined };

  const slash = model.indexOf("/");
  const first = asciiLowercase(slash >= 0 ? model.slice(0, slash) : model);
  const inner = slash >= 0 ? model.slice(slash + 1) : undefined;
  if (first === ref.backendId) return { backend, modelSpec: inner };
  if (registry.get(first) || builtinBackend(first)) {
    throw agentValidationError(
      `model "${model}" routes to "${first}" but the session ref belongs to "${ref.backendId}"`,
      label,
    );
  }
  return { backend, modelSpec: model };
}

/**
 * The model rule `fork()`, `setModel()` and a per-turn `model` share: `spec` goes through the
 * runner's grammar (`resolveModelRoute` — a registered name wins, an unrouted spec goes to the
 * default backend) and the route must land on THIS agent's backend, poolKey-equal; otherwise
 * INVALID_ARGUMENT naming both backends. The remainder is the verbatim model id (`undefined` for a
 * backend-only spec — `fork()` reads that as "no selection"; a switch rejects it, see
 * `resolveModelSwitch`).
 */
export function resolveSameBackendModel(
  spec: string,
  backend: Backend,
  registry: BackendRegistry,
  label: string | undefined,
  method: string,
): ModelRoute {
  const route = resolveModelRoute(spec, registry);
  const routedPool = route.backend.poolKey ?? route.backend.id;
  const ownPool = backend.poolKey ?? backend.id;
  if (route.backend.id !== backend.id || routedPool !== ownPool) {
    // Same id, different pool (a registry entry shadowing this built-in's name): say which pool.
    const pooled = route.backend.id === backend.id;
    const routed = `backend "${route.backend.id}"${pooled ? ` (pool "${routedPool}")` : ""}`;
    const own = `backend "${backend.id}"${pooled ? ` (pool "${ownPool}")` : ""}`;
    throw agentValidationError(`${method}: model "${spec}" routes to ${routed} but must stay on ${own}`, label);
  }
  return route;
}

/** What a mid-session switch selects: `spec` resolved with `resolveSameBackendModel`, with a
 *  blank spec or a backend-only spec (`"claude"`, `"claude/"`) rejected — there is no wire form
 *  for "unselect", so a switch always names a model id. Returns the verbatim id to send and the
 *  routed `<backendId>/<id>` form the agent's `model` takes once it applied. */
export function resolveModelSwitch(
  spec: unknown,
  backend: Backend,
  registry: BackendRegistry,
  label: string | undefined,
  method: string,
): { modelSpec: string; model: string } {
  if (typeof spec !== "string" || spec.trim() === "") {
    throw agentValidationError(`${method} requires a non-empty model spec ("${backend.id}/<model id>")`, label);
  }
  const { modelSpec } = resolveSameBackendModel(spec, backend, registry, label, method);
  if (modelSpec === undefined || modelSpec.trim() === "") {
    throw agentValidationError(
      `${method}: model "${spec}" names backend "${backend.id}" but no model id; use "${backend.id}/<model id>"`,
      label,
    );
  }
  return { modelSpec, model: `${backend.id}/${modelSpec}` };
}

/** A fresh `Backend` instance with the same identity as `backend` (a registered name wins, as in
 *  routing; else the built-in of that id). A fork child must own its own instance — pooling identity
 *  is `poolKey ?? id`, never the object. */
export function freshBackendFor(backend: Backend, registry: BackendRegistry): Backend {
  return backendNamed(backend.id, registry) ?? backend;
}

function backendNamed(name: string, registry: BackendRegistry): Backend | undefined {
  const custom = registry.get(name);
  if (custom) return new CustomAcpBackend(custom);
  return builtinBackend(name);
}

/** Stricter than the runner's interactive check and equal to the Claude adapter's own: absolute,
 *  existing, and a directory — so the failure happens before a process spawns. */
export function validateAgentCwd(cwd: unknown, label: string | undefined, method: string): asserts cwd is string {
  if (typeof cwd !== "string" || cwd.trim() === "" || !isAbsolute(cwd)) {
    throw agentValidationError(`${method} requires cwd to be a non-empty absolute path`, label);
  }
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(cwd, { throwIfNoEntry: false });
  } catch (error) {
    // `throwIfNoEntry` only suppresses ENOENT; EACCES / ELOOP / ENOTDIR on a parent are caller
    // errors too, not raw Node errors.
    const code = (error as { code?: unknown }).code;
    const detail = typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
    throw agentValidationError(`${method} cwd is not accessible: ${cwd} (${detail})`, label);
  }
  if (stat?.isDirectory() !== true) {
    throw agentValidationError(`${method} cwd does not exist or is not a directory: ${cwd}`, label);
  }
}
