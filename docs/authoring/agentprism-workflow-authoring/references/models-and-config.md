## Choosing the agent for each call

**Context:** JavaScript passed to the MCP `workflow` tool.

The backend is selected **per `agent()` call** from its effective `model` string. One script can plan on one vendor's agent, implement on another's, and review on a third's, handing structured results between them.

The built-in names are `claude`, `codex`, `opencode`, and `pi`. Custom backends registered on the server, or declared in `meta.backends` and approved at setup, extend that set.

- **Every call needs a route.** A call may inherit its model from an `agentType` definition, the current phase's `model`, or `meta.model`; otherwise supply `model` explicitly. A call with no route is rejected at preflight, before any agent runs. There is no automatic default.
- **Route by the first segment.** Split on the first `/`; a registered backend name (ASCII-case-insensitive) selects that backend and is stripped exactly once. Whatever remains is sent to the backend byte-for-byte: no catalog matching, case folding, prefix trimming, or fallback.
- **A backend name alone** (`model: "codex"`) keeps that backend's own configured default model and needs no discovery. Prefer it whenever the exact model does not matter.
- **Anything else** (`anthropic/…`, `openai/…`, bare `opus`, bare `gpt-…`) is not an alias and will almost always be rejected. Do not use it.

## Discover before you pin

Never guess model ids, mode ids, or option ids from memory: they vary by harness version, login, and machine. Call the `workflow` tool with `action:"config"` first. It opens one no-prompt session per backend, spends no tokens, and creates no run.

```json
{ "action": "config", "projectDir": "/absolute/project" }
```

Narrow it with `harnesses` (backend names to probe), `modelFilter` (a case-insensitive substring or a `/regex/` over model ids), or `modelSpecs` (exact routes whose model-specific options you want):

```json
{ "action": "config", "projectDir": "/absolute/project", "harnesses": ["codex"], "modelFilter": "gpt" }
```

```json
{ "action": "config", "projectDir": "/absolute/project", "modelSpecs": ["codex/MODEL_ID_FROM_CONFIG"] }
```

Each probe is bounded (15 seconds per backend, 40 seconds overall). A backend that cannot be probed is reported with `probed:false` and an `error` and simply cannot be routed to until it works; the other backends' catalogs are still complete.

### Reading the response

- `harnessOptions[]` — one entry per probed backend/model pair: `backendId`, `probed`, `model` (when probed for an exact route), `defaultModeId`, `modes` (`null` when the backend has no modes; otherwise `availableModes[]` with each mode's raw `id`, `name`, and `description`), and `options[]` — the backend's config options with their ids, current values, and, for select options, the allowed values.
- `authoringSummary.harnesses[]` — per backend: `currentModel`, `currentRoute` (present only when the current model is an exact executable leaf), `models[]` as `{ modelId, route }` pairs, and `groups[]` for large catalogs (`provider`, `count`, and a `modelFilter` that expands the group). A group's `selector` such as `openrouter/*` is a browse selector, never a route.
- `models[]` — the ids matching `modelFilter`, per backend, with `matchCount` and `omittedMatches` when the list was bounded.

Copy values exactly: `route` into `model`, a mode `id` into `mode`, and an option id with one of its advertised values into `configOptions`. Punctuation is part of the id (`"fast-mode"` is not `fast_mode`); quote ids that are not valid identifiers.

### Pinning walkthrough

1. Probe the backend: `{ "action":"config", "projectDir":"/absolute/project", "harnesses":["codex"] }`.
2. Pick a `route` from `authoringSummary.harnesses[0].models` (or expand a group with its `modelFilter` and pick from `models[].matches` as `codex/<id>`).
3. Read that model's own mode and option domain: `{ "action":"config", "projectDir":"/absolute/project", "modelSpecs":["codex/MODEL_ID_FROM_CONFIG"] }`. Option domains are model-specific, so confirm every value against the entry echoed for that exact route.
4. Pin only what step 3 advertised:

```js
const impl = await agent(implPrompt(plan), {
  label: "implement",
  model: "codex/MODEL_ID_FROM_CONFIG",     // the exact `route` copied from step 2
  mode: "agent",                           // an `availableModes[].id` from step 3
  configOptions: { OPTION_ID: "VALUE" },   // an option id and advertised value from step 3
});
```

Replace every placeholder with the value you copied; the run preflight rejects unknown option ids, unadvertised values, wrong value types, an unadvertised mode, and the reserved `"model"` option key, naming the offending call. A recognized effort-style value above a model's ceiling passes with a warning that names the effective clamp.

## Modes

Omitting `mode` applies the backend's `defaultModeId`: Claude `auto`, Codex `agent`, OpenCode `build`, and no mode for Pi. For trusted implementation or review work, choose Claude `bypassPermissions` or Codex `agent` when the catalog advertises them. Claude `auto` delegates permission policy to a model classifier and may request permission, which surfaces in status as `pendingPermissions` for you to answer; it is not full autonomy. Use an advertised read-only or plan mode for reviewers that must not write. Read the backend-owned mode descriptions instead of inferring behavior from an id.

## Mixing backends

```js
const plan   = await agent(PLAN_PROMPT,        { label: "plan",      model: "opencode", schema: PLAN });
const impl   = await agent(implPrompt(plan),   { label: "implement", model: "codex", mode: "agent" });
const review = await agent(reviewPrompt(impl), { label: "review",    model: "claude", mode: "bypassPermissions", schema: REVIEW });
```

Backend-only routes let each harness apply its own configured default model, so this script runs unchanged on any machine where those backends are logged in. Confirm the mode ids in the config response first.
