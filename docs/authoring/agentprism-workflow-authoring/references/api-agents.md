# Workflow agent API reference

**Context:** JavaScript passed to the MCP `workflow` tool.

## `agent(prompt, options?)` — full option table

Returns the agent's final assistant text, or the schema-validated object when `schema` is set. Resolves to `null` when a *recoverable* failure survives all retries.

| option | type | meaning |
|---|---|---|
| `label` | `string` | Display name shown in status `calls`, `latestActivity`, and the run log. Always set it. Not part of the replay identity. |
| `phase` | `string` | Assign this call to a phase explicitly (needed inside concurrent stages where the global `phase()` state would race). |
| `schema` | JSON Schema object | Structured output. Plain object literal only — no schema builders exist in the realm. Part of the replay identity. |
| `model` | `string` | Backend name, or `backend/<exact id>` copied from the config response. See [Model specs & routing](#model-specs--routing). Part of the replay identity. |
| `mode` | `string` | Exact ACP session mode id advertised for the selected backend/model in the config response. For trusted implementation/review work use Claude `bypassPermissions` or Codex `agent` when advertised. Claude `auto` is classifier-driven and may request permission. Part of the replay identity when set. |
| `configOptions` | `Record<string, string \| boolean>` | Exact option ids and values copied from the config response. Applied after model selection and before the prompt, with no aliases or coercion. `"model"` is reserved for the `model` field. Part of the replay identity when non-empty. |
| `agentType` | `string` | Bind a named subagent definition file (tools allow/deny, model, isolation, role prompt). See [environment-and-tools.md](environment-and-tools.md). Part of the replay identity. |
| `isolation` | `"worktree"` | Run in a throwaway git worktree branched from the run cwd. **Always removed (worktree + branch) when the call ends** — edits are discarded; return work as data. Degrades to the shared tree outside a git repo (logged). |
| `cwd` | `string` | Per-session working directory; relative resolves against the run's base cwd. Overridden by worktree isolation. Not part of the replay identity. |
| `retries` | `number` | Retries after *recoverable* failures (default: the run's `agentRetries`, itself default 0). Exhausted retries ⇒ the call resolves `null`. |
| `mcpServers` | `McpServerConfig[]` | MCP servers attached to this session. Stdio shape: `{ name, command, args: [], env: [{ name, value }] }` (`args`/`env` required, `env` is name/value pairs, not a map); `{ type: "http" \| "sse", name, url, headers: [] }` also accepted. Not part of the replay identity. |
| `images` | `{ data, mimeType, uri? }[]` | Base64 image blocks appended to the prompt; backends without image support get a bracketed text note. Not part of the replay identity. |
| `meta` | `object` | ACP `_meta` merged into `session/new` — session-scoped passthrough for custom backends. Not part of the replay identity. |
| `promptMeta` | `object` | ACP `_meta` merged into `session/prompt` — turn-scoped passthrough. Not part of the replay identity. |

Agent attempts have no wall-clock or idle timeout. They remain live until they complete, fail, or you cancel the call (`stop` with `callIndex`) or the run.

## Model specs & routing

A `model` string is resolved solely from its first `/`-separated segment, then handed to that backend:

| spec shape | routes to | notes |
|---|---|---|
| *(omitted)* | inherited route | The call must inherit a model from its `agentType` definition, the current phase, or `meta.model`; otherwise preflight rejects the run. |
| `claude`, `codex`, `opencode`, `pi`, or `<custom-name>` | that backend | Backend-only: no model selection call is made; the backend's own configured default model stays active. Always valid. |
| `claude/<id>`, `codex/<id>`, `opencode/<id>`, `pi/<id>`, or `<custom-name>/<id>` | that backend | The first segment matches ASCII-case-insensitively and is stripped exactly once. The remaining `<id>` is sent verbatim, including any further `/` characters. For Pi the remainder is `<provider>/<model-id>`. Copy the whole route from the config response. |
| anything else (`anthropic/…`, `openai/…`, bare `opus`, bare `gpt-…`) | not a route | These are not aliases. The whole string is sent verbatim to the server's default backend and is almost always rejected. Do not use them. |

Browse selectors ending in `/*` appear in the config response as catalog groups and cannot dispatch. Expand them with config `modelFilter` and copy an exact returned route.

Model selection is exact: there is no catalog matching, case folding, normalization, nearest-neighbor selection, or fallback. The backend is authoritative — a rejected id fails the call as an ordinary agent error and nothing substitutes a nearby model.

## Structured output

Pass `schema` — a **plain JSON Schema object literal** — and the call resolves to a **validated object** instead of text:

```js
const FINDINGS = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "summary"],
        properties: {
          file:    { type: "string", description: "Repo-relative path — copy it exactly, never invent one" },
          line:    { type: "number", description: "1-indexed line the finding anchors to" },
          summary: { type: "string", description: "One sentence stating the defect, grounded in code you actually read" },
        },
      },
    },
  },
};

const report = await agent("Review the diff on this branch for correctness bugs.", {
  label: "review", model: "codex", schema: FINDINGS,
});
report.findings.forEach((f) => log(`${f.file}:${f.line} ${f.summary}`));
```

The same schema works on **every** backend; the server picks the delivery channel per backend (native structured output where the backend has it, otherwise an injected structured-output tool or a validated final-message parse). In every channel the value is validated client-side (with type coercion) and the agent is re-prompted a bounded number of times; the final miss fails the call with non-recoverable `SCHEMA_NONCOMPLIANCE`.

Schema authoring rules that keep every channel healthy:

- Root must be an object; set `additionalProperties: false` and list every property in `required`.
- Put a `description` on every field — descriptions are the per-field prompt.
- Keep schemas structurally simple. Exotic keywords (`oneOf`, `patternProperties`, unusual `format`s, backreference regexes) are normalized or stripped on the wire for some backends while still enforced client-side, which shows up as re-prompt churn. Prefer `anyOf`, `enum`, and plain types.
- Keep free-text fields small (tens of lines). An oversized structured output can exhaust schema repair and fail the call.
- Validation checks structure, not truth. Check load-bearing values in script code (for example, reject findings whose `file` is not in a known file list) before spending more agents on them.
